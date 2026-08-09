// Protocol-level tests for the MCP adapter + composition (T-130). Each test composes the
// REAL serve-path object graph (`composeServer`) from a parsed env — the same wiring
// production uses, minus stdio: the server talks to an SDK Client over a linked
// InMemoryTransport pair (MCP-2), and all network goes through the undici MockAgent
// dispatcher so the per-bucket recording clients (INT-3) are exercised end to end.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { parseConfig } from '../../src/core/config.js';
import { composeServer } from '../../src/mcp/compose.js';
import type { Composition } from '../../src/mcp/compose.js';
import type { RateLimitStatus } from '../../src/api/ratelimit.js';

import { mockHttp, loadFixture } from '../helpers/index.js';
import type { MockHttp } from '../helpers/index.js';

// The exact field/expansion query x_post_get sends (pinned in test/tools/posts.test.ts):
// undici matches the full query string, so the interceptor doubles as a wire-contract pin.
const COMMON_QUERY = {
  'tweet.fields':
    'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id',
  expansions:
    'author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys',
  'user.fields': 'username,name,verified',
  'media.fields': 'type,url,preview_image_url,alt_text',
} as const;

function queryFor(ids: string): Record<string, string> {
  return { ids, ...COMMON_QUERY };
}

/** Minimal valid app-only env (CFG-2); tests layer policy/budget overrides on top. */
function appOnlyEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { X_MCP_AUTH_MODE: 'app-only', X_MCP_BEARER_TOKEN: 'AAAA', ...extra };
}

/** Compose the production object graph over the mock dispatcher. */
function composeFor(mock: MockHttp, extraEnv: Record<string, string> = {}): Composition {
  return composeServer(parseConfig(appOnlyEnv(extraEnv)), { dispatcher: mock.dispatcher });
}

/** Connect an SDK client to the composed server over an in-memory pair (MCP-2). */
async function connect(composition: Composition): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-harness', version: '0.0.0' });
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
interface Rendered {
  readonly data: unknown;
  readonly summary?: string;
  readonly meta: { readonly cost_usd: number; readonly session_total_usd: number };
}

/** The rendered XError payload (`XError.toPayload`). */
interface RenderedError {
  readonly error: { readonly kind: string; readonly message: string; readonly retryable: boolean };
}

/** Unwrap the single text content block and parse its JSON payload. */
function textPayload<T>(result: CallToolResult): T {
  assert.equal(result.content.length, 1);
  const block = result.content[0];
  assert.ok(block !== undefined && block.type === 'text', 'expected one text content block');
  return JSON.parse(block.text) as T;
}

// Read-surface tools: everything in a read:* / meta cell → readOnlyHint (MCP-4).
const READ_TOOLS = [
  'x_auth_status',
  'x_bookmarks_list',
  'x_dm_conversation_events_list',
  'x_dm_events_list',
  'x_dm_participant_events_list',
  'x_followers_list',
  'x_following_list',
  'x_list_get',
  'x_list_members',
  'x_list_timeline',
  'x_lists_owned',
  'x_media_status',
  'x_post_counts_archive',
  'x_post_counts_recent',
  'x_post_get',
  'x_rate_limit_status',
  'x_search_archive',
  'x_search_recent',
  'x_timeline_home',
  'x_timeline_mentions',
  'x_timeline_user',
  'x_usage_get',
  'x_user_get',
  'x_user_search',
];

// Write-surface tools (Phases 2–3): must NOT advertise readOnlyHint.
const WRITE_TOOLS = [
  'x_block_set',
  'x_bookmark_set',
  'x_dm_send',
  'x_follow_set',
  'x_like_set',
  'x_list_create',
  'x_list_delete',
  'x_list_follow_set',
  'x_list_member_set',
  'x_list_pin_set',
  'x_list_update',
  'x_media_upload',
  'x_mute_set',
  'x_post_create',
  'x_post_delete',
  'x_post_hide_reply',
  'x_repost_set',
];

// The destructive:* cells → destructiveHint (MCP-4).
const DESTRUCTIVE_TOOLS = new Set(['x_block_set', 'x_list_delete', 'x_post_delete']);

