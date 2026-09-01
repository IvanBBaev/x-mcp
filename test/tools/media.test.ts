// Tests for the media tools (T-303 + T-304): x_media_upload / x_media_status. Each
// network test builds a REAL http client (api/http) over an undici MockAgent and drives
// the handler end to end: local file open/validation -> INIT -> APPEND -> FINALIZE (->
// metadata) -> compact output. Interceptors pin exact DEDICATED v2 paths, methods, and
// JSON bodies (MEDIA-1) — with net connect disabled, a retired v1.1 route could never be
// hit, and an APPEND that should not happen shows up as an unmatched request.
//
// T-304 adds the path-security battery (MEDIA-5/6), the boundary battery (MEDIA-2), the
// failed-processing mapping (MEDIA-4) and cancellation/progress (MEDIA-7). Every upload
// runs through a tool bound to a temp media directory (`createMediaTools`), because with
// no directory configured the tool is default-deny.
//
// Uploads read small temp files created under the OS temp dir and removed in teardown;
// no real media and no network are ever touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, parse, sep } from 'node:path';

import { MEDIA_SEGMENT_BYTES, MEDIA_SIZE_CAPS } from '../../src/api/endpoints/media.js';
import { mapHttpError } from '../../src/api/errors.js';
import { createHttpClient } from '../../src/api/http.js';
import { XError, networkError } from '../../src/core/errors.js';
import { withCallSignal } from '../../src/core/registry.js';
import type { EndpointInvoker, ToolContext, XApiRequest } from '../../src/core/tooldef.js';
import {
  createMediaTools,
  mediaTools,
  openMediaFile,
  openNoFollow,
  xMediaStatus,
  xMediaUpload,
} from '../../src/tools/media.js';
import type { MediaUploadProgress } from '../../src/tools/media.js';

import { loadFixture, makePorts, mockHttp } from '../helpers/index.js';
import type { MockHttp } from '../helpers/index.js';

/** The wrapper shape of the error fixtures under test/fixtures/errors/. */
interface ErrorFixture {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** Build a ToolContext over a real http client bound to the mock dispatcher. */
function contextFor(mock: MockHttp, signal?: AbortSignal): ToolContext {
  const ports = makePorts({ dispatcher: mock.dispatcher });
  const http = createHttpClient({
    sleep: ports.sleep,
    random: ports.random,
    dispatcher: mock.dispatcher,
    mapError: mapHttpError,
  });
  return { ports, http, ...(signal !== undefined ? { signal } : {}) };
}

/** A context whose invoker fails loudly — proves a handler never reached the network. */
function noHttpCtx(signal?: AbortSignal): ToolContext {
  return {
    ports: makePorts(),
    http: {
      send: () => Promise.reject(new Error('endpoint must not be called for invalid input')),
    },
    ...(signal !== undefined ? { signal } : {}),
  };
}

// All media test files live in one throwaway directory under the OS temp dir; that
// directory IS the configured media directory for the bound tool below.
const tmpRoot = mkdtempSync(join(tmpdir(), 'x-mcp-media-test-'));
// A second directory OUTSIDE the media directory — the target of every escape attempt.
const outsideRoot = mkdtempSync(join(tmpdir(), 'x-mcp-media-outside-'));
test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

/** The upload tool bound to the temp media directory (INT-6 factory). */
const [upload] = createMediaTools({ mediaDir: tmpRoot });

/**
 * Real magic bytes per format — the same-fd sniff (MEDIA-6) refuses anything else, so
 * every fixture below carries a genuine signature.
 */
const MAGIC = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  webp: Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'latin1'),
  ]),
  gif: Buffer.from('GIF89a', 'latin1'),
  mp4: Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom', 'latin1')]),
  mov: Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x14]), Buffer.from('ftypqt  ', 'latin1')]),
};

/** Bytes of exactly `size` that sniff as `kind` (signature + filler). */
function mediaBytes(kind: keyof typeof MAGIC, size: number): Buffer {
  const magic = MAGIC[kind];
  const buf = Buffer.alloc(size, 7);
  magic.copy(buf, 0, 0, Math.min(magic.length, size));
  return buf;
}

/** Write a small temp media file inside the media directory and return its absolute path. */
function tempFile(name: string, content: string | Buffer): string {
  const path = join(tmpRoot, name);
  writeFileSync(path, content);
  return path;
}

/**
 * A file of exactly `size` bytes carrying a real signature, created SPARSELY: the size
 * checks read `fstat`, never the bytes, so the multi-MiB cap boundaries cost no disk.
 */
function sparseFile(name: string, kind: keyof typeof MAGIC, size: number): string {
  const path = join(tmpRoot, name);
  const fd = openSync(path, 'w');
  try {
    const magic = MAGIC[kind];
    writeSync(fd, magic, 0, magic.length, 0);
    ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }
  return path;
}

/** Base64 of a buffer, as it rides in the APPEND body. */
const b64 = (buf: Buffer): string => buf.toString('base64');

/**
 * Symlink creation needs a privilege on Windows that CI accounts may not have; probe once
 * so the symlink axes skip with a reason instead of failing for the wrong cause.
 */
const symlinkSkip = ((): string | false => {
  const target = join(tmpRoot, '.probe');
  const link = join(tmpRoot, '.probe-link');
  try {
    writeFileSync(target, 'x');
    symlinkSync(target, link);
    return false;
  } catch {
    return 'this platform/account cannot create symlinks';
  } finally {
    rmSync(link, { force: true });
    rmSync(target, { force: true });
  }
})();

/** Create a named pipe, or report why this platform cannot (win32 has no mkfifo). */
function makeFifo(name: string): string | undefined {
  if (process.platform === 'win32') return undefined;
  const path = join(tmpRoot, name);
  try {
    execFileSync('mkfifo', [path]);
    return path;
  } catch {
    return undefined;
  }
}

// --- Contract axes ---------------------------------------------------------------

test('MEDIA-3: mediaTools exposes upload + status as SEPARATE tools with catalog axes', () => {
  assert.deepEqual(mediaTools, [xMediaUpload, xMediaStatus]);
  assert.equal(xMediaUpload.name, 'x_media_upload');
  assert.equal(xMediaStatus.name, 'x_media_status');
  for (const tool of mediaTools) {
    assert.equal(tool.availability, 'user-only');
    assert.equal(tool.phase, 3);
    assert.deepEqual([...tool.scopes], ['media.write']);
    assert.equal(tool.annotations.openWorldHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
  }
  // Upload is a paid content write; re-running it uploads (and bills) again.
  assert.equal(xMediaUpload.policy, 'write:content');
  assert.equal(xMediaUpload.cost, 'w:action');
  assert.equal(xMediaUpload.annotations.readOnlyHint, false);
  assert.equal(xMediaUpload.annotations.idempotentHint, false);
  // Status is a cheap read-only poll.
  assert.equal(xMediaStatus.policy, 'read:content');
  assert.equal(xMediaStatus.cost, 'local');
  assert.equal(xMediaStatus.annotations.readOnlyHint, true);
  assert.equal(xMediaStatus.annotations.idempotentHint, true);
  // The bound factory instance is the SAME tool, only with a media directory closed over.
  const [boundUpload, boundStatus] = createMediaTools({ mediaDir: tmpRoot });
  assert.equal(boundStatus, xMediaStatus);
  assert.equal(boundUpload.name, xMediaUpload.name);
  assert.equal(boundUpload.policy, xMediaUpload.policy);
  assert.equal(boundUpload.cost, xMediaUpload.cost);
  assert.equal(boundUpload.availability, xMediaUpload.availability);
  assert.deepEqual(boundUpload.annotations, xMediaUpload.annotations);
});

// --- x_media_upload happy paths ---------------------------------------------------

test('MEDIA-1: image upload drives ONLY the dedicated v2 paths INIT -> APPEND -> FINALIZE', async () => {
  const content = mediaBytes('png', 12); // 12 bytes -> one segment
  const path = tempFile('one.png', content);
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/media/upload/initialize',
      method: 'POST',
      body: '{"media_category":"tweet_image","media_type":"image/png","total_bytes":12}',
    })
    .reply(200, loadFixture<Record<string, unknown>>('media/initialize.json'));
  mock.pool
    .intercept({
      path: '/2/media/upload/7100/append',
      method: 'POST',
      body: `{"segment_index":0,"media":"${b64(content)}"}`,
    })
    .reply(204);
  mock.pool
    .intercept({ path: '/2/media/upload/7100/finalize', method: 'POST' })
    .reply(200, loadFixture<Record<string, unknown>>('media/finalize-image.json'));

  const out = await upload.handler({ path }, contextFor(mock));
  assert.deepEqual(out.data, {
    media_id: '7100',
    media_key: '3_7100',
    processing_state: 'succeeded',
    media_type: 'image/png',
    media_category: 'tweet_image',
    size_bytes: 12,
    segments: 1,
    expires_after_secs: 86400,
  });
  assert.equal(out.summary, 'Media 7100 uploaded (tweet_image).');
  mock.assertDone();
  await mock.close();
});

