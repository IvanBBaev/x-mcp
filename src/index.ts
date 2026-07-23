#!/usr/bin/env node
// Composition root — SCAFFOLD PLACEHOLDER (owned/expanded by T-130).
//
// The finished root reads process.env + the optional profiles file, calls
// core/config.parseConfig, wires the api/mcp adapters, and starts the stdio server
// (it does the I/O that `core` must not). For now it only proves the launcher +
// subcommand routing + the `x-mcp-ai: fatal:` startup contract (CFG-5).
import { parseSubcommand } from './cli/dispatch.js';

function fatal(reason: string): never {
  process.stderr.write(`x-mcp-ai: fatal: ${reason}\n`);
  process.exit(1);
}

const { command } = parseSubcommand(process.argv.slice(2));
fatal(`'${command}' is not wired yet (scaffold). Server: T-130; authorize: T-204; doctor: T-205.`);
