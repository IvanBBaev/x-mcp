// Configuration parsing — owned by T-110 (WP-1.2). Pure, dependency-light, no I/O.
//
// `parseConfig(env, profilesJson?)` is the single validator for the whole `X_MCP_*`
// surface. docs/02 §4 holds the canonical env-var table (a frozen Wave-0 contract); this
// module is its executable form. The composition root (`index.ts`, the `cli/`
// subcommands) reads `process.env` and — if used — the already-parsed profiles file, then
// calls this. It performs no file/network I/O itself: `os.homedir()` and `process.platform`
// are the only ambient reads, and only to expand `~` and resolve the default token path
// (both mandated by docs/02 §4).
//
// Fatal config is refused, never tolerated: on any invalid input a typed `validation`
// `XError` is thrown; the root turns its message into the single stderr line
// `x-mcp-ai: fatal: <reason>` and exits non-zero (CFG-5). Non-fatal issues (unknown vars,
// non-default base URL) are returned in `Config.warnings` for the root to log.
//
// Corner cases handled here: CFG-1 (`~` expansion), CFG-2 (default token path), CFG-3
// (profiles vs direct creds), CFG-4 (empty string = unset), CFG-5 (fatal contract), CFG-6
// (profiles content re-validation), CFG-7 (base-URL gating — the value rules; proxy-ignore
// is api/http's concern), CFG-8 (unknown `X_MCP_*` warnings). Full multi-profile resolution
// is a later task (T-309); profiles are parsed conservatively here.

import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { validationError } from './errors.js';
import {
  AVAILABILITY_CLASSES,
  POLICY_CELLS,
  type AvailabilityClass,
  type PolicyClass,
} from './tooldef.js';

// --- Value vocabularies (const-unions so zod can enumerate + the error lists them) ------

