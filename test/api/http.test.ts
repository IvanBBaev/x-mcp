// Tests for the host-scoped HTTP client (api/http, T-114). Every request goes through the
// real global-fetch path with an injected undici MockAgent (test/helpers/http.ts), so no
// real network happens. Coverage is tagged to the docs/07 requirements it proves:
//   AUTH-14 — host-scoped auth + redirects never followed
//   CFG-7   — proxy env is ignored (default/injected dispatcher, never a ProxyAgent)
//   NET-1   — body tolerance: empty / non-JSON / oversized, no raw body text in errors
//   NET-2   — transport failures mapped to `network` (connect AND mid-body), timeouts distinguished
//   NET-3   — GET retries exactly once on 5xx/network; writes never auto-retry
//   MCP-7   — host cancellation before AND during the response; a cancelled write is POST-4-ambiguous
//   RATE-1/2/4 — the onResponse seam (T-320 F6): every response, once per attempt, before any decision

import test from 'node:test';
import assert from 'node:assert/strict';

import { XError } from '../../src/core/errors.js';
import { createHttpClient, shouldAttachAuth, DEFAULT_API_BASE_URL } from '../../src/api/http.js';
import type { HttpClientConfig } from '../../src/api/http.js';
import type { Dispatcher } from '../../src/core/ports.js';
import { mockHttp, fakeClock, fakeSleep, fakeRandom } from '../helpers/index.js';

// Case-insensitive header lookup over the object the MockAgent reply callback captures.
function headerValue(headers: unknown, name: string): string | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === wanted)
      return Array.isArray(value) ? String(value[0]) : String(value);
  }
  return undefined;
}

// Build a client + its recording sleep/random over a given mock, with sensible test defaults.
function makeClient(http: ReturnType<typeof mockHttp>, overrides: Partial<HttpClientConfig> = {}) {
  const clock = fakeClock(0);
  const sleep = fakeSleep(clock);
  const random = fakeRandom([0.5]); // backoff = 250 + 0.5*500 = 500ms, deterministic
  const config: HttpClientConfig = {
    sleep: sleep.fn,
    random,
    dispatcher: http.dispatcher,
    ...overrides,
  };
  return { client: createHttpClient(config), sleep, random };
}

async function rejects(promise: Promise<unknown>): Promise<XError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(XError.is(err), `expected an XError, got ${String(err)}`);
    return err;
  }
  throw new assert.AssertionError({ message: 'expected the promise to reject, but it resolved' });
}

// The union of the two undici handler protocols this decorator has to speak: the bundled
// fetch on Node 22 drives a dispatcher with v1 callbacks (`onComplete` / `onError`), Node 24+
// with v2 (`onResponseEnd` / `onResponseError`). Only the members touched here are named.
interface BodySink {
  onRequestStart?: unknown;
  onComplete?(trailers: unknown): void;
  onError?(err: Error): void;
  onResponseEnd?(controller: unknown, trailers: unknown): void;
  onResponseError?(controller: unknown, err: Error): void;
}

/** What befalls a response once its bytes were delivered: die in an error, or never finish. */
type MidBodyFate = { readonly die: Error } | { readonly stall: () => void };

/**
 * Wrap a dispatcher so the FIRST `fates.length` responses do not complete cleanly: status
 * and bytes are delivered as the mock replied them, then the stream either ends in the
 * queued error — an ECONNRESET after the headers, exactly the NET-2 case the MockAgent
 * alone cannot stage (`replyWithError` fails before any response exists) — or stalls open
 * forever, with `stall` told so a test can cancel a request whose body is still streaming
 * (MCP-7). Both act a macrotask later because a real socket never resets synchronously
 * inside `dispatch`, and fetch wires its stream-error listener only after `onHeaders`.
 * Later responses pass through untouched, so a retry can succeed.
 */
