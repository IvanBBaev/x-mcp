// Post tools: reads (T-121) and writes (T-210). Each tool is DATA: a `defineTool` entry
// declaring its policy cell, availability, scopes, cost, MCP annotations, and a zod input
// schema, plus one handler that maps validated input -> endpoint call -> compact output.
// The registry (core/registry, T-115) enforces policy/budget/rate-limit around this.
//
// The write handlers additionally own the write-specific ERROR MEANING the generic
// status -> XError mapper (api/errors, frozen) cannot know: duplicate-403 (POST-3),
// too-long-400 (POST-2), gone-reply-target-400 (POST-7), and the write-ambiguity
// decoration for timeouts/5xx (POST-4 / NET-4) plus thread-resume guidance (POST-9).

import { z } from 'zod';

import {
  REPLY_SETTINGS,
  createPost,
  deletePost,
  getPosts,
  setReplyHidden,
} from '../api/endpoints/posts.js';
import type { RawCreatedPost } from '../api/endpoints/posts.js';
import { XError, forbiddenError, notFoundError, validationError } from '../core/errors.js';
import {
  RAW_MAX_RESULTS,
  capRawMaxResults,
  postUrl,
  rawSummary,
  renderPosts,
} from '../core/render.js';
import type { RawSingleResponse } from '../core/render.js';
import { parsePostId } from '../core/resolve.js';
import { defineTool } from '../core/tooldef.js';

const TITLE = 'Get posts';

/**
 * `x_post_get` — batch post lookup (docs/03 posts §). Accepts 1–100 references, each a
 * numeric post id or a full status URL; returns compacted posts plus a `missing[]` list for
 * ids that could not be fetched (deleted / protected / not found — REND-2). `raw: true`
 * bypasses compaction and returns the uncompacted, size-capped API envelope (REND-10).
 */
export const xPostGet = defineTool({
  name: 'x_post_get',
  title: TITLE,
  description:
    'Batch-fetch one or more X (Twitter) posts by numeric id or status URL (1-100 per ' +
    'call). Returns compacted posts (author handle, text, metrics, reply/quote refs, media) ' +
    'plus a `missing` list for any ids that could not be fetched (deleted, protected, or not ' +
    'found). Pass `raw: true` for the uncompacted, size-capped API envelope.',
  policy: 'read:content',
  availability: 'app+user',
  scopes: ['tweet.read', 'users.read'],
  cost: 'r:post',
  annotations: { title: TITLE, readOnlyHint: true, openWorldHint: true },
  phase: 1,
  input: z
    .object({
      ids: z
        .array(z.string().min(1))
        .min(1)
        .max(100)
        .describe(
          'Post references to fetch. Each is a numeric post id or a full status URL ' +
            '(e.g. https://x.com/user/status/123). 1-100 per call.',
        ),
      raw: z.boolean().optional(),
    })
    .strict(),
  handler: async (input, ctx) => {
    // Normalize every reference to a canonical numeric id. `parsePostId` throws a
    // `validation` error for a handle or garbage input — that propagates unchanged.
    // POST-8: duplicates are de-duplicated AFTER normalization (so a bare id and a
    // status URL of the same post collapse) and before the request is sent.
    const ids = [...new Set(input.ids.map(parsePostId))];
    const res = await getPosts(ctx.http, { ids });

    if (input.raw === true) {
      const all = res.data ?? [];
      const capped = all.slice(0, capRawMaxResults(all.length));
      const truncated = all.length > capped.length;
      return {
        data: { ...res, data: capped },
        summary: rawSummary(
          `${capped.length} raw post(s)${truncated ? ` (capped at ${RAW_MAX_RESULTS})` : ''}`,
        ),
      };
    }

    const batch = renderPosts(res);
    return {
      data: batch,
      summary: `${batch.items.length} post(s)${
        batch.missing?.length ? `, ${batch.missing.length} missing` : ''
      }`,
    };
  },
});

// --- Write helpers (T-210) --------------------------------------------------------

/** Base per-post price (docs/01 §3, mirrored by core/budget's COST_TABLE `w:post`). */
const BASE_POST_USD = 0.015;
/** COST-4: the raised per-post price X charges when the text carries a URL. */
const URL_POST_USD = 0.2;

/** POST-2: the platform's fixed weighted width of any URL, and the weighted limit. */
const URL_WEIGHT = 23;
const WEIGHTED_LIMIT = 280;

