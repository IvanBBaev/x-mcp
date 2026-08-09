// Tests for the OAuth2 integration facade (T-203, src/api/oauth2/index.ts): the
// machine-backed AuthorizationProvider, the 401 → refresh → retry-once orchestration
// (§4A step 6, AUTH-8), and the production fetch RefreshHttp adapter. The two CANONICAL
// cross-module tests live here: reload-under-lock / adopt-on-disk-pair (AUTH-3) and
// persist-before-use (AUTH-1), both observed at the request seam the way a real serve
// path would see them.
//
// Everything is deterministic: time from the fake Clock, persistence from the in-memory
// TokenStore fake, the token endpoint from a scripted stub — and the fetch adapter runs
// against the undici MockAgent with net connect disabled. No disk, no timers, no network.

import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeClock, inMemoryTokenStore, mockHttp } from '../../helpers/index.js';
import type { FakeClock } from '../../helpers/index.js';
import { XError } from '../../../src/core/errors.js';
import type { TokenPair, TokenStore } from '../../../src/core/ports.js';
import type { EndpointInvoker, XApiRequest } from '../../../src/core/tooldef.js';
import { mapHttpError } from '../../../src/api/errors.js';
import type { AuthorizationProvider } from '../../../src/api/http.js';
import { LOCK_STALE_MS } from '../../../src/api/oauth2/filestore.js';
import {
  REFRESH_HTTP_TIMEOUT_MS,
  type RefreshHttp,
  type RefreshHttpResult,
} from '../../../src/api/oauth2/machine.js';
import {
  TOKEN_ENDPOINT_PATH,
  createFetchRefreshHttp,
  createOAuth2Auth,
} from '../../../src/api/oauth2/index.js';

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

/** A scripted refresh stub: each call consumes the next step; extra calls fail the test. */
interface RefreshStub {
  readonly fn: RefreshHttp;
  readonly calls: string[];
}

