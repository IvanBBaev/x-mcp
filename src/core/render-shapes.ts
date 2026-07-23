// Compact render shapes — FROZEN CONTRACT (docs/02 §5.2). Owned by T-102; produced by
// the compactors (core/render, T-117) and consumed by every read tool. These are the
// AGENT-FACING shapes: small, stable, and free of the API's envelope noise. The `raw:
// true` flag on read tools bypasses compaction entirely (REND-9, size-capped).
//
// Design rules baked in here:
//   • Author is always `@handle` form, never a bare numeric id (REND-1).
//   • Optional fields are OMITTED when absent, never null (exactOptionalPropertyTypes).
//   • Long posts carry the full text via `note_tweet`; `truncated` marks API clipping
//     (REND-3/4). `url` is the canonical status permalink (REND-2).
//   • List envelopes always carry `result_count`; empty results carry an explicit note
//     so an agent never mistakes "zero" for "error" (REND-5/10).
//
// Untrusted content (post/user/DM text) is passed through the sanitizer (core/sanitize,
// T-118) BEFORE landing in these fields — the shapes hold already-safe strings.

/** Public engagement counts on a post. Fields are omitted when the API withholds them. */
export interface PostMetrics {
  readonly replies?: number;
  readonly reposts?: number;
  readonly likes?: number;
  readonly quotes?: number;
  readonly bookmarks?: number;
  readonly impressions?: number;
}

/** A post author, resolved to handle form. `id` is the numeric user id for follow-ups. */
export interface Author {
  readonly id: string;
  /** `@handle`, sanitized. */
  readonly handle: string;
  readonly name?: string;
  readonly verified?: boolean;
}

/** A referenced post (reply parent / quoted post), shallow to avoid unbounded nesting. */
export interface PostRef {
  readonly id: string;
  readonly author?: string;
}

/** An attached media item, compacted (REND-6). */
export interface CompactMedia {
  readonly type: 'photo' | 'video' | 'animated_gif';
  readonly url?: string;
  readonly alt_text?: string;
}

/**
 * The compact post — the workhorse read shape (docs/02 §5.2). `text` is the display
 * text; when the post exceeds the classic limit, `note_tweet` holds the full body and
 * `truncated` is true.
 */
export interface CompactPost {
  readonly id: string;
  /** `@handle` of the author (REND-1). */
  readonly author: string;
  readonly text: string;
  /** ISO-8601 creation time. */
  readonly created_at?: string;
  readonly metrics?: PostMetrics;
  /** Present when this post replies to another. */
  readonly reply_to?: PostRef;
  /** Present when this post quotes another. */
  readonly quoted?: PostRef;
  readonly media?: readonly CompactMedia[];
  /** Canonical status permalink (REND-2). */
  readonly url?: string;
  /** Full body when the post is a long-form note (REND-3). */
  readonly note_tweet?: string;
  /** True when the API clipped `text` (REND-4). */
  readonly truncated?: boolean;
}

/** Public metrics on a user profile. Omitted fields mean the API withheld them. */
export interface UserMetrics {
  readonly followers?: number;
  readonly following?: number;
  readonly posts?: number;
  readonly listed?: number;
}

/** The compact user profile. */
export interface CompactUser {
  readonly id: string;
  /** `@handle`, sanitized. */
  readonly handle: string;
  readonly name?: string;
  readonly description?: string;
  readonly verified?: boolean;
  readonly protected?: boolean;
  readonly created_at?: string;
  readonly location?: string;
  readonly url?: string;
  readonly metrics?: UserMetrics;
}

/** The compact direct-message event. */
export interface CompactDm {
  readonly id: string;
  /** `@handle` of the sender. */
  readonly sender: string;
  readonly text: string;
  readonly created_at?: string;
  /** Conversation (DM thread) id. */
  readonly conversation_id?: string;
  readonly media?: readonly CompactMedia[];
}

/** The compact list. */
export interface CompactList {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly private?: boolean;
  readonly member_count?: number;
  readonly follower_count?: number;
  readonly owner?: string;
}

/**
 * A paginated envelope for any list-returning tool (docs/02 §5.2, REND-10). `next_token`
 * is present only when more results exist; `result_count` is always the number of items
 * in THIS page. `note` carries the explicit zero-results message (REND-5) or other
 * agent-facing hints (e.g. "results truncated to endpoint max").
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly result_count: number;
  readonly next_token?: string;
  readonly note?: string;
}

/** Standard zero-results note text (REND-5) — single source so every tool reads alike. */
export const ZERO_RESULTS_NOTE = 'No results matched this query.';

/**
 * Why a requested item is absent from a partial batch result (REND-7). Drawn from a fixed,
 * agent-safe vocabulary derived only from the API's structural `title`/`type`/`detail` — no
 * third-party prose is ever echoed. `not-found` is the safe default when the platform reports
 * a resource-not-found (a deleted or never-existed id); `unavailable` is the last-resort
 * fallback when the signal is unrecognized. This is the single canonical union shared by the
 * error mapper (api/errors, T-116) and the batch renderers (core/render, T-117).
 */
export type MissingReason =
  'not-found' | 'deleted' | 'suspended' | 'protected' | 'unauthorized' | 'unavailable';

/**
 * One absent item in a partial batch result (REND-2). Carries only safe scalars — the item
 * identifier and a classified reason — so no third-party content can leak (REND-7). X's raw
 * `detail` prose is deliberately NOT surfaced here.
 */
export interface Missing {
  /** The requested identifier X reported as failing (`resource_id`, else `value`). */
  readonly id: string;
  /** Classified reason the item is absent. */
  readonly reason: MissingReason;
  /** The resource kind X named (`tweet`, `user`, …), when present. */
  readonly resource_type?: string;
}

/**
 * Result of a batch lookup (post_get / user_get with N ids): the items that resolved, plus
 * any that did not. `Page<T>` has no `missing` field, so batch endpoints return this instead
 * (REND-2).
 */
export interface BatchResult<T> {
  readonly items: readonly T[];
  readonly missing?: readonly Missing[];
}
