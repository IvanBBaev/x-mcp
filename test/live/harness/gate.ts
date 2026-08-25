// The live-suite GATE (docs/05 §1 layer table, §6 "Live-suite spend rules", §7 "No live
// tests in CI"). Owned by the live-test slice; nothing under `src/` imports it.
//
// Everything in `test/live/*.live.test.ts` spends REAL money against a REAL X account and
// can post PUBLICLY. The dangerous default therefore has to be impossible, not merely
// discouraged, so the gate is built on three rules:
//
//   1. The suite runs ONLY when `X_MCP_LIVE_TEST=1`. Unset, empty, `0`, `true`, `yes` —
//      anything that is not exactly `1` — leaves every live test SKIPPED via node:test's
//      skip mechanism, with a message naming the variable to set. The default
//      `node --test "build/test/**/*.test.js"` run therefore stays green and silent.
//   2. Writes need a SECOND, independent opt-in: `X_MCP_LIVE_ACCOUNT` must name the handle
//      the suite may touch, and the handle the X API reports for the authenticated user
//      must match it (harness/account.ts). docs/05 §6's "never a personal account" is a
//      check, not a comment.
//   3. The COST-6 capture needs a THIRD opt-in, `X_MCP_LIVE_CAPTURE=1`, because it is only
//      meaningful against an account that has deliberately exhausted its credit.
//
// The gate reads a plain env snapshot and NEVER touches the network. Its one piece of I/O is
// an `existsSync` on the resolved OAuth2 token path — injectable, because "did you actually
// run `authorize`?" is the single most common reason a live run would otherwise fail on its
// first request. Every branch is exercised offline by test/live/gate.test.ts in the normal
// (ungated) suite. That is the whole point: a live suite nobody can run today is still worth
// having if its guardrails are provably correct.

import { existsSync } from 'node:fs';
import test from 'node:test';

import { parseConfig } from '../../../src/core/config.js';
import type { Config } from '../../../src/core/config.js';
import { resolvePolicy } from '../../../src/core/policy.js';
import type { PolicyClass } from '../../../src/core/tooldef.js';

/** Env snapshot shape — `process.env` structurally, but injectable in tests. */
export type EnvSnapshot = Readonly<Record<string, string | undefined>>;

/**
 * "Does this path exist?" — the gate's ONLY piece of I/O, injected so that the gate's own
 * tests (which run in CI on every commit) stay hermetic and never depend on the state of the
 * machine's filesystem.
 */
export type FileProbe = (path: string) => boolean;

/** The master switch. Must be EXACTLY `1`; every other value keeps the suite shut. */
export const LIVE_TEST_ENV = 'X_MCP_LIVE_TEST';

/** The dedicated test account's handle. Required for the write tier (T-214). */
export const LIVE_ACCOUNT_ENV = 'X_MCP_LIVE_ACCOUNT';

/** The COST-6 capture opt-in. Must be exactly `1`. */
export const LIVE_CAPTURE_ENV = 'X_MCP_LIVE_CAPTURE';

/** Every variable this harness owns. Stripped before the snapshot reaches `parseConfig`. */
export const LIVE_ENV_VARS: readonly string[] = [LIVE_TEST_ENV, LIVE_ACCOUNT_ENV, LIVE_CAPTURE_ENV];

/**
 * The three tiers, ordered by blast radius:
 *   `read`    — cheap GETs against public resources. Costs credit, changes nothing.
 *   `write`   — creates and deletes a real public post. Needs the dedicated account.
 *   `capture` — deliberately provokes a billing rejection to record its raw body (COST-6).
 */
export type LiveTier = 'read' | 'write' | 'capture';

/** A gate decision. `reason` is non-empty exactly when `open` is false. */
export interface LiveGate {
  readonly open: boolean;
  /** The node:test skip message when closed; the empty string when open. */
  readonly reason: string;
}

/**
 * The resolved live environment: what was asked for, and everything wrong with it.
 * `problems` is only meaningful when `requested` is true — an operator who never asked for
 * a live run must never be told their credentials are incomplete.
 */
export interface LiveEnvironment {
  /** `X_MCP_LIVE_TEST === '1'`. */
  readonly requested: boolean;
  /** Normalized `X_MCP_LIVE_ACCOUNT` (no `@`, lower-cased); undefined when unset. */
  readonly account: string | undefined;
  /** `X_MCP_LIVE_CAPTURE === '1'`. */
  readonly capture: boolean;
  /** Fatal, operator-fixable reasons the live suite cannot run. Empty means ready. */
  readonly problems: readonly string[];
  /** The parsed server config, when it parsed at all. */
  readonly config: Config | undefined;
}

/** Strip a leading `@`, trim, and lower-case. `undefined`/blank in → `undefined` out. */
export function normalizeHandle(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().replace(/^@+/, '');
  return trimmed === '' ? undefined : trimmed.toLowerCase();
}

/**
 * Remove the `X_MCP_LIVE_*` variables from an env snapshot.
 *
 * `parseConfig` warns about any unknown `X_MCP_*` variable (CFG-8, typo detection) — a
 * correct warning that would nonetheless fire on every single live run, because these
 * three belong to the test harness and not to the server. Stripping them keeps the startup
 * banner honest without touching the config module.
 */
export function stripLiveVars(env: EnvSnapshot): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!LIVE_ENV_VARS.includes(key)) out[key] = value;
  }
  return out;
}

/**
 * Everything that would make a live run fail at the first API call, detected WITHOUT making
 * one. Pure: `parseConfig` performs no I/O and no network (CFG contract).
 */
