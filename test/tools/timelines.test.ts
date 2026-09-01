// Tests for the timeline read tools (T-212). Each tool handler runs against a REAL
// createHttpClient (api/http) wired to an offline undici MockAgent (test/helpers/http.ts),
// so the whole resolve -> endpoint -> compact-render path is exercised with no real
// network. Fixtures are reused from test/fixtures/users/ and test/fixtures/search/ (a
// timeline response envelope is shape-identical to a search page).
//
// undici 6.x matches an interceptor by string-comparing its `path` (with `query` merged in
// and the params sorted) against the incoming request's full path+query (also sorted). A
// path-only interceptor therefore never matches a request that carries a query string, so
// every intercept below pins the EXACT query the endpoint wrapper puts on the wire. The
// REND-9 test in particular pins the CLAMPED end_time (now - 10 s), not the requested one,
// so a match proves the clamp reached the wire.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHttpClient } from '../../src/api/http.js';
import { XError } from '../../src/core/errors.js';
import { UNTRUSTED_CONTENT_NOTE } from '../../src/core/render.js';
import type {
  RawListResponse,
  RawSingleResponse,
  RawTweet,
  RawUser,
} from '../../src/core/render.js';
import type { ToolContext } from '../../src/core/tooldef.js';
import {
  timelinesTools,
  xTimelineHome,
  xTimelineMentions,
  xTimelineUser,
} from '../../src/tools/timelines.js';
import {
  fakeClock,
  fakeRandom,
  fakeSleep,
  loadFixture,
  makePorts,
  mockHttp,
} from '../helpers/index.js';
import type { FakeClock } from '../helpers/index.js';

/** Build a ToolContext whose `http` is the real client over the offline mock dispatcher. */
function makeCtx(http: ReturnType<typeof mockHttp>, clock: FakeClock = fakeClock(0)): ToolContext {
  const sleep = fakeSleep(clock);
  const random = fakeRandom([0.5]);
  const client = createHttpClient({ sleep: sleep.fn, random, dispatcher: http.dispatcher });
  return { ports: makePorts({ clock, dispatcher: http.dispatcher }), http: client };
}

// The compaction field params every timeline request carries (must mirror
// api/endpoints/timelines). undici sorts params before comparing, so only the set matters.
const TIMELINE_FIELD_PARAMS = {
  'tweet.fields':
    'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id',
  expansions:
    'author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys',
  'user.fields': 'username,name,verified',
  'media.fields': 'type,url,preview_image_url,alt_text',
} as const;

// The user.fields projection the users endpoints request (must mirror api/endpoints/users).
const USERS_PROJECTION = {
  'user.fields':
    'created_at,description,location,public_metrics,protected,url,verified,username,name',
} as const;

/** The authenticated user's id in test/fixtures/users/me.json. */
const ME_ID = '1526228120226357248';

// The compact page the timeline handlers return (a Page<CompactPost>, narrowed for asserts).
interface CompactPageResult {
  readonly items: readonly { readonly author: string }[];
  readonly result_count: number;
  readonly next_token?: string;
  readonly note?: string;
}

test('timelinesTools registers the three timeline read tools with the expected axes', () => {
  assert.deepEqual(
    timelinesTools.map((t) => t.name),
    ['x_timeline_home', 'x_timeline_mentions', 'x_timeline_user'],
  );
  for (const tool of timelinesTools) {
    assert.equal(tool.policy, 'read:content');
    assert.equal(tool.phase, 2);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.openWorldHint, true);
    assert.deepEqual([...tool.scopes], ['tweet.read', 'users.read']);
  }
  assert.equal(xTimelineHome.availability, 'user-only');
  assert.equal(xTimelineHome.cost, 'r:post');
  assert.equal(xTimelineMentions.availability, 'app+user');
  assert.equal(xTimelineMentions.cost, 'owned');
  assert.equal(xTimelineUser.availability, 'app+user');
  assert.equal(xTimelineUser.cost, 'r:post');
});

