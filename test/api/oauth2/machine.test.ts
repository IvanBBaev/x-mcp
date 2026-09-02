// Tests for the in-memory single-flight OAuth2 refresh state machine (T-201,
// src/api/oauth2/machine.ts). Cases: AUTH-1…4, AUTH-6, AUTH-8…12, CONC-1, PLAT-4
// (docs/07-corner-cases.md §2, §13, §15) per the ratified spec in docs/02 §4A.
//
// Everything is deterministic: time comes only from the injected fake Clock, persistence
// from the in-memory TokenStore fake (test/helpers), and the token-endpoint POST from a
// scripted stub — no disk, no timers, no network. The cross-process variants of the two
// canonical tests belong to T-203/T-206; the in-process halves are covered here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeClock, inMemoryTokenStore } from '../../helpers/index.js';
import type { FakeClock, InMemoryTokenStore } from '../../helpers/index.js';
import { XError } from '../../../src/core/errors.js';
import type { TokenPair, TokenStore } from '../../../src/core/ports.js';
import {
  EAGER_REFRESH_MARGIN_MS,
  createRefreshMachine,
  type MachineState,
  type RefreshHttp,
  type RefreshHttpResult,
} from '../../../src/api/oauth2/machine.js';

/** A healthy 2-hour pair minted "now" per the given clock. */
function pairAt(clock: FakeClock, overrides: Partial<TokenPair> = {}): TokenPair {
  return {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    obtained_at: clock.now(),
    expires_in: 7200,
    version: 1,
    ...overrides,
  };
}

/** A pair with NO refresh_token property at all (AUTH-10). */
function pairWithoutRefresh(clock: FakeClock, overrides: Partial<TokenPair> = {}): TokenPair {
  return { access_token: 'access-only', obtained_at: clock.now(), expires_in: 7200, ...overrides };
}

/** Build a token-endpoint success result; omit fields to exercise the tolerance paths. */
function ok(
  access: string,
  opts: { refresh?: string; expiresIn?: number } = {},
): RefreshHttpResult {
  const token: { access_token: string; refresh_token?: string; expires_in?: number } = {
    access_token: access,
  };
  if (opts.refresh !== undefined) token.refresh_token = opts.refresh;
  if (opts.expiresIn !== undefined) token.expires_in = opts.expiresIn;
  return { ok: true, token };
}

/** Build a token-endpoint rejection result. */
function rejected(status: number, error?: string, description?: string): RefreshHttpResult {
  return {
    ok: false,
    status,
    ...(error === undefined ? {} : { error }),
    ...(description === undefined ? {} : { error_description: description }),
  };
}

/** A scripted refresh stub: each call consumes the next step; extra calls fail the test. */
interface RefreshStub {
  readonly fn: RefreshHttp;
  readonly calls: string[];
}

function refreshStub(
  ...steps: readonly (RefreshHttpResult | Error | Promise<RefreshHttpResult>)[]
): RefreshStub {
  const calls: string[] = [];
  const queue = [...steps];
  const fn: RefreshHttp = (refreshToken) => {
    calls.push(refreshToken);
    const step = queue.shift();
    if (step === undefined) {
      return Promise.reject(new Error('refreshStub: unexpected extra token-endpoint call'));
    }
    if (step instanceof Error) return Promise.reject(step);
    return Promise.resolve(step);
  };
  return { fn, calls };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Await a promise expected to reject with an XError; return it for detailed asserts. */
async function captureError(promise: Promise<unknown>): Promise<XError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(XError.is(error), 'expected an XError');
    return error;
  }
  return assert.fail('expected the promise to reject');
}

function setup(opts: { pair?: TokenPair | null; stub?: RefreshStub; clock?: FakeClock } = {}): {
  clock: FakeClock;
  store: InMemoryTokenStore;
  stub: RefreshStub;
  machine: ReturnType<typeof createRefreshMachine>;
} {
  const clock = opts.clock ?? fakeClock();
  const store = inMemoryTokenStore(opts.pair === undefined ? pairAt(clock) : opts.pair);
  const stub = opts.stub ?? refreshStub();
  const machine = createRefreshMachine({ clock, store, refreshHttp: stub.fn });
  return { clock, store, stub, machine };
}

// ---------------------------------------------------------------------------------
// Happy path + eager boundary (AUTH-7)
// ---------------------------------------------------------------------------------

