// Tests for the header-driven rate-limit tracker + preflight (T-115, src/api/ratelimit.ts).
// Cases: RATE-1…7, CONC-3, and PLAT-4 (docs/07-corner-cases.md §4, §13, §15). Time is driven
// exclusively by the injected fake Clock — the tracker never reads the wall clock.

import test from 'node:test';
import assert from 'node:assert/strict';

import { fakeClock } from '../helpers/index.js';
import { XError } from '../../src/core/errors.js';
import { createRateLimitTracker, rateLimitKey } from '../../src/api/ratelimit.js';

/** Standard-window headers. `resetInMs` is relative to the given clock. */
function stdHeaders(
  clock: { now(): number },
  opts: { limit?: number; remaining: number; resetInMs: number },
): Record<string, string> {
  const resetSec = Math.floor((clock.now() + opts.resetInMs) / 1000);
  const h: Record<string, string> = {
    'x-rate-limit-remaining': String(opts.remaining),
    'x-rate-limit-reset': String(resetSec),
  };
  if (opts.limit !== undefined) h['x-rate-limit-limit'] = String(opts.limit);
  return h;
}

test('RATE-1: app and user buckets for the same endpoint are isolated', () => {
  const clock = fakeClock();
  const rl = createRateLimitTracker(clock);
  const userKey = rateLimitKey('POST /2/tweets', 'user');
  const appKey = rateLimitKey('POST /2/tweets', 'app');

  // Exhaust only the user-context bucket.
  rl.record(userKey, stdHeaders(clock, { limit: 100, remaining: 0, resetInMs: 60_000 }));
  rl.record(appKey, stdHeaders(clock, { limit: 100, remaining: 42, resetInMs: 60_000 }));

  assert.ok(rl.preflight(userKey) instanceof XError, 'user bucket is blocked');
  assert.equal(rl.preflight(appKey), null, 'app bucket is untouched and allowed');

  // Distinct keys prove the (endpoint × auth-context) tuple is what buckets on.
  assert.notEqual(userKey, appKey);
});

test('RATE-2: remaining=0 with a future reset refuses locally with reset_at + retry_after', () => {
  const clock = fakeClock();
  const rl = createRateLimitTracker(clock);
  const key = rateLimitKey('GET /2/tweets', 'user');
  rl.record(key, stdHeaders(clock, { limit: 15, remaining: 0, resetInMs: 30_000 }));

  const err = rl.preflight(key);
  assert.ok(err instanceof XError);
  assert.equal(err.kind, 'rate-limit');
  assert.equal(err.retryable, true);
  assert.equal(err.fix, 'agent');
  assert.equal(err.data.retry_after_seconds, 30);
  assert.equal(err.data.reset_at, new Date(clock.now() + 30_000).toISOString());
  // No HTTP was performed — the refusal came purely from tracked state.
});

test('RATE-3: a past (or within-skew) reset proceeds; the 5 s skew boundary is honored', () => {
  const clock = fakeClock();
  const rl = createRateLimitTracker(clock);
  const key = rateLimitKey('GET /2/users', 'user');

  // Reset already 1 s in the past → window presumed renewed → allowed.
  rl.record(key, stdHeaders(clock, { limit: 15, remaining: 0, resetInMs: -1_000 }));
  assert.equal(rl.preflight(key), null, 'past reset proceeds');

  // Reset 3 s ahead → inside the 5 s skew allowance → allowed.
  rl.record(key, stdHeaders(clock, { limit: 15, remaining: 0, resetInMs: 3_000 }));
  assert.equal(rl.preflight(key), null, 'within-skew reset proceeds');

  // Reset 10 s ahead → clearly future → blocked.
  rl.record(key, stdHeaders(clock, { limit: 15, remaining: 0, resetInMs: 10_000 }));
  assert.ok(rl.preflight(key) instanceof XError, 'future reset blocks');
});

test('RATE-3: advancing the clock past a recorded reset flips block → allow (Clock-only time)', () => {
  const clock = fakeClock();
  const rl = createRateLimitTracker(clock);
  const key = rateLimitKey('GET /2/tweets', 'app');
  rl.record(key, stdHeaders(clock, { limit: 15, remaining: 0, resetInMs: 20_000 }));
  assert.ok(rl.preflight(key) instanceof XError);

  clock.advance(20_000); // now == reset → beyond `reset − 5 s`
  assert.equal(rl.preflight(key), null);
});

