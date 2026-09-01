// Tests for the social-graph tools (T-301): x_follow_set / x_mute_set / x_block_set and
// x_followers_list / x_following_list / x_user_search. Each network test builds a REAL
// http client (api/http) over an undici MockAgent and drives the handler end to end:
// target/user resolution (REND-8) -> GET /2/users/me (the AUTH-15 "who am I" seam) -> the
// graph request -> compact output. Interceptors pin exact paths, methods, queries, and
// JSON bodies, so they stub AND assert the wire contract.
//
// undici 6.x matches an interceptor by string-comparing its `path` (with `query` merged in
// and the params sorted) against the incoming request's full path+query (also sorted), so
// every GET intercept below pins the EXACT query the endpoint wrapper puts on the wire —
// the PAGE-3 tests in particular pin the CLAMPED max_results, not the requested one.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mapHttpError } from '../../src/api/errors.js';
import { createHttpClient } from '../../src/api/http.js';
import { XError } from '../../src/core/errors.js';
import { UNTRUSTED_CONTENT_NOTE } from '../../src/core/render.js';
import type { RawListResponse, RawSingleResponse, RawUser } from '../../src/core/render.js';
import type { ToolContext } from '../../src/core/tooldef.js';
import {
  graphTools,
  xBlockSet,
  xFollowSet,
  xFollowersList,
  xFollowingList,
  xMuteSet,
  xUserSearch,
} from '../../src/tools/graph.js';

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

/** Queue the `GET /2/users/me` interceptor every self-addressed call starts with (id "9"). */
function interceptMe(mock: MockHttp): void {
  mock.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: { 'user.fields': 'username,name' } })
    .reply(200, loadFixture<Record<string, unknown>>('auth/me.json'));
}

// The user.fields projection every graph read and handle lookup carries (must mirror
// api/endpoints/graph and api/endpoints/users). undici sorts params before comparing.
const USERS_PROJECTION = {
  'user.fields':
    'created_at,description,location,public_metrics,protected,url,verified,username,name',
} as const;

// The compact page the list handlers return (a Page<CompactUser>, narrowed for asserts).
interface CompactPageResult {
  readonly items: readonly { readonly id: string; readonly handle: string }[];
  readonly result_count: number;
  readonly next_token?: string;
  readonly note?: string;
}

/** assert.rejects predicate for a typed `validation` XError matching `re`. */
function isValidation(re: RegExp) {
  return (err: unknown) => {
    assert.ok(XError.is(err));
    assert.equal(err.kind, 'validation');
    assert.match(err.message, re);
    return true;
  };
}

// --- Contract axes (MCP-4 / COST-3 / POL-5) ---------------------------------------

test('graphTools exposes the six graph tools with the catalog axes (MCP-4/COST-3)', () => {
  assert.deepEqual(graphTools, [
    xFollowSet,
    xMuteSet,
    xBlockSet,
    xFollowersList,
    xFollowingList,
    xUserSearch,
  ]);
  assert.equal(xFollowSet.name, 'x_follow_set');
  assert.equal(xMuteSet.name, 'x_mute_set');
  assert.equal(xBlockSet.name, 'x_block_set');
  assert.equal(xFollowersList.name, 'x_followers_list');
  assert.equal(xFollowingList.name, 'x_following_list');
  assert.equal(xUserSearch.name, 'x_user_search');
  for (const tool of graphTools) {
    assert.equal(tool.phase, 3);
    assert.equal(tool.annotations.openWorldHint, true);
  }

  // The three writes: user-only w:action toggles; MCP-4 — annotations mirror the policy
  // cell, so follow/mute are non-destructive and block alone carries destructiveHint.
  for (const tool of [xFollowSet, xMuteSet, xBlockSet]) {
    assert.equal(tool.availability, 'user-only');
    assert.equal(tool.cost, 'w:action');
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.idempotentHint, true);
  }
  assert.equal(xFollowSet.policy, 'write:social-graph');
  assert.equal(xFollowSet.annotations.destructiveHint, false);
  assert.equal(xMuteSet.policy, 'write:social-graph');
  assert.equal(xMuteSet.annotations.destructiveHint, false);
  // POL-5: block is the one destructive tool that merges create/delete — the reversible
  // block/unblock pair stays a single toggle, but in the destructive cell.
  assert.equal(xBlockSet.policy, 'destructive:social-graph');
  assert.equal(xBlockSet.annotations.destructiveHint, true);
  assert.deepEqual([...xFollowSet.scopes], ['tweet.read', 'users.read', 'follows.write']);
  assert.deepEqual([...xMuteSet.scopes], ['tweet.read', 'users.read', 'mute.write']);
  assert.deepEqual([...xBlockSet.scopes], ['tweet.read', 'users.read', 'block.write']);

  // The reads: compact-page list tools, readable in app or user mode.
  for (const tool of [xFollowersList, xFollowingList, xUserSearch]) {
    assert.equal(tool.availability, 'app+user');
    assert.equal(tool.annotations.readOnlyHint, true);
  }
  assert.equal(xFollowersList.policy, 'read:social-graph');
  assert.equal(xFollowersList.cost, 'r:follows');
  assert.equal(xFollowingList.policy, 'read:social-graph');
  assert.equal(xFollowingList.cost, 'r:follows');
  assert.deepEqual([...xFollowersList.scopes], ['tweet.read', 'users.read', 'follows.read']);
  assert.deepEqual([...xFollowingList.scopes], ['tweet.read', 'users.read', 'follows.read']);
  // COST-3: x_user_search registers by default at the paid r:user cost class — the
  // registry's budget pipeline meters it per call instead of hiding the tool.
  assert.equal(xUserSearch.policy, 'read:user');
  assert.equal(xUserSearch.cost, 'r:user');
  assert.deepEqual([...xUserSearch.scopes], ['tweet.read', 'users.read']);
});

