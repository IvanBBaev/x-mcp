// Tests for the token-store backend selector (T-308 / WP-3.7) — docs/02 §4 (env table),
// CFG-1/CFG-2/CFG-3 and docs/07 AUTH-5.
//
// Every Config here comes out of the REAL `parseConfig`, never a hand-written literal: the
// selector's whole job is to read fields another module produces, so the test must break if
// that contract moves (a renamed field, a default token path that stops being resolved, a
// profile that stops being recorded).
//
// The keychain branch is proven without spawning anything: `withLock` runs no subprocess,
// and an identifier-hostile profile name is refused by the keychain store at construction —
// which is exactly the observation that the profile name landed in the ACCOUNT slot.

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { fakeClock, fakeSleep } from '../../helpers/index.js';
import { XError } from '../../../src/core/errors.js';
import { parseConfig } from '../../../src/core/config.js';
import { createConfiguredTokenStore } from '../../../src/api/oauth2/store.js';
import type { Clock, Sleep, TokenPair } from '../../../src/core/ports.js';

const PAIR: TokenPair = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  obtained_at: 1_000_000,
  expires_in: 7200,
};

/** The selector needs a clock and a sleep for the file backend; neither ever ticks here. */
function ports(): { clock: Clock; sleep: Sleep } {
  const clock = fakeClock(1_000_000);
  return { clock, sleep: fakeSleep(clock).fn };
}

/**
 * The keychain backend only exists on darwin and linux; on anything else the store throws
 * at construction (asserted by its own test below). Darwin-only or POSIX-only assertions
 * are skipped with the reason spelled out rather than silently passing.
 */
const KEYCHAIN_OK = process.platform === 'darwin' || process.platform === 'linux';
const skipUnsupported = KEYCHAIN_OK
  ? false
  : `the keychain backend is not supported on ${process.platform}`;

// --- app-only: nothing to persist ------------------------------------------------------

test('CFG-1: app-only mode gets no token store at all', () => {
  const { clock, sleep } = ports();
  const direct = parseConfig({ X_MCP_AUTH_MODE: 'app-only', X_MCP_BEARER_TOKEN: 'AAAA' });
  assert.equal(createConfiguredTokenStore(direct, clock, sleep), undefined);

  // ...including when the mode came from a profile rather than the environment (CFG-3).
  const viaProfile = parseConfig(
    { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'bot' },
    { bot: { auth_mode: 'app-only', bearer_token: 'AAAA' } },
  );
  assert.equal(viaProfile.authMode, 'app-only');
  assert.equal(createConfiguredTokenStore(viaProfile, clock, sleep), undefined);
});

// --- oauth2 + a token file: the file backend -------------------------------------------

test('CFG-2: oauth2 + X_MCP_TOKEN_FILE builds a FILE store at exactly that path', async (t: TestContext) => {
  const dir = await fsp.mkdtemp(join(os.tmpdir(), 'x-mcp-store-'));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'tokens.json');

  const { clock, sleep } = ports();
  const config = parseConfig({ X_MCP_TOKEN_FILE: path });
  assert.equal(config.authMode, 'oauth2'); // CFG-4 default
  assert.equal(config.tokenKeychain, false);

  const store = createConfiguredTokenStore(config, clock, sleep);
  assert.ok(store !== undefined);

  // The only way to tell the backends apart is to make one do its side effect: a file store
  // writes the pair to the configured path, and reads it back.
  await store.persist(PAIR);
  const written = JSON.parse(await fsp.readFile(path, 'utf8')) as Record<string, unknown>;
  assert.equal(written['access_token'], PAIR.access_token);
  assert.equal((await store.load())?.access_token, PAIR.access_token);
});

test('CFG-2: oauth2 with no explicit file still gets a store, on the resolved default path', () => {
  const { clock, sleep } = ports();
  const config = parseConfig({ XDG_CONFIG_HOME: '/tmp/x-mcp-does-not-need-to-exist' });
  assert.equal(config.tokenFile, join('/tmp/x-mcp-does-not-need-to-exist', 'x-mcp', 'tokens.json'));
  // Construction alone touches no filesystem, so this is safe to assert without writing.
  assert.ok(createConfiguredTokenStore(config, clock, sleep) !== undefined);
});

test("CFG-3: a profile's own token_file is the path the selector uses", async (t: TestContext) => {
  const dir = await fsp.mkdtemp(join(os.tmpdir(), 'x-mcp-store-'));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'work-tokens.json');

  const { clock, sleep } = ports();
  const config = parseConfig(
    { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work' },
    { work: { auth_mode: 'oauth2', token_file: path } },
  );
  const store = createConfiguredTokenStore(config, clock, sleep);
  assert.ok(store !== undefined);
  await store.persist(PAIR);
  await assert.doesNotReject(fsp.access(path)); // the profile's path, not the default one
});

// --- oauth2 + X_MCP_TOKEN_KEYCHAIN=1: the keychain backend -----------------------------

