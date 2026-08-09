// Tests for core/budget.ts (T-112) — the session credit budget with atomic check-and-reserve.
// Corner cases exercised by ID: COST-1 (operator-set, model-immutable, no per-call override),
// COST-2 (unseeded, starts at zero), COST-3 (per-call + session total on every result),
// COST-4 (URL-post $0.20 via CostEstimate.usd override), COST-5 (90% warn / 100% boundaries),
// and CONC-2 (check-and-reserve is atomic — two interleaved calls cannot both pass).

import test from 'node:test';
import assert from 'node:assert/strict';

import { XError } from '../../src/core/errors.js';
import { COST_TABLE, createSessionBudget, priceOf } from '../../src/core/budget.js';
import type { ResultMeta } from '../../src/core/tooldef.js';

test('COST_TABLE prices each class at the verified pay-per-use rate (docs/01 App. B)', () => {
  assert.deepEqual(COST_TABLE, {
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
    // w:action (engagement/graph/moderation writes + deletes) is unpriced on X's page as of
    // 2026-07-22; counted $0 locally until the Phase 1 live capture (COST-6).
    'w:action': 0,
  });
});

test('priceOf resolves a bare class from the table', () => {
  assert.equal(priceOf('r:post'), 0.005);
  assert.equal(priceOf('w:dm'), 0.015);
  assert.equal(priceOf('local'), 0);
});

test('COST-4: a CostEstimate.usd override wins over the class base (URL post → $0.20)', () => {
  // A URL-bearing post is priced $0.20, not the $0.015 base — via the override, not the table.
  assert.equal(priceOf({ class: 'w:post' }), 0.015);
  assert.equal(priceOf({ class: 'w:post', usd: 0.2 }), 0.2);
  // The same override mechanism prices a count-multiplied read (87 posts × $0.005).
  assert.equal(priceOf({ class: 'r:post', usd: 87 * 0.005 }), 0.435);
  // A non-finite / negative override is ignored in favour of the table price (defensive).
  assert.equal(priceOf({ class: 'r:post', usd: Number.NaN }), 0.005);
  assert.equal(priceOf({ class: 'r:post', usd: -1 }), 0.005);
  // Zero is a LEGITIMATE override, not a missing one: a count-multiplied read that resolved
  // to zero resources costs nothing, and falling back to the table price here would invent a
  // charge for a call that fetched nothing. This is the `>= 0` / `> 0` boundary.
  assert.equal(priceOf({ class: 'r:post', usd: 0 }), 0);
  assert.equal(priceOf({ class: 'w:post', usd: 0 }), 0);
});

test('COST-2: a fresh budget starts at zero and is never seeded', () => {
  const budget = createSessionBudget({ limit: 1, mode: 'warn' });
  assert.equal(budget.total(), 0);
  // Uncapped budgets, too — no usage API is consulted to seed the counter.
  assert.equal(createSessionBudget().total(), 0);
});

test('COST-3: every reservation reports cost_usd and the running session total', () => {
  const budget = createSessionBudget(); // uncapped
  const a: ResultMeta = budget.reserve('r:post'); // 0.005
  assert.deepEqual(a, { cost_usd: 0.005, session_total_usd: 0.005 });
  const b: ResultMeta = budget.reserve('r:user'); // +0.010
  assert.deepEqual(b, { cost_usd: 0.01, session_total_usd: 0.015 });
  const c: ResultMeta = budget.reserve({ class: 'w:post', usd: 0.2 }); // +0.200
  assert.deepEqual(c, { cost_usd: 0.2, session_total_usd: 0.215 });
  assert.equal(budget.total(), 0.215);
});

test('COST-3: below the warn threshold no budget_warning field is present', () => {
  const budget = createSessionBudget({ limit: 1, mode: 'warn' });
  const meta = budget.reserve({ class: 'local', usd: 0.5 }); // 50%
  assert.equal('budget_warning' in meta, false);
  assert.equal(meta.budget_warning, undefined);
});

test('COST-5: warning appears exactly at 90% of the cap, not before', () => {
  const budget = createSessionBudget({ limit: 1, mode: 'warn' });
  const below = budget.reserve({ class: 'local', usd: 0.89 }); // 89%
  assert.equal('budget_warning' in below, false);
  const at = budget.reserve({ class: 'local', usd: 0.01 }); // → 0.90 exactly = 90%
  assert.equal(at.session_total_usd, 0.9);
  assert.match(at.budget_warning ?? '', /~90%/);
});

test('COST-5: hard mode passes exactly at 100% and blocks only past it', () => {
  const budget = createSessionBudget({ limit: 1, mode: 'hard' });
  const at = budget.reserve({ class: 'local', usd: 1 }); // → 100% exactly: allowed
  assert.equal(at.session_total_usd, 1);
  assert.match(at.budget_warning ?? '', /~100%/);
  // Any further non-zero reservation would exceed the cap → blocked.
  assert.throws(
    () => budget.reserve('owned'),
    (err: unknown) => XError.is(err) && err.kind === 'budget',
  );
  // A blocked reservation spends nothing — the counter is untouched.
  assert.equal(budget.total(), 1);
});

