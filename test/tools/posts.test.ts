// Tests for the post read tools (T-121) and write tools (T-210). Each network test
// builds a REAL http client (api/http) wired to an undici MockAgent dispatcher, mirroring
// test/smoke.test.ts, and drives the tool handler end to end: id normalization ->
// /2/tweets -> compaction (reads) or write-specific error meaning (writes).

import test from 'node:test';
import assert from 'node:assert/strict';

import { WRITE_AMBIGUITY, createHttpClient } from '../../src/api/http.js';
import { mapHttpError } from '../../src/api/errors.js';
import {
  xPostGet,
  xPostCreate,
  xPostDelete,
  xPostHideReply,
  xThreadCreate,
  postsTools,
} from '../../src/tools/posts.js';
import { XError, apiError } from '../../src/core/errors.js';
import { createRegistry } from '../../src/core/registry.js';
import type { Registry } from '../../src/core/registry.js';
import type { ErrorClass } from '../../src/core/errors.js';
import type { AnyToolDef, ToolContext } from '../../src/core/tooldef.js';
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
  assert.deepEqual(postsTools, [xPostGet, xPostCreate, xPostDelete, xPostHideReply, xThreadCreate]);
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

  // REND-6: a batch with at least one item carries the untrusted-content note on `summary`
  // (BatchResult has no page-level `note` field to carry it on).
  assert.equal(out.summary, `2 post(s) ${UNTRUSTED_CONTENT_NOTE}`);
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
  // REND-6: still carries the note — at least one item came back.
  assert.equal(out.summary, `1 post(s), 1 missing ${UNTRUSTED_CONTENT_NOTE}`);

  mock.assertDone();
  await mock.close();
});

test('REND-6: an all-missing batch (0 items) carries no untrusted-content note', async () => {
  const mock = mockHttp();
  // No `data` at all — every requested id came back only in `errors[]`. Nothing third-party
  // rendered, so nothing to warn about (unlike the raw path, which warns unconditionally).
  mock.pool
    .intercept({ path: '/2/tweets', method: 'GET', query: queryFor('999') })
    .reply(200, { errors: [{ value: '999', title: 'Not Found Error' }] });

  const out = await xPostGet.handler({ ids: ['999'] }, contextFor(mock));
  const batch = out.data as BatchResult<CompactPost>;

  assert.equal(batch.items.length, 0);
  assert.deepEqual(batch.missing, [{ id: '999', reason: 'not-found' }]);
  assert.equal(out.summary, '0 post(s), 1 missing');

  mock.assertDone();
  await mock.close();
});

test('REND-5: missing author, reply parent, and media expansions degrade per-field, never crash', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'GET', query: queryFor('111,222') })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('posts/degraded-includes.json'));

  const out = await xPostGet.handler({ ids: ['111', '222'] }, contextFor(mock));
  const batch = out.data as BatchResult<CompactPost>;

  // Both posts still render; a partial `includes` never drops an item (REND-5).
  assert.equal(batch.items.length, 2);
  assert.equal(batch.missing, undefined);
  const [first, second] = batch.items;
  assert.ok(first && second);

  // Post 111: the attached media key has no matching includes.media entry, so it is
  // dropped from the media array without dropping the post itself.
  assert.equal(first.id, '111');
  assert.equal(first.media, undefined);

  // Post 222: author_id has no matching includes.users entry, so the author degrades to
  // the raw numeric id; the reply parent has no matching includes.tweets entry, so it
  // keeps its id and omits the unresolvable author.
  assert.equal(second.id, '222');
  assert.equal(second.author, '99');
  assert.deepEqual(second.reply_to, { id: '444' });

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
  assert.equal(out.units, 2); // COST-3: billed per post returned

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

test('x_post_get: a handle in ids fails input validation, naming the array index', () => {
  // Mirrors x_post_create's reply_to_id/quote_id schema check (delta audit 09 Finding 1 residual):
  // `getInput`'s `.superRefine` runs `parsePostId` per entry so a bad reference is refused
  // at the schema boundary, before the registry's budget charge.
  const rejected = xPostGet.input.safeParse({ ids: ['111', '@jack'] });
  assert.equal(rejected.success, false);
  if (!rejected.success) {
    const issue = rejected.error.issues[0];
    assert.deepEqual(issue?.path, ['ids', 1]);
    assert.match(issue?.message ?? '', /numeric id or a status URL/);
  }
});

