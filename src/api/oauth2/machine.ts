// The in-memory single-flight OAuth 2.0 refresh state machine (docs/02 §4A; docs/07
// AUTH-1…4/6/8…12, CONC-1). Owned by T-201 (WP-2.1).
//
// This module is the PER-PROCESS half of the token manager. It is pure in-memory logic:
// no file I/O, no timers, no HTTP. Everything non-deterministic is injected — time via
// the `Clock` port, persistence + cross-process locking via the `TokenStore` port
// (implemented by the file store, T-202), and the token-endpoint POST via the
// `RefreshHttp` callable (built by the integration layer, T-203, over api/http with a
// timeout strictly below the 30 s lock-staleness threshold — see
// {@link REFRESH_HTTP_TIMEOUT_MS}).
//
// Invariants implemented here (§4A):
//   1. Single-flight — N concurrent callers share ONE refresh promise; never N refreshes
//      (AUTH-2, CONC-1). Eager and reactive callers join the same in-flight refresh.
//   2. Reload-under-lock / adopt-on-disk-pair — inside the critical section the store is
//      re-read; a differing on-disk pair is ADOPTED and the refresh HTTP call is skipped
//      entirely, so a peer's rotation is never burned (AUTH-3).
//   3. Reload-on-401 — the reactive path always goes through the lock + reload before
//      deciding to refresh (AUTH-4).
//   4. Persist-before-use — a rotated pair is handed to `TokenStore.persist` BEFORE the
//      new access token is released to any caller (AUTH-1). A rotation that cannot be
//      persisted is never used: the machine fails closed, because the old refresh token
//      may already be invalidated server-side and a later reload would otherwise refresh
//      with a burned token.
//   5. Fail-closed — a rejected refresh (4xx / invalid_grant) is TERMINAL: every later
//      call surfaces the same typed `auth` error with the re-authorize instruction;
//      there is never a retry loop into a second refresh of the same token (AUTH-8).
//      Transient failures (thrown transport errors, 5xx) are retryable and leave the
//      machine healthy — the stored tokens are unchanged.
//
// The eager boundary (≤ 5 min of access-token life, via the injected Clock) is computed
// at the point of use — there are no long-lived timers, so a laptop resume can never
// fire a stale timer (AUTH-7, PLAT-4). A pair whose lifetime cannot be computed disables
// eager refresh and relies purely on the reactive 401 path (AUTH-11).
//
// There is no `Sleep` port here by design: the machine never waits — the stale-lock
// wait/fail-closed protocol lives inside `TokenStore.withLock` (T-202), and the machine
// has no internal retry loop to back off (§4A step 4: "No retry loop").
//
// Out of scope, owned by T-203 (integration) / api/http: retrying the triggering request
// exactly once after a completed refresh, and treating a second 401 on the retried
// request as terminal. This module supplies the primitive: `handleUnauthorized` either
// returns an access token DIFFERENT from the rejected one or throws a typed `auth`
// error — it can never hand the rejected token back, so the caller's retry-once loop
// cannot spin.

import type { Clock, TokenPair, TokenStore } from '../../core/ports.js';
import { XError, apiError, authError, networkError } from '../../core/errors.js';
import { sanitizePlatformText } from '../../core/sanitize.js';

/** Eager-refresh margin: refresh proactively once ≤ 5 minutes of life remain (§4A, AUTH-7). */
export const EAGER_REFRESH_MARGIN_MS = 5 * 60_000;

/**
 * The timeout the T-203-built {@link RefreshHttp} callable MUST apply to the token-endpoint
 * POST: strictly below the 30 s lock-staleness threshold, so a hung refresh can never
 * outlive its own lock's staleness window (§4A step 4, AUTH-5 — enforced in T-202/T-203;
 * exported here so the contract has one authoritative value).
 */
export const REFRESH_HTTP_TIMEOUT_MS = 25_000;