test('MEDIA-1: video upload splits raw segments under the 5 MB cap and returns pending after FINALIZE', async () => {
  assert.ok(MEDIA_SEGMENT_BYTES < 5 * 1024 * 1024, 'raw segment size must stay under 5 MB');
  const totalBytes = MEDIA_SEGMENT_BYTES + 3; // -> exactly two segments: 4 MiB + 3 bytes
  const path = tempFile('clip.mp4', mediaBytes('mp4', totalBytes));
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/media/upload/initialize',
      method: 'POST',
      body: `{"media_category":"tweet_video","media_type":"video/mp4","total_bytes":${totalBytes}}`,
    })
    .reply(200, { data: { id: '7200', media_key: '13_7200' } });
  // Function matcher: record each segment's index and DECODED byte length off the wire.
  const segments = new Map<number, number>();
  mock.pool
    .intercept({
      path: '/2/media/upload/7200/append',
      method: 'POST',
      body: (raw: string) => {
        const parsed = JSON.parse(raw) as { segment_index: number; media: string };
        segments.set(parsed.segment_index, Buffer.from(parsed.media, 'base64').byteLength);
        return true;
      },
    })
    .reply(204)
    .times(2);
  mock.pool
    .intercept({ path: '/2/media/upload/7200/finalize', method: 'POST' })
    .reply(200, loadFixture<Record<string, unknown>>('media/finalize-video-pending.json'));

  const out = await upload.handler({ path }, contextFor(mock));
  assert.deepEqual(
    [...segments.entries()],
    [
      [0, MEDIA_SEGMENT_BYTES],
      [1, 3],
    ],
  );
  const data = out.data as { processing_state: string; segments: number; media_id: string };
  assert.equal(data.media_id, '7200');
  assert.equal(data.segments, 2);
  assert.equal(data.processing_state, 'pending');
  assert.match(out.summary ?? '', /poll x_media_status/);
  mock.assertDone();
  await mock.close();
});

test('MEDIA-6: a gif defaults to tweet_gif from its content; an explicit media_category still wins on the wire', async () => {
  const content = mediaBytes('gif', 6); // 6 bytes: exactly the GIF89a signature
  const path = tempFile('anim.gif', content);
  const appendBody = `{"segment_index":0,"media":"${b64(content)}"}`;
  const mock = mockHttp();

  // Flow 1: no media_category input -> the sniffed default, tweet_gif.
  mock.pool
    .intercept({
      path: '/2/media/upload/initialize',
      method: 'POST',
      body: '{"media_category":"tweet_gif","media_type":"image/gif","total_bytes":6}',
    })
    .reply(200, loadFixture<Record<string, unknown>>('media/initialize.json'));
  mock.pool
    .intercept({ path: '/2/media/upload/7100/append', method: 'POST', body: appendBody })
    .reply(204);
  mock.pool
    .intercept({ path: '/2/media/upload/7100/finalize', method: 'POST' })
    .reply(200, { data: { id: '7100', media_key: '3_7100' } });
  const defaulted = await upload.handler({ path }, contextFor(mock));
  assert.equal((defaulted.data as { media_category: string }).media_category, 'tweet_gif');
  // No expires_after_secs in this FINALIZE envelope -> the field is absent, not undefined.
  assert.equal('expires_after_secs' in (defaulted.data as object), false);

  // Flow 2: explicit media_category overrides the detected default; media_type stays gif.
  mock.pool
    .intercept({
      path: '/2/media/upload/initialize',
      method: 'POST',
      body: '{"media_category":"tweet_image","media_type":"image/gif","total_bytes":6}',
    })
    .reply(200, loadFixture<Record<string, unknown>>('media/initialize.json'));
  mock.pool
    .intercept({ path: '/2/media/upload/7100/append', method: 'POST', body: appendBody })
    .reply(204);
  mock.pool
    .intercept({ path: '/2/media/upload/7100/finalize', method: 'POST' })
    .reply(200, { data: { id: '7100', media_key: '3_7100' } });
  const overridden = await upload.handler(
    { path, media_category: 'tweet_image' },
    contextFor(mock),
  );
  assert.equal((overridden.data as { media_category: string }).media_category, 'tweet_image');

  mock.assertDone();
  await mock.close();
});

test('MEDIA-3: alt_text is an upload param — POST /2/media/metadata fires after FINALIZE, with no separate metadata tool', async () => {
  const content = mediaBytes('png', 12);
  const path = tempFile('alt.png', content);
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/media/upload/initialize',
      method: 'POST',
      body: '{"media_category":"tweet_image","media_type":"image/png","total_bytes":12}',
    })
    .reply(200, loadFixture<Record<string, unknown>>('media/initialize.json'));
  mock.pool
    .intercept({
      path: '/2/media/upload/7100/append',
      method: 'POST',
      body: `{"segment_index":0,"media":"${b64(content)}"}`,
    })
    .reply(204);
  mock.pool
    .intercept({ path: '/2/media/upload/7100/finalize', method: 'POST' })
    .reply(200, loadFixture<Record<string, unknown>>('media/finalize-image.json'));
  mock.pool
    .intercept({
      path: '/2/media/metadata',
      method: 'POST',
      body: '{"id":"7100","metadata":{"alt_text":{"text":"A red panda sleeping on a branch."}}}',
    })
    .reply(200, loadFixture<Record<string, unknown>>('media/metadata-ok.json'));

  const out = await upload.handler(
    { path, alt_text: 'A red panda sleeping on a branch.' },
    contextFor(mock),
  );
  const data = out.data as { alt_text_set: boolean; media_id: string };
  assert.equal(data.alt_text_set, true);
  assert.equal(data.media_id, '7100');
  mock.assertDone();
  await mock.close();
});

test('MEDIA-3: a failed alt_text call never loses the uploaded media_id (best-effort metadata)', async () => {
  const path = tempFile('alt-fail.png', mediaBytes('png', 12));
  const fx = loadFixture<ErrorFixture>('errors/403-suspended-target.json');
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/media/upload/initialize', method: 'POST' })
    .reply(200, loadFixture<Record<string, unknown>>('media/initialize.json'));
  mock.pool.intercept({ path: '/2/media/upload/7100/append', method: 'POST' }).reply(204);
  mock.pool
    .intercept({ path: '/2/media/upload/7100/finalize', method: 'POST' })
    .reply(200, loadFixture<Record<string, unknown>>('media/finalize-image.json'));
  mock.pool
    .intercept({ path: '/2/media/metadata', method: 'POST' })
    .reply(fx.status, fx.body as Record<string, unknown>, { headers: fx.headers });

  // No throw: the upload succeeded and the paid media_id must survive the metadata 403.
  const out = await upload.handler({ path, alt_text: 'desc' }, contextFor(mock));
  const data = out.data as { media_id: string; alt_text_set: boolean; note: string };
  assert.equal(data.media_id, '7100');
  assert.equal(data.alt_text_set, false);
  assert.match(data.note, /media_id is still usable/);
  mock.assertDone();
  await mock.close();
});

