// OS-keychain TokenStore backend — the `X_MCP_TOKEN_KEYCHAIN=1` alternative to the
// file-backed store (docs/02 §4A + env table; docs/04 threat T1). Owned by T-308 (WP-3.7).
// Implements the same frozen `TokenStore` port as filestore.ts, so the refresh machine
// (T-201) and the integration facade (T-203) sit on top of it unchanged.
//
// Why a subprocess and not a native binding: the runtime dependency set is FROZEN
// (@modelcontextprotocol/sdk + zod), so `keytar`-style native modules are not available.
// The store therefore shells out to the platform's own secret tool through the injected
// {@link KeychainRunner} seam — the same "every side effect is a port" stance the rest of
// the codebase takes, and the reason the tests here never touch a real keychain.
//
// Guarantees:
//   • Secrets NEVER reach argv (docs/04 T1): a process command line is world-readable via
//     `ps`, so the payload always travels on the child's stdin. On macOS that rules out
//     both `-w <password>` (argv) and `-w` prompt mode — the interactive prompt reads a
//     line through `readpassphrase`, which TRUNCATES AT 128 BYTES (measured), silently
//     corrupting any real token payload. What is used instead is `security -i`: the
//     command line itself is read from stdin, so the payload is off argv and unbounded.
//   • Secrets never reach the child's ENVIRONMENT either (docs/04 T17): the helper is spawned
//     with an explicit allowlist ({@link keychainChildEnv}), not the inherited environment, so
//     `ps e` / `/proc/<pid>/environ` against it cannot hand out the app-only bearer or the
//     OAuth2 client secret. The helper never needed either of them.
//   • Fail CLOSED, never silently degrade: an unsupported platform is refused at
//     construction, and a missing/failing secret tool raises a typed `auth` error naming
//     `X_MCP_TOKEN_FILE` as the supported fallback. There is no in-memory fallback store —
//     silently "succeeding" with a store that forgets the rotated refresh token would
//     strand the operator at the next restart.
//   • Nothing token-shaped is ever put in an error message, an error `cause`, or a
//     warning: tool stdout is never surfaced at all, and stderr goes through
//     {@link scrubSecrets} (known payload + generic long-token-run redaction + one-line
//     truncation) before it reaches an `XError`.
//   • Injection-proof identifiers: the macOS `-i` line is a command line, so the service /
//     account / label are validated against a conservative charset at construction and the
//     payload is base64url — no quoting, no escaping, nothing that can start a second
//     command.
//   • Corrupt entries follow AUTH-9: typed `auth` error naming the entry and the
//     re-authorize command; the entry is never deleted or rewritten on load. The schema
//     gate is the file store's (`TOKEN_FILE_SCHEMA_VERSION`, docs/05 §8.7) — a NEWER
//     payload fails closed instead of being guessed at.
//
// LIMITATION (documented, warned about once, not silently ignored): unlike the file store
// there is no cross-process refresh lock — neither `security` nor `secret-tool` exposes a
// lock primitive, and an emulated one built on a second keychain entry cannot be created
// atomically on Linux (`secret-tool store` always overwrites). `withLock` therefore
// guarantees the single-flight contract WITHIN this process (FIFO, released on throw) and
// warns once, on the first refresh, that operators running several x-mcp-ai processes
// against one account should use `X_MCP_TOKEN_FILE` (AUTH-5).

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { authError } from '../../core/errors.js';
import type { TokenPair, TokenStore } from '../../core/ports.js';
import { TOKEN_FILE_SCHEMA_VERSION } from './filestore.js';

/** Keychain "service" attribute the token entry is filed under. */
export const KEYCHAIN_SERVICE = 'x-mcp-ai';

/** Default "account" attribute; the integrator passes the profile name when one is set. */
export const KEYCHAIN_ACCOUNT = 'oauth2';

/** Human-facing label shown by Keychain Access / Seahorse. */
export const KEYCHAIN_LABEL = 'x-mcp-ai-oauth2-token';

/** `security` exit status for `errSecItemNotFound` (measured on macOS 15). */
export const MACOS_ITEM_NOT_FOUND_EXIT = 44;

/** `security` exit status for `errSecDuplicateItem` (measured on macOS 15). */
export const MACOS_DUPLICATE_ITEM_EXIT = 45;

