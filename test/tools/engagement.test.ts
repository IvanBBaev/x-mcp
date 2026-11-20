// Tests for the engagement tools (T-211): the writes x_like_set / x_repost_set /
// x_bookmark_set, the own-bookmarks read x_bookmarks_list, and the bookmark-folder tools
// (Q10, docs/07 BKF): x_bookmark_folders_list / x_bookmark_folder_posts /
// x_bookmark_folder_create. Each network test builds a
// REAL http client (api/http) over an undici MockAgent and drives the handler end to end:
// post-ref normalization -> GET /2/users/me (the AUTH-15 "who am I" seam) -> the engagement
// call -> compact output. Interceptors pin exact paths, methods, queries and JSON bodies, so
// they stub AND assert the wire contract.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mapHttpError } from '../../src/api/errors.js';
import { createHttpClient } from '../../src/api/http.js';
import {
  BOOKMARK_USD,
  INTERACTION_DELETE_USD,
  USER_INTERACTION_CREATE_USD,
} from '../../src/core/budget.js';
import { XError, apiError } from '../../src/core/errors.js';
import { createRegistry } from '../../src/core/registry.js';
import type { Registry } from '../../src/core/registry.js';
import { UNTRUSTED_CONTENT_NOTE } from '../../src/core/render.js';
import type { RawListResponse, RawTweet } from '../../src/core/render.js';
import type { AnyToolDef, ToolContext } from '../../src/core/tooldef.js';
import {
  engagementTools,
  xBookmarkFolderCreate,
  xBookmarkFolderPosts,
  xBookmarkFoldersList,
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
    'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id,paid_partnership',
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
  assert.deepEqual(engagementTools, [
    xLikeSet,
    xRepostSet,
    xBookmarkSet,
    xBookmarksList,
    xBookmarkFoldersList,
    xBookmarkFolderPosts,
    xBookmarkFolderCreate,
  ]);
  assert.equal(xLikeSet.name, 'x_like_set');
  assert.equal(xRepostSet.name, 'x_repost_set');
  assert.equal(xBookmarkSet.name, 'x_bookmark_set');
  for (const tool of [xLikeSet, xRepostSet, xBookmarkSet]) {
    assert.equal(tool.policy, 'write:engagement');
    assert.equal(tool.availability, 'user-only');
    // Each *_set tool prices its own operation via a resolver, not a flat class (docs/01 App. B).
    assert.equal(typeof tool.cost, 'function');
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

test('x_like_set / x_repost_set / x_bookmark_set price each direction per docs/01 App. B', () => {
  const likeCost = xLikeSet.cost;
  assert.ok(typeof likeCost === 'function', 'x_like_set cost must be a resolver');
  assert.deepEqual(likeCost({ post: '1', action: 'like' }), {
    class: 'w:action',
    usd: USER_INTERACTION_CREATE_USD,
  });
  assert.deepEqual(likeCost({ post: '1', action: 'unlike' }), {
    class: 'w:action',
    usd: INTERACTION_DELETE_USD,
  });

  const repostCost = xRepostSet.cost;
  assert.ok(typeof repostCost === 'function', 'x_repost_set cost must be a resolver');
  assert.deepEqual(repostCost({ post: '1', action: 'repost' }), {
    class: 'w:action',
    usd: USER_INTERACTION_CREATE_USD,
  });
  assert.deepEqual(repostCost({ post: '1', action: 'unrepost' }), {
    class: 'w:action',
    usd: INTERACTION_DELETE_USD,
  });

  // Bookmark is flat-rate both directions.
  const bookmarkCost = xBookmarkSet.cost;
  assert.ok(typeof bookmarkCost === 'function', 'x_bookmark_set cost must be a resolver');
  assert.deepEqual(bookmarkCost({ post: '1', action: 'add' }), {
    class: 'w:action',
    usd: BOOKMARK_USD,
  });
  assert.deepEqual(bookmarkCost({ post: '1', action: 'remove' }), {
    class: 'w:action',
    usd: BOOKMARK_USD,
  });
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
      // F-5: the class is kept, the likely self-serve removal is named.
      assert.match(err.message, /likes via the API were removed from all self-serve tiers/);
      assert.equal(err.retryable, false);
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

test('F-5: an unlike refused with 403 carries the self-serve note; a 404 does not', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/likes/555', method: 'DELETE' })
    .reply(403, { title: 'Forbidden', detail: 'You are not permitted to perform this action.' });
  await assert.rejects(
    () => xLikeSet.handler({ post: '555', action: 'unlike' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'forbidden');
      assert.match(err.message, /likes via the API were removed from all self-serve tiers/);
      return true;
    },
  );

  const fx = loadFixture<ErrorFixture>('errors/404-not-found.json');
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/likes/555', method: 'DELETE' })
    .reply(fx.status, fx.body as Record<string, unknown>, { headers: fx.headers });
  await assert.rejects(
    () => xLikeSet.handler({ post: '555', action: 'unlike' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.notEqual(err.kind, 'forbidden');
      assert.doesNotMatch(err.message, /self-serve/);
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
  assert.equal(out.units, 3); // COST-3: billed per bookmarked post returned
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

test('REND-10: raw without max_results sends the raw default (10); a data-less 200 counts as 0', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  // Bookmarks default to 100 per page at X; a raw read with no size must send the raw
  // default instead. A degraded envelope with no `data` must still summarize (DRIFT-1).
  const envelope = { meta: { result_count: 0 } };
  mock.pool
    .intercept({
      path: '/2/users/9/bookmarks',
      method: 'GET',
      query: { ...BOOKMARK_FIELD_PARAMS, max_results: '10' },
    })
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

// --- Bookmark folders (Q10, docs/07 BKF) ------------------------------------------

/**
 * A registry with permissive gates that counts budget checks (pipeline step 4), so a test
 * can prove a local refusal happens at schema validation (step 1) and is never charged.
 * Mirrors `test/tools/lists.test.ts`'s helper of the same name.
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

/** The compact folder page x_bookmark_folders_list returns (narrowed for asserts). */
interface FolderPageResult {
  readonly items: readonly { readonly id: string; readonly name: string }[];
  readonly result_count: number;
  readonly next_token?: string;
  readonly note?: string;
}

/** The compact id page x_bookmark_folder_posts returns (narrowed for asserts). */
interface FolderPostsPageResult {
  readonly items: readonly { readonly id: string; readonly url: string }[];
  readonly result_count: number;
  readonly next_token?: string;
  readonly note?: string;
}

const FOLDER_ID = '1146654567674912769';
const FOLDER_POSTS_PATH = `/2/users/9/bookmarks/folders/${FOLDER_ID}`;

test('bookmark folder tools declare their axes: two read:content reads, one engagement write', () => {
  assert.equal(xBookmarkFoldersList.name, 'x_bookmark_folders_list');
  assert.equal(xBookmarkFolderPosts.name, 'x_bookmark_folder_posts');
  assert.equal(xBookmarkFolderCreate.name, 'x_bookmark_folder_create');
  for (const tool of [xBookmarkFoldersList, xBookmarkFolderPosts]) {
    assert.equal(tool.policy, 'read:content');
    assert.equal(tool.availability, 'user-only');
    assert.equal(tool.phase, 3);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.openWorldHint, true);
    assert.match(tool.description, /^X \(Twitter\): /);
  }
  // Existing bookmark scopes only (OD-7): no new scope for the folder surface.
  assert.deepEqual([...xBookmarkFoldersList.scopes], ['users.read', 'bookmark.read']);
  assert.deepEqual([...xBookmarkFolderPosts.scopes], ['tweet.read', 'users.read', 'bookmark.read']);
  assert.equal(xBookmarkFolderCreate.policy, 'write:engagement');
  assert.equal(xBookmarkFolderCreate.availability, 'user-only');
  assert.equal(xBookmarkFolderCreate.phase, 3);
  assert.deepEqual([...xBookmarkFolderCreate.scopes], ['users.read', 'bookmark.write']);
  assert.equal(xBookmarkFolderCreate.annotations.readOnlyHint, false);
  assert.equal(xBookmarkFolderCreate.annotations.destructiveHint, false);
  // A second create with the same name makes a second folder: not idempotent.
  assert.equal(xBookmarkFolderCreate.annotations.idempotentHint, false);
  assert.equal(xBookmarkFolderCreate.annotations.openWorldHint, true);
});

test('BKF-6: unpublished folder pricing is billed conservatively, never as owned', () => {
  // No pricing row for any folder endpoint (fetched 2026-11-20): the reads take the
  // per-resource read rates instead of `owned`, the create takes the "Bookmark" write rate.
  assert.equal(xBookmarkFoldersList.cost, 'r:list');
  assert.equal(xBookmarkFolderPosts.cost, 'r:post');
  const createCost = xBookmarkFolderCreate.cost;
  assert.ok(typeof createCost === 'function', 'x_bookmark_folder_create cost must be a resolver');
  assert.deepEqual(createCost({ name: 'Reading list' }), { class: 'w:action', usd: BOOKMARK_USD });
});

test('BKF-4: folders list renders sanitized names with the untrusted-content note', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/bookmarks/folders', method: 'GET', query: {} })
    .reply(200, loadFixture<Record<string, unknown>>('bookmarks/folders.json'));

  const out = await xBookmarkFoldersList.handler({}, contextFor(mock));
  const page = out.data as FolderPageResult;

  assert.equal(page.result_count, 2);
  assert.equal(out.units, 2); // COST-3: billed per folder returned
  assert.deepEqual(page.items[0], { id: '1146654567674912769', name: 'Reading list' });
  assert.equal(page.items[1]?.id, '1146654567674912770');
  // The bidi override and the zero-width space are stripped from the user-chosen name.
  assert.equal(page.items[1]?.name, 'AI agents');
  assert.doesNotMatch(page.items[1]?.name ?? '', /[\u202e\u200b]/);
  assert.ok(page.note);
  assert.match(page.note, /third-party text/);
  // BKF-2: the folder reads document no meta — no meta is the final page, not an error.
  assert.equal(page.next_token, undefined);
  assert.equal(out.summary, '2 result(s).');

  mock.assertDone();
  await mock.close();
});

test('BKF-2: a folder page with meta.next_token passes the cursor through', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/bookmarks/folders', method: 'GET', query: {} })
    .reply(200, {
      data: [{ id: '1146654567674912769', name: 'Reading list' }],
      meta: { result_count: 1, next_token: 'folders-2' },
    });

  const out = await xBookmarkFoldersList.handler({}, contextFor(mock));
  assert.equal((out.data as FolderPageResult).next_token, 'folders-2');
  assert.equal(out.summary, '1 result(s), more available.');

  mock.assertDone();
  await mock.close();
});

test('folders list: PAGE-1 cursor bridge and PAGE-3 clamp reach the wire', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({
      path: '/2/users/9/bookmarks/folders',
      method: 'GET',
      query: { max_results: '100', pagination_token: 'folders-2' },
    })
    .reply(200, loadFixture<Record<string, unknown>>('bookmarks/folders.json'));

  const out = await xBookmarkFoldersList.handler(
    { max_results: 500, page_token: 'folders-2' },
    contextFor(mock),
  );
  const page = out.data as FolderPageResult;
  assert.ok(page.note);
  assert.match(page.note, /max_results adjusted to 100/);

  mock.assertDone();
  await mock.close();
});

test('folders list: REND-10 raw returns the exact envelope with max_results capped at 25', async () => {
  const fixture = loadFixture<Record<string, unknown>>('bookmarks/folders.json');
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({
      path: '/2/users/9/bookmarks/folders',
      method: 'GET',
      query: { max_results: '25' },
    })
    .reply(200, fixture);

  const out = await xBookmarkFoldersList.handler({ max_results: 100, raw: true }, contextFor(mock));
  assert.deepEqual(out.data, fixture);
  assert.equal(out.units, 2);
  assert.match(out.summary ?? '', /raw/i);

  mock.assertDone();
  await mock.close();
});

test('folders list: entries without an id are dropped; a data-less 200 is an empty page', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/bookmarks/folders', method: 'GET', query: {} })
    .reply(200, { data: [{ name: 'orphan' }, { id: '7', name: 'Kept' }] });
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/bookmarks/folders', method: 'GET', query: {} })
    .reply(200, {});

  const first = await xBookmarkFoldersList.handler({}, contextFor(mock));
  assert.deepEqual((first.data as FolderPageResult).items, [{ id: '7', name: 'Kept' }]);
  // Billing follows what X sent, not what rendering kept (COST-3).
  assert.equal(first.units, 2);

  const second = await xBookmarkFoldersList.handler({}, contextFor(mock));
  assert.equal((second.data as FolderPageResult).result_count, 0);
  assert.equal(second.units, 0);

  mock.assertDone();
  await mock.close();
});

test('BKF-1: folder posts are ids only, rendered as {id, url} without an untrusted note', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: FOLDER_POSTS_PATH, method: 'GET', query: {} })
    .reply(200, loadFixture<Record<string, unknown>>('bookmarks/folder-posts.json'));

  const out = await xBookmarkFolderPosts.handler({ folder_id: FOLDER_ID }, contextFor(mock));
  const page = out.data as FolderPostsPageResult;

  assert.equal(page.result_count, 3);
  assert.equal(out.units, 3);
  assert.deepEqual(page.items[0], {
    id: '1460323737035677698',
    url: 'https://x.com/i/status/1460323737035677698',
  });
  assert.ok(page.items.every((item) => Object.keys(item).length === 2));
  // Ids carry no third-party text, so the REND-6 note does not apply.
  assert.doesNotMatch(page.note ?? '', /third-party text/);
  assert.equal(page.next_token, undefined); // BKF-2
  assert.equal(out.summary, '3 result(s).');

  mock.assertDone();
  await mock.close();
});

test('folder posts: PAGE-1 / PAGE-3 reach the wire on the folder route', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({
      path: FOLDER_POSTS_PATH,
      method: 'GET',
      query: { max_results: '1', pagination_token: 'p-2' },
    })
    .reply(200, {
      data: [{ id: '1460323737035677698' }],
      meta: { result_count: 1, next_token: 'p-3' },
    });

  const out = await xBookmarkFolderPosts.handler(
    { folder_id: FOLDER_ID, max_results: 0, page_token: 'p-2' },
    contextFor(mock),
  );
  const page = out.data as FolderPostsPageResult;
  assert.equal(page.next_token, 'p-3');
  assert.ok(page.note);
  assert.match(page.note, /max_results adjusted to 1/);

  mock.assertDone();
  await mock.close();
});

