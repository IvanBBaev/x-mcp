// Media tools (T-303 + T-304; docs/03 media §): `x_media_upload`, `x_media_status`.
// Upload and status are SEPARATE tools (MEDIA-3): upload returns as soon as FINALIZE
// does, and the agent polls `x_media_status` for async video/GIF processing instead of
// the server blocking a tool call for minutes. Alt text is folded into upload as an
// optional field (docs/03 — the former `x_media_metadata_set` is cut).
//
// Chunked upload drives the dedicated v2 paths only (MEDIA-1): INIT -> APPEND (raw
// segments < 5 MB) -> FINALIZE. Handlers only map validated input -> API calls ->
// compact output; the registry (core/registry) enforces policy/budget/rate-limit around
// them.
//
// T-304 adds the path-security battery around the single open (MEDIA-5/6), the boundary
// battery (MEDIA-2), the failed-processing mapping (MEDIA-4), and cancellation/progress
// on the APPEND loop (MEDIA-7). The ordered controls (docs/04 §7) are, top to bottom:
//   1. default-deny  — no configured media directory means no local file is ever opened;
//   2. extension allow-list — refused before any filesystem access;
//   3. lexical containment — `../` escapes die without touching the disk;
//   4. realpath containment — symlinked parents cannot escape the media directory;
//   5. O_NOFOLLOW open — the final component is never a symlink (PLAT-2 fallback on win32);
//   6. same-fd checks — fstat, magic-byte sniff, size cap and every APPEND read use the
//      SAME file descriptor, so the file cannot be swapped between check and upload.
//
// Residual risk, stated rather than hidden: a HARD link inside the media directory to a
// file outside it is indistinguishable from a regular file (it IS the same inode, with no
// "outside" path to resolve), so containment cannot see through it. Creating one requires
// write access to the media directory in the first place, at which point the attacker can
// simply copy the file in — the control that matters there is who may write to the
// operator-configured directory, not anything this module can check.

import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, resolve, sep } from 'node:path';

import { z } from 'zod';

import {
  MEDIA_CATEGORIES,
  MEDIA_SEGMENT_BYTES,
  MEDIA_SIZE_CAPS,
  appendSegment,
  finalizeUpload,
  getUploadStatus,
  initializeUpload,
  setAltText,
} from '../api/endpoints/media.js';
import type { MediaCategory } from '../api/endpoints/media.js';
import { XError, apiError, networkError, validationError } from '../core/errors.js';
import { defineTool } from '../core/tooldef.js';
import type { EndpointInvoker } from '../core/tooldef.js';

// Extension -> claimed MIME type (MEDIA-1). This is the supported-format surface;
// anything else is refused locally before any I/O. The extension only ever CLAIMS a
// type: the magic bytes decide what is actually uploaded (MEDIA-6).
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

/** Sniffed MIME type -> the `media_category` the composer wants (MEDIA-6: sniffed wins). */
const CATEGORY_BY_TYPE: Readonly<Record<string, MediaCategory>> = {
  'image/png': 'tweet_image',
  'image/jpeg': 'tweet_image',
  'image/webp': 'tweet_image',
  'image/gif': 'tweet_gif',
  'video/mp4': 'tweet_video',
  'video/quicktime': 'tweet_video',
};

/**
 * ISO-BMFF containers (`ftyp`) share one byte layout; the brand distinguishes QuickTime
 * from MP4 and the two are routinely interchanged by cameras and editors. Treating them
 * as one family keeps MEDIA-6 honest (a real container mismatch is still refused) without
 * failing a `.mov` that holds a perfectly valid MP4 — the SNIFFED type still wins on the
 * wire and in `media_category`.
 */
const ISO_BMFF_FAMILY: readonly string[] = ['video/mp4', 'video/quicktime'];

/** Bytes read from offset 0 for the magic-byte sniff — enough for every signature below. */
const SNIFF_BYTES = 16;

/** `O_NOFOLLOW` is POSIX-only; on win32 it is absent and degrades to an lstat check (PLAT-2). */
const O_NOFOLLOW: number = constants.O_NOFOLLOW ?? 0;
/** Opening a FIFO read-only blocks until a writer appears; `O_NONBLOCK` keeps that bounded. */
const O_NONBLOCK: number = constants.O_NONBLOCK ?? 0;

