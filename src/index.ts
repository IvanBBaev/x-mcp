#!/usr/bin/env node
// Composition root (T-130; docs/02 §5). The ONLY place that touches process.env, argv,
// stdio, and signals. Flow: route the subcommand (cli/dispatch) → read the optional
// profiles file + validate the environment (core/config) → compose the object graph
// (mcp/compose) → serve MCP over stdio. Startup failure prints a single
// `x-mcp-ai: fatal: <reason>` line to STDERR and exits non-zero (CFG-5); stdout carries
// nothing but JSON-RPC frames (MCP-1).

import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fsp, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createConfiguredTokenStore } from './api/oauth2/store.js';
import {
  createAuthorizeCli,
  createFetchTokenExchangeHttp,
  createNodeLoopbackListen,
  createStdinReadLine,
} from './cli/authorize.js';
import { createDoctorCli } from './cli/doctor.js';
import type { DoctorStat } from './cli/doctor.js';
import { parseSubcommand } from './cli/dispatch.js';
import { parseConfig } from './core/config.js';
import type { Config } from './core/config.js';
import { XError } from './core/errors.js';
import type { Clock, Random, Sleep } from './core/ports.js';
import { composeServer } from './mcp/compose.js';

/** The CFG-5 startup contract: one legible stderr line, non-zero exit, silent stdout. */
function fatal(reason: string): never {
  process.stderr.write(`x-mcp-ai: fatal: ${reason}\n`);
  process.exit(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Leading-`~` expansion for the operator-supplied profiles path (PLAT-3). */
function expandLeadingTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** The parsed profiles document plus any non-fatal startup notices it produced (CFG-6). */
interface ProfilesLoad {
  readonly value: unknown;
  readonly warnings: readonly string[];
}

/**
 * CFG-6 permission hygiene: the profiles file may carry client secrets and bearer tokens,
 * so it gets the SAME rule as the token file — group/other-readable is a warning, not a
 * refusal. Warning rather than fatal is deliberate: unlike the token file, which this
 * server writes and therefore owns, the profiles file is authored by the operator, and
 * refusing to start over a file we never created would be a footgun. Windows has no POSIX
 * permission model, so the check is skipped there (PLAT-2).
 */
function profilesPermissionWarning(file: string): string[] {
  if (process.platform === 'win32') return [];
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch {
    return []; // Unreadable files are already fatal at the read below.
  }
  if ((mode & 0o077) === 0) return [];
  return [
    `profiles file ${file} is readable by group or other (mode ${(mode & 0o777).toString(8)}); ` +
      'it may hold credentials — restrict it with `chmod 600`.',
  ];
}

/**
 * Read + parse the optional profiles file (CFG-6). `parseConfig` validates the selected
 * profile's CONTENT; physically reading the file is this root's I/O to do. An unreadable
 * or non-JSON file is a startup error, never a silent fallback.
 */
function loadProfilesJson(env: NodeJS.ProcessEnv): ProfilesLoad {
  const raw = env.X_MCP_PROFILES_FILE?.trim();
  if (raw === undefined || raw === '') return { value: undefined, warnings: [] };
  const file = expandLeadingTilde(raw);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    fatal(`cannot read profiles file "${file}" — ${errorMessage(error)}`);
  }
  const warnings = profilesPermissionWarning(file);
  try {
    return { value: JSON.parse(text), warnings };
  } catch (error) {
    fatal(`profiles file "${file}" is not valid JSON — ${errorMessage(error)}`);
  }
}

/**
 * The validated config plus the notices raised BEFORE validation. `Config.warnings` is
 * built by `parseConfig` and cannot carry a finding about the file that fed it, so the
 * two lists are merged by the caller rather than folded into `Config`.
 */
interface ConfigLoad {
  readonly config: Config;
  readonly warnings: readonly string[];
}

function loadConfig(): ConfigLoad {
  const profiles = loadProfilesJson(process.env);
  try {
    return { config: parseConfig(process.env, profiles.value), warnings: profiles.warnings };
  } catch (error) {
    // parseConfig throws a `validation` XError carrying one legible reason (CFG-5).
    fatal(XError.is(error) ? error.message : errorMessage(error));
  }
}

async function serve(): Promise<void> {
  const { config, warnings } = loadConfig();

  // Non-fatal startup notices (CFG-6/CFG-7/CFG-8) go to stderr ONLY, so stdout stays
  // protocol-pure (MCP-1) at every log level. The pre-validation findings come first:
  // "your credentials file is world-readable" outranks "unknown X_MCP_* variable".
  if (config.logLevel !== 'silent') {
    for (const warning of [...warnings, ...config.warnings]) {
      process.stderr.write(`x-mcp-ai: warning: ${warning}\n`);
    }
  }

  const { server } = composeServer(config);

  // MCP-3 — graceful shutdown: a host that is done closes our stdin (EOF) or signals us;
  // every path closes the server once and exits cleanly instead of lingering or crashing.
  // MCP-3 — stdout on a pipe is asynchronous, so exiting the instant the server closes can
  // truncate a response that is still buffered: a `tools/list` frame is ~74 kB, far past a
  // 64 kB pipe buffer, so a host that closes stdin immediately after writing its request
  // receives a half-written JSON frame. Flush first — but bounded, because a peer that has
  // stopped reading must never make us linger.
  const FLUSH_TIMEOUT_MS = 1_000;
  const flushStdout = (): Promise<void> =>
    new Promise((resolve) => {
      if (process.stdout.writableLength === 0) {
        resolve();
        return;
      }
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(settle, FLUSH_TIMEOUT_MS);
      // An empty write's callback runs after every previously queued write has flushed.
      process.stdout.write('', settle);
    });

  let closing = false;
  const shutdown = (code: number): void => {
    if (closing) return;
    closing = true;
    void server
      .close()
      .catch(() => undefined)
      .then(flushStdout)
      .then(() => process.exit(code));
  };
  process.stdin.once('end', () => shutdown(0));
  process.stdin.once('close', () => shutdown(0));
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
  // MCP-3 — a vanished host breaks the stdout pipe; EPIPE must exit quietly, never enter
  // a write-crash-write loop.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    process.stderr.write(`x-mcp-ai: fatal: stdout error — ${errorMessage(error)}\n`);
    process.exit(1);
  });

  await server.connect(new StdioServerTransport());
}