test('PLAT-4: sleep/resume — a multi-hour one-step clock jump is recomputed on next use; the expired window no longer blocks', () => {
  const clock = fakeClock();
  const rl = createRateLimitTracker(clock);
  const key = rateLimitKey('GET /2/tweets', 'user');

  // A drained window resetting in the near future: preflight refuses locally.
  rl.record(key, stdHeaders(clock, { limit: 15, remaining: 0, resetInMs: 60_000 }));
  assert.ok(rl.preflight(key) instanceof XError, 'blocked before the sleep');

  // The laptop sleeps; on resume the Clock has jumped 6 hours in ONE step. The tracker
  // holds no timers — block/allow is recomputed from the injected Clock at the point of
  // use, so the long-expired window simply no longer blocks.
  clock.advance(6 * 3_600_000);
  assert.equal(rl.preflight(key), null, 'the pre-sleep window is expired, not stale-blocking');
  assert.equal(rl.retryDelayMs(key), 0, 'no residual delay from the pre-sleep reset');

  // The status dump reflects the same recomputation (not the stale pre-sleep view).
  const win = rl.status().buckets.find((b) => b.key === key)?.windows[0];
  assert.equal(win?.exhausted, false);
  assert.equal(win?.seconds_until_reset, 0);
});

test('RATE-4: a response without rate-limit headers leaves tracked state unchanged', () => {
  const clock = fakeClock();
  const rl = createRateLimitTracker(clock);
  const key = rateLimitKey('GET /2/tweets', 'user');

  rl.record(key, stdHeaders(clock, { limit: 15, remaining: 0, resetInMs: 60_000 }));
  assert.ok(rl.preflight(key) instanceof XError);

  // A header-less response must not crash, reset to zero, or clear exhaustion.
  rl.record(key, { 'content-type': 'application/json' });
  assert.ok(rl.preflight(key) instanceof XError, 'prior exhausted state survives');

  // An unknown bucket has no state and preflights clean.
  assert.equal(rl.preflight(rateLimitKey('GET /2/never', 'user')), null);
});

test('RATE-4: blank, negative and non-integer header values are treated as absent, not as zero', () => {
  const clock = fakeClock();
  const rl = createRateLimitTracker(clock);
  const key = rateLimitKey('GET /2/tweets', 'user');
  const resetSec = String(Math.floor((clock.now() + 60_000) / 1000));

  // Start from a known exhausted window so a wrongly-parsed value would visibly change state.
  rl.record(key, stdHeaders(clock, { limit: 15, remaining: 0, resetInMs: 60_000 }));
  assert.ok(rl.preflight(key) instanceof XError);

  // A malformed `remaining` or `reset` makes the window unparsable, so the response is ignored
  // exactly like a header-less one: no crash, no reset to zero, no clearing of exhaustion.
  for (const bad of ['', '   ', '-1', '12.5', 'abc']) {
    rl.record(key, {
      'x-rate-limit-limit': '15',
      'x-rate-limit-remaining': bad,
      'x-rate-limit-reset': resetSec,
    });
    rl.record(key, {
      'x-rate-limit-limit': '15',
      'x-rate-limit-remaining': '9',
      'x-rate-limit-reset': bad,
    });
  }
  assert.ok(rl.preflight(key) instanceof XError, 'prior exhausted state survives');
  const win = rl.status().buckets.find((b) => b.key === key)?.windows[0];
  assert.equal(win?.remaining, 0, 'remaining was not overwritten by a malformed response');
  assert.equal(win?.limit, 15);

  // A malformed `retry-after` on a header-less 429 synthesizes nothing: there is no delay for
  // the RATE-5 GET retry to act on, and no window to refuse the next call.
  const fresh = rateLimitKey('GET /2/users', 'user');
  rl.record(fresh, { 'retry-after': '-5' }, 429);
  assert.equal(rl.retryDelayMs(fresh), null);
  assert.equal(rl.preflight(fresh), null);
});

