// Tests for the post read tools (T-121) and write tools (T-210). Each network test
// builds a REAL http client (api/http) wired to an undici MockAgent dispatcher, mirroring
// test/smoke.test.ts, and drives the tool handler end to end: id normalization ->
// /2/tweets -> compaction (reads) or write-specific error meaning (writes).

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHttpClient } from '../../src/api/http.js';
import { mapHttpError } from '../../src/api/errors.js';
import {
  xPostGet,
  xPostCreate,
  xPostDelete,
  xPostHideReply,
  postsTools,
} from '../../src/tools/posts.js';
import { XError } from '../../src/core/errors.js';
import type { ErrorClass } from '../../src/core/errors.js';
import type { ToolContext } from '../../src/core/tooldef.js';
import type { BatchResult, CompactPost } from '../../src/core/render-shapes.js';
import { UNTRUSTED_CONTENT_NOTE } from '../../src/core/render.js';
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

test('registry array exposes the post tools', () => {
  assert.deepEqual(postsTools, [xPostGet, xPostCreate, xPostDelete, xPostHideReply]);
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
  // `raw` skips sanitization, so it must NOT skip the REND-6 warning too (T-320 F4).
  assert.equal(out.summary, `2 raw post(s) ${UNTRUSTED_CONTENT_NOTE}`);

  mock.assertDone();
  await mock.close();
});

test('POST-8: 101 ids fail input validation before any HTTP; 100 ids pass', () => {
  // The registry runs `tool.input` validation before the handler, so the limit is
  // exercised at the schema boundary — no context (and no network) is ever built.
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => String(i + 1));

  const rejected = xPostGet.input.safeParse({ ids: ids(101) });
  assert.equal(rejected.success, false);
  if (!rejected.success) {
    // The failure must legibly name the 100-id ceiling.
    assert.match(rejected.error.issues[0]?.message ?? '', /100/);
  }

  assert.equal(xPostGet.input.safeParse({ ids: ids(100) }).success, true);
});

test('POST-8: duplicate references collapse to one id on the wire', async () => {
  const mock = mockHttp();
  // The interceptor pins ids=111,222 — undici string-compares the full sorted query, so a
  // match proves the duplicate (a status URL of an already-listed id) was de-duplicated
  // before the request was sent.
  mock.pool
    .intercept({ path: '/2/tweets', method: 'GET', query: queryFor('111,222') })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('posts/two-posts.json'));

  const out = await xPostGet.handler(
    { ids: ['111', 'https://x.com/author_one/status/111', '222'] },
    contextFor(mock),
  );
  const batch = out.data as BatchResult<CompactPost>;
  assert.equal(batch.items.length, 2);

  mock.assertDone();
  await mock.close();
});

test('POST-8: a single id still goes through the batch endpoint in one request', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'GET', query: queryFor('444') })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('posts/long-note.json'));

  const out = await xPostGet.handler({ ids: ['444'] }, contextFor(mock));
  const batch = out.data as BatchResult<CompactPost>;
  assert.equal(batch.items.length, 1);

  // assertDone proves exactly the one pending interceptor was consumed — one request.
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

// ---------------------------------------------------------------------------------------
// Write tools (T-210): x_post_create / x_post_delete.
// ---------------------------------------------------------------------------------------

/** A ToolContext whose invoker fails loudly — proves a code path never reached HTTP. */
function noHttpCtx(): ToolContext {
  return {
    ports: makePorts(),
    http: {
      send: () => Promise.reject(new Error('endpoint must not be called before validation passes')),
    },
  };
}

/**
 * Capture the raw JSON request body a POST interceptor receives, while matching any
 * body. Lets a test pin the exact wire body (undici hands the matcher the buffered
 * body string for a string-bodied fetch).
 */
function captureBody(): { matcher: (raw: unknown) => boolean; get: () => string } {
  let captured: string | undefined;
  return {
    matcher: (raw: unknown) => {
      captured = typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf8');
      return true;
    },
    get: () => {
      assert.ok(captured !== undefined, 'request body was never captured');
      return captured;
    },
  };
}