/** One-shot latch so the win32 `O_NOFOLLOW` degradation is announced once, not per upload. */
let nofollowWarned = false;

/** Per-segment progress event (WP-3.3). Emitted AFTER each APPEND the platform accepted. */
export interface MediaUploadProgress {
  /** The media id INIT returned — the upload this event belongs to. */
  readonly mediaId: string;
  /** 0-based index of the segment that was just appended. */
  readonly segmentIndex: number;
  /** Total segments this upload will send. */
  readonly segments: number;
  /** Bytes appended so far (`totalBytes` once the last segment lands). */
  readonly bytesUploaded: number;
  /** Total bytes of the local file. */
  readonly totalBytes: number;
  /**
   * The per-call `AbortSignal` from `ToolContext`, when the caller supplied one. It is
   * the correlation key an MCP-side progress bridge needs to map an event back to the
   * originating `tools/call` (and its `progressToken`) — emitting the protocol
   * notification itself is composition-root work, not this package's.
   */
  readonly signal?: AbortSignal;
}

/** Progress sink. Must not throw meaningfully — a throwing listener is swallowed. */
export type MediaProgressListener = (event: MediaUploadProgress) => void;

/**
 * Composition-root dependencies for the media tools (INT-6 factory pattern, as in
 * tools/auth): `ToolContext` and `Ports` carry no config, so the operator-set media
 * directory and the progress sink are closed over at build time by `createMediaTools`.
 */
export interface MediaToolDeps {
  /**
   * The operator-set `X_MCP_MEDIA_DIR` (docs/04 §7). ABSENT MEANS DEFAULT-DENY: with no
   * media directory configured, `x_media_upload` refuses every path before touching the
   * filesystem. `~` is expanded.
   */
  readonly mediaDir?: string;
  /** Optional per-segment progress sink (WP-3.3 seam). */
  readonly onProgress?: MediaProgressListener;
  /** Operator-facing warning sink (PLAT-2 degradation notice). Defaults to stderr. */
  readonly warn?: (message: string) => void;
}

/** What `openMediaFile` hands the upload flow. The caller owns closing `handle`. */
export interface OpenedMediaFile {
  readonly handle: FileHandle;
  readonly size: number;
  /** The SNIFFED media type (MEDIA-6), not the one the extension claimed. */
  readonly mediaType: string;
  /** Derived from the sniffed type (MEDIA-6: the sniffed type wins). */
  readonly category: MediaCategory;
  /** The contained, realpath-resolved absolute path the fd was opened from (diagnostics). */
  readonly resolvedPath: string;
}

// --- Path security (MEDIA-5) ------------------------------------------------------

/** Expand a leading `~` so operators can configure `~/x-media` (docs/04 §7). */
function expandTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith(`~${sep}`)) return resolve(homedir(), path.slice(2));
  return path;
}

/** Containment test on two ALREADY realpath-resolved absolute paths. `root` itself passes. */
function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}

/** The one refusal message for every containment failure — never leaks what is outside. */
function escapeError(rawPath: string, mediaDir: string): XError {
  return validationError(
    `Media path ${rawPath} resolves outside the configured media directory ` +
      `(X_MCP_MEDIA_DIR=${mediaDir}). Only files inside that directory can be uploaded; ` +
      '`../` traversal and symlinks that leave it are refused. Nothing was uploaded.',
  );
}

/**
 * Resolve a user-supplied path to an absolute path that provably lives inside the media
 * directory (MEDIA-5). Relative paths resolve AGAINST the media directory, never against
 * the server's cwd. Symlinked parents are collapsed with `realpath` BEFORE the containment
 * test; the final component is deliberately left unresolved so the `O_NOFOLLOW` open —
 * not a resolve-then-open race — decides whether it is a symlink.
 */
