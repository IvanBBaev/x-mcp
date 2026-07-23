// Typed X API v2 user-endpoint wrappers (docs/03 `x_user_get`). Owned by T-122. Each
// function maps to exactly one v2 endpoint and asks for the full `user.fields` projection
// the compactors read; the handle→id step is exposed as the injected `HandleLookup` the
// resolver (core/resolve, REND-8) depends on. No merging or compaction happens here — that
// is the tool handler's job (src/tools/users.ts). Auth, rate-limit accounting, and error
// mapping all live in the injected `EndpointInvoker` (api/http).

import { XError } from '../../core/errors.js';
import type { EndpointInvoker, OAuthScope } from '../../core/tooldef.js';
import type { RawListResponse, RawSingleResponse, RawUser } from '../../core/render.js';
import type { HandleLookup, UserIdentity } from '../../core/resolve.js';

/**
 * The `user.fields` projection every user read requests (docs/03: handle, name, bio,
 * metrics, created_at, …). Kept identical across the three endpoints so a user resolved by
 * id, handle, or `me` compacts to the same shape.
 */
const USER_FIELDS =
  'created_at,description,location,public_metrics,protected,url,verified,username,name';

/** Every user read requires the `users.read` OAuth scope. */
const USERS_READ_SCOPES: readonly OAuthScope[] = ['users.read'];

/** `GET /2/users?ids=...` — batch lookup by numeric id. */
export async function getUsersByIds(
  http: EndpointInvoker,
  ids: readonly string[],
): Promise<RawListResponse<RawUser>> {
  return http.send<RawListResponse<RawUser>>({
    method: 'GET',
    path: '/2/users',
    query: { ids: ids.join(','), 'user.fields': USER_FIELDS },
    scopes: USERS_READ_SCOPES,
  });
}

/** `GET /2/users/by?usernames=...` — batch lookup by handle. */
export async function getUsersByUsernames(
  http: EndpointInvoker,
  handles: readonly string[],
): Promise<RawListResponse<RawUser>> {
  return http.send<RawListResponse<RawUser>>({
    method: 'GET',
    path: '/2/users/by',
    query: { usernames: handles.join(','), 'user.fields': USER_FIELDS },
    scopes: USERS_READ_SCOPES,
  });
}

/**
 * `GET /2/users/me` — the authenticated user. Requires user-context auth; under an app-only
 * bearer X returns 401, which the http/error layer maps to an `auth` XError — callers let it
 * propagate rather than swallow it.
 */
export async function getMe(http: EndpointInvoker): Promise<RawSingleResponse<RawUser>> {
  return http.send<RawSingleResponse<RawUser>>({
    method: 'GET',
    path: '/2/users/me',
    query: { 'user.fields': USER_FIELDS },
    scopes: USERS_READ_SCOPES,
  });
}

/**
 * Build the injected {@link HandleLookup} the resolver uses to turn a bare handle into an
 * identity via `GET /2/users/by/username/:username`. Returns `null` for a not-found user —
 * whether X reports it as an HTTP-200 body with an `errors[]` array and no `data`, or as a
 * 404 (mapped to a `not-found` XError) — and rethrows any other failure (auth, scope,
 * rate-limit, network) unchanged, per the `HandleLookup` contract.
 */
export function createHandleLookup(http: EndpointInvoker): HandleLookup {
  return async (handle: string): Promise<UserIdentity | null> => {
    const username = handle.replace(/^@+/, '');
    let res: RawSingleResponse<RawUser>;
    try {
      res = await http.send<RawSingleResponse<RawUser>>({
        method: 'GET',
        path: `/2/users/by/username/${encodeURIComponent(username)}`,
        query: { 'user.fields': USER_FIELDS },
        scopes: USERS_READ_SCOPES,
      });
    } catch (err) {
      // A 404 means no such user — the resolver wants `null`, not a thrown error.
      if (XError.is(err) && err.kind === 'not-found') return null;
      throw err;
    }
    const user = res.data;
    if (user === undefined || user.id === undefined || user.username === undefined) return null;
    return { id: user.id, handle: user.username };
  };
}
