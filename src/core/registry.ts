// core/registry.ts — the registry-as-data + the single request-pipeline choke point.
// Owned by T-113 (WP-1.3). References: docs/02 §5 (tool surface) & §6 (the pipeline);
// docs/04 §3.3 (denied-tool resolution, SEC-F10); docs/07 POL-1/POL-5/POL-7, MCP-4.
//
// TWO responsibilities behind ONE choke point (ARCH-F2 — enforcement lives here, never
// per-tool):
//
//   1. Registry-as-data. Tools are collected as `AnyToolDef` values, looked up by name,
//      and projected into an MCP-registration view whose annotations are DERIVED from the
//      policy class (MCP-4) and whose denied entries stay visible + annotated (POL-7).
//
//   2. The pipeline wrapper. Every `tools/call` runs the exact ordered gauntlet
//      (docs/02 §6): zod-validate input -> policy check -> budget check -> rate-limit
//      preflight -> invoke handler -> reserve credit -> attach ResultMeta. Nothing reaches
//      a handler except through this function.
//
// DECOUPLING: policy (T-111), budget (T-112) and rate-limit (T-115) are built in parallel,
// so this module does NOT import them. It depends on three small COLLABORATOR interfaces
// (PolicyGate / BudgetGate / RateLimitGate) injected at construction; production wires the
// real modules, tests wire fakes. `core` stays pure — all non-determinism/side-effects flow
// through `Ports`, the injected gates, and the `EndpointInvoker` from `ToolContext`.

import type { Ports } from './ports.js';
import { POLICY_CELLS } from './tooldef.js';
import type {
  AnyToolDef,
  CostEstimate,
  EndpointInvoker,
  Operation,
  ResultMeta,
  ToolAnnotations,
  ToolContext,
  ToolOutput,
} from './tooldef.js';
import { apiError, validationError, XError } from './errors.js';

// --- Injected collaborators (built by sibling tasks; wired by the integrator) --------

/**
 * Policy decision surface (real impl: core/policy, T-111). The registry never re-implements
 * two-axis resolution — it asks the gate. `denyError` OWNS the POL-7 / SEC-F10 message rule:
 * for a sensitive cell (`*:dm`, `destructive:*`, `*:social-graph`) it names the blocked cell
 * WITHOUT the env var/value that would unlock it; low-sensitivity cells (e.g.
 * `write:engagement`) MAY include the unlock hint. Keeping message construction inside the
 * gate is what stops a prompt injection from turning a denial into an escalation recipe.
 */
export interface PolicyGate {
  /** Active preset name (e.g. `read-only`) — appended to denied-tool descriptions (POL-7). */
  readonly preset: string;
  /** `X_MCP_HIDE_DENIED` — drop denied tools from the MCP listing entirely (POL-7). */
  readonly hideDenied: boolean;
  /** Is this tool's policy cell permitted under the resolved matrix? Pure, never throws. */
  isAllowed(tool: AnyToolDef): boolean;
  /** The typed `policy` XError for a denied tool — owns the POL-7 wording (no unlock leak). */
  denyError(tool: AnyToolDef): XError;
}

/** A per-call budget reservation (real impl: core/budget, T-112). Shapes ResultMeta (COST-3). */
export interface BudgetReservation {
  readonly cost_usd: number;
  readonly session_total_usd: number;
  readonly budget_warning?: string;
}

/**
 * Session credit budget (real impl: core/budget, T-112). `check` is the pre-flight gate
 * (pipeline step 3): in `hard` mode it throws the typed `budget` XError when reserving
 * `estimate` would cross the cap; in `warn` mode it never throws. `reserve` is the atomic
 * post-response accounting (step 6, COST-5 / CONC-2) that yields the per-call + session cost.
 */
export interface BudgetGate {
  check(estimate: CostEstimate): void;
  reserve(estimate: CostEstimate): BudgetReservation;
}

/**
 * Rate-limit preflight (real impl: api/ratelimit, T-115). Pipeline step 4: throws the typed
 * `rate-limit` XError when the tracked window for this tool's endpoint class is known to be
 * exhausted (RATE-2); a no-op otherwise. Header-driven table updates happen inside the
 * EndpointInvoker, out of the registry's sight.
 */
export interface RateLimitGate {
  preflight(tool: AnyToolDef): void;
}

