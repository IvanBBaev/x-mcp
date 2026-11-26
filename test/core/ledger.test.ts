// core/ledger — the persisted daily/monthly spend ledger (Q15, docs/07 §21 LEDGER-*). Driven
// through an in-memory LedgerStore whose backing "file" several ledgers can share, so the
// multi-process cases run without touching the disk (the file adapter has its own tests).

import test from 'node:test';
import assert from 'node:assert/strict';

import { XError } from '../../src/core/errors.js';
import { createSpendLedger, dayKey, monthKey } from '../../src/core/ledger.js';
import type { LedgerEntry, LedgerStore, SpendLedgerOptions } from '../../src/core/ledger.js';

import { fakeClock } from '../helpers/index.js';

/** 2026-11-26T12:00:00Z — mid-day, mid-month. */
const NOON = Date.UTC(2026, 10, 26, 12, 0, 0);

/** The shared backing "file": an append-only list plus a generation bumped on truncation. */
interface MemFile {
  lines: LedgerEntry[];
  generation: number;
  failRead?: string | undefined;
  failAppend?: string | undefined;
}

function memFile(lines: LedgerEntry[] = []): MemFile {
  return { lines: [...lines], generation: 0 };
}

/** One process's view of the shared file: its own read offset, like the real adapter. */
function memStore(file: MemFile): LedgerStore & { reads: number; appends: number } {
  let offset = 0;
  let generation = file.generation;
  const store = {
    reads: 0,
    appends: 0,
    readNew() {
      store.reads += 1;
      if (file.failRead !== undefined) throw Object.assign(new Error('x'), { code: file.failRead });
      let reset = false;
      if (generation !== file.generation) {
        generation = file.generation;
        offset = 0;
        reset = true;
      }
      const entries = file.lines.slice(offset);
      offset = file.lines.length;
      return { reset, entries };
    },
    append(entry: LedgerEntry) {
      store.appends += 1;
      if (file.failAppend !== undefined) {
        throw Object.assign(new Error('/secret/path/spend-ledger.jsonl'), {
          code: file.failAppend,
        });
      }
      file.lines.push(entry);
    },
  };
  return store;
}

function ledgerOn(
  file: MemFile,
  options: Partial<Omit<SpendLedgerOptions, 'store'>> = {},
): {
  ledger: ReturnType<typeof createSpendLedger>;
  store: ReturnType<typeof memStore>;
  clock: ReturnType<typeof fakeClock>;
} {
  const clock = fakeClock(NOON);
  const store = memStore(file);
  const ledger = createSpendLedger({ store, clock, mode: 'warn', ...options });
  return { ledger, store, clock };
}

const isBudget = (err: unknown): boolean => XError.is(err) && err.kind === 'budget';

test('dayKey / monthKey are UTC slices of the instant', () => {
  assert.equal(dayKey(NOON), '2026-11-26');
  assert.equal(monthKey(NOON), '2026-11');
  // 23:30 on the 30th in UTC−5 is already 1 December in UTC.
  assert.equal(dayKey(Date.UTC(2026, 11, 1, 4, 30)), '2026-12-01');
});

test('LEDGER-2: totals persist across a restart — a new ledger folds the file it finds', () => {
  const file = memFile();
  const first = ledgerOn(file).ledger;
  first.reserve(0.25);
  first.reserve(0.5);
  // "Restart": a fresh ledger over the same file starts from what is on disk, not zero.
  const second = ledgerOn(file).ledger;
  const snap = second.snapshot();
  assert.deepEqual(snap.day, { period: '2026-11-26', spent_usd: 0.75 });
  assert.deepEqual(snap.month, { period: '2026-11', spent_usd: 0.75 });
});