test('folder posts: raw returns the exact envelope', async () => {
  const fixture = loadFixture<Record<string, unknown>>('bookmarks/folder-posts.json');
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: FOLDER_POSTS_PATH, method: 'GET', query: { max_results: '10' } })
    .reply(200, fixture);

  const out = await xBookmarkFolderPosts.handler(
    { folder_id: FOLDER_ID, raw: true },
    contextFor(mock),
  );
  assert.deepEqual(out.data, fixture);
  assert.equal(out.units, 3);

  mock.assertDone();
  await mock.close();
});

test('BKF-3: a malformed folder_id is refused in the schema, before any charge', async () => {
  const { reg, budgetChecks } = chargeCountingRegistry(xBookmarkFolderPosts);
  for (const folderId of ['', 'abc', '12a', '-1', '1'.repeat(20), ' 123', '../9']) {
    await assert.rejects(
      () => reg.call('x_bookmark_folder_posts', { folder_id: folderId }, noHttpCtx()),
      (err: unknown) => {
        assert.ok(XError.is(err), `folder_id ${JSON.stringify(folderId)} must be refused`);
        assert.equal(err.kind, 'validation');
        return true;
      },
    );
  }
  await assert.rejects(
    () => reg.call('x_bookmark_folder_posts', {}, noHttpCtx()),
    (err: unknown) => XError.is(err) && err.kind === 'validation',
  );
  assert.equal(budgetChecks(), 0);
  assert.equal(xBookmarkFolderPosts.input.safeParse({ folder_id: '1'.repeat(19) }).success, true);
});

