// The OAuth2 cross-process concurrency suite (T-206 / WP-2.5) — docs/02 §4A, docs/07
// CONC-4, AUTH-5, AUTH-7. Where filestore.test.ts proves the stale-lock protocol
// against FAKE seams (injected pid probes, fake fs), this suite proves it against the
// real thing: real child Node processes (spawned via process.execPath from the compiled
// fixtures/ drivers), real PIDs probed by the store's DEFAULT process.kill(pid, 0)
// liveness check, a real shared token file in a fresh mkdtemp directory, and a local
// node:http stub standing in for X's token endpoint, counting every refresh POST.
//
// Flake policy: no assertion ever depends on a wall-clock timing window. Assertions are
// on counters (refresh POSTs, persisted revisions, lock polls) and on ordering enforced
// by the drivers' line protocol (READY/GO/RESULT, LOCKED). Lock "age" is manufactured
// through the injectable Clock seam — either a fake clock in-process, or a backdated
// clock offset injected into the child — never by really waiting 30 s.
//
// Windows-compatible by construction: children are spawned from process.execPath with
// argv arrays (no shell), paths use path.join / fileURLToPath, tmp dirs come from
// fs.mkdtemp under os.tmpdir(), and SIGKILL goes through child.kill('SIGKILL').

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promises as fsp } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { fakeClock, fakeSleep } from '../../helpers/index.js';
import { XError } from '../../../src/core/errors.js';
import type { Clock, Sleep } from '../../../src/core/ports.js';
import {
  createFileTokenStore,
  LOCK_POLL_MS,
  LOCK_STALE_MS,
  LOCK_WAIT_MS,
  TOKEN_FILE_SCHEMA_VERSION,
} from '../../../src/api/oauth2/filestore.js';
import { createRefreshMachine } from '../../../src/api/oauth2/machine.js';
import { createFetchRefreshHttp } from '../../../src/api/oauth2/index.js';

/** Rescue timer for child-protocol waits: fires only on genuine failure, never a race. */
const RESCUE_TIMEOUT_MS = 20_000;

/** Backdate applied to a child lock holder's clock so its lock is born already stale. */
const BACKDATE_MS = LOCK_STALE_MS + 5_000;

const realClock: Clock = { now: () => Date.now() };

// ---------------------------------------------------------------------------
// Harness: tmp dirs, the stubbed token endpoint, child drivers, typed asserts
// ---------------------------------------------------------------------------

async function makeTmpDir(t: TestContext): Promise<string> {
  const dir = await fsp.mkdtemp(join(os.tmpdir(), 'x-mcp-conc-'));
  t.after(async () => {
    // Best-effort: on Windows a just-killed child can briefly pin an entry.
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  return dir;
}

/** The well-known initial pair every scenario starts from: expired, refreshable. */
async function writeExpiredTokenFile(path: string): Promise<void> {
  const body = {
    version: TOKEN_FILE_SCHEMA_VERSION,
    access_token: 'access-initial',
    refresh_token: 'refresh-initial',
    obtained_at: Date.now() - 3_600_000, // minted an hour ago…
    expires_in: 60, // …with a minute of life: long expired, eager refresh fires
  };
  await fsp.writeFile(path, `${JSON.stringify(body, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

interface RecordedRefresh {
  readonly method: string;
  readonly url: string;
  readonly grantType: string | null;
  readonly refreshToken: string | null;
  readonly clientId: string | null;
}

interface TokenEndpointStub {
  readonly url: string;
  /** One entry per POST, in arrival order. Refresh N is answered with `rotated-*-N`. */
  readonly requests: readonly RecordedRefresh[];
}

/**
 * A local stand-in for X's token endpoint: counts every refresh POST and answers the
 * N-th one with `rotated-access-N`/`rotated-refresh-N`. `holdFirstResponseMs` keeps the
 * FIRST response in flight briefly so the losing process provably contends for the held
 * lock — it widens the interleaving window but no assertion depends on it.
 */
async function startTokenEndpointStub(
  t: TestContext,
  options: { holdFirstResponseMs?: number } = {},
): Promise<TokenEndpointStub> {
  const requests: RecordedRefresh[] = [];
  const holdMs = options.holdFirstResponseMs ?? 0;
  let counter = 0;

  const server = createServer((req, res) => {
    req.on('error', () => undefined); // a SIGKILLed client may RST mid-stream
    res.on('error', () => undefined);
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      counter += 1;
      const n = counter;
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        grantType: form.get('grant_type'),
        refreshToken: form.get('refresh_token'),
        clientId: form.get('client_id'),
      });
      const respond = (): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            token_type: 'bearer',
            access_token: `rotated-access-${n}`,
            refresh_token: `rotated-refresh-${n}`,
            expires_in: 7200,
          }),
        );
      };
      if (n === 1 && holdMs > 0) setTimeout(respond, holdMs);
      else respond();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'stub server must expose a port');
  const url = `http://127.0.0.1:${String(address.port)}`;
  t.after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections(); // drop keep-alive sockets so close() cannot hang
    });
  });
  return { url, requests };
}

