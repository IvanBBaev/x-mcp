// Post read tools (T-121). Each tool is DATA: a `defineTool` entry declaring its policy
// cell, availability, scopes, cost, MCP annotations, and a zod input schema, plus one
// handler that maps validated input -> endpoint call -> compact output. The registry
// (core/registry, T-115) enforces policy/budget/rate-limit around this; the handler only
// normalizes ids, calls the endpoint, and compacts the result (or returns a size-capped
// raw envelope when `raw: true`).

import { z } from 'zod';

import { getPosts } from '../api/endpoints/posts.js';
import { RAW_MAX_RESULTS, capRawMaxResults, renderPosts } from '../core/render.js';
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
    const ids = input.ids.map(parsePostId);
    const res = await getPosts(ctx.http, { ids });

    if (input.raw === true) {
      const all = res.data ?? [];
      const capped = all.slice(0, capRawMaxResults(all.length));
      const truncated = all.length > capped.length;
      return {
        data: { ...res, data: capped },
        summary: `${capped.length} raw post(s)${
          truncated ? ` (capped at ${RAW_MAX_RESULTS})` : ''
        }`,
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

/** Every tool this module contributes to the registry. */
export const postsTools = [xPostGet];
