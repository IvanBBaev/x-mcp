// The WP-3.3 progress bridge (MCP-9): the correlation layer that turns the media package's
// internal per-segment seam into protocol `notifications/progress`.
//
// Two levels, deliberately. The unit block pins the correlation rule itself — bindings are
// keyed on AbortSignal OBJECT IDENTITY, so N overlapping uploads cannot cross-talk and an
// event from an unbound call is silently dropped. The protocol block proves the same thing
// over a real SDK client/server pair, which is the only way to show that a notification
// actually reaches the wire with the client's own `progressToken` on it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Progress } from '@modelcontextprotocol/sdk/types.js';

import { z } from 'zod';

import { MEDIA_SEGMENT_BYTES } from '../../src/api/endpoints/media.js';
import { parseConfig } from '../../src/core/config.js';
import { composeServer } from '../../src/mcp/compose.js';
import { createProgressBridge } from '../../src/mcp/progress.js';
import { buildMcpServer } from '../../src/mcp/server.js';
import type { ProgressBridge } from '../../src/mcp/progress.js';
import { defineTool } from '../../src/core/tooldef.js';
import type { EndpointInvoker } from '../../src/core/tooldef.js';
import type { Ports } from '../../src/core/ports.js';
import type { CallContext, Registry, ToolResult } from '../../src/core/registry.js';
import type { MediaUploadProgress } from '../../src/tools/media.js';

import { fakeClock, inMemoryTokenStore, mockHttp } from '../helpers/index.js';

/** One segment event, shaped exactly as `src/tools/media.ts` emits it. */
function event(signal: AbortSignal | undefined, index: number, done: number): MediaUploadProgress {
  return {
    mediaId: '1700000000000000001',
    segmentIndex: index,
    segments: 2,
    bytesUploaded: done,
    totalBytes: 2048,
    ...(signal !== undefined ? { signal } : {}),
  };
}

// --- The correlation rule -------------------------------------------------------------

test('MCP-9: a bound signal receives its own events, and release stops them', () => {
  const bridge = createProgressBridge();
  const controller = new AbortController();
  const seen: MediaUploadProgress[] = [];

  const release = bridge.bind(controller.signal, (e) => seen.push(e));
  bridge.onProgress(event(controller.signal, 0, 1024));
  bridge.onProgress(event(controller.signal, 1, 2048));
  assert.equal(seen.length, 2);
  assert.deepEqual(
    seen.map((e) => e.bytesUploaded),
    [1024, 2048],
  );

  // After the adapter's `finally`, a late event from a straggling upload is a no-op rather
  // than a notification against a request id the client has already resolved.
  release();
  bridge.onProgress(event(controller.signal, 1, 2048));
  assert.equal(seen.length, 2);
});

test('MCP-9: bindings are keyed on signal identity — concurrent calls never cross-talk', () => {
  const bridge = createProgressBridge();
  const first = new AbortController();
  const second = new AbortController();
  const toFirst: number[] = [];
  const toSecond: number[] = [];

  bridge.bind(first.signal, (e) => toFirst.push(e.bytesUploaded));
  bridge.bind(second.signal, (e) => toSecond.push(e.bytesUploaded));

  // Interleaved, as two overlapping uploads actually are.
  bridge.onProgress(event(first.signal, 0, 1024));
  bridge.onProgress(event(second.signal, 0, 512));
  bridge.onProgress(event(first.signal, 1, 2048));

  assert.deepEqual(toFirst, [1024, 2048]);
  assert.deepEqual(toSecond, [512]);
});

test('MCP-9: an event with no signal, or from an unbound call, is silently dropped', () => {
  const bridge = createProgressBridge();
  const bound = new AbortController();
  const other = new AbortController();
  let calls = 0;

  bridge.bind(bound.signal, () => {
    calls += 1;
  });

  // No signal at all: the caller sent no cancellation token, so nothing correlates.
  bridge.onProgress(event(undefined, 0, 1024));
  // A signal nobody bound: the client sent no `progressToken` for that call.
  bridge.onProgress(event(other.signal, 0, 1024));

  assert.equal(calls, 0, 'an uncorrelated event must not reach any bound emitter');
});

// --- End to end over the protocol -----------------------------------------------------