/** Max characters of (scrubbed) tool stderr echoed into an error message. */
export const MAX_DETAIL_CHARS = 200;

/** Runs of at least this many token-ish characters are redacted defensively. */
const SECRET_RUN_MIN = 40;

/** Cap on captured child output, so a runaway tool cannot exhaust memory. */
const MAX_CAPTURE_BYTES = 64 * 1024;

const FALLBACK_HINT =
  'Unset X_MCP_TOKEN_KEYCHAIN and set X_MCP_TOKEN_FILE to use the file-backed token store instead.';

const AUTHORIZE_HINT = 'Run `npx x-mcp-ai authorize` to mint a fresh token.';

/** Service/account/label charset: safe on an argv AND on the macOS `security -i` line. */
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

/** Platforms with a first-party secret tool this backend knows how to drive. */
const SUPPORTED_PLATFORMS = ['darwin', 'linux'] as const;
type KeychainPlatform = (typeof SUPPORTED_PLATFORMS)[number];

/** The binary each supported platform needs on PATH. */
const PLATFORM_TOOL: Readonly<Record<KeychainPlatform, string>> = {
  darwin: 'security',
  linux: 'secret-tool',
};

// --- The child-process environment (docs/04 T17) -----------------------------------------

/**
 * Variables the helper is given on EVERY platform.
 *
 * • `PATH` — the helper is spawned by NAME (`security` / `secret-tool`), and on the
 *   fork+exec spawn path libuv replaces `environ` with this `env` option BEFORE `execvp`,
 *   so the binary lookup runs against the CHILD's PATH. Dropping it would turn every
 *   keychain call on Linux into a spurious `ENOENT` — reported by {@link nodeKeychainRunner}
 *   as "the tool is not installed or not on PATH", which is the worst possible lie to tell
 *   an operator whose keychain is fine. (macOS happens to resolve through `posix_spawnp`
 *   against the PARENT's PATH — measured — but that is a platform accident, not a contract.)
 * • `HOME` — D-Bus autolaunch reads `$HOME/.dbus/session-bus/`, and every XDG path below is
 *   defined relative to it. NOT required by macOS `security`: a full `security -i`
 *   add → `find-generic-password -w` → `delete-generic-password` round trip against the real
 *   login keychain succeeds under `env -i` (measured, macOS 15). Kept anyway because it
 *   carries no credential and both platforms share this list.
 */
const CHILD_ENV_COMMON = ['PATH', 'HOME'] as const;

/**
 * Per-platform additions, deliberately minimal — everything here is a variable the helper
 * cannot do its job without, and nothing here can carry a credential.
 */
const CHILD_ENV_PLATFORM: Readonly<Record<KeychainPlatform, readonly string[]>> = {
  // NOTHING, and that is a measured claim rather than an omission. `security` reaches the
  // user's login context through securityd over the inherited Mach bootstrap port and
  // resolves the default keychain from `getpwuid(getuid())` — the login context travels with
  // the process, not in its environment (see the `env -i` round trip noted above).
  // `__CF_USER_TEXT_ENCODING` and `TMPDIR` were considered and dropped: every identifier is
  // ASCII by {@link SAFE_IDENTIFIER} and the payload is base64url, so no byte in play is
  // text-encoding dependent, and none of the three subcommands used here touches TMPDIR.
  darwin: [],
  // `secret-tool` stores nothing itself: it asks the Secret Service (gnome-keyring, kwallet)
  // over the D-Bus SESSION bus, so without a route to that bus every call fails with
  // "Cannot autolaunch D-Bus without X11 $DISPLAY" — the exact stderr `load` already has to
  // classify as a real failure rather than "no token yet".
  //   DBUS_SESSION_BUS_ADDRESS  the direct route to the bus.
  //   XDG_RUNTIME_DIR           the fallback route: systemd/dbus-broker put the socket at
  //                             `$XDG_RUNTIME_DIR/bus` and do not always export the address.
  //   DISPLAY / WAYLAND_DISPLAY / XAUTHORITY
  //                             a LOCKED keyring is unlocked through a graphical gcr prompt,
  //                             and X11 D-Bus autolaunch needs DISPLAY + XAUTHORITY. Without
  //                             them a locked keyring fails closed at every refresh instead
  //                             of asking the operator once for their password.
  linux: [
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
  ],
};

