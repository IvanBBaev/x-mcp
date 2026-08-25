// Process-level smoke tests for the composition root (T-130): the BUILT `src/index.js` is
// spawned as a child, exactly as an MCP host launches it. Asserted contracts: stdout
// carries ONLY JSON-RPC frames (MCP-1), stdin EOF and SIGTERM exit cleanly (MCP-3), and a
// bad environment produces the single `x-mcp-ai: fatal:` stderr line (CFG-5).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// Resolves inside the same compiled tree this test runs from (works for any outDir).
const ENTRY = fileURLToPath(new URL('../../src/index.js', import.meta.url));

/** The inherited env with every X_MCP_* variable stripped, plus the test's own settings. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('X_MCP_')) env[key] = value;
  }
  return { ...env, ...extra };
}

const VALID_ENV = { X_MCP_AUTH_MODE: 'app-only', X_MCP_BEARER_TOKEN: 'AAAA' };

function spawnServer(
  args: readonly string[],
  extraEnv: Record<string, string>,
): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [ENTRY, ...args], { env: cleanEnv(extraEnv) });
  // Watchdog: a hung child must fail the test, not hang the runner forever.
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 15_000);
  watchdog.unref();
  child.once('exit', () => clearTimeout(watchdog));
  return child;
}

function frame(message: object): string {
  return `${JSON.stringify(message)}\n`;
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'spawn-probe', version: '0.0.0' },
  },
};

/** Collect a stream fully into a string (for stderr / non-line assertions). */
function collect(stream: NodeJS.ReadableStream): () => string {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => (buffer += chunk));
  return () => buffer;
}

interface LineReader {
  /** Every line seen so far (for whole-stream purity assertions). */
  readonly lines: string[];
  /** The next line, or null once the stream closed. */
  next(): Promise<string | null>;
}

/**
 * Queueing line reader. NOT a `for await` over readline: breaking out of that loop
 * destroys the interface, which would silently swallow every later frame.
 */
