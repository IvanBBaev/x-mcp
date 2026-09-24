// Tests for core/timebounds (REND-9) — the shared `start_time`/`end_time` normalizer used
// by every tool that accepts a time window (timelines, recent/archive search, recent/archive
// counts). Pure unit tests: `normalizeTimeBounds` takes `now` as a plain number, so every
// case below is deterministic with no clock or HTTP fake needed. The per-tool wiring (the
// clamp actually reaching the wire, and the note landing on the rendered page) is covered by
// the handler-level tests in test/tools/{timelines,search,archive}.test.ts.

import test from 'node:test';
import assert from 'node:assert/strict';

import { XError } from '../../src/core/errors.js';
import { END_TIME_MIN_AGE_MS, normalizeTimeBounds } from '../../src/core/timebounds.js';

const NOW_ISO = '2026-07-30T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const CUTOFF_MS = NOW_MS - END_TIME_MIN_AGE_MS;
const CUTOFF_ISO = new Date(CUTOFF_MS).toISOString();

test('END_TIME_MIN_AGE_MS is 10 seconds, per REND-9', () => {
  assert.equal(END_TIME_MIN_AGE_MS, 10_000);
});

// --- Sweep: every combination of bound presence / distance from `now` ------------------
// One table drives both the returned {startTime, endTime} and whether a clamp note fires,
// so a regression in either the boundary math or the note wording shows up as a row diff.
const SWEEP: ReadonlyArray<{
  readonly name: string;
  readonly input: { readonly start_time?: string; readonly end_time?: string };
  readonly expectStart?: string;
  readonly expectEnd?: string;
  readonly expectClampNote: boolean;
}> = [
  { name: 'no bounds at all', input: {}, expectClampNote: false },
  {
    name: 'start_time only, safely past',
    input: { start_time: '2020-01-01T00:00:00Z' },
    expectStart: '2020-01-01T00:00:00.000Z',
    expectClampNote: false,
  },
  {
    name: 'end_time only, safely past',
    input: { end_time: '2025-01-01T00:00:00Z' },
    expectEnd: '2025-01-01T00:00:00.000Z',
    expectClampNote: false,
  },
  {
    name: 'end_time exactly AT the cutoff (boundary is inclusive, not clamped)',
    input: { end_time: CUTOFF_ISO },
    expectEnd: CUTOFF_ISO,
    expectClampNote: false,
  },
  {
    name: 'end_time 1 ms past the cutoff (just inside the rejection window)',
    input: { end_time: new Date(CUTOFF_MS + 1).toISOString() },
    expectEnd: CUTOFF_ISO,
    expectClampNote: true,
  },
  {
    name: 'end_time equal to now',
    input: { end_time: NOW_ISO },
    expectEnd: CUTOFF_ISO,
    expectClampNote: true,
  },
  {
    name: 'end_time in the future',
    input: { end_time: '2099-01-01T00:00:00Z' },
    expectEnd: CUTOFF_ISO,
    expectClampNote: true,
  },
  {
    name: 'start_time and end_time both given, only end_time is inside the window',
    input: { start_time: '2020-01-01T00:00:00Z', end_time: NOW_ISO },
    expectStart: '2020-01-01T00:00:00.000Z',
    expectEnd: CUTOFF_ISO,
    expectClampNote: true,
  },
  {
    name: 'a non-UTC offset form normalizes to canonical UTC (no clamp)',
    input: { start_time: '2026-07-29T02:00:00+02:00', end_time: '2026-07-30T10:00:00+02:00' },
    expectStart: '2026-07-29T00:00:00.000Z',
    expectEnd: '2026-07-30T08:00:00.000Z',
    expectClampNote: false,
  },
];

for (const c of SWEEP) {
  test(`REND-9 sweep: ${c.name}`, () => {
    const bounds = normalizeTimeBounds(c.input, NOW_MS);
    assert.equal(bounds.startTime, c.expectStart, 'startTime');
    assert.equal(bounds.endTime, c.expectEnd, 'endTime');
    assert.equal(Object.hasOwn(bounds, 'startTime'), c.expectStart !== undefined);
    assert.equal(Object.hasOwn(bounds, 'endTime'), c.expectEnd !== undefined);
    if (c.expectClampNote) {
      assert.equal(bounds.notes.length, 1, 'expected exactly one clamp note');
      assert.match(bounds.notes[0] ?? '', /end_time adjusted to /);
      assert.match(bounds.notes[0] ?? '', /at least 10 seconds in the past/);
      assert.ok(bounds.notes[0]?.includes(c.expectEnd ?? ''), 'note names the clamped value');
    } else {
      assert.deepEqual(bounds.notes, []);
    }
  });
}

// --- Invalid input: validation errors before any HTTP -----------------------------------

/** Assert the rejection is a typed `validation` XError whose message matches `re`. */
function isValidation(re: RegExp) {
  return (err: unknown): boolean => {
    assert.ok(XError.is(err), 'expected an XError');
    assert.equal(err.kind, 'validation');
    assert.equal(err.fix, 'agent');
    assert.match(err.message, re);
    return true;
  };
}

test('REND-9: an unparseable start_time throws validation before end_time is even checked', () => {
  assert.throws(
    () => normalizeTimeBounds({ start_time: 'not-a-date', end_time: 'also-garbage' }, NOW_MS),
    isValidation(/^start_time is not a recognizable timestamp: "not-a-date"/),
  );
});

test('REND-9: an unparseable end_time throws validation naming end_time', () => {
  assert.throws(
    () => normalizeTimeBounds({ end_time: 'not-a-date' }, NOW_MS),
    isValidation(/^end_time is not a recognizable timestamp: "not-a-date"/),
  );
});

test('REND-9: an overlong unparseable value is echoed truncated (77 chars + "..."), never verbatim', () => {
  const garbage = `garbage-${'x'.repeat(100)}`;
  assert.throws(
    () => normalizeTimeBounds({ start_time: garbage }, NOW_MS),
    isValidation(/^start_time is not a recognizable timestamp: "garbage-x{69}\.\.\."/),
  );
});

test('REND-9: an empty or whitespace-only bound is unparseable, not silently accepted', () => {
  assert.throws(
    () => normalizeTimeBounds({ start_time: '   ' }, NOW_MS),
    isValidation(/start_time is not a recognizable timestamp/),
  );
});