function midBody(inner: Dispatcher, fates: MidBodyFate[]): Dispatcher {
  const dispatcher = {
    dispatch(opts: unknown, handler: BodySink): boolean {
      const fate = fates.shift();
      const spy = fate === undefined ? handler : (Object.create(handler) as BodySink);
      if (fate !== undefined) {
        // Replaces the clean completion: raise the error through the handler, or just tell.
        const instead = (raise: (err: Error) => void): void => {
          setImmediate(() => ('die' in fate ? raise(fate.die) : fate.stall()));
        };
        if ('onRequestStart' in handler) {
          spy.onResponseEnd = function (this: BodySink, controller: unknown) {
            instead((err) => handler.onResponseError?.call(this, controller, err));
          };
        } else {
          spy.onComplete = function (this: BodySink) {
            instead((err) => handler.onError?.call(this, err));
          };
        }
      }
      return (inner as unknown as { dispatch(o: unknown, h: BodySink): boolean }).dispatch(
        opts,
        spy,
      );
    },
    close: () => (inner as unknown as { close(): Promise<void> }).close(),
    destroy: () => (inner as unknown as { destroy(): Promise<void> }).destroy(),
  };
  return dispatcher as unknown as Dispatcher;
}

function connectionReset(): Error {
  return Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
}

// --- AUTH-14: host-scoped auth ---------------------------------------------------

test('AUTH-14: attaches the injected Authorization header for the API host only', async () => {
  const http = mockHttp();
  let captured: unknown;
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply((opts) => {
    captured = opts.headers;
    return { statusCode: 200, data: { data: { id: '1' } } };
  });

  const { client } = makeClient(http, {
    authorization: () => Promise.resolve('Bearer TOKEN-123'),
  });
  const body = await client.send<{ data: { id: string } }>({ method: 'GET', path: '/2/tweets/1' });

  assert.equal(body.data.id, '1');
  assert.equal(headerValue(captured, 'authorization'), 'Bearer TOKEN-123');
  assert.equal(headerValue(captured, 'accept'), 'application/json');
  http.assertDone();
  await http.close();
});

test('AUTH-14: omits Authorization when the provider yields no credential', async () => {
  const http = mockHttp();
  let captured: unknown;
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply((opts) => {
    captured = opts.headers;
    return { statusCode: 200, data: { data: { id: '1' } } };
  });

  const { client } = makeClient(http, { authorization: () => Promise.resolve(undefined) });
  await client.send({ method: 'GET', path: '/2/tweets/1' });

  assert.equal(headerValue(captured, 'authorization'), undefined);
  http.assertDone();
  await http.close();
});

test('AUTH-14: host-scoping predicate only matches the exact API origin', () => {
  const base = new URL(DEFAULT_API_BASE_URL);
  assert.equal(shouldAttachAuth(new URL('https://api.x.com/2/tweets'), base), true);
  // Never leak the token to a foreign host (a redirect target) or a downgraded scheme.
  assert.equal(shouldAttachAuth(new URL('https://evil.example/2/tweets'), base), false);
  assert.equal(shouldAttachAuth(new URL('https://api.x.com.evil.example/'), base), false);
  assert.equal(shouldAttachAuth(new URL('http://api.x.com/2/tweets'), base), false);
});

test('T10: the predicate is an allowlist, not equality — a foreign base URL gets no token', () => {
  // The case origin-equality alone would wave through: the operator-configured base URL IS
  // the attacker's host, so `requestUrl.host === baseUrl.host` is satisfied. The hardcoded
  // credential-egress list is what says no (docs/04 T10). oauth2 never reaches this — config
  // refuses that session outright — so this is the app-only path: it runs, unauthenticated.
  const foreign = new URL('https://x-api-mirror.evil');
  assert.equal(shouldAttachAuth(new URL('https://x-api-mirror.evil/2/tweets'), foreign), false);
  // A subdomain of the credential domain is still fine when that is what was configured.
  const sandbox = new URL('https://api.sandbox.x.com');
  assert.equal(shouldAttachAuth(new URL('https://api.sandbox.x.com/2/tweets'), sandbox), true);
});