/**
 * Build the environment the keychain helper is spawned with (docs/04 T17).
 *
 * An ALLOWLIST, deny-by-default: nothing has to remember to blocklist `X_MCP_BEARER_TOKEN`,
 * `X_MCP_OAUTH2_CLIENT_SECRET`, or the next credential variable somebody adds — none of them
 * is on the list, so none of them is inherited. Without this, `ps e` /
 * `/proc/<pid>/environ` against the short-lived helper hands out the app-only bearer, which
 * per T17 is unscoped, long-lived and un-rotatable. The helper never needed any of it: the
 * only secret it handles is the payload, and that travels on stdin — never argv, never env.
 *
 * The same deny-by-default drops the loader hooks (`DYLD_INSERT_LIBRARIES`, `LD_PRELOAD`,
 * `NODE_OPTIONS`), so a poisoned parent environment cannot inject code into the one child
 * process that touches the token. It also drops `LANG`/`LC_*`, which is a small bonus: the
 * C locale keeps `security`'s "could not be found" stderr — the macOS "no token yet"
 * fallback signal in {@link createKeychainTokenStore}'s `load` — in English.
 *
 * A platform this backend does not support is never reached in production (the store refuses
 * at construction), so it simply gets the shared pair.
 *
 * Exported for the test that pins the scrub.
 */
export function keychainChildEnv(
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const supported = SUPPORTED_PLATFORMS.find((candidate) => candidate === platform);
  const allowed = [
    ...CHILD_ENV_COMMON,
    ...(supported === undefined ? [] : CHILD_ENV_PLATFORM[supported]),
  ];
  const env: Record<string, string> = {};
  for (const name of allowed) {
    const value = source[name];
    // Only DEFINED values are copied: an own key holding `undefined` is not the same thing
    // as an absent variable, and Node has spelled that inheritance both ways across majors.
    if (value !== undefined) env[name] = value;
  }
  return env;
}

// --- The command-runner seam ------------------------------------------------------------

/** One child-process invocation. The secret, when there is one, is only ever `stdin`. */
export interface KeychainInvocation {
  /** Binary to execute (`security` / `secret-tool`); resolved via PATH. */
  readonly command: string;
  /** Arguments — MUST NOT contain secret material (argv is world-readable via `ps`). */
  readonly args: readonly string[];
  /** Bytes written to the child's stdin, which is always closed afterwards. */
  readonly stdin?: string;
}

/** The outcome of one invocation. A runner resolves; it never rejects in production. */
export interface KeychainResult {
  /** Exit status, or `null` when the process never ran (see {@link errorCode}). */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Spawn errno when the process never ran — `'ENOENT'` = the tool is not installed. */
  readonly errorCode?: string;
}

/**
 * The injection seam that keeps this module testable: production passes
 * {@link nodeKeychainRunner}; tests pass a fake that records invocations and replays
 * canned results, so no test ever reads or writes a real keychain.
 */
export interface KeychainRunner {
  run(invocation: KeychainInvocation): Promise<KeychainResult>;
}

/** Extract a Node errno code (`'ENOENT'`, …) from an unknown error. */
function errCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * The production runner: `node:child_process.spawn` with piped stdio. Output is captured
 * up to {@link MAX_CAPTURE_BYTES}; a spawn failure (notably `ENOENT` — the tool is not
 * installed) resolves as `code: null` + `errorCode` rather than rejecting, so the caller
 * has exactly one failure shape to classify.
 */
export const nodeKeychainRunner: KeychainRunner = {
  run(invocation) {
    return new Promise<KeychainResult>((resolve) => {
      let settled = false;
      const finish = (result: KeychainResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(invocation.command, [...invocation.args], {
          stdio: ['pipe', 'pipe', 'pipe'],
          // docs/04 T17: an EXPLICIT environment, never the inherited one, so no `X_MCP_*`
          // credential is readable through `ps e` / `/proc/<pid>/environ` for the lifetime of
          // the child. See {@link keychainChildEnv} for what survives and why.
          env: keychainChildEnv(),
        });
      } catch (err) {
        finish({ code: null, stdout: '', stderr: '', errorCode: errCode(err) ?? 'ESPAWN' });
        return;
      }

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk;
      });

      child.on('error', (err: unknown) => {
        finish({ code: null, stdout, stderr, errorCode: errCode(err) ?? 'ESPAWN' });
      });
      child.on('close', (code: number | null) => {
        finish({ code, stdout, stderr });
      });

      // A tool that reads its secret from stdin blocks until EOF, so stdin is always
      // ended — even when there is nothing to send. EPIPE (child exited early) is not a
      // failure of ours: the exit status decides.
      child.stdin.on('error', () => undefined);
      child.stdin.end(invocation.stdin ?? '');
    });
  },
};

