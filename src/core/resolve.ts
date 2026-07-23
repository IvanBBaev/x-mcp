// Identifier resolution — REND-8 (docs/02 §5.1, docs/03 "Identifier resolution",
// docs/07 REND-8). Owned by T-118; consumed by the read/write packages (T-121 posts,
// T-122 users, …). Pure `core`: this module does NO I/O — it PARSES a user-supplied
// argument into a canonical token, holds a per-session id↔handle CACHE, and ORCHESTRATES
// resolution. The one genuinely networked step — turning a bare handle into a numeric id
// via `GET /2/users/by/username/:username` — is delegated to an injected async lookup so
// the endpoint (and its auth/rate-limit/error mapping) stays in the `api` layer.
//
// REND-8 in one line: every user argument accepts a numeric id, a `handle`, or a
// `@handle` (resolved once and cached per process); every post argument accepts a bare id
// or a full `x.com`/`twitter.com` status URL; malformed input is a `validation` error and
// a syntactically-valid handle that does not exist is a `not-found` error naming the form.

import { URL } from 'node:url';

import { notFoundError, validationError } from './errors.js';

// --- Syntax ----------------------------------------------------------------------

/** X handle: 1–15 chars of `[A-Za-z0-9_]`. Handles are case-insensitive. */
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
/** A snowflake id is a run of decimal digits (up to 19 for int64, allow 20 for slack). */
const NUMERIC_ID_RE = /^\d{1,20}$/;
/** Protocol-less inputs we still treat as X URLs, e.g. `x.com/user/status/1`. */
const BARE_X_HOST_RE = /^(www\.|mobile\.|m\.)?(x|twitter)\.com\//i;

/**
 * Single path segments that are X app routes, never usernames — so `x.com/home` is not
 * mistaken for the profile of a user called "home". Compared lower-cased.
 */
const RESERVED_PATH_SEGMENTS = new Set<string>([
  'home',
  'explore',
  'notifications',
  'messages',
  'search',
  'settings',
  'i',
  'intent',
  'hashtag',
  'compose',
  'login',
  'logout',
  'signup',
  'tos',
  'privacy',
]);

// --- Public types ----------------------------------------------------------------

/**
 * The classification of a raw user-reference argument (the pure, sync half of REND-8).
 * `handle` is always WITHOUT the leading `@`. `me` is the self-reference sentinel — the
 * bare word `me`; the explicit `@me` form is a normal handle, never the sentinel, so a
 * real `@me` account stays reachable.
 */
export type UserRef =
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'handle'; readonly handle: string }
  | { readonly kind: 'me' };

/** A user's canonical identity, as produced by the injected handle lookup. */
export interface UserIdentity {
  readonly id: string;
  /** `@`-less handle in its display casing. */
  readonly handle: string;
}

/**
 * The injected network step: resolve a `@`-less handle to its identity, or `null` when no
 * such user exists (which the orchestrator turns into a `not-found`). Any other failure —
 * auth, rate-limit, network — should be THROWN (as an `XError`) and propagates unchanged.
 * Implemented by the users package (T-122) over `GET /2/users/by/username/:username`.
 */
export type HandleLookup = (handle: string) => Promise<UserIdentity | null>;

/**
 * A per-session bidirectional id↔handle cache (REND-8). Handles are matched
 * case-insensitively; the stored handle keeps its display casing. Intentionally
 * unbounded — a session touches few distinct users; the composition root owns its
 * lifetime.
 */
export interface ResolveCache {
  /** Numeric id for a handle (case-insensitive, `@` optional), or `undefined` on a miss. */
  getIdByHandle(handle: string): string | undefined;
  /** Display-cased handle for a numeric id, or `undefined` on a miss. */
  getHandleById(id: string): string | undefined;
  /** Record an id↔handle pair (both directions). */
  set(identity: UserIdentity): void;
  /** Drop every entry. */
  clear(): void;
  /** Number of distinct identities cached. */
  readonly size: number;
}

/** Options for {@link resolveUserId}. */
export interface ResolveUserOptions {
  /** The handle→identity network step (see {@link HandleLookup}). */
  readonly lookup: HandleLookup;
  /** Optional per-session cache; when present, resolved handles skip re-lookup. */
  readonly cache?: ResolveCache;
  /**
   * The authenticated user's numeric id, enabling the `"me"` self-reference. Omit it and a
   * `"me"` argument is a `validation` error — `me` is not a username and must never be sent
   * to the handle lookup (a real `@me` account exists).
   */
  readonly me?: string;
}

// --- Classification (pure, sync) -------------------------------------------------

/**
 * Classify a raw user argument into an id, a handle, or the `me` sentinel. Throws a
 * `validation` XError when the input is not a recognizable id / `@handle` / handle /
 * profile-URL form. This does NOT hit the network — a handle is returned as `kind:
 * 'handle'` for {@link resolveUserId} to resolve.
 */
export function classifyUserRef(input: string): UserRef {
  const value = input.trim();
  if (value === '') throw validationError('Empty user reference.');

  const url = tryParseXUrl(value);
  if (url) return userRefFromUrl(url, value);

  if (value.startsWith('@')) {
    const handle = value.slice(1);
    if (!HANDLE_RE.test(handle)) {
      throw validationError(`Malformed handle: "${preview(value)}".`);
    }
    return { kind: 'handle', handle };
  }

  // Bare `me` is the self sentinel; `@me` above is an explicit handle.
  if (value.toLowerCase() === 'me') return { kind: 'me' };

  // An all-digits token is a canonical id; force handle interpretation with `@12345`.
  if (NUMERIC_ID_RE.test(value)) return { kind: 'id', id: value };

  if (HANDLE_RE.test(value)) return { kind: 'handle', handle: value };

  throw validationError(
    `Not a recognized X user id, @handle, or profile URL: "${preview(value)}".`,
  );
}