test('a VALID token is served straight from the store — no refresh, no persist', async () => {
  const { store, stub, machine } = setup();
  assert.equal(await machine.getAccessToken(), 'access-1');
  assert.equal(stub.calls.length, 0);
  assert.equal(store.persistCount(), 0);
  assert.equal(machine.state(), 'VALID');
});

test('AUTH-7: eager boundary — 5:01 of life serves the current token, 4:59 refreshes first', async () => {
  const stub = refreshStub(ok('access-2', { refresh: 'refresh-2', expiresIn: 7200 }));
  const { clock, machine } = setup({ stub });

  clock.advance(7200_000 - 301_000); // 5 min 1 s of life left
  assert.equal(await machine.getAccessToken(), 'access-1');
  assert.equal(stub.calls.length, 0, 'outside the margin no refresh happens');
  assert.equal(machine.state(), 'VALID');

  clock.advance(2_000); // 4 min 59 s of life left → inside the margin
  assert.equal(machine.state(), 'EAGER');
  assert.equal(await machine.getAccessToken(), 'access-2');
  assert.deepEqual(stub.calls, ['refresh-1']);
  assert.equal(machine.state(), 'VALID', 'the fresh pair leaves the machine VALID again');
});

test('AUTH-7: exactly 5:00 of life left is inside the eager margin (≤ boundary)', async () => {
  const stub = refreshStub(ok('access-2', { refresh: 'refresh-2', expiresIn: 7200 }));
  const { clock, machine } = setup({ stub });
  clock.advance(7200_000 - EAGER_REFRESH_MARGIN_MS);
  assert.equal(await machine.getAccessToken(), 'access-2');
  assert.deepEqual(stub.calls, ['refresh-1']);
});

test('AUTH-7/AUTH-2: concurrent eager callers share one refresh — early-refresh skew can never double-refresh', async () => {
  const gate = deferred<RefreshHttpResult>();
  const calls: string[] = [];
  const clock = fakeClock();
  const store = inMemoryTokenStore(pairAt(clock));
  const machine = createRefreshMachine({
    clock,
    store,
    refreshHttp: (rt) => {
      calls.push(rt);
      return gate.promise;
    },
  });

  await machine.getAccessToken(); // prime the in-memory pair
  clock.advance(7200_000 - 60_000); // 1 min left → clearly eager
  const a = machine.getAccessToken();
  const b = machine.getAccessToken();
  gate.resolve(ok('access-2', { refresh: 'refresh-2', expiresIn: 7200 }));
  assert.deepEqual(await Promise.all([a, b]), ['access-2', 'access-2']);
  assert.equal(calls.length, 1, 'exactly one token-endpoint call for two eager callers');
});

// ---------------------------------------------------------------------------------
// Sleep/resume — recompute from the Clock on next use, no timers (PLAT-4)
// ---------------------------------------------------------------------------------

test('PLAT-4: sleep/resume — a one-step clock jump past expiry fires nothing during the jump; the next use recomputes from the Clock and refreshes exactly once', async () => {
  const stub = refreshStub(ok('access-2', { refresh: 'refresh-2', expiresIn: 7200 }));
  const { clock, store, machine } = setup({ stub });

  assert.equal(await machine.getAccessToken(), 'access-1', 'comfortably valid before the sleep');
  assert.equal(machine.state(), 'VALID');

  // The laptop sleeps; on resume the Clock has jumped 8 hours in ONE step — far past both
  // the eager boundary and the token's actual 2 h expiry. The machine schedules no timers,
  // so nothing can have fired "during" the jump: zero refresh calls, zero persists.
  clock.advance(8 * 3_600_000);
  assert.equal(stub.calls.length, 0, 'no stale timer fired during the jump');
  assert.equal(store.persistCount(), 0);
  assert.equal(machine.state(), 'EAGER', 'expiry is recomputed from the Clock, not a schedule');

  // The very next use consults the injected Clock and refreshes — exactly once.
  assert.equal(await machine.getAccessToken(), 'access-2');
  assert.deepEqual(stub.calls, ['refresh-1'], 'exactly one refresh, triggered by post-resume use');
  assert.equal(machine.state(), 'VALID');
});

// ---------------------------------------------------------------------------------
// Single-flight (AUTH-2, CONC-1)
// ---------------------------------------------------------------------------------

