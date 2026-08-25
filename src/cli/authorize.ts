// The `x-mcp-ai authorize` subcommand — the one-time OAuth 2.0 authorization-code + PKCE
// dance that mints the initial token pair (docs/04 §4.3 / T12; docs/07 AUTH-13, AUTH-16).
// Owned by T-204.
//
// Security invariants implemented here:
//   • PKCE (S256): the `code_verifier` comes from the injected Random port and lives in
//     memory only — never printed, never echoed to the browser page, never logged.
//   • CSRF `state`: cryptographically random (Random port), carried through the
//     authorization request and STRICTLY verified on the callback (and on the pasted
//     redirect URL in --manual). A mismatch or a late callback is rejected and reported —
//     never silently accepted (AUTH-13).
//   • One-shot loopback listener: bound to 127.0.0.1 only (never 0.0.0.0), on an
//     ephemeral (or configured) port; exactly ONE callback is accepted — any later
//     request is refused — and the listener's lifetime is bounded by a short timeout.
//   • Single-use code: the authorization code is exchanged exactly once, and the token
//     pair is persisted through the TokenStore PORT before the success exit.
//   • `--manual` (AUTH-16): no listener, no browser launch; prints the authorization URL
//     and accepts the full redirect URL pasted back — same state verification. The
//     default browser flow detects launch failure and falls back to manual instructions
//     instead of hanging (the callback wait stays bounded by the timeout).
//
// Everything ambient is injected through `AuthorizeDeps`, so the whole flow runs under
// `node --test` with fakes (in-memory listener, fake token endpoint, scripted stdin).
// The integrator composes the real adapters — fetch/node:http/readline based defaults
// are exported at the bottom of this module. Routing stays in cli/dispatch.ts and is
// intentionally NOT wired here.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';

import type { Clock, Dispatcher, Random, Sleep, TokenPair, TokenStore } from '../core/ports.js';
import { XError, apiError, authError, networkError, validationError } from '../core/errors.js';

// --- Constants -----------------------------------------------------------------------

/** X's OAuth 2.0 authorization endpoint (docs/01 §2.1). Overridable per-deps for tests. */
export const DEFAULT_AUTHORIZATION_URL = 'https://x.com/i/oauth2/authorize';

/** X's OAuth 2.0 token endpoint. Overridable per-deps for tests. */
export const DEFAULT_TOKEN_URL = 'https://api.x.com/2/oauth2/token';

/** The redirect listener binds here and NOWHERE else — never 0.0.0.0 (AUTH-13). */
export const LOOPBACK_HOST = '127.0.0.1';

/** The redirect path. Register `http://127.0.0.1:<port>/callback` on the X app. */
export const CALLBACK_PATH = '/callback';

/** Bounded listener lifetime — the capture window cannot stay open (AUTH-13). */
export const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000;

/**
 * Nominal redirect port used by `--manual` when no port is configured. Nothing listens
 * on it — the browser's navigation to it fails, which is expected; the user pastes the
 * full redirect URL back (AUTH-16). It only has to match a redirect URI registered on
 * the X app.
 */
export const DEFAULT_MANUAL_REDIRECT_PORT = 8371;

/**
 * The scope superset the tool catalog needs (docs/01 §2.1, verbatim). The app's own
 * registered scopes bound what X actually grants; a narrower request can be composed via
 * `AuthorizeOAuthConfig.scopes` (e.g. a future preset→scope mapping).
 */
export const DEFAULT_SCOPES: readonly string[] = [
  'tweet.read',
  'tweet.write',
  'tweet.moderate.write',
  'users.read',
  'follows.read',
  'follows.write',
  'like.read',
  'like.write',
  'list.read',
  'list.write',
  'bookmark.read',
  'bookmark.write',
  'dm.read',
  'dm.write',
  'mute.read',
  'mute.write',
  'block.read',
  'block.write',
  'space.read',
  'media.write',
  'offline.access',
];

/** X token responses carry `expires_in`; if one ever does not, assume the documented 2 h. */
const DEFAULT_EXPIRES_IN_S = 7200;

