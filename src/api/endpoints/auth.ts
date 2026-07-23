// Endpoint wrappers for the auth/session tools (T-120). Only one real network call lives
// here: `getMe`, the optional `me`-enrichment for `x_auth_status`. It is invoked ONLY in
// user-context mode and best-effort — a status read must never hard-fail on it (AUTH-15).
//
// Pure endpoint layer: it builds a typed `XApiRequest` and forwards it through the injected
// `EndpointInvoker`; host-scoped auth, rate-limit accounting, the GET retry, and error
// mapping all live below in api/http (T-114). Nothing here reads config, the clock, or the
// network directly.

import type { EndpointInvoker, XApiRequest } from '../../core/tooldef.js';
import type { RawSingleResponse, RawUser } from '../../core/render.js';

/**
 * `GET /2/users/me` — the authenticated user's own profile. Requests only the fields
 * `x_auth_status` needs (`username`, `name`); `id` is always returned. Requires the
 * `users.read` scope and a user-context token, so callers MUST gate it on user-mode auth
 * (app-only bearer tokens have no `me`).
 */
export async function getMe(http: EndpointInvoker): Promise<RawSingleResponse<RawUser>> {
  const req: XApiRequest = {
    method: 'GET',
    path: '/2/users/me',
    query: { 'user.fields': 'username,name' },
    scopes: ['users.read'],
  };
  return http.send<RawSingleResponse<RawUser>>(req);
}
