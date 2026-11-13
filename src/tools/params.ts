// Shared wording for parameters that recur across tools (page_token, raw, max_results, the
// time bounds). Every host pays for the whole `tools/list` payload on every conversation
// (scripts/context-gate.mjs), and JSON Schema cannot share a definition across tools, so a
// sentence repeated in 17 schemas is paid 17 times. One terse source of truth keeps the
// wording identical everywhere and makes a trim land on every tool at once.

import type { z } from 'zod';

import { XError } from '../core/errors.js';
import { parsePostId } from '../core/resolve.js';

/** `page_token`: the cursor a paged read returned. */
export const PAGE_TOKEN_DESC = 'next_token from a previous call.';

/** `raw` on a paged read: the uncompacted envelope, capped by the renderer. */
export const RAW_PAGE_DESC = 'Return raw API JSON (max 25 items), not the compact page.';

/** `raw` on a counts read. */
export const RAW_HISTOGRAM_DESC = 'Return raw API JSON, not the compact histogram.';

/** `start_time` on a post read. */
export const START_TIME_DESC = 'Oldest post time (ISO-8601 UTC).';

/** `end_time` on a post read; REND-9 clamps it to `now - 10 s` (src/core/timebounds.ts). */
export const END_TIME_DESC = 'Newest post time (ISO-8601 UTC; clamped to 10 s ago at most).';

/** `since_id` on a post read: incremental polling from the newest id already seen. */
export const SINCE_ID_DESC =
  'Only posts newer than this post id or status URL; not with start_time.';

/**
 * Schema-level check for `since_id` (refused before the budget charge): it must be a post
 * id or status URL, and it is not combined with `start_time` — the two bound the same edge
 * of the window, so a caller gets one unambiguous lower bound.
 */
export function checkSinceId(
  input: { readonly since_id?: string | undefined; readonly start_time?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (input.since_id === undefined) return;
  if (input.start_time !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['since_id'],
      message: 'Pass since_id or start_time, not both: each sets the oldest edge of the window.',
    });
  }
  try {
    parsePostId(input.since_id);
  } catch (err) {
    if (!(err instanceof XError)) throw err;
    ctx.addIssue({ code: 'custom', path: ['since_id'], message: err.message });
  }
}

/** `start_time` on a counts read. */
export const BUCKET_START_TIME_DESC = 'Oldest bucket time (ISO-8601 UTC).';

/** `end_time` on a counts read; same REND-9 clamp. */
export const BUCKET_END_TIME_DESC =
  'Newest bucket time (ISO-8601 UTC; clamped to 10 s ago at most).';

/** `max_results`: the page size range; out-of-range values are clamped, not rejected. */
export function maxResultsDesc(min: number, max: number): string {
  return `Page size ${min}-${max} (clamped).`;
}
