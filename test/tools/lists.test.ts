// Tests for the list tools (T-302 / WP-3.2): the ten merged list tools. Each network test
// builds a REAL http client (api/http) over an undici MockAgent and drives the handler end
// to end: list-id/user normalization -> (optional) GET /2/users/me -> the list endpoint ->
// compact output. Interceptors pin exact paths, methods, queries, and JSON bodies, so they
// stub AND assert the wire contract.
//
// undici 6.x matches an interceptor by string-comparing its `path` (with `query` merged in
// and the params sorted) against the incoming request's full path+query (also sorted), so
// every intercept below pins the EXACT query the endpoint wrapper puts on the wire — a
// match proves clamps/caps/cursors reached the wire.
//
// PAGE-5 (no auto-pagination): every test queues exactly ONE list-endpoint interceptor and
// ends with `assertDone()` — a handler that looped for a second page would throw on the
// unmocked request, so the single-request-per-call rule is enforced structurally here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mapHttpError } from '../../src/api/errors.js';
import { createHttpClient } from '../../src/api/http.js';
import { XError } from '../../src/core/errors.js';
import { UNTRUSTED_CONTENT_NOTE } from '../../src/core/render.js';
import type {
  RawList,
  RawListResponse,
  RawSingleResponse,
  RawTweet,
  RawUser,
} from '../../src/core/render.js';
import type { ToolContext } from '../../src/core/tooldef.js';
import {
  listsTools,
  xListCreate,
  xListDelete,
  xListFollowSet,
  xListGet,
  xListMemberSet,
  xListMembers,
  xListPinSet,
  xListTimeline,
  xListUpdate,
  xListsOwned,
} from '../../src/tools/lists.js';

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

/** Assert the rejection is a typed `validation` XError whose message matches `re`. */
function isValidation(re: RegExp) {
  return (err: unknown): boolean => {
    assert.ok(XError.is(err), 'expected an XError');
    assert.equal(err.kind, 'validation');
    assert.match(err.message, re);
    return true;
  };
}

// The list-object projection getList/ownedLists request (must mirror api/endpoints/lists).
const LIST_PROJECTION = {
  'list.fields': 'description,follower_count,member_count,private,owner_id',
  expansions: 'owner_id',
  'user.fields': 'username,name',
} as const;

// The member projection listMembers requests (mirrors api/endpoints/users USER_FIELDS).
const MEMBERS_PROJECTION = {
  'user.fields':
    'created_at,description,location,public_metrics,protected,url,verified,username,name',
} as const;

// The tweet projection listTimeline requests (mirrors api/endpoints/timelines).
const TIMELINE_FIELD_PARAMS = {
  'tweet.fields':
    'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id',
  expansions:
    'author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys',
  'user.fields': 'username,name,verified',
  'media.fields': 'type,url,preview_image_url,alt_text',
} as const;

// The user.fields projection the users-package resolvers request (users/me, by/username).
const USERS_PROJECTION = MEMBERS_PROJECTION;
// The lean projection the auth-package GET /2/users/me requests (selfUserId seam).
const AUTH_ME_QUERY = { 'user.fields': 'username,name' } as const;

/** The list id in test/fixtures/lists/single.json / owned-page.json. */
const LIST_ID = '1900000000000000001';
/** The authenticated user's id in test/fixtures/users/me.json (users projection). */
const USERS_ME_ID = '1526228120226357248';
/** The authenticated user's id in test/fixtures/auth/me.json (lean projection). */
const AUTH_ME_ID = '9';

/** Queue the lean `GET /2/users/me` the follow/pin writes start with (id "9"). */
function interceptAuthMe(mock: MockHttp): void {
  mock.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: AUTH_ME_QUERY })
    .reply(200, loadFixture<Record<string, unknown>>('auth/me.json'));
}

// The compact page shape the paginated handlers return, narrowed for asserts.
interface CompactPageResult {
  readonly items: readonly Record<string, unknown>[];
  readonly result_count: number;
  readonly next_token?: string;
  readonly note?: string;
}

