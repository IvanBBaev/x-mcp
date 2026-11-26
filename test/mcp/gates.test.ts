// The budget gate's charge-at-check contract (INT-2). The registry pipeline is exercised
// end to end by test/mcp/server.test.ts; what cannot be reached through it is the gate's
// own defensive posture when a caller SKIPS `check` — the pipeline always checks first, so
// pinning that arm means driving the gate directly, outside the registry. Hence this file.
// Its tail composes the real registry with this gate to pin which local refusals are charged.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  USER_INTERACTION_CREATE_USD,
  createSessionBudget,
  createSpendByTool,
} from '../../src/core/budget.js';
import type { SessionBudget, SpendByTool } from '../../src/core/budget.js';
import { XError, apiError } from '../../src/core/errors.js';
import { createRegistry } from '../../src/core/registry.js';
import type { CallContext, Registry } from '../../src/core/registry.js';
import type { AnyToolDef, CostEstimate, XApiRequest } from '../../src/core/tooldef.js';
import { createSpendLedger } from '../../src/core/ledger.js';
import type { LedgerEntry, LedgerStore, SpendLedger } from '../../src/core/ledger.js';
import { createBudgetGate } from '../../src/mcp/gates.js';
import { xLikeSet } from '../../src/tools/engagement.js';
import { xFollowSet } from '../../src/tools/graph.js';
import { xListUpdate } from '../../src/tools/lists.js';

import { fakeClock, loadFixture, makePorts } from '../helpers/index.js';

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

test('RATE-2/CONC-2: release hands back exactly the held reservation, by the difference', () => {
  // The registry calls `release` when a handler refused before sending any request. The
  // ledger moves by minus what THIS call held, so a reservation another call took in
  // between is untouched (CONC-2).
  const budget = createSessionBudget({ limit: 1, mode: 'hard' });
  const gate = createBudgetGate(budget);
  const refused: CostEstimate = { class: 'w:action', usd: 0.005 };
  const other: CostEstimate = { class: 'r:user' };

  gate.check(refused);
  gate.check(other);
  assert.equal(budget.total(), 0.015);

  gate.release(refused);
  assert.equal(budget.total(), 0.01); // only the refused call's hold came back

  // A second release, or a release of an estimate never checked, moves nothing.
  gate.release(refused);
  gate.release({ class: 'r:post' });
  assert.equal(budget.total(), 0.01);
});

test('per-tool attribution moves with the session ledger: check, settle and release', () => {
  const budget = createSessionBudget({ limit: 1, mode: 'hard' });
  const spend = createSpendByTool();
  const gate = createBudgetGate(budget, spend);
  const read: CostEstimate = { class: 'r:post' };
  const refused: CostEstimate = { class: 'w:action', usd: 0.015 };
  const anonymous: CostEstimate = { class: 'r:user' };

  gate.check(read, 'x_search_recent');
  gate.check(refused, 'x_like_set');
  gate.check(anonymous); // no tool name: charged, but attributed to nobody
  assert.deepEqual(spend.snapshot(), { x_like_set: 0.015, x_search_recent: 0.005 });

  gate.reserve(read, 10); // settled up to ten posts
  gate.release(refused); // refused locally: handed back to $0 and dropped from the report
  assert.deepEqual(spend.snapshot(), { x_search_recent: 0.05 });
  assert.equal(budget.total(), 0.06); // 0.05 attributed + 0.01 unattributed

  // A hard-mode refusal at check reserves nothing, so it attributes nothing either.
  assert.throws(() => gate.check({ class: 'w:post', usd: 5 }, 'x_post_create'));
  assert.deepEqual(spend.snapshot(), { x_search_recent: 0.05 });
});

// --- Local refusals of priced w:action writes, through the real registry + real gate ----
//
// These writes refuse some inputs inside the handler — after step 4 has reserved the
// write's price, before the first request. The registry hands the reservation back when
// nothing was sent, so the session total is unchanged; once a request has left (a handle
// lookup), the call stays charged.

/** The real registry wired to the real budget gate over a hard-mode session budget. */
function budgetedRegistry(tools: readonly AnyToolDef[]): {
  reg: Registry;
  budget: SessionBudget;
  spend: SpendByTool;
} {
  const budget = createSessionBudget({ limit: 1, mode: 'hard' });
  const spend = createSpendByTool();
  const reg = createRegistry(tools, {
    policy: {
      preset: 'full',
      hideDenied: false,
      isAllowed: () => true,
      denyError: () => apiError('unused'),
    },
    budget: createBudgetGate(budget, spend),
    rateLimit: { preflight: () => {} },
  });
  return { reg, budget, spend };
}

/** A call context whose invoker records every request and answers with `reply`. */
function recordingCall(reply: (req: XApiRequest) => unknown = () => ({})): {
  ctx: CallContext;
  sent: XApiRequest[];
} {
  const sent: XApiRequest[] = [];
  const ctx: CallContext = {
    ports: makePorts(),
    http: {
      send<T>(req: XApiRequest): Promise<T> {
        sent.push(req);
        return Promise.resolve(reply(req) as T);
      },
    },
  };
  return { ctx, sent };
}