test('LEDGER-2: only the current UTC day counts toward the daily window; the month keeps all', () => {
  const yesterday = NOON - 24 * 3_600_000;
  const lastMonth = Date.UTC(2026, 9, 31, 23, 0);
  const file = memFile([
    { at: yesterday, usd: 1 },
    { at: lastMonth, usd: 4 },
    { at: NOON, usd: 0.5 },
  ]);
  const snap = ledgerOn(file, { dailyUsd: 2, monthlyUsd: 10 }).ledger.snapshot();
  assert.deepEqual(snap.day, {
    period: '2026-11-26',
    spent_usd: 0.5,
    limit_usd: 2,
    remaining_usd: 1.5,
    percent_used: 25,
  });
  assert.deepEqual(snap.month, {
    period: '2026-11',
    spent_usd: 1.5,
    limit_usd: 10,
    remaining_usd: 8.5,
    percent_used: 15,
  });
  assert.equal(snap.mode, 'warn');
  assert.equal(snap.note, undefined);
});

test('LEDGER-3: hard mode refuses BEFORE writing, naming the window and the cap', () => {
  const file = memFile([{ at: NOON, usd: 0.95 }]);
  const { ledger, store } = ledgerOn(file, { mode: 'hard', dailyUsd: 1 });
  assert.throws(
    () => ledger.reserve(0.1, 'Priced as 1 DM.'),
    (err: unknown) =>
      isBudget(err) &&
      /would bring persisted daily spend \(UTC day 2026-11-26\) to \$1\.05, over the daily budget of \$1\. Priced as 1 DM\. This is an operator-set limit/.test(
        (err as Error).message,
      ),
  );
  assert.equal(store.appends, 0); // charge before refuse is a bug — nothing was persisted
  assert.equal(file.lines.length, 1);
});

test('LEDGER-3: the monthly cap binds independently of the daily one', () => {
  const file = memFile([{ at: Date.UTC(2026, 10, 2), usd: 9.9 }]);
  const { ledger } = ledgerOn(file, { mode: 'hard', dailyUsd: 5, monthlyUsd: 10 });
  assert.throws(
    () => ledger.reserve(0.2),
    (err: unknown) =>
      isBudget(err) && /monthly spend \(UTC month 2026-11\)/.test((err as Error).message),
  );
});

test('LEDGER-3: reaching the cap exactly is allowed; crossing it is not', () => {
  const file = memFile([{ at: NOON, usd: 0.9 }]);
  const { ledger } = ledgerOn(file, { mode: 'hard', dailyUsd: 1 });
  const { reservation, warning } = ledger.reserve(0.1);
  assert.deepEqual(reservation, { at: NOON, usd: 0.1 });
  assert.match(warning ?? '', /is at ~100% of the operator-set daily budget of \$1\./);
  assert.throws(() => ledger.reserve(0.005), isBudget);
});

test('LEDGER-3: warn mode never refuses; it warns at 90% and past the cap', () => {
  const file = memFile();
  const { ledger } = ledgerOn(file, { dailyUsd: 1 });
  assert.equal(ledger.reserve(0.5).warning, undefined); // 50% — silent
  assert.match(ledger.reserve(0.4).warning ?? '', /Persisted daily spend \$0\.9 .* ~90%/);
  const past = ledger.reserve(0.3);
  assert.equal(past.reservation.usd, 0.3); // still persisted
  assert.match(
    past.warning ?? '',
    /has exceeded the operator-set daily budget of \$1 \(warn mode — call not blocked\)/,
  );
  assert.equal(ledger.snapshot().day.remaining_usd, 0);
});

test('LEDGER-3: both windows can warn at once, joined into one string', () => {
  const file = memFile([{ at: NOON, usd: 0.9 }]);
  const { ledger } = ledgerOn(file, { dailyUsd: 1, monthlyUsd: 1 });
  const { warning } = ledger.reserve(0.05);
  assert.match(warning ?? '', /daily spend .* monthly spend/);
});

