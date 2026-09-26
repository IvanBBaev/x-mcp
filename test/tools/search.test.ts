// Tests for the search & counts tools (T-123). Each tool handler runs against a REAL
// createHttpClient (api/http) wired to an offline undici MockAgent (test/helpers/http.ts),
// so the whole endpoint -> compact-render path is exercised with no real network. This
// mirrors the smoke-test wiring; fixtures live in test/fixtures/search/.
//
// undici 6.x matches an interceptor by string-comparing its `path` (with `query` merged in
// and the params sorted) against the incoming request's full path+query (also sorted). A
// path-only interceptor therefore never matches a request that carries a query string, so
// every intercept below pins the EXACT query the endpoint wrapper puts on the wire. The
// clamp test in particular pins `max_results: '100'` (the clamped value, not the requested
// 500) so a match proves the clamp reached the wire.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHttpClient } from '../../src/api/http.js';
import { XError, apiError } from '../../src/core/errors.js';
import { createRegistry } from '../../src/core/registry.js';
import type { Registry } from '../../src/core/registry.js';
import { UNTRUSTED_CONTENT_NOTE } from '../../src/core/render.js';
import type { RawListResponse, RawTweet } from '../../src/core/render.js';
import type { AnyToolDef, ToolContext } from '../../src/core/tooldef.js';
import type { RawCountsResponse } from '../../src/api/endpoints/search.js';
import { searchTools, xPostCountsRecent, xSearchRecent } from '../../src/tools/search.js';
import {
  fakeClock,
  fakeRandom,
  fakeSleep,
  loadFixture,
  makePorts,
  mockHttp,
} from '../helpers/index.js';

/** Build a ToolContext whose `http` is the real client over the offline mock dispatcher. */
function makeCtx(http: ReturnType<typeof mockHttp>): ToolContext {
  const clock = fakeClock(0);
  const sleep = fakeSleep(clock);
  const random = fakeRandom([0.5]);
  const client = createHttpClient({ sleep: sleep.fn, random, dispatcher: http.dispatcher });
  // The tool clock sits after every time window used below, so no end_time is clamped (REND-9).
  const toolClock = fakeClock(Date.parse('2026-08-01T00:00:00.000Z'));
  return { ports: makePorts({ clock: toolClock, dispatcher: http.dispatcher }), http: client };
}

// The compaction field params every search request carries (must mirror api/endpoints/search).
// undici sorts params before comparing, so key order here is irrelevant — only the set matters.
const SEARCH_FIELD_PARAMS = {
  'tweet.fields':
    'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id',
  expansions: 'author_id,referenced_tweets.id,attachments.media_keys',
  'user.fields': 'username,name,verified',
  'media.fields': 'type,url,preview_image_url,alt_text',
} as const;

// The compact page the search handler returns (a Page<CompactPost>, narrowed for asserts).
interface CompactPageResult {
  readonly items: readonly { readonly author: string }[];
  readonly result_count: number;
  readonly next_token?: string;
  readonly note?: string;
}

// The compact histogram the counts handler returns.
interface CountsResult {
  readonly counts: readonly { readonly count: number; readonly start?: string }[];
  readonly total: number;
  readonly next_token?: string;
}

test('searchTools registers both P1 read:content tools with the expected axes', () => {
  assert.deepEqual(
    searchTools.map((t) => t.name),
    ['x_search_recent', 'x_post_counts_recent'],
  );
  for (const tool of searchTools) {
    assert.equal(tool.policy, 'read:content');
    assert.equal(tool.availability, 'app+user');
    assert.equal(tool.cost, 'r:post');
    assert.equal(tool.phase, 1);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.openWorldHint, true);
  }
  assert.deepEqual([...xSearchRecent.scopes], ['tweet.read', 'users.read']);
  assert.deepEqual([...xPostCountsRecent.scopes], ['tweet.read']);
});