test('MEDIA-3: upload returns as soon as FINALIZE does — it never polls STATUS itself', async () => {
  const path = tempFile('async.mp4', mediaBytes('mp4', 32));
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/media/upload/initialize', method: 'POST' })
    .reply(200, { data: { id: '7900' } });
  mock.pool.intercept({ path: '/2/media/upload/7900/append', method: 'POST' }).reply(204);
  mock.pool.intercept({ path: '/2/media/upload/7900/finalize', method: 'POST' }).reply(200, {
    data: { id: '7900', processing_info: { state: 'in_progress', check_after_secs: 10 } },
  });
  // No STATUS interceptor is registered: a handler that polled processing itself would hit
  // the net-connect-disabled agent and fail this test loudly — which is the whole point of
  // upload and status being SEPARATE tool calls (a long video must not block one call).

  const out = await upload.handler({ path }, contextFor(mock));
  const data = out.data as { processing_state: string; media_id: string };
  assert.equal(data.media_id, '7900');
  assert.equal(data.processing_state, 'in_progress');
  // The result hands the agent the next call to make rather than waiting for it.
  assert.match(out.summary ?? '', /poll x_media_status/);
  // And there is no third media tool: alt text rides on upload, status is the only poller.
  assert.deepEqual(
    mediaTools.map((tool) => tool.name),
    ['x_media_upload', 'x_media_status'],
  );
  mock.assertDone();
  await mock.close();
});

// --- x_media_status ---------------------------------------------------------------

test('status: GET /2/media/upload?command=STATUS maps processing_info fields', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/media/upload',
      method: 'GET',
      query: { command: 'STATUS', media_id: '7200' },
    })
    .reply(200, loadFixture<Record<string, unknown>>('media/status-in-progress.json'));

  const out = await xMediaStatus.handler({ media_id: '7200' }, contextFor(mock));
  assert.deepEqual(out.data, {
    media_id: '7200',
    processing_state: 'in_progress',
    progress_percent: 45,
    check_after_secs: 5,
  });
  assert.match(out.summary ?? '', /poll again in ~5s/);
  mock.assertDone();
  await mock.close();
});

test('status: succeeded processing reports ready-to-attach', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/media/upload',
      method: 'GET',
      query: { command: 'STATUS', media_id: '7200' },
    })
    .reply(200, loadFixture<Record<string, unknown>>('media/status-succeeded.json'));

  const out = await xMediaStatus.handler({ media_id: '7200' }, contextFor(mock));
  assert.deepEqual(out.data, {
    media_id: '7200',
    processing_state: 'succeeded',
    progress_percent: 100,
  });
  assert.equal(out.summary, 'Media 7200 is ready to attach.');
  mock.assertDone();
  await mock.close();
});

test('status: an image with no processing_info reports succeeded; missing id falls back', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/media/upload',
      method: 'GET',
      query: { command: 'STATUS', media_id: '7100' },
    })
    .reply(200, { data: { id: '7100', media_key: '3_7100' } });
  const out = await xMediaStatus.handler({ media_id: '7100' }, contextFor(mock));
  assert.deepEqual(out.data, { media_id: '7100', processing_state: 'succeeded' });

  // Envelope with data but no id: the requested media_id fills in.
  mock.pool
    .intercept({
      path: '/2/media/upload',
      method: 'GET',
      query: { command: 'STATUS', media_id: '7300' },
    })
    .reply(200, { data: {} });
  const fallback = await xMediaStatus.handler({ media_id: '7300' }, contextFor(mock));
  assert.deepEqual(fallback.data, { media_id: '7300', processing_state: 'succeeded' });

  mock.assertDone();
  await mock.close();
});

test('status: an empty envelope yields a typed api error', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/media/upload',
      method: 'GET',
      query: { command: 'STATUS', media_id: '7400' },
    })
    .reply(200, {});

  await assert.rejects(
    () => xMediaStatus.handler({ media_id: '7400' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'api');
      assert.match(err.message, /empty envelope/);
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

test('status: an unknown media_id surfaces a typed not-found error', async () => {
  const fx = loadFixture<ErrorFixture>('errors/404-not-found.json');
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/media/upload',
      method: 'GET',
      query: { command: 'STATUS', media_id: '999' },
    })
    .reply(fx.status, fx.body as Record<string, unknown>, { headers: fx.headers });

  await assert.rejects(
    () => xMediaStatus.handler({ media_id: '999' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'not-found');
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

// --- MEDIA-4: failed processing ---------------------------------------------------

test('MEDIA-4: a failed STATUS renders a typed api error with the platform reason and calls the media_id unusable', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/media/upload',
      method: 'GET',
      query: { command: 'STATUS', media_id: '7200' },
    })
    .reply(200, {
      data: {
        id: '7200',
        media_key: '13_7200',
        processing_info: {
          state: 'failed',
          progress_percent: 0,
          error: { code: 3, name: 'InvalidMedia', message: 'Unsupported video format' },
        },
      },
    });

  await assert.rejects(
    () => xMediaStatus.handler({ media_id: '7200' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'api');
      // The media_id is reported as unusable — not as a state worth polling again.
      assert.match(err.message, /unusable/);
      assert.match(err.message, /do not poll it again/);
      // The platform's own failure reason rides along, verbatim.
      assert.match(err.message, /Unsupported video format/);
      assert.equal(err.data.platform_title, 'InvalidMedia');
      assert.equal(err.data.platform_detail, 'Unsupported video format');
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

test('MEDIA-4: a failed STATUS with no error detail still errors, saying the platform gave no reason', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/media/upload',
      method: 'GET',
      query: { command: 'STATUS', media_id: '7201' },
    })
    .reply(200, { data: { id: '7201', processing_info: { state: 'failed' } } });

  await assert.rejects(
    () => xMediaStatus.handler({ media_id: '7201' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'api');
      assert.match(err.message, /no failure detail/);
      assert.equal(err.data.platform_title, undefined);
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

// --- MEDIA-5: path security -------------------------------------------------------

test('MEDIA-5: default-deny — with no media directory configured every upload refuses locally', async () => {
  const path = tempFile('denied.png', mediaBytes('png', 12));
  // The unbound (composition-default) tool has no media directory closed over.
  await assert.rejects(
    () => xMediaUpload.handler({ path }, noHttpCtx()),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.equal(err.fix, 'operator');
      assert.match(err.message, /X_MCP_MEDIA_DIR/);
      assert.match(err.message, /Nothing was uploaded/);
      return true;
    },
  );
  // Same refusal for a path that does not exist: default-deny fires BEFORE any I/O, so
  // the message never reveals whether the file is there.
  await assert.rejects(
    () => openMediaFile(join(tmpRoot, 'nope.png')),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.match(err.message, /no media directory is configured/);
      return true;
    },
  );
});

test('MEDIA-5: a whitespace-only media directory counts as unconfigured (default-deny, not a root of "")', async () => {
  const path = tempFile('blank-dir.png', mediaBytes('png', 12));
  for (const mediaDir of ['', '   ', '\t\n']) {
    await assert.rejects(
      () => openMediaFile(path, { mediaDir }),
      (err: unknown) => {
        assert.ok(XError.is(err));
        assert.equal(err.kind, 'validation');
        assert.equal(err.fix, 'operator');
        assert.match(err.message, /no media directory is configured/);
        return true;
      },
    );
  }
});

test('MEDIA-5: a configured media directory that does not exist is an operator-fixable refusal', async () => {
  await assert.rejects(
    () => openMediaFile('x.png', { mediaDir: join(tmpRoot, 'no-such-dir') }),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.equal(err.fix, 'operator');
      assert.match(err.message, /does not exist or is not readable/);
      return true;
    },
  );
});

test('MEDIA-5: ../ traversal out of the media directory is a validation error', async () => {
  const outsidePath = join(outsideRoot, 'secret.png');
  writeFileSync(outsidePath, mediaBytes('png', 12));
  // Both spellings of the same escape: an absolute path outside, and a relative `../` one
  // (relative paths resolve against the media directory, never the process cwd).
  const relative = join('..', basename(outsideRoot), 'secret.png');
  for (const path of [outsidePath, relative]) {
    await assert.rejects(
      () => upload.handler({ path }, noHttpCtx()),
      (err: unknown) => {
        assert.ok(XError.is(err));
        assert.equal(err.kind, 'validation');
        assert.match(err.message, /resolves outside the configured media directory/);
        // The refusal is containment, not a failed open — the file is never touched.
        assert.doesNotMatch(err.message, /Cannot open media file/);
        return true;
      },
    );
  }
});

test('MEDIA-5: a ~-prefixed path is expanded and then refused for landing outside the media directory', async () => {
  // `~` expansion happens on BOTH the media directory and the requested path, so `~/x.png`
  // cannot be used to smuggle the server's home directory past the containment test.
  assert.notEqual(homedir(), tmpRoot);
  await assert.rejects(
    () => upload.handler({ path: '~/secret.png' }, noHttpCtx()),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /resolves outside the configured media directory/);
      return true;
    },
  );
});

test('MEDIA-5: the media directory itself is not an uploadable file', async () => {
  // A directory named like a media file: containment refuses the root itself before the
  // open, so "upload the whole directory" can never be mistaken for a file inside it.
  const rootLike = join(tmpRoot, 'root-like.png');
  mkdirSync(rootLike, { recursive: true });
  // Three spellings of "the root itself": plain, with a trailing separator, and reached by
  // a `../` that lands exactly back on it.
  for (const path of [rootLike, rootLike + sep, join(rootLike, 'sub', '..')]) {
    await assert.rejects(
      () => openMediaFile(path, { mediaDir: rootLike }),
      (err: unknown) => {
        assert.ok(XError.is(err));
        assert.equal(err.kind, 'validation');
        assert.match(err.message, /resolves outside the configured media directory/);
        return true;
      },
    );
  }
});

test('MEDIA-5: a path whose parent directory does not exist is refused without probing further', async () => {
  await assert.rejects(
    () => upload.handler({ path: join(tmpRoot, 'no-such-sub', 'deep.png') }, noHttpCtx()),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /Cannot open media file/);
      assert.match(err.message, /Nothing was uploaded/);
      return true;
    },
  );
});

