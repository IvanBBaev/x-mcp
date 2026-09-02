// Tests for the `x-mcp-ai authorize` PKCE flow (T-204, src/cli/authorize.ts).
// Cases: AUTH-13 (CSRF state strictly verified, one-shot 127.0.0.1 listener, bounded
// timeout, secrets never echoed) and AUTH-16 (--manual no-browser mode, browser-launch
// failure falls back to manual instructions) — docs/07-corner-cases.md §2, docs/04 §4.3.
//
// Everything runs over fakes injected through AuthorizeDeps: an in-memory loopback
// listener, a fake token endpoint, a scripted stdin, and the shared deterministic
// clock/random/token-store helpers. No socket is opened, no real time passes — except in
// the final "production adapters" section, which exercises the exported fetch/node:http/
// readline adapters over strictly local resources (a MockAgent dispatcher, a one-shot
// 127.0.0.1 ephemeral-port server, a child process with a piped stdin).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { fakeClock, inMemoryTokenStore, mockHttp } from '../helpers/index.js';
import type { Random, Sleep, TokenStore } from '../../src/core/ports.js';
import {
  CALLBACK_PATH,
  DEFAULT_MANUAL_REDIRECT_PORT,
  DEFAULT_TOKEN_URL,
  LOOPBACK_HOST,
  createAuthorizeCli,
  createFetchTokenExchangeHttp,
  createNodeLoopbackListen,
  type AuthorizeDeps,
  type LoopbackListen,
  type LoopbackRequest,
  type TokenEndpointResponse,
  type TokenExchangeHttp,
} from '../../src/cli/authorize.js';

// --- Local fakes (this file only — test/cli has no shared helpers by design) -----------

/** Deterministic Random whose successive `bytes()` calls differ (verifier ≠ state). */
function seqRandom(): Random {
  let counter = 0;
  return {
    float: () => 0.5,
    uuid: () => '00000000-0000-4000-8000-000000000000',
    bytes: (n) => {
      counter += 1;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) out[i] = (i * 7 + counter * 13) & 0xff;
      return out;
    },
  };
}

/** A sleep that never resolves — the callback timeout never fires unless a test wants it. */
const neverSleep: Sleep = () => new Promise<void>(() => undefined);

/** A sleep that resolves immediately — the timeout branch wins the race at once. */
const instantSleep: Sleep = () => Promise.resolve();

interface Delivered {
  status: number;
  body: string;
}

/** In-memory loopback listener: records bindings, lets tests inject callback requests. */
function fakeLoopback(assignedPort = 49152) {
  let handler: ((request: LoopbackRequest) => void) | null = null;
  let closeCount = 0;
  const bindings: { host: string; port: number }[] = [];
  const listen: LoopbackListen = (host, port, onRequest) => {
    bindings.push({ host, port });
    handler = onRequest;
    return Promise.resolve({
      port: port === 0 ? assignedPort : port,
      close: () => {
        closeCount += 1;
        return Promise.resolve();
      },
    });
  };
  const deliver = (url: string): Delivered => {
    assert.ok(handler !== null, 'listener was never started');
    const result: Delivered = { status: -1, body: '' };
    handler({
      url,
      respond: (status, body) => {
        result.status = status;
        result.body = body;
      },
    });
    return result;
  };
  return { listen, deliver, bindings, closeCount: () => closeCount };
}

interface ExchangeCall {
  url: string;
  form: Record<string, string>;
  headers: Record<string, string>;
}

/** Fake token endpoint: records every exchange call, answers with a canned result. */
function fakeExchange(result: TokenEndpointResponse | Error) {
  const calls: ExchangeCall[] = [];
  const http: TokenExchangeHttp = (url, form, headers) => {
    calls.push({ url, form: { ...form }, headers: { ...headers } });
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  };
  return { http, calls };
}

function okTokenResponse(): TokenEndpointResponse {
  return {
    status: 200,
    body: {
      token_type: 'bearer',
      access_token: 'at-secret-1',
      refresh_token: 'rt-secret-1',
      expires_in: 7200,
      scope: 'tweet.read users.read offline.access',
    },
  };
}

interface Bag {
  deps: AuthorizeDeps;
  out: string[];
  errs: string[];
  loopback: ReturnType<typeof fakeLoopback>;
  exchange: ReturnType<typeof fakeExchange>;
  store: ReturnType<typeof inMemoryTokenStore>;
  clock: ReturnType<typeof fakeClock>;
}

function makeDeps(
  opts: { exchange?: TokenEndpointResponse | Error; sleep?: Sleep; clientId?: string } = {},
): Bag {
  const out: string[] = [];
  const errs: string[] = [];
  const loopback = fakeLoopback();
  const exchange = fakeExchange(opts.exchange ?? okTokenResponse());
  const store = inMemoryTokenStore();
  const clock = fakeClock();
  const deps: AuthorizeDeps = {
    oauth: { clientId: opts.clientId ?? 'client-abc' },
    tokenStore: store,
    http: exchange.http,
    random: seqRandom(),
    clock,
    sleep: opts.sleep ?? neverSleep,
    listen: loopback.listen,
    readLine: () => Promise.resolve(''),
    stdout: (line) => {
      out.push(line);
    },
    stderr: (line) => {
      errs.push(line);
    },
  };
  return { deps, out, errs, loopback, exchange, store, clock };
}