test('AUTH-14: a redirect is refused, never followed (token cannot chase Location)', async () => {
  const http = mockHttp();
  // Single interceptor: if the client followed the redirect it would need a second request
  // (to the Location host) and — net connect disabled — throw a network error instead.
  http.pool
    .intercept({ path: '/2/redir', method: 'GET' })
    .reply(302, '', { headers: { location: 'https://evil.example/steal' } });

  const { client } = makeClient(http, {
    authorization: () => Promise.resolve('Bearer TOKEN-123'),
  });
  const err = await rejects(client.send({ method: 'GET', path: '/2/redir' }));

  assert.equal(err.kind, 'api');
  assert.equal(err.data.http_status, 302);
  http.assertDone(); // exactly the one request was made — the redirect was not chased
  await http.close();
});

// --- CFG-7: proxy env ignored ----------------------------------------------------

test('CFG-7: proxy env vars are ignored — the client never builds a ProxyAgent', async () => {
  // Production leaves the dispatcher undefined so global fetch uses its default dispatcher,
  // which ignores HTTP(S)_PROXY (documented in core/ports.ts). The client never reads proxy
  // env itself: with a bogus proxy set, a request still flows through the injected dispatcher.
  const saved = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    HTTP_PROXY: process.env.HTTP_PROXY,
    https_proxy: process.env.https_proxy,
    http_proxy: process.env.http_proxy,
  };
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9'; // non-routable; would fail if honored
  process.env.HTTP_PROXY = 'http://127.0.0.1:9';
  process.env.https_proxy = 'http://127.0.0.1:9';
  process.env.http_proxy = 'http://127.0.0.1:9';

  const http = mockHttp();
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply(200, { data: { id: '1' } });
  try {
    const { client } = makeClient(http);
    const body = await client.send<{ data: { id: string } }>({
      method: 'GET',
      path: '/2/tweets/1',
    });
    assert.equal(body.data.id, '1');
    http.assertDone();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await http.close();
  }
});

// --- NET-1: body tolerance -------------------------------------------------------

test('NET-1: an empty success body (204) resolves to undefined', async () => {
  const http = mockHttp();
  http.pool.intercept({ path: '/2/tweets/1', method: 'DELETE' }).reply(204, '');

  const { client } = makeClient(http);
  const body = await client.send({ method: 'DELETE', path: '/2/tweets/1' });

  assert.equal(body, undefined);
  http.assertDone();
  await http.close();
});

test('NET-1: a non-JSON 2xx body becomes a clean `api` error, not a parse crash', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/tweets/1', method: 'GET' })
    .reply(200, '<html>not json</html>', { headers: { 'content-type': 'text/html' } });

  const { client } = makeClient(http);
  const err = await rejects(client.send({ method: 'GET', path: '/2/tweets/1' }));

  assert.equal(err.kind, 'api');
  assert.doesNotMatch(err.message, /<html>/); // raw body text never inlined
  http.assertDone();
  await http.close();
});

test('NET-1: a non-JSON error body (Cloudflare-style HTML 502) never leaks into the message', async () => {
  const http = mockHttp();
  // A write (POST) so the 5xx is not retried — keeps the assertion on the error mapping.
  http.pool
    .intercept({ path: '/2/tweets', method: 'POST' })
    .reply(502, '<html><body>Bad Gateway</body></html>', {
      headers: { 'content-type': 'text/html' },
    });

  const { client } = makeClient(http);
  const err = await rejects(
    client.send({ method: 'POST', path: '/2/tweets', body: { text: 'hi' } }),
  );

  assert.equal(err.kind, 'api');
  assert.equal(err.data.http_status, 502);
  assert.doesNotMatch(err.message, /html|Bad Gateway/i);
  http.assertDone();
  await http.close();
});

test('NET-1: an oversized response body is refused with a terminal `api` error', async () => {
  const http = mockHttp();
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply(200, 'x'.repeat(500));

  const { client } = makeClient(http, { maxResponseBytes: 16 });
  const err = await rejects(client.send({ method: 'GET', path: '/2/tweets/1' }));

  assert.equal(err.kind, 'api');
  assert.match(err.message, /size limit/i);
  http.assertDone();
  await http.close();
});

