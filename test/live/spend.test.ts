// Tests for test/live/harness/spend.ts — the live-suite spend guard. UNGATED: this file runs
// in the normal `node --test` suite, in CI, on every commit.
//
// This is the guard that stands between the suite and a real invoice. docs/05 §6 allows a
// live run at most 20 read units and forbids the archive endpoints outright, and the guard is
// the only place either rule is enforced — on the single seam every live call goes through
// (harness/session.ts `call`), BEFORE the request is issued. The live suite itself cannot run
// in CI (it spends real money and posts publicly, docs/05 §7), so the only thing CI can do
// about a bug in the guard is to catch it here, on in-memory guards, before a live run finds
// it with real dollars. Both rails, every refusal, the ledger, the deny list, and the
// derivation of the money cap from the production cost table are driven here — with no
// network, no filesystem, and no dependence on the ambient `process.env`.
//
// The money cap is asserted as a DERIVATION (`20 x` the priciest read unit in `COST_TABLE`),
// never as `$0.20`: if X reprices a read class the expected value moves with the table, and
// a guard that silently kept an old constant would fail here rather than under-charge live.

import test from 'node:test';
import assert from 'node:assert/strict';

import { COST_TABLE, priceOf } from '../../src/core/budget.js';
import { XError } from '../../src/core/errors.js';
import { COST_CLASSES } from '../../src/core/tooldef.js';
import type { CostClass } from '../../src/core/tooldef.js';
import { archiveTools } from '../../src/tools/archive.js';
import { xPostCreate } from '../../src/tools/posts.js';

import {
  LIVE_DENIED_TOOLS,
  LIVE_READ_UNIT_CAP,
  LIVE_USD_CAP,
  READ_COST_CLASSES,
  assertDenyListIntact,
  createLiveSpendGuard,
  deniedToolMessage,
  maxReadUnitUsd,
} from './harness/spend.js';
import type { LiveCall } from './harness/spend.js';

/** Round the way core/budget and the guard do, so derived expectations compare exactly. */
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** A one-unit call of the given class — what a live spot-check declares. */
const call = (cost: LiveCall['cost'], tool = 'x_user_get', units = 1): LiveCall => ({
  tool,
  units,
  cost,
});

/** The typed `budget` refusal core/budget raises in `hard` mode — the thing a rail throws. */
const refusedByBudget = (err: unknown): boolean =>
  err instanceof XError && err.kind === 'budget' && /over the credit budget/.test(err.message);

/**
 * The priciest read class in the production table, found by scanning the table itself. The
 * tests below use it wherever they need "a full-price read unit" so they follow a repricing.
 */
const priciestRead: CostClass = READ_COST_CLASSES.reduce((best, c) =>
  COST_TABLE[c] > COST_TABLE[best] ? c : best,
);

/** A $0 engagement/moderation write — what the cleanup delete in the write e2e declares. */
const FREE_WRITE: CostClass = 'w:action';

// --- The two caps, derived from the production cost table ---------------------------

test('LIVE_READ_UNIT_CAP is the literal 20 read units docs/05 §6 allows one live run', () => {
  assert.equal(LIVE_READ_UNIT_CAP, 20);
});

test('READ_COST_CLASSES is the r:* family plus owned — no write class, no local', () => {
  assert.ok(READ_COST_CLASSES.length > 0);
  for (const cls of COST_CLASSES) {
    const isRead = cls.startsWith('r:') || cls === 'owned';
    assert.equal(READ_COST_CLASSES.includes(cls), isRead, `${cls} classified wrong`);
  }
  for (const cls of READ_COST_CLASSES) {
    assert.equal(cls.startsWith('w:'), false, `${cls} is a write class`);
    assert.notEqual(cls, 'local');
  }
  // Spelled out for the reader: the two classes the money rail exists to keep apart.
  assert.equal(READ_COST_CLASSES.includes('owned'), true);
  assert.equal(READ_COST_CLASSES.includes('w:post'), false);
});

