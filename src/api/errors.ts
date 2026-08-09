// HTTP → XError mapper (docs/02 §5.5 taxonomy, §6 pipeline; docs/07 DX-F13/REND-2/REND-7,
// DRIFT-2, RATE-2/4/7, COST-6/7, AUTH-8). Owned by T-116. This module is the single place
// that turns an X API v2 error response into a typed `XError`, and a 200-with-`errors[]`
// batch response into the partial-failure `missing[]` contract. It is PURE: it performs no
// I/O and reads nothing but its arguments (the optional `nowMs` makes the one time-relative
// output — `retry_after_seconds` — deterministic for tests).
//
// What lives HERE vs elsewhere:
//   • `mapHttpError` maps a RESPONSE (a status exists). Transport failures with NO response
//     (DNS/TLS/reset/timeout) map to the `network` class inside api/http (T-114) — never here.
//   • The rate-limit TABLE and preflight refusal live in api/ratelimit (T-115); this module
//     only classifies a 429 that already came back and surfaces its reset window.
//
// Design rules baked in:
//   • DX-F13 — every returned XError carries actionable, agent- or operator-directed
//     remediation prose in `message`; the platform's own `title`/`detail` pass through in
//     `data` (DRIFT-2), never as the primary instruction.
//   • REND-7 — no third-party content and no raw upstream body ever land in a message. An
//     HTML/non-JSON error page is recognised and dropped, never echoed. The `message` text is
//     fixed per class and never interpolates a post/bio/DM string; only OUR own remediation
//     prose plus safe scalar fields (status, reset time, scope name) appear.
//   • REND-6 — the platform prose that DOES pass through (`platform_title`/`platform_detail`)
//     is third-party text and is sanitized and length-capped on ingest exactly like every
//     other third-party string (core/sanitize), because it lands in the tool error the model
//     reads. Only OUR remediation prose is exempt — this codebase authors it, so there is
//     nothing to strip and clipping it would destroy the DX-F13 instructions.
//   • REND-2 — a batch/single lookup that partially fails (HTTP 200 with an `errors[]` array)
//     is NOT an error: `collectMissing` returns the `missing[]` list so the tool can render
//     found items + why the rest are absent.

import {
  apiError,
  authError,
  billingError,
  forbiddenError,
  notFoundError,
  rateLimitError,
  scopeError,
  type XError,
  type XErrorData,
} from '../core/errors.js';
import type { Missing, MissingReason } from '../core/render-shapes.js';
import { sanitizePlatformText } from '../core/sanitize.js';

// --- Public input types ----------------------------------------------------------

/**
 * A header source. Accepts either a WHATWG `Headers`-like object (a real `Response.headers`)
 * or a plain, case-insensitive record (what a JSON fixture deserialises to). Lookups are
 * always case-insensitive; an array value takes its first element.
 */
export type HeaderSource =
  | { get(name: string): string | null }
  | Readonly<Record<string, string | number | readonly string[] | undefined>>;

// --- Partial-failure (REND-2) contract -------------------------------------------

// The `Missing` / `MissingReason` shapes are the single canonical partial-failure contract,
// defined in core/render-shapes.ts and shared with the batch renderers (core/render, T-117).
// Re-exported here so error-mapping callers can keep importing them from this module (INT-4).
export type { Missing, MissingReason } from '../core/render-shapes.js';

// --- Small, total helpers (no throwing) ------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toFiniteNumber(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const n = Number(text.trim());
  return Number.isFinite(n) ? n : undefined;
}

/** Case-insensitive header read that works for both `Headers` and a plain record. */
function readHeader(headers: HeaderSource, name: string): string | undefined {
  const maybeGet = (headers as { get?: unknown }).get;
  if (typeof maybeGet === 'function') {
    const value = (headers as { get(name: string): string | null }).get(name);
    return value === null ? undefined : value;
  }
  const record = headers as Record<string, string | number | readonly string[] | undefined>;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = record[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) {
      const first: unknown = value[0];
      return typeof first === 'string' ? first : undefined;
    }
    return undefined;
  }
  return undefined;
}