/** `X_MCP_AUTH_MODE` (docs/02 §4). */
export const AUTH_MODES = ['oauth2', 'oauth1', 'app-only'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * `X_MCP_POLICY` presets (docs/04 §3.1). Owned as data by `core/policy` (T-111); named
 * here only so `parseConfig` can validate the preset name and re-validate a profile's
 * policy (CFG-6) without importing a concurrently-built module.
 */
export const POLICY_PRESETS = ['read-only', 'engage', 'publish', 'manage', 'full'] as const;
export type PolicyPreset = (typeof POLICY_PRESETS)[number];

/** `X_MCP_BUDGET_MODE` (docs/02 §4, §7). */
export const BUDGET_MODES = ['warn', 'hard'] as const;
export type BudgetMode = (typeof BUDGET_MODES)[number];

/** `X_MCP_LOG_LEVEL` (docs/02 §4, §9). */
export const LOG_LEVELS = ['silent', 'error', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Default `X_MCP_BASE_URL` (docs/02 §4 — the canonical env table). */
export const DEFAULT_BASE_URL = 'https://api.x.com';

/** Default per-HTTP-request timeout in ms (docs/02 §4). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** The config directory is `x-mcp` on every platform — the npm name never leaks (CFG-2). */
const CONFIG_DIR = 'x-mcp';
const TOKEN_FILE_NAME = 'tokens.json';

/** Every `X_MCP_*` variable the server recognizes; anything else warns (CFG-8). */
const KNOWN_VARS: ReadonlySet<string> = new Set([
  'X_MCP_AUTH_MODE',
  'X_MCP_CLIENT_ID',
  'X_MCP_CLIENT_SECRET',
  'X_MCP_BEARER_TOKEN',
  'X_MCP_TOKEN_FILE',
  'X_MCP_TOKEN_KEYCHAIN',
  'X_MCP_API_KEY',
  'X_MCP_API_SECRET',
  'X_MCP_ACCESS_TOKEN',
  'X_MCP_ACCESS_SECRET',
  'X_MCP_POLICY',
  'X_MCP_POLICY_ALLOW',
  'X_MCP_POLICY_DENY',
  'X_MCP_HIDE_DENIED',
  'X_MCP_CREDIT_BUDGET',
  'X_MCP_BUDGET_MODE',
  'X_MCP_AVAILABILITY',
  'X_MCP_MEDIA_DIR',
  'X_MCP_PROFILES_FILE',
  'X_MCP_PROFILE',
  'X_MCP_BASE_URL',
  'X_MCP_ALLOW_INSECURE_BASE_URL',
  'X_MCP_TIMEOUT_MS',
  'X_MCP_LOG_LEVEL',
]);

// --- Public Config shape ---------------------------------------------------------------

/** OAuth 2.0 public/confidential client parameters (credentials arrive via `authorize`). */
export interface Oauth2Config {
  readonly clientId?: string;
  readonly clientSecret?: string;
}

/** OAuth 1.0a quadruple (Phase 3, only if kept — roadmap Q3). Present only when complete. */
export interface Oauth1Config {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly accessToken: string;
  readonly accessSecret: string;
}

/** Two-axis policy inputs (deny-wins resolution is `core/policy`'s job, T-111). */
export interface PolicyConfig {
  readonly preset: PolicyPreset;
  readonly allow: readonly PolicyClass[];
  readonly deny: readonly PolicyClass[];
  /** `X_MCP_HIDE_DENIED=1` → drop policy-denied tools from registration (POL-7). */
  readonly hideDenied: boolean;
}

/** Session credit budget (docs/02 §7). `creditUsd` omitted → no cap. */
export interface BudgetConfig {
  readonly mode: BudgetMode;
  readonly creditUsd?: number;
}

/** Active profile coordinates. Full resolution of its creds/policy is T-309's. */
export interface ProfileSelection {
  readonly file: string;
  readonly name: string;
}

/**
 * The validated, frozen configuration. Every field is derived from the canonical env-var
 * table (docs/02 §4); optional fields are omitted (never `undefined`) per
 * exactOptionalPropertyTypes.
 */
export interface Config {
  readonly authMode: AuthMode;
  readonly oauth2: Oauth2Config;
  readonly bearerToken?: string;
  readonly oauth1?: Oauth1Config;
  /** Resolved OAuth2 token-store path (default computed in oauth2 mode; CFG-1/CFG-2). */
  readonly tokenFile?: string;
  /** `X_MCP_TOKEN_KEYCHAIN=1` → OS keychain backend (Phase 3). */
  readonly tokenKeychain: boolean;
  readonly policy: PolicyConfig;
  readonly budget: BudgetConfig;
  /** Reachable account-gated surfaces (conservative default = none). */
  readonly availability: readonly AvailabilityClass[];
  /** Resolved media root (`~` expanded); absent → uploads default-deny (SEC-T9). */
  readonly mediaDir?: string;
  readonly profile?: ProfileSelection;
  readonly baseUrl: string;
  readonly allowInsecureBaseUrl: boolean;
  readonly timeoutMs: number;
  readonly logLevel: LogLevel;
  /** Non-fatal startup notices for the composition root to log (CFG-7, CFG-8). */
  readonly warnings: readonly string[];
}

// --- Small pure helpers ----------------------------------------------------------------

/** Empty/whitespace-only = unset (CFG-4); returns the raw value otherwise (secrets/paths). */
function norm(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim() === '' ? undefined : value;
}

/** Like {@link norm} but returns the trimmed value — for enums/numbers/lists/flags. */
function normTrim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  return t === '' ? undefined : t;
}

/** Split a comma-separated list, trimming and dropping empties. */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Expand a **leading** `~/` (or a bare `~`) to the home directory (CFG-1). A mid-string
 * `~` and `~user` forms are left untouched — MCP clients pass paths verbatim and Node
 * never expands `~` itself.
 */
function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Validated cells, deduped and order-preserving (zod has already checked membership). */
function toCells(value: string | undefined): PolicyClass[] {
  const valid = POLICY_CELLS as readonly string[];
  const out: PolicyClass[] = [];
  if (value === undefined) return out;
  for (const c of splitList(value)) {
    if (valid.includes(c) && !out.includes(c as PolicyClass)) out.push(c as PolicyClass);
  }
  return out;
}

/** Validated availability classes, deduped and order-preserving. */
function toAvailability(value: string | undefined): AvailabilityClass[] {
  const valid = AVAILABILITY_CLASSES as readonly string[];
  const out: AvailabilityClass[] = [];
  if (value === undefined) return out;
  for (const a of splitList(value)) {
    if (valid.includes(a) && !out.includes(a as AvailabilityClass))
      out.push(a as AvailabilityClass);
  }
  return out;
}

/**
 * Default OAuth2 token path when `X_MCP_TOKEN_FILE` is unset (CFG-2). No hardcoded `/`
 * joins — `node:path` keeps backslash paths and drive letters working (PLAT-3). Only
 * oauth2 mode has a rotating file store; other modes have no default file. Keychain mode
 * stores tokens elsewhere, so no file path is resolved.
 */
function resolveTokenFile(
  env: Record<string, string | undefined>,
  authMode: AuthMode,
  explicit: string | undefined,
  keychain: boolean,
): string | undefined {
  if (explicit !== undefined) return expandTilde(explicit);
  if (keychain || authMode !== 'oauth2') return undefined;
  if (process.platform === 'win32') {
    const appData = norm(env.APPDATA) ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, CONFIG_DIR, TOKEN_FILE_NAME);
  }
  const xdg = norm(env.XDG_CONFIG_HOME);
  const baseDir = xdg ?? path.join(os.homedir(), '.config');
  return path.join(baseDir, CONFIG_DIR, TOKEN_FILE_NAME);
}

