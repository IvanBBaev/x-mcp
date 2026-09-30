// The budget gate's charge-at-check contract (INT-2). The registry pipeline is exercised
// end to end by test/mcp/server.test.ts; what cannot be reached through it is the gate's
// own defensive posture when a caller SKIPS `check` — the pipeline always checks first, so
// pinning that arm means driving the gate directly, outside the registry. Hence this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionBudget } from '../../src/core/budget.js';
import { createBudgetGate } from '../../src/mcp/gates.js';
import type { CostEstimate } from '../../src/core/tooldef.js';

test('INT-2: check reserves atomically; the paired reserve is a read-back, not a second charge', () => {
  const budget = createSessionBudget();
  const gate = createBudgetGate(budget);
  const estimate: CostEstimate = { class: 'r:post' };

  gate.check(estimate);
  assert.equal(budget.total(), 0.005); // charged AT CHECK time (INT-2 / CONC-2)

  const meta = gate.reserve(estimate);
  assert.deepEqual(meta, { cost_usd: 0.005, session_total_usd: 0.005 });
  assert.equal(budget.total(), 0.005); // read-back — no double charge
});

test('INT-2: a reserve WITHOUT a prior check still charges, so nothing rides free', () => {
  // Unreachable through the registry (check always precedes reserve); the gate's contract
  // for a future direct caller is to fall through to a real reservation.
  const budget = createSessionBudget();
  const gate = createBudgetGate(budget);

  const meta = gate.reserve({ class: 'r:user' });
  assert.deepEqual(meta, { cost_usd: 0.01, session_total_usd: 0.01 });
  assert.equal(budget.total(), 0.01); // the fallback charged the real budget
});

test('COST-3: reserve settles the held reservation to the resources the response carried', () => {
  const budget = createSessionBudget();
  const gate = createBudgetGate(budget);
  const estimate: CostEstimate = { class: 'r:post' };

  gate.check(estimate);
  assert.equal(budget.total(), 0.005); // one resource held — the count is unknowable yet

  const meta = gate.reserve(estimate, 42);
  assert.deepEqual(meta, { cost_usd: 0.21, session_total_usd: 0.21 });
  assert.equal(budget.total(), 0.21); // settled by the difference, not charged again
});

test('COST-3: a page that came back empty is settled down to $0 (REND-1)', () => {
  const budget = createSessionBudget();
  const gate = createBudgetGate(budget);
  const estimate: CostEstimate = { class: 'r:user' };

  gate.check(estimate);
  const meta = gate.reserve(estimate, 0);
  assert.deepEqual(meta, { cost_usd: 0, session_total_usd: 0 });
  assert.equal(budget.total(), 0);
});

test('a handler that reports no count leaves the check-time reservation exactly as taken', () => {
  const budget = createSessionBudget();
  const gate = createBudgetGate(budget);
  const estimate: CostEstimate = { class: 'w:post', usd: 0.2 };

  gate.check(estimate);
  const meta = gate.reserve(estimate);
  assert.deepEqual(meta, { cost_usd: 0.2, session_total_usd: 0.2 }); // COST-4, unmultiplied
  assert.equal(budget.total(), 0.2);
});

test('INT-2: a count-bearing reserve WITHOUT a prior check charges the counted price', () => {
  // Same defensive arm as above, but with a resource count: the fallback reservation must
  // price the resources rather than silently dropping the multiplier.
  const budget = createSessionBudget();
  const gate = createBudgetGate(budget);

  const meta = gate.reserve({ class: 'r:post' }, 4);
  assert.deepEqual(meta, { cost_usd: 0.02, session_total_usd: 0.02 });
  assert.equal(budget.total(), 0.02);
});

test('the settled call stays charged even when the handler later fails (INT-2)', () => {
  // The gate charges at check; a call that dies after the API answered keeps its charge.
  // Nothing settles it, so it stays at the one-resource hold — never at zero.
  const budget = createSessionBudget();
  const gate = createBudgetGate(budget);
  const estimate: CostEstimate = { class: 'r:post' };

  gate.check(estimate);
  // …handler throws; the registry never reaches step 6.
  assert.equal(budget.total(), 0.005);
});
