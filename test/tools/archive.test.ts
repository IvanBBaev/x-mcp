// Tests for the full-archive search & counts tools (T-306). Each tool handler runs against
// a REAL createHttpClient (api/http) wired to an offline undici MockAgent
// (test/helpers/http.ts), so the whole endpoint -> compact-render path is exercised with no
// real network. Mirrors test/tools/search.test.ts; fixtures live in test/fixtures/archive/
// and each carries a `_provenance` key (DRIFT-4).
//
// undici 6.x matches an interceptor by string-comparing its `path` (with `query` merged in
// and the params sorted) against the incoming request's full path+query (also sorted), so
// every intercept below pins the EXACT query the endpoint wrapper puts on the wire. PAGE-5
// holds structurally: each wired test registers exactly ONE intercept and `assertDone()`
// proves the handler consumed it exactly once — a second request would fail to match.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHttpClient } from '../../src/api/http.js';
import { XError } from '../../src/core/errors.js';
import { UNTRUSTED_CONTENT_NOTE } from '../../src/core/render.js';
import type { RawListResponse, RawTweet } from '../../src/core/render.js';
import type { ToolContext } from '../../src/core/tooldef.js';
import type { RawCountsResponse } from '../../src/api/endpoints/search.js';
import { archiveTools, xPostCountsArchive, xSearchArchive } from '../../src/tools/archive.js';
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
  return { ports: makePorts({ dispatcher: http.dispatcher }), http: client };
}

// The compaction field params every archive search request carries (must mirror
// api/endpoints/archive). undici sorts params before comparing, so only the set matters.
const ARCHIVE_FIELD_PARAMS = {
  'tweet.fields':
    'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id',
  expansions: 'author_id,referenced_tweets.id,attachments.media_keys',
  'user.fields': 'username,name,verified',
  'media.fields': 'type,url,preview_image_url,alt_text',
} as const;

// The compact page the archive search handler returns (a Page<CompactPost>, narrowed).
interface CompactPageResult {
  readonly items: readonly { readonly author: string; readonly created_at?: string }[];
  readonly result_count: number;
  readonly next_token?: string;
  readonly note?: string;
}

// The compact histogram the archive counts handler returns.
interface CountsResult {
  readonly counts: readonly { readonly count: number; readonly start?: string }[];
  readonly total: number;
  readonly next_token?: string;
}

test('archiveTools exposes both P3 read:content tools with the expected axes (registered by default, budget-guarded — never availability-gated)', () => {
  assert.deepEqual(
    archiveTools.map((t) => t.name),
    ['x_search_archive', 'x_post_counts_archive'],
  );
  for (const tool of archiveTools) {
    assert.equal(tool.policy, 'read:content');
    // T-010 fact-check: full-archive endpoints are app+user under pay-per-use, so the
    // availability gate (pilot/premium-user/enterprise only) can never exclude them;
    // COST-1 (session credit budget) + COST-3 (per-call r:post cost) are the guard rails.
    assert.equal(tool.availability, 'app+user');
    assert.equal(tool.cost, 'r:post');
    assert.equal(tool.phase, 3);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.openWorldHint, true);
  }
  assert.deepEqual([...xSearchArchive.scopes], ['tweet.read', 'users.read']);
  assert.deepEqual([...xPostCountsArchive.scopes], ['tweet.read']);
});