/** A stub tool standing in for `x_media_upload`: it only needs to emit through the seam. */
const probe = defineTool({
  name: 'x_probe_upload',
  title: 'probe upload',
  description: 'Test stand-in that drives the progress seam.',
  policy: 'read:content',
  availability: 'app+user',
  scopes: [],
  cost: 'local',
  annotations: { title: 'probe upload', readOnlyHint: true },
  input: z.object({}).strict(),
  handler: () => Promise.resolve({ data: null }),
  phase: 1,
});

const RESULT: ToolResult = { data: null, meta: { cost_usd: 0, session_total_usd: 0 } };

/**
 * A registry whose single call emits the two segment events the media package would, on
 * whatever signal the adapter hands it — i.e. the real `ctx.signal` → `event.signal` path.
 */
function emittingRegistry(bridge: ProgressBridge): Registry {
  return {
    all: () => [probe],
    get: (name) => (name === probe.name ? probe : undefined),
    size: 1,
    listForMcp: () => [
      {
        def: probe,
        name: probe.name,
        description: probe.description,
        annotations: probe.annotations,
        denied: false,
      },
    ],
    call: (_name: string, _args: unknown, ctx: CallContext): Promise<ToolResult> => {
      bridge.onProgress(event(ctx.signal, 0, 1024));
      bridge.onProgress(event(ctx.signal, 1, 2048));
      return Promise.resolve(RESULT);
    },
  };
}

/**
 * Connect a client to a server built over `registry`, with `progress` wired or not.
 * `breakNotifications` makes the server transport reject every outbound
 * `notifications/progress` while leaving the response frame intact — the disconnected-client
 * case, made deterministic.
 */