const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS].sort();

test('MCP-2: tools/list exposes the registered tools with object input schemas', async () => {
  const mock = mockHttp();
  const client = await connect(composeFor(mock));

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ALL_TOOLS);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} must advertise an object schema`);
    assert.ok(tool.description !== undefined && tool.description.length > 0);
  }

  await client.close();
  await mock.close();
});

test('MCP-4: listed annotations are derived from the policy class', async () => {
  const mock = mockHttp();
  const client = await connect(composeFor(mock));

  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  // Read-surface tools sit in read:* / meta cells -> readOnlyHint, and MCP-4 stamps
  // openWorldHint on every tool regardless of its own declared hints.
  for (const name of READ_TOOLS) {
    const tool = byName.get(name);
    assert.ok(tool?.annotations, `${name} must carry annotations`);
    assert.equal(tool.annotations.readOnlyHint, true, name);
    assert.equal(tool.annotations.openWorldHint, true, name);
    assert.notEqual(tool.annotations.destructiveHint, true, name);
  }
  // Write-surface tools must never claim to be read-only; only destructive:* cells carry
  // destructiveHint.
  for (const name of WRITE_TOOLS) {
    const tool = byName.get(name);
    assert.ok(tool?.annotations, `${name} must carry annotations`);
    assert.notEqual(tool.annotations.readOnlyHint, true, name);
    assert.equal(tool.annotations.openWorldHint, true, name);
    assert.equal(tool.annotations.destructiveHint, DESTRUCTIVE_TOOLS.has(name), name);
  }
  assert.equal(byName.get('x_post_get')?.annotations?.title, 'Get posts');

  await client.close();
  await mock.close();
});

test('MCP-5: server identity and instructions cover identifiers, pagination, raw, and policy', async () => {
  const mock = mockHttp();
  const client = await connect(composeFor(mock));

  assert.equal(client.getServerVersion()?.name, 'x-mcp-ai');
  const instructions = client.getInstructions();
  assert.ok(instructions !== undefined);
  assert.match(instructions, /page_token/); // the next_token -> page_token bridge
  assert.match(instructions, /`raw`|raw: true/); // raw-mode semantics + cost warning
  assert.match(instructions, /policy/); // the operator policy model
  assert.match(instructions, /x_auth_status/); // the call-auth-status-first hint

  await client.close();
  await mock.close();
});

test('POL-7: denied tools stay listed with the disabled-by-policy suffix and refuse calls', async () => {
  const mock = mockHttp();
  const composition = composeFor(mock, { X_MCP_POLICY_DENY: 'read:content' });
  const client = await connect(composition);

  const { tools } = await client.listTools();
  const postGet = tools.find((t) => t.name === 'x_post_get');
  assert.ok(postGet !== undefined, 'denied tool must stay listed');
  assert.match(postGet.description ?? '', /\(disabled by policy `read-only`\)$/);

  const result = await call(client, 'x_post_get', { ids: ['111'] });
  assert.equal(result.isError, true);
  const payload = textPayload<RenderedError>(result);
  assert.equal(payload.error.kind, 'policy');
  // The deny happens BEFORE the budget gate: nothing is charged for a refused call.
  assert.equal(composition.budget.total(), 0);

  mock.assertDone(); // no network was touched
  await client.close();
  await mock.close();
});

test('POL-2: the engage preset opens write:engagement but keeps content writes denied', async () => {
  const mock = mockHttp();
  const composition = composeFor(mock, { X_MCP_POLICY: 'engage' });
  const client = await connect(composition);

  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  // write:engagement is granted by `engage`: no disabled-by-policy suffix.
  for (const name of ['x_like_set', 'x_repost_set', 'x_bookmark_set']) {
    assert.doesNotMatch(byName.get(name)?.description ?? '', /disabled by policy/, name);
  }
  // write:content / destructive:content stay denied under `engage` (POL-2), and the
  // suffix names the ACTIVE preset.
  for (const name of ['x_post_create', 'x_post_delete']) {
    assert.match(byName.get(name)?.description ?? '', /\(disabled by policy `engage`\)$/, name);
  }

  // A denied write refuses BEFORE budget and network: typed policy error, nothing charged.
  const result = await call(client, 'x_post_create', { text: 'hello' });
  assert.equal(result.isError, true);
  assert.equal(textPayload<RenderedError>(result).error.kind, 'policy');
  assert.equal(composition.budget.total(), 0);

  mock.assertDone(); // no network was touched
  await client.close();
  await mock.close();
});

test('POL-7: X_MCP_HIDE_DENIED drops denied tools from the listing entirely', async () => {
  const mock = mockHttp();
  const client = await connect(
    composeFor(mock, { X_MCP_POLICY_DENY: 'read:content', X_MCP_HIDE_DENIED: '1' }),
  );

  // Under the default `read-only` preset with read:content denied and hidden, what
  // survives is meta + read:user + read:account + read:social-graph; DM reads sit in no
  // preset (POL-3).
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'x_auth_status',
    'x_followers_list',
    'x_following_list',
    'x_rate_limit_status',
    'x_usage_get',
    'x_user_get',
    'x_user_search',
  ]);

  await client.close();
  await mock.close();
});

test('MCP-2: tools/call round-trips a read tool through the full composed pipeline', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/tweets',
      method: 'GET',
      query: queryFor('111,222'),
      // The composed app-only client must sign with the operator bearer (AUTH-14).
      headers: { authorization: 'Bearer AAAA' },
    })
    .reply(200, loadFixture<object>('posts/two-posts.json'));

  const composition = composeFor(mock);
  const client = await connect(composition);

  const result = await call(client, 'x_post_get', { ids: ['111', '222'] });
  assert.notEqual(result.isError, true);
  const payload = textPayload<Rendered>(result);
  const batch = payload.data as { items: unknown[] };
  assert.equal(batch.items.length, 2);
  assert.equal(payload.summary, '2 post(s)');
  // ResultMeta (COST-3) flows from the real budget through the registry envelope.
  assert.ok(payload.meta.cost_usd > 0);
  assert.equal(payload.meta.session_total_usd, payload.meta.cost_usd);
  assert.equal(composition.budget.total(), payload.meta.cost_usd);

  mock.assertDone();
  await client.close();
  await mock.close();
});

test('INT-2/INT-3/RATE-2: a 429 charges at check time, trains the tracker, and blocks the retry', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'GET', query: queryFor('111') })
    .reply(429, loadFixture<object>('errors/429-rate-limit.json'), {
      headers: {
        'x-rate-limit-limit': '15',
        'x-rate-limit-remaining': '0',
        'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 900),
      },
    });

  const composition = composeFor(mock);
  const client = await connect(composition);

  // Call 1: reaches the API, gets 429. The budget gate charged at check time (INT-2), so
  // the failed-but-attempted call stays charged — the honest accounting.
  const first = await call(client, 'x_post_get', { ids: ['111'] });
  assert.equal(first.isError, true);
  assert.equal(textPayload<RenderedError>(first).error.kind, 'rate-limit');
  const chargedOnce = composition.budget.total();
  assert.ok(chargedOnce > 0, 'the failed call must stay charged (INT-2)');

  // Call 2: NO interceptor is queued — the recorded headers must make the preflight gate
  // refuse locally (RATE-2) before any network attempt (a network attempt would surface as
  // a loud MockAgent failure, not a typed rate-limit error).
  const second = await call(client, 'x_post_get', { ids: ['111'] });
  assert.equal(second.isError, true);
  assert.equal(textPayload<RenderedError>(second).error.kind, 'rate-limit');
  assert.equal(composition.budget.total(), chargedOnce * 2);

  // The recording client filed the headers under the composed bucket key (INT-3).
  const status = await call(client, 'x_rate_limit_status', {});
  const table = textPayload<Rendered>(status).data as RateLimitStatus;
  assert.deepEqual(
    table.buckets.map((b) => b.key),
    ['tweets#app'],
  );

  mock.assertDone();
  await client.close();
  await mock.close();
});

/** A minimal `GET /2/tweets` envelope whose contents are derivable from the requested ids. */
function postsEnvelope(ids: readonly string[]): object {
  return {
    data: ids.map((id) => ({
      id,
      text: `post ${id}`,
      created_at: '2026-07-20T14:30:00.000Z',
      author_id: `a${id}`,
    })),
    includes: {
      users: ids.map((id) => ({
        id: `a${id}`,
        username: `author_${id}`,
        name: `Author ${id}`,
        verified: false,
      })),
    },
  };
}

/** Identical rate-limit headers on every reply, so the shared bucket has ONE settled value. */
const SHARED_RATE_HEADERS = {
  'x-rate-limit-limit': '15',
  'x-rate-limit-remaining': '10',
  'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 900),
};

test('MCP-8/CONC-2: parallel tools/call requests interleave safely with no cross-talk and atomic accounting', async () => {
  const mock = mockHttp();
  // Three overlapping calls with DISTINCT arguments, answered OUT OF ORDER: the call issued
  // first is answered last. If the adapter kept any per-request global mutable state — a
  // "current" tool, args, or invoker — the payloads would land on the wrong promise here.
  const calls = [
    { ids: ['111'], delayMs: 60 },
    { ids: ['222'], delayMs: 30 },
    { ids: ['111', '222'], delayMs: 1 },
  ] as const;
  for (const c of calls) {
    mock.pool
      .intercept({ path: '/2/tweets', method: 'GET', query: queryFor(c.ids.join(',')) })
      .reply(200, postsEnvelope(c.ids), { headers: SHARED_RATE_HEADERS })
      .delay(c.delayMs);
  }

  const composition = composeFor(mock);
  const client = await connect(composition);

  const results = await Promise.all(calls.map((c) => call(client, 'x_post_get', { ids: c.ids })));
  const payloads = results.map((r) => {
    assert.notEqual(r.isError, true);
    return textPayload<Rendered>(r);
  });

  // (1) No cross-talk: every result carries exactly the posts ITS OWN arguments asked for.
  payloads.forEach((payload, i) => {
    const expected = calls[i]?.ids ?? [];
    const batch = payload.data as { items: Array<{ id: string; author: string; text: string }> };
    assert.deepEqual(
      batch.items.map((p) => p.id),
      [...expected],
      `call ${i} must receive only its own posts`,
    );
    for (const post of batch.items) {
      assert.equal(post.text, `post ${post.id}`);
      assert.equal(post.author, `@author_${post.id}`);
    }
    assert.equal(payload.summary, `${expected.length} post(s)`);
  });

  // (2) Atomic check-and-reserve (CONC-2): identical cost class, and the three session totals
  //     are 1x/2x/3x — every call saw a DIFFERENT snapshot, so no update was lost.
  const unit = payloads[0]?.meta.cost_usd ?? 0;
  assert.ok(unit > 0);
  for (const payload of payloads) assert.equal(payload.meta.cost_usd, unit);
  const totals = payloads.map((p) => p.meta.session_total_usd).sort((x, y) => x - y);
  assert.deepEqual(totals, [unit, unit * 2, unit * 3]);
  assert.equal(composition.budget.total(), unit * 3);

  // (3) The rate-limit table is unchanged by three concurrent SUCCESSES. This is not an
  //     oversight in the test: api/http exposes its header hook only through `mapError`, so
  //     the per-bucket recording clients (INT-3) train the tracker on non-2xx responses only
  //     (see the integrator note in mcp/compose). Pinning the empty table here keeps that
  //     limitation visible — if a success-path hook is ever added, this assertion fails and
  //     forces the concurrency claim below to be revisited deliberately.
  const status = await call(client, 'x_rate_limit_status', {});
  assert.deepEqual((textPayload<Rendered>(status).data as RateLimitStatus).buckets, []);

  mock.assertDone();
  await client.close();
  await mock.close();
});

test('MCP-8/CONC-3: concurrent limited responses on one bucket settle into a single entry', async () => {
  const mock = mockHttp();
  // Three overlapping calls whose replies all carry rate-limit headers and land out of order.
  // They share ONE per-bucket recording client, so the tracker sees three interleaved writes
  // to the same key — the table must end with one bucket holding one settled window, never
  // three entries and never a torn read.
  const calls = [
    { ids: ['111'], delayMs: 60 },
    { ids: ['222'], delayMs: 30 },
    { ids: ['333'], delayMs: 1 },
  ] as const;
  for (const c of calls) {
    mock.pool
      .intercept({ path: '/2/tweets', method: 'GET', query: queryFor(c.ids.join(',')) })
      .reply(429, loadFixture<object>('errors/429-rate-limit.json'), {
        headers: SHARED_RATE_HEADERS,
      })
      .delay(c.delayMs);
  }

  const composition = composeFor(mock);
  const client = await connect(composition);

  const results = await Promise.all(calls.map((c) => call(client, 'x_post_get', { ids: c.ids })));
  for (const result of results) {
    assert.equal(result.isError, true);
    assert.equal(textPayload<RenderedError>(result).error.kind, 'rate-limit');
  }

  const status = await call(client, 'x_rate_limit_status', {});
  const table = textPayload<Rendered>(status).data as RateLimitStatus;
  assert.deepEqual(
    table.buckets.map((b) => b.key),
    ['tweets#app'],
  );
  // ONE window, and its remaining is 0, not the header's 10: a 429 means the window is spent
  // whatever the header claims, and the tracker clamps it (RATE-1). Three interleaved writes
  // therefore converge on one settled value rather than racing to the last header seen.
  assert.deepEqual(
    table.buckets[0]?.windows.map((w) => w.remaining),
    [0],
  );

  mock.assertDone();
  await client.close();
  await mock.close();
});

test('INT-6: x_auth_status reports the config-derived snapshot without a network call', async () => {
  const mock = mockHttp();
  const client = await connect(composeFor(mock));

  const result = await call(client, 'x_auth_status', {});
  assert.notEqual(result.isError, true);
  const report = textPayload<Rendered>(result).data as {
    auth_mode: string;
    scopes: string[];
    availability: string[];
    policy: { preset: string; cells: Record<string, boolean> };
    me?: unknown;
    note?: string;
  };
  assert.equal(report.auth_mode, 'app-only');
  assert.deepEqual(report.scopes, []);
  assert.equal(report.policy.preset, 'read-only');
  assert.equal(report.policy.cells['read:content'], true);
  assert.equal(report.policy.cells['write:content'], false);
  assert.equal(report.me, undefined); // AUTH-15: no user under app-only
  assert.match(report.note ?? '', /app-only/);

  mock.assertDone(); // the app-only path must NOT fall back to GET /2/users/me
  await client.close();
  await mock.close();
});

test('INT-3: x_rate_limit_status is local-only — no bucket, no charge, empty table', async () => {
  const mock = mockHttp();
  const composition = composeFor(mock);
  const client = await connect(composition);

  const result = await call(client, 'x_rate_limit_status', {});
  assert.notEqual(result.isError, true);
  const payload = textPayload<Rendered>(result);
  assert.deepEqual((payload.data as RateLimitStatus).buckets, []);
  assert.equal(payload.summary, 'rate-limit: 0 bucket(s) tracked');
  assert.equal(payload.meta.cost_usd, 0);
  assert.equal(composition.budget.total(), 0);

  mock.assertDone();
  await client.close();
  await mock.close();
});

test('MCP-2: unknown arguments surface as a typed validation tool result, not a protocol error', async () => {
  const mock = mockHttp();
  const client = await connect(composeFor(mock));

  // The low-level adapter must let the REGISTRY validate (ARCH-F2): a bad input renders as
  // an isError tool result with the `validation` taxonomy, never an McpError -32602 throw.
  const result = await call(client, 'x_post_get', { ids: ['111'], bogus: true });
  assert.equal(result.isError, true);
  assert.equal(textPayload<RenderedError>(result).error.kind, 'validation');

  mock.assertDone();
  await client.close();
  await mock.close();
});