/** assert.rejects predicate: the rejection is an XError of `kind` whose message matches. */
function xErrorOf(kind: ErrorClass, pattern: RegExp): (err: unknown) => boolean {
  return (err: unknown): boolean => {
    assert.ok(XError.is(err), 'expected an XError');
    assert.equal(err.kind, kind);
    assert.match(err.message, pattern);
    return true;
  };
}

/** Resolve x_post_create's per-call cost — the tool declares a resolver, not a class. */
function createCostFor(text: string): { class: string; usd?: number } {
  const spec = xPostCreate.cost;
  assert.ok(typeof spec === 'function', 'x_post_create cost must be an input-dependent resolver');
  return spec({ text });
}

test('x_post_create / x_post_delete declare the docs/03 axes', () => {
  assert.equal(xPostCreate.name, 'x_post_create');
  assert.equal(xPostCreate.policy, 'write:content');
  assert.equal(xPostCreate.availability, 'user-only');
  assert.equal(xPostCreate.phase, 2);
  assert.deepEqual([...xPostCreate.scopes], ['tweet.read', 'tweet.write', 'users.read']);
  assert.match(xPostCreate.description, /^X \(Twitter\): /);
  // COST-4: the raised URL-post price is disclosed up front, in the description.
  assert.match(xPostCreate.description, /\$0\.20/);
  assert.equal(xPostCreate.annotations.readOnlyHint, false);
  assert.equal(xPostCreate.annotations.destructiveHint, false);
  assert.equal(xPostCreate.annotations.openWorldHint, true);

  assert.equal(xPostDelete.name, 'x_post_delete');
  assert.equal(xPostDelete.policy, 'destructive:content');
  assert.equal(xPostDelete.availability, 'user-only');
  assert.equal(xPostDelete.phase, 2);
  assert.equal(xPostDelete.cost, 'w:action');
  assert.deepEqual([...xPostDelete.scopes], ['tweet.read', 'tweet.write', 'users.read']);
  assert.match(xPostDelete.description, /^X \(Twitter\): /);
  // MCP-4: destructive & non-idempotent hints, matching deriveAnnotations.
  assert.equal(xPostDelete.annotations.destructiveHint, true);
  assert.equal(xPostDelete.annotations.idempotentHint, false);
  assert.equal(xPostDelete.annotations.openWorldHint, true);
});

test('x_post_create: happy path returns id + canonical URL and sends a minimal body', async () => {
  const mock = mockHttp();
  const body = captureBody();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'POST', body: body.matcher })
    .reply(201, { data: { id: '1690', text: 'hello world' } });

  const out = await xPostCreate.handler({ text: 'hello world' }, contextFor(mock));

  // Optional keys are OMITTED from the wire body — only `text` is sent.
  assert.deepEqual(JSON.parse(body.get()), { text: 'hello world' });
  assert.deepEqual(out.data, { id: '1690', url: 'https://x.com/i/status/1690' });
  assert.equal(out.summary, 'Post created: https://x.com/i/status/1690');

  mock.assertDone();
  await mock.close();
});

test('POST-1: unicode text is sent byte-identical — no normalization, no trimming', async () => {
  // NFD combining accent, ZWJ family emoji, RTL Hebrew, and deliberate edge whitespace.
  const text = '  Café \u{1F468}‍\u{1F469}‍\u{1F467} שלום  ';
  const mock = mockHttp();
  const body = captureBody();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'POST', body: body.matcher })
    .reply(201, { data: { id: '42', text } });

  await xPostCreate.handler({ text }, contextFor(mock));

  // Exact string equality against our own serialization proves byte-identity: what the
  // user wrote is what went on the wire.
  assert.equal(body.get(), JSON.stringify({ text }));

  mock.assertDone();
  await mock.close();
});