async function resolveInsideMediaDir(rawPath: string, mediaDir: string): Promise<string> {
  // Two spellings of the media directory: as configured, and fully resolved. Both are
  // legitimate ways to name a file inside it (on macOS, `/var/…` is `/private/var/…`),
  // so the cheap lexical gate accepts either and the realpath gate below decides.
  const rootRaw = resolve(expandTilde(mediaDir));
  let rootReal: string;
  try {
    rootReal = await realpath(rootRaw);
  } catch (cause) {
    throw validationError(
      `The configured media directory (X_MCP_MEDIA_DIR=${mediaDir}) does not exist or is ` +
        'not readable by the server, so no media can be uploaded. Nothing was uploaded.',
      { fix: 'operator', cause },
    );
  }
  // Lexical containment first: a `../` escape is refused with ZERO filesystem access, so
  // probing for files outside the directory cannot even learn whether they exist.
  // Relative paths resolve against the media directory, never the server's cwd.
  const candidate = resolve(rootRaw, expandTilde(rawPath));
  const lexicallyInside = isInside(rootRaw, candidate) || isInside(rootReal, candidate);
  if (!lexicallyInside || candidate === rootRaw || candidate === rootReal) {
    throw escapeError(rawPath, mediaDir);
  }

  // Then the authoritative one: resolve the PARENT through every symlink and re-test.
  const parent = dirname(candidate);
  let realParent: string;
  try {
    realParent = await realpath(parent);
  } catch (cause) {
    throw validationError(
      `Cannot open media file ${rawPath} for reading — check that the path exists and is ` +
        'readable by the server. Nothing was uploaded.',
      { cause },
    );
  }
  if (!isInside(rootReal, realParent)) throw escapeError(rawPath, mediaDir);
  return resolve(realParent, basename(candidate));
}

/** POSIX reports "you asked not to follow a symlink" as ELOOP (EMLINK on some BSDs). */
function isSymlinkOpenError(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  return code === 'ELOOP' || code === 'EMLINK';
}

function symlinkError(rawPath: string): XError {
  return validationError(
    `Media path ${rawPath} is a symlink. The final path component must be a regular file ` +
      'inside the media directory (it is opened with O_NOFOLLOW), so symlinks are refused ' +
      'even when they point back inside. Nothing was uploaded.',
  );
}

/**
 * Open the contained path read-only WITHOUT following a final symlink (MEDIA-5).
 *
 * PLAT-2: `O_NOFOLLOW` does not exist on win32. There the check degrades to a
 * non-atomic `lstat` and the operator is warned once — the containment guarantee is
 * unchanged for every non-adversarial case, but a symlink swapped in between the lstat
 * and the open would not be caught. Documented rather than silently weaker.
 *
 * `nofollow` is a test seam, and only that: it defaults to the platform's real flag, and
 * the degraded win32 branch is unreachable on POSIX otherwise — a security fallback that
 * cannot be exercised is a security fallback nobody has ever seen run.
 */
export async function openNoFollow(
  target: string,
  rawPath: string,
  deps: MediaToolDeps,
  nofollow: number = O_NOFOLLOW,
): Promise<FileHandle> {
  if (nofollow === 0) {
    if (!nofollowWarned) {
      nofollowWarned = true;
      const warn =
        deps.warn ??
        ((message: string): void => {
          process.stderr.write(message + '\n');
        });
      warn(
        'x-mcp: O_NOFOLLOW is unavailable on this platform (win32); the final media path ' +
          'component is checked with a non-atomic lstat instead (PLAT-2).',
      );
    }
    const link = await lstat(target).catch(() => undefined);
    if (link?.isSymbolicLink() === true) throw symlinkError(rawPath);
  }
  try {
    return await open(target, constants.O_RDONLY | nofollow | O_NONBLOCK);
  } catch (cause) {
    if (isSymlinkOpenError(cause)) throw symlinkError(rawPath);
    throw validationError(
      `Cannot open media file ${rawPath} for reading — check that the path exists and is ` +
        'readable by the server. Nothing was uploaded.',
      { cause },
    );
  }
}

// --- Content sniffing (MEDIA-6) ---------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Identify a media type from its leading bytes. Signature-based, never extension-based. */
function sniffMediaType(header: Buffer): string | undefined {
  if (header.length >= 8 && header.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg';
  }
  if (header.length >= 6) {
    const gif = header.subarray(0, 6).toString('latin1');
    if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  }
  if (header.length >= 12) {
    const riff = header.subarray(0, 4).toString('latin1');
    if (riff === 'RIFF' && header.subarray(8, 12).toString('latin1') === 'WEBP')
      return 'image/webp';
    // ISO-BMFF: `ftyp` box type at offset 4, major brand at offset 8.
    if (header.subarray(4, 8).toString('latin1') === 'ftyp') {
      return header.subarray(8, 12).toString('latin1').startsWith('qt')
        ? 'video/quicktime'
        : 'video/mp4';
    }
  }
  return undefined;
}

