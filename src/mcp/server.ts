// The MCP protocol adapter (T-130; docs/02 §5). Builds the stdio-served MCP server over
// the tool registry. Deliberately the LOW-LEVEL SDK `Server`, not `McpServer`: the
// high-level API validates tool input itself and rejects with a protocol-level `McpError`
// BEFORE the callback, which would bypass the registry choke point (ARCH-F2) and its typed
// `validation` tool results. With raw `tools/list` / `tools/call` handlers, every call
// enters `registry.call` untouched and every deterministic failure renders as a structured
// tool result (`isError: true`), exactly as docs/02 §5 specifies.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';

import { XError } from '../core/errors.js';
import type { Ports } from '../core/ports.js';
import type { Registry } from '../core/registry.js';
import type { EndpointInvoker } from '../core/tooldef.js';
import { toolInputSchema } from './schema.js';
import { renderStructuredResult, toolOutputSchema } from './structured.js';

export const SERVER_NAME = 'x-mcp-ai';
/** Kept in sync with package.json manually — NodeNext offers no assert-free JSON import. */
export const SERVER_VERSION = '0.1.0';

/**
 * Server-level usage guidance (MCP-5): identifier forms, the pagination bridge, `raw`
 * semantics and cost, the policy model in one sentence, and the auth-status-first hint.
 */
export const INSTRUCTIONS =
  'Tools for the X (Twitter) API v2. Identifier forms: posts accept a numeric post id or a ' +
  'full x.com/twitter.com status URL; users accept a numeric id, an @handle, a bare handle, ' +
  'or the sentinel `me` (the authenticated account). Pagination: pass a previous result’s ' +
  '`next_token` as the next call’s `page_token` to fetch the following page. Read tools ' +
  'accept `raw: true` to return the uncompacted X API envelope instead of the compact ' +
  'shape — much larger output at the same per-call credit cost, so prefer the compact ' +
  'default. Tool access is governed by an operator-set policy preset: denied tools stay ' +
  'listed but are marked "(disabled by policy …)" and refuse calls with a typed `policy` ' +
  'error. Every result carries `meta.cost_usd` and `meta.session_total_usd` (advisory ' +
  'per-session credit accounting). In a session that will write or needs user context, call ' +
  '`x_auth_status` first to confirm the auth mode, granted scopes, and the policy matrix.';

/** What the protocol adapter needs from the composition (T-130). */
export interface McpServerDeps {
  readonly registry: Registry;
  readonly ports: Ports;
  /** The rate-limit-recording invoker for a tool's endpoint bucket (INT-3). */
  readonly invokerFor: (toolName: string) => EndpointInvoker;
}

/** Render a typed XError as a structured tool error result (docs/02 §5 — never a crash). */
function renderError(error: XError): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(error.toPayload()) }] };
}

/**
 * Construct the MCP server over the registry. Transport-agnostic — the composition root
 * connects stdio (production) or an in-memory pair (tests, MCP-2).
 */
export function buildMcpServer(deps: McpServerDeps): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  // tools/list — the registry's MCP view verbatim: derived annotations (MCP-4), the
  // denied-description suffix or hide-denied drop (POL-7), JSON-Schema inputs (MCP-2),
  // and the T-310 output schemas (REND-11). Advertising and rendering are wired in the
  // same change on purpose: the SDK client caches an advertised outputSchema and then
  // REQUIRES structuredContent on every non-error result for that tool.
  server.setRequestHandler(ListToolsRequestSchema, (): ListToolsResult => {
    return {
      tools: deps.registry.listForMcp().map((tool) => {
        const outputSchema = toolOutputSchema(tool.name);
        return {
          name: tool.name,
          description: tool.description,
          inputSchema: toolInputSchema(tool.def),
          ...(outputSchema !== undefined ? { outputSchema } : {}),
          annotations: tool.annotations,
        };
      }),
    };
  });

  // tools/call — raw arguments straight into the registry choke point.
  //
  // MCP-8: every value this handler touches is either a parameter or a fresh per-call local
  // (`name`, `args`, the CallContext literal). The adapter closes over `deps` only, which it
  // never mutates — there is no per-request global, no "current call" field, no shared
  // buffer. So N overlapping `tools/call` requests cannot cross-talk: each result is derived
  // solely from its own arguments, and the only shared state is behind the process-scoped
  // atomic gates (budget CONC-2, rate-limit table CONC-3) the registry enforces through.
  //
  // MCP-7: `extra.signal` is the SDK's per-request cancellation signal — it aborts when the
  // client sends notifications/cancelled for THIS request id (and when the connection
  // closes). Handing it to `registry.call` is the whole of the adapter's cancellation duty:
  // the registry binds it to the invoker, so it reaches every in-flight HTTP request the
  // call makes, on every tool.
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra): Promise<CallToolResult> => {
      const name = request.params.name;
      const args: unknown = request.params.arguments ?? {};
      try {
        const result = await deps.registry.call(name, args, {
          ports: deps.ports,
          http: deps.invokerFor(name),
          signal: extra.signal,
        });
        // Text block and structuredContent are built from the SAME render object
        // (REND-11 by construction); typed errors stay text-only (schemas cover success).
        return renderStructuredResult(result);
      } catch (error) {
        // Every deterministic failure leaves the registry as a typed XError and renders as
        // a tool result. Anything else is a wiring bug — let the SDK surface it as a
        // JSON-RPC internal error rather than disguising it as a tool outcome.
        if (XError.is(error)) return renderError(error);
        throw error;
      }
    },
  );

  return server;
}
