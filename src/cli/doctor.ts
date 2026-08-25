// CLI `doctor` — offline environment diagnostics (T-205, WP-2.2, OPS-F9).
//
// `x-mcp-ai doctor` validates the operator's environment WITHOUT starting the server:
//   • config      — the whole X_MCP_* surface via core/config's parseConfig (CFG-1…8);
//                   fatal problems surface the error taxonomy's remediation text verbatim.
//   • paths/perms — token file/dir existence + POSIX mode (report, never fix; SEC-T13, T1),
//                   profiles-file perms (CFG-6), media-dir existence, leftover
//                   `<token-file>.lock` files (AUTH-5). On win32 the POSIX permission
//                   checks degrade with an explicit note (PLAT-2).
//   • CFG-9       — warns when the token/profiles path lies inside a cloud-synced
//                   directory (iCloud Drive, Dropbox, OneDrive, Google Drive).
//   • policy      — prints the resolved auth mode + two-axis policy matrix by REUSING
//                   core/policy's resolvePolicy; doctor never re-derives the matrix.
//   • network     — optional single connectivity GET (`--connect`, off by default)
//                   through the injected http callable; no ambient network access.
//
// Diagnostics are human-readable lines on STDOUT (docs/05 §8.9); the exit code is 0 when
// healthy and 1 when any check fails — warnings never flip the exit code. Secrets are
// never printed: presence is reported as `set (masked)` and, as defense in depth, every
// emitted line is scrubbed of the raw secret values present in the environment.
//
// Everything ambient is injected via DoctorDeps (env, fs, http, writers, clock, platform)
// so the whole subcommand is unit-testable with fakes; the integrator (T-130) composes
// the real adapters in index.ts. This module never reads process.env or touches the disk
// itself — `process.platform` is only the default for the injectable `platform` field.

import path from 'node:path';

import { parseConfig } from '../core/config.js';
import type { Config } from '../core/config.js';
import { XError } from '../core/errors.js';
import { resolvePolicy } from '../core/policy.js';
import type { Clock } from '../core/ports.js';

// --- Injection seam (dictated by the T-205 task card) -----------------------------------

/** What doctor needs to know about one filesystem entry. Produced by {@link DoctorFs.stat}. */
export interface DoctorStat {
  /** `other` covers symlinks, sockets, … — doctor treats non-regular token files as errors. */
  readonly kind: 'file' | 'directory' | 'other';
  /** POSIX permission bits (`mode & 0o777`); omit where meaningless (win32 ACLs, PLAT-2). */
  readonly mode?: number;
  /** Last-modification epoch ms — used to report the age of a leftover lock (AUTH-5). */
  readonly mtimeMs?: number;
}

/** Read-only filesystem access. Compose from `fs.promises` (`lstat` — never follow symlinks). */
export interface DoctorFs {
  /** Stat WITHOUT following a final symlink; resolves `null` when the path does not exist. */
  stat(p: string): Promise<DoctorStat | null>;
  /** Read a UTF-8 text file (the profiles file); rejects when unreadable. */
  readFile(p: string): Promise<string>;
}

/** Minimal HTTP seam for the optional connectivity probe: one GET, resolves the status. */
export type DoctorHttpGet = (url: string) => Promise<{ readonly status: number }>;

/** Line writer; the integrator appends the newline (`(l) => process.stdout.write(l + '\n')`). */
export type LineWriter = (line: string) => void;

