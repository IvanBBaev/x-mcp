// Property-based tests (docs/05 §1) for core/budget — the session cap under arbitrary
// call sequences.
//
// The unit suite pins single boundary examples; these properties replay WHOLE random
// sequences of reservations against random caps and assert the safety invariants that
// must survive any interleaving of accepts and refusals: in hard mode the running total
// NEVER exceeds the cap and a refusal spends nothing (COST-1/CONC-2); in warn mode
// nothing ever throws, the total is monotone, and crossing the cap is always flagged
// (COST-5). EPSILON (1e-9) and the 6-dp rounding are part of the documented contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { COST_TABLE, createSessionBudget, priceOf } from '../src/core/budget.js';
import { XError } from '../src/core/errors.js';
import type { CostClass } from '../src/core/tooldef.js';

const EPSILON = 1e-9; // mirrors the module's boundary tolerance (private const)
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

const costClassArb = fc.constantFrom(...(Object.keys(COST_TABLE) as CostClass[]));
const costArb = fc.oneof(
  costClassArb,
  // A resolved estimate with a valid usd override (count-multiplied reads, URL posts).
  fc.record({ class: costClassArb, usd: fc.double({ min: 0, max: 0.05, noNaN: true }) }),
  // Junk overrides must fall back to the table, never poison the counter (defensive).
  fc.record({
    class: costClassArb,
    usd: fc.constantFrom(Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
  }),
);

test('COST-1/CONC-2 property: in hard mode the cap is never exceeded and a refusal spends nothing', () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0.001, max: 0.2, noNaN: true }),
      fc.array(costArb, { minLength: 1, maxLength: 30 }),
      (limit, costs) => {
        const budget = createSessionBudget({ limit, mode: 'hard' });
        for (const cost of costs) {
          const before = budget.total();
          try {
            const meta = budget.reserve(cost);
            assert.equal(meta.session_total_usd, budget.total()); // reported == enforced
            assert.ok(meta.cost_usd >= 0);
          } catch (err) {
            assert.ok(
              XError.is(err) && err.kind === 'budget',
              'refusal must be a typed budget error',
            );
            assert.equal(budget.total(), before); // blocked reservation left the counter alone
          }
          assert.ok(
            budget.total() <= limit + EPSILON,
            `total ${budget.total()} exceeds cap ${limit}`,
          );
        }
      },
    ),
  );
});

test('COST-1/5 property: warn mode never throws, the total is monotone and 6-dp stable, over-cap is always flagged', () => {
  fc.assert(
    fc.property(
      fc.option(fc.double({ min: 0.001, max: 0.2, noNaN: true }), { nil: undefined }),
      fc.array(costArb, { maxLength: 30 }),
      (limit, costs) => {
        const budget = createSessionBudget({
          ...(limit !== undefined ? { limit } : {}),
          mode: 'warn',
        });
        let previous = 0;
        for (const cost of costs) {
          const meta = budget.reserve(cost); // must never throw in warn mode
          assert.ok(meta.session_total_usd >= previous - EPSILON, 'total went backwards');
          previous = meta.session_total_usd;
          // Reported figures are already rounded — re-rounding changes nothing.
          assert.equal(meta.session_total_usd, round6(meta.session_total_usd));
          assert.equal(meta.cost_usd, round6(meta.cost_usd));
          if (limit !== undefined && meta.session_total_usd > limit + EPSILON) {
            assert.ok(meta.budget_warning !== undefined, 'over-cap call must carry budget_warning');
          }
        }
        assert.equal(budget.total(), previous);
      },
    ),
  );
});

test('COST-4 property: a finite non-negative usd override wins; any junk override falls back to the table', () => {
  fc.assert(
    fc.property(costClassArb, fc.double({ min: 0, max: 1, noNaN: true }), (cls, usd) => {
      assert.equal(priceOf({ class: cls, usd }), usd);
    }),
  );
  fc.assert(
    fc.property(
      costClassArb,
      fc.constantFrom(Number.NaN, -0.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
      (cls, usd) => {
        assert.equal(priceOf({ class: cls, usd }), COST_TABLE[cls]);
      },
    ),
  );
});