function lineReader(stream: NodeJS.ReadableStream): LineReader {
  const rl = createInterface({ input: stream });
  const lines: string[] = [];
  const queue: string[] = [];
  const waiters: ((line: string | null) => void)[] = [];
  rl.on('line', (line) => {
    lines.push(line);
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    for (const waiter of waiters.splice(0)) waiter(null);
  });
  return {
    lines,
    next() {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/** Read frames until the response with `id` arrives; fail if the stream ends first. */
async function responseWithId(reader: LineReader, id: number): Promise<Record<string, unknown>> {
  for (;;) {
    const line = await reader.next();
    assert.ok(line !== null, `stdout closed before the id:${id} response arrived`);
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.id === id) return message;
  }
}

test('MCP-1/MCP-3: stdout carries only JSON-RPC frames and stdin EOF exits cleanly', async () => {
  const child = spawnServer(['serve'], VALID_ENV);
  const stderr = collect(child.stderr);
  const reader = lineReader(child.stdout);

  child.stdin.write(frame(INITIALIZE));
  await responseWithId(reader, 1);
  child.stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  const listResponse = (await responseWithId(reader, 2)) as {
    result?: { tools?: unknown[] };
  };
  assert.equal(listResponse.result?.tools?.length, 41, 'tools/list must expose all 41 tools');

  // MCP-3 — closing stdin (host is done) must exit 0 without being killed.
  child.stdin.end();
  const [code, signal] = (await once(child, 'exit')) as [number | null, string | null];
  assert.equal(code, 0);
  assert.equal(signal, null);

  // MCP-1 — every stdout line the server emitted is a well-formed JSON-RPC frame.
  assert.ok(reader.lines.length >= 2);
  for (const line of reader.lines) {
    const message = JSON.parse(line) as { jsonrpc?: string };
    assert.equal(message.jsonrpc, '2.0', `non-protocol bytes on stdout: ${line}`);
  }
  assert.ok(!stderr().includes('fatal'), `unexpected fatal on stderr: ${stderr()}`);
});

test('MCP-3: stdin EOF flushes a large buffered response instead of truncating it', async () => {
  // Regression (found by the T-316 compatibility probe). The test above reads each frame as
  // it arrives, which keeps stdout drained and so can never see this: the failure needs a
  // host that writes its requests and closes stdin WITHOUT reading. `tools/list` is ~74 kB —
  // well past a 64 kB pipe buffer — so exiting the moment the server closed used to deliver
  // a frame cut mid-JSON. Measured before the fix: 66,654 of 75,575 bytes, 6 runs out of 6.
  const child = spawnServer(['serve'], VALID_ENV);
  const stdout = collect(child.stdout);

  child.stdin.write(frame(INITIALIZE));
  child.stdin.write(frame({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  // No read between the write and the EOF — that ordering is the whole point.
  child.stdin.end();

  const [code] = (await once(child, 'exit')) as [number | null];
  assert.equal(code, 0);

  const lines = stdout().trim().split('\n');
  // Every frame must be complete, not merely the last one: a truncated frame is unparseable.
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `truncated frame on stdout: ${line.slice(-80)}`);
  }
  const listResponse = lines
    .map((line) => JSON.parse(line) as { id?: number; result?: { tools?: unknown[] } })
    .find((message) => message.id === 2);
  assert.ok(listResponse, 'the tools/list response never reached stdout');
  assert.equal(listResponse.result?.tools?.length, 41);
});

// Windows has no POSIX signals: `child.kill('SIGTERM')` there is an unconditional
// `TerminateProcess`, so the server's handler can never run and the child always dies
// by-signal. Nothing in this repo can change that — the axis asserts a POSIX kernel
// guarantee, so it skips rather than assert a fiction (docs/13 §Windows).
test(
  'MCP-3: SIGTERM after startup exits cleanly with code 0',
  {
    skip: process.platform === 'win32' ? 'win32 kills unconditionally — no SIGTERM handler' : false,
  },
  async () => {
    const child = spawnServer(['serve'], VALID_ENV);
    const reader = lineReader(child.stdout);

    // Wait for the initialize response so the signal lands on a fully-started server.
    child.stdin.write(frame(INITIALIZE));
    await responseWithId(reader, 1);

    child.kill('SIGTERM');
    const [code, signal] = (await once(child, 'exit')) as [number | null, string | null];
    // The handler exits deliberately (process.exit(0)) — NOT death-by-signal.
    assert.equal(code, 0);
    assert.equal(signal, null);
  },
);

test('CFG-5: an invalid environment yields one fatal stderr line, empty stdout, exit 1', async () => {
  const child = spawnServer(['serve'], {
    ...VALID_ENV,
    X_MCP_POLICY: 'no-such-preset',
  });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);

  const [code] = (await once(child, 'exit')) as [number | null];
  assert.equal(code, 1);
  assert.equal(stdout(), '', 'stdout must stay protocol-pure even on startup failure (MCP-1)');
  const errLines = stderr().trim().split('\n');
  assert.equal(errLines.length, 1, `expected a single fatal line, got: ${stderr()}`);
  assert.match(errLines[0] ?? '', /^x-mcp-ai: fatal: /);
  assert.match(errLines[0] ?? '', /no-such-preset/);
});

test('CFG-5/INT-7: authorize without a token store fails closed with one fatal line', async () => {
  // app-only mode resolves NEITHER backend — no token file and no keychain entry — so the
  // composition root must refuse to start the OAuth flow instead of composing an authorize
  // CLI around a store that cannot persist anything.
  const child = spawnServer(['authorize'], VALID_ENV);
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);

  const [code] = (await once(child, 'exit')) as [number | null];
  assert.equal(code, 1);
  assert.equal(stdout(), '');
  const errLines = stderr().trim().split('\n');
  assert.equal(errLines.length, 1, `expected a single fatal line, got: ${stderr()}`);
  assert.match(errLines[0] ?? '', /^x-mcp-ai: fatal: authorize needs an OAuth2 token store/);
});

test('CFG-6: a group/other-readable profiles file warns on stderr and still starts', async (t) => {
  // PLAT-2 — there is no POSIX permission model to violate on Windows.
  if (process.platform === 'win32') return t.skip('POSIX permissions only');
  const dir = await fsp.mkdtemp(join(tmpdir(), 'x-mcp-profiles-'));
  const file = join(dir, 'profiles.json');
  // The credential lives IN the profile: CFG-3 refuses a profile selection combined with
  // direct env credentials, so VALID_ENV cannot be reused here.
  const content = JSON.stringify({ work: { auth_mode: 'app-only', bearer_token: 'AAAA' } });
  await fsp.writeFile(file, content, { mode: 0o644 });
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const child = spawnServer(['serve'], { X_MCP_PROFILES_FILE: file, X_MCP_PROFILE: 'work' });
  const stderr = collect(child.stderr);
  const reader = lineReader(child.stdout);

  // A warning is NOT a refusal: the server must reach a working handshake.
  child.stdin.write(frame(INITIALIZE));
  const response = await responseWithId(reader, 1);
  // MCP-1 — the notice went to stderr only; the first stdout line is still a JSON-RPC frame.
  assert.equal(response.jsonrpc, '2.0');
  child.stdin.end();
  await once(child, 'exit');

  assert.match(stderr(), /^x-mcp-ai: warning: .*profiles\.json is readable by group or other/m);
  assert.match(stderr(), /mode 644.*chmod 600/);
});

test('INT-7: doctor runs the real diagnostics CLI and exits 0 on a healthy env', async () => {
  const child = spawnServer(['doctor'], VALID_ENV);
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);

  const [code] = (await once(child, 'exit')) as [number | null];
  assert.equal(code, 0, `stderr: ${stderr()}`);
  assert.match(stdout(), /environment configuration is valid/);
  assert.match(stdout(), /doctor: healthy/);
});
