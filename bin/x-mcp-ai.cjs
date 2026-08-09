#!/usr/bin/env node
'use strict';

// MCP-6 / OPS-F1: refuse ancient Node with a legible message BEFORE anything else.
// The `node:`-prefixed requires below throw an opaque MODULE_NOT_FOUND on Node < 14.18,
// so this guard must come first and use only ES5-era syntax (var, string concat) that
// every Node back to 0.x can parse. Threshold 20: engines say >= 22, but the Node 20 CI
// leg must still boot the launcher, so only < 20 is refused here.
var nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor < 20) {
  process.stderr.write(
    'x-mcp-ai: fatal: Node ' +
      process.versions.node +
      ' is not supported - Node >= 22 is required\n',
  );
  process.exit(1);
}

// CJS launcher for `npx` compatibility. The real entry point is the compiled ESM
// composition root (build/src/index.js); we import it dynamically so the package
// works whether invoked via `npx x-mcp-ai` or a global bin symlink.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const entry = path.join(__dirname, '..', 'build', 'src', 'index.js');

import(pathToFileURL(entry).href).catch((err) => {
  const reason = err && err.message ? err.message : String(err);
  process.stderr.write(`x-mcp-ai: fatal: ${reason}\n`);
  process.exit(1);
});
