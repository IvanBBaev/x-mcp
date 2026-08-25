// Cheap live read spot-checks — the live half of T-132 / DRIFT-1. GATED (`read` tier).
//
// docs/05 §1 puts "do the recorded fixtures still match reality?" in the live layer, because
// no offline test can answer it. This file answers it for four of the fixtures the offline
// suite leans on hardest, by calling the SAME production endpoint wrapper each fixture was
// captured through and comparing response SHAPES (harness/drift.ts) rather than values.
//
// Budget: four API requests, all reads, well inside the 20-unit cap docs/05 §6 sets. Each
// one is authorized through the shared spend guard before it is issued, so the cap is
// enforced here exactly as it is for a tool call — the probes bypass the MCP pipeline (they
// need RAW envelopes to compare against raw fixtures) but they do not bypass the budget.
//
// Failure policy, restated from harness/drift.ts because it is the thing a reader will
// question: only a TYPE CONFLICT on a shared path, or a declared-required path missing from
// the live response, fails the test. Fields that come and go are printed, not failed on — a
// user with no `location` or a post with no `note_tweet` is normal, and a check that cries
// wolf on those would be turned off within a month.

import assert from 'node:assert/strict';

import { mapHttpError } from '../../src/api/errors.js';
import { getPosts } from '../../src/api/endpoints/posts.js';
import { searchRecent } from '../../src/api/endpoints/search.js';
import { getMe, getUsersByUsernames } from '../../src/api/endpoints/users.js';
import type { RawListResponse, RawTweet, RawUser } from '../../src/core/render.js';

import { loadFixture } from '../helpers/index.js';
import {
  assertNoBreakingDrift,
  createLiveInvoker,
  diffShapes,
  formatDrift,
  liveTest,
  openLiveSession,
  shapeOf,
  stripFixtureMeta,
} from './harness/index.js';
import type { LiveSession } from './harness/index.js';

/**
 * A public account that is certain to exist, be readable app-only, and carry a rich profile
 * — so the informational half of the diff stays short. Not the test account: a brand-new
 * dedicated account has almost no profile fields set, which would bury the real signal.
 */
const PROBE_HANDLE = 'X';

/** A recent-search query that reliably returns something without being noisy. */
const PROBE_QUERY = `from:${PROBE_HANDLE} -is:retweet`;

function log(line: string): void {
  console.log(line);
}

/** Compare one live envelope against one fixture and print the readable diff. */
function checkDrift(
  label: string,
  fixturePath: string,
  live: unknown,
  required: readonly string[],
): void {
  const fixture = stripFixtureMeta(loadFixture(fixturePath));
  const report = diffShapes(shapeOf(fixture), shapeOf(live), required);
  log(formatDrift(label, fixturePath, report));
  assertNoBreakingDrift(label, fixturePath, report);
}

liveTest('live reads: recorded fixture shapes still match the X API', 'read', async () => {
  const session: LiveSession = await openLiveSession();
  try {
    // The probes need RAW envelopes, so they go through a production http client of their
    // own rather than the tool pipeline. Same client, same auth, same error mapper as
    // mcp/compose builds — only the caller differs.
    const http = createLiveInvoker({ config: session.config, mapError: mapHttpError });

    // --- P1: users/by-username.json (GET /2/users/by) -----------------------------
    session.guard.authorize({ tool: 'harness:getUsersByUsernames', units: 1, cost: 'r:user' });
    const users: RawListResponse<RawUser> = await getUsersByUsernames(http, [PROBE_HANDLE]);
    checkDrift('user batch lookup', 'users/by-username.json', users, [
      'data',
      'data[]',
      'data[].id',
      'data[].username',
    ]);

    // --- P2: search/recent-page.json (GET /2/tweets/search/recent) ----------------
    session.guard.authorize({ tool: 'harness:searchRecent', units: 1, cost: 'r:post' });
    const search: RawListResponse<RawTweet> = await searchRecent(http, {
      query: PROBE_QUERY,
      maxResults: 10,
    });
    checkDrift('recent search page', 'search/recent-page.json', search, ['meta']);

    // --- P3: posts/two-posts.json (GET /2/tweets?ids=…) ---------------------------
    // Ids come from P2 so the probe needs no hard-coded post id that could be deleted.
    const ids = (search.data ?? [])
      .map((post) => post.id)
      .filter((id): id is string => id !== undefined)
      .slice(0, 2);
    if (ids.length === 0) {
      log(`drift check: post batch lookup SKIPPED — "${PROBE_QUERY}" returned no recent posts`);
    } else {
      session.guard.authorize({ tool: 'harness:getPosts', units: 1, cost: 'r:post' });
      const posts: RawListResponse<RawTweet> = await getPosts(http, { ids });
      checkDrift('post batch lookup', 'posts/two-posts.json', posts, [
        'data',
        'data[]',
        'data[].id',
        'data[].text',
      ]);
    }

    // --- P4: users/me.json (GET /2/users/me) --------------------------------------
    // User context only: app-only auth has no "me", and X answers 401 there by design.
    if (session.config.authMode === 'oauth2') {
      session.guard.authorize({ tool: 'harness:getMe', units: 1, cost: 'owned' });
      const me = await getMe(http);
      checkDrift('authenticated user', 'users/me.json', me, ['data', 'data.id', 'data.username']);
    } else {
      log('drift check: authenticated user SKIPPED — app-only auth has no /2/users/me');
    }

    // The unit rail must have absorbed every probe; nothing may have slipped past it.
    const report = session.guard.report();
    assert.ok(
      report.unitsUsed <= report.unitCap,
      `spend guard reports ${String(report.unitsUsed)} units, cap ${String(report.unitCap)}`,
    );
  } finally {
    await session.printSummary();
    await session.close();
  }
});