function refreshStub(...steps: readonly RefreshHttpResult[]): RefreshStub {
  const calls: string[] = [];
  const queue = [...steps];
  const fn: RefreshHttp = (refreshToken) => {
    calls.push(refreshToken);
    const step = queue.shift();
    if (step === undefined) {
      return Promise.reject(new Error('refreshStub: unexpected extra token-endpoint call'));
    }
    return Promise.resolve(step);
  };
  return { fn, calls };
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

/** The mapped credentials-rejected error the wrapper must react to (api/errors, 401). */
function unauthorized(): XError {
  return mapHttpError(401, new Headers(), { title: 'Unauthorized' }, 0);
}

const REQ: XApiRequest = { method: 'GET', path: '/2/users/me' };

/**
 * Simulate api/http's send at the seam the wrapper composes over: fetch the
 * `authorization` header exactly once per send (as `buildHeaders` does), record it, then
 * answer per the script — returning a payload or throwing a mapped XError.
 */
interface ScriptedInvoker {
  readonly invoker: EndpointInvoker;
  /** The `authorization` header value each send went out with, in order. */
  readonly sends: string[];
}

function scriptedInvoker(
  authorization: AuthorizationProvider,
  respond: (bearer: string, call: number) => unknown,
): ScriptedInvoker {
  const sends: string[] = [];
  const invoker: EndpointInvoker = {
    async send<T>(_req: XApiRequest): Promise<T> {
      const bearer = (await authorization()) ?? '(unauthenticated)';
      sends.push(bearer);
      return respond(bearer, sends.length) as T;
    },
  };
  return { invoker, sends };
}

// --- The two canonical cross-module tests ---------------------------------------------

test('AUTH-3 (canonical): a 401 adopts a fresh on-disk pair under the lock instead of refreshing', async () => {
  const clock = fakeClock();
  const store = inMemoryTokenStore(pairAt(clock));
  const stub = refreshStub(); // ANY token-endpoint call fails the test
  const auth = createOAuth2Auth({ clock, store, refreshHttp: stub.fn });

  const peer: TokenPair = {
    access_token: 'peer-access',
    refresh_token: 'peer-refresh',
    obtained_at: clock.now(),
    expires_in: 7200,
    version: 2,
  };
  const { invoker, sends } = scriptedInvoker(auth.authorization, (bearer, call) => {
    if (call === 1) {
      // The peer's rotation lands on disk while our request is in flight; then X
      // rejects the token we signed with.
      store.seed(peer);
      throw unauthorized();
    }
    assert.equal(bearer, 'Bearer peer-access', 'the retry must sign with the ADOPTED pair');
    return { data: 'ok' };
  });

  const result = await auth.withAuthRetry(invoker).send<{ data: string }>(REQ);
  assert.deepEqual(result, { data: 'ok' });
  assert.deepEqual(sends, ['Bearer access-1', 'Bearer peer-access']);
  // The whole recovery burned ZERO refresh calls (the peer's rotation was adopted) and
  // persisted nothing (adoption reads the store; it never writes it).
  assert.deepEqual(stub.calls, []);
  assert.equal(store.persistCount(), 0);
});

test('AUTH-1 (canonical): a refreshed pair is persisted BEFORE any request signs with it', async () => {
  const clock = fakeClock();
  const store = inMemoryTokenStore(pairAt(clock));
  const persisted: string[] = [];
  // Spy on the persist seam so the invoker can assert ordering AT SEND TIME.
  const spy: TokenStore = {
    load: () => store.load(),
    persist: (next) => {
      persisted.push(next.access_token);
      return store.persist(next);
    },
    withLock: (fn) => store.withLock(fn),
  };
  const stub = refreshStub(ok('access-2', { refresh: 'refresh-2', expiresIn: 7200 }));
  const auth = createOAuth2Auth({ clock, store: spy, refreshHttp: stub.fn });

  const { invoker, sends } = scriptedInvoker(auth.authorization, (bearer, call) => {
    if (call === 1) throw unauthorized();
    // Persist-before-use, observed at the wire seam: by the time the retried request
    // goes out with the rotated token, that token is ALREADY in the store.
    assert.equal(bearer, 'Bearer access-2');
    assert.deepEqual(persisted, ['access-2'], 'the pair must be persisted before this send');
    return { data: 'ok' };
  });

  const result = await auth.withAuthRetry(invoker).send<{ data: string }>(REQ);
  assert.deepEqual(result, { data: 'ok' });
  assert.deepEqual(sends, ['Bearer access-1', 'Bearer access-2']);
  assert.deepEqual(stub.calls, ['refresh-1']); // exactly one refresh, with the stored token
});

// --- Retry-once orchestration (§4A step 6) --------------------------------------------

test('AUTH-8: a second 401 on the retried request is terminal — exactly one retry, no loop', async () => {
  const clock = fakeClock();
  const store = inMemoryTokenStore(pairAt(clock));
  const stub = refreshStub(ok('access-2'));
  const auth = createOAuth2Auth({ clock, store, refreshHttp: stub.fn });

  const { invoker, sends } = scriptedInvoker(auth.authorization, () => {
    throw unauthorized();
  });

  const err = await captureError(auth.withAuthRetry(invoker).send(REQ));
  assert.equal(err.kind, 'auth');
  assert.equal(err.data.http_status, 401);
  assert.match(err.message, /AUTH-8/);
  assert.equal(sends.length, 2, 'exactly one retry — never a loop');
  assert.equal(stub.calls.length, 1, 'exactly one refresh per triggering request');
});

test('non-401 failures pass through untouched — no refresh, no retry', async () => {
  const clock = fakeClock();
  const store = inMemoryTokenStore(pairAt(clock));
  const stub = refreshStub();
  const auth = createOAuth2Auth({ clock, store, refreshHttp: stub.fn });

  const { invoker, sends } = scriptedInvoker(auth.authorization, () => {
    throw mapHttpError(500, new Headers(), { title: 'oops' }, 0);
  });

  const err = await captureError(auth.withAuthRetry(invoker).send(REQ));
  assert.equal(err.kind, 'api');
  assert.equal(sends.length, 1);
  assert.deepEqual(stub.calls, []);
});

test('SCOPE-1: an insufficient-scope 401 never triggers a refresh (kind `scope`, not `auth`)', async () => {
  const clock = fakeClock();
  const store = inMemoryTokenStore(pairAt(clock));
  const stub = refreshStub();
  const auth = createOAuth2Auth({ clock, store, refreshHttp: stub.fn });

  const { invoker, sends } = scriptedInvoker(auth.authorization, () => {
    // A scope rejection cannot be repaired by a refresh — only by re-authorizing with
    // more scopes; refreshing would burn a rotation for nothing.
    throw mapHttpError(
      401,
      new Headers(),
      { title: 'Unauthorized', detail: 'insufficient scopes for this endpoint' },
      0,
    );
  });

  const err = await captureError(auth.withAuthRetry(invoker).send(REQ));
  assert.equal(err.kind, 'scope');
  assert.equal(sends.length, 1);
  assert.deepEqual(stub.calls, []);
});

test('the provider signs from the stored pair, and an empty store throws typed (AUTH-9)', async () => {
  const clock = fakeClock();
  const stocked = createOAuth2Auth({
    clock,
    store: inMemoryTokenStore(pairAt(clock)),
    refreshHttp: refreshStub().fn,
  });
  assert.equal(await stocked.authorization(), 'Bearer access-1');

  const empty = createOAuth2Auth({
    clock,
    store: inMemoryTokenStore(null),
    refreshHttp: refreshStub().fn,
  });
  const err = await captureError(empty.authorization());
  assert.equal(err.kind, 'auth');
  assert.match(err.message, /authorize/);
});

// --- The production fetch RefreshHttp adapter -----------------------------------------

test('AUTH-5: the refresh timeout stays strictly below the lock-staleness threshold', () => {
  // The §4A cross-module invariant this integration owns: a hung refresh must never
  // outlive its own lock's staleness window.
  assert.ok(REFRESH_HTTP_TIMEOUT_MS < LOCK_STALE_MS);
});

test('fetch adapter: confidential client POSTs the form with HTTP Basic and maps a 200', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: TOKEN_ENDPOINT_PATH,
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('client-1:secret-1').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=refresh_token&refresh_token=refresh-1&client_id=client-1',
    })
    .reply(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 7200 });

  const http = createFetchRefreshHttp({
    baseUrl: 'https://api.x.com',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    dispatcher: mock.dispatcher,
  });
  assert.deepEqual(await http('refresh-1'), {
    ok: true,
    token: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 7200 },
  });

  mock.assertDone();
  await mock.close();
});