test('maxReadUnitUsd is the priciest READ price in COST_TABLE, and a w:post costs more', () => {
  const expected = Math.max(...READ_COST_CLASSES.map((c) => COST_TABLE[c]));
  assert.equal(maxReadUnitUsd(), expected);
  assert.equal(maxReadUnitUsd(), COST_TABLE[priciestRead]);
  assert.ok(Number.isFinite(expected) && expected > 0, 'a read unit costs real money');
  for (const c of READ_COST_CLASSES) assert.ok(COST_TABLE[c] <= maxReadUnitUsd());
  // The premise the money rail is built on (harness/spend.ts header): for pure reads the
  // two rails coincide, and they DIVERGE for a post — a post costs more than any read unit.
  assert.ok(COST_TABLE['w:post'] > maxReadUnitUsd(), 'w:post must exceed every read unit');
});

test('LIVE_USD_CAP is DERIVED as the unit cap times the priciest read unit, not hard-coded', () => {
  // Computed here from COST_TABLE and COST_CLASSES directly, without the module's own
  // helper, so this test does not merely restate `maxReadUnitUsd()`.
  const priciestUnit = COST_CLASSES.filter((c) => c.startsWith('r:') || c === 'owned').reduce(
    (max, c) => Math.max(max, COST_TABLE[c]),
    0,
  );
  assert.equal(LIVE_USD_CAP, round6(LIVE_READ_UNIT_CAP * priciestUnit));
  assert.equal(LIVE_USD_CAP, round6(LIVE_READ_UNIT_CAP * maxReadUnitUsd()));
  assert.ok(LIVE_USD_CAP > 0);
});

// --- The deny list -------------------------------------------------------------------

test('LIVE_DENIED_TOOLS names exactly the two archive endpoints docs/05 §6 bans', () => {
  assert.deepEqual([...LIVE_DENIED_TOOLS], ['x_search_archive', 'x_post_counts_archive']);
});

test('a denied tool is refused by NAME before anything else, and nothing is charged', () => {
  for (const tool of LIVE_DENIED_TOOLS) {
    const guard = createLiveSpendGuard();
    // The call is deliberately ALSO invalid on both rails and on validation: zero units and a
    // price a thousand times the cap. The deny list must answer first — no unit message, no
    // budget error, the archive refusal and nothing else.
    assert.throws(
      () =>
        guard.authorize({ tool, units: 0, cost: { class: 'r:post', usd: LIVE_USD_CAP * 1000 } }),
      { message: deniedToolMessage(tool) },
    );
    // And it is refused even as a perfectly ordinary one-unit read — the NAME is the ban.
    assert.throws(() => guard.authorize(call('r:post', tool)), {
      message: deniedToolMessage(tool),
    });
    assert.deepEqual(guard.report(), {
      unitsUsed: 0,
      unitCap: LIVE_READ_UNIT_CAP,
      usdUsed: 0,
      usdCap: LIVE_USD_CAP,
      calls: [],
    });
  }
});

test('deniedToolMessage names the tool, the policy, that nothing was sent, and the whole list', () => {
  const message = deniedToolMessage('x_search_archive');
  assert.match(message, /^live suite refuses to call x_search_archive:/);
  assert.match(message, /docs\/05 §6/);
  assert.match(message, /Nothing was sent\./);
  for (const name of LIVE_DENIED_TOOLS) assert.ok(message.includes(name), `lists ${name}`);
});

test('the deny list matches exact names only — a lookalike falls through to the rails', () => {
  // This is precisely why assertDenyListIntact exists (below): a renamed tool would not be
  // caught by this string comparison, so the rename has to be caught structurally instead.
  const guard = createLiveSpendGuard();
  guard.authorize(call('r:post', 'x_search_archive_v2'));
  guard.authorize(call('r:post', 'X_SEARCH_ARCHIVE'));
  assert.equal(guard.report().unitsUsed, 2);
});

// --- Unit validation -------------------------------------------------------------------

test('a unit count that is not a positive integer is refused before either rail is touched', () => {
  const guard = createLiveSpendGuard();
  for (const units of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => guard.authorize(call('r:post', 'x_post_get', units)), {
      message: /declared .* read units — must be a positive integer/,
    });
  }
  assert.equal(guard.report().unitsUsed, 0);
  assert.equal(guard.report().usdUsed, 0);
  assert.deepEqual(guard.report().calls, []);
});

// --- Rail 1: the unit cap ----------------------------------------------------------------