/** CFG-7 value rules: `https://` required, non-`*.x.com` host needs the dev flag. */
function baseUrlIssue(baseUrl: string, allowInsecure: boolean): string | null {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return `X_MCP_BASE_URL must be a valid absolute URL (got "${baseUrl}")`;
  }
  if (u.protocol !== 'https:') return 'X_MCP_BASE_URL must use https://';
  const host = u.hostname.toLowerCase();
  const isXHost = host === 'x.com' || host.endsWith('.x.com');
  if (!isXHost && !allowInsecure) {
    return `X_MCP_BASE_URL host "${host}" is not *.x.com; set X_MCP_ALLOW_INSECURE_BASE_URL=1 to allow a non-x.com base URL`;
  }
  return null;
}

/** Recursively freeze the returned config so nothing downstream can mutate it. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Aggregate all zod issues into one legible reason, keyed by the real env-var name. */
function formatIssues(error: z.ZodError): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const issue of error.issues) {
    const where = issue.path.join('.') || 'config';
    const line = `${where}: ${issue.message}`;
    if (!seen.has(line)) {
      seen.add(line);
      parts.push(line);
    }
  }
  return parts.join('; ');
}

// --- Reusable field validators (zod) ---------------------------------------------------

/** `0` | `1` flag with a default; kept as a string, coerced to boolean in the transform. */
function flag() {
  return z.enum(['0', '1']);
}

/** Comma-separated policy cells; every entry must be a known cell (POL-6 lists them). */
function cellListField() {
  return z.string().refine(
    (v) => splitList(v).every((c) => KNOWN_CELL.has(c)),
    (v) => ({
      message: `invalid policy cell(s): ${splitList(v)
        .filter((c) => !KNOWN_CELL.has(c))
        .join(', ')}; valid cells: ${POLICY_CELLS.join(', ')}`,
    }),
  );
}

/** Comma-separated availability classes; every entry must be a known class. */
function availabilityField() {
  return z.string().refine(
    (v) => splitList(v).every((a) => KNOWN_AVAILABILITY.has(a)),
    (v) => ({
      message: `invalid availability class(es): ${splitList(v)
        .filter((a) => !KNOWN_AVAILABILITY.has(a))
        .join(', ')}; valid classes: ${AVAILABILITY_CLASSES.join(', ')}`,
    }),
  );
}

