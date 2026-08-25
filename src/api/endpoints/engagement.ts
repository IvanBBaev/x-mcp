// Endpoint wrappers for the engagement tools (T-211; docs/03 engagement §). Six thin
// write builders — like/repost/bookmark, each with a create (POST) and a delete (DELETE)
// form — plus the bookmarks READ (`GET /2/users/:id/bookmarks`), all producing a typed
// `XApiRequest` forwarded through the injected `EndpointInvoker`. Host-scoped auth, the
// no-retry-on-writes rule (RATE-5/NET-4), and error mapping all live below in api/http
// (T-114); nothing here does I/O.
//
// Every route is addressed by the ACTING user's id (`/2/users/:id/...`), which the tool
// layer resolves via `GET /2/users/me` — see src/tools/engagement.ts.

import type { RawListResponse, RawSingleResponse, RawTweet } from '../../core/render.js';
import type { EndpointInvoker, OAuthScope, XApiRequest } from '../../core/tooldef.js';

/** The acting (authenticated) user and the target post, both canonical numeric ids. */
export interface EngagementTarget {
  readonly userId: string;
  readonly postId: string;
}

// The X v2 write confirmations: each endpoint family echoes the resulting state under
// its own key. All fields optional — tolerate envelope drift (DRIFT-1) at the type level.
export interface RawLikeState {
  readonly liked?: boolean;
}
export interface RawRepostState {
  readonly retweeted?: boolean;
}
export interface RawBookmarkState {
  readonly bookmarked?: boolean;
}

// Scope sets per endpoint family (docs/01 §2.1; rate limits in §4). Every user-addressed route
// also needs `users.read` + `tweet.read` alongside its family write scope.
const LIKE_SCOPES: readonly OAuthScope[] = ['tweet.read', 'users.read', 'like.write'];
const REPOST_SCOPES: readonly OAuthScope[] = ['tweet.read', 'users.read', 'tweet.write'];
const BOOKMARK_SCOPES: readonly OAuthScope[] = ['tweet.read', 'users.read', 'bookmark.write'];
/** Reading bookmarks needs `bookmark.read`, NOT the write scope the toggles use. */
const BOOKMARK_READ_SCOPES: readonly OAuthScope[] = ['tweet.read', 'users.read', 'bookmark.read'];

// The tweet compaction field set, identical to the one the timeline and list reads send so
// bookmarked posts compact into the same `CompactPost` shape (core/render `renderPostPage`).
const TWEET_FIELDS =
  'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id';
const TWEET_EXPANSIONS =
  'author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys';
const TWEET_USER_FIELDS = 'username,name,verified';
const MEDIA_FIELDS = 'type,url,preview_image_url,alt_text';

/** Page size + cursor for {@link listBookmarks}; keys are omitted when undefined. */
export interface BookmarkPageParams {
  readonly maxResults?: number;
  readonly paginationToken?: string;
}

/** `POST /2/users/:id/likes` — like a post as the acting user. */
export async function createLike(
  http: EndpointInvoker,
  { userId, postId }: EngagementTarget,
): Promise<RawSingleResponse<RawLikeState>> {
  const req: XApiRequest = {
    method: 'POST',
    path: `/2/users/${encodeURIComponent(userId)}/likes`,
    body: { tweet_id: postId },
    scopes: LIKE_SCOPES,
  };
  return http.send<RawSingleResponse<RawLikeState>>(req);
}

/** `DELETE /2/users/:id/likes/:tweet_id` — remove the acting user's like from a post. */
export async function deleteLike(
  http: EndpointInvoker,
  { userId, postId }: EngagementTarget,
): Promise<RawSingleResponse<RawLikeState>> {
  const req: XApiRequest = {
    method: 'DELETE',
    path: `/2/users/${encodeURIComponent(userId)}/likes/${encodeURIComponent(postId)}`,
    scopes: LIKE_SCOPES,
  };
  return http.send<RawSingleResponse<RawLikeState>>(req);
}

/** `POST /2/users/:id/retweets` — repost a post as the acting user. */
export async function createRepost(
  http: EndpointInvoker,
  { userId, postId }: EngagementTarget,
): Promise<RawSingleResponse<RawRepostState>> {
  const req: XApiRequest = {
    method: 'POST',
    path: `/2/users/${encodeURIComponent(userId)}/retweets`,
    body: { tweet_id: postId },
    scopes: REPOST_SCOPES,
  };
  return http.send<RawSingleResponse<RawRepostState>>(req);
}

/** `DELETE /2/users/:id/retweets/:source_tweet_id` — undo the acting user's repost. */
export async function deleteRepost(
  http: EndpointInvoker,
  { userId, postId }: EngagementTarget,
): Promise<RawSingleResponse<RawRepostState>> {
  const req: XApiRequest = {
    method: 'DELETE',
    path: `/2/users/${encodeURIComponent(userId)}/retweets/${encodeURIComponent(postId)}`,
    scopes: REPOST_SCOPES,
  };
  return http.send<RawSingleResponse<RawRepostState>>(req);
}

/** `POST /2/users/:id/bookmarks` — bookmark a post (private to the acting user). */
export async function createBookmark(
  http: EndpointInvoker,
  { userId, postId }: EngagementTarget,
): Promise<RawSingleResponse<RawBookmarkState>> {
  const req: XApiRequest = {
    method: 'POST',
    path: `/2/users/${encodeURIComponent(userId)}/bookmarks`,
    body: { tweet_id: postId },
    scopes: BOOKMARK_SCOPES,
  };
  return http.send<RawSingleResponse<RawBookmarkState>>(req);
}

/** `DELETE /2/users/:id/bookmarks/:tweet_id` — remove a post from the acting user's bookmarks. */
export async function deleteBookmark(
  http: EndpointInvoker,
  { userId, postId }: EngagementTarget,
): Promise<RawSingleResponse<RawBookmarkState>> {
  const req: XApiRequest = {
    method: 'DELETE',
    path: `/2/users/${encodeURIComponent(userId)}/bookmarks/${encodeURIComponent(postId)}`,
    scopes: BOOKMARK_SCOPES,
  };
  return http.send<RawSingleResponse<RawBookmarkState>>(req);
}

/**
 * `GET /2/users/:id/bookmarks` — the acting user's own bookmarks, newest first (docs/03
 * `x_bookmarks_list`). Own-data, so it is priced at the `owned` rate and is reachable only
 * under user context. Paginates with the `pagination_token` REQUEST parameter while the
 * RESPONSE cursor stays `meta.next_token` — the PAGE-1 bridge lives in the tool layer.
 */
export async function listBookmarks(
  http: EndpointInvoker,
  userId: string,
  params: BookmarkPageParams = {},
): Promise<RawListResponse<RawTweet>> {
  const req: XApiRequest = {
    method: 'GET',
    path: `/2/users/${encodeURIComponent(userId)}/bookmarks`,
    query: {
      'tweet.fields': TWEET_FIELDS,
      expansions: TWEET_EXPANSIONS,
      'user.fields': TWEET_USER_FIELDS,
      'media.fields': MEDIA_FIELDS,
      ...(params.maxResults !== undefined ? { max_results: params.maxResults } : {}),
      ...(params.paginationToken !== undefined ? { pagination_token: params.paginationToken } : {}),
    },
    scopes: BOOKMARK_READ_SCOPES,
  };
  return http.send<RawListResponse<RawTweet>>(req);
}