test('the unit rail accepts the 20th unit and refuses the 21st — the suite stops BEFORE the cap', () => {
  // $0 writes, so the money rail cannot be the one refusing: this isolates the unit rail.
  const guard = createLiveSpendGuard();
  for (let i = 0; i < LIVE_READ_UNIT_CAP; i += 1)
    guard.authorize(call(FREE_WRITE, 'x_post_delete'));
  assert.equal(guard.report().unitsUsed, LIVE_READ_UNIT_CAP);
  assert.equal(guard.report().usdUsed, 0);

  assert.throws(() => guard.authorize(call(FREE_WRITE, 'x_post_delete')), refusedByBudget);
  assert.equal(guard.report().unitsUsed, LIVE_READ_UNIT_CAP, 'the refused unit was not charged');
  assert.equal(guard.report().calls.length, LIVE_READ_UNIT_CAP);
});

test('a multi-unit call that would cross the unit cap is refused whole and charges nothing', () => {
  // A paginated read declares one unit per page. 18 + 3 crosses the cap: the whole call is
  // refused, not trimmed to the two pages that would fit — check-before-mutate, dogfooded.
  const guard = createLiveSpendGuard();
  guard.authorize(call(FREE_WRITE, 'x_post_delete', 18));
  assert.throws(() => guard.authorize(call(FREE_WRITE, 'x_timeline_home', 3)), refusedByBudget);
  assert.equal(guard.report().unitsUsed, 18);
  assert.equal(guard.report().calls.length, 1);
});

test('once the unit rail is full every later authorize refuses — even a $0 write, even local', () => {
  // The fail-closed property the guard actually delivers: a unit count is always >= 1, so a
  // full unit rail refuses every conceivable call, whatever the money rail would say.
  const guard = createLiveSpendGuard();
  guard.authorize(call(FREE_WRITE, 'x_post_delete', LIVE_READ_UNIT_CAP));
  assert.throws(() => guard.authorize(call(FREE_WRITE, 'x_post_delete')), refusedByBudget);
  assert.throws(() => guard.authorize(call('local', 'harness:probe')), refusedByBudget);
  assert.throws(() => guard.authorize(call('owned', 'x_usage_get')), refusedByBudget);
  assert.equal(guard.report().unitsUsed, LIVE_READ_UNIT_CAP);
});

// --- Rail 2: the money cap ----------------------------------------------------------------

test('the money rail refuses a call whose price would carry the run past LIVE_USD_CAP', () => {
  const guard = createLiveSpendGuard();
  const oneUnitOverTheCap = { class: priciestRead, usd: round6(LIVE_USD_CAP + maxReadUnitUsd()) };
  assert.throws(() => guard.authorize(call(oneUnitOverTheCap, 'x_user_get')), refusedByBudget);
  assert.equal(guard.report().usdUsed, 0, 'a refused reservation spends nothing');
  assert.deepEqual(guard.report().calls, []);
});

test('COST-1: a rail refusal is the typed budget error the model cannot talk its way past', () => {
  const guard = createLiveSpendGuard();
  assert.throws(
    () => guard.authorize(call({ class: 'r:post', usd: round6(LIVE_USD_CAP * 2) })),
    (err: unknown) => {
      assert.ok(err instanceof XError);
      assert.equal(err.kind, 'budget');
      assert.match(err.message, /operator-set limit; cannot be changed from within this session/);
      return true;
    },
  );
});

test('COST-5: landing exactly on the money cap is allowed, the next paid call is refused', () => {
  const guard = createLiveSpendGuard();
  guard.authorize(call({ class: priciestRead, usd: LIVE_USD_CAP }, 'x_user_get'));
  assert.equal(guard.report().usdUsed, LIVE_USD_CAP);

  // The cheapest priced read in the table is still too much.
  const cheapest = READ_COST_CLASSES.reduce((best, c) =>
    COST_TABLE[c] < COST_TABLE[best] ? c : best,
  );
  assert.ok(COST_TABLE[cheapest] > 0);
  assert.throws(() => guard.authorize(call(cheapest)), refusedByBudget);
  assert.equal(guard.report().usdUsed, LIVE_USD_CAP);
  assert.equal(guard.report().unitsUsed, 2, 'the unit charge of the refused call stands');
});

