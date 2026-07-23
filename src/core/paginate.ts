// Pagination contract helpers — docs/03 "Pagination" convention, docs/07 PAGE-1…5.
// Owned by T-119. Pure `core`: no I/O, no fetch loops, imports only sibling contracts.
//
// Every list-returning tool calls these three helpers around its SINGLE page request:
//   1. `clampMaxResults` — normalize/validate the agent's `max_results` into the
//      endpoint's [min, max] window, clamping in BOTH directions (PAGE-3).
//   2. `toCursor` / `pageTokenError` — bridge the opaque `page_token` to the v2
//      `next_token` cursor, verbatim (PAGE-1), and surface a bad/expired token as a
//      typed `validation` error, never `api` (PAGE-2).
//   3. `buildPage` — assemble the `Page<T>` envelope from one fetched batch: `items`,
//      `result_count`, pass `next_token` through only when more pages exist (PAGE-4),
//      and attach the zero-results note on an empty batch.
//
// Auto-pagination is a deliberate design refusal (PAGE-5): nothing here loops or issues
// requests. A list tool makes exactly one page request per call; these helpers only shape
// that call's inputs and its response — they cannot fetch a second page even in principle.

import { validationError } from './errors.js';
import type { XError, XErrorOptions } from './errors.js';
import { ZERO_RESULTS_NOTE } from './render-shapes.js';
import type { Page } from './render-shapes.js';

/** Per-endpoint `max_results` window. Bounds are inclusive and come from docs/03 (PAGE-3). */
export interface PageBounds {
  readonly min: number;
  readonly max: number;
}

/**
 * The named `max_results` windows from the tool catalog (docs/03, PAGE-3). A single source
 * so every list tool clamps against the same numbers instead of re-deriving them. Grouped
 * by endpoint family; pass the matching entry to `clampMaxResults`.
 */
export const PAGE_BOUNDS = {
  /** `x_search_recent` — last-7-days search. */
  searchRecent: { min: 10, max: 100 },
  /** `x_search_archive` — full-archive search. */
  searchArchive: { min: 10, max: 500 },
  /** `x_timeline_home` / `_mentions` / `_user`. */
  timeline: { min: 5, max: 100 },
  /** `x_liked_posts_list`. */
  likedPosts: { min: 5, max: 100 },
  /** `x_quote_posts_list`. */
  quotePosts: { min: 10, max: 100 },
  /** `x_liking_users_list`, `x_reposted_by_list`, `x_bookmarks_list`, list members/timeline. */
  engagementList: { min: 1, max: 100 },
  /** `x_followers_list`, `x_following_list`, `x_blocks_list`, `x_mutes_list`. */
  socialGraph: { min: 1, max: 1000 },
  /** `x_user_search`. */
  userSearch: { min: 1, max: 1000 },
  /** `x_dm_events_list` and the other DM-event lookups. */
  dm: { min: 1, max: 100 },
} as const satisfies Record<string, PageBounds>;

/** The result of normalizing an agent-supplied `max_results`. */
export interface MaxResultsResolution {
  /** The API-safe value to send: `requested` clamped into `[bounds.min, bounds.max]`. */
  readonly value: number;
  /** True when `value` differs from `requested` (i.e. the request was out of range). */
  readonly clamped: boolean;
  /** Agent-facing note explaining the adjustment. Present iff `clamped` is true (PAGE-3). */
  readonly note?: string;
}

/**
 * Normalize an agent-supplied `max_results` against an endpoint's bounds (PAGE-3).
 *
 * - Below `min` clamps up, above `max` clamps down — both directions (e.g. search `5` → `10`).
 * - An in-range value passes through untouched, with no note.
 * - Non-integers (`NaN`, `Infinity`, fractionals) are nonsense and raise a typed
 *   `validation` error rather than being silently coerced.
 *
 * Callers pass the value only when the agent supplied one; an omitted `max_results` lets the
 * API default stand and should not be routed through here.
 */
export function clampMaxResults(requested: number, bounds: PageBounds): MaxResultsResolution {
  const { min, max } = bounds;
  if (min > max) {
    // Programmer error in the endpoint's bounds, not an agent input problem.
    throw new Error(`invalid page bounds: min ${min} > max ${max}`);
  }
  if (!Number.isInteger(requested)) {
    throw validationError('max_results must be a whole number.');
  }

  let value = requested;
  if (value < min) value = min;
  else if (value > max) value = max;

  if (value === requested) {
    return { value, clamped: false };
  }
  const note = `max_results adjusted to ${value} (this endpoint accepts ${min}-${max}; requested ${requested}).`;
  return { value, clamped: true, note };
}

/**
 * Bridge an incoming, opaque `page_token` to the v2 `next_token` request cursor (PAGE-1).
 * The token round-trips verbatim — it is never parsed, trimmed, or re-encoded — so a
 * `next_token` handed back as `page_token` reproduces the exact cursor. A missing or
 * blank token means "start from the first page" and yields `undefined` (no cursor sent).
 */
export function toCursor(pageToken?: string): string | undefined {
  if (pageToken === undefined) return undefined;
  return pageToken.trim().length === 0 ? undefined : pageToken;
}

/** Canonical message for a rejected pagination token (PAGE-2) — single source for the mapper. */
export const PAGE_TOKEN_INVALID_MESSAGE =
  'pagination token invalid or expired — restart from the first page';

/**
 * The typed error for a bad/expired pagination token (PAGE-2). The API's rejection of a
 * stale cursor maps here to a `validation` error (agent-fixable), never an opaque `api`
 * error. Callers may forward `opts` (e.g. `data.http_status`) from the mapping site.
 */
export function pageTokenError(opts?: XErrorOptions): XError {
  return validationError(PAGE_TOKEN_INVALID_MESSAGE, opts);
}

/**
 * Build the `Page<T>` envelope from ONE fetched batch (PAGE-4/PAGE-1, REND-5).
 *
 * - `result_count` is always this page's item count, so the model can reason about paging.
 * - `next_token` is passed through verbatim, and only when the API returned a non-empty
 *   cursor — the last page omits it entirely (never `null`).
 * - An empty batch carries the explicit zero-results note so an agent never reads "zero"
 *   as an error. An optional `extraNote` (e.g. the `clampMaxResults` adjustment note) is
 *   appended; on an empty page both notes are surfaced together.
 */
export function buildPage<T>(items: readonly T[], nextToken?: string, extraNote?: string): Page<T> {
  const next = typeof nextToken === 'string' && nextToken.length > 0 ? nextToken : undefined;

  const notes: string[] = [];
  if (items.length === 0) notes.push(ZERO_RESULTS_NOTE);
  if (extraNote !== undefined && extraNote.length > 0) notes.push(extraNote);
  const note = notes.length > 0 ? notes.join(' ') : undefined;

  return {
    items,
    result_count: items.length,
    ...(next !== undefined ? { next_token: next } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}
