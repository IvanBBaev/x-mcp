// ToolDef — the registry-as-data contract (docs/02 §5, §6). FROZEN; owned by T-102.
//
// A tool is DATA, not a bespoke handler wired by hand: each entry declares its policy
// cell, availability class, OAuth scopes, cost class, MCP annotations, and a zod input
// schema, plus one async handler. The registry (core/registry, T-115) is the single
// choke point — it validates input, checks policy → budget → rate-limit, invokes the
// handler through the endpoint layer, then reserves credit and renders. Nothing here
// does I/O; the handler receives its capabilities via `ToolContext`.
//
// `zod` is imported as a TYPE only (the runtime schema VALUES come from each tool
// module); this keeps `core/tooldef` dependency-light and erasable.

import type { z } from 'zod';
import type { Ports } from './ports.js';

// --- Axes (const-unions so config/validation can enumerate them) -----------------

/** Account-gating class (docs/01 §3.2). Only the last three are gated by X_MCP_AVAILABILITY. */
export const AVAILABILITY_CLASSES = [
  'app+user',
  'user-only',
  'pilot',
  'premium-user',
  'enterprise',
] as const;
export type AvailabilityClass = (typeof AVAILABILITY_CLASSES)[number];

/** Policy operation axis (docs/04 §3). `destructive` is a strictly higher bar than `write`. */
export const OPERATIONS = ['read', 'write', 'destructive'] as const;
export type Operation = (typeof OPERATIONS)[number];

/** Policy domain axis (docs/03 class column ∪ docs/04 §3 presets). */
export const DOMAINS = [
  'content',
  'user',
  'account',
  'engagement',
  'social-graph',
  'moderation',
  'dm',
] as const;
export type Domain = (typeof DOMAINS)[number];

/**
 * The 12 valid policy cells (`operation:domain`). This is the authoritative set POL-6
 * lists when refusing an unknown cell. Not every operation×domain combination is a real
 * cell — only these are. Sensitive cells (`*:dm`, `destructive:*`, `*:social-graph`)
 * never leak their unlock env var in a `policy` error (POL-7 / SEC-F10).
 */
export const POLICY_CELLS = [
  'read:content',
  'read:user',
  'read:account',
  'read:social-graph',
  'read:dm',
  'write:content',
  'write:engagement',
  'write:moderation',
  'write:social-graph',
  'write:dm',
  'destructive:content',
  'destructive:social-graph',
] as const;
export type PolicyClass = (typeof POLICY_CELLS)[number];

/**
 * Indicative pay-per-use cost bucket (docs/03 legend; authoritative USD table in
 * docs/01 §3, owned by core/budget T-112). `local` spends nothing; `w:post` is
 * $0.015 but $0.20 when the post carries a URL — hence `CostSpec` below can resolve a
 * per-call override.
 */
export const COST_CLASSES = [
  'local',
  'owned',
  'r:post',
  'r:user',
  'r:follows',
  'r:list',
  'r:engage',
  'r:dm',
  'w:post',
  'w:dm',
  'w:list',
  'w:action',
] as const;
export type CostClass = (typeof COST_CLASSES)[number];

/**
 * Known X OAuth 2.0 scopes a tool may require. Kept as an explicit union for typo-safety
 * across ~50 tool definitions; extending the X surface means adding the scope here first
 * (a frozen-contract change that goes through the integrator).
 */
export const X_OAUTH_SCOPES = [
  'tweet.read',
  'tweet.write',
  'tweet.moderate.write',
  'users.read',
  'users.email',
  'follows.read',
  'follows.write',
  'offline.access',
  'space.read',
  'mute.read',
  'mute.write',
  'like.read',
  'like.write',
  'list.read',
  'list.write',
  'block.read',
  'block.write',
  'bookmark.read',
  'bookmark.write',
  'dm.read',
  'dm.write',
  'media.write',
] as const;
export type OAuthScope = (typeof X_OAUTH_SCOPES)[number];

// --- Handler-side contract -------------------------------------------------------

/**
 * A single low-level X API request. The endpoint layer (api/endpoints, T-119) builds
 * these from typed args; `send` injects host-scoped auth, handles the 401-once refresh,
 * updates the rate-limit table, and maps errors to `XError`. `scopes` lets `send`
 * pick the right token and produce a precise `scope` error on a 403.
 */
