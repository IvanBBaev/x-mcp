// File-backed TokenStore — the persistence half of the OAuth2 refresh machinery
// (docs/02 §4A; docs/04 §4.1/§4.2). Owned by T-202 (WP-2.1). The in-memory refresh
// state machine (T-201, machine.ts) sits above this store; T-203 (index.ts) wires the
// two together. Implements the frozen `TokenStore` port from core/ports.
//
// Guarantees (cases AUTH-5, AUTH-7, AUTH-9, PLAT-1, PLAT-2; threats T1/T3/T13):
//   • Atomic persist: payload → tmp file (`O_CREAT|O_EXCL|O_NOFOLLOW`, 0600, same
//     directory ⇒ same filesystem) → `rename` over the token path. A crash between the
//     tmp write and the rename leaves the previous pair intact. On win32,
//     rename-over-open-file is retried briefly and then surfaced as a typed `auth`
//     error instructing the operator to check the path (PLAT-1).
//   • Cross-process refresh lock at `<token-file>.lock`, created
//     `O_CREAT|O_EXCL|O_NOFOLLOW` 0600, content `{pid, timestamp}`. The stale-lock
//     protocol is FAIL-CLOSED (AUTH-5): only a lock that is BOTH expired (≥ 30 s old)
//     AND provably dead (holder PID gone) is reclaimed; on any ambiguity the caller
//     waits briefly and then throws a typed `auth` error — a live-but-slow holder is
//     never broken into a second refresh. The refresh HTTP timeout (25 s, enforced by
//     the machine) is strictly below the 30 s staleness threshold, so a hung refresh
//     cannot outlive its own lock's staleness window.
//   • Staleness/aging decisions use the injected Clock only — never `Date.now()` — so
//     a skewed or resumed clock cannot fabricate staleness (AUTH-7, PLAT-4); a lock
//     timestamped in the future (peer clock skew) is simply "not stale".
//   • POSIX hygiene: refuses to operate when the token DIRECTORY is group/other-
//     writable (the symlink-plant precondition, SEC-T13); warns once when the token
//     FILE is wider than 0600 (T1 — the next persist rewrites it 0600, which is the
//     "repair" path). Token, lock, and tmp paths are never followed through symlinks.
//     On win32 each POSIX-only check degrades explicitly with its own one-time warning
//     (PLAT-2).
//   • Corrupt, empty, or partial token files raise a typed `auth` error naming the
//     path and the re-authorize command; the file is never deleted or rewritten on
//     load (AUTH-9).
//   • Format migration is forward-only and never guesses (docs/05 §8.7): the file
//     carries a schema `version` (currently 1). An older/missing version loads fine
//     and is stamped current on the next persist; a NEWER version fails closed with an
//     upgrade instruction — the newer shape is never guessed or downgraded. The frozen
//     `TokenPair.version` ("monotonic on-disk revision; bumped on every persist") is a
//     DIFFERENT concept and is serialized as a separate `revision` field.
//
// All filesystem access goes through the injectable `TokenFs` seam so tests can
// simulate `EEXIST` races, win32 rename failures, symlink plants, and kill-9 leftovers
// without real processes; all waiting goes through the injected `Sleep`, so no test
// ever sleeps for real.

import { constants as FSC, promises as fsp } from 'node:fs';
import { dirname } from 'node:path';

import type { Clock, Sleep, TokenPair, TokenStore } from '../../core/ports.js';
import { authError } from '../../core/errors.js';

/** On-disk schema version this build reads and writes (docs/05 §8.7). */
export const TOKEN_FILE_SCHEMA_VERSION = 1;

/**
 * A foreign lock older than this is "expired". The refresh HTTP timeout (25 s, in the
 * machine) is strictly below it, so a live refresh always finishes — or dies — before
 * its own lock can be judged expired (AUTH-5).
 */
export const LOCK_STALE_MS = 30_000;