test('POST-1: whitespace-only text rejects as validation before any HTTP', async () => {
  await assert.rejects(
    () => xPostCreate.handler({ text: ' \n\t ' }, noHttpCtx()),
    xErrorOf('validation', /whitespace-only/),
  );
});

test('POST-6: poll and media_ids are mutually exclusive, checked before any HTTP', async () => {
  await assert.rejects(
    () =>
      xPostCreate.handler(
        {
          text: 'pick one',
          media_ids: ['900'],
          poll: { options: ['a', 'b'], duration_minutes: 60 },
        },
        noHttpCtx(),
      ),
    xErrorOf('validation', /mutually exclusive/),
  );
});

test('POST-6: schema pre-validates poll bounds, media count, and the reply_settings enum', () => {
  const base = { text: 'vote' };
  const withPoll = (options: string[], duration_minutes: number) => ({
    ...base,
    poll: { options, duration_minutes },
  });

  // Poll options: 2-4 choices.
  assert.equal(xPostCreate.input.safeParse(withPoll(['only'], 60)).success, false);
  assert.equal(xPostCreate.input.safeParse(withPoll(['a', 'b', 'c', 'd', 'e'], 60)).success, false);
  assert.equal(xPostCreate.input.safeParse(withPoll(['a', 'b'], 60)).success, true);

  // Poll duration: 5..10080 minutes, integer.
  assert.equal(xPostCreate.input.safeParse(withPoll(['a', 'b'], 4)).success, false);
  assert.equal(xPostCreate.input.safeParse(withPoll(['a', 'b'], 10081)).success, false);
  assert.equal(xPostCreate.input.safeParse(withPoll(['a', 'b'], 5)).success, true);
  assert.equal(xPostCreate.input.safeParse(withPoll(['a', 'b'], 10080)).success, true);

  // Media: at most 4 attachments.
  assert.equal(
    xPostCreate.input.safeParse({ ...base, media_ids: ['1', '2', '3', '4', '5'] }).success,
    false,
  );
  assert.equal(
    xPostCreate.input.safeParse({ ...base, media_ids: ['1', '2', '3', '4'] }).success,
    true,
  );

  // reply_settings is a CLOSED enum; "everyone" is expressed by omission, not a value.
  assert.equal(xPostCreate.input.safeParse({ ...base, reply_settings: 'everyone' }).success, false);
  assert.equal(xPostCreate.input.safeParse({ ...base, reply_settings: 'following' }).success, true);

  // Unknown keys are refused (strict schema).
  assert.equal(xPostCreate.input.safeParse({ ...base, surprise: true }).success, false);
});

test('COST-4: the cost resolver prices URL-bearing text at $0.20, plain text at base', () => {
  // Plain text -> class only; the budget layer prices it from the $0.015 table entry.
  assert.deepEqual(createCostFor('plain words, nothing linkable'), { class: 'w:post' });

  // Explicit scheme and bare auto-linkable domain both trigger the override (detection
  // errs toward warning).
  assert.deepEqual(createCostFor('read https://example.com/post'), { class: 'w:post', usd: 0.2 });
  assert.deepEqual(createCostFor('read example.com for details'), { class: 'w:post', usd: 0.2 });
});

test('COST-4: the result note states the $0.20 URL price distinctly from the base', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'POST' })
    .reply(201, { data: { id: '77', text: 'see https://example.com' } });

  const out = await xPostCreate.handler({ text: 'see https://example.com' }, contextFor(mock));
  const data = out.data as { note?: string };

  // Both prices appear, so the agent can see WHY this post costs more than the base.
  assert.match(data.note ?? '', /\$0\.20/);
  assert.match(data.note ?? '', /\$0\.015/);

  mock.assertDone();
  await mock.close();
});

