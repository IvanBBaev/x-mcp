// core/ledger.ts — the persisted daily/monthly spend ledger (Q15, docs/07 §21 LEDGER-*).
//
// The session budget (core/budget) forgets everything on restart; this ledger keeps the SAME
// local estimate across restarts and across every process that shares the ledger file, per
// UTC calendar day and per UTC calendar month, with optional operator-set caps for each
// window. It is still an advisory, locally-priced estimate (COST-2) — never X's billed spend.
//
// `core` does no I/O: persistence goes through the {@link LedgerStore} seam (production adapter:
// api/spendledger, an append-only JSONL file), and time comes from the Clock port. The store
// is SYNCHRONOUS on purpose — `reserve` folds every entry other processes appended, checks the
// caps and appends its own entry with no `await` in between, so CONC-2 (check-and-reserve is
// one synchronous step) holds in-process exactly as it does for the session budget.
//
// Across processes the file is append-only, so no process ever loses another's entry. The
// cap check is NOT a cross-process lock: two processes that check in the same instant can
// each pass, so a hard cap may be overshot by at most one in-flight reservation per other
// process (LEDGER-5). That bound is documented rather than closed with a lock file, because a
// synchronous lock would have to block the event loop while it waits.

import { budgetError } from './errors.js';
import type { BudgetMode } from './budget.js';
import type { Clock } from './ports.js';

/** One ledger line: `at` = epoch ms of the reservation, `usd` = the amount (negative = refund). */
export interface LedgerEntry {
  readonly at: number;
  readonly usd: number;
}

/** What {@link LedgerStore.readNew} returns. */
export interface LedgerRead {
  /**
   * `true` when the backing file was truncated, replaced or removed since the last read: the
   * entries are then the WHOLE new file and every total folded so far must be dropped.
   */
  readonly reset: boolean;
  readonly entries: readonly LedgerEntry[];
}

/** The persistence seam. Both methods are synchronous and throw on an I/O failure. */
export interface LedgerStore {
  /** Entries appended by ANY process (this one included) since the previous call. */
  readNew(): LedgerRead;
  /** Durably append one entry. */
  append(entry: LedgerEntry): void;
}

/** Options for {@link createSpendLedger}. */
export interface SpendLedgerOptions {
  readonly store: LedgerStore;
  readonly clock: Clock;
  /** Shared with the session budget (env `X_MCP_BUDGET_MODE`). */
  readonly mode: BudgetMode;
  /** Operator-set cap for the current UTC day (env `X_MCP_DAILY_BUDGET`). */
  readonly dailyUsd?: number;
  /** Operator-set cap for the current UTC month (env `X_MCP_MONTHLY_BUDGET`). */
  readonly monthlyUsd?: number;
}

/** A held ledger reservation: the amount persisted and the instant it is dated to. */
export interface LedgerReservation {
  readonly at: number;
  readonly usd: number;
}

/** One window's state as `x_usage_get` reports it. */
export interface LedgerWindowReport {
  /** `YYYY-MM-DD` (day) or `YYYY-MM` (month), UTC. */
  readonly period: string;
  readonly spent_usd: number;
  readonly limit_usd?: number;
  readonly remaining_usd?: number;
  /** `spent_usd` as a percentage of `limit_usd`, 1 dp. Absent when uncapped. */
  readonly percent_used?: number;
}

/** The persisted totals for the current day and month. */
export interface LedgerSnapshot {
  readonly mode: BudgetMode;
  readonly day: LedgerWindowReport;
  readonly month: LedgerWindowReport;
  /** Present when the ledger could not be read: the totals are the last ones this process saw. */
  readonly note?: string;
}

/** The persisted spend ledger. Every method is synchronous. */
export interface SpendLedger {
  /**
   * Check `usd` against the day and month caps and persist it — one synchronous step
   * (CONC-2). In `hard` mode it throws a typed `budget` XError, before anything is written,
   * when the call would cross a cap or when the ledger cannot be read or written (fail
   * closed: a cap it cannot see is a cap it cannot enforce). In `warn` mode it never throws;
   * the warning, if any, is returned. A `usd` of 0 never touches the store (LEDGER-8).
   */
  reserve(usd: number, note?: string): { reservation: LedgerReservation; warning?: string };
  /** What {@link reserve} would do, without writing (Q14 dry run). Same throws. */
  quote(usd: number, note?: string): { warning?: string };
  /**
   * Move a held reservation to `usd` (COST-3 settle; 0 = release). The difference is appended
   * dated to the ORIGINAL reservation, so it lands in the same day and month even when the
   * call straddles midnight (LEDGER-4). Never throws.
   */
  settle(held: LedgerReservation, usd: number): { warning?: string };
  /** The current day's and month's totals, folded from the store. Never throws. */
  snapshot(): LedgerSnapshot;
}