test(
  'MEDIA-5: a symlink whose target leaves the media directory is refused (O_NOFOLLOW)',
  { skip: symlinkSkip },
  async () => {
    const outsidePath = join(outsideRoot, 'linked.png');
    writeFileSync(outsidePath, mediaBytes('png', 12));
    const link = join(tmpRoot, 'escape.png');
    symlinkSync(outsidePath, link);
    await assert.rejects(
      () => upload.handler({ path: link }, noHttpCtx()),
      (err: unknown) => {
        assert.ok(XError.is(err));
        assert.equal(err.kind, 'validation');
        assert.match(err.message, /symlink/);
        return true;
      },
    );
  },
);

test(
  'MEDIA-5: even an in-directory symlink is refused — the final component must be a real file',
  { skip: symlinkSkip },
  async () => {
    const real = tempFile('real-target.png', mediaBytes('png', 12));
    const link = join(tmpRoot, 'inside-link.png');
    symlinkSync(real, link);
    await assert.rejects(
      () => upload.handler({ path: link }, noHttpCtx()),
      (err: unknown) => {
        assert.ok(XError.is(err));
        assert.equal(err.kind, 'validation');
        assert.match(err.message, /symlink/);
        return true;
      },
    );
  },
);

test(
  'MEDIA-5: a symlinked parent directory cannot escape the media directory (realpath containment)',
  { skip: symlinkSkip },
  async () => {
    const nested = join(outsideRoot, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'shot.png'), mediaBytes('png', 12));
    const linkDir = join(tmpRoot, 'linked-dir');
    symlinkSync(nested, linkDir, 'dir');
    await assert.rejects(
      () => upload.handler({ path: join(linkDir, 'shot.png') }, noHttpCtx()),
      (err: unknown) => {
        assert.ok(XError.is(err));
        assert.equal(err.kind, 'validation');
        assert.match(err.message, /resolves outside the configured media directory/);
        return true;
      },
    );
  },
);

test(
  'MEDIA-5: the magic-byte sniff and the upload reads share ONE file descriptor (no TOCTOU swap)',
  {
    skip:
      process.platform === 'win32' ? 'an open file cannot be unlinked/replaced on win32' : false,
  },
  async () => {
    const path = tempFile('toctou.png', mediaBytes('png', 64));
    const file = await openMediaFile(path, { mediaDir: tmpRoot });
    try {
      assert.equal(file.mediaType, 'image/png');
      // Swap the path for entirely different content AFTER the checks passed. The handle
      // still points at the inode that was sniffed, so the upload cannot be tricked into
      // sending bytes nobody validated.
      rmSync(path, { force: true });
      writeFileSync(path, Buffer.alloc(64, 0x41));
      const buf = Buffer.alloc(8);
      await file.handle.read(buf, 0, 8, 0);
      assert.deepEqual(buf, MAGIC.png);
      assert.equal(file.size, 64);
    } finally {
      await file.handle.close();
    }
  },
);

test(
  'MEDIA-5: the PLAT-2 fallback still refuses a symlink when O_NOFOLLOW is unavailable, and warns the operator once',
  { skip: symlinkSkip },
  async () => {
    const real = tempFile('plat2-target.png', mediaBytes('png', 12));
    const link = join(tmpRoot, 'plat2-link.png');
    symlinkSync(real, link);
    const warnings: string[] = [];
    const deps = { mediaDir: tmpRoot, warn: (message: string) => warnings.push(message) };
    // `nofollow: 0` pins the win32 branch on every platform: no O_NOFOLLOW flag exists, so
    // the non-atomic lstat pre-check is the only thing standing between a symlink and the
    // open — and it must still refuse.
    for (let i = 0; i < 2; i += 1) {
      await assert.rejects(
        () => openNoFollow(link, link, deps, 0),
        (err: unknown) => {
          assert.ok(XError.is(err));
          assert.equal(err.kind, 'validation');
          assert.match(err.message, /symlink/);
          return true;
        },
      );
    }
    // The degradation is announced ONCE, not once per upload (a per-file warning would be
    // noise an operator learns to ignore). On win32 a real upload may have latched it first.
    assert.ok(warnings.length <= 1, `expected at most one warning, got ${String(warnings.length)}`);
    if (process.platform !== 'win32') {
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? '', /O_NOFOLLOW is unavailable/);
      assert.match(warnings[0] ?? '', /PLAT-2/);
    }
    // A regular file still opens through the same fallback path.
    const handle = await openNoFollow(real, real, deps, 0);
    await handle.close();
  },
);

