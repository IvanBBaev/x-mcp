// Tests for the post read tools (T-121). Each network test builds a REAL http client
// (api/http) wired to an undici MockAgent dispatcher, mirroring test/smoke.test.ts, and
// drives the tool handler end to end: id normalization -> GET /2/tweets -> compaction.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHttpClient } from '../../src/api/http.js';
import { mapHttpError } from '../../src/api/errors.js';
import { xPostGet, postsTools } from '../../src/tools/posts.js';
import type { ToolContext } from '../../src/core/tooldef.js';
import type { BatchResult, CompactPost } from '../../src/core/render-shapes.js';
import type { RawListResponse, RawTweet } from '../../src/core/render.js';

import { makePorts, mockHttp, loadFixture } from '../helpers/index.js';
import type { MockHttp } from '../helpers/index.js';

// The exact field/expansion query the endpoint sends alongside `ids`. Pinned here so the
// interceptor both stubs the call AND asserts the wire contract: undici matches the full
// (sorted) query string, so any drift in the endpoint's fields fails the match loudly.
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

test('registry array exposes x_post_get', () => {
  assert.deepEqual(postsTools, [xPostGet]);
  assert.equal(xPostGet.name, 'x_post_get');
  assert.equal(xPostGet.policy, 'read:content');
  assert.equal(xPostGet.availability, 'app+user');
  assert.equal(xPostGet.cost, 'r:post');
  assert.deepEqual([...xPostGet.scopes], ['tweet.read', 'users.read']);
  assert.equal(xPostGet.annotations.readOnlyHint, true);
  assert.equal(xPostGet.annotations.openWorldHint, true);
});

test('two posts compact to items with @handle authors, metrics, and refs', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'GET', query: queryFor('111,222') })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('posts/two-posts.json'));

  const out = await xPostGet.handler({ ids: ['111', '222'] }, contextFor(mock));
  const batch = out.data as BatchResult<CompactPost>;

  assert.equal(batch.items.length, 2);
  assert.equal(batch.missing, undefined);

  const [first, second] = batch.items;
  assert.ok(first && second);

  // Authors resolved to @handle form (REND-1).
  assert.equal(first.author, '@author_one');
  assert.equal(second.author, '@author_two');

  // Metrics mapped from public_metrics.
  assert.deepEqual(first.metrics, {
    replies: 4,
    reposts: 12,
    likes: 87,
    quotes: 3,
    bookmarks: 9,
    impressions: 5400,
  });

  // Canonical permalink (REND-4) and media compaction on the first post.
  assert.equal(first.url, 'https://x.com/i/status/111');
  assert.deepEqual(first.media, [
    {
      type: 'photo',
      url: 'https://pbs.twimg.com/media/example111.jpg',
      alt_text: 'A screenshot of the server startup logs.',
    },
  ]);

  // Reply + quote refs on the second post, with authors resolved from includes.tweets.
  assert.deepEqual(second.reply_to, { id: '111', author: '@author_one' });
  assert.deepEqual(second.quoted, { id: '333', author: '@author_three' });

  assert.match(out.summary ?? '', /^2 post\(s\)$/);
  mock.assertDone();
  await mock.close();
});

test('partial failure yields one item and one classified missing entry', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'GET', query: queryFor('111,999') })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('posts/partial-missing.json'));

  const out = await xPostGet.handler({ ids: ['111', '999'] }, contextFor(mock));
  const batch = out.data as BatchResult<CompactPost>;

  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0]?.id, '111');
  assert.deepEqual(batch.missing, [{ id: '999', reason: 'not-found' }]);
  assert.match(out.summary ?? '', /1 post\(s\), 1 missing/);

  mock.assertDone();
  await mock.close();
});

test('status URLs are accepted and normalized to numeric ids', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'GET', query: queryFor('111,222') })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('posts/two-posts.json'));

  // A bare id and a full status URL both normalize to the numeric id on the wire.
  const out = await xPostGet.handler(
    { ids: ['111', 'https://x.com/author_two/status/222'] },
    contextFor(mock),
  );
  const batch = out.data as BatchResult<CompactPost>;
  assert.equal(batch.items.length, 2);

  mock.assertDone();
  await mock.close();
});

test('a handle passed as an id rejects before any request', async () => {
  // parsePostId throws a validation error for a handle; no http call is reached, so a
  // stub invoker that would fail loudly proves the handler never touched the network.
  const ctx: ToolContext = {
    ports: makePorts(),
    http: {
      send: () => Promise.reject(new Error('endpoint must not be called for a bad reference')),
    },
  };
  await assert.rejects(() => xPostGet.handler({ ids: ['@jack'] }, ctx));
});

test('raw: true returns the uncompacted, size-capped envelope', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'GET', query: queryFor('111,222') })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('posts/two-posts.json'));

  const out = await xPostGet.handler({ ids: ['111', '222'], raw: true }, contextFor(mock));
  const raw = out.data as RawListResponse<RawTweet>;

  // Uncompacted: raw field names survive (author_id, public_metrics), includes preserved.
  assert.equal(raw.data?.length, 2);
  assert.equal(raw.data?.[0]?.author_id, '11');
  assert.ok(raw.data?.[0]?.public_metrics);
  assert.ok(raw.includes?.users);
  assert.match(out.summary ?? '', /^2 raw post\(s\)$/);

  mock.assertDone();
  await mock.close();
});

test('a long-form post recovers its full body into note_tweet and marks truncated', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'GET', query: queryFor('444') })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('posts/long-note.json'));

  const out = await xPostGet.handler({ ids: ['444'] }, contextFor(mock));
  const batch = out.data as BatchResult<CompactPost>;

  const post = batch.items[0];
  assert.ok(post);
  assert.equal(post.truncated, true);
  assert.ok(post.note_tweet && post.note_tweet.length > post.text.length);
  assert.match(post.note_tweet, /full body lives in note_tweet/);

  mock.assertDone();
  await mock.close();
});
