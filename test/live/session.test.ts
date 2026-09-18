// Tests for test/live/harness/session.ts — the live session, the ONE seam every live API
// call goes through. UNGATED: this file runs in the normal `node --test` suite, in CI, on
// every commit.
//
// session.ts makes four promises, and a gated file nobody runs in CI cannot be trusted to
// keep any of them: the budget is forced to `hard` at the derived cap no matter what the
// operator exported; the archive deny list is checked structurally at open time; the
// harness's own `X_MCP_LIVE_*` switches are stripped before `parseConfig` sees them; and
// `call()` asks the spend guard BEFORE anything is sent. Every promise is driven here
// offline, through the REAL composition over the REAL `InMemoryTransport`, with the one
// seam session.ts leaves open — `dispatcher` — set to an undici MockAgent that has
// net-connect disabled and is wrapped in a counter. "Nothing was sent" is asserted as a
// literal zero dispatches, never inferred from an error kind. No test here depends on the
// ambient `process.env`, and no test touches the filesystem: app-only auth needs no token
// file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { USAGE_FIELDS } from '../../src/api/endpoints/usage.js';
import { getMe } from '../../src/api/endpoints/users.js';
import { mapHttpError } from '../../src/api/errors.js';
import { parseConfig } from '../../src/core/config.js';
import { XError } from '../../src/core/errors.js';
import type { Dispatcher } from '../../src/core/ports.js';

import { loadFixture, mockHttp } from '../helpers/index.js';
import type { MockHttp } from '../helpers/index.js';
import { createBillingRecorder } from './harness/capture.js';
import { LIVE_ENV_VARS } from './harness/gate.js';
import type { EnvSnapshot } from './harness/gate.js';
import { createLiveInvoker, liveConfigEnv, openLiveSession } from './harness/session.js';
import type { LiveSession } from './harness/session.js';
import {
  LIVE_DENIED_TOOLS,
  LIVE_READ_UNIT_CAP,
  LIVE_USD_CAP,
  assertDenyListIntact,
  createLiveSpendGuard,
  deniedToolMessage,
} from './harness/spend.js';
import type { LiveSpendGuard } from './harness/spend.js';

/** The bearer the fake operator exported. Every intercept that cares pins it (AUTH-14). */
const BEARER = 'AAAA-live-test';

/** A complete, valid app-only env: no token file, no keychain, nothing on disk. */
const APP_ONLY: EnvSnapshot = { X_MCP_AUTH_MODE: 'app-only', X_MCP_BEARER_TOKEN: BEARER };

/** Every harness switch set, so a test can prove each one is stripped. */
const LIVE_SWITCHES: EnvSnapshot = Object.fromEntries(
  LIVE_ENV_VARS.map((name) => [name, 'set-by-operator']),
);

/** The projection `api/endpoints/users` puts on the wire (a private constant there). */
const USER_FIELDS =
  'created_at,description,location,public_metrics,protected,url,verified,username,name';

