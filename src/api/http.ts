// The host-scoped HTTP client — the production `EndpointInvoker` (docs/02 §6; docs/07
// AUTH-14, CFG-7, NET-1/2/3/4). Owned by T-114.
//
// It sends every `XApiRequest` over Node's global `fetch` with an INJECTABLE dispatcher.
// Production leaves the dispatcher undefined, so `fetch` uses its default dispatcher —
// which ignores HTTP(S)_PROXY env vars, satisfying proxy-ignore (CFG-7). Tests inject an
// undici `MockAgent` (test/helpers/http.ts), so no real network happens. `undici` is a
// DEV-only dependency; nothing here imports it.
//
// Responsibilities kept deliberately minimal — this layer owns transport, host-scoped
// auth, redirect refusal, timeouts, GET retry-once (5xx, transport, near-reset 429), body
// tolerance, and marking a write that failed without a definite answer as ambiguous and
// non-retryable (POST-4/NET-4). The rich
// (status, headers, body) → XError mapping is api/errors (T-116), plugged in through the
// `mapError` seam; the 401→refresh→retry loop is oauth2 (T-201/203), layered on top of the
// `authorization` provider. When those are absent we fall back to a safe, minimal `api`
// error that never leaks third-party body text. The `onResponse` observer is the third
// seam: it hands every response's status and headers to whoever tracks them (the
// rate-limit table, T-320 F6) without this layer knowing what a rate limit is. The
// `rateLimitRetryDelay` query is its counterpart: after a 429 it asks that same table how
// far away the reset is, so a GET can wait out a window about to renew (RATE-5).

import type { Dispatcher, Random, Sleep } from '../core/ports.js';
import type { EndpointInvoker, XApiRequest } from '../core/tooldef.js';
import { isCredentialEgressHost } from '../core/egress.js';
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
 * RATE-5: the longest reset a 429'd GET will wait out in-call. Beyond it the typed
 * `rate-limit` error goes back to the agent, which is better placed to decide whether a
 * longer wait is worth it than a request holding its `tools/call` open. It is the same 5 s
 * as the tracker's reset skew, so a window this close to renewing is one the preflight
 * would already let through (RATE-3).
 */
export const RATE_LIMIT_RETRY_MAX_MS = 5_000;

/**
 * POST-4 / NET-2 / NET-4 / MCP-7: a write that fails without a definite answer — a
 * transport failure, a 5xx, a cancellation — may still have been applied by X. This note
 * is the SUFFIX of every such non-GET error, and those errors are non-retryable, so the
 * agent never treats "failed" as "did not happen" and nothing re-issues the write blindly.
 * A tool with a sharper answer (a delete that is safe to repeat, a create with a probe)
 * swaps this suffix for its own guidance.
 */
export const WRITE_AMBIGUITY =
  ' The request had already been sent, so X may have applied the write anyway — the outcome ' +
  'is unknown (POST-4). Do NOT blindly re-issue it; verify the effect first.';

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

/**
 * The response observer seam (T-320 F6). Called SYNCHRONOUSLY for every HTTP response the
 * origin returned — success and error alike, once per attempt, in arrival order, before the
 * body is read and before this client decides to retry, refuse or map it. It exists so the
 * rate-limit tracker (`api/ratelimit`, wired by `mcp/compose`) learns a window's state from
 * the headers of a 200, not only from the 429 that follows — which is what makes the
 * preflight refusal a look-ahead rather than a repeat suppressor (RATE-2). A transport
 * failure (timeout, reset, cancellation) yields no response and so never reaches it. The
 * observer must not throw: it is wiring, not policy, and nothing here catches for it.
 */
export type ResponseObserver = (status: number, headers: Headers) => void;

/**
 * The rate-limit delay query (RATE-5). Consulted only after a GET came back 429 — and
 * therefore only AFTER the observer has recorded that 429 — it returns the milliseconds
 * until the bucket's window resets, or `null` when nothing is tracked. `mcp/compose` wires
 * it to `RateLimitTracker.retryDelayMs` under the same bucket key as the observer, so the
 * answer already reflects the 429's own headers, `retry-after` and `x-rate-limit-reset`
 * reconciled the tracker's way (RATE-7). Without it a 429 is never retried.
 */
export type RateLimitRetryDelay = () => number | null;

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
  /**
   * Client-wide cooperative cancellation. Production composes one client PER endpoint
   * bucket for the whole session, so this stays unset there; the per-`tools/call` signal
   * travels with each request instead (`XApiRequest.signal`, MCP-7). Both are honoured and
   * combined — see {@link createHttpClient}.
   */
  readonly signal?: AbortSignal;
  /** Rich response→XError mapper (T-116). Omit to use the minimal `api` fallback. */
  readonly mapError?: ErrorMapper;
  /** Sees every response's status and headers (T-320 F6). Omit when nothing tracks them. */
  readonly onResponse?: ResponseObserver;
  /** Reset delay after a 429, for the single GET retry (RATE-5). Omit to never retry a 429. */
  readonly rateLimitRetryDelay?: RateLimitRetryDelay;
  /** Max buffered response bytes. Defaults to {@link DEFAULT_MAX_RESPONSE_BYTES}. */
  readonly maxResponseBytes?: number;
}

