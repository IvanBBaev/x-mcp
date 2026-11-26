// The production registry gates (T-130). The registry (core/registry, T-113) runs every
// `tools/call` through PolicyGate → BudgetGate → RateLimitGate; this module adapts the real
// policy/budget/rate-limit modules onto those three collaborator interfaces. Kept free of
// `api/*` imports — the rate-limit gate takes its tracker STRUCTURALLY (`preflight` only)
// plus a tool→bucket-key mapping, so the api wiring stays in the composition (INT-3).

import type {
  BudgetGate,
  BudgetQuote,
  BudgetReservation,
  PolicyGate,
  RateLimitGate,
} from '../core/registry.js';
import type { SessionBudget, SpendByTool } from '../core/budget.js';
import type { LedgerReservation, SpendLedger } from '../core/ledger.js';
import { deniedToolError, isCellAllowed } from '../core/policy.js';
import type { ResolvedPolicy } from '../core/policy.js';
import type { AnyToolDef, CostEstimate } from '../core/tooldef.js';
import type { XError } from '../core/errors.js';

/** Adapt a resolved policy (core/policy, T-111) onto the registry's PolicyGate seam. */
export function createPolicyGate(policy: ResolvedPolicy, hideDenied: boolean): PolicyGate {
  return {
    preset: policy.preset,
    hideDenied,
    isAllowed: (tool) => isCellAllowed(policy, tool.policy),
    denyError: (tool) => deniedToolError(tool.policy, policy.preset),
  };
}

/**
 * Adapt the session budget (core/budget, T-112) onto the registry's two-step BudgetGate.
 *
 * INT-2 — the budget must be charged ATOMICALLY at check time. `SessionBudget.reserve` is
 * the single synchronous check-and-reserve (CONC-2); splitting it into a passive `check`
 * followed by a post-handler `reserve` would reopen the interleaving window the budget
 * module closes. So `check` performs the real reservation, and `reserve` merely returns the
 * meta already reserved for that call. The two steps are correlated by the OBJECT IDENTITY
 * of the `CostEstimate`: the registry resolves one fresh estimate per call and passes the
 * SAME object to both `check` and `reserve`, so a WeakMap keyed by it is race-free under
 * parallel `tools/call` (MCP-8) with zero edits to the frozen pipeline.
 *
 * Consequence (mandated by INT-2): a call that fails AFTER the check (handler error, a 429
 * from X) stays charged — the API attempt was paid for, so charge-at-check is the honest
 * accounting. A local rate-limit refusal (RATE-2) is NOT charged: the registry runs that
 * preflight before `check`, and no request leaves the process. Nor is a handler that
 * refuses locally before sending its first request (MEDIA-5's path battery): the registry
 * calls `release`, which settles the held reservation to $0. The registry's post-handler `reserve` becomes a read-back here.
 *
 * SETTLEMENT (COST-3): the check-time reservation prices ONE resource, because how many
 * the response will carry is unknowable before it arrives. When the handler reports a real
 * count, `reserve` settles the held reservation to `unit price × units` — a refund for a
 * page shorter than asked for, a top-up for a full one. `settle` never throws, so a hard-mode
 * budget that the settled price pushes past the cap reports a warning rather than failing a
 * call whose resources the platform has already delivered (the money is spent either way).
 *
 * PERSISTED LEDGER (Q15, docs/07 §21): when the operator configured one, every charge also
 * goes through the daily/monthly ledger, in the same synchronous step. Order matters for
 * "charge before refuse is a bug": the session budget is QUOTED first (its hard refusal
 * moves nothing), then the ledger reserves (its hard refusal moves nothing either — the
 * session budget has not been charged yet), and only then is the session budget charged.
 * Settle and release move the ledger by the same difference as the session ledger.
 */