test('AUTH-2/CONC-1: one-refresh-for-N-concurrent-401s — N callers, one token-endpoint call, all get the new token', async () => {
  const gate = deferred<RefreshHttpResult>();
  const calls: string[] = [];
  const clock = fakeClock();
  const store = inMemoryTokenStore(pairAt(clock));
  const machine = createRefreshMachine({
    clock,
    store,
    refreshHttp: (rt) => {
      calls.push(rt);
      return gate.promise;
    },
  });
  await machine.getAccessToken(); // prime the in-memory pair

  const waiters = [1, 2, 3, 4, 5].map(() => machine.handleUnauthorized('access-1'));
  gate.resolve(ok('access-2', { refresh: 'refresh-2', expiresIn: 7200 }));
  const tokens = await Promise.all(waiters);

  assert.deepEqual(tokens, ['access-2', 'access-2', 'access-2', 'access-2', 'access-2']);
  assert.equal(calls.length, 1, 'exactly one HTTP call to the token endpoint');
  assert.equal(store.persistCount(), 1, 'exactly one persisted rotation');
});

test('AUTH-2/CONC-1: an eager caller joins a reactive refresh already in flight (one shared promise across both paths)', async () => {
  const gate = deferred<RefreshHttpResult>();
  const calls: string[] = [];
  const clock = fakeClock();
  const store = inMemoryTokenStore(pairAt(clock));
  const machine = createRefreshMachine({
    clock,
    store,
    refreshHttp: (rt) => {
      calls.push(rt);
      return gate.promise;
    },
  });
  await machine.getAccessToken();

  const reactive = machine.handleUnauthorized('access-1');
  const eager = machine.getAccessToken(); // joins the in-flight refresh instead of racing it
  gate.resolve(ok('access-2', { refresh: 'refresh-2', expiresIn: 7200 }));
  assert.deepEqual(await Promise.all([reactive, eager]), ['access-2', 'access-2']);
  assert.equal(calls.length, 1);
});

test('AUTH-2: two COLD callers loading an already-eager pair share one refresh (join inside the refresh entry)', async () => {
  // Both callers enter with no in-memory pair and no flight, so both pass the early join
  // check, both load the (eager) pair from the store, and both reach the refresh entry —
  // the second must join the first one's flight there instead of double-refreshing.
  const gate = deferred<RefreshHttpResult>();
  const calls: string[] = [];
  const clock = fakeClock();
  const store = inMemoryTokenStore(pairAt(clock));
  const machine = createRefreshMachine({
    clock,
    store,
    refreshHttp: (rt) => {
      calls.push(rt);
      return gate.promise;
    },
  });

  clock.advance(7200_000 - 60_000); // 1 min of life left → the stored pair is already eager
  const a = machine.getAccessToken();
  const b = machine.getAccessToken();
  gate.resolve(ok('access-2', { refresh: 'refresh-2', expiresIn: 7200 }));
  assert.deepEqual(await Promise.all([a, b]), ['access-2', 'access-2']);
  assert.equal(calls.length, 1, 'the second cold caller joined the flight');
});

test('CONC-1: all waiters of a failed single-flight refresh see the same typed error; the machine stays healthy', async () => {
  const gate = deferred<RefreshHttpResult>();
  const calls: string[] = [];
  const clock = fakeClock();
  const store = inMemoryTokenStore(pairAt(clock));
  const machine = createRefreshMachine({
    clock,
    store,
    refreshHttp: (rt) => {
      calls.push(rt);
      return gate.promise;
    },
  });
  await machine.getAccessToken();

  const waiters = [1, 2, 3].map(() => machine.handleUnauthorized('access-1'));
  gate.resolve(rejected(503));
  const errors = await Promise.all(waiters.map((w) => captureError(w)));

  assert.equal(errors[0]?.kind, 'api');
  assert.equal(errors[0]?.retryable, true);
  assert.equal(errors[1], errors[0], 'one shared rejection for all waiters');
  assert.equal(errors[2], errors[0]);
  assert.equal(calls.length, 1);
  assert.notEqual(machine.state(), 'FAILED_CLOSED', 'a transient failure is not terminal');
});

// ---------------------------------------------------------------------------------
// Reload-on-401 + adopt-on-disk-pair (AUTH-3, AUTH-4)
// ---------------------------------------------------------------------------------

