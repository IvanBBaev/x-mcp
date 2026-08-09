// Typed endpoint wrappers for the X API v2 timeline family (docs/03 timelines package:
// `x_timeline_home`, `x_timeline_mentions`, `x_timeline_user`). Owned by the T-212
// timelines slice.
//
// Each wrapper maps typed args to a single `XApiRequest` and returns the raw response
// envelope for the tool layer to compact. Nothing here owns transport, auth, retries, or
// error mapping — that is the injected `EndpointInvoker` (api/http, T-114). Optional query
// keys are OMITTED when their value is undefined (exactOptionalPropertyTypes-safe).
//
// Wire note: timelines paginate with the `pagination_token` REQUEST parameter (unlike
// search, whose request cursor is `next_token`), while the RESPONSE cursor is still
// `meta.next_token` — the PAGE-1 opaque round-trip bridges the two names.

import type { EndpointInvoker, OAuthScope } from '../../core/tooldef.js';
import type { RawListResponse, RawTweet } from '../../core/render.js';

// The tweet compaction field set, aligned with the post/search read tools so timeline
// entries carry author handles, engagement metrics, references, media, and long-form note
// bodies. `referenced_tweets.id.author_id` is included (as in api/endpoints/posts) because
// timelines are dense with reposts/replies whose referenced authors REND-3/REND-5 resolve.
const TWEET_FIELDS =
  'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id';
const EXPANSIONS =
  'author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys';
const USER_FIELDS = 'username,name,verified';
const MEDIA_FIELDS = 'type,url,preview_image_url,alt_text';

/** Every timeline read returns tweets with author expansions. */
const TIMELINE_SCOPES: readonly OAuthScope[] = ['tweet.read', 'users.read'];

/** Query-string value type accepted by {@link XApiRequest.query}. */
type QueryValue = string | number | boolean | undefined;

/** Parameters shared by all three timeline endpoints. */
export interface TimelineParams {
  /** Resolved numeric id of the user whose timeline is read (never a handle). */
  readonly userId: string;
  readonly maxResults?: number;
  /** v2 `pagination_token` request cursor (a previous response's `next_token`, PAGE-1). */
  readonly paginationToken?: string;
  readonly startTime?: string;
  readonly endTime?: string;
}

/** `exclude` values accepted by `GET /2/users/:id/tweets` (v2 wire vocabulary). */
export type TimelineExclude = 'replies' | 'retweets';

/** Parameters for {@link userTimeline}: the shared set plus the `exclude` flags. */
export interface UserTimelineParams extends TimelineParams {
  readonly exclude?: readonly TimelineExclude[];
}

/** Build the query shared by the three endpoints; optional keys omitted when undefined. */
function timelineQuery(params: TimelineParams): Record<string, QueryValue> {
  return {
    'tweet.fields': TWEET_FIELDS,
    expansions: EXPANSIONS,
    'user.fields': USER_FIELDS,
    'media.fields': MEDIA_FIELDS,
    ...(params.maxResults !== undefined ? { max_results: params.maxResults } : {}),
    ...(params.paginationToken !== undefined ? { pagination_token: params.paginationToken } : {}),
    ...(params.startTime !== undefined ? { start_time: params.startTime } : {}),
    ...(params.endTime !== undefined ? { end_time: params.endTime } : {}),
  };
}

/**
 * `GET /2/users/:id/timelines/reverse_chronological` — the authenticated user's home
 * timeline (docs/03 `x_timeline_home`). User-context only; under app-only auth the http
 * layer maps the API's 401 to a typed `auth` error.
 */
export async function homeTimeline(
  http: EndpointInvoker,
  params: TimelineParams,
): Promise<RawListResponse<RawTweet>> {
  return http.send<RawListResponse<RawTweet>>({
    method: 'GET',
    path: `/2/users/${encodeURIComponent(params.userId)}/timelines/reverse_chronological`,
    query: timelineQuery(params),
    scopes: TIMELINE_SCOPES,
  });
}

/** `GET /2/users/:id/mentions` — posts mentioning the user (docs/03 `x_timeline_mentions`). */
export async function mentionsTimeline(
  http: EndpointInvoker,
  params: TimelineParams,
): Promise<RawListResponse<RawTweet>> {
  return http.send<RawListResponse<RawTweet>>({
    method: 'GET',
    path: `/2/users/${encodeURIComponent(params.userId)}/mentions`,
    query: timelineQuery(params),
    scopes: TIMELINE_SCOPES,
  });
}

/** `GET /2/users/:id/tweets` — a user's own posts (docs/03 `x_timeline_user`). */
export async function userTimeline(
  http: EndpointInvoker,
  params: UserTimelineParams,
): Promise<RawListResponse<RawTweet>> {
  const query = timelineQuery(params);
  if (params.exclude !== undefined && params.exclude.length > 0) {
    query['exclude'] = params.exclude.join(',');
  }
  return http.send<RawListResponse<RawTweet>>({
    method: 'GET',
    path: `/2/users/${encodeURIComponent(params.userId)}/tweets`,
    query,
    scopes: TIMELINE_SCOPES,
  });
}
