#!/usr/bin/env node
'use strict';

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
