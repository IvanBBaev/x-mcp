// Post endpoint wrappers (T-121). Thin, typed builders over the host-scoped
// `EndpointInvoker` (api/http, T-114): they translate typed args into an `XApiRequest`
// (path, query, required scopes) and return the RAW X API v2 envelope UNCOMPACTED — the
// compaction into agent-facing shapes is the tool layer's job (core/render, T-117). No
// I/O, auth, retry, or error mapping lives here; `http.send` owns all of that.

import type { EndpointInvoker, OAuthScope, XApiRequest } from '../../core/tooldef.js';
import type { RawListResponse, RawTweet } from '../../core/render.js';

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
