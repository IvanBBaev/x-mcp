// Tests for test/live/harness/gate.ts — the live-suite gate. UNGATED: this file runs in the
// normal `node --test` suite, in CI, on every commit.
//
// That is the whole point. The live suite itself cannot run in CI (it spends real money and
// posts publicly, docs/05 §7), so the only thing CI can protect is the LOGIC that decides
// whether the live suite may run at all. A gate that is never exercised is a gate nobody can
// trust — so every branch of it is driven here from injected env snapshots, with no
// dependence on the ambient `process.env` and no network of any kind.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVE_ACCOUNT_ENV,
  LIVE_CAPTURE_ENV,
  LIVE_ENV_VARS,
  LIVE_TEST_ENV,
  WRITE_TIER_CELLS,
  gateFor,
  liveEnvironment,
  missingWriteCells,
  normalizeHandle,
  stripLiveVars,
} from './harness/gate.js';
import type { EnvSnapshot, LiveEnvironment } from './harness/gate.js';

/**
 * `liveEnvironment` with its one piece of I/O stubbed: the token file is present unless a
 * test says otherwise. Everything here is offline by construction — no test in this file may
 * depend on whether the machine happens to have a token file at the configured path.
 */
const resolveLive = (env: EnvSnapshot, tokenFileExists = true): LiveEnvironment =>
  liveEnvironment(env, () => tokenFileExists);

/** A complete, valid oauth2 live environment. Individual tests take pieces away. */
const READY: EnvSnapshot = {
  [LIVE_TEST_ENV]: '1',
  X_MCP_AUTH_MODE: 'oauth2',
  X_MCP_CLIENT_ID: 'test-client-id',
  X_MCP_TOKEN_FILE: '/tmp/x-mcp-live-tokens.json',
};

/** The same, plus everything the write tier needs. */
const WRITE_READY: EnvSnapshot = {
  ...READY,
  [LIVE_ACCOUNT_ENV]: '@MyTestbed',
  X_MCP_POLICY: 'manage',
};

// --- The master switch -------------------------------------------------------------

test('the gate is SHUT when X_MCP_LIVE_TEST is unset — the dangerous default is impossible', () => {
  const live = resolveLive({});
  assert.equal(live.requested, false);
  for (const tier of ['read', 'write', 'capture'] as const) {
    const gate = gateFor(live, tier);
    assert.equal(gate.open, false);
    assert.match(gate.reason, /X_MCP_LIVE_TEST=1/);
  }
});

test('only the exact string "1" opens the master switch', () => {
  for (const value of ['', '0', 'true', 'yes', 'on', ' 1', '1 ', 'TRUE', '2']) {
    const live = resolveLive({ ...READY, [LIVE_TEST_ENV]: value });
    assert.equal(live.requested, false, `"${value}" must not open the gate`);
    assert.equal(gateFor(live, 'read').open, false);
  }
  assert.equal(resolveLive(READY).requested, true);
});

test('an operator who never asked for a live run is never told about missing credentials', () => {
  // `problems` is silence, not a diagnosis, when nothing was requested — otherwise the
  // default `node --test` run would nag about credentials the user has no reason to hold.
  const live = resolveLive({ X_MCP_AUTH_MODE: 'oauth2' });
  assert.deepEqual(live.problems, []);
  assert.equal(live.config, undefined);
});

// --- Credential preflight (no network) ---------------------------------------------

test('oauth2 without a client id or a written token store is refused before any call', () => {
  const live = resolveLive({ [LIVE_TEST_ENV]: '1', X_MCP_AUTH_MODE: 'oauth2' }, false);
  assert.equal(live.requested, true);
  assert.equal(live.problems.length, 2, live.problems.join(' | '));
  assert.match(live.problems.join('\n'), /X_MCP_CLIENT_ID/);
  assert.match(live.problems.join('\n'), /token file .* does not exist/);
  // Shut for every tier, with the preflight named so the operator knows where to look.
  assert.match(gateFor(live, 'read').reason, /live preflight failed/);
});

