// The MCP progress bridge (WP-3.3 follow-up, queue Q01): the media package's per-segment
// events reach a client as `notifications/progress` — for a tools/call that sent a
// `_meta.progressToken`, and only for that call. Unit tests pin the bridge's routing
// rules; the protocol tests drive the COMPOSED server over an in-memory pair, so the whole
// chain (SDK signal -> registry -> media handler -> listener -> bridge -> adapter) is real.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage, Progress } from '@modelcontextprotocol/sdk/types.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

import { MEDIA_SEGMENT_BYTES } from '../../src/api/endpoints/media.js';
import { parseConfig } from '../../src/core/config.js';
import { composeServer } from '../../src/mcp/compose.js';
import { createProgressBridge, mediaProgressListener } from '../../src/mcp/progress.js';
import type { ProgressUpdate } from '../../src/mcp/progress.js';

import { mockHttp } from '../helpers/index.js';
import type { MockHttp } from '../helpers/index.js';

// --- Bridge unit tests ----------------------------------------------------------------

test('progress bridge: a report reaches only the sink bound to its own signal (MCP-8)', () => {
  const bridge = createProgressBridge();
  const a = new AbortController().signal;
  const b = new AbortController().signal;
  const seenA: ProgressUpdate[] = [];
  const seenB: ProgressUpdate[] = [];
  bridge.bind(a, (u) => seenA.push(u));
  bridge.bind(b, (u) => seenB.push(u));

  bridge.report(a, { progress: 1, total: 2 });
  bridge.report(b, { progress: 5 });
  bridge.report(undefined, { progress: 9 });
  bridge.report(new AbortController().signal, { progress: 9 });

  assert.deepEqual(seenA, [{ progress: 1, total: 2 }]);
  assert.deepEqual(seenB, [{ progress: 5 }]);
});

test('progress bridge: unbind stops delivery, and a stale unbind keeps a newer binding', () => {
  const bridge = createProgressBridge();
  const signal = new AbortController().signal;
  const first: number[] = [];
  const second: number[] = [];
  const unbindFirst = bridge.bind(signal, (u) => first.push(u.progress));
  bridge.report(signal, { progress: 1 });
  unbindFirst();
  bridge.report(signal, { progress: 2 });
  assert.deepEqual(first, [1]);

  const unbindSecond = bridge.bind(signal, (u) => second.push(u.progress));
  unbindFirst(); // stale: must not drop the newer binding
  bridge.report(signal, { progress: 3 });
  unbindSecond();
  bridge.report(signal, { progress: 4 });
  assert.deepEqual(second, [3]);
});

test('progress bridge: non-increasing progress is dropped and a throwing sink is swallowed', () => {
  const bridge = createProgressBridge();
  const signal = new AbortController().signal;
  const seen: number[] = [];
  bridge.bind(signal, (u) => {
    seen.push(u.progress);
    if (u.progress === 2) throw new Error('sink exploded');
  });
  bridge.report(signal, { progress: 1 });
  bridge.report(signal, { progress: 1 });
  bridge.report(signal, { progress: 0 });
  assert.doesNotThrow(() => bridge.report(signal, { progress: 2 }));
  bridge.report(signal, { progress: 3 });
  assert.deepEqual(seen, [1, 2, 3]);
});

test('progress bridge: the media listener maps a segment event to bytes, total and a message', () => {
  const bridge = createProgressBridge();
  const signal = new AbortController().signal;
  const seen: ProgressUpdate[] = [];
  bridge.bind(signal, (u) => seen.push(u));
  const listener = mediaProgressListener(bridge);
  listener({
    mediaId: '42',
    segmentIndex: 0,
    segments: 3,
    bytesUploaded: 10,
    totalBytes: 25,
    signal,
  });
  // An event with no signal (a bare handler call) has nowhere to go.
  listener({ mediaId: '42', segmentIndex: 1, segments: 3, bytesUploaded: 20, totalBytes: 25 });
  assert.deepEqual(seen, [
    { progress: 10, total: 25, message: 'Uploaded segment 1 of 3 to media 42.' },
  ]);
});

