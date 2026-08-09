// Typed endpoint wrappers for the X API v2 list family (docs/03 lists package: the ten
// merged list tools, T-302 / WP-3.2). Each wrapper maps typed args to a single
// `XApiRequest` and returns the raw response envelope for the tool layer to compact.
// Nothing here owns transport, auth, retries, or error mapping — that is the injected
// `EndpointInvoker` (api/http, T-114). Optional query keys are OMITTED when their value
// is undefined (exactOptionalPropertyTypes-safe).
//
// Wire note: like the timelines, the paginated list reads use the `pagination_token`
// REQUEST parameter while the RESPONSE cursor is still `meta.next_token` — the PAGE-1
// opaque round-trip bridges the two names in the tool layer.

import type {
  RawList,
  RawListResponse,
  RawSingleResponse,
  RawTweet,
  RawUser,
} from '../../core/render.js';
import type { EndpointInvoker, OAuthScope, XApiRequest } from '../../core/tooldef.js';

// Scope sets per docs/01 §2.1: every list route also needs `tweet.read` + `users.read`
// alongside its family scope.
const LIST_READ_SCOPES: readonly OAuthScope[] = ['tweet.read', 'users.read', 'list.read'];
const LIST_WRITE_SCOPES: readonly OAuthScope[] = ['tweet.read', 'users.read', 'list.write'];

// List-object projection: exactly the fields `renderList` compacts, plus the owner
// expansion so the compact `owner` handle can resolve (REND-5 tolerates its absence).
const LIST_FIELDS = 'description,follower_count,member_count,private,owner_id';
const LIST_EXPANSIONS = 'owner_id';
const OWNER_USER_FIELDS = 'username,name';

// Member projection: aligned with api/endpoints/users so `renderUser` sees the same
// profile surface as `x_user_get`.
const MEMBER_USER_FIELDS =
  'created_at,description,location,public_metrics,protected,url,verified,username,name';

// Timeline projection: aligned with api/endpoints/timelines so list-timeline entries
// carry author handles, engagement metrics, references, media, and note bodies.
const TWEET_FIELDS =
  'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id';
const TWEET_EXPANSIONS =
  'author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys';
const TWEET_USER_FIELDS = 'username,name,verified';
const MEDIA_FIELDS = 'type,url,preview_image_url,alt_text';

/** Query-string value type accepted by {@link XApiRequest.query}. */
type QueryValue = string | number | boolean | undefined;

// The X v2 write confirmations: each list write echoes the resulting state under its own
// key. All fields optional — tolerate envelope drift (DRIFT-1) at the type level.
export interface RawListUpdateState {
  readonly updated?: boolean;
}
export interface RawListDeleteState {
  readonly deleted?: boolean;
}
export interface RawListMemberState {
  readonly is_member?: boolean;
}
export interface RawListFollowState {
  readonly following?: boolean;
}
export interface RawListPinState {
  readonly pinned?: boolean;
}

/** Metadata accepted by `POST /2/lists` (name required, the rest optional). */
export interface ListCreateParams {
  readonly name: string;
  readonly description?: string;
  readonly private?: boolean;
}

/** Metadata accepted by `PUT /2/lists/:id` — only the provided keys are sent. */
export interface ListUpdateParams {
  readonly name?: string;
  readonly description?: string;
  readonly private?: boolean;
}

/** Pagination shared by the paginated list reads (PAGE-1/PAGE-3). */
export interface ListPageParams {
  readonly maxResults?: number;
  /** v2 `pagination_token` request cursor (a previous response's `next_token`, PAGE-1). */
  readonly paginationToken?: string;
}

/** Spread-in pagination keys, omitted when undefined. */
function pageQuery(params: ListPageParams): Record<string, QueryValue> {
  return {
    ...(params.maxResults !== undefined ? { max_results: params.maxResults } : {}),
    ...(params.paginationToken !== undefined ? { pagination_token: params.paginationToken } : {}),
  };
}

/** The list-object projection shared by `getList` and `ownedLists`. */
function listQuery(): Record<string, QueryValue> {
  return {
    'list.fields': LIST_FIELDS,
    expansions: LIST_EXPANSIONS,
    'user.fields': OWNER_USER_FIELDS,
  };
}

// --- List CRUD -------------------------------------------------------------------

/** `POST /2/lists` — create a list owned by the acting user (docs/03 `x_list_create`). */
export async function createList(
  http: EndpointInvoker,
  params: ListCreateParams,
): Promise<RawSingleResponse<RawList>> {
  const req: XApiRequest = {
    method: 'POST',
    path: '/2/lists',
    body: {
      name: params.name,
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.private !== undefined ? { private: params.private } : {}),
    },
    scopes: LIST_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawList>>(req);
}

/** `PUT /2/lists/:id` — update the acting user's list metadata (docs/03 `x_list_update`). */
export async function updateList(
  http: EndpointInvoker,
  listId: string,
  params: ListUpdateParams,
): Promise<RawSingleResponse<RawListUpdateState>> {
  const req: XApiRequest = {
    method: 'PUT',
    path: `/2/lists/${encodeURIComponent(listId)}`,
    body: {
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.private !== undefined ? { private: params.private } : {}),
    },
    scopes: LIST_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawListUpdateState>>(req);
}

