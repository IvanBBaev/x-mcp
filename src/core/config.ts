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
// (profiles content re-validation AND resolution of the selected profile), CFG-7 (base-URL
// gating — the value rules; proxy-ignore is api/http's concern), CFG-8 (unknown `X_MCP_*`
// warnings). The *permission* half of CFG-6 (warn when the profiles file is group/other
// readable) belongs to the composition root — `core` does no I/O.
//
// Auth modes are `oauth2` and `app-only` — nothing else. OAuth 1.0a was resolved NO-GO
// (`docs/decisions/0001-oauth1-go-no-go.md`, T-307): the signer was never built, so T-309
// removed the `oauth1` mode value and the `X_MCP_API_KEY`/`X_MCP_API_SECRET`/
// `X_MCP_ACCESS_TOKEN`/`X_MCP_ACCESS_SECRET` quadruple from this surface entirely.
// `X_MCP_AUTH_MODE=oauth1` is now a plain unknown-value startup error.

import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { CREDENTIAL_DOMAIN, isCredentialEgressHost } from './egress.js';
import { validationError } from './errors.js';
import {
  AVAILABILITY_CLASSES,
  POLICY_CELLS,
  type AvailabilityClass,
  type PolicyClass,
} from './tooldef.js';

// --- Value vocabularies (const-unions so zod can enumerate + the error lists them) ------

/**
 * `X_MCP_AUTH_MODE` (docs/02 §4). Two modes only — OAuth 2.0 PKCE user context and the
 * app-only bearer; `oauth1` was dropped by decision 0001 and is now an invalid value.
 */
export const AUTH_MODES = ['oauth2', 'app-only'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/** Applied when `X_MCP_AUTH_MODE` is unset/empty (CFG-4) and no profile names a mode. */
const DEFAULT_AUTH_MODE: AuthMode = 'oauth2';

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

/**
 * Coordinates of the active profile (CFG-3). The profile's own credentials, token file and
 * policy are resolved *into* the corresponding `Config` fields (`authMode`, `oauth2`,
 * `bearerToken`, `tokenFile`, `policy`) — consumers never re-read the profiles file.
 */
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
  if (!isCredentialEgressHost(u) && !allowInsecure) {
    return `X_MCP_BASE_URL host "${u.hostname.toLowerCase()}" is not *.${CREDENTIAL_DOMAIN}; set X_MCP_ALLOW_INSECURE_BASE_URL=1 to allow a non-x.com base URL`;
  }
  return null;
}

/**
 * The credential half of CFG-7 (docs/04 T10). `X_MCP_ALLOW_INSECURE_BASE_URL` relaxes where
 * requests go — never where credentials go. An access token is withheld at request time by
 * api/http, but an OAuth2 session cannot be made safe that way: its token endpoint is
 * derived from the base URL, so refreshing would post the refresh token — and `authorize`
 * would post the code plus the PKCE verifier — to whatever host was configured. There is no
 * degraded mode to fall back to, so this combination is refused outright.
 */
function credentialEgressIssue(baseUrl: string, authMode: AuthMode): string | null {
  if (authMode !== 'oauth2') return null;
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return null; // Already reported by baseUrlIssue.
  }
  if (isCredentialEgressHost(u)) return null;
  return (
    `X_MCP_AUTH_MODE=oauth2 refuses a non-*.${CREDENTIAL_DOMAIN} base URL: the OAuth2 token endpoint is derived ` +
    `from X_MCP_BASE_URL, so the refresh token would be sent to "${u.hostname.toLowerCase()}". ` +
    'X_MCP_ALLOW_INSECURE_BASE_URL relaxes where requests go, never where credentials go — ' +
    'point a mock at app-only mode (it starts, and sends no credential) or restore an x.com base URL.'
  );
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

/**
 * Enum whose rejection diagnostic echoes the received value alongside the accepted ones
 * (zod v4 dropped the `received` clause from its stock message; the operator needs it to
 * spot a typo in the env var, so it is restored here).
 */
function enumField<const T extends readonly string[]>(values: T) {
  return z.enum(values, {
    error: (issue) =>
      `Invalid option: expected one of ${values
        .map((v) => `"${v}"`)
        .join('|')}, received "${String(issue.input)}"`,
  });
}

/** `0` | `1` flag with a default; kept as a string, coerced to boolean in the transform. */
function flag() {
  return enumField(['0', '1']);
}