// --- Redaction ---------------------------------------------------------------------------

/**
 * Make tool output safe to embed in an error: replace the payloads we know we sent, then
 * any remaining long token-shaped run (defence against a tool echoing what it read),
 * collapse to one line and truncate. Applied to EVERY piece of tool output that leaves
 * this module; tool stdout is never surfaced at all.
 */
export function scrubSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join('[redacted]');
  }
  out = out.replace(new RegExp(`[A-Za-z0-9+/=_.-]{${SECRET_RUN_MIN},}`, 'g'), '[redacted]');
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > MAX_DETAIL_CHARS ? `${out.slice(0, MAX_DETAIL_CHARS)}…` : out;
}

// --- Payload codec -----------------------------------------------------------------------

/**
 * The stored secret is base64url of a SINGLE-LINE JSON object with exactly the file
 * store's field names and semantics (`version` = schema version, `revision` = the frozen
 * `TokenPair.version` counter). Single-line because the payload travels through
 * line-oriented tools; base64url because it then contains nothing a command-line
 * tokenizer could treat as structure.
 */
function encodePayload(pair: TokenPair): string {
  const body: Record<string, unknown> = {
    version: TOKEN_FILE_SCHEMA_VERSION,
    revision: (pair.version ?? 0) + 1,
    access_token: pair.access_token,
    obtained_at: pair.obtained_at,
    expires_in: pair.expires_in,
  };
  if (pair.refresh_token !== undefined) body['refresh_token'] = pair.refresh_token;
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decode + validate a stored payload (AUTH-9 semantics, keychain edition): every failure
 * is a typed `auth` error naming the entry, and the entry is left untouched for the
 * operator to inspect. Never echoes the payload itself.
 */
function decodePayload(raw: string, entry: string): TokenPair {
  // The annotation is on the VARIABLE, not just the arrow: TypeScript only treats a call
  // as an unreachability assertion when the callee's `never` return type is visible on the
  // const's declared type, and every check below relies on that narrowing.
  const corrupt: (detail: string) => never = (detail) => {
    throw authError(
      `Keychain entry ${entry} ${detail}. The entry was left untouched for inspection. ${AUTHORIZE_HINT}`,
    );
  };

  // No try/catch around the decode: Node's base64url decoder is lenient by contract — it
  // skips characters outside the alphabet and returns a (possibly empty) buffer rather than
  // throwing, and `toString('utf8')` substitutes U+FFFD instead of failing. A genuinely
  // corrupt entry therefore surfaces one step later, as "is empty" or as invalid JSON, and a
  // `catch` here would be unreachable code pretending to be a safety net.
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  if (text.trim() === '') corrupt('is empty');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    corrupt('does not decode to valid JSON');
  }
  if (!isRecord(parsed)) corrupt('does not decode to a JSON object');

  const version = parsed['version'] ?? 0;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    corrupt('has a malformed "version" field');
  }
  if (version > TOKEN_FILE_SCHEMA_VERSION) {
    throw authError(
      `Keychain entry ${entry} uses format version ${version}, but this build of x-mcp-ai ` +
        `only understands up to version ${TOKEN_FILE_SCHEMA_VERSION}. A newer x-mcp-ai wrote ` +
        'it — upgrade this server to at least that version. The entry was left untouched and ' +
        'was not downgraded.',
    );
  }

  const accessToken = parsed['access_token'];
  if (typeof accessToken !== 'string' || accessToken === '') {
    corrupt('is missing the required "access_token" field');
  }
  const obtainedAt = parsed['obtained_at'];
  if (typeof obtainedAt !== 'number' || !Number.isFinite(obtainedAt)) {
    corrupt('is missing a numeric "obtained_at" field');
  }
  const expiresIn = parsed['expires_in'];
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
    corrupt('is missing a numeric "expires_in" field');
  }
  const refreshToken = parsed['refresh_token'];
  if (refreshToken !== undefined && (typeof refreshToken !== 'string' || refreshToken === '')) {
    corrupt('has a malformed "refresh_token" field');
  }
  const revision = parsed['revision'];
  const hasRevision = typeof revision === 'number' && Number.isInteger(revision) && revision >= 0;

  return {
    access_token: accessToken,
    obtained_at: obtainedAt,
    expires_in: expiresIn,
    ...(typeof refreshToken === 'string' ? { refresh_token: refreshToken } : {}),
    ...(hasRevision ? { version: revision } : {}),
  };
}