// --- Contract axes (MCP-4, POL-5) -------------------------------------------------

test('listsTools exposes the ten merged list tools with the docs/03 axes (MCP-4)', () => {
  assert.deepEqual(
    listsTools.map((t) => t.name),
    [
      'x_list_create',
      'x_list_update',
      'x_list_delete',
      'x_list_get',
      'x_lists_owned',
      'x_list_member_set',
      'x_list_members',
      'x_list_timeline',
      'x_list_follow_set',
      'x_list_pin_set',
    ],
  );
  for (const tool of listsTools) {
    assert.equal(tool.phase, 3);
    assert.equal(tool.annotations.openWorldHint, true);
  }

  // Policy cells per docs/03.
  assert.equal(xListCreate.policy, 'write:content');
  assert.equal(xListUpdate.policy, 'write:content');
  assert.equal(xListMemberSet.policy, 'write:content');
  assert.equal(xListDelete.policy, 'destructive:content');
  assert.equal(xListFollowSet.policy, 'write:engagement');
  assert.equal(xListPinSet.policy, 'write:engagement');
  for (const tool of [xListGet, xListsOwned, xListMembers, xListTimeline]) {
    assert.equal(tool.policy, 'read:content');
    assert.equal(tool.availability, 'app+user');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.deepEqual([...tool.scopes], ['tweet.read', 'users.read', 'list.read']);
  }

  // Cost classes per docs/03.
  assert.equal(xListCreate.cost, 'w:list');
  assert.equal(xListGet.cost, 'r:list');
  assert.equal(xListsOwned.cost, 'owned');
  assert.equal(xListMembers.cost, 'r:user');
  assert.equal(xListTimeline.cost, 'r:post');
  for (const tool of [xListUpdate, xListDelete, xListMemberSet, xListFollowSet, xListPinSet]) {
    assert.equal(tool.cost, 'w:action');
  }

  // Writes: user-only, list.write scope, non-read annotations (MCP-4).
  const writes = [
    xListCreate,
    xListUpdate,
    xListDelete,
    xListMemberSet,
    xListFollowSet,
    xListPinSet,
  ];
  for (const tool of writes) {
    assert.equal(tool.availability, 'user-only');
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.deepEqual([...tool.scopes], ['tweet.read', 'users.read', 'list.write']);
  }
  // Reversible merged writes are idempotent, never destructive.
  for (const tool of [xListUpdate, xListMemberSet, xListFollowSet, xListPinSet]) {
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, true);
  }
  // Plain create: not destructive, and no idempotent claim (repeat calls create more lists).
  assert.equal(xListCreate.annotations.destructiveHint, false);
  assert.equal(xListCreate.annotations.idempotentHint, undefined);
});

test('POL-5: x_list_delete is standalone destructive:content — never behind an action enum', () => {
  assert.equal(xListDelete.policy, 'destructive:content');
  assert.equal(xListDelete.annotations.destructiveHint, true);
  assert.equal(xListDelete.annotations.idempotentHint, false);
  // Standalone: the input carries ONLY the list id; a smuggled `action` key is refused
  // (.strict()), so deletion can never hide behind an enum.
  assert.equal(xListDelete.input.safeParse({ list_id: '1' }).success, true);
  assert.equal(xListDelete.input.safeParse({ list_id: '1', action: 'delete' }).success, false);
});

// --- x_list_create ---------------------------------------------------------------

test('create: POST /2/lists with name/description/private, returns the new list id', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/lists',
      method: 'POST',
      body: '{"name":"AI builders","description":"People shipping agent tooling.","private":true}',
    })
    .reply(200, { data: { id: LIST_ID, name: 'AI builders' } });

  const out = await xListCreate.handler(
    { name: 'AI builders', description: 'People shipping agent tooling.', private: true },
    contextFor(mock),
  );

  assert.deepEqual(out.data, { list_id: LIST_ID, name: 'AI builders', private: true });
  assert.equal(out.summary, `Created list "AI builders" (id ${LIST_ID}).`);
  mock.assertDone();
  await mock.close();
});