/**
 * Total time a caller waits on a foreign lock before failing closed. Slightly past
 * `LOCK_STALE_MS` so a crashed holder's lock provably crosses the staleness line
 * during the wait (and is then reclaimed if the PID is dead), while a healthy holder —
 * bounded by the 25 s refresh timeout — finishes well inside this window.
 */
export const LOCK_WAIT_MS = 35_000;

/** Poll interval while waiting on a foreign lock. Sleeping goes through the Sleep port. */
export const LOCK_POLL_MS = 500;

/** win32 rename-over-open-file: total attempts, and the delay between them (PLAT-1). */
export const WIN32_RENAME_ATTEMPTS = 4;
export const WIN32_RENAME_DELAY_MS = 100;

/** Candidate tmp names tried before concluding the directory is cluttered/planted. */
const MAX_TMP_ATTEMPTS = 3;

/** Reclaims of provably-stale locks attempted before treating it as live contention. */
const MAX_RECLAIM_ATTEMPTS = 3;

const AUTHORIZE_HINT = 'Run `npx x-mcp-ai authorize` to create a fresh token file.';

/**
 * The minimal async file-handle surface the store needs — a structural subset of
 * `fs.promises.FileHandle`, so the production default is node:fs verbatim and tests
 * can hand back plain objects.
 */
export interface TokenFileHandle {
  readFile(options: { encoding: 'utf8' }): Promise<string>;
  writeFile(data: string, options: { encoding: 'utf8' }): Promise<void>;
  stat(): Promise<{ mode: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The filesystem seam. Production uses {@link nodeTokenFs} (a thin wrapper over
 * `node:fs/promises`); tests wrap it to inject `EEXIST` races, rename failures, and
 * kill-9 leftovers deterministically.
 */
export interface TokenFs {
  open(path: string, flags: number, mode?: number): Promise<TokenFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<{ mode: number }>;
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
}

/** The production `TokenFs`: `node:fs/promises`, nothing else. */
export const nodeTokenFs: TokenFs = {
  open: (path, flags, mode) => fsp.open(path, flags, mode),
  rename: (oldPath, newPath) => fsp.rename(oldPath, newPath),
  unlink: (path) => fsp.unlink(path),
  stat: (path) => fsp.stat(path),
  mkdir: (path, options) => fsp.mkdir(path, options),
};

export interface FileTokenStoreOptions {
  /** Absolute path of the token file (`X_MCP_TOKEN_FILE` after expansion, CFG-2). */
  readonly path: string;
  /** The only time source — lock timestamps and staleness use it exclusively (AUTH-7). */
  readonly clock: Clock;
  /** All waiting (lock polls, win32 rename retries) goes through this port. */
  readonly sleep: Sleep;
  /** Filesystem seam; defaults to {@link nodeTokenFs}. */
  readonly fs?: TokenFs;
  /** Platform switch for the win32 branches; defaults to `process.platform` (PLAT-1/2). */
  readonly platform?: NodeJS.Platform;
  /** Liveness probe for a foreign lock's PID; defaults to `process.kill(pid, 0)`. */
  readonly isPidAlive?: (pid: number) => boolean;
  /** Warning sink; defaults to `console.warn` (stderr — stdout stays MCP-pure). */
  readonly warn?: (message: string) => void;
}

/** `{pid, timestamp}` as persisted inside the lock file (docs/02 §4A step 2). */
interface LockHolder {
  readonly pid: number;
  readonly timestamp: number;
}

/** `gone` = lock vanished between probes; `unreadable` = cannot attribute → fail closed. */
type LockProbe = LockHolder | 'gone' | 'unreadable';

/** Extract a Node errno code (`'EEXIST'`, `'ELOOP'`, …) from an unknown error. */
function errCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Default PID liveness probe. `EPERM` means the process exists but belongs to another
 * user — alive for our purposes (never steal a lock we cannot attribute, AUTH-5).
 */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errCode(err) === 'EPERM';
  }
}

/**
 * Build the file-backed {@link TokenStore}. One instance per token path per process;
 * the composition root (T-203/T-130) constructs it from the resolved config and the
 * real ports.
 */
