// Typed endpoint wrappers for the X API v2 social-graph family (docs/03 graph package:
// `x_follow_set`, `x_mute_set`, `x_block_set`, `x_followers_list`, `x_following_list`,
// plus `x_user_search` from the users section). Owned by the T-301 graph slice.
//
// Each wrapper maps typed args to a single `XApiRequest` and returns the raw response
// envelope for the tool layer to compact. Nothing here owns transport, auth, retries, or
// error mapping — that is the injected `EndpointInvoker` (api/http, T-114). Optional query
// keys are OMITTED when their value is undefined (exactOptionalPropertyTypes-safe).
//
// Wire notes:
//   • The write routes are addressed by the ACTING user's id (`/2/users/:id/...`), which
//     the tool layer resolves via `GET /2/users/me` — see src/tools/graph.ts.
//   • Followers/following paginate with the `pagination_token` REQUEST parameter (like
//     timelines); `GET /2/users/search` uses `next_token` instead (like tweet search).
//     Both respond with a `meta.next_token` cursor — PAGE-1 bridges the names.

import type { RawListResponse, RawSingleResponse, RawUser } from '../../core/render.js';
import type { EndpointInvoker, OAuthScope, XApiRequest } from '../../core/tooldef.js';

/**
 * The `user.fields` projection every graph read requests — identical to the one in
 * api/endpoints/users.ts so a follower page compacts to the same `CompactUser` shape as a
 * direct user lookup.
 */
const USER_FIELDS =
  'created_at,description,location,public_metrics,protected,url,verified,username,name';

/** The acting (authenticated) user and the target user, both canonical numeric ids. */
export interface GraphTarget {
  readonly userId: string;
  readonly targetUserId: string;
}

// The X v2 write confirmations: each endpoint family echoes the resulting state under
// its own key. All fields optional — tolerate envelope drift (DRIFT-1) at the type level.
export interface RawFollowState {
  readonly following?: boolean;
  /** True when the target is protected and the follow is pending their approval. */
  readonly pending_follow?: boolean;
}
export interface RawMuteState {
  readonly muting?: boolean;
}
export interface RawBlockState {
  readonly blocking?: boolean;
}

// Scope sets per endpoint family (docs/01 §2.1). Every user-addressed route also needs
// `users.read` + `tweet.read` alongside its family read/write scope.
const FOLLOW_WRITE_SCOPES: readonly OAuthScope[] = ['tweet.read', 'users.read', 'follows.write'];
const MUTE_WRITE_SCOPES: readonly OAuthScope[] = ['tweet.read', 'users.read', 'mute.write'];
const BLOCK_WRITE_SCOPES: readonly OAuthScope[] = ['tweet.read', 'users.read', 'block.write'];
const FOLLOW_READ_SCOPES: readonly OAuthScope[] = ['tweet.read', 'users.read', 'follows.read'];
const USER_SEARCH_SCOPES: readonly OAuthScope[] = ['tweet.read', 'users.read'];