// --- The store ---------------------------------------------------------------------------

export interface KeychainTokenStoreOptions {
  /** Keychain "service" attribute; defaults to {@link KEYCHAIN_SERVICE}. */
  readonly service?: string;
  /** Keychain "account" attribute; defaults to {@link KEYCHAIN_ACCOUNT} (or the profile). */
  readonly account?: string;
  /** Item label shown in the OS UI; defaults to {@link KEYCHAIN_LABEL}. */
  readonly label?: string;
  /** Command-runner seam; defaults to {@link nodeKeychainRunner}. */
  readonly runner?: KeychainRunner;
  /** Platform switch; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Warning sink; defaults to `console.warn` (stderr — stdout stays MCP-pure). */
  readonly warn?: (message: string) => void;
}

function assertSupportedPlatform(platform: NodeJS.Platform): KeychainPlatform {
  const supported = SUPPORTED_PLATFORMS.find((candidate) => candidate === platform);
  if (supported === undefined) {
    throw authError(
      `X_MCP_TOKEN_KEYCHAIN=1 is not supported on platform "${platform}": x-mcp-ai drives the ` +
        `OS keychain through ${SUPPORTED_PLATFORMS.map((p) => `${p} (${PLATFORM_TOOL[p]})`).join(' and ')}, ` +
        `and refuses to fall back to an in-memory store that would forget the token. ${FALLBACK_HINT}`,
    );
  }
  return supported;
}

function assertSafeIdentifier(kind: string, value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw authError(
      `Keychain ${kind} "${value}" contains characters x-mcp-ai will not put on a keychain ` +
        'command line; use letters, digits, ".", "_", "@" or "-" (max 64 characters). ' +
        FALLBACK_HINT,
    );
  }
  return value;
}

/**
 * Build the OS-keychain-backed {@link TokenStore}. Throws a typed `auth` error at
 * CONSTRUCTION on an unsupported platform or an unusable identifier, so the operator sees
 * the misconfiguration at startup rather than at the first refresh.
 */