test('POST-2: the platform 400 "too long" maps to validation with the weighted estimate', async () => {
  const mock = mockHttp();
  mock.pool.intercept({ path: '/2/tweets', method: 'POST' }).reply(400, {
    title: 'Invalid Request',
    detail: 'Your Tweet text is too long.',
  });

  // 300 plain code points -> advisory weight ~300/280, shorten by ~20.
  await assert.rejects(
    () => xPostCreate.handler({ text: 'a'.repeat(300) }, contextFor(mock)),
    xErrorOf('validation', /weighs ~300\/280 — URLs count as 23 characters/),
  );

  // When the local estimate does NOT exceed the limit (weighted CJK/emoji count 2 on the
  // platform but 1 here), the message defers to X instead of a misleading "shorten by".
  mock.pool.intercept({ path: '/2/tweets', method: 'POST' }).reply(400, {
    title: 'Invalid Request',
    detail: 'Your Tweet text is too long.',
  });
  await assert.rejects(
    () => xPostCreate.handler({ text: '字'.repeat(200) }, contextFor(mock)),
    xErrorOf('validation', /X's weighted count is authoritative/),
  );

  mock.assertDone();
  await mock.close();
});

test('POST-3: a duplicate-content 403 maps to a meaningful forbidden', async () => {
  const mock = mockHttp();
  mock.pool.intercept({ path: '/2/tweets', method: 'POST' }).reply(403, {
    title: 'Forbidden',
    detail: 'You are not allowed to create a Tweet with duplicate content.',
  });

  // The message is both the refusal AND the POST-4 ambiguity-resolution signal.
  await assert.rejects(
    () => xPostCreate.handler({ text: 'same again' }, contextFor(mock)),
    (err: unknown) => {
      xErrorOf('forbidden', /duplicate of a recent identical post/)(err);
      assert.match((err as XError).message, /original post DID land/);
      assert.equal((err as XError).data.http_status, 403);
      return true;
    },
  );

  mock.assertDone();
  await mock.close();
});

test('POST-4: a timed-out create explains the ambiguity and the identical-text probe', async () => {
  const mock = mockHttp();
  const timeout = Object.assign(new Error('simulated timeout'), { name: 'TimeoutError' });
  // A single interceptor + assertDone proves exactly one attempt: writes never retry.
  mock.pool.intercept({ path: '/2/tweets', method: 'POST' }).replyWithError(timeout);

  await assert.rejects(
    () => xPostCreate.handler({ text: 'launch update' }, contextFor(mock)),
    (err: unknown) => {
      xErrorOf('network', /timed out after \d+ms/)(err);
      const xerr = err as XError;
      assert.match(xerr.message, /may nevertheless have been created/);
      assert.match(xerr.message, /re-issuing the IDENTICAL text/);
      assert.match(xerr.message, /duplicate-content 403 means it did land/);
      // Non-retryable: the probe is a deliberate, interpreted act — never a blind retry.
      assert.equal(xerr.retryable, false);
      return true;
    },
  );

  mock.assertDone();
  await mock.close();
});

test('NET-4: a 5xx on create surfaces immediately with the ambiguity note', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'POST' })
    .reply(503, { title: 'Service Unavailable' });

  await assert.rejects(
    () => xPostCreate.handler({ text: 'launch update' }, contextFor(mock)),
    (err: unknown) => {
      xErrorOf('api', /may nevertheless have been created/)(err);
      const xerr = err as XError;
      assert.equal(xerr.data.http_status, 503);
      assert.equal(xerr.retryable, false);
      return true;
    },
  );

  // assertDone: the single interceptor was consumed exactly once — no write retry.
  mock.assertDone();
  await mock.close();
});