test('at the money cap a $0 cleanup delete is still authorized while the unit rail has room', () => {
  // A run that spent its whole money allowance must still be able to delete what it created
  // (docs/05 §6: cleanup in a `finally`) — x_post_delete is `w:action`, priced $0. Only the
  // unit rail can close that door, and it does so on its own terms (tested above).
  const guard = createLiveSpendGuard();
  guard.authorize(call({ class: priciestRead, usd: LIVE_USD_CAP }, 'x_user_get'));
  guard.authorize(call(FREE_WRITE, 'x_post_delete'));
  assert.equal(guard.report().unitsUsed, 2);
  assert.equal(guard.report().usdUsed, LIVE_USD_CAP);
});

test('for pure reads the two rails coincide: 20 priciest-class reads land on both caps at once', () => {
  const guard = createLiveSpendGuard();
  for (let i = 0; i < LIVE_READ_UNIT_CAP; i += 1) guard.authorize(call(priciestRead));
  const report = guard.report();
  assert.equal(report.unitsUsed, report.unitCap);
  assert.equal(report.usdUsed, report.usdCap);
  // The 21st read is refused — by the unit rail and the money rail alike; either suffices.
  assert.throws(() => guard.authorize(call(priciestRead)), refusedByBudget);
});

test('when the money rail refuses after the unit rail charged, the unit charge STANDS', () => {
  // Deliberate (harness/spend.ts header): the guard never refunds. The refused call does not
  // appear in the ledger, so `unitsUsed` is one more than the ledger accounts for — the
  // asymmetry is the evidence that nothing was given back.
  const guard = createLiveSpendGuard();
  guard.authorize(call(priciestRead));
  assert.throws(
    () => guard.authorize(call({ class: 'w:post', usd: LIVE_USD_CAP }, 'x_post_create')),
    refusedByBudget,
  );
  const report = guard.report();
  assert.equal(report.unitsUsed, 2);
  assert.equal(report.usdUsed, COST_TABLE[priciestRead]);
  assert.equal(report.calls.length, 1);
});

test('a refusal does NOT latch: a later call that still fits both rails is authorized', () => {
  // Deliberate, and the header says why: the call after a refusal is the cleanup delete
  // `withCleanup` runs on the way out (write-e2e.live.test.ts), and a guard that kept saying
  // no after one no would leave the live post standing. The caps bound the run, not a latch —
  // the refused call's units stay spent, so the allowance only ever shrinks.
  const guard = createLiveSpendGuard();
  guard.authorize(call(priciestRead));
  assert.throws(
    () => guard.authorize(call({ class: 'w:post', usd: LIVE_USD_CAP }, 'x_post_create')),
    refusedByBudget,
  );
  guard.authorize(call(FREE_WRITE, 'x_post_delete'));
  guard.authorize(call(priciestRead));
  const report = guard.report();
  assert.equal(report.calls.length, 3);
  assert.equal(report.unitsUsed, 4, 'the refused call is the one unit the ledger does not show');
  assert.equal(report.usdUsed, round6(2 * COST_TABLE[priciestRead]));
});

test('authorize throws synchronously, so the session pattern cannot send after a refusal', () => {
  // harness/session.ts `raw` is `guard.authorize(call); await client.callTool(...)`. Modelled
  // here with a recorder in place of the client: a refusal must leave the recorder untouched.
  const guard = createLiveSpendGuard({ unitCap: 1 });
  const sent: string[] = [];
  const send = (c: LiveCall): void => {
    guard.authorize(c);
    sent.push(c.tool);
  };
  send(call('r:post', 'x_post_get'));
  assert.throws(() => send(call('r:post', 'x_post_get')), refusedByBudget);
  assert.throws(() => send(call('r:post', 'x_search_archive')), { message: /deny list/ });
  assert.deepEqual(sent, ['x_post_get']);
});

// --- The ledger and the summary -----------------------------------------------------------

