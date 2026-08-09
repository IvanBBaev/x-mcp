// The OAuth2 integration facade (docs/02 §4A; docs/04 §4.1). Owned by T-203 (WP-2.3).
//
// This module composes the two halves built in parallel — the in-memory single-flight
// refresh machine (T-201, machine.ts) and the on-disk token store (T-202, filestore.ts,
// injected as a `TokenStore` by the composition root) — into what the serve path actually
// consumes:
//
//   • an {@link AuthorizationProvider} for api/http: every user-context request signs
//     with `Bearer <access token>` from `machine.getAccessToken()`, so the eager-refresh
//     boundary and the single-flight join (AUTH-2/7) apply per request with no timers;
//   • the production {@link RefreshHttp} over global `fetch` — the token-endpoint POST
//     with the {@link REFRESH_HTTP_TIMEOUT_MS} per-attempt timeout that MUST stay
//     strictly below the 30 s lock-staleness threshold (§4A step 4, AUTH-5);
//   • the 401 → `handleUnauthorized` → retry-ONCE orchestration (§4A step 6, docs/04
//     §4.1 item 6) that machine.ts declares out of its own scope: the triggering request
//     is retried exactly once after a completed refresh/adoption, and a second 401 on the
//     retried request surfaces as the mapped terminal `auth` error — no retry loop
//     (AUTH-8). It is layered as an `EndpointInvoker` wrapper on top of the
//     `authorization` seam, exactly where api/http's header comment points, so http.ts
//     itself stays untouched.
//
// A mid-flight refresh timeout is classified HERE (machine.ts passes a thrown XError
// through unchanged for this reason): it becomes a retryable `network` error, because the
// stored tokens are unchanged locally — if X did rotate server-side before the timeout,
// the NEXT refresh attempt gets `invalid_grant` and takes the terminal re-authorize path,
// so retrying can never double-spend a rotation.

import type { Clock, Dispatcher, TokenStore } from '../../core/ports.js';
import { XError, authError, networkError } from '../../core/errors.js';
import type { EndpointInvoker, XApiRequest } from '../../core/tooldef.js';
import type { AuthorizationProvider } from '../http.js';
import {
  REFRESH_HTTP_TIMEOUT_MS,
  createRefreshMachine,
  type RefreshHttp,
  type RefreshMachine,
} from './machine.js';

/** X's token endpoint, resolved against the configured base URL (docs/01 §2.1). */
export const TOKEN_ENDPOINT_PATH = '/2/oauth2/token';

// The exact shape of `fetch`'s second argument — structurally includes the non-standard
// `dispatcher` option (same derivation as core/ports and api/http; no undici import).
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

/** OAuth client + endpoint parameters for the production refresh POST. */
export interface FetchRefreshHttpOptions {
  /** `Config.baseUrl` — the token endpoint lives under the same host (CFG-3). */
  readonly baseUrl: string;
  /**
   * `X_MCP_CLIENT_ID`. The serve path does not REQUIRE it (config allows oauth2 mode
   * without it, since only `authorize` mints tokens) — but a refresh cannot run without
   * it, so a missing id surfaces as an operator-fixable `auth` error at refresh time,
   * NOT at composition time. The stored tokens stay untouched and usable until expiry.
   */
  readonly clientId?: string;
  /** `X_MCP_CLIENT_SECRET` — confidential clients only; sent as HTTP Basic (RFC 6749 §2.3.1). */
  readonly clientSecret?: string;
  /** Injectable like api/http's (undefined in production → default dispatcher, CFG-7). */
  readonly dispatcher?: Dispatcher;
}

/**
 * Production {@link RefreshHttp} over global `fetch` (same idiom as authorize.ts's
 * exchange adapter): form-encoded POST, redirects never followed, per-attempt timeout
 * {@link REFRESH_HTTP_TIMEOUT_MS} < the 30 s lock-staleness line (AUTH-5). Non-2xx maps
 * to `ok: false` with the sanitized OAuth error code; a timeout throws the retryable
 * `network` classification described in the module header; any other transport failure
 * rethrows raw for the machine to wrap.
 */