// --- x_follow_set -----------------------------------------------------------------

test('follow: POST /2/users/me-id/following with the target_user_id body', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/following', method: 'POST', body: '{"target_user_id":"34"}' })
    .reply(200, { data: { following: true, pending_follow: false } });

  const out = await xFollowSet.handler({ user: '34', action: 'follow' }, contextFor(mock));
  assert.deepEqual(out.data, { user_id: '34', action: 'follow', following: true });
  assert.equal(out.summary, 'Followed user 34.');
  mock.assertDone();
  await mock.close();
});

test('follow of a protected target reports pending_follow (approval pending)', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/following', method: 'POST', body: '{"target_user_id":"34"}' })
    .reply(200, { data: { following: false, pending_follow: true } });

  const out = await xFollowSet.handler({ user: '34', action: 'follow' }, contextFor(mock));
  assert.deepEqual(out.data, {
    user_id: '34',
    action: 'follow',
    following: false,
    pending_follow: true,
  });
  assert.equal(out.summary, 'Requested to follow user 34 (approval pending).');
  mock.assertDone();
  await mock.close();
});

test('unfollow: DELETE /2/users/me-id/following/:target reports following: false', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/following/34', method: 'DELETE' })
    .reply(200, { data: { following: false } });

  const out = await xFollowSet.handler({ user: '34', action: 'unfollow' }, contextFor(mock));
  assert.deepEqual(out.data, { user_id: '34', action: 'unfollow', following: false });
  assert.equal(out.summary, 'Unfollowed user 34.');
  mock.assertDone();
  await mock.close();
});

// --- x_mute_set -------------------------------------------------------------------

test('mute/unmute: POST and DELETE /2/users/me-id/muting report the muting state', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/muting', method: 'POST', body: '{"target_user_id":"12"}' })
    .reply(200, { data: { muting: true } });
  const muteOut = await xMuteSet.handler({ user: '12', action: 'mute' }, contextFor(mock));
  assert.deepEqual(muteOut.data, { user_id: '12', action: 'mute', muting: true });
  assert.equal(muteOut.summary, 'Muted user 12.');

  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/muting/12', method: 'DELETE' })
    .reply(200, { data: { muting: false } });
  const unmuteOut = await xMuteSet.handler({ user: '12', action: 'unmute' }, contextFor(mock));
  assert.deepEqual(unmuteOut.data, { user_id: '12', action: 'unmute', muting: false });
  assert.equal(unmuteOut.summary, 'Unmuted user 12.');

  mock.assertDone();
  await mock.close();
});

// --- x_block_set ------------------------------------------------------------------