test(
  'MEDIA-5: a FIFO inside the media directory is refused as not a regular file, without hanging',
  { skip: process.platform === 'win32' ? 'win32 has no mkfifo' : false },
  async () => {
    const fifo = makeFifo('pipe.png');
    if (fifo === undefined) return; // mkfifo unavailable in this environment
    // Opening a FIFO read-only would block until a writer appears; O_NONBLOCK bounds that,
    // and the same-fd fstat then refuses it — a media directory the operator shares must
    // not be able to stall the server with a named pipe.
    await assert.rejects(
      () => openMediaFile(fifo, { mediaDir: tmpRoot }),
      (err: unknown) => {
        assert.ok(XError.is(err));
        assert.equal(err.kind, 'validation');
        assert.match(err.message, /not a regular file/);
        return true;
      },
    );
    rmSync(fifo, { force: true });
  },
);

test('MEDIA-5: a file truncated between segments aborts before FINALIZE instead of sending short bytes', async () => {
  const totalBytes = MEDIA_SEGMENT_BYTES + 1024; // two segments
  const path = tempFile('shrink.mp4', mediaBytes('mp4', totalBytes));
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/media/upload/initialize', method: 'POST' })
    .reply(200, { data: { id: '8000' } });
  mock.pool
    .intercept({
      path: '/2/media/upload/8000/append',
      method: 'POST',
      body: () => {
        // The file shrinks under the (already validated) fd while segment 0 is in flight.
        truncateSync(path, 16);
        return true;
      },
    })
    .reply(204);
  // No FINALIZE interceptor: finalizing a session whose segments do not add up would be a
  // corrupt media_id, so the upload must die here.

  await assert.rejects(
    () => upload.handler({ path }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /changed size while it was being read/);
      assert.match(err.message, /aborted before FINALIZE/);
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

test('MEDIA-5: a relative path inside the media directory resolves against it, not the cwd', async () => {
  tempFile('relative.png', mediaBytes('png', 12));
  const file = await openMediaFile('relative.png', { mediaDir: tmpRoot });
  try {
    assert.equal(file.size, 12);
    assert.equal(file.mediaType, 'image/png');
    assert.equal(basename(file.resolvedPath), 'relative.png');
  } finally {
    await file.handle.close();
  }
});

// --- MEDIA-6: magic bytes vs extension --------------------------------------------

test('MEDIA-6: a .png that is not a PNG is refused locally, naming both the claimed and sniffed types', async () => {
  const path = tempFile('liar.png', mediaBytes('jpeg', 32));
  await assert.rejects(
    () => upload.handler({ path }, noHttpCtx()),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /claims to be image\/png/);
      assert.match(err.message, /content is image\/jpeg/);
      assert.match(err.message, /Nothing was uploaded/);
      return true;
    },
  );
});

test('MEDIA-6: content matching no supported format at all is refused before INIT', async () => {
  const path = tempFile('garbage.png', Buffer.alloc(32, 0x5a));
  await assert.rejects(
    () => upload.handler({ path }, noHttpCtx()),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /claims to be image\/png/);
      assert.match(err.message, /match no supported media format/);
      return true;
    },
  );
});

test('MEDIA-6: the sniffed type wins for media_type and media_category selection', async () => {
  // A .mov file that actually holds an ISO-BMFF MP4: the extension claims quicktime, the
  // bytes say mp4, and what goes on the wire is what the bytes say.
  const content = mediaBytes('mp4', 24);
  const path = tempFile('claims-quicktime.mov', content);
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/media/upload/initialize',
      method: 'POST',
      body: '{"media_category":"tweet_video","media_type":"video/mp4","total_bytes":24}',
    })
    .reply(200, { data: { id: '7300' } });
  mock.pool
    .intercept({
      path: '/2/media/upload/7300/append',
      method: 'POST',
      body: `{"segment_index":0,"media":"${b64(content)}"}`,
    })
    .reply(204);
  mock.pool
    .intercept({ path: '/2/media/upload/7300/finalize', method: 'POST' })
    .reply(200, { data: { id: '7300' } });

  const out = await upload.handler({ path }, contextFor(mock));
  const data = out.data as { media_type: string; media_category: string };
  assert.equal(data.media_type, 'video/mp4');
  assert.equal(data.media_category, 'tweet_video');
  mock.assertDone();
  await mock.close();
});

test('MEDIA-6: a near-miss signature and a file too short to hold one are both refused', async () => {
  // A real RIFF container that is NOT WebP (an AVI): the first four bytes match, the fourcc
  // does not — a prefix check alone would have waved it through.
  const riffNotWebp = Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('AVI ', 'latin1'),
  ]);
  // And a file shorter than the PNG signature it claims: nothing to match against.
  const cases: readonly (readonly [string, Buffer])[] = [
    ['not-webp.webp', riffNotWebp],
    ['truncated.png', MAGIC.png.subarray(0, 4)],
  ];
  for (const [name, content] of cases) {
    const path = tempFile(name, content);
    await assert.rejects(
      () => upload.handler({ path }, noHttpCtx()),
      (err: unknown) => {
        assert.ok(XError.is(err));
        assert.equal(err.kind, 'validation');
        assert.match(err.message, /match no supported media format/);
        assert.match(err.message, /Nothing was uploaded/);
        return true;
      },
    );
  }
});

test('MEDIA-6: an .mp4 holding a QuickTime brand is accepted and the sniffed video/quicktime wins', async () => {
  // The mirror of the .mov-holding-MP4 case: cameras and editors swap these two ISO-BMFF
  // brands routinely, so the family is tolerated — but the SNIFFED type is what travels.
  const path = tempFile('really-quicktime.mp4', mediaBytes('mov', 24));
  const file = await openMediaFile(path, { mediaDir: tmpRoot });
  try {
    assert.equal(file.mediaType, 'video/quicktime');
    assert.equal(file.category, 'tweet_video');
  } finally {
    await file.handle.close();
  }
});

// --- MEDIA-2: boundary battery ----------------------------------------------------

test('MEDIA-2: a size that is an exact chunk multiple produces no empty trailing APPEND', async () => {
  const totalBytes = MEDIA_SEGMENT_BYTES * 2; // exactly two full segments
  const path = tempFile('exact.mp4', mediaBytes('mp4', totalBytes));
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/media/upload/initialize',
      method: 'POST',
      body: `{"media_category":"tweet_video","media_type":"video/mp4","total_bytes":${totalBytes}}`,
    })
    .reply(200, { data: { id: '7400' } });
  // Keyed by segment_index: undici may run a body matcher more than once per request.
  const lengths = new Map<number, number>();
  mock.pool
    .intercept({
      path: '/2/media/upload/7400/append',
      method: 'POST',
      body: (raw: string) => {
        const parsed = JSON.parse(raw) as { segment_index: number; media: string };
        lengths.set(parsed.segment_index, Buffer.from(parsed.media, 'base64').byteLength);
        return true;
      },
    })
    .reply(204)
    // Exactly two APPENDs are queued: a third (empty) one would find no interceptor and
    // fail loudly against the net-connect-disabled agent.
    .times(2);
  mock.pool
    .intercept({ path: '/2/media/upload/7400/finalize', method: 'POST' })
    .reply(200, { data: { id: '7400' } });

  const out = await upload.handler({ path }, contextFor(mock));
  assert.deepEqual(
    [...lengths.entries()],
    [
      [0, MEDIA_SEGMENT_BYTES],
      [1, MEDIA_SEGMENT_BYTES],
    ],
  );
  assert.equal((out.data as { segments: number }).segments, 2);
  mock.assertDone();
  await mock.close();
});

test('MEDIA-2: a zero-byte file is a validation error before INIT', async () => {
  const path = tempFile('empty.png', Buffer.alloc(0));
  await assert.rejects(
    () => upload.handler({ path }, noHttpCtx()),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /empty \(0 bytes\)/);
      assert.match(err.message, /No upload session was opened/);
      return true;
    },
  );
});

