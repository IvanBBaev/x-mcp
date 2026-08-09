// COST-6 — capture a REAL pay-per-use billing rejection. GATED (`capture` tier).
//
// docs/07 COST-6 is the one corner case Phase 1 could not close: nobody in this project has
// seen what X actually returns when a pay-per-use account's credit runs out. The fixture
// standing in for it (`test/fixtures/errors/403-billing-access-level.json`) says PROVISIONAL
// in its own `_provenance` because it is an informed guess.
//
// This test does not simulate that state — it cannot. It requires an operator to deliberately
// exhaust the credit on a throwaway account and then set `X_MCP_LIVE_CAPTURE=1`, which is why
// the capture has its own third opt-in on top of `X_MCP_LIVE_TEST=1`. What it does is make
// the recording repeatable and the promotion mechanical: issue ONE cheap read, and if the
// production error mapper classifies the rejection as `billing`, write the raw status,
// headers and body to `test/fixtures/errors/*.captured.json` with a `_provenance` string that
// is a numbered promotion checklist.
//
// THREE OUTCOMES, all of them useful, none of them silent:
//   * `billing`  — the artifact is written and the promotion block is printed. PASS.
//   * success    — the account still has credit, so there is nothing to capture. PASS, with
//                  a message saying what the operator must do first. Failing here would
//                  punish someone for having a working account.
//   * any other  — auth, scope, rate-limit, network... FAIL, loudly. A capture run that
//                  quietly recorded nothing because the token expired is worse than no run.
//
// Cost: one `GET /2/users/me` (`owned`, $0.001). Against an exhausted account it is rejected
// and costs nothing at all.

import assert from 'node:assert/strict';

import { mapHttpError } from '../../src/api/errors.js';
import { getMe } from '../../src/api/endpoints/users.js';
import { XError } from '../../src/core/errors.js';

import {
  buildBillingFixture,
  createBillingRecorder,
  createLiveInvoker,
  liveTest,
  openLiveSession,
  promotionInstructions,
  writeCapturedFixture,
} from './harness/index.js';

const CAPTURE_ENDPOINT = 'GET /2/users/me';

liveTest('live capture: record a real billing rejection (COST-6)', 'capture', async () => {
  const session = await openLiveSession();
  try {
    // The recorder wraps the PRODUCTION mapper, so the decision "is this billing?" is the
    // shipped classification (api/errors `mapHttpError`); the recorder only observes it.
    const recorder = createBillingRecorder(mapHttpError);
    const http = createLiveInvoker({ config: session.config, mapError: recorder.mapError });

    // Through the guard like every other live call — a capture run is still a spend.
    session.guard.authorize({ tool: 'harness:cost6-probe', units: 1, cost: 'owned' });

    let rejection: unknown;
    let succeeded = false;
    try {
      await getMe(http);
      succeeded = true;
    } catch (err) {
      rejection = err;
    }

    if (succeeded) {
      console.log(
        'COST-6: nothing to capture — the request SUCCEEDED, so this account still has ' +
          'pay-per-use credit. Exhaust the credit on the throwaway account first, then ' +
          're-run with X_MCP_LIVE_CAPTURE=1 (docs/14-live-testing.md §6).',
      );
      return;
    }

    assert.ok(
      XError.is(rejection),
      `the X API rejected the probe with a non-XError: ${String(rejection)}`,
    );

    if (rejection.kind !== 'billing') {
      // Deliberately a failure: a capture run must never end "green, captured nothing".
      assert.fail(
        `COST-6 capture: ${CAPTURE_ENDPOINT} was rejected as \`${rejection.kind}\`, not ` +
          `\`billing\` — ${rejection.message}\n` +
          'Nothing was captured. Fix the underlying problem (usually an expired token or a ' +
          'missing scope) and re-run; an `auth` or `rate-limit` rejection says nothing about ' +
          'what an out-of-credit account returns.',
      );
    }

    const captured = recorder.captured[0];
    assert.ok(
      captured !== undefined,
      'the mapper classified the rejection as `billing` but the recorder saw nothing — the ' +
        'recording mapper is not wired into the client that made the call',
    );

    const path = writeCapturedFixture(
      buildBillingFixture(captured, {
        endpoint: CAPTURE_ENDPOINT,
        authContext: session.config.authMode === 'oauth2' ? 'oauth2 user context' : 'app-only',
        capturedAt: new Date().toISOString(),
      }),
    );
    console.log(promotionInstructions(path));

    // The artifact must be usable as a fixture, not just written.
    assert.equal(typeof captured.status, 'number');
    assert.ok(captured.status >= 400, 'a billing rejection is an error status');
  } finally {
    await session.printSummary();
    await session.close();
  }
});