function isValidation(err: unknown): boolean {
  assert.ok(XError.is(err));
  assert.equal(err.kind, 'validation');
  return true;
}

test('RATE-2/COST-3: a w:action write refused locally before any request is not charged', async () => {
  const { reg, budget } = budgetedRegistry([xFollowSet, xListUpdate, xLikeSet]);
  const refusals: readonly [string, Record<string, unknown>][] = [
    ['x_follow_set', { user: 'me', action: 'follow' }],
    ['x_list_update', { list_id: '1234567890' }],
    ['x_like_set', { post: 'not-a-post-id', action: 'like' }],
  ];
  for (const [name, input] of refusals) {
    const { ctx, sent } = recordingCall();
    await assert.rejects(() => reg.call(name, input, ctx), isValidation);
    assert.equal(sent.length, 0, `${name} must refuse before any request`);
    assert.equal(budget.total(), 0, `${name}'s local refusal must not be charged`);
  }
});

test('COST-3: an unknown follow target stays charged — the handle lookup reached X', async () => {
  const { reg, budget } = budgetedRegistry([xFollowSet]);
  const { ctx, sent } = recordingCall(() => loadFixture('users/handle-lookup-miss.json'));
  await assert.rejects(
    () => reg.call('x_follow_set', { user: '@ghost', action: 'follow' }, ctx),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'not-found');
      return true;
    },
  );
  assert.equal(sent.length, 1); // the lookup only — the write was never sent
  assert.equal(budget.total(), USER_INTERACTION_CREATE_USD);
});

test('the registry attributes each charge to the tool that was called', async () => {
  const { reg, spend } = budgetedRegistry([xFollowSet, xLikeSet]);
  // A local refusal: charged at check, released, so it never shows up.
  await assert.rejects(
    () => reg.call('x_like_set', { post: 'not-a-post-id', action: 'like' }, recordingCall().ctx),
    isValidation,
  );
  // A call that reached X stays charged under its own name.
  await assert.rejects(() =>
    reg.call(
      'x_follow_set',
      { user: '@ghost', action: 'follow' },
      recordingCall(() => loadFixture('users/handle-lookup-miss.json')).ctx,
    ),
  );
  assert.deepEqual(spend.snapshot(), { x_follow_set: USER_INTERACTION_CREATE_USD });
});

// --- Q14: quote (the dry-run price check) -------------------------------------------

test('Q14/DRY-2: the gate quote reserves, holds and attributes nothing', () => {
  const budget = createSessionBudget({ limit: 1, mode: 'hard' });
  const spend = createSpendByTool();
  const gate = createBudgetGate(budget, spend);
  const estimate: CostEstimate = { class: 'w:dm' };

  gate.check(estimate, 'x_user_get'); // one real charge, so `total` is not trivially zero
  const before = budget.total();
  const quote = gate.quote({ class: 'w:dm' });
  assert.deepEqual(quote, {
    projected: { cost_usd: 0.015, session_total_usd: 0.03 },
    total: before,
  });
  assert.equal(budget.total(), before);
  assert.deepEqual(Object.keys(spend.snapshot()), ['x_user_get']);
  // A quoted estimate holds no reservation: a later release of it moves nothing.
  const quoted: CostEstimate = { class: 'w:post' };
  gate.quote(quoted);
  gate.release(quoted);
  assert.equal(budget.total(), before);
});

test('Q14/DRY-2: the gate quote refuses past a hard cap, exactly like check', () => {
  const budget = createSessionBudget({ limit: 0.01, mode: 'hard' });
  const gate = createBudgetGate(budget);
  assert.throws(
    () => gate.quote({ class: 'w:dm' }),
    (err: unknown) => XError.is(err) && err.kind === 'budget',
  );
  assert.equal(budget.total(), 0);
});

// --- Q15: the persisted spend ledger rides the same charge (docs/07 §21) ---------------

/** An in-memory LedgerStore: the "file" is the array, shared by whoever holds it. */
function memLedger(
  lines: LedgerEntry[],
  options: { mode?: 'warn' | 'hard'; dailyUsd?: number } = {},
): SpendLedger {
  let offset = 0;
  const store: LedgerStore = {
    readNew: () => {
      const entries = lines.slice(offset);
      offset = lines.length;
      return { reset: false, entries };
    },
    append: (entry) => {
      lines.push(entry);
    },
  };
  return createSpendLedger({
    store,
    clock: fakeClock(Date.UTC(2026, 10, 26, 12)),
    mode: options.mode ?? 'warn',
    ...(options.dailyUsd !== undefined ? { dailyUsd: options.dailyUsd } : {}),
  });
}

