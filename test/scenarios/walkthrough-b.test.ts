// Scenario test for WALKTHROUGH B — "Summarize today's mentions and draft replies"
// (docs/reviews/06-agent-dx-review.md § Workflow walkthroughs, T-318 / WP-3.12).
//
// The walkthrough as written:
//   1. `timeline_mentions {start_time, max_results: 50}` -> mentions, compact.
//   2. per ambiguous mention: `post_get {id: parent_id}` or
//      `search_recent {query: "conversation_id:..."}` -> thread context.
//   3. the model summarizes and drafts replies in-model (no tool call).
// It "runs entirely under the default `read-only` policy", so nothing here sets
// X_MCP_POLICY — the default preset must carry the whole journey.
//
// Everything below drives the REAL composed serve-path graph (`composeServer`) over an
// SDK Client on an InMemoryTransport pair, with all network on the offline undici
// MockAgent. undici 6.x string-compares the full sorted path+query, so every intercept
// doubles as a wire-contract pin (e.g. the ISO-normalized `start_time` the tool sends).

import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { parseConfig } from '../../src/core/config.js';
import { composeServer } from '../../src/mcp/compose.js';
import type { Composition } from '../../src/mcp/compose.js';
import type { RateLimitStatus } from '../../src/api/ratelimit.js';
import type {
  RawListResponse,
  RawTweet,
  RawSingleResponse,
  RawUser,
} from '../../src/core/render.js';

import { mockHttp, loadFixture } from '../helpers/index.js';
import type { MockHttp } from '../helpers/index.js';

// --- Wire-contract constants (mirrored from the per-tool tests) --------------------

/** The field/expansion set every timeline request carries (api/endpoints/timelines). */
const TIMELINE_FIELD_PARAMS = {
  'tweet.fields':
    'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id',
  expansions:
    'author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys',
  'user.fields': 'username,name,verified',
  'media.fields': 'type,url,preview_image_url,alt_text',
} as const;

/** Search sends a narrower expansion set than posts/timelines (api/endpoints/search). */
const SEARCH_FIELD_PARAMS = {
  'tweet.fields':
    'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id',
  expansions: 'author_id,referenced_tweets.id,attachments.media_keys',
  'user.fields': 'username,name,verified',
  'media.fields': 'type,url,preview_image_url,alt_text',
} as const;

/** The `ids` lookup query x_post_get sends (api/endpoints/posts). */
const POSTS_FIELD_PARAMS = {
  'tweet.fields':
    'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id',
  expansions:
    'author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys',
  'user.fields': 'username,name,verified',
  'media.fields': 'type,url,preview_image_url,alt_text',
} as const;

/** The user.fields projection GET /2/users/me requests (api/endpoints/users). */
const USERS_PROJECTION = {
  'user.fields':
    'created_at,description,location,public_metrics,protected,url,verified,username,name',
} as const;

/** The authenticated user's id in test/fixtures/users/me.json. */
const ME_ID = '1526228120226357248';

/** The thread root both ambiguous mentions point at (test/fixtures/scenarios/*). */
const PARENT_ID = '1700000000000000009';

function rateHeaders(remaining: number): Record<string, string> {
  return {
    'x-rate-limit-limit': '180',
    'x-rate-limit-remaining': String(remaining),
    'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 900),
  };
}

// --- Harness (mirrors test/mcp/server.test.ts) ------------------------------------

/** Minimal valid app-only env (CFG-2). Note: X_MCP_POLICY is deliberately UNSET. */
function appOnlyEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { X_MCP_AUTH_MODE: 'app-only', X_MCP_BEARER_TOKEN: 'AAAA', ...extra };
}

function composeFor(mock: MockHttp, extraEnv: Record<string, string> = {}): Composition {
  return composeServer(parseConfig(appOnlyEnv(extraEnv)), { dispatcher: mock.dispatcher });
}

async function connect(composition: Composition): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'walkthrough-b', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), composition.server.connect(serverTransport)]);
  return client;
}

