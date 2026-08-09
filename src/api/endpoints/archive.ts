// Typed endpoint wrappers for X API v2 full-archive search & counts (docs/01 §5 "Search &
// counts"; docs/03 `x_search_archive`, `x_post_counts_archive`). Owned by the T-306 archive
// slice (WP-3.5).
//
// Each wrapper maps typed args to a single `XApiRequest` and returns the raw response
// envelope for the tool layer to compact. Nothing here owns transport, auth, retries, or
// error mapping — that is the injected `EndpointInvoker` (api/http, T-114). Optional query
// keys are OMITTED when their value is undefined (exactOptionalPropertyTypes-safe), so a
// blank field never becomes an empty `?key=` parameter.
//
// Availability note (T-010 fact-check, docs/01 §3.2): full-archive search/counts are
// `app+user` under pay-per-use — no longer a Pro/Academic gate. These endpoints therefore
// register by default and are restrained by the session credit budget (COST-1), never by
// availability gating (src/tools/availability.ts gates only pilot/premium-user/enterprise).

import type { EndpointInvoker } from '../../core/tooldef.js';
import type { RawListResponse, RawTweet } from '../../core/render.js';
import type { RawCountsResponse } from './search.js';

// The tweet compaction field set, mirroring the recent-search slice (api/endpoints/search)
// so archive results carry the same author handles, metrics, references, media, and
// long-form note bodies through the shared renderPostPage path.
const TWEET_FIELDS =
  'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id';
const EXPANSIONS = 'author_id,referenced_tweets.id,attachments.media_keys';
const USER_FIELDS = 'username,name,verified';
const MEDIA_FIELDS = 'type,url,preview_image_url,alt_text';

/** Query-string value type accepted by {@link XApiRequest.query}. */
type QueryValue = string | number | boolean | undefined;

/** Parameters for {@link searchArchive}. */
export interface SearchArchiveParams {
  readonly query: string;
  readonly maxResults?: number;
  readonly nextToken?: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly sortOrder?: 'recency' | 'relevancy';
}

/** `GET /2/tweets/search/all` — full-archive search since 2006 (docs/03 `x_search_archive`). */
export async function searchArchive(
  http: EndpointInvoker,
  params: SearchArchiveParams,
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
    path: '/2/tweets/search/all',
    query,
    scopes: ['tweet.read', 'users.read'],
  });
}

/** Parameters for {@link countsArchive}. */
export interface CountsArchiveParams {
  readonly query: string;
  readonly granularity?: 'minute' | 'hour' | 'day';
  readonly startTime?: string;
  readonly endTime?: string;
  readonly nextToken?: string;
}

/**
 * `GET /2/tweets/counts/all` — full-archive volume histogram (docs/03
 * `x_post_counts_archive`). Reuses the counts envelope from the recent slice — the
 * archive variant differs only in path and time span, never in shape.
 */
export async function countsArchive(
  http: EndpointInvoker,
  params: CountsArchiveParams,
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
    path: '/2/tweets/counts/all',
    query,
    scopes: ['tweet.read'],
  });
}