/** The shape of a `test/fixtures/errors/*.json` file. */
interface ErrorFixture {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** The compact user the pipeline renders; only the field the tests read is declared. */
interface UserBatch {
  readonly items: readonly { readonly handle?: string }[];
}

/** A dispatcher that counts every dispatch before forwarding it to the mock. */
interface CountingDispatcher {
  readonly dispatcher: Dispatcher;
  /** Requests that reached the wire (the mock), including ones it then refused to match. */
  sent(): number;
}

function countDispatches(inner: Dispatcher): CountingDispatcher {
  // The port type is the bundled undici Dispatcher; the mock helper already hides the
  // v1/v2 handler bridge behind the same cast, so only the three members used are typed.
  const forward = inner as unknown as {
    dispatch(opts: unknown, handler: unknown): boolean;
    close(): Promise<void>;
    destroy(): Promise<void>;
  };
  let sent = 0;
  const counting = {
    dispatch(opts: unknown, handler: unknown): boolean {
      sent += 1;
      return forward.dispatch(opts, handler);
    },
    close: () => forward.close(),
    destroy: () => forward.destroy(),
  };
  return { dispatcher: counting as unknown as Dispatcher, sent: () => sent };
}

/** One open live session over a counted, net-connect-disabled mock. */
interface Harness {
  readonly mock: MockHttp;
  readonly wire: CountingDispatcher;
  /** Everything `printSummary` logged, one entry per line. */
  readonly lines: string[];
  readonly session: LiveSession;
  close(): Promise<void>;
}

async function openHarness(
  options: { readonly env?: EnvSnapshot; readonly guard?: LiveSpendGuard } = {},
): Promise<Harness> {
  const mock = mockHttp();
  const wire = countDispatches(mock.dispatcher);
  const lines: string[] = [];
  const session = await openLiveSession({
    env: options.env ?? APP_ONLY,
    dispatcher: wire.dispatcher,
    ...(options.guard !== undefined ? { guard: options.guard } : {}),
    log: (line) => lines.push(line),
  });
  let closed = false;
  return {
    mock,
    wire,
    lines,
    session,
    async close() {
      if (!closed) {
        closed = true;
        await session.close();
      }
      await mock.close();
    },
  };
}

/** Pin the one endpoint `x_user_get {users:['12','34']}` fires, signed with the bearer. */
function interceptUsers(mock: MockHttp): ReturnType<MockHttp['pool']['intercept']> {
  return mock.pool.intercept({
    path: '/2/users',
    method: 'GET',
    query: { ids: '12,34', 'user.fields': USER_FIELDS },
    headers: { authorization: `Bearer ${BEARER}` },
  });
}

/** Pin `GET /2/users/me` — what both `x_user_get {users:['me']}` and `getMe` send. */
function interceptMe(mock: MockHttp): ReturnType<MockHttp['pool']['intercept']> {
  return mock.pool.intercept({
    path: '/2/users/me',
    method: 'GET',
    query: { 'user.fields': USER_FIELDS },
    headers: { authorization: `Bearer ${BEARER}` },
  });
}

// --- liveConfigEnv: what parseConfig is allowed to see ---------------------------------

test('liveConfigEnv forces hard mode and the derived USD cap over whatever the operator exported (COST-1)', () => {
  const generous: EnvSnapshot = {
    ...APP_ONLY,
    X_MCP_BUDGET_MODE: 'warn',
    X_MCP_CREDIT_BUDGET: '50',
  };
  const out = liveConfigEnv(generous);
  assert.equal(out.X_MCP_BUDGET_MODE, 'hard');
  assert.equal(out.X_MCP_CREDIT_BUDGET, String(LIVE_USD_CAP));
  // The cap is the guard's own derived number, not a hard-coded lookalike.
  assert.equal(Number(out.X_MCP_CREDIT_BUDGET), LIVE_USD_CAP);
  // The same two land when the operator set nothing at all.
  const bare = liveConfigEnv({});
  assert.equal(bare.X_MCP_BUDGET_MODE, 'hard');
  assert.equal(bare.X_MCP_CREDIT_BUDGET, String(LIVE_USD_CAP));
});

test('liveConfigEnv strips every X_MCP_LIVE_* switch and passes everything else through untouched', () => {
  const env: EnvSnapshot = {
    ...APP_ONLY,
    ...LIVE_SWITCHES,
    PATH: '/usr/bin',
    HOME: '/home/operator',
    X_MCP_POLICY: 'manage',
  };
  const out = liveConfigEnv(env);
  for (const name of LIVE_ENV_VARS) {
    assert.equal(name in out, false, `${name} must not reach parseConfig`);
  }
  assert.deepEqual(out, {
    ...APP_ONLY,
    PATH: '/usr/bin',
    HOME: '/home/operator',
    X_MCP_POLICY: 'manage',
    X_MCP_BUDGET_MODE: 'hard',
    X_MCP_CREDIT_BUDGET: String(LIVE_USD_CAP),
  });
  // The operator's snapshot itself is never mutated.
  for (const name of LIVE_ENV_VARS) assert.equal(env[name], 'set-by-operator');
});

test('the stripped env parses to a hard-mode config at the cap, and no harness switch surfaces as an unknown-variable warning (CFG-8)', () => {
  const operator: EnvSnapshot = {
    ...APP_ONLY,
    ...LIVE_SWITCHES,
    X_MCP_BUDGET_MODE: 'warn',
    X_MCP_CREDIT_BUDGET: '50',
  };
  const config = parseConfig(liveConfigEnv(operator));
  assert.equal(config.budget.mode, 'hard');
  assert.equal(config.budget.creditUsd, LIVE_USD_CAP);
  assert.deepEqual(
    config.warnings.filter((w) => /X_MCP_LIVE_/.test(w)),
    [],
  );
  // The strip is load-bearing: the same snapshot handed over raw DOES warn about each switch.
  const raw = parseConfig({ ...operator });
  for (const name of LIVE_ENV_VARS) {
    assert.ok(
      raw.warnings.some((w) => w.includes(name)),
      `without the strip, ${name} would be reported as unknown`,
    );
  }
});

// --- openLiveSession: the real composition over the real transport ---------------------

test('openLiveSession composes the production server under the forced hard cap, with the production guard, and sends nothing by itself', async () => {
  const h = await openHarness({
    env: { ...APP_ONLY, ...LIVE_SWITCHES, X_MCP_BUDGET_MODE: 'warn', X_MCP_CREDIT_BUDGET: '50' },
  });
  try {
    const { composition, config, guard } = h.session;
    assert.equal(config.authMode, 'app-only');
    assert.equal(config.budget.mode, 'hard');
    // The SERVER's own budget — the second rail — carries the live cap, not the operator's 50.
    assert.equal(composition.budget.mode, 'hard');
    assert.equal(composition.budget.limit, LIVE_USD_CAP);
    assert.equal(composition.budget.total(), 0);
    // The default guard is the production one: 20 units / $0.20, nothing spent yet.
    assert.deepEqual(guard.report(), {
      unitsUsed: 0,
      unitCap: LIVE_READ_UNIT_CAP,
      usdUsed: 0,
      usdCap: LIVE_USD_CAP,
      calls: [],
    });
    // Opening performs no network I/O.
    assert.equal(h.wire.sent(), 0);
  } finally {
    await h.close();
  }
});

test('openLiveSession checks the deny list structurally against the composed registry: every denied name is a real tool, and a rename would throw at open time', async () => {
  const h = await openHarness();
  try {
    const names = h.session.composition.registry.all().map((tool) => tool.name);
    for (const denied of LIVE_DENIED_TOOLS) {
      assert.ok(names.includes(denied), `${denied} must be a registered tool`);
    }
    // `assertDenyListIntact` is not injectable, so the check openLiveSession performs is
    // re-run here on the exact list it hands over — and once more on what a rename would
    // leave behind, to show the open would have failed loudly, naming the missing tool.
    assert.doesNotThrow(() => assertDenyListIntact(names));
    assert.throws(
      () => assertDenyListIntact(names.filter((name) => name !== 'x_search_archive')),
      /the live deny list names x_search_archive, which the registry does not expose/,
    );
  } finally {
    await h.close();
  }
});

// --- call(): the guard is asked first --------------------------------------------------

test('a denied tool is refused by the guard before any HTTP request: zero dispatches, nothing charged on either rail', async () => {
  const h = await openHarness();
  try {
    await assert.rejects(
      h.session.call('x_search_archive', { query: 'anything' }, { cost: 'r:post' }),
      { message: deniedToolMessage('x_search_archive') },
    );
    // raw() sits on the same seam — it is not a way around the guard.
    await assert.rejects(
      h.session.raw('x_post_counts_archive', { query: 'anything' }, { cost: 'r:post' }),
      { message: deniedToolMessage('x_post_counts_archive') },
    );
    assert.equal(h.wire.sent(), 0);
    const report = h.session.guard.report();
    assert.equal(report.unitsUsed, 0);
    assert.equal(report.usdUsed, 0);
    assert.deepEqual(report.calls, []);
    assert.equal(h.session.composition.budget.total(), 0);
    h.mock.assertDone();
  } finally {
    await h.close();
  }
});

test('an allowed read goes through the shipped pipeline: the bearer is on the wire (AUTH-14), the ledger records the call, and both rails charge the same price (COST-3)', async () => {
  const h = await openHarness();
  try {
    interceptUsers(h.mock).reply(200, loadFixture<object>('users/two-by-id.json'));

    const res = await h.session.call<UserBatch>(
      'x_user_get',
      { users: ['12', '34'] },
      { cost: 'r:user' },
    );
    assert.deepEqual(
      res.data.items.map((u) => u.handle),
      ['@NASA', '@BillGates'],
    );
    assert.equal(res.meta.cost_usd, 0.01);
    assert.equal(res.meta.session_total_usd, 0.01);
    assert.equal(h.wire.sent(), 1);
    h.mock.assertDone();

    // Harness rail: one unit, the catalog price, in the ledger's exact format.
    const report = h.session.guard.report();
    assert.equal(report.unitsUsed, 1);
    assert.equal(report.usdUsed, 0.01);
    assert.deepEqual(report.calls, ['x_user_get x1 ($0.0100)']);
    // Server rail: the production budget charged the same call.
    assert.equal(h.session.composition.budget.total(), 0.01);
  } finally {
    await h.close();
  }
});

test('a declared unit count is what the guard reserves — a two-page read costs two units on the harness rail', async () => {
  const h = await openHarness();
  try {
    interceptUsers(h.mock).reply(200, loadFixture<object>('users/two-by-id.json'));
    await h.session.call<UserBatch>(
      'x_user_get',
      { users: ['12', '34'] },
      { units: 2, cost: 'r:user' },
    );
    const report = h.session.guard.report();
    assert.equal(report.unitsUsed, 2);
    assert.deepEqual(report.calls, ['x_user_get x2 ($0.0100)']);
    h.mock.assertDone();
  } finally {
    await h.close();
  }
});

test('call() turns a rendered error into a thrown Error naming the tool and the kind, while raw() hands the MCP result back as-is', async () => {
  const billing = loadFixture<ErrorFixture>('errors/403-billing-access-level.json');
  const unauthorized = loadFixture<ErrorFixture>('errors/401-invalid-token.json');
  const h = await openHarness();
  try {
    // Neither 401 nor 403 is retried by api/http, so each reply is consumed exactly once.
    interceptUsers(h.mock).reply(billing.status, billing.body as Record<string, unknown>, {
      headers: billing.headers,
    });
    await assert.rejects(
      h.session.call('x_user_get', { users: ['12', '34'] }, { cost: 'r:user' }),
      { message: /^x_user_get failed \[billing\]: .+/ },
    );

    interceptUsers(h.mock).reply(
      unauthorized.status,
      unauthorized.body as Record<string, unknown>,
      { headers: unauthorized.headers },
    );
    const result = await h.session.raw('x_user_get', { users: ['12', '34'] }, { cost: 'r:user' });
    assert.equal(result.isError, true);
    const block = result.content[0];
    assert.ok(block !== undefined && block.type === 'text');
    const payload = JSON.parse(block.text) as { error: { kind: string; retryable: boolean } };
    assert.equal(payload.error.kind, 'auth');
    assert.equal(payload.error.retryable, false);

    assert.equal(h.wire.sent(), 2);
    h.mock.assertDone();
    // Both attempts were authorized and both reached the API, so both are in the ledger.
    assert.deepEqual(h.session.guard.report().calls, [
      'x_user_get x1 ($0.0100)',
      'x_user_get x1 ($0.0100)',
    ]);
  } finally {
    await h.close();
  }
});

// --- Two independent rails -------------------------------------------------------------

test('the server rail refuses on its own: with a generous harness guard, a production budget already at the cap rejects the call in hard mode before any HTTP (COST-1)', async () => {
  const h = await openHarness({ guard: createLiveSpendGuard({ unitCap: 1000, usdCap: 1000 }) });
  try {
    // Bring the SERVER's budget exactly to the cap; the next priced call would cross it.
    h.session.composition.budget.reserve({ class: 'local', usd: LIVE_USD_CAP });
    assert.equal(h.session.composition.budget.total(), LIVE_USD_CAP);

    await assert.rejects(
      h.session.call('x_user_get', { users: ['12', '34'] }, { cost: 'r:user' }),
      { message: /^x_user_get failed \[budget\]: .+/ },
    );
    assert.equal(h.wire.sent(), 0);
    // The harness guard had said yes — its rails are generous here — so the refusal is the
    // production budget's, and the server total did not move.
    assert.deepEqual(h.session.guard.report().calls, ['x_user_get x1 ($0.0100)']);
    assert.equal(h.session.composition.budget.total(), LIVE_USD_CAP);
    h.mock.assertDone();
  } finally {
    await h.close();
  }
});

test('the harness unit rail stops BEFORE the cap: at 20 units the next call is refused without reaching callTool, and the server never hears of it', async () => {
  const h = await openHarness();
  try {
    // Fill the unit rail with a free pseudo-call so the money rail stays at zero.
    h.session.guard.authorize({ tool: 'harness:seed', units: LIVE_READ_UNIT_CAP, cost: 'local' });
    assert.equal(h.session.guard.report().unitsUsed, LIVE_READ_UNIT_CAP);

    await assert.rejects(
      h.session.call('x_user_get', { users: ['12', '34'] }, { cost: 'r:user' }),
      (err: unknown) => XError.is(err) && err.kind === 'budget',
    );
    assert.equal(h.wire.sent(), 0);
    assert.equal(h.session.composition.budget.total(), 0);
    assert.deepEqual(h.session.guard.report().calls, [
      `harness:seed x${String(LIVE_READ_UNIT_CAP)} ($0.0000)`,
    ]);
    h.mock.assertDone();
  } finally {
    await h.close();
  }
});

// --- reportedHandle, printSummary, close -----------------------------------------------

test('reportedHandle() asks x_user_get for `me` through the pipeline and returns the @handle X reports', async () => {
  const h = await openHarness();
  try {
    interceptMe(h.mock).reply(200, loadFixture<object>('users/me.json'));
    assert.equal(await h.session.reportedHandle(), '@self_bot');
    assert.deepEqual(h.session.guard.report().calls, ['x_user_get x1 ($0.0100)']);
    h.mock.assertDone();
  } finally {
    await h.close();
  }
});

test('printSummary() logs the guard summary, the server budget line, and the x_usage_get report, in that order', async () => {
  const h = await openHarness();
  try {
    h.mock.pool
      .intercept({
        path: '/2/usage/tweets',
        method: 'GET',
        query: { 'usage.fields': USAGE_FIELDS },
        headers: { authorization: `Bearer ${BEARER}` },
      })
      .reply(200, loadFixture<object>('usage/usage-tweets.json'));

    await h.session.printSummary();
    h.mock.assertDone();

    assert.equal(h.lines.length, 5);
    assert.equal(h.lines[0], '');
    // The guard summary is printed BEFORE x_usage_get is called, so it shows the run so far.
    assert.match(h.lines[1] ?? '', /^live session budget summary \(docs\/05 §6\)\n/);
    assert.match(h.lines[1] ?? '', /read units : 0 \/ 20\n/);
    assert.equal(
      h.lines[2],
      `  server budget: hard mode, cap ${String(LIVE_USD_CAP)} USD, spent 0 USD`,
    );
    const usageLine = h.lines[3] ?? '';
    assert.ok(usageLine.startsWith('  x_usage_get: {'), usageLine);
    assert.doesNotThrow(() => JSON.parse(usageLine.slice('  x_usage_get: '.length)));
    assert.equal(h.lines[4], '');
    // The usage call itself went through the guard like any other.
    assert.deepEqual(h.session.guard.report().calls, ['x_usage_get x1 ($0.0010)']);
  } finally {
    await h.close();
  }
});

test('printSummary() reports a failing x_usage_get on its own line and never throws — the summary is reporting, not a test', async () => {
  const unauthorized = loadFixture<ErrorFixture>('errors/401-invalid-token.json');
  const h = await openHarness();
  try {
    h.mock.pool
      .intercept({
        path: '/2/usage/tweets',
        method: 'GET',
        query: { 'usage.fields': USAGE_FIELDS },
      })
      .reply(unauthorized.status, unauthorized.body as Record<string, unknown>, {
        headers: unauthorized.headers,
      });

    await assert.doesNotReject(h.session.printSummary());
    h.mock.assertDone();
    assert.equal(h.lines.length, 5);
    assert.match(h.lines[3] ?? '', /^ {2}x_usage_get FAILED: x_usage_get failed \[auth\]: /);
    assert.equal(h.lines[4], '');
  } finally {
    await h.close();
  }
});

test('close() tears the transport down: a later call is rejected by the client and nothing reaches the wire', async () => {
  const h = await openHarness();
  try {
    await h.session.close();
    await assert.rejects(
      h.session.raw('x_user_get', { users: ['12', '34'] }, { cost: 'r:user' }),
      /Not connected/,
    );
    assert.equal(h.wire.sent(), 0);
    h.mock.assertDone();
  } finally {
    await h.mock.close();
  }
});

// --- createLiveInvoker: the stand-alone production client for the capture path ---------

test('createLiveInvoker builds a production client that signs app-only requests with the bearer (AUTH-14) and speaks only through the injected dispatcher', async () => {
  const mock = mockHttp();
  const wire = countDispatches(mock.dispatcher);
  try {
    interceptMe(mock).reply(200, loadFixture<object>('users/me.json'));
    const http = createLiveInvoker({
      config: parseConfig(liveConfigEnv(APP_ONLY)),
      mapError: mapHttpError,
      dispatcher: wire.dispatcher,
    });
    const me = await getMe(http);
    assert.equal(me.data?.username, 'self_bot');
    assert.equal(wire.sent(), 1);
    mock.assertDone();
  } finally {
    await mock.close();
  }
});

test('createLiveInvoker routes every rejection through the injected mapError — the COST-6 capture wiring, rehearsed offline', async () => {
  const billing = loadFixture<ErrorFixture>('errors/403-billing-access-level.json');
  const mock = mockHttp();
  try {
    mock.pool
      .intercept({ path: '/2/users/me', method: 'GET', query: { 'user.fields': USER_FIELDS } })
      .reply(billing.status, billing.body as Record<string, unknown>, {
        headers: billing.headers,
      });
    const recorder = createBillingRecorder(mapHttpError);
    const http = createLiveInvoker({
      config: parseConfig(liveConfigEnv(APP_ONLY)),
      mapError: recorder.mapError,
      dispatcher: mock.dispatcher,
    });

    await assert.rejects(getMe(http), (err: unknown) => XError.is(err) && err.kind === 'billing');
    assert.equal(recorder.captured.length, 1);
    assert.equal(recorder.captured[0]?.status, 403);
    assert.deepEqual(recorder.captured[0]?.body, billing.body);
    mock.assertDone();
  } finally {
    await mock.close();
  }
});