// --- Problem-body parsing --------------------------------------------------------

/**
 * The fields we care about from an X v2 error body, normalised across the RFC-7807 problem
 * shape (`{title, detail, type}` at top level) and the legacy `{errors:[{message,code}]}`
 * shape. Values are `undefined` when absent (never partially-typed).
 *
 * REND-6: every string in here is SANITIZED — `parseProblem` is the single point at which
 * platform prose is lifted off the wire, so the rest of the module can treat these three
 * fields as safe by construction.
 */
interface ParsedProblem {
  readonly title: string | undefined;
  readonly detail: string | undefined;
  readonly type: string | undefined;
}

function parseProblem(body: unknown): ParsedProblem {
  const obj = asRecord(body);
  if (obj === undefined) {
    // A string body (HTML error page, truncated JSON) or a non-object: nothing safe to read.
    return { title: undefined, detail: undefined, type: undefined };
  }
  let title = asString(obj['title']);
  let detail = asString(obj['detail']);
  const type = asString(obj['type']);

  const errors = obj['errors'];
  if (Array.isArray(errors) && errors.length > 0) {
    const first = asRecord(errors[0]);
    if (first !== undefined) {
      title = title ?? asString(first['title']) ?? asString(first['message']);
      detail = detail ?? asString(first['detail']) ?? asString(first['message']);
    }
  }
  // REND-6/REND-7: `title`/`detail` are surfaced to the agent verbatim in `platform_title` /
  // `platform_detail` (DRIFT-2), so they get the SAME strip-and-cap every third-party string
  // on a success path gets — the error payload is not an exemption from docs/04 §5, it is
  // just the one path that never passes a compactor. Sanitizing HERE rather than in the two
  // `data` builders means a future builder cannot forget it, and the classifiers below
  // benefit too: a zero-width character can no longer be used to break up `scope` or
  // `not enrolled` and steer a response into the wrong error class. `type` is a platform
  // URI that never reaches the agent, but it is wire text like the others and reads cleaner
  // sanitized than carved out by exception.
  return {
    title: sanitizePlatformText(title),
    detail: sanitizePlatformText(detail),
    type: sanitizePlatformText(type),
  };
}

function haystack(problem: ParsedProblem): string {
  return `${problem.title ?? ''} ${problem.detail ?? ''} ${problem.type ?? ''}`.toLowerCase();
}

/** The token lacks an OAuth scope the endpoint requires (401/403 with a scope signal). */
function looksLikeScope(problem: ParsedProblem): boolean {
  const hay = haystack(problem);
  return (
    /scope/.test(problem.type ?? '') ||
    /\bscopes?\b/.test(hay) ||
    hay.includes('oauth1-permissions')
  );
}

/**
 * A billing/entitlement rejection — out of prepaid credit, or the account lacks the required
 * product/access level (COST-6/7). The real credit-exhaustion body is not publicly documented
 * (COST-6 is a named Phase-1 live-capture task), so detection is a conservative keyword set;
 * it stays clear of the phrases genuine `forbidden` refusals use (suspended/protected/blocked/
 * duplicate).
 */
function looksLikeBilling(problem: ParsedProblem): boolean {
  const type = problem.type ?? '';
  if (/usage-capped|not-enrolled|payment-required|client-not-enrolled/.test(type)) return true;
  const hay = haystack(problem);
  return /\b(credit|credits|entitlement|entitled|not enrolled|enrollment|access level|payment required|out of credit|usage cap|usage limit|monthly (post )?cap|quota exceeded|billing)\b/.test(
    hay,
  );
}

/** Best-effort scope name (e.g. `tweet.write`) from the detail; usually absent. */
function extractScope(problem: ParsedProblem): string | undefined {
  const match = /\b([a-z]+(?:\.[a-z]+)+)\b/.exec(problem.detail ?? '');
  return match?.[1];
}

function looksLikeHtml(body: unknown, headers: HeaderSource): boolean {
  if (typeof body !== 'string') return false;
  const contentType = (readHeader(headers, 'content-type') ?? '').toLowerCase();
  if (contentType.includes('html')) return true;
  const head = body.trimStart().slice(0, 14).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<');
}

