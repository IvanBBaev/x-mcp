// Header-driven rate-limit tracker + preflight (docs/02 §6 pipeline / §7; docs/01 §4).
// Owned by T-115 (WP-1.4). Consumed by the request pipeline (core/registry, T-113) as the
// pre-flight choke point, by api/http (T-114) after every response to update the table, and
// by the `x_rate_limit_status` tool (T-120) to dump the table.
//
// What it does (cases RATE-1…7, CONC-3):
//   • Parses `x-rate-limit-{limit,remaining,reset}` (and the `x-app-limit-24hour-*` 24-hour
//     app window) from a response and stores them per bucket key — one bucket per
//     (endpoint-class × auth-context), so app-only and user-context windows never collide
//     (RATE-1). Keys are opaque strings; compose them with `rateLimitKey(...)`.
//   • `preflight(key)` returns a typed `rate-limit` XError when a tracked window is exhausted
//     (`remaining === 0`) and its reset is still in the future — so the call is refused
//     LOCALLY, no HTTP request is made (RATE-2). A past-or-imminent reset (within a 5 s skew
//     allowance) proceeds instead (RATE-3).
//   • A response with no rate-limit headers leaves tracked state untouched (RATE-4).
//   • Dual windows (15-min user + 24-h app) are both tracked; refusal names WHICH window
//     blocked (RATE-6).
//   • `retry-after` vs `x-rate-limit-reset` disagreement resolves to the LATER time (RATE-7).
//   • Out-of-order responses for the same window merge last-reset-wins, so older data never
//     overwrites newer (CONC-3). `record` is fully synchronous, so a single update is atomic
//     with respect to the event loop — updates cannot interleave mid-write.
//
// The RATE-5 GET-retry-once-within-5-s orchestration (method-aware; writes never retry) lives
// in api/http (T-114); this module only supplies the reset delay it needs via `retryDelayMs`.
//
// Pure in-process state. Time comes ONLY from the injected `Clock` — never `Date.now()`.

import type { Clock } from '../core/ports.js';
import { rateLimitError, type XError } from '../core/errors.js';

/** Skew allowance for reset comparisons: a window is treated as renewed once `reset − 5 s`
 * has passed (RATE-3), absorbing small clock disagreement with X. */
const SKEW_MS = 5_000;

// The X rate-limit header families. The standard 15-minute window is always present; write
// endpoints such as `POST /2/tweets` additionally carry the 24-hour app window (RATE-6).
const H_LIMIT = 'x-rate-limit-limit';
const H_REMAINING = 'x-rate-limit-remaining';
const H_RESET = 'x-rate-limit-reset';
const H_APP_LIMIT = 'x-app-limit-24hour-limit';
const H_APP_REMAINING = 'x-app-limit-24hour-remaining';
const H_APP_RESET = 'x-app-limit-24hour-reset';
const H_RETRY_AFTER = 'retry-after';

/** OAuth context a bucket is tracked under. The same endpoint has independent limits per
 * context (RATE-1). */
export type AuthContext = 'app' | 'user';

/** Which rate-limit window a tracked entry came from. `standard` is the 15-minute per-user
 * window (`x-rate-limit-*`); `app-24h` is the 24-hour app cap (`x-app-limit-24hour-*`). */
export type WindowKind = 'standard' | 'app-24h';

/**
 * A header source. Accepts either a WHATWG `Headers`-like object (a real `Response.headers`)
 * or a plain, case-insensitive record. Lookups are always case-insensitive.
 */
export type HeaderLookup =
  { get(name: string): string | null } | Record<string, string | number | undefined>;

/** A single window's status, in the renderable shape `x_rate_limit_status` (T-120) surfaces. */
export interface RateLimitWindowStatus {
  readonly kind: WindowKind;
  /** The window ceiling, when the header reported it. */
  readonly limit?: number;
  readonly remaining: number;
  /** Reset instant, ISO-8601. */
  readonly reset_at: string;
  /** Seconds from now (per the injected Clock) until the window resets; never negative. */
  readonly seconds_until_reset: number;
  /** True when the window would refuse a call right now (skew-adjusted). */
  readonly exhausted: boolean;
}

/** One bucket (endpoint-class × auth-context) and every window tracked for it. */
export interface RateLimitBucketStatus {
  readonly key: string;
  readonly windows: readonly RateLimitWindowStatus[];
}

/** The whole tracked table, for the `x_rate_limit_status` tool. */
export interface RateLimitStatus {
  readonly buckets: readonly RateLimitBucketStatus[];
}