test('DRIFT-1: create with an empty 2xx envelope still succeeds with an empty id', async () => {
  const mock = mockHttp();
  mock.pool.intercept({ path: '/2/lists', method: 'POST', body: '{"name":"Bare"}' }).reply(200, {});

  const out = await xListCreate.handler({ name: 'Bare' }, contextFor(mock));

  assert.deepEqual(out.data, { list_id: '', name: 'Bare', private: false });
  assert.equal(out.summary, 'Created list "Bare".');
  mock.assertDone();
  await mock.close();
});

// --- x_list_update ---------------------------------------------------------------

test('update: PUT /2/lists/:id sends only the provided fields; accepts a list URL (REND-8)', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: `/2/lists/${LIST_ID}`, method: 'PUT', body: '{"name":"Renamed"}' })
    .reply(200, { data: { updated: true } });

  // The list URL form normalizes to the canonical numeric id before the request.
  const out = await xListUpdate.handler(
    { list_id: `https://x.com/i/lists/${LIST_ID}`, name: 'Renamed' },
    contextFor(mock),
  );

  assert.deepEqual(out.data, { list_id: LIST_ID, updated: true });
  mock.assertDone();
  await mock.close();
});

test('update with no fields is a validation error before any request', async () => {
  await assert.rejects(
    () => xListUpdate.handler({ list_id: LIST_ID }, noHttpCtx()),
    isValidation(/at least one of name, description, or private/),
  );
});

// --- x_list_delete (POL-5: destructive, standalone) ------------------------------

test('POL-5: delete sends DELETE /2/lists/:id and reports the deleted state', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: `/2/lists/${LIST_ID}`, method: 'DELETE' })
    .reply(200, { data: { deleted: true } });

  const out = await xListDelete.handler({ list_id: LIST_ID }, contextFor(mock));

  assert.deepEqual(out.data, { list_id: LIST_ID, deleted: true });
  assert.equal(out.summary, `Deleted list ${LIST_ID}.`);
  mock.assertDone();
  await mock.close();
});

