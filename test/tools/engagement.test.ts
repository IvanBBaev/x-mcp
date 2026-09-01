// Tests for the engagement tools (T-211): the writes x_like_set / x_repost_set /
// x_bookmark_set, plus the own-bookmarks read x_bookmarks_list. Each network test builds a
// REAL http client (api/http) over an undici MockAgent and drives the handler end to end:
// post-ref normalization -> GET /2/users/me (the AUTH-15 "who am I" seam) -> the engagement
// call -> compact output. Interceptors pin exact paths, methods, queries and JSON bodies, so
// they stub AND assert the wire contract.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mapHttpError } from '../../src/api/errors.js';
import { createHttpClient } from '../../src/api/http.js';
import { XError } from '../../src/core/errors.js';
import { UNTRUSTED_CONTENT_NOTE } from '../../src/core/render.js';
import type { RawListResponse, RawTweet } from '../../src/core/render.js';
import type { ToolContext } from '../../src/core/tooldef.js';
import {
  engagementTools,
  xBookmarkSet,
  xBookmarksList,
  xLikeSet,
  xRepostSet,
} from '../../src/tools/engagement.js';

import { loadFixture, makePorts, mockHttp } from '../helpers/index.js';
import type { MockHttp } from '../helpers/index.js';

/** The wrapper shape of the error fixtures under test/fixtures/errors/. */
interface ErrorFixture {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** Build a ToolContext over a real http client bound to the mock dispatcher. */
function contextFor(mock: MockHttp): ToolContext {
  const ports = makePorts({ dispatcher: mock.dispatcher });
  const http = createHttpClient({
    sleep: ports.sleep,
    random: ports.random,
    dispatcher: mock.dispatcher,
    mapError: mapHttpError,
  });
  return { ports, http };
}

/** A context whose invoker fails loudly — proves a handler never reached the network. */
function noHttpCtx(): ToolContext {
  return {
    ports: makePorts(),
    http: {
      send: () => Promise.reject(new Error('endpoint must not be called for invalid input')),
    },
  };
}

/** Queue the `GET /2/users/me` interceptor every engagement write starts with (id "9"). */
function interceptMe(mock: MockHttp): void {
  mock.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: { 'user.fields': 'username,name' } })
    .reply(200, loadFixture<Record<string, unknown>>('auth/me.json'));
}

/** The compaction field params the bookmarks read carries (mirrors api/endpoints/engagement). */
const BOOKMARK_FIELD_PARAMS = {
  'tweet.fields':
    'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id',
  expansions:
    'author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys',
  'user.fields': 'username,name,verified',
  'media.fields': 'type,url,preview_image_url,alt_text',
} as const;

/** The compact page x_bookmarks_list returns (a Page<CompactPost>, narrowed for asserts). */
interface CompactPageResult {
  readonly items: readonly { readonly author: string }[];
  readonly result_count: number;
  readonly next_token?: string;
  readonly note?: string;
}

// --- Contract axes ---------------------------------------------------------------

test('engagementTools exposes the three *_set tools with identical write axes', () => {
  assert.deepEqual(engagementTools, [xLikeSet, xRepostSet, xBookmarkSet, xBookmarksList]);
  assert.equal(xLikeSet.name, 'x_like_set');
  assert.equal(xRepostSet.name, 'x_repost_set');
  assert.equal(xBookmarkSet.name, 'x_bookmark_set');
  for (const tool of [xLikeSet, xRepostSet, xBookmarkSet]) {
    assert.equal(tool.policy, 'write:engagement');
    assert.equal(tool.availability, 'user-only');
    assert.equal(tool.cost, 'w:action');
    assert.equal(tool.phase, 2);
    // Reversible toggles: writes, but neither destructive nor open-ended (docs/03).
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, true);
    assert.equal(tool.annotations.openWorldHint, true);
  }
  assert.deepEqual([...xLikeSet.scopes], ['tweet.read', 'users.read', 'like.write']);
  assert.deepEqual([...xRepostSet.scopes], ['tweet.read', 'users.read', 'tweet.write']);
  assert.deepEqual([...xBookmarkSet.scopes], ['tweet.read', 'users.read', 'bookmark.write']);
});

test('x_bookmarks_list is a user-only OWN-DATA read, not a write (decisions/0002)', () => {
  assert.equal(xBookmarksList.name, 'x_bookmarks_list');
  assert.equal(xBookmarksList.policy, 'read:content');
  assert.equal(xBookmarksList.availability, 'user-only');
  assert.equal(xBookmarksList.cost, 'owned');
  assert.equal(xBookmarksList.phase, 3);
  assert.equal(xBookmarksList.annotations.readOnlyHint, true);
  assert.equal(xBookmarksList.annotations.openWorldHint, true);
  // bookmark.READ, not the bookmark.write the toggle uses: a write-only grant cannot list.
  assert.deepEqual([...xBookmarksList.scopes], ['tweet.read', 'users.read', 'bookmark.read']);
});

