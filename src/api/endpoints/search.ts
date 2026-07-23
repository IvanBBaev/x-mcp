// Typed endpoint wrappers for X API v2 search & counts (docs/01 "Search & counts";
// docs/03 `x_search_recent`, `x_post_counts_recent`). Owned by the T-123 search slice.
//
// Each wrapper maps typed args to a single `XApiRequest` and returns the raw response
// envelope for the tool layer to compact. Nothing here owns transport, auth, retries, or
// error mapping — that is the injected `EndpointInvoker` (api/http, T-114). Optional query
// keys are OMITTED when their value is undefined (exactOptionalPropertyTypes-safe), so a
// blank field never becomes an empty `?key=` parameter.

import type { EndpointInvoker } from '../../core/tooldef.js';
import type { RawListResponse, RawTweet } from '../../core/render.js';

// The tweet compaction field set, shared with the post read tools so search results carry
// author handles, engagement metrics, references, media, and long-form note bodies.
const TWEET_FIELDS =
  'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id';
const EXPANSIONS = 'author_id,referenced_tweets.id,attachments.media_keys';
const USER_FIELDS = 'username,name,verified';
const MEDIA_FIELDS = 'type,url,preview_image_url,alt_text';

/** Query-string value type accepted by {@link XApiRequest.query}. */
type QueryValue = string | number | boolean | undefined;

/** Parameters for {@link searchRecent}. */
export interface SearchRecentParams {
  readonly query: string;
  readonly maxResults?: number;
  readonly nextToken?: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly sortOrder?: 'recency' | 'relevancy';
}

/** `GET /2/tweets/search/recent` — last-7-days search (docs/03 `x_search_recent`). */
export async function searchRecent(
  http: EndpointInvoker,
  params: SearchRecentParams,
): Promise<RawListResponse<RawTweet>> {
  const query: Record<string, QueryValue> = {
    query: params.query,
    'tweet.fields': TWEET_FIELDS,
    expansions: EXPANSIONS,
    'user.fields': USER_FIELDS,
    'media.fields': MEDIA_FIELDS,
    ...(params.maxResults !== undefined ? { max_results: params.maxResults } : {}),
    ...(params.nextToken !== undefined ? { next_token: params.nextToken } : {}),
    ...(params.startTime !== undefined ? { start_time: params.startTime } : {}),
    ...(params.endTime !== undefined ? { end_time: params.endTime } : {}),
    ...(params.sortOrder !== undefined ? { sort_order: params.sortOrder } : {}),
  };
  return http.send<RawListResponse<RawTweet>>({
    method: 'GET',
    path: '/2/tweets/search/recent',
    query,
    scopes: ['tweet.read', 'users.read'],
  });
}

/** One bucket of a counts histogram. Fields are read defensively (DRIFT-1). */
export interface RawCountBucket {
  readonly start?: string;
  readonly end?: string;
  readonly tweet_count?: number;
}

/**
 * The `GET /2/tweets/counts/recent` response envelope. This is NOT modelled in core/render
 * (it carries only numbers + ISO timestamps, never post text), so it is defined locally.
 */
export interface RawCountsResponse {
  readonly data?: readonly RawCountBucket[];
  readonly meta?: {
    readonly total_tweet_count?: number;
    readonly next_token?: string;
  };
}

/** Parameters for {@link countsRecent}. */
export interface CountsRecentParams {
  readonly query: string;
  readonly granularity?: 'minute' | 'hour' | 'day';
  readonly startTime?: string;
  readonly endTime?: string;
  readonly nextToken?: string;
}

/** `GET /2/tweets/counts/recent` — last-7-days volume histogram (docs/03 `x_post_counts_recent`). */
export async function countsRecent(
  http: EndpointInvoker,
  params: CountsRecentParams,
): Promise<RawCountsResponse> {
  const query: Record<string, QueryValue> = {
    query: params.query,
    ...(params.granularity !== undefined ? { granularity: params.granularity } : {}),
    ...(params.startTime !== undefined ? { start_time: params.startTime } : {}),
    ...(params.endTime !== undefined ? { end_time: params.endTime } : {}),
    ...(params.nextToken !== undefined ? { next_token: params.nextToken } : {}),
  };
  return http.send<RawCountsResponse>({
    method: 'GET',
    path: '/2/tweets/counts/recent',
    query,
    scopes: ['tweet.read'],
  });
}