export function createBudgetGate(
  budget: SessionBudget,
  spend?: Pick<SpendByTool, 'record'>,
  ledger?: SpendLedger,
): BudgetGate & {
  release(estimate: CostEstimate): void;
  quote(estimate: CostEstimate): BudgetQuote;
} {
  // Each held reservation remembers the tool it was taken for, so every later move of the
  // session ledger (settle, release) is mirrored onto the same tool's share.
  const reserved = new WeakMap<
    CostEstimate,
    { meta: BudgetReservation; tool?: string; ledger?: LedgerReservation }
  >();
  const attribute = (tool: string | undefined, deltaUsd: number): void => {
    if (tool !== undefined) spend?.record(tool, deltaUsd);
  };
  /** Charge the session budget and the ledger as one synchronous step (CONC-2). */
  const charge = (cost: CostEstimate): { meta: BudgetReservation; ledger?: LedgerReservation } => {
    if (ledger === undefined) return { meta: budget.reserve(cost) };
    // Session hard refusal first, while nothing has moved (COST-1)…
    const projected = budget.quote(cost);
    // …then the ledger's (LEDGER-3); it writes only when it does not refuse…
    const persisted = ledger.reserve(projected.cost_usd, cost.note);
    // …and only then the session charge, which can no longer refuse.
    const meta = withLedgerWarning(budget.reserve(cost), persisted.warning);
    return { meta, ledger: persisted.reservation };
  };
  return {
    check(estimate, tool) {
      // Throws the typed `budget` XError in hard mode BEFORE any reservation (COST-1).
      const { meta, ledger: held } = charge(estimate);
      reserved.set(estimate, {
        meta,
        ...(tool !== undefined ? { tool } : {}),
        ...(held !== undefined ? { ledger: held } : {}),
      });
      attribute(tool, meta.cost_usd);
    },
    reserve(estimate, units) {
      const held = reserved.get(estimate);
      if (held !== undefined) {
        reserved.delete(estimate);
        if (units === undefined) return held.meta;
        const settled = budget.settle(held.meta, { ...estimate, units });
        attribute(held.tool, settled.cost_usd - held.meta.cost_usd);
        if (ledger === undefined || held.ledger === undefined) return settled;
        // LEDGER-4: the ledger moves by the same difference, dated to the reservation.
        return withLedgerWarning(settled, ledger.settle(held.ledger, settled.cost_usd).warning);
      }
      // Defensive: unreachable through the registry pipeline (check always precedes
      // reserve); if a future caller skips check, charge now so nothing rides free.
      return charge(units === undefined ? estimate : { ...estimate, units }).meta;
    },
    quote(estimate) {
      // Q14 dry run: the same pricing and hard-mode refusals as `check`, but nothing is
      // reserved, held, attributed or persisted (LEDGER-9).
      const projected = budget.quote(estimate);
      const warning =
        ledger === undefined ? undefined : ledger.quote(projected.cost_usd, estimate.note).warning;
      return { projected: withLedgerWarning(projected, warning), total: budget.total() };
    },
    release(estimate) {
      const held = reserved.get(estimate);
      if (held === undefined) return;
      reserved.delete(estimate);
      // Settle to the $0 `local` price: the ledger moves by minus exactly what this call
      // held, never by overwriting a total another call moved in between (CONC-2).
      budget.settle(held.meta, 'local');
      attribute(held.tool, -held.meta.cost_usd);
      if (ledger !== undefined && held.ledger !== undefined) ledger.settle(held.ledger, 0);
    },
  };
}

/** Append the ledger's warning to the session meta's own (`budget_warning` is one string). */
function withLedgerWarning(
  meta: BudgetReservation,
  warning: string | undefined,
): BudgetReservation {
  if (warning === undefined) return meta;
  const merged = meta.budget_warning !== undefined ? `${meta.budget_warning} ${warning}` : warning;
  return { ...meta, budget_warning: merged };
}

/** The read side of the rate-limit tracker the gate needs (api/ratelimit, structurally). */
export interface RateLimitPreflight {
  preflight(key: string): XError | null;
}

/**
 * Adapt the rate-limit tracker onto the registry's RateLimitGate (INT-3). The registry
 * hands the gate a TOOL; the tracker speaks BUCKET KEYS (`endpointClass#authContext`), so
 * the composition supplies `keyFor` — its explicit tool→bucket map lives next to the
 * per-bucket http clients that feed the tracker. `null` marks a local-only tool (no
 * network, nothing to preflight).
 */
export function createRateLimitGate(
  tracker: RateLimitPreflight,
  keyFor: (tool: AnyToolDef) => string | null,
): RateLimitGate {
  return {
    preflight(tool) {
      const key = keyFor(tool);
      if (key === null) return;
      const error = tracker.preflight(key);
      if (error !== null) throw error; // typed `rate-limit` XError (RATE-2)
    },
  };
}