// COST-4: URL detection ERRS TOWARD WARNING — an explicit http(s):// URL, or anything
// shaped like a bare domain the platform's auto-linker could pick up (dotted labels with
// a 2+-letter TLD, optional path). A false positive (e.g. "node.js") merely over-warns;
// a miss would silently underquote the $0.20 price. Kept as a SOURCE string so call
// sites build fresh RegExp objects — no shared lastIndex state between `g` users.
const URL_PATTERN =
  'https?:\\/\\/\\S+|\\b[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9][a-z0-9-]*)*\\.[a-z]{2,}(?:\\/\\S*)?';

/** COST-4: does the text contain something X would price as a URL post? */
function containsUrl(text: string): boolean {
  return new RegExp(URL_PATTERN, 'i').test(text);
}

/**
 * POST-2: cheap ADVISORY weighted-length estimate — twitter-text is NOT embedded. Every
 * URL-ish token weighs the platform's fixed 23; everything else weighs its code-point
 * count. The X API stays authoritative; this number only decorates the mapped 400.
 */
function weightedLength(text: string): number {
  const collapsed = text.replace(new RegExp(URL_PATTERN, 'gi'), 'x'.repeat(URL_WEIGHT));
  return [...collapsed].length;
}

/**
 * POST-4 / NET-4: a transport failure or 5xx on a WRITE is ambiguous — the platform may
 * have applied the request before the failure. Both classes share one contract.
 */
function isAmbiguousWriteFailure(err: XError): boolean {
  return err.kind === 'network' || (err.kind === 'api' && (err.data.http_status ?? 0) >= 500);
}

// POST-4 / NET-4 guidance for a failed create. The safe probe deliberately does not
// depend on any paid timeline read; RATE-5: a write is never auto-retried.
const CREATE_AMBIGUITY_GUIDANCE =
  ' The post may nevertheless have been created — the failure happened after the request ' +
  'was sent, so the outcome is unknown (POST-4/NET-4). Do NOT auto-retry. The safe probe ' +
  'is re-issuing the IDENTICAL text once: success means the original never landed; a ' +
  'duplicate-content 403 means it did land. No paid timeline read is needed.';

// NET-4 guidance for a failed delete: re-issuing IS safe because deletion is idempotent
// from the agent's perspective (POST-5).
const DELETE_AMBIGUITY_GUIDANCE =
  ' The delete may nevertheless have been applied — the failure happened after the ' +
  'request was sent, so the outcome is unknown (NET-4). Re-issuing this delete is safe: ' +
  'deleting an already-deleted post reports success with `already_deleted: true` (POST-5).';

// POST-9: appended to ANY failed create that carried `reply_to_id`.
const THREAD_RESUME_GUIDANCE =
  ' Thread note: posts already created in this sequence remain live; resume by replying ' +
  'to the last successful id (POST-9) — do not restart the thread from the top.';

/**
 * Rebuild an `XError` with guidance appended, preserving kind/fix/data and chaining the
 * original as `cause`. `retryable` is set explicitly: ambiguous WRITE failures surface
 * as non-retryable so no machinery re-issues them blindly — the probe in the message is
 * a deliberate, interpreted act, not a retry (RATE-5).
 */
function withGuidance(err: XError, guidance: string, retryable: boolean): XError {
  return new XError(err.kind, err.message + guidance, {
    retryable,
    fix: err.fix,
    data: err.data,
    cause: err,
  });
}

/**
 * Give a failed `POST /2/tweets` its write-specific meaning (POST-2/3/4/7/9, NET-4).
 * The generic status -> XError mapping already happened in api/errors (frozen); this
 * narrows it using the platform's `title`/`detail` passed through in `data`.
 */
