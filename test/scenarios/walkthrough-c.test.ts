// Scenario test for WALKTHROUGH C — "Find the most-engaged post about topic T this week
// and quote-post it" (docs/reviews/06-agent-dx-review.md § Workflow walkthroughs,
// T-318 / WP-3.12).
//
// The walkthrough as written:
//   1. (optional) `post_counts_recent {query: "T -is:retweet", granularity: "day"}`
//      -> volume shape, so the model can size the search before paying for it.
//   2. `search_recent {query: "T -is:retweet lang:en", max_results: 100,
//      sort_order: "relevancy"}` -> one page of compact posts WITH metrics.
//   3. the model ranks client-side by `metrics` (likes + reposts + quotes) -> winner id.
//      There is no engagement sort at Basic tier, so this is a sample, not a global max.
//   4. `post_create {text, quote_id: winner_id}` -> id + URL.
//
// The named friction is that step 4 CROSSES THE POLICY BOUNDARY mid-workflow (read ->
// write:content): under the default `read-only` preset the model gets through steps 1-3
// and then hits a terminal `policy` error. Both halves are asserted below — the refused
// run under `read-only`, and the same journey completed under `publish`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { parseConfig } from '../../src/core/config.js';
import { composeServer } from '../../src/mcp/compose.js';
import type { Composition } from '../../src/mcp/compose.js';
import type { RawListResponse, RawTweet } from '../../src/core/render.js';
import type { RawCountsResponse } from '../../src/api/endpoints/search.js';

import { mockHttp, loadFixture } from '../helpers/index.js';
import type { MockHttp } from '../helpers/index.js';

// --- Wire-contract constants (mirrored from test/tools/search.test.ts) -------------

/** Search sends a narrower expansion set than posts/timelines (api/endpoints/search). */
const SEARCH_FIELD_PARAMS = {
  'tweet.fields':
    'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id',
  expansions: 'author_id,referenced_tweets.id,attachments.media_keys',
  'user.fields': 'username,name,verified',
  'media.fields': 'type,url,preview_image_url,alt_text',
} as const;

/** The topic under study, and the two query forms the walkthrough uses for it. */
const COUNTS_QUERY = 'agent tooling -is:retweet';
const SEARCH_QUERY = 'agent tooling -is:retweet lang:en';

/** The most-engaged post in test/fixtures/search/recent-page.json (30 + 4 + 1). */
const WINNER_ID = '1800000000000000001';

// --- Harness (mirrors test/mcp/server.test.ts) ------------------------------------

function appOnlyEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { X_MCP_AUTH_MODE: 'app-only', X_MCP_BEARER_TOKEN: 'AAAA', ...extra };
}

function composeFor(mock: MockHttp, extraEnv: Record<string, string> = {}): Composition {
  return composeServer(parseConfig(appOnlyEnv(extraEnv)), { dispatcher: mock.dispatcher });
}

async function connect(composition: Composition): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'walkthrough-c', version: '0.0.0' });
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
  readonly meta: {
    readonly cost_usd: number;
    readonly session_total_usd: number;
    readonly budget_warning?: string;
  };
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

// --- Rendered shapes --------------------------------------------------------------

interface PostMetrics {
  readonly likes?: number;
  readonly reposts?: number;
  readonly quotes?: number;
  readonly replies?: number;
}

interface CompactPost {
  readonly id: string;
  readonly author: string;
  readonly text: string;
  readonly url?: string;
  readonly metrics?: PostMetrics;
}

interface CompactPage {
  readonly items: readonly CompactPost[];
  readonly result_count: number;
  readonly next_token?: string;
  readonly note?: string;
}

interface CountsResult {
  readonly counts: readonly { readonly count: number; readonly start?: string }[];
  readonly total: number;
}

interface CreatedPost {
  readonly id: string;
  readonly url: string;
  readonly note?: string;
}

/** Step 3 as the model would do it: rank the page client-side, no tool call involved. */
function rankByEngagement(items: readonly CompactPost[]): readonly CompactPost[] {
  const score = (p: CompactPost): number =>
    (p.metrics?.likes ?? 0) + (p.metrics?.reposts ?? 0) + (p.metrics?.quotes ?? 0);
  return [...items].sort((a, b) => score(b) - score(a));
}

/** Register the step-1 counts intercept. */
function interceptCounts(mock: MockHttp): void {
  mock.pool
    .intercept({
      path: '/2/tweets/counts/recent',
      method: 'GET',
      query: { query: COUNTS_QUERY, granularity: 'day' },
    })
    .reply(200, loadFixture<RawCountsResponse>('search/counts.json'));
}