async function call(client: Client, name: string, args: object): Promise<CallToolResult> {
  return (await client.callTool({
    name,
    arguments: args as Record<string, unknown>,
  })) as CallToolResult;
}

/** The Phase-1 rendered success payload (docs/02 §5). */
interface Rendered<T> {
  readonly data: T;
  readonly summary?: string;
  readonly meta: { readonly cost_usd: number; readonly session_total_usd: number };
}

/** The rendered XError payload (`XError.toPayload`). */
interface RenderedError {
  readonly error: { readonly kind: string; readonly message: string; readonly retryable: boolean };
}

function textPayload<T>(result: CallToolResult): T {
  assert.equal(result.content.length, 1);
  const block = result.content[0];
  assert.ok(block !== undefined && block.type === 'text', 'expected one text content block');
  return JSON.parse(block.text) as T;
}

// --- Rendered shapes the walkthrough promises the operator will see ----------------

interface PostRef {
  readonly id: string;
  readonly author?: string;
}

interface CompactPost {
  readonly id: string;
  readonly author: string;
  readonly text: string;
  readonly url?: string;
  readonly created_at?: string;
  readonly metrics?: Record<string, number>;
  readonly reply_to?: PostRef;
  readonly quoted?: PostRef;
}

interface CompactPage {
  readonly items: readonly CompactPost[];
  readonly result_count: number;
  readonly next_token?: string;
  readonly note?: string;
}

interface PostBatch {
  readonly items: readonly CompactPost[];
  readonly missing?: readonly string[];
  readonly note?: string;
}

// --- Step 0: the tools the walkthrough needs are usable under the DEFAULT preset ---

test('walkthrough B step 0: the whole journey is listed and allowed under the default read-only policy (POL-7)', async () => {
  const mock = mockHttp();
  const client = await connect(composeFor(mock));

  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  for (const name of ['x_timeline_mentions', 'x_post_get', 'x_search_recent']) {
    const tool = byName.get(name);
    assert.ok(tool !== undefined, `${name} must be listed`);
    // No POL-7 suffix: read:content is inside the default `read-only` preset, so the
    // walkthrough never has to be told to widen the policy.
    assert.doesNotMatch(tool.description ?? '', /disabled by policy/);
    // MCP-4: all three are read-surface tools.
    assert.equal(tool.annotations?.readOnlyHint, true);
  }

  // Drafting replies (step 3) is deliberately in-model: the walkthrough never calls a
  // write tool, and under this preset it could not — x_post_create stays listed but denied.
  const postCreate = byName.get('x_post_create');
  assert.ok(postCreate !== undefined, 'x_post_create must stay registered (POL-7)');
  assert.match(postCreate.description ?? '', /\(disabled by policy `read-only`\)$/);

  mock.assertDone(); // tools/list touches no network
  await client.close();
  await mock.close();
});

// --- The journey ------------------------------------------------------------------