test('delete of a nonexistent list surfaces a typed not-found error', async () => {
  // Deliberately NOT the x_post_delete POST-5 already-deleted mapping: a missing list id
  // more often means a WRONG id than a repeated delete, so the not-found propagates.
  const fx = loadFixture<ErrorFixture>('errors/404-not-found.json');
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/lists/999', method: 'DELETE' })
    .reply(fx.status, fx.body as Record<string, unknown>, { headers: fx.headers });

  await assert.rejects(
    () => xListDelete.handler({ list_id: '999' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'not-found');
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

// --- x_list_get ------------------------------------------------------------------

test('get: GET /2/lists/:id renders the compact list with the owner handle', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: `/2/lists/${LIST_ID}`, method: 'GET', query: LIST_PROJECTION })
    .reply(200, loadFixture<RawSingleResponse<RawList>>('lists/single.json'));

  const out = await xListGet.handler({ list_id: LIST_ID }, contextFor(mock));

  assert.deepEqual(out.data, {
    id: LIST_ID,
    name: 'AI builders',
    description: 'People shipping agent tooling.',
    private: false,
    member_count: 42,
    follower_count: 7,
    owner: '@alice_dev',
  });
  assert.equal(out.summary, `List "AI builders" (id ${LIST_ID}).`);
  mock.assertDone();
  await mock.close();
});

test('REND-5: a list without owner includes renders with `owner` omitted, no crash', async () => {
  const fixture = loadFixture<RawSingleResponse<RawList>>('lists/single.json');
  const mock = mockHttp();
  // Same list object, but the `includes.users` expansion is missing from the envelope.
  mock.pool
    .intercept({ path: `/2/lists/${LIST_ID}`, method: 'GET', query: LIST_PROJECTION })
    .reply(200, { data: fixture.data });

  const out = await xListGet.handler({ list_id: LIST_ID }, contextFor(mock));
  const list = out.data as Record<string, unknown>;

  assert.equal(list['name'], 'AI builders');
  assert.ok(!('owner' in list), 'owner must be omitted when unresolvable');
  mock.assertDone();
  await mock.close();
});

test('REND-10: get with raw:true returns the exact API envelope', async () => {
  const fixture = loadFixture<RawSingleResponse<RawList>>('lists/single.json');
  const mock = mockHttp();
  mock.pool
    .intercept({ path: `/2/lists/${LIST_ID}`, method: 'GET', query: LIST_PROJECTION })
    .reply(200, fixture);

  const out = await xListGet.handler({ list_id: LIST_ID, raw: true }, contextFor(mock));

  assert.deepEqual(out.data, fixture); // exact envelope, includes and all
  // `raw` skips sanitization, so it must NOT skip the REND-6 warning too (T-320 F4).
  assert.equal(out.summary, `Raw list ${LIST_ID}. ${UNTRUSTED_CONTENT_NOTE}`);
  mock.assertDone();
  await mock.close();
});

// --- x_lists_owned ---------------------------------------------------------------

test('owned: user defaults to "me", renders a compact list page (REND-8/REND-6)', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<RawSingleResponse<RawUser>>('users/me.json'));
  mock.pool
    .intercept({
      path: `/2/users/${USERS_ME_ID}/owned_lists`,
      method: 'GET',
      query: LIST_PROJECTION,
    })
    .reply(200, loadFixture<RawListResponse<RawList>>('lists/owned-page.json'));

  const out = await xListsOwned.handler({}, contextFor(mock));
  const page = out.data as CompactPageResult;

  assert.equal(page.result_count, 2);
  assert.equal(page.next_token, 'owned-cursor-2');
  assert.equal(page.items[0]?.['owner'], '@alice_dev');
  assert.equal(page.items[1]?.['private'], true);
  assert.ok(page.note);
  assert.match(page.note, /third-party text/); // REND-6 untrusted-content note
  assert.equal(out.summary, '2 result(s), more available.');
  mock.assertDone();
  await mock.close();
});

test('REND-8/REND-1/PAGE-4: owned resolves a @handle; an empty page has the zero note and no next_token', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/users/by/username/BillGates', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<RawSingleResponse<RawUser>>('users/handle-lookup-hit.json'));
  mock.pool
    .intercept({ path: '/2/users/50393960/owned_lists', method: 'GET', query: LIST_PROJECTION })
    .reply(200, loadFixture<RawListResponse<RawList>>('lists/owned-empty.json'));

  const out = await xListsOwned.handler({ user: '@BillGates' }, contextFor(mock));
  const page = out.data as CompactPageResult;

  assert.equal(page.result_count, 0);
  assert.equal(page.next_token, undefined); // PAGE-4: last page omits the cursor entirely
  assert.equal(page.note, 'No results matched this query.'); // REND-1
  mock.assertDone();
  await mock.close();
});

