// Behavioural tests for the `x_user_get` tool and the `createHandleLookup` endpoint
// (T-122). Every request is served by an undici MockAgent injected as the http
// dispatcher — no real network. The intercepts pass the EXACT query object each endpoint
// sends (undici 6 string-compares the full path + sorted query, so a query-less intercept
// never matches a request that carries one); this doubles as the wire-contract assertion
// for the `user.fields` projection and the `ids`/`usernames` params. Canned bodies come
// from typed fixtures under test/fixtures/users; only the single-user id-`12` response has
// no fitting fixture and is built inline.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHttpClient } from '../../src/api/http.js';
import { createHandleLookup } from '../../src/api/endpoints/users.js';
import { xUserGet, usersTools } from '../../src/tools/users.js';
import type { ToolContext, EndpointInvoker } from '../../src/core/tooldef.js';
import type { RawListResponse, RawSingleResponse, RawUser } from '../../src/core/render.js';
import type { BatchResult, CompactUser } from '../../src/core/render-shapes.js';

import { fakeRandom, fakeSleep, loadFixture, makePorts, mockHttp } from '../helpers/index.js';
import type { MockHttp } from '../helpers/index.js';

// The `user.fields` projection every user endpoint requests — MUST match the private
// constant in src/api/endpoints/users.ts exactly, or the intercepts below will not match.
const USER_FIELDS =
  'created_at,description,location,public_metrics,protected,url,verified,username,name';

/** A one-item raw list holding NASA (id `12`) — the id-branch body no single fixture fits. */
const NASA_BODY: RawListResponse<RawUser> = {
  data: [
    {
      id: '12',
      name: 'NASA',
      username: 'NASA',
      created_at: '2007-12-19T20:30:39.000Z',
      description: "There's space for everybody.",
      location: 'Pale Blue Dot',
      url: 'https://t.co/nasa',
      verified: true,
      protected: false,
      public_metrics: {
        followers_count: 74_000_000,
        following_count: 180,
        tweet_count: 65_000,
        listed_count: 92_000,
      },
    },
  ],
};

/** Build a real `EndpointInvoker` over the mock dispatcher. */
function invokerFor(mock: MockHttp): EndpointInvoker {
  return createHttpClient({
    sleep: fakeSleep().fn,
    random: fakeRandom(),
    dispatcher: mock.dispatcher,
  });
}

/** …plus a bare tool context around it. */
function ctxFor(mock: MockHttp): ToolContext {
  return { ports: makePorts(), http: invokerFor(mock) };
}

test('x_user_get carries the frozen contract axes', () => {
  assert.equal(xUserGet.name, 'x_user_get');
  assert.equal(xUserGet.policy, 'read:user');
  assert.equal(xUserGet.availability, 'app+user');
  assert.equal(xUserGet.cost, 'r:user');
  assert.deepEqual(xUserGet.scopes, ['users.read']);
  assert.equal(xUserGet.annotations.readOnlyHint, true);
  assert.equal(xUserGet.phase, 1);
  assert.deepEqual(usersTools, [xUserGet]);
});

test('x_user_get merges id, @handle and me into one batch of distinct users', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/users',
      method: 'GET',
      query: { ids: '12', 'user.fields': USER_FIELDS },
    })
    .reply(200, NASA_BODY);
  mock.pool
    .intercept({
      path: '/2/users/by',
      method: 'GET',
      query: { usernames: 'jack', 'user.fields': USER_FIELDS },
    })
    .reply(200, loadFixture<RawListResponse<RawUser>>('users/by-username.json'));
  mock.pool
    .intercept({ path: '/2/users/me', method: 'GET', query: { 'user.fields': USER_FIELDS } })
    .reply(200, loadFixture<RawSingleResponse<RawUser>>('users/me.json'));

  const out = await xUserGet.handler({ users: ['12', '@jack', 'me'] }, ctxFor(mock));
  const batch = out.data as BatchResult<CompactUser>;

  assert.equal(batch.items.length, 3);
  assert.deepEqual(
    batch.items.map((u) => u.handle),
    ['@NASA', '@jack', '@self_bot'],
  );
  assert.equal(batch.missing, undefined);
  assert.equal(out.summary, '3 user(s)');
  mock.assertDone();
  await mock.close();
});

test('x_user_get surfaces an unresolved id in missing[] (partial batch, REND-2)', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/users',
      method: 'GET',
      query: { ids: '12,404999', 'user.fields': USER_FIELDS },
    })
    .reply(200, loadFixture<RawListResponse<RawUser>>('users/missing-user.json'));

  const out = await xUserGet.handler({ users: ['12', '404999'] }, ctxFor(mock));
  const batch = out.data as BatchResult<CompactUser>;

  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0]?.handle, '@NASA');
  assert.equal(batch.missing?.length, 1);
  assert.equal(batch.missing?.[0]?.id, '404999');
  assert.equal(batch.missing?.[0]?.reason, 'not-found');
  assert.equal(out.summary, '1 user(s), 1 missing');
  mock.assertDone();
  await mock.close();
});

test('x_user_get de-dupes a user reached by both id and @handle', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/users',
      method: 'GET',
      query: { ids: '12', 'user.fields': USER_FIELDS },
    })
    .reply(200, NASA_BODY);
  mock.pool
    .intercept({
      path: '/2/users/by',
      method: 'GET',
      query: { usernames: 'NASA', 'user.fields': USER_FIELDS },
    })
    .reply(200, NASA_BODY);

  const out = await xUserGet.handler({ users: ['12', '@NASA'] }, ctxFor(mock));
  const batch = out.data as BatchResult<CompactUser>;

  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0]?.id, '12');
  assert.equal(out.summary, '1 user(s)');
  mock.assertDone();
  await mock.close();
});

test('x_user_get raw:true returns the uncompacted envelope, capped', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/users',
      method: 'GET',
      query: { ids: '12,34', 'user.fields': USER_FIELDS },
    })
    .reply(200, loadFixture<RawListResponse<RawUser>>('users/two-by-id.json'));

  const out = await xUserGet.handler({ users: ['12', '34'], raw: true }, ctxFor(mock));
  const envelope = out.data as RawListResponse<RawUser>;

  assert.equal(envelope.data?.length, 2);
  assert.equal(envelope.data?.[0]?.id, '12');
  // Uncompacted: the raw `public_metrics` block survives (a compact user would have `metrics`).
  assert.ok(envelope.data?.[0]?.public_metrics);
  assert.equal(out.summary, '2 raw user record(s)');
  mock.assertDone();
  await mock.close();
});

test('createHandleLookup resolves a handle to an identity on a hit', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/users/by/username/BillGates',
      method: 'GET',
      query: { 'user.fields': USER_FIELDS },
    })
    .reply(200, loadFixture<RawSingleResponse<RawUser>>('users/handle-lookup-hit.json'));

  // The leading `@` is stripped before the request path is built.
  const identity = await createHandleLookup(invokerFor(mock))('@BillGates');

  assert.deepEqual(identity, { id: '50393960', handle: 'BillGates' });
  mock.assertDone();
  await mock.close();
});

test('createHandleLookup returns null for a not-found handle (200 + errors[])', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/users/by/username/ghost',
      method: 'GET',
      query: { 'user.fields': USER_FIELDS },
    })
    .reply(200, loadFixture<RawSingleResponse<RawUser>>('users/handle-lookup-miss.json'));

  const identity = await createHandleLookup(invokerFor(mock))('ghost');

  assert.equal(identity, null);
  mock.assertDone();
  await mock.close();
});