// --- CLI subcommand composition (INT-7) ------------------------------------------------

const cliClock: Clock = { now: () => Date.now() };
// The CLI sleep must unref() its timer: a pending authorize callback-timeout must never
// hold the process open after a successful exchange (T-204 seam note).
const cliSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
const cliRandom: Random = {
  float: () => Math.random(),
  uuid: () => randomUUID(),
  bytes: (n) => new Uint8Array(randomBytes(n)),
};
const writeLine =
  (stream: NodeJS.WriteStream) =>
  (line: string): void => {
    stream.write(`${line}\n`);
  };

async function runAuthorize(rest: readonly string[]): Promise<number> {
  const { config, warnings } = loadConfig();
  for (const warning of warnings) process.stderr.write(`x-mcp-ai: warning: ${warning}\n`);
  // Whichever backend the server will READ from is the one authorize must WRITE to — the
  // selector is shared with mcp/compose precisely so the two cannot disagree. app-only
  // mode resolves nothing, and minting a user token there would be meaningless.
  const tokenStore = createConfiguredTokenStore(config, cliClock, cliSleep);
  if (tokenStore === undefined) {
    fatal('authorize needs an OAuth2 token store (X_MCP_AUTH_MODE=oauth2)');
  }
  const run = createAuthorizeCli({
    oauth: {
      clientId: config.oauth2.clientId ?? '',
      ...(config.oauth2.clientSecret !== undefined
        ? { clientSecret: config.oauth2.clientSecret }
        : {}),
      tokenUrl: new URL('/2/oauth2/token', config.baseUrl).toString(),
    },
    tokenStore,
    http: createFetchTokenExchangeHttp(),
    random: cliRandom,
    clock: cliClock,
    sleep: cliSleep,
    listen: createNodeLoopbackListen(),
    readLine: createStdinReadLine(),
    stdout: writeLine(process.stdout),
    stderr: writeLine(process.stderr),
  });
  return run(rest);
}

async function runDoctor(rest: readonly string[]): Promise<number> {
  const run = createDoctorCli({
    env: process.env,
    fs: {
      // lstat, not stat — the doctor reports on symlinks instead of following them.
      stat: (p) =>
        fsp.lstat(p).then(
          (s): DoctorStat => ({
            kind: s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'other',
            mode: s.mode & 0o777,
            mtimeMs: s.mtimeMs,
          }),
          () => null,
        ),
      readFile: (p) => fsp.readFile(p, 'utf8'),
    },
    http: async (url) => {
      const response = await fetch(url);
      return { status: response.status };
    },
    stdout: writeLine(process.stdout),
    stderr: writeLine(process.stderr),
    clock: cliClock,
  });
  return run(rest);
}

const { command, rest } = parseSubcommand(process.argv.slice(2));
if (command === 'authorize' || command === 'doctor') {
  const run = command === 'authorize' ? runAuthorize : runDoctor;
  run(rest)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      fatal(errorMessage(error));
    });
} else {
  serve().catch((error: unknown) => {
    fatal(errorMessage(error));
  });
}