test('REND-8: an unknown handle is not-found and the owned-lists read is never spent', async () => {
  const mock = mockHttp();
  // ONLY the handle lookup is queued: assertDone() proves no owned_lists request followed.
  mock.pool
    .intercept({ path: '/2/users/by/username/ghost', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<RawSingleResponse<RawUser>>('users/handle-lookup-miss.json'));

  await assert.rejects(
    () => xListsOwned.handler({ user: '@ghost' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err), 'expected an XError');
      assert.equal(err.kind, 'not-found');
      assert.match(err.message, /No X user found for handle "@ghost"/);
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

test('owned: a me response without an id maps to a typed api error', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: USERS_PROJECTION })
    .reply(200, {});

  await assert.rejects(
    () => xListsOwned.handler({}, contextFor(mock)),
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

// --- x_list_members --------------------------------------------------------------

test('PAGE-3: members clamps max_results above the 1-100 window down to 100 and notes it', async () => {
  const mock = mockHttp();
  // Intercept pins max_results=100 (clamped), not 150 (requested): a match proves the
  // clamp reached the wire, since undici string-compares the full sorted query.
  mock.pool
    .intercept({
      path: `/2/lists/${LIST_ID}/members`,
      method: 'GET',
      query: { ...MEMBERS_PROJECTION, max_results: '100' },
    })
    .reply(200, loadFixture<RawListResponse<RawUser>>('lists/members-page.json'));

  const out = await xListMembers.handler({ list_id: LIST_ID, max_results: 150 }, contextFor(mock));
  const page = out.data as CompactPageResult;

  assert.equal(page.result_count, 2);
  assert.equal(page.next_token, 'members-cursor-2');
  assert.equal(page.items[0]?.['handle'], '@alice_dev');
  assert.ok(page.note);
  assert.match(
    page.note,
    /max_results adjusted to 100 \(this endpoint accepts 1-100; requested 150\)/,
  );
  assert.match(page.note, /third-party text/); // clamp note is PREFIXED to the REND-6 note
  mock.assertDone();
  await mock.close();
});

test('members: a fractional max_results is a validation error before any request', async () => {
  await assert.rejects(
    () => xListMembers.handler({ list_id: LIST_ID, max_results: 10.5 }, noHttpCtx()),
    isValidation(/max_results must be a whole number/),
  );
});

// --- x_list_timeline -------------------------------------------------------------

test('PAGE-1: timeline sends page_token verbatim as pagination_token; posts carry canonical urls (REND-4)', async () => {
  // PAGE-2: the same `toCursor` bridge maps the tool's `page_token` to the v2
  // `pagination_token` request cursor and back to the response's `next_token`; a stale or
  // rejected cursor is surfaced as a typed `validation` error via core/paginate's
  // pageTokenError (covered in test/core/paginate.test.ts — api/errors has no
  // pagination-specific wire mapping to exercise here).
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: `/2/lists/${LIST_ID}/tweets`,
      method: 'GET',
      query: { ...TIMELINE_FIELD_PARAMS, pagination_token: 'cursor==abc' },
    })
    .reply(200, loadFixture<RawListResponse<RawTweet>>('search/recent-page.json'));

  const out = await xListTimeline.handler(
    { list_id: LIST_ID, page_token: 'cursor==abc' },
    contextFor(mock),
  );
  const page = out.data as CompactPageResult;

  assert.equal(page.result_count, 3);
  assert.equal(page.next_token, 'abc');
  // REND-4: every compact post carries the canonical status permalink.
  for (const item of page.items) {
    assert.match(String(item['url']), /^https:\/\/x\.com\/i\/status\/\d+$/);
  }
  assert.ok(page.note);
  assert.match(page.note, /third-party text/); // REND-6
  mock.assertDone();
  await mock.close();
});

test('REND-10: timeline raw:true returns the exact API JSON and caps max_results at 25', async () => {
  const fixture = loadFixture<RawListResponse<RawTweet>>('search/recent-page.json');
  const mock = mockHttp();
  // Pins max_results=25 (the raw ceiling), not 100 (requested).
  mock.pool
    .intercept({
      path: `/2/lists/${LIST_ID}/tweets`,
      method: 'GET',
      query: { ...TIMELINE_FIELD_PARAMS, max_results: '25' },
    })
    .reply(200, fixture);

  const out = await xListTimeline.handler(
    { list_id: LIST_ID, raw: true, max_results: 100 },
    contextFor(mock),
  );

  assert.deepEqual(out.data, fixture); // exact envelope, includes/meta and all
  assert.equal(out.summary, `3 raw result(s). ${UNTRUSTED_CONTENT_NOTE}`); // T-320 F4
  mock.assertDone();
  await mock.close();
});

// --- x_list_member_set -----------------------------------------------------------

test('member add: resolves the @handle then POSTs /2/lists/:id/members with user_id', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/users/by/username/BillGates', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<RawSingleResponse<RawUser>>('users/handle-lookup-hit.json'));
  mock.pool
    .intercept({
      path: `/2/lists/${LIST_ID}/members`,
      method: 'POST',
      body: '{"user_id":"50393960"}',
    })
    .reply(200, { data: { is_member: true } });

  const out = await xListMemberSet.handler(
    { list_id: LIST_ID, user: '@BillGates', action: 'add' },
    contextFor(mock),
  );

  assert.deepEqual(out.data, {
    list_id: LIST_ID,
    user_id: '50393960',
    action: 'add',
    is_member: true,
  });
  assert.equal(out.summary, `Added user 50393960 to list ${LIST_ID}.`);
  mock.assertDone();
  await mock.close();
});

test('member remove: a numeric user id passes through to DELETE /2/lists/:id/members/:user_id', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: `/2/lists/${LIST_ID}/members/101`, method: 'DELETE' })
    .reply(200, { data: { is_member: false } });

  const out = await xListMemberSet.handler(
    { list_id: LIST_ID, user: '101', action: 'remove' },
    contextFor(mock),
  );

  assert.deepEqual(out.data, {
    list_id: LIST_ID,
    user_id: '101',
    action: 'remove',
    is_member: false,
  });
  mock.assertDone();
  await mock.close();
});

