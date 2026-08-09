// Spend discipline for the live suite (docs/05 §6). Owned by the live-test slice.
//
// docs/05 §6 is a literal contract, not advice:
//
//   "A live run may spend at most 20 read units. Enforced by the suite itself via
//    core/budget in `hard` mode (dogfooding the budget). The suite stops BEFORE the cap,
//    it does not merely report crossing it."
//   "No archive endpoints. `x_search_archive` / `x_post_counts_archive` are never called
//    from the live suite."
//
// Both are enforced here, on the single seam every live call goes through
// (harness/session.ts `LiveSession.call`), and both are enforced BEFORE the request is
// issued — a refusal costs nothing because nothing was sent.
//
// TWO RAILS, both `core/budget` in `hard` mode:
//
//   * The UNIT rail is the §6 cap itself: a `SessionBudget` whose currency is the read
//     unit, with `limit = 20`. Each authorized call reserves its unit count as a
//     `CostEstimate` with an explicit `usd` override, so `SessionBudget.reserve` performs
//     the exact same check-before-mutate it performs for money (COST-1/CONC-2).
//   * The MONEY rail is a second `SessionBudget` priced from the real `COST_TABLE`, capped
//     at `20 x (the priciest read unit in the table)`. Deriving the cap from the table
//     rather than hard-coding `$0.20` keeps it correct if X reprices a class, and makes
//     the derivation itself testable.
//
// For pure reads the two rails coincide by construction — 20 units at the priciest read
// class is exactly the money cap. They diverge for WRITES, which is the point: a
// `w:post` costs more than any read unit, and a post whose text contains a URL costs
// $0.20 (docs/07 COST-4) — a single such call would consume the entire run budget, and the
// money rail refuses it. That is a guard worth having, not an accident.
//
// If the second rail refuses after the first accepted, the first stays charged. Deliberate:
// a refusal aborts the run, and every later `authorize` then refuses too. The guard fails
// CLOSED — it never becomes cheaper to keep going after it said no.
//
// SCOPE, stated plainly because it is easy to misread: `node --test` runs each test FILE in
// its own process, so the cap is per live test file, not per `npm run test:live` invocation.
// Each of the live files is individually far under 20 units (the read spot-checks use 4, the
// write e2e 5, the capture 1), so the whole live tier costs well under one file's allowance
// — but a new live file gets its own fresh 20, and that is the number to keep an eye on.
// docs/14-live-testing.md §2 carries the same warning for operators.

import { COST_TABLE, createSessionBudget, priceOf } from '../../../src/core/budget.js';
import type { ResolvedCost, SessionBudget } from '../../../src/core/budget.js';
import { COST_CLASSES } from '../../../src/core/tooldef.js';
import type { CostClass } from '../../../src/core/tooldef.js';

/** docs/05 §6: at most 20 read units per live run. */
export const LIVE_READ_UNIT_CAP = 20;

/**
 * docs/05 §6: the archive endpoints are never called from the live suite. They are the two
 * most expensive reads on the surface and a full-archive query can silently page for a very
 * long time, so the deny list is structural — the live session refuses the NAME, before
 * argument validation, before policy, before the budget.
 */
export const LIVE_DENIED_TOOLS: readonly string[] = ['x_search_archive', 'x_post_counts_archive'];

/** Cost classes a READ can charge: the `r:*` family plus `owned` (self-scoped reads). */
export const READ_COST_CLASSES: readonly CostClass[] = COST_CLASSES.filter(
  (c) => c.startsWith('r:') || c === 'owned',
);

/** Round to the budget module's six-decimal precision so the two rails agree exactly. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** The priciest single read unit in the current `COST_TABLE` (today: `$0.01`). */
export function maxReadUnitUsd(): number {
  return READ_COST_CLASSES.reduce((max, c) => Math.max(max, COST_TABLE[c]), 0);
}

/**
 * The money cap, DERIVED: 20 read units can never legitimately cost more than 20 times the
 * priciest read unit. Today `$0.20`. Also fed to the live server as `X_MCP_CREDIT_BUDGET`
 * (harness/session.ts), so the server's own budget refuses in `hard` mode too — the harness
 * rail and the production rail are independent and both must pass.
 */
export const LIVE_USD_CAP = round6(LIVE_READ_UNIT_CAP * maxReadUnitUsd());

/** One authorized live call. */
export interface LiveCall {
  /** MCP tool name, or a `harness:<label>` pseudo-name for a direct endpoint probe. */
  readonly tool: string;
  /** API requests this call will make. One per request; a paginated read costs one per page. */
  readonly units: number;
  /** The cost the production catalog declares for this tool. */
  readonly cost: ResolvedCost;
}