test('COST-1: hard-mode block is a typed budget error the model cannot override', () => {
  const budget = createSessionBudget({ limit: 0.01, mode: 'hard' });
  assert.throws(
    () => budget.reserve({ class: 'w:post', usd: 0.5 }),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'budget');
      assert.equal(err.fix, 'operator'); // operator-fixable, not agent-fixable
      assert.equal(err.retryable, false);
      // COST-1: the cap is operator-set and immutable from inside the session.
      assert.match(err.message, /operator-set limit; cannot be changed from within this session/);
      return true;
    },
  );
});

test('COST-1: no cap set → hard mode never blocks (X_MCP_CREDIT_BUDGET unset = no cap)', () => {
  const budget = createSessionBudget({ mode: 'hard' }); // limit undefined
  for (let i = 0; i < 1000; i += 1) budget.reserve({ class: 'w:post', usd: 0.2 });
  assert.equal(budget.limit, undefined);
  assert.equal(budget.total(), 200);
  // Uncapped means no percentage to report — never a warning.
  assert.equal('budget_warning' in budget.reserve('w:post'), false);
});

test('warn mode never blocks: past-100% results carry a warning and still return', () => {
  const budget = createSessionBudget({ limit: 0.01, mode: 'warn' });
  const meta = budget.reserve({ class: 'w:post', usd: 0.5 }); // way over the cap
  assert.equal(meta.session_total_usd, 0.5);
  assert.match(meta.budget_warning ?? '', /exceeded the operator-set credit budget/);
  assert.equal(budget.total(), 0.5); // spend was recorded, not refused
});

test('spending EXACTLY the cap reads as 100% of it, not as exceeding it', () => {
  // The `next <= limit` boundary. Landing precisely on the cap is the last legal state, so
  // the wording must still be the percentage one — "exceeded" would tell the operator they
  // overspent when they did not, and in hard mode the same boundary decides whether the call
  // is allowed at all.
  const budget = createSessionBudget({ limit: 0.015, mode: 'warn' });
  const meta = budget.reserve('w:post'); // $0.015 against a $0.015 cap
  assert.equal(meta.session_total_usd, 0.015);
  assert.match(meta.budget_warning ?? '', /is at ~100% of the operator-set credit budget/);
  assert.doesNotMatch(meta.budget_warning ?? '', /exceeded/);
});

test('hard mode allows the call that lands exactly on the cap and refuses the next one', () => {
  const budget = createSessionBudget({ limit: 0.015, mode: 'hard' });
  assert.equal(budget.reserve('w:post').session_total_usd, 0.015); // exactly the cap: allowed
  assert.throws(
    () => budget.reserve('w:post'),
    (err: unknown) => XError.is(err) && err.kind === 'budget',
  );
  assert.equal(budget.total(), 0.015, 'the refused call must not have been charged');
});

test('COST-5: a zero cap in warn mode flags the very first paid call as exceeded', () => {
  // limit: 0 is a legitimate operator setting ("spend nothing") — the warn threshold
  // degenerates to 0, so any non-free reservation is immediately past the cap.
  const budget = createSessionBudget({ limit: 0, mode: 'warn' });
  const meta = budget.reserve('r:post'); // $0.005 against a $0 cap
  assert.equal(meta.session_total_usd, 0.005);
  assert.match(meta.budget_warning ?? '', /exceeded the operator-set credit budget/);
  // A free call on a FRESH zero-cap budget stays warning-free (total is still $0) —
  // the warning tracks the session total, so any spent budget would flag it.
  const fresh = createSessionBudget({ limit: 0, mode: 'warn' });
  assert.equal('budget_warning' in fresh.reserve('local'), false);
});

test('CONC-2: check-and-reserve is atomic — two interleaved calls cannot both pass', async () => {
  // Remaining ≈ one r:post credit ($0.005); two concurrently-scheduled calls each cost $0.005.
  // A check-then-spend budget (read remaining, yield, then increment) would let BOTH pass;
  // a synchronous check-and-reserve cannot — the event loop can't interleave a sync function,
  // so exactly one reservation succeeds and the other is refused.
  const budget = createSessionBudget({ limit: 0.005, mode: 'hard' });
  const call = async (): Promise<ResultMeta> => {
    await Promise.resolve(); // schedule both on the microtask queue "at the same time"
    return budget.reserve('r:post');
  };
  const results = await Promise.allSettled([call(), call()]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(XError.is((rejected[0] as PromiseRejectedResult).reason));
  assert.equal(budget.total(), 0.005); // only the winning reservation is counted
});

test('a $0 local call never blocks and never warns, even at the cap', () => {
  const budget = createSessionBudget({ limit: 1, mode: 'hard' });
  budget.reserve({ class: 'local', usd: 1 }); // sit exactly at the cap
  const free = budget.reserve('local'); // $0 — does not exceed the cap
  assert.equal(free.cost_usd, 0);
  assert.equal(free.session_total_usd, 1);
  assert.equal(budget.total(), 1);
});