/**
 * Extract the canonical numeric post id from a bare id or a full status URL
 * (`https://x.com/user/status/123`, `twitter.com/user/status/123?s=20`,
 * `x.com/i/web/status/123`). Throws a `validation` XError for handles, profile URLs, and
 * anything without a numeric status id.
 */
export function parsePostId(input: string): string {
  const value = input.trim();
  if (value === '') throw validationError('Empty post reference.');

  const url = tryParseXUrl(value);
  if (url) return postIdFromUrl(url, value);

  if (NUMERIC_ID_RE.test(value)) return value;

  if (value.startsWith('@') || HANDLE_RE.test(value)) {
    throw validationError(
      `A post reference must be a numeric id or a status URL, not a handle: "${preview(value)}".`,
    );
  }

  throw validationError(`Not a recognized X post id or status URL: "${preview(value)}".`);
}

// --- Cache -----------------------------------------------------------------------

/** Build an empty {@link ResolveCache}. */
export function createResolveCache(): ResolveCache {
  const handleToId = new Map<string, string>();
  const idToHandle = new Map<string, string>();

  return {
    getIdByHandle: (handle) => handleToId.get(normalizeHandle(handle)),
    getHandleById: (id) => idToHandle.get(id),
    set: ({ id, handle }) => {
      handleToId.set(normalizeHandle(handle), id);
      idToHandle.set(id, handle);
    },
    clear: () => {
      handleToId.clear();
      idToHandle.clear();
    },
    get size() {
      return handleToId.size;
    },
  };
}

// --- Orchestration ---------------------------------------------------------------

/**
 * Resolve any user argument to its canonical numeric id (REND-8). An id passes through
 * untouched; a handle is served from the cache when present and otherwise resolved via the
 * injected {@link HandleLookup} (whose result is cached both ways); `"me"` resolves to
 * `opts.me` when supplied. A syntactically-valid handle with no matching user becomes a
 * `not-found` error naming the tried form; malformed input becomes a `validation` error
 * BEFORE any lookup runs.
 */
export async function resolveUserId(input: string, opts: ResolveUserOptions): Promise<string> {
  const ref = classifyUserRef(input);

  if (ref.kind === 'id') return ref.id;

  if (ref.kind === 'me') {
    if (opts.me !== undefined) return opts.me;
    throw validationError(
      '"me" refers to the authenticated user and cannot be resolved by username; ' +
        'resolve the self id first and pass it via `me`.',
    );
  }

  // ref.kind === 'handle'
  const cached = opts.cache?.getIdByHandle(ref.handle);
  if (cached !== undefined) return cached;

  const identity = await opts.lookup(ref.handle);
  if (identity === null) {
    throw notFoundError(`No X user found for handle "@${ref.handle}".`);
  }

  opts.cache?.set(identity);
  return identity.id;
}

// --- Internals -------------------------------------------------------------------

/** Parse `raw` as an X URL (with or without protocol), or return `null` if it is not one. */
function tryParseXUrl(raw: string): URL | null {
  let candidate = raw;
  if (!/^https?:\/\//i.test(candidate)) {
    if (!BARE_X_HOST_RE.test(candidate)) return null;
    candidate = `https://${candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^(www\.|mobile\.|m\.)/, '');
  if (host !== 'x.com' && host !== 'twitter.com') return null;
  return url;
}

/** A profile URL → its handle; a status URL or unknown route → a `validation` error. */
function userRefFromUrl(url: URL, original: string): UserRef {
  const segments = pathSegments(url);
  if (segments.some(isStatusSegment)) {
    throw validationError(
      `That looks like a post URL, not a user reference: "${preview(original)}".`,
    );
  }

  const first = segments[0];
  if (
    first !== undefined &&
    !RESERVED_PATH_SEGMENTS.has(first.toLowerCase()) &&
    HANDLE_RE.test(first)
  ) {
    return { kind: 'handle', handle: first };
  }

  throw validationError(`Unrecognized X profile URL: "${preview(original)}".`);
}

/** A status URL → its numeric post id; anything else → a `validation` error. */
function postIdFromUrl(url: URL, original: string): string {
  const segments = pathSegments(url);
  const idx = segments.findIndex(isStatusSegment);
  if (idx < 0) {
    throw validationError(`Not a status URL (no /status/ segment): "${preview(original)}".`);
  }

  const candidate = segments[idx + 1];
  if (candidate !== undefined && NUMERIC_ID_RE.test(candidate)) return candidate;
  throw validationError(`Status URL has no numeric post id: "${preview(original)}".`);
}

function pathSegments(url: URL): readonly string[] {
  return url.pathname.split('/').filter((segment) => segment.length > 0);
}

function isStatusSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return lower === 'status' || lower === 'statuses';
}

function normalizeHandle(handle: string): string {
  return handle.replace(/^@/, '').toLowerCase();
}

/** Echo the agent-supplied identifier in an error, trimmed and length-capped. */
function preview(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}