test('BKF-3: an empty, blank or over-long folder name is refused before any charge', async () => {
  const { reg, budgetChecks } = chargeCountingRegistry(xBookmarkFolderCreate);
  for (const name of ['', '   ', '\t\n', 'x'.repeat(26)]) {
    await assert.rejects(
      () => reg.call('x_bookmark_folder_create', { name }, noHttpCtx()),
      (err: unknown) => {
        assert.ok(XError.is(err), `name ${JSON.stringify(name)} must be refused`);
        assert.equal(err.kind, 'validation');
        return true;
      },
    );
  }
  await assert.rejects(
    () => reg.call('x_bookmark_folder_create', { name: 'ok', extra: 1 }, noHttpCtx()),
    (err: unknown) => XError.is(err) && err.kind === 'validation',
  );
  assert.equal(budgetChecks(), 0);
  assert.equal(xBookmarkFolderCreate.input.safeParse({ name: 'x'.repeat(25) }).success, true);
});

test('folder reads: input schemas reject unknown keys and non-integer sizes', () => {
  assert.equal(xBookmarkFoldersList.input.safeParse({}).success, true);
  assert.equal(xBookmarkFoldersList.input.safeParse({ max_results: 10.5 }).success, false);
  assert.equal(xBookmarkFoldersList.input.safeParse({ user: 'me' }).success, false);
  assert.equal(
    xBookmarkFolderPosts.input.safeParse({ folder_id: FOLDER_ID, fields: 'x' }).success,
    false,
  );
});