// --- x_list_follow_set / x_list_pin_set ------------------------------------------

test('follow: GET /2/users/me then POST /2/users/:id/followed_lists with the list_id body', async () => {
  const mock = mockHttp();
  interceptAuthMe(mock);
  mock.pool
    .intercept({
      path: `/2/users/${AUTH_ME_ID}/followed_lists`,
      method: 'POST',
      body: `{"list_id":"${LIST_ID}"}`,
    })
    .reply(200, { data: { following: true } });

  const out = await xListFollowSet.handler(
    { list_id: LIST_ID, action: 'follow' },
    contextFor(mock),
  );

  assert.deepEqual(out.data, { list_id: LIST_ID, action: 'follow', following: true });
  assert.equal(out.summary, `Followed list ${LIST_ID}.`);
  mock.assertDone();
  await mock.close();
});

test('unfollow: DELETE /2/users/:id/followed_lists/:list_id', async () => {
  const mock = mockHttp();
  interceptAuthMe(mock);
  mock.pool
    .intercept({ path: `/2/users/${AUTH_ME_ID}/followed_lists/${LIST_ID}`, method: 'DELETE' })
    .reply(200, { data: { following: false } });

  const out = await xListFollowSet.handler(
    { list_id: LIST_ID, action: 'unfollow' },
    contextFor(mock),
  );

  assert.deepEqual(out.data, { list_id: LIST_ID, action: 'unfollow', following: false });
  mock.assertDone();
  await mock.close();
});

test('pin/unpin: POST and DELETE /2/users/:id/pinned_lists', async () => {
  const mock = mockHttp();
  interceptAuthMe(mock);
  mock.pool
    .intercept({
      path: `/2/users/${AUTH_ME_ID}/pinned_lists`,
      method: 'POST',
      body: `{"list_id":"${LIST_ID}"}`,
    })
    .reply(200, { data: { pinned: true } });
  const pinOut = await xListPinSet.handler({ list_id: LIST_ID, action: 'pin' }, contextFor(mock));
  assert.deepEqual(pinOut.data, { list_id: LIST_ID, action: 'pin', pinned: true });

  interceptAuthMe(mock);
  mock.pool
    .intercept({ path: `/2/users/${AUTH_ME_ID}/pinned_lists/${LIST_ID}`, method: 'DELETE' })
    .reply(200, { data: { pinned: false } });
  const unpinOut = await xListPinSet.handler(
    { list_id: LIST_ID, action: 'unpin' },
    contextFor(mock),
  );
  assert.deepEqual(unpinOut.data, { list_id: LIST_ID, action: 'unpin', pinned: false });
  assert.equal(unpinOut.summary, `Unpinned list ${LIST_ID}.`);
  mock.assertDone();
  await mock.close();
});