test('POL-5: block and unblock merge in one destructive toggle, both directions on the wire', async () => {
  // POL-5: block/unblock is reversible, so it merges into a single `_set` toggle — but
  // BOTH directions run under the destructive:social-graph cell's per-call confirmation.
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/blocking', method: 'POST', body: '{"target_user_id":"12"}' })
    .reply(200, { data: { blocking: true } });
  const blockOut = await xBlockSet.handler({ user: '12', action: 'block' }, contextFor(mock));
  assert.deepEqual(blockOut.data, { user_id: '12', action: 'block', blocking: true });
  assert.equal(blockOut.summary, 'Blocked user 12.');

  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/blocking/12', method: 'DELETE' })
    .reply(200, { data: { blocking: false } });
  const unblockOut = await xBlockSet.handler({ user: '12', action: 'unblock' }, contextFor(mock));
  assert.deepEqual(unblockOut.data, { user_id: '12', action: 'unblock', blocking: false });
  assert.equal(unblockOut.summary, 'Unblocked user 12.');

  mock.assertDone();
  await mock.close();
});

// --- DRIFT-1 ----------------------------------------------------------------------

test('DRIFT-1: a 2xx envelope without data falls back to the requested state (all three)', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/following', method: 'POST', body: '{"target_user_id":"34"}' })
    .reply(200, {});
  const followOut = await xFollowSet.handler({ user: '34', action: 'follow' }, contextFor(mock));
  assert.equal((followOut.data as { following: boolean }).following, true);

  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/muting', method: 'POST', body: '{"target_user_id":"12"}' })
    .reply(200, {});
  const muteOut = await xMuteSet.handler({ user: '12', action: 'mute' }, contextFor(mock));
  assert.equal((muteOut.data as { muting: boolean }).muting, true);

  interceptMe(mock);
  mock.pool.intercept({ path: '/2/users/9/blocking/12', method: 'DELETE' }).reply(200, {});
  const unblockOut = await xBlockSet.handler({ user: '12', action: 'unblock' }, contextFor(mock));
  assert.equal((unblockOut.data as { blocking: boolean }).blocking, false);

  mock.assertDone();
  await mock.close();
});

// --- Target resolution (REND-8) ----------------------------------------------------

test('REND-8: a handle target resolves to its id before the write is addressed', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/users/by/username/BillGates', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<RawSingleResponse<RawUser>>('users/handle-lookup-hit.json'));
  interceptMe(mock);
  mock.pool
    .intercept({
      path: '/2/users/9/following',
      method: 'POST',
      body: '{"target_user_id":"50393960"}',
    })
    .reply(200, { data: { following: true } });

  const out = await xFollowSet.handler({ user: '@BillGates', action: 'follow' }, contextFor(mock));
  assert.equal((out.data as { user_id: string }).user_id, '50393960');
  mock.assertDone();
  await mock.close();
});

test('REND-8: "me" as the write target rejects before ANY request (validation)', async () => {
  // Follow/mute/block act on ANOTHER account; the stub invoker rejects loudly, so a
  // passing test proves neither GET /2/users/me nor the write was ever attempted.
  for (const [tool, action] of [
    [xFollowSet, 'follow'],
    [xMuteSet, 'mute'],
    [xBlockSet, 'block'],
  ] as const) {
    await assert.rejects(
      () => tool.handler({ user: 'me', action } as never, noHttpCtx()),
      isValidation(/cannot be "me"/),
    );
  }
});

test('REND-8: a malformed write target rejects before ANY request (validation)', async () => {
  await assert.rejects(
    () => xFollowSet.handler({ user: 'not a user!!!', action: 'follow' }, noHttpCtx()),
    isValidation(/Not a recognized X user id/),
  );
  // A post URL is a valid X URL but not a user reference — still refused with no spend.
  await assert.rejects(
    () => xBlockSet.handler({ user: 'https://x.com/u/status/1', action: 'block' }, noHttpCtx()),
    isValidation(/post URL, not a user reference/),
  );
});