test('MEDIA-2: a file over the per-type size cap is refused locally with the cap stated', async () => {
  const path = tempFile('huge.png', mediaBytes('png', 5 * 1024 * 1024 + 1));
  await assert.rejects(
    () => upload.handler({ path }, noHttpCtx()),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /5 MiB \(5242880 bytes\) cap/);
      assert.match(err.message, /tweet_image/);
      assert.match(err.message, /5242881 bytes/);
      return true;
    },
  );
  rmSync(path, { force: true });
});

test('MEDIA-2: the size cap is PER TYPE — a GIF is measured against the 15 MiB GIF cap, not the image cap', async () => {
  assert.equal(MEDIA_SIZE_CAPS.tweet_gif, 15 * 1024 * 1024);
  assert.ok(MEDIA_SIZE_CAPS.tweet_gif > MEDIA_SIZE_CAPS.tweet_image);
  // Comfortably over the image cap but under the GIF one: sniffing decides which cap applies.
  const underGifCap = sparseFile('big.gif', 'gif', MEDIA_SIZE_CAPS.tweet_image + 1);
  const file = await openMediaFile(underGifCap, { mediaDir: tmpRoot });
  try {
    assert.equal(file.category, 'tweet_gif');
    assert.equal(file.size, MEDIA_SIZE_CAPS.tweet_image + 1);
  } finally {
    await file.handle.close();
  }
  rmSync(underGifCap, { force: true });

  const overGifCap = sparseFile('huge.gif', 'gif', MEDIA_SIZE_CAPS.tweet_gif + 1);
  await assert.rejects(
    () => upload.handler({ path: overGifCap }, noHttpCtx()),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      // The GIF cap is quoted, not the image one — the message must be actionable.
      assert.match(err.message, /15 MiB \(15728640 bytes\) cap/);
      assert.match(err.message, /tweet_gif/);
      return true;
    },
  );
  rmSync(overGifCap, { force: true });
});

test('MEDIA-2: a file exactly ON the cap is accepted — the cap is inclusive, one byte more is not', async () => {
  const atCap = sparseFile('at-cap.png', 'png', MEDIA_SIZE_CAPS.tweet_image);
  const file = await openMediaFile(atCap, { mediaDir: tmpRoot });
  try {
    assert.equal(file.size, MEDIA_SIZE_CAPS.tweet_image);
    assert.equal(file.category, 'tweet_image');
  } finally {
    await file.handle.close();
  }
  rmSync(atCap, { force: true });

  const overCap = sparseFile('over-cap.png', 'png', MEDIA_SIZE_CAPS.tweet_image + 1);
  await assert.rejects(
    () => openMediaFile(overCap, { mediaDir: tmpRoot }),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /over the 5 MiB \(5242880 bytes\) cap/);
      return true;
    },
  );
  rmSync(overCap, { force: true });
});

test('MEDIA-2: a one-byte-over-a-chunk file sends a full segment plus a one-byte tail', async () => {
  const totalBytes = MEDIA_SEGMENT_BYTES + 1; // the smallest possible trailing segment
  const path = tempFile('tail.mp4', mediaBytes('mp4', totalBytes));
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/media/upload/initialize', method: 'POST' })
    .reply(200, { data: { id: '8100' } });
  const lengths = new Map<number, number>();
  mock.pool
    .intercept({
      path: '/2/media/upload/8100/append',
      method: 'POST',
      body: (raw: string) => {
        const parsed = JSON.parse(raw) as { segment_index: number; media: string };
        lengths.set(parsed.segment_index, Buffer.from(parsed.media, 'base64').byteLength);
        return true;
      },
    })
    .reply(204)
    .times(2);
  mock.pool
    .intercept({ path: '/2/media/upload/8100/finalize', method: 'POST' })
    .reply(200, { data: { id: '8100' } });

  const out = await upload.handler({ path }, contextFor(mock));
  assert.deepEqual(
    [...lengths.entries()],
    [
      [0, MEDIA_SEGMENT_BYTES],
      [1, 1],
    ],
  );
  assert.equal((out.data as { segments: number }).segments, 2);
  mock.assertDone();
  await mock.close();
});

// --- MEDIA-7: cancellation + progress ---------------------------------------------

test('MEDIA-7: cancellation mid-APPEND stops the loop, sends no FINALIZE, and says the partial upload expires', async () => {
  const totalBytes = MEDIA_SEGMENT_BYTES + 3; // two segments: cancel during the first
  const path = tempFile('cancel.mp4', mediaBytes('mp4', totalBytes));
  const controller = new AbortController();
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/media/upload/initialize', method: 'POST' })
    .reply(200, { data: { id: '7500' } });
  // Distinct segment indices seen on the wire (a body matcher may run more than once).
  const appended = new Set<number>();
  mock.pool
    .intercept({
      path: '/2/media/upload/7500/append',
      method: 'POST',
      body: (raw: string) => {
        appended.add((JSON.parse(raw) as { segment_index: number }).segment_index);
        // The MCP client cancelled while this APPEND was in flight.
        controller.abort();
        return true;
      },
    })
    .reply(204);
  // No FINALIZE interceptor is registered on purpose: if the handler sent one, the
  // net-connect-disabled agent would fail the test loudly.

  await assert.rejects(
    () => upload.handler({ path }, contextFor(mock, controller.signal)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'network');
      assert.equal(err.retryable, false);
      assert.match(err.message, /cancelled/);
      assert.match(err.message, /FINALIZE was never sent/);
      assert.match(err.message, /expires server-side/);
      assert.match(err.message, /1 of 2 segment\(s\)/);
      return true;
    },
  );
  // Only the first segment ever went out; segment 1 was never attempted.
  assert.deepEqual([...appended], [0]);
  mock.assertDone();
  await mock.close();
});

test('MEDIA-7: an APPEND that fails while the signal is aborted reports cancellation, not a bare network error', async () => {
  const path = tempFile('cancel-inflight.png', mediaBytes('png', 12));
  const controller = new AbortController();
  // A transport that aborts the in-flight APPEND (the shape T-311 will produce once the
  // per-call signal reaches api/http): the request rejects AND the signal is aborted.
  const http: EndpointInvoker = {
    send: <T>(req: XApiRequest): Promise<T> => {
      if (req.path === '/2/media/upload/initialize') {
        return Promise.resolve({ data: { id: '7600' } } as unknown as T);
      }
      controller.abort();
      return Promise.reject(
        networkError('The X API request was cancelled before a response arrived.'),
      );
    },
  };

  await assert.rejects(
    () => upload.handler({ path }, { ports: makePorts(), http, signal: controller.signal }),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'network');
      assert.match(err.message, /The media upload was cancelled/);
      assert.match(err.message, /0 of 1 segment\(s\)/);
      assert.match(err.message, /expires server-side/);
      return true;
    },
  );
});

test('MEDIA-7: a call cancelled before it starts spends no INIT and opens no file', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => upload.handler({ path: join(tmpRoot, 'never-read.png') }, noHttpCtx(controller.signal)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'network');
      assert.match(err.message, /cancelled/);
      assert.match(err.message, /No upload session had been opened/);
      return true;
    },
  );
});

