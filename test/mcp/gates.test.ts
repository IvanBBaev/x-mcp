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