test('AUTH-3: waiter-adopts-disk-pair — a 401 whose reload finds a differing on-disk pair adopts it and issues no refresh HTTP call', async () => {
  const { clock, store, stub, machine } = setup();
  await machine.getAccessToken(); // in-memory pair is now access-1/refresh-1
  const loadsBefore = store.loadCount();

  // A peer process rotated on the shared store while we held a stale in-memory copy.
  const peerPair = pairAt(clock, {
    access_token: 'access-2',
    refresh_token: 'refresh-2',
    version: 2,
  });
  store.seed(peerPair);

  const token = await machine.handleUnauthorized('access-1');
  assert.equal(token, 'access-2', 'the peer rotation is adopted');
  assert.equal(stub.calls.length, 0, 'no refresh HTTP call — the peer rotation is never burned');
  assert.equal(store.persistCount(), 0, 'adoption does not re-persist');
  assert.ok(store.loadCount() > loadsBefore, 'the store was re-read under the lock');
  assert.equal(await machine.getAccessToken(), 'access-2', 'the adopted pair is now in memory');
  assert.equal(machine.state(), 'VALID');
});

test('AUTH-4: a 401 reloads the store under the lock BEFORE the refresh decision (lock → load → refresh → persist)', async () => {
  const clock = fakeClock();
  const inner = inMemoryTokenStore(pairAt(clock));
  const events: string[] = [];
  const store: TokenStore = {
    load: () => {
      events.push('load');
      return inner.load();
    },
    persist: (p) => {
      events.push('persist');
      return inner.persist(p);
    },
    withLock: (fn) => {
      events.push('lock');
      return inner.withLock(fn);
    },
  };
  const machine = createRefreshMachine({
    clock,
    store,
    refreshHttp: (rt) => {
      events.push(`refresh:${rt}`);
      return Promise.resolve(ok('access-2', { refresh: 'refresh-2', expiresIn: 7200 }));
    },
  });
  await machine.getAccessToken();
  events.length = 0; // keep only the 401 cycle

  assert.equal(await machine.handleUnauthorized('access-1'), 'access-2');
  assert.deepEqual(events, ['lock', 'load', 'refresh:refresh-1', 'persist']);
});

test('AUTH-2/AUTH-8: a 401 for an already-rotated token returns the current pair without another refresh (the machine half of retry-once)', async () => {
  const stub = refreshStub(ok('access-2', { refresh: 'refresh-2', expiresIn: 7200 }));
  const { machine } = setup({ stub });
  await machine.getAccessToken();
  assert.equal(await machine.handleUnauthorized('access-1'), 'access-2'); // first cycle rotates

  // A slow request that still carried the OLD token reports its 401 after the rotation:
  // the current pair is the recovery — no reload, no second refresh.
  assert.equal(await machine.handleUnauthorized('access-1'), 'access-2');
  assert.equal(stub.calls.length, 1);
});

// ---------------------------------------------------------------------------------
// Persist-before-use (AUTH-1) and port-only persistence (AUTH-12)
// ---------------------------------------------------------------------------------

test('AUTH-1: the rotated pair is persisted BEFORE the new access token is released to any caller', async () => {
  const clock = fakeClock();
  const inner = inMemoryTokenStore(pairAt(clock));
  const events: string[] = [];
  let stateInPersist: MachineState | null = null;
  const store: TokenStore = {
    load: () => inner.load(),
    persist: (p) => {
      events.push('persist');
      stateInPersist = machine.state();
      return inner.persist(p);
    },
    withLock: (fn) => inner.withLock(fn),
  };
  const machine = createRefreshMachine({
    clock,
    store,
    refreshHttp: (rt) => {
      events.push(`refresh:${rt}`);
      return Promise.resolve(ok('access-2', { refresh: 'refresh-2', expiresIn: 7200 }));
    },
  });
  await machine.getAccessToken();

  const token = await machine.handleUnauthorized('access-1');
  events.push('released');
  assert.equal(token, 'access-2');
  assert.deepEqual(
    events,
    ['refresh:refresh-1', 'persist', 'released'],
    'token response → persist → only then is the token released',
  );
  assert.equal(stateInPersist, 'PERSISTING');
});

