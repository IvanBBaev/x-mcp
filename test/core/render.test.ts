// Unit tests for the compactors (T-117, core/render). Test ids follow docs/07 §11 (the
// authoritative REND-* numbering). Raw JSON samples are inlined; invisible characters are
// built with String.fromCharCode so this source stays pure ASCII.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderPost,
  renderUser,
  renderDm,
  renderList,
  renderPosts,
  renderPostPage,
  renderUserPage,
  capRawMaxResults,
  toIso,
  RAW_MAX_RESULTS,
} from '../../src/core/render.js';
import { ZERO_RESULTS_NOTE } from '../../src/core/render-shapes.js';

test('REND-1: empty result set renders result_count 0 with the zero-results note', () => {
  const page = renderPostPage({ meta: { result_count: 0 } });
  assert.deepEqual(page, { items: [], result_count: 0, note: ZERO_RESULTS_NOTE });
});

test('REND-2: partial failures surface as missing[] with a controlled reason', () => {
  const out = renderPosts({
    data: [{ id: '1', text: 'ok', author_id: 'u1' }],
    includes: { users: [{ id: 'u1', username: 'alice' }] },
    errors: [
      {
        title: 'Not Found Error',
        type: 'https://api.twitter.com/2/problems/resource-not-found',
        resource_id: '2',
        detail: 'Could not find tweet with id: [2].',
      },
      { title: 'Forbidden', resource_id: '3' },
    ],
  });
  assert.equal(out.items.length, 1);
  assert.deepEqual(out.missing, [
    { id: '2', reason: 'not-found' },
    { id: '3', reason: 'protected' },
  ]);
});

test('REND-7: third-party error detail text never leaks into the mapped result', () => {
  const out = renderPosts({
    data: [],
    errors: [{ title: 'Not Found Error', resource_id: '2', detail: 'secret content: hunter2' }],
  });
  assert.equal(JSON.stringify(out).includes('hunter2'), false);
  assert.equal(JSON.stringify(out).includes('secret content'), false);
});

test('REND-3: long-form posts expose the full body via note_tweet and set truncated', () => {
  const post = renderPost(
    {
      id: '10',
      author_id: 'u1',
      text: 'short display text...',
      note_tweet: { text: 'the complete long body that exceeds the classic limit' },
    },
    { users: [{ id: 'u1', username: 'bob' }] },
  );
  assert.equal(post.note_tweet, 'the complete long body that exceeds the classic limit');
  assert.equal(post.truncated, true);
  assert.equal(post.text, 'short display text...');
});

test('REND-3: reposts join the referenced full text; unrecoverable sets truncated only', () => {
  const recovered = renderPost(
    {
      id: '20',
      author_id: 'u1',
      text: 'RT @orig: clipped...',
      referenced_tweets: [{ type: 'retweeted', id: '99' }],
    },
    {
      users: [{ id: 'u1', username: 'bob' }],
      tweets: [{ id: '99', author_id: 'u2', text: 'full original text' }],
    },
  );
  assert.equal(recovered.note_tweet, 'full original text');
  assert.equal(recovered.truncated, true);

  const unrecoverable = renderPost({
    id: '21',
    author_id: 'u1',
    text: 'RT @orig: clipped...',
    referenced_tweets: [{ type: 'retweeted', id: 'gone' }],
  });
  assert.equal(unrecoverable.truncated, true);
  assert.equal(unrecoverable.note_tweet, undefined);
});

test('REND-4: every rendered post carries the canonical status permalink', () => {
  const post = renderPost(
    { id: '12345', author_id: 'u1' },
    { users: [{ id: 'u1', username: 'a' }] },
  );
  assert.equal(post.url, 'https://x.com/i/status/12345');
});

test('REND-5: missing author expansion degrades to the numeric id, never crashes', () => {
  const post = renderPost({ id: '1', author_id: '9876', text: 'hi' }); // no includes at all
  assert.equal(post.author, '9876');
  assert.equal(post.text, 'hi');
  assert.equal(post.url, 'https://x.com/i/status/1');
});