// The exact shape of `fetch`'s second argument, which structurally includes the
// non-standard `dispatcher` option (same derivation as Ports.Dispatcher).
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

/**
 * Auth is attached ONLY when the request targets the configured API origin (AUTH-14) AND
 * that origin is on the hardcoded credential-egress allowlist (T10). Exported for direct
 * unit testing of the predicate. Because redirects are never followed (see `send`), a
 * request URL can only ever be the base origin — so the token can never chase a `Location`
 * to a foreign host.
 *
 * The two clauses answer different questions and neither implies the other: origin equality
 * keeps the credential off any host but the one this client was built for, and the
 * allowlist keeps it off any host that is not X's — including one an operator named via
 * `X_MCP_BASE_URL=…` + `X_MCP_ALLOW_INSECURE_BASE_URL=1`. Such a session still runs; it
 * simply sends no credential (docs/04 §4.4).
 */
export function shouldAttachAuth(requestUrl: URL, baseUrl: URL): boolean {
  return (
    requestUrl.protocol === baseUrl.protocol &&
    requestUrl.host === baseUrl.host &&
    isCredentialEgressHost(requestUrl)
  );
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

  /**
   * MCP-7: every signal that may cancel this request — the client-wide one (if configured)
   * and the per-request one the registry attaches for the owning `tools/call`. They are
   * COMBINED, never prioritized: a tool cannot opt out of host cancellation by setting its
   * own signal, and the host cannot override a tool's stricter deadline.
   */
  function cancellers(req: XApiRequest): readonly AbortSignal[] {
    const out: AbortSignal[] = [];
    if (config.signal !== undefined) out.push(config.signal);
    if (req.signal !== undefined) out.push(req.signal);
    return out;
  }

  function isCancelled(signals: readonly AbortSignal[]): boolean {
    return signals.some((signal) => signal.aborted);
  }

  async function doFetch(
    url: URL,
    method: XApiRequest['method'],
    headers: Record<string, string>,
    bodyText: string | undefined,
    signals: readonly AbortSignal[],
  ): Promise<Response> {
    // A fresh timeout per attempt, combined with every cancellation signal (if any).
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = signals.length === 0 ? timeout : AbortSignal.any([timeout, ...signals]);
    // redirect: 'manual' — a 3xx is surfaced, never followed, so auth never leaks (AUTH-14).
    const init: FetchInit = { method, headers, redirect: 'manual', signal };
    if (bodyText !== undefined) init.body = bodyText;
    if (config.dispatcher !== undefined) init.dispatcher = config.dispatcher;
    return fetch(url, init);
  }

  async function backoff(): Promise<void> {
    await config.sleep(jitterMs());
  }

  function jitterMs(): number {
    return RETRY_BACKOFF_MIN_MS + config.random.float() * RETRY_BACKOFF_SPAN_MS;
  }

  /**
   * RATE-5: how long a 429'd request should wait before its one retry, or `null` when it
   * must not retry — no tracker wired, nothing tracked, or a reset further out than
   * {@link RATE_LIMIT_RETRY_MAX_MS}. The jitter is added on top of the reset delay because X
   * reports resets in whole epoch seconds: arriving exactly on the boundary risks a second
   * 429 from a window that has not quite rolled over.
   */
  function rateLimitWaitMs(): number | null {
    const delay = config.rateLimitRetryDelay?.() ?? null;
    if (delay === null || delay > RATE_LIMIT_RETRY_MAX_MS) return null;
    return Math.max(0, delay) + jitterMs();
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

  function toError(method: XApiRequest['method'], response: Response, bodyText: string): XError {
    const parsed = tryParseJson(bodyText);
    // Minimal fallback — the full status/headers/body → XError mapping is api/errors (T-116).
    // We surface ONLY the status, never third-party body text (NET-1 / no raw HTML in prose).
    const mapped = config.mapError
      ? config.mapError(response.status, response.headers, parsed)
      : apiError(`X API request failed with HTTP ${response.status}.`, {
          data: { http_status: response.status },
        });
    return method !== 'GET' && response.status >= 500 ? toAmbiguousWrite(mapped) : mapped;
  }

  /**
   * NET-4: a 5xx on a write keeps its class and data, but the mapper's read-side advice ("a
   * single retry may succeed") is wrong for it — X may have applied the write before
   * failing. The message is rebuilt around that, and the error is non-retryable.
   */
  function toAmbiguousWrite(mapped: XError): XError {
    const status = mapped.data.http_status ?? 0;
    const reported =
      mapped.data.platform_title !== undefined || mapped.data.platform_detail !== undefined
        ? ' See `platform_title`/`platform_detail` for what X reported.'
        : '';
    return new XError(
      mapped.kind,
      `X failed this write with HTTP ${status}.${reported}${WRITE_AMBIGUITY}`,
      {
        retryable: false,
        fix: mapped.fix,
        data: mapped.data,
        cause: mapped,
      },
    );
  }

  /**
   * MCP-7: a cancelled request is a `network` error (no new taxonomy class — the transport
   * failed before a usable response, exactly what `network` means). A cancelled WRITE is
   * ambiguous the same way a timed-out write is: the bytes were already on the wire, so the
   * platform may have applied it (POST-4). It therefore carries the ambiguity note and is
   * marked NON-retryable, so nothing auto-re-issues a possibly-applied write. A cancelled
   * GET keeps the `network` default (safely re-issuable).
   */
  function toCancelledError(
    method: XApiRequest['method'],
    phase: 'request' | 'response',
    err: unknown,
  ): XError {
    const where = phase === 'request' ? 'before a response arrived' : 'while reading the response';
    const message = `The X API request was cancelled ${where}.`;
    if (method === 'GET') return networkError(message, { cause: err });
    return networkError(`${message}${WRITE_AMBIGUITY}`, { cause: err, retryable: false });
  }

  function toNetworkError(method: XApiRequest['method'], err: unknown): XError {
    // NET-2: a distinct message for timeouts vs connect/DNS/TLS/reset failures, kept generic —
    // the raw transport error is preserved as `cause` (never rendered to the agent), not inlined.
    const message = isTimeout(err)
      ? `The X API request timed out after ${timeoutMs}ms.`
      : 'The connection to the X API failed before a response was received.';
    if (method === 'GET') return networkError(message, { cause: err });
    return networkError(`${message}${WRITE_AMBIGUITY}`, { cause: err, retryable: false });
  }

  async function send<T>(req: XApiRequest): Promise<T> {
    const signals = cancellers(req);
    // MCP-7: a call cancelled before we start does NO work at all — in particular it never
    // invokes the authorization provider, so a cancelled call cannot trigger a token refresh.
    if (isCancelled(signals)) throw toCancelledError(req.method, 'request', undefined);

    const url = buildUrl(req);
    const bodyText = req.body === undefined ? undefined : JSON.stringify(req.body);
    const headers = await buildHeaders(url, bodyText !== undefined);
    const isRetryable = req.method === 'GET'; // writes (POST/PUT/DELETE) NEVER auto-retry (NET-3)
    const maxAttempts = isRetryable ? 2 : 1;

    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        response = await doFetch(url, req.method, headers, bodyText, signals);
      } catch (err) {
        // Cancellation is never retried and is reported as such, not as a bare timeout.
        if (isCancelled(signals)) {
          throw toCancelledError(req.method, 'request', err);
        }
        // NET-3: a GET retries once on a transport failure; a write surfaces it immediately.
        if (isRetryable && attempt < maxAttempts) {
          await backoff();
          continue;
        }
        throw toNetworkError(req.method, err);
      }

      // T-320 F6: the observer sees the response BEFORE any of the decisions below — a 3xx
      // this client refuses, a 5xx it is about to retry and a 2xx alike all carry whatever
      // rate-limit headers the origin attached, and every one of them is a fact about the
      // window that the tracker should not miss.
      config.onResponse?.(response.status, response.headers);

      // AUTH-14: redirects are refused. With redirect: 'manual', a real fetch yields an
      // opaque redirect (status 0); undici's MockAgent yields the raw 3xx. Both are refused.
      if (isRedirect(response)) {
        await discardBody(response);
        throw apiError(
          'X API returned a redirect; redirects are not followed for authenticated requests.',
          response.status >= 300 ? { data: { http_status: response.status } } : {},
        );
      }

      // NET-3: a GET retries once on a 5xx; a write does not. MCP-7: a cancellation that
      // landed while the 5xx was arriving stops the retry — nothing is re-sent after abort.
      if (response.status >= 500 && isRetryable && attempt < maxAttempts) {
        await discardBody(response);
        if (isCancelled(signals)) throw toCancelledError(req.method, 'request', undefined);
        await backoff();
        continue;
      }

      // RATE-5: a GET that hit a 429 on a window about to renew waits it out and retries
      // once; one that would wait longer, and every write, surfaces the typed error. It
      // shares the single retry with NET-3 — a GET that already retried a 5xx does not get
      // a second one here. A cancellation during the wait is caught by the next attempt's
      // fetch, which rejects on the aborted signal before anything is sent.
      if (response.status === 429 && isRetryable && attempt < maxAttempts) {
        const waitMs = rateLimitWaitMs();
        if (waitMs !== null) {
          await discardBody(response);
          if (isCancelled(signals)) throw toCancelledError(req.method, 'request', undefined);
          await config.sleep(waitMs);
          continue;
        }
      }

      let bodyText2: string;
      try {
        bodyText2 = await readBody(response);
      } catch (err) {
        if (XError.is(err)) throw err; // terminal oversize `api` error — never retried
        if (isCancelled(signals)) {
          throw toCancelledError(req.method, 'response', err);
        }
        // NET-2/NET-3: a mid-stream failure (e.g. ECONNRESET) is a network error; GET retries once.
        if (isRetryable && attempt < maxAttempts) {
          await backoff();
          continue;
        }
        throw toNetworkError(req.method, err);
      }

      if (response.status < 200 || response.status >= 300) {
        throw toError(req.method, response, bodyText2);
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