/** `POST /2/users/:id/following` — follow a user as the acting user. */
export async function createFollow(
  http: EndpointInvoker,
  { userId, targetUserId }: GraphTarget,
): Promise<RawSingleResponse<RawFollowState>> {
  const req: XApiRequest = {
    method: 'POST',
    path: `/2/users/${encodeURIComponent(userId)}/following`,
    body: { target_user_id: targetUserId },
    scopes: FOLLOW_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawFollowState>>(req);
}

/** `DELETE /2/users/:source_user_id/following/:target_user_id` — unfollow a user. */
export async function deleteFollow(
  http: EndpointInvoker,
  { userId, targetUserId }: GraphTarget,
): Promise<RawSingleResponse<RawFollowState>> {
  const req: XApiRequest = {
    method: 'DELETE',
    path: `/2/users/${encodeURIComponent(userId)}/following/${encodeURIComponent(targetUserId)}`,
    scopes: FOLLOW_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawFollowState>>(req);
}

/** `POST /2/users/:id/muting` — mute a user as the acting user. */
export async function createMute(
  http: EndpointInvoker,
  { userId, targetUserId }: GraphTarget,
): Promise<RawSingleResponse<RawMuteState>> {
  const req: XApiRequest = {
    method: 'POST',
    path: `/2/users/${encodeURIComponent(userId)}/muting`,
    body: { target_user_id: targetUserId },
    scopes: MUTE_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawMuteState>>(req);
}

/** `DELETE /2/users/:source_user_id/muting/:target_user_id` — unmute a user. */
export async function deleteMute(
  http: EndpointInvoker,
  { userId, targetUserId }: GraphTarget,
): Promise<RawSingleResponse<RawMuteState>> {
  const req: XApiRequest = {
    method: 'DELETE',
    path: `/2/users/${encodeURIComponent(userId)}/muting/${encodeURIComponent(targetUserId)}`,
    scopes: MUTE_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawMuteState>>(req);
}

/** `POST /2/users/:id/blocking` — block a user as the acting user (POL-5: destructive cell). */
export async function createBlock(
  http: EndpointInvoker,
  { userId, targetUserId }: GraphTarget,
): Promise<RawSingleResponse<RawBlockState>> {
  const req: XApiRequest = {
    method: 'POST',
    path: `/2/users/${encodeURIComponent(userId)}/blocking`,
    body: { target_user_id: targetUserId },
    scopes: BLOCK_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawBlockState>>(req);
}

/** `DELETE /2/users/:source_user_id/blocking/:target_user_id` — unblock a user. */
export async function deleteBlock(
  http: EndpointInvoker,
  { userId, targetUserId }: GraphTarget,
): Promise<RawSingleResponse<RawBlockState>> {
  const req: XApiRequest = {
    method: 'DELETE',
    path: `/2/users/${encodeURIComponent(userId)}/blocking/${encodeURIComponent(targetUserId)}`,
    scopes: BLOCK_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawBlockState>>(req);
}

/** Query-string value type accepted by {@link XApiRequest.query}. */
type QueryValue = string | number | boolean | undefined;

/** Parameters shared by {@link followersList} and {@link followingList}. */
export interface GraphListParams {
  /** Resolved numeric id of the user whose graph is read (never a handle). */
  readonly userId: string;
  readonly maxResults?: number;
  /** v2 `pagination_token` request cursor (a previous response's `next_token`, PAGE-1). */
  readonly paginationToken?: string;
}

/** Build the query shared by the two list endpoints; optional keys omitted when undefined. */
function graphListQuery(params: GraphListParams): Record<string, QueryValue> {
  return {
    'user.fields': USER_FIELDS,
    ...(params.maxResults !== undefined ? { max_results: params.maxResults } : {}),
    ...(params.paginationToken !== undefined ? { pagination_token: params.paginationToken } : {}),
  };
}

/** `GET /2/users/:id/followers` — followers of a user (docs/03 `x_followers_list`). */
export async function followersList(
  http: EndpointInvoker,
  params: GraphListParams,
): Promise<RawListResponse<RawUser>> {
  return http.send<RawListResponse<RawUser>>({
    method: 'GET',
    path: `/2/users/${encodeURIComponent(params.userId)}/followers`,
    query: graphListQuery(params),
    scopes: FOLLOW_READ_SCOPES,
  });
}

/** `GET /2/users/:id/following` — accounts a user follows (docs/03 `x_following_list`). */
export async function followingList(
  http: EndpointInvoker,
  params: GraphListParams,
): Promise<RawListResponse<RawUser>> {
  return http.send<RawListResponse<RawUser>>({
    method: 'GET',
    path: `/2/users/${encodeURIComponent(params.userId)}/following`,
    query: graphListQuery(params),
    scopes: FOLLOW_READ_SCOPES,
  });
}

/** Parameters for {@link searchUsers}. */
export interface UserSearchParams {
  readonly query: string;
  readonly maxResults?: number;
  /** v2 `next_token` request cursor (a previous response's `next_token`, PAGE-1). */
  readonly nextToken?: string;
}

/** `GET /2/users/search` — keyword search over profiles (docs/03 `x_user_search`). */
export async function searchUsers(
  http: EndpointInvoker,
  params: UserSearchParams,
): Promise<RawListResponse<RawUser>> {
  const query: Record<string, QueryValue> = {
    query: params.query,
    'user.fields': USER_FIELDS,
    ...(params.maxResults !== undefined ? { max_results: params.maxResults } : {}),
    ...(params.nextToken !== undefined ? { next_token: params.nextToken } : {}),
  };
  return http.send<RawListResponse<RawUser>>({
    method: 'GET',
    path: '/2/users/search',
    query,
    scopes: USER_SEARCH_SCOPES,
  });
}