test('MEDIA-7: a cancellation that lands after the LAST APPEND still sends no FINALIZE', async () => {
  // One segment only: the loop ends normally, so the last gate before FINALIZE is the one
  // under test — the window where "everything is uploaded, just finalize it" is tempting.
  const path = tempFile('cancel-last.png', mediaBytes('png', 12));
  const controller = new AbortController();
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/media/upload/initialize', method: 'POST' })
    .reply(200, { data: { id: '8300' } });
  mock.pool
    .intercept({
      path: '/2/media/upload/8300/append',
      method: 'POST',
      body: () => {
        controller.abort();
        return true;
      },
    })
    .reply(204);
  // No FINALIZE interceptor: sending one would hit the net-connect-disabled agent.

  await assert.rejects(
    () => upload.handler({ path }, contextFor(mock, controller.signal)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'network');
      assert.equal(err.retryable, false);
      assert.match(err.message, /1 of 1 segment\(s\)/);
      assert.match(err.message, /FINALIZE was never sent/);
      assert.match(err.message, /expires server-side/);
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

test('MEDIA-7: a cancellation between the file open and INIT spends no upload session at all', async () => {
  // A signal that is clear on the first read (the pre-open gate) and aborted on the second
  // (the pre-INIT gate) — the exact window in which the MCP host cancels while the server
  // is still reading the local file. The file is real and valid, so nothing but the gate
  // can stop the flow; the loud invoker proves INIT never went out.
  const path = tempFile('cancel-preinit.png', mediaBytes('png', 12));
  let reads = 0;
  const signal = {
    get aborted(): boolean {
      reads += 1;
      return reads > 1;
    },
  } as unknown as AbortSignal;

  await assert.rejects(
    () => upload.handler({ path }, noHttpCtx(signal)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'network');
      assert.match(err.message, /The media upload was cancelled/);
      assert.match(err.message, /No upload session had been opened/);
      return true;
    },
  );
  assert.ok(reads >= 2, 'both cancellation gates must be consulted');
});

test('MEDIA-7: the bound call signal reaches the transport — the in-flight APPEND is torn down, no FINALIZE follows', async () => {
  // End-to-end shape of the real thing: the registry binds the tools/call signal to the
  // invoker (MCP-7 `withCallSignal`), so the APPEND request itself is aborted mid-flight
  // rather than merely being followed by a loop check.
  const path = tempFile('inflight.png', mediaBytes('png', 12));
  const controller = new AbortController();
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/media/upload/initialize', method: 'POST' })
    .reply(200, { data: { id: '8400' } });
  mock.pool
    .intercept({ path: '/2/media/upload/8400/append', method: 'POST' })
    .reply(204)
    .delay(2000);
  // No FINALIZE interceptor, again on purpose.
  const base = contextFor(mock, controller.signal);
  const ctx: ToolContext = {
    ports: base.ports,
    http: withCallSignal(base.http, controller.signal),
    signal: controller.signal,
  };
  const timer = setTimeout(() => controller.abort(), 20);

  await assert.rejects(
    () => upload.handler({ path }, ctx),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'network');
      assert.equal(err.retryable, false);
      // The transport's bare "request was cancelled" is re-framed in media terms.
      assert.match(err.message, /The media upload was cancelled/);
      assert.match(err.message, /0 of 1 segment\(s\)/);
      assert.match(err.message, /expires server-side/);
      return true;
    },
  );
  clearTimeout(timer);
  await mock.close();
});

test('MEDIA-7: an APPEND that fails with the call NOT cancelled keeps its own typed error and sends no FINALIZE', async () => {
  // The negative of the cancellation path: a plain API failure must not be dressed up as a
  // cancellation (its taxonomy and its fix are different), and must still stop before
  // FINALIZE.
  const path = tempFile('append-fails.png', mediaBytes('png', 12));
  const fx = loadFixture<ErrorFixture>('errors/404-not-found.json');
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/media/upload/initialize', method: 'POST' })
    .reply(200, { data: { id: '8500' } });
  mock.pool
    .intercept({ path: '/2/media/upload/8500/append', method: 'POST' })
    .reply(fx.status, fx.body as Record<string, unknown>, { headers: fx.headers });

  await assert.rejects(
    () => upload.handler({ path }, contextFor(mock, new AbortController().signal)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'not-found');
      assert.doesNotMatch(err.message, /cancelled/);
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

test('upload progress: onProgress fires once per accepted segment with byte counts (WP-3.3 seam)', async () => {
  const totalBytes = MEDIA_SEGMENT_BYTES + 3; // two segments
  const path = tempFile('progress.mp4', mediaBytes('mp4', totalBytes));
  const events: MediaUploadProgress[] = [];
  const [progressUpload] = createMediaTools({
    mediaDir: tmpRoot,
    onProgress: (event) => events.push(event),
  });
  const signal = new AbortController().signal;
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/media/upload/initialize', method: 'POST' })
    .reply(200, { data: { id: '7700' } });
  mock.pool.intercept({ path: '/2/media/upload/7700/append', method: 'POST' }).reply(204).times(2);
  mock.pool
    .intercept({ path: '/2/media/upload/7700/finalize', method: 'POST' })
    .reply(200, { data: { id: '7700' } });

  await progressUpload.handler({ path }, contextFor(mock, signal));
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => [e.segmentIndex, e.segments, e.bytesUploaded, e.totalBytes]),
    [
      [0, 2, MEDIA_SEGMENT_BYTES, totalBytes],
      [1, 2, totalBytes, totalBytes],
    ],
  );
  // Every event carries the media id and the per-call signal — the correlation key an MCP
  // progress bridge needs to find the originating call's progressToken.
  assert.deepEqual(new Set(events.map((e) => e.mediaId)), new Set(['7700']));
  assert.equal(events[0]?.signal, signal);
  mock.assertDone();
  await mock.close();
});

test('upload progress: a throwing progress listener never fails the upload', async () => {
  const content = mediaBytes('png', 12);
  const path = tempFile('progress-throws.png', content);
  const [progressUpload] = createMediaTools({
    mediaDir: tmpRoot,
    onProgress: () => {
      throw new Error('listener exploded');
    },
  });
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/media/upload/initialize', method: 'POST' })
    .reply(200, { data: { id: '7800' } });
  mock.pool.intercept({ path: '/2/media/upload/7800/append', method: 'POST' }).reply(204);
  mock.pool
    .intercept({ path: '/2/media/upload/7800/finalize', method: 'POST' })
    .reply(200, { data: { id: '7800' } });

  const out = await progressUpload.handler({ path }, contextFor(mock));
  assert.equal((out.data as { media_id: string }).media_id, '7800');
  mock.assertDone();
  await mock.close();
});

// --- Local file validation (the openMediaFile seam) --------------------------------

test('an unsupported extension refuses locally BEFORE any request and lists the supported set', async () => {
  const path = tempFile('notes.txt', 'not media');
  await assert.rejects(
    () => upload.handler({ path }, noHttpCtx()),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /Unsupported media file extension/);
      assert.match(err.message, /\.png, \.jpg, \.jpeg, \.webp, \.gif, \.mp4, \.mov/);
      return true;
    },
  );
});

test('a nonexistent path refuses locally BEFORE any request (validation)', async () => {
  await assert.rejects(
    () => upload.handler({ path: join(tmpRoot, 'missing.png') }, noHttpCtx()),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /Cannot open media file/);
      return true;
    },
  );
});

test('openMediaFile covers the full extension map and rejects non-regular files', async () => {
  const cases = [
    ['shot.jpg', 'jpeg', 'image/jpeg', 'tweet_image'],
    ['shot.jpeg', 'jpeg', 'image/jpeg', 'tweet_image'],
    ['shot.webp', 'webp', 'image/webp', 'tweet_image'],
    ['clip.mov', 'mov', 'video/quicktime', 'tweet_video'],
    ['SHOUT.PNG', 'png', 'image/png', 'tweet_image'], // extension match is case-insensitive
  ] as const;
  for (const [name, kind, mediaType, category] of cases) {
    const path = tempFile(name, mediaBytes(kind, 16));
    const file = await openMediaFile(path, { mediaDir: tmpRoot });
    try {
      assert.equal(file.mediaType, mediaType);
      assert.equal(file.category, category);
      assert.equal(file.size, 16);
    } finally {
      await file.handle.close();
    }
  }

  // A directory with a media-looking name is not a regular file. POSIX opens it and the
  // fstat refuses; win32 refuses the open itself — both are typed `validation`.
  const dir = join(tmpRoot, 'folder.png');
  mkdirSync(dir, { recursive: true });
  await assert.rejects(
    () => openMediaFile(dir, { mediaDir: tmpRoot }),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /not a regular file|Cannot open media file/);
      return true;
    },
  );
});