/**
 * The in-process rate-limit tracker. One instance lives for the process (built at the
 * composition root, T-130); handlers share it through the request pipeline.
 */
export interface RateLimitTracker {
  /**
   * Fold a response's rate-limit headers into the table for `key`. `status` (the HTTP status
   * code) is optional; when it is 429 the standard window is forced to `remaining === 0` and,
   * if only `retry-after` is present, a window is synthesized so the next preflight refuses
   * (RATE-5). No headers → no change (RATE-4).
   */
  record(key: string, headers: HeaderLookup, status?: number): void;
  /**
   * Preflight the bucket. Returns a typed `rate-limit` XError (carrying `reset_at` and
   * `retry_after_seconds`) when a tracked window is exhausted and its reset is still in the
   * future (RATE-2); `null` when the call may proceed (RATE-3). Never performs I/O.
   */
  preflight(key: string): XError | null;
  /**
   * Milliseconds until the standard (15-minute) window for `key` resets, or `null` when no
   * standard window is tracked. api/http (T-114) reads this after a 429 to decide the single
   * GET retry (only when the delay is ≤ 5 s; writes never retry — RATE-5).
   */
  retryDelayMs(key: string): number | null;
  /** Snapshot of the whole table for the `x_rate_limit_status` tool (T-120). */
  status(): RateLimitStatus;
}

/**
 * Compose a bucket key from an endpoint class and auth context (RATE-1). The tracker treats
 * keys as opaque, but every caller should build them the same way so buckets line up.
 */
export function rateLimitKey(endpointClass: string, authContext: AuthContext): string {
  return `${endpointClass}#${authContext}`;
}

interface Window {
  readonly limit?: number;
  readonly remaining: number;
  /** Reset instant in epoch MILLISECONDS (X reports epoch seconds; we scale on parse). */
  readonly resetAtMs: number;
}

interface Bucket {
  standard?: Window;
  app24h?: Window;
}

/** Build a window, omitting `limit` when unknown (exactOptionalPropertyTypes). */
function makeWindow(remaining: number, resetAtMs: number, limit?: number): Window {
  return limit === undefined ? { remaining, resetAtMs } : { remaining, resetAtMs, limit };
}

/** Normalize either header shape into a single case-insensitive accessor. */
function toLookup(source: HeaderLookup): (name: string) => string | null {
  if (typeof (source as { get?: unknown }).get === 'function') {
    const headers = source as { get(name: string): string | null };
    return (name) => headers.get(name);
  }
  const record = source as Record<string, string | number | undefined>;
  const map = new Map<string, string>();
  for (const [rawKey, value] of Object.entries(record)) {
    if (value !== undefined) map.set(rawKey.toLowerCase(), String(value));
  }
  return (name) => map.get(name.toLowerCase()) ?? null;
}