test('an unknown handle target is a not-found; neither the self-lookup nor the write is sent', async () => {
  const mock = mockHttp();
  // ONLY the handle lookup is queued: assertDone proves the write path stopped there.
  mock.pool
    .intercept({ path: '/2/users/by/username/ghost', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<Record<string, unknown>>('users/handle-lookup-miss.json'));

  await assert.rejects(
    () => xMuteSet.handler({ user: '@ghost', action: 'mute' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'not-found');
      assert.match(err.message, /@ghost/);
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
    () => xFollowSet.handler({ user: '34', action: 'follow' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'auth');
      return true;
    },
  );
  // assertDone: the me-interceptor was the ONLY request — no following call went out.
  mock.assertDone();
  await mock.close();
});

test('a me-response without an id yields a typed api error and sends no write', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: { 'user.fields': 'username,name' } })
    .reply(200, { data: {} });

  await assert.rejects(
    () => xBlockSet.handler({ user: '12', action: 'block' }, contextFor(mock)),
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

// --- x_followers_list / x_following_list ------------------------------------------

test('x_followers_list: ONE GET renders a compact user page (PAGE-5/REND-6)', async () => {
  const mock = mockHttp();
  // PAGE-5: exactly one page request per call — the single interceptor plus assertDone
  // proves the handler never auto-paginated toward the returned next_token.
  mock.pool
    .intercept({ path: '/2/users/12/followers', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<RawListResponse<RawUser>>('graph/followers-page.json'));

  const out = await xFollowersList.handler({ user: '12' }, contextFor(mock));
  const page = out.data as CompactPageResult;
  assert.equal(page.result_count, 2);
  assert.deepEqual(
    page.items.map((u) => u.id),
    ['12', '34'],
  );
  assert.deepEqual(
    page.items.map((u) => u.handle),
    ['@NASA', '@BillGates'],
  );
  assert.equal(page.next_token, 'graph-cursor-7');
  assert.ok(page.note);
  assert.match(page.note, /third-party text/); // REND-6 untrusted-content note
  assert.equal(out.summary, '2 result(s), more available.');
  mock.assertDone();
  await mock.close();
});

test('PAGE-3: x_followers_list clamps max_results above the window down to 1000 and notes it', async () => {
  const mock = mockHttp();
  // Intercept pins max_results=1000 (clamped), not 2000 (requested): a match proves the
  // clamp reached the wire.
  mock.pool
    .intercept({
      path: '/2/users/12/followers',
      method: 'GET',
      query: { ...USERS_PROJECTION, max_results: '1000' },
    })
    .reply(200, loadFixture<RawListResponse<RawUser>>('graph/followers-page.json'));

  const out = await xFollowersList.handler({ user: '12', max_results: 2000 }, contextFor(mock));
  const page = out.data as CompactPageResult;
  assert.ok(page.note);
  assert.match(page.note, /max_results adjusted to 1000/);
  assert.match(page.note, /requested 2000/);
  mock.assertDone();
  await mock.close();
});

test('PAGE-3: x_following_list clamps max_results below the window up to 1 and notes it', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/users/34/following',
      method: 'GET',
      query: { ...USERS_PROJECTION, max_results: '1' },
    })
    .reply(200, loadFixture<RawListResponse<RawUser>>('graph/followers-page.json'));

  const out = await xFollowingList.handler({ user: '34', max_results: 0 }, contextFor(mock));
  const page = out.data as CompactPageResult;
  assert.ok(page.note);
  assert.match(page.note, /max_results adjusted to 1 /);
  mock.assertDone();
  await mock.close();
});

test('PAGE-1/PAGE-4/REND-1: page_token rides verbatim as pagination_token; the empty last page', async () => {
  const mock = mockHttp();
  // PAGE-1: the cursor round-trips verbatim into the v2 `pagination_token` request param.
  mock.pool
    .intercept({
      path: '/2/users/12/followers',
      method: 'GET',
      query: { ...USERS_PROJECTION, pagination_token: 'graph-cursor-7' },
    })
    .reply(200, loadFixture<RawListResponse<RawUser>>('graph/followers-empty.json'));

  const out = await xFollowersList.handler(
    { user: '12', page_token: 'graph-cursor-7' },
    contextFor(mock),
  );
  const page = out.data as CompactPageResult;
  assert.equal(page.result_count, 0); // PAGE-4: the last page…
  assert.equal(page.next_token, undefined); // …omits next_token entirely (never null).
  assert.equal(page.note, 'No results matched this query.'); // REND-1 zero-results note
  assert.equal(out.summary, '0 result(s).');
  mock.assertDone();
  await mock.close();
});

test('REND-5: a degraded follower entry keeps its id and renders an empty handle', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/users/12/followers', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<RawListResponse<RawUser>>('graph/followers-degraded.json'));

  const out = await xFollowersList.handler({ user: '12' }, contextFor(mock));
  const page = out.data as CompactPageResult;
  // REND-5: a projection-degraded entry (id only) is kept, never dropped or fabricated.
  assert.deepEqual(page.items, [{ id: '777', handle: '' }]);
  mock.assertDone();
  await mock.close();
});

test('REND-8: x_followers_list resolves "me" via GET /2/users/me', async () => {
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/followers', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<RawListResponse<RawUser>>('graph/followers-empty.json'));

  const out = await xFollowersList.handler({ user: 'me' }, contextFor(mock));
  assert.equal((out.data as CompactPageResult).result_count, 0);
  mock.assertDone();
  await mock.close();
});

