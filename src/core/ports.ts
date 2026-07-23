// Injection seams — FROZEN CONTRACT (docs/02 §3, §4A). Owned by T-102.
//
// Every source of non-determinism and every side effect that `core` must stay free of
// is expressed as a port here. Production adapters live in `api`/`cli`; tests inject
// fakes (test/helpers, T-103). `core` logic takes these as parameters — it never reads
// the clock, the RNG, the disk, or the network directly. This is what makes the request
// pipeline unit-testable without a live X account.
//
// This module is dependency-free: it imports nothing. `undici` stays a dev-only
// dependency — production uses Node's global `fetch` with the default dispatcher (which
// ignores proxy env vars, satisfying the proxy-ignore requirement, CFG-7).

/**
 * The HTTP dispatcher injection seam. Derived STRUCTURALLY from global `fetch` itself, so
 * there is no `undici` / `undici-types` version skew: it is, by definition, exactly what
 * `fetch`'s `dispatcher` option accepts. Production leaves it undefined (default
 * dispatcher); tests pass an undici `MockAgent`. `core` only forwards it — the concrete
 * wiring lives in api/http (T-114).
 */
export type Dispatcher = NonNullable<NonNullable<Parameters<typeof fetch>[1]>['dispatcher']>;

/** Wall clock. `now()` is epoch milliseconds. The only time source in the system. */
export interface Clock {
  now(): number;
}

/**
 * Cancellable delay. Used for GET retry backoff and the refresh state machine.
 * A fake in tests resolves instantly (or on a manual tick) so no test really waits.
 */
export type Sleep = (ms: number) => Promise<void>;

/**
 * All randomness: retry jitter, PKCE verifier, OAuth CSRF `state`, DM idempotency keys.
 * Split out so tests are fully deterministic.
 */
export interface Random {
  /** Uniform float in [0, 1). */
  float(): number;
  /** RFC-4122 v4 UUID. */
  uuid(): string;
  /** `n` cryptographically-random bytes (PKCE verifier, CSRF state). */
  bytes(n: number): Uint8Array;
}

/**
 * A persisted OAuth2 token pair. `obtained_at` + `expires_in` drive proactive refresh;
 * `refresh_token` is absent for app-only/bearer modes. `version` supports the
 * adopt-on-disk-pair reconciliation in the refresh machine (docs/02 §4A).
 */
export interface TokenPair {
  readonly access_token: string;
  readonly refresh_token?: string;
  /** Epoch ms the pair was minted (per this process's Clock). */
  readonly obtained_at: number;
  /** Access-token lifetime in seconds, as reported by X. */
  readonly expires_in: number;
  /** Monotonic on-disk revision; bumped on every persist. */
  readonly version?: number;
}

/**
 * The token persistence + cross-process locking seam (docs/02 §4A). Implemented by the
 * encrypted file store / keychain adapter (T-202); the in-memory refresh state machine
 * (T-201) sits above it. `withLock` provides the single-flight guarantee — exactly one
 * refresh runs for N concurrent 401s; it must fail-closed on a live foreign lock and
 * detect stale locks (PID + timestamp).
 */
export interface TokenStore {
  /** Read the current pair, or `null` if none is persisted yet. */
  load(): Promise<TokenPair | null>;
  /** Atomically replace the persisted pair (write-temp-then-rename). */
  persist(pair: TokenPair): Promise<void>;
  /** Run `fn` holding the exclusive refresh lock; releases even if `fn` throws. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * The full set of ambient capabilities threaded through the request pipeline. The
 * composition root (T-130) builds this once from real adapters; tests build it from
 * fakes. Bundling them keeps handler signatures stable as new seams are added.
 */
export interface Ports {
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly random: Random;
  readonly tokens: TokenStore;
  readonly dispatcher?: Dispatcher;
}