export function createFileTokenStore(options: FileTokenStoreOptions): TokenStore {
  const { path, clock, sleep } = options;
  const fs = options.fs ?? nodeTokenFs;
  const platform = options.platform ?? process.platform;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const dir = dirname(path);
  const lockPath = `${path}.lock`;
  const win32 = platform === 'win32';

  const warnedKeys = new Set<string>();
  function warnOnce(key: string, message: string): void {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    warn(message);
  }

  /**
   * `O_NOFOLLOW` for every open. On win32 the flag does not exist; degrade explicitly
   * with a one-time warning rather than silently passing a wrong bit (PLAT-2).
   */
  function noFollowFlag(): number {
    if (win32) {
      warnOnce(
        'nofollow-win32',
        `x-mcp-ai: O_NOFOLLOW is unavailable on Windows; symlink refusal for ${path} degrades to plain opens (PLAT-2).`,
      );
      return 0;
    }
    return FSC.O_NOFOLLOW;
  }

  /**
   * Ensure the token directory exists (0700 for fresh creation) and is not group/
   * other-writable — a writable directory is the symlink-plant / lock-race
   * precondition, so it is a refusal, not a warning (SEC-T13). On win32 the POSIX
   * permission model does not apply; degrade with a one-time warning (PLAT-2).
   */
  async function ensureDir(): Promise<void> {
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw authError(
        `Cannot create the token directory ${dir} (${errCode(err) ?? 'unknown error'}). ` +
          'Check the configured token file path and its permissions.',
        { cause: err },
      );
    }
    if (win32) {
      warnOnce(
        'posix-perms-win32',
        `x-mcp-ai: POSIX permission checks for ${dir} are skipped on Windows; ` +
          'use NTFS ACLs to restrict access to the token file (PLAT-2).',
      );
      return;
    }
    let mode: number;
    try {
      mode = (await fs.stat(dir)).mode;
    } catch (err) {
      throw authError(
        `Cannot inspect the token directory ${dir} (${errCode(err) ?? 'unknown error'}). ` +
          'Check the configured token file path.',
        { cause: err },
      );
    }
    if ((mode & 0o022) !== 0) {
      throw authError(
        `Token directory ${dir} is writable by group or other ` +
          `(mode ${(mode & 0o777).toString(8)}); refusing to operate — a writable token ` +
          `directory enables symlink and lock attacks. Run: chmod 700 ${dir}`,
      );
    }
  }

  /** Typed corruption error: never delete or rewrite the file on load (AUTH-9). */
  function corruptError(detail: string): never {
    throw authError(
      `Token file ${path} ${detail}. The file was left untouched for inspection. ${AUTHORIZE_HINT}`,
    );
  }

  /** Parse + validate the on-disk JSON into a `TokenPair` (AUTH-9; docs/05 §8.7). */
  function parseTokenFile(text: string): TokenPair {
    if (text.trim() === '') corruptError('is empty');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      corruptError('is not valid JSON');
    }
    if (!isRecord(parsed)) corruptError('does not contain a JSON object');

    // Schema-version gate (docs/05 §8.7). Missing → 0 (legacy, pre-versioning) →
    // migrated forward by the next persist. Newer than this build → fail closed:
    // guessing a newer shape risks resurrecting a rotated-out refresh token.
    const version = parsed['version'] ?? 0;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
      corruptError('has a malformed "version" field');
    }
    if (version > TOKEN_FILE_SCHEMA_VERSION) {
      throw authError(
        `Token file ${path} uses format version ${version}, but this build of x-mcp-ai ` +
          `only understands up to version ${TOKEN_FILE_SCHEMA_VERSION}. A newer x-mcp-ai wrote ` +
          'it — upgrade this server to at least that version. The file was left untouched ' +
          'and was not downgraded.',
      );
    }

    const accessToken = parsed['access_token'];
    if (typeof accessToken !== 'string' || accessToken === '') {
      corruptError('is missing the required "access_token" field');
    }
    const obtainedAt = parsed['obtained_at'];
    if (typeof obtainedAt !== 'number' || !Number.isFinite(obtainedAt)) {
      corruptError('is missing a numeric "obtained_at" field');
    }
    const expiresIn = parsed['expires_in'];
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
      corruptError('is missing a numeric "expires_in" field');
    }
    const refreshToken = parsed['refresh_token'];
    if (refreshToken !== undefined && (typeof refreshToken !== 'string' || refreshToken === '')) {
      corruptError('has a malformed "refresh_token" field');
    }
    const revision = parsed['revision'];
    const hasRevision = typeof revision === 'number' && Number.isInteger(revision) && revision >= 0;

    return {
      access_token: accessToken,
      obtained_at: obtainedAt,
      expires_in: expiresIn,
      ...(typeof refreshToken === 'string' ? { refresh_token: refreshToken } : {}),
      ...(hasRevision ? { version: revision } : {}),
    };
  }

  async function load(): Promise<TokenPair | null> {
    await ensureDir();
    let handle: TokenFileHandle;
    try {
      handle = await fs.open(path, FSC.O_RDONLY | noFollowFlag());
    } catch (err) {
      const code = errCode(err);
      if (code === 'ENOENT') return null;
      if (code === 'ELOOP' || code === 'EMLINK') {
        throw authError(
          `Token file ${path} is a symbolic link; refusing to follow it. ` +
            `Replace it with a regular file. ${AUTHORIZE_HINT}`,
          { cause: err },
        );
      }
      throw authError(
        `Cannot open the token file ${path} (${code ?? 'unknown error'}). ${AUTHORIZE_HINT}`,
        { cause: err },
      );
    }
    let text: string;
    try {
      if (!win32) {
        // fstat on the open handle (not a second path lookup) → no TOCTOU window (T1).
        const { mode } = await handle.stat();
        if ((mode & 0o077) !== 0) {
          warnOnce(
            'token-file-perms',
            `x-mcp-ai: token file ${path} is accessible by group or other ` +
              `(mode ${(mode & 0o777).toString(8)}); tighten it with: chmod 600 ${path}. ` +
              'The next token refresh rewrites it with mode 0600.',
          );
        }
      }
      text = await handle.readFile({ encoding: 'utf8' });
    } catch (err) {
      throw authError(
        `Cannot read the token file ${path} (${errCode(err) ?? 'unknown error'}). ${AUTHORIZE_HINT}`,
        { cause: err },
      );
    } finally {
      await handle.close().catch(() => undefined);
    }
    return parseTokenFile(text);
  }

  // Monotonic per-process tmp-name sequence. Combined with the PID, collisions can
  // only come from leftovers of a DEAD process or an adversarial plant — both of which
  // O_EXCL refuses, and the next candidate name sidesteps (never reuse, never follow).
  let tmpSeq = 0;

  /** Write the payload to a fresh tmp file (O_EXCL, 0600) and return its path. */
  async function writeTmp(payload: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_TMP_ATTEMPTS; attempt += 1) {
      const tmpPath = `${path}.${process.pid}.${tmpSeq}.tmp`;
      tmpSeq += 1;
      let handle: TokenFileHandle;
      try {
        handle = await fs.open(
          tmpPath,
          FSC.O_WRONLY | FSC.O_CREAT | FSC.O_EXCL | noFollowFlag(),
          0o600,
        );
      } catch (err) {
        if (errCode(err) === 'EEXIST') continue; // occupied name (leftover/plant) — try the next
        throw authError(
          `Cannot create a temporary file next to ${path} (${errCode(err) ?? 'unknown error'}); ` +
            'the refreshed token was NOT saved. Check the token directory and its permissions.',
          { cause: err },
        );
      }
      try {
        await handle.writeFile(payload, { encoding: 'utf8' });
        await handle.sync();
      } catch (err) {
        await handle.close().catch(() => undefined);
        await fs.unlink(tmpPath).catch(() => undefined);
        throw authError(
          `Cannot write the token file next to ${path} (${errCode(err) ?? 'unknown error'}); ` +
            'the refreshed token was NOT saved. Check free space and permissions.',
          { cause: err },
        );
      }
      await handle.close();
      return tmpPath;
    }
    throw authError(
      `Could not create a temporary file next to ${path}: every candidate name already ` +
        'exists (possible symlink plant or leftover files). The refreshed token was NOT ' +
        `saved; inspect the directory and remove stray "*.tmp" entries. (SEC-T13)`,
    );
  }

  /**
   * Rename the tmp file over the token path. POSIX rename is atomic and replaces; on
   * win32 rename-over-open-file can fail while a reader holds the destination — retry
   * briefly, then surface a typed `auth` error naming the path (PLAT-1). The caller
   * keeps using the rotated pair in memory for the session.
   */
  async function renameIntoPlace(tmpPath: string): Promise<void> {
    const attempts = win32 ? WIN32_RENAME_ATTEMPTS : 1;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await fs.rename(tmpPath, path);
        return;
      } catch (err) {
        const code = errCode(err);
        const win32Retryable =
          win32 && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'EEXIST');
        if (win32Retryable && attempt < attempts) {
          await sleep(WIN32_RENAME_DELAY_MS);
          continue;
        }
        throw authError(
          `Could not save the refreshed token to ${path} (${code ?? 'unknown error'})` +
            (win32 ? ' — another program may be holding the file open.' : '.') +
            ' The refreshed pair stays usable in memory for this session only; check the ' +
            'token file path and permissions before the next restart.',
          { cause: err },
        );
      }
    }
  }

  async function persist(pair: TokenPair): Promise<void> {
    await ensureDir();
    const body: Record<string, unknown> = {
      version: TOKEN_FILE_SCHEMA_VERSION,
      // The frozen TokenPair.version revision counter: bumped on every persist so the
      // machine's adopt-on-disk-pair reconciliation can compare pairs cheaply.
      revision: (pair.version ?? 0) + 1,
      access_token: pair.access_token,
      obtained_at: pair.obtained_at,
      expires_in: pair.expires_in,
    };
    if (pair.refresh_token !== undefined) body['refresh_token'] = pair.refresh_token;
    const payload = `${JSON.stringify(body, null, 2)}\n`;

    const tmpPath = await writeTmp(payload);
    try {
      await renameIntoPlace(tmpPath);
    } catch (err) {
      // Best-effort cleanup; the invariant that matters is that the OLD pair is intact.
      await fs.unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }

  /** Read `{pid, timestamp}` out of the current lock file, without following symlinks. */
  async function readLockHolder(): Promise<LockProbe> {
    let text: string;
    try {
      const handle = await fs.open(lockPath, FSC.O_RDONLY | noFollowFlag());
      try {
        text = await handle.readFile({ encoding: 'utf8' });
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch (err) {
      // ENOENT: released between our O_EXCL failure and this read. Anything else
      // (ELOOP for a symlinked lock, EACCES, …) cannot be attributed → 'unreadable'
      // → the caller fails closed rather than reclaim (AUTH-5, SEC-T13).
      return errCode(err) === 'ENOENT' ? 'gone' : 'unreadable';
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) {
        const pid = parsed['pid'];
        const timestamp = parsed['timestamp'];
        if (
          typeof pid === 'number' &&
          Number.isInteger(pid) &&
          pid > 0 &&
          typeof timestamp === 'number' &&
          Number.isFinite(timestamp)
        ) {
          return { pid, timestamp };
        }
      }
    } catch {
      // Fall through: partial write from a kill-9 mid-write → 'unreadable'.
    }
    return 'unreadable';
  }

  /** One O_EXCL attempt: `true` on acquisition, `false` on EEXIST (lock held). */
  async function tryCreateLock(): Promise<boolean> {
    let handle: TokenFileHandle;
    try {
      handle = await fs.open(
        lockPath,
        FSC.O_WRONLY | FSC.O_CREAT | FSC.O_EXCL | noFollowFlag(),
        0o600,
      );
    } catch (err) {
      if (errCode(err) === 'EEXIST') return false;
      throw authError(
        `Cannot create the refresh lock ${lockPath} (${errCode(err) ?? 'unknown error'}). ` +
          'Check the token directory and its permissions.',
        { cause: err },
      );
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, timestamp: clock.now() }), {
        encoding: 'utf8',
      });
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => undefined);
      await fs.unlink(lockPath).catch(() => undefined);
      throw authError(
        `Cannot write the refresh lock ${lockPath} (${errCode(err) ?? 'unknown error'}). ` +
          'Check the token directory and its permissions.',
        { cause: err },
      );
    }
    await handle.close().catch(() => undefined);
    return true;
  }

  /**
   * Acquire `<token-file>.lock` (docs/02 §4A step 2). Fail-closed protocol (AUTH-5):
   * reclaim ONLY a lock that is both expired (≥ `LOCK_STALE_MS` by the injected Clock)
   * and provably dead (holder PID gone); otherwise wait up to `LOCK_WAIT_MS` in
   * `LOCK_POLL_MS` steps, then throw a typed `auth` error. The O_EXCL re-create is the
   * arbiter for reclaim races: two processes may both judge a lock stale, but only one
   * create succeeds — the loser simply sees EEXIST again and re-enters the wait.
   */
  async function acquireLock(): Promise<void> {
    await ensureDir();
    let waitedMs = 0;
    let reclaims = 0;
    for (;;) {
      if (await tryCreateLock()) return;
      const holder = await readLockHolder();
      if (holder !== 'gone' && holder !== 'unreadable') {
        // Age by the injected Clock only; a future timestamp (peer clock skew) yields
        // a negative age and is therefore never stale (AUTH-7).
        const age = clock.now() - holder.timestamp;
        if (age >= LOCK_STALE_MS && !isPidAlive(holder.pid) && reclaims < MAX_RECLAIM_ATTEMPTS) {
          reclaims += 1;
          await fs.unlink(lockPath).catch(() => undefined);
          continue;
        }
      }
      if (waitedMs >= LOCK_WAIT_MS) {
        throw authError(
          `Another x-mcp-ai process appears to hold the token refresh lock ${lockPath} ` +
            'and it cannot be proven stale; failing closed instead of risking a double ' +
            'refresh (two refreshes with the same token can lock the account). If no other ' +
            `process is running, inspect and remove the lock file, then retry. ${AUTHORIZE_HINT}`,
        );
      }
      await sleep(LOCK_POLL_MS);
      waitedMs += LOCK_POLL_MS;
    }
  }

  /**
   * Release the lock — but only when it is provably OURS. If a peer reclaimed it
   * (possible only after we were stale-and-presumed-dead), or the content cannot be
   * attributed, leave it in place and warn: removing an unattributed lock is exactly
   * the break-and-refresh this store exists to prevent (AUTH-5).
   */
  async function releaseLock(): Promise<void> {
    const holder = await readLockHolder();
    if (holder === 'gone') return;
    if (holder === 'unreadable' || holder.pid !== process.pid) {
      warn(
        `x-mcp-ai: not removing the refresh lock ${lockPath}: it no longer looks like this ` +
          "process's lock (a peer may have reclaimed it). Remove it manually if no other " +
          'x-mcp-ai process is running.',
      );
      return;
    }
    await fs.unlink(lockPath).catch((err: unknown) => {
      if (errCode(err) !== 'ENOENT') {
        warn(
          `x-mcp-ai: could not remove the refresh lock ${lockPath} ` +
            `(${errCode(err) ?? 'unknown error'}); remove it manually.`,
        );
      }
    });
  }

  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    await acquireLock();
    try {
      return await fn();
    } finally {
      await releaseLock();
    }
  }

  return { load, persist, withLock };
}