/** Timeout for the code-exchange POST in the production fetch adapter. */
const EXCHANGE_TIMEOUT_MS = 30_000;

const USAGE = 'usage: x-mcp-ai authorize [--manual] [--port <port>]';

// --- Injection seams -------------------------------------------------------------------

/** One request received by the loopback listener. `respond` sends the human-facing page. */
export interface LoopbackRequest {
  /** Request target as received, e.g. `/callback?code=...&state=...`. */
  readonly url: string;
  /** Send the response page. The body NEVER contains `code`/`state`/`code_verifier`. */
  readonly respond: (status: number, body: string) => void;
}

export interface LoopbackServer {
  /** The actually-bound port (resolves an ephemeral `0` request). */
  readonly port: number;
  readonly close: () => Promise<void>;
}

/**
 * The listener factory seam. Production binds a real `node:http` server (adapter below);
 * tests hand back an in-memory fake. `host` is always {@link LOOPBACK_HOST}; `port` is
 * `0` for an OS-assigned ephemeral port.
 */
export type LoopbackListen = (
  host: string,
  port: number,
  onRequest: (request: LoopbackRequest) => void,
) => Promise<LoopbackServer>;

/** What the token endpoint answered. `body` is parsed JSON, raw text, or `undefined`. */
export interface TokenEndpointResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * The code-exchange HTTP seam — a single form-encoded POST. Production uses global
 * `fetch` with an injectable dispatcher (same idiom as api/http, never a hardcoded
 * undici import); tests inject a fake token endpoint. A transport failure rejects with
 * the raw error, which this module maps to a typed `network` XError.
 */
export type TokenExchangeHttp = (
  url: string,
  form: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>>,
) => Promise<TokenEndpointResponse>;

/** OAuth client + endpoint parameters, composed by the integrator from `parseConfig`. */
export interface AuthorizeOAuthConfig {
  /** `X_MCP_CLIENT_ID` — required; a public PKCE client needs nothing else. */
  readonly clientId: string;
  /** `X_MCP_CLIENT_SECRET` — confidential clients only; sent as HTTP Basic on exchange. */
  readonly clientSecret?: string;
  /** Scopes to request; defaults to {@link DEFAULT_SCOPES}. */
  readonly scopes?: readonly string[];
  /** Defaults to {@link DEFAULT_AUTHORIZATION_URL}. */
  readonly authorizationUrl?: string;
  /** Defaults to {@link DEFAULT_TOKEN_URL}. */
  readonly tokenUrl?: string;
  /** Fixed callback port (when the X app registers an exact redirect URI); `0` = ephemeral. */
  readonly callbackPort?: number;
  /** Listener lifetime; defaults to {@link DEFAULT_CALLBACK_TIMEOUT_MS}. */
  readonly callbackTimeoutMs?: number;
}

/**
 * Everything the authorize flow touches, injected (T-204's dictated seam). The
 * integrator composes real adapters; tests compose fakes. NOTE for the composition
 * root: the production `sleep` should `unref()` its timer so a pending callback-timeout
 * never holds the process open after success.
 */
export interface AuthorizeDeps {
  readonly oauth: AuthorizeOAuthConfig;
  /** Token persistence PORT — the file store in production (T-202), a fake in tests. */
  readonly tokenStore: TokenStore;
  /** Code-exchange HTTP callable (see {@link TokenExchangeHttp}). */
  readonly http: TokenExchangeHttp;
  /** Source of the PKCE `code_verifier` and the CSRF `state` (AUTH-13). */
  readonly random: Random;
  /** Stamps `obtained_at` on the minted pair. */
  readonly clock: Clock;
  /** Drives the bounded callback wait; tests inject a fake that never really waits. */
  readonly sleep: Sleep;
  /** Loopback listener factory (see {@link LoopbackListen}). */
  readonly listen: LoopbackListen;
  /** Read one line from stdin (`--manual`, AUTH-16). */
  readonly readLine: (prompt: string) => Promise<string>;
  /** Write one informational line (adapter appends the newline). */
  readonly stdout: (line: string) => void;
  /** Write one error/warning line. */
  readonly stderr: (line: string) => void;
  /**
   * Optional browser opener; resolves `false` (or throws) on launch failure, which falls
   * back to manual instructions (AUTH-16). Omit it entirely to only print the URL — no
   * `open`-style dependency exists or is wanted.
   */
  readonly openBrowser?: (url: string) => Promise<boolean>;
}