test('LEDGER-4: settle moves the ledger by the difference, dated to the reservation', () => {
  const file = memFile();
  const { ledger, clock } = ledgerOn(file);
  const { reservation } = ledger.reserve(0.005);
  // The response arrives after UTC midnight: the top-up still lands on 26 November.
  clock.set(Date.UTC(2026, 10, 27, 0, 0, 5));
  ledger.settle(reservation, 0.21);
  assert.deepEqual(file.lines, [
    { at: NOON, usd: 0.005 },
    { at: NOON, usd: 0.205 },
  ]);
  assert.equal(ledger.snapshot().day.spent_usd, 0); // "today" is now the 27th
  clock.set(NOON);
  assert.equal(ledger.snapshot().day.spent_usd, 0.21);
});

test('LEDGER-4: release (settle to 0) hands back exactly what was held', () => {
  const file = memFile([{ at: NOON, usd: 1 }]);
  const { ledger } = ledgerOn(file);
  const { reservation } = ledger.reserve(0.015);
  assert.deepEqual(ledger.settle(reservation, 0), {});
  assert.equal(ledger.snapshot().day.spent_usd, 1);
  assert.deepEqual(file.lines.at(-1), { at: NOON, usd: -0.015 });
});

test('LEDGER-4: an unchanged settle appends nothing but keeps the warning the reservation had', () => {
  const file = memFile([{ at: NOON, usd: 0.95 }]);
  const { ledger, store } = ledgerOn(file, { dailyUsd: 1 });
  const { reservation, warning } = ledger.reserve(0.01);
  assert.match(warning ?? '', /~96%/);
  const appends = store.appends;
  assert.match(ledger.settle(reservation, 0.01).warning ?? '', /~96%/);
  assert.equal(store.appends, appends);
});

test('LEDGER-4: a hard-mode settle past the cap warns instead of throwing', () => {
  const file = memFile([{ at: NOON, usd: 0.9 }]);
  const { ledger } = ledgerOn(file, { mode: 'hard', dailyUsd: 1 });
  const { reservation } = ledger.reserve(0.005);
  const settled = ledger.settle(reservation, 0.5);
  assert.match(settled.warning ?? '', /already delivered .* the next call is/);
  assert.throws(() => ledger.reserve(0.005), isBudget);
});

test('LEDGER-5: two processes sharing one file see each other — no lost update', () => {
  const file = memFile();
  const a = ledgerOn(file, { mode: 'hard', dailyUsd: 1 }).ledger;
  const b = ledgerOn(file, { mode: 'hard', dailyUsd: 1 }).ledger;
  a.reserve(0.4);
  b.reserve(0.4);
  a.reserve(0.1);
  // B folds A's entries before its check: 0.9 + 0.2 would cross the shared cap.
  assert.throws(() => b.reserve(0.2), isBudget);
  assert.equal(a.snapshot().day.spent_usd, 0.9);
  assert.equal(b.snapshot().day.spent_usd, 0.9);
});

test('LEDGER-6: a truncated or replaced file resets the fold', () => {
  const file = memFile([{ at: NOON, usd: 3 }]);
  const { ledger } = ledgerOn(file);
  assert.equal(ledger.snapshot().day.spent_usd, 3);
  file.lines = [{ at: NOON, usd: 0.25 }];
  file.generation += 1;
  assert.equal(ledger.snapshot().day.spent_usd, 0.25);
});

test('LEDGER-6: net-negative entries never report a negative spend', () => {
  const file = memFile([{ at: NOON, usd: -2 }]);
  assert.equal(ledgerOn(file).ledger.snapshot().day.spent_usd, 0);
});

test('LEDGER-7: hard mode fails closed when the ledger cannot be read — nothing written', () => {
  const file = memFile();
  file.failRead = 'EACCES';
  const { ledger, store } = ledgerOn(file, { mode: 'hard', dailyUsd: 5 });
  assert.throws(
    () => ledger.reserve(0.1),
    (err: unknown) =>
      isBudget(err) &&
      /ledger is unavailable \(EACCES\).*Hard budget mode refuses calls/.test(
        (err as Error).message,
      ),
  );
  assert.equal(store.appends, 0);
  assert.throws(() => ledger.quote(0.1), isBudget);
});