test('app-only without a bearer token is refused; with one it is ready', () => {
  const missing = resolveLive({ [LIVE_TEST_ENV]: '1', X_MCP_AUTH_MODE: 'app-only' });
  assert.equal(missing.problems.length, 1);
  assert.match(missing.problems[0] ?? '', /X_MCP_BEARER_TOKEN/);

  const ok = resolveLive({
    [LIVE_TEST_ENV]: '1',
    X_MCP_AUTH_MODE: 'app-only',
    X_MCP_BEARER_TOKEN: 'AAAA-test-bearer',
  });
  assert.deepEqual(ok.problems, []);
  assert.equal(gateFor(ok, 'read').open, true);
});

test('an invalid X_MCP_* configuration is reported as a problem, never thrown at import', () => {
  const live = resolveLive({ [LIVE_TEST_ENV]: '1', X_MCP_POLICY: 'read-olny' });
  assert.equal(live.config, undefined);
  assert.equal(live.problems.length, 1);
  assert.match(live.problems[0] ?? '', /configuration is invalid/);
});

test('a configured token file that does not exist is caught BEFORE the first request', () => {
  // `authorize` never run is the most common way a live run dies on its first call — and it
  // dies after spending nothing but the operator's patience, so the gate says it up front.
  const live = resolveLive(READY, false);
  assert.equal(live.problems.length, 1);
  assert.match(live.problems[0] ?? '', /does not exist — run `npx x-mcp-ai authorize`/);
  assert.match(live.problems[0] ?? '', /x-mcp-live-tokens\.json/);
  assert.equal(gateFor(live, 'read').open, false);
});

test('the keychain backend gets no file probe — it cannot be read without I/O', () => {
  const live = liveEnvironment(
    {
      [LIVE_TEST_ENV]: '1',
      X_MCP_AUTH_MODE: 'oauth2',
      X_MCP_CLIENT_ID: 'test-client-id',
      X_MCP_TOKEN_KEYCHAIN: '1',
    },
    () => {
      throw new Error('the file probe must not run for the keychain backend');
    },
  );
  assert.deepEqual(live.problems, []);
});

test('a keychain token store satisfies the oauth2 store requirement', () => {
  const live = resolveLive({
    [LIVE_TEST_ENV]: '1',
    X_MCP_AUTH_MODE: 'oauth2',
    X_MCP_CLIENT_ID: 'test-client-id',
    X_MCP_TOKEN_KEYCHAIN: '1',
  });
  assert.deepEqual(live.problems, []);
});

// --- The write tier's second opt-in ------------------------------------------------

test('the write tier stays shut until X_MCP_LIVE_ACCOUNT names the account', () => {
  const live = resolveLive(READY);
  assert.equal(gateFor(live, 'read').open, true, 'reads are fine without it');
  const write = gateFor(live, 'write');
  assert.equal(write.open, false);
  assert.match(write.reason, /X_MCP_LIVE_ACCOUNT/);
  assert.match(write.reason, /never a personal account/);
});

test('the write tier refuses app-only auth — it cannot post at all', () => {
  const live = resolveLive({
    [LIVE_TEST_ENV]: '1',
    [LIVE_ACCOUNT_ENV]: 'mytestbed',
    X_MCP_AUTH_MODE: 'app-only',
    X_MCP_BEARER_TOKEN: 'AAAA-test-bearer',
  });
  const write = gateFor(live, 'write');
  assert.equal(write.open, false);
  assert.match(write.reason, /user-context auth/);
});

test('the write tier refuses a policy that cannot delete what it would create', () => {
  // `publish` grants write:content but NOT destructive:content — a create the suite could
  // not clean up. Refusing is the only safe answer.
  const live = resolveLive({ ...WRITE_READY, X_MCP_POLICY: 'publish' });
  const write = gateFor(live, 'write');
  assert.equal(write.open, false);
  assert.match(write.reason, /destructive:content/);
  assert.match(write.reason, /X_MCP_POLICY=manage/);

  // The default preset is read-only, so BOTH cells are missing there.
  const readOnly = resolveLive({ ...WRITE_READY, X_MCP_POLICY: undefined });
  assert.deepEqual(missingWriteCells(readOnly.config), WRITE_TIER_CELLS);
});