// --- x_like_set ------------------------------------------------------------------

test('like: POST /2/users/me-id/likes with the tweet_id body, canonical url out (REND-4)', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/likes', method: 'POST', body: '{"tweet_id":"111"}' })
    .reply(200, { data: { liked: true } });

  const out = await xLikeSet.handler({ post: '111', action: 'like' }, contextFor(mock));
  assert.deepEqual(out.data, {
    post_id: '111',
    url: 'https://x.com/i/status/111',
    action: 'like',
    liked: true,
  });
  assert.equal(out.summary, 'Liked post 111.');
  mock.assertDone();
  await mock.close();
});

test('unlike: DELETE /2/users/me-id/likes/:tweet_id reports liked: false', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/likes/111', method: 'DELETE' })
    .reply(200, { data: { liked: false } });

  const out = await xLikeSet.handler({ post: '111', action: 'unlike' }, contextFor(mock));
  assert.deepEqual(out.data, {
    post_id: '111',
    url: 'https://x.com/i/status/111',
    action: 'unlike',
    liked: false,
  });
  assert.equal(out.summary, 'Unliked post 111.');
  mock.assertDone();
  await mock.close();
});

test('like: a 2xx envelope without data falls back to the requested state (DRIFT-1)', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/likes', method: 'POST', body: '{"tweet_id":"111"}' })
    .reply(200, {});

  const out = await xLikeSet.handler({ post: '111', action: 'like' }, contextFor(mock));
  const data = out.data as { liked: boolean };
  assert.equal(data.liked, true);
  mock.assertDone();
  await mock.close();
});

test('unrepost/remove: the DRIFT-1 fallback reports the requested state for deletes too', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool.intercept({ path: '/2/users/9/retweets/222', method: 'DELETE' }).reply(200, {});
  const repostOut = await xRepostSet.handler({ post: '222', action: 'unrepost' }, contextFor(mock));
  assert.equal((repostOut.data as { reposted: boolean }).reposted, false);

  interceptMe(mock);
  mock.pool.intercept({ path: '/2/users/9/bookmarks/333', method: 'DELETE' }).reply(200, {});
  const bookmarkOut = await xBookmarkSet.handler(
    { post: '333', action: 'remove' },
    contextFor(mock),
  );
  assert.equal((bookmarkOut.data as { bookmarked: boolean }).bookmarked, false);

  mock.assertDone();
  await mock.close();
});

// --- x_repost_set ----------------------------------------------------------------

test('repost: POST /2/users/me-id/retweets maps raw retweeted -> reposted', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/retweets', method: 'POST', body: '{"tweet_id":"222"}' })
    .reply(200, { data: { retweeted: true } });

  const out = await xRepostSet.handler({ post: '222', action: 'repost' }, contextFor(mock));
  assert.deepEqual(out.data, {
    post_id: '222',
    url: 'https://x.com/i/status/222',
    action: 'repost',
    reposted: true,
  });
  assert.equal(out.summary, 'Reposted post 222.');
  mock.assertDone();
  await mock.close();
});

test('unrepost: DELETE /2/users/me-id/retweets/:source_tweet_id reports reposted: false', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/retweets/222', method: 'DELETE' })
    .reply(200, { data: { retweeted: false } });

  const out = await xRepostSet.handler({ post: '222', action: 'unrepost' }, contextFor(mock));
  assert.deepEqual(out.data, {
    post_id: '222',
    url: 'https://x.com/i/status/222',
    action: 'unrepost',
    reposted: false,
  });
  assert.equal(out.summary, 'Removed repost of post 222.');
  mock.assertDone();
  await mock.close();
});

// --- x_bookmark_set --------------------------------------------------------------

test('bookmark add: POST /2/users/me-id/bookmarks with the tweet_id body', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/bookmarks', method: 'POST', body: '{"tweet_id":"333"}' })
    .reply(200, { data: { bookmarked: true } });

  const out = await xBookmarkSet.handler({ post: '333', action: 'add' }, contextFor(mock));
  assert.deepEqual(out.data, {
    post_id: '333',
    url: 'https://x.com/i/status/333',
    action: 'add',
    bookmarked: true,
  });
  assert.equal(out.summary, 'Bookmarked post 333.');
  mock.assertDone();
  await mock.close();
});

test('bookmark remove: DELETE /2/users/me-id/bookmarks/:tweet_id reports bookmarked: false', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/bookmarks/333', method: 'DELETE' })
    .reply(200, { data: { bookmarked: false } });

  const out = await xBookmarkSet.handler({ post: '333', action: 'remove' }, contextFor(mock));
  assert.deepEqual(out.data, {
    post_id: '333',
    url: 'https://x.com/i/status/333',
    action: 'remove',
    bookmarked: false,
  });
  assert.equal(out.summary, 'Removed bookmark from post 333.');
  mock.assertDone();
  await mock.close();
});