test('NET-1: the injected mapError seam (T-116) receives status, headers and parsed body', async () => {
  const http = mockHttp();
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply(
    404,
    { title: 'Not Found', detail: 'missing' },
    {
      headers: { 'x-rate-limit-remaining': '10' },
    },
  );

  let seen: { status: number; header: string | null; body: unknown } | undefined;
  const { client } = makeClient(http, {
    mapError: (status, headers, body) => {
      seen = { status, header: headers.get('x-rate-limit-remaining'), body };
      return new XError('not-found', 'The requested resource was not found.');
    },
  });
  const err = await rejects(client.send({ method: 'GET', path: '/2/tweets/1' }));

  assert.equal(err.kind, 'not-found');
  assert.equal(seen?.status, 404);
  assert.equal(seen?.header, '10');
  assert.deepEqual(seen?.body, { title: 'Not Found', detail: 'missing' });
  http.assertDone();
  await http.close();
});

// --- NET-2: transport failures mapped to `network` -------------------------------

test('NET-2: a connection failure surfaces as `network`, raw cause never inlined', async () => {
  const http = mockHttp();
  // A write so there is no retry; the single interceptor throws on connect.
  http.pool
    .intercept({ path: '/2/tweets', method: 'POST' })
    .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

  const { client } = makeClient(http);
  const err = await rejects(
    client.send({ method: 'POST', path: '/2/tweets', body: { text: 'hi' } }),
  );

  assert.equal(err.kind, 'network');
  assert.equal(err.retryable, true); // network default
  assert.doesNotMatch(err.message, /ECONNRESET|socket hang up/);
  http.assertDone();
  await http.close();
});

test('NET-2: a per-attempt timeout maps to `network` with a distinct message', async () => {
  const http = mockHttp();
  // A write (no retry). The response is delayed well past the tiny timeout window.
  http.pool.intercept({ path: '/2/tweets', method: 'POST' }).reply(200, { ok: true }).delay(500);

  const { client } = makeClient(http, { timeoutMs: 10 });
  const err = await rejects(
    client.send({ method: 'POST', path: '/2/tweets', body: { text: 'hi' } }),
  );

  assert.equal(err.kind, 'network');
  assert.match(err.message, /timed out/i);
  await http.close();
});

test('NET-2: host cancellation before a response is reported as a cancelled `network` error', async () => {
  const http = mockHttp();
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply(200, { data: { id: '1' } });

  const controller = new AbortController();
  controller.abort(); // already cancelled by the host
  const { client, sleep } = makeClient(http, { signal: controller.signal });
  const err = await rejects(client.send({ method: 'GET', path: '/2/tweets/1' }));

  assert.equal(err.kind, 'network');
  assert.match(err.message, /cancelled/i);
  assert.deepEqual(sleep.calls, []); // cancellation is never retried
  await http.close();
});

// --- NET-3: GET retry-once; writes never retry -----------------------------------

test('NET-3: a GET retries exactly once on a 5xx, then succeeds; jitter is 250–750ms', async () => {
  const http = mockHttp();
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply(500, { e: 'boom' });
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply(200, { data: { id: '1' } });

  const { client, sleep } = makeClient(http);
  const body = await client.send<{ data: { id: string } }>({ method: 'GET', path: '/2/tweets/1' });

  assert.equal(body.data.id, '1');
  assert.equal(sleep.calls.length, 1);
  assert.ok(sleep.calls[0]! >= 250 && sleep.calls[0]! < 750, `backoff ${sleep.calls[0]}`);
  http.assertDone(); // both interceptors consumed → exactly two requests
  await http.close();
});

test('NET-3: a GET retries once on a network error, then succeeds', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/tweets/1', method: 'GET' })
    .replyWithError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply(200, { data: { id: '1' } });

  const { client, sleep } = makeClient(http);
  const body = await client.send<{ data: { id: string } }>({ method: 'GET', path: '/2/tweets/1' });

  assert.equal(body.data.id, '1');
  assert.equal(sleep.calls.length, 1);
  http.assertDone();
  await http.close();
});