test('RATE-5: a 429 with only retry-after synthesizes an exhausted window; retryDelayMs feeds the http GET-retry-within-5s decision', () => {
  const clock = fakeClock();
  const rl = createRateLimitTracker(clock);

  // Reset ≤ 5 s away: api/http (T-114) retries a GET once after sleeping this delay (writes
  // never — enforced there). Within the 5 s skew, preflight itself does not block (RATE-3) —
  // the ≤ 5 s case is handled by the http retry, driven by retryDelayMs, not by refusal.
  const near = rateLimitKey('GET /2/tweets', 'user');
  rl.record(near, { 'retry-after': '3' }, 429);
  assert.equal(rl.retryDelayMs(near), 3_000);

  // Reset > 5 s away: no cheap retry; the synthesized exhausted window refuses further calls.
  const far = rateLimitKey('GET /2/users', 'user');
  rl.record(far, { 'retry-after': '120' }, 429);
  assert.equal(rl.retryDelayMs(far), 120_000);
  assert.ok(rl.preflight(far) instanceof XError, 'headerless 429 refuses future calls');

  // A 429 forces remaining to 0 even if the header still claims capacity.
  const stale = rateLimitKey('GET /2/lists', 'user');
  rl.record(stale, stdHeaders(clock, { limit: 15, remaining: 9, resetInMs: 30_000 }), 429);
  assert.ok(rl.preflight(stale) instanceof XError, '429 overrides a stale positive remaining');
});

test('RATE-5/RATE-7: a 429 with x-rate-limit-* headers is drained at the header reset, or at the later of it and retry-after when both are present', () => {
  const clock = fakeClock();
  const rl = createRateLimitTracker(clock);

  // Standard headers only: remaining is forced to 0 at exactly the header's reset instant.
  const keyA = rateLimitKey('GET /2/tweets', 'user');
  rl.record(keyA, stdHeaders(clock, { limit: 15, remaining: 9, resetInMs: 30_000 }), 429);
  const winA = rl.status().buckets.find((b) => b.key === keyA)?.windows[0];
  assert.equal(winA?.remaining, 0, '429 overrides the positive remaining header');
  assert.equal(winA?.limit, 15, 'the ceiling is carried over');
  assert.equal(rl.retryDelayMs(keyA), 30_000);

  // retry-after is later than the reset header: the window is drained until retry-after.
  const keyB = rateLimitKey('GET /2/users', 'user');
  rl.record(
    keyB,
    { ...stdHeaders(clock, { limit: 15, remaining: 9, resetInMs: 10_000 }), 'retry-after': '60' },
    429,
  );
  const errB = rl.preflight(keyB);
  assert.ok(errB instanceof XError);
  assert.equal(errB.data.retry_after_seconds, 60);
  assert.equal(rl.retryDelayMs(keyB), 60_000);

  // reset header is later than retry-after: the reset header wins, remaining is still 0.
  const keyC = rateLimitKey('GET /2/lists', 'user');
  rl.record(
    keyC,
    { ...stdHeaders(clock, { limit: 15, remaining: 9, resetInMs: 90_000 }), 'retry-after': '10' },
    429,
  );
  const errC = rl.preflight(keyC);
  assert.ok(errC instanceof XError);
  assert.equal(errC.data.retry_after_seconds, 90);
  const winC = rl.status().buckets.find((b) => b.key === keyC)?.windows[0];
  assert.equal(winC?.remaining, 0);
  assert.equal(winC?.limit, 15);
});

test('RATE-6: dual windows tracked; refusal names whichever window is exhausted', () => {
  const clock = fakeClock();
  const rl = createRateLimitTracker(clock);
  const key = rateLimitKey('POST /2/tweets', 'user');
  const appResetSec = Math.floor((clock.now() + 3_600_000) / 1000);

  // 15-min window has room, but the 24-h app cap is drained.
  rl.record(key, {
    ...stdHeaders(clock, { limit: 100, remaining: 50, resetInMs: 600_000 }),
    'x-app-limit-24hour-limit': '10000',
    'x-app-limit-24hour-remaining': '0',
    'x-app-limit-24hour-reset': String(appResetSec),
  });

  const err = rl.preflight(key);
  assert.ok(err instanceof XError);
  assert.match(err.message, /24-hour app window/);

  // Both windows show in the status dump (for x_rate_limit_status, T-120).
  const bucket = rl.status().buckets.find((b) => b.key === key);
  assert.equal(bucket?.windows.length, 2);
  assert.deepEqual(bucket?.windows.map((w) => w.kind).sort(), ['app-24h', 'standard']);

  // Now the 15-minute window is the exhausted one → the message names it instead.
  const key2 = rateLimitKey('POST /2/likes', 'user');
  rl.record(key2, {
    ...stdHeaders(clock, { limit: 100, remaining: 0, resetInMs: 600_000 }),
    'x-app-limit-24hour-limit': '10000',
    'x-app-limit-24hour-remaining': '5000',
    'x-app-limit-24hour-reset': String(appResetSec),
  });
  const err2 = rl.preflight(key2);
  assert.ok(err2 instanceof XError);
  assert.match(err2.message, /15-minute window/);
});