test('AUTH-1: a rotation that cannot be persisted is never used — the machine fails closed', async () => {
  const clock = fakeClock();
  const inner = inMemoryTokenStore(pairAt(clock));
  const store: TokenStore = {
    load: () => inner.load(),
    persist: () => Promise.reject(new Error('disk full')),
    withLock: (fn) => inner.withLock(fn),
  };
  const stub = refreshStub(ok('access-2', { refresh: 'refresh-2', expiresIn: 7200 }));
  const machine = createRefreshMachine({ clock, store, refreshHttp: stub.fn });
  await machine.getAccessToken();

  const err = await captureError(machine.handleUnauthorized('access-1'));
  assert.equal(err.kind, 'auth');
  assert.match(err.message, /unsaved rotation/);
  assert.match(err.message, /npx x-mcp-ai authorize/);
  assert.equal(machine.state(), 'FAILED_CLOSED');

  // Terminal: the burned refresh token must never be refreshed a second time.
  const err2 = await captureError(machine.handleUnauthorized('access-1'));
  assert.equal(err2, err, 'the same terminal error, no second refresh');
  assert.equal(stub.calls.length, 1);
});

test('AUTH-12: persistence flows ONLY through the TokenStore port, in the frozen TokenPair shape (0600/atomicity are the file store contract, T-202)', async () => {
  // The machine does no file I/O of its own — the injected store observes every write,
  // and the file store (T-202) is the sole owner of 0600 permissions and tmp+rename
  // atomicity for those writes.
  const stub = refreshStub(ok('access-2', { refresh: 'refresh-2', expiresIn: 5400 }));
  const { clock, store, machine } = setup({ stub });
  await machine.getAccessToken();
  await machine.handleUnauthorized('access-1');

  assert.equal(store.persistCount(), 1);
  assert.deepEqual(await store.load(), {
    access_token: 'access-2',
    refresh_token: 'refresh-2',
    obtained_at: clock.now(),
    expires_in: 5400,
    version: 2,
  });
});

// ---------------------------------------------------------------------------------
// Non-rotating tolerance (AUTH-6)
// ---------------------------------------------------------------------------------

test('AUTH-6: a refresh response WITHOUT a refresh_token retains the old one for the next cycle', async () => {
  const stub = refreshStub(
    ok('access-2', { expiresIn: 7200 }), // no refresh_token in the response
    ok('access-3', { refresh: 'refresh-3', expiresIn: 7200 }),
  );
  const { store, machine } = setup({ stub });
  await machine.getAccessToken();

  assert.equal(await machine.handleUnauthorized('access-1'), 'access-2');
  assert.equal((await store.load())?.refresh_token, 'refresh-1', 'old refresh token retained');

  assert.equal(await machine.handleUnauthorized('access-2'), 'access-3');
  assert.deepEqual(
    stub.calls,
    ['refresh-1', 'refresh-1'],
    'the retained token drove the next refresh',
  );
});

test('AUTH-6: a refresh response repeating the SAME refresh_token persists without error', async () => {
  const stub = refreshStub(ok('access-2', { refresh: 'refresh-1', expiresIn: 7200 }));
  const { store, machine } = setup({ stub });
  await machine.getAccessToken();

  assert.equal(await machine.handleUnauthorized('access-1'), 'access-2');
  assert.equal(store.persistCount(), 1);
  assert.equal((await store.load())?.refresh_token, 'refresh-1');
});

test('AUTH-6: a ROTATED refresh_token replaces the old one and drives the next cycle; the persisted version increments', async () => {
  const stub = refreshStub(
    ok('access-2', { refresh: 'refresh-2', expiresIn: 7200 }),
    ok('access-3', { refresh: 'refresh-3', expiresIn: 7200 }),
  );
  const { store, machine } = setup({ stub });
  await machine.getAccessToken();

  await machine.handleUnauthorized('access-1');
  assert.equal((await store.load())?.version, 2);
  await machine.handleUnauthorized('access-2');
  assert.equal((await store.load())?.version, 3);
  assert.deepEqual(stub.calls, ['refresh-1', 'refresh-2'], 'rotation observed, then used');
});

// ---------------------------------------------------------------------------------
// Refresh failure taxonomy (AUTH-8)
// ---------------------------------------------------------------------------------

test('AUTH-8: invalid_grant is terminal — typed auth error with the re-authorize instruction and NO retry loop', async () => {
  const stub = refreshStub(rejected(400, 'invalid_grant', 'Refresh token has been revoked'));
  const { machine } = setup({ stub });
  await machine.getAccessToken();

  const err = await captureError(machine.handleUnauthorized('access-1'));
  assert.equal(err.kind, 'auth');
  assert.equal(err.retryable, false);
  assert.equal(err.fix, 'operator');
  assert.match(err.message, /npx x-mcp-ai authorize/);
  assert.equal(err.data.http_status, 400);
  assert.equal(err.data.platform_title, 'invalid_grant');
  assert.equal(err.data.platform_detail, 'Refresh token has been revoked');
  assert.equal(machine.state(), 'FAILED_CLOSED');

  // Every later call fails immediately with the SAME error; the token endpoint is never
  // called again (401 → refresh → rejection → stop).
  assert.equal(await captureError(machine.handleUnauthorized('access-1')), err);
  assert.equal(await captureError(machine.getAccessToken()), err);
  assert.equal(stub.calls.length, 1);
});