test('NET-3: a GET gives up after a single retry (two 5xx → `api`)', async () => {
  const http = mockHttp();
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply(503, { e: 1 });
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply(503, { e: 2 });

  const { client, sleep } = makeClient(http);
  const err = await rejects(client.send({ method: 'GET', path: '/2/tweets/1' }));

  assert.equal(err.kind, 'api');
  assert.equal(err.data.http_status, 503);
  assert.equal(sleep.calls.length, 1); // retried exactly once
  http.assertDone(); // both interceptors consumed → exactly two requests, no third
  await http.close();
});

test('NET-3: a write (POST) NEVER auto-retries on a 5xx', async () => {
  const http = mockHttp();
  // Only one interceptor: a retry would need a second and throw (net connect disabled).
  http.pool.intercept({ path: '/2/tweets', method: 'POST' }).reply(500, { e: 'boom' });

  const { client, sleep } = makeClient(http);
  const err = await rejects(
    client.send({ method: 'POST', path: '/2/tweets', body: { text: 'hi' } }),
  );

  assert.equal(err.kind, 'api');
  assert.equal(err.data.http_status, 500);
  assert.deepEqual(sleep.calls, []); // no backoff, no retry
  http.assertDone();
  await http.close();
});

test('NET-3: a write (POST) NEVER auto-retries on a network error', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/tweets', method: 'POST' })
    .replyWithError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));

  const { client, sleep } = makeClient(http);
  const err = await rejects(
    client.send({ method: 'POST', path: '/2/tweets', body: { text: 'hi' } }),
  );

  assert.equal(err.kind, 'network');
  assert.deepEqual(sleep.calls, []);
  http.assertDone();
  await http.close();
});

// --- NET-2 mid-body: the response started, then the connection died ----------------
//
// Distinct from the connect failures above: headers (and some bytes) arrived, so the failure
// surfaces from the body read, not from fetch itself. The read rejects with the stream's
// `terminated` error carrying the transport cause — never with our own XError — and the
// client must treat it exactly like a connect failure: GET retries once, a write never.

test('NET-2/NET-3: a GET whose body dies mid-stream (ECONNRESET) retries once, then succeeds', async () => {
  const http = mockHttp();
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply(200, { data: { id: '1' } });
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply(200, { data: { id: '1' } });

  const { client, sleep } = makeClient(http, {
    dispatcher: midBody(http.dispatcher, [{ die: connectionReset() }]),
  });
  const body = await client.send<{ data: { id: string } }>({ method: 'GET', path: '/2/tweets/1' });

  assert.equal(body.data.id, '1');
  assert.equal(sleep.calls.length, 1); // one backoff between the two attempts
  http.assertDone(); // both interceptors consumed → the retry really went out
  await http.close();
});

test('NET-2/NET-3: a write whose body dies mid-stream surfaces `network` at once, never retries', async () => {
  const http = mockHttp();
  // A single interceptor: a retry would need a second and throw (net connect disabled).
  http.pool.intercept({ path: '/2/tweets', method: 'POST' }).reply(201, { data: { id: '9' } });

  const { client, sleep } = makeClient(http, {
    dispatcher: midBody(http.dispatcher, [{ die: connectionReset() }]),
  });
  const err = await rejects(
    client.send({ method: 'POST', path: '/2/tweets', body: { text: 'hi' } }),
  );

  assert.equal(err.kind, 'network');
  assert.deepEqual(sleep.calls, []); // no backoff, no retry
  assert.doesNotMatch(err.message, /ECONNRESET|terminated/); // raw cause never inlined
  assert.doesNotMatch(err.message, /timed out/i); // a reset is not a timeout
  http.assertDone();
  await http.close();
});

test("NET-2: a timeout that reaches the client wrapped as the stream error's cause still reads as a timeout", async () => {
  const http = mockHttp();
  http.pool.intercept({ path: '/2/tweets', method: 'POST' }).reply(201, { data: { id: '9' } });

  // fetch reports a mid-body failure as `TypeError: terminated` with the transport error as
  // `cause`; when that transport error is the timeout DOMException, the client must still
  // unwrap it — the distinct NET-2 timeout message, not the generic connection-failed one.
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const { client, sleep } = makeClient(http, {
    dispatcher: midBody(http.dispatcher, [{ die: timeout }]),
  });
  const err = await rejects(
    client.send({ method: 'POST', path: '/2/tweets', body: { text: 'hi' } }),
  );

  assert.equal(err.kind, 'network');
  assert.match(err.message, /timed out/i);
  assert.deepEqual(sleep.calls, []);
  http.assertDone();
  await http.close();
});