/** Comma-separated policy cells; every entry must be a known cell (POL-6 lists them). */
function cellListField() {
  return z.string().refine((v) => splitList(v).every((c) => KNOWN_CELL.has(c)), {
    error: (issue) =>
      `invalid policy cell(s): ${splitList(String(issue.input))
        .filter((c) => !KNOWN_CELL.has(c))
        .join(', ')}; valid cells: ${POLICY_CELLS.join(', ')}`,
  });
}

/** Comma-separated availability classes; every entry must be a known class. */
function availabilityField() {
  return z.string().refine((v) => splitList(v).every((a) => KNOWN_AVAILABILITY.has(a)), {
    error: (issue) =>
      `invalid availability class(es): ${splitList(String(issue.input))
        .filter((a) => !KNOWN_AVAILABILITY.has(a))
        .join(', ')}; valid classes: ${AVAILABILITY_CLASSES.join(', ')}`,
  });
}

/** Positive USD decimal for `X_MCP_CREDIT_BUDGET`. */
function usdAmountField() {
  return z.string().refine(
    (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0;
    },
    { error: 'X_MCP_CREDIT_BUDGET must be a positive USD amount' },
  );
}

/** Positive integer milliseconds for `X_MCP_TIMEOUT_MS`. */
function timeoutField() {
  return z.string().refine((v) => /^\d+$/.test(v) && Number(v) > 0, {
    error: 'X_MCP_TIMEOUT_MS must be a positive integer number of milliseconds',
  });
}

const KNOWN_CELL: ReadonlySet<string> = new Set(POLICY_CELLS);
const KNOWN_AVAILABILITY: ReadonlySet<string> = new Set(AVAILABILITY_CLASSES);

// --- The env schema (keyed by real var names so error paths are operator-facing) -------

const EnvObject = z.object({
  X_MCP_AUTH_MODE: enumField(AUTH_MODES).default(DEFAULT_AUTH_MODE),
  X_MCP_CLIENT_ID: z.string().optional(),
  X_MCP_CLIENT_SECRET: z.string().optional(),
  X_MCP_BEARER_TOKEN: z.string().optional(),
  X_MCP_TOKEN_FILE: z.string().optional(),
  X_MCP_TOKEN_KEYCHAIN: flag().default('0'),
  X_MCP_POLICY: enumField(POLICY_PRESETS).default('read-only'),
  X_MCP_POLICY_ALLOW: cellListField().optional(),
  X_MCP_POLICY_DENY: cellListField().optional(),
  X_MCP_HIDE_DENIED: flag().default('0'),
  X_MCP_CREDIT_BUDGET: usdAmountField().optional(),
  X_MCP_BUDGET_MODE: enumField(BUDGET_MODES).default('warn'),
  X_MCP_AVAILABILITY: availabilityField().optional(),
  X_MCP_MEDIA_DIR: z.string().optional(),
  X_MCP_PROFILES_FILE: z.string().optional(),
  X_MCP_PROFILE: z.string().optional(),
  X_MCP_BASE_URL: z.string().default(DEFAULT_BASE_URL),
  X_MCP_ALLOW_INSECURE_BASE_URL: flag().default('0'),
  X_MCP_TIMEOUT_MS: timeoutField().default(String(DEFAULT_TIMEOUT_MS)),
  X_MCP_LOG_LEVEL: enumField(LOG_LEVELS).default('info'),
});

const EnvSchema = EnvObject.superRefine((d, ctx) => {
  const has = (v: string | undefined): v is string => v !== undefined;
  const add = (p: string, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [p], message });
  };

  const directCred =
    has(d.X_MCP_BEARER_TOKEN) || has(d.X_MCP_CLIENT_ID) || has(d.X_MCP_CLIENT_SECRET);

  // CFG-3 — profiles file vs profile selection vs direct credentials. There is NO
  // precedence between the two credential sources: the ambiguity is refused outright, so
  // the selected profile is the process's single source of credentials.
  if (has(d.X_MCP_PROFILES_FILE)) {
    if (!has(d.X_MCP_PROFILE)) {
      add('X_MCP_PROFILE', 'X_MCP_PROFILE is required when X_MCP_PROFILES_FILE is set');
    }
    if (directCred) {
      add(
        'X_MCP_PROFILES_FILE',
        'X_MCP_PROFILES_FILE is set together with direct credentials (X_MCP_BEARER_TOKEN / X_MCP_CLIENT_ID / X_MCP_CLIENT_SECRET) — choose one credential source, not both',
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
    if (mode === 'app-only' && !has(d.X_MCP_BEARER_TOKEN)) {
      add('X_MCP_BEARER_TOKEN', 'X_MCP_AUTH_MODE=app-only requires X_MCP_BEARER_TOKEN');
    }
  }

  // CFG-7 — base-URL value rules (proxy-ignore is enforced later, in api/http).
  const issue = baseUrlIssue(d.X_MCP_BASE_URL, d.X_MCP_ALLOW_INSECURE_BASE_URL === '1');
  if (issue) add('X_MCP_BASE_URL', issue);
});