// --- DRIFT-1 across the write family ---------------------------------------------

test('DRIFT-1: empty 2xx envelopes fall back to the requested state across the list writes', async () => {
  const mock = mockHttp();

  mock.pool
    .intercept({ path: `/2/lists/${LIST_ID}`, method: 'PUT', body: '{"private":true}' })
    .reply(200, {});
  const upd = await xListUpdate.handler({ list_id: LIST_ID, private: true }, contextFor(mock));
  assert.deepEqual(upd.data, { list_id: LIST_ID, updated: true });

  mock.pool.intercept({ path: `/2/lists/${LIST_ID}`, method: 'DELETE' }).reply(200, {});
  const del = await xListDelete.handler({ list_id: LIST_ID }, contextFor(mock));
  assert.deepEqual(del.data, { list_id: LIST_ID, deleted: true });

  mock.pool
    .intercept({ path: `/2/lists/${LIST_ID}/members`, method: 'POST', body: '{"user_id":"101"}' })
    .reply(200, {});
  const mem = await xListMemberSet.handler(
    { list_id: LIST_ID, user: '101', action: 'add' },
    contextFor(mock),
  );
  assert.deepEqual(mem.data, {
    list_id: LIST_ID,
    user_id: '101',
    action: 'add',
    is_member: true,
  });

  interceptAuthMe(mock);
  mock.pool
    .intercept({
      path: `/2/users/${AUTH_ME_ID}/followed_lists`,
      method: 'POST',
      body: `{"list_id":"${LIST_ID}"}`,
    })
    .reply(200, {});
  const fol = await xListFollowSet.handler(
    { list_id: LIST_ID, action: 'follow' },
    contextFor(mock),
  );
  assert.deepEqual(fol.data, { list_id: LIST_ID, action: 'follow', following: true });

  interceptAuthMe(mock);
  mock.pool
    .intercept({ path: `/2/users/${AUTH_ME_ID}/pinned_lists/${LIST_ID}`, method: 'DELETE' })
    .reply(200, {});
  const pin = await xListPinSet.handler({ list_id: LIST_ID, action: 'unpin' }, contextFor(mock));
  assert.deepEqual(pin.data, { list_id: LIST_ID, action: 'unpin', pinned: false });

  mock.assertDone();
  await mock.close();
});

// --- Normalization before HTTP (REND-8) ------------------------------------------

test('REND-8: malformed list references are validation errors before any request', async () => {
  await assert.rejects(
    () => xListGet.handler({ list_id: 'not a list!!' }, noHttpCtx()),
    isValidation(/Not a recognized X list id or list URL/),
  );
  await assert.rejects(
    () => xListDelete.handler({ list_id: '@somehandle' }, noHttpCtx()),
    isValidation(/Not a recognized X list id or list URL/),
  );
  await assert.rejects(
    () => xListTimeline.handler({ list_id: '   ' }, noHttpCtx()),
    isValidation(/Empty list reference/),
  );
  // An overlong garbage value is echoed truncated (77 chars + '...'), never verbatim.
  await assert.rejects(
    () => xListGet.handler({ list_id: `garbage-${'x'.repeat(100)}` }, noHttpCtx()),
    isValidation(/garbage-x{69}\.\.\./),
  );
  // A profile URL is not a list reference.
  await assert.rejects(
    () => xListMembers.handler({ list_id: 'https://x.com/some_user' }, noHttpCtx()),
    isValidation(/Not a recognized X list id or list URL/),
  );
});

test('REND-8: a malformed member reference is a validation error before any request', async () => {
  await assert.rejects(
    () =>
      xListMemberSet.handler(
        { list_id: LIST_ID, user: 'not a user!!', action: 'add' },
        noHttpCtx(),
      ),
    isValidation(/Not a recognized X user id/),
  );
});