// --- MCP-7 mid-body: the host cancels while the body is still streaming --------------
//
// The response started, so the cancellation surfaces from the body read — fetch errors the
// stream with the abort reason — not from fetch itself: the `'response'` phase of the
// cancelled error. Never retried, whatever the method. A GET stays re-issuable; a write
// was already on the wire, so it carries the POST-4 ambiguity and is pinned non-retryable
// so that nothing auto-re-issues a possibly-applied write.

test('MCP-7: cancellation while a GET body streams is a cancelled `network` error, not a retry', async () => {
  const http = mockHttp();
  // A single interceptor: a retry would need a second and throw (net connect disabled).
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply(200, { data: { id: '1' } });

  const controller = new AbortController();
  const { client, sleep } = makeClient(http, {
    signal: controller.signal,
    dispatcher: midBody(http.dispatcher, [{ stall: () => controller.abort() }]),
  });
  const err = await rejects(client.send({ method: 'GET', path: '/2/tweets/1' }));

  assert.equal(err.kind, 'network');
  assert.match(err.message, /cancelled while reading the response/);
  assert.doesNotMatch(err.message, /before a response arrived/); // the body-read phase, not fetch
  assert.equal(err.retryable, true); // a cancelled GET is safe to re-issue
  assert.doesNotMatch(err.message, /X may have applied/); // no write ambiguity on a GET
  assert.deepEqual(sleep.calls, []); // cancellation is never retried, even for a GET
  http.assertDone();
  await http.close();
});

test('MCP-7/POST-4: cancellation while a write body streams carries the applied-anyway note, non-retryable', async () => {
  const http = mockHttp();
  http.pool.intercept({ path: '/2/tweets', method: 'POST' }).reply(201, { data: { id: '9' } });

  const controller = new AbortController();
  const { client, sleep } = makeClient(http, {
    signal: controller.signal,
    dispatcher: midBody(http.dispatcher, [{ stall: () => controller.abort() }]),
  });
  const err = await rejects(
    client.send({ method: 'POST', path: '/2/tweets', body: { text: 'hi' } }),
  );

  assert.equal(err.kind, 'network');
  assert.match(err.message, /cancelled while reading the response/);
  assert.match(err.message, /X may have applied the write anyway/);
  assert.match(err.message, /Do NOT blindly re-issue it/);
  assert.equal(err.retryable, false); // pinned: a possibly-applied write must not auto-retry
  assert.deepEqual(sleep.calls, []);
  http.assertDone();
  await http.close();
});

// --- RATE-2/INT-3: the onResponse observer seam (T-320 F6) --------------------------
//
// The third seam. Every response the origin returned — a 2xx, the 429 that follows it, a
// 5xx about to be retried, a 3xx about to be refused — reaches the observer once per
// attempt, in arrival order, BEFORE this client reads the body, retries, refuses or maps
// it. A transport failure yields no response and so never reaches it. What to make of a
// headerless response is the tracker's policy (RATE-4), not this layer's.

// Record what the observer saw, one entry per call, in arrival order.
function observed() {
  const calls: Array<{ status: number; remaining: string | null }> = [];
  const onResponse = (status: number, headers: Headers): void => {
    calls.push({ status, remaining: headers.get('x-rate-limit-remaining') });
  };
  return { calls, onResponse };
}