// --- CLI entry ---------------------------------------------------------------------------

/**
 * Build the `authorize` subcommand. The returned function takes the argv rest (from
 * cli/dispatch.ts, wired by the integrator) and resolves to the process exit code:
 * `0` = tokens persisted through the port; `1` = any failure (reported on stderr).
 */
export function createAuthorizeCli(
  deps: AuthorizeDeps,
): (rest: readonly string[]) => Promise<number> {
  return async (rest) => {
    try {
      const args = parseAuthorizeArgs(rest);
      if (typeof args === 'string') {
        deps.stderr(`x-mcp-ai authorize: ${args}`);
        deps.stderr(USAGE);
        return 1;
      }
      if (deps.oauth.clientId.trim() === '') {
        throw validationError(
          'X_MCP_CLIENT_ID is required for `authorize` — set it to your X app OAuth 2.0 client id',
        );
      }
      return args.manual ? await runManualFlow(deps, args) : await runListenerFlow(deps, args);
    } catch (err) {
      reportFailure(deps, err);
      return 1;
    }
  };
}

interface AuthorizeArgs {
  readonly manual: boolean;
  readonly port?: number;
}

/** Parse the argv rest. Returns the parsed flags or a human-readable error string. */
function parseAuthorizeArgs(rest: readonly string[]): AuthorizeArgs | string {
  let manual = false;
  let port: number | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? '';
    if (arg === '--manual') {
      manual = true;
      continue;
    }
    let portValue: string | undefined;
    if (arg === '--port') {
      i += 1;
      portValue = rest[i];
      if (portValue === undefined) return 'missing value for --port';
    } else if (arg.startsWith('--port=')) {
      portValue = arg.slice('--port='.length);
    } else {
      return `unknown argument "${arg}"`;
    }
    const n = Number(portValue);
    if (!/^\d+$/.test(portValue) || !Number.isInteger(n) || n > 65535) {
      return `invalid --port value "${portValue}" (expected an integer 0-65535)`;
    }
    port = n;
  }
  return port === undefined ? { manual } : { manual, port };
}

