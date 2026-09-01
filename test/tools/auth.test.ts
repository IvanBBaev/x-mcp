// Tests for the auth/session tools (T-120). The tools are composition-root tools (INT-6):
// they read injected `AuthToolDeps`, not the frozen `ToolContext`. So each test builds fake
// deps — a fake `AuthSessionProvider` and a fake rate-limit tracker — calls `createAuthTools`,
// then drives the built handlers directly.
//
// The `x_auth_status` user-mode test exercises the real `getMe` me-enrichment path over the
// global-fetch mock (mirroring smoke.test.ts): the snapshot omits the handle, so the handler
// calls `/2/users/me` and fills it in.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAuthTools } from '../../src/tools/auth.js';
import type { AuthSessionInfo, AuthToolDeps } from '../../src/tools/auth.js';
import type { AnyToolDef, EndpointInvoker, ToolContext } from '../../src/core/tooldef.js';
import type { RateLimitStatus, RateLimitTracker } from '../../src/api/ratelimit.js';
import { createHttpClient } from '../../src/api/http.js';

import { makePorts, fakeRandom, fakeSleep, mockHttp, loadFixture } from '../helpers/index.js';

// The agent-facing shape `x_auth_status` returns in `data` (structural view for assertions).
interface AuthStatusData {
  readonly auth_mode: string;
  readonly token_store: string;
  readonly base_url_override?: string;
  readonly scopes: readonly string[];
  readonly availability: readonly string[];
  readonly policy: { readonly preset: string; readonly cells: Record<string, boolean> };
  readonly me?: { readonly id: string; readonly handle?: string };
  readonly note?: string;
}

