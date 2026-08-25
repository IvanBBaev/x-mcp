// Scenario test for WALKTHROUGH A — "Post a thread of 3 posts with an image on the first"
// (docs/reviews/06-agent-dx-review.md § Workflow walkthroughs, T-318 / WP-3.12).
//
// The walkthrough as written (preconditions: X_MCP_POLICY=publish, because media upload and
// post create sit in the SAME `write:content` cell):
//   1. `media_upload {path: "chart.png"}` -> media_id
//   2. `media_metadata_set {media_id, alt_text}` -> ok
//   3. `post_create {text: t1, media_ids: [media_id]}` -> id1 + URL
//   4. `post_create {text: t2, reply_to_id: id1}` -> id2 + URL
//   5. `post_create {text: t3, reply_to_id: id2}` -> id3 + URL
// Its named friction items are asserted too: the review's own recommendation to FOLD the
// alt-text call into the upload (so steps 1-2 collapse into one call — MEDIA-3), and the
// partial-failure recovery prose a failed mid-thread create must carry (POST-9).
//
// Step 1 runs end to end through the COMPOSED server (not the bare handler): that is the
// only place where `X_MCP_MEDIA_DIR` has to survive the trip from Config into the tool's
// closure, and a regression there disables every upload with a message blaming the operator
// for a directory they did configure. The thread steps then run from the media_id it returns.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { parseConfig } from '../../src/core/config.js';
import { composeServer } from '../../src/mcp/compose.js';
import type { Composition } from '../../src/mcp/compose.js';

import { mockHttp, loadFixture } from '../helpers/index.js';
import type { MockHttp } from '../helpers/index.js';

/** The media_id a successful x_media_upload would have handed to step 3. */
const MEDIA_ID = '7100';

/** The three posts of the thread, and the ids X assigns them. */
const T1 = 'Thread 1/3: what we shipped this week.';
const T2 = 'Thread 2/3: the part that surprised us.';
const T3 = 'Thread 3/3: what we are doing next.';
const ID1 = '1900000000000000101';
const ID2 = '1900000000000000102';
const ID3 = '1900000000000000103';

// --- Harness (mirrors test/mcp/server.test.ts) ------------------------------------

function appOnlyEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { X_MCP_AUTH_MODE: 'app-only', X_MCP_BEARER_TOKEN: 'AAAA', ...extra };
}

/** The walkthrough's precondition: the `publish` preset opens `write:content`. */
function composeFor(mock: MockHttp, extraEnv: Record<string, string> = {}): Composition {
  return composeServer(parseConfig(appOnlyEnv({ X_MCP_POLICY: 'publish', ...extraEnv })), {
    dispatcher: mock.dispatcher,
  });
}

async function connect(composition: Composition): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'walkthrough-a', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), composition.server.connect(serverTransport)]);
  return client;
}

async function call(client: Client, name: string, args: object): Promise<CallToolResult> {
  return (await client.callTool({
    name,
    arguments: args as Record<string, unknown>,
  })) as CallToolResult;
}

interface Rendered<T> {
  readonly data: T;
  readonly summary?: string;
  readonly meta: { readonly cost_usd: number; readonly session_total_usd: number };
}

interface RenderedError {
  readonly error: {
    readonly kind: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly fix?: string;
  };
}

function textPayload<T>(result: CallToolResult): T {
  assert.equal(result.content.length, 1);
  const block = result.content[0];
  assert.ok(block !== undefined && block.type === 'text', 'expected one text content block');
  return JSON.parse(block.text) as T;
}

interface CreatedPost {
  readonly id: string;
  readonly url: string;
  readonly note?: string;
}

/** The exact `POST /2/tweets` body each thread step must put on the wire. */
function createBody(step: 1 | 2 | 3): string {
  if (step === 1) return JSON.stringify({ text: T1, media: { media_ids: [MEDIA_ID] } });
  if (step === 2) return JSON.stringify({ text: T2, reply: { in_reply_to_tweet_id: ID1 } });
  return JSON.stringify({ text: T3, reply: { in_reply_to_tweet_id: ID2 } });
}

function createdEnvelope(id: string, text: string): object {
  return { data: { id, text } };
}

