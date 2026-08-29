// zod → JSON-Schema conversion for `tools/list` (T-130). Uses the SDK's own compat
// converter (zod v4's built-in `toJSONSchema` behind the SDK's version-dispatching
// wrapper), so no new dependency is introduced and the emitted schemas match what the
// SDK's high-level server would advertise.

import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import type { AnyToolDef } from '../core/tooldef.js';

/**
 * Drop the safe-integer sentinel bounds zod v4's `toJSONSchema` stamps on every bare
 * `.int()` (±(2^53 − 1) — its runtime parse limit, not a contract of any tool). Left in,
 * they bloat every integer field in `tools/list` (the context budget pays for them on
 * every conversation) and render as a nonsense range in the generated docs. Explicit
 * `.min()`/`.max()` bounds are untouched — no real field uses these exact values.
 */
function stripSafeIntSentinels(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripSafeIntSentinels(item);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (record['minimum'] === Number.MIN_SAFE_INTEGER) delete record['minimum'];
  if (record['maximum'] === Number.MAX_SAFE_INTEGER) delete record['maximum'];
  for (const value of Object.values(record)) stripSafeIntSentinels(value);
}

/**
 * The `inputSchema` advertised for one tool. Every catalog tool declares a strict
 * `z.object(...)` input (the registry's parse contract), which is exactly the
 * object-schema shape MCP requires — the casts bridge the SDK's zod-version-erased
 * `AnyObjectSchema` alias, not any real shape difference.
 */
export function toolInputSchema(tool: AnyToolDef): Tool['inputSchema'] {
  const schema = toJsonSchemaCompat(tool.input as Parameters<typeof toJsonSchemaCompat>[0]);
  stripSafeIntSentinels(schema);
  return schema as Tool['inputSchema'];
}