// --- data builders (exactOptionalPropertyTypes-safe: never write `undefined`) -----

function baseData(status: number, problem: ParsedProblem): XErrorData {
  return {
    http_status: status,
    ...(problem.title !== undefined ? { platform_title: problem.title } : {}),
    ...(problem.detail !== undefined ? { platform_detail: problem.detail } : {}),
  };
}

// --- The mapper ------------------------------------------------------------------

/**
 * Map an X API v2 error RESPONSE to a typed `XError`.
 *
 * @param status  HTTP status of the response (expected ≥ 400).
 * @param headers Response headers (`Headers` or a case-insensitive record).
 * @param body    Parsed JSON body, OR a raw string when the body was non-JSON (HTML/truncated).
 * @param nowMs   Epoch millis used only to turn a rate-limit reset into `retry_after_seconds`;
 *                defaults to `Date.now()`. Pass a fixed value in tests for determinism.
 */
export function mapHttpError(
  status: number,
  headers: HeaderSource,
  body: unknown,
  nowMs: number = Date.now(),
): XError {
  const problem = parseProblem(body);
  const data = baseData(status, problem);

  if (status === 429) {
    return mapRateLimit(status, headers, problem, nowMs);
  }

  if (status === 402) {
    return billingError(BILLING_MESSAGE, { data });
  }

  if (status === 401) {
    if (looksLikeScope(problem)) return mapScope(problem, data);
    return authError(
      'The X API rejected the request credentials as missing, invalid, or expired, and an ' +
        'automatic token refresh did not recover (AUTH-8). Re-authorize by running ' +
        '`npx x-mcp-ai authorize`, then retry.',
      { data },
    );
  }

  if (status === 403) {
    if (looksLikeScope(problem)) return mapScope(problem, data);
    if (looksLikeBilling(problem)) return billingError(BILLING_MESSAGE, { data });
    return forbiddenError(
      'X refused this specific action. Typical causes: the target is suspended, protected, ' +
        'or blocked, or a write duplicates existing content — the action will not succeed as ' +
        'issued. Adjust the target or arguments; see `platform_detail` for the reason X gave. ' +
        '(A platform refusal, distinct from an unexpected `api` error — DRIFT-2.)',
      { data },
    );
  }

  if (status === 404) {
    return notFoundError(
      'The requested resource does not exist or is not visible with the current credentials. ' +
        'Check the id or handle and retry; the same call will not succeed unless the resource ' +
        'becomes available.',
      { data },
    );
  }

  // Everything else (5xx, and any unmapped 4xx) → `api` (DRIFT-2). A 5xx is often transient,
  // so it is retryable — the GET-retry-once gate (NET-3) lives in api/http and honours method.
  const retryable = status >= 500;
  if (looksLikeHtml(body, headers)) {
    // REND-7 / NET-1: recognise the HTML error page (Cloudflare/gateway 502) and DROP it —
    // the raw markup is never placed in the message or in `platform_detail`.
    return apiError(
      `X or an upstream gateway returned a non-JSON HTML error page with HTTP ${status}. This ` +
        `is usually a transient gateway problem; ${
          retryable ? 'an idempotent read may retry once after a short backoff' : 'do not retry'
        }. The raw HTML page is intentionally omitted (REND-7).`,
      { retryable, data: { http_status: status } },
    );
  }
  return apiError(
    `X returned an error (HTTP ${status}) that this server could not map to a specific cause. ` +
      `See \`platform_title\`/\`platform_detail\` for what X reported${
        retryable ? '; a 5xx is often transient, so a single retry may succeed' : ''
      }.`,
    { retryable, data },
  );
}

const BILLING_MESSAGE =
  'X rejected the call for a billing or entitlement reason: out of prepaid credit, or the ' +
  'account lacks the required product / access level for this endpoint (COST-6). This is NOT ' +
  'the local session budget — add credit or enable the entitlement on the X developer ' +
  'account, then retry.';