test('RATE-2: a 2xx with rate-limit headers reaches the observer — successes train the tracker', async () => {
  const http = mockHttp();
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply(
    200,
    { data: { id: '1' } },
    {
      headers: {
        'x-rate-limit-limit': '300',
        'x-rate-limit-remaining': '299',
        'x-rate-limit-reset': '1700000000',
      },
    },
  );

  let seen: { status: number; headers: Headers } | undefined;
  const { client } = makeClient(http, {
    onResponse: (status, headers) => {
      seen = { status, headers };
    },
  });
  const body = await client.send<{ data: { id: string } }>({ method: 'GET', path: '/2/tweets/1' });

  assert.equal(body.data.id, '1'); // the request itself still resolves with the parsed body
  assert.equal(seen?.status, 200);
  assert.ok(seen?.headers instanceof Headers);
  assert.equal(seen?.headers.get('x-rate-limit-limit'), '300');
  assert.equal(seen?.headers.get('x-rate-limit-remaining'), '299');
  assert.equal(seen?.headers.get('x-rate-limit-reset'), '1700000000');
  http.assertDone();
  await http.close();
});

test('RATE-1: on a 429 the observer fires before mapError, with the headers the mapper sees', async () => {
  const http = mockHttp();
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply(
    429,
    { title: 'Too Many Requests' },
    {
      headers: { 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': '1700000000' },
    },
  );

  const order: string[] = [];
  const seen = observed();
  let mapped: { status: number; remaining: string | null } | undefined;
  const { client } = makeClient(http, {
    onResponse: (status, headers) => {
      order.push('observe');
      seen.onResponse(status, headers);
    },
    mapError: (status, headers) => {
      order.push('map');
      mapped = { status, remaining: headers.get('x-rate-limit-remaining') };
      return new XError('rate-limit', 'Rate limit exhausted.');
    },
  });
  const err = await rejects(client.send({ method: 'GET', path: '/2/tweets/1' }));

  assert.equal(err.kind, 'rate-limit');
  assert.deepEqual(order, ['observe', 'map']); // the tracker learns the window before the error is built
  assert.deepEqual(seen.calls, [{ status: 429, remaining: '0' }]);
  assert.deepEqual(mapped, { status: 429, remaining: '0' });
  http.assertDone();
  await http.close();
});

test('NET-3: a retried GET reaches the observer once per attempt — the 5xx, then the 2xx', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/tweets/1', method: 'GET' })
    .reply(503, { e: 'boom' }, { headers: { 'x-rate-limit-remaining': '7' } });
  http.pool
    .intercept({ path: '/2/tweets/1', method: 'GET' })
    .reply(200, { data: { id: '1' } }, { headers: { 'x-rate-limit-remaining': '6' } });

  const seen = observed();
  const { client, sleep } = makeClient(http, { onResponse: seen.onResponse });
  const body = await client.send<{ data: { id: string } }>({ method: 'GET', path: '/2/tweets/1' });

  assert.equal(body.data.id, '1');
  assert.equal(sleep.calls.length, 1); // one backoff between the two attempts
  // Each call carries its own attempt's headers, in arrival order — the retried 5xx is not lost.
  assert.deepEqual(seen.calls, [
    { status: 503, remaining: '7' },
    { status: 200, remaining: '6' },
  ]);
  http.assertDone();
  await http.close();
});

test('AUTH-14: a refused redirect still reaches the observer before it is refused', async () => {
  const http = mockHttp();
  http.pool.intercept({ path: '/2/redir', method: 'GET' }).reply(302, '', {
    headers: { location: 'https://evil.example/steal', 'x-rate-limit-remaining': '5' },
  });

  const seen = observed();
  const { client } = makeClient(http, { onResponse: seen.onResponse });
  const err = await rejects(client.send({ method: 'GET', path: '/2/redir' }));

  assert.equal(err.kind, 'api');
  assert.equal(err.data.http_status, 302);
  assert.deepEqual(seen.calls, [{ status: 302, remaining: '5' }]); // observed, then refused
  http.assertDone();
  await http.close();
});

test('NET-2: a connection failure never reaches the observer — there is no response', async () => {
  const http = mockHttp();
  // A write so there is no retry; the single interceptor throws on connect.
  http.pool
    .intercept({ path: '/2/tweets', method: 'POST' })
    .replyWithError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

  const seen = observed();
  const { client } = makeClient(http, { onResponse: seen.onResponse });
  const err = await rejects(
    client.send({ method: 'POST', path: '/2/tweets', body: { text: 'hi' } }),
  );

  assert.equal(err.kind, 'network');
  assert.deepEqual(seen.calls, []);
  http.assertDone();
  await http.close();
});