test('POST-7: a gone/hidden reply target maps to not-found (never generic api)', async () => {
  const mock = mockHttp();
  mock.pool.intercept({ path: '/2/tweets', method: 'POST' }).reply(400, {
    title: 'Invalid Request',
    detail: 'You attempted to reply to a Tweet that is deleted or not visible to you.',
  });

  await assert.rejects(
    () => xPostCreate.handler({ text: 'nice one', reply_to_id: '111' }, contextFor(mock)),
    xErrorOf('not-found', /target post deleted or protected — verify the id\/URL/),
  );

  // The protected-target leg: a 403 stays a typed `forbidden` (still never generic api).
  mock.pool.intercept({ path: '/2/tweets', method: 'POST' }).reply(403, {
    title: 'Forbidden',
    detail: 'You are not permitted to reply to a protected Tweet.',
  });
  await assert.rejects(
    () => xPostCreate.handler({ text: 'nice one', reply_to_id: '111' }, contextFor(mock)),
    xErrorOf('forbidden', /X refused this specific action/),
  );

  mock.assertDone();
  await mock.close();
});

test('POST-9: any failed create with reply_to_id carries the thread-resume guidance', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'POST' })
    .reply(500, { title: 'Internal Server Error' });

  await assert.rejects(
    () => xPostCreate.handler({ text: 'part 3 of 5', reply_to_id: '222' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.match(err.message, /posts already created in this sequence remain live/);
      assert.match(err.message, /resume by replying to the last successful id/);
      return true;
    },
  );

  mock.assertDone();
  await mock.close();
});

test('x_post_create: reply/quote/media/reply_settings compose the documented body', async () => {
  const mock = mockHttp();
  const body = captureBody();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'POST', body: body.matcher })
    .reply(201, { data: { id: '321', text: 'launch' } });

  // reply_to_id arrives as a status URL and must be normalized to the bare id on the wire.
  await xPostCreate.handler(
    {
      text: 'launch',
      reply_to_id: 'https://x.com/someone/status/111',
      quote_id: '222',
      media_ids: ['900', '901'],
      reply_settings: 'following',
    },
    contextFor(mock),
  );

  assert.deepEqual(JSON.parse(body.get()), {
    text: 'launch',
    reply: { in_reply_to_tweet_id: '111' },
    quote_tweet_id: '222',
    media: { media_ids: ['900', '901'] },
    reply_settings: 'following',
  });

  mock.assertDone();
  await mock.close();
});

test('x_post_create: a poll rides the body as options + duration_minutes', async () => {
  const mock = mockHttp();
  const body = captureBody();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'POST', body: body.matcher })
    .reply(201, { data: { id: '500', text: 'vote' } });

  await xPostCreate.handler(
    { text: 'vote', poll: { options: ['yes', 'no'], duration_minutes: 60 } },
    contextFor(mock),
  );

  assert.deepEqual(JSON.parse(body.get()), {
    text: 'vote',
    poll: { options: ['yes', 'no'], duration_minutes: 60 },
  });

  mock.assertDone();
  await mock.close();
});

test('x_post_create: a handle as reply_to_id rejects before any HTTP', async () => {
  await assert.rejects(
    () => xPostCreate.handler({ text: 'hi', reply_to_id: '@jack' }, noHttpCtx()),
    xErrorOf('validation', /numeric id or a status URL/),
  );
});

test('x_post_delete: happy path deletes by id', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets/123', method: 'DELETE' })
    .reply(200, { data: { deleted: true } });

  const out = await xPostDelete.handler({ id: '123' }, contextFor(mock));

  // Success shape carries NO already_deleted flag — that marks only the 404 path.
  assert.deepEqual(out.data, { id: '123', deleted: true });
  assert.equal(out.summary, 'Post 123 deleted.');

  mock.assertDone();
  await mock.close();
});

test('x_post_delete: a status URL normalizes to the id on the wire', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets/555', method: 'DELETE' })
    .reply(200, { data: { deleted: true } });

  const out = await xPostDelete.handler(
    { id: 'https://x.com/someone/status/555' },
    contextFor(mock),
  );
  assert.deepEqual(out.data, { id: '555', deleted: true });

  mock.assertDone();
  await mock.close();
});