export function createKeychainTokenStore(options: KeychainTokenStoreOptions = {}): TokenStore {
  const platform = assertSupportedPlatform(options.platform ?? process.platform);
  const service = assertSafeIdentifier('service', options.service ?? KEYCHAIN_SERVICE);
  const account = assertSafeIdentifier('account', options.account ?? KEYCHAIN_ACCOUNT);
  const label = assertSafeIdentifier('label', options.label ?? KEYCHAIN_LABEL);
  const runner = options.runner ?? nodeKeychainRunner;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const tool = PLATFORM_TOOL[platform];
  const entry = `${service}/${account}`;

  /**
   * Run one invocation. A runner rejection is caught and re-thrown scrubbed and WITHOUT a
   * `cause`: a rejection message is the one place a buggy runner could carry the payload.
   */
  async function run(
    invocation: KeychainInvocation,
    secrets: readonly string[],
  ): Promise<KeychainResult> {
    let result: KeychainResult;
    try {
      result = await runner.run(invocation);
    } catch (err) {
      const detail = scrubSecrets(err instanceof Error ? err.message : String(err), secrets);
      throw authError(
        `Could not run "${tool}" for keychain entry ${entry}: ${detail}. ${FALLBACK_HINT}`,
      );
    }
    if (result.code === null) {
      const code = result.errorCode ?? 'unknown error';
      throw authError(
        code === 'ENOENT'
          ? `The "${tool}" command is not installed or not on PATH, so x-mcp-ai cannot reach the ` +
              `OS keychain (X_MCP_TOKEN_KEYCHAIN=1). Install it, or: ${FALLBACK_HINT}`
          : `Could not run "${tool}" for keychain entry ${entry} (${code}). ${FALLBACK_HINT}`,
      );
    }
    return result;
  }

  /** Typed failure for a non-zero exit; only scrubbed stderr is ever surfaced. */
  function toolError(
    what: string,
    result: KeychainResult,
    secrets: readonly string[],
    tail: string,
  ): never {
    const detail = scrubSecrets(result.stderr, secrets);
    throw authError(
      `${what} for keychain entry ${entry} failed (${tool} exited ${String(result.code)}` +
        `${detail === '' ? '' : `: ${detail}`}). ${tail}`,
    );
  }

  async function load(): Promise<TokenPair | null> {
    const result =
      platform === 'darwin'
        ? await run(
            { command: tool, args: ['find-generic-password', '-s', service, '-a', account, '-w'] },
            [],
          )
        : await run(
            { command: tool, args: ['lookup', 'service', service, 'account', account] },
            [],
          );

    if (result.code === 0) {
      const raw = result.stdout.trim();
      return raw === '' ? null : decodePayload(raw, entry);
    }
    // "No such entry" is a normal first-run state, and each tool signals it differently:
    // macOS `security` exits 44 (errSecItemNotFound); `secret-tool lookup` exits non-zero
    // with NO output at all. Anything else (locked keychain, no D-Bus session, denied
    // access) is a real failure and must not be mistaken for "no token yet".
    const notFound =
      platform === 'darwin'
        ? result.code === MACOS_ITEM_NOT_FOUND_EXIT || /could not be found/i.test(result.stderr)
        : result.stdout.trim() === '' && result.stderr.trim() === '';
    if (notFound) return null;
    toolError('Reading the stored OAuth2 token', result, [], `${FALLBACK_HINT} ${AUTHORIZE_HINT}`);
  }

  /** macOS write: the whole command line (payload included) is fed to `security -i`. */
  function macosStoreInvocation(payload: string): KeychainInvocation {
    return {
      command: tool,
      args: ['-i'],
      stdin: `add-generic-password -U -a ${account} -s ${service} -l ${label} -w ${payload}\n`,
    };
  }

  async function persist(pair: TokenPair): Promise<void> {
    const payload = encodePayload(pair);
    const secrets = [payload, pair.access_token, pair.refresh_token ?? ''].filter(
      (secret) => secret.length > 0,
    );
    const failureTail =
      'The refreshed pair stays usable in memory for this session only. ' + FALLBACK_HINT;

    if (platform === 'darwin') {
      let result = await run(macosStoreInvocation(payload), secrets);
      if (result.code === MACOS_DUPLICATE_ITEM_EXIT) {
        // `-U` normally updates in place; when the existing item cannot be updated
        // (rewritten ACL, item in another keychain in the search list) `security` reports
        // errSecDuplicateItem. Remove the old item and write once more — same secret, so
        // nothing is lost if the delete itself fails.
        await run(
          { command: tool, args: ['delete-generic-password', '-s', service, '-a', account] },
          secrets,
        ).catch(() => undefined);
        result = await run(macosStoreInvocation(payload), secrets);
      }
      if (result.code !== 0) toolError('Saving the OAuth2 token', result, secrets, failureTail);
      return;
    }

    const result = await run(
      {
        command: tool,
        args: ['store', `--label=${label}`, 'service', service, 'account', account],
        stdin: payload,
      },
      secrets,
    );
    if (result.code !== 0) toolError('Saving the OAuth2 token', result, secrets, failureTail);
  }

  // In-process FIFO mutex: `tail` is replaced synchronously on entry, so waiters queue in
  // call order and each one is released even when `fn` throws (the file store's contract
  // shape, minus the cross-process half the OS keychain cannot provide — see the header).
  let tail: Promise<void> = Promise.resolve();
  let warnedAboutLock = false;

  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (!warnedAboutLock) {
      warnedAboutLock = true;
      warn(
        `x-mcp-ai: the OS keychain backend serializes token refresh within THIS process only; ` +
          'unlike the file store it has no cross-process refresh lock. If several x-mcp-ai ' +
          'processes share this account, use X_MCP_TOKEN_FILE so concurrent refreshes stay ' +
          'single-flight (AUTH-5).',
      );
    }
    const previous = tail;
    // Definite assignment, not a no-op placeholder: the executor runs synchronously inside
    // the constructor, so `release` is assigned before this statement returns and a stand-in
    // arrow could never be the one invoked in `finally` — it would only be dead code that
    // reads like a fallback.
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { load, persist, withLock };
}