test('fetch adapter: a public client sends NO authorization header, and unusable optional fields are dropped', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: TOKEN_ENDPOINT_PATH,
      method: 'POST',
      headers: (headers) => !('authorization' in headers),
      body: 'grant_type=refresh_token&refresh_token=refresh-1&client_id=client-1',
    })
    .reply(200, { access_token: 'access-2', refresh_token: '', expires_in: -5 });

  const http = createFetchRefreshHttp({
    baseUrl: 'https://api.x.com',
    clientId: 'client-1',
    dispatcher: mock.dispatcher,
  });
  // Empty/negative optional fields vanish → the machine reads "no rotation, unknown
  // lifetime" (AUTH-6/11) instead of garbage.
  assert.deepEqual(await http('refresh-1'), { ok: true, token: { access_token: 'access-2' } });

  mock.assertDone();
  await mock.close();
});

test('fetch adapter: a rejection maps to ok:false with a SANITIZED error code', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: TOKEN_ENDPOINT_PATH, method: 'POST' })
    .reply(400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
  mock.pool
    .intercept({ path: TOKEN_ENDPOINT_PATH, method: 'POST' })
    .reply(400, { error: 'bad code <script>' }); // fails the machine-token shape

  const http = createFetchRefreshHttp({
    baseUrl: 'https://api.x.com',
    clientId: 'client-1',
    dispatcher: mock.dispatcher,
  });
  assert.deepEqual(await http('refresh-1'), {
    ok: false,
    status: 400,
    error: 'invalid_grant',
    error_description: 'refresh token revoked',
  });
  assert.deepEqual(await http('refresh-1'), { ok: false, status: 400, error: 'unknown_error' });

  mock.assertDone();
  await mock.close();
});

test('fetch adapter: a mid-flight timeout classifies as a RETRYABLE network error', async () => {
  const mock = mockHttp();
  // undici surfaces a dispatcher error as fetch's TypeError with the original as `cause` —
  // the adapter must recognize the TimeoutError shape either way (same as api/http).
  const timeoutish = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  mock.pool.intercept({ path: TOKEN_ENDPOINT_PATH, method: 'POST' }).replyWithError(timeoutish);

  const http = createFetchRefreshHttp({
    baseUrl: 'https://api.x.com',
    clientId: 'client-1',
    dispatcher: mock.dispatcher,
  });
  const err = await captureError(http('refresh-1'));
  assert.equal(err.kind, 'network');
  assert.equal(err.retryable, true);
  assert.match(err.message, /unchanged locally/); // the safe-to-retry rationale
  assert.match(err.message, /25 s/);

  mock.assertDone();
  await mock.close();
});

test('fetch adapter: a non-timeout transport failure rethrows RAW for the machine to wrap', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: TOKEN_ENDPOINT_PATH, method: 'POST' })
    .replyWithError(new Error('connection reset'));

  const http = createFetchRefreshHttp({
    baseUrl: 'https://api.x.com',
    clientId: 'client-1',
    dispatcher: mock.dispatcher,
  });
  await assert.rejects(http('refresh-1'), (err) => !XError.is(err));

  mock.assertDone();
  await mock.close();
});

test('fetch adapter: a missing client id fails typed at refresh time, before any network', async () => {
  const http = createFetchRefreshHttp({ baseUrl: 'https://api.x.com' });
  const err = await captureError(http('refresh-1'));
  assert.equal(err.kind, 'auth');
  assert.match(err.message, /X_MCP_CLIENT_ID/);
  assert.match(err.message, /unchanged/); // the stored tokens survive — usable until expiry
});