test('the report accounts every authorized call in order, with its units and resolved price', () => {
  const guard = createLiveSpendGuard();
  guard.authorize(call('r:user', 'x_user_get'));
  // A count-multiplied read, priced the way the registry prices it: unit price x resources.
  const twoPosts = round6(2 * COST_TABLE['r:post']);
  guard.authorize({ tool: 'x_post_get', units: 2, cost: { class: 'r:post', usd: twoPosts } });
  guard.authorize(call(FREE_WRITE, 'x_post_delete'));

  const report = guard.report();
  assert.equal(report.unitsUsed, 4);
  assert.equal(report.unitCap, LIVE_READ_UNIT_CAP);
  assert.equal(report.usdUsed, round6(COST_TABLE['r:user'] + twoPosts));
  assert.equal(report.usdCap, LIVE_USD_CAP);
  assert.deepEqual(report.calls, [
    `x_user_get x1 ($${COST_TABLE['r:user'].toFixed(4)})`,
    `x_post_get x2 ($${twoPosts.toFixed(4)})`,
    'x_post_delete x1 ($0.0000)',
  ]);
  // The ledger prices what `priceOf` resolves — the override, when there is one.
  assert.equal(priceOf({ class: 'r:post', usd: twoPosts }), twoPosts);
});

test('the report is a snapshot — mutating it cannot rewrite the ledger', () => {
  const guard = createLiveSpendGuard();
  guard.authorize(call('r:user'));
  const calls = guard.report().calls as string[];
  calls.length = 0;
  assert.equal(guard.report().calls.length, 1);
});

test('the summary prints the docs/05 §6 accounting: units, spend, and every call', () => {
  const guard = createLiveSpendGuard();
  const empty = guard.summary();
  assert.match(empty, /^live session budget summary \(docs\/05 §6\)/);
  assert.match(empty, new RegExp(`read units : 0 / ${String(LIVE_READ_UNIT_CAP)}`));
  assert.match(empty, new RegExp(`spend {6}: \\$0\\.0000 / \\$${LIVE_USD_CAP.toFixed(4)}`));
  assert.match(empty, /calls {6}: \(none\)/);

  guard.authorize(call('r:user', 'x_user_get'));
  guard.authorize(call(FREE_WRITE, 'x_post_delete'));
  const lines = guard.summary().split('\n');
  assert.match(lines[1] ?? '', new RegExp(`read units : 2 / ${String(LIVE_READ_UNIT_CAP)}`));
  assert.match(lines[2] ?? '', new RegExp(`\\$${COST_TABLE['r:user'].toFixed(4)} / `));
  assert.equal(
    lines.some((l) => l.includes('(none)')),
    false,
  );
  assert.equal(lines[4], `    - x_user_get x1 ($${COST_TABLE['r:user'].toFixed(4)})`);
  assert.equal(lines[5], '    - x_post_delete x1 ($0.0000)');
});

test('the test-only cap overrides shrink a rail without changing its arithmetic', () => {
  const units = createLiveSpendGuard({ unitCap: 2 });
  units.authorize(call(FREE_WRITE));
  units.authorize(call(FREE_WRITE));
  assert.throws(() => units.authorize(call(FREE_WRITE)), refusedByBudget);
  assert.equal(units.report().unitCap, 2);

  const usd = createLiveSpendGuard({ usdCap: COST_TABLE[priciestRead] });
  usd.authorize(call(priciestRead));
  assert.throws(() => usd.authorize(call(priciestRead)), refusedByBudget);
  assert.equal(usd.report().usdCap, COST_TABLE[priciestRead]);
});

// --- COST-4: the URL-post repricing --------------------------------------------------------

/**
 * Resolve x_post_create's per-call cost exactly as the registry does (`resolveCost`): the tool
 * declares a RESOLVER, not a class, and the resolved estimate is what a live test must hand the
 * guard. The guard never inspects the post text itself — it prices what it is told.
 */
function createCostFor(text: string): LiveCall['cost'] {
  const spec = xPostCreate.cost;
  assert.ok(typeof spec === 'function', 'x_post_create cost must be an input-dependent resolver');
  return spec({ text });
}

test('COST-4: a w:post whose text carries a URL reaches the guard repriced above the base price', () => {
  const plain = createCostFor('x-mcp live e2e — automated test post, deleted immediately.');
  const withUrl = createCostFor('x-mcp live e2e https://example.com/x — deleted immediately.');
  assert.equal(priceOf(plain), COST_TABLE['w:post']);
  assert.ok(typeof withUrl === 'object' && withUrl.class === 'w:post');
  assert.ok(priceOf(withUrl) > COST_TABLE['w:post'], 'the URL post is priced above the base');
  // The repricing is what the money rail is for: one URL post is the ENTIRE run allowance.
  assert.ok(priceOf(withUrl) >= LIVE_USD_CAP, 'a URL post consumes the whole live money cap');
});