/** Pin one thread step on the wire: the body matcher is the step's whole contract. */
function interceptCreate(
  mock: MockHttp,
  step: 1 | 2 | 3,
): ReturnType<MockHttp['pool']['intercept']> {
  return mock.pool.intercept({ path: '/2/tweets', method: 'POST', body: createBody(step) });
}

// --- Step 0: the journey is listed and allowed -------------------------------------

test('walkthrough A step 0: the publish preset lists the whole thread journey, and step 2 has folded into step 1 (MEDIA-3)', async () => {
  const mock = mockHttp();
  const client = await connect(composeFor(mock));
  try {
    const listed = await client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));

    // Both media upload and post create sit in the same `write:content` cell, which is
    // exactly why the walkthrough's precondition is a single preset switch to `publish`.
    for (const name of ['x_media_upload', 'x_post_create']) {
      const tool = byName.get(name);
      assert.ok(tool !== undefined, `${name} must be registered`);
      assert.doesNotMatch(
        tool.description ?? '',
        /disabled by policy/,
        `${name} must be allowed under the publish preset`,
      );
      assert.notEqual(tool.annotations?.readOnlyHint, true, `${name} is a write tool`);
    }

    // MEDIA-3: the review's own recommendation shipped — there is no separate metadata
    // tool, `alt_text` is an optional parameter of the upload itself, so the walkthrough's
    // steps 1 and 2 are one call.
    assert.deepEqual(
      listed.tools.filter((tool) => /metadata/.test(tool.name)).map((tool) => tool.name),
      [],
      'no separate media metadata tool may exist',
    );
    const uploadProps = (
      byName.get('x_media_upload')?.inputSchema as { properties?: Record<string, unknown> }
    ).properties;
    assert.ok(uploadProps !== undefined);
    assert.ok('path' in uploadProps, 'x_media_upload takes the local path');
    assert.ok('alt_text' in uploadProps, 'MEDIA-3: alt_text is an x_media_upload param');

    // The thread is chained with `reply_to_id`, and the image rides on `media_ids`.
    const createProps = (
      byName.get('x_post_create')?.inputSchema as { properties?: Record<string, unknown> }
    ).properties;
    assert.ok(createProps !== undefined);
    for (const key of ['text', 'reply_to_id', 'media_ids']) {
      assert.ok(key in createProps, `x_post_create must accept ${key}`);
    }
  } finally {
    await client.close();
    await mock.close();
  }
});

// --- Step 1: the image upload ------------------------------------------------------

/** The media directory the walkthrough's operator configured, holding the chart. */
const mediaRoot = mkdtempSync(join(tmpdir(), 'x-mcp-walkthrough-a-'));
test.after(() => rmSync(mediaRoot, { recursive: true, force: true }));

/** 12 bytes opening with the real PNG signature — MEDIA-6 sniffs the fd, not the name. */
const CHART_BYTES = ((): Buffer => {
  const buf = Buffer.alloc(12, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  return buf;
})();
const CHART_PATH = join(mediaRoot, 'chart.png');
writeFileSync(CHART_PATH, CHART_BYTES);

const ALT_TEXT = 'A red panda sleeping on a branch.';

test('walkthrough A steps 1-2 (MEDIA-1/MEDIA-3): one upload call does INIT -> APPEND -> FINALIZE -> metadata', async () => {
  const mock = mockHttp();
  // The whole chunked flow, body-matched: the composed server must drive the dedicated v2
  // paths and nothing else. The metadata POST is what makes step 2 of the walkthrough
  // disappear — alt_text rides along instead of costing the agent a second call.
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
      body: `{"segment_index":0,"media":"${CHART_BYTES.toString('base64')}"}`,
    })
    .reply(204);
  mock.pool
    .intercept({ path: '/2/media/upload/7100/finalize', method: 'POST' })
    .reply(200, loadFixture<Record<string, unknown>>('media/finalize-image.json'));
  mock.pool
    .intercept({
      path: '/2/media/metadata',
      method: 'POST',
      body: `{"id":"7100","metadata":{"alt_text":{"text":"${ALT_TEXT}"}}}`,
    })
    .reply(200, loadFixture<Record<string, unknown>>('media/metadata-ok.json'));

  // The operator's media directory has to survive the trip Config -> composeServer -> the
  // tool's closure; registering the unbound default-deny instances instead would refuse
  // this upload while blaming the operator for a directory they did configure.
  const config = parseConfig(appOnlyEnv({ X_MCP_POLICY: 'publish', X_MCP_MEDIA_DIR: mediaRoot }));
  assert.equal(config.mediaDir, mediaRoot, 'config parsed the media dir');
  const composition = composeServer(config, { dispatcher: mock.dispatcher });

  const client = await connect(composition);
  try {
    const payload = textPayload<Rendered<{ media_id: string; alt_text_set: boolean }>>(
      await call(client, 'x_media_upload', { path: CHART_PATH, alt_text: ALT_TEXT }),
    );
    assert.equal(payload.data.media_id, MEDIA_ID);
    assert.equal(payload.data.alt_text_set, true);
    // An upload is priced `w:action` ($0): the thread's cost starts accruing at step 3.
    assert.equal(composition.budget.total(), 0);
    mock.assertDone();
  } finally {
    await client.close();
    await mock.close();
  }
});