test('POST-5: deleting an already-deleted post is success with already_deleted: true', async () => {
  const mock = mockHttp();
  mock.pool.intercept({ path: '/2/tweets/123', method: 'DELETE' }).reply(404, {
    title: 'Not Found Error',
    detail: 'Could not find tweet with id: [123].',
  });

  // Resolves — never throws. Deletion is idempotent from the agent's perspective.
  const out = await xPostDelete.handler({ id: '123' }, contextFor(mock));
  const data = out.data as { id: string; deleted: boolean; already_deleted?: boolean };

  assert.equal(data.id, '123');
  assert.equal(data.deleted, true);
  assert.equal(data.already_deleted, true);
  assert.match(out.summary ?? '', /already deleted/);

  mock.assertDone();
  await mock.close();
});

test('NET-4: a 5xx on delete carries the delete-specific ambiguity note', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets/123', method: 'DELETE' })
    .reply(500, { title: 'Internal Server Error' });

  await assert.rejects(
    () => xPostDelete.handler({ id: '123' }, contextFor(mock)),
    (err: unknown) => {
      xErrorOf('api', /may nevertheless have been applied/)(err);
      const xerr = err as XError;
      // Re-issuing a delete is SAFE (POST-5 makes it idempotent) — the note says so.
      assert.match(xerr.message, /Re-issuing this delete is safe/);
      assert.equal(xerr.retryable, false);
      return true;
    },
  );

  mock.assertDone();
  await mock.close();
});

test("x_post_delete: a 403 (not the caller's post) passes through as forbidden", async () => {
  const mock = mockHttp();
  mock.pool.intercept({ path: '/2/tweets/123', method: 'DELETE' }).reply(403, {
    title: 'Forbidden',
    detail: 'You are not permitted to delete this Tweet.',
  });

  await assert.rejects(
    () => xPostDelete.handler({ id: '123' }, contextFor(mock)),
    xErrorOf('forbidden', /X refused this specific action/),
  );

  mock.assertDone();
  await mock.close();
});

// --- x_post_hide_reply (decisions/0002) ------------------------------------------

test('x_post_hide_reply declares the docs/03 axes: reversible moderation write', () => {
  assert.equal(xPostHideReply.name, 'x_post_hide_reply');
  assert.equal(xPostHideReply.policy, 'write:moderation');
  assert.equal(xPostHideReply.availability, 'user-only');
  assert.equal(xPostHideReply.cost, 'w:action');
  assert.equal(xPostHideReply.phase, 3);
  assert.equal(xPostHideReply.annotations.readOnlyHint, false);
  // Hiding is reversible and absolute (not a toggle), so it is neither destructive nor
  // dangerous to re-issue — the two hints that let a client auto-approve it.
  assert.equal(xPostHideReply.annotations.destructiveHint, false);
  assert.equal(xPostHideReply.annotations.idempotentHint, true);
  assert.equal(xPostHideReply.annotations.openWorldHint, true);
  assert.deepEqual(
    [...xPostHideReply.scopes],
    ['tweet.read', 'tweet.moderate.write', 'users.read'],
  );
});

test('x_post_hide_reply: PUT /2/tweets/:id/hidden with {"hidden":true}', async () => {
  const mock = mockHttp();
  const body = captureBody();
  mock.pool
    .intercept({ path: '/2/tweets/777/hidden', method: 'PUT', body: body.matcher })
    .reply(200, { data: { hidden: true } });

  const out = await xPostHideReply.handler({ reply_id: '777', action: 'hide' }, contextFor(mock));

  assert.equal(body.get(), '{"hidden":true}');
  assert.deepEqual(out.data, {
    post_id: '777',
    url: 'https://x.com/i/status/777',
    action: 'hide',
    hidden: true,
  });
  assert.equal(out.summary, 'Hid reply 777.');

  mock.assertDone();
  await mock.close();
});