// --- Auth seam failures (writes abort before the list call) ----------------------

test('a failing GET /2/users/me aborts BEFORE the follow write: auth error, no write sent', async () => {
  const fx = loadFixture<ErrorFixture>('errors/401-invalid-token.json');
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: AUTH_ME_QUERY })
    .reply(fx.status, fx.body as Record<string, unknown>, { headers: fx.headers });

  await assert.rejects(
    () => xListFollowSet.handler({ list_id: LIST_ID, action: 'follow' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'auth');
      return true;
    },
  );
  // assertDone: the me-interceptor was the ONLY request — no followed_lists call went out.
  mock.assertDone();
  await mock.close();
});

test('pin: a me-response without an id yields a typed api error and sends no write', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: AUTH_ME_QUERY })
    .reply(200, { data: {} });

  await assert.rejects(
    () => xListPinSet.handler({ list_id: LIST_ID, action: 'pin' }, contextFor(mock)),
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

// --- Error mapping on reads ------------------------------------------------------

test('members of a private list without access surface a typed forbidden error', async () => {
  const fx = loadFixture<ErrorFixture>('errors/403-suspended-target.json');
  const mock = mockHttp();
  mock.pool
    .intercept({ path: `/2/lists/${LIST_ID}/members`, method: 'GET', query: MEMBERS_PROJECTION })
    .reply(fx.status, fx.body as Record<string, unknown>, { headers: fx.headers });

  await assert.rejects(
    () => xListMembers.handler({ list_id: LIST_ID }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'forbidden');
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

// --- Input schema boundaries (.strict()) -----------------------------------------

test('input schemas: strict shapes, name/description caps, enum vocabulary', () => {
  // .strict(): unknown keys are refused, not silently dropped.
  assert.equal(xListCreate.input.safeParse({ name: 'ok', extra: 1 }).success, false);
  assert.equal(
    xListMemberSet.input.safeParse({ list_id: '1', user: '2', action: 'add', force: true }).success,
    false,
  );

  // Name and description caps (X limits: 25 / 100 chars).
  assert.equal(xListCreate.input.safeParse({ name: '' }).success, false);
  assert.equal(xListCreate.input.safeParse({ name: 'x'.repeat(26) }).success, false);
  assert.equal(xListCreate.input.safeParse({ name: 'x'.repeat(25) }).success, true);
  assert.equal(
    xListUpdate.input.safeParse({ list_id: '1', description: 'x'.repeat(101) }).success,
    false,
  );

  // Enum vocabulary is closed per tool.
  assert.equal(
    xListMemberSet.input.safeParse({ list_id: '1', user: '2', action: 'invite' }).success,
    false,
  );
  assert.equal(xListFollowSet.input.safeParse({ list_id: '1', action: 'pin' }).success, false);
  assert.equal(xListPinSet.input.safeParse({ list_id: '1', action: 'follow' }).success, false);

  // The happy shapes parse.
  assert.equal(xListCreate.input.safeParse({ name: 'ok', private: true }).success, true);
  assert.equal(xListUpdate.input.safeParse({ list_id: '1', name: 'renamed' }).success, true);
  assert.equal(
    xListMemberSet.input.safeParse({ list_id: '1', user: '@a', action: 'remove' }).success,
    true,
  );
  assert.equal(xListFollowSet.input.safeParse({ list_id: '1', action: 'unfollow' }).success, true);
  assert.equal(xListPinSet.input.safeParse({ list_id: '1', action: 'unpin' }).success, true);
  assert.equal(
    xListsOwned.input.safeParse({ user: 'me', max_results: 50, page_token: 't', raw: true })
      .success,
    true,
  );
  assert.equal(
    xListTimeline.input.safeParse({ list_id: '1', max_results: 10, page_token: 'abc' }).success,
    true,
  );
});