test('folder create: POST /2/users/:id/bookmarks/folders sends {name} and returns the id', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({
      path: '/2/users/9/bookmarks/folders',
      method: 'POST',
      body: JSON.stringify({ name: 'Reading list' }),
    })
    .reply(201, loadFixture<Record<string, unknown>>('bookmarks/folder-create.json'));

  const out = await xBookmarkFolderCreate.handler({ name: 'Reading list' }, contextFor(mock));
  assert.deepEqual(out.data, { folder_id: '1146654567674912771', name: 'Reading list' });
  assert.equal(out.summary, 'Created bookmark folder "Reading list" (id 1146654567674912771).');

  mock.assertDone();
  await mock.close();
});

test('BKF-5: a 201 without data still reports the requested name (DRIFT-1)', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({
      path: '/2/users/9/bookmarks/folders',
      method: 'POST',
      body: JSON.stringify({ name: 'Later\u200b' }),
    })
    .reply(201, {});

  const out = await xBookmarkFolderCreate.handler({ name: 'Later\u200b' }, contextFor(mock));
  // The echoed name is sanitized like any other text the planner reads.
  assert.deepEqual(out.data, { folder_id: '', name: 'Later' });
  assert.equal(out.summary, 'Created bookmark folder "Later".');

  mock.assertDone();
  await mock.close();
});

