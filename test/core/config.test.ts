// Tests for T-110 `parseConfig` — the executable form of the canonical env-var table
// (docs/02 §4). Every corner case CFG-1..8 (docs/07) is exercised and named below.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { parseConfig, DEFAULT_BASE_URL } from '../../src/core/config.js';
import { XError } from '../../src/core/errors.js';

/** Assert `fn` throws a fatal `validation` XError whose message matches `re`. */
function assertFatal(fn: () => unknown, re: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(XError.is(err), 'expected an XError');
    assert.equal(err.kind, 'validation');
    assert.match(err.message, re);
    // CFG-5 — the reason must NOT carry the banner; the root prepends `x-mcp-ai: fatal:`.
    assert.doesNotMatch(err.message, /x-mcp-ai: fatal:/);
    return true;
  });
}

test('defaults: an empty env yields a valid, frozen oauth2 read-only config', () => {
  const cfg = parseConfig({});
  assert.equal(cfg.authMode, 'oauth2');
  assert.equal(cfg.policy.preset, 'read-only');
  assert.deepEqual(cfg.policy.allow, []);
  assert.deepEqual(cfg.policy.deny, []);
  assert.equal(cfg.policy.hideDenied, false);
  assert.equal(cfg.budget.mode, 'warn');
  assert.equal(Object.hasOwn(cfg.budget, 'creditUsd'), false);
  assert.deepEqual(cfg.availability, []);
  assert.equal(cfg.baseUrl, DEFAULT_BASE_URL);
  assert.equal(cfg.allowInsecureBaseUrl, false);
  assert.equal(cfg.timeoutMs, 30000);
  assert.equal(cfg.logLevel, 'info');
  assert.equal(cfg.tokenKeychain, false);
  // Frozen deeply.
  assert.ok(Object.isFrozen(cfg));
  assert.ok(Object.isFrozen(cfg.policy));
  assert.ok(Object.isFrozen(cfg.policy.allow));
  assert.ok(Object.isFrozen(cfg.warnings));
});

test('happy path: scalar vars parse into typed fields', () => {
  const cfg = parseConfig({
    X_MCP_AUTH_MODE: 'app-only',
    X_MCP_BEARER_TOKEN: 'AAAA',
    X_MCP_POLICY: 'engage',
    X_MCP_POLICY_ALLOW: 'write:content, read:user',
    X_MCP_POLICY_DENY: 'destructive:content',
    X_MCP_HIDE_DENIED: '1',
    X_MCP_CREDIT_BUDGET: '2.50',
    X_MCP_BUDGET_MODE: 'hard',
    X_MCP_AVAILABILITY: 'premium-user,enterprise',
    X_MCP_TIMEOUT_MS: '5000',
    X_MCP_LOG_LEVEL: 'debug',
  });
  assert.equal(cfg.authMode, 'app-only');
  assert.equal(cfg.bearerToken, 'AAAA');
  assert.equal(cfg.policy.preset, 'engage');
  assert.deepEqual(cfg.policy.allow, ['write:content', 'read:user']);
  assert.deepEqual(cfg.policy.deny, ['destructive:content']);
  assert.equal(cfg.policy.hideDenied, true);
  assert.equal(cfg.budget.mode, 'hard');
  assert.equal(cfg.budget.creditUsd, 2.5);
  assert.deepEqual(cfg.availability, ['premium-user', 'enterprise']);
  assert.equal(cfg.timeoutMs, 5000);
  assert.equal(cfg.logLevel, 'debug');
  // app-only mode has no default token file.
  assert.equal(Object.hasOwn(cfg, 'tokenFile'), false);
});

// --- CFG-1: leading `~` expansion; mid-string `~` untouched -----------------------------

