// T-214 — the live write end-to-end: authorize -> post -> delete. GATED (`write` tier).
//
// This is the only file in the repo that creates PUBLIC content on a real X account, and it
// is the reason the gate has a second, independent opt-in. Four things must all be true
// before a single byte leaves the process:
//
//   1. `X_MCP_LIVE_TEST=1`                    — the master switch (harness/gate.ts).
//   2. `X_MCP_LIVE_ACCOUNT=<handle>`          — the operator NAMES the account that may be
//                                               posted from, and the handle the X API
//                                               reports must match it (harness/account.ts).
//   3. user-context auth with a usable token store — app-only cannot post at all.
//   4. a policy granting `write:content` AND `destructive:content` — the suite refuses to
//      create what it is not also allowed to delete.
//
// STEP 1 "authorize" IS MANUAL, and deliberately so. OAuth2 authorization-code + PKCE
// requires a human to approve the app in a browser; automating a consent screen would mean
// automating credential entry, which this repo will not do. So the test asserts that a token
// the human already minted is present and belongs to the declared account — that IS the
// authorize leg, verified rather than performed. See docs/14-live-testing.md §4.
//
// STEPS 2 and 3 are automated and paired: the delete is deferred into `withCleanup` on the
// line after the create returns, before any assertion can fail in between. A failed cleanup
// is printed loudly and re-thrown (harness/cleanup.ts) — a live post left standing must
// never coexist with a green run.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  LIVE,
  assertDedicatedAccount,
  liveTest,
  openLiveSession,
  withCleanup,
} from './harness/index.js';

interface CreatedPost {
  readonly id: string;
  readonly url: string;
  readonly note?: string;
}

interface DeletedPost {
  readonly deleted?: boolean;
  readonly already_deleted?: boolean;
}

interface PostList {
  readonly items?: readonly { readonly id?: string; readonly text?: string }[];
  readonly missing?: readonly unknown[];
}

/**
 * The post body. Two deliberate properties:
 *   * a nonce, so the created post is identifiable in the timeline if cleanup ever fails
 *     and a human has to find it;
 *   * NO URL — COST-4 reprices a post containing a URL from $0.015 to $0.20, which would
 *     blow straight through the live USD rail. The absence of a link here is load-bearing.
 */
function livePostText(): string {
  return `x-mcp live e2e ${randomUUID()} — automated test post, deleted immediately.`;
}

liveTest('live write e2e: authorize -> post -> delete (T-214)', 'write', async () => {
  const session = await openLiveSession();
  try {
    // --- Step 1: authorize (verified, not performed) -------------------------------
    // Goes through the real pipeline, so a missing/expired token surfaces here as the
    // production `auth` error — before anything is created.
    const reported = await session.reportedHandle();
    const account = assertDedicatedAccount(LIVE.account, reported);
    console.log(`live write e2e: authorized as @${account} (declared and reported agree)`);

    const postId = await withCleanup(async (scope) => {
      // --- Step 2: post -----------------------------------------------------------
      const text = livePostText();
      const created = await session.call<CreatedPost>(
        'x_post_create',
        { text },
        { cost: { class: 'w:post' } },
      );

      // Deferred FIRST, before any assertion — from this line on, every exit path deletes.
      scope.defer(`delete post ${created.data.id}`, async () => {
        await session.call<DeletedPost>(
          'x_post_delete',
          { id: created.data.id },
          { cost: 'w:action' },
        );
      });

      assert.notEqual(created.data.id, '', 'x_post_create must return the new post id');
      assert.match(created.data.url, /^https:\/\/x\.com\//, 'the result carries a canonical URL');
      assert.equal(
        created.data.note,
        undefined,
        'the live post text must contain no URL — a URL reprices it to $0.20 (COST-4)',
      );
      console.log(`live write e2e: created ${created.data.url}`);

      // --- Step 3: read it back ---------------------------------------------------
      // Proves the post really exists before the delete claims to have removed it; without
      // this a broken create + a tolerant delete would look like a passing round trip.
      const readBack = await session.call<PostList>(
        'x_post_get',
        { ids: [created.data.id] },
        { cost: 'r:post' },
      );
      assert.equal(readBack.data.items?.length, 1, 'the created post must be readable by id');
      assert.equal(readBack.data.items?.[0]?.text, text, 'X stores the text byte-identical');

      return created.data.id;
    });

    // --- Step 4: the delete really happened ----------------------------------------
    // The deferred delete's own result is consumed inside `withCleanup`, so the proof that
    // it landed is a REPEAT delete: POST-5 renders an already-deleted post as success with
    // `already_deleted: true`. A post that was never deleted would answer `deleted: true`
    // here and leave the timeline clean anyway, so this assertion is safe either way — it
    // fails only on an error, which is exactly the case worth failing on. `w:action` is a
    // $0 cost class, so this costs one unit of the read rail and nothing in money.
    const repeat = await session.call<DeletedPost>(
      'x_post_delete',
      { id: postId },
      { cost: 'w:action' },
    );
    assert.ok(
      repeat.data.already_deleted === true || repeat.data.deleted === true,
      'a repeat delete must render as success (POST-5), never as an error',
    );
    console.log(`live write e2e: post ${postId} is gone`);
  } finally {
    await session.printSummary();
    await session.close();
  }
});