test('COST-4: after the write tier has verified the account, the money rail refuses the URL post', () => {
  // Every write-tier test starts with `reportedHandle()` — one `r:user` read (harness/
  // session.ts) — so this is the state a URL post would actually meet. A base-priced post
  // fits; the same post with a URL does not, and the refusal happens before anything is sent.
  const guard = createLiveSpendGuard();
  guard.authorize(call('r:user', 'x_user_get'));

  const plain = createCostFor('x-mcp live e2e — automated test post, deleted immediately.');
  const withUrl = createCostFor('x-mcp live e2e https://example.com/x — deleted immediately.');
  assert.throws(() => guard.authorize(call(withUrl, 'x_post_create')), refusedByBudget);
  assert.equal(guard.report().calls.length, 1, 'the URL post never entered the ledger');
  assert.equal(guard.report().unitsUsed, 2, 'its unit charge stands (no refund)');

  guard.authorize(call(plain, 'x_post_create'));
  assert.equal(guard.report().usdUsed, round6(COST_TABLE['r:user'] + COST_TABLE['w:post']));
});

test('COST-4: on a fresh guard the URL post lands exactly on the cap and leaves no money for anything', () => {
  // The boundary is inclusive (COST-5), so a run that does NOTHING but a URL post is allowed to
  // — it spends the entire allowance in one call. Anything priced above $0 is then refused.
  const guard = createLiveSpendGuard();
  const withUrl = createCostFor('see https://example.com');
  // Today the URL price IS the cap (20 x the priciest read unit). If a repricing ever breaks
  // this equality, the header's "a single such call would consume the entire run budget"
  // needs rewording too — so fail here, loudly, rather than let that sentence drift.
  assert.equal(priceOf(withUrl), LIVE_USD_CAP);
  guard.authorize(call(withUrl, 'x_post_create'));
  assert.equal(guard.report().usdUsed, LIVE_USD_CAP);
  assert.throws(() => guard.authorize(call('owned', 'x_usage_get')), refusedByBudget);
});

// --- assertDenyListIntact -------------------------------------------------------------------

test('assertDenyListIntact passes when the registry exposes both denied names, extras and all', () => {
  assert.doesNotThrow(() =>
    assertDenyListIntact(['x_post_get', ...LIVE_DENIED_TOOLS, 'x_user_get', 'x_usage_get']),
  );
});

test('the shipped archive module still defines both denied names — the ban is intact today', () => {
  // The same check harness/session.ts runs against the composed registry at open time, run
  // here against the tool module the registry is composed from — offline, on every commit.
  const shipped = archiveTools.map((tool) => tool.name);
  assert.doesNotThrow(() => assertDenyListIntact(shipped));
  for (const name of LIVE_DENIED_TOOLS) assert.ok(shipped.includes(name), `${name} shipped`);
});

test('assertDenyListIntact throws naming the missing tool — a rename cannot silently un-ban it', () => {
  for (const missing of LIVE_DENIED_TOOLS) {
    const present = LIVE_DENIED_TOOLS.filter((name) => name !== missing);
    assert.throws(
      () => assertDenyListIntact(['x_post_get', ...present]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, new RegExp(`deny list names ${missing},`));
        for (const kept of present) assert.equal(err.message.includes(kept), false);
        assert.match(err.message, /a rename would silently disable the archive ban/);
        assert.match(err.message, /LIVE_DENIED_TOOLS/);
        return true;
      },
    );
  }
  // Both gone: both named.
  assert.throws(() => assertDenyListIntact(['x_post_get']), {
    message: new RegExp(`names ${LIVE_DENIED_TOOLS.join(', ')},`),
  });
});

test('assertDenyListIntact is exact-name: a renamed lookalike does not satisfy it', () => {
  assert.throws(() => assertDenyListIntact(['x_search_archive_v2', 'x_post_counts_archive']), {
    message: /names x_search_archive,/,
  });
  assert.throws(() => assertDenyListIntact(['X_SEARCH_ARCHIVE', 'x_post_counts_archive']), {
    message: /names x_search_archive,/,
  });
});