test('x_search_recent: happy path renders a compact page with @handles and next_token', async () => {
  const http = mockHttp();
  http.pool
    .intercept({
      path: '/2/tweets/search/recent',
      method: 'GET',
      query: { query: 'safety-first', ...SEARCH_FIELD_PARAMS },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-page.json'));

  const out = await xSearchRecent.handler({ query: 'safety-first' }, makeCtx(http));
  const page = out.data as CompactPageResult;

  assert.equal(page.items.length, 3);
  assert.equal(page.result_count, 3);
  // COST-3: the page is billed per post it returned, so the handler reports three units
  // for the registry to settle the reservation with — not one for the call.
  assert.equal(out.units, 3);
  assert.equal(page.next_token, 'abc');
  assert.equal(page.items[0]?.author, '@alice_dev');
  assert.ok(page.items.every((p) => p.author.startsWith('@')));

  http.assertDone();
  await http.close();
});

test('x_search_recent: over-bound max_results is clamped and the note explains it', async () => {
  const http = mockHttp();
  // Intercept pins max_results=100 (clamped), not 500 (requested): a match proves the clamp
  // reached the wire, since undici string-compares the full sorted query.
  http.pool
    .intercept({
      path: '/2/tweets/search/recent',
      method: 'GET',
      query: { query: 'x', ...SEARCH_FIELD_PARAMS, max_results: '100' },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-page.json'));

  const out = await xSearchRecent.handler({ query: 'x', max_results: 500 }, makeCtx(http));
  const page = out.data as CompactPageResult;

  assert.ok(page.note);
  assert.match(page.note, /max_results adjusted to 100/);

  http.assertDone();
  await http.close();
});

test('x_search_recent: page_token rides the wire verbatim, the time window ISO-normalized (PAGE-1, REND-9)', async () => {
  const http = mockHttp();
  // The intercept pins the RENAMED wire params: page_token -> next_token, start_time and
  // end_time re-emitted as canonical ISO-8601 UTC (REND-9). A match proves the bridge, since
  // undici string-compares the full sorted query.
  http.pool
    .intercept({
      path: '/2/tweets/search/recent',
      method: 'GET',
      query: {
        query: 'x',
        ...SEARCH_FIELD_PARAMS,
        next_token: 'abc',
        start_time: '2026-07-20T00:00:00.000Z',
        end_time: '2026-07-27T00:00:00.000Z',
      },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-page.json'));

  const out = await xSearchRecent.handler(
    {
      query: 'x',
      page_token: 'abc',
      start_time: '2026-07-20T00:00:00Z',
      end_time: '2026-07-27T00:00:00Z',
    },
    makeCtx(http),
  );
  const page = out.data as CompactPageResult;

  assert.equal(page.result_count, 3);
  assert.equal(page.next_token, 'abc');

  http.assertDone();
  await http.close();
});

test('REND-9: x_search_recent clamps a near-now end_time to 10 s in the past and notes it', async () => {
  const http = mockHttp();
  // makeCtx's tool clock sits at 2026-08-01T00:00:00.000Z; an end_time at that instant falls
  // inside the 10 s rejection window, so the wire must carry the clamped value instead.
  http.pool
    .intercept({
      path: '/2/tweets/search/recent',
      method: 'GET',
      query: { query: 'x', ...SEARCH_FIELD_PARAMS, end_time: '2026-07-31T23:59:50.000Z' },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-page.json'));

  const out = await xSearchRecent.handler(
    { query: 'x', end_time: '2026-08-01T00:00:00Z' },
    makeCtx(http),
  );
  const page = out.data as CompactPageResult;

  assert.ok(page.note);
  assert.match(page.note, /end_time adjusted to 2026-07-31T23:59:50\.000Z/);
  assert.match(page.note, /at least 10 seconds in the past/);

  http.assertDone();
  await http.close();
});

test('REND-9: x_search_recent rejects an unparseable time bound before any request', async () => {
  await assert.rejects(
    () => xSearchRecent.handler({ query: 'x', end_time: 'not-a-date' }, noHttpCtx()),
    (err: unknown) => {
      assert.ok(XError.is(err), 'expected an XError');
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /end_time is not a recognizable timestamp/);
      return true;
    },
  );
});

test('x_search_recent: raw:true returns the exact envelope and caps the wire at 25 (REND-10)', async () => {
  const http = mockHttp();
  const fixture = loadFixture<RawListResponse<RawTweet>>('search/recent-page.json');
  // The intercept pins max_results=25 (the raw ceiling), not the requested 100.
  http.pool
    .intercept({
      path: '/2/tweets/search/recent',
      method: 'GET',
      query: { query: 'x', ...SEARCH_FIELD_PARAMS, max_results: '25' },
    })
    .reply(200, fixture);

  const out = await xSearchRecent.handler(
    { query: 'x', raw: true, max_results: 100 },
    makeCtx(http),
  );

  // The envelope is passed through byte-for-byte — no compaction, no sanitization…
  assert.deepEqual(out.data, fixture);
  // …but the REND-6 warning still rides the summary (T-320 F4).
  assert.equal(out.summary, `3 raw result(s). ${UNTRUSTED_CONTENT_NOTE}`);
  // A raw read pays for the same three posts: the price follows the response, not the shape.
  assert.equal(out.units, 3);

  http.assertDone();
  await http.close();
});

test('x_search_recent: raw without max_results sends the raw default (REND-10); a data-less 200 counts as 0', async () => {
  const http = mockHttp();
  // With no size asked for, the raw read sends the raw default (10) (REND-10). A degraded
  // envelope with no `data` must not crash the summary (DRIFT-1).
  const envelope = { meta: { result_count: 0 } };
  http.pool
    .intercept({
      path: '/2/tweets/search/recent',
      method: 'GET',
      query: { query: 'x', ...SEARCH_FIELD_PARAMS, max_results: '10' },
    })
    .reply(200, envelope);

  const out = await xSearchRecent.handler({ query: 'x', raw: true }, makeCtx(http));

  assert.deepEqual(out.data, envelope);
  assert.equal(out.summary, `0 raw result(s). ${UNTRUSTED_CONTENT_NOTE}`);
  assert.equal(out.units, 0); // no resource returned, nothing to charge for (REND-1)

  http.assertDone();
  await http.close();
});

test('x_search_recent: empty results carry the zero-results note', async () => {
  const http = mockHttp();
  http.pool
    .intercept({
      path: '/2/tweets/search/recent',
      method: 'GET',
      query: { query: 'nothing-matches-this', ...SEARCH_FIELD_PARAMS },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-empty.json'));

  const out = await xSearchRecent.handler({ query: 'nothing-matches-this' }, makeCtx(http));
  const page = out.data as CompactPageResult;

  assert.equal(page.result_count, 0);
  assert.equal(out.units, 0); // an empty page is free (COST-3/REND-1)
  assert.equal(page.next_token, undefined);
  assert.equal(page.note, 'No results matched this query.');

  http.assertDone();
  await http.close();
});

// A ToolContext whose http port fails loudly: DRIFT-3 rejections must fire BEFORE any
// request, so reaching the stub at all is the failure (mirrors the posts bad-id test).
function noHttpCtx(): ToolContext {
  return {
    ports: makePorts(),
    http: {
      send: () => Promise.reject(new Error('endpoint must not be called for a removed operator')),
    },
  };
}

/** Assert the rejection is the typed DRIFT-3 `validation` error, not the stub's Error. */
function isRemovedOperatorError(err: unknown): boolean {
  assert.ok(XError.is(err), 'expected an XError');
  assert.equal(err.kind, 'validation');
  assert.match(err.message, /operator removed by X/);
  return true;
}

/**
 * A registry with permissive gates that counts budget checks (pipeline step 4), so a test
 * can prove a local refusal happens at schema validation (step 1) and is never charged
 * (delta audit 09 Finding 1 residual). Mirrors `test/tools/posts.test.ts`'s helper of the same name.
 */
function chargeCountingRegistry(tool: AnyToolDef): { reg: Registry; budgetChecks: () => number } {
  let checks = 0;
  const reg = createRegistry([tool], {
    policy: {
      preset: 'publish',
      hideDenied: false,
      isAllowed: () => true,
      denyError: () => apiError('unused'),
    },
    budget: {
      check: () => {
        checks += 1;
      },
      reserve: () => ({ cost_usd: 0, session_total_usd: 0 }),
    },
    rateLimit: { preflight: () => {} },
  });
  return { reg, budgetChecks: () => checks };
}

test('DRIFT-3: x_search_recent rejects each removed engagement operator before the budget charge or any request', async () => {
  for (const op of ['min_likes', 'min_replies', 'min_reposts']) {
    const { reg, budgetChecks } = chargeCountingRegistry(xSearchRecent);
    await assert.rejects(
      () => reg.call('x_search_recent', { query: `from:xdevelopers ${op}:10` }, noHttpCtx()),
      isRemovedOperatorError,
    );
    assert.equal(budgetChecks(), 0);
  }
});

test('DRIFT-3: x_post_counts_recent applies the same pre-validation before the budget charge', async () => {
  const { reg, budgetChecks } = chargeCountingRegistry(xPostCountsRecent);
  await assert.rejects(
    () => reg.call('x_post_counts_recent', { query: 'ai min_likes:100' }, noHttpCtx()),
    isRemovedOperatorError,
  );
  assert.equal(budgetChecks(), 0);
});

test('DRIFT-3: x_search_recent.input.safeParse rejects a removed operator, naming the field', () => {
  const rejected = xSearchRecent.input.safeParse({ query: 'from:xdevelopers min_replies:5' });
  assert.equal(rejected.success, false);
  if (!rejected.success) {
    const issue = rejected.error.issues[0];
    assert.deepEqual(issue?.path, ['query']);
    assert.match(issue?.message ?? '', /operator removed by X/);
  }
  assert.equal(
    xSearchRecent.input.safeParse({ query: 'from:xdevelopers -is:retweet' }).success,
    true,
  );
});

test('DRIFT-3: x_post_counts_recent.input.safeParse rejects a removed operator, naming the field', () => {
  const rejected = xPostCountsRecent.input.safeParse({ query: 'ai min_reposts:10' });
  assert.equal(rejected.success, false);
  if (!rejected.success) {
    const issue = rejected.error.issues[0];
    assert.deepEqual(issue?.path, ['query']);
    assert.match(issue?.message ?? '', /operator removed by X/);
  }
});

test('DRIFT-3: an operator name as a plain word is not a false positive', async () => {
  // Only the `operator:` form is the removed syntax; the bare word must still search.
  const http = mockHttp();
  http.pool
    .intercept({
      path: '/2/tweets/search/recent',
      method: 'GET',
      query: { query: 'discussing min_likes removal', ...SEARCH_FIELD_PARAMS },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-empty.json'));

  const out = await xSearchRecent.handler({ query: 'discussing min_likes removal' }, makeCtx(http));
  const page = out.data as CompactPageResult;
  assert.equal(page.result_count, 0);

  http.assertDone();
  await http.close();
});

test('x_post_counts_recent: maps buckets to numeric counts with a total', async () => {
  const http = mockHttp();
  http.pool
    .intercept({
      path: '/2/tweets/counts/recent',
      method: 'GET',
      query: { query: 'x' },
    })
    .reply(200, loadFixture<RawCountsResponse>('search/counts.json'));

  const out = await xPostCountsRecent.handler({ query: 'x' }, makeCtx(http));
  const data = out.data as CountsResult;

  assert.equal(data.total, 128);
  assert.equal(data.counts.length, 2);
  assert.equal(data.counts[0]?.count, 42);
  assert.equal(data.counts[0]?.start, '2026-07-19T00:00:00.000Z');
  assert.ok(data.counts.every((b) => typeof b.count === 'number'));

  http.assertDone();
  await http.close();
});

test('x_post_counts_recent: granularity and page_token ride the wire, the window ISO-normalized', async () => {
  const http = mockHttp();
  // Pins every optional query param the tool can forward: granularity passes through, the
  // time window is re-emitted as canonical ISO-8601 UTC (REND-9), and page_token is bridged
  // to next_token (PAGE-1).
  http.pool
    .intercept({
      path: '/2/tweets/counts/recent',
      method: 'GET',
      query: {
        query: 'x',
        granularity: 'day',
        start_time: '2026-07-20T00:00:00.000Z',
        end_time: '2026-07-27T00:00:00.000Z',
        next_token: 'ct1',
      },
    })
    .reply(200, loadFixture<RawCountsResponse>('search/counts.json'));

  const out = await xPostCountsRecent.handler(
    {
      query: 'x',
      granularity: 'day',
      start_time: '2026-07-20T00:00:00Z',
      end_time: '2026-07-27T00:00:00Z',
      page_token: 'ct1',
    },
    makeCtx(http),
  );
  const data = out.data as CountsResult;

  assert.equal(data.total, 128);
  assert.equal(data.counts.length, 2);

  http.assertDone();
  await http.close();
});

test('x_post_counts_recent: raw:true returns the exact counts envelope with the untrusted note', async () => {
  const http = mockHttp();
  const fixture = loadFixture<RawCountsResponse>('search/counts.json');
  http.pool
    .intercept({ path: '/2/tweets/counts/recent', method: 'GET', query: { query: 'x' } })
    .reply(200, fixture);

  const out = await xPostCountsRecent.handler({ query: 'x', raw: true }, makeCtx(http));

  assert.deepEqual(out.data, fixture);
  assert.equal(out.summary, `2 raw bucket(s). ${UNTRUSTED_CONTENT_NOTE}`);

  http.assertDone();
  await http.close();
});

test('x_post_counts_recent: raw on a data-less 200 reports zero raw buckets', async () => {
  const http = mockHttp();
  const envelope = { meta: { total_tweet_count: 0 } };
  http.pool
    .intercept({ path: '/2/tweets/counts/recent', method: 'GET', query: { query: 'x' } })
    .reply(200, envelope);

  const out = await xPostCountsRecent.handler({ query: 'x', raw: true }, makeCtx(http));

  assert.deepEqual(out.data, envelope);
  assert.equal(out.summary, `0 raw bucket(s). ${UNTRUSTED_CONTENT_NOTE}`);

  http.assertDone();
  await http.close();
});

test('x_post_counts_recent: a data-less 200 degrades to an empty histogram (DRIFT-1)', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/tweets/counts/recent', method: 'GET', query: { query: 'x' } })
    .reply(200, {});

  const out = await xPostCountsRecent.handler({ query: 'x' }, makeCtx(http));

  assert.deepEqual(out.data, { counts: [], total: 0 });
  assert.equal(out.summary, '0 posts across 0 buckets.');

  http.assertDone();
  await http.close();
});

test('x_post_counts_recent: sparse buckets count as 0 and total falls back to the bucket sum', async () => {
  const http = mockHttp();
  // No meta.total_tweet_count -> the total is recomputed from the buckets; a bucket with no
  // fields at all renders as { count: 0 } (start/end omitted, DRIFT-1); the response cursor
  // is surfaced verbatim.
  http.pool
    .intercept({ path: '/2/tweets/counts/recent', method: 'GET', query: { query: 'x' } })
    .reply(200, {
      data: [
        { start: '2026-07-19T00:00:00.000Z', end: '2026-07-20T00:00:00.000Z', tweet_count: 5 },
        {},
      ],
      meta: { next_token: 'ct2' },
    });

  const out = await xPostCountsRecent.handler({ query: 'x' }, makeCtx(http));
  const data = out.data as CountsResult;

  assert.deepEqual(data, {
    counts: [
      { start: '2026-07-19T00:00:00.000Z', end: '2026-07-20T00:00:00.000Z', count: 5 },
      { count: 0 },
    ],
    total: 5,
    next_token: 'ct2',
  });
  assert.equal(out.summary, '5 posts across 2 buckets.');

  http.assertDone();
  await http.close();
});