test('x_search_archive: happy path renders a compact page with @handles and next_token', async () => {
  const http = mockHttp();
  http.pool
    .intercept({
      path: '/2/tweets/search/all',
      method: 'GET',
      query: { query: 'streaming api', ...ARCHIVE_FIELD_PARAMS },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('archive/archive-page.json'));

  const out = await xSearchArchive.handler({ query: 'streaming api' }, makeCtx(http));
  const page = out.data as CompactPageResult;

  assert.equal(page.items.length, 3);
  assert.equal(page.result_count, 3);
  assert.equal(page.next_token, 'arch-next-1');
  assert.equal(page.items[0]?.author, '@carol_codes');
  assert.ok(page.items.every((p) => p.author.startsWith('@')));
  // The archive reaches back past the 7-day recent window (2014-2015 era fixture).
  assert.equal(page.items[2]?.created_at, '2014-06-21T08:15:00.000Z');

  http.assertDone();
  await http.close();
});

test('PAGE-3: over-bound max_results clamps DOWN to 500 on the wire and the note explains it', async () => {
  const http = mockHttp();
  // Intercept pins max_results=500 (clamped), not 1000 (requested): a match proves the
  // clamp reached the wire, since undici string-compares the full sorted query.
  http.pool
    .intercept({
      path: '/2/tweets/search/all',
      method: 'GET',
      query: { query: 'x', ...ARCHIVE_FIELD_PARAMS, max_results: '500' },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('archive/archive-page.json'));

  const out = await xSearchArchive.handler({ query: 'x', max_results: 1000 }, makeCtx(http));
  const page = out.data as CompactPageResult;

  assert.ok(page.note);
  assert.match(page.note, /max_results adjusted to 500/);
  assert.match(page.note, /10-500/);

  http.assertDone();
  await http.close();
});

test('PAGE-3: under-bound max_results clamps UP to 10 on the wire (both directions)', async () => {
  const http = mockHttp();
  http.pool
    .intercept({
      path: '/2/tweets/search/all',
      method: 'GET',
      query: { query: 'x', ...ARCHIVE_FIELD_PARAMS, max_results: '10' },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('archive/archive-page.json'));

  const out = await xSearchArchive.handler({ query: 'x', max_results: 5 }, makeCtx(http));
  const page = out.data as CompactPageResult;

  assert.ok(page.note);
  assert.match(page.note, /max_results adjusted to 10/);

  http.assertDone();
  await http.close();
});

test('PAGE-1: page_token round-trips verbatim as next_token, alongside time window and sort order', async () => {
  const http = mockHttp();
  // The cursor from a previous page ('arch-next-1') must reach the wire untouched — the
  // intercept pins it verbatim together with the optional start/end/sort params.
  http.pool
    .intercept({
      path: '/2/tweets/search/all',
      method: 'GET',
      query: {
        query: 'x api',
        ...ARCHIVE_FIELD_PARAMS,
        next_token: 'arch-next-1',
        start_time: '2014-01-01T00:00:00Z',
        end_time: '2015-12-31T23:59:59Z',
        sort_order: 'relevancy',
      },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('archive/archive-page.json'));

  const out = await xSearchArchive.handler(
    {
      query: 'x api',
      page_token: 'arch-next-1',
      start_time: '2014-01-01T00:00:00Z',
      end_time: '2015-12-31T23:59:59Z',
      sort_order: 'relevancy',
    },
    makeCtx(http),
  );
  const page = out.data as CompactPageResult;
  assert.equal(page.result_count, 3);

  http.assertDone();
  await http.close();
});

test('REND-1 / PAGE-4: empty results carry the zero-results note and omit next_token', async () => {
  const http = mockHttp();
  http.pool
    .intercept({
      path: '/2/tweets/search/all',
      method: 'GET',
      query: { query: 'nothing-matches-this', ...ARCHIVE_FIELD_PARAMS },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('archive/archive-empty.json'));

  const out = await xSearchArchive.handler({ query: 'nothing-matches-this' }, makeCtx(http));
  const page = out.data as CompactPageResult;

  assert.equal(page.result_count, 0);
  assert.equal(page.next_token, undefined); // PAGE-4: last page omits the cursor entirely.
  assert.equal(page.note, 'No results matched this query.'); // REND-1

  http.assertDone();
  await http.close();
});

test('REND-10: raw:true caps the outgoing max_results at 25 and returns the exact API JSON', async () => {
  const http = mockHttp();
  // Intercept pins max_results=25 (the raw ceiling), not the requested 100.
  http.pool
    .intercept({
      path: '/2/tweets/search/all',
      method: 'GET',
      query: { query: 'x', ...ARCHIVE_FIELD_PARAMS, max_results: '25' },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('archive/archive-page.json'));

  const out = await xSearchArchive.handler(
    { query: 'x', max_results: 100, raw: true },
    makeCtx(http),
  );
  const raw = out.data as RawListResponse<RawTweet>;

  // Raw path returns the untouched envelope: raw tweet objects and the meta cursor.
  assert.equal(raw.data?.length, 3);
  assert.equal(raw.data?.[0]?.author_id, '201');
  assert.equal(raw.meta?.next_token, 'arch-next-1');
  // …but `raw` is no off switch for the REND-6 warning (T-320 F4): it bypasses compaction
  // and sanitization, so the untrusted-content marking matters MORE here, not less.
  assert.equal(out.summary, `3 raw result(s). ${UNTRUSTED_CONTENT_NOTE}`);

  http.assertDone();
  await http.close();
});

// A ToolContext whose http port fails loudly: DRIFT-3 rejections must fire BEFORE any
// request — on the archive surface a leaked call could burn hundreds of r:post credits.
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

test('DRIFT-3: x_search_archive rejects each removed engagement operator before any request', async () => {
  for (const op of ['min_likes', 'min_replies', 'min_reposts']) {
    await assert.rejects(
      () => xSearchArchive.handler({ query: `from:xdevelopers ${op}:10` }, noHttpCtx()),
      isRemovedOperatorError,
    );
  }
});

test('DRIFT-3: x_post_counts_archive applies the same pre-validation', async () => {
  await assert.rejects(
    () => xPostCountsArchive.handler({ query: 'ai min_replies:100' }, noHttpCtx()),
    isRemovedOperatorError,
  );
});

test('DRIFT-3: an operator name as a plain word is not a false positive', async () => {
  // Only the `operator:` form is the removed syntax; the bare word must still search.
  const http = mockHttp();
  http.pool
    .intercept({
      path: '/2/tweets/search/all',
      method: 'GET',
      query: { query: 'discussing min_reposts removal', ...ARCHIVE_FIELD_PARAMS },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('archive/archive-empty.json'));

  const out = await xSearchArchive.handler(
    { query: 'discussing min_reposts removal' },
    makeCtx(http),
  );
  const page = out.data as CompactPageResult;
  assert.equal(page.result_count, 0);

  http.assertDone();
  await http.close();
});

test('x_post_counts_archive: maps buckets to numeric counts, prefers meta total, passes next_token through', async () => {
  const http = mockHttp();
  http.pool
    .intercept({
      path: '/2/tweets/counts/all',
      method: 'GET',
      query: { query: 'x' },
    })
    .reply(200, loadFixture<RawCountsResponse>('archive/counts-archive.json'));

  const out = await xPostCountsArchive.handler({ query: 'x' }, makeCtx(http));
  const data = out.data as CountsResult;

  assert.equal(data.total, 50); // meta.total_tweet_count preferred over summing buckets.
  assert.equal(data.counts.length, 3);
  assert.equal(data.counts[0]?.count, 17);
  assert.equal(data.counts[0]?.start, '2014-06-20T00:00:00.000Z');
  assert.equal(data.counts[2]?.count, 0); // a zero bucket stays a number, not undefined.
  assert.equal(data.next_token, 'counts-next-1'); // archive counts page via meta.next_token.
  assert.ok(data.counts.every((b) => typeof b.count === 'number'));
  assert.equal(out.summary, '50 posts across 3 buckets.');

  http.assertDone();
  await http.close();
});

test('REND-10: raw search WITHOUT max_results sends no cap on the wire and counts a data-less page as 0', async () => {
  const http = mockHttp();
  // The raw ceiling only rewrites a max_results the caller actually asked for; with none
  // given the request must carry none — the API's own default applies, not an invented 25.
  // The intercept pins the exact sorted query, so a smuggled max_results fails the match.
  http.pool
    .intercept({
      path: '/2/tweets/search/all',
      method: 'GET',
      query: { query: 'nothing-matches-this', ...ARCHIVE_FIELD_PARAMS },
    })
    .reply(200, { meta: { result_count: 0 } });

  const out = await xSearchArchive.handler(
    { query: 'nothing-matches-this', raw: true },
    makeCtx(http),
  );

  // The envelope passes through untouched, and the absent `data` array counts as 0 —
  // still with the REND-6 warning, since even `meta` is platform-controlled JSON.
  assert.deepEqual(out.data, { meta: { result_count: 0 } });
  assert.equal(out.summary, `0 raw result(s). ${UNTRUSTED_CONTENT_NOTE}`);

  http.assertDone();
  await http.close();
});

test('x_post_counts_archive: raw:true returns the exact envelope with the bucket count and warning', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/tweets/counts/all', method: 'GET', query: { query: 'x' } })
    .reply(200, loadFixture<RawCountsResponse>('archive/counts-archive.json'));

  const out = await xPostCountsArchive.handler({ query: 'x', raw: true }, makeCtx(http));

  // Raw path: no compaction — the fixture envelope survives verbatim (meta included)…
  assert.deepEqual(out.data, loadFixture<RawCountsResponse>('archive/counts-archive.json'));
  // …and counts-only or not, raw JSON is platform-controlled, so the warning stays.
  assert.equal(out.summary, `3 raw bucket(s). ${UNTRUSTED_CONTENT_NOTE}`);

  // A degraded 200 with no data array counts 0 buckets instead of crashing.
  http.pool
    .intercept({ path: '/2/tweets/counts/all', method: 'GET', query: { query: 'y' } })
    .reply(200, { meta: {} });
  const empty = await xPostCountsArchive.handler({ query: 'y', raw: true }, makeCtx(http));
  assert.equal(empty.summary, `0 raw bucket(s). ${UNTRUSTED_CONTENT_NOTE}`);

  http.assertDone();
  await http.close();
});

test('x_post_counts_archive: with no meta total the buckets are summed, and bare buckets stay honest', async () => {
  const http = mockHttp();
  // No `meta` at all: total must come from summing the buckets — never NaN or a silent 0 —
  // and a bucket missing its timestamps/count still renders as a zero-count bucket with
  // the timestamp keys ABSENT (exactOptionalPropertyTypes), not `undefined`-valued.
  http.pool
    .intercept({ path: '/2/tweets/counts/all', method: 'GET', query: { query: 'x' } })
    .reply(200, {
      data: [
        {
          start: '2014-06-20T00:00:00.000Z',
          end: '2014-06-21T00:00:00.000Z',
          tweet_count: 17,
        },
        { tweet_count: 2 },
        {},
      ],
    });

  const out = await xPostCountsArchive.handler({ query: 'x' }, makeCtx(http));
  const data = out.data as CountsResult;

  assert.deepEqual(data, {
    counts: [
      {
        start: '2014-06-20T00:00:00.000Z',
        end: '2014-06-21T00:00:00.000Z',
        count: 17,
      },
      { count: 2 },
      { count: 0 },
    ],
    total: 19, // summed from the buckets — meta.total_tweet_count was absent
  });
  assert.equal(Object.hasOwn(data, 'next_token'), false); // no cursor invented either
  assert.equal(out.summary, '19 posts across 3 buckets.');

  http.assertDone();
  await http.close();
});

test('x_post_counts_archive: a data-less compact envelope renders an empty histogram, total 0', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/tweets/counts/all', method: 'GET', query: { query: 'x' } })
    .reply(200, {});

  const out = await xPostCountsArchive.handler({ query: 'x' }, makeCtx(http));

  assert.deepEqual(out.data, { counts: [], total: 0 });
  assert.equal(out.summary, '0 posts across 0 buckets.');

  http.assertDone();
  await http.close();
});

test('x_post_counts_archive: granularity, time window, and page_token (PAGE-1) reach the wire verbatim', async () => {
  const http = mockHttp();
  http.pool
    .intercept({
      path: '/2/tweets/counts/all',
      method: 'GET',
      query: {
        query: 'x api',
        granularity: 'day',
        start_time: '2014-06-20T00:00:00Z',
        end_time: '2014-06-23T00:00:00Z',
        next_token: 'counts-next-1',
      },
    })
    .reply(200, loadFixture<RawCountsResponse>('archive/counts-archive.json'));

  const out = await xPostCountsArchive.handler(
    {
      query: 'x api',
      granularity: 'day',
      start_time: '2014-06-20T00:00:00Z',
      end_time: '2014-06-23T00:00:00Z',
      page_token: 'counts-next-1',
    },
    makeCtx(http),
  );
  const data = out.data as CountsResult;
  assert.equal(data.total, 50);

  http.assertDone();
  await http.close();
});
