// core/budget.ts — the session credit budget with atomic check-and-reserve.
// Owned by T-112 (WP-1.2). Pure and in-process: the running spend counter lives in memory
// for the life of the process and resets on restart. It is priced from a static per-endpoint
// cost table and never seeds from a usage API — per-process, advisory accounting, not a hard
// platform ledger (docs/01 §3.4, docs/02 §7; COST-2, OPS-F10). `core` does no I/O, so this
// module takes no ports; a session budget is time-independent (no Clock needed).
//
// The load-bearing invariant is CONC-2: check-and-reserve is a SINGLE SYNCHRONOUS step.
// `reserve` runs the threshold check and the counter increment with no `await` between them,
// so the event loop can never interleave two concurrently-scheduled tool calls at the
// boundary — this is a check-and-reserve, never a check-then-spend (docs/02 §7, CONC-2).

import { budgetError } from './errors.js';
import type { CostClass, CostEstimate, ResultMeta } from './tooldef.js';

/** Budget enforcement mode (env `X_MCP_BUDGET_MODE`). `warn` never blocks; `hard` refuses. */
export type BudgetMode = 'warn' | 'hard';

/**
 * The authoritative per-class USD price table. Values are the pay-per-use rates verified
 * 2026-07-22 (docs/01 §3.1 + Appendix B) and agree with docs/03's cost-class legend. These
 * are UNIT prices: reads are billed per resource returned, writes per request. For a
 * multi-resource read the registry multiplies the unit price by the response count and hands
 * the product to `reserve` as a `CostEstimate.usd` override (same mechanism as the URL-post
 * $0.20 line, COST-4) — so this table only ever holds the single-unit price.
 *
 *  - `local`     $0      in-process only, no X API spend
 *  - `owned`     $0.001  own-data read ("Owned Reads" discount)
 *  - `r:post`    $0.005  per post returned
 *  - `r:user`    $0.010  per user returned
 *  - `r:follows` $0.010  per follower/following resource
 *  - `r:list`    $0.005  per list / space / trend resource
 *  - `r:engage`  $0.001  per like/mute/block resource read
 *  - `r:dm`      $0.010  per DM event returned
 *  - `w:post`    $0.015  per post created ($0.20 when the text carries a URL — COST-4, via
 *                        the `CostEstimate.usd` override; the class base stays $0.015)
 *  - `w:dm`      $0.015  per DM sent
 *  - `w:list`    $0.010  per list created
 *  - `w:action`  $0      engagement / social-graph / moderation writes, deletes, media:
 *                        unpriced on the pricing page (2026-07-22); counted $0 locally until
 *                        the Phase 1 live capture confirms the real rate (docs/01 App. B, COST-6)
 */
export const COST_TABLE: Readonly<Record<CostClass, number>> = {
  local: 0,
  owned: 0.001,
  'r:post': 0.005,
  'r:user': 0.01,
  'r:follows': 0.01,
  'r:list': 0.005,
  'r:engage': 0.001,
  'r:dm': 0.01,
  'w:post': 0.015,
  'w:dm': 0.015,
  'w:list': 0.01,
  'w:action': 0,
};

/** A per-call cost the registry hands the budget: a bare class, or a resolved estimate. */
export type ResolvedCost = CostClass | CostEstimate;

/** Tolerance for the boundary comparisons so binary-float noise can't misjudge the cap. */
const EPSILON = 1e-9;
/** Warn once the running total reaches this fraction of the cap (COST-5: 90%). */
const WARN_FRACTION = 0.9;

/** Round to 6 dp so reported totals stay free of binary-float tails (0.1 + 0.2 = 0.300…04). */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function formatUsd(n: number): string {
  return `$${round6(n)}`;
}

/**
 * Price a resolved cost in USD. A `CostEstimate.usd` override wins over the table lookup —
 * this is how a URL-bearing post is priced at $0.20 rather than the $0.015 base (COST-4) and
 * how a count-multiplied read is priced (unit price × resources). A non-finite or negative
 * override is ignored in favour of the table price (defensive).
 */
export function priceOf(cost: ResolvedCost): number {
  if (typeof cost === 'string') return COST_TABLE[cost];
  const { class: cls, usd } = cost;
  if (usd !== undefined && Number.isFinite(usd) && usd >= 0) return usd;
  return COST_TABLE[cls];
}

/** Options for {@link createSessionBudget}. */
export interface SessionBudgetOptions {
  /** Operator-set cap in USD (env `X_MCP_CREDIT_BUDGET`). Undefined → no cap (COST-1). */
  readonly limit?: number;
  /** `warn` (default) | `hard` (env `X_MCP_BUDGET_MODE`). */
  readonly mode?: BudgetMode;
}

/** The session credit budget: an atomic counter over the process lifetime. */
export interface SessionBudget {
  /** The operator-set cap in USD, or `undefined` when uncapped. */
  readonly limit: number | undefined;
  readonly mode: BudgetMode;
  /**
   * Atomically price, check, and reserve one call's cost. This is a SINGLE SYNCHRONOUS
   * step (no `await` between the check and the increment), which is what makes it safe under
   * interleaving — two concurrently-scheduled calls near the cap can never both pass in
   * `hard` mode (CONC-2). Returns the per-result cost meta attached to every tool result
   * (`cost_usd`, `session_total_usd`, and `budget_warning` at ≥90%; COST-3/5). In `hard`
   * mode it throws a typed `budget` XError when the reservation would exceed the cap
   * (COST-1); in `warn` mode it never throws — past-cap results carry `budget_warning` and
   * proceed. The counter is only mutated when the reservation is accepted.
   */
  reserve(cost: ResolvedCost): ResultMeta;
  /** The current running session total in USD. */
  total(): number;
}

export function createSessionBudget(options: SessionBudgetOptions = {}): SessionBudget {
  const limit = options.limit;
  const mode: BudgetMode = options.mode ?? 'warn';
  let spent = 0;

  function warningFor(next: number): string | undefined {
    if (limit === undefined || next <= 0) return undefined;
    const threshold = limit > 0 ? WARN_FRACTION * limit : 0;
    if (next < threshold - EPSILON) return undefined;
    if (limit > 0 && next <= limit + EPSILON) {
      const pct = Math.round((next / limit) * 100);
      return `Session spend ${formatUsd(next)} is at ~${pct}% of the operator-set credit budget of ${formatUsd(
        limit,
      )}.`;
    }
    // Over the cap: only reachable in `warn` mode — `hard` would already have thrown.
    return `Session spend ${formatUsd(next)} has exceeded the operator-set credit budget of ${formatUsd(
      limit,
    )} (warn mode — call not blocked).`;
  }

  return {
    limit,
    mode,
    reserve(cost) {
      const price = round6(priceOf(cost));
      const next = round6(spent + price);
      if (mode === 'hard' && limit !== undefined && next > limit + EPSILON) {
        // COST-1/COST-5: refuse BEFORE mutating the counter, so a blocked reservation
        // spends nothing and the boundary stays exact under interleaving (CONC-2).
        throw budgetError(
          `This call (${formatUsd(price)}) would bring session spend to ${formatUsd(
            next,
          )}, over the credit budget of ${formatUsd(
            limit,
          )}. This is an operator-set limit; cannot be changed from within this session.`,
        );
      }
      spent = next; // atomic increment — same synchronous tick as the check above (CONC-2)
      const warning = warningFor(next);
      return warning === undefined
        ? { cost_usd: price, session_total_usd: next }
        : { cost_usd: price, session_total_usd: next, budget_warning: warning };
    },
    total() {
      return spent;
    },
  };
}