// --- Profiles file: validation + resolution (CFG-3, CFG-6) -----------------------------

/**
 * One named entry of the profiles file. docs/02 §4: the file maps
 * `name → {auth mode, credentials or token file, policy}`. Keys mirror the env-var names
 * (lower-snake, minus the `X_MCP_` prefix) so a working env setup moves into a profile
 * verbatim. Unknown keys warn like an unknown env var (CFG-8) — they never refuse.
 */
const ProfileEntrySchema = z
  .object({
    auth_mode: enumField(AUTH_MODES).optional(),
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
    bearer_token: z.string().optional(),
    token_file: z.string().optional(),
    policy: z.string().optional(),
  })
  .passthrough();

/** The keys {@link ProfileEntrySchema} knows; everything else is a typo warning (CFG-8). */
const PROFILE_KEYS: ReadonlySet<string> = new Set([
  'auth_mode',
  'client_id',
  'client_secret',
  'bearer_token',
  'token_file',
  'policy',
]);

/**
 * The file itself: a map of named object entries. Only the *selected* entry is validated in
 * depth — an unrelated profile's typo must not stop this process from starting.
 */
const ProfilesFileSchema = z.record(z.string(), z.object({}).passthrough());

/** Env-side facts the profile resolution needs; `undefined` = the operator did not set it. */
interface EnvSelection {
  /** `X_MCP_AUTH_MODE` as *explicitly* set (not the schema default). */
  readonly authMode?: AuthMode;
  readonly tokenFile?: string;
  readonly keychain: boolean;
  /** `X_MCP_POLICY` as *explicitly* set (not the schema default). */
  readonly policy?: PolicyPreset;
  readonly policyAllow?: string;
}

/**
 * The parts of a {@link Config} the selected profile supplies. Credential fields may hold
 * plaintext secrets (SEC-T16) — they flow into `Config` and are never echoed in warnings or
 * error messages, which name keys only.
 */
interface ProfileResolution {
  readonly authMode?: AuthMode;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly bearerToken?: string;
  readonly tokenFile?: string;
  readonly policyPreset?: PolicyPreset;
  readonly policyAllow?: readonly PolicyClass[];
  readonly warnings: readonly string[];
}

/** CFG-4 parity inside the profiles file: an empty/whitespace string value means unset. */
function dropEmptyValues(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}

/**
 * Validate the (already-read) profiles JSON and resolve the selected profile (CFG-3/CFG-6).
 *
 * Precedence, deliberately different per field class:
 *  - **credentials** — no precedence at all: direct credential env vars alongside a
 *    profiles file are already refused by the CFG-3 rule above, so the profile is the only
 *    source and nothing can be overridden silently;
 *  - **auth mode** — profile-supplied, but a *conflicting* explicit `X_MCP_AUTH_MODE`
 *    is fatal: an env mode pointing away from the profile's credentials is exactly the
 *    ambiguity CFG-3 refuses;
 *  - **token file / policy** — an explicit env var wins over the profile value and the
 *    override is warned about (never silent). Env is the per-server-entry operator input;
 *    the profiles file may be shared and is the tamper surface of SEC-T16, so it must not
 *    quietly replace a policy the operator pinned in the client config. `X_MCP_POLICY_DENY`
 *    is untouched by profiles — deny always wins (POL-2).
 */