/** The three process-scoped gates the pipeline enforces through. */
export interface RegistryDeps {
  readonly policy: PolicyGate;
  readonly budget: BudgetGate;
  readonly rateLimit: RateLimitGate;
}

// --- Per-call and projection shapes --------------------------------------------------

/** Per-call capabilities: the auth-scoped invoker + ports + optional cancellation signal. */
export interface CallContext {
  readonly ports: Ports;
  readonly http: EndpointInvoker;
  readonly signal?: AbortSignal;
}

/** The pipeline output: the handler's compact payload plus the always-present cost meta. */
export interface ToolResult {
  readonly data: unknown;
  readonly summary?: string;
  readonly meta: ResultMeta;
}

/**
 * An MCP-registration projection of a tool: the raw def, its DERIVED annotations (MCP-4),
 * and a denial-aware description (POL-7). This is what the MCP adapter (T-130) registers.
 */
export interface RegisteredTool {
  readonly def: AnyToolDef;
  readonly name: string;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly denied: boolean;
}

// --- Annotation derivation (MCP-4) ---------------------------------------------------

/**
 * Derive MCP annotations FROM THE POLICY CLASS (MCP-4), not from the tool's own declared
 * hints — the registry is the single source of truth, so a tool's advertised safety hints
 * can never drift from its classification. Rules:
 *   - `read:*`        -> readOnlyHint: true
 *   - `destructive:*` -> destructiveHint: true, idempotentHint: false (destructive & non-idempotent)
 *   - a merged `*_set` write -> idempotentHint: true (setting a state to a value is idempotent)
 *   - every tool -> openWorldHint: true (the X API is an open world)
 */
export function deriveAnnotations(tool: AnyToolDef): ToolAnnotations {
  const op = tool.policy.slice(0, tool.policy.indexOf(':')) as Operation;
  const base: ToolAnnotations = {
    title: tool.annotations.title,
    readOnlyHint: op === 'read',
    destructiveHint: op === 'destructive',
    openWorldHint: true,
  };
  if (op === 'destructive') return { ...base, idempotentHint: false };
  if (tool.name.endsWith('_set')) return { ...base, idempotentHint: true };
  return base;
}

// --- The registry --------------------------------------------------------------------

export interface Registry {
  /** All registered tools as raw data, in registration order. */
  all(): readonly AnyToolDef[];
  /** Look up a tool by its MCP name; `undefined` if absent. */
  get(name: string): AnyToolDef | undefined;
  /** Registered tool count — a tested number that guards against scope creep (docs/08). */
  readonly size: number;
  /**
   * The MCP-registration view: derived annotations (MCP-4); denied tools kept and annotated
   * "(disabled by policy `<preset>`)" (POL-7); and — under `X_MCP_HIDE_DENIED` — dropped
   * entirely (POL-7).
   */
  listForMcp(): readonly RegisteredTool[];
  /**
   * THE choke point (docs/02 §6, ARCH-F2). Runs one `tools/call` through the ordered gauntlet
   * and returns the compact payload + cost meta, or throws a typed XError at the first gate
   * that refuses. Nothing invokes a handler except this method.
   */
  call(name: string, rawInput: unknown, ctx: CallContext): Promise<ToolResult>;
}

/**
 * Build the registry from a list of tool defs and the injected gates. Structural invariants
 * (POL-1) are checked at construction so a mis-declared catalog fails fast, never silently at
 * call time.
 */
