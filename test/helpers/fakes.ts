// Deterministic port fakes — the T-103 test harness. These let the whole request
// pipeline run under `node --test` with no real clock, RNG, disk, or network, so tests
// are fast and reproducible. Every fake implements a frozen port from src/core/ports.ts.

import type { Clock, Ports, Random, Sleep, TokenPair, TokenStore } from '../../src/core/ports.js';

/** A clock the test drives by hand. `advance(ms)` moves time forward deterministically. */
export interface FakeClock extends Clock {
  advance(ms: number): void;
  set(epochMs: number): void;
}

export function fakeClock(startEpochMs = 1_700_000_000_000): FakeClock {
  let t = startEpochMs;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (epochMs) => {
      t = epochMs;
    },
  };
}

/**
 * A `Sleep` that never really waits. It records each requested duration and, if given a
 * clock, advances it — so backoff logic is exercised without wall-clock delay.
 */
export interface FakeSleep {
  readonly fn: Sleep;
  readonly calls: readonly number[];
}

export function fakeSleep(clock?: FakeClock): FakeSleep {
  const calls: number[] = [];
  const fn: Sleep = (ms) => {
    calls.push(ms);
    clock?.advance(ms);
    return Promise.resolve();
  };
  return { fn, calls };
}

/**
 * A `Random` with a fixed, repeatable stream. `float()` cycles a supplied sequence;
 * `uuid()` counts up; `bytes()` fills a deterministic ramp. Never use in production.
 */
export function fakeRandom(floats: readonly number[] = [0.42]): Random {
  let fi = 0;
  let uu = 0;
  return {
    float: () => {
      const v = floats[fi % floats.length] ?? 0;
      fi += 1;
      return v;
    },
    uuid: () => {
      uu += 1;
      // Deterministic v4-shaped id: 8-4-4-4-12 hex, seeded by the counter.
      const h = uu.toString(16).padStart(12, '0');
      return `00000000-0000-4000-8000-${h}`;
    },
    bytes: (n) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) out[i] = (i * 31 + 7) & 0xff;
      return out;
    },
  };
}

/**
 * An in-memory `TokenStore` with a real single-flight lock, so refresh-machine tests can
 * assert "one refresh for N concurrent 401s" without touching disk. `withLock` serializes
 * via a promise chain; `persistCount` and `loadCount` expose call counts for assertions.
 */
export interface InMemoryTokenStore extends TokenStore {
  seed(pair: TokenPair | null): void;
  readonly persistCount: () => number;
  readonly loadCount: () => number;
}

export function inMemoryTokenStore(initial: TokenPair | null = null): InMemoryTokenStore {
  let pair = initial;
  let persists = 0;
  let loads = 0;
  let chain: Promise<unknown> = Promise.resolve();

  return {
    load: () => {
      loads += 1;
      return Promise.resolve(pair);
    },
    persist: (next) => {
      persists += 1;
      pair = next;
      return Promise.resolve();
    },
    withLock: <T>(fn: () => Promise<T>): Promise<T> => {
      const run = chain.then(fn, fn);
      // Keep the chain alive regardless of fn's outcome, without unhandled rejections.
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    seed: (p) => {
      pair = p;
    },
    persistCount: () => persists,
    loadCount: () => loads,
  };
}

/** Overrides for {@link makePorts}. */
export interface FakePortsOptions {
  readonly clock?: FakeClock;
  readonly sleep?: FakeSleep;
  readonly random?: Random;
  readonly tokens?: InMemoryTokenStore;
  readonly dispatcher?: Ports['dispatcher'];
}

/** Assemble a full {@link Ports} bundle from fakes, wiring sleep→clock by default. */
export function makePorts(opts: FakePortsOptions = {}): Ports {
  const clock = opts.clock ?? fakeClock();
  const sleep = opts.sleep ?? fakeSleep(clock);
  const base = {
    clock,
    sleep: sleep.fn,
    random: opts.random ?? fakeRandom(),
    tokens: opts.tokens ?? inMemoryTokenStore(),
  };
  return opts.dispatcher === undefined ? base : { ...base, dispatcher: opts.dispatcher };
}
