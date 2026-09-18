// Tests for test/live/harness/account.ts — the dedicated-account check. UNGATED: this file
// runs in the normal `node --test` suite, in CI, on every commit.
//
// docs/05 §6 says live writes go only against the dedicated test account, never a personal
// one. harness/account.ts turns that sentence into a comparison between the handle the
// operator declared (`X_MCP_LIVE_ACCOUNT`) and the handle the X API reports for the stored
// token, and the write tier refuses unless the two agree. The comparison is pure, so every
// branch of it is driven here from plain strings — no network, no token file, no dependence
// on the ambient `process.env`. The thing worth proving beyond the happy path is that there
// is no way through by omission: an unset, blank, unreported, or mismatched handle each
// refuses, and the reason names what was compared. A false refusal costs an operator a
// puzzled minute; a false acceptance costs a public post from the wrong account.

import test from 'node:test';
import assert from 'node:assert/strict';

import { assertDedicatedAccount, checkDedicatedAccount } from './harness/account.js';
import type { AccountVerdict } from './harness/account.js';

/** Every spelling of the dedicated account an operator or the API might produce. */
const FORMS_OF_TESTBED: readonly string[] = [
  'mytestbed',
  'MyTestbed',
  'MYTESTBED',
  '@mytestbed',
  '@MyTestbed',
  '  @MyTestbed  ',
  '@@MYTESTBED',
];

/** Inputs that normalize to "no handle at all". */
const NOT_A_HANDLE: readonly (string | undefined)[] = [undefined, '', '   ', '@', '@@', ' @ '];

/** Handles that are NOT the dedicated account — including near misses that must not match. */
const OTHER_ACCOUNTS: readonly string[] = [
  'other',
  '@Other',
  'mytestbed2',
  'mytestbe',
  'my testbed',
  'my_testbed',
];

/** A refusal is `ok: false`, carries a printable reason, and never clears a handle. */
function assertRefusal(verdict: AccountVerdict, reason: RegExp, label: string): void {
  assert.equal(verdict.ok, false, `${label}: must refuse`);
  assert.match(verdict.reason, reason, label);
  assert.equal('handle' in verdict, false, `${label}: a refusal clears no handle`);
}

// --- The happy path ---------------------------------------------------------------------

test('declared and reported handles that name the same account verify, with the normalized handle', () => {
  const verdict = checkDedicatedAccount('mytestbed', 'mytestbed');
  assert.deepEqual(verdict, {
    ok: true,
    reason: 'verified: the stored credentials belong to @mytestbed',
    handle: 'mytestbed',
  });
});

test('the comparison is case-insensitive, because X handles are', () => {
  assert.equal(checkDedicatedAccount('MyTestbed', 'mytestbed').ok, true);
  assert.equal(checkDedicatedAccount('mytestbed', 'MYTESTBED').ok, true);
  assert.equal(checkDedicatedAccount('MyTestbed', 'mYtESTBED').handle, 'mytestbed');
});

test('the comparison is @-insensitive on BOTH sides, and trims surrounding whitespace', () => {
  assert.equal(checkDedicatedAccount('@MyTestbed', 'mytestbed').ok, true);
  assert.equal(checkDedicatedAccount('mytestbed', '@mytestbed').ok, true);
  assert.equal(checkDedicatedAccount('@@mytestbed', '@MyTestbed').ok, true);
  assert.equal(checkDedicatedAccount('  @MyTestbed  ', 'mytestbed ').ok, true);
  // Whatever the spelling, the cleared handle is the normalized one — no `@`, lower-case.
  for (const declared of FORMS_OF_TESTBED) {
    for (const reported of FORMS_OF_TESTBED) {
      const verdict = checkDedicatedAccount(declared, reported);
      assert.equal(verdict.ok, true, `${JSON.stringify([declared, reported])} must verify`);
      assert.equal(verdict.handle, 'mytestbed');
      assert.match(verdict.reason, /^verified: the stored credentials belong to @mytestbed$/);
    }
  }
});

// --- Refusal by omission --------------------------------------------------------------------

test('no declared handle refuses and tells the operator to set X_MCP_LIVE_ACCOUNT', () => {
  const verdict = checkDedicatedAccount(undefined, 'mytestbed');
  assertRefusal(verdict, /^X_MCP_LIVE_ACCOUNT is not set/, 'undefined declared');
  assert.match(
    verdict.reason,
    /refuses to post until the operator names the dedicated test account/,
  );
  assert.match(verdict.reason, /docs\/05 §6/);
});

test('a blank or @-only declared handle is "not set", not an empty account name', () => {
  for (const declared of NOT_A_HANDLE) {
    const verdict = checkDedicatedAccount(declared, 'mytestbed');
    assertRefusal(verdict, /^X_MCP_LIVE_ACCOUNT is not set/, JSON.stringify(declared));
  }
});

