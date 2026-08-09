// Post endpoint wrappers (T-121 reads, T-210 writes). Thin, typed builders over the
// host-scoped `EndpointInvoker` (api/http, T-114): they translate typed args into an
// `XApiRequest` (path, query/body, required scopes) and return the RAW X API v2 envelope
// UNCOMPACTED — the compaction into agent-facing shapes is the tool layer's job
// (core/render, T-117). No I/O, auth, retry, or error mapping lives here; `http.send`
// owns all of that.

import type { EndpointInvoker, OAuthScope, XApiRequest } from '../../core/tooldef.js';
import type { RawListResponse, RawSingleResponse, RawTweet } from '../../core/render.js';

// The field/expansion set the compactor (core/render `renderPosts`) actually reads:
// author + metrics + references + attachments + long-form note, with the user and media
// expansions needed to resolve `@handle`s and attached media. Kept module-local so the
// wire contract lives in exactly one place.
const TWEET_FIELDS =
  'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id';
const EXPANSIONS =
  'author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys';
const USER_FIELDS = 'username,name,verified';
const MEDIA_FIELDS = 'type,url,preview_image_url,alt_text';

/** OAuth scopes the batch-lookup endpoint requires (read tweets + resolve author users). */
const POST_LOOKUP_SCOPES: readonly OAuthScope[] = ['tweet.read', 'users.read'];

/**
 * Batch-fetch posts by numeric id via `GET /2/tweets?ids=…` (up to 100 per call). Ids are
 * comma-joined onto the query; the response envelope's `errors[]` carries any that could not
 * be fetched (the tool maps those to `missing[]`, REND-2). Returns the raw typed envelope.
 */
export async function getPosts(
  http: EndpointInvoker,
  params: { readonly ids: readonly string[] },
): Promise<RawListResponse<RawTweet>> {
  const req: XApiRequest = {
    method: 'GET',
    path: '/2/tweets',
    query: {
      ids: params.ids.join(','),
      'tweet.fields': TWEET_FIELDS,
      expansions: EXPANSIONS,
      'user.fields': USER_FIELDS,
      'media.fields': MEDIA_FIELDS,
    },
    scopes: POST_LOOKUP_SCOPES,
  };
  return http.send<RawListResponse<RawTweet>>(req);
}

// --- Write endpoints (T-210) ------------------------------------------------------

/** OAuth scopes every post WRITE endpoint requires (create + delete). */
const POST_WRITE_SCOPES: readonly OAuthScope[] = ['tweet.read', 'tweet.write', 'users.read'];

/**
 * The closed `reply_settings` enum (POST-6). Values are the ones X documents for
 * `POST /2/tweets`; omitting the field means "everyone may reply" — there is no
 * explicit `everyone` value on the wire. Single source of truth: the tool schema
 * (src/tools/posts) builds its `z.enum` from this tuple.
 */
export const REPLY_SETTINGS = ['following', 'mentionedUsers', 'subscribers'] as const;
export type ReplySetting = (typeof REPLY_SETTINGS)[number];

/** Poll attachment for {@link createPost}: 2-4 options, duration 5-10080 minutes (POST-6). */
export interface CreatePostPoll {
  readonly options: readonly string[];
  readonly durationMinutes: number;
}

/**
 * Parameters for {@link createPost}. Optional keys are OMITTED from the JSON body when
 * absent (exactOptionalPropertyTypes-safe) — the API treats a missing key as its default.
 * `replyToId`/`quoteId` are already-normalized bare numeric ids (the tool layer runs
 * `parsePostId` first).
 */
export interface CreatePostParams {
  readonly text: string;
  readonly replyToId?: string;
  readonly quoteId?: string;
  readonly mediaIds?: readonly string[];
  readonly poll?: CreatePostPoll;
  readonly replySettings?: ReplySetting;
}

/** The `POST /2/tweets` success payload. Fields are read defensively (DRIFT-1). */
export interface RawCreatedPost {
  readonly id?: string;
  readonly text?: string;
}

/** The `DELETE /2/tweets/:id` success payload. */
export interface RawDeleteResult {
  readonly deleted?: boolean;
}

/** The `PUT /2/tweets/:id/hidden` success payload. */
export interface RawHiddenState {
  readonly hidden?: boolean;
}

/**
 * Scopes for reply moderation. `tweet.moderate.write` is its own scope — a token granted
 * only `tweet.write` cannot hide a reply, so this list is NOT the write list above.
 */
const REPLY_MODERATION_SCOPES: readonly OAuthScope[] = [
  'tweet.read',
  'tweet.moderate.write',
  'users.read',
];

/**
 * Create a post via `POST /2/tweets` (docs/03 `x_post_create`). The `text` lands in the
 * JSON body EXACTLY as received — no normalization, no trimming (POST-1). Composite
 * constraint validation (POST-6) and reply/quote id normalization happened in the tool
 * layer; write-specific error interpretation (POST-2/3/4/7/9) happens there too — this
 * builder only shapes the request.
 */
export async function createPost(
  http: EndpointInvoker,
  params: CreatePostParams,
): Promise<RawSingleResponse<RawCreatedPost>> {
  const body: Record<string, unknown> = {
    text: params.text,
    ...(params.replyToId !== undefined
      ? { reply: { in_reply_to_tweet_id: params.replyToId } }
      : {}),
    ...(params.quoteId !== undefined ? { quote_tweet_id: params.quoteId } : {}),
    ...(params.mediaIds !== undefined ? { media: { media_ids: [...params.mediaIds] } } : {}),
    ...(params.poll !== undefined
      ? {
          poll: {
            options: [...params.poll.options],
            duration_minutes: params.poll.durationMinutes,
          },
        }
      : {}),
    ...(params.replySettings !== undefined ? { reply_settings: params.replySettings } : {}),
  };
  const req: XApiRequest = {
    method: 'POST',
    path: '/2/tweets',
    body,
    scopes: POST_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawCreatedPost>>(req);
}

/**
 * Delete a post via `DELETE /2/tweets/:id` (docs/03 `x_post_delete`). A 404 (already
 * gone) surfaces here as the mapped `not-found` XError from api/errors; the TOOL layer
 * converts that into the idempotent success shape (POST-5) — no error interpretation
 * happens in this builder. `id` is an already-normalized bare numeric id.
 */
export async function deletePost(
  http: EndpointInvoker,
  params: { readonly id: string },
): Promise<RawSingleResponse<RawDeleteResult>> {
  const req: XApiRequest = {
    method: 'DELETE',
    path: `/2/tweets/${encodeURIComponent(params.id)}`,
    scopes: POST_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawDeleteResult>>(req);
}

/**
 * Hide or unhide a reply via `PUT /2/tweets/:id/hidden` (docs/03 `x_post_hide_reply`). The
 * target is the REPLY's own id, and the endpoint is authorized only for replies inside a
 * conversation the acting user started — a reply to somebody else's post comes back 403,
 * which the tool layer gives its ownership-specific meaning. `id` is an already-normalized
 * bare numeric id; `hidden` is the state to SET, not a toggle.
 */
export async function setReplyHidden(
  http: EndpointInvoker,
  params: { readonly id: string; readonly hidden: boolean },
): Promise<RawSingleResponse<RawHiddenState>> {
  const req: XApiRequest = {
    method: 'PUT',
    path: `/2/tweets/${encodeURIComponent(params.id)}/hidden`,
    body: { hidden: params.hidden },
    scopes: REPLY_MODERATION_SCOPES,
  };
  return http.send<RawSingleResponse<RawHiddenState>>(req);
}