/** Do the extension's claim and the file's actual bytes describe the same container? */
function typesAgree(claimed: string, sniffed: string): boolean {
  if (claimed === sniffed) return true;
  return ISO_BMFF_FAMILY.includes(claimed) && ISO_BMFF_FAMILY.includes(sniffed);
}

/** Human-readable cap for the refusal message (MEDIA-2: state the cap). */
function formatCap(bytes: number): string {
  return `${String(Math.round(bytes / (1024 * 1024)))} MiB (${String(bytes)} bytes)`;
}

// --- The single open --------------------------------------------------------------

/**
 * The ONLY place a user-supplied path is opened. Runs the full ordered battery and
 * returns an fd whose content has already been vetted — everything downstream (size,
 * type, category, every APPEND read) is derived from THAT fd, never from the path again,
 * so there is no check/use gap to exploit (MEDIA-5).
 */
export async function openMediaFile(
  rawPath: string,
  deps: MediaToolDeps = {},
): Promise<OpenedMediaFile> {
  // 1. Default-deny (MEDIA-5): without a configured directory nothing is openable.
  const mediaDir = deps.mediaDir;
  if (mediaDir === undefined || mediaDir.trim() === '') {
    throw validationError(
      'Media upload is disabled: no media directory is configured. The operator must set ' +
        'X_MCP_MEDIA_DIR to a directory the server may read, and files must live inside it. ' +
        'Nothing was uploaded.',
      { fix: 'operator' },
    );
  }
  // 2. Extension allow-list — cheapest refusal, still before any filesystem access.
  const claimed = MEDIA_TYPES[extname(rawPath).toLowerCase()];
  if (claimed === undefined) {
    throw validationError(
      `Unsupported media file extension on ${rawPath}. Supported: ` +
        `${Object.keys(MEDIA_TYPES).join(', ')}. Nothing was uploaded.`,
    );
  }
  // 3./4. Lexical + realpath containment.
  const target = await resolveInsideMediaDir(rawPath, mediaDir);
  // 5. O_NOFOLLOW open.
  const handle = await openNoFollow(target, rawPath, deps);
  try {
    // 6. Everything below reads the SAME fd — no path is touched again.
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw validationError(`Media path ${rawPath} is not a regular file. Nothing was uploaded.`);
    }
    // MEDIA-2: a zero-byte file is a `validation` error BEFORE INIT — never a session
    // opened for an upload that can only fail.
    if (stat.size === 0) {
      throw validationError(
        `Media file ${rawPath} is empty (0 bytes), so there is nothing to upload. No upload ` +
          'session was opened.',
      );
    }
    const header = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(header, 0, SNIFF_BYTES, 0);
    const sniffed = sniffMediaType(header.subarray(0, bytesRead));
    // MEDIA-6: name BOTH the claimed and the sniffed type so the agent can fix the call.
    if (sniffed === undefined) {
      throw validationError(
        `Media file ${rawPath} claims to be ${claimed} (from its extension) but its leading ` +
          'bytes match no supported media format. Upload a real image, GIF, or video file. ' +
          'Nothing was uploaded.',
      );
    }
    if (!typesAgree(claimed, sniffed)) {
      throw validationError(
        `Media file ${rawPath} claims to be ${claimed} (from its extension) but its content ` +
          `is ${sniffed}. Rename the file to match its real type, or upload the file whose ` +
          'type you meant. Nothing was uploaded.',
      );
    }
    const category = CATEGORY_BY_TYPE[sniffed] ?? 'tweet_image';
    // MEDIA-2: per-type cap enforced locally, with the cap stated.
    const cap = MEDIA_SIZE_CAPS[category];
    if (stat.size > cap) {
      throw validationError(
        `Media file ${rawPath} is ${String(stat.size)} bytes, over the ${formatCap(cap)} cap ` +
          `for ${category} uploads. Compress or shorten the file and try again. Nothing was ` +
          'uploaded.',
      );
    }
    return {
      handle,
      size: stat.size,
      mediaType: sniffed,
      category,
      resolvedPath: target,
    };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

// --- Cancellation + progress (MEDIA-7) --------------------------------------------

/**
 * The typed error for a cancelled upload. The taxonomy is frozen at 11 classes and has no
 * `cancelled` kind, so cancellation stays `network` — the same class api/http already maps
 * a host-aborted request to, and the class whose semantics (transport stopped before a
 * result, retry is sensible) match. Not retried automatically: writes never are (RATE-5).
 */
function cancelledError(detail: string): XError {
  return networkError(`The media upload was cancelled. ${detail}`, { retryable: false });
}

/** Throw if the caller's signal has fired. Called between segments, never mid-request. */
function throwIfCancelled(signal: AbortSignal | undefined, detail: string): void {
  if (signal?.aborted === true) throw cancelledError(detail);
}

/** Cancellation message once a session exists — states that the partial upload expires. */
function partialUploadDetail(mediaId: string, done: number, total: number): string {
  return (
    `${String(done)} of ${String(total)} segment(s) had been appended to media ${mediaId}; ` +
    'FINALIZE was never sent, so the partial upload was never completed and expires ' +
    'server-side on its own. Nothing was posted. Re-run x_media_upload to start over.'
  );
}

interface UploadRun {
  readonly http: EndpointInvoker;
  readonly handle: FileHandle;
  readonly mediaId: string;
  readonly size: number;
  readonly deps: MediaToolDeps;
  readonly signal?: AbortSignal;
}

/**
 * APPEND every `MEDIA_SEGMENT_BYTES`-sized slice of the open file (raw segments stay
 * under the 5 MB cap, MEDIA-1). The `offset < size` guard means a size that is an exact
 * multiple of the segment size never produces an empty trailing APPEND (MEDIA-2).
 *
 * Cancellation (MEDIA-7) works on two levels. The registry binds the `tools/call` signal
 * to the invoker this handler was given (MCP-7, `withCallSignal`), so the IN-FLIGHT APPEND
 * is torn down by the transport itself and surfaces as a cancelled `network` error. The
 * checks here are the second level: between segments, and on any APPEND rejection while
 * the signal is aborted, so the loop stops and FINALIZE is NEVER sent even if a transport
 * ignored the signal. Progress is emitted after each accepted segment.
 */
async function uploadSegments(run: UploadRun): Promise<number> {
  const total = Math.ceil(run.size / MEDIA_SEGMENT_BYTES);
  let segmentIndex = 0;
  for (let offset = 0; offset < run.size; offset += MEDIA_SEGMENT_BYTES) {
    throwIfCancelled(run.signal, partialUploadDetail(run.mediaId, segmentIndex, total));
    const length = Math.min(MEDIA_SEGMENT_BYTES, run.size - offset);
    const buffer = Buffer.alloc(length);
    // Reads come from the vetted fd (never the path) — the file cannot be swapped under us.
    const { bytesRead } = await run.handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) {
      throw validationError(
        `Media file changed size while it was being read (expected ${String(length)} bytes at ` +
          `offset ${String(offset)}, got ${String(bytesRead)}); the upload was aborted before ` +
          'FINALIZE.',
      );
    }
    try {
      await appendSegment(run.http, { mediaId: run.mediaId, segmentIndex, segment: buffer });
    } catch (err) {
      // A transport abort of the in-flight APPEND surfaces as api/http's cancelled
      // `network` error, which says nothing about the media session; re-frame it as THIS
      // upload's cancellation so the agent learns the partial upload expires on its own.
      // A failure with no cancellation in play propagates untouched (typed by api/http).
      if (run.signal?.aborted === true) {
        throw cancelledError(partialUploadDetail(run.mediaId, segmentIndex, total));
      }
      throw err;
    }
    segmentIndex += 1;
    reportProgress(run, segmentIndex, total, offset + length);
  }
  return segmentIndex;
}

