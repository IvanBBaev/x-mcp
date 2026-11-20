// Typed endpoint wrappers for X API v2 search & counts (docs/01 "Search & counts";
// docs/03 `x_search_recent`, `x_post_counts_recent`, `x_news_search`, `x_news_get`). Owned
// by the T-123 search slice; the news wrappers were added by Q11.
//
// Each wrapper maps typed args to a single `XApiRequest` and returns the raw response
// envelope for the tool layer to compact. Nothing here owns transport, auth, retries, or
// error mapping — that is the injected `EndpointInvoker` (api/http, T-114). Optional query
// keys are OMITTED when their value is undefined (exactOptionalPropertyTypes-safe), so a
// blank field never becomes an empty `?key=` parameter.

import type { EndpointInvoker } from '../../core/tooldef.js';
import type { RawListResponse, RawSingleResponse, RawTweet } from '../../core/render.js';

// The tweet compaction field set, shared with the post read tools so search results carry
// author handles, engagement metrics, references, media, and long-form note bodies.
const TWEET_FIELDS =
  'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id,' +
  'paid_partnership';
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
  readonly sinceId?: string;
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
    ...(params.sinceId !== undefined ? { since_id: params.sinceId } : {}),
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

// --- News (Q11) --------------------------------------------------------------------
//
// `GET /2/news/search` and `GET /2/news/{id}` (docs.x.com x-api/news, OpenAPI 2.175 —
// operationIds searchNews / getNews, fetched 2026-11-20). Both accept an app-only bearer or a
// user token (OAuth2 scopes `tweet.read users.read`). Every request asks for the full
// `news.fields` set the spec enumerates; the tool layer decides what the compact shape keeps.

/** Every `news.fields` value the OpenAPI 2.175 enum lists. */
const NEWS_FIELDS =
  'category,cluster_posts_results,contexts,disclaimer,hook,id,keywords,name,summary,updated_at';

/**
 * One news story. Every field is optional and read defensively (DRIFT-1). `updated_at` is
 * the spec's name; the docs' introduction example and changelog call the same ISO value
 * `last_updated_at_ms`, so both are modelled (docs/07 NEWS-3). `contexts` / `keywords` have
 * no documented shape, so they stay `unknown` and only ever reach the caller via `raw`.
 */
export interface RawNews {
  readonly id?: string;
  readonly name?: string;
  readonly summary?: string;
  readonly hook?: string;
  readonly category?: string;
  readonly disclaimer?: string;
  readonly updated_at?: string;
  readonly last_updated_at_ms?: string | number;
  readonly cluster_posts_results?: readonly { readonly post_id?: string }[];
  readonly contexts?: unknown;
  readonly keywords?: unknown;
}

/** Parameters for {@link searchNews}. */
export interface SearchNewsParams {
  readonly query: string;
  readonly maxResults?: number;
  readonly maxAgeHours?: number;
}

/** `GET /2/news/search` — news stories matching a query; unpaginated (docs/03 `x_news_search`). */
export async function searchNews(
  http: EndpointInvoker,
  params: SearchNewsParams,
): Promise<RawListResponse<RawNews>> {
  const query: Record<string, QueryValue> = {
    query: params.query,
    'news.fields': NEWS_FIELDS,
    ...(params.maxResults !== undefined ? { max_results: params.maxResults } : {}),
    ...(params.maxAgeHours !== undefined ? { max_age_hours: params.maxAgeHours } : {}),
  };
  return http.send<RawListResponse<RawNews>>({
    method: 'GET',
    path: '/2/news/search',
    query,
    scopes: ['tweet.read', 'users.read'],
  });
}

/** `GET /2/news/{id}` — one news story by id (docs/03 `x_news_get`). */
export async function getNews(
  http: EndpointInvoker,
  newsId: string,
): Promise<RawSingleResponse<RawNews>> {
  return http.send<RawSingleResponse<RawNews>>({
    method: 'GET',
    path: `/2/news/${encodeURIComponent(newsId)}`,
    query: { 'news.fields': NEWS_FIELDS },
    scopes: ['tweet.read', 'users.read'],
  });
}