test('walkthrough A step 1 (MEDIA-5): with no X_MCP_MEDIA_DIR the composed upload is default-denied', async () => {
  const mock = mockHttp();
  // Same graph, one variable removed. Fail-closed is the DEFAULT for a tool that opens
  // local files, so an operator who never opted in gets a refusal, not a file read.
  const composition = composeFor(mock);

  const client = await connect(composition);
  try {
    const result = await call(client, 'x_media_upload', { path: CHART_PATH, alt_text: ALT_TEXT });
    assert.equal(result.isError, true);
    const payload = textPayload<RenderedError>(result);

    // MEDIA-5 default-deny prose: what is disabled, who must fix it, and the explicit
    // "nothing happened" so the agent does not retry blind.
    assert.equal(payload.error.kind, 'validation');
    assert.match(payload.error.message, /Media upload is disabled/);
    assert.match(payload.error.message, /X_MCP_MEDIA_DIR/);
    assert.match(payload.error.message, /Nothing was uploaded\./);
    assert.equal(payload.error.fix, 'operator');

    // A refused upload spends nothing and never reaches the wire.
    assert.equal(composition.budget.total(), 0);
    mock.assertDone();
  } finally {
    await client.close();
    await mock.close();
  }
});

// --- Steps 3-5: the thread ---------------------------------------------------------

test('walkthrough A steps 3-5 (COST-3): three chained creates, each reply pointing at the previous id', async () => {
  const mock = mockHttp();
  interceptCreate(mock, 1).reply(201, createdEnvelope(ID1, T1));
  interceptCreate(mock, 2).reply(201, createdEnvelope(ID2, T2));
  interceptCreate(mock, 3).reply(201, createdEnvelope(ID3, T3));

  const composition = composeFor(mock);
  const client = await connect(composition);
  try {
    // Step 3 — the head of the thread carries the image from step 1.
    const first = textPayload<Rendered<CreatedPost>>(
      await call(client, 'x_post_create', { text: T1, media_ids: [MEDIA_ID] }),
    );
    assert.equal(first.data.id, ID1);
    assert.equal(first.data.url, `https://x.com/i/status/${ID1}`);
    assert.equal(first.summary, `Post created: https://x.com/i/status/${ID1}`);
    // COST-3: a plain create is the flat `w:post` price; no URL in the text, so no COST-4
    // surcharge and no advisory note.
    assert.equal(first.meta.cost_usd, 0.015);
    assert.equal(first.meta.session_total_usd, 0.015);
    assert.equal(first.data.note, undefined);

    // Step 4 — replies to the id the previous step returned.
    const second = textPayload<Rendered<CreatedPost>>(
      await call(client, 'x_post_create', { text: T2, reply_to_id: first.data.id }),
    );
    assert.equal(second.data.id, ID2);
    assert.equal(second.data.url, `https://x.com/i/status/${ID2}`);
    assert.equal(second.meta.cost_usd, 0.015);
    assert.equal(second.meta.session_total_usd, 0.03);

    // Step 5 — and the last one to the id from step 4.
    const third = textPayload<Rendered<CreatedPost>>(
      await call(client, 'x_post_create', { text: T3, reply_to_id: second.data.id }),
    );
    assert.equal(third.data.id, ID3);
    assert.equal(third.data.url, `https://x.com/i/status/${ID3}`);
    assert.equal(third.meta.cost_usd, 0.015);
    assert.equal(third.meta.session_total_usd, 0.045);

    // The session meta is the operator-visible running total of the whole walkthrough.
    assert.equal(composition.budget.total(), 0.045);
    // Every interceptor above string-matched its full request body, so reaching here also
    // proves the wire shape of each step (`media.media_ids`, `reply.in_reply_to_tweet_id`).
    mock.assertDone();
  } finally {
    await client.close();
    await mock.close();
  }
});