function resolveProfile(profilesJson: unknown, name: string, env: EnvSelection): ProfileResolution {
  const file = ProfilesFileSchema.safeParse(profilesJson);
  if (!file.success) {
    throw validationError(`invalid profiles file — ${formatIssues(file.error)}`);
  }
  const rawEntry = file.data[name];
  if (rawEntry === undefined) {
    const names = Object.keys(file.data);
    throw validationError(
      `profile "${name}" not found in profiles file; available profiles: ${
        names.length > 0 ? names.join(', ') : '(none)'
      }`,
    );
  }

  const parsed = ProfileEntrySchema.safeParse(dropEmptyValues(rawEntry));
  if (!parsed.success) {
    throw validationError(`profile "${name}" is invalid — ${formatIssues(parsed.error)}`);
  }
  const entry = parsed.data;
  const warnings: string[] = [];

  // CFG-8's typo rule, applied inside the file: an unknown key is ignored, never fatal.
  for (const key of Object.keys(rawEntry)) {
    if (!PROFILE_KEYS.has(key)) {
      warnings.push(`Unknown key "${key}" in profile "${name}" (ignored — possible typo)`);
    }
  }

  // --- Auth mode: the profile decides; a conflicting explicit env mode is fatal (CFG-3).
  if (
    entry.auth_mode !== undefined &&
    env.authMode !== undefined &&
    entry.auth_mode !== env.authMode
  ) {
    throw validationError(
      `X_MCP_AUTH_MODE=${env.authMode} conflicts with auth_mode "${entry.auth_mode}" of profile "${name}" — set one, not both`,
    );
  }
  const authMode: AuthMode = entry.auth_mode ?? env.authMode ?? DEFAULT_AUTH_MODE;

  // --- Credentials must match the mode, exactly as the direct (non-profile) path demands.
  if (entry.bearer_token !== undefined && authMode !== 'app-only') {
    throw validationError(
      `profile "${name}": bearer_token requires auth_mode app-only (this profile resolves to ${authMode})`,
    );
  }
  if (
    (entry.client_id !== undefined || entry.client_secret !== undefined) &&
    authMode !== 'oauth2'
  ) {
    throw validationError(
      `profile "${name}": client_id / client_secret require auth_mode oauth2 (this profile resolves to ${authMode})`,
    );
  }
  if (authMode === 'app-only' && entry.bearer_token === undefined) {
    throw validationError(`profile "${name}": auth_mode app-only requires bearer_token`);
  }
  if (entry.token_file !== undefined && env.keychain) {
    throw validationError(
      `profile "${name}": token_file is mutually exclusive with X_MCP_TOKEN_KEYCHAIN=1`,
    );
  }

  // --- Token file: an explicit env path wins, loudly.
  let tokenFile = entry.token_file;
  if (tokenFile !== undefined && env.tokenFile !== undefined) {
    warnings.push(`X_MCP_TOKEN_FILE overrides the token_file of profile "${name}"`);
    tokenFile = undefined;
  }

  // --- Policy: re-validated exactly like an env-provided policy (CFG-6/SEC-T16). A preset
  // name sets the preset; a cell list behaves like X_MCP_POLICY_ALLOW (additive over the
  // preset, still subject to deny).
  let policyPreset: PolicyPreset | undefined;
  let policyAllow: PolicyClass[] | undefined;
  if (entry.policy !== undefined) {
    const value = entry.policy.trim();
    if ((POLICY_PRESETS as readonly string[]).includes(value)) {
      policyPreset = value as PolicyPreset;
    } else {
      const cells = splitList(value);
      const invalid = cells.filter((c) => !KNOWN_CELL.has(c));
      if (cells.length === 0 || invalid.length > 0) {
        throw validationError(
          `profile "${name}" has an invalid policy ("${entry.policy}"); valid presets: ${POLICY_PRESETS.join(
            ', ',
          )}; valid cells: ${POLICY_CELLS.join(', ')}`,
        );
      }
      policyAllow = toCells(value);
    }
  }
  if (policyPreset !== undefined && env.policy !== undefined) {
    warnings.push(`X_MCP_POLICY=${env.policy} overrides the policy of profile "${name}"`);
    policyPreset = undefined;
  }
  if (policyAllow !== undefined && env.policyAllow !== undefined) {
    warnings.push(`X_MCP_POLICY_ALLOW overrides the policy cells of profile "${name}"`);
    policyAllow = undefined;
  }

  return {
    ...(entry.auth_mode !== undefined ? { authMode: entry.auth_mode } : {}),
    ...(entry.client_id !== undefined ? { clientId: entry.client_id } : {}),
    ...(entry.client_secret !== undefined ? { clientSecret: entry.client_secret } : {}),
    ...(entry.bearer_token !== undefined ? { bearerToken: entry.bearer_token } : {}),
    ...(tokenFile !== undefined ? { tokenFile } : {}),
    ...(policyPreset !== undefined ? { policyPreset } : {}),
    ...(policyAllow !== undefined ? { policyAllow } : {}),
    warnings,
  };
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

  const tokenKeychain = d.X_MCP_TOKEN_KEYCHAIN === '1';

  // CFG-3/CFG-6 — validate and resolve the selected profile when the root supplied the
  // file's contents. Without contents (a caller that skipped the I/O) only the selection
  // is recorded — this function performs no I/O of its own and never guesses credentials.
  const profileName = d.X_MCP_PROFILE;
  const resolved: ProfileResolution | undefined =
    d.X_MCP_PROFILES_FILE !== undefined && profileName !== undefined && profilesJson !== undefined
      ? resolveProfile(profilesJson, profileName, {
          // Only *explicitly* set values may override a profile — the schema defaults for
          // X_MCP_AUTH_MODE/X_MCP_POLICY must not masquerade as operator intent.
          ...(raw.X_MCP_AUTH_MODE !== undefined ? { authMode: d.X_MCP_AUTH_MODE } : {}),
          ...(d.X_MCP_TOKEN_FILE !== undefined ? { tokenFile: d.X_MCP_TOKEN_FILE } : {}),
          keychain: tokenKeychain,
          ...(raw.X_MCP_POLICY !== undefined ? { policy: d.X_MCP_POLICY } : {}),
          ...(d.X_MCP_POLICY_ALLOW !== undefined ? { policyAllow: d.X_MCP_POLICY_ALLOW } : {}),
        })
      : undefined;

  // --- Derive the typed config -----------------------------------------------------
  const authMode = resolved?.authMode ?? d.X_MCP_AUTH_MODE;
  const hideDenied = d.X_MCP_HIDE_DENIED === '1';
  const allowInsecureBaseUrl = d.X_MCP_ALLOW_INSECURE_BASE_URL === '1';
  const baseUrl = d.X_MCP_BASE_URL;
  // Checked HERE, not in the schema refinement: a profile may set `auth_mode`, so the
  // effective mode is only known after resolution (a profile cannot set the base URL).
  const egressIssue = credentialEgressIssue(baseUrl, authMode);
  if (egressIssue !== null) throw validationError(`invalid configuration — ${egressIssue}`);
  const timeoutMs = Number(d.X_MCP_TIMEOUT_MS);

  // Credentials come from exactly one source: env OR the profile (CFG-3 refuses both).
  const clientId = d.X_MCP_CLIENT_ID ?? resolved?.clientId;
  const clientSecret = d.X_MCP_CLIENT_SECRET ?? resolved?.clientSecret;
  const bearerToken = d.X_MCP_BEARER_TOKEN ?? resolved?.bearerToken;

  const oauth2: Oauth2Config = {
    ...(clientId !== undefined ? { clientId } : {}),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
  };

  const policy: PolicyConfig = {
    // A profile's preset/cells survive only where the operator did not set the env var
    // (resolveProfile clears them and warns otherwise), so `??` is the whole precedence.
    preset: resolved?.policyPreset ?? d.X_MCP_POLICY,
    allow: resolved?.policyAllow ?? toCells(d.X_MCP_POLICY_ALLOW),
    deny: toCells(d.X_MCP_POLICY_DENY),
    hideDenied,
  };

  const budget: BudgetConfig = {
    mode: d.X_MCP_BUDGET_MODE,
    ...(d.X_MCP_CREDIT_BUDGET !== undefined ? { creditUsd: Number(d.X_MCP_CREDIT_BUDGET) } : {}),
  };

  const tokenFile = resolveTokenFile(
    env,
    authMode,
    d.X_MCP_TOKEN_FILE ?? resolved?.tokenFile,
    tokenKeychain,
  );
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
  // CFG-6 — unknown profile keys and env-over-profile overrides (never a secret value).
  warnings.push(...(resolved?.warnings ?? []));
  // CFG-7 — a non-default base URL is loud (banner + auth_status upstream).
  if (baseUrl !== DEFAULT_BASE_URL) {
    warnings.push(`Using non-default X API base URL: ${baseUrl}`);
  }
  if (allowInsecureBaseUrl) {
    warnings.push(
      'X_MCP_ALLOW_INSECURE_BASE_URL is enabled — a non-x.com base URL is permitted. ' +
        `Credentials are NOT: they travel to *.${CREDENTIAL_DOMAIN} only, so requests to any other ` +
        'host go out unauthenticated (docs/04 T10).',
    );
  }

  const config: Config = {
    authMode,
    oauth2,
    ...(bearerToken !== undefined ? { bearerToken } : {}),
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