// --- Input schema boundary --------------------------------------------------------

test('input schemas: missing path, bad category, long alt_text, and extra keys all reject', () => {
  // Upload: missing / empty path.
  assert.equal(xMediaUpload.input.safeParse({}).success, false);
  assert.equal(xMediaUpload.input.safeParse({ path: '' }).success, false);
  // The closed media_category enum (MEDIA-1) refuses unknown categories.
  assert.equal(
    xMediaUpload.input.safeParse({ path: 'a.png', media_category: 'dm_image' }).success,
    false,
  );
  // alt_text bounds: 1..1000 chars.
  assert.equal(xMediaUpload.input.safeParse({ path: 'a.png', alt_text: '' }).success, false);
  assert.equal(
    xMediaUpload.input.safeParse({ path: 'a.png', alt_text: 'y'.repeat(1001) }).success,
    false,
  );
  assert.equal(
    xMediaUpload.input.safeParse({ path: 'a.png', alt_text: 'y'.repeat(1000) }).success,
    true,
  );
  // .strict(): unknown keys are refused, not silently dropped.
  assert.equal(xMediaUpload.input.safeParse({ path: 'a.png', shared: true }).success, false);
  assert.equal(xMediaStatus.input.safeParse({ media_id: '1', wait: true }).success, false);
  // Status: missing / empty media_id.
  assert.equal(xMediaStatus.input.safeParse({}).success, false);
  assert.equal(xMediaStatus.input.safeParse({ media_id: '' }).success, false);
  // The happy shapes parse.
  assert.equal(
    xMediaUpload.input.safeParse({ path: 'a.mp4', media_category: 'tweet_video' }).success,
    true,
  );
  assert.equal(xMediaStatus.input.safeParse({ media_id: '7100' }).success, true);
});

// --- Error mapping ----------------------------------------------------------------

test('a rate-limited INIT surfaces a typed rate-limit error and nothing is appended', async () => {
  const path = tempFile('limited.png', mediaBytes('png', 12));
  const fx = loadFixture<ErrorFixture>('errors/429-rate-limit.json');
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/media/upload/initialize', method: 'POST' })
    .reply(fx.status, fx.body as Record<string, unknown>, { headers: fx.headers });

  await assert.rejects(
    () => upload.handler({ path }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'rate-limit');
      return true;
    },
  );
  // assertDone + disabled net connect: INIT was the ONLY request — no APPEND went out.
  mock.assertDone();
  await mock.close();
});

test('an INIT 200 without a media id aborts with a typed api error before any APPEND', async () => {
  const path = tempFile('no-id.png', mediaBytes('png', 12));
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/media/upload/initialize', method: 'POST' })
    .reply(200, { data: {} });

  await assert.rejects(
    () => upload.handler({ path }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'api');
      assert.match(err.message, /no media id/);
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

// --- MEDIA-5: media-directory spellings (~ and /) ---------------------------------

test('MEDIA-5: a media directory of exactly `~` names the real home directory', async () => {
  // `expandTilde` must treat a bare `~` as the home directory itself (docs/04 §7 lets the
  // operator write `~/x-media`; plain `~` is the degenerate spelling). If it were taken
  // literally, `resolve("~")` would name a `./~` that does not exist and every upload
  // would refuse with the operator-fix "directory does not exist" error. Instead the
  // (existing) home directory passes the root check and the failure is the ordinary
  // file-open one for a file that is not there.
  await assert.rejects(
    () => openMediaFile('x-mcp-no-such-file-2f4a1c.png', { mediaDir: '~' }),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /Cannot open media file/);
      // NOT the unconfigured/missing-directory refusal: `~` resolved to a real root.
      assert.doesNotMatch(err.message, /does not exist or is not readable by the server/);
      assert.doesNotMatch(err.message, /resolves outside/);
      return true;
    },
  );
});

test('MEDIA-5: a media directory that already ends with the separator still contains its files', async () => {
  // The containment prefix must not become `//` (or `dir//`) when the configured root
  // already ends with the path separator — that malformed prefix would refuse EVERY file
  // inside the directory. The filesystem root is the natural always-trailing spelling;
  // it must be the root of the VOLUME holding the temp file (`parse().root`), because on
  // win32 a bare `sep` resolves against the current drive, which CI keeps separate from
  // the temp directory's drive.
  const path = tempFile('sep-root.png', mediaBytes('png', 12));
  const file = await openMediaFile(path, { mediaDir: parse(path).root });
  try {
    assert.equal(file.mediaType, 'image/png');
    assert.equal(basename(file.resolvedPath), 'sep-root.png');
  } finally {
    await file.handle.close();
  }
});

// --- MEDIA-3: alt_text failure classes --------------------------------------------

test('MEDIA-3: a programming error during the alt_text call is NOT swallowed into the note', async () => {
  // Only TYPED (XError) metadata failures downgrade to the best-effort note; a
  // programming error or torn invariant must surface as the SAME object — hiding it
  // behind "media_id is still usable" would bury a real bug.
  const path = tempFile('alt-crash.png', mediaBytes('png', 12));
  const sentinel = new TypeError('metadata serializer broke');
  const http: EndpointInvoker = {
    send: <T>(req: XApiRequest): Promise<T> => {
      if (req.path === '/2/media/upload/initialize') {
        return Promise.resolve({ data: { id: '7100' } } as T);
      }
      if (req.path === '/2/media/upload/7100/append') {
        return Promise.resolve(undefined as T);
      }
      if (req.path === '/2/media/upload/7100/finalize') {
        return Promise.resolve({ data: { id: '7100' } } as T);
      }
      if (req.path === '/2/media/metadata') return Promise.reject(sentinel);
      return Promise.reject(new Error(`unexpected request: ${req.path}`));
    },
  };

  await assert.rejects(
    () => upload.handler({ path, alt_text: 'desc' }, { ports: makePorts(), http }),
    (err: unknown) => err === sentinel,
  );
});

// --- MEDIA-4: failure-reason fallbacks --------------------------------------------

test('MEDIA-4: a failed STATUS whose error has only a name still quotes it as the reason', async () => {
  // The platform error object may carry `name` without `message`; the reason line must
  // fall back to the name rather than claiming the platform gave no detail.
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/media/upload',
      method: 'GET',
      query: { command: 'STATUS', media_id: '7202' },
    })
    .reply(200, {
      data: { id: '7202', processing_info: { state: 'failed', error: { name: 'InvalidMedia' } } },
    });

  await assert.rejects(
    () => xMediaStatus.handler({ media_id: '7202' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'api');
      assert.match(err.message, /Reason: InvalidMedia\./);
      assert.doesNotMatch(err.message, /no failure detail/);
      assert.equal(err.data.platform_title, 'InvalidMedia');
      // No `message` from the platform → no platform_detail key at all.
      assert.equal(Object.hasOwn(err.data, 'platform_detail'), false);
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

test('status: an in-progress state WITHOUT check_after_secs states the state and stops there', async () => {
  // No poll-again hint can be given when the platform sends none — the summary must not
  // invent a delay, only name the state.
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/media/upload',
      method: 'GET',
      query: { command: 'STATUS', media_id: '7203' },
    })
    .reply(200, {
      data: { id: '7203', processing_info: { state: 'in_progress', progress_percent: 10 } },
    });

  const out = await xMediaStatus.handler({ media_id: '7203' }, contextFor(mock));
  assert.deepEqual(out.data, {
    media_id: '7203',
    processing_state: 'in_progress',
    progress_percent: 10,
  });
  assert.equal(out.summary, 'Media 7203 processing state: in_progress.');
  mock.assertDone();
  await mock.close();
});