// --- The failure the walkthrough exists to test ------------------------------------

test('walkthrough A (POST-3/POST-9): a mid-thread failure names the duplicate and says how to resume', async () => {
  const mock = mockHttp();
  interceptCreate(mock, 1).reply(201, createdEnvelope(ID1, T1));
  interceptCreate(mock, 2).reply(201, createdEnvelope(ID2, T2));
  // Step 5 hits X's duplicate-content refusal — the classic "did my thread land?" moment.
  const duplicate = loadFixture<{ status: number; body: object }>(
    'errors/403-duplicate-content.json',
  );
  interceptCreate(mock, 3).reply(duplicate.status, duplicate.body);

  const composition = composeFor(mock);
  const client = await connect(composition);
  try {
    const first = textPayload<Rendered<CreatedPost>>(
      await call(client, 'x_post_create', { text: T1, media_ids: [MEDIA_ID] }),
    );
    const second = textPayload<Rendered<CreatedPost>>(
      await call(client, 'x_post_create', { text: T2, reply_to_id: first.data.id }),
    );
    assert.equal(second.meta.session_total_usd, 0.03);

    const failed = await call(client, 'x_post_create', { text: T3, reply_to_id: second.data.id });
    assert.equal(failed.isError, true);
    const payload = textPayload<RenderedError>(failed);

    // POST-3: the platform's refusal is classified, not passed through as generic `api`.
    assert.equal(payload.error.kind, 'forbidden');
    assert.match(payload.error.message, /duplicate of a recent identical post/);
    assert.match(payload.error.message, /\(POST-3\)/);
    assert.equal(payload.error.retryable, false);

    // POST-9: because the failed call carried `reply_to_id`, the error also tells the agent
    // that the first two posts are LIVE and how to continue instead of re-posting the thread.
    assert.match(payload.error.message, /posts already created in this sequence remain live/);
    assert.match(payload.error.message, /resume by replying to the last successful id/);
    assert.match(payload.error.message, /\(POST-9\)/);
    assert.match(payload.error.message, /do not restart the thread from the top/);

    // The failed attempt is still billed: price is charged at the check, before the handler
    // runs, so the operator's running total covers three attempts, not two successes.
    assert.equal(composition.budget.total(), 0.045);
    mock.assertDone();
  } finally {
    await client.close();
    await mock.close();
  }
});

test('walkthrough A: without reply_to_id the same refusal carries NO thread-resume guidance (POST-9)', async () => {
  const mock = mockHttp();
  const duplicate = loadFixture<{ status: number; body: object }>(
    'errors/403-duplicate-content.json',
  );
  mock.pool
    .intercept({ path: '/2/tweets', method: 'POST', body: JSON.stringify({ text: T1 }) })
    .reply(duplicate.status, duplicate.body);

  const client = await connect(composeFor(mock));
  try {
    const failed = await call(client, 'x_post_create', { text: T1 });
    const payload = textPayload<RenderedError>(failed);
    assert.equal(payload.error.kind, 'forbidden');
    assert.match(payload.error.message, /duplicate of a recent identical post/);
    // A standalone post is not a thread — the recovery prose would be noise here.
    assert.doesNotMatch(payload.error.message, /Thread note/);
    mock.assertDone();
  } finally {
    await client.close();
    await mock.close();
  }
});