test('REND-8: a handle list user resolves via the username lookup; an unknown one is not-found', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/users/by/username/BillGates', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<RawSingleResponse<RawUser>>('users/handle-lookup-hit.json'));
  mock.pool
    .intercept({ path: '/2/users/50393960/following', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<RawListResponse<RawUser>>('graph/followers-empty.json'));
  const out = await xFollowingList.handler({ user: '@BillGates' }, contextFor(mock));
  assert.equal((out.data as CompactPageResult).result_count, 0);
  mock.assertDone();

  // Unknown handle: only the lookup goes out — the follows read is never spent.
  mock.pool
    .intercept({ path: '/2/users/by/username/ghost', method: 'GET', query: USERS_PROJECTION })
    .reply(200, loadFixture<Record<string, unknown>>('users/handle-lookup-miss.json'));
  await assert.rejects(
    () => xFollowersList.handler({ user: '@ghost' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'not-found');
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

test('REND-10: raw:true returns the exact API JSON and caps max_results at 25', async () => {
  const mock = mockHttp();
  const fixture = loadFixture<RawListResponse<RawUser>>('graph/followers-page.json');
  // Pins max_results=25 (the raw ceiling), not 100 (requested).
  mock.pool
    .intercept({
      path: '/2/users/12/followers',
      method: 'GET',
      query: { ...USERS_PROJECTION, max_results: '25' },
    })
    .reply(200, fixture);

  const out = await xFollowersList.handler(
    { user: '12', raw: true, max_results: 100 },
    contextFor(mock),
  );
  assert.deepEqual(out.data, fixture); // the exact envelope, not the compact page
  assert.equal(out.summary, `2 raw result(s). ${UNTRUSTED_CONTENT_NOTE}`); // T-320 F4
  mock.assertDone();
  await mock.close();
});

test('x_following_list: cursor rides as pagination_token; raw without max_results sends no cap', async () => {
  const mock = mockHttp();
  // PAGE-1: the following read bridges page_token to pagination_token like the followers
  // read does; REND-10: a raw call with no requested size puts NO max_results on the wire.
  // The intercept pins exactly the projection + cursor and nothing else.
  const envelope = { meta: { result_count: 0 } };
  mock.pool
    .intercept({
      path: '/2/users/12/following',
      method: 'GET',
      query: { ...USERS_PROJECTION, pagination_token: 'graph-cursor-7' },
    })
    .reply(200, envelope);

  const out = await xFollowingList.handler(
    { user: '12', page_token: 'graph-cursor-7', raw: true },
    contextFor(mock),
  );

  // DRIFT-1: a data-less envelope still summarizes as 0 rather than crashing.
  assert.deepEqual(out.data, envelope);
  assert.equal(out.summary, `0 raw result(s). ${UNTRUSTED_CONTENT_NOTE}`);
  mock.assertDone();
  await mock.close();
});

// --- x_user_search ----------------------------------------------------------------

test('x_user_search: one GET renders a compact user page (REND-6/COST-3)', async () => {
  // COST-3: the tool registers by default; its r:user cost class is what the registry's
  // budget pipeline meters — nothing in the handler special-cases spend.
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/users/search',
      method: 'GET',
      query: { query: 'space agency', ...USERS_PROJECTION },
    })
    .reply(200, loadFixture<RawListResponse<RawUser>>('graph/user-search-page.json'));

  const out = await xUserSearch.handler({ query: 'space agency' }, contextFor(mock));
  const page = out.data as CompactPageResult;
  assert.equal(page.result_count, 1);
  assert.deepEqual(
    page.items.map((u) => u.handle),
    ['@NASA'],
  );
  assert.equal(page.next_token, 'user-search-cursor-3');
  assert.ok(page.note);
  assert.match(page.note, /third-party text/); // REND-6
  assert.equal(out.summary, '1 result(s), more available.');
  mock.assertDone();
  await mock.close();
});

test('PAGE-1/PAGE-3: x_user_search sends the cursor as next_token and clamps 5000 to 1000', async () => {
  const mock = mockHttp();
  // This endpoint's REQUEST cursor is `next_token` (unlike the lists' `pagination_token`)
  // — the pin proves the wire name — and max_results pins the clamped 1000.
  mock.pool
    .intercept({
      path: '/2/users/search',
      method: 'GET',
      query: {
        query: 'nasa',
        ...USERS_PROJECTION,
        max_results: '1000',
        next_token: 'user-search-cursor-3',
      },
    })
    .reply(200, loadFixture<RawListResponse<RawUser>>('graph/followers-empty.json'));

  const out = await xUserSearch.handler(
    { query: 'nasa', max_results: 5000, page_token: 'user-search-cursor-3' },
    contextFor(mock),
  );
  const page = out.data as CompactPageResult;
  assert.equal(page.result_count, 0);
  assert.ok(page.note);
  assert.match(page.note, /max_results adjusted to 1000/);
  assert.match(page.note, /No results matched this query\./); // REND-1 after the clamp note
  mock.assertDone();
  await mock.close();
});

// --- Input schema boundary --------------------------------------------------------

test('input schemas: unknown action, empty refs, fractional max_results, extra keys all reject', () => {
  // Wrong action enum value (each tool has its own verb pair).
  assert.equal(xFollowSet.input.safeParse({ user: '1', action: 'mute' }).success, false);
  assert.equal(xMuteSet.input.safeParse({ user: '1', action: 'block' }).success, false);
  assert.equal(xBlockSet.input.safeParse({ user: '1', action: 'unfollow' }).success, false);

  // Missing / empty user or query.
  assert.equal(xFollowSet.input.safeParse({ action: 'follow' }).success, false);
  assert.equal(xFollowersList.input.safeParse({ user: '' }).success, false);
  assert.equal(xUserSearch.input.safeParse({ query: '' }).success, false);
  assert.equal(xUserSearch.input.safeParse({}).success, false);

  // Fractional max_results is refused at the schema (.int()), before the handler runs.
  assert.equal(xFollowersList.input.safeParse({ user: '1', max_results: 1.5 }).success, false);

  // .strict(): unknown keys are refused, not silently dropped.
  assert.equal(
    xBlockSet.input.safeParse({ user: '1', action: 'block', reason: 'spam' }).success,
    false,
  );
  assert.equal(xFollowingList.input.safeParse({ user: '1', page: 2 }).success, false);

  // The happy shapes parse.
  assert.equal(xFollowSet.input.safeParse({ user: '@jack', action: 'unfollow' }).success, true);
  assert.equal(xMuteSet.input.safeParse({ user: '12', action: 'unmute' }).success, true);
  assert.equal(xBlockSet.input.safeParse({ user: '12', action: 'unblock' }).success, true);
  assert.equal(
    xFollowersList.input.safeParse({ user: 'me', max_results: 50, raw: true }).success,
    true,
  );
  assert.equal(xUserSearch.input.safeParse({ query: 'nasa', page_token: 'abc' }).success, true);
});

// --- Error mapping ----------------------------------------------------------------

test('block of a suspended target surfaces a typed forbidden error', async () => {
  const fx = loadFixture<ErrorFixture>('errors/403-suspended-target.json');
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/blocking', method: 'POST', body: '{"target_user_id":"12"}' })
    .reply(fx.status, fx.body as Record<string, unknown>, { headers: fx.headers });

  await assert.rejects(
    () => xBlockSet.handler({ user: '12', action: 'block' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'forbidden');
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

test('followers of a nonexistent user surface a typed not-found error', async () => {
  // A 404 is NOT retryable, so a single GET interceptor is safe (unlike a 429, which the
  // http client would retry on a GET).
  const fx = loadFixture<ErrorFixture>('errors/404-not-found.json');
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/users/404404/followers', method: 'GET', query: USERS_PROJECTION })
    .reply(fx.status, fx.body as Record<string, unknown>, { headers: fx.headers });

  await assert.rejects(
    () => xFollowersList.handler({ user: '404404' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'not-found');
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

test('a rate-limited mute surfaces a typed rate-limit error; the write is NOT retried', async () => {
  // RATE-5/NET-4: writes are never auto-retried, so the single 429 interceptor both stubs
  // the response and asserts exactly one POST went out.
  const fx = loadFixture<ErrorFixture>('errors/429-rate-limit.json');
  const mock = mockHttp();
  interceptMe(mock);
  mock.pool
    .intercept({ path: '/2/users/9/muting', method: 'POST', body: '{"target_user_id":"12"}' })
    .reply(fx.status, fx.body as Record<string, unknown>, { headers: fx.headers });

  await assert.rejects(
    () => xMuteSet.handler({ user: '12', action: 'mute' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'rate-limit');
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});
