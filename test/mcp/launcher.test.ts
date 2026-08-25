// Launcher probe expectations (MCP-6): `bin/x-mcp-ai.cjs` is the npx entry an OLD Node may
// execute, so it must stay parseable CommonJS (no top-level import/await, no optional
// chaining beyond what ancient parsers accept is required — but the load-bearing pieces
// are pinned here) and must forward failures as the standard fatal contract (CFG-5).
// These are source-shape assertions: T-130 must not break the launcher; spawning it would
// require the SHARED build/ output, which parallel tasks own.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// From the compiled test (<outDir>/test/mcp/) three levels up is the repo root.
const LAUNCHER = fileURLToPath(new URL('../../../bin/x-mcp-ai.cjs', import.meta.url));
const source = readFileSync(LAUNCHER, 'utf8');

test('MCP-6: the launcher is executable CommonJS with a node shebang', () => {
  assert.ok(source.startsWith('#!/usr/bin/env node\n'));
  assert.match(source, /^'use strict';$/m);
  // CJS only: dynamic import() is the sole ESM doorway; no top-level import/export syntax.
  assert.doesNotMatch(source, /^\s*(import|export)\s/m);
  assert.match(source, /require\('node:path'\)/);
  assert.match(source, /require\('node:url'\)/);
});

test('MCP-6: an ancient-Node version guard runs before any node:-prefixed require', () => {
  // Node < 14.18 cannot resolve `require('node:path')` — it dies with an opaque
  // MODULE_NOT_FOUND — so the guard must textually precede the first such require and
  // must itself use only ES5-era syntax (var + string concat; pinned by the patterns).
  const guardAt = source.indexOf('process.versions.node');
  const firstNodeRequire = source.indexOf("require('node:");
  assert.ok(guardAt !== -1, 'guard must reference process.versions.node');
  assert.ok(firstNodeRequire !== -1);
  assert.ok(guardAt < firstNodeRequire, 'guard must come before the first node: require');
  assert.match(
    source,
    /var nodeMajor = parseInt\(process\.versions\.node\.split\('\.'\)\[0\], 10\)/,
  );
  assert.match(source, /nodeMajor < 20/);
  // The refusal is the standard fatal contract: one legible stderr line, then exit 1.
  assert.match(source, /is not supported - Node >= 22 is required/);
  assert.match(source, /process\.exit\(1\)/);
});

test('MCP-6: the launcher targets the built composition root via a file URL', () => {
  // The exact entry join the packaged layout depends on: <pkg>/build/src/index.js.
  assert.match(source, /path\.join\(__dirname, '\.\.', 'build', 'src', 'index\.js'\)/);
  assert.match(source, /import\(pathToFileURL\(entry\)\.href\)/);
});

test('MCP-6/CFG-5: a failed dynamic import surfaces as the standard fatal contract', () => {
  assert.match(source, /\.catch\(/);
  assert.match(source, /x-mcp-ai: fatal: /);
  assert.match(source, /process\.stderr\.write/);
  assert.match(source, /process\.exit\(1\)/);
});