function reportFailure(deps: AuthorizeDeps, err: unknown): void {
  if (XError.is(err)) {
    deps.stderr(`x-mcp-ai authorize: [${err.kind}] ${err.message}`);
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  deps.stderr(`x-mcp-ai authorize: [api] unexpected failure — ${message}`);
}

// --- PKCE material -----------------------------------------------------------------------

interface PkceMaterial {
  /** RFC 7636 code_verifier — 43 base64url chars from 32 random bytes. In memory ONLY. */
  readonly verifier: string;
  /** S256 code_challenge = base64url(sha256(verifier)). */
  readonly challenge: string;
  /** CSRF state — independent 32 random bytes (AUTH-13). */
  readonly state: string;
}

function mintPkce(random: Random): PkceMaterial {
  const verifier = base64Url(random.bytes(32));
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const state = base64Url(random.bytes(32));
  return { verifier, challenge, state };
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function buildAuthorizationUrl(
  oauth: AuthorizeOAuthConfig,
  redirectUri: string,
  pkce: PkceMaterial,
): string {
  const url = new URL(oauth.authorizationUrl ?? DEFAULT_AUTHORIZATION_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', oauth.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', (oauth.scopes ?? DEFAULT_SCOPES).join(' '));
  url.searchParams.set('state', pkce.state);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

// --- Browser (listener) flow ---------------------------------------------------------------

type CallbackRejection =
  | { readonly kind: 'denied'; readonly errorCode: string }
  | { readonly kind: 'state-mismatch' }
  | { readonly kind: 'missing-code' }
  | { readonly kind: 'timeout' };

type FlowOutcome = { readonly kind: 'code'; readonly code: string } | CallbackRejection;

async function runListenerFlow(deps: AuthorizeDeps, args: AuthorizeArgs): Promise<number> {
  const oauth = deps.oauth;
  const pkce = mintPkce(deps.random);
  const requestedPort = args.port ?? oauth.callbackPort ?? 0;
  const timeoutMs = oauth.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;

  let resolveOutcome: (outcome: FlowOutcome) => void = () => undefined;
  const callbackReceived = new Promise<FlowOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  // One-shot guard (AUTH-13): the FIRST request on the callback path decides the flow's
  // outcome — valid or not — and every later request is refused. Requests to other paths
  // (a browser's /favicon.ico probe) get a 404 without consuming the one shot.
  let consumed = false;
  const onRequest = (request: LoopbackRequest): void => {
    const query = parseCallbackQuery(request.url);
    if (query === null) {
      request.respond(404, 'Not found.');
      return;
    }
    if (consumed) {
      request.respond(
        410,
        'This authorization flow already handled a callback. Close this window.',
      );
      return;
    }
    consumed = true;
    const errorCode = query.get('error');
    if (errorCode !== null) {
      request.respond(400, 'Authorization failed. Close this window and return to the terminal.');
      resolveOutcome({ kind: 'denied', errorCode: sanitizeOAuthCode(errorCode) });
      return;
    }
    if (query.get('state') !== pkce.state) {
      // AUTH-13: never silently accepted — and the received value is never echoed back.
      request.respond(400, 'State mismatch — this callback was rejected. Close this window.');
      resolveOutcome({ kind: 'state-mismatch' });
      return;
    }
    const code = query.get('code');
    if (code === null || code === '') {
      request.respond(400, 'Missing authorization code — this callback was rejected.');
      resolveOutcome({ kind: 'missing-code' });
      return;
    }
    // The success page carries no code, state, or verifier (AUTH-13).
    request.respond(200, 'Authorization received. Close this window and return to the terminal.');
    resolveOutcome({ kind: 'code', code });
  };

  let server: LoopbackServer;
  try {
    server = await deps.listen(LOOPBACK_HOST, requestedPort, onRequest);
  } catch (err) {
    throw validationError(
      `could not bind the loopback callback listener on ${LOOPBACK_HOST}:${String(requestedPort)} — is the port in use? Try --port <n> or --manual`,
      { cause: err },
    );
  }

  const redirectUri = `http://${LOOPBACK_HOST}:${String(server.port)}${CALLBACK_PATH}`;
  let outcome: FlowOutcome;
  try {
    const authorizationUrl = buildAuthorizationUrl(oauth, redirectUri, pkce);
    deps.stdout('Open this URL in your browser to authorize x-mcp-ai:');
    deps.stdout(`  ${authorizationUrl}`);
    deps.stdout(
      `Waiting for the OAuth callback on ${redirectUri} (times out in ${String(Math.round(timeoutMs / 1000))} s)...`,
    );
    await tryOpenBrowser(deps, authorizationUrl);

    outcome = await Promise.race([
      callbackReceived,
      deps.sleep(timeoutMs).then((): FlowOutcome => ({ kind: 'timeout' })),
    ]);
  } finally {
    // The capture window closes as soon as the outcome is decided (or on any throw).
    await server.close();
  }

  if (outcome.kind !== 'code') throw rejectionToError(outcome, timeoutMs);
  const exchanged = await exchangeCode(deps, outcome.code, pkce.verifier, redirectUri);
  return persistAndReport(deps, exchanged);
}

/** Returns the query for a callback-path request, or `null` for any other path. */
function parseCallbackQuery(rawUrl: string): URLSearchParams | null {
  let url: URL;
  try {
    url = new URL(rawUrl, `http://${LOOPBACK_HOST}`);
  } catch {
    return null;
  }
  return url.pathname === CALLBACK_PATH ? url.searchParams : null;
}

async function tryOpenBrowser(deps: AuthorizeDeps, url: string): Promise<void> {
  if (deps.openBrowser === undefined) return; // default: the URL is already printed
  let launched = false;
  try {
    launched = await deps.openBrowser(url);
  } catch {
    launched = false;
  }
  if (launched) return;
  // AUTH-16: launch failure falls back to manual instructions instead of hanging — the
  // wait below stays bounded by the callback timeout either way.
  deps.stderr(
    'Could not launch a browser — open the URL above manually; if this machine has no browser at all, re-run with `x-mcp-ai authorize --manual`.',
  );
}

function rejectionToError(rejection: CallbackRejection, timeoutMs: number): XError {
  switch (rejection.kind) {
    case 'timeout':
      // AUTH-13: a callback arriving after the timeout is rejected and reported.
      return authError(
        `timed out after ${String(Math.round(timeoutMs / 1000))} s waiting for the OAuth callback — nothing was authorized; if this machine has no local browser, re-run with \`x-mcp-ai authorize --manual\``,
      );
    case 'denied':
      return authError(
        `the authorization request was refused (${rejection.errorCode}) — no tokens were issued`,
      );
    case 'state-mismatch':
      return authError(
        'the callback state did not match this run (possible CSRF, or a stale redirect) — the authorization was rejected; re-run `x-mcp-ai authorize`',
      );
    case 'missing-code':
      return authError(
        'the callback carried no authorization code — the authorization was rejected',
      );
  }
}

// --- Manual (no-browser) flow (AUTH-16) -----------------------------------------------------

async function runManualFlow(deps: AuthorizeDeps, args: AuthorizeArgs): Promise<number> {
  const oauth = deps.oauth;
  const pkce = mintPkce(deps.random);
  const configuredPort = args.port ?? oauth.callbackPort ?? DEFAULT_MANUAL_REDIRECT_PORT;
  const nominalPort = configuredPort === 0 ? DEFAULT_MANUAL_REDIRECT_PORT : configuredPort;
  // No listener is opened (AUTH-16) — the redirect URI is nominal; the browser's
  // navigation to it fails and the user pastes the full URL back.
  const redirectUri = `http://${LOOPBACK_HOST}:${String(nominalPort)}${CALLBACK_PATH}`;
  const authorizationUrl = buildAuthorizationUrl(oauth, redirectUri, pkce);

  deps.stdout('Manual authorization (no browser is launched, no listener is opened):');
  deps.stdout('  1. Open this URL in any browser:');
  deps.stdout(`     ${authorizationUrl}`);
  deps.stdout(
    '  2. Approve the app. The browser will fail to load the redirect — that is expected.',
  );
  deps.stdout('  3. Copy the FULL redirect URL from the address bar and paste it below.');

  const input = (await deps.readLine('Redirect URL: ')).trim();
  if (input === '') {
    throw validationError(
      'no redirect URL was provided — re-run `x-mcp-ai authorize --manual` and paste the full redirect URL',
    );
  }
  const query = parseManualInput(input);
  if (query === null) {
    // A bare code is NOT accepted: without the query string the CSRF `state` cannot be
    // verified, and state verification is mandatory in manual mode too (AUTH-13/16).
    throw validationError(
      'could not parse the pasted value — paste the FULL redirect URL (a bare authorization code is not accepted because the `state` parameter must be verified)',
    );
  }
  const errorCode = query.get('error');
  if (errorCode !== null) {
    throw authError(
      `the authorization request was refused (${sanitizeOAuthCode(errorCode)}) — no tokens were issued`,
    );
  }
  if (query.get('state') !== pkce.state) {
    // AUTH-13 in manual clothing: same strict verification, same rejection.
    throw authError(
      'the pasted redirect URL carries a state that does not match this run (possible CSRF, or a URL from an older attempt) — the authorization was rejected; re-run `x-mcp-ai authorize --manual`',
    );
  }
  const code = query.get('code');
  if (code === null || code === '') {
    throw authError(
      'the pasted redirect URL carries no authorization code — the authorization was rejected',
    );
  }
  const exchanged = await exchangeCode(deps, code, pkce.verifier, redirectUri);
  return persistAndReport(deps, exchanged);
}

/**
 * Accepts a full redirect URL or its raw query string (`code=...&state=...`, with or
 * without the leading `?`). Returns `null` for anything else — notably a bare code.
 */
function parseManualInput(input: string): URLSearchParams | null {
  try {
    return new URL(input).searchParams;
  } catch {
    // Not an absolute URL — fall through to the query-string form.
  }
  const qs = input.startsWith('?') ? input.slice(1) : input;
  if (!qs.includes('=')) return null;
  const params = new URLSearchParams(qs);
  return params.has('code') || params.has('state') || params.has('error') ? params : null;
}

// --- Code exchange ---------------------------------------------------------------------------

interface ExchangeResult {
  readonly pair: TokenPair;
  /** Space-separated granted scopes, verbatim from the token response (docs/01 §2.1). */
  readonly scope?: string;
}

/**
 * Exchange the single-use authorization code for the initial token pair. The verifier
 * and the code travel ONLY in the POST form body — never through argv, logs, or pages.
 */
async function exchangeCode(
  deps: AuthorizeDeps,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<ExchangeResult> {
  const oauth = deps.oauth;
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    client_id: oauth.clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  };
  const headers: Record<string, string> = {};
  if (oauth.clientSecret !== undefined && oauth.clientSecret !== '') {
    // Confidential client: HTTP Basic per RFC 6749 §2.3.1. Public PKCE clients send none.
    const basic = Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString('base64');
    headers.authorization = `Basic ${basic}`;
  }

  let response: TokenEndpointResponse;
  try {
    response = await deps.http(oauth.tokenUrl ?? DEFAULT_TOKEN_URL, form, headers);
  } catch (err) {
    throw networkError(
      'the connection to the token endpoint failed before a response was received — check connectivity and try again',
      { cause: err },
    );
  }
  if (response.status < 200 || response.status >= 300) throw mapExchangeFailure(response);
  return toExchangeResult(deps, response.body);
}

/**
 * The exchange failure taxonomy. OAuth error codes are sanitized before they enter a
 * message (REND-7 discipline — no free-form response text in errors), and the body is
 * never echoed.
 */
function mapExchangeFailure(response: TokenEndpointResponse): XError {
  const status = response.status;
  const errorCode = readOAuthErrorCode(response.body);
  if (status >= 500) {
    return apiError(`the token endpoint failed with HTTP ${String(status)} — try again shortly`, {
      retryable: true,
      data: { http_status: status },
    });
  }
  if (errorCode === 'invalid_grant') {
    return authError(
      'the authorization code was rejected (invalid_grant) — it may have expired or already been used; re-run `x-mcp-ai authorize`',
      { data: { http_status: status } },
    );
  }
  if (errorCode === 'invalid_client' || status === 401) {
    return authError(
      'the token endpoint rejected the client credentials (invalid_client) — check X_MCP_CLIENT_ID and X_MCP_CLIENT_SECRET against your X app settings',
      { data: { http_status: status } },
    );
  }
  if (errorCode !== undefined) {
    return authError(
      `the token exchange was refused (${errorCode}) — verify the app's OAuth 2.0 settings and re-run \`x-mcp-ai authorize\``,
      { data: { http_status: status } },
    );
  }
  return apiError(`the token endpoint returned an unexpected HTTP ${String(status)} response`, {
    data: { http_status: status },
  });
}

function readOAuthErrorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>).error;
  return typeof value === 'string' ? sanitizeOAuthCode(value) : undefined;
}

/** OAuth error codes are machine tokens; anything else is replaced, never interpolated. */
function sanitizeOAuthCode(value: string): string {
  return /^[a-zA-Z0-9_.-]{1,40}$/.test(value) ? value : 'unknown_error';
}

function toExchangeResult(deps: AuthorizeDeps, body: unknown): ExchangeResult {
  if (typeof body !== 'object' || body === null) {
    throw apiError(
      'the token endpoint returned a success response without a JSON body — cannot continue',
    );
  }
  const record = body as Record<string, unknown>;
  const accessToken = record.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw apiError(
      'the token endpoint returned HTTP 200 without an access_token — unexpected response shape',
    );
  }
  const refreshToken =
    typeof record.refresh_token === 'string' && record.refresh_token !== ''
      ? record.refresh_token
      : undefined;
  const expiresIn =
    typeof record.expires_in === 'number' &&
    Number.isFinite(record.expires_in) &&
    record.expires_in > 0
      ? record.expires_in
      : undefined;
  if (expiresIn === undefined) {
    deps.stdout(
      `Note: the token response carried no usable expires_in — assuming ${String(DEFAULT_EXPIRES_IN_S)} s (the reactive 401 path remains the source of truth).`,
    );
  }
  if (refreshToken === undefined) {
    deps.stdout(
      'Note: no refresh_token was issued (is the `offline.access` scope granted?) — the access token cannot be refreshed after it expires.',
    );
  }
  const scope = typeof record.scope === 'string' && record.scope !== '' ? record.scope : undefined;
  const pair: TokenPair = {
    access_token: accessToken,
    ...(refreshToken !== undefined ? { refresh_token: refreshToken } : {}),
    obtained_at: deps.clock.now(),
    expires_in: expiresIn ?? DEFAULT_EXPIRES_IN_S,
  };
  return scope === undefined ? { pair } : { pair, scope };
}