/** Find a built tool by its public name, failing loudly when absent. */
function getTool(tools: readonly AnyToolDef[], name: string): AnyToolDef {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} should be registered`);
  return tool;
}

/** A fake `AuthSessionProvider` returning a fixed snapshot. */
function fakeDeps(info: AuthSessionInfo, status: RateLimitStatus): AuthToolDeps {
  return {
    session: { snapshot: () => info },
    rateLimit: { status: () => status },
  };
}

/** A tracker status with a single tracked bucket/window, for the rate-limit test. */
const SAMPLE_RATE_LIMIT: RateLimitStatus = {
  buckets: [
    {
      key: 'tweets#user',
      windows: [
        {
          kind: 'standard',
          limit: 900,
          remaining: 42,
          reset_at: '2026-07-23T12:00:00.000Z',
          seconds_until_reset: 120,
          exhausted: false,
        },
      ],
    },
  ],
};

/** An `EndpointInvoker` that must never be called (app-only / local paths make no request). */
const NO_HTTP: EndpointInvoker = {
  send: () => {
    throw new Error('handler must not make an API call in this path');
  },
};

test('x_auth_status (user mode) surfaces the session and enriches the handle via /2/users/me', async () => {
  const info: AuthSessionInfo = {
    authMode: 'user',
    me: { id: '9' }, // handle omitted → the handler enriches it from /2/users/me
    scopes: ['users.read', 'tweet.read'],
    availability: ['app+user', 'user-only'],
    policy: { preset: 'default-write', cells: { 'read:account': true, 'write:content': true } },
    tokenStore: 'file',
  };
  const tools = createAuthTools(fakeDeps(info, SAMPLE_RATE_LIMIT));

  const mock = mockHttp();
  mock.pool
    .intercept({ path: /^\/2\/users\/me/, method: 'GET' })
    .reply(200, loadFixture<{ data: { id: string; username: string } }>('auth/me.json'));
  const http = createHttpClient({
    sleep: fakeSleep().fn,
    random: fakeRandom(),
    dispatcher: mock.dispatcher,
  });
  const ctx: ToolContext = { ports: makePorts(), http };

  const result = await getTool(tools, 'x_auth_status').handler({}, ctx);
  const data = result.data as AuthStatusData;

  assert.equal(data.auth_mode, 'user');
  assert.deepEqual(data.me, { id: '9', handle: 'me_handle' });
  assert.deepEqual(data.scopes, ['tweet.read', 'users.read']); // sorted
  assert.deepEqual(data.availability, ['app+user', 'user-only']);
  assert.equal(data.policy.preset, 'default-write');
  assert.equal(data.policy.cells['read:account'], true);
  assert.equal(data.note, undefined); // user mode carries no degradation note
  assert.equal(data.token_store, 'file');
  // T6: the summary — the part that survives into a transcript — leads with the account.
  assert.equal(result.summary, 'auth: user @me_handle');

  mock.assertDone();
  await mock.close();
});

test('x_auth_status (app-only mode) omits `me` and adds the AUTH-15 degradation note', async () => {
  const info: AuthSessionInfo = {
    authMode: 'app-only',
    scopes: [],
    availability: ['app+user'],
    policy: { preset: 'read-only', cells: { 'read:account': true } },
    tokenStore: 'env',
  };
  const tools = createAuthTools(fakeDeps(info, SAMPLE_RATE_LIMIT));
  const ctx: ToolContext = { ports: makePorts(), http: NO_HTTP };

  const result = await getTool(tools, 'x_auth_status').handler({}, ctx);
  const data = result.data as AuthStatusData;

  assert.equal(data.auth_mode, 'app-only');
  assert.equal(data.me, undefined); // no authenticated user under app-only
  assert.equal(typeof data.note, 'string');
  assert.match(data.note ?? '', /app-only/);
  assert.deepEqual(data.scopes, []);
  // T17: the app-only bearer arrives on the environment, and the report says so rather
  // than leaving the backend blank.
  assert.equal(data.token_store, 'env');
  assert.equal(result.summary, 'auth: app-only (no acting account)');
});

// --- docs/04 T6: the acting account leads the summary (T-320 F10) ----------------------
//
// One profile per process fixes the account for the session, so the defence against a
// wrong-account write is making the account cheap to CHECK. `data.me` alone is not enough:
// the summary is what survives compaction into a transcript.

test('T6: a user-mode summary whose handle cannot be resolved still pins the identity', async () => {
  const info: AuthSessionInfo = {
    authMode: 'user',
    me: { id: '9' }, // no handle in the snapshot…
    scopes: [],
    availability: ['app+user'],
    policy: { preset: 'default-write', cells: { 'read:account': true } },
    tokenStore: 'file',
  };
  const tools = createAuthTools(fakeDeps(info, SAMPLE_RATE_LIMIT));

  // …and /2/users/me fails, so the AUTH-15 best-effort enrichment gives up (never throws).
  const mock = mockHttp();
  mock.pool.intercept({ path: /^\/2\/users\/me/, method: 'GET' }).reply(503, {});
  const http = createHttpClient({
    sleep: fakeSleep().fn,
    random: fakeRandom(),
    dispatcher: mock.dispatcher,
  });
  const ctx: ToolContext = { ports: makePorts(), http };

  const result = await getTool(tools, 'x_auth_status').handler({}, ctx);
  assert.deepEqual((result.data as AuthStatusData).me, { id: '9' });
  // The id is a worse label than a handle but an unambiguous one — better than a summary
  // that says nothing about WHICH account the next write would hit.
  assert.equal(result.summary, 'auth: user id 9');

  await mock.close();
});

test('T6: a user-mode session with no `me` at all says so instead of implying an account', async () => {
  const info: AuthSessionInfo = {
    authMode: 'user',
    scopes: [],
    availability: ['app+user'],
    policy: { preset: 'default-write', cells: { 'read:account': true } },
    tokenStore: 'keychain',
  };
  const tools = createAuthTools(fakeDeps(info, SAMPLE_RATE_LIMIT));
  const ctx: ToolContext = { ports: makePorts(), http: NO_HTTP };

  const result = await getTool(tools, 'x_auth_status').handler({}, ctx);
  assert.equal((result.data as AuthStatusData).me, undefined);
  assert.equal(result.summary, 'auth: user (account unresolved)');
});

// --- docs/04 T1/T17: the BACKEND is reported; the path and the perms are not ------------

test('token_store names the backend and the report never carries a filesystem path', async () => {
  for (const backend of ['env', 'file', 'keychain'] as const) {
    const info: AuthSessionInfo = {
      authMode: 'app-only',
      scopes: [],
      availability: ['app+user'],
      policy: { preset: 'read-only', cells: { 'read:account': true } },
      tokenStore: backend,
    };
    const tools = createAuthTools(fakeDeps(info, SAMPLE_RATE_LIMIT));
    const ctx: ToolContext = { ports: makePorts(), http: NO_HTTP };

    const result = await getTool(tools, 'x_auth_status').handler({}, ctx);
    assert.equal((result.data as AuthStatusData).token_store, backend);

    // The path and the permission bits belong to `doctor`, not to a tool whose output lands
    // in the model's context: an absolute token path carries the operator's account name and
    // home layout (docs/12), and a mode read once at composition time would be reported as
    // current long after it stopped being true. The key set is pinned exactly, so a later
    // "just add the path, it's useful" fails here rather than shipping.
    assert.deepEqual(Object.keys(result.data as object).sort(), [
      'auth_mode',
      'availability',
      'note',
      'policy',
      'scopes',
      'token_store',
    ]);
  }
});

// --- CFG-7: a non-default API host is disclosed to the AGENT, not only to the operator ---

test('base_url_override is absent on the real API and present when overridden', async () => {
  const base: AuthSessionInfo = {
    authMode: 'app-only',
    scopes: [],
    availability: ['app+user'],
    policy: { preset: 'read-only', cells: { 'read:account': true } },
    tokenStore: 'env',
  };
  const ctx: ToolContext = { ports: makePorts(), http: NO_HTTP };

  // Against api.x.com the field is ABSENT rather than echoing a constant on every call.
  const plain = await getTool(
    createAuthTools(fakeDeps(base, SAMPLE_RATE_LIMIT)),
    'x_auth_status',
  ).handler({}, ctx);
  assert.equal((plain.data as AuthStatusData).base_url_override, undefined);
  assert.equal(Object.hasOwn(plain.data as object, 'base_url_override'), false);

  // Under an override the agent can see that "X" is some other host before it drafts a DM
  // there. The startup banner already told the operator; this is the other half (CFG-7).
  const proxied = await getTool(
    createAuthTools(
      fakeDeps({ ...base, baseUrlOverride: 'https://proxy.example' }, SAMPLE_RATE_LIMIT),
    ),
    'x_auth_status',
  ).handler({}, ctx);
  assert.equal((proxied.data as AuthStatusData).base_url_override, 'https://proxy.example');
});

test('x_rate_limit_status returns the tracker status verbatim', async () => {
  const info: AuthSessionInfo = {
    authMode: 'user',
    me: { id: '9', handle: 'me_handle' },
    scopes: ['users.read'],
    availability: ['app+user'],
    policy: { preset: 'default-write', cells: { 'read:account': true } },
    tokenStore: 'keychain',
  };
  const tools = createAuthTools(fakeDeps(info, SAMPLE_RATE_LIMIT));
  const ctx: ToolContext = { ports: makePorts(), http: NO_HTTP };

  const result = await getTool(tools, 'x_rate_limit_status').handler({}, ctx);
  const status = result.data as RateLimitStatus;

  assert.deepEqual(status, SAMPLE_RATE_LIMIT);
  const window = status.buckets[0]?.windows[0];
  assert.equal(window?.remaining, 42);
  assert.equal(window?.limit, 900);
  assert.equal(window?.exhausted, false);
  assert.equal(result.summary, 'rate-limit: 1 bucket(s) tracked');
});

test('a snapshot that already carries the handle is used verbatim — no /2/users/me call', async () => {
  const info: AuthSessionInfo = {
    authMode: 'user',
    me: { id: '9', handle: 'preset_handle' }, // handle known at composition time
    scopes: [],
    availability: ['app+user'],
    policy: { preset: 'default-write', cells: { 'read:account': true } },
    tokenStore: 'file',
  };
  const tools = createAuthTools(fakeDeps(info, SAMPLE_RATE_LIMIT));
  // NO_HTTP proves the short-circuit: with the handle already in the snapshot the handler
  // must not spend a request (or a rate-limit hit, or a failure risk) on enrichment.
  const ctx: ToolContext = { ports: makePorts(), http: NO_HTTP };

  const result = await getTool(tools, 'x_auth_status').handler({}, ctx);
  assert.deepEqual((result.data as AuthStatusData).me, { id: '9', handle: 'preset_handle' });
  assert.equal(result.summary, 'auth: user @preset_handle');
});

// Statically pins the INT-6 dependency contract the integrator (T-130) must satisfy.
test('AuthToolDeps shape is the INT-6 seam createAuthTools consumes', () => {
  const tracker: Pick<RateLimitTracker, 'status'> = { status: () => SAMPLE_RATE_LIMIT };
  const deps: AuthToolDeps = {
    session: {
      snapshot: (): AuthSessionInfo => ({
        authMode: 'app-only',
        scopes: [],
        availability: [],
        policy: { preset: 'read-only', cells: {} },
        tokenStore: 'env',
      }),
    },
    rateLimit: tracker,
  };
  const tools = createAuthTools(deps);
  assert.deepEqual(
    tools.map((t) => t.name),
    ['x_auth_status', 'x_rate_limit_status'],
  );
});