/** The operator recovery instruction every terminal `auth` error carries (§4A invariant 5). */
export const REAUTHORIZE_HINT = 'run `npx x-mcp-ai authorize` to re-link the account';

/** The token-endpoint success body, as parsed by the T-203 callable. */
export interface RefreshTokenResponse {
  readonly access_token: string;
  /**
   * Rotation is observed behavior, never assumed (AUTH-6): when this is omitted the old
   * refresh token is retained; when it repeats the old value it persists without error.
   */
  readonly refresh_token?: string;
  /** Access-token lifetime in seconds. Omitted → the new pair has an unknown lifetime (AUTH-11). */
  readonly expires_in?: number;
}

/**
 * The refresh HTTP outcome. `ok: false` carries the HTTP status plus the OAuth error
 * fields when the body had them. Transport failures (no response at all) are THROWN by
 * the callable instead; a thrown `XError` passes through unchanged (so T-203 can classify
 * an ambiguous mid-flight timeout itself), anything else is wrapped as a retryable
 * `network` error.
 */
export type RefreshHttpResult =
  | { readonly ok: true; readonly token: RefreshTokenResponse }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error?: string;
      readonly error_description?: string;
    };

/** The injected token-endpoint POST (§4A step 4). Built by T-203; faked in tests. */
export type RefreshHttp = (refreshToken: string) => Promise<RefreshHttpResult>;

/**
 * The §4A state vocabulary. `REACTIVE`, `REFRESH`, `ADOPTED`, and `PERSISTING` are
 * transient (observable only while a refresh is in flight); `FAILED_CLOSED` is terminal
 * and sticky; the rest are derived from the in-memory pair + Clock at the point of use.
 * Before the first successful load the machine reports `VALID` (the diagram's start state).
 */
export type MachineState =
  | 'VALID'
  | 'UNKNOWN_LIFETIME'
  | 'EAGER'
  | 'REACTIVE'
  | 'REFRESH'
  | 'ADOPTED'
  | 'PERSISTING'
  | 'FAILED_CLOSED';

export interface RefreshMachineConfig {
  readonly clock: Clock;
  /** Persistence + cross-process lock (T-202 file store in production; in-memory fake in tests). */
  readonly store: TokenStore;
  /** The token-endpoint POST (T-203). */
  readonly refreshHttp: RefreshHttp;
}

export interface RefreshMachine {
  /**
   * The pre-request path: returns a usable access token, eagerly refreshing when ≤ 5 min
   * of life remain (AUTH-7) and joining any in-flight refresh (AUTH-2). Throws a typed
   * `auth` error when no usable credentials exist (AUTH-9/10) or the machine is terminal.
   */
  getAccessToken(): Promise<string>;
  /**
   * The reactive path: report that `unauthorizedAccessToken` just got a 401. Reloads the
   * store under the lock before deciding to refresh (AUTH-4), adopts a differing on-disk
   * pair without any refresh HTTP call (AUTH-3), and otherwise runs the single-flight
   * refresh. Returns an access token guaranteed to DIFFER from the rejected one, or
   * throws a typed error. The caller (T-203) retries the triggering request exactly once
   * with the returned token; a second 401 there is terminal (AUTH-8).
   */
  handleUnauthorized(unauthorizedAccessToken: string): Promise<string>;
  /** Current §4A state, for tests / `auth_status` / `doctor` observability. */
  state(): MachineState;
}

/** A pair's lifetime is computable only when both timestamps are sane numbers (AUTH-11). */
function hasKnownLifetime(pair: TokenPair): boolean {
  return (
    Number.isFinite(pair.obtained_at) &&
    pair.obtained_at > 0 &&
    Number.isFinite(pair.expires_in) &&
    pair.expires_in > 0
  );
}

/** Milliseconds of access-token life left, per the injected Clock. */
function remainingLifeMs(pair: TokenPair, nowMs: number): number {
  return pair.obtained_at + pair.expires_in * 1000 - nowMs;
}