/** Positive USD decimal for `X_MCP_CREDIT_BUDGET`. */
function usdAmountField() {
  return z.string().refine(
    (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0;
    },
    () => ({ message: 'X_MCP_CREDIT_BUDGET must be a positive USD amount' }),
  );
}

/** Positive integer milliseconds for `X_MCP_TIMEOUT_MS`. */
function timeoutField() {
  return z.string().refine(
    (v) => /^\d+$/.test(v) && Number(v) > 0,
    () => ({
      message: 'X_MCP_TIMEOUT_MS must be a positive integer number of milliseconds',
    }),
  );
}

const KNOWN_CELL: ReadonlySet<string> = new Set(POLICY_CELLS);
const KNOWN_AVAILABILITY: ReadonlySet<string> = new Set(AVAILABILITY_CLASSES);

// --- The env schema (keyed by real var names so error paths are operator-facing) -------

const EnvObject = z.object({
  X_MCP_AUTH_MODE: z.enum(AUTH_MODES).default('oauth2'),
  X_MCP_CLIENT_ID: z.string().optional(),
  X_MCP_CLIENT_SECRET: z.string().optional(),
  X_MCP_BEARER_TOKEN: z.string().optional(),
  X_MCP_TOKEN_FILE: z.string().optional(),
  X_MCP_TOKEN_KEYCHAIN: flag().default('0'),
  X_MCP_API_KEY: z.string().optional(),
  X_MCP_API_SECRET: z.string().optional(),
  X_MCP_ACCESS_TOKEN: z.string().optional(),
  X_MCP_ACCESS_SECRET: z.string().optional(),
  X_MCP_POLICY: z.enum(POLICY_PRESETS).default('read-only'),
  X_MCP_POLICY_ALLOW: cellListField().optional(),
  X_MCP_POLICY_DENY: cellListField().optional(),
  X_MCP_HIDE_DENIED: flag().default('0'),
  X_MCP_CREDIT_BUDGET: usdAmountField().optional(),
  X_MCP_BUDGET_MODE: z.enum(BUDGET_MODES).default('warn'),
  X_MCP_AVAILABILITY: availabilityField().optional(),
  X_MCP_MEDIA_DIR: z.string().optional(),
  X_MCP_PROFILES_FILE: z.string().optional(),
  X_MCP_PROFILE: z.string().optional(),
  X_MCP_BASE_URL: z.string().default(DEFAULT_BASE_URL),
  X_MCP_ALLOW_INSECURE_BASE_URL: flag().default('0'),
  X_MCP_TIMEOUT_MS: timeoutField().default(String(DEFAULT_TIMEOUT_MS)),
  X_MCP_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

const EnvSchema = EnvObject.superRefine((d, ctx) => {
  const has = (v: string | undefined): v is string => v !== undefined;
  const add = (p: string, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [p], message });
  };

  const oauth1Vars = [
    d.X_MCP_API_KEY,
    d.X_MCP_API_SECRET,
    d.X_MCP_ACCESS_TOKEN,
    d.X_MCP_ACCESS_SECRET,
  ];
  const oauth1Any = oauth1Vars.some(has);
  const oauth1All = oauth1Vars.every(has);
  const directCred =
    has(d.X_MCP_BEARER_TOKEN) || has(d.X_MCP_CLIENT_ID) || has(d.X_MCP_CLIENT_SECRET) || oauth1Any;

  // CFG-3 — profiles file vs profile selection vs direct credentials.
  if (has(d.X_MCP_PROFILES_FILE)) {
    if (!has(d.X_MCP_PROFILE)) {
      add('X_MCP_PROFILE', 'X_MCP_PROFILE is required when X_MCP_PROFILES_FILE is set');
    }
    if (directCred) {
      add(
        'X_MCP_PROFILES_FILE',
        'X_MCP_PROFILES_FILE is set together with direct credentials (X_MCP_BEARER_TOKEN / X_MCP_CLIENT_ID / X_MCP_CLIENT_SECRET / OAuth 1.0a) — choose one credential source, not both',
      );
    }
  }

  // Keychain and an explicit token file are mutually exclusive (docs/02 §4).
  if (d.X_MCP_TOKEN_KEYCHAIN === '1' && has(d.X_MCP_TOKEN_FILE)) {
    add(
      'X_MCP_TOKEN_KEYCHAIN',
      'X_MCP_TOKEN_KEYCHAIN=1 is mutually exclusive with an explicit X_MCP_TOKEN_FILE',
    );
  }

  // Mode/credential conflicts only apply to the direct (non-profile) path.
  if (!has(d.X_MCP_PROFILES_FILE)) {
    const mode = d.X_MCP_AUTH_MODE;
    if (has(d.X_MCP_BEARER_TOKEN) && mode !== 'app-only') {
      add('X_MCP_BEARER_TOKEN', 'X_MCP_BEARER_TOKEN is only valid when X_MCP_AUTH_MODE=app-only');
    }
    if ((has(d.X_MCP_CLIENT_ID) || has(d.X_MCP_CLIENT_SECRET)) && mode !== 'oauth2') {
      add(
        'X_MCP_CLIENT_ID',
        'X_MCP_CLIENT_ID / X_MCP_CLIENT_SECRET require X_MCP_AUTH_MODE=oauth2',
      );
    }
    if (oauth1Any && mode !== 'oauth1') {
      add('X_MCP_API_KEY', 'OAuth 1.0a credentials require X_MCP_AUTH_MODE=oauth1');
    }
    if (oauth1Any && !oauth1All) {
      add(
        'X_MCP_API_KEY',
        'incomplete OAuth 1.0a credentials: X_MCP_API_KEY, X_MCP_API_SECRET, X_MCP_ACCESS_TOKEN and X_MCP_ACCESS_SECRET are all required together',
      );
    }
    if (mode === 'app-only' && !has(d.X_MCP_BEARER_TOKEN)) {
      add('X_MCP_BEARER_TOKEN', 'X_MCP_AUTH_MODE=app-only requires X_MCP_BEARER_TOKEN');
    }
  }

  // CFG-7 — base-URL value rules (proxy-ignore is enforced later, in api/http).
  const issue = baseUrlIssue(d.X_MCP_BASE_URL, d.X_MCP_ALLOW_INSECURE_BASE_URL === '1');
  if (issue) add('X_MCP_BASE_URL', issue);
});