/** `DELETE /2/lists/:id` — delete the acting user's list (docs/03 `x_list_delete`). */
export async function deleteList(
  http: EndpointInvoker,
  listId: string,
): Promise<RawSingleResponse<RawListDeleteState>> {
  const req: XApiRequest = {
    method: 'DELETE',
    path: `/2/lists/${encodeURIComponent(listId)}`,
    scopes: LIST_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawListDeleteState>>(req);
}

// --- List reads ------------------------------------------------------------------

/** `GET /2/lists/:id` — one list's metadata (docs/03 `x_list_get`). */
export async function getList(
  http: EndpointInvoker,
  listId: string,
): Promise<RawSingleResponse<RawList>> {
  return http.send<RawSingleResponse<RawList>>({
    method: 'GET',
    path: `/2/lists/${encodeURIComponent(listId)}`,
    query: listQuery(),
    scopes: LIST_READ_SCOPES,
  });
}

/** `GET /2/users/:id/owned_lists` — lists a user owns (docs/03 `x_lists_owned`). */
export async function ownedLists(
  http: EndpointInvoker,
  userId: string,
  params: ListPageParams = {},
): Promise<RawListResponse<RawList>> {
  return http.send<RawListResponse<RawList>>({
    method: 'GET',
    path: `/2/users/${encodeURIComponent(userId)}/owned_lists`,
    query: { ...listQuery(), ...pageQuery(params) },
    scopes: LIST_READ_SCOPES,
  });
}

/** `GET /2/lists/:id/members` — a list's members (docs/03 `x_list_members`). */
export async function listMembers(
  http: EndpointInvoker,
  listId: string,
  params: ListPageParams = {},
): Promise<RawListResponse<RawUser>> {
  return http.send<RawListResponse<RawUser>>({
    method: 'GET',
    path: `/2/lists/${encodeURIComponent(listId)}/members`,
    query: { 'user.fields': MEMBER_USER_FIELDS, ...pageQuery(params) },
    scopes: LIST_READ_SCOPES,
  });
}

/** `GET /2/lists/:id/tweets` — posts from a list's timeline (docs/03 `x_list_timeline`). */
export async function listTimeline(
  http: EndpointInvoker,
  listId: string,
  params: ListPageParams = {},
): Promise<RawListResponse<RawTweet>> {
  return http.send<RawListResponse<RawTweet>>({
    method: 'GET',
    path: `/2/lists/${encodeURIComponent(listId)}/tweets`,
    query: {
      'tweet.fields': TWEET_FIELDS,
      expansions: TWEET_EXPANSIONS,
      'user.fields': TWEET_USER_FIELDS,
      'media.fields': MEDIA_FIELDS,
      ...pageQuery(params),
    },
    scopes: LIST_READ_SCOPES,
  });
}

// --- Membership writes -----------------------------------------------------------

/** `POST /2/lists/:id/members` — add one user to the acting user's list. */
export async function addListMember(
  http: EndpointInvoker,
  listId: string,
  userId: string,
): Promise<RawSingleResponse<RawListMemberState>> {
  const req: XApiRequest = {
    method: 'POST',
    path: `/2/lists/${encodeURIComponent(listId)}/members`,
    body: { user_id: userId },
    scopes: LIST_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawListMemberState>>(req);
}

/** `DELETE /2/lists/:id/members/:user_id` — remove one user from the acting user's list. */
export async function removeListMember(
  http: EndpointInvoker,
  listId: string,
  userId: string,
): Promise<RawSingleResponse<RawListMemberState>> {
  const req: XApiRequest = {
    method: 'DELETE',
    path: `/2/lists/${encodeURIComponent(listId)}/members/${encodeURIComponent(userId)}`,
    scopes: LIST_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawListMemberState>>(req);
}

// --- Follow / pin writes (addressed by the ACTING user's id) ---------------------

/** `POST /2/users/:id/followed_lists` — follow a list as the acting user. */
export async function followList(
  http: EndpointInvoker,
  userId: string,
  listId: string,
): Promise<RawSingleResponse<RawListFollowState>> {
  const req: XApiRequest = {
    method: 'POST',
    path: `/2/users/${encodeURIComponent(userId)}/followed_lists`,
    body: { list_id: listId },
    scopes: LIST_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawListFollowState>>(req);
}

/** `DELETE /2/users/:id/followed_lists/:list_id` — unfollow a list. */
export async function unfollowList(
  http: EndpointInvoker,
  userId: string,
  listId: string,
): Promise<RawSingleResponse<RawListFollowState>> {
  const req: XApiRequest = {
    method: 'DELETE',
    path: `/2/users/${encodeURIComponent(userId)}/followed_lists/${encodeURIComponent(listId)}`,
    scopes: LIST_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawListFollowState>>(req);
}

/** `POST /2/users/:id/pinned_lists` — pin a list for the acting user. */
export async function pinList(
  http: EndpointInvoker,
  userId: string,
  listId: string,
): Promise<RawSingleResponse<RawListPinState>> {
  const req: XApiRequest = {
    method: 'POST',
    path: `/2/users/${encodeURIComponent(userId)}/pinned_lists`,
    body: { list_id: listId },
    scopes: LIST_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawListPinState>>(req);
}

/** `DELETE /2/users/:id/pinned_lists/:list_id` — unpin a list. */
export async function unpinList(
  http: EndpointInvoker,
  userId: string,
  listId: string,
): Promise<RawSingleResponse<RawListPinState>> {
  const req: XApiRequest = {
    method: 'DELETE',
    path: `/2/users/${encodeURIComponent(userId)}/pinned_lists/${encodeURIComponent(listId)}`,
    scopes: LIST_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawListPinState>>(req);
}