test('no reported handle refuses and names the declared account it could not verify against', () => {
  const verdict = checkDedicatedAccount('@MyTestbed', undefined);
  assertRefusal(
    verdict,
    /^X_MCP_LIVE_ACCOUNT is @mytestbed, but the X API reported no handle/,
    'none',
  );
  assert.match(verdict.reason, /Refusing to write\./);
  // The fix is spelled out: the scope the lookup needs, and the command that grants it.
  assert.match(verdict.reason, /`users\.read` scope/);
  assert.match(verdict.reason, /npx x-mcp-ai authorize/);
});

test('a blank or @-only reported handle is treated as "no handle", never as a match', () => {
  for (const reported of NOT_A_HANDLE) {
    const verdict = checkDedicatedAccount('mytestbed', reported);
    assertRefusal(verdict, /the X API reported no handle/, JSON.stringify(reported));
  }
});

test('when both handles are missing the declared one is reported first — fix the config first', () => {
  for (const declared of NOT_A_HANDLE) {
    for (const reported of NOT_A_HANDLE) {
      const verdict = checkDedicatedAccount(declared, reported);
      assertRefusal(
        verdict,
        /^X_MCP_LIVE_ACCOUNT is not set/,
        JSON.stringify([declared, reported]),
      );
    }
  }
});

// --- Refusal on mismatch ---------------------------------------------------------------------

test('a mismatch refuses with a reason naming BOTH accounts, normalized', () => {
  const verdict = checkDedicatedAccount('@MyTestbed', 'Personal');
  assertRefusal(verdict, /^refusing to write: /, 'mismatch');
  assert.match(verdict.reason, /X_MCP_LIVE_ACCOUNT declares @mytestbed/);
  assert.match(verdict.reason, /the stored credentials belong to @personal/);
  assert.match(verdict.reason, /never a personal one \(docs\/05 §6\)/);
});

test('nothing but case, @, and surrounding whitespace is normalized — no prefix or fuzzy match', () => {
  for (const other of OTHER_ACCOUNTS) {
    assertRefusal(
      checkDedicatedAccount('mytestbed', other),
      /^refusing to write: /,
      `reported ${other}`,
    );
    assertRefusal(
      checkDedicatedAccount(other, 'mytestbed'),
      /^refusing to write: /,
      `declared ${other}`,
    );
  }
});

// --- No "assume it is fine" branch ----------------------------------------------------------

test('over the whole input grid, ok is true ONLY when both sides name the same account', () => {
  const everything: readonly (string | undefined)[] = [
    ...FORMS_OF_TESTBED,
    ...NOT_A_HANDLE,
    ...OTHER_ACCOUNTS,
  ];
  let verified = 0;
  for (const declared of everything) {
    for (const reported of everything) {
      const verdict = checkDedicatedAccount(declared, reported);
      const label = JSON.stringify([declared, reported]);
      assert.ok(verdict.reason.length > 0, `${label}: every verdict carries a printable reason`);
      const bothTestbed =
        declared !== undefined &&
        reported !== undefined &&
        FORMS_OF_TESTBED.includes(declared) &&
        FORMS_OF_TESTBED.includes(reported);
      const bothSameOther =
        declared !== undefined &&
        reported !== undefined &&
        OTHER_ACCOUNTS.includes(declared) &&
        OTHER_ACCOUNTS.includes(reported) &&
        declared.replace(/^@/, '').toLowerCase() === reported.replace(/^@/, '').toLowerCase();
      // The check verifies an ACCOUNT, not "the testbed": two spellings of the same other
      // account agree too — that is the operator's declaration matching the token, which is
      // exactly the contract. Every other cell refuses.
      assert.equal(verdict.ok, bothTestbed || bothSameOther, `${label}: verdict`);
      if (verdict.ok) {
        verified += 1;
        assert.ok(verdict.handle !== undefined && verdict.handle.length > 0);
      } else {
        assert.equal('handle' in verdict, false, `${label}: a refusal clears no handle`);
      }
    }
  }
  assert.ok(verified > 0, 'the grid contains matching cells, so the check is not always-refuse');
});

// --- The throwing form ---------------------------------------------------------------------

test('assertDedicatedAccount returns the normalized handle when the check verifies', () => {
  assert.equal(assertDedicatedAccount('@MyTestbed', 'MYTESTBED'), 'mytestbed');
});

test('assertDedicatedAccount throws the verdict reason, verbatim, for every kind of refusal', () => {
  const refusals: readonly [string | undefined, string | undefined][] = [
    [undefined, 'mytestbed'],
    ['   ', 'mytestbed'],
    ['mytestbed', undefined],
    ['mytestbed', '@'],
    ['mytestbed', 'personal'],
  ];
  for (const [declared, reported] of refusals) {
    const verdict = checkDedicatedAccount(declared, reported);
    assert.equal(verdict.ok, false);
    assert.throws(() => assertDedicatedAccount(declared, reported), {
      name: 'Error',
      message: verdict.reason,
    });
  }
});