/**
 * Persist THROUGH THE PORT, then report success. The pair itself never reaches
 * stdout/stderr (T2 — tokens never enter output); a persist failure fails the run,
 * so exit code 0 always implies the tokens are on disk (or wherever the store puts them).
 */
async function persistAndReport(deps: AuthorizeDeps, exchanged: ExchangeResult): Promise<number> {
  try {
    await deps.tokenStore.persist(exchanged.pair);
  } catch (err) {
    throw authError(
      'the tokens could not be persisted to the token store — nothing was saved; fix the token file location/permissions and re-run `x-mcp-ai authorize`',
      { cause: err },
    );
  }
  deps.stdout('Authorization complete — tokens persisted to the token store.');
  if (exchanged.scope !== undefined) deps.stdout(`Granted scopes: ${exchanged.scope}`);
  return 0;
}

// --- Production adapters (composed by the integrator; NOT wired here) ------------------------

// The exact shape of `fetch`'s second argument — structurally includes the non-standard
// `dispatcher` option (same derivation as core/ports and api/http; no undici import).
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

/**
 * Production {@link TokenExchangeHttp} over global `fetch`. The dispatcher stays
 * injectable exactly like api/http's (undefined in production → the default dispatcher,
 * which ignores proxy env vars, CFG-7); redirects are never followed.
 */