export interface XApiRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path under the API base, e.g. `/2/tweets`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  /** OAuth scopes this endpoint requires. */
  readonly scopes?: readonly OAuthScope[];
}

/** The host-scoped endpoint invoker a handler calls. Implemented in api/http (T-114). */
export interface EndpointInvoker {
  send<T>(req: XApiRequest): Promise<T>;
}

/**
 * Everything a handler is allowed to touch. The pipeline has ALREADY enforced policy,
 * budget, and rate limits before the handler runs, and reserves credit AFTER — so a
 * handler only maps validated input → API call → compact output. No config, budget, or
 * clock access leaks in beyond the ports.
 */
export interface ToolContext {
  readonly ports: Ports;
  readonly http: EndpointInvoker;
  /** Cooperative cancellation from the MCP host. */
  readonly signal?: AbortSignal;
}

/** What a handler returns: the agent-facing structured payload plus an optional summary. */
export interface ToolOutput {
  /** JSON-serializable result — a CompactPost, `Page<CompactUser>`, `{ ok: true }`, … */
  readonly data: unknown;
  /** Optional one-line human summary; the adapter still renders `data`. */
  readonly summary?: string;
}

/** The per-result cost meta the pipeline attaches to EVERY tool result (docs/02 §5.2). */
export interface ResultMeta {
  /** USD this call reserved. */
  readonly cost_usd: number;
  /** Running session spend after this call. */
  readonly session_total_usd: number;
  /** Present at ≥90% of the credit budget (BUDGET warn threshold). */
  readonly budget_warning?: string;
}

export type ToolHandler<I> = (input: I, ctx: ToolContext) => Promise<ToolOutput>;

/** A resolved per-call cost. `usd` overrides the class→table lookup (e.g. w:post with URL). */
export interface CostEstimate {
  readonly class: CostClass;
  readonly usd?: number;
}

/** A tool's cost: a static class, or an input-dependent resolver (for the URL-post case). */
export type CostSpec<I> = CostClass | ((input: I) => CostEstimate);

/**
 * MCP tool annotations (hints for the host UI). `title` is required; the hints are
 * derived from the policy class (a `read:*` tool is readOnly, a `destructive:*` tool is
 * destructive & non-idempotent) but declared explicitly so they stay auditable.
 */
export interface ToolAnnotations {
  readonly title: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/**
 * The frozen tool contract. One object per tool; the registry collects them as data.
 * `I` is inferred from `input` via `defineTool`.
 */
export interface ToolDef<I = unknown> {
  /** Public MCP tool name, e.g. `x_post_get`. Unique across the registry. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** Policy cell governing this tool. */
  readonly policy: PolicyClass;
  /** Account-gating class. */
  readonly availability: AvailabilityClass;
  /** OAuth scopes the handler's API calls require. */
  readonly scopes: readonly OAuthScope[];
  /** Cost class or per-call resolver. */
  readonly cost: CostSpec<I>;
  readonly annotations: ToolAnnotations;
  /** Validated input schema; the registry runs it before the handler. */
  readonly input: z.ZodType<I>;
  readonly handler: ToolHandler<I>;
  /** Roadmap phase gating registration (docs/08). */
  readonly phase: 1 | 2 | 3;
  /** True for a tool registered only when a precondition holds (e.g. x_usage_get, WP-3.11). */
  readonly conditional?: boolean;
}

/** The registry holds heterogeneous tools; input types are erased at the collection boundary. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any>;

/**
 * Ergonomic constructor: infers the handler/cost input type from the zod schema so a
 * tool module writes its schema once. Returns the same object, typed.
 */
export function defineTool<S extends z.ZodType>(def: {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly policy: PolicyClass;
  readonly availability: AvailabilityClass;
  readonly scopes: readonly OAuthScope[];
  readonly cost: CostSpec<z.infer<S>>;
  readonly annotations: ToolAnnotations;
  readonly input: S;
  readonly handler: ToolHandler<z.infer<S>>;
  readonly phase: 1 | 2 | 3;
  readonly conditional?: boolean;
}): ToolDef<z.infer<S>> {
  return def;
}