test('CFG-1: leading ~/ and bare ~ expand; mid-string ~ is left alone', () => {
  const home = os.homedir();
  const withSlash = parseConfig({ X_MCP_MEDIA_DIR: '~/media/x' });
  assert.equal(withSlash.mediaDir, path.join(home, 'media/x'));

  const bare = parseConfig({ X_MCP_MEDIA_DIR: '~' });
  assert.equal(bare.mediaDir, home);

  // A `~` in the middle of a path is NOT a home reference — verbatim.
  const mid = parseConfig({ X_MCP_MEDIA_DIR: '/data/~backup/x' });
  assert.equal(mid.mediaDir, '/data/~backup/x');

  // Also applies to an explicit token file.
  const tok = parseConfig({ X_MCP_TOKEN_FILE: '~/creds/tokens.json' });
  assert.equal(tok.tokenFile, path.join(home, 'creds/tokens.json'));
});

// --- CFG-2: default token path when unset (dir name `x-mcp`, node:path joins) ----------

test('CFG-2: default token file uses the x-mcp config dir on the current platform', () => {
  if (process.platform === 'win32') {
    const cfg = parseConfig({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' });
    assert.equal(
      cfg.tokenFile,
      path.join('C:\\Users\\me\\AppData\\Roaming', 'x-mcp', 'tokens.json'),
    );
  } else {
    // Honors XDG_CONFIG_HOME when set.
    const xdg = parseConfig({ XDG_CONFIG_HOME: '/xdg/config' });
    assert.equal(xdg.tokenFile, path.join('/xdg/config', 'x-mcp', 'tokens.json'));
    // Falls back to ~/.config otherwise.
    const fallback = parseConfig({});
    assert.equal(fallback.tokenFile, path.join(os.homedir(), '.config', 'x-mcp', 'tokens.json'));
    // The directory is `x-mcp` — the npm name (`x-mcp-ai`) never leaks into the path.
    assert.ok(fallback.tokenFile !== undefined && !fallback.tokenFile.includes('x-mcp-ai'));
  }
});

test('CFG-2: keychain mode and non-oauth2 modes resolve no default token file', () => {
  const keychain = parseConfig({ X_MCP_TOKEN_KEYCHAIN: '1' });
  assert.equal(Object.hasOwn(keychain, 'tokenFile'), false);
  const appOnly = parseConfig({ X_MCP_AUTH_MODE: 'app-only', X_MCP_BEARER_TOKEN: 'AAAA' });
  assert.equal(Object.hasOwn(appOnly, 'tokenFile'), false);
});

// --- PLAT-3: Windows-style paths survive verbatim (no hardcoded `/` joins) -------------
// These run on every platform: config never re-joins or normalises an explicit path, so
// backslashes, drive letters, and UNC prefixes must come out byte-identical on macOS too.

test('PLAT-3: a drive-letter backslash token file passes through verbatim', () => {
  const cfg = parseConfig({ X_MCP_TOKEN_FILE: 'C:\\Users\\me\\tokens.json' });
  assert.equal(cfg.tokenFile, 'C:\\Users\\me\\tokens.json');
});

test('PLAT-3: backslash media dir and UNC profiles file pass through verbatim', () => {
  const media = parseConfig({ X_MCP_MEDIA_DIR: 'D:\\media\\x' });
  assert.equal(media.mediaDir, 'D:\\media\\x');

  const unc = parseConfig({
    X_MCP_PROFILES_FILE: '\\\\server\\share\\profiles.json',
    X_MCP_PROFILE: 'work',
  });
  assert.equal(unc.profile?.file, '\\\\server\\share\\profiles.json');
});

test("PLAT-3: a literal %APPDATA% reference is NOT expanded (expansion is the shell's job)", () => {
  const cfg = parseConfig({ X_MCP_TOKEN_FILE: '%APPDATA%\\x-mcp\\tokens.json' });
  assert.equal(cfg.tokenFile, '%APPDATA%\\x-mcp\\tokens.json');
});

test('PLAT-3: a leading ~\\ expands via node:path (backslash form of CFG-1)', () => {
  const cfg = parseConfig({ X_MCP_TOKEN_FILE: '~\\creds\\tokens.json' });
  // The expected value is built with path.join itself, so the assertion is
  // platform-independent: whatever separator join picks, expansion must match it.
  assert.equal(cfg.tokenFile, path.join(os.homedir(), 'creds\\tokens.json'));
});

// --- CFG-3: profiles file vs profile selection vs direct credentials -------------------

test('CFG-3: a profiles file requires X_MCP_PROFILE', () => {
  assertFatal(
    () => parseConfig({ X_MCP_PROFILES_FILE: '~/profiles.json' }),
    /X_MCP_PROFILE is required/,
  );
});

test('CFG-3: profiles file + a direct credential is a startup error naming both sources', () => {
  assertFatal(
    () =>
      parseConfig({
        X_MCP_PROFILES_FILE: '~/profiles.json',
        X_MCP_PROFILE: 'work',
        X_MCP_BEARER_TOKEN: 'AAAA',
      }),
    /X_MCP_PROFILES_FILE.*direct credentials/s,
  );
});

test('CFG-3: a valid single profile parses (profile selection recorded, ~ expanded)', () => {
  const profilesJson = {
    work: { auth_mode: 'oauth2', policy: 'engage' },
  };
  const cfg = parseConfig(
    { X_MCP_PROFILES_FILE: '~/profiles.json', X_MCP_PROFILE: 'work' },
    profilesJson,
  );
  assert.deepEqual(cfg.profile, { file: path.join(os.homedir(), 'profiles.json'), name: 'work' });
});

test('CFG-3: the selected profile is the single source of credentials (app-only)', () => {
  const cfg = parseConfig(
    { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'bot' },
    { bot: { auth_mode: 'app-only', bearer_token: 'AAAA' }, work: { auth_mode: 'oauth2' } },
  );
  assert.equal(cfg.authMode, 'app-only');
  assert.equal(cfg.bearerToken, 'AAAA');
  // app-only resolves no default token file, exactly as the direct env path (CFG-2).
  assert.equal(Object.hasOwn(cfg, 'tokenFile'), false);
});

test('CFG-3: an oauth2 profile supplies client id/secret and its own token file', () => {
  const cfg = parseConfig(
    { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work' },
    {
      work: {
        auth_mode: 'oauth2',
        client_id: 'CID',
        client_secret: 'CSEC',
        token_file: '~/work/tokens.json',
      },
    },
  );
  assert.equal(cfg.authMode, 'oauth2');
  assert.equal(cfg.oauth2.clientId, 'CID');
  assert.equal(cfg.oauth2.clientSecret, 'CSEC');
  // CFG-1 expansion applies to a profile-supplied path exactly as to X_MCP_TOKEN_FILE.
  assert.equal(cfg.tokenFile, path.join(os.homedir(), 'work/tokens.json'));
});

test('CFG-3: X_MCP_AUTH_MODE conflicting with the profile auth_mode is fatal (no silent winner)', () => {
  assertFatal(
    () =>
      parseConfig(
        { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work', X_MCP_AUTH_MODE: 'app-only' },
        { work: { auth_mode: 'oauth2', client_id: 'CID' } },
      ),
    /X_MCP_AUTH_MODE=app-only conflicts with auth_mode "oauth2" of profile "work"/,
  );
});

test('CFG-3: a profile whose credentials contradict its auth_mode is fatal', () => {
  assertFatal(
    () =>
      parseConfig(
        { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work' },
        { work: { auth_mode: 'oauth2', bearer_token: 'AAAA' } },
      ),
    /bearer_token requires auth_mode app-only/,
  );
  assertFatal(
    () =>
      parseConfig(
        { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'bot' },
        { bot: { auth_mode: 'app-only', client_id: 'CID' } },
      ),
    /client_id \/ client_secret require auth_mode oauth2/,
  );
  assertFatal(
    () =>
      parseConfig(
        { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'bot' },
        { bot: { auth_mode: 'app-only' } },
      ),
    /auth_mode app-only requires bearer_token/,
  );
});

test('CFG-3: selecting a profile from an EMPTY profiles file says "(none)", not an empty list', () => {
  assertFatal(
    () => parseConfig({ X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work' }, {}),
    /profile "work" not found in profiles file; available profiles: \(none\)/,
  );
});

// --- CFG-4: empty string is treated as unset -------------------------------------------

test('CFG-4: empty/whitespace values are treated as unset (defaults apply)', () => {
  const cfg = parseConfig({
    X_MCP_POLICY: '',
    X_MCP_BUDGET_MODE: '   ',
    X_MCP_LOG_LEVEL: '',
    X_MCP_POLICY_ALLOW: '',
  });
  assert.equal(cfg.policy.preset, 'read-only');
  assert.equal(cfg.budget.mode, 'warn');
  assert.equal(cfg.logLevel, 'info');
  assert.deepEqual(cfg.policy.allow, []);
});

test('CFG-4: an empty required var errors exactly like a missing one', () => {
  // Empty X_MCP_PROFILE in profile mode == missing → same "required" failure.
  assertFatal(
    () => parseConfig({ X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: '   ' }),
    /X_MCP_PROFILE is required/,
  );
});

// --- CFG-5: fatal contract (typed error, legible, lists valid options) -----------------

test('CFG-5: an invalid enum is fatal and the message lists the valid options', () => {
  assertFatal(() => parseConfig({ X_MCP_AUTH_MODE: 'oauth3' }), /oauth2.*app-only/s);
  assertFatal(() => parseConfig({ X_MCP_LOG_LEVEL: 'verbose' }), /silent.*error.*info.*debug/s);
  assertFatal(() => parseConfig({ X_MCP_BUDGET_MODE: 'soft' }), /warn.*hard/s);
});

test('CFG-5: invalid policy cell / availability / numbers are fatal with valid sets listed', () => {
  assertFatal(
    () => parseConfig({ X_MCP_POLICY_ALLOW: 'read:content,bogus:cell' }),
    /invalid policy cell/i,
  );
  assertFatal(
    () => parseConfig({ X_MCP_POLICY: 'godmode' }),
    /read-only.*engage.*publish.*manage.*full/s,
  );
  assertFatal(() => parseConfig({ X_MCP_AVAILABILITY: 'galaxy' }), /invalid availability class/i);
  assertFatal(() => parseConfig({ X_MCP_CREDIT_BUDGET: '-1' }), /positive USD/i);
  assertFatal(() => parseConfig({ X_MCP_CREDIT_BUDGET: 'free' }), /positive USD/i);
  assertFatal(() => parseConfig({ X_MCP_TIMEOUT_MS: '0' }), /positive integer/i);
  assertFatal(() => parseConfig({ X_MCP_TIMEOUT_MS: '1.5' }), /positive integer/i);
});

// --- Mode / credential conflicts (fatal) -----------------------------------------------

test('mode/credential conflicts are fatal', () => {
  // Bearer token only valid in app-only.
  assertFatal(() => parseConfig({ X_MCP_BEARER_TOKEN: 'AAAA' }), /app-only/);
  // app-only requires a bearer token.
  assertFatal(() => parseConfig({ X_MCP_AUTH_MODE: 'app-only' }), /requires X_MCP_BEARER_TOKEN/);
  // client id/secret require oauth2.
  assertFatal(
    () =>
      parseConfig({ X_MCP_AUTH_MODE: 'app-only', X_MCP_BEARER_TOKEN: 'A', X_MCP_CLIENT_ID: 'C' }),
    /X_MCP_CLIENT_ID.*oauth2/s,
  );
  // Keychain + explicit token file are mutually exclusive.
  assertFatal(
    () => parseConfig({ X_MCP_TOKEN_KEYCHAIN: '1', X_MCP_TOKEN_FILE: '~/t.json' }),
    /mutually exclusive/,
  );
});

// --- OAuth 1.0a is gone (decision 0001, T-309) -----------------------------------------

test('T-309: X_MCP_AUTH_MODE=oauth1 is refused like any unknown mode (decision 0001)', () => {
  assertFatal(() => parseConfig({ X_MCP_AUTH_MODE: 'oauth1' }), /oauth2.*app-only/s);
  // The message must not advertise the dropped mode as a valid option: `oauth1` may occur
  // exactly once — as the rejected value, never in the list of accepted modes.
  assert.throws(
    () => parseConfig({ X_MCP_AUTH_MODE: 'oauth1' }),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.message.split('oauth1').length - 1, 1);
      return true;
    },
  );
});

test('T-309: the OAuth 1.0a credential quadruple is no longer part of the surface', () => {
  const cfg = parseConfig({
    X_MCP_API_KEY: 'k',
    X_MCP_API_SECRET: 's',
    X_MCP_ACCESS_TOKEN: 'at',
    X_MCP_ACCESS_SECRET: 'as',
  });
  // They parse as *unknown* X_MCP_* vars now: CFG-8 warnings, no credentials, no refusal.
  assert.equal(cfg.authMode, 'oauth2');
  assert.equal(Object.hasOwn(cfg, 'oauth1'), false);
  for (const name of [
    'X_MCP_API_KEY',
    'X_MCP_API_SECRET',
    'X_MCP_ACCESS_TOKEN',
    'X_MCP_ACCESS_SECRET',
  ]) {
    assert.ok(cfg.warnings.some((w) => w.includes(name) && /possible typo/.test(w)));
  }
});

// --- CFG-6: profiles content is re-validated when the file is supplied -----------------

test('CFG-6: a selected profile with an invalid policy is fatal', () => {
  assertFatal(
    () =>
      parseConfig(
        { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work' },
        { work: { policy: 'read:content,nope:cell' } },
      ),
    /profile "work" has an invalid policy/,
  );
});

test('CFG-6: selecting a profile absent from the file is fatal and lists what is available', () => {
  assertFatal(
    () =>
      parseConfig(
        { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'missing' },
        { work: {}, home: {} },
      ),
    /profile "missing" not found.*work.*home/s,
  );
});

test('CFG-6: a malformed profiles file (not a map of entries) is fatal', () => {
  assertFatal(
    () => parseConfig({ X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work' }, [1, 2, 3]),
    /invalid profiles file/,
  );
});

test('CFG-6: a valid profile policy (preset name) passes re-validation', () => {
  const cfg = parseConfig(
    { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work' },
    { work: { auth_mode: 'oauth2', policy: 'publish' } },
  );
  assert.equal(cfg.profile?.name, 'work');
  assert.equal(cfg.policy.preset, 'publish');
});

test('CFG-6: a profile policy given as a cell list becomes allow cells; deny still wins', () => {
  const cfg = parseConfig(
    {
      X_MCP_PROFILES_FILE: '~/p.json',
      X_MCP_PROFILE: 'work',
      X_MCP_POLICY_DENY: 'destructive:content',
    },
    { work: { policy: 'write:content, read:user' } },
  );
  assert.equal(cfg.policy.preset, 'read-only');
  assert.deepEqual(cfg.policy.allow, ['write:content', 'read:user']);
  // A profile never touches DENY — deny > allow > preset stays the operator's (POL-2).
  assert.deepEqual(cfg.policy.deny, ['destructive:content']);
});

test('CFG-6: an env policy overrides the profile policy and the override is warned about', () => {
  const preset = parseConfig(
    { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work', X_MCP_POLICY: 'read-only' },
    { work: { policy: 'full' } },
  );
  assert.equal(preset.policy.preset, 'read-only');
  assert.ok(preset.warnings.some((w) => /X_MCP_POLICY=read-only overrides the policy/.test(w)));

  const cells = parseConfig(
    { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work', X_MCP_POLICY_ALLOW: 'read:user' },
    { work: { policy: 'write:content' } },
  );
  assert.deepEqual(cells.policy.allow, ['read:user']);
  assert.ok(cells.warnings.some((w) => /X_MCP_POLICY_ALLOW overrides the policy cells/.test(w)));
});

test('CFG-6: X_MCP_TOKEN_FILE overrides the profile token_file and warns', () => {
  const cfg = parseConfig(
    { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work', X_MCP_TOKEN_FILE: '~/env.json' },
    { work: { auth_mode: 'oauth2', token_file: '~/profile.json' } },
  );
  assert.equal(cfg.tokenFile, path.join(os.homedir(), 'env.json'));
  assert.ok(cfg.warnings.some((w) => /X_MCP_TOKEN_FILE overrides the token_file/.test(w)));
});

test('CFG-6: a profile token_file with X_MCP_TOKEN_KEYCHAIN=1 is fatal', () => {
  assertFatal(
    () =>
      parseConfig(
        { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work', X_MCP_TOKEN_KEYCHAIN: '1' },
        { work: { token_file: '~/profile.json' } },
      ),
    /token_file is mutually exclusive with X_MCP_TOKEN_KEYCHAIN=1/,
  );
});

test('CFG-6: an unknown auth_mode inside the selected profile is fatal', () => {
  assertFatal(
    () =>
      parseConfig(
        { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work' },
        { work: { auth_mode: 'oauth1' } },
      ),
    /profile "work" is invalid.*auth_mode/s,
  );
});

test('CFG-6: a profile entry that is not an object is fatal', () => {
  assertFatal(
    () =>
      parseConfig({ X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work' }, { work: 'oauth2' }),
    /invalid profiles file/,
  );
});

test('CFG-6: an unknown key in the selected profile warns but does not refuse', () => {
  const cfg = parseConfig(
    { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work' },
    { work: { auth_mode: 'oauth2', clientid: 'CID' } },
  );
  assert.equal(cfg.authMode, 'oauth2');
  assert.ok(
    cfg.warnings.some((w) => /Unknown key "clientid" in profile "work"/.test(w) && /typo/.test(w)),
  );
});

test('CFG-6: a malformed *unselected* profile never blocks startup', () => {
  const cfg = parseConfig(
    { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work' },
    { work: { auth_mode: 'oauth2' }, broken: { auth_mode: 'nope', policy: 'godmode' } },
  );
  assert.equal(cfg.profile?.name, 'work');
  assert.equal(cfg.warnings.length, 0);
});

test('CFG-6: empty profile values are treated as unset (CFG-4 parity inside the file)', () => {
  const cfg = parseConfig(
    { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'work' },
    { work: { auth_mode: 'oauth2', client_id: '   ', policy: '' } },
  );
  assert.equal(Object.hasOwn(cfg.oauth2, 'clientId'), false);
  assert.equal(cfg.policy.preset, 'read-only');
});

test('CFG-6: profile secrets never leak into warnings or fatal messages (SEC-T16)', () => {
  const secret = 'SUPER-SECRET-VALUE';
  const cfg = parseConfig(
    { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'bot' },
    { bot: { auth_mode: 'app-only', bearer_token: secret, oops: secret } },
  );
  assert.equal(cfg.bearerToken, secret);
  assert.ok(cfg.warnings.length > 0);
  assert.ok(!cfg.warnings.some((w) => w.includes(secret)));

  assert.throws(
    () =>
      parseConfig(
        { X_MCP_PROFILES_FILE: '~/p.json', X_MCP_PROFILE: 'bot', X_MCP_AUTH_MODE: 'oauth2' },
        { bot: { auth_mode: 'app-only', bearer_token: secret } },
      ),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.ok(!err.message.includes(secret));
      return true;
    },
  );
});

// --- CFG-7: base-URL value rules (the config half; proxy-ignore is api/http's) ---------

test('CFG-7: base URL must use https', () => {
  assertFatal(() => parseConfig({ X_MCP_BASE_URL: 'http://api.x.com' }), /must use https/);
});

test('CFG-7: a base URL that does not parse at all is fatal, reported once', () => {
  // Under oauth2 both value rules inspect the URL; the credential-egress check stays quiet
  // on a malformed value so the operator sees exactly one issue, not two for one typo.
  assertFatal(
    () =>
      parseConfig({
        X_MCP_AUTH_MODE: 'oauth2',
        X_MCP_CLIENT_ID: 'CID',
        X_MCP_BASE_URL: 'not-a-url',
      }),
    /X_MCP_BASE_URL must be a valid absolute URL \(got "not-a-url"\)/,
  );
});

test('CFG-7: a non-x.com host is refused unless the insecure flag is set', () => {
  assertFatal(
    () => parseConfig({ X_MCP_BASE_URL: 'https://evil.example.com' }),
    /not \*\.x\.com.*X_MCP_ALLOW_INSECURE_BASE_URL=1/s,
  );
  // With the flag it is allowed — in app-only mode, where no credential can follow it
  // (T10). Both a non-default and an insecure warning surface.
  const cfg = parseConfig({
    X_MCP_BASE_URL: 'https://localhost:8443',
    X_MCP_ALLOW_INSECURE_BASE_URL: '1',
    X_MCP_AUTH_MODE: 'app-only',
    X_MCP_BEARER_TOKEN: 'AAAA',
  });
  assert.equal(cfg.baseUrl, 'https://localhost:8443');
  assert.equal(cfg.allowInsecureBaseUrl, true);
  assert.ok(cfg.warnings.some((w) => /non-default X API base URL/.test(w)));
  assert.ok(cfg.warnings.some((w) => /ALLOW_INSECURE_BASE_URL is enabled/.test(w)));
  // The warning must be honest about the split: requests may leave x.com, credentials may not.
  assert.ok(cfg.warnings.some((w) => /Credentials are NOT.*unauthenticated/s.test(w)));
});

// --- T10: the credential-egress allowlist is independent of the base URL ---------------

test('T10: oauth2 refuses a non-x.com base URL even with the insecure flag', () => {
  // The confused-deputy vector docs/04 T10 names first: a socially-engineered base URL
  // makes the token endpoint the attacker's, so refreshing would hand over the refresh
  // token. No request-time header check can undo that — the whole session is refused.
  assertFatal(
    () =>
      parseConfig({
        X_MCP_AUTH_MODE: 'oauth2',
        X_MCP_CLIENT_ID: 'cid',
        X_MCP_BASE_URL: 'https://x-api-mirror.evil',
        X_MCP_ALLOW_INSECURE_BASE_URL: '1',
      }),
    /refuses a non-\*\.x\.com base URL.*refresh token would be sent to "x-api-mirror\.evil"/s,
  );
});

test('T10: a profile-selected oauth2 mode is caught too, not just the env one', () => {
  // The mode is only known after profile resolution — a check on the raw env would miss this.
  assertFatal(
    () =>
      parseConfig(
        {
          X_MCP_PROFILES_FILE: '/tmp/profiles.json',
          X_MCP_PROFILE: 'work',
          X_MCP_BASE_URL: 'https://x-api-mirror.evil',
          X_MCP_ALLOW_INSECURE_BASE_URL: '1',
        },
        { work: { auth_mode: 'oauth2', client_id: 'cid' } },
      ),
    /refuses a non-\*\.x\.com base URL/,
  );
});

test('CFG-7: an *.x.com host is accepted without the flag', () => {
  const cfg = parseConfig({ X_MCP_BASE_URL: 'https://api.sandbox.x.com' });
  assert.equal(cfg.baseUrl, 'https://api.sandbox.x.com');
  assert.ok(cfg.warnings.some((w) => /non-default X API base URL/.test(w)));
});

// --- CFG-8: unknown X_MCP_* vars warn (never fatal) ------------------------------------

test('CFG-8: an unknown X_MCP_* var produces a warning but does not refuse startup', () => {
  const cfg = parseConfig({ X_MCP_POLCY: 'engage', X_MCP_TYPO_HERE: 'x' });
  // The real policy default still applies (the typo was ignored).
  assert.equal(cfg.policy.preset, 'read-only');
  assert.ok(cfg.warnings.some((w) => /X_MCP_POLCY/.test(w) && /possible typo/.test(w)));
  assert.ok(cfg.warnings.some((w) => /X_MCP_TYPO_HERE/.test(w)));
});

test('CFG-8: known vars and empty unknowns do not warn', () => {
  const cfg = parseConfig({ X_MCP_POLICY: 'engage', X_MCP_MYSTERY: '' });
  assert.equal(cfg.warnings.length, 0);
});

test('a profile named without a profiles file is ignored with a warning (not fatal)', () => {
  const cfg = parseConfig({ X_MCP_PROFILE: 'work' });
  assert.equal(Object.hasOwn(cfg, 'profile'), false);
  assert.ok(
    cfg.warnings.some((w) => /X_MCP_PROFILE is set but X_MCP_PROFILES_FILE is not/.test(w)),
  );
});