/** Register the step-2 search intercept (exactly one — PAGE-5: no auto-pagination). */
function interceptSearch(mock: MockHttp): void {
  mock.pool
    .intercept({
      path: '/2/tweets/search/recent',
      method: 'GET',
      query: {
        query: SEARCH_QUERY,
        max_results: '100',
        sort_order: 'relevancy',
        ...SEARCH_FIELD_PARAMS,
      },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-page.json'));
}

// --- The refused run: the policy boundary is crossed mid-workflow ------------------

test('walkthrough C under read-only: steps 1-3 run, step 4 is refused at the policy boundary (POL-7)', async () => {
  const mock = mockHttp();
  interceptCounts(mock);
  interceptSearch(mock);

  const composition = composeFor(mock); // no X_MCP_POLICY -> the `read-only` default
  const client = await connect(composition);

  // The listing already tells the model where the wall is: the read tools are clean, the
  // write tool is still there (so it is discoverable and its refusal is terminal, not a
  // "tool missing" mystery) but carries the disabled-by-policy suffix.
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const name of ['x_post_counts_recent', 'x_search_recent']) {
    assert.doesNotMatch(byName.get(name)?.description ?? '', /disabled by policy/);
  }
  const postCreate = byName.get('x_post_create');
  assert.ok(postCreate !== undefined, 'x_post_create must stay registered (POL-7)');
  assert.match(postCreate.description ?? '', /\(disabled by policy `read-only`\)$/);
  // MCP-4: a write tool never advertises readOnlyHint, denied or not.
  assert.notEqual(postCreate.annotations?.readOnlyHint, true);

  // --- Step 1: size the topic before paying for the search -----------------------
  const countsResult = await call(client, 'x_post_counts_recent', {
    query: COUNTS_QUERY,
    granularity: 'day',
  });
  assert.notEqual(countsResult.isError, true);
  const counts = textPayload<Rendered<CountsResult>>(countsResult);
  assert.equal(counts.data.total, 128);
  assert.deepEqual(
    counts.data.counts.map((b) => b.count),
    [42, 86],
  );
  // Numbers and ISO timestamps only — no third-party text, so no untrusted-content note.
  assert.equal(counts.meta.cost_usd, 0.005);
  assert.equal(counts.meta.session_total_usd, 0.005);

  // --- Step 2: one relevancy-sorted page, metrics included ------------------------
  const searchResult = await call(client, 'x_search_recent', {
    query: SEARCH_QUERY,
    max_results: 100,
    sort_order: 'relevancy',
  });
  assert.notEqual(searchResult.isError, true);
  const page = textPayload<Rendered<CompactPage>>(searchResult);

  assert.equal(page.data.result_count, 3);
  // Step 3 is only possible because every item carries `metrics`; without them the model
  // would have to re-fetch each candidate.
  for (const item of page.data.items) {
    assert.ok(item.metrics !== undefined, `${item.id} must carry metrics for client ranking`);
  }
  assert.match(page.data.note ?? '', /third-party text/);
  // PAGE-1/PAGE-5: exactly ONE request was made and the cursor comes back opaque for the
  // model to pass as `page_token` — the tool never auto-paginates behind its back.
  assert.equal(page.data.next_token, 'abc');
  assert.equal(page.meta.cost_usd, 0.005);
  assert.equal(page.meta.session_total_usd, 0.01);

  // --- Step 3: rank client-side (in-model, no tool call, no spend) ----------------
  const ranked = rankByEngagement(page.data.items);
  assert.equal(ranked[0]?.id, WINNER_ID);
  assert.equal(ranked[0]?.author, '@alice_dev');
  assert.equal(ranked[0]?.url, `https://x.com/i/status/${WINNER_ID}`);

  // --- Step 4: the wall ------------------------------------------------------------
  const quoteResult = await call(client, 'x_post_create', {
    text: 'Best breakdown of the topic this week.',
    quote_id: WINNER_ID,
  });
  assert.equal(quoteResult.isError, true);
  const refusal = textPayload<RenderedError>(quoteResult);
  assert.equal(refusal.error.kind, 'policy');
  // POL-7: terminal — retrying is pointless, only the operator can change it.
  assert.equal(refusal.error.retryable, false);
  assert.equal(refusal.error.fix, 'operator');
  // The refusal names the blocked cell, so the operator knows exactly what to widen.
  assert.match(refusal.error.message, /write:content/);

  // The deny runs BEFORE the budget gate: the refused step charges nothing, so the
  // session total is still exactly steps 1 + 2.
  assert.equal(composition.budget.total(), 0.01);

  mock.assertDone(); // step 4 never reached the network
  await client.close();
  await mock.close();
});

// --- The completed run: the same journey with the boundary opened -----------------

test('walkthrough C under publish: counts -> search -> client-side ranking -> quote post (COST-3)', async () => {
  const mock = mockHttp();
  interceptCounts(mock);
  interceptSearch(mock);
  const quoteText = 'Best breakdown of the topic this week.';
  mock.pool
    .intercept({
      path: '/2/tweets',
      method: 'POST',
      // The winner id from step 3 must reach the wire as `quote_tweet_id` — a reply would
      // be `reply.in_reply_to_tweet_id`, which is a different post entirely.
      body: JSON.stringify({ text: quoteText, quote_tweet_id: WINNER_ID }),
    })
    .reply(201, loadFixture<object>('scenarios/quote-post-created.json'));

  const composition = composeFor(mock, { X_MCP_POLICY: 'publish' });
  const client = await connect(composition);

  const { tools } = await client.listTools();
  const postCreate = tools.find((t) => t.name === 'x_post_create');
  assert.ok(postCreate !== undefined);
  // `publish` grants write:content, so the same tool now lists without the suffix.
  assert.doesNotMatch(postCreate.description ?? '', /disabled by policy/);

  await call(client, 'x_post_counts_recent', { query: COUNTS_QUERY, granularity: 'day' });
  const page = textPayload<Rendered<CompactPage>>(
    await call(client, 'x_search_recent', {
      query: SEARCH_QUERY,
      max_results: 100,
      sort_order: 'relevancy',
    }),
  );
  const winner = rankByEngagement(page.data.items)[0];
  assert.equal(winner?.id, WINNER_ID);

  const createResult = await call(client, 'x_post_create', {
    text: quoteText,
    quote_id: winner?.id,
  });
  assert.notEqual(createResult.isError, true);
  const created = textPayload<Rendered<CreatedPost>>(createResult);

  assert.equal(created.data.id, '1900000000000000777');
  assert.equal(created.data.url, 'https://x.com/i/status/1900000000000000777');
  assert.equal(created.summary, 'Post created: https://x.com/i/status/1900000000000000777');
  // COST-4: this text carries no URL, so the base price applies and no price note appears.
  assert.equal(created.data.note, undefined);
  assert.equal(created.meta.cost_usd, 0.015);
  // COST-3: $0.005 counts + $0.005 search + $0.015 create, accumulated across the journey.
  assert.equal(created.meta.session_total_usd, 0.025);
  assert.equal(composition.budget.total(), 0.025);

  mock.assertDone();
  await client.close();
  await mock.close();
});

// --- The other mid-workflow wall: price, not policy -------------------------------

test('COST-4/COST-5: a URL in the quote text raises the price to $0.20 and hard mode refuses before spending', async () => {
  const mock = mockHttp();
  interceptCounts(mock);
  interceptSearch(mock);

  // Cap sized so steps 1-2 fit comfortably but a $0.20 URL post cannot.
  const composition = composeFor(mock, {
    X_MCP_POLICY: 'publish',
    X_MCP_CREDIT_BUDGET: '0.05',
    X_MCP_BUDGET_MODE: 'hard',
  });
  const client = await connect(composition);

  await call(client, 'x_post_counts_recent', { query: COUNTS_QUERY, granularity: 'day' });
  const page = textPayload<Rendered<CompactPage>>(
    await call(client, 'x_search_recent', {
      query: SEARCH_QUERY,
      max_results: 100,
      sort_order: 'relevancy',
    }),
  );
  assert.equal(rankByEngagement(page.data.items)[0]?.id, WINNER_ID);
  assert.equal(composition.budget.total(), 0.01);

  const refusedResult = await call(client, 'x_post_create', {
    text: `Best breakdown of the topic this week: https://x.com/i/status/${WINNER_ID}`,
    quote_id: WINNER_ID,
  });
  assert.equal(refusedResult.isError, true);
  const refusal = textPayload<RenderedError>(refusedResult);
  assert.equal(refusal.error.kind, 'budget');
  // The refusal quotes the RAISED $0.20 price, not the $0.015 base — that is the whole
  // point of warning before the spend rather than after it.
  assert.match(refusal.error.message, /\$0\.2/);
  assert.match(refusal.error.message, /credit budget of \$0\.05/);
  assert.equal(refusal.error.retryable, false);

  // COST-5: a refused reservation mutates nothing — the counter is still steps 1 + 2.
  assert.equal(composition.budget.total(), 0.01);

  mock.assertDone(); // the create never reached the network
  await client.close();
  await mock.close();
});