// --- Post-ref normalization (REND-8) ----------------------------------------------

test('REND-8: a full status URL normalizes to the numeric id on the wire', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/likes', method: 'POST', body: '{"tweet_id":"444"}' })
    .reply(200, { data: { liked: true } });

  const out = await xLikeSet.handler(
    { post: 'https://x.com/someone/status/444', action: 'like' },
    contextFor(mock),
  );
  const data = out.data as { post_id: string };
  assert.equal(data.post_id, '444');
  mock.assertDone();
  await mock.close();
});

test('REND-8: a handle as the post ref rejects before ANY request (validation)', async () => {
  // The stub invoker rejects loudly, so a passing test proves neither GET /2/users/me
  // nor the write was ever attempted — nothing was spent.
  for (const [tool, action] of [
    [xLikeSet, 'like'],
    [xRepostSet, 'repost'],
    [xBookmarkSet, 'add'],
  ] as const) {
    await assert.rejects(
      () => tool.handler({ post: '@jack', action } as never, noHttpCtx()),
      (err: unknown) => {
        assert.ok(XError.is(err));
        assert.equal(err.kind, 'validation');
        return true;
      },
    );
  }
});

// --- Input schema boundary --------------------------------------------------------

test('input schemas: unknown action, missing post, and extra keys all reject', () => {
  // Wrong action enum value (each tool has its own verb pair).
  assert.equal(xLikeSet.input.safeParse({ post: '1', action: 'unrepost' }).success, false);
  assert.equal(xRepostSet.input.safeParse({ post: '1', action: 'like' }).success, false);
  assert.equal(xBookmarkSet.input.safeParse({ post: '1', action: 'bookmark' }).success, false);

  // Missing / empty post reference.
  assert.equal(xLikeSet.input.safeParse({ action: 'like' }).success, false);
  assert.equal(xLikeSet.input.safeParse({ post: '', action: 'like' }).success, false);

  // .strict(): unknown keys are refused, not silently dropped.
  assert.equal(
    xBookmarkSet.input.safeParse({ post: '1', action: 'add', folder: 'x' }).success,
    false,
  );

  // The happy shapes parse.
  assert.equal(xLikeSet.input.safeParse({ post: '1', action: 'unlike' }).success, true);
  assert.equal(xRepostSet.input.safeParse({ post: '1', action: 'unrepost' }).success, true);
  assert.equal(xBookmarkSet.input.safeParse({ post: '1', action: 'remove' }).success, true);
});

// --- Error mapping ----------------------------------------------------------------

