// The host-scoped HTTP client — the production `EndpointInvoker` (docs/02 §6; docs/07
// AUTH-14, CFG-7, NET-1/2/3). Owned by T-114.
//
// It sends every `XApiRequest` over Node's global `fetch` with an INJECTABLE dispatcher.
// Production leaves the dispatcher undefined, so `fetch` uses its default dispatcher —
// which ignores HTTP(S)_PROXY env vars, satisfying proxy-ignore (CFG-7). Tests inject an
// undici `MockAgent` (test/helpers/http.ts), so no real network happens. `undici` is a
// DEV-only dependency; nothing here imports it.
//
// Responsibilities kept deliberately minimal — this layer owns transport, host-scoped
// auth, redirect refusal, timeouts, GET retry-once, and body tolerance. The rich
// (status, headers, body) → XError mapping is api/errors (T-116), plugged in through the
// `mapError` seam; the 401→refresh→retry loop is oauth2 (T-201/203), layered on top of the
// `authorization` provider. When those are absent we fall back to a safe, minimal `api`
// error that never leaks third-party body text.

import type { Dispatcher, Random, Sleep } from '../core/ports.js';
import type { EndpointInvoker, XApiRequest } from '../core/tooldef.js';
import { XError, apiError, networkError } from '../core/errors.js';

/** The X API v2 origin. Matches the frozen test contract (test/helpers/http.ts). */
export const DEFAULT_API_BASE_URL = 'https://api.x.com';

/** Per-attempt request timeout. A GET's retry gets its own fresh timeout window. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Hard ceiling on a response body we will buffer (NET-1); larger bodies are refused. */
export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

// Jittered backoff for the single GET retry: 250–750 ms (NET-3).
const RETRY_BACKOFF_MIN_MS = 250;
const RETRY_BACKOFF_SPAN_MS = 500;

/**
 * The host-scoped credential provider — the auth injection seam (AUTH-14). Resolves the
 * full `Authorization` header value (e.g. `Bearer …`) or `undefined` when there is no
 * credential (app-only with no bearer). oauth2 (T-201/203) plugs its refresh machine in
 * here; this client never touches token storage itself.
 */
export type AuthorizationProvider = () => Promise<string | undefined>;

/**
 * The rich error mapper seam (T-116, api/errors). Given the raw response facts it returns
 * a precisely-typed `XError` (auth/scope/rate-limit/billing/not-found/…). When omitted,
 * this client uses a minimal `api` fallback. `body` is best-effort-parsed JSON, or the raw
 * string when the body was not JSON, or `undefined` when empty.
 */
export type ErrorMapper = (status: number, headers: Headers, body: unknown) => XError;

/** Configuration for {@link createHttpClient}. The composition root (T-130) wires it. */
export interface HttpClientConfig {
  /** Backoff delay port — injected so the GET retry never really waits in tests. */
  readonly sleep: Sleep;
  /** Randomness port — supplies the retry jitter deterministically in tests. */
  readonly random: Random;
  /**
   * The fetch dispatcher. Production leaves it UNDEFINED (default dispatcher → ignores
   * proxy env, CFG-7); tests inject an undici `MockAgent`.
   */
  readonly dispatcher?: Dispatcher;
  /** Host-scoped auth provider (AUTH-14). Omit for unauthenticated requests. */
  readonly authorization?: AuthorizationProvider;
  /** API origin. Defaults to {@link DEFAULT_API_BASE_URL}. */
  readonly baseUrl?: string;
  /** Per-attempt timeout in ms. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Cooperative cancellation from the MCP host (ToolContext.signal). */
  readonly signal?: AbortSignal;
  /** Rich response→XError mapper (T-116). Omit to use the minimal `api` fallback. */
  readonly mapError?: ErrorMapper;
  /** Max buffered response bytes. Defaults to {@link DEFAULT_MAX_RESPONSE_BYTES}. */
  readonly maxResponseBytes?: number;
}

