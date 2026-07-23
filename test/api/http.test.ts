// Tests for the host-scoped HTTP client (api/http, T-114). Every request goes through the
// real global-fetch path with an injected undici MockAgent (test/helpers/http.ts), so no
// real network happens. Coverage is tagged to the docs/07 requirements it proves:
//   AUTH-14 — host-scoped auth + redirects never followed
//   CFG-7   — proxy env is ignored (default/injected dispatcher, never a ProxyAgent)
//   NET-1   — body tolerance: empty / non-JSON / oversized, no raw body text in errors
//   NET-2   — transport failures mapped to `network`, timeouts distinguished
//   NET-3   — GET retries exactly once on 5xx/network; writes never auto-retry

import test from 'node:test';
import assert from 'node:assert/strict';

import { XError } from '../../src/core/errors.js';
import { createHttpClient, shouldAttachAuth, DEFAULT_API_BASE_URL } from '../../src/api/http.js';
import type { HttpClientConfig } from '../../src/api/http.js';
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