test('x_post_hide_reply: unhide sends {"hidden":false} and reports the resulting state', async () => {
  const mock = mockHttp();
  const body = captureBody();
  mock.pool
    .intercept({ path: '/2/tweets/777/hidden', method: 'PUT', body: body.matcher })
    .reply(200, { data: { hidden: false } });

  const out = await xPostHideReply.handler({ reply_id: '777', action: 'unhide' }, contextFor(mock));

  assert.equal(body.get(), '{"hidden":false}');
  assert.equal((out.data as { hidden: boolean }).hidden, false);
  assert.equal(out.summary, 'Unhid reply 777.');

  mock.assertDone();
  await mock.close();
});

test('DRIFT-1: a 2xx envelope without data falls back to the requested state', async () => {
  const mock = mockHttp();
  mock.pool.intercept({ path: '/2/tweets/777/hidden', method: 'PUT' }).reply(200, {});

  const out = await xPostHideReply.handler({ reply_id: '777', action: 'hide' }, contextFor(mock));
  assert.equal((out.data as { hidden: boolean }).hidden, true);

  mock.assertDone();
  await mock.close();
});

test('REND-8: a status URL normalizes to the id before HTTP; a handle rejects', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets/888/hidden', method: 'PUT' })
    .reply(200, { data: { hidden: true } });

  const out = await xPostHideReply.handler(
    { reply_id: 'https://twitter.com/someone/status/888', action: 'hide' },
    contextFor(mock),
  );
  assert.equal((out.data as { post_id: string }).post_id, '888');

  mock.assertDone();
  await mock.close();

  // A handle is not a post reference: rejected as validation, with no request attempted.
  await assert.rejects(
    () => xPostHideReply.handler({ reply_id: '@someone', action: 'hide' }, contextFor(mockHttp())),
    xErrorOf('validation', /numeric id or a status URL, not a handle/i),
  );
});

test('x_post_hide_reply: a 403 explains the conversation-owner rule (not a scope typo)', async () => {
  const mock = mockHttp();
  mock.pool.intercept({ path: '/2/tweets/777/hidden', method: 'PUT' }).reply(403, {
    title: 'Forbidden',
    detail: 'You are not permitted to hide this reply.',
  });

  await assert.rejects(
    () => xPostHideReply.handler({ reply_id: '777', action: 'hide' }, contextFor(mock)),
    (err: unknown) => {
      xErrorOf('forbidden', /author of the post that started the conversation/)(err);
      const xerr = err as XError;
      assert.match(xerr.message, /tweet\.moderate\.write/);
      assert.equal(xerr.retryable, false);
      return true;
    },
  );

  mock.assertDone();
  await mock.close();
});

test('NET-4: a 5xx on hide states the ambiguity AND that re-issuing is safe', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets/777/hidden', method: 'PUT' })
    .reply(500, { title: 'Internal Server Error' });

  await assert.rejects(
    () => xPostHideReply.handler({ reply_id: '777', action: 'hide' }, contextFor(mock)),
    (err: unknown) => {
      xErrorOf('api', /may nevertheless have been applied/)(err);
      const xerr = err as XError;
      // Absolute state, not a toggle: a blind retry cannot flip the reply back.
      assert.match(xerr.message, /absolute state rather than toggling/);
      assert.equal(xerr.retryable, false);
      return true;
    },
  );

  mock.assertDone();
  await mock.close();
});

test('x_post_hide_reply: the input schema is strict and the action enum is closed', () => {
  assert.equal(xPostHideReply.input.safeParse({ reply_id: '1', action: 'hide' }).success, true);
  assert.equal(xPostHideReply.input.safeParse({ reply_id: '1', action: 'unhide' }).success, true);
  assert.equal(xPostHideReply.input.safeParse({ reply_id: '1', action: 'delete' }).success, false);
  assert.equal(xPostHideReply.input.safeParse({ reply_id: '1' }).success, false);
  assert.equal(xPostHideReply.input.safeParse({ reply_id: '', action: 'hide' }).success, false);
  assert.equal(
    xPostHideReply.input.safeParse({ reply_id: '1', action: 'hide', force: true }).success,
    false,
  );
});