test(
  'X_MCP_TOKEN_KEYCHAIN=1 builds a KEYCHAIN store, not a file store',
  { skip: skipUnsupported },
  async (t: TestContext) => {
    const warned: string[] = [];
    t.mock.method(console, 'warn', (message: string) => {
      warned.push(message);
    });

    const { clock, sleep } = ports();
    const config = parseConfig({ X_MCP_TOKEN_KEYCHAIN: '1' });
    assert.equal(config.tokenKeychain, true);
    // CFG-2 resolves NO default file in keychain mode, so a file store could not even be
    // constructed here — reaching the file branch would return `undefined` instead.
    assert.equal(Object.hasOwn(config, 'tokenFile'), false);

    const store = createConfiguredTokenStore(config, clock, sleep);
    assert.ok(store !== undefined);

    // `withLock` is the one operation that runs no subprocess, and only the keychain backend
    // warns about the missing cross-process lock (AUTH-5).
    assert.equal(await store.withLock(() => Promise.resolve('ok')), 'ok');
    assert.equal(warned.length, 1);
    assert.ok(warned[0]?.includes('no cross-process refresh lock'));
    assert.ok(warned[0]?.includes('AUTH-5'));
  },
);

test(
  'the keychain entry is filed under the ACTIVE PROFILE name, so profiles cannot collide',
  { skip: skipUnsupported },
  () => {
    const { clock, sleep } = ports();
    const env = { X_MCP_TOKEN_KEYCHAIN: '1', X_MCP_PROFILES_FILE: '~/p.json' };

    // A profile name is not charset-validated by parseConfig, so the keychain store is what
    // refuses it — and the message names the ACCOUNT, which is the observable proof that the
    // profile name was passed into the account slot (and nowhere else).
    const hostile = parseConfig({ ...env, X_MCP_PROFILE: 'work account' }, { 'work account': {} });
    assert.deepEqual(hostile.profile?.name, 'work account');
    assert.throws(
      () => createConfiguredTokenStore(hostile, clock, sleep),
      (err: unknown) => {
        assert.ok(XError.is(err));
        assert.equal(err.kind, 'auth');
        assert.equal(err.retryable, false);
        assert.ok(err.message.includes('Keychain account "work account"'), err.message);
        return true;
      },
    );

    // Ordinary profile names construct cleanly, under their own account each.
    for (const name of ['work', 'brand-2']) {
      const config = parseConfig({ ...env, X_MCP_PROFILE: name }, { [name]: {} });
      assert.equal(config.profile?.name, name);
      assert.ok(createConfiguredTokenStore(config, clock, sleep) !== undefined);
    }
  },
);

test(
  'the selector fails closed on a platform with no keychain backend',
  { skip: KEYCHAIN_OK ? `${process.platform} supports the keychain backend` : false },
  () => {
    const { clock, sleep } = ports();
    assert.throws(
      () => createConfiguredTokenStore(parseConfig({ X_MCP_TOKEN_KEYCHAIN: '1' }), clock, sleep),
      (err: unknown) => {
        assert.ok(XError.is(err));
        assert.equal(err.kind, 'auth');
        assert.ok(err.message.includes(`not supported on platform "${process.platform}"`));
        assert.ok(err.message.includes('X_MCP_TOKEN_FILE')); // and it names the way out
        return true;
      },
    );
  },
);

// --- the two backends can never both be requested --------------------------------------

test('the backends are mutually exclusive by construction, so the selector needs no precedence', () => {
  // If this ever stopped being fatal, the `if (tokenKeychain)` branch would silently win
  // over an explicitly configured token file.
  assert.throws(
    () => parseConfig({ X_MCP_TOKEN_KEYCHAIN: '1', X_MCP_TOKEN_FILE: '/tmp/tokens.json' }),
    /X_MCP_TOKEN_KEYCHAIN=1 is mutually exclusive with an explicit X_MCP_TOKEN_FILE/,
  );
  assert.throws(
    () =>
      parseConfig(
        { X_MCP_TOKEN_KEYCHAIN: '1', X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work' },
        { work: { token_file: '/tmp/tokens.json' } },
      ),
    /token_file is mutually exclusive with X_MCP_TOKEN_KEYCHAIN=1/,
  );
});

test('oauth2 with neither backend resolved yields no store rather than a broken one', () => {
  const { clock, sleep } = ports();
  // `parseConfig` cannot produce this state today — oauth2 without keychain always resolves
  // a default path (CFG-2) — so the fallback is pinned against a Config derived from a real
  // parse with just that field dropped, rather than against a hand-written literal.
  const { tokenFile, ...withoutFile } = parseConfig({});
  assert.ok(tokenFile !== undefined, 'CFG-2 must still resolve a default token file');
  assert.equal(withoutFile.authMode, 'oauth2');
  assert.equal(withoutFile.tokenKeychain, false);
  assert.equal(createConfiguredTokenStore(withoutFile, clock, sleep), undefined);
});