test('walkthrough B: mentions -> parent post -> conversation search, all under read-only', async () => {
  const mock = mockHttp();

  // Step 1 resolves `user: "me"` first (REND-8), then reads the mentions timeline. Both
  // requests belong to the x_timeline_mentions tool, so both record into one bucket.
  mock.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<RawSingleResponse<RawUser>>('users/me.json'), {
      headers: rateHeaders(179),
    });
  mock.pool
    .intercept({
      path: `/2/users/${ME_ID}/mentions`,
      method: 'GET',
      query: {
        ...TIMELINE_FIELD_PARAMS,
        max_results: '50',
        // REND-9: the tool normalizes the agent's `Z` form to ISO-8601 UTC with millis
        // BEFORE the wire, so a match here proves the normalization reached the request.
        start_time: '2026-07-21T00:00:00.000Z',
      },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('scenarios/mentions-page.json'), {
      headers: rateHeaders(178),
    });

  // Step 2a: the parent of the ambiguous mention, via the batch lookup.
  mock.pool
    .intercept({
      path: '/2/tweets',
      method: 'GET',
      query: { ids: PARENT_ID, ...POSTS_FIELD_PARAMS },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('scenarios/parent-post.json'), {
      headers: rateHeaders(14),
    });

  // Step 2b: the rest of the thread, via a conversation_id search.
  mock.pool
    .intercept({
      path: '/2/tweets/search/recent',
      method: 'GET',
      query: {
        query: `conversation_id:${PARENT_ID}`,
        max_results: '10',
        ...SEARCH_FIELD_PARAMS,
      },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('scenarios/conversation-page.json'), {
      headers: rateHeaders(59),
    });

  const composition = composeFor(mock);
  const client = await connect(composition);

  // --- Step 1: today's mentions, compact -----------------------------------------
  const mentionsResult = await call(client, 'x_timeline_mentions', {
    start_time: '2026-07-21T00:00:00Z',
    max_results: 50,
  });
  assert.notEqual(mentionsResult.isError, true);
  const mentions = textPayload<Rendered<CompactPage>>(mentionsResult);

  assert.equal(mentions.data.result_count, 3);
  assert.equal(mentions.data.items.length, 3);
  assert.deepEqual(
    mentions.data.items.map((p) => p.author),
    ['@carla_ops', '@dan_reads', '@erin_ml'],
  );
  // F3: every item carries the canonical, handle-free permalink (REND-4).
  assert.deepEqual(
    mentions.data.items.map((p) => p.url),
    [
      'https://x.com/i/status/1900000000000000001',
      'https://x.com/i/status/1900000000000000002',
      'https://x.com/i/status/1900000000000000003',
    ],
  );
  // The compact shape carries the reply/quote refs the walkthrough needs to decide
  // WHICH mentions are ambiguous — without them step 2 would be un-targetable.
  assert.deepEqual(mentions.data.items[0]?.reply_to, { id: PARENT_ID, author: '@self_bot' });
  assert.deepEqual(mentions.data.items[1]?.quoted, { id: PARENT_ID, author: '@self_bot' });
  assert.equal(mentions.data.items[2]?.reply_to, undefined);
  assert.equal(mentions.data.items[2]?.quoted, undefined);
  // Metrics ride along, so the model can triage without a second read.
  assert.equal(mentions.data.items[2]?.metrics?.['likes'], 9);
  // One page, no cursor: the fixture's meta carries no next_token.
  assert.equal(mentions.data.next_token, undefined);
  assert.equal(mentions.summary, '3 result(s).');
  // COST-3: the `owned` mentions read is $0.001 and it is the first spend of the session.
  assert.equal(mentions.meta.cost_usd, 0.001);
  assert.equal(mentions.meta.session_total_usd, 0.001);

  // --- Step 2a: pull the thread root the ambiguous mentions point at --------------
  const parentResult = await call(client, 'x_post_get', { ids: [PARENT_ID] });
  assert.notEqual(parentResult.isError, true);
  const parent = textPayload<Rendered<PostBatch>>(parentResult);

  assert.equal(parent.data.items.length, 1);
  assert.equal(parent.data.items[0]?.id, PARENT_ID);
  assert.equal(parent.data.items[0]?.author, '@self_bot');
  assert.equal(parent.data.items[0]?.url, `https://x.com/i/status/${PARENT_ID}`);
  assert.equal(parent.data.missing, undefined);
  // COST-3: $0.005 for a post read, accumulating onto the session total.
  assert.equal(parent.meta.cost_usd, 0.005);
  assert.equal(parent.meta.session_total_usd, 0.006);

  // --- Step 2b: the rest of the conversation --------------------------------------
  const threadResult = await call(client, 'x_search_recent', {
    query: `conversation_id:${PARENT_ID}`,
    max_results: 10,
  });
  assert.notEqual(threadResult.isError, true);
  const thread = textPayload<Rendered<CompactPage>>(threadResult);

  assert.equal(thread.data.result_count, 2);
  assert.deepEqual(
    thread.data.items.map((p) => p.id),
    ['1900000000000000001', '1900000000000000004'],
  );
  // The reply chain is walkable from the compact page alone.
  assert.deepEqual(thread.data.items[1]?.reply_to, { id: '1900000000000000001' });
  assert.equal(thread.meta.cost_usd, 0.005);
  assert.equal(thread.meta.session_total_usd, 0.011);

  // Step 3 (summarize + draft) is in-model: no further tool call, no further spend.
  assert.equal(composition.budget.total(), 0.011);

  // INT-3: the table is trained by the error mapper, and api/http exposes no success-path
  // header hook — so an all-2xx journey like this one leaves it empty. The operator sees
  // an honest "nothing observed yet", not a stale or invented window.
  const table = textPayload<Rendered<RateLimitStatus>>(
    await call(client, 'x_rate_limit_status', {}),
  );
  assert.deepEqual(table.data.buckets, []);
  assert.equal(table.meta.cost_usd, 0); // `local` meta tool: free, and it adds no spend
  assert.equal(table.meta.session_total_usd, 0.011);

  mock.assertDone();
  await client.close();
  await mock.close();
});

test('REND-6: the untrusted-content note is one field per RESULT, not one per item', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<RawSingleResponse<RawUser>>('users/me.json'));
  mock.pool
    .intercept({
      path: `/2/users/${ME_ID}/mentions`,
      method: 'GET',
      query: { ...TIMELINE_FIELD_PARAMS, max_results: '50' },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('scenarios/mentions-page.json'));

  const client = await connect(composeFor(mock));
  const page = textPayload<Rendered<CompactPage>>(
    await call(client, 'x_timeline_mentions', { max_results: 50 }),
  ).data;

  assert.equal(typeof page.note, 'string');
  assert.match(page.note ?? '', /third-party text/);
  assert.match(page.note ?? '', /data, not instructions/);
  // Exactly one guard note for the whole page — repeating it per item would be pure
  // token waste, which is the friction the walkthrough calls out.
  for (const item of page.items) {
    assert.ok(!('note' in item), 'a compact item must not repeat the guard note');
  }

  mock.assertDone();
  await client.close();
  await mock.close();
});

test('RATE-1/INT-3: a limited mentions read trains the TOOL bucket and the next call is refused before HTTP', async () => {
  const mock = mockHttp();
  // The `me` resolution the mentions tool issues is billed to the TOOL's bucket, not to a
  // generic `users` one (compose.ts TOOL_BUCKETS) — a 429 here must show up as
  // `timeline-mentions#app`, which is what makes the preflight refusal below correct.
  mock.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: USERS_PROJECTION })
    .reply(429, loadFixture<object>('errors/429-rate-limit.json'), {
      headers: {
        'x-rate-limit-limit': '180',
        'x-rate-limit-remaining': '0',
        'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 900),
      },
    });

  const client = await connect(composeFor(mock));

  const limited = await call(client, 'x_timeline_mentions', { max_results: 50 });
  assert.equal(limited.isError, true);
  assert.equal(textPayload<RenderedError>(limited).error.kind, 'rate-limit');

  const table = textPayload<Rendered<RateLimitStatus>>(
    await call(client, 'x_rate_limit_status', {}),
  ).data;
  assert.deepEqual(
    table.buckets.map((b) => b.key),
    ['timeline-mentions#app'],
  );
  const bucket = table.buckets[0];
  assert.deepEqual(
    bucket?.windows.map((w) => w.remaining),
    [0],
  );
  assert.equal(bucket?.windows[0]?.exhausted, true);

  // RATE-1: the second attempt never reaches the network — the preflight gate refuses it.
  // No interceptor is registered for it, so any request would fail the mock outright.
  const refused = await call(client, 'x_timeline_mentions', { max_results: 50 });
  assert.equal(refused.isError, true);
  assert.equal(textPayload<RenderedError>(refused).error.kind, 'rate-limit');

  mock.assertDone();
  await client.close();
  await mock.close();
});