test('RATE-6: with BOTH windows exhausted the refusal names the one that resets latest', () => {
  const clock = fakeClock();
  const rl = createRateLimitTracker(clock);

  // The 24-h app window resets AFTER the 15-min one: the agent has to wait for the app window.
  const keyA = rateLimitKey('POST /2/tweets', 'user');
  rl.record(keyA, {
    ...stdHeaders(clock, { limit: 100, remaining: 0, resetInMs: 600_000 }),
    'x-app-limit-24hour-limit': '10000',
    'x-app-limit-24hour-remaining': '0',
    'x-app-limit-24hour-reset': String(Math.floor((clock.now() + 3_600_000) / 1000)),
  });
  const errA = rl.preflight(keyA);
  assert.ok(errA instanceof XError);
  assert.match(errA.message, /24-hour app window/);
  assert.equal(errA.data.retry_after_seconds, 3_600);

  // The 24-h app window resets BEFORE the 15-min one: the 15-min window is the binding one.
  const keyB = rateLimitKey('POST /2/likes', 'user');
  rl.record(keyB, {
    ...stdHeaders(clock, { limit: 100, remaining: 0, resetInMs: 600_000 }),
    'x-app-limit-24hour-limit': '10000',
    'x-app-limit-24hour-remaining': '0',
    'x-app-limit-24hour-reset': String(Math.floor((clock.now() + 60_000) / 1000)),
  });
  const errB = rl.preflight(keyB);
  assert.ok(errB instanceof XError);
  assert.match(errB.message, /15-minute window/);
  assert.equal(errB.data.retry_after_seconds, 600);
});

test('RATE-6/RATE-5: an app-24h-only bucket has no standard window; retryDelayMs is null and the status omits an unreported limit', () => {
  const clock = fakeClock();
  const rl = createRateLimitTracker(clock);
  const key = rateLimitKey('POST /2/tweets', 'app');
  const appResetSec = Math.floor((clock.now() + 3_600_000) / 1000);

  // Only the 24-hour app family, and without its `-limit` header.
  rl.record(key, {
    'x-app-limit-24hour-remaining': '0',
    'x-app-limit-24hour-reset': String(appResetSec),
  });

  // The bucket exists and blocks on the app window, but there is no 15-minute reset for the
  // http GET-retry decision to read: null, not 0 (which would mean "retry right away").
  const err = rl.preflight(key);
  assert.ok(err instanceof XError);
  assert.match(err.message, /24-hour app window/);
  assert.equal(rl.retryDelayMs(key), null);

  // The status window (for x_rate_limit_status, T-120) carries no `limit` key at all, never an
  // `undefined`-valued one.
  assert.deepEqual(rl.status().buckets, [
    {
      key,
      windows: [
        {
          kind: 'app-24h',
          remaining: 0,
          reset_at: new Date(appResetSec * 1000).toISOString(),
          seconds_until_reset: 3_600,
          exhausted: true,
        },
      ],
    },
  ]);
});

test('RATE-7: retry-after vs x-rate-limit-reset disagreement — the later time wins', () => {
  const clock = fakeClock();

  // retry-after is later than the reset header → retry-after wins.
  const rlA = createRateLimitTracker(clock);
  const keyA = rateLimitKey('GET /2/tweets', 'user');
  rlA.record(keyA, {
    ...stdHeaders(clock, { remaining: 0, resetInMs: 10_000 }),
    'retry-after': '60',
  });
  const errA = rlA.preflight(keyA);
  assert.ok(errA instanceof XError);
  assert.equal(errA.data.retry_after_seconds, 60);

  // reset header is later than retry-after → the reset header wins.
  const rlB = createRateLimitTracker(clock);
  const keyB = rateLimitKey('GET /2/users', 'user');
  rlB.record(keyB, {
    ...stdHeaders(clock, { remaining: 0, resetInMs: 90_000 }),
    'retry-after': '10',
  });
  const errB = rlB.preflight(keyB);
  assert.ok(errB instanceof XError);
  assert.equal(errB.data.retry_after_seconds, 90);
});

