// Tests for cli/doctor (T-205, WP-2.2, OPS-F9): env validation via parseConfig with
// remediation text and masked secrets (CFG-5), paths & permissions reporting (SEC-T13, T1,
// PLAT-2), lock leftovers (AUTH-5), the synced-storage warning (CFG-9), the resolved
// auth+policy matrix print reusing core/policy (POL-2), the opt-in connectivity GET
// through the injected http callable, and the 0/1 exit-code contract.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDoctorCli } from '../../src/cli/doctor.js';
import type { DoctorDeps, DoctorFs, DoctorHttpGet, DoctorStat } from '../../src/cli/doctor.js';
import { fakeClock } from '../helpers/fakes.js';

// --- Fake dependency assembly ------------------------------------------------------------

interface FakeFile {
  readonly kind?: DoctorStat['kind'];
  readonly mode?: number;
  readonly mtimeMs?: number;
  readonly content?: string;
}

interface FakeDepsOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly files?: Readonly<Record<string, FakeFile>>;
  readonly platform?: NodeJS.Platform;
  readonly http?: DoctorHttpGet;
  readonly nowMs?: number;
}

interface FakeDoctor {
  readonly deps: DoctorDeps;
  readonly outLines: readonly string[];
  readonly errLines: readonly string[];
  readonly httpCalls: readonly string[];
  readonly stdout: () => string;
}

function makeDeps(opts: FakeDepsOptions = {}): FakeDoctor {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const httpCalls: string[] = [];
  const files = opts.files ?? {};

  const fs: DoctorFs = {
    stat: (p) => {
      const entry = files[p];
      if (entry === undefined) return Promise.resolve(null);
      return Promise.resolve({
        kind: entry.kind ?? 'file',
        ...(entry.mode !== undefined ? { mode: entry.mode } : {}),
        ...(entry.mtimeMs !== undefined ? { mtimeMs: entry.mtimeMs } : {}),
      });
    },
    readFile: (p) => {
      const entry = files[p];
      if (entry?.content === undefined) return Promise.reject(new Error(`ENOENT: ${p}`));
      return Promise.resolve(entry.content);
    },
  };

  const inner: DoctorHttpGet = opts.http ?? (() => Promise.resolve({ status: 200 }));
  const http: DoctorHttpGet = (url) => {
    httpCalls.push(url);
    return inner(url);
  };

  const deps: DoctorDeps = {
    env: opts.env ?? {},
    fs,
    http,
    stdout: (line) => outLines.push(line),
    stderr: (line) => errLines.push(line),
    clock: fakeClock(opts.nowMs ?? 1_700_000_000_000),
    platform: opts.platform ?? 'linux',
  };

  return { deps, outLines, errLines, httpCalls, stdout: () => outLines.join('\n') };
}

// --- Shared healthy fixture ---------------------------------------------------------------

const TOKEN_FILE = '/home/u/.config/x-mcp/tokens.json';
const TOKEN_DIR = '/home/u/.config/x-mcp';

const HEALTHY_ENV: Record<string, string> = {
  X_MCP_AUTH_MODE: 'oauth2',
  X_MCP_CLIENT_ID: 'client-id-123',
  X_MCP_TOKEN_FILE: TOKEN_FILE,
};

const HEALTHY_FILES: Record<string, FakeFile> = {
  [TOKEN_DIR]: { kind: 'directory', mode: 0o700 },
  [TOKEN_FILE]: { kind: 'file', mode: 0o600 },
};

// --- Healthy path -------------------------------------------------------------------------

test('healthy env exits 0 and prints the resolved auth mode + two-axis policy matrix (T-205)', async () => {
  const f = makeDeps({ env: HEALTHY_ENV, files: HEALTHY_FILES });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 0);
  const output = f.stdout();
  assert.match(output, /auth mode: oauth2/);
  assert.match(output, /policy preset: read-only/);
  // The matrix is core/policy's resolution — read-only grants read:* except read:dm.
  assert.match(output, /allowed cells — tools in these cells register and run: .*read:content/);
  assert.match(output, /allowed cells .*read:account/);
  assert.match(output, /denied cells .*read:dm/);
  assert.match(output, /denied cells .*write:content/);
  assert.match(output, /denied cells — tools in these cells are registered but annotated/);
  assert.match(output, /doctor: healthy/);
});