test('unlike of a nonexistent post surfaces a typed not-found error', async () => {
  const fx = loadFixture<ErrorFixture>('errors/404-not-found.json');
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/likes/999', method: 'DELETE' })
    .reply(fx.status, fx.body as Record<string, unknown>, { headers: fx.headers });

  await assert.rejects(
    () => xLikeSet.handler({ post: '999', action: 'unlike' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'not-found');
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

test('like of a suspended target surfaces a typed forbidden error', async () => {
  const fx = loadFixture<ErrorFixture>('errors/403-suspended-target.json');
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/likes', method: 'POST', body: '{"tweet_id":"555"}' })
    .reply(fx.status, fx.body as Record<string, unknown>, { headers: fx.headers });

  await assert.rejects(
    () => xLikeSet.handler({ post: '555', action: 'like' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'forbidden');
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

test('a failing GET /2/users/me aborts BEFORE the write: auth error, no write sent', async () => {
  const fx = loadFixture<ErrorFixture>('errors/401-invalid-token.json');
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: { 'user.fields': 'username,name' } })
    .reply(fx.status, fx.body as Record<string, unknown>, { headers: fx.headers });

  await assert.rejects(
    () => xRepostSet.handler({ post: '222', action: 'repost' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'auth');
      return true;
    },
  );
  // assertDone: the me-interceptor was the ONLY request — no retweets call went out.
  mock.assertDone();
  await mock.close();
});

test('a me-response without an id yields a typed api error and sends no write', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: { 'user.fields': 'username,name' } })
    .reply(200, { data: {} });

  await assert.rejects(
    () => xBookmarkSet.handler({ post: '333', action: 'add' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'api');
      assert.match(err.message, /no user id/);
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

// --- x_bookmarks_list -------------------------------------------------------------

test('bookmarks list: GET /2/users/me-id/bookmarks renders a compact page (REND-6)', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/bookmarks', method: 'GET', query: BOOKMARK_FIELD_PARAMS })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-page.json'));

  const out = await xBookmarksList.handler({}, contextFor(mock));
  const page = out.data as CompactPageResult;

  assert.equal(page.result_count, 3);
  assert.equal(page.next_token, 'abc');
  assert.ok(page.items.every((p) => p.author.startsWith('@')));
  assert.ok(page.note);
  assert.match(page.note, /third-party text/); // REND-6 untrusted-content note
  assert.equal(out.summary, '3 result(s), more available.');

  mock.assertDone();
  await mock.close();
});

test('PAGE-1: page_token rides the wire as pagination_token, next_token comes back', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  // The interceptor pins `pagination_token` — the REQUEST cursor name differs from the
  // RESPONSE cursor (`meta.next_token`), and a match proves the bridge happened.
  mock.pool
    .intercept({
      path: '/2/users/9/bookmarks',
      method: 'GET',
      query: { ...BOOKMARK_FIELD_PARAMS, pagination_token: 'cursor-1' },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-page.json'));

  const out = await xBookmarksList.handler({ page_token: 'cursor-1' }, contextFor(mock));
  assert.equal((out.data as CompactPageResult).next_token, 'abc');

  mock.assertDone();
  await mock.close();
});

test('PAGE-3: max_results is clamped into 1-100 in both directions and noted', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  // Pins max_results=100 (clamped), not 500 (requested): a match proves the clamped value
  // reached the wire, since undici string-compares the full sorted query.
  mock.pool
    .intercept({
      path: '/2/users/9/bookmarks',
      method: 'GET',
      query: { ...BOOKMARK_FIELD_PARAMS, max_results: '100' },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-page.json'));

  const out = await xBookmarksList.handler({ max_results: 500 }, contextFor(mock));
  const page = out.data as CompactPageResult;
  assert.ok(page.note);
  assert.match(page.note, /max_results adjusted to 100/);

  mock.assertDone();
  await mock.close();
});

test('REND-10: raw: true returns the exact envelope with max_results capped at 25', async () => {
  const fixture = loadFixture<RawListResponse<RawTweet>>('search/recent-page.json');
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({
      path: '/2/users/9/bookmarks',
      method: 'GET',
      query: { ...BOOKMARK_FIELD_PARAMS, max_results: '25' },
    })
    .reply(200, fixture);

  const out = await xBookmarksList.handler({ max_results: 100, raw: true }, contextFor(mock));
  assert.deepEqual(out.data, fixture); // exact envelope: includes/meta and all
  assert.match(out.summary ?? '', /raw/i);

  mock.assertDone();
  await mock.close();
});

test('REND-10: raw without max_results sends no cap; a data-less 200 counts as 0', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  // The intercept carries the field params ONLY — the raw cap applies just when the caller
  // asked for a size. A degraded envelope with no `data` must still summarize (DRIFT-1).
  const envelope = { meta: { result_count: 0 } };
  mock.pool
    .intercept({ path: '/2/users/9/bookmarks', method: 'GET', query: BOOKMARK_FIELD_PARAMS })
    .reply(200, envelope);

  const out = await xBookmarksList.handler({ raw: true }, contextFor(mock));

  assert.deepEqual(out.data, envelope);
  assert.equal(out.summary, `0 raw result(s). ${UNTRUSTED_CONTENT_NOTE}`);

  mock.assertDone();
  await mock.close();
});

test('REND-1: an empty last page has no "more available" and carries the zero-results note', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/bookmarks', method: 'GET', query: BOOKMARK_FIELD_PARAMS })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-empty.json'));

  const out = await xBookmarksList.handler({}, contextFor(mock));
  const page = out.data as CompactPageResult;

  assert.equal(page.result_count, 0);
  assert.equal(page.next_token, undefined);
  assert.equal(out.summary, '0 result(s).');

  mock.assertDone();
  await mock.close();
});

test('bookmarks list: input schema rejects unknown keys and non-integer sizes', () => {
  assert.equal(xBookmarksList.input.safeParse({}).success, true);
  assert.equal(xBookmarksList.input.safeParse({ max_results: 10, raw: false }).success, true);
  assert.equal(xBookmarksList.input.safeParse({ max_results: 10.5 }).success, false);
  assert.equal(xBookmarksList.input.safeParse({ user: 'me' }).success, false);
});

test('bookmarks list: a me-response without an id reads NOTHING and says so', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: { 'user.fields': 'username,name' } })
    .reply(200, { data: {} });

  await assert.rejects(
    () => xBookmarksList.handler({}, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'api');
      // The read path states its own consequence — not the write path's wording.
      assert.match(err.message, /bookmarks endpoint cannot be addressed; nothing was read/);
      return true;
    },
  );
  // assertDone: the me-interceptor was the ONLY request — no bookmarks call went out.
  mock.assertDone();
  await mock.close();
});