test('bookmark folder tools: a me-response without an id addresses no folder endpoint', async () => {
  const cases = [
    {
      run: (ctx: ToolContext) => xBookmarkFoldersList.handler({}, ctx),
      message: /bookmark folders endpoint cannot be addressed; nothing was read/,
    },
    {
      run: (ctx: ToolContext) => xBookmarkFolderPosts.handler({ folder_id: FOLDER_ID }, ctx),
      message: /bookmark folder endpoint cannot be addressed; nothing was read/,
    },
    {
      run: (ctx: ToolContext) => xBookmarkFolderCreate.handler({ name: 'Reading list' }, ctx),
      message: /bookmark folders endpoint cannot be addressed; the folder was not created/,
    },
  ];
  for (const { run, message } of cases) {
    const mock = mockHttp();
    mock.pool
      .intercept({ path: '/2/users/me', method: 'GET', query: { 'user.fields': 'username,name' } })
      .reply(200, { data: {} });
    await assert.rejects(
      () => run(contextFor(mock)),
      (err: unknown) => {
        assert.ok(XError.is(err));
        assert.equal(err.kind, 'api');
        assert.match(err.message, message);
        return true;
      },
    );
    // assertDone: the me-interceptor was the ONLY request.
    mock.assertDone();
    await mock.close();
  }
});