function mapCreateFailure(err: XError, hasReplyTo: boolean, text: string): XError {
  const platformText =
    `${err.data.platform_title ?? ''} ${err.data.platform_detail ?? ''}`.toLowerCase();
  let mapped = err;

  if (err.kind === 'forbidden' && platformText.includes('duplicate')) {
    // POST-3: the duplicate-403 is meaningful in itself AND is the ambiguity-resolution
    // signal for the POST-4 safe probe.
    mapped = forbiddenError(
      'X rejected this as a duplicate of a recent identical post (POST-3). If this call ' +
        'was the safe probe after an ambiguous create failure, the duplicate rejection ' +
        'means the original post DID land. Otherwise, change the text before posting again.',
      { data: err.data, cause: err },
    );
  } else if (
    err.kind === 'api' &&
    err.data.http_status === 400 &&
    /not visible/.test(platformText)
  ) {
    // POST-7: the reply/quote target is deleted or hidden — never a generic `api` error.
    mapped = notFoundError(
      'target post deleted or protected — verify the id/URL (POST-7). The referenced ' +
        'reply/quote target does not exist or is not visible to this account.',
      { data: err.data, cause: err },
    );
  } else if (
    err.kind === 'api' &&
    err.data.http_status === 400 &&
    platformText.includes('too long')
  ) {
    // POST-2: the platform's authoritative "too long" becomes a typed `validation` error
    // carrying our advisory weighted estimate.
    const weighed = weightedLength(text);
    const over = weighed - WEIGHTED_LIMIT;
    const hint =
      over > 0
        ? `Shorten by ~${over} characters and retry.`
        : "X's weighted count is authoritative; shorten the text and retry.";
    mapped = validationError(
      `X rejected the post as over the length limit: text weighs ~${weighed}/${WEIGHTED_LIMIT} — ` +
        `URLs count as ${URL_WEIGHT} characters (POST-2). ${hint}`,
      { data: err.data, cause: err },
    );
  } else if (isAmbiguousWriteFailure(err)) {
    // POST-4 / NET-4: decorate, never remap the class.
    mapped = withGuidance(err, CREATE_AMBIGUITY_GUIDANCE, false);
  }

  // POST-9: thread guidance rides on WHATEVER the failure became.
  if (hasReplyTo) {
    mapped = withGuidance(mapped, THREAD_RESUME_GUIDANCE, mapped.retryable);
  }
  return mapped;
}

// --- x_post_create ----------------------------------------------------------------

const CREATE_TITLE = 'Create post';

const createInput = z
  .object({
    text: z
      .string()
      .min(1)
      .describe(
        'The post text, sent byte-identical (no normalization or trimming). Note: a URL ' +
          'in the text raises the per-post cost to $0.20.',
      ),
    reply_to_id: z
      .string()
      .optional()
      .describe('Post this replies to: a numeric post id or a full status URL.'),
    quote_id: z
      .string()
      .optional()
      .describe('Post this quotes: a numeric post id or a full status URL.'),
    media_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(4)
      .optional()
      .describe(
        'Previously uploaded media ids, max 4. X allows up to 4 images OR a single ' +
          'video/GIF; media types are not knowable from bare ids, so the platform ' +
          'enforces the one-video rule. Mutually exclusive with poll.',
      ),
    poll: z
      .object({
        options: z
          .array(z.string().min(1).max(25))
          .min(2)
          .max(4)
          .describe('2-4 poll choices, each at most 25 characters.'),
        duration_minutes: z
          .number()
          .int()
          .min(5)
          .max(10080)
          .describe('Poll duration in minutes: 5 to 10080 (7 days).'),
      })
      .strict()
      .optional()
      .describe('Attach a poll. Mutually exclusive with media_ids.'),
    reply_settings: z
      .enum(REPLY_SETTINGS)
      .optional()
      .describe('Who may reply. Omit to allow everyone.'),
  })
  .strict();

/**
 * `x_post_create` — create a post (docs/03 posts §; POST-1..4/6/7/9, COST-4, NET-4).
 * The cost is a RESOLVER, not a static class: a URL in the text raises the per-post
 * price to $0.20 via the `CostEstimate.usd` override (COST-4), which core/budget's
 * `priceOf` honors over the table price.
 */
