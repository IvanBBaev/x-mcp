// Tests for the file-backed TokenStore (T-202 / WP-2.1) — docs/02 §4A, docs/04
// §4.1-4.2, docs/07 AUTH-5/AUTH-7/AUTH-9/PLAT-1/PLAT-2, threat SEC-T13/T1.
//
// The suites run against the REAL filesystem inside a fresh mkdtemp directory per
// test; time and waiting are fully faked (fakeSleep advances fakeClock — no test ever
// waits for real), and the TokenFs seam injects the faults that cannot be produced
// safely on a healthy machine (EEXIST races, win32 rename failures, kill-9 leftovers).

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { constants as FSC, promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { fakeClock, fakeSleep } from '../../helpers/index.js';
import { XError } from '../../../src/core/errors.js';
import {
  createFileTokenStore,
  nodeTokenFs,
  LOCK_POLL_MS,
  LOCK_STALE_MS,
  LOCK_WAIT_MS,
  TOKEN_FILE_SCHEMA_VERSION,
  WIN32_RENAME_ATTEMPTS,
  WIN32_RENAME_DELAY_MS,
} from '../../../src/api/oauth2/filestore.js';
import type { FileTokenStoreOptions, TokenFs } from '../../../src/api/oauth2/filestore.js';
import type { TokenPair } from '../../../src/core/ports.js';

interface Harness {
  readonly dir: string;
  readonly path: string;
  readonly lockPath: string;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly sleep: ReturnType<typeof fakeSleep>;
  readonly warnings: string[];
  store(overrides?: Partial<FileTokenStoreOptions>): ReturnType<typeof createFileTokenStore>;
}

async function makeHarness(t: TestContext): Promise<Harness> {
  const dir = await fsp.mkdtemp(join(os.tmpdir(), 'x-mcp-filestore-'));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'tokens.json');
  const clock = fakeClock(1_000_000);
  const sleep = fakeSleep(clock);
  const warnings: string[] = [];
  return {
    dir,
    path,
    lockPath: `${path}.lock`,
    clock,
    sleep,
    warnings,
    store(overrides) {
      return createFileTokenStore({
        path,
        clock,
        sleep: sleep.fn,
        platform: 'linux',
        warn: (message) => warnings.push(message),
        ...overrides,
      });
    },
  };
}

const PAIR: TokenPair = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  obtained_at: 1_000_000,
  expires_in: 7200,
};

async function assertAuthError(promise: Promise<unknown>, ...fragments: string[]): Promise<XError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(XError.is(caught), `expected an XError, got: ${String(caught)}`);
  assert.equal(caught.kind, 'auth');
  assert.equal(caught.retryable, false);
  for (const fragment of fragments) {
    assert.ok(
      caught.message.includes(fragment),
      `expected message to include "${fragment}", got: ${caught.message}`,
    );
  }
  return caught;
}

async function fileMode(path: string): Promise<number> {
  return (await fsp.stat(path)).mode & 0o777;
}