test('AUTH-8: a bare 4xx rejection without OAuth error fields is terminal — no parenthetical, no platform data', async () => {
  const stub = refreshStub(rejected(401));
  const { machine } = setup({ stub });
  await machine.getAccessToken();

  const err = await captureError(machine.handleUnauthorized('access-1'));
  assert.equal(err.kind, 'auth');
  // With no `error` field there is no `(...)` insert — the sentence reads cleanly.
  assert.match(err.message, /X rejected the stored refresh token; re-authorization is required/);
  assert.equal(err.data.http_status, 401);
  assert.equal(err.data.platform_title, undefined);
  assert.equal(err.data.platform_detail, undefined);
  assert.equal(machine.state(), 'FAILED_CLOSED');
});

test('AUTH-8: a transient 5xx from the token endpoint is retryable and NOT terminal — the next attempt may refresh again', async () => {
  const stub = refreshStub(
    rejected(503),
    ok('access-2', { refresh: 'refresh-2', expiresIn: 7200 }),
  );
  const { store, machine } = setup({ stub });
  await machine.getAccessToken();

  const err = await captureError(machine.handleUnauthorized('access-1'));
  assert.equal(err.kind, 'api');
  assert.equal(err.retryable, true);
  assert.equal(err.data.http_status, 503);
  assert.notEqual(machine.state(), 'FAILED_CLOSED');
  assert.equal(store.persistCount(), 0, 'nothing rotated, nothing persisted');

  assert.equal(await machine.handleUnauthorized('access-1'), 'access-2', 'recovery works');
  assert.equal(stub.calls.length, 2);
});

test('AUTH-8: a thrown transport failure surfaces as a retryable network error; a thrown XError passes through as-is', async () => {
  const stub = refreshStub(
    new Error('ECONNRESET'),
    ok('access-2', { refresh: 'refresh-2', expiresIn: 7200 }),
  );
  const { store, machine } = setup({ stub });
  await machine.getAccessToken();

  const err = await captureError(machine.handleUnauthorized('access-1'));
  assert.equal(err.kind, 'network');
  assert.equal(err.retryable, true);
  assert.match(err.message, /tokens are unchanged/);
  assert.equal(store.persistCount(), 0);
  assert.equal(await machine.handleUnauthorized('access-1'), 'access-2', 'not terminal');

  // An XError thrown by the callable (e.g. T-203 classifying an ambiguous mid-flight
  // timeout itself) must not be re-wrapped.
  const custom = new XError('network', 'ambiguous refresh timeout');
  const clock2 = fakeClock();
  const store2 = inMemoryTokenStore(pairAt(clock2));
  const machine2 = createRefreshMachine({
    clock: clock2,
    store: store2,
    refreshHttp: () => Promise.reject(custom),
  });
  await machine2.getAccessToken();
  assert.equal(await captureError(machine2.handleUnauthorized('access-1')), custom);
});

test('AUTH-8: a completed refresh that echoes the rejected access token fails closed (never hands the rejected token back)', async () => {
  const stub = refreshStub(ok('access-1', { refresh: 'refresh-2', expiresIn: 7200 }));
  const { machine } = setup({ stub });
  await machine.getAccessToken();

  const err = await captureError(machine.handleUnauthorized('access-1'));
  assert.equal(err.kind, 'auth');
  assert.match(err.message, /same access token/);
  assert.equal(machine.state(), 'FAILED_CLOSED');
});

