// The live-suite PREFLIGHT (docs/05 §1, §6). GATED — see test/live/harness/gate.ts.
//
// This file is the one place where asking for a live run and not being able to have one is
// LOUD. Every other live test skips when the environment is incomplete; this one fails, with
// the full list of what is missing. The asymmetry is on purpose:
//
//   * An operator who never set `X_MCP_LIVE_TEST` gets silence — the whole live tier skips,
//     the default `node --test` run stays green, and nothing tells them about credentials
//     they never asked to use.
//   * An operator who DID set `X_MCP_LIVE_TEST=1` and has an unusable environment gets
//     exactly one failure naming every problem. Skipping there would be worse than useless:
//     the run would report green while having tested nothing live.
//
// Not one assertion in this file makes a network call. `parseConfig` is pure, `composeServer`
// is pure wiring, and the checks below read only the resulting objects. That is what makes
// "X_MCP_LIVE_TEST=1 with no credentials" a clean refusal rather than a crash or, far worse,
// an attempted call with whatever credentials happened to be lying around.

import test from 'node:test';
import assert from 'node:assert/strict';

import { composeServer } from '../../src/mcp/compose.js';
import { parseConfig } from '../../src/core/config.js';

import {
  LIVE,
  LIVE_ACCOUNT_ENV,
  LIVE_DENIED_TOOLS,
  LIVE_READ_UNIT_CAP,
  LIVE_TEST_ENV,
  LIVE_USD_CAP,
  assertDenyListIntact,
  liveConfigEnv,
} from './harness/index.js';

if (!LIVE.requested) {
  test(
    'live preflight',
    {
      skip: `live tests are off — set ${LIVE_TEST_ENV}=1 to run them (docs/14-live-testing.md)`,
    },
    () => {
      /* never runs — the gate is shut */
    },
  );
} else {
  test('live preflight: the environment can actually run a live suite', () => {
    assert.deepEqual(
      LIVE.problems,
      [],
      `${LIVE_TEST_ENV}=1 was set, but this environment cannot run the live suite:\n` +
        LIVE.problems.map((p) => `  - ${p}`).join('\n') +
        '\n\nNothing was sent to the X API. See docs/14-live-testing.md §3 for the exact ' +
        'variables each tier needs.',
    );
  });

  test('live preflight: the run is capped at 20 read units and the derived USD ceiling', () => {
    const config = parseConfig(liveConfigEnv(process.env));
    const composition = composeServer(config);
    // Rail 2 (harness/spend.ts): the SERVER's own budget, forced regardless of the
    // operator's X_MCP_CREDIT_BUDGET, so a generous personal setting cannot raise the
    // live ceiling.
    assert.equal(composition.budget.mode, 'hard', 'the live server budget must be hard mode');
    assert.equal(composition.budget.limit, LIVE_USD_CAP);
    assert.equal(LIVE_READ_UNIT_CAP, 20, 'docs/05 §6 caps a live run at 20 read units');
  });

  test('live preflight: the archive deny list still names real tools', () => {
    const composition = composeServer(parseConfig(liveConfigEnv(process.env)));
    const names = composition.registry.all().map((tool) => tool.name);
    assertDenyListIntact(names);
    for (const denied of LIVE_DENIED_TOOLS) {
      assert.ok(names.includes(denied), `${denied} must exist for the deny list to mean anything`);
    }
  });

  test(
    'live preflight: the write tier knows which account it may touch',
    {
      skip: LIVE.account === undefined ? `writes are off — ${LIVE_ACCOUNT_ENV} is not set` : false,
    },
    () => {
      assert.ok(LIVE.account !== undefined);
      assert.doesNotMatch(LIVE.account, /^@/, 'the handle is normalized before comparison');
      assert.equal(LIVE.account, LIVE.account.toLowerCase());
    },
  );
}