test('REND-5: an unknown media type is dropped without dropping the whole post', () => {
  const post = renderPost(
    { id: '1', author_id: 'u1', attachments: { media_keys: ['k1', 'k2'] } },
    {
      users: [{ id: 'u1', username: 'a' }],
      media: [
        { media_key: 'k1', type: 'photo', url: 'https://pic.example/1.jpg' },
        { media_key: 'k2', type: 'some_new_type' },
      ],
    },
  );
  assert.equal(post.media?.length, 1);
  assert.equal(post.media?.[0]?.type, 'photo');
  assert.equal(post.media?.[0]?.url, 'https://pic.example/1.jpg');
});

test('REND-6: third-party text is sanitized in-shape and non-empty pages carry the untrusted note', () => {
  const zwsp = String.fromCharCode(0x200b);
  const page = renderPostPage({
    data: [{ id: '1', author_id: 'u1', text: `he${zwsp}llo` }],
    includes: { users: [{ id: 'u1', username: 'a' }] },
    meta: { next_token: 'NT' },
  });
  assert.equal(page.items[0]?.text, 'hello');
  assert.equal(page.result_count, 1);
  assert.equal(page.next_token, 'NT');
  assert.ok(page.note?.includes('third-party text'));
});

test('REND-9: timestamps normalise to ISO-8601 UTC', () => {
  const post = renderPost(
    { id: '1', author_id: 'u1', created_at: '2021-03-04T12:34:56.000Z' },
    { users: [{ id: 'u1', username: 'a' }] },
  );
  assert.equal(post.created_at, '2021-03-04T12:34:56.000Z');
  assert.equal(toIso(0), '1970-01-01T00:00:00.000Z');
  assert.equal(toIso('not-a-date'), undefined);
  assert.equal(toIso(undefined), undefined);
});

test('REND-10: raw:true max_results is capped at 25', () => {
  assert.equal(capRawMaxResults(100), 25);
  assert.equal(capRawMaxResults(25), 25);
  assert.equal(capRawMaxResults(10), 10);
  assert.equal(capRawMaxResults(0), 1);
  assert.equal(RAW_MAX_RESULTS, 25);
});

test('renderPost maps public_metrics into the compact metrics shape', () => {
  const post = renderPost(
    {
      id: '1',
      author_id: 'u1',
      public_metrics: {
        reply_count: 1,
        retweet_count: 2,
        like_count: 3,
        quote_count: 4,
        bookmark_count: 5,
        impression_count: 6,
      },
    },
    { users: [{ id: 'u1', username: 'a' }] },
  );
  assert.deepEqual(post.metrics, {
    replies: 1,
    reposts: 2,
    likes: 3,
    quotes: 4,
    bookmarks: 5,
    impressions: 6,
  });
});

test('renderUser resolves @handle, maps metrics, and omits absent optionals', () => {
  const user = renderUser({
    id: 'u1',
    username: '@Alice',
    name: 'Alice',
    public_metrics: { followers_count: 10, following_count: 5, tweet_count: 100, listed_count: 2 },
  });
  assert.equal(user.handle, '@Alice');
  assert.equal(user.name, 'Alice');
  assert.deepEqual(user.metrics, { followers: 10, following: 5, posts: 100, listed: 2 });
  assert.equal(Object.hasOwn(user, 'description'), false);
  assert.equal(Object.hasOwn(user, 'verified'), false);
});

test('renderDm resolves sender handle and conversation/created fields', () => {
  const dm = renderDm(
    {
      id: 'd1',
      sender_id: 'u1',
      text: 'hey',
      dm_conversation_id: 'c1',
      created_at: '2022-01-01T00:00:00.000Z',
    },
    { users: [{ id: 'u1', username: 'sender' }] },
  );
  assert.equal(dm.sender, '@sender');
  assert.equal(dm.text, 'hey');
  assert.equal(dm.conversation_id, 'c1');
  assert.equal(dm.created_at, '2022-01-01T00:00:00.000Z');
});

test('renderList omits owner when the expansion is unresolvable (REND-5)', () => {
  const list = renderList({ id: 'l1', name: 'My List', owner_id: 'u9' }); // no includes
  assert.equal(list.name, 'My List');
  assert.equal(Object.hasOwn(list, 'owner'), false);
});

test('a page omits next_token on the last page', () => {
  const page = renderUserPage({ data: [{ id: 'u1', username: 'a' }], meta: { result_count: 1 } });
  assert.equal(Object.hasOwn(page, 'next_token'), false);
  assert.equal(page.result_count, 1);
});