async function writeLockFile(lockPath: string, content: string): Promise<void> {
  await fsp.writeFile(lockPath, content, { encoding: 'utf8', mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Basic round-trip, permissions, corruption (T1, AUTH-9, SEC-T13)
// ---------------------------------------------------------------------------

test('T1: persist writes the token file with mode 0600 and load round-trips the pair', async (t) => {
  const h = await makeHarness(t);
  const store = h.store();
  await store.persist(PAIR);
  assert.equal(await fileMode(h.path), 0o600);
  const loaded = await store.load();
  assert.ok(loaded !== null);
  assert.equal(loaded.access_token, PAIR.access_token);
  assert.equal(loaded.refresh_token, PAIR.refresh_token);
  assert.equal(loaded.obtained_at, PAIR.obtained_at);
  assert.equal(loaded.expires_in, PAIR.expires_in);
  assert.equal(loaded.version, 1); // first persist bumps the revision 0 → 1
  assert.deepEqual(h.warnings, []);
});

test('load returns null when the token file does not exist', async (t) => {
  const h = await makeHarness(t);
  assert.equal(await h.store().load(), null);
});

test('AUTH-9: empty token file fails closed with path and authorize hint, file untouched', async (t) => {
  const h = await makeHarness(t);
  await fsp.writeFile(h.path, '   \n', { mode: 0o600 });
  await assertAuthError(h.store().load(), h.path, 'left untouched', 'npx x-mcp-ai authorize');
  assert.equal(await fsp.readFile(h.path, 'utf8'), '   \n'); // never deleted or rewritten
});

test('AUTH-9: invalid JSON and missing required fields fail closed, file untouched', async (t) => {
  const h = await makeHarness(t);
  const store = h.store();

  await fsp.writeFile(h.path, '{ not json', { mode: 0o600 });
  await assertAuthError(store.load(), h.path, 'not valid JSON', 'npx x-mcp-ai authorize');
  assert.equal(await fsp.readFile(h.path, 'utf8'), '{ not json');

  await fsp.writeFile(h.path, JSON.stringify({ version: 1, refresh_token: 'r' }), { mode: 0o600 });
  await assertAuthError(store.load(), h.path, 'access_token', 'npx x-mcp-ai authorize');

  await fsp.writeFile(h.path, JSON.stringify({ version: 1, access_token: 'a', expires_in: 7200 }), {
    mode: 0o600,
  });
  await assertAuthError(store.load(), h.path, 'obtained_at');

  await fsp.writeFile(h.path, JSON.stringify({ version: 1, access_token: 'a', obtained_at: 5 }), {
    mode: 0o600,
  });
  await assertAuthError(store.load(), h.path, 'expires_in');
});

test('T1: token file wider than 0600 warns once across repeated loads', async (t) => {
  const h = await makeHarness(t);
  const store = h.store();
  await store.persist(PAIR);
  await fsp.chmod(h.path, 0o644);
  await store.load();
  await store.load();
  const permWarnings = h.warnings.filter((w) => w.includes('chmod 600'));
  assert.equal(permWarnings.length, 1);
  assert.ok(permWarnings[0]?.includes(h.path));
  assert.ok(permWarnings[0]?.includes('644'));
});

test('SEC-T13: group/other-writable token directory is refused by load and persist', async (t) => {
  const h = await makeHarness(t);
  const store = h.store();
  await store.persist(PAIR);
  await fsp.chmod(h.dir, 0o770);
  await assertAuthError(store.load(), h.dir, 'chmod 700');
  await assertAuthError(store.persist(PAIR), h.dir, 'chmod 700');
  await fsp.chmod(h.dir, 0o777);
  await assertAuthError(store.load(), h.dir, 'chmod 700');
  await fsp.chmod(h.dir, 0o700); // restore for cleanup
});

// ---------------------------------------------------------------------------
// PLAT-2: explicit degradation on win32
// ---------------------------------------------------------------------------

test('PLAT-2: POSIX permission checks are skipped on win32 with a one-time warning', async (t) => {
  const h = await makeHarness(t);
  const store = h.store({ platform: 'win32' });
  await store.persist(PAIR);
  await fsp.chmod(h.dir, 0o777); // would be refused on POSIX
  await fsp.chmod(h.path, 0o644); // would warn on POSIX
  assert.ok((await store.load()) !== null); // no refusal on win32
  await store.load();
  const permsWarnings = h.warnings.filter((w) => w.includes('POSIX permission checks'));
  assert.equal(permsWarnings.length, 1);
  assert.equal(
    h.warnings.filter((w) => w.includes('chmod 600')).length,
    0, // the file-perms warning must not fire on win32
  );
  await fsp.chmod(h.dir, 0o700);
});

test('PLAT-2: O_NOFOLLOW is omitted from open flags on win32 with a one-time warning', async (t) => {
  const h = await makeHarness(t);
  const openFlags: number[] = [];
  const recordingFs: TokenFs = {
    ...nodeTokenFs,
    open: (path, flags, mode) => {
      openFlags.push(flags);
      return nodeTokenFs.open(path, flags, mode);
    },
  };

  const posixStore = h.store({ fs: recordingFs });
  await posixStore.persist(PAIR);
  assert.ok(openFlags.every((f) => (f & FSC.O_NOFOLLOW) !== 0));

  openFlags.length = 0;
  const winStore = h.store({ platform: 'win32', fs: recordingFs });
  await winStore.persist(PAIR);
  await winStore.load();
  assert.ok(openFlags.length > 0);
  assert.ok(openFlags.every((f) => (f & FSC.O_NOFOLLOW) === 0));
  assert.equal(h.warnings.filter((w) => w.includes('O_NOFOLLOW')).length, 1);
});

// ---------------------------------------------------------------------------
// SEC-T13: symlink refusal on the token path
// ---------------------------------------------------------------------------

test('SEC-T13: a symlinked token file is refused on load and the target is never read', async (t) => {
  const h = await makeHarness(t);
  const target = join(h.dir, 'victim.json');
  await fsp.writeFile(target, JSON.stringify({ version: 1, access_token: 'stolen' }), {
    mode: 0o600,
  });
  await fsp.symlink(target, h.path);
  await assertAuthError(h.store().load(), h.path, 'symbolic link', 'refusing');
});

test('SEC-T13: persist over a symlinked token path replaces the link and never writes through it', async (t) => {
  const h = await makeHarness(t);
  const target = join(h.dir, 'victim.txt');
  await fsp.writeFile(target, 'victim-content', { mode: 0o600 });
  await fsp.symlink(target, h.path);
  const store = h.store();
  await store.persist(PAIR);
  // rename() replaced the symlink itself with the real tmp file...
  const stat = await fsp.lstat(h.path);
  assert.equal(stat.isSymbolicLink(), false);
  // ...and the symlink target was never written through.
  assert.equal(await fsp.readFile(target, 'utf8'), 'victim-content');
  const loaded = await store.load();
  assert.equal(loaded?.access_token, PAIR.access_token);
});

test('SEC-T13: a symlink planted at the first tmp candidate is skipped, its target untouched', async (t) => {
  const h = await makeHarness(t);
  const target = join(h.dir, 'plant-target.txt');
  await fsp.writeFile(target, 'plant-content', { mode: 0o600 });
  // The first candidate name is deterministic: `${path}.${pid}.0.tmp`.
  await fsp.symlink(target, `${h.path}.${process.pid}.0.tmp`);
  const store = h.store();
  await store.persist(PAIR); // O_EXCL|O_NOFOLLOW refuses the plant; the next seq succeeds
  assert.equal(await fsp.readFile(target, 'utf8'), 'plant-content');
  const loaded = await store.load();
  assert.equal(loaded?.access_token, PAIR.access_token);
});

test('SEC-T13: persist fails closed when every tmp candidate is occupied, targets untouched', async (t) => {
  const h = await makeHarness(t);
  const target = join(h.dir, 'plant-target.txt');
  await fsp.writeFile(target, 'plant-content', { mode: 0o600 });
  for (let seq = 0; seq < 3; seq += 1) {
    await fsp.symlink(target, `${h.path}.${process.pid}.${seq}.tmp`);
  }
  await assertAuthError(h.store().persist(PAIR), 'NOT saved', '*.tmp');
  assert.equal(await fsp.readFile(target, 'utf8'), 'plant-content');
  await assert.rejects(fsp.access(h.path)); // the token file was never created
});

// ---------------------------------------------------------------------------
// Atomicity of persist (crash / failure between tmp write and rename)
// ---------------------------------------------------------------------------

test('a rename failure leaves the previous pair intact and the store recovers on retry', async (t) => {
  const h = await makeHarness(t);
  let failNext = false;
  const faultyFs: TokenFs = {
    ...nodeTokenFs,
    rename: (oldPath, newPath) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(Object.assign(new Error('injected'), { code: 'EIO' }));
      }
      return nodeTokenFs.rename(oldPath, newPath);
    },
  };
  const store = h.store({ fs: faultyFs });
  await store.persist(PAIR); // old pair on disk

  failNext = true;
  const newer: TokenPair = { ...PAIR, access_token: 'access-2', version: 1 };
  await assertAuthError(store.persist(newer), h.path, 'in memory');

  // Old pair intact — the crash-window invariant.
  const loaded = await store.load();
  assert.equal(loaded?.access_token, 'access-1');

  // The failed tmp file was cleaned up.
  const leftovers = (await fsp.readdir(h.dir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);

  // A subsequent persist succeeds.
  await store.persist(newer);
  assert.equal((await store.load())?.access_token, 'access-2');
});

test('stray tmp leftovers from a dead process never block persist or load', async (t) => {
  const h = await makeHarness(t);
  // kill-9 leftovers: same prefix shape, dead PID.
  await fsp.writeFile(`${h.path}.99999.0.tmp`, 'half-written', { mode: 0o600 });
  await fsp.writeFile(`${h.path}.99999.7.tmp`, '', { mode: 0o600 });
  const store = h.store();
  await store.persist(PAIR);
  assert.equal((await store.load())?.access_token, PAIR.access_token);
});

// ---------------------------------------------------------------------------
// PLAT-1: win32 rename-over-open-file semantics
// ---------------------------------------------------------------------------

function renameFailingFs(codes: string[]): TokenFs {
  return {
    ...nodeTokenFs,
    rename: (oldPath, newPath) => {
      const code = codes.shift();
      if (code !== undefined) {
        return Promise.reject(Object.assign(new Error(`injected ${code}`), { code }));
      }
      return nodeTokenFs.rename(oldPath, newPath);
    },
  };
}

test('PLAT-1: win32 rename EPERM is retried briefly and then succeeds', async (t) => {
  const h = await makeHarness(t);
  const store = h.store({ platform: 'win32', fs: renameFailingFs(['EPERM', 'EBUSY']) });
  await store.persist(PAIR);
  assert.deepEqual(h.sleep.calls, [WIN32_RENAME_DELAY_MS, WIN32_RENAME_DELAY_MS]);
  assert.equal((await store.load())?.access_token, PAIR.access_token);
});

test('PLAT-1: persistent win32 rename failure surfaces a typed auth error after bounded retries', async (t) => {
  const h = await makeHarness(t);
  const codes = Array.from({ length: WIN32_RENAME_ATTEMPTS }, () => 'EPERM');
  const store = h.store({ platform: 'win32', fs: renameFailingFs(codes) });
  await assertAuthError(
    store.persist(PAIR),
    h.path,
    'holding the file open',
    'in memory for this session only',
  );
  // attempts - 1 sleeps between attempts, no more.
  assert.equal(h.sleep.calls.length, WIN32_RENAME_ATTEMPTS - 1);
  // tmp file cleaned up, token file never created.
  const leftovers = (await fsp.readdir(h.dir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  await assert.rejects(fsp.access(h.path));
});

test('PLAT-1: rename failures are NOT retried on POSIX platforms', async (t) => {
  const h = await makeHarness(t);
  const store = h.store({ platform: 'linux', fs: renameFailingFs(['EPERM']) });
  await assertAuthError(store.persist(PAIR), h.path);
  assert.equal(h.sleep.calls.length, 0); // one attempt, no retry sleeps
});

// ---------------------------------------------------------------------------
// withLock: creation, content, release (docs/02 §4A)
// ---------------------------------------------------------------------------

test('withLock creates the lock 0600 with {pid, timestamp}, removes it on success and on error', async (t) => {
  const h = await makeHarness(t);
  const store = h.store();
  let observed: { pid: number; timestamp: number } | undefined;
  const result = await store.withLock(async () => {
    assert.equal(await fileMode(h.lockPath), 0o600);
    observed = JSON.parse(await fsp.readFile(h.lockPath, 'utf8')) as {
      pid: number;
      timestamp: number;
    };
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(observed?.pid, process.pid);
  assert.equal(observed?.timestamp, 1_000_000);
  await assert.rejects(fsp.access(h.lockPath)); // released on success

  await assert.rejects(
    store.withLock(() => Promise.reject(new Error('boom'))),
    /boom/,
  );
  await assert.rejects(fsp.access(h.lockPath)); // released on failure too
});

// ---------------------------------------------------------------------------
// AUTH-5 / AUTH-7: the stale-lock fail-closed matrix
// ---------------------------------------------------------------------------

test('AUTH-5: a fresh lock of a live process is never broken — wait, then fail closed', async (t) => {
  const h = await makeHarness(t);
  await writeLockFile(h.lockPath, JSON.stringify({ pid: 4242, timestamp: h.clock.now() }));
  const store = h.store({ isPidAlive: () => true });
  let ran = false;
  await assertAuthError(
    store.withLock(() => {
      ran = true;
      return Promise.resolve();
    }),
    h.lockPath,
    'failing closed',
    'double refresh',
  );
  assert.equal(ran, false);
  assert.equal(h.sleep.calls.length, LOCK_WAIT_MS / LOCK_POLL_MS); // full budget, no real waiting
  await fsp.access(h.lockPath); // the foreign lock is left in place
});

test('AUTH-5: an expired lock of a LIVE process is never reclaimed', async (t) => {
  const h = await makeHarness(t);
  await writeLockFile(
    h.lockPath,
    JSON.stringify({ pid: 4242, timestamp: h.clock.now() - LOCK_STALE_MS * 10 }),
  );
  const store = h.store({ isPidAlive: () => true });
  let ran = false;
  await assertAuthError(
    store.withLock(() => {
      ran = true;
      return Promise.resolve();
    }),
    'failing closed',
  );
  assert.equal(ran, false);
  await fsp.access(h.lockPath); // still there
});

test('AUTH-5: a lock that is both expired AND provably dead is reclaimed immediately', async (t) => {
  const h = await makeHarness(t);
  await writeLockFile(
    h.lockPath,
    JSON.stringify({ pid: 4242, timestamp: h.clock.now() - LOCK_STALE_MS }),
  );
  const store = h.store({ isPidAlive: () => false });
  let lockDuringFn: { pid: number } | undefined;
  await store.withLock(async () => {
    lockDuringFn = JSON.parse(await fsp.readFile(h.lockPath, 'utf8')) as { pid: number };
  });
  assert.equal(lockDuringFn?.pid, process.pid); // reclaimed and re-stamped as ours
  assert.equal(h.sleep.calls.length, 0); // no waiting needed
  await assert.rejects(fsp.access(h.lockPath)); // released afterwards
});

test('AUTH-5: a dead process’s FRESH lock is reclaimed only after it crosses the staleness line', async (t) => {
  const h = await makeHarness(t);
  await writeLockFile(h.lockPath, JSON.stringify({ pid: 4242, timestamp: h.clock.now() }));
  const store = h.store({ isPidAlive: () => false });
  let ran = false;
  await store.withLock(() => {
    ran = true;
    return Promise.resolve();
  });
  assert.equal(ran, true);
  // fakeSleep advances the clock LOCK_POLL_MS per poll: the lock becomes stale only
  // after LOCK_STALE_MS of (simulated) waiting — never earlier, and with no real delay.
  assert.equal(h.sleep.calls.length, LOCK_STALE_MS / LOCK_POLL_MS);
});

test('AUTH-5: an unreadable/corrupt lock (kill-9 mid-write) fails closed and is left in place', async (t) => {
  const h = await makeHarness(t);
  await writeLockFile(h.lockPath, '{"pid": 42'); // truncated JSON
  const store = h.store({ isPidAlive: () => false });
  await assertAuthError(
    store.withLock(() => Promise.resolve()),
    'failing closed',
  );
  assert.equal(await fsp.readFile(h.lockPath, 'utf8'), '{"pid": 42'); // untouched
});

test('AUTH-7: a future-timestamped lock (peer clock skew) is never considered stale', async (t) => {
  const h = await makeHarness(t);
  // Peer's clock runs far ahead: timestamp beyond our whole wait budget. Age stays
  // negative → never stale, even though the pid is provably dead.
  await writeLockFile(
    h.lockPath,
    JSON.stringify({ pid: 4242, timestamp: h.clock.now() + LOCK_WAIT_MS * 10 }),
  );
  const store = h.store({ isPidAlive: () => false });
  await assertAuthError(
    store.withLock(() => Promise.resolve()),
    'failing closed',
  );
  await fsp.access(h.lockPath);
});

test('AUTH-5: losing the O_EXCL race means waiting for the winner, then acquiring cleanly', async (t) => {
  const h = await makeHarness(t);
  // The "winner" holds a real lock; our first create loses with EEXIST. After three
  // polls the winner releases (the sleep side effect), and we acquire for real.
  await writeLockFile(h.lockPath, JSON.stringify({ pid: 4242, timestamp: h.clock.now() }));
  let polls = 0;
  const sleepWithRelease = async (ms: number): Promise<void> => {
    polls += 1;
    if (polls === 3) await fsp.unlink(h.lockPath);
    return h.sleep.fn(ms);
  };
  const store = h.store({ isPidAlive: () => true, sleep: sleepWithRelease });
  let ran = false;
  await store.withLock(() => {
    ran = true;
    return Promise.resolve();
  });
  assert.equal(ran, true);
  assert.equal(polls, 3);
});

test('AUTH-5: release leaves a lock that no longer looks like ours and warns instead', async (t) => {
  const h = await makeHarness(t);
  const foreign = JSON.stringify({ pid: 4242, timestamp: 123 });
  const store = h.store();
  await store.withLock(async () => {
    // Simulate a peer that (wrongly) reclaimed our lock mid-critical-section.
    await fsp.rm(h.lockPath);
    await writeLockFile(h.lockPath, foreign);
  });
  assert.equal(await fsp.readFile(h.lockPath, 'utf8'), foreign); // left in place
  assert.equal(h.warnings.filter((w) => w.includes('not removing the refresh lock')).length, 1);
});

test('SEC-T13: a symlinked lock file is never followed — fail closed, target intact', async (t) => {
  const h = await makeHarness(t);
  const target = join(h.dir, 'lock-target.json');
  const targetContent = JSON.stringify({ pid: 99999, timestamp: 0 }); // would look stale+dead
  await fsp.writeFile(target, targetContent, { mode: 0o600 });
  await fsp.symlink(target, h.lockPath);
  const store = h.store({ isPidAlive: () => false });
  // O_NOFOLLOW makes the read fail → 'unreadable' → never reclaimed, fail closed.
  await assertAuthError(
    store.withLock(() => Promise.resolve()),
    'failing closed',
  );
  assert.equal(await fsp.readFile(target, 'utf8'), targetContent);
  assert.equal((await fsp.lstat(h.lockPath)).isSymbolicLink(), true);
});

test('withLock returns the callback value and rethrows its error unchanged', async (t) => {
  const h = await makeHarness(t);
  const store = h.store();
  assert.equal(await store.withLock(() => Promise.resolve(42)), 42);
  const boom = new Error('kaboom');
  await assert.rejects(
    store.withLock(() => Promise.reject(boom)),
    (err: unknown) => err === boom,
  );
});

// ---------------------------------------------------------------------------
// Version migration (docs/05 §8.7) and the revision counter
// ---------------------------------------------------------------------------

test('migration: a legacy file without "version" loads and the next persist stamps the current schema', async (t) => {
  const h = await makeHarness(t);
  await fsp.writeFile(
    h.path,
    JSON.stringify({ access_token: 'legacy', obtained_at: 1, expires_in: 3600 }),
    { mode: 0o600 },
  );
  const store = h.store();
  const legacy = await store.load();
  assert.ok(legacy !== null);
  assert.equal(legacy.access_token, 'legacy');
  assert.equal(legacy.version, undefined); // no revision recorded yet

  await store.persist(legacy);
  const raw = JSON.parse(await fsp.readFile(h.path, 'utf8')) as Record<string, unknown>;
  assert.equal(raw['version'], TOKEN_FILE_SCHEMA_VERSION);
});

test('migration: a FUTURE schema version fails closed with upgrade remediation, file untouched', async (t) => {
  const h = await makeHarness(t);
  const futureBody = JSON.stringify({
    version: 999,
    access_token: 'from-the-future',
    obtained_at: 1,
    expires_in: 3600,
  });
  await fsp.writeFile(h.path, futureBody, { mode: 0o600 });
  await assertAuthError(
    h.store().load(),
    h.path,
    'version 999',
    'upgrade this server',
    'not downgraded',
  );
  assert.equal(await fsp.readFile(h.path, 'utf8'), futureBody); // never touched
});

test('the revision counter bumps monotonically across persist/load cycles', async (t) => {
  const h = await makeHarness(t);
  const store = h.store();
  await store.persist(PAIR); // pair.version undefined → revision 1
  const first = await store.load();
  assert.ok(first !== null);
  assert.equal(first.version, 1);
  await store.persist(first); // revision 1 → 2
  const second = await store.load();
  assert.equal(second?.version, 2);
});