// --- Protocol tests over the composed server ------------------------------------------

const mediaRoot = mkdtempSync(join(tmpdir(), 'x-mcp-progress-test-'));
test.after(() => rmSync(mediaRoot, { recursive: true, force: true }));

/** Two APPEND segments: one full segment plus a 3-byte tail, with a real MP4 signature. */
const TOTAL_BYTES = MEDIA_SEGMENT_BYTES + 3;
const VIDEO_PATH = join(mediaRoot, 'clip.mp4');
{
  const bytes = Buffer.alloc(TOTAL_BYTES, 7);
  Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypisom', 'latin1')]).copy(
    bytes,
  );
  writeFileSync(VIDEO_PATH, bytes);
}

function interceptUpload(mock: MockHttp, mediaId: string): void {
  mock.pool
    .intercept({ path: '/2/media/upload/initialize', method: 'POST' })
    .reply(200, { data: { id: mediaId } });
  mock.pool
    .intercept({ path: `/2/media/upload/${mediaId}/append`, method: 'POST' })
    .reply(204)
    .times(2);
  mock.pool
    .intercept({ path: `/2/media/upload/${mediaId}/finalize`, method: 'POST' })
    .reply(200, { data: { id: mediaId } });
}

/** Connect a client to the composed server, recording every message the server sends. */
async function connectRecording(
  mock: MockHttp,
): Promise<{ client: Client; sent: JSONRPCMessage[] }> {
  const config = parseConfig({
    X_MCP_AUTH_MODE: 'app-only',
    X_MCP_BEARER_TOKEN: 'AAAA',
    X_MCP_POLICY: 'publish',
    X_MCP_MEDIA_DIR: mediaRoot,
  });
  const composition = composeServer(config, { dispatcher: mock.dispatcher });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sent: JSONRPCMessage[] = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = (message, options) => {
    sent.push(message);
    return send(message, options);
  };
  const client = new Client({ name: 'progress-harness', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), composition.server.connect(serverTransport)]);
  return { client, sent };
}

function progressNotifications(sent: readonly JSONRPCMessage[]): JSONRPCMessage[] {
  return sent.filter((m) => 'method' in m && m.method === 'notifications/progress');
}

test('WP-3.3: an upload with a progressToken streams one notifications/progress per segment, before the result', async () => {
  const mock = mockHttp();
  interceptUpload(mock, '7900');
  const { client, sent } = await connectRecording(mock);
  try {
    const updates: Progress[] = [];
    // The SDK client sets `_meta.progressToken` itself when `onprogress` is given.
    const result = await client.callTool(
      { name: 'x_media_upload', arguments: { path: VIDEO_PATH } },
      CallToolResultSchema,
      { onprogress: (p) => updates.push(p) },
    );
    assert.notEqual(result.isError, true);

    assert.deepEqual(updates, [
      {
        progress: MEDIA_SEGMENT_BYTES,
        total: TOTAL_BYTES,
        message: 'Uploaded segment 1 of 2 to media 7900.',
      },
      {
        progress: TOTAL_BYTES,
        total: TOTAL_BYTES,
        message: 'Uploaded segment 2 of 2 to media 7900.',
      },
    ]);
    // Wire order: both notifications precede the tools/call response.
    const responseAt = sent.findIndex((m) => 'result' in m && 'content' in m.result);
    const notifiedAt = sent
      .map((m, i) => ('method' in m && m.method === 'notifications/progress' ? i : -1))
      .filter((i) => i >= 0);
    assert.equal(notifiedAt.length, 2);
    assert.ok(notifiedAt.every((i) => i < responseAt));
    mock.assertDone();
  } finally {
    await client.close();
    await mock.close();
  }
});

test('WP-3.3: an upload without a progressToken emits no progress notification', async () => {
  const mock = mockHttp();
  interceptUpload(mock, '7901');
  const { client, sent } = await connectRecording(mock);
  try {
    const result = await client.callTool({
      name: 'x_media_upload',
      arguments: { path: VIDEO_PATH },
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(progressNotifications(sent), []);
    mock.assertDone();
  } finally {
    await client.close();
    await mock.close();
  }
});