const EPSILON = 1e-9;
const WARN_FRACTION = 0.9;

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function formatUsd(n: number): string {
  return `$${round6(n)}`;
}

/** UTC `YYYY-MM-DD` of an epoch-ms instant. Pure — no clock read. */
export function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** UTC `YYYY-MM` of an epoch-ms instant. */
export function monthKey(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

/** A thrown store failure, reduced to its error code — never a path or a stack. */
function failureCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = err.code;
    if (typeof code === 'string' && code !== '') return code;
  }
  return 'I/O error';
}

interface Window {
  readonly name: 'daily' | 'monthly';
  readonly period: string;
  readonly label: string;
  readonly limit: number | undefined;
  readonly spent: number;
}

export function createSpendLedger(options: SpendLedgerOptions): SpendLedger {
  const { store, clock, mode } = options;
  const byDay = new Map<string, number>();
  const byMonth = new Map<string, number>();
  let lastFailure: string | undefined;

  function fold(entries: readonly LedgerEntry[]): void {
    for (const { at, usd } of entries) {
      const d = dayKey(at);
      const m = monthKey(at);
      byDay.set(d, round6((byDay.get(d) ?? 0) + usd));
      byMonth.set(m, round6((byMonth.get(m) ?? 0) + usd));
    }
  }

  /** Fold everything other processes appended. Throws when the store cannot be read. */
  function sync(): void {
    const read = store.readNew();
    if (read.reset) {
      byDay.clear();
      byMonth.clear();
    }
    fold(read.entries);
  }

  function windows(at: number): [Window, Window] {
    const d = dayKey(at);
    const m = monthKey(at);
    return [
      {
        name: 'daily',
        period: d,
        label: `UTC day ${d}`,
        limit: options.dailyUsd,
        spent: Math.max(0, byDay.get(d) ?? 0),
      },
      {
        name: 'monthly',
        period: m,
        label: `UTC month ${m}`,
        limit: options.monthlyUsd,
        spent: Math.max(0, byMonth.get(m) ?? 0),
      },
    ];
  }

  function warningFor(w: Window, next: number, settled: boolean): string | undefined {
    const limit = w.limit;
    if (limit === undefined || next <= 0) return undefined;
    if (next < WARN_FRACTION * limit - EPSILON) return undefined;
    const head = `Persisted ${w.name} spend ${formatUsd(next)} (${w.label})`;
    if (next <= limit + EPSILON) {
      const pct = Math.round((next / limit) * 100);
      return `${head} is at ~${pct}% of the operator-set ${w.name} budget of ${formatUsd(limit)}.`;
    }
    if (settled && mode === 'hard') {
      return `${head} has exceeded the operator-set ${w.name} budget of ${formatUsd(
        limit,
      )} — the resources this call returned were already delivered when its reservation was settled, so it was not blocked; the next call is.`;
    }
    return `${head} has exceeded the operator-set ${w.name} budget of ${formatUsd(
      limit,
    )} (warn mode — call not blocked).`;
  }

  function unavailable(code: string): string {
    return `The persisted spend ledger is unavailable (${code}), so the daily and monthly budgets cannot be checked.`;
  }

  /**
   * The shared check behind `reserve` and `quote`: sync, then refuse (hard) or warn. Pure
   * apart from the store read — it never appends.
   */
  function project(usd: number, note: string | undefined, at: number): string | undefined {
    try {
      sync();
      lastFailure = undefined;
    } catch (err) {
      lastFailure = failureCode(err);
      if (mode === 'hard') {
        throw budgetError(
          `${unavailable(lastFailure)} Hard budget mode refuses calls until the operator fixes the ledger file. This is an operator-set limit; cannot be changed from within this session.`,
        );
      }
      return `${unavailable(lastFailure)} This call is not recorded in it (warn mode — call not blocked).`;
    }
    const price = round6(usd);
    const warnings: string[] = [];
    for (const w of windows(at)) {
      const next = round6(w.spent + price);
      if (mode === 'hard' && w.limit !== undefined && next > w.limit + EPSILON) {
        const why = note !== undefined ? ` ${note}` : '';
        throw budgetError(
          `This call (${formatUsd(price)}) would bring persisted ${w.name} spend (${w.label}) to ${formatUsd(
            next,
          )}, over the ${w.name} budget of ${formatUsd(
            w.limit,
          )}.${why} This is an operator-set limit; cannot be changed from within this session.`,
        );
      }
      const warning = warningFor(w, next, false);
      if (warning !== undefined) warnings.push(warning);
    }
    return warnings.length > 0 ? warnings.join(' ') : undefined;
  }

  function report(w: Window): LedgerWindowReport {
    const spent = round6(w.spent);
    if (w.limit === undefined) return { period: w.period, spent_usd: spent };
    return {
      period: w.period,
      spent_usd: spent,
      limit_usd: round6(w.limit),
      remaining_usd: round6(Math.max(0, w.limit - spent)),
      percent_used: Math.round((spent / w.limit) * 1000) / 10,
    };
  }
  function withWarning<T extends object>(
    value: T,
    warning: string | undefined,
  ): T & { warning?: string } {
    return warning === undefined ? value : { ...value, warning };
  }

  return {
    reserve(usd, note) {
      const at = clock.now();
      const reservation: LedgerReservation = { at, usd: round6(usd) };
      // LEDGER-8: a free call never reads or writes the ledger, and is never refused by it.
      if (reservation.usd <= 0) return { reservation: { at, usd: 0 } };
      const warning = project(reservation.usd, note, at);
      if (lastFailure !== undefined) {
        // Warn mode with an unreadable ledger: nothing is persisted for this call.
        return { reservation: { at, usd: 0 }, ...(warning !== undefined ? { warning } : {}) };
      }
      try {
        store.append(reservation);
      } catch (err) {
        const code = failureCode(err);
        if (mode === 'hard') {
          throw budgetError(
            `${unavailable(code)} Hard budget mode refuses calls until the operator fixes the ledger file. This is an operator-set limit; cannot be changed from within this session.`,
          );
        }
        return {
          reservation: { at, usd: 0 },
          warning: `${unavailable(code)} This call is not recorded in it (warn mode — call not blocked).`,
        };
      }
      // Fold our own line (and anything appended meanwhile). A read failure here is not a
      // refusal — the entry is on disk and the next sync picks it up.
      try {
        sync();
      } catch {
        // deliberate: see above
      }
      return withWarning({ reservation }, warning);
    },
    quote(usd, note) {
      const price = round6(usd);
      if (price <= 0) return {};
      return withWarning({}, project(price, note, clock.now()));
    },
    settle(held, usd) {
      const price = round6(usd);
      // A free call stays free and silent, as at reserve time (LEDGER-8).
      if (held.usd <= 0 && price <= 0) return {};
      const delta = round6(price - held.usd);
      if (delta !== 0) {
        try {
          store.append({ at: held.at, usd: delta });
          sync();
        } catch (err) {
          return {
            warning: `The persisted spend ledger could not record this call's settled price (${failureCode(
              err,
            )}); its daily and monthly totals are off by ${formatUsd(delta)}.`,
          };
        }
      }
      // Recomputed even for an unchanged price: the settled meta REPLACES the check-time one,
      // so a warning the reservation carried must survive the settle.
      const warnings = windows(held.at)
        .map((w) => warningFor(w, w.spent, true))
        .filter((w): w is string => w !== undefined);
      return warnings.length > 0 ? { warning: warnings.join(' ') } : {};
    },
    snapshot() {
      let note: string | undefined;
      try {
        sync();
      } catch (err) {
        note = `${unavailable(failureCode(err))} The totals below are the last ones this process read.`;
      }
      const [day, month] = windows(clock.now());
      return {
        mode,
        day: report(day),
        month: report(month),
        ...(note !== undefined ? { note } : {}),
      };
    },
  };
}