export function createFetchRefreshHttp(options: FetchRefreshHttpOptions): RefreshHttp {
  const url = new URL(TOKEN_ENDPOINT_PATH, options.baseUrl).toString();
  return async (refreshToken) => {
    const clientId = options.clientId;
    if (clientId === undefined || clientId === '') {
      throw authError(
        'X_MCP_CLIENT_ID is required to refresh OAuth2 tokens — set it to your X app OAuth 2.0 client id and restart; the stored tokens are unchanged.',
      );
    }
    // `client_id` always travels in the form (public PKCE clients have nothing else);
    // confidential clients ALSO authenticate with HTTP Basic — same split as authorize.ts.
    const form: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    };
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (options.clientSecret !== undefined && options.clientSecret !== '') {
      const basic = Buffer.from(`${clientId}:${options.clientSecret}`).toString('base64');
      headers.authorization = `Basic ${basic}`;
    }
    const init: FetchInit = {
      method: 'POST',
      headers,
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(REFRESH_HTTP_TIMEOUT_MS),
    };
    if (options.dispatcher !== undefined) init.dispatcher = options.dispatcher;

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      if (isTimeout(err)) {
        // Ambiguous mid-flight timeout: X may or may not have rotated server-side. The
        // stored tokens are unchanged locally, so retrying is safe — a rotation we never
        // saw surfaces as `invalid_grant` on the retry and fails closed there (AUTH-8).
        throw networkError(
          `Token refresh timed out after ${String(REFRESH_HTTP_TIMEOUT_MS / 1000)} s with no response; whether X rotated the tokens is unknown, but the stored tokens are unchanged locally, so refresh may be retried.`,
          { cause: err },
        );
      }
      throw err; // machine.ts wraps non-XError transport failures as retryable `network`
    }

    const body = tryParseJson(await response.text());
    if (response.status >= 200 && response.status < 300) {
      // Tolerant extraction (the machine validates and fails closed on a 200 without a
      // usable access token itself): unusable fields are simply absent from the result.
      const record =
        typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      const accessToken = record.access_token;
      const refresh = record.refresh_token;
      const expiresIn = record.expires_in;
      return {
        ok: true,
        token: {
          access_token: typeof accessToken === 'string' ? accessToken : '',
          ...(typeof refresh === 'string' && refresh !== '' ? { refresh_token: refresh } : {}),
          ...(typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
            ? { expires_in: expiresIn }
            : {}),
        },
      };
    }
    // OAuth error codes are machine tokens, sanitized before they can reach a message
    // (REND-7 discipline, same as authorize.ts); the description rides only in error DATA.
    const errorCode = readOAuthErrorCode(body);
    const description = readOAuthErrorDescription(body);
    return {
      ok: false,
      status: response.status,
      ...(errorCode === undefined ? {} : { error: errorCode }),
      ...(description === undefined ? {} : { error_description: description }),
    };
  };
}

/** Everything the facade composes over; built by the composition root (mcp/compose). */
export interface OAuth2AuthOptions {
  readonly clock: Clock;
  /** The T-202 file store in production; the in-memory fake in tests. */
  readonly store: TokenStore;
  /** The token-endpoint POST — {@link createFetchRefreshHttp} in production. */
  readonly refreshHttp: RefreshHttp;
}

/** The wired user-context auth surface the composition root plugs into api/http. */
export interface OAuth2Auth {
  /** Signs every user-context request; throws typed `auth` when nothing is stored (AUTH-9). */
  readonly authorization: AuthorizationProvider;
  /** The store handed in — exposed so `ports.tokens` and the facade share one instance. */
  readonly store: TokenStore;
  /** The underlying machine, for observability (`state()`) and direct tests. */
  readonly machine: RefreshMachine;
  /** Wrap a bucket's http client with the 401 → refresh → retry-once orchestration. */
  readonly withAuthRetry: (inner: EndpointInvoker) => EndpointInvoker;
}

/**
 * The mapped-response predicate for "this request's credentials were rejected": exactly
 * the `auth` taxonomy carrying HTTP 401 (api/errors' mapHttpError). A `scope` 401 is
 * deliberately excluded — an insufficient-scope rejection cannot be repaired by a
 * refresh, only by re-authorizing with more scopes (SCOPE-1), so refreshing would burn a
 * rotation for nothing.
 */
function isUnauthorized(err: unknown): boolean {
  return XError.is(err) && err.kind === 'auth' && err.data.http_status === 401;
}

export function createOAuth2Auth(options: OAuth2AuthOptions): OAuth2Auth {
  const machine = createRefreshMachine({
    clock: options.clock,
    store: options.store,
    refreshHttp: options.refreshHttp,
  });

  const authorization: AuthorizationProvider = async () =>
    `Bearer ${await machine.getAccessToken()}`;

  function withAuthRetry(inner: EndpointInvoker): EndpointInvoker {
    return {
      async send<T>(req: XApiRequest): Promise<T> {
        // Pre-acquire the token this send will sign with: api/http invokes the provider
        // synchronously at the top of its send, so no refresh can slip in between — and
        // even if one did, `handleUnauthorized` treats a stale token as already-recovered
        // and returns the current pair without refreshing (machine.ts REACTIVE fast path).
        const issued = await machine.getAccessToken();
        try {
          return await inner.send<T>(req);
        } catch (err) {
          if (!isUnauthorized(err)) throw err;
          // Reload-on-401 (AUTH-4) → adopt-or-refresh (AUTH-3) → persist-before-use
          // (AUTH-1) all happen inside this call; it resolves only once a token
          // DIFFERENT from `issued` is safe to use, or throws typed.
          await machine.handleUnauthorized(issued);
          // Retry exactly once — the provider re-fetches the recovered token. A second
          // 401 here propagates as the mapped terminal `auth` error (AUTH-8): no loop.
          return await inner.send<T>(req);
        }
      },
    };
  }

  return { authorization, store: options.store, machine, withAuthRetry };
}

// --- Local helpers (same discipline as authorize.ts, kept private there too) -----------

// AbortSignal.timeout aborts with a DOMException named 'TimeoutError'; fetch surfaces it
// directly or as the `cause` of its own TypeError — same detection as api/http's.
function isTimeout(err: unknown): boolean {
  if (hasName(err, 'TimeoutError')) return true;
  if (err instanceof Error && err.cause !== undefined) return hasName(err.cause, 'TimeoutError');
  return false;
}

function hasName(err: unknown, name: string): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === name;
}

function readOAuthErrorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>).error;
  return typeof value === 'string' ? sanitizeOAuthCode(value) : undefined;
}

/** The free-form description never enters a message — only structured error data. */
function readOAuthErrorDescription(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>).error_description;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** OAuth error codes are machine tokens; anything else is replaced, never interpolated. */
function sanitizeOAuthCode(value: string): string {
  return /^[a-zA-Z0-9_.-]{1,40}$/.test(value) ? value : 'unknown_error';
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
