// The production registry gates (T-130). The registry (core/registry, T-113) runs every
// `tools/call` through PolicyGate → BudgetGate → RateLimitGate; this module adapts the real
// policy/budget/rate-limit modules onto those three collaborator interfaces. Kept free of
// `api/*` imports — the rate-limit gate takes its tracker STRUCTURALLY (`preflight` only)
// plus a tool→bucket-key mapping, so the api wiring stays in the composition (INT-3).

import type { BudgetGate, BudgetReservation, PolicyGate, RateLimitGate } from '../core/registry.js';
import type { SessionBudget } from '../core/budget.js';
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
 * Consequence (mandated by INT-2): a call that fails AFTER the check (rate-limit gate,
 * handler error) stays charged — the API attempt was paid for, so charge-at-check is the
 * honest accounting. The registry's "reserve on success" step becomes a read-back here.
 */
export function createBudgetGate(budget: SessionBudget): BudgetGate {
  const reserved = new WeakMap<CostEstimate, BudgetReservation>();
  return {
    check(estimate) {
      // Throws the typed `budget` XError in hard mode BEFORE any reservation (COST-1).
      reserved.set(estimate, budget.reserve(estimate));
    },
    reserve(estimate) {
      const meta = reserved.get(estimate);
      if (meta !== undefined) {
        reserved.delete(estimate);
        return meta;
      }
      // Defensive: unreachable through the registry pipeline (check always precedes
      // reserve); if a future caller skips check, charge now so nothing rides free.
      return budget.reserve(estimate);
    },
  };
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