test('x_post_get: a malformed id in ids rejects before the budget charge or any HTTP', async () => {
  const { reg, budgetChecks } = chargeCountingRegistry(xPostGet);
  await assert.rejects(
    () => reg.call('x_post_get', { ids: ['@jack'] }, noHttpCtx()),
    xErrorOf('validation', /ids\.0: .*numeric id or a status URL/),
  );
  assert.equal(budgetChecks(), 0);
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
 * A registry with permissive gates that counts budget checks (pipeline step 4), so a test
 * can prove a local refusal happens at schema validation (step 1) and is never charged.
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
function createCostFor(text: string): { class: string; usd?: number; note?: string } {
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

test('POST-1: whitespace-only text rejects as validation before the budget charge or any HTTP', async () => {
  const { reg, budgetChecks } = chargeCountingRegistry(xPostCreate);
  await assert.rejects(
    () => reg.call('x_post_create', { text: ' \n\t ' }, noHttpCtx()),
    xErrorOf('validation', /text: Post text is whitespace-only/),
  );
  assert.equal(budgetChecks(), 0);
});

test('POST-6: poll and media_ids are mutually exclusive, refused before the budget charge or any HTTP', async () => {
  const { reg, budgetChecks } = chargeCountingRegistry(xPostCreate);
  await assert.rejects(
    () =>
      reg.call(
        'x_post_create',
        {
          text: 'pick one',
          media_ids: ['900'],
          poll: { options: ['a', 'b'], duration_minutes: 60 },
        },
        noHttpCtx(),
      ),
    xErrorOf('validation', /poll: poll and media_ids are mutually exclusive/),
  );
  assert.equal(budgetChecks(), 0);
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

  // Explicit scheme, bare auto-linkable domains (including IDN and punycode) and a domain
  // glued to a word by `_` all trigger the override (detection errs toward warning).
  for (const text of [
    'read https://example.com/post',
    'read example.com for details',
    'read WWW.EXAMPLE.COM',
    'siehe m\u00fcnchen.de',
    'see \u043f\u0440\u0438\u043c\u0435\u0440.\u0440\u0444',
    'see xn--e1afmkfd.xn--p1ai',
    'see foo_bar.com',
  ]) {
    const cost = createCostFor(text);
    assert.equal(cost.usd, 0.2, text);
    // The note travels with the estimate, so a hard-mode refusal can name the URL price.
    assert.match(cost.note ?? '', /\$0\.20.*\$0\.015/, text);
  }
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

test('x_post_create: a malformed reply_to_id or quote_id rejects before the budget charge or any HTTP', async () => {
  const { reg, budgetChecks } = chargeCountingRegistry(xPostCreate);
  await assert.rejects(
    () => reg.call('x_post_create', { text: 'hi', reply_to_id: '@jack' }, noHttpCtx()),
    xErrorOf('validation', /reply_to_id: .*numeric id or a status URL/),
  );
  await assert.rejects(
    () => reg.call('x_post_create', { text: 'hi', quote_id: 'not an id' }, noHttpCtx()),
    xErrorOf('validation', /quote_id: Not a recognized X post id or status URL/),
  );
  assert.equal(budgetChecks(), 0);
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
      // The generic "do NOT re-issue" note is replaced, never stacked against the safe advice.
      assert.equal(xerr.message.includes(WRITE_AMBIGUITY), false);
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

test('a non-XError rejection propagates unchanged through the create and hide catches', async () => {
  // The guidance mappers (mapCreateFailure / withGuidance) only dress TYPED failures; a
  // programming error or torn transport must surface as the SAME object, not be rewrapped
  // into misleading API guidance.
  const sentinel = new Error('socket torn mid-write');
  const ctx: ToolContext = {
    ports: makePorts(),
    http: { send: () => Promise.reject(sentinel) },
  };

  await assert.rejects(
    () => xPostCreate.handler({ text: 'hello' }, ctx),
    (err: unknown) => err === sentinel,
  );
  await assert.rejects(
    () => xPostHideReply.handler({ reply_id: '777', action: 'hide' }, ctx),
    (err: unknown) => err === sentinel,
  );
});

test('raw: a data-less envelope (all ids missing) counts 0 and keeps the warning', async () => {
  const mock = mockHttp();
  // /2/tweets answers 200 with only `errors[]` when every requested id is gone — no
  // `data` array at all. The raw path must render that as an honest empty list.
  mock.pool
    .intercept({ path: '/2/tweets', method: 'GET', query: queryFor('999') })
    .reply(200, { errors: [{ value: '999', title: 'Not Found Error' }] });

  const out = await xPostGet.handler({ ids: ['999'], raw: true }, contextFor(mock));
  const raw = out.data as RawListResponse<RawTweet>;

  assert.deepEqual(raw.data, []); // normalized to [] for the cap, never a crash
  // Every id came back in `errors[]`: no resource was returned, so nothing is charged.
  assert.equal(out.units, 0);
  // Zero results still carry the REND-6 warning: `errors[]` titles are platform text too.
  assert.equal(out.summary, `0 raw post(s) ${UNTRUSTED_CONTENT_NOTE}`);

  mock.assertDone();
  await mock.close();
});

test('REND-10: a raw batch larger than 25 is capped in order and says so', async () => {
  // The batch endpoint takes up to 100 ids in ONE request, so unlike the paged readers the
  // cap cannot be enforced on the wire — the response itself is truncated to RAW_MAX_RESULTS.
  const ids = Array.from({ length: 30 }, (_, i) => String(i + 1));
  const tweets = ids.map((id) => ({ id, text: `post ${id}` }));

  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'GET', query: queryFor(ids.join(',')) })
    .reply(200, { data: tweets });

  const out = await xPostGet.handler({ ids, raw: true }, contextFor(mock));
  const raw = out.data as RawListResponse<RawTweet>;

  // First 25 in response order survive; the tail is dropped, not sampled.
  assert.equal(raw.data?.length, 25);
  assert.equal(raw.data?.[0]?.id, '1');
  assert.equal(raw.data?.[24]?.id, '25');
  // The summary states the truncation so the agent knows the envelope is not complete.
  assert.equal(out.summary, `25 raw post(s) (capped at 25) ${UNTRUSTED_CONTENT_NOTE}`);
  // …and the price follows what X SENT, not what survived the local cap: 30 posts came
  // back in one request and all 30 were billed, however few we hand on (COST-3/REND-10).
  assert.equal(out.units, 30);

  mock.assertDone();
  await mock.close();
});

test('x_post_create: a degraded 201 without a body id still resolves, never crashes', async () => {
  // NET-4 asymmetry: once the platform says 201 the post EXISTS, so a malformed success
  // envelope must degrade (empty id, base permalink) rather than throw after the write.
  const mock = mockHttp();
  mock.pool.intercept({ path: '/2/tweets', method: 'POST' }).reply(201, {});

  const out = await xPostCreate.handler({ text: 'hello' }, contextFor(mock));

  assert.deepEqual(out.data, { id: '', url: 'https://x.com/i/status/' });
  assert.equal(out.summary, 'Post created: https://x.com/i/status/');

  mock.assertDone();
  await mock.close();
});

test('NET-4: an api error WITHOUT an http_status is not treated as write-ambiguous', async () => {
  // isAmbiguousWriteFailure keys on `http_status >= 500`; when the status is absent the
  // outcome is NOT unknown-outcome territory, so the error must pass through unchanged —
  // same object, no "may nevertheless have been created" hedge invented for it.
  const original = apiError('malformed platform response');
  const ctx: ToolContext = {
    ports: makePorts(),
    http: { send: () => Promise.reject(original) },
  };

  await assert.rejects(
    () => xPostCreate.handler({ text: 'hello' }, ctx),
    (err: unknown) => {
      assert.equal(err, original); // identity: mapCreateFailure returned it untouched
      assert.ok(XError.is(err));
      assert.doesNotMatch(err.message, /may nevertheless have been created/);
      return true;
    },
  );
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

// --- x_thread_create (roadmap Phase 3) ---------------------------------------------

/** Resolve x_thread_create's per-call cost — the tool declares a resolver, not a class. */
function threadCostFor(posts: string[]): { class: string; usd?: number; note?: string } {
  const spec = xThreadCreate.cost;
  assert.ok(typeof spec === 'function', 'x_thread_create cost must be an input-dependent resolver');
  return spec({ posts });
}

test('x_thread_create declares the docs/03 axes', () => {
  assert.equal(xThreadCreate.name, 'x_thread_create');
  assert.equal(xThreadCreate.policy, 'write:content');
  assert.equal(xThreadCreate.availability, 'user-only');
  assert.equal(xThreadCreate.phase, 3);
  assert.deepEqual([...xThreadCreate.scopes], ['tweet.read', 'tweet.write', 'users.read']);
  assert.match(xThreadCreate.description, /^X \(Twitter\): /);
  assert.equal(xThreadCreate.annotations.readOnlyHint, false);
  assert.equal(xThreadCreate.annotations.destructiveHint, false);
  assert.equal(xThreadCreate.annotations.openWorldHint, true);
});

test('x_thread_create: happy path chains reply_to_id across all posts', async () => {
  const mock = mockHttp();
  const body1 = captureBody();
  const body2 = captureBody();
  const body3 = captureBody();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'POST', body: body1.matcher })
    .reply(201, { data: { id: '100', text: 'one' } });
  mock.pool
    .intercept({ path: '/2/tweets', method: 'POST', body: body2.matcher })
    .reply(201, { data: { id: '101', text: 'two' } });
  mock.pool
    .intercept({ path: '/2/tweets', method: 'POST', body: body3.matcher })
    .reply(201, { data: { id: '102', text: 'three' } });

  const out = await xThreadCreate.handler({ posts: ['one', 'two', 'three'] }, contextFor(mock));

  // Post 1 stands alone; each following post replies to the id the previous one returned.
  assert.deepEqual(JSON.parse(body1.get()), { text: 'one' });
  assert.deepEqual(JSON.parse(body2.get()), {
    text: 'two',
    reply: { in_reply_to_tweet_id: '100' },
  });
  assert.deepEqual(JSON.parse(body3.get()), {
    text: 'three',
    reply: { in_reply_to_tweet_id: '101' },
  });

  assert.deepEqual(out.data, {
    ok: true,
    posts: [
      { id: '100', url: 'https://x.com/i/status/100' },
      { id: '101', url: 'https://x.com/i/status/101' },
      { id: '102', url: 'https://x.com/i/status/102' },
    ],
  });
  assert.equal(out.summary, 'Thread created: 3 posts, starting at https://x.com/i/status/100');

  mock.assertDone();
  await mock.close();
});

test('x_thread_create: posts bounds are validated by the schema (2-25, strict)', () => {
  assert.equal(xThreadCreate.input.safeParse({ posts: ['only one'] }).success, false);
  assert.equal(xThreadCreate.input.safeParse({ posts: ['a', 'b'] }).success, true);
  assert.equal(
    xThreadCreate.input.safeParse({ posts: Array.from({ length: 25 }, (_, i) => `p${i}`) }).success,
    true,
  );
  assert.equal(
    xThreadCreate.input.safeParse({ posts: Array.from({ length: 26 }, (_, i) => `p${i}`) }).success,
    false,
  );
  // An empty-string element is rejected by the per-element min(1), before the whitespace
  // check even runs.
  assert.equal(xThreadCreate.input.safeParse({ posts: ['a', ''] }).success, false);
  // Unknown keys are refused (strict schema) — no x_post_create option rides along.
  assert.equal(
    xThreadCreate.input.safeParse({ posts: ['a', 'b'], reply_settings: 'following' }).success,
    false,
  );
});

test('POST-1: any whitespace-only post in the thread rejects before any HTTP is sent', () => {
  // The bad post is THIRD, not first — proving every post is validated up front, not just
  // the one about to be sent.
  const parsed = xThreadCreate.input.safeParse({ posts: ['fine', 'also fine', '  \n\t '] });
  assert.equal(parsed.success, false);
  assert.match(parsed.error?.issues[0]?.message ?? '', /Post 3 of 3 is whitespace-only/);
  assert.deepEqual(parsed.error?.issues[0]?.path, ['posts', 2]);
});

test('POST-1 / delta audit 09 F1: a whitespace-only thread post is refused before the budget charge', async () => {
  // Schema validation is registry step 1 and the budget charge is step 4, so a rejected
  // thread must reach neither the budget gate nor the network.
  const { reg, budgetChecks } = chargeCountingRegistry(xThreadCreate);
  const posts = [...Array.from({ length: 24 }, (_, i) => `see https://example.com/${i}`), ' '];
  await assert.rejects(
    () => reg.call('x_thread_create', { posts }, noHttpCtx()),
    xErrorOf('validation', /Post 25 of 25 is whitespace-only/),
  );
  assert.equal(budgetChecks(), 0);
});

test('x_thread_create: a mid-thread failure reports published posts, failed_at, and POST-9 resume guidance without throwing', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/tweets', method: 'POST' })
    .reply(201, { data: { id: '200', text: 'one' } });
  mock.pool.intercept({ path: '/2/tweets', method: 'POST' }).reply(500, {
    title: 'Internal Server Error',
  });

  // The handler must resolve normally (REND-2 precedent) — a partial failure is reported
  // data, never a thrown error.
  const out = await xThreadCreate.handler({ posts: ['one', 'two', 'three'] }, contextFor(mock));

  const data = out.data as {
    ok: boolean;
    posts: { id: string; url: string }[];
    failed_at: number;
    error: { kind: string; message: string; retryable: boolean };
  };
  assert.equal(data.ok, false);
  assert.deepEqual(data.posts, [{ id: '200', url: 'https://x.com/i/status/200' }]);
  assert.equal(data.failed_at, 1);
  assert.equal(data.error.kind, 'api');
  // POST-9: the second post carried a reply_to_id, so the thread-resume guidance rides on
  // the mapped failure exactly as it would for a standalone x_post_create reply failure.
  assert.match(data.error.message, /posts already created in this sequence remain live/);
  assert.match(data.error.message, /resume by replying to the last successful id/);
  assert.equal(out.summary, `Thread stopped at post 2/3: ${data.error.message}`);

  // Only 2 interceptors were queued (for posts 1 and 2): the loop stopped at the failure
  // and never attempted post 3 — assertDone proves that, not just the returned shape.
  mock.assertDone();
  await mock.close();
});

test('COST-4: the cost resolver prices the thread as the sum of each post’s own price', () => {
  const plain = threadCostFor(['plain one', 'plain two']);
  assert.equal(plain.class, 'w:post');
  assert.equal(plain.usd, 0.03); // 2 * $0.015
  // The note discloses the aggregate/no-refund tradeoff, not a per-post dollar figure.
  assert.match(plain.note ?? '', /aggregate/i);
  assert.match(plain.note ?? '', /not.*refunded/i);

  // A URL in even one post raises that post's price; the rest stay at base.
  const mixed = threadCostFor(['plain', 'see https://example.com', 'plain again']);
  assert.equal(mixed.usd, 0.015 + 0.2 + 0.015);

  // All-URL thread: every post prices at the URL rate.
  const allUrls = threadCostFor(['see https://a.example', 'see https://b.example']);
  assert.equal(allUrls.usd, 0.4);
});

test('COST-4: the cost resolver never throws on an empty/partial input (docs-gen costClass probe)', () => {
  // scripts/docs-gen.mjs's costClass() calls tool.cost({}) at doc-check time; the resolver
  // must degrade to a zero-cost estimate instead of throwing on a missing `posts` field.
  const spec = xThreadCreate.cost;
  assert.ok(typeof spec === 'function', 'x_thread_create cost must be an input-dependent resolver');
  const result = spec({} as unknown as { posts: string[] });
  assert.equal(result.class, 'w:post');
  assert.equal(result.usd, 0);
  assert.match(result.note ?? '', /aggregate/i);
});
