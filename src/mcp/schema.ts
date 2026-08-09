// zod → JSON-Schema conversion for `tools/list` (T-130). Uses the SDK's own compat
// converter (which bundles zod-to-json-schema for the zod-v3 line this project pins), so
// no new dependency is introduced and the emitted schemas match what the SDK's high-level
// server would advertise.

import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import type { AnyToolDef } from '../core/tooldef.js';

/**
 * The `inputSchema` advertised for one tool. Every catalog tool declares a strict
 * `z.object(...)` input (the registry's parse contract), which is exactly the
 * object-schema shape MCP requires — the casts bridge the SDK's zod-version-erased
 * `AnyObjectSchema` alias, not any real shape difference.
 */
export function toolInputSchema(tool: AnyToolDef): Tool['inputSchema'] {
  const schema = toJsonSchemaCompat(tool.input as Parameters<typeof toJsonSchemaCompat>[0]);
  return schema as Tool['inputSchema'];
}