// --- Conservative profiles-content validation (CFG-6) ----------------------------------

const ProfileEntrySchema = z
  .object({
    auth_mode: z.enum(AUTH_MODES).optional(),
    policy: z.string().optional(),
  })
  .passthrough();

const ProfilesFileSchema = z.record(z.string(), ProfileEntrySchema);

/**
 * Validate the (already-read) profiles JSON conservatively (CFG-6): it must be a map of
 * named entries, the selected profile must exist, and its `policy` — if present — is
 * re-validated exactly like an env-provided policy (a preset name or a cell list). Full
 * per-profile credential resolution is deferred to T-309.
 */
function validateProfilesContent(profilesJson: unknown, name: string): void {
  const parsed = ProfilesFileSchema.safeParse(profilesJson);
  if (!parsed.success) {
    throw validationError(`invalid profiles file — ${formatIssues(parsed.error)}`);
  }
  const entry = parsed.data[name];
  if (entry === undefined) {
    const names = Object.keys(parsed.data);
    throw validationError(
      `profile "${name}" not found in profiles file; available profiles: ${
        names.length > 0 ? names.join(', ') : '(none)'
      }`,
    );
  }
  if (entry.policy !== undefined) {
    const raw = entry.policy.trim();
    const isPreset = (POLICY_PRESETS as readonly string[]).includes(raw);
    if (!isPreset) {
      const invalid = splitList(raw).filter((c) => !KNOWN_CELL.has(c));
      if (raw === '' || invalid.length > 0) {
        throw validationError(
          `profile "${name}" has an invalid policy ("${entry.policy}"); valid presets: ${POLICY_PRESETS.join(
            ', ',
          )}; valid cells: ${POLICY_CELLS.join(', ')}`,
        );
      }
    }
  }
}