/** A usable refresh token is a non-empty string; anything else means "none stored" (AUTH-10). */
function refreshTokenOf(pair: TokenPair): string | undefined {
  return typeof pair.refresh_token === 'string' && pair.refresh_token !== ''
    ? pair.refresh_token
    : undefined;
}

export function createRefreshMachine(config: RefreshMachineConfig): RefreshMachine {
  /** The in-memory pair; `null` until the first load (or adoption) succeeds. */
  let pair: TokenPair | null = null;
  /** The shared single-flight refresh promise (AUTH-2, CONC-1). */
  let inFlight: Promise<string> | null = null;
  /** Transient §4A phase while a refresh cycle runs; `null` when at rest. */
  let phase: Extract<MachineState, 'REACTIVE' | 'REFRESH' | 'ADOPTED' | 'PERSISTING'> | null = null;
  /** The sticky terminal error once the machine has failed closed (AUTH-8). */
  let terminal: XError | null = null;

  /** Enter the terminal FAILED_CLOSED state: every later call rethrows the same error. */
  function failClosed(error: XError): never {
    terminal = error;
    throw error;
  }

  /**
   * Read the store, mapping failures to a typed `auth` error (AUTH-9). An `XError` thrown
   * by the store (the file store names the offending path itself) passes through
   * unchanged. Never terminal: the operator can repair/re-authorize and the next call
   * re-reads — and the machine never deletes or rewrites a corrupt file.
   */
  async function loadFromStore(): Promise<TokenPair | null> {
    try {
      return await config.store.load();
    } catch (cause) {
      if (XError.is(cause)) throw cause;
      throw authError(
        `Stored OAuth tokens could not be read (corrupt or unreadable token store); ${REAUTHORIZE_HINT}.`,
        { cause },
      );
    }
  }

  /** A loaded pair must at least carry an access token; a partial file is AUTH-9. */
  function assertUsable(loaded: TokenPair): void {
    if (typeof loaded.access_token !== 'string' || loaded.access_token === '') {
      throw authError(
        `Stored OAuth token data is missing an access token (partial or corrupt token store); ${REAUTHORIZE_HINT}.`,
      );
    }
  }

  /**
   * The single-flight entry (§4A REFRESH step 1): joiners share the one in-flight
   * promise; only the first caller runs the critical section (AUTH-2, CONC-1).
   */
  function runRefresh(unauthorizedToken?: string): Promise<string> {
    if (inFlight !== null) return inFlight;
    const flight = doRefresh(unauthorizedToken).finally(() => {
      inFlight = null;
      phase = null;
    });
    inFlight = flight;
    return flight;
  }

  /** The §4A critical section: lock → reload → adopt-or-refresh → persist-before-use. */
  async function doRefresh(unauthorizedToken?: string): Promise<string> {
    phase = 'REFRESH';
    return config.store.withLock(async () => {
      // §4A step 3 — reload under the lock (AUTH-3/AUTH-4).
      const disk = await loadFromStore();
      if (disk !== null) assertUsable(disk);
      const memory = pair;

      if (disk !== null) {
        const diskDiffers =
          memory === null ||
          disk.access_token !== memory.access_token ||
          disk.refresh_token !== memory.refresh_token;
        if (diskDiffers && disk.access_token !== unauthorizedToken) {
          // ADOPTED (AUTH-3): a peer already rotated — adopt its pair and skip the
          // refresh HTTP call entirely. This is the rule that prevents burning a peer's
          // rotation.
          phase = 'ADOPTED';
          pair = disk;
          return disk.access_token;
        }
      }

      // The on-disk pair matches what we know (or only its refresh token is newer) —
      // refresh from the persisted truth, falling back to memory if the file vanished.
      const base = disk ?? memory;
      if (base === null) {
        throw authError(`No stored OAuth tokens to refresh; ${REAUTHORIZE_HINT}.`);
      }
      const refreshToken = refreshTokenOf(base);
      if (refreshToken === undefined) {
        // AUTH-10: nothing to refresh with. Not terminal — a peer or the operator can
        // re-authorize on the same store and the next reload will find the new pair.
        throw authError(
          `The access token was rejected and no refresh token is stored, so it cannot be renewed; ${REAUTHORIZE_HINT}.`,
        );
      }

      // §4A step 4 — the refresh HTTP call (timeout enforced by the T-203 callable).
      let result: RefreshHttpResult;
      try {
        result = await config.refreshHttp(refreshToken);
      } catch (cause) {
        // No response arrived: the stored tokens are unchanged, so a later attempt is a
        // FIRST refresh again, not a double-spend. A thrown XError (e.g. T-203 mapping an
        // ambiguous mid-flight timeout) passes through with its own classification.
        if (XError.is(cause)) throw cause;
        throw networkError(
          'Token refresh did not complete (transport failure before any response); the stored tokens are unchanged and refresh may be retried.',
          { cause },
        );
      }

      if (!result.ok) {
        if (result.status >= 500) {
          // Transient server failure: nothing rotated, safe to try again later.
          throw apiError(
            `The token endpoint failed transiently (HTTP ${result.status}); the stored tokens are unchanged and refresh may be retried.`,
            { retryable: true, data: { http_status: result.status } },
          );
        }
        // Rejected (invalid_grant / 400 / 401 / other 4xx) → terminal, no retry loop (AUTH-8).
        // REND-6/REND-7: `error` and `error_description` are token-endpoint prose off the
        // wire, so they get the same strip-and-cap as any other third-party text before they
        // reach the agent — in `data` AND in the sentence below, which interpolates the
        // former. A hostile or misconfigured token endpoint (docs/04 base-URL confusion)
        // otherwise owns an unbounded, unsanitized channel into the planner's context.
        const platformError = sanitizePlatformText(result.error);
        const platformDetail = sanitizePlatformText(result.error_description);
        const grant = platformError === undefined ? '' : ` (${platformError})`;
        failClosed(
          authError(
            `X rejected the stored refresh token${grant}; re-authorization is required — ${REAUTHORIZE_HINT}.`,
            {
              data: {
                http_status: result.status,
                ...(platformError === undefined ? {} : { platform_title: platformError }),
                ...(platformDetail === undefined ? {} : { platform_detail: platformDetail }),
              },
            },
          ),
        );
      }

      const token = result.token;
      if (typeof token.access_token !== 'string' || token.access_token === '') {
        // A 200 without a usable access token: the old refresh token may or may not have
        // been spent server-side — ambiguity fails closed (§4A invariant 5).
        failClosed(
          authError(
            `Token refresh returned no usable access token; the account state is ambiguous — ${REAUTHORIZE_HINT}.`,
          ),
        );
      }
      if (unauthorizedToken !== undefined && token.access_token === unauthorizedToken) {
        // The endpoint echoed the very token that just got a 401. Handing it back would
        // let the caller's retry loop spin into repeated refreshes — fail closed instead.
        failClosed(
          authError(
            `Token refresh returned the same access token that was just rejected; the account state is ambiguous — ${REAUTHORIZE_HINT}.`,
          ),
        );
      }

      // Non-rotating tolerance (AUTH-6): keep the old refresh token unless the response
      // carries a (possibly identical) new one. `expires_in` may be absent → NaN, which
      // `hasKnownLifetime` reads as unknown, disabling eager refresh for the new pair
      // (AUTH-11).
      const expiresIn = token.expires_in;
      const next: TokenPair = {
        access_token: token.access_token,
        refresh_token:
          typeof token.refresh_token === 'string' && token.refresh_token !== ''
            ? token.refresh_token
            : refreshToken,
        obtained_at: config.clock.now(),
        expires_in:
          typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
            ? expiresIn
            : Number.NaN,
        version: (base.version ?? 0) + 1,
      };

      // §4A step 5 — persist-before-use (AUTH-1). Only `TokenStore.persist` ever writes
      // (atomicity + 0600 are the file store's contract, T-202 / AUTH-12).
      phase = 'PERSISTING';
      try {
        await config.store.persist(next);
      } catch (cause) {
        // The rotation happened server-side but could not be saved. Using it would break
        // persist-before-use; NOT failing closed would let a later reload refresh with
        // the old — now burned — refresh token. Terminal (AUTH-1).
        failClosed(
          authError(
            `A rotated token could not be persisted; refusing to use an unsaved rotation — ${REAUTHORIZE_HINT}.`,
            { cause },
          ),
        );
      }
      pair = next;
      return next.access_token;
    });
  }

  async function getAccessToken(): Promise<string> {
    if (terminal !== null) throw terminal;
    // Join any in-flight refresh instead of racing it (AUTH-2/CONC-1) — the freshly
    // rotated token is what this caller should use anyway.
    if (inFlight !== null) return inFlight;

    if (pair === null) {
      const loaded = await loadFromStore();
      if (loaded === null) {
        // Not terminal: `authorize` can run at any time and the next call re-reads.
        throw authError(`No stored OAuth tokens were found; ${REAUTHORIZE_HINT}.`);
      }
      assertUsable(loaded);
      pair = loaded;
    }

    const current = pair;
    // UNKNOWN_LIFETIME (AUTH-11): eager refresh disabled; the reactive 401 path rules.
    if (!hasKnownLifetime(current)) return current.access_token;

    const remaining = remainingLifeMs(current, config.clock.now());
    if (remaining > EAGER_REFRESH_MARGIN_MS) return current.access_token; // VALID

    // EAGER (AUTH-7): ≤ 5 min left.
    if (refreshTokenOf(current) === undefined) {
      // AUTH-10: no refresh token — the access token stays usable until it actually
      // expires; only then is re-authorization the answer.
      if (remaining > 0) return current.access_token;
      throw authError(
        `The access token has expired and no refresh token is stored, so it cannot be renewed; ${REAUTHORIZE_HINT}.`,
      );
    }
    return runRefresh();
  }

  async function handleUnauthorized(unauthorizedAccessToken: string): Promise<string> {
    if (terminal !== null) throw terminal;

    if (inFlight !== null) {
      // A refresh is already running — await it (AUTH-2). Its outcome must differ from
      // the rejected token; if a completed refresh still yields the rejected token,
      // nothing changed and retrying would spin (§4A invariant 5).
      const token = await inFlight;
      if (token !== unauthorizedAccessToken) return token;
      failClosed(
        authError(
          `A completed token refresh still yields the rejected access token; the account state is ambiguous — ${REAUTHORIZE_HINT}.`,
        ),
      );
    }

    phase = 'REACTIVE';
    if (pair !== null && pair.access_token !== unauthorizedAccessToken) {
      // This process already rotated/adopted since the 401'd request took its token —
      // the current pair IS the recovery; no reload or refresh needed (no refresh will
      // be issued, so reload-on-401 has nothing to protect here).
      phase = null;
      return pair.access_token;
    }
    // Reload-on-401 (AUTH-4): the decision to refresh is only ever made after the
    // under-lock reload inside the critical section.
    return runRefresh(unauthorizedAccessToken);
  }

  function state(): MachineState {
    if (terminal !== null) return 'FAILED_CLOSED';
    if (phase !== null) return phase;
    if (pair === null) return 'VALID'; // the diagram's start state; nothing loaded yet
    if (!hasKnownLifetime(pair)) return 'UNKNOWN_LIFETIME';
    return remainingLifeMs(pair, config.clock.now()) <= EAGER_REFRESH_MARGIN_MS ? 'EAGER' : 'VALID';
  }

  return { getAccessToken, handleUnauthorized, state };
}