function mapScope(problem: ParsedProblem, data: XErrorData): XError {
  const scope = extractScope(problem);
  const scopedData: XErrorData = scope !== undefined ? { ...data, scope } : data;
  return scopeError(
    `The access token is missing an OAuth scope this endpoint requires${
      scope !== undefined ? ` (\`${scope}\`)` : ''
    }. Re-authorize with the needed scopes (run \`npx x-mcp-ai authorize\`) and retry.`,
    { data: scopedData },
  );
}

function mapRateLimit(
  status: number,
  headers: HeaderSource,
  problem: ParsedProblem,
  nowMs: number,
): XError {
  const nowSec = Math.floor(nowMs / 1000);
  const resetEpoch = toFiniteNumber(readHeader(headers, 'x-rate-limit-reset'));
  const retryAfter = toFiniteNumber(readHeader(headers, 'retry-after'));

  // RATE-7: when both a relative `retry-after` and an absolute `x-rate-limit-reset` are present
  // and disagree, the LATER time wins (conservative). RATE-4: neither header → no window fields.
  const candidates: number[] = [];
  if (resetEpoch !== undefined) candidates.push(resetEpoch);
  if (retryAfter !== undefined) candidates.push(nowSec + retryAfter);

  let resetAtIso: string | undefined;
  let retryAfterSeconds: number | undefined;
  if (candidates.length > 0) {
    const chosen = Math.max(...candidates);
    resetAtIso = new Date(chosen * 1000).toISOString();
    retryAfterSeconds = Math.max(0, chosen - nowSec);
  }

  const data: XErrorData = {
    http_status: status,
    ...(resetAtIso !== undefined ? { reset_at: resetAtIso } : {}),
    ...(retryAfterSeconds !== undefined ? { retry_after_seconds: retryAfterSeconds } : {}),
    ...(problem.title !== undefined ? { platform_title: problem.title } : {}),
    ...(problem.detail !== undefined ? { platform_detail: problem.detail } : {}),
  };

  const when =
    resetAtIso !== undefined
      ? ` Wait until the window resets at ${resetAtIso} (~${retryAfterSeconds}s) before retrying.`
      : ' Retry after a short backoff.';
  return rateLimitError(
    `The X rate-limit window for this endpoint is exhausted.${when} Idempotent reads may retry ` +
      'once when the reset is imminent; writes must not auto-retry (RATE-5).',
    { data },
  );
}

// --- Partial failures (REND-2) ---------------------------------------------------

function classifyMissing(entry: Record<string, unknown>): MissingReason {
  const hay = `${asString(entry['title']) ?? ''} ${asString(entry['detail']) ?? ''} ${
    asString(entry['type']) ?? ''
  }`.toLowerCase();
  if (hay.includes('suspend')) return 'suspended';
  if (hay.includes('protect')) return 'protected';
  if (hay.includes('deleted')) return 'deleted';
  if (
    hay.includes('not authorized') ||
    hay.includes('not-authorized') ||
    hay.includes('unauthorized')
  ) {
    return 'unauthorized';
  }
  return 'not-found';
}

/**
 * Extract the partial-failure `missing[]` list from an HTTP-200 batch/single lookup body that
 * carries an `errors[]` array (REND-2). Total and never-throwing: a body with no `errors[]`
 * (a full success, or an explicit zero-results page — REND-1) yields `[]`. The tool renders
 * `data` items plus this list; it never raises. Only safe scalars are surfaced — no raw
 * platform `detail` prose (REND-7).
 */
export function collectMissing(body: unknown): readonly Missing[] {
  const obj = asRecord(body);
  if (obj === undefined) return [];
  const errors = obj['errors'];
  if (!Array.isArray(errors)) return [];

  const out: Missing[] = [];
  for (const raw of errors) {
    const entry = asRecord(raw);
    if (entry === undefined) continue;
    const id = asString(entry['resource_id']) ?? asString(entry['value']) ?? '';
    const resourceType = asString(entry['resource_type']);
    out.push({
      id,
      reason: classifyMissing(entry),
      ...(resourceType !== undefined ? { resource_type: resourceType } : {}),
    });
  }
  return out;
}