interface ChildHarness {
  readonly child: ChildProcess;
  /** Everything the child wrote to stderr so far — for failure diagnostics. */
  stderr(): string;
  /** Resolve with the next stdout line starting with one of `prefixes` (in order). */
  waitForLine(...prefixes: string[]): Promise<string>;
  /** Write one line to the child's stdin. */
  send(line: string): void;
  /** Await process exit and return its exit code (null when signal-killed). */
  exited(): Promise<number | null>;
}

function spawnFixture(t: TestContext, fixture: string, args: readonly string[]): ChildHarness {
  const scriptPath = fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url));
  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.ok(child.stdout !== null && child.stderr !== null && child.stdin !== null);

  let stderrText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrText += chunk;
  });

  const lines: string[] = [];
  let cursor = 0;
  let closed = false;
  const watchers = new Set<() => void>();
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    lines.push(line.trim());
    for (const watcher of watchers) watcher();
  });
  child.on('close', () => {
    closed = true;
    for (const watcher of watchers) watcher();
  });
  child.on('error', () => undefined); // surfaced through `closed` + diagnostics instead

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'close').catch(() => undefined);
    }
  });

  const diagnose = (what: string): string =>
    `${fixture}: ${what}; stdout so far: ${JSON.stringify(lines)}; stderr: ${stderrText || '(empty)'}`;

  return {
    child,
    stderr: () => stderrText,
    waitForLine: (...prefixes: string[]) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(diagnose(`timed out waiting for ${prefixes.join('|')}`)));
        }, RESCUE_TIMEOUT_MS);
        const cleanup = (): void => {
          clearTimeout(timer);
          watchers.delete(check);
        };
        const check = (): void => {
          while (cursor < lines.length) {
            const line = lines[cursor];
            cursor += 1;
            if (line !== undefined && prefixes.some((p) => line.startsWith(p))) {
              cleanup();
              resolve(line);
              return;
            }
          }
          if (closed) {
            cleanup();
            reject(new Error(diagnose(`exited before ${prefixes.join('|')}`)));
          }
        };
        watchers.add(check);
        check();
      }),
    send: (line: string) => {
      child.stdin?.write(`${line}\n`);
    },
    exited: async () => {
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
      return child.exitCode;
    },
  };
}

interface ChildResult {
  readonly token: string;
  readonly state: string;
}

/** Consume the refresh-child's terminal line; an ERROR line fails with diagnostics. */
async function childResult(h: ChildHarness): Promise<ChildResult> {
  const line = await h.waitForLine('RESULT ', 'ERROR ');
  if (line.startsWith('ERROR ')) {
    throw new Error(`refresh-child failed: ${line.slice('ERROR '.length)}; stderr: ${h.stderr()}`);
  }
  return JSON.parse(line.slice('RESULT '.length)) as ChildResult;
}

/** A recording Sleep that never really waits (real-clock legs assert on poll COUNTS). */
function instantSleep(): { readonly fn: Sleep; readonly calls: number[] } {
  const calls: number[] = [];
  return {
    fn: (ms) => {
      calls.push(ms);
      return Promise.resolve();
    },
    calls,
  };
}

async function assertFailsClosed(promise: Promise<unknown>, ...fragments: string[]): Promise<void> {
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
}