/** Emit one progress event. A misbehaving listener must never fail an upload. */
function reportProgress(run: UploadRun, done: number, total: number, bytes: number): void {
  const onProgress = run.deps.onProgress;
  if (onProgress === undefined) return;
  try {
    onProgress({
      mediaId: run.mediaId,
      segmentIndex: done - 1,
      segments: total,
      bytesUploaded: bytes,
      totalBytes: run.size,
      ...(run.signal !== undefined ? { signal: run.signal } : {}),
    });
  } catch {
    // Progress is advisory; swallow.
  }
}

// --- x_media_upload --------------------------------------------------------------

const uploadInput = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        'Path of the media file to upload (image, GIF, or video). Must be inside the ' +
          'operator-configured media directory; relative paths resolve against it.',
      ),
    media_category: z
      .enum(MEDIA_CATEGORIES)
      .optional()
      .describe(
        'Upload category for the composer. Defaults to the one implied by the file’s ' +
          'actual content (image -> tweet_image, GIF -> tweet_gif, video -> tweet_video).',
      ),
    alt_text: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe('Accessibility description attached to the media after upload (max 1000 chars).'),
  })
  .strict();

function buildUploadTool(deps: MediaToolDeps) {
  return defineTool({
    name: 'x_media_upload',
    title: 'Upload media',
    description:
      'X (Twitter): upload a local image, GIF, or video via the chunked v2 flow and return a ' +
      '`media_id` to attach with `x_post_create`. The file must live inside the ' +
      'operator-configured media directory. Videos and GIFs may keep processing after ' +
      'upload — poll `x_media_status` until `processing_state` is `succeeded` before posting. ' +
      'Optional `alt_text` adds an accessibility description.',
    policy: 'write:content',
    availability: 'user-only',
    scopes: ['media.write'],
    cost: 'w:action',
    annotations: {
      title: 'Upload media',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    phase: 3,
    input: uploadInput,
    handler: async (input, ctx) => {
      // Cancelled before we even started: no file is opened, no session is spent.
      throwIfCancelled(ctx.signal, 'No upload session had been opened yet — nothing was uploaded.');
      // Refuse locally BEFORE any network call: an unsupported extension, a path outside
      // the media directory, a symlink, an empty/oversized file, or content that does not
      // match its extension all throw a typed error here and no INIT is ever spent.
      const file = await openMediaFile(input.path, deps);
      try {
        // MEDIA-6: the sniffed type wins — an explicit `media_category` still overrides,
        // because the composer category is a posting decision, not a content claim.
        const category = input.media_category ?? file.category;
        throwIfCancelled(
          ctx.signal,
          'No upload session had been opened yet — nothing was uploaded.',
        );
        const init = await initializeUpload(ctx.http, {
          totalBytes: file.size,
          mediaType: file.mediaType,
          mediaCategory: category,
        });
        const mediaId = init.data?.id;
        if (mediaId === undefined || mediaId === '') {
          throw apiError(
            'POST /2/media/upload/initialize returned no media id, so the upload cannot ' +
              'proceed; no segment was appended. Retry the upload.',
          );
        }
        const segments = await uploadSegments({
          http: ctx.http,
          handle: file.handle,
          mediaId,
          size: file.size,
          deps,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });
        // Last chance to stop: a cancellation that lands here must not FINALIZE (MEDIA-7).
        throwIfCancelled(ctx.signal, partialUploadDetail(mediaId, segments, segments));
        const fin = await finalizeUpload(ctx.http, { mediaId });
        // No `processing_info` on FINALIZE means the media is ready as-is (images).
        const processingState = fin.data?.processing_info?.state ?? 'succeeded';

        // Alt text is best-effort AFTER a successful upload: a metadata failure must not
        // discard the media_id the segments were already spent on.
        let altTextSet: boolean | undefined;
        let note: string | undefined;
        if (input.alt_text !== undefined) {
          try {
            await setAltText(ctx.http, { mediaId, altText: input.alt_text });
            altTextSet = true;
          } catch (err) {
            if (!XError.is(err)) throw err;
            altTextSet = false;
            note =
              `The media uploaded successfully, but attaching alt_text failed (${err.kind}: ` +
              `${err.message}) — the media_id is still usable with x_post_create; the media ` +
              'will simply lack an accessibility description.';
          }
        }

        return {
          data: {
            media_id: mediaId,
            ...(fin.data?.media_key !== undefined ? { media_key: fin.data.media_key } : {}),
            processing_state: processingState,
            media_type: file.mediaType,
            media_category: category,
            size_bytes: file.size,
            segments,
            ...(fin.data?.expires_after_secs !== undefined
              ? { expires_after_secs: fin.data.expires_after_secs }
              : {}),
            ...(altTextSet !== undefined ? { alt_text_set: altTextSet } : {}),
            ...(note !== undefined ? { note } : {}),
          },
          summary:
            processingState === 'succeeded'
              ? `Media ${mediaId} uploaded (${category}).`
              : `Media ${mediaId} uploaded (${category}); processing is ${processingState} — ` +
                'poll x_media_status until it succeeds before attaching it to a post.',
        };
      } finally {
        await file.handle.close();
      }
    },
  });
}

/**
 * Default-deny instance (no media directory bound). The composition root replaces it via
 * `createMediaTools({ mediaDir })`; until then every upload refuses, which is the correct
 * fail-closed default for a tool that opens local files.
 */
export const xMediaUpload = buildUploadTool({});

// --- x_media_status --------------------------------------------------------------

const statusInput = z
  .object({
    media_id: z
      .string()
      .min(1)
      .describe('The media id returned by x_media_upload whose processing state to check.'),
  })
  .strict();

export const xMediaStatus = defineTool({
  name: 'x_media_status',
  title: 'Check media processing status',
  description:
    'X (Twitter): check the async processing state of an uploaded media by `media_id`. ' +
    'Videos and GIFs process after upload — poll until `processing_state` is `succeeded` ' +
    '(`check_after_secs` suggests when) before attaching the media to a post.',
  policy: 'read:content',
  availability: 'user-only',
  scopes: ['media.write'],
  cost: 'local',
  annotations: {
    title: 'Check media processing status',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  phase: 3,
  input: statusInput,
  handler: async (input, ctx) => {
    const res = await getUploadStatus(ctx.http, { mediaId: input.media_id });
    const data = res.data;
    if (data === undefined) {
      throw apiError(
        `GET /2/media/upload returned an empty envelope for media ${input.media_id}. ` +
          'Retry, and check that the media_id came from x_media_upload.',
      );
    }
    const info = data.processing_info;
    // No `processing_info` means processing is complete (images never carry one).
    const state = info?.state ?? 'succeeded';
    const mediaId = data.id ?? input.media_id;
    // MEDIA-4: `failed` is a terminal platform outcome, not a state to keep polling. It
    // renders as a typed `api` error carrying the platform's own reason, and says plainly
    // that this media_id can never be attached — polling again would only waste calls.
    if (state === 'failed') {
      const reason = info?.error;
      const detail = reason?.message ?? reason?.name;
      throw apiError(
        `Media ${mediaId} failed processing on X and is unusable: do not attach it to a post ` +
          `and do not poll it again — re-upload the file with x_media_upload. Reason: ` +
          `${detail ?? 'the platform reported no failure detail'}.`,
        {
          data: {
            ...(reason?.name !== undefined ? { platform_title: reason.name } : {}),
            ...(reason?.message !== undefined ? { platform_detail: reason.message } : {}),
          },
        },
      );
    }
    return {
      data: {
        media_id: mediaId,
        processing_state: state,
        ...(info?.progress_percent !== undefined
          ? { progress_percent: info.progress_percent }
          : {}),
        ...(info?.check_after_secs !== undefined
          ? { check_after_secs: info.check_after_secs }
          : {}),
      },
      summary:
        state === 'succeeded'
          ? `Media ${mediaId} is ready to attach.`
          : info?.check_after_secs !== undefined
            ? `Media ${mediaId} processing state: ${state}; poll again in ~${info.check_after_secs}s.`
            : `Media ${mediaId} processing state: ${state}.`,
    };
  },
});

/**
 * INT-6 factory: build the media tools bound to composition-root dependencies (the
 * operator's media directory, an optional progress sink). The composition root should
 * register these instead of the default-deny `mediaTools`.
 */
export function createMediaTools(deps: MediaToolDeps) {
  return [buildUploadTool(deps), xMediaStatus] as const;
}

/** Every tool this slice contributes to the registry (default-deny until bound). */
export const mediaTools = [xMediaUpload, xMediaStatus];