test('x_timeline_home: resolves me then renders a compact page (REND-8/REND-6)', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<RawSingleResponse<RawUser>>('users/me.json'));
  http.pool
    .intercept({
      path: `/2/users/${ME_ID}/timelines/reverse_chronological`,
      method: 'GET',
      query: TIMELINE_FIELD_PARAMS,
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-page.json'));

  const out = await xTimelineHome.handler({}, makeCtx(http));
  const page = out.data as CompactPageResult;

  assert.equal(page.result_count, 3);
  assert.equal(page.next_token, 'abc');
  assert.ok(page.items.every((p) => p.author.startsWith('@')));
  assert.ok(page.note);
  assert.match(page.note, /third-party text/); // REND-6 untrusted-content note

  http.assertDone();
  await http.close();
});

test('PAGE-3: x_timeline_home clamps max_results below the window up to 5 and notes it', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<RawSingleResponse<RawUser>>('users/me.json'));
  // Intercept pins max_results=5 (clamped), not 2 (requested): a match proves the clamp
  // reached the wire, since undici string-compares the full sorted query.
  http.pool
    .intercept({
      path: `/2/users/${ME_ID}/timelines/reverse_chronological`,
      method: 'GET',
      query: { ...TIMELINE_FIELD_PARAMS, max_results: '5' },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-page.json'));

  const out = await xTimelineHome.handler({ max_results: 2 }, makeCtx(http));
  const page = out.data as CompactPageResult;

  assert.ok(page.note);
  assert.match(page.note, /max_results adjusted to 5/);

  http.assertDone();
  await http.close();
});

