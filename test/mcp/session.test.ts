// Tests for the concrete AuthSessionProvider (T-130, INT-6) — the snapshot `x_auth_status`
// renders. The provider is pure: it derives everything from a validated `Config` plus a
// resolved policy and performs NO I/O, so every case here is built with the real
// `parseConfig` over a plain env record rather than a fake.
//
// The `tokenStore` assertions are the T-320 F10 contract: docs/04 T1 used to promise that
// `x_auth_status` reports the token file's LOCATION and PERMISSIONS. It reports neither, on
// purpose — the path carries the operator's home layout into the model's context, and a mode
// read once at composition time would be stale by the time anyone read it. What it does
// report is the backend, which is the part an agent can act on.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseConfig } from '../../src/core/config.js';
import { resolvePolicy } from '../../src/core/policy.js';
import { POLICY_CELLS } from '../../src/core/tooldef.js';
import { createSessionProvider } from '../../src/mcp/session.js';

const READ_ONLY = resolvePolicy({ preset: 'read-only' });

/** An app-only process: the bearer arrives on the environment, nothing is persisted. */
const APP_ONLY_ENV = { X_MCP_AUTH_MODE: 'app-only', X_MCP_BEARER_TOKEN: 'bearer-value' };

/** An oauth2 process: config resolves a default token file unless the keychain claims it. */
const OAUTH2_ENV = { X_MCP_AUTH_MODE: 'oauth2', X_MCP_CLIENT_ID: 'client-1' };

test('the snapshot mirrors config and policy, and is stable across calls', () => {
  const config = parseConfig({ ...OAUTH2_ENV, X_MCP_AVAILABILITY: 'app+user' });
  const provider = createSessionProvider(config, READ_ONLY);

  const first = provider.snapshot();
  assert.equal(first.authMode, 'user');
  assert.deepEqual(first.availability, ['app+user']);
  assert.equal(first.policy.preset, 'read-only');
  // Every policy cell is present with an explicit boolean — an absent cell would read as
  // "not applicable" to an agent when it actually means "denied" (POL-1).
  assert.deepEqual(Object.keys(first.policy.cells).sort(), [...POLICY_CELLS].sort());
  assert.equal(
    Object.values(first.policy.cells).every((v) => typeof v === 'boolean'),
    true,
  );

  // Built once at composition time: the same object, not a fresh derivation per call.
  assert.equal(provider.snapshot(), first);
});

test('scopes and me are empty by design — the token schema persists neither', () => {
  const provider = createSessionProvider(parseConfig(OAUTH2_ENV), READ_ONLY);
  const snap = provider.snapshot();
  // T-203: token file schema v1 and the frozen `TokenPair` port carry no granted-scopes and
  // no identity, so inventing either here would be a lie. `x_auth_status` falls back to a
  // live `/2/users/me` instead (AUTH-15).
  assert.deepEqual(snap.scopes, []);
  assert.equal(snap.me, undefined);
});

test('app-only auth reports the `env` backend — the T17 leak surface, not a blank', () => {
  const provider = createSessionProvider(parseConfig(APP_ONLY_ENV), READ_ONLY);
  const snap = provider.snapshot();
  assert.equal(snap.authMode, 'app-only');
  assert.equal(snap.tokenStore, 'env');
});

test('oauth2 without the keychain flag reports the `file` backend', () => {
  const provider = createSessionProvider(parseConfig(OAUTH2_ENV), READ_ONLY);
  assert.equal(provider.snapshot().tokenStore, 'file');
});

test('X_MCP_TOKEN_KEYCHAIN=1 reports `keychain` even with a token file named', () => {
  // config refuses to resolve a token file under the keychain flag; the report must follow
  // that precedence rather than guessing from whichever variable is set.
  const config = parseConfig({
    ...OAUTH2_ENV,
    X_MCP_TOKEN_KEYCHAIN: '1',
  });
  assert.equal(config.tokenFile, undefined);
  assert.equal(createSessionProvider(config, READ_ONLY).snapshot().tokenStore, 'keychain');
});

test('baseUrlOverride is absent by default and set for a non-default host (CFG-7)', () => {
  const plain = createSessionProvider(parseConfig(APP_ONLY_ENV), READ_ONLY).snapshot();
  assert.equal(plain.baseUrlOverride, undefined);
  assert.equal(Object.hasOwn(plain, 'baseUrlOverride'), false);

  // A non-x.com host needs the explicit opt-in; credentials still never travel there (T10).
  const overridden = createSessionProvider(
    parseConfig({
      ...APP_ONLY_ENV,
      X_MCP_BASE_URL: 'https://proxy.example',
      X_MCP_ALLOW_INSECURE_BASE_URL: '1',
    }),
    READ_ONLY,
  ).snapshot();
  assert.equal(overridden.baseUrlOverride, 'https://proxy.example');
});

test('the snapshot carries no filesystem path and no permission bits (T-320 F10)', () => {
  const config = parseConfig({ ...OAUTH2_ENV, X_MCP_TOKEN_FILE: '/home/operator/.x-mcp/tok' });
  assert.equal(config.tokenFile, '/home/operator/.x-mcp/tok'); // config knows it…
  const snap = createSessionProvider(config, READ_ONLY).snapshot();
  assert.equal(snap.tokenStore, 'file'); // …the snapshot reduces it to the backend.
  assert.equal(JSON.stringify(snap).includes('/home/operator'), false);
});