async function connectProbe(deps: {
  registry: Registry;
  progress?: ProgressBridge;
  breakNotifications?: boolean;
}): Promise<Client> {
  const server = buildMcpServer({
    registry: deps.registry,
    ports: {} as Ports,
    invokerFor: () =>
      (() => Promise.reject(new Error('unreachable'))) as unknown as EndpointInvoker,
    ...(deps.progress !== undefined ? { progress: deps.progress } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  if (deps.breakNotifications === true) {
    const send = serverTransport.send.bind(serverTransport);
    serverTransport.send = (message, options): Promise<void> =>
      'method' in message && message.method === 'notifications/progress'
        ? Promise.reject(new Error('transport gone'))
        : send(message, options);
  }
  const client = new Client({ name: 'test-harness', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

test('MCP-9: a client that sends a progressToken receives one notification per segment', async () => {
  const bridge = createProgressBridge();
  const client = await connectProbe({ registry: emittingRegistry(bridge), progress: bridge });

  // Supplying `onprogress` is what makes the SDK client attach `_meta.progressToken`.
  const notifications: Progress[] = [];
  await client.callTool({ name: 'x_probe_upload', arguments: {} }, undefined, {
    onprogress: (p) => notifications.push(p),
  });

  assert.equal(notifications.length, 2, 'one notification per accepted segment');
  // Bytes, not segments: monotonic by construction and directly renderable as a percentage.
  assert.deepEqual(
    notifications.map((p) => p.progress),
    [1024, 2048],
  );
  assert.deepEqual(
    notifications.map((p) => p.total),
    [2048, 2048],
  );
  assert.match(String(notifications[0]?.message), /^media 1700000000000000001: segment 1\/2$/);

  await client.close();
});

test('MCP-9: without a progressToken nothing is sent, and the call still succeeds', async () => {
  const bridge = createProgressBridge();
  const client = await connectProbe({ registry: emittingRegistry(bridge), progress: bridge });

  const seen: unknown[] = [];
  client.fallbackNotificationHandler = (notification): Promise<void> => {
    seen.push(notification);
    return Promise.resolve();
  };

  // No `onprogress` option → no `_meta.progressToken` → the adapter binds nothing, so the
  // upload's events find no emitter and die in the bridge.
  const result = await client.callTool({ name: 'x_probe_upload', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(seen.length, 0, 'an unsolicited notifications/progress would be a protocol bug');

  await client.close();
});

test('MCP-9: a server composed without a bridge ignores a progressToken entirely', async () => {
  // The `progress` dep is optional so a bare `buildMcpServer` (embedders, the older tests)
  // keeps working. A client may still ask for progress; it just never arrives.
  const bridge = createProgressBridge();
  const client = await connectProbe({ registry: emittingRegistry(bridge) });

  const notifications: Progress[] = [];
  const result = await client.callTool({ name: 'x_probe_upload', arguments: {} }, undefined, {
    onprogress: (p) => notifications.push(p),
  });

  assert.equal(result.isError, undefined);
  assert.equal(notifications.length, 0);

  await client.close();
});

test('MCP-9: a transport that rejects the notification never fails the call', async () => {
  // The real failure mode: the client goes away mid-upload, so `sendNotification` rejects.
  // MEDIA-7's rule is that an upload must never fail because nobody was listening, and the
  // adapter's `.catch` is what upholds it — an unhandled rejection here would also crash
  // the process under Node's default policy.
  const bridge = createProgressBridge();
  const client = await connectProbe({
    registry: emittingRegistry(bridge),
    progress: bridge,
    breakNotifications: true,
  });

  const notifications: Progress[] = [];
  const result = await client.callTool({ name: 'x_probe_upload', arguments: {} }, undefined, {
    onprogress: (p) => notifications.push(p),
  });

  assert.equal(result.isError, undefined, 'the call must succeed despite the dropped frames');
  assert.equal(notifications.length, 0, 'nothing got through — by construction here');

  await client.close();
});

test('MCP-9: the bridge does not swallow a throwing emitter — the media seam does', () => {
  // `reportProgress` in src/tools/media.ts already wraps the sink in try/catch, so adding a
  // second catch here would only hide a wiring bug in the adapter. Pin the division of
  // responsibility so it cannot silently move.
  const bridge = createProgressBridge();
  const controller = new AbortController();
  bridge.bind(controller.signal, () => {
    throw new Error('emitter blew up');
  });

  assert.throws(() => {
    bridge.onProgress(event(controller.signal, 0, 1024));
  }, /emitter blew up/);
});

// --- The real chain: media.ts → bridge → adapter → client ------------------------------

test('MCP-9/INT: a real chunked upload reports every segment to the client', async () => {
  // The stub blocks above prove the correlation and the wire format; this one proves the
  // COMPOSITION — that `composeServer` actually hands the media package a sink wired to the
  // adapter. Everything here is production wiring except the dispatcher and the token store:
  // the real `x_media_upload`, the real registry gauntlet, the real bridge.
  const clock = fakeClock();
  const tokens = inMemoryTokenStore({
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    obtained_at: clock.now(),
    expires_in: 7200,
    version: 1,
  });
  const mediaDir = mkdtempSync(join(tmpdir(), 'x-mcp-progress-'));
  const totalBytes = MEDIA_SEGMENT_BYTES + 3; // two segments: one full, one 3-byte tail
  const mp4 = Buffer.alloc(totalBytes, 7);
  Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom', 'latin1')]).copy(
    mp4,
    0,
  );
  const path = join(mediaDir, 'clip.mp4');
  writeFileSync(path, mp4);

  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/media/upload/initialize', method: 'POST' })
    .reply(200, { data: { id: '8800' } });
  mock.pool.intercept({ path: '/2/media/upload/8800/append', method: 'POST' }).reply(204).times(2);
  mock.pool
    .intercept({ path: '/2/media/upload/8800/finalize', method: 'POST' })
    .reply(200, { data: { id: '8800' } });

  const composition = composeServer(
    parseConfig({
      X_MCP_AUTH_MODE: 'oauth2',
      X_MCP_CLIENT_ID: 'client-1',
      X_MCP_POLICY: 'publish',
      X_MCP_MEDIA_DIR: mediaDir,
    }),
    { dispatcher: mock.dispatcher, clock, tokens },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-harness', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), composition.server.connect(serverTransport)]);

  const notifications: Progress[] = [];
  const result = await client.callTool({ name: 'x_media_upload', arguments: { path } }, undefined, {
    onprogress: (p) => notifications.push(p),
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(
    notifications.map((p) => [p.progress, p.total]),
    [
      [MEDIA_SEGMENT_BYTES, totalBytes],
      [totalBytes, totalBytes],
    ],
  );
  assert.match(String(notifications[1]?.message), /^media 8800: segment 2\/2$/);

  mock.assertDone();
  await mock.close();
  await client.close();
  rmSync(mediaDir, { recursive: true, force: true });
});