test('LEDGER-7: hard mode fails closed when the append fails, and never leaks the path', () => {
  const file = memFile();
  file.failAppend = 'ENOSPC';
  const { ledger } = ledgerOn(file, { mode: 'hard' });
  assert.throws(
    () => ledger.reserve(0.1),
    (err: unknown) =>
      isBudget(err) &&
      /\(ENOSPC\)/.test((err as Error).message) &&
      !(err as Error).message.includes('/secret/'),
  );
});

test('LEDGER-7: warn mode proceeds with a warning and holds a $0 reservation', () => {
  const file = memFile();
  file.failRead = 'EIO';
  const { ledger } = ledgerOn(file, { dailyUsd: 1 });
  const read = ledger.reserve(0.1);
  assert.deepEqual(read.reservation, { at: NOON, usd: 0 });
  assert.match(read.warning ?? '', /unavailable \(EIO\).*not recorded in it \(warn mode/);
  // A readable ledger whose append fails is the same degraded path.
  file.failRead = undefined;
  file.failAppend = 'EROFS';
  const write = ledger.reserve(0.1);
  assert.equal(write.reservation.usd, 0);
  assert.match(write.warning ?? '', /\(EROFS\)/);
});

test('LEDGER-7: settle never throws — a failed append becomes a warning with the drift', () => {
  const file = memFile();
  const { ledger } = ledgerOn(file, { mode: 'hard' });
  const { reservation } = ledger.reserve(0.005);
  file.failAppend = 'EIO';
  const settled = ledger.settle(reservation, 0.205);
  assert.match(
    settled.warning ?? '',
    /could not record this call's settled price \(EIO\).*off by \$0\.2\./,
  );
});

test('LEDGER-7: snapshot never throws — it notes the failure and reports the last totals', () => {
  const file = memFile([{ at: NOON, usd: 0.3 }]);
  const { ledger } = ledgerOn(file);
  assert.equal(ledger.snapshot().day.spent_usd, 0.3);
  file.failRead = 'EACCES';
  const snap = ledger.snapshot();
  assert.equal(snap.day.spent_usd, 0.3);
  assert.match(snap.note ?? '', /unavailable \(EACCES\).*last ones this process read/);
});

test('LEDGER-8: a $0 call never reads, writes or is refused by the ledger', () => {
  const file = memFile([{ at: NOON, usd: 5 }]);
  file.failRead = 'EACCES';
  const { ledger, store } = ledgerOn(file, { mode: 'hard', dailyUsd: 1 });
  const { reservation, warning } = ledger.reserve(0);
  assert.deepEqual(reservation, { at: NOON, usd: 0 });
  assert.equal(warning, undefined);
  assert.deepEqual(ledger.quote(0), {});
  assert.deepEqual(ledger.settle(reservation, 0), {});
  assert.equal(store.reads, 0);
  assert.equal(store.appends, 0);
});

test('LEDGER-9: quote checks the caps exactly like reserve but writes nothing', () => {
  const file = memFile([{ at: NOON, usd: 0.95 }]);
  const hard = ledgerOn(file, { mode: 'hard', dailyUsd: 1 });
  assert.match(hard.ledger.quote(0.04).warning ?? '', /~99%/);
  assert.throws(() => hard.ledger.quote(0.1, 'Priced as 1 post.'), isBudget);
  assert.equal(hard.store.appends, 0);
  assert.equal(file.lines.length, 1);
});

test('uncapped windows report spend only, and never warn', () => {
  const file = memFile();
  const { ledger } = ledgerOn(file, { mode: 'hard' });
  assert.equal(ledger.reserve(1000).warning, undefined);
  assert.deepEqual(ledger.snapshot().day, { period: '2026-11-26', spent_usd: 1000 });
});