function credentialProblems(
  env: EnvSnapshot,
  fileExists: FileProbe,
): { problems: string[]; config: Config | undefined } {
  const problems: string[] = [];
  let config: Config | undefined;
  try {
    config = parseConfig(stripLiveVars(env));
  } catch (err) {
    problems.push(
      `the X_MCP_* configuration is invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { problems, config: undefined };
  }

  if (config.authMode === 'app-only') {
    if (config.bearerToken === undefined) {
      problems.push('X_MCP_AUTH_MODE=app-only but X_MCP_BEARER_TOKEN is not set');
    }
  } else {
    if (config.oauth2.clientId === undefined) {
      problems.push(
        'X_MCP_CLIENT_ID is not set — a mid-run token refresh would fail with an auth error',
      );
    }
    // NOT "is a token store configured?" — `tokenFile` carries a default path, so that
    // question can only ever answer yes and the check would be dead. The question that
    // actually predicts a failed live run is whether `authorize` ever WROTE to it. The
    // keychain backend gets no equivalent probe on purpose: reading it means spawning
    // `security`/`secret-tool`, which is I/O this gate refuses to do — that case surfaces as
    // an auth error on the first call instead.
    if (config.tokenFile !== undefined && !fileExists(config.tokenFile)) {
      problems.push(
        `the OAuth2 token file ${config.tokenFile} does not exist — run \`npx x-mcp-ai authorize\` ` +
          'first (or set X_MCP_TOKEN_KEYCHAIN=1 to read the OS keychain instead)',
      );
    }
  }
  return { problems, config };
}

/**
 * The policy cells the write tier needs: `x_post_create` is `write:content`,
 * `x_post_delete` is `destructive:content`. Both are required, because a create the suite
 * cannot delete is exactly the outcome the cleanup contract exists to prevent — so the
 * write tier refuses to start rather than leave a public post behind.
 */
export const WRITE_TIER_CELLS: readonly PolicyClass[] = ['write:content', 'destructive:content'];

/** Which of {@link WRITE_TIER_CELLS} the config's resolved policy does NOT grant. */
export function missingWriteCells(config: Config | undefined): readonly PolicyClass[] {
  if (config === undefined) return WRITE_TIER_CELLS;
  const resolved = resolvePolicy({
    preset: config.policy.preset,
    allow: config.policy.allow,
    deny: config.policy.deny,
  });
  return WRITE_TIER_CELLS.filter((cell) => !resolved.cells.has(cell));
}

/**
 * Resolve the whole live environment from one env snapshot. The only I/O is the injected
 * {@link FileProbe}, and it is reached ONLY when a live run was actually requested — an
 * operator who never asked for one is never told anything about their credentials.
 */
export function liveEnvironment(
  env: EnvSnapshot,
  fileExists: FileProbe = existsSync,
): LiveEnvironment {
  const requested = env[LIVE_TEST_ENV] === '1';
  const account = normalizeHandle(env[LIVE_ACCOUNT_ENV]);
  const capture = env[LIVE_CAPTURE_ENV] === '1';
  if (!requested) {
    return { requested, account, capture, problems: [], config: undefined };
  }
  const { problems, config } = credentialProblems(env, fileExists);
  return { requested, account, capture, problems, config };
}

/**
 * Decide whether one tier may run. The order of the checks is the order of the blast
 * radius: the master switch, then the credentials, then the tier's own opt-in.
 */
export function gateFor(live: LiveEnvironment, tier: LiveTier): LiveGate {
  if (!live.requested) {
    return {
      open: false,
      reason:
        `live tests are off — set ${LIVE_TEST_ENV}=1 to run them (they spend real credit ` +
        `against a real X account; see docs/14-live-testing.md)`,
    };
  }
  if (live.problems.length > 0) {
    return {
      open: false,
      reason: `live preflight failed (${live.problems[0] ?? 'unknown'}) — see the "live preflight" test`,
    };
  }
  if (tier === 'write') {
    if (live.account === undefined) {
      return {
        open: false,
        reason:
          `live WRITES are off — set ${LIVE_ACCOUNT_ENV} to the handle of the dedicated test ` +
          `account this run may post from and delete from (never a personal account)`,
      };
    }
    if (live.config?.authMode !== 'oauth2') {
      return {
        open: false,
        reason: `live WRITES need user-context auth — set X_MCP_AUTH_MODE=oauth2 and authorize first`,
      };
    }
    const missing = missingWriteCells(live.config);
    if (missing.length > 0) {
      return {
        open: false,
        reason:
          `live WRITES are denied by the active policy — the ${missing.join(' and ')} ` +
          `cell(s) are not granted by preset \`${live.config.policy.preset}\`. Set ` +
          `X_MCP_POLICY=manage (or grant the cells explicitly) for the run`,
      };
    }
  }
  if (tier === 'capture' && !live.capture) {
    return {
      open: false,
      reason:
        `the COST-6 billing capture is off — set ${LIVE_CAPTURE_ENV}=1 and run it against an ` +
        `account whose pay-per-use credit is already exhausted (docs/07 COST-6)`,
    };
  }
  return { open: true, reason: '' };
}

/** The live environment of THIS process, resolved once at module load. */
export const LIVE = liveEnvironment(process.env);

/**
 * Register a live test. When the tier's gate is shut the test is registered as a node:test
 * SKIP carrying the gate's reason, so `node --test` reports it (visible, not silently
 * absent) without running a byte of it.
 */
export function liveTest(name: string, tier: LiveTier, fn: () => Promise<void>): void {
  const gate = gateFor(LIVE, tier);
  if (!gate.open) {
    test(name, { skip: gate.reason }, () => {
      /* never runs — the gate is shut */
    });
    return;
  }
  test(name, fn);
}