test('AUTH-8: a JOINER whose rejected token is the refresh outcome fails closed instead of spinning', async () => {
  // The first 401 starts the flight; a second 401 — for the very token that flight is
  // about to mint — joins it and must NOT hand that same token back (§4A invariant 5).
  const gate = deferred<RefreshHttpResult>();
  const clock = fakeClock();
  const store = inMemoryTokenStore(pairAt(clock));
  const machine = createRefreshMachine({ clock, store, refreshHttp: () => gate.promise });
  await machine.getAccessToken();

  const first = machine.handleUnauthorized('access-1');
  const second = machine.handleUnauthorized('access-2'); // joins; its 401 was for the outcome
  gate.resolve(ok('access-2', { refresh: 'refresh-2', expiresIn: 7200 }));

  assert.equal(await first, 'access-2', 'the original caller is served the rotation');
  const err = await captureError(second);
  assert.equal(err.kind, 'auth');
  assert.match(err.message, /still yields the rejected access token/);
  assert.equal(machine.state(), 'FAILED_CLOSED');
});

test('AUTH-8: a 200 refresh response with no usable access token is ambiguous and fails closed', async () => {
  const stub = refreshStub(ok(''));
  const { machine } = setup({ stub });
  await machine.getAccessToken();

  const err = await captureError(machine.handleUnauthorized('access-1'));
  assert.equal(err.kind, 'auth');
  assert.match(err.message, /no usable access token/);
  assert.equal(machine.state(), 'FAILED_CLOSED');
});

// ---------------------------------------------------------------------------------
// Corrupt / partial / absent stored state (AUTH-9) and missing pair
// ---------------------------------------------------------------------------------

test('AUTH-9: an unreadable token store surfaces a typed auth error — no crash, no delete, and not terminal', async () => {
  const clock = fakeClock();
  const inner = inMemoryTokenStore(pairAt(clock));
  let broken = true;
  const store: TokenStore = {
    load: () => (broken ? Promise.reject(new Error('unexpected end of JSON input')) : inner.load()),
    persist: (p) => inner.persist(p),
    withLock: (fn) => inner.withLock(fn),
  };
  const stub = refreshStub();
  const machine = createRefreshMachine({ clock, store, refreshHttp: stub.fn });

  const err = await captureError(machine.getAccessToken());
  assert.equal(err.kind, 'auth');
  assert.match(err.message, /npx x-mcp-ai authorize/);
  assert.equal(inner.persistCount(), 0, 'the machine never rewrites or deletes the stored file');
  assert.notEqual(machine.state(), 'FAILED_CLOSED');

  // The operator repairs / re-authorizes; the next call simply re-reads and works.
  broken = false;
  assert.equal(await machine.getAccessToken(), 'access-1');
  assert.equal(stub.calls.length, 0);
});

test('AUTH-9: an XError thrown by the store (the file store names the offending path) passes through verbatim', async () => {
  const pathful = new XError(
    'auth',
    'Token file /tmp/x/tokens.json is corrupt; run `npx x-mcp-ai authorize`.',
  );
  const store: TokenStore = {
    load: () => Promise.reject(pathful),
    persist: () => Promise.resolve(),
    withLock: (fn) => fn(),
  };
  const machine = createRefreshMachine({
    clock: fakeClock(),
    store,
    refreshHttp: refreshStub().fn,
  });
  assert.equal(await captureError(machine.getAccessToken()), pathful);
});

test('AUTH-9: a stored pair missing its access token is a typed auth error, not a crash', async () => {
  const clock = fakeClock();
  const { machine, stub } = setup({ clock, pair: pairAt(clock, { access_token: '' }) });
  const err = await captureError(machine.getAccessToken());
  assert.equal(err.kind, 'auth');
  assert.match(err.message, /missing an access token/);
  assert.match(err.message, /npx x-mcp-ai authorize/);
  assert.equal(stub.calls.length, 0);
});

test('no stored tokens at all → typed auth error with the authorize instruction; a later authorize is picked up', async () => {
  const { clock, store, machine, stub } = setup({ pair: null });
  const err = await captureError(machine.getAccessToken());
  assert.equal(err.kind, 'auth');
  assert.match(err.message, /npx x-mcp-ai authorize/);
  assert.equal(stub.calls.length, 0);

  store.seed(pairAt(clock)); // `authorize` ran meanwhile — not terminal, just retry
  assert.equal(await machine.getAccessToken(), 'access-1');
});

test('a 401 with nothing in memory AND nothing on disk reports no stored tokens to refresh', async () => {
  // The reactive path with a cold machine over an empty store: the under-lock reload
  // finds nothing to adopt and nothing to refresh from — typed auth error, not terminal.
  const { machine, stub } = setup({ pair: null });
  const err = await captureError(machine.handleUnauthorized('access-x'));
  assert.equal(err.kind, 'auth');
  assert.match(err.message, /No stored OAuth tokens to refresh/);
  assert.match(err.message, /npx x-mcp-ai authorize/);
  assert.equal(stub.calls.length, 0);
  assert.notEqual(machine.state(), 'FAILED_CLOSED');
});

