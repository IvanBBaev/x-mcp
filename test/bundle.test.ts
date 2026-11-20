// Claude Desktop bundle (`.mcpb`, docs/08 Phase 4): `scripts/bundle.mjs` is run for real,
// twice, and its output is opened with the official MCPB toolkit (`@anthropic-ai/mcpb`, a
// devDependency) the way Claude Desktop opens it — unpacked, `mcp_config` substituted from
// the manifest, and the entry point launched over stdio from the unpacked directory alone.
// Asserted: the build is byte-for-byte reproducible, the archive carries the production
// closure and nothing from the dev tree, and the unpacked bundle boots and lists all tools
// with every setting left at its empty default except the two app-only credentials.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { getMcpConfigForManifest, unpackExtension } from '@anthropic-ai/mcpb';
import type { McpbManifestAny } from '@anthropic-ai/mcpb';

const run = promisify(execFile);
// From the compiled test (<outDir>/test/) two levels up is the repo root.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BUNDLE_SCRIPT = join(ROOT, 'scripts', 'bundle.mjs');

const work = mkdtempSync(join(tmpdir(), 'x-mcp-bundle-'));
test.after(() => rmSync(work, { recursive: true, force: true }));

async function bundle(name: string): Promise<{ path: string; sha256: string }> {
  const out = join(work, name);
  const { stdout } = await run(process.execPath, [BUNDLE_SCRIPT, '--out', out], { cwd: ROOT });
  const sha = /sha256 ([0-9a-f]{64})/.exec(stdout);
  assert.ok(sha, `bundle printed no sha256: ${stdout}`);
  return { path: out, sha256: sha[1]! };
}

/** Every file under `dir`, as `/`-separated paths relative to it. */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(dir.length + 1)
        .split(sep)
        .join('/'),
    );
}

let unpacked: { dir: string; files: string[] } | undefined;

test('MCPB: two builds of the same tree are byte-identical', async () => {
  const [first, second] = await Promise.all([bundle('a.mcpb'), bundle('b.mcpb')]);
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(readFileSync(first.path), readFileSync(second.path));

  const dir = join(work, 'unpacked');
  assert.equal(await unpackExtension({ mcpbPath: first.path, outputDir: dir, silent: true }), true);
  unpacked = { dir, files: listFiles(dir) };
});

test('MCPB: the archive holds the server and its production closure, nothing from the dev tree', () => {
  assert.ok(unpacked, 'the build test must run first');
  const files = new Set(unpacked.files);
  for (const required of [
    'manifest.json',
    'package.json',
    'LICENSE',
    'bin/x-mcp-ai.cjs',
    'build/src/index.js',
    'node_modules/@modelcontextprotocol/sdk/package.json',
    'node_modules/zod/package.json',
  ]) {
    assert.ok(files.has(required), `missing ${required}`);
  }
  const manifest = JSON.parse(readFileSync(join(unpacked.dir, 'manifest.json'), 'utf8')) as {
    version: string;
  };
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    version: string;
    devDependencies: Record<string, string>;
  };
  assert.equal(manifest.version, pkg.version);

  for (const file of files) {
    assert.ok(!file.startsWith('build/test/'), `test output bundled: ${file}`);
    assert.ok(!file.startsWith('src/') && !file.startsWith('test/'), `sources bundled: ${file}`);
    assert.ok(!file.endsWith('.map'), `source map bundled: ${file}`);
    assert.ok(!/(^|\/)\.env/.test(file), `env file bundled: ${file}`);
    assert.ok(!file.startsWith('node_modules/.bin/'), `bin link bundled: ${file}`);
  }
  for (const dev of Object.keys(pkg.devDependencies)) {
    assert.ok(
      !existsSync(join(unpacked.dir, 'node_modules', dev)),
      `devDependency bundled: ${dev}`,
    );
  }
});

test('MCPB: the unpacked bundle boots from its own directory with the substituted config', async () => {
  assert.ok(unpacked, 'the build test must run first');
  const manifest = JSON.parse(
    readFileSync(join(unpacked.dir, 'manifest.json'), 'utf8'),
  ) as McpbManifestAny;
  const config = await getMcpConfigForManifest({
    manifest,
    extensionPath: unpacked.dir,
    systemDirs: {},
    userConfig: { auth_mode: 'app-only', bearer_token: 'AAAA' },
    pathSeparator: sep,
  });
  assert.ok(config);
  assert.equal(config.command, 'node');
  const env = config.env ?? {};
  assert.equal(env.X_MCP_AUTH_MODE, 'app-only');
  assert.equal(env.X_MCP_BEARER_TOKEN, 'AAAA');
  assert.equal(env.X_MCP_POLICY, '', 'an untouched option must arrive empty');

  // Only what a desktop host passes through, so nothing leaks in from the dev shell. Matched
  // on the real key names (Windows spells it `Path`, and its env lookup ignores case).
  const PASS_THROUGH = new Set([
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
  ]);
  const base: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (PASS_THROUGH.has(key.toUpperCase())) base[key] = value;
  }
  const child = spawn(process.execPath, config.args ?? [], {
    cwd: unpacked.dir,
    env: { ...base, ...env },
  });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 15_000);
  watchdog.unref();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));

  const responses = new Map<number, Record<string, unknown>>();
  const waiting = new Map<number, () => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as { id?: number };
    if (typeof message.id === 'number') {
      responses.set(message.id, message);
      waiting.get(message.id)?.();
    }
  });
  const response = (id: number) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (responses.has(id)) return resolve(responses.get(id)!);
      waiting.set(id, () => resolve(responses.get(id)!));
      child.once('exit', () => reject(new Error(`exited before response ${id}: ${stderr}`)));
    });

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'mcpb-probe', version: '0.0.0' },
      },
    })}\n`,
  );
  const init = (await response(1)) as { result?: { serverInfo?: { version?: string } } };
  assert.equal(init.result?.serverInfo?.version, (manifest as { version: string }).version);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  const list = (await response(2)) as { result?: { tools?: unknown[] } };
  assert.equal(list.result?.tools?.length, 45);

  child.stdin.end();
  const [code] = (await once(child, 'exit')) as [number | null];
  clearTimeout(watchdog);
  assert.equal(code, 0, stderr);
  assert.ok(!stderr.includes('fatal'), stderr);
});