test('REND-9: x_timeline_home clamps a near-now end_time to 10 s in the past and notes it', async () => {
  const NOW_ISO = '2026-07-30T12:00:00.000Z';
  const CLAMPED_ISO = '2026-07-30T11:59:50.000Z';
  const clock = fakeClock(Date.parse(NOW_ISO));

  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<RawSingleResponse<RawUser>>('users/me.json'));
  // Pins the CLAMPED end_time: X rejects an end_time within ~10 s of now, so the tool
  // must send now - 10 s instead of the requested now.
  http.pool
    .intercept({
      path: `/2/users/${ME_ID}/timelines/reverse_chronological`,
      method: 'GET',
      query: { ...TIMELINE_FIELD_PARAMS, end_time: CLAMPED_ISO },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-page.json'));

  const out = await xTimelineHome.handler({ end_time: NOW_ISO }, makeCtx(http, clock));
  const page = out.data as CompactPageResult;

  assert.ok(page.note);
  assert.match(page.note, /end_time adjusted to 2026-07-30T11:59:50\.000Z/);
  assert.match(page.note, /at least 10 seconds in the past/);

  http.assertDone();
  await http.close();
});

test('REND-9: a safely-past end_time is normalized to ISO-8601 UTC and passed through unclamped', async () => {
  const clock = fakeClock(Date.parse('2026-07-30T12:00:00.000Z'));
  const http = mockHttp();
  // Offset forms in, canonical UTC on the wire — and NOT the clamp value for end_time.
  http.pool
    .intercept({
      path: '/2/users/50393960/tweets',
      method: 'GET',
      query: {
        ...TIMELINE_FIELD_PARAMS,
        start_time: '2026-07-28T22:00:00.000Z',
        end_time: '2026-07-30T08:00:00.000Z',
      },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-page.json'));

  const out = await xTimelineUser.handler(
    {
      user: '50393960',
      start_time: '2026-07-29T00:00:00+02:00',
      end_time: '2026-07-30T10:00:00+02:00',
    },
    makeCtx(http, clock),
  );
  const page = out.data as CompactPageResult;

  assert.ok(page.note);
  assert.doesNotMatch(page.note, /end_time adjusted/);

  http.assertDone();
  await http.close();
});

// A ToolContext whose http port fails loudly: validation must fire BEFORE any request, so
// reaching the stub at all is the failure (mirrors the search removed-operator tests).
function noHttpCtx(): ToolContext {
  return {
    ports: makePorts(),
    http: {
      send: () => Promise.reject(new Error('endpoint must not be called for invalid input')),
    },
  };
}

/** Assert the rejection is a typed `validation` XError whose message matches `re`. */
function isValidation(re: RegExp) {
  return (err: unknown): boolean => {
    assert.ok(XError.is(err), 'expected an XError');
    assert.equal(err.kind, 'validation');
    assert.match(err.message, re);
    return true;
  };
}

test('REND-9: unparseable time bounds are validation errors before any request', async () => {
  await assert.rejects(
    () => xTimelineUser.handler({ user: '101', start_time: 'not-a-date' }, noHttpCtx()),
    isValidation(/start_time is not a recognizable timestamp/),
  );
  // An overlong garbage value is echoed truncated (77 chars + '...'), never verbatim.
  await assert.rejects(
    () =>
      xTimelineUser.handler({ user: '101', start_time: `garbage-${'x'.repeat(100)}` }, noHttpCtx()),
    isValidation(/start_time is not a recognizable timestamp: "garbage-x{69}\.\.\."/),
  );
  await assert.rejects(
    () => xTimelineUser.handler({ user: '101', end_time: 'garbage' }, noHttpCtx()),
    isValidation(/end_time is not a recognizable timestamp/),
  );
});

test('x_timeline_mentions: user defaults to "me" and resolves via GET /2/users/me', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<RawSingleResponse<RawUser>>('users/me.json'));
  http.pool
    .intercept({
      path: `/2/users/${ME_ID}/mentions`,
      method: 'GET',
      query: TIMELINE_FIELD_PARAMS,
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-page.json'));

  const out = await xTimelineMentions.handler({}, makeCtx(http));
  const page = out.data as CompactPageResult;

  assert.equal(page.result_count, 3);
  assert.equal(page.next_token, 'abc');

  http.assertDone();
  await http.close();
});

test('REND-8: x_timeline_mentions resolves a @handle via users/by/username', async () => {
  const http = mockHttp();
  http.pool
    .intercept({
      path: '/2/users/by/username/BillGates',
      method: 'GET',
      query: USERS_PROJECTION,
    })
    .reply(200, loadFixture<RawSingleResponse<RawUser>>('users/handle-lookup-hit.json'));
  http.pool
    .intercept({
      path: '/2/users/50393960/mentions',
      method: 'GET',
      query: TIMELINE_FIELD_PARAMS,
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-empty.json'));

  const out = await xTimelineMentions.handler({ user: '@BillGates' }, makeCtx(http));
  const page = out.data as CompactPageResult;

  assert.equal(page.result_count, 0);
  assert.equal(page.note, 'No results matched this query.'); // REND-1

  http.assertDone();
  await http.close();
});

test('REND-8: an unknown handle is not-found and the timeline read is never spent', async () => {
  const http = mockHttp();
  // ONLY the handle lookup is queued: assertDone() proves no timeline request followed.
  http.pool
    .intercept({
      path: '/2/users/by/username/ghost',
      method: 'GET',
      query: USERS_PROJECTION,
    })
    .reply(200, loadFixture<RawSingleResponse<RawUser>>('users/handle-lookup-miss.json'));

  await assert.rejects(
    () => xTimelineMentions.handler({ user: '@ghost' }, makeCtx(http)),
    (err: unknown) => {
      assert.ok(XError.is(err), 'expected an XError');
      assert.equal(err.kind, 'not-found');
      assert.match(err.message, /No X user found for handle "@ghost"/);
      return true;
    },
  );

  http.assertDone();
  await http.close();
});

test('PAGE-1: x_timeline_user sends page_token verbatim as pagination_token with exclude flags', async () => {
  const http = mockHttp();
  // The cursor round-trips verbatim into the v2 `pagination_token` request param, and the
  // two exclude flags collapse into the wire's comma-joined `exclude` value.
  http.pool
    .intercept({
      path: '/2/users/50393960/tweets',
      method: 'GET',
      query: {
        ...TIMELINE_FIELD_PARAMS,
        pagination_token: 'cursor==abc',
        exclude: 'replies,retweets',
      },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-page.json'));

  const out = await xTimelineUser.handler(
    {
      user: '50393960',
      page_token: 'cursor==abc',
      exclude_replies: true,
      exclude_reposts: true,
    },
    makeCtx(http),
  );
  const page = out.data as CompactPageResult;

  assert.equal(page.next_token, 'abc');

  http.assertDone();
  await http.close();
});

test('REND-1/PAGE-4: an empty timeline page carries the zero-results note and no next_token', async () => {
  const http = mockHttp();
  http.pool
    .intercept({
      path: '/2/users/50393960/tweets',
      method: 'GET',
      query: TIMELINE_FIELD_PARAMS,
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-empty.json'));

  const out = await xTimelineUser.handler({ user: '50393960' }, makeCtx(http));
  const page = out.data as CompactPageResult;

  assert.equal(page.result_count, 0);
  assert.equal(page.next_token, undefined);
  assert.equal(page.note, 'No results matched this query.');

  http.assertDone();
  await http.close();
});

test('REND-10: raw:true returns the exact API JSON and caps max_results at 25', async () => {
  const http = mockHttp();
  const fixture = loadFixture<RawListResponse<RawTweet>>('search/recent-page.json');
  // Pins max_results=25 (the raw ceiling), not 100 (requested).
  http.pool
    .intercept({
      path: '/2/users/50393960/tweets',
      method: 'GET',
      query: { ...TIMELINE_FIELD_PARAMS, max_results: '25' },
    })
    .reply(200, fixture);

  const out = await xTimelineUser.handler(
    { user: '50393960', raw: true, max_results: 100 },
    makeCtx(http),
  );

  assert.deepEqual(out.data, fixture); // exact envelope, includes/meta and all
  assert.equal(out.summary, `3 raw result(s). ${UNTRUSTED_CONTENT_NOTE}`); // T-320 F4

  http.assertDone();
  await http.close();
});

test('REND-10: raw without max_results sends no cap; a data-less 200 counts as 0', async () => {
  const http = mockHttp();
  // The intercept carries the field params ONLY — the raw cap applies just when the caller
  // asked for a size. A degraded envelope with no `data` must still summarize (DRIFT-1).
  const envelope = { meta: { result_count: 0 } };
  http.pool
    .intercept({
      path: '/2/users/50393960/tweets',
      method: 'GET',
      query: TIMELINE_FIELD_PARAMS,
    })
    .reply(200, envelope);

  const out = await xTimelineUser.handler({ user: '50393960', raw: true }, makeCtx(http));

  assert.deepEqual(out.data, envelope);
  assert.equal(out.summary, `0 raw result(s). ${UNTRUSTED_CONTENT_NOTE}`);

  http.assertDone();
  await http.close();
});

test('REND-8: a malformed user reference is a validation error before any request', async () => {
  await assert.rejects(
    () => xTimelineUser.handler({ user: 'not a user!!' }, noHttpCtx()),
    isValidation(/Not a recognized X user id/),
  );
});

test('x_timeline_home: a me response without an id maps to a typed api error', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: USERS_PROJECTION })
    .reply(200, {});

  await assert.rejects(
    () => xTimelineHome.handler({}, makeCtx(http)),
    (err: unknown) => {
      assert.ok(XError.is(err), 'expected an XError');
      assert.equal(err.kind, 'api');
      assert.match(err.message, /no user id/);
      return true;
    },
  );

  http.assertDone();
  await http.close();
});