// ---------------------------------------------------------------------------------
// Missing refresh token (AUTH-10)
// ---------------------------------------------------------------------------------

test('AUTH-10: with no refresh token the access token serves until it actually expires — then re-auth is required', async () => {
  const clock = fakeClock();
  const { machine, stub, store } = setup({ clock, pair: pairWithoutRefresh(clock) });

  assert.equal(await machine.getAccessToken(), 'access-only', 'fully valid → served');

  clock.advance(7200_000 - 120_000); // 2 min left: inside the eager margin, still valid
  assert.equal(machine.state(), 'EAGER');
  assert.equal(
    await machine.getAccessToken(),
    'access-only',
    'usable until expiry, no refresh attempt',
  );
  assert.equal(stub.calls.length, 0);

  clock.advance(120_000); // now fully expired
  const err = await captureError(machine.getAccessToken());
  assert.equal(err.kind, 'auth');
  assert.match(err.message, /no refresh token/);
  assert.match(err.message, /npx x-mcp-ai authorize/);
  assert.notEqual(machine.state(), 'FAILED_CLOSED', 're-authorization can still recover it');
  assert.equal(store.persistCount(), 0);
});

test('AUTH-10: a 401 with no stored refresh token reloads first (a peer may have re-authorized), then reports re-auth required', async () => {
  const clock = fakeClock();
  const { machine, stub, store } = setup({ clock, pair: pairWithoutRefresh(clock) });
  await machine.getAccessToken();
  const loadsBefore = store.loadCount();

  // Disk matches memory: nothing to adopt, nothing to refresh with → typed auth error.
  const err = await captureError(machine.handleUnauthorized('access-only'));
  assert.equal(err.kind, 'auth');
  assert.match(err.message, /no refresh token is stored/);
  assert.ok(store.loadCount() > loadsBefore, 'the reload happened before giving up');
  assert.equal(stub.calls.length, 0);

  // A peer wrote a full pair on the shared store → the same 401 path now adopts it.
  store.seed(pairAt(clock, { access_token: 'access-2', refresh_token: 'refresh-2', version: 2 }));
  assert.equal(await machine.handleUnauthorized('access-only'), 'access-2');
  assert.equal(stub.calls.length, 0, 'recovery came from adoption, not refresh');
});

// ---------------------------------------------------------------------------------
// Unknown lifetime (AUTH-11)
// ---------------------------------------------------------------------------------

test('AUTH-11: missing expires_in/obtained_at disables eager refresh — the reactive 401 path remains the source of truth', async () => {
  const clock = fakeClock();
  // Runtime-missing fields (a hand-edited or legacy token file) — the frozen TokenPair
  // type declares them, so the partial shape needs a cast.
  const partial = {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
  } as TokenPair;
  const stub = refreshStub(ok('access-2', { refresh: 'refresh-2', expiresIn: 7200 }));
  const { machine } = setup({ clock, pair: partial, stub });

  clock.advance(365 * 24 * 3600_000); // a year later: lifetime is uncomputable, NOT expired
  assert.equal(await machine.getAccessToken(), 'access-1', 'no crash, no assumed lifetime');
  assert.equal(machine.state(), 'UNKNOWN_LIFETIME');
  assert.equal(stub.calls.length, 0, 'eager refresh is disabled');

  // The reactive path still refreshes normally.
  assert.equal(await machine.handleUnauthorized('access-1'), 'access-2');
  assert.deepEqual(stub.calls, ['refresh-1']);
});

test('AUTH-11: a refresh response without expires_in yields an unknown-lifetime pair — eager stays disabled for it', async () => {
  const stub = refreshStub(ok('access-2', { refresh: 'refresh-2' })); // no expires_in
  const { clock, machine } = setup({ stub });
  await machine.getAccessToken();

  assert.equal(await machine.handleUnauthorized('access-1'), 'access-2');
  assert.equal(machine.state(), 'UNKNOWN_LIFETIME');
  clock.advance(24 * 3600_000);
  assert.equal(
    await machine.getAccessToken(),
    'access-2',
    'served reactively, never eagerly refreshed',
  );
  assert.equal(stub.calls.length, 1);
});
