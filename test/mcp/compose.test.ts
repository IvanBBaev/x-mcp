// Composition-level tests for the OAuth2 serve path (T-203): `composeServer` in oauth2
// mode must wire the real store + refresh machine so user-context requests sign with
// `Bearer <access token>` from the persisted pair, recover from a 401 via the token
// endpoint, persist the rotation (AUTH-1), and retry the triggering request exactly once
// (AUTH-8) — all through the SAME per-bucket recording clients production uses. The
// network is the undici MockAgent (both the X API and the token endpoint share the
// `api.x.com` origin); the store is the in-memory fake via the `overrides.tokens` seam.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../../src/core/config.js';
import type { TokenPair } from '../../src/core/ports.js';
import { composeServer } from '../../src/mcp/compose.js';
import { TOKEN_ENDPOINT_PATH } from '../../src/api/oauth2/index.js';

import { fakeClock, inMemoryTokenStore, mockHttp } from '../helpers/index.js';

// The exact `user.fields` projection the users endpoints request (pinned in
// test/tools/users.test.ts); undici matches the full query string.
const USER_FIELDS =
  'created_at,description,location,public_metrics,protected,url,verified,username,name';

test('T-203/INT: oauth2 mode signs from the store, refreshes on 401, persists, and retries once', async () => {
  const mock = mockHttp();
  const clock = fakeClock();
  const pair: TokenPair = {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    obtained_at: clock.now(),
    expires_in: 7200,
    version: 1,
  };
  const tokens = inMemoryTokenStore(pair);

  // 1. The first attempt signs with the persisted access token — and X rejects it.
  mock.pool
    .intercept({
      path: '/2/users/by/username/alice',
      method: 'GET',
      query: { 'user.fields': USER_FIELDS },
      headers: { authorization: 'Bearer access-1' },
    })
    .reply(401, { title: 'Unauthorized' });
  // 2. The reactive refresh POSTs the stored refresh token to the token endpoint.
  mock.pool
    .intercept({
      path: TOKEN_ENDPOINT_PATH,
      method: 'POST',
      body: 'grant_type=refresh_token&refresh_token=refresh-1&client_id=client-1',
    })
    .reply(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 7200 });
  // 3. The single retry signs with the rotated token.
  mock.pool
    .intercept({
      path: '/2/users/by/username/alice',
      method: 'GET',
      query: { 'user.fields': USER_FIELDS },
      headers: { authorization: 'Bearer access-2' },
    })
    .reply(200, { data: { id: '42', username: 'alice', name: 'Alice' } });

  const config = parseConfig({ X_MCP_AUTH_MODE: 'oauth2', X_MCP_CLIENT_ID: 'client-1' });
  const composition = composeServer(config, { dispatcher: mock.dispatcher, clock, tokens });

  // The resolver's handle lookup rides the composed users-bucket client — the same
  // wrapped invoker every user-context tool gets.
  assert.deepEqual(await composition.resolver.lookup('@alice'), { id: '42', handle: 'alice' });
  // Persist-before-use through the REAL wiring: the rotation reached the store (AUTH-1).
  assert.equal(tokens.persistCount(), 1);
  const stored = await tokens.load();
  assert.equal(stored?.access_token, 'access-2');
  assert.equal(stored?.refresh_token, 'refresh-2');

  mock.assertDone();
  await mock.close();
});

test('T-203/INT: oauth2 mode without stored tokens surfaces the typed re-authorize error', async () => {
  const mock = mockHttp();
  const config = parseConfig({ X_MCP_AUTH_MODE: 'oauth2', X_MCP_CLIENT_ID: 'client-1' });
  const composition = composeServer(config, {
    dispatcher: mock.dispatcher,
    clock: fakeClock(),
    tokens: inMemoryTokenStore(null),
  });

  // No interceptor is queued: the machine must refuse BEFORE any network attempt (a
  // network attempt would surface as a loud MockAgent failure, not a typed auth error).
  await assert.rejects(composition.resolver.lookup('@alice'), (err: unknown) => {
    assert.ok(err instanceof Error);
    return /authorize/.test(err.message);
  });

  mock.assertDone();
  await mock.close();
});

test('T-203/INT: a confidential client refreshes with HTTP Basic through the composed wiring', async () => {
  const mock = mockHttp();
  const clock = fakeClock();
  const pair: TokenPair = {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    obtained_at: clock.now(),
    expires_in: 7200,
    version: 1,
  };
  const tokens = inMemoryTokenStore(pair);

  mock.pool
    .intercept({
      path: '/2/users/by/username/alice',
      method: 'GET',
      query: { 'user.fields': USER_FIELDS },
      headers: { authorization: 'Bearer access-1' },
    })
    .reply(401, { title: 'Unauthorized' });
  // The client secret must reach the refresh adapter: confidential clients authenticate
  // the token-endpoint POST with HTTP Basic on top of the client_id in the form.
  mock.pool
    .intercept({
      path: TOKEN_ENDPOINT_PATH,
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('client-1:secret-1').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=refresh_token&refresh_token=refresh-1&client_id=client-1',
    })
    .reply(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 7200 });
  mock.pool
    .intercept({
      path: '/2/users/by/username/alice',
      method: 'GET',
      query: { 'user.fields': USER_FIELDS },
      headers: { authorization: 'Bearer access-2' },
    })
    .reply(200, { data: { id: '42', username: 'alice', name: 'Alice' } });

  const config = parseConfig({
    X_MCP_AUTH_MODE: 'oauth2',
    X_MCP_CLIENT_ID: 'client-1',
    X_MCP_CLIENT_SECRET: 'secret-1',
  });
  const composition = composeServer(config, { dispatcher: mock.dispatcher, clock, tokens });

  assert.deepEqual(await composition.resolver.lookup('@alice'), { id: '42', handle: 'alice' });
  assert.equal(tokens.persistCount(), 1);

  mock.assertDone();
  await mock.close();
});

test('T-203: production defaults compose without overrides — pure wiring, no I/O', () => {
  // No overrides at all: the default clock/sleep/random are taken, no dispatcher is
  // spread into the ports or clients, and the oauth2 store is the REAL file backend at
  // the configured path (constructing it touches nothing on disk). A public client
  // (no client id/secret) exercises the omit arms of the refresh-adapter spreads.
  const config = parseConfig({
    X_MCP_AUTH_MODE: 'oauth2',
    X_MCP_TOKEN_FILE: join(os.tmpdir(), 'x-mcp-compose-defaults', 'tokens.json'),
  });
  const composition = composeServer(config);

  assert.ok(composition.server !== undefined);
  assert.ok(composition.registry.size > 0);
  assert.ok(composition.tracker !== undefined);
  assert.ok(composition.budget !== undefined);
  assert.equal(typeof composition.resolver.lookup, 'function');
});