// The exact shape of `fetch`'s second argument, which structurally includes the
// non-standard `dispatcher` option (same derivation as Ports.Dispatcher).
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

/**
 * Auth is attached ONLY when the request targets the configured API origin (AUTH-14).
 * Exported for direct unit testing of the host-scoping predicate. Because redirects are
 * never followed (see `send`), a request URL can only ever be the base origin — so the
 * token can never chase a `Location` to a foreign host.
 */
export function shouldAttachAuth(requestUrl: URL, baseUrl: URL): boolean {
  return requestUrl.protocol === baseUrl.protocol && requestUrl.host === baseUrl.host;
}

/**
 * Build the production `EndpointInvoker`. One client is created per request pipeline; it
 * closes over the injected ports and config and exposes only `send`.
 */
export function createHttpClient(config: HttpClientConfig): EndpointInvoker {
  const base = new URL(config.baseUrl ?? DEFAULT_API_BASE_URL);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  function buildUrl(req: XApiRequest): URL {
    const url = new URL(req.path, base);
    if (req.query) {
      for (const [key, value] of Object.entries(req.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  async function buildHeaders(url: URL, hasBody: boolean): Promise<Record<string, string>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (hasBody) headers['content-type'] = 'application/json';
    if (config.authorization && shouldAttachAuth(url, base)) {
      const authorization = await config.authorization();
      // Never emit an empty Authorization header (AUTH-14) — treat blank as "no credential".
      if (authorization !== undefined && authorization !== '') {
        headers.authorization = authorization;
      }
    }
    return headers;
  }

  async function doFetch(
    url: URL,
    method: XApiRequest['method'],
    headers: Record<string, string>,
    bodyText: string | undefined,
  ): Promise<Response> {
    // A fresh timeout per attempt, combined with the host's cancellation signal (if any).
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = config.signal ? AbortSignal.any([timeout, config.signal]) : timeout;
    // redirect: 'manual' — a 3xx is surfaced, never followed, so auth never leaks (AUTH-14).
    const init: FetchInit = { method, headers, redirect: 'manual', signal };
    if (bodyText !== undefined) init.body = bodyText;
    if (config.dispatcher !== undefined) init.dispatcher = config.dispatcher;
    return fetch(url, init);
  }

  async function backoff(): Promise<void> {
    const ms = RETRY_BACKOFF_MIN_MS + config.random.float() * RETRY_BACKOFF_SPAN_MS;
    await config.sleep(ms);
  }

  // Buffer the body defensively (NET-1): bounded size, tolerant of empty/non-JSON. Throws
  // a terminal `api` error when oversized; a mid-stream transport failure rejects with the
  // raw error so the caller can map it to `network` (and retry a GET).
  async function readBody(response: Response): Promise<string> {
    const body = response.body;
    if (!body) return '';
    // undici-types default the stream's chunk to `any`; pin it so the read loop stays typed.
    const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxResponseBytes) {
        await discardReader(reader);
        throw apiError('X API response body exceeded the safe size limit.', {
          data: { http_status: response.status },
        });
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  function toError(response: Response, bodyText: string): XError {
    const parsed = tryParseJson(bodyText);
    if (config.mapError) return config.mapError(response.status, response.headers, parsed);
    // Minimal fallback — the full status/headers/body → XError mapping is api/errors (T-116).
    // We surface ONLY the status, never third-party body text (NET-1 / no raw HTML in prose).
    return apiError(`X API request failed with HTTP ${response.status}.`, {
      data: { http_status: response.status },
    });
  }

  function toNetworkError(err: unknown): XError {
    if (isTimeout(err)) {
      return networkError(`The X API request timed out after ${timeoutMs}ms.`, { cause: err });
    }
    // NET-2: a distinct message for connect/DNS/TLS/reset failures, kept generic — the raw
    // transport error is preserved as `cause` (never rendered to the agent), not inlined.
    return networkError('The connection to the X API failed before a response was received.', {
      cause: err,
    });
  }

  async function send<T>(req: XApiRequest): Promise<T> {
    const url = buildUrl(req);
    const bodyText = req.body === undefined ? undefined : JSON.stringify(req.body);
    const headers = await buildHeaders(url, bodyText !== undefined);
    const isRetryable = req.method === 'GET'; // writes (POST/PUT/DELETE) NEVER auto-retry (NET-3)
    const maxAttempts = isRetryable ? 2 : 1;

    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await doFetch(url, req.method, headers, bodyText);
      } catch (err) {
        // Host cancellation is never retried and is reported as such, not as a bare timeout.
        if (config.signal?.aborted) {
          throw networkError('The X API request was cancelled before a response arrived.', {
            cause: err,
          });
        }
        // NET-3: a GET retries once on a transport failure; a write surfaces it immediately.
        if (isRetryable && attempt < maxAttempts) {
          await backoff();
          continue;
        }
        throw toNetworkError(err);
      }

      // AUTH-14: redirects are refused. With redirect: 'manual', a real fetch yields an
      // opaque redirect (status 0); undici's MockAgent yields the raw 3xx. Both are refused.
      if (isRedirect(response)) {
        await discardBody(response);
        throw apiError(
          'X API returned a redirect; redirects are not followed for authenticated requests.',
          response.status >= 300 ? { data: { http_status: response.status } } : {},
        );
      }

      // NET-3: a GET retries once on a 5xx; a write does not.
      if (response.status >= 500 && isRetryable && attempt < maxAttempts) {
        await discardBody(response);
        await backoff();
        continue;
      }

      let bodyText2: string;
      try {
        bodyText2 = await readBody(response);
      } catch (err) {
        if (XError.is(err)) throw err; // terminal oversize `api` error — never retried
        if (config.signal?.aborted) {
          throw networkError('The X API request was cancelled while reading the response.', {
            cause: err,
          });
        }
        // NET-2/NET-3: a mid-stream failure (e.g. ECONNRESET) is a network error; GET retries once.
        if (isRetryable && attempt < maxAttempts) {
          await backoff();
          continue;
        }
        throw toNetworkError(err);
      }

      if (response.status < 200 || response.status >= 300) {
        throw toError(response, bodyText2);
      }
      return parseSuccess<T>(response.status, bodyText2);
    }
  }

  return { send };
}

// --- module-private helpers ------------------------------------------------------

function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
}

// Best-effort drain so an abandoned response does not hold the connection open.
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // best-effort cleanup — nothing actionable if cancel() rejects
  }
}

async function discardReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // best-effort cleanup
  }
}

// Tolerant JSON parse for the error path (NET-1): empty → undefined, invalid → the raw
// string (handed to the mapper, which decides what, if anything, to surface). Never throws.
function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}

// Parse a 2xx body. Empty (e.g. 204) resolves to `undefined`; a non-JSON success body
// (NET-1) becomes a clean `api` error rather than a JSON.parse crash — and never inlines
// the raw body text.
function parseSuccess<T>(status: number, text: string): T {
  const trimmed = text.trim();
  if (trimmed === '') return undefined as unknown as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    throw apiError('X API returned a success response with a body that was not valid JSON.', {
      data: { http_status: status },
      cause: err,
    });
  }
}

// AbortSignal.timeout aborts with a DOMException named 'TimeoutError'; fetch surfaces it as
// the rejection reason directly, or wrapped as `.cause`. Distinguishing it lets NET-2 give
// a timeout its own message.
function isTimeout(err: unknown): boolean {
  if (hasName(err, 'TimeoutError')) return true;
  if (err instanceof Error && err.cause !== undefined) return hasName(err.cause, 'TimeoutError');
  return false;
}

function hasName(value: unknown, name: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    (value as { name?: unknown }).name === name
  );
}