test('NET-2: a per-attempt timeout never reaches the observer', async () => {
  const http = mockHttp();
  // A write (no retry). The response is delayed well past the tiny timeout window.
  http.pool.intercept({ path: '/2/tweets', method: 'POST' }).reply(200, { ok: true }).delay(500);

  const seen = observed();
  const { client } = makeClient(http, { timeoutMs: 10, onResponse: seen.onResponse });
  const err = await rejects(
    client.send({ method: 'POST', path: '/2/tweets', body: { text: 'hi' } }),
  );

  assert.equal(err.kind, 'network');
  assert.match(err.message, /timed out/i);
  assert.deepEqual(seen.calls, []);
  await http.close();
});

test('MCP-7: a call cancelled before any response never reaches the observer', async () => {
  const http = mockHttp();
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply(200, { data: { id: '1' } });

  const controller = new AbortController();
  controller.abort(); // already cancelled by the host
  const seen = observed();
  const { client } = makeClient(http, { signal: controller.signal, onResponse: seen.onResponse });
  const err = await rejects(client.send({ method: 'GET', path: '/2/tweets/1' }));

  assert.equal(err.kind, 'network');
  assert.match(err.message, /cancelled/i);
  assert.deepEqual(seen.calls, []);
  await http.close();
});

test('NET-1: the observer is optional — a client built without one handles a 200 normally', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/tweets/1', method: 'GET' })
    .reply(200, { data: { id: '1' } }, { headers: { 'x-rate-limit-remaining': '299' } });

  const { client } = makeClient(http); // no onResponse
  const body = await client.send<{ data: { id: string } }>({ method: 'GET', path: '/2/tweets/1' });

  assert.equal(body.data.id, '1');
  http.assertDone();
  await http.close();
});

test('RATE-4: a 200 without rate-limit headers still reaches the observer — the seam is unconditional', async () => {
  const http = mockHttp();
  http.pool.intercept({ path: '/2/tweets/1', method: 'GET' }).reply(200, { data: { id: '1' } });

  const seen = observed();
  const { client } = makeClient(http, { onResponse: seen.onResponse });
  await client.send({ method: 'GET', path: '/2/tweets/1' });

  // Whether a headerless response trains the table is the tracker's call, not this layer's.
  assert.deepEqual(seen.calls, [{ status: 200, remaining: null }]);
  http.assertDone();
  await http.close();
});

// --- request building ------------------------------------------------------------

test('builds path + query and JSON body against the API base', async () => {
  const http = mockHttp();
  let captured: unknown;
  http.pool
    .intercept({ path: '/2/tweets?ids=1%2C2&expansions=author_id', method: 'GET' })
    .reply((opts) => {
      captured = opts.headers;
      return { statusCode: 200, data: { data: [] } };
    });

  const { client } = makeClient(http);
  await client.send({
    method: 'GET',
    path: '/2/tweets',
    query: { ids: '1,2', expansions: 'author_id', dropped: undefined },
  });

  assert.equal(headerValue(captured, 'accept'), 'application/json');
  http.assertDone();
  await http.close();
});

test('sends a JSON body with a content-type on writes', async () => {
  const http = mockHttp();
  let captured: { headers: unknown; body: string } | undefined;
  http.pool.intercept({ path: '/2/tweets', method: 'POST' }).reply((opts) => {
    captured = { headers: opts.headers, body: typeof opts.body === 'string' ? opts.body : '' };
    return { statusCode: 201, data: { data: { id: '9' } } };
  });

  const { client } = makeClient(http);
  const body = await client.send<{ data: { id: string } }>({
    method: 'POST',
    path: '/2/tweets',
    body: { text: 'hello' },
  });

  assert.equal(body.data.id, '9');
  assert.equal(headerValue(captured?.headers, 'content-type'), 'application/json');
  assert.deepEqual(JSON.parse(captured!.body) as unknown, { text: 'hello' });
  http.assertDone();
  await http.close();
});