function stateOf(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get('state');
  assert.ok(state !== null && state !== '', 'authorization URL carries a state');
  return state;
}

/** A "browser" that immediately hits the callback with the CORRECT state + given code. */
function completingBrowser(bag: Bag, code = 'good-code') {
  const urls: string[] = [];
  const responses: Delivered[] = [];
  return {
    urls,
    responses,
    open: (url: string): Promise<boolean> => {
      urls.push(url);
      responses.push(
        bag.loopback.deliver(
          `${CALLBACK_PATH}?state=${encodeURIComponent(stateOf(url))}&code=${code}`,
        ),
      );
      return Promise.resolve(true);
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// --- Happy path (listener flow) --------------------------------------------------------

test('happy path: callback with matching state → code exchanged once, tokens persisted through the port, exit 0', async () => {
  const bag = makeDeps();
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({ ...bag.deps, openBrowser: browser.open });

  const code = await cli([]);
  assert.equal(code, 0);

  // The listener bound 127.0.0.1 with an ephemeral port request, and was closed exactly once.
  assert.deepEqual(bag.loopback.bindings, [{ host: '127.0.0.1', port: 0 }]);
  assert.equal(bag.loopback.closeCount(), 1);

  // Exactly one exchange, carrying the code, the verifier, and the exact redirect_uri.
  assert.equal(bag.exchange.calls.length, 1);
  const call = bag.exchange.calls[0];
  assert.ok(call);
  assert.equal(call.url, DEFAULT_TOKEN_URL);
  assert.equal(call.form.grant_type, 'authorization_code');
  assert.equal(call.form.code, 'good-code');
  assert.equal(call.form.client_id, 'client-abc');
  assert.equal(call.form.redirect_uri, `http://127.0.0.1:49152${CALLBACK_PATH}`);
  assert.ok((call.form.code_verifier ?? '').length >= 43, 'RFC 7636 verifier length');
  // Public PKCE client: no Basic auth header without a client secret.
  assert.equal(call.headers.authorization, undefined);

  // The pair went through the TokenStore port, stamped by the injected clock.
  assert.equal(bag.store.persistCount(), 1);
  const pair = await bag.store.load();
  assert.ok(pair);
  assert.equal(pair.access_token, 'at-secret-1');
  assert.equal(pair.refresh_token, 'rt-secret-1');
  assert.equal(pair.expires_in, 7200);
  assert.equal(pair.obtained_at, bag.clock.now());

  // Success is reported, with granted scopes shown verbatim.
  assert.ok(bag.out.some((l) => l.includes('Authorization complete')));
  assert.ok(bag.out.some((l) => l.includes('tweet.read users.read offline.access')));
  assert.equal(bag.errs.length, 0);
});

test('AUTH-13: PKCE S256 — authorization URL carries base64url(sha256(verifier)), never the verifier', async () => {
  const bag = makeDeps();
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({ ...bag.deps, openBrowser: browser.open });
  assert.equal(await cli([]), 0);

  const authUrl = browser.urls[0];
  assert.ok(authUrl);
  const params = new URL(authUrl).searchParams;
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('code_challenge_method'), 'S256');

  const verifier = bag.exchange.calls[0]?.form.code_verifier;
  assert.ok(verifier);
  const expectedChallenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  assert.equal(params.get('code_challenge'), expectedChallenge);
  assert.notEqual(params.get('state'), verifier, 'state and verifier are independent');
  assert.ok(!authUrl.includes(verifier), 'verifier never appears in the authorization URL');
});

test('AUTH-13: no secret ever reaches stdout, stderr, or the browser success page', async () => {
  const bag = makeDeps();
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({ ...bag.deps, openBrowser: browser.open });
  assert.equal(await cli([]), 0);

  const verifier = bag.exchange.calls[0]?.form.code_verifier;
  assert.ok(verifier);
  const page = browser.responses[0];
  assert.ok(page);
  assert.equal(page.status, 200);
  const secrets = ['at-secret-1', 'rt-secret-1', 'good-code', verifier];
  for (const secret of secrets) {
    assert.ok(!page.body.includes(secret), `success page must not contain ${secret.slice(0, 8)}…`);
    for (const line of [...bag.out, ...bag.errs]) {
      assert.ok(!line.includes(secret), `output must not contain ${secret.slice(0, 8)}…`);
    }
  }
});

// --- AUTH-13: CSRF state verification --------------------------------------------------

test('AUTH-13: callback with a mismatching state is rejected — no exchange, no token persisted, exit 1', async () => {
  const bag = makeDeps();
  let page: Delivered | undefined;
  const cli = createAuthorizeCli({
    ...bag.deps,
    openBrowser: (): Promise<boolean> => {
      page = bag.loopback.deliver(`${CALLBACK_PATH}?state=not-the-state&code=evil-code`);
      return Promise.resolve(true);
    },
  });

  const code = await cli([]);
  assert.equal(code, 1);

  assert.ok(page);
  assert.equal(page.status, 400);
  assert.ok(!page.body.includes('not-the-state'), 'received state is not echoed back');
  assert.equal(bag.exchange.calls.length, 0, 'the code is NEVER exchanged on state mismatch');
  assert.equal(bag.store.persistCount(), 0, 'nothing is persisted');
  assert.equal(bag.loopback.closeCount(), 1, 'listener is shut down');
  const stderrText = bag.errs.join('\n');
  assert.match(stderrText, /\[auth\]/);
  assert.match(stderrText, /state/);
  assert.ok(!stderrText.includes('evil-code'), 'attacker-supplied code is not echoed');
  assert.ok(!stderrText.includes('not-the-state'), 'attacker-supplied state is not echoed');
});

test('AUTH-13: provider error callback (access_denied) is reported without an exchange', async () => {
  const bag = makeDeps();
  const cli = createAuthorizeCli({
    ...bag.deps,
    openBrowser: (): Promise<boolean> => {
      bag.loopback.deliver(`${CALLBACK_PATH}?error=access_denied&state=whatever`);
      return Promise.resolve(true);
    },
  });
  assert.equal(await cli([]), 1);
  assert.equal(bag.exchange.calls.length, 0);
  assert.equal(bag.store.persistCount(), 0);
  assert.match(bag.errs.join('\n'), /access_denied/);
});

// --- AUTH-13: one-shot listener + bounded lifetime --------------------------------------

test('AUTH-13: the listener is one-shot — a second callback is refused and not exchanged', async () => {
  const bag = makeDeps();
  let second: Delivered | undefined;
  const cli = createAuthorizeCli({
    ...bag.deps,
    openBrowser: (url): Promise<boolean> => {
      const query = `${CALLBACK_PATH}?state=${encodeURIComponent(stateOf(url))}&code=good-code`;
      bag.loopback.deliver(query);
      second = bag.loopback.deliver(query); // replayed callback
      return Promise.resolve(true);
    },
  });

  assert.equal(await cli([]), 0);
  assert.ok(second);
  assert.equal(second.status, 410, 'second request is refused');
  assert.equal(bag.exchange.calls.length, 1, 'the code is exchanged exactly once');
  assert.equal(bag.store.persistCount(), 1);
});

test('AUTH-13: a non-callback path (favicon probe) gets 404 and does not consume the one shot', async () => {
  const bag = makeDeps();
  let probe: Delivered | undefined;
  const cli = createAuthorizeCli({
    ...bag.deps,
    openBrowser: (url): Promise<boolean> => {
      probe = bag.loopback.deliver('/favicon.ico');
      bag.loopback.deliver(
        `${CALLBACK_PATH}?state=${encodeURIComponent(stateOf(url))}&code=good-code`,
      );
      return Promise.resolve(true);
    },
  });
  assert.equal(await cli([]), 0);
  assert.ok(probe);
  assert.equal(probe.status, 404);
  assert.equal(bag.store.persistCount(), 1, 'the real callback still lands');
});

test('AUTH-13: no callback before the timeout → listener closed, exit 1, manual mode suggested', async () => {
  const bag = makeDeps({ sleep: instantSleep }); // the timeout branch wins immediately
  const cli = createAuthorizeCli(bag.deps);

  assert.equal(await cli([]), 1);
  assert.equal(bag.loopback.closeCount(), 1, 'the capture window is closed');
  assert.equal(bag.exchange.calls.length, 0);
  assert.equal(bag.store.persistCount(), 0);
  const stderrText = bag.errs.join('\n');
  assert.match(stderrText, /timed out/);
  assert.match(stderrText, /--manual/);
});

// --- AUTH-16: browser launch failure + manual mode --------------------------------------

test('AUTH-16: browser launch failure falls back to manual instructions instead of hanging', async () => {
  const bag = makeDeps();
  let seenUrl = '';
  const cli = createAuthorizeCli({
    ...bag.deps,
    openBrowser: (url): Promise<boolean> => {
      seenUrl = url;
      return Promise.reject(new Error('spawn xdg-open ENOENT'));
    },
  });

  const done = cli([]);
  await tick(); // let the flow print, fail the launch, and start waiting
  bag.loopback.deliver(
    `${CALLBACK_PATH}?state=${encodeURIComponent(stateOf(seenUrl))}&code=good-code`,
  );
  assert.equal(await done, 0, 'the flow still completes via the printed URL');
  assert.match(bag.errs.join('\n'), /--manual/, 'fallback instructions were printed');
  assert.equal(bag.store.persistCount(), 1);
});

test('AUTH-16: --manual round-trip — full redirect URL pasted back, no listener opened', async () => {
  const bag = makeDeps();
  const cli = createAuthorizeCli({
    ...bag.deps,
    readLine: (): Promise<string> => {
      const urlLine = bag.out.find((l) => l.includes('authorize?'));
      assert.ok(urlLine, 'the authorization URL was printed before the prompt');
      const state = stateOf(urlLine.trim());
      return Promise.resolve(
        `http://127.0.0.1:${String(DEFAULT_MANUAL_REDIRECT_PORT)}${CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=manual-code-1`,
      );
    },
  });

  assert.equal(await cli(['--manual']), 0);
  assert.equal(bag.loopback.bindings.length, 0, 'NO listener is opened in manual mode');
  assert.equal(bag.exchange.calls.length, 1);
  const call = bag.exchange.calls[0];
  assert.ok(call);
  assert.equal(call.form.code, 'manual-code-1');
  assert.equal(
    call.form.redirect_uri,
    `http://127.0.0.1:${String(DEFAULT_MANUAL_REDIRECT_PORT)}${CALLBACK_PATH}`,
  );
  assert.equal(bag.store.persistCount(), 1);
  assert.ok(bag.out.some((l) => l.includes('Authorization complete')));
});

test('AUTH-16 + AUTH-13: --manual still verifies state — a stale/foreign URL is rejected', async () => {
  const bag = makeDeps();
  const cli = createAuthorizeCli({
    ...bag.deps,
    readLine: () =>
      Promise.resolve(
        `http://127.0.0.1:${String(DEFAULT_MANUAL_REDIRECT_PORT)}${CALLBACK_PATH}?state=stale-state&code=stolen-code`,
      ),
  });

  assert.equal(await cli(['--manual']), 1);
  assert.equal(bag.exchange.calls.length, 0, 'the pasted code is never exchanged');
  assert.equal(bag.store.persistCount(), 0);
  const stderrText = bag.errs.join('\n');
  assert.match(stderrText, /\[auth\]/);
  assert.match(stderrText, /state/);
  assert.ok(!stderrText.includes('stolen-code'), 'the pasted code is not echoed');
});

test('AUTH-16: --manual rejects a bare code because state cannot be verified', async () => {
  const bag = makeDeps();
  const cli = createAuthorizeCli({
    ...bag.deps,
    readLine: () => Promise.resolve('just-a-bare-authorization-code'),
  });
  assert.equal(await cli(['--manual']), 1);
  assert.equal(bag.exchange.calls.length, 0);
  assert.equal(bag.store.persistCount(), 0);
  assert.match(bag.errs.join('\n'), /state/);
});

// --- Exchange failure taxonomy ----------------------------------------------------------

test('exchange failure: invalid_grant maps to a non-retryable [auth] error; nothing persisted', async () => {
  const bag = makeDeps({ exchange: { status: 400, body: { error: 'invalid_grant' } } });
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({ ...bag.deps, openBrowser: browser.open });

  assert.equal(await cli([]), 1);
  assert.equal(bag.store.persistCount(), 0);
  const stderrText = bag.errs.join('\n');
  assert.match(stderrText, /\[auth\]/);
  assert.match(stderrText, /invalid_grant/);
});

test('exchange failure: invalid_client points the operator at the client credentials', async () => {
  const bag = makeDeps({ exchange: { status: 401, body: { error: 'invalid_client' } } });
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({ ...bag.deps, openBrowser: browser.open });

  assert.equal(await cli([]), 1);
  const stderrText = bag.errs.join('\n');
  assert.match(stderrText, /\[auth\]/);
  assert.match(stderrText, /X_MCP_CLIENT_ID/);
  assert.equal(bag.store.persistCount(), 0);
});

test('exchange failure: a 5xx maps to [api] with the status, without echoing the body', async () => {
  const bag = makeDeps({ exchange: { status: 503, body: '<html>upstream oops</html>' } });
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({ ...bag.deps, openBrowser: browser.open });

  assert.equal(await cli([]), 1);
  const stderrText = bag.errs.join('\n');
  assert.match(stderrText, /\[api\]/);
  assert.match(stderrText, /503/);
  assert.ok(!stderrText.includes('upstream oops'), 'response body text is never echoed');
  assert.equal(bag.store.persistCount(), 0);
});

test('exchange failure: a transport error maps to [network]; nothing persisted', async () => {
  const bag = makeDeps({ exchange: new Error('connect ECONNREFUSED 104.244.42.1:443') });
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({ ...bag.deps, openBrowser: browser.open });

  assert.equal(await cli([]), 1);
  assert.match(bag.errs.join('\n'), /\[network\]/);
  assert.equal(bag.store.persistCount(), 0);
});

test('exchange failure: HTTP 200 without an access_token maps to [api] unexpected shape', async () => {
  const bag = makeDeps({ exchange: { status: 200, body: { token_type: 'bearer' } } });
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({ ...bag.deps, openBrowser: browser.open });

  assert.equal(await cli([]), 1);
  const stderrText = bag.errs.join('\n');
  assert.match(stderrText, /\[api\]/);
  assert.match(stderrText, /access_token/);
  assert.equal(bag.store.persistCount(), 0);
});

// --- Persist-before-success ordering ----------------------------------------------------

test('exit 0 implies persisted: a TokenStore.persist failure fails the run with no success line', async () => {
  const bag = makeDeps();
  const failingStore: TokenStore = {
    load: () => Promise.resolve(null),
    persist: () => Promise.reject(new Error('EACCES: permission denied')),
    withLock: (fn) => fn(),
  };
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({
    ...bag.deps,
    tokenStore: failingStore,
    openBrowser: browser.open,
  });

  assert.equal(await cli([]), 1);
  assert.ok(!bag.out.some((l) => l.includes('Authorization complete')), 'no success line');
  const stderrText = bag.errs.join('\n');
  assert.match(stderrText, /\[auth\]/);
  assert.match(stderrText, /persist/);
});

// --- Argument and configuration handling ------------------------------------------------

test('args: --port pins the listener port and the redirect_uri', async () => {
  const bag = makeDeps();
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({ ...bag.deps, openBrowser: browser.open });

  assert.equal(await cli(['--port', '51234']), 0);
  assert.deepEqual(bag.loopback.bindings, [{ host: '127.0.0.1', port: 51234 }]);
  assert.equal(bag.exchange.calls[0]?.form.redirect_uri, `http://127.0.0.1:51234${CALLBACK_PATH}`);
});

test('args: an unknown flag prints usage and exits 1 without ever binding a listener', async () => {
  const bag = makeDeps();
  const cli = createAuthorizeCli(bag.deps);

  assert.equal(await cli(['--frobnicate']), 1);
  assert.equal(bag.loopback.bindings.length, 0);
  const stderrText = bag.errs.join('\n');
  assert.match(stderrText, /unknown argument/);
  assert.match(stderrText, /usage: x-mcp-ai authorize/);
});

test('config: a missing client id fails fast with a [validation] error before any listener', async () => {
  const bag = makeDeps({ clientId: '' });
  const cli = createAuthorizeCli(bag.deps);

  assert.equal(await cli([]), 1);
  assert.equal(bag.loopback.bindings.length, 0);
  const stderrText = bag.errs.join('\n');
  assert.match(stderrText, /\[validation\]/);
  assert.match(stderrText, /X_MCP_CLIENT_ID/);
});

test('config: a client secret switches the exchange to HTTP Basic without leaking it', async () => {
  const bag = makeDeps();
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({
    ...bag.deps,
    oauth: { clientId: 'client-abc', clientSecret: 'shh-secret' },
    openBrowser: browser.open,
  });

  assert.equal(await cli([]), 0);
  const auth = bag.exchange.calls[0]?.headers.authorization;
  assert.ok(auth);
  assert.equal(auth, `Basic ${Buffer.from('client-abc:shh-secret').toString('base64')}`);
  for (const line of [...bag.out, ...bag.errs]) {
    assert.ok(!line.includes('shh-secret'), 'client secret never reaches output');
  }
});

test('args: --port=<n> inline form pins the listener port like the two-token form', async () => {
  const bag = makeDeps();
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({ ...bag.deps, openBrowser: browser.open });

  assert.equal(await cli(['--port=51235']), 0);
  assert.deepEqual(bag.loopback.bindings, [{ host: '127.0.0.1', port: 51235 }]);
  assert.equal(bag.exchange.calls[0]?.form.redirect_uri, `http://127.0.0.1:51235${CALLBACK_PATH}`);
});

test('args: --port without a value prints usage and exits 1', async () => {
  const bag = makeDeps();
  const cli = createAuthorizeCli(bag.deps);

  assert.equal(await cli(['--port']), 1);
  assert.equal(bag.loopback.bindings.length, 0);
  const stderrText = bag.errs.join('\n');
  assert.match(stderrText, /missing value for --port/);
  assert.match(stderrText, /usage: x-mcp-ai authorize/);
});

test('args: non-numeric, out-of-range, and overflowing --port values are all rejected', async () => {
  // Three parse rejections: regex failure, > 65535, and a digit string so long that
  // Number() overflows to Infinity (the Number.isInteger guard).
  for (const value of ['abc', '70000', '9'.repeat(400)]) {
    const bag = makeDeps();
    const cli = createAuthorizeCli(bag.deps);
    assert.equal(await cli([`--port=${value}`]), 1);
    assert.equal(bag.loopback.bindings.length, 0, 'no listener for a rejected value');
    const stderrText = bag.errs.join('\n');
    assert.match(stderrText, /invalid --port value/);
    assert.match(stderrText, /usage: x-mcp-ai authorize/);
  }
});

// --- Listener flow: bind failure, malformed requests, code-less callbacks ---------------

test('a loopback bind failure maps to [validation] pointing at --port/--manual', async () => {
  const bag = makeDeps();
  const failingListen: LoopbackListen = () =>
    Promise.reject(new Error('listen EADDRINUSE: address already in use 127.0.0.1:51234'));
  const cli = createAuthorizeCli({ ...bag.deps, listen: failingListen });

  assert.equal(await cli(['--port', '51234']), 1);
  assert.equal(bag.exchange.calls.length, 0);
  const stderrText = bag.errs.join('\n');
  assert.match(stderrText, /\[validation\]/);
  assert.match(stderrText, /could not bind the loopback callback listener/);
  assert.match(stderrText, /--manual/);
});

test('AUTH-13: a request whose target does not even parse gets 404 without consuming the shot', async () => {
  const bag = makeDeps();
  let probe: Delivered | undefined;
  const cli = createAuthorizeCli({
    ...bag.deps,
    openBrowser: (url): Promise<boolean> => {
      // `new URL('http://[bad', base)` throws — the request is treated like any non-callback path.
      probe = bag.loopback.deliver('http://[bad');
      bag.loopback.deliver(
        `${CALLBACK_PATH}?state=${encodeURIComponent(stateOf(url))}&code=good-code`,
      );
      return Promise.resolve(true);
    },
  });
  assert.equal(await cli([]), 0);
  assert.ok(probe);
  assert.equal(probe.status, 404);
  assert.equal(bag.store.persistCount(), 1, 'the real callback still lands');
});

test('AUTH-13: a callback with a matching state but no code is rejected without an exchange', async () => {
  const bag = makeDeps();
  let page: Delivered | undefined;
  const cli = createAuthorizeCli({
    ...bag.deps,
    openBrowser: (url): Promise<boolean> => {
      page = bag.loopback.deliver(`${CALLBACK_PATH}?state=${encodeURIComponent(stateOf(url))}`);
      return Promise.resolve(true);
    },
  });

  assert.equal(await cli([]), 1);
  assert.ok(page);
  assert.equal(page.status, 400);
  assert.equal(bag.exchange.calls.length, 0);
  assert.equal(bag.store.persistCount(), 0);
  assert.match(bag.errs.join('\n'), /carried no authorization code/);
});

test('AUTH-13: a callback with an EMPTY code is rejected the same way', async () => {
  const bag = makeDeps();
  const cli = createAuthorizeCli({
    ...bag.deps,
    openBrowser: (url): Promise<boolean> => {
      bag.loopback.deliver(`${CALLBACK_PATH}?state=${encodeURIComponent(stateOf(url))}&code=`);
      return Promise.resolve(true);
    },
  });

  assert.equal(await cli([]), 1);
  assert.equal(bag.exchange.calls.length, 0);
  assert.match(bag.errs.join('\n'), /carried no authorization code/);
});

// --- Failure reporting for non-XError throws --------------------------------------------

test('an unexpected Error surfaces as [api] unexpected failure with its message', async () => {
  const bag = makeDeps();
  const cli = createAuthorizeCli({
    ...bag.deps,
    readLine: () => Promise.reject(new Error('stdin closed unexpectedly')),
  });

  assert.equal(await cli(['--manual']), 1);
  assert.match(bag.errs.join('\n'), /\[api\] unexpected failure — stdin closed unexpectedly/);
});

test('an unexpected non-Error throw is stringified into the [api] failure line', async () => {
  const bag = makeDeps();
  const cli = createAuthorizeCli({
    ...bag.deps,
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error arm is the point
    readLine: () => Promise.reject('raw-string-rejection'),
  });

  assert.equal(await cli(['--manual']), 1);
  assert.match(bag.errs.join('\n'), /\[api\] unexpected failure — raw-string-rejection/);
});

// --- AUTH-16: manual-flow input variants -------------------------------------------------

test('AUTH-16: --manual with an empty paste fails with [validation] and exchanges nothing', async () => {
  const bag = makeDeps(); // the default scripted readLine answers ''
  const cli = createAuthorizeCli(bag.deps);

  assert.equal(await cli(['--manual']), 1);
  assert.equal(bag.exchange.calls.length, 0);
  const stderrText = bag.errs.join('\n');
  assert.match(stderrText, /\[validation\]/);
  assert.match(stderrText, /no redirect URL was provided/);
});

test('AUTH-16: a pasted `?error=...` query string is accepted as input and reported as refusal', async () => {
  const bag = makeDeps();
  const cli = createAuthorizeCli({
    ...bag.deps,
    readLine: () => Promise.resolve('?error=access_denied'),
  });

  assert.equal(await cli(['--manual']), 1);
  assert.equal(bag.exchange.calls.length, 0);
  const stderrText = bag.errs.join('\n');
  assert.match(stderrText, /\[auth\]/);
  assert.match(stderrText, /access_denied/);
});

test('AUTH-16: a pasted query string with a matching state but an empty code is rejected', async () => {
  const bag = makeDeps();
  const cli = createAuthorizeCli({
    ...bag.deps,
    readLine: (): Promise<string> => {
      const urlLine = bag.out.find((l) => l.includes('authorize?'));
      assert.ok(urlLine, 'the authorization URL was printed before the prompt');
      // Raw query-string form, no leading `?` — also accepted (AUTH-16).
      return Promise.resolve(`state=${encodeURIComponent(stateOf(urlLine.trim()))}&code=`);
    },
  });

  assert.equal(await cli(['--manual']), 1);
  assert.equal(bag.exchange.calls.length, 0);
  assert.match(bag.errs.join('\n'), /carries no authorization code/);
});

test('AUTH-16: a pasted query string carrying only the state is rejected for its missing code', async () => {
  const bag = makeDeps();
  const cli = createAuthorizeCli({
    ...bag.deps,
    readLine: (): Promise<string> => {
      const urlLine = bag.out.find((l) => l.includes('authorize?'));
      assert.ok(urlLine, 'the authorization URL was printed before the prompt');
      return Promise.resolve(`state=${encodeURIComponent(stateOf(urlLine.trim()))}`);
    },
  });

  assert.equal(await cli(['--manual']), 1);
  assert.equal(bag.exchange.calls.length, 0);
  assert.match(bag.errs.join('\n'), /carries no authorization code/);
});

test('AUTH-16: a pasted query string without code/state/error is not parseable input', async () => {
  const bag = makeDeps();
  const cli = createAuthorizeCli({
    ...bag.deps,
    readLine: () => Promise.resolve('foo=bar&baz=1'),
  });

  assert.equal(await cli(['--manual']), 1);
  assert.equal(bag.exchange.calls.length, 0);
  assert.match(bag.errs.join('\n'), /could not parse the pasted value/);
});

test('AUTH-16: --manual --port=0 falls back to the nominal manual redirect port', async () => {
  const bag = makeDeps();
  const cli = createAuthorizeCli({
    ...bag.deps,
    readLine: (): Promise<string> => {
      const urlLine = bag.out.find((l) => l.includes('authorize?'));
      assert.ok(urlLine, 'the authorization URL was printed before the prompt');
      const state = stateOf(urlLine.trim());
      // `?`-prefixed query-string paste — the third accepted input shape (AUTH-16).
      return Promise.resolve(`?state=${encodeURIComponent(state)}&code=manual-qs-code`);
    },
  });

  assert.equal(await cli(['--manual', '--port=0']), 0);
  assert.equal(bag.loopback.bindings.length, 0, 'NO listener is opened in manual mode');
  const call = bag.exchange.calls[0];
  assert.ok(call);
  assert.equal(call.form.code, 'manual-qs-code');
  assert.equal(
    call.form.redirect_uri,
    `http://127.0.0.1:${String(DEFAULT_MANUAL_REDIRECT_PORT)}${CALLBACK_PATH}`,
  );
  assert.equal(bag.store.persistCount(), 1);
});

// --- Exchange failure taxonomy: remaining arms ------------------------------------------

test('exchange failure: a bare 401 without an OAuth error code still maps to invalid_client', async () => {
  const bag = makeDeps({ exchange: { status: 401, body: '<html>nope</html>' } });
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({ ...bag.deps, openBrowser: browser.open });

  assert.equal(await cli([]), 1);
  const stderrText = bag.errs.join('\n');
  assert.match(stderrText, /\[auth\]/);
  assert.match(stderrText, /X_MCP_CLIENT_ID/);
  assert.ok(!stderrText.includes('nope'), 'response body text is never echoed');
});

test('exchange failure: an unrecognized OAuth error code is reported as a refusal, sanitized', async () => {
  // The code fails the machine-token shape check, so it is REPLACED, never interpolated.
  const bag = makeDeps({ exchange: { status: 400, body: { error: 'bad code <script>' } } });
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({ ...bag.deps, openBrowser: browser.open });

  assert.equal(await cli([]), 1);
  const stderrText = bag.errs.join('\n');
  assert.match(stderrText, /\[auth\]/);
  assert.match(stderrText, /token exchange was refused \(unknown_error\)/);
  assert.ok(!stderrText.includes('<script>'), 'the raw code never enters the message');
});

test('exchange failure: a 4xx with a non-string error field maps to [api] unexpected status', async () => {
  const bag = makeDeps({ exchange: { status: 418, body: { error: 123 } } });
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({ ...bag.deps, openBrowser: browser.open });

  assert.equal(await cli([]), 1);
  const stderrText = bag.errs.join('\n');
  assert.match(stderrText, /\[api\]/);
  assert.match(stderrText, /unexpected HTTP 418/);
});

// --- Token response shape: remaining arms ------------------------------------------------

test('exchange: HTTP 200 with a non-JSON body maps to [api] missing-JSON-body', async () => {
  const bag = makeDeps({ exchange: { status: 200, body: 'plain text, not JSON' } });
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({ ...bag.deps, openBrowser: browser.open });

  assert.equal(await cli([]), 1);
  assert.match(bag.errs.join('\n'), /without a JSON body/);
  assert.equal(bag.store.persistCount(), 0);
});

test('exchange: a minimal body (access_token only) succeeds with notes and defaults', async () => {
  const bag = makeDeps({ exchange: { status: 200, body: { access_token: 'at-min-1' } } });
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({ ...bag.deps, openBrowser: browser.open });

  assert.equal(await cli([]), 0);
  const pair = await bag.store.load();
  assert.ok(pair);
  assert.equal(pair.access_token, 'at-min-1');
  assert.equal(pair.refresh_token, undefined, 'no refresh token is fabricated');
  assert.equal(pair.expires_in, 7200, 'the documented default lifetime is assumed');
  const stdoutText = bag.out.join('\n');
  assert.match(stdoutText, /no usable expires_in/);
  assert.match(stdoutText, /no refresh_token was issued/);
  assert.ok(!stdoutText.includes('Granted scopes'), 'no scope line without a scope');
});

test('exchange: empty refresh_token/scope and a non-positive expires_in are all dropped', async () => {
  const bag = makeDeps({
    exchange: {
      status: 200,
      body: { access_token: 'at-deg-1', refresh_token: '', expires_in: -5, scope: '' },
    },
  });
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({ ...bag.deps, openBrowser: browser.open });

  assert.equal(await cli([]), 0);
  const pair = await bag.store.load();
  assert.ok(pair);
  assert.equal(pair.refresh_token, undefined);
  assert.equal(pair.expires_in, 7200);
  assert.ok(!bag.out.some((l) => l.includes('Granted scopes')));
});

test('exchange: a non-finite expires_in and a non-string scope are dropped too', async () => {
  const bag = makeDeps({
    exchange: {
      status: 200,
      body: { access_token: 'at-nf-1', expires_in: Number.POSITIVE_INFINITY, scope: 42 },
    },
  });
  const browser = completingBrowser(bag);
  const cli = createAuthorizeCli({ ...bag.deps, openBrowser: browser.open });

  assert.equal(await cli([]), 0);
  const pair = await bag.store.load();
  assert.ok(pair);
  assert.equal(pair.expires_in, 7200);
  assert.ok(!bag.out.some((l) => l.includes('Granted scopes')));
});

// --- Production adapters (real fetch/node:http/readline, strictly local) -----------------

test('createFetchTokenExchangeHttp: posts the form, parses JSON, tolerates empty and non-JSON bodies', async () => {
  const mock = mockHttp();
  const http = createFetchTokenExchangeHttp(mock.dispatcher);

  // 1. JSON body, with the exact wire-format form and headers pinned by the matcher.
  mock.pool
    .intercept({
      path: '/2/oauth2/token',
      method: 'POST',
      headers: {
        authorization: 'Basic Zm9vOmJhcg==',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=authorization_code&code=code-1',
    })
    .reply(200, { access_token: 'at-fetch-1' });
  const okResponse = await http(
    DEFAULT_TOKEN_URL,
    { grant_type: 'authorization_code', code: 'code-1' },
    { authorization: 'Basic Zm9vOmJhcg==' },
  );
  assert.equal(okResponse.status, 200);
  assert.deepEqual(okResponse.body, { access_token: 'at-fetch-1' });

  // 2. Empty body → undefined (NET-1 tolerant parse).
  mock.pool.intercept({ path: '/2/oauth2/token', method: 'POST' }).reply(204, '');
  const emptyResponse = await http(DEFAULT_TOKEN_URL, {}, {});
  assert.equal(emptyResponse.status, 204);
  assert.equal(emptyResponse.body, undefined);

  // 3. Non-JSON body → the raw text, never a throw.
  mock.pool.intercept({ path: '/2/oauth2/token', method: 'POST' }).reply(502, '<html>bad</html>');
  const rawResponse = await http(DEFAULT_TOKEN_URL, {}, {});
  assert.equal(rawResponse.status, 502);
  assert.equal(rawResponse.body, '<html>bad</html>');

  mock.assertDone();
  await mock.close();
});

test('createFetchTokenExchangeHttp: without a dispatcher, a transport failure rejects raw', async () => {
  // No dispatcher → the default-dispatcher arm; an unparseable URL rejects inside fetch
  // itself, before any network I/O.
  const http = createFetchTokenExchangeHttp();
  await assert.rejects(http('http://', {}, {}));
});

test('createNodeLoopbackListen: binds 127.0.0.1 on an ephemeral port and serves one response', async () => {
  const listen = createNodeLoopbackListen();
  const seen: string[] = [];
  const server = await listen(LOOPBACK_HOST, 0, (request) => {
    seen.push(request.url);
    request.respond(200, 'adapter says hello');
  });
  try {
    assert.ok(server.port > 0, 'an ephemeral port was actually assigned');
    const response = await fetch(
      `http://${LOOPBACK_HOST}:${String(server.port)}${CALLBACK_PATH}?probe=1`,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'adapter says hello');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(seen, [`${CALLBACK_PATH}?probe=1`]);
  } finally {
    await server.close();
  }
});

test('createStdinReadLine: prompts on stdout and resolves the first stdin line', async () => {
  // The reader talks to the REAL process.stdin, so it runs in a child process with a
  // piped stdin. The module URL is handed over as an argument — portable on Windows,
  // where a bare path would not be a valid ESM specifier.
  const moduleHref = new URL('../../src/cli/authorize.js', import.meta.url).href;
  const script = [
    'const { createStdinReadLine } = await import(process.argv[1]);',
    "const answer = await createStdinReadLine()('Redirect URL: ');",
    "process.stdout.write('ANSWER:' + answer);",
  ].join('\n');

  const child = spawn(process.execPath, ['--input-type=module', '-e', script, moduleHref], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  child.stdin.write('  https://127.0.0.1/cb?code=x  \n');
  child.stdin.end();

  const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));
  assert.equal(exitCode, 0, `child failed: ${stderr}`);
  assert.ok(stdout.includes('Redirect URL: '), 'the prompt reached stdout');
  assert.ok(stdout.includes('ANSWER:  https://127.0.0.1/cb?code=x  '), 'the raw line came back');
});