test('RATE-2 boundary: remaining=1 allows, remaining=0 blocks at the same reset', () => {
  const clock = fakeClock();
  const rl = createRateLimitTracker(clock);
  const key = rateLimitKey('GET /2/tweets', 'user');

  rl.record(key, stdHeaders(clock, { limit: 15, remaining: 1, resetInMs: 60_000 }));
  assert.equal(rl.preflight(key), null, 'one call left → proceed');

  rl.record(key, stdHeaders(clock, { limit: 15, remaining: 0, resetInMs: 60_000 }));
  assert.ok(rl.preflight(key) instanceof XError, 'zero left → refuse');
});

test('CONC-3: out-of-order updates merge last-reset-wins; stale data never overwrites newer', () => {
  const clock = fakeClock();
  const rl = createRateLimitTracker(clock);
  const key = rateLimitKey('GET /2/tweets', 'user');

  // Newer window (later reset) recorded first, then an older/stale response arrives after it.
  rl.record(key, stdHeaders(clock, { limit: 15, remaining: 3, resetInMs: 900_000 }));
  const newerResetSec = Math.floor((clock.now() + 900_000) / 1000);

  // Stale response: an EARLIER reset window — must be ignored, not overwrite the newer one.
  rl.record(key, stdHeaders(clock, { limit: 15, remaining: 14, resetInMs: 60_000 }));

  const win = rl.status().buckets.find((b) => b.key === key)?.windows[0];
  assert.equal(win?.remaining, 3, 'newer window remaining preserved');
  assert.equal(
    win?.reset_at,
    new Date(newerResetSec * 1000).toISOString(),
    'newer reset preserved',
  );

  // Same-reset responses keep the LOWER remaining (most consumption seen wins the race).
  rl.record(key, stdHeaders(clock, { limit: 15, remaining: 1, resetInMs: 900_000 }));
  rl.record(key, stdHeaders(clock, { limit: 15, remaining: 9, resetInMs: 900_000 }));
  const win2 = rl.status().buckets.find((b) => b.key === key)?.windows[0];
  assert.equal(win2?.remaining, 1, 'equal-reset merge keeps the lower remaining');
});

test('CONC-3: an equal-reset merge adopts a newly reported limit and keeps it when a later response omits it', () => {
  const clock = fakeClock();
  const rl = createRateLimitTracker(clock);
  const key = rateLimitKey('GET /2/tweets', 'user');

  // First sighting of the window carries no ceiling; the next one for the SAME reset reports it.
  rl.record(key, stdHeaders(clock, { remaining: 5, resetInMs: 900_000 }));
  assert.ok(!('limit' in (rl.status().buckets[0]?.windows[0] ?? {})), 'no ceiling known yet');
  rl.record(key, stdHeaders(clock, { limit: 15, remaining: 4, resetInMs: 900_000 }));
  const win = rl.status().buckets.find((b) => b.key === key)?.windows[0];
  assert.equal(win?.limit, 15, 'a later-reported limit is adopted');
  assert.equal(win?.remaining, 4);

  // A further limit-less response for the same window must not drop the known ceiling.
  rl.record(key, stdHeaders(clock, { remaining: 3, resetInMs: 900_000 }));
  const win2 = rl.status().buckets.find((b) => b.key === key)?.windows[0];
  assert.equal(win2?.limit, 15, 'stored limit survives a limit-less response');
  assert.equal(win2?.remaining, 3, 'lower remaining still wins');
});

test('accepts a WHATWG Headers-like source and reports status seconds via the Clock', () => {
  const clock = fakeClock();
  const rl = createRateLimitTracker(clock);
  const key = rateLimitKey('GET /2/tweets', 'user');

  // `.get`-style source (case-insensitive), exercising the Headers branch of the parser.
  const resetSec = Math.floor((clock.now() + 45_000) / 1000);
  const map: Record<string, string> = {
    'x-rate-limit-limit': '15',
    'x-rate-limit-remaining': '0',
    'x-rate-limit-reset': String(resetSec),
  };
  rl.record(key, { get: (name) => map[name.toLowerCase()] ?? null });

  const win = rl.status().buckets[0]?.windows[0];
  assert.equal(win?.kind, 'standard');
  assert.equal(win?.limit, 15);
  assert.equal(win?.remaining, 0);
  assert.equal(win?.exhausted, true);
  assert.equal(win?.seconds_until_reset, 45);
  assert.ok(rl.preflight(key) instanceof XError);
});