export function createFetchTokenExchangeHttp(dispatcher?: Dispatcher): TokenExchangeHttp {
  return async (url, form, headers) => {
    const init: FetchInit = {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    };
    if (dispatcher !== undefined) init.dispatcher = dispatcher;
    const response = await fetch(url, init);
    const text = await response.text();
    return { status: response.status, body: tryParseJson(text) };
  };
}

/** Production {@link LoopbackListen} over `node:http`. Binds exactly the host it is given. */
export function createNodeLoopbackListen(): LoopbackListen {
  return (host, port, onRequest) =>
    new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        onRequest({
          url: req.url ?? '/',
          respond: (status, body) => {
            res.writeHead(status, {
              'content-type': 'text/plain; charset=utf-8',
              'cache-control': 'no-store',
              connection: 'close',
            });
            res.end(body);
          },
        });
      });
      server.once('error', reject);
      server.listen(port, host, () => {
        const address = server.address();
        const boundPort = typeof address === 'object' && address !== null ? address.port : port;
        resolve({
          port: boundPort,
          close: () =>
            new Promise<void>((done) => {
              server.closeAllConnections();
              server.close(() => {
                done();
              });
            }),
        });
      });
    });
}

/** Production stdin reader for `--manual` over `node:readline`. One question, one answer. */
export function createStdinReadLine(): (prompt: string) => Promise<string> {
  return (prompt) =>
    new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
}

// Tolerant JSON parse for token-endpoint bodies (same discipline as api/http, NET-1):
// empty → undefined, invalid → the raw string. Never throws.
function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}