// --- Entry point -----------------------------------------------------------------------

/**
 * Validate the environment (and, optionally, an already-parsed profiles file) and return a
 * typed, frozen {@link Config}. Throws a `validation` {@link XError} on any fatal problem
 * (CFG-5); collects non-fatal notices in `Config.warnings`. Pure: no file/network I/O.
 *
 * @param env          A snapshot of the environment (the root passes `process.env`).
 * @param profilesJson The parsed contents of `X_MCP_PROFILES_FILE`, if the root read it.
 */
export function parseConfig(
  env: Record<string, string | undefined>,
  profilesJson?: unknown,
): Config {
  const raw = {
    X_MCP_AUTH_MODE: normTrim(env.X_MCP_AUTH_MODE),
    X_MCP_CLIENT_ID: norm(env.X_MCP_CLIENT_ID),
    X_MCP_CLIENT_SECRET: norm(env.X_MCP_CLIENT_SECRET),
    X_MCP_BEARER_TOKEN: norm(env.X_MCP_BEARER_TOKEN),
    X_MCP_TOKEN_FILE: norm(env.X_MCP_TOKEN_FILE),
    X_MCP_TOKEN_KEYCHAIN: normTrim(env.X_MCP_TOKEN_KEYCHAIN),
    X_MCP_API_KEY: norm(env.X_MCP_API_KEY),
    X_MCP_API_SECRET: norm(env.X_MCP_API_SECRET),
    X_MCP_ACCESS_TOKEN: norm(env.X_MCP_ACCESS_TOKEN),
    X_MCP_ACCESS_SECRET: norm(env.X_MCP_ACCESS_SECRET),
    X_MCP_POLICY: normTrim(env.X_MCP_POLICY),
    X_MCP_POLICY_ALLOW: normTrim(env.X_MCP_POLICY_ALLOW),
    X_MCP_POLICY_DENY: normTrim(env.X_MCP_POLICY_DENY),
    X_MCP_HIDE_DENIED: normTrim(env.X_MCP_HIDE_DENIED),
    X_MCP_CREDIT_BUDGET: normTrim(env.X_MCP_CREDIT_BUDGET),
    X_MCP_BUDGET_MODE: normTrim(env.X_MCP_BUDGET_MODE),
    X_MCP_AVAILABILITY: normTrim(env.X_MCP_AVAILABILITY),
    X_MCP_MEDIA_DIR: norm(env.X_MCP_MEDIA_DIR),
    X_MCP_PROFILES_FILE: norm(env.X_MCP_PROFILES_FILE),
    X_MCP_PROFILE: normTrim(env.X_MCP_PROFILE),
    X_MCP_BASE_URL: normTrim(env.X_MCP_BASE_URL),
    X_MCP_ALLOW_INSECURE_BASE_URL: normTrim(env.X_MCP_ALLOW_INSECURE_BASE_URL),
    X_MCP_TIMEOUT_MS: normTrim(env.X_MCP_TIMEOUT_MS),
    X_MCP_LOG_LEVEL: normTrim(env.X_MCP_LOG_LEVEL),
  };

  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    // CFG-5 — one legible reason; the root prefixes `x-mcp-ai: fatal:`.
    throw validationError(`invalid configuration — ${formatIssues(parsed.error)}`);
  }
  const d = parsed.data;

  // CFG-6 — re-validate the selected profile's content when the root supplied the file.
  const profileName = d.X_MCP_PROFILE;
  if (
    d.X_MCP_PROFILES_FILE !== undefined &&
    profileName !== undefined &&
    profilesJson !== undefined
  ) {
    validateProfilesContent(profilesJson, profileName);
  }

  // --- Derive the typed config -----------------------------------------------------
  const authMode = d.X_MCP_AUTH_MODE;
  const tokenKeychain = d.X_MCP_TOKEN_KEYCHAIN === '1';
  const hideDenied = d.X_MCP_HIDE_DENIED === '1';
  const allowInsecureBaseUrl = d.X_MCP_ALLOW_INSECURE_BASE_URL === '1';
  const baseUrl = d.X_MCP_BASE_URL;
  const timeoutMs = Number(d.X_MCP_TIMEOUT_MS);

  const oauth2: Oauth2Config = {
    ...(d.X_MCP_CLIENT_ID !== undefined ? { clientId: d.X_MCP_CLIENT_ID } : {}),
    ...(d.X_MCP_CLIENT_SECRET !== undefined ? { clientSecret: d.X_MCP_CLIENT_SECRET } : {}),
  };

  const oauth1: Oauth1Config | undefined =
    d.X_MCP_API_KEY !== undefined &&
    d.X_MCP_API_SECRET !== undefined &&
    d.X_MCP_ACCESS_TOKEN !== undefined &&
    d.X_MCP_ACCESS_SECRET !== undefined
      ? {
          apiKey: d.X_MCP_API_KEY,
          apiSecret: d.X_MCP_API_SECRET,
          accessToken: d.X_MCP_ACCESS_TOKEN,
          accessSecret: d.X_MCP_ACCESS_SECRET,
        }
      : undefined;

  const policy: PolicyConfig = {
    preset: d.X_MCP_POLICY,
    allow: toCells(d.X_MCP_POLICY_ALLOW),
    deny: toCells(d.X_MCP_POLICY_DENY),
    hideDenied,
  };

  const budget: BudgetConfig = {
    mode: d.X_MCP_BUDGET_MODE,
    ...(d.X_MCP_CREDIT_BUDGET !== undefined ? { creditUsd: Number(d.X_MCP_CREDIT_BUDGET) } : {}),
  };

  const tokenFile = resolveTokenFile(env, authMode, d.X_MCP_TOKEN_FILE, tokenKeychain);
  const mediaDir = d.X_MCP_MEDIA_DIR !== undefined ? expandTilde(d.X_MCP_MEDIA_DIR) : undefined;
  const profile: ProfileSelection | undefined =
    d.X_MCP_PROFILES_FILE !== undefined && profileName !== undefined
      ? { file: expandTilde(d.X_MCP_PROFILES_FILE), name: profileName }
      : undefined;

  // --- Non-fatal warnings ----------------------------------------------------------
  const warnings: string[] = [];

  // CFG-8 — unknown X_MCP_* vars (typo detection); never a refusal.
  for (const key of Object.keys(env)) {
    if (key.startsWith('X_MCP_') && !KNOWN_VARS.has(key) && norm(env[key]) !== undefined) {
      warnings.push(`Unknown environment variable ${key} (ignored — possible typo)`);
    }
  }
  // A profile named without a profiles file is ignored (likely a leftover/typo).
  if (profileName !== undefined && d.X_MCP_PROFILES_FILE === undefined) {
    warnings.push('X_MCP_PROFILE is set but X_MCP_PROFILES_FILE is not — the selection is ignored');
  }
  // CFG-7 — a non-default base URL is loud (banner + auth_status upstream).
  if (baseUrl !== DEFAULT_BASE_URL) {
    warnings.push(`Using non-default X API base URL: ${baseUrl}`);
  }
  if (allowInsecureBaseUrl) {
    warnings.push('X_MCP_ALLOW_INSECURE_BASE_URL is enabled — a non-x.com base URL is permitted');
  }

  const config: Config = {
    authMode,
    oauth2,
    ...(d.X_MCP_BEARER_TOKEN !== undefined ? { bearerToken: d.X_MCP_BEARER_TOKEN } : {}),
    ...(oauth1 !== undefined ? { oauth1 } : {}),
    ...(tokenFile !== undefined ? { tokenFile } : {}),
    tokenKeychain,
    policy,
    budget,
    availability: toAvailability(d.X_MCP_AVAILABILITY),
    ...(mediaDir !== undefined ? { mediaDir } : {}),
    ...(profile !== undefined ? { profile } : {}),
    baseUrl,
    allowInsecureBaseUrl,
    timeoutMs,
    logLevel: d.X_MCP_LOG_LEVEL,
    warnings,
  };

  return deepFreeze(config);
}
