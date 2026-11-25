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
  'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id,' +
  'paid_partnership';
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
  /** Paid-promotion disclosure (X changelog 2026-06-03); sent only when `true`. */
  readonly paidPartnership?: boolean;
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
  return http.send<RawSingleResponse<RawCreatedPost>>(createPostRequest(params));
}

/**
 * The exact `POST /2/tweets` request {@link createPost} sends — shared with the dry-run
 * preview (Q14), so a preview can never drift from what a real call would send.
 */
export function createPostRequest(params: CreatePostParams): XApiRequest {
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
    ...(params.paidPartnership === true ? { paid_partnership: true } : {}),
  };
  return { method: 'POST', path: '/2/tweets', body, scopes: POST_WRITE_SCOPES };
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

// --- Articles (Q12; X changelog 2026-06-11) ------------------------------------------

/**
 * The block types {@link createArticleDraft} sends. X's `content_state` is DraftJS-shaped
 * and also documents `atomic`, but an atomic block only renders through an entity (image,
 * embedded post, divider, …), which this minimal surface does not build — so the tool
 * schema offers only the text blocks below. Single source of truth for the tool's `z.enum`.
 */
export const ARTICLE_BLOCK_TYPES = [
  'unstyled',
  'header-one',
  'header-two',
  'unordered-list-item',
  'ordered-list-item',
  'blockquote',
] as const;
export type ArticleBlockType = (typeof ARTICLE_BLOCK_TYPES)[number];

/** Parameters for {@link createArticleDraft}; `coverMediaId` is an uploaded image's id. */
export interface CreateArticleDraftParams {
  readonly title: string;
  readonly blocks: readonly { readonly text: string; readonly type: ArticleBlockType }[];
  readonly coverMediaId?: string;
}

/** The `POST /2/articles/draft` success payload (201). Read defensively (DRIFT-1). */
export interface RawArticleDraft {
  readonly id?: string;
  readonly title?: string;
}

/** The `POST /2/articles/:id/publish` success payload: the post the article became. */
export interface RawArticlePublished {
  readonly post_id?: string;
}

/**
 * Create a private Article draft via `POST /2/articles/draft` (docs/03 `x_article_draft_create`).
 * The body is `{title, content_state: {blocks, entities}, cover_media?}` (docs.x.com, fetched
 * 2026-11-20). Blocks carry only the documented required `text` + `type` (keys, inline
 * styles and entity ranges are optional and not built); `entities` is always empty. The
 * cover goes out as `{media_category: 'tweet_image', media_id}` — X's cover is an image
 * uploaded through the media upload endpoint. No validation lives here: the tool schema did it.
 */
export async function createArticleDraft(
  http: EndpointInvoker,
  params: CreateArticleDraftParams,
): Promise<RawSingleResponse<RawArticleDraft>> {
  const body: Record<string, unknown> = {
    title: params.title,
    content_state: {
      blocks: params.blocks.map((b) => ({ text: b.text, type: b.type })),
      entities: [],
    },
    ...(params.coverMediaId !== undefined
      ? { cover_media: { media_category: 'tweet_image', media_id: params.coverMediaId } }
      : {}),
  };
  const req: XApiRequest = {
    method: 'POST',
    path: '/2/articles/draft',
    body,
    scopes: POST_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawArticleDraft>>(req);
}

/**
 * Publish an Article draft via `POST /2/articles/:article_id/publish` (docs/03
 * `x_article_publish`). No request body; the response names the post the article became.
 * `articleId` is an already-validated 1-19 digit id.
 */
export async function publishArticle(
  http: EndpointInvoker,
  params: { readonly articleId: string },
): Promise<RawSingleResponse<RawArticlePublished>> {
  const req: XApiRequest = {
    method: 'POST',
    path: `/2/articles/${encodeURIComponent(params.articleId)}/publish`,
    scopes: POST_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawArticlePublished>>(req);
}
