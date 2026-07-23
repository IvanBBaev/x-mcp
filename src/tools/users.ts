// The `x_user_get` tool (docs/03 tool catalog; read:user / app+user / r:user, P1). Owned by
// T-122. A batch profile lookup that accepts a mixed list of numeric ids, `@handle`/handle
// forms, and the `me` self-sentinel, fires only the endpoints it needs (concurrently), and
// merges the results into one `BatchResult<CompactUser>` — de-duped by id, with any
// unresolved reference surfaced in `missing[]` (REND-2). `raw: true` bypasses compaction and
// returns the merged raw envelope, size-capped (REND-10).

import { z } from 'zod';

import { defineTool } from '../core/tooldef.js';
import { capRawMaxResults, renderUsers } from '../core/render.js';
import type { RawListResponse, RawUser } from '../core/render.js';
import type { BatchResult, CompactUser, Missing } from '../core/render-shapes.js';
import { classifyUserRef } from '../core/resolve.js';
import { getMe, getUsersByIds, getUsersByUsernames } from '../api/endpoints/users.js';

export const xUserGet = defineTool({
  name: 'x_user_get',
  title: 'Get users',
  description:
    'Batch fetch of X (Twitter) user profiles by numeric id, @handle, bare handle, or the ' +
    'sentinel `me` (the authenticated user). Returns compact profiles (handle, name, bio, ' +
    'metrics, created) plus a `missing` list for any reference that could not be resolved.',
  policy: 'read:user',
  availability: 'app+user',
  scopes: ['users.read'],
  cost: 'r:user',
  annotations: { title: 'Get users', readOnlyHint: true, openWorldHint: true },
  phase: 1,
  input: z
    .object({
      users: z
        .array(z.string().min(1))
        .min(1)
        .max(100)
        .describe("user id, @handle, handle, or 'me'"),
      raw: z.boolean().optional(),
    })
    .strict(),
  handler: async (input, ctx) => {
    // Partition the mixed references into the three endpoint groups (pure, sync — a malformed
    // reference throws a `validation` XError here, before any network call).
    const ids: string[] = [];
    const handles: string[] = [];
    let wantsMe = false;
    for (const ref of input.users) {
      const classified = classifyUserRef(ref);
      if (classified.kind === 'id') ids.push(classified.id);
      else if (classified.kind === 'handle') handles.push(classified.handle);
      else wantsMe = true;
    }

    // Fire only the endpoints that have work, concurrently.
    const [byIds, byHandles, meRes] = await Promise.all([
      ids.length > 0 ? getUsersByIds(ctx.http, ids) : undefined,
      handles.length > 0 ? getUsersByUsernames(ctx.http, handles) : undefined,
      wantsMe ? getMe(ctx.http) : undefined,
    ]);

    // raw: true → the merged, uncompacted envelope, capped at the endpoint maximum (REND-10).
    if (input.raw === true) {
      const rawUsers: RawUser[] = [];
      if (byIds?.data !== undefined) rawUsers.push(...byIds.data);
      if (byHandles?.data !== undefined) rawUsers.push(...byHandles.data);
      if (meRes?.data !== undefined) rawUsers.push(meRes.data);
      const errors = [
        ...(byIds?.errors ?? []),
        ...(byHandles?.errors ?? []),
        ...(meRes?.errors ?? []),
      ];
      const capped = rawUsers.slice(0, capRawMaxResults(rawUsers.length));
      const envelope: RawListResponse<RawUser> = {
        data: capped,
        ...(errors.length > 0 ? { errors } : {}),
      };
      return { data: envelope, summary: `${capped.length} raw user record(s)` };
    }

    // Compact each response, concatenating items + missing and de-duping items by id.
    const items: CompactUser[] = [];
    const missing: Missing[] = [];
    const seen = new Set<string>();
    const addBatch = (batch: BatchResult<CompactUser>): void => {
      for (const user of batch.items) {
        if (user.id !== '' && seen.has(user.id)) continue;
        if (user.id !== '') seen.add(user.id);
        items.push(user);
      }
      for (const entry of batch.missing ?? []) missing.push(entry);
    };

    if (byIds !== undefined) addBatch(renderUsers(byIds));
    if (byHandles !== undefined) addBatch(renderUsers(byHandles));
    if (meRes !== undefined) {
      // Wrap the single `me` response as a one-item list so `renderUsers` compacts it uniformly.
      const meList: RawListResponse<RawUser> = {
        ...(meRes.data !== undefined ? { data: [meRes.data] } : {}),
        ...(meRes.errors !== undefined ? { errors: meRes.errors } : {}),
      };
      addBatch(renderUsers(meList));
    }

    // exactOptionalPropertyTypes: only include `missing` when there is something to report.
    const batch: BatchResult<CompactUser> = missing.length > 0 ? { items, missing } : { items };
    const summary = `${items.length} user(s)${
      missing.length > 0 ? `, ${missing.length} missing` : ''
    }`;
    return { data: batch, summary };
  },
});

export const usersTools = [xUserGet];