/** Parse a non-negative integer header, or `null` when absent/malformed. */
function readInt(get: (name: string) => string | null, name: string): number | null {
  const raw = get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Parse one window from a header triple; `null` unless both remaining and reset are present. */
function parseWindow(
  get: (name: string) => string | null,
  limitH: string,
  remainingH: string,
  resetH: string,
): Window | null {
  const remaining = readInt(get, remainingH);
  const resetSec = readInt(get, resetH);
  if (remaining === null || resetSec === null) return null;
  const limit = readInt(get, limitH);
  return makeWindow(remaining, resetSec * 1000, limit ?? undefined);
}

/**
 * Merge an incoming window into the stored one, last-reset-wins (CONC-3): a later reset is a
 * newer window and replaces; an earlier reset is stale and is ignored; an equal reset is the
 * same window seen again, so the LOWER remaining (more consumption observed) is kept, guarding
 * against a stale higher-remaining response overwriting a fresher one.
 */
function mergeWindow(stored: Window | undefined, incoming: Window): Window {
  if (stored === undefined) return incoming;
  if (incoming.resetAtMs > stored.resetAtMs) return incoming;
  if (incoming.resetAtMs < stored.resetAtMs) return stored;
  return makeWindow(
    Math.min(incoming.remaining, stored.remaining),
    stored.resetAtMs,
    incoming.limit ?? stored.limit,
  );
}

/** A window blocks now iff it is drained AND its reset is still in the future beyond skew. */
function isExhausted(window: Window, now: number): boolean {
  return window.remaining === 0 && now < window.resetAtMs - SKEW_MS;
}

/** Remediation prose for a blocked call, naming which window is exhausted (RATE-6). */
function blockedMessage(kind: WindowKind): string {
  const which = kind === 'app-24h' ? '24-hour app' : '15-minute';
  return (
    `Rate limit reached for the ${which} window; no request was made. ` +
    'Wait until the window resets, then retry.'
  );
}

export function createRateLimitTracker(clock: Clock): RateLimitTracker {
  const buckets = new Map<string, Bucket>();

  const record: RateLimitTracker['record'] = (key, headers, status) => {
    const get = toLookup(headers);
    const now = clock.now();

    let standard = parseWindow(get, H_LIMIT, H_REMAINING, H_RESET);
    const retryAfterSec = readInt(get, H_RETRY_AFTER);
    const retryResetMs = retryAfterSec === null ? null : now + retryAfterSec * 1000;

    if (status === 429) {
      // A 429 means the standard window is actually drained right now, regardless of what the
      // (possibly stale) `remaining` header says. Force it to 0, and if only `retry-after` is
      // present synthesize the window so the next preflight refuses (RATE-5).
      if (standard !== null) {
        const reset =
          retryResetMs === null ? standard.resetAtMs : Math.max(standard.resetAtMs, retryResetMs);
        standard = makeWindow(0, reset, standard.limit);
      } else if (retryResetMs !== null) {
        standard = makeWindow(0, retryResetMs);
      }
    } else if (standard !== null && retryResetMs !== null) {
      // Both signals present and possibly disagreeing → the later reset wins (RATE-7).
      standard = makeWindow(
        standard.remaining,
        Math.max(standard.resetAtMs, retryResetMs),
        standard.limit,
      );
    }

    const app24h = parseWindow(get, H_APP_LIMIT, H_APP_REMAINING, H_APP_RESET);

    // No usable headers at all → leave the table untouched, do not create an empty bucket (RATE-4).
    if (standard === null && app24h === null) return;

    const bucket = buckets.get(key) ?? {};
    if (standard !== null) bucket.standard = mergeWindow(bucket.standard, standard);
    if (app24h !== null) bucket.app24h = mergeWindow(bucket.app24h, app24h);
    buckets.set(key, bucket);
  };

  const preflight: RateLimitTracker['preflight'] = (key) => {
    const bucket = buckets.get(key);
    if (bucket === undefined) return null;
    const now = clock.now();

    // Consider every exhausted window; block on the one that resets LATEST (the agent must
    // wait the longest), and name it (RATE-6).
    let blocking: { kind: WindowKind; window: Window } | null = null;
    for (const candidate of [
      { kind: 'standard' as const, window: bucket.standard },
      { kind: 'app-24h' as const, window: bucket.app24h },
    ]) {
      const window = candidate.window;
      if (window === undefined || !isExhausted(window, now)) continue;
      if (blocking === null || window.resetAtMs > blocking.window.resetAtMs) {
        blocking = { kind: candidate.kind, window };
      }
    }
    if (blocking === null) return null;

    const resetAtMs = blocking.window.resetAtMs;
    return rateLimitError(blockedMessage(blocking.kind), {
      data: {
        reset_at: new Date(resetAtMs).toISOString(),
        retry_after_seconds: Math.max(0, Math.ceil((resetAtMs - now) / 1000)),
      },
    });
  };

  const retryDelayMs: RateLimitTracker['retryDelayMs'] = (key) => {
    const standard = buckets.get(key)?.standard;
    if (standard === undefined) return null;
    return Math.max(0, standard.resetAtMs - clock.now());
  };

  const status: RateLimitTracker['status'] = () => {
    const now = clock.now();
    const toStatus = (kind: WindowKind, window: Window): RateLimitWindowStatus => {
      const base = {
        kind,
        remaining: window.remaining,
        reset_at: new Date(window.resetAtMs).toISOString(),
        seconds_until_reset: Math.max(0, Math.ceil((window.resetAtMs - now) / 1000)),
        exhausted: isExhausted(window, now),
      };
      return window.limit === undefined ? base : { ...base, limit: window.limit };
    };

    const bucketList: RateLimitBucketStatus[] = [];
    for (const [key, bucket] of buckets) {
      const windows: RateLimitWindowStatus[] = [];
      if (bucket.standard !== undefined) windows.push(toStatus('standard', bucket.standard));
      if (bucket.app24h !== undefined) windows.push(toStatus('app-24h', bucket.app24h));
      bucketList.push({ key, windows });
    }
    return { buckets: bucketList };
  };

  return { record, preflight, retryDelayMs, status };
}
