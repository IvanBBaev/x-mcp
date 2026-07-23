// Error taxonomy — FROZEN CONTRACT (docs/02 §5.5). Owned by T-102; consumed by the
// request pipeline (core/registry, T-115), the HTTP→error mapper (api/errors, T-116),
// and the MCP result adapter (mcp/structured, T-125). Do not add or rename classes
// without a corpus revision — every layer switches on `kind`.
//
// Every error the server surfaces is an `XError` carrying:
//   • kind        — one of the 11 taxonomy classes below
//   • retryable   — may the SAME call succeed again unchanged? (GET auto-retry gate)
//   • fix         — who can act: the calling agent, or the human operator?
//   • message     — plain-language remediation (agent- or operator-directed)
//   • data        — optional structured fields (retry_after_seconds, scope, cell, …)
//
// `core` does no I/O and imports nothing from other layers; this module is dependency-free.

/**
 * The 11 error classes. Stable, exhaustive, switch-friendly.
 *
 * - `auth`       — no/invalid/expired credentials; refresh already failed. (operator)
 * - `scope`      — token lacks the OAuth scope this endpoint needs. (operator)
 * - `forbidden`  — authenticated but not permitted (suspended, protected, blocked). (agent)
 * - `rate-limit` — X rate window exhausted; carries reset_at / retry_after_seconds. (agent)
 * - `budget`     — session credit budget would be exceeded in `hard` mode. (operator)
 * - `billing`    — X account lacks the paid tier / entitlement for this endpoint. (operator)
 * - `policy`     — a local policy cell denies this operation:domain. (operator)
 * - `validation` — arguments failed schema/semantic checks before any API call. (agent)
 * - `not-found`  — the requested resource does not exist / is not visible. (agent)
 * - `api`        — X returned an error we cannot map more specifically. (varies)
 * - `network`    — transport failure (DNS, TLS, timeout, reset) before a response. (agent)
 */
export type ErrorClass =
  | 'auth'
  | 'scope'
  | 'forbidden'
  | 'rate-limit'
  | 'budget'
  | 'billing'
  | 'policy'
  | 'validation'
  | 'not-found'
  | 'api'
  | 'network';

/** Who can remediate: the calling agent (adjust the call) or the human operator (change config). */
export type ErrorFix = 'agent' | 'operator';

/**
 * Optional structured fields. Every field is class-specific and omitted when N/A
 * (exactOptionalPropertyTypes — never set to `undefined`, just leave it out).
 */
export interface XErrorData {
  /** Missing OAuth scope, e.g. `tweet.write`. (kind `scope`) */
  readonly scope?: string;
  /** Rate-limit window reset, ISO-8601. (kind `rate-limit`) */
  readonly reset_at?: string;
  /** Seconds until a retry is sensible. (kind `rate-limit`) */
  readonly retry_after_seconds?: number;
  /** Denied policy cell `operation:domain`, e.g. `write:dm`. (kind `policy`) */
  readonly cell?: string;
  /** Upstream HTTP status, when the error was derived from a response. */
  readonly http_status?: number;
  /** X API `title`, passed through verbatim. (kind `api` | `billing` | `forbidden`) */
  readonly platform_title?: string;
  /** X API `detail`, passed through verbatim. */
  readonly platform_detail?: string;
}

/** Per-class defaults for `retryable`/`fix`. A factory may override either. */
const DEFAULTS: Readonly<Record<ErrorClass, { retryable: boolean; fix: ErrorFix }>> = {
  auth: { retryable: false, fix: 'operator' },
  scope: { retryable: false, fix: 'operator' },
  forbidden: { retryable: false, fix: 'agent' },
  'rate-limit': { retryable: true, fix: 'agent' },
  budget: { retryable: false, fix: 'operator' },
  billing: { retryable: false, fix: 'operator' },
  policy: { retryable: false, fix: 'operator' },
  validation: { retryable: false, fix: 'agent' },
  'not-found': { retryable: false, fix: 'agent' },
  api: { retryable: false, fix: 'agent' },
  network: { retryable: true, fix: 'agent' },
};

export interface XErrorOptions {
  /** Override the class default. */
  readonly retryable?: boolean;
  /** Override the class default. */
  readonly fix?: ErrorFix;
  /** Structured, class-specific fields. */
  readonly data?: XErrorData;
  /** Underlying cause (network stack, parse error). Never surfaced to the agent. */
  readonly cause?: unknown;
}

/**
 * The single error type the whole server throws and renders. Construct via the
 * factories below (they apply the taxonomy defaults) or `new XError(...)` directly.
 */
export class XError extends Error {
  readonly kind: ErrorClass;
  readonly retryable: boolean;
  readonly fix: ErrorFix;
  readonly data: Readonly<XErrorData>;

  constructor(kind: ErrorClass, message: string, opts: XErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'XError';
    this.kind = kind;
    this.retryable = opts.retryable ?? DEFAULTS[kind].retryable;
    this.fix = opts.fix ?? DEFAULTS[kind].fix;
    this.data = opts.data ?? {};
  }

  /** Type guard — errors cross async/catch boundaries as `unknown`. */
  static is(value: unknown): value is XError {
    return value instanceof XError;
  }

  /**
   * The structured payload the MCP adapter renders into a tool error result.
   * Contains only agent-safe fields — `cause` and stack are never included.
   */
  toPayload(): XErrorPayload {
    return {
      error: {
        kind: this.kind,
        message: this.message,
        retryable: this.retryable,
        fix: this.fix,
        ...this.data,
      },
    };
  }
}

/** The wire shape of a rendered error (mcp/structured turns this into an MCP error result). */
export interface XErrorPayload {
  readonly error: {
    readonly kind: ErrorClass;
    readonly message: string;
    readonly retryable: boolean;
    readonly fix: ErrorFix;
  } & XErrorData;
}

// --- Factories -------------------------------------------------------------------
// One per class. They exist so call sites read as remediation, not construction, and
// so the taxonomy defaults are applied uniformly. `message` is always the caller's
// remediation prose; structured fields go through `data`.
//
// NOTE (POL-7 / SEC-F10): for a `policy` denial on a SENSITIVE cell (dm, destructive:*,
// social-graph), the caller MUST pass a message that does NOT name the unlock env var.
// The taxonomy does not enforce this — the policy layer (T-111) owns the message text.

export const authError = (message: string, opts?: XErrorOptions): XError =>
  new XError('auth', message, opts);

export const scopeError = (message: string, opts?: XErrorOptions): XError =>
  new XError('scope', message, opts);

export const forbiddenError = (message: string, opts?: XErrorOptions): XError =>
  new XError('forbidden', message, opts);

export const rateLimitError = (message: string, opts?: XErrorOptions): XError =>
  new XError('rate-limit', message, opts);

export const budgetError = (message: string, opts?: XErrorOptions): XError =>
  new XError('budget', message, opts);

export const billingError = (message: string, opts?: XErrorOptions): XError =>
  new XError('billing', message, opts);

export const policyError = (message: string, opts?: XErrorOptions): XError =>
  new XError('policy', message, opts);

export const validationError = (message: string, opts?: XErrorOptions): XError =>
  new XError('validation', message, opts);

export const notFoundError = (message: string, opts?: XErrorOptions): XError =>
  new XError('not-found', message, opts);

export const apiError = (message: string, opts?: XErrorOptions): XError =>
  new XError('api', message, opts);

export const networkError = (message: string, opts?: XErrorOptions): XError =>
  new XError('network', message, opts);