/** Everything `doctor` touches, injected — no ambient env/fs/network/clock reads inside. */
export interface DoctorDeps {
  /** Environment snapshot (the integrator passes `process.env`). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fs: DoctorFs;
  /** Used only when `--connect` is passed; never called otherwise. */
  readonly http: DoctorHttpGet;
  readonly stdout: LineWriter;
  readonly stderr: LineWriter;
  readonly clock: Clock;
  /** Platform semantics for the permission checks; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

// --- Internals ---------------------------------------------------------------------------

/** Check severity. Only `fail` flips the exit code to 1; `warn`/`note` are advisory. */
type Level = 'ok' | 'note' | 'warn' | 'fail';

type Report = (level: Level, area: string, text: string) => void;

/**
 * Env vars whose values are secrets and must never appear in doctor output (T-205
 * masking rule). Client id is a public OAuth2 value and is deliberately not listed.
 */
const SECRET_VARS = ['X_MCP_CLIENT_SECRET', 'X_MCP_BEARER_TOKEN'] as const;

/**
 * Profiles-file keys whose values are secrets — the CFG-3 mirrors of {@link SECRET_VARS}.
 * `client_id` is public and deliberately absent, exactly as above.
 */
const SECRET_PROFILE_KEYS = ['client_secret', 'bearer_token'] as const;

/**
 * A scrubber that can learn further secrets after construction. The env-sourced values are
 * known before anything is printed, but profile-sourced credentials only exist once the
 * profiles file has been read, which is itself a reportable step — so the redactor is
 * mutable rather than a snapshot.
 */
interface Redactor {
  (line: string): string;
  /** Register another secret; `undefined`, blank and duplicate values are ignored. */
  add(value: unknown): void;
}

/**
 * Defense-in-depth scrubber: replaces every occurrence of a known secret in an output line
 * with `[redacted]`, longest value first (so overlapping secrets cannot leak a tail).
 */
function buildRedactor(env: Readonly<Record<string, string | undefined>>): Redactor {
  const secrets: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'string' || value.trim() === '' || secrets.includes(value)) return;
    secrets.push(value);
    secrets.sort((a, b) => b.length - a.length);
  };
  for (const key of SECRET_VARS) add(env[key]);
  const redact = ((line: string): string => {
    let out = line;
    for (const secret of secrets) out = out.split(secret).join('[redacted]');
    return out;
  }) as Redactor;
  redact.add = add;
  return redact;
}

/**
 * Teach the redactor every secret in an already-parsed profiles document (CFG-3/CFG-6).
 * Without this, a credential that lives only in the profiles file — the normal setup for
 * an operator juggling several accounts — would be masked nowhere, because the redactor's
 * other source is the environment.
 *
 * EVERY entry is harvested, not only the selected one: the document is already in memory,
 * and a validation failure or an unknown-key warning can quote any entry by name. The shape
 * is not validated here (that is `parseConfig`'s job) — this must keep working on a
 * malformed document, since that is precisely the case that produces quoting error text.
 */