export const xPostCreate = defineTool({
  name: 'x_post_create',
  title: CREATE_TITLE,
  description:
    'X (Twitter): create a post — text, optional reply_to_id, quote_id, media_ids[], ' +
    'poll {options[], duration_minutes}, reply_settings. Returns id + URL. Note: a URL ' +
    'in the text raises the per-post cost to $0.20.',
  policy: 'write:content',
  availability: 'user-only',
  scopes: ['tweet.read', 'tweet.write', 'users.read'],
  cost: (input) =>
    containsUrl(input.text) ? { class: 'w:post', usd: URL_POST_USD } : { class: 'w:post' },
  annotations: {
    title: CREATE_TITLE,
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  phase: 2,
  input: createInput,
  handler: async (input, ctx) => {
    // POST-1: the ONLY local text rule is rejecting whitespace-only. Everything else is
    // sent byte-identical — no trim, no unicode normalization. What the user wrote posts.
    if (input.text.trim() === '') {
      throw validationError(
        'Post text is whitespace-only. Provide non-whitespace text (POST-1: it will be ' +
          'sent byte-identical, with no normalization or trimming).',
      );
    }
    // POST-6: composite constraints fail as typed validation errors BEFORE any HTTP.
    // (Poll shape, duration bounds, media count, and the reply_settings enum are already
    // enforced by the input schema; the cross-field exclusivity is checked here.)
    if (input.poll !== undefined && input.media_ids !== undefined) {
      throw validationError(
        'poll and media_ids are mutually exclusive — an X post carries a poll OR media, ' +
          'never both (POST-6). Drop one of the two and retry; the request was not sent.',
      );
    }

    // Reply/quote references accept a bare id or a full status URL; `parsePostId` throws
    // a typed `validation` error for anything else — still before any HTTP.
    const replyToId = input.reply_to_id !== undefined ? parsePostId(input.reply_to_id) : undefined;
    const quoteId = input.quote_id !== undefined ? parsePostId(input.quote_id) : undefined;

    let res: RawSingleResponse<RawCreatedPost>;
    try {
      res = await createPost(ctx.http, {
        text: input.text,
        ...(replyToId !== undefined ? { replyToId } : {}),
        ...(quoteId !== undefined ? { quoteId } : {}),
        ...(input.media_ids !== undefined ? { mediaIds: input.media_ids } : {}),
        ...(input.poll !== undefined
          ? {
              poll: {
                options: input.poll.options,
                durationMinutes: input.poll.duration_minutes,
              },
            }
          : {}),
        ...(input.reply_settings !== undefined ? { replySettings: input.reply_settings } : {}),
      });
    } catch (err) {
      if (XError.is(err)) throw mapCreateFailure(err, replyToId !== undefined, input.text);
      throw err;
    }

    const id = res.data?.id ?? '';
    const url = postUrl(id);
    // COST-4: the RESULT restates the raised URL-post price distinctly from the base
    // price (the budget meta shows only the number; this explains why it is higher).
    const data = {
      id,
      url,
      ...(containsUrl(input.text)
        ? {
            note:
              `The text contains a URL, so X prices this post at $${URL_POST_USD.toFixed(2)} ` +
              `instead of the $${BASE_POST_USD} base price (COST-4).`,
          }
        : {}),
    };
    return { data, summary: `Post created: ${url}` };
  },
});

// --- x_post_delete ----------------------------------------------------------------

const DELETE_TITLE = 'Delete post';

/**
 * `x_post_delete` — delete an own post (docs/03 posts §; POST-5, NET-4). Standalone by
 * design: destructive content deletion is NEVER hidden behind an action enum (docs/03
 * conventions), so a policy preset can deny exactly this tool. Idempotent from the
 * agent's perspective: a 404 renders as success with `already_deleted: true` (POST-5).
 */
export const xPostDelete = defineTool({
  name: 'x_post_delete',
  title: DELETE_TITLE,
  description:
    'X (Twitter): delete own post by id. Standalone (never behind an enum). Accepts a ' +
    'numeric post id or a full status URL. Deleting an already-deleted post reports ' +
    'success with `already_deleted: true` rather than an error.',
  policy: 'destructive:content',
  availability: 'user-only',
  scopes: ['tweet.read', 'tweet.write', 'users.read'],
  cost: 'w:action',
  annotations: {
    title: DELETE_TITLE,
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  phase: 2,
  input: z
    .object({
      id: z
        .string()
        .min(1)
        .describe('The post to delete: a numeric post id or a full status URL. Own posts only.'),
    })
    .strict(),
  handler: async (input, ctx) => {
    // Normalize a bare id or status URL; garbage throws typed validation before HTTP.
    const id = parsePostId(input.id);
    try {
      await deletePost(ctx.http, { id });
    } catch (err) {
      if (XError.is(err) && err.kind === 'not-found') {
        // POST-5: deleting an already-deleted post is SUCCESS, not an error — deletion
        // is idempotent from the agent's perspective.
        return {
          data: {
            id,
            deleted: true,
            already_deleted: true,
            note: 'The post was already gone; deletion is idempotent, so this reports success (POST-5).',
          },
          summary: `Post ${id} was already deleted.`,
        };
      }
      if (XError.is(err) && isAmbiguousWriteFailure(err)) {
        // NET-4 on a destructive write: decorate with the (delete-safe) ambiguity note.
        throw withGuidance(err, DELETE_AMBIGUITY_GUIDANCE, false);
      }
      throw err;
    }
    return { data: { id, deleted: true }, summary: `Post ${id} deleted.` };
  },
});

// --- x_post_hide_reply ------------------------------------------------------------

const HIDE_TITLE = 'Hide / unhide a reply';

// The 403 this endpoint returns has one dominant cause that the generic mapper cannot
// know: reply moderation is authorized only inside a conversation the acting user
// STARTED. Naming it saves the agent an otherwise inevitable second attempt.
const HIDE_FORBIDDEN_GUIDANCE =
  ' A reply can only be hidden by the author of the post that started the conversation, ' +
  "so this fails if the root post is not the authenticated account's. Check that " +
  '`reply_id` is a reply TO one of your own posts (not the root post itself, and not a ' +
  "reply in somebody else's thread), and that the token carries `tweet.moderate.write`.";

// NET-4 guidance: re-issuing is safe because the endpoint SETS a state rather than
// toggling it, so a repeated call converges on the same result (RATE-5 still forbids an
// automatic retry — the re-issue is a deliberate act).
const HIDE_AMBIGUITY_GUIDANCE =
  ' The change may nevertheless have been applied — the failure happened after the ' +
  'request was sent, so the outcome is unknown (NET-4). Re-issuing this call is safe: it ' +
  'sets an absolute state rather than toggling, so the result is the same either way.';

/**
 * `x_post_hide_reply` — hide or unhide a reply to own post (docs/03 posts §). The write
 * half of moderation: it sets an absolute state, so it is idempotent, and it is reversible,
 * so it merges into an action enum rather than staying standalone (docs/03 conventions —
 * the destructive-op rule covers irreversible deletion only).
 */
export const xPostHideReply = defineTool({
  name: 'x_post_hide_reply',
  title: HIDE_TITLE,
  description:
    'X (Twitter): hide or unhide a reply to one of your own posts. `reply_id` is the ' +
    "REPLY's own numeric id or status URL (not the root post); `action` selects `hide` or " +
    '`unhide`. Only works inside a conversation the authenticated account started. ' +
    'Reversible and idempotent — the result reports the resulting `hidden` state.',
  policy: 'write:moderation',
  availability: 'user-only',
  scopes: ['tweet.read', 'tweet.moderate.write', 'users.read'],
  cost: 'w:action',
  annotations: {
    title: HIDE_TITLE,
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  phase: 3,
  input: z
    .object({
      reply_id: z
        .string()
        .min(1)
        .describe(
          "The reply to hide or unhide: the REPLY's own numeric post id or status URL, " +
            'inside a conversation started by the authenticated account.',
        ),
      action: z.enum(['hide', 'unhide']).describe('Whether to hide or unhide the reply.'),
    })
    .strict(),
  handler: async (input, ctx) => {
    // Normalize BEFORE any network call (REND-8): a handle or garbage reference throws a
    // typed `validation` error here and no write is ever spent.
    const id = parsePostId(input.reply_id);
    const hidden = input.action === 'hide';
    let res;
    try {
      res = await setReplyHidden(ctx.http, { id, hidden });
    } catch (err) {
      if (XError.is(err) && err.kind === 'forbidden') {
        throw withGuidance(err, HIDE_FORBIDDEN_GUIDANCE, false);
      }
      if (XError.is(err) && isAmbiguousWriteFailure(err)) {
        throw withGuidance(err, HIDE_AMBIGUITY_GUIDANCE, false);
      }
      throw err;
    }
    // The 2xx envelope echoes the resulting state; if X omits it (DRIFT-1), the write
    // still succeeded, so fall back to the state the action requested.
    const resulting = res.data?.hidden ?? hidden;
    return {
      data: { post_id: id, url: postUrl(id), action: input.action, hidden: resulting },
      summary: hidden ? `Hid reply ${id}.` : `Unhid reply ${id}.`,
    };
  },
});

/** Every tool this module contributes to the registry. */
export const postsTools = [xPostGet, xPostCreate, xPostDelete, xPostHideReply];