async function readDiskPair(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fsp.readFile(path, 'utf8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// CONC-4 — two real processes, one token file, exactly ONE refresh
// ---------------------------------------------------------------------------

test('CONC-4: two processes hitting one expired token file perform exactly one refresh; the loser adopts from disk', async (t) => {
  const dir = await makeTmpDir(t);
  const tokenFile = join(dir, 'tokens.json');
  await writeExpiredTokenFile(tokenFile);
  // Hold the single refresh response briefly so the loser demonstrably polls the
  // winner's held lock; every interleaving still satisfies the assertions below.
  const stub = await startTokenEndpointStub(t, { holdFirstResponseMs: 600 });

  const a = spawnFixture(t, 'refresh-child.js', [tokenFile, stub.url, 'client-a']);
  const b = spawnFixture(t, 'refresh-child.js', [tokenFile, stub.url, 'client-b']);

  // Barrier: both children have built the full stack before either may start.
  await Promise.all([a.waitForLine('READY'), b.waitForLine('READY')]);
  a.send('GO');
  b.send('GO');

  const [resultA, resultB] = await Promise.all([childResult(a), childResult(b)]);
  assert.equal(await a.exited(), 0, `child A exit; stderr: ${a.stderr()}`);
  assert.equal(await b.exited(), 0, `child B exit; stderr: ${b.stderr()}`);

  // Exactly ONE refresh POST total, spending the ORIGINAL refresh token (§4A: the
  // loser reloads under the lock and adopts — it never re-spends the rotation).
  assert.equal(stub.requests.length, 1);
  const refresh = stub.requests[0];
  assert.ok(refresh !== undefined);
  assert.equal(refresh.method, 'POST');
  assert.equal(refresh.url, '/2/oauth2/token');
  assert.equal(refresh.grantType, 'refresh_token');
  assert.equal(refresh.refreshToken, 'refresh-initial');

  // Both processes end up on the winner's rotation — no lockout, no divergence.
  assert.equal(resultA.token, 'rotated-access-1');
  assert.equal(resultB.token, 'rotated-access-1');

  // Disk carries the rotated pair; the lock was released; no tmp litter remains.
  const disk = await readDiskPair(tokenFile);
  assert.equal(disk['access_token'], 'rotated-access-1');
  assert.equal(disk['refresh_token'], 'rotated-refresh-1');
  assert.equal(disk['version'], TOKEN_FILE_SCHEMA_VERSION);
  assert.ok(typeof disk['revision'] === 'number' && disk['revision'] >= 1);
  assert.deepEqual(await fsp.readdir(dir), ['tokens.json']);
});

// ---------------------------------------------------------------------------
// kill-9 between refresh and persist → clean recovery by a fresh process
// ---------------------------------------------------------------------------

test('AUTH-5/CONC-4: SIGKILL between refresh and persist — a fresh process reclaims the dead holder’s stale lock and recovers', async (t) => {
  const dir = await makeTmpDir(t);
  const tokenFile = join(dir, 'tokens.json');
  const lockPath = `${tokenFile}.lock`;
  await writeExpiredTokenFile(tokenFile);
  const stub = await startTokenEndpointStub(t);

  // The doomed child: backdated clock → its lock is born past the staleness line as
  // seen by a real clock; it spends refresh #1 at the stub, then hangs before persist.
  const doomed = spawnFixture(t, 'lock-holder-child.js', [
    tokenFile,
    String(-BACKDATE_MS),
    stub.url,
  ]);
  await doomed.waitForLine('LOCKED');
  assert.equal(stub.requests.length, 1); // the rotation is spent server-side…
  assert.equal((await readDiskPair(tokenFile))['access_token'], 'access-initial'); // …but never persisted

  // kill -9 exactly between refresh and persist.
  doomed.child.kill('SIGKILL');
  await doomed.exited();
  const holder = JSON.parse(await fsp.readFile(lockPath, 'utf8')) as { pid: number };
  assert.equal(holder.pid, doomed.child.pid); // the dead child's lock survived it

  // A fresh, fully real recovery stack: real clock, DEFAULT process.kill(0) liveness
  // probe, production refresh HTTP against the stub. The dead holder's lock is already
  // stale (backdate ≥ LOCK_STALE_MS), so takeover is immediate — zero lock polls.
  const sleep = instantSleep();
  const warnings: string[] = [];
  const store = createFileTokenStore({
    path: tokenFile,
    clock: realClock,
    sleep: sleep.fn,
    warn: (message) => warnings.push(message),
  });
  const machine = createRefreshMachine({
    clock: realClock,
    store,
    refreshHttp: createFetchRefreshHttp({ baseUrl: stub.url, clientId: 'recovery' }),
  });

  const token = await machine.getAccessToken();
  assert.equal(token, 'rotated-access-2');
  assert.equal(machine.state(), 'VALID');
  assert.equal(sleep.calls.length, 0); // provably-dead + stale → reclaimed without waiting

  // The child's unsaved rotation is invisible: recovery refreshed from the persisted
  // truth — the ORIGINAL refresh token — exactly once (refresh #2 overall).
  assert.equal(stub.requests.length, 2);
  const recoveryRefresh = stub.requests[1];
  assert.ok(recoveryRefresh !== undefined);
  assert.equal(recoveryRefresh.refreshToken, 'refresh-initial');
  assert.equal(recoveryRefresh.clientId, 'recovery');

  // Persist-before-use landed on disk and the reclaimed lock was released.
  const disk = await readDiskPair(tokenFile);
  assert.equal(disk['access_token'], 'rotated-access-2');
  assert.equal(disk['refresh_token'], 'rotated-refresh-2');
  await assert.rejects(fsp.access(lockPath));
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// AUTH-5 / AUTH-7 stale-lock matrix against REAL PIDs and the DEFAULT probe
// ---------------------------------------------------------------------------

test('AUTH-5: a LIVE process’s lock is never taken over, even past the staleness line — fail closed', async (t) => {
  const dir = await makeTmpDir(t);
  const tokenFile = join(dir, 'tokens.json');
  const lockPath = `${tokenFile}.lock`;

  // A genuinely live holder whose lock timestamp already looks expired (backdated
  // clock): expired + alive must NEVER be reclaimed (AUTH-5's break-and-refresh ban).
  const holder = spawnFixture(t, 'lock-holder-child.js', [tokenFile, String(-BACKDATE_MS), '-']);
  await holder.waitForLine('LOCKED');

  const sleep = instantSleep();
  const store = createFileTokenStore({
    path: tokenFile,
    clock: realClock,
    sleep: sleep.fn,
    warn: () => undefined,
  });
  let ran = false;
  await assertFailsClosed(
    store.withLock(() => {
      ran = true;
      return Promise.resolve();
    }),
    lockPath,
    'failing closed',
    'double refresh',
  );
  assert.equal(ran, false);
  // The full wait budget was spent polling (counted, not timed) before failing closed.
  assert.equal(sleep.calls.length, LOCK_WAIT_MS / LOCK_POLL_MS);
  // The holder survived and its lock is untouched.
  assert.equal(holder.child.exitCode, null);
  assert.equal(holder.child.signalCode, null);
  const survivor = JSON.parse(await fsp.readFile(lockPath, 'utf8')) as { pid: number };
  assert.equal(survivor.pid, holder.child.pid);

  holder.child.kill('SIGKILL');
  await holder.exited();
});

test('AUTH-5: a DEAD process’s fresh lock is waited out — takeover only once it crosses the staleness line', async (t) => {
  const dir = await makeTmpDir(t);
  const tokenFile = join(dir, 'tokens.json');
  const lockPath = `${tokenFile}.lock`;

  // Harvest a real, provably dead PID.
  const dead = spawnFixture(t, 'exit-child.js', []);
  assert.equal(await dead.exited(), 0);
  const deadPid = dead.child.pid;
  assert.ok(deadPid !== undefined);

  // Its (synthesised) lock is FRESH by the store's injected fake clock; the fake sleep
  // advances that clock per poll, so staleness is crossed by counting, never waiting.
  const clock = fakeClock();
  const sleep = fakeSleep(clock);
  await fsp.writeFile(lockPath, JSON.stringify({ pid: deadPid, timestamp: clock.now() }), {
    encoding: 'utf8',
    mode: 0o600,
  });
  const store = createFileTokenStore({
    path: tokenFile,
    clock,
    sleep: sleep.fn,
    warn: () => undefined,
  });

  let ran = false;
  await store.withLock(() => {
    ran = true;
    return Promise.resolve();
  });
  assert.equal(ran, true);
  // Dead-but-fresh is respected for exactly LOCK_STALE_MS of (simulated) waiting: the
  // DEFAULT pid probe said "dead" from poll one, yet takeover waited for staleness.
  assert.equal(sleep.calls.length, LOCK_STALE_MS / LOCK_POLL_MS);
  await assert.rejects(fsp.access(lockPath)); // released after the critical section
});

test('AUTH-5/AUTH-7: a DEAD process’s stale lock is taken over immediately and re-stamped', async (t) => {
  const dir = await makeTmpDir(t);
  const tokenFile = join(dir, 'tokens.json');
  const lockPath = `${tokenFile}.lock`;

  const dead = spawnFixture(t, 'exit-child.js', []);
  assert.equal(await dead.exited(), 0);
  const deadPid = dead.child.pid;
  assert.ok(deadPid !== undefined);

  // Aged through the Clock seam (AUTH-7: staleness is judged ONLY by the injected
  // clock): the lock sits exactly on the staleness line, and the holder is truly dead.
  const clock = fakeClock();
  const sleep = fakeSleep(clock);
  await fsp.writeFile(
    lockPath,
    JSON.stringify({ pid: deadPid, timestamp: clock.now() - LOCK_STALE_MS }),
    { encoding: 'utf8', mode: 0o600 },
  );
  const store = createFileTokenStore({
    path: tokenFile,
    clock,
    sleep: sleep.fn,
    warn: () => undefined,
  });

  let lockDuringFn: { pid: number } | undefined;
  await store.withLock(async () => {
    lockDuringFn = JSON.parse(await fsp.readFile(lockPath, 'utf8')) as { pid: number };
  });
  assert.equal(lockDuringFn?.pid, process.pid); // reclaimed and re-stamped as OURS
  assert.equal(sleep.calls.length, 0); // stale + provably dead → no waiting at all
  await assert.rejects(fsp.access(lockPath)); // and released cleanly afterwards
});