/** The end-of-run accounting docs/05 §6 requires every live run to print. */
export interface LiveSpendReport {
  readonly unitsUsed: number;
  readonly unitCap: number;
  readonly usdUsed: number;
  readonly usdCap: number;
  /** `<tool> x<units> ($<usd>)`, in call order. */
  readonly calls: readonly string[];
}

export interface LiveSpendGuard {
  /**
   * Authorize one call. Throws BEFORE the request is issued when the tool is denied, when
   * the unit count is not a positive integer, or when either rail would be crossed. Never
   * mutates when the deny list or the validation rejects.
   */
  authorize(call: LiveCall): void;
  report(): LiveSpendReport;
  /** The human-readable session summary printed at the end of every live run. */
  summary(): string;
}

export interface LiveSpendGuardOptions {
  /** Override for tests only. Production live runs use {@link LIVE_READ_UNIT_CAP}. */
  readonly unitCap?: number;
  /** Override for tests only. Production live runs use {@link LIVE_USD_CAP}. */
  readonly usdCap?: number;
  /** Override for tests only. Production live runs use {@link LIVE_DENIED_TOOLS}. */
  readonly denied?: readonly string[];
}

/** The refusal message for a denied tool. Exported so the tests assert the exact wording. */
export function deniedToolMessage(tool: string): string {
  return (
    `live suite refuses to call ${tool}: the archive endpoints are on the live deny list ` +
    `(docs/05 §6). Nothing was sent. Denied: ${LIVE_DENIED_TOOLS.join(', ')}.`
  );
}

function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

export function createLiveSpendGuard(options: LiveSpendGuardOptions = {}): LiveSpendGuard {
  const unitCap = options.unitCap ?? LIVE_READ_UNIT_CAP;
  const usdCap = options.usdCap ?? LIVE_USD_CAP;
  const denied = options.denied ?? LIVE_DENIED_TOOLS;

  // Rail 1 — the §6 cap. `core/budget` in `hard` mode, denominated in READ UNITS.
  const units: SessionBudget = createSessionBudget({ limit: unitCap, mode: 'hard' });
  // Rail 2 — the money backstop, denominated in USD from the production cost table.
  const usd: SessionBudget = createSessionBudget({ limit: usdCap, mode: 'hard' });

  const calls: string[] = [];

  function report(): LiveSpendReport {
    return {
      unitsUsed: units.total(),
      unitCap,
      usdUsed: round6(usd.total()),
      usdCap,
      calls: [...calls],
    };
  }

  return {
    authorize(call) {
      if (denied.includes(call.tool)) {
        throw new Error(deniedToolMessage(call.tool));
      }
      if (!Number.isInteger(call.units) || call.units < 1) {
        throw new Error(
          `live call ${call.tool} declared ${String(call.units)} read units — must be a positive integer`,
        );
      }
      // Rail 1: reserve the units. `local` carries a $0 table entry, so the explicit `usd`
      // override is the whole price — the budget is counting units, not dollars, here.
      units.reserve({ class: 'local', usd: call.units });
      // Rail 2: reserve the real money.
      usd.reserve(call.cost);
      calls.push(`${call.tool} x${String(call.units)} (${formatUsd(priceOf(call.cost))})`);
    },
    report,
    summary() {
      const r = report();
      const lines = [
        'live session budget summary (docs/05 §6)',
        `  read units : ${String(r.unitsUsed)} / ${String(r.unitCap)}`,
        `  spend      : ${formatUsd(r.usdUsed)} / ${formatUsd(r.usdCap)}`,
        `  calls      : ${r.calls.length === 0 ? '(none)' : ''}`,
      ];
      for (const c of r.calls) lines.push(`    - ${c}`);
      return lines.join('\n');
    },
  };
}

/**
 * Structural check that the deny list still names REAL tools.
 *
 * A deny list keyed by string silently stops protecting anything the day a tool is renamed.
 * The live session asserts this against the composed registry at open time, so a rename
 * fails loudly at the first live run instead of quietly re-enabling a full-archive search.
 */
export function assertDenyListIntact(toolNames: readonly string[]): void {
  const missing = LIVE_DENIED_TOOLS.filter((name) => !toolNames.includes(name));
  if (missing.length > 0) {
    throw new Error(
      `the live deny list names ${missing.join(', ')}, which the registry does not expose — ` +
        `a rename would silently disable the archive ban. Update LIVE_DENIED_TOOLS in ` +
        `test/live/harness/spend.ts to the current names (docs/05 §6).`,
    );
  }
}