const sumOf = (lines: readonly LedgerEntry[]): number =>
  Math.round(lines.reduce((acc, l) => acc + l.usd, 0) * 1e6) / 1e6;

test('LEDGER-2: check persists the same price the session budget charges', () => {
  const lines: LedgerEntry[] = [];
  const budget = createSessionBudget();
  const gate = createBudgetGate(budget, undefined, memLedger(lines));
  gate.check({ class: 'w:dm' }, 'x_dm_send');
  assert.equal(budget.total(), 0.015);
  assert.equal(sumOf(lines), 0.015);
});

test('LEDGER-3: a hard ledger refusal moves neither the session budget nor the ledger', () => {
  const lines: LedgerEntry[] = [{ at: Date.UTC(2026, 10, 26, 1), usd: 0.99 }];
  const budget = createSessionBudget({ mode: 'hard' });
  const spend = createSpendByTool();
  const gate = createBudgetGate(budget, spend, memLedger(lines, { mode: 'hard', dailyUsd: 1 }));
  assert.throws(
    () => gate.check({ class: 'w:dm', note: 'Priced as 1 DM.' }, 'x_dm_send'),
    (err: unknown) =>
      XError.is(err) &&
      err.kind === 'budget' &&
      /daily budget of \$1\. Priced as 1 DM\./.test(err.message),
  );
  assert.equal(budget.total(), 0);
  assert.equal(lines.length, 1);
  assert.deepEqual(spend.snapshot(), {});
});

test('LEDGER-3: a hard SESSION refusal never reaches the ledger', () => {
  const lines: LedgerEntry[] = [];
  const budget = createSessionBudget({ limit: 0.01, mode: 'hard' });
  const gate = createBudgetGate(budget, undefined, memLedger(lines));
  assert.throws(
    () => gate.check({ class: 'w:dm' }),
    (err: unknown) => XError.is(err) && err.kind === 'budget',
  );
  assert.equal(lines.length, 0);
});

test('LEDGER-3: the ledger warning is appended to the session meta', () => {
  const lines: LedgerEntry[] = [{ at: Date.UTC(2026, 10, 26, 1), usd: 0.9 }];
  const gate = createBudgetGate(
    createSessionBudget(),
    undefined,
    memLedger(lines, { dailyUsd: 1 }),
  );
  const estimate: CostEstimate = { class: 'w:dm' };
  gate.check(estimate);
  const meta = gate.reserve(estimate);
  assert.equal(meta.cost_usd, 0.015);
  assert.match(meta.budget_warning ?? '', /^Persisted daily spend \$0\.915 .* ~92%/);
});

test('LEDGER-4: settle and release move the ledger by the same difference as the session', () => {
  const lines: LedgerEntry[] = [];
  const budget = createSessionBudget();
  const gate = createBudgetGate(budget, undefined, memLedger(lines));
  const page: CostEstimate = { class: 'r:post' };
  gate.check(page);
  gate.reserve(page, 42);
  assert.equal(budget.total(), 0.21);
  assert.equal(sumOf(lines), 0.21);

  const refused: CostEstimate = { class: 'w:post' };
  gate.check(refused);
  gate.release(refused);
  assert.equal(budget.total(), 0.21);
  assert.equal(sumOf(lines), 0.21);
  assert.equal(lines.length, 4); // reserve, settle delta, reserve, release delta
});

test('LEDGER-8: a $0 local call leaves the ledger file untouched', () => {
  const lines: LedgerEntry[] = [];
  const gate = createBudgetGate(createSessionBudget(), undefined, memLedger(lines));
  const estimate: CostEstimate = { class: 'local' };
  gate.check(estimate);
  gate.reserve(estimate);
  gate.release(estimate);
  assert.equal(lines.length, 0);
});

test('LEDGER-9: the dry-run quote checks the ledger but persists nothing', () => {
  const lines: LedgerEntry[] = [{ at: Date.UTC(2026, 10, 26, 1), usd: 0.99 }];
  const budget = createSessionBudget({ mode: 'hard' });
  const hard = createBudgetGate(budget, undefined, memLedger(lines, { mode: 'hard', dailyUsd: 1 }));
  assert.throws(
    () => hard.quote({ class: 'w:dm' }),
    (err: unknown) => XError.is(err) && err.kind === 'budget',
  );
  const warn = createBudgetGate(
    createSessionBudget(),
    undefined,
    memLedger(lines, { dailyUsd: 1 }),
  );
  const quote = warn.quote({ class: 'r:post' });
  assert.match(quote.projected.budget_warning ?? '', /~100%/);
  assert.equal(lines.length, 1);
});

test('the defensive reserve-without-check path also persists to the ledger', () => {
  const lines: LedgerEntry[] = [];
  const gate = createBudgetGate(createSessionBudget(), undefined, memLedger(lines));
  gate.reserve({ class: 'r:post' }, 2);
  assert.equal(sumOf(lines), 0.01);
});