test('an explicit ALLOW override satisfies the write tier without the manage preset', () => {
  const live = resolveLive({
    ...WRITE_READY,
    X_MCP_POLICY: 'read-only',
    X_MCP_POLICY_ALLOW: 'write:content,destructive:content',
  });
  assert.deepEqual(missingWriteCells(live.config), []);
  assert.equal(gateFor(live, 'write').open, true);
});

test('DENY wins over the preset for the write tier too (POL-2)', () => {
  const live = resolveLive({ ...WRITE_READY, X_MCP_POLICY_DENY: 'destructive:content' });
  assert.deepEqual(missingWriteCells(live.config), ['destructive:content']);
  assert.equal(gateFor(live, 'write').open, false);
});

test('missingWriteCells refuses everything when the config did not parse', () => {
  assert.deepEqual(missingWriteCells(undefined), WRITE_TIER_CELLS);
});

test('a fully-configured write environment opens the write tier', () => {
  const live = resolveLive(WRITE_READY);
  assert.deepEqual(live.problems, []);
  assert.equal(live.account, 'mytestbed', 'the handle is normalized');
  assert.equal(gateFor(live, 'write').open, true);
});

// --- The capture tier's third opt-in ------------------------------------------------

test('the COST-6 capture needs its own X_MCP_LIVE_CAPTURE=1', () => {
  const live = resolveLive(READY);
  const shut = gateFor(live, 'capture');
  assert.equal(shut.open, false);
  assert.match(shut.reason, /X_MCP_LIVE_CAPTURE=1/);
  assert.match(shut.reason, /credit is already exhausted/);

  const open = resolveLive({ ...READY, [LIVE_CAPTURE_ENV]: '1' });
  assert.equal(open.capture, true);
  assert.equal(gateFor(open, 'capture').open, true);
});

test('the capture opt-in alone does not open anything — the master switch still rules', () => {
  const live = resolveLive({ ...READY, [LIVE_TEST_ENV]: '0', [LIVE_CAPTURE_ENV]: '1' });
  assert.equal(gateFor(live, 'capture').open, false);
  assert.match(gateFor(live, 'capture').reason, /X_MCP_LIVE_TEST=1/);
});

// --- Handle normalization ------------------------------------------------------------

test('normalizeHandle strips @, trims, lower-cases, and treats blank as unset', () => {
  assert.equal(normalizeHandle('@MyTestbed'), 'mytestbed');
  assert.equal(normalizeHandle('  MyTestbed '), 'mytestbed');
  assert.equal(normalizeHandle('@@double'), 'double');
  assert.equal(normalizeHandle(''), undefined);
  assert.equal(normalizeHandle('   '), undefined);
  assert.equal(normalizeHandle('@'), undefined);
  assert.equal(normalizeHandle(undefined), undefined);
});

// --- CFG-8 hygiene --------------------------------------------------------------------

test('the harness variables are stripped before parseConfig sees them (CFG-8)', () => {
  const stripped = stripLiveVars({
    [LIVE_TEST_ENV]: '1',
    [LIVE_ACCOUNT_ENV]: 'mytestbed',
    [LIVE_CAPTURE_ENV]: '1',
    X_MCP_AUTH_MODE: 'oauth2',
    PATH: '/usr/bin',
  });
  assert.deepEqual(stripped, { X_MCP_AUTH_MODE: 'oauth2', PATH: '/usr/bin' });
  for (const name of LIVE_ENV_VARS) assert.equal(name in stripped, false);
});

test('a ready live environment produces no config warnings about the harness variables', () => {
  const live = resolveLive(WRITE_READY);
  const warnings = (live.config?.warnings ?? []).join('\n');
  for (const name of LIVE_ENV_VARS) {
    assert.equal(warnings.includes(name), false, `${name} leaked into the startup warnings`);
  }
});