export function createRegistry(tools: readonly AnyToolDef[], deps: RegistryDeps): Registry {
  const byName = new Map<string, AnyToolDef>();
  for (const tool of tools) {
    // POL-1 (structural): a duplicate name or an unclassified policy cell is a wiring bug
    // surfaced at startup — a tool "missing classification" cannot register.
    if (byName.has(tool.name)) {
      throw new Error(`registry: duplicate tool name "${tool.name}"`);
    }
    if (!POLICY_CELLS.includes(tool.policy)) {
      throw new Error(`registry: tool "${tool.name}" has an unknown policy cell "${tool.policy}"`);
    }
    byName.set(tool.name, tool);
  }

  const listForMcp = (): readonly RegisteredTool[] => {
    const out: RegisteredTool[] = [];
    for (const def of tools) {
      const denied = !deps.policy.isAllowed(def);
      // POL-7: X_MCP_HIDE_DENIED removes denied tools from registration entirely.
      if (denied && deps.policy.hideDenied) continue;
      // POL-7: denied tools stay listed with a self-documenting "(disabled by policy ...)".
      const description = denied
        ? `${def.description} (disabled by policy \`${deps.policy.preset}\`)`
        : def.description;
      out.push({ def, name: def.name, description, annotations: deriveAnnotations(def), denied });
    }
    return out;
  };

  const call = async (name: string, rawInput: unknown, ctx: CallContext): Promise<ToolResult> => {
    const tool = byName.get(name);
    if (tool === undefined) {
      // An unknown tool name is a malformed request (the name is an argument).
      throw validationError(`Unknown tool "${name}".`);
    }

    // (1) zod-validate input -> typed `validation` error on failure (before any gate/side effect).
    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map(
          (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
        )
        .join('; ');
      throw validationError(`Invalid input for "${name}": ${detail}`);
    }
    const input: unknown = parsed.data;

    // (2) policy check (POL-1/POL-2/POL-7). Denied tools stay LISTED but the call is terminal;
    //     the gate owns the message so no unlock hint leaks for sensitive cells (SEC-F10).
    if (!deps.policy.isAllowed(tool)) {
      throw deps.policy.denyError(tool);
    }

    // (3) budget pre-flight — `hard` mode over cap -> typed `budget` error, nothing reserved.
    const estimate = resolveCost(tool, input);
    deps.budget.check(estimate);

    // (4) rate-limit preflight — a known-exhausted window -> typed `rate-limit` error.
    deps.rateLimit.preflight(tool);

    // (5) invoke the handler through its ToolContext (the only place a handler ever runs).
    const output = await invokeHandler(tool, input, buildToolContext(ctx));

    // (6) reserve the credit cost (atomic in the gate — COST-5 / CONC-2). Only successful
    //     calls are charged; a handler throw above short-circuits before this point.
    const reservation = deps.budget.reserve(estimate);

    // (7) attach ResultMeta (COST-3). Compaction/sanitization already happened inside the
    //     handler (core/render + sanitize, T-117); the registry only envelopes payload + cost.
    return buildResult(output, reservation);
  };

  return {
    all: () => tools,
    get: (name) => byName.get(name),
    get size() {
      return tools.length;
    },
    listForMcp,
    call,
  };
}

// --- Internals -----------------------------------------------------------------------

/** Resolve the per-call cost estimate from the (validated) input. */
function resolveCost(tool: AnyToolDef, input: unknown): CostEstimate {
  return typeof tool.cost === 'function' ? tool.cost(input) : { class: tool.cost };
}

/** Thread ports + the auth-scoped invoker + optional cancellation into a ToolContext. */
function buildToolContext(ctx: CallContext): ToolContext {
  return ctx.signal === undefined
    ? { ports: ctx.ports, http: ctx.http }
    : { ports: ctx.ports, http: ctx.http, signal: ctx.signal };
}

/**
 * Run the handler, letting already-typed XErrors propagate unchanged. A non-XError escaping
 * a handler is a bug: surface a generic `api` error WITHOUT the original message (which may
 * embed third-party text — REND-7) while preserving the cause for operator logs.
 */
async function invokeHandler(
  tool: AnyToolDef,
  input: unknown,
  toolCtx: ToolContext,
): Promise<ToolOutput> {
  try {
    return await tool.handler(input, toolCtx);
  } catch (err) {
    if (XError.is(err)) throw err;
    throw apiError(`Tool "${tool.name}" failed unexpectedly.`, { cause: err });
  }
}

/** Envelope the handler output with ResultMeta, honoring exactOptionalPropertyTypes. */
function buildResult(output: ToolOutput, reservation: BudgetReservation): ToolResult {
  const meta: ResultMeta =
    reservation.budget_warning === undefined
      ? { cost_usd: reservation.cost_usd, session_total_usd: reservation.session_total_usd }
      : {
          cost_usd: reservation.cost_usd,
          session_total_usd: reservation.session_total_usd,
          budget_warning: reservation.budget_warning,
        };
  return output.summary === undefined
    ? { data: output.data, meta }
    : { data: output.data, summary: output.summary, meta };
}