function harvestProfileSecrets(json: unknown, redact: Redactor): void {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return;
  for (const entry of Object.values(json as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    for (const key of SECRET_PROFILE_KEYS) redact.add(record[key]);
  }
}

/** Known cloud-synced directory markers (CFG-9). Matched per path segment, case-insensitive. */
const SYNCED_SEGMENT_RULES: readonly { match: (segment: string) => boolean; provider: string }[] = [
  { match: (s) => s === 'dropbox', provider: 'Dropbox' },
  { match: (s) => s.startsWith('onedrive'), provider: 'OneDrive' },
  {
    match: (s) => s === 'google drive' || s.startsWith('googledrive') || s === 'my drive',
    provider: 'Google Drive',
  },
  // macOS iCloud Drive lives under `~/Library/Mobile Documents`.
  { match: (s) => s.startsWith('icloud') || s === 'mobile documents', provider: 'iCloud Drive' },
  // macOS mounts every third-party provider under `~/Library/CloudStorage/<Provider>-…`.
  { match: (s) => s === 'cloudstorage', provider: 'a cloud provider (macOS CloudStorage)' },
];

/**
 * The synced-storage provider a path lies under, or `null` for local disk (CFG-9). Rules
 * are tried in declaration order across ALL segments, so a specific provider (e.g. a
 * `GoogleDrive-…` mount under `~/Library/CloudStorage`) beats the generic macOS marker.
 */
function syncedStorageProvider(p: string): string | null {
  const segments = p.split(/[\\/]+/).map((s) => s.toLowerCase());
  for (const rule of SYNCED_SEGMENT_RULES) {
    if (segments.some((s) => rule.match(s))) return rule.provider;
  }
  return null;
}

/** `0600`-style octal rendering of the permission bits. */
function fmtMode(mode: number): string {
  return `0${(mode & 0o777).toString(8).padStart(3, '0')}`;
}

/** ` (mode 0600)` suffix on POSIX, empty where the bits are unavailable/meaningless. */
function modeSuffix(stat: DoctorStat, posix: boolean): string {
  return posix && stat.mode !== undefined ? ` (mode ${fmtMode(stat.mode)})` : '';
}

/** Human-readable message of an unknown thrown value (XError first — remediation text). */
function messageOf(err: unknown): string {
  if (XError.is(err)) return err.message;
  if (err instanceof Error) return err.message;
  return JSON.stringify(err);
}

/**
 * Validate the environment via core/config (never re-parse env by hand). When a profiles
 * file is configured, it is read through the injected fs and parseConfig runs a second
 * time with its parsed JSON so the CFG-6 content re-validation executes. Returns `null`
 * after reporting when the configuration is fatally broken (CFG-5).
 */
async function loadConfig(
  deps: DoctorDeps,
  report: Report,
  redact: Redactor,
): Promise<Config | null> {
  let config: Config;
  try {
    config = parseConfig(deps.env);
  } catch (err) {
    report('fail', 'config', messageOf(err));
    return null;
  }

  if (config.profile !== undefined) {
    const profilesPath = config.profile.file;
    let raw: string;
    try {
      raw = await deps.fs.readFile(profilesPath);
    } catch (err) {
      report('fail', 'profiles file', `cannot read ${profilesPath} — ${messageOf(err)}`);
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch (err) {
      report('fail', 'profiles file', `${profilesPath} is not valid JSON — ${messageOf(err)}`);
      return null;
    }
    // Learn the file's credentials BEFORE re-validating: the very next call can throw an
    // error that quotes an entry, and that line must already be maskable.
    harvestProfileSecrets(json, redact);
    try {
      config = parseConfig(deps.env, json); // CFG-6 — profile content re-validation
    } catch (err) {
      report('fail', 'config', messageOf(err));
      return null;
    }
  }

  report('ok', 'config', 'environment configuration is valid');
  for (const warning of config.warnings) report('warn', 'config', warning); // CFG-7/8
  return config;
}

/** One CFG-9 advisory for any secret-bearing path that lies under a synced root. */
function warnIfSynced(report: Report, area: string, p: string): void {
  const provider = syncedStorageProvider(p);
  if (provider !== null) {
    report(
      'warn',
      area,
      `CFG-9: ${p} lies inside a ${provider} synced directory — a sync conflict can ` +
        'resurrect a rotated-out refresh token and lock the account; keep this file on local disk',
    );
  }
}

/** Paths & permissions battery: token file/dir, lock leftovers, profiles file, media dir. */
async function checkPaths(deps: DoctorDeps, config: Config, report: Report): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const posix = platform !== 'win32';
  // Doctor inspects paths for the platform it was told about, not the host's path flavor.
  const dirnameOf = (p: string): string => (posix ? path.posix.dirname(p) : path.win32.dirname(p));

  if (!posix) {
    report(
      'note',
      'permissions',
      'PLAT-2: POSIX permission checks do not apply on Windows — inspect the token file ACLs manually',
    );
  }

  if (config.tokenKeychain) {
    report(
      'ok',
      'token store',
      'OS keychain backend (X_MCP_TOKEN_KEYCHAIN=1) — no file checks apply',
    );
  }

  if (config.tokenFile !== undefined) {
    const tokenFile = config.tokenFile;
    const tokenDir = dirnameOf(tokenFile);

    const dirStat = await deps.fs.stat(tokenDir);
    if (dirStat === null) {
      report(
        'warn',
        'token directory',
        `${tokenDir} does not exist yet — \`npx x-mcp-ai authorize\` will create it`,
      );
    } else if (dirStat.kind !== 'directory') {
      report('fail', 'token directory', `${tokenDir} is not a directory`);
    } else if (posix && dirStat.mode !== undefined && (dirStat.mode & 0o022) !== 0) {
      // SEC-T13 — a group/other-writable token dir is a symlink-plant/lock-race precondition.
      report(
        'fail',
        'token directory',
        `${tokenDir} is writable by group/other (mode ${fmtMode(dirStat.mode)}) — the server ` +
          `refuses to operate; run \`chmod 700 ${tokenDir}\` (SEC-T13)`,
      );
    } else {
      report('ok', 'token directory', `${tokenDir}${modeSuffix(dirStat, posix)}`);
    }

    const fileStat = await deps.fs.stat(tokenFile);
    if (fileStat === null) {
      report(
        'warn',
        'token file',
        `${tokenFile} not found — run \`npx x-mcp-ai authorize\` to mint tokens`,
      );
    } else if (fileStat.kind !== 'file') {
      report(
        'fail',
        'token file',
        `${tokenFile} is not a regular file — symlinks are never followed (SEC-T13)`,
      );
    } else if (posix && fileStat.mode !== undefined && (fileStat.mode & 0o077) !== 0) {
      // T1 — the token file itself warns (startup keeps running) at wider-than-0600 perms.
      report(
        'warn',
        'token file',
        `${tokenFile} is accessible by group/other (mode ${fmtMode(fileStat.mode)}) — run ` +
          `\`chmod 600 ${tokenFile}\``,
      );
    } else {
      report('ok', 'token file', `${tokenFile}${modeSuffix(fileStat, posix)}`);
    }

    // AUTH-5 — a leftover lock is noted (never removed): the server fails closed on it.
    const lockPath = `${tokenFile}.lock`;
    const lockStat = await deps.fs.stat(lockPath);
    if (lockStat !== null) {
      const age =
        lockStat.mtimeMs !== undefined
          ? ` (age ${Math.max(0, Math.round((deps.clock.now() - lockStat.mtimeMs) / 1000))} s)`
          : '';
      report(
        'warn',
        'token lock',
        `leftover lock file ${lockPath}${age} — a crashed process may have left it; the ` +
          'server fails closed on an ambiguous lock (AUTH-5); remove it only if no x-mcp-ai process is running',
      );
    }

    warnIfSynced(report, 'token file', tokenFile); // CFG-9
  }

  if (config.profile !== undefined) {
    const profilesPath = config.profile.file;
    const profStat = await deps.fs.stat(profilesPath);
    if (profStat === null) {
      report('fail', 'profiles file', `${profilesPath} not found`);
    } else if (profStat.kind !== 'file') {
      report('fail', 'profiles file', `${profilesPath} is not a regular file`);
    } else if (posix && profStat.mode !== undefined && (profStat.mode & 0o077) !== 0) {
      // CFG-6 — the profiles file is a secret; warn when readable by group/other.
      report(
        'warn',
        'profiles file',
        `${profilesPath} is accessible by group/other (mode ${fmtMode(profStat.mode)}) — it ` +
          `holds credentials; run \`chmod 600 ${profilesPath}\` (CFG-6)`,
      );
    } else {
      report('ok', 'profiles file', `${profilesPath}${modeSuffix(profStat, posix)}`);
    }
    warnIfSynced(report, 'profiles file', profilesPath); // CFG-9
  }

  if (config.mediaDir !== undefined) {
    const mediaStat = await deps.fs.stat(config.mediaDir);
    if (mediaStat === null) {
      report(
        'fail',
        'media dir',
        `X_MCP_MEDIA_DIR ${config.mediaDir} does not exist — media uploads will fail; ` +
          'create the directory or unset the variable',
      );
    } else if (mediaStat.kind !== 'directory') {
      report('fail', 'media dir', `${config.mediaDir} is not a directory`);
    } else {
      report('ok', 'media dir', config.mediaDir);
    }
  }
}

/** Credential presence for the summary block — values are NEVER printed, only masked state. */
function credentialsLine(config: Config): string {
  switch (config.authMode) {
    case 'oauth2': {
      const id = config.oauth2.clientId !== undefined ? 'set' : 'not set';
      const secret = config.oauth2.clientSecret !== undefined ? 'set (masked)' : 'not set';
      const store = config.tokenKeychain ? 'OS keychain' : (config.tokenFile ?? '(none)');
      return `OAuth 2.0 — client id ${id}, client secret ${secret}, token store ${store}`;
    }
    case 'app-only':
      return `app-only — bearer token ${config.bearerToken !== undefined ? 'set (masked)' : 'not set'}`;
  }
}

/**
 * Print the resolved auth mode and the two-axis policy matrix. The matrix comes from
 * core/policy's resolvePolicy — the exact resolution the registry enforces — so what
 * doctor prints can never drift from what the server does (deny > allow > preset, POL-2).
 */
function printResolved(config: Config, out: LineWriter): void {
  const resolved = resolvePolicy({
    preset: config.policy.preset,
    allow: config.policy.allow,
    deny: config.policy.deny,
  });
  const deniedFate = config.policy.hideDenied
    ? 'hidden from registration (X_MCP_HIDE_DENIED=1)'
    : 'registered but annotated as disabled';
  out('');
  out(`auth mode: ${config.authMode}`);
  out(`credentials: ${credentialsLine(config)}`);
  out(`base URL: ${config.baseUrl}`);
  out(`policy preset: ${config.policy.preset} (precedence: deny > allow > preset)`);
  out(
    `allowed cells — tools in these cells register and run: ${
      resolved.allowed.length > 0 ? resolved.allowed.join(', ') : '(none)'
    }`,
  );
  out(
    `denied cells — tools in these cells are ${deniedFate}: ${
      resolved.denied.length > 0 ? resolved.denied.join(', ') : '(none)'
    }`,
  );
}

/** The single opt-in connectivity GET (`--connect`) through the injected http callable. */
async function checkConnectivity(deps: DoctorDeps, config: Config, report: Report): Promise<void> {
  const url = new URL('/2/openapi.json', config.baseUrl).toString();
  const started = deps.clock.now();
  try {
    const res = await deps.http(url);
    // Any HTTP response proves DNS/TLS/HTTP reachability — auth is authorize's concern.
    report(
      'ok',
      'connectivity',
      `GET ${url} → HTTP ${res.status} (${deps.clock.now() - started} ms)`,
    );
  } catch (err) {
    report(
      'fail',
      'connectivity',
      `GET ${url} failed — ${messageOf(err)}; check DNS/TLS and network access ` +
        '(the server ignores proxy environment variables, CFG-7)',
    );
  }
}

// --- Entry point ---------------------------------------------------------------------------

const USAGE = 'usage: x-mcp-ai doctor [--connect]';

/**
 * Build the `doctor` subcommand from injected dependencies. The returned function takes
 * the argv rest (everything after `doctor`) and resolves the process exit code:
 * 0 = healthy (warnings allowed), 1 = at least one failing check or a usage error.
 */
export function createDoctorCli(deps: DoctorDeps): (rest: readonly string[]) => Promise<number> {
  return async (rest) => {
    const redact = buildRedactor(deps.env);
    const out: LineWriter = (line) => {
      deps.stdout(redact(line));
    };
    const err: LineWriter = (line) => {
      deps.stderr(redact(line));
    };

    let connect = false;
    for (const arg of rest) {
      if (arg === '--connect') {
        connect = true;
      } else {
        err(`x-mcp-ai doctor: unknown argument "${arg}"`);
        err(USAGE);
        return 1;
      }
    }

    let failures = 0;
    const report: Report = (level, area, text) => {
      if (level === 'fail') failures += 1;
      out(`${`[${level}]`.padEnd(7)}${area}: ${text}`);
    };

    out('x-mcp-ai doctor');
    out('');

    const config = await loadConfig(deps, report, redact);
    if (config === null) {
      // CFG-5 — invalid config is fatal for the server too; nothing else is meaningful.
      report('note', 'doctor', 'remaining checks skipped — fix the configuration first (CFG-5)');
      out('');
      out(`doctor: ${failures} problem${failures === 1 ? '' : 's'} found`);
      return 1;
    }

    await checkPaths(deps, config, report);

    if (connect) {
      await checkConnectivity(deps, config, report);
    } else {
      report('note', 'connectivity', 'skipped — pass --connect to probe the API with one GET');
    }

    printResolved(config, out);

    out('');
    out(
      failures === 0
        ? 'doctor: healthy'
        : `doctor: ${failures} problem${failures === 1 ? '' : 's'} found`,
    );
    return failures === 0 ? 0 : 1;
  };
}