test('policy overrides resolve through core/policy — deny wins over allow (POL-2)', async () => {
  const f = makeDeps({
    env: {
      ...HEALTHY_ENV,
      X_MCP_POLICY: 'full',
      X_MCP_POLICY_ALLOW: 'write:dm',
      X_MCP_POLICY_DENY: 'write:dm,destructive:content',
    },
    files: HEALTHY_FILES,
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 0);
  const output = f.stdout();
  const allowedLine = f.outLines.find((l) => l.startsWith('allowed cells'));
  const deniedLine = f.outLines.find((l) => l.startsWith('denied cells'));
  assert.ok(allowedLine !== undefined && deniedLine !== undefined);
  assert.match(deniedLine, /write:dm/); // allow + deny → denied (deny wins)
  assert.match(deniedLine, /destructive:content/); // preset grant revoked by deny
  assert.match(allowedLine, /write:content/); // rest of `full` stays allowed
  assert.match(output, /registered but annotated as disabled/); // hideDenied off → annotate, not hide
});

test('X_MCP_HIDE_DENIED=1 prints that denied tools are hidden from registration (POL-7)', async () => {
  const f = makeDeps({
    env: { ...HEALTHY_ENV, X_MCP_HIDE_DENIED: '1' },
    files: HEALTHY_FILES,
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 0);
  assert.match(f.stdout(), /hidden from registration \(X_MCP_HIDE_DENIED=1\)/);
});

// --- Broken env: remediation text + masking (CFG-5) ---------------------------------------

test('broken env exits 1 with the taxonomy remediation text (CFG-5)', async () => {
  const f = makeDeps({ env: { X_MCP_AUTH_MODE: 'app-only' } });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 1);
  const output = f.stdout();
  // parseConfig's validation XError message is surfaced verbatim — that IS the remediation.
  assert.match(output, /X_MCP_AUTH_MODE=app-only requires X_MCP_BEARER_TOKEN/);
  assert.match(output, /\[fail\]\s+config:/);
  assert.match(output, /remaining checks skipped/);
  assert.match(output, /doctor: 1 problem found/);
});

test('secret values never appear in output on a failing config (T-205 masking)', async () => {
  const secret = 'super-secret-bearer-value-9f3a';
  const f = makeDeps({
    env: { X_MCP_AUTH_MODE: 'oauth2', X_MCP_BEARER_TOKEN: secret, X_MCP_TOKEN_FILE: TOKEN_FILE },
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 1);
  assert.ok(!f.stdout().includes(secret), 'stdout leaked a secret value');
  assert.ok(!f.errLines.join('\n').includes(secret), 'stderr leaked a secret value');
});

test('credentials are reported as presence only — client secret masked, never printed', async () => {
  const secret = 'confidential-client-secret-77';
  const f = makeDeps({
    env: { ...HEALTHY_ENV, X_MCP_CLIENT_SECRET: secret },
    files: HEALTHY_FILES,
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 0);
  const output = f.stdout();
  assert.match(output, /client secret set \(masked\)/);
  assert.ok(!output.includes(secret), 'stdout leaked the client secret');
});

test('config warnings (CFG-8 unknown X_MCP_* var) surface as warnings, not failures', async () => {
  const f = makeDeps({
    env: { ...HEALTHY_ENV, X_MCP_POLCY: 'full' },
    files: HEALTHY_FILES,
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 0);
  assert.match(f.stdout(), /\[warn\]\s+config: Unknown environment variable X_MCP_POLCY/);
  assert.match(f.stdout(), /doctor: healthy/);
});

// --- Paths & permissions (SEC-T13, T1, AUTH-5, PLAT-2) ------------------------------------

test('perms: group/other-writable token directory is a failing check (SEC-T13)', async () => {
  const f = makeDeps({
    env: HEALTHY_ENV,
    files: { ...HEALTHY_FILES, [TOKEN_DIR]: { kind: 'directory', mode: 0o770 } },
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 1);
  const output = f.stdout();
  assert.match(output, /\[fail\]\s+token directory: .*writable by group\/other \(mode 0770\)/);
  assert.match(output, /chmod 700/);
});

test('perms: token file mode wider than 0600 is reported as a warning (T1)', async () => {
  const f = makeDeps({
    env: HEALTHY_ENV,
    files: { ...HEALTHY_FILES, [TOKEN_FILE]: { kind: 'file', mode: 0o644 } },
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 0); // warn only — startup would keep running too
  const output = f.stdout();
  assert.match(output, /\[warn\]\s+token file: .*group\/other \(mode 0644\)/);
  assert.match(output, /chmod 600/);
});

test('token file that is not a regular file (symlink) is a failing check (SEC-T13)', async () => {
  const f = makeDeps({
    env: HEALTHY_ENV,
    files: { ...HEALTHY_FILES, [TOKEN_FILE]: { kind: 'other' } },
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 1);
  assert.match(f.stdout(), /\[fail\]\s+token file: .*not a regular file/);
});

test('missing token file is only a warning pointing at authorize (pre-auth doctor run)', async () => {
  const f = makeDeps({
    env: HEALTHY_ENV,
    files: { [TOKEN_DIR]: { kind: 'directory', mode: 0o700 } },
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 0);
  assert.match(f.stdout(), /\[warn\]\s+token file: .*not found — run `npx x-mcp-ai authorize`/);
});

test('lock leftovers: a stale <token-file>.lock is noted with its age (AUTH-5)', async () => {
  const now = 1_700_000_000_000;
  const f = makeDeps({
    env: HEALTHY_ENV,
    files: {
      ...HEALTHY_FILES,
      [`${TOKEN_FILE}.lock`]: { kind: 'file', mode: 0o600, mtimeMs: now - 90_000 },
    },
    nowMs: now,
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 0); // noted, not failed — the server itself fails closed at runtime
  assert.match(
    f.stdout(),
    /\[warn\]\s+token lock: leftover lock file .*tokens\.json\.lock \(age 90 s\)/,
  );
  assert.match(f.stdout(), /AUTH-5/);
});

test('win32: POSIX permission checks degrade with an explicit note (PLAT-2)', async () => {
  const f = makeDeps({
    env: HEALTHY_ENV,
    files: {
      // Wide-open modes must NOT fail on Windows — the bits are not meaningful there.
      [TOKEN_DIR]: { kind: 'directory', mode: 0o777 },
      [TOKEN_FILE]: { kind: 'file', mode: 0o777 },
    },
    platform: 'win32',
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 0);
  const output = f.stdout();
  assert.match(output, /\[note\]\s+permissions: PLAT-2/);
  assert.doesNotMatch(output, /\[fail\]/);
});

test('media dir: X_MCP_MEDIA_DIR pointing at a missing directory is a failing check', async () => {
  const f = makeDeps({
    env: { ...HEALTHY_ENV, X_MCP_MEDIA_DIR: '/home/u/media' },
    files: HEALTHY_FILES,
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 1);
  assert.match(f.stdout(), /\[fail\]\s+media dir: X_MCP_MEDIA_DIR \/home\/u\/media does not exist/);
});

// --- CFG-9 — synced-storage warning --------------------------------------------------------

test('CFG-9: token file under Dropbox produces a synced-storage warning, not a failure', async () => {
  const tokenFile = '/home/u/Dropbox/x-mcp/tokens.json';
  const f = makeDeps({
    env: { ...HEALTHY_ENV, X_MCP_TOKEN_FILE: tokenFile },
    files: {
      '/home/u/Dropbox/x-mcp': { kind: 'directory', mode: 0o700 },
      [tokenFile]: { kind: 'file', mode: 0o600 },
    },
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 0);
  assert.match(f.stdout(), /\[warn\]\s+token file: CFG-9: .*Dropbox.*keep this file on local disk/);
});

test('CFG-9: iCloud Drive (Mobile Documents) and macOS CloudStorage paths are detected', async () => {
  const icloud = '/Users/u/Library/Mobile Documents/x-mcp/tokens.json';
  const f1 = makeDeps({
    env: { ...HEALTHY_ENV, X_MCP_TOKEN_FILE: icloud },
    files: {
      '/Users/u/Library/Mobile Documents/x-mcp': { kind: 'directory', mode: 0o700 },
      [icloud]: { kind: 'file', mode: 0o600 },
    },
    platform: 'darwin',
  });
  assert.equal(await createDoctorCli(f1.deps)([]), 0);
  assert.match(f1.stdout(), /CFG-9: .*iCloud Drive/);

  const cloudStorage = '/Users/u/Library/CloudStorage/GoogleDrive-u@example.com/x-mcp/tokens.json';
  const f2 = makeDeps({
    env: { ...HEALTHY_ENV, X_MCP_TOKEN_FILE: cloudStorage },
    files: { [cloudStorage]: { kind: 'file', mode: 0o600 } },
    platform: 'darwin',
  });
  assert.equal(await createDoctorCli(f2.deps)([]), 0);
  assert.match(f2.stdout(), /CFG-9: .*Google Drive/);
});

test('CFG-9: OneDrive on a Windows-style path is detected (segments split on backslash)', async () => {
  const tokenFile = 'C:\\Users\\u\\OneDrive\\x-mcp\\tokens.json';
  const f = makeDeps({
    env: { ...HEALTHY_ENV, X_MCP_TOKEN_FILE: tokenFile },
    files: {
      'C:\\Users\\u\\OneDrive\\x-mcp': { kind: 'directory' },
      [tokenFile]: { kind: 'file' },
    },
    platform: 'win32',
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 0);
  assert.match(f.stdout(), /CFG-9: .*OneDrive/);
});

// --- Profiles file (CFG-3/6) ----------------------------------------------------------------

const PROFILES_ENV: Record<string, string> = {
  X_MCP_TOKEN_FILE: TOKEN_FILE,
  X_MCP_PROFILES_FILE: '/home/u/profiles.json',
  X_MCP_PROFILE: 'work',
};

test('profiles file: unreadable file is a failing check with the read error surfaced', async () => {
  const f = makeDeps({ env: PROFILES_ENV, files: HEALTHY_FILES });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 1);
  assert.match(f.stdout(), /\[fail\]\s+profiles file: cannot read \/home\/u\/profiles\.json/);
});

test('profiles content is re-validated through parseConfig — invalid profile policy fails (CFG-6)', async () => {
  const f = makeDeps({
    env: PROFILES_ENV,
    files: {
      ...HEALTHY_FILES,
      '/home/u/profiles.json': {
        kind: 'file',
        mode: 0o600,
        content: '{"work":{"policy":"read-olny"}}',
      },
    },
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 1);
  assert.match(f.stdout(), /\[fail\]\s+config: .*invalid policy.*read-olny/);
});

// Both masking tests below need a doctor line that actually CONTAINS the secret, otherwise
// they would pass with the redactor removed. The only message that echoes profile input
// verbatim is the invalid-policy failure, so the profile's `policy` is set to the very
// string stored as a credential — contrived on purpose, and the sole observable proof that
// the value was learned from the profiles file rather than from the environment.

test('a profile-sourced secret is masked too, not just an env-sourced one (T-205/CFG-3)', async () => {
  const secret = 'profile-only-bearer-token-4b21';
  const f = makeDeps({
    env: { X_MCP_PROFILES_FILE: '/home/u/profiles.json', X_MCP_PROFILE: 'work' },
    files: {
      ...HEALTHY_FILES,
      '/home/u/profiles.json': {
        kind: 'file',
        mode: 0o600,
        content: JSON.stringify({
          work: { auth_mode: 'app-only', bearer_token: secret, policy: secret },
        }),
      },
    },
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 1);
  assert.match(f.stdout(), /\[fail\]\s+config: .*invalid policy.*\[redacted\]/);
  assert.ok(!f.stdout().includes(secret), 'stdout leaked a profile-sourced secret');
  assert.ok(!f.errLines.join('\n').includes(secret), 'stderr leaked a profile-sourced secret');
});

test('secrets of the NON-selected profiles are masked as well (T-205)', async () => {
  const other = 'other-profile-client-secret-8c05';
  const f = makeDeps({
    env: { X_MCP_PROFILES_FILE: '/home/u/profiles.json', X_MCP_PROFILE: 'work' },
    files: {
      ...HEALTHY_FILES,
      '/home/u/profiles.json': {
        kind: 'file',
        mode: 0o600,
        // The credential lives in `spare`, which is never selected and never validated in
        // depth; only `work` reaches the message that prints it.
        content: JSON.stringify({
          work: { auth_mode: 'app-only', bearer_token: 'work-token', policy: other },
          spare: { auth_mode: 'oauth2', client_secret: other, token_file: TOKEN_FILE },
        }),
      },
    },
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 1);
  assert.match(f.stdout(), /\[fail\]\s+config: .*invalid policy.*\[redacted\]/);
  assert.ok(!f.stdout().includes(other), 'stdout leaked an unrelated profile secret');
});

test('profiles file readable by group/other warns like the token file (CFG-6)', async () => {
  const f = makeDeps({
    env: PROFILES_ENV,
    files: {
      ...HEALTHY_FILES,
      '/home/u/profiles.json': { kind: 'file', mode: 0o644, content: '{"work":{}}' },
    },
  });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 0);
  assert.match(f.stdout(), /\[warn\]\s+profiles file: .*group\/other \(mode 0644\).*CFG-6/);
});

// --- Connectivity (opt-in, injected http) ---------------------------------------------------

test('connectivity is off by default — the injected http callable is never invoked', async () => {
  const f = makeDeps({ env: HEALTHY_ENV, files: HEALTHY_FILES });
  const code = await createDoctorCli(f.deps)([]);
  assert.equal(code, 0);
  assert.equal(f.httpCalls.length, 0);
  assert.match(f.stdout(), /\[note\]\s+connectivity: skipped — pass --connect/);
});

test('--connect performs exactly one GET through the injected http callable', async () => {
  const f = makeDeps({ env: HEALTHY_ENV, files: HEALTHY_FILES });
  const code = await createDoctorCli(f.deps)(['--connect']);
  assert.equal(code, 0);
  assert.deepEqual(f.httpCalls, ['https://api.x.com/2/openapi.json']);
  assert.match(
    f.stdout(),
    /\[ok\]\s+connectivity: GET https:\/\/api\.x\.com\/2\/openapi\.json → HTTP 200/,
  );
});

test('--connect network failure exits 1 with a network-flavored remediation', async () => {
  const f = makeDeps({
    env: HEALTHY_ENV,
    files: HEALTHY_FILES,
    http: () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.x.com')),
  });
  const code = await createDoctorCli(f.deps)(['--connect']);
  assert.equal(code, 1);
  const output = f.stdout();
  assert.match(output, /\[fail\]\s+connectivity: GET .* failed — getaddrinfo ENOTFOUND/);
  assert.match(output, /check DNS\/TLS/);
});

// --- Argument handling ----------------------------------------------------------------------

test('unknown argument exits 1 with usage on stderr and no checks run', async () => {
  const f = makeDeps({ env: HEALTHY_ENV, files: HEALTHY_FILES });
  const code = await createDoctorCli(f.deps)(['--bogus']);
  assert.equal(code, 1);
  assert.match(f.errLines.join('\n'), /unknown argument "--bogus"/);
  assert.match(f.errLines.join('\n'), /usage: x-mcp-ai doctor \[--connect\]/);
  assert.equal(f.outLines.length, 0);
});
