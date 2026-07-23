// Tests for core/paginate (T-119) — the pagination contract helpers. Every PAGE-1…5
// corner case (docs/07 §7) is referenced by name below. Pure unit tests: no I/O, no
// dispatcher, so the PAGE-5 "exactly one request" invariant is asserted structurally
// (there is no fetch loop to test) plus by the mocked-dispatcher tests the tool tasks own.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampMaxResults,
  toCursor,
  pageTokenError,
  buildPage,
  PAGE_BOUNDS,
  PAGE_TOKEN_INVALID_MESSAGE,
} from '../../src/core/paginate.js';
import type { PageBounds } from '../../src/core/paginate.js';
import { XError } from '../../src/core/errors.js';
import { ZERO_RESULTS_NOTE } from '../../src/core/render-shapes.js';

interface Item {
  readonly id: string;
}
const items = (...ids: string[]): Item[] => ids.map((id) => ({ id }));

// --- PAGE-3 — max_results clamps in both directions -------------------------------

test('PAGE-3: below the floor clamps up (search 5 -> 10) and notes the effective value', () => {
  const r = clampMaxResults(5, PAGE_BOUNDS.searchRecent);
  assert.equal(r.value, 10);
  assert.equal(r.clamped, true);
  assert.match(r.note ?? '', /adjusted to 10/);
  assert.match(r.note ?? '', /10-100/);
  assert.match(r.note ?? '', /requested 5/);
});

test('PAGE-3: above the ceiling clamps down (search 200 -> 100)', () => {
  const r = clampMaxResults(200, PAGE_BOUNDS.searchRecent);
  assert.equal(r.value, 100);
  assert.equal(r.clamped, true);
});

test('PAGE-3: an in-range value passes through with no note', () => {
  const r = clampMaxResults(50, PAGE_BOUNDS.searchRecent);
  assert.equal(r.value, 50);
  assert.equal(r.clamped, false);
  assert.equal(Object.hasOwn(r, 'note'), false); // exactOptionalPropertyTypes: key absent, not undefined
});

test('PAGE-3: honors distinct per-endpoint floors (timeline floor 5, archive ceiling 500)', () => {
  assert.equal(clampMaxResults(1, PAGE_BOUNDS.timeline).value, 5);
  assert.equal(clampMaxResults(99, PAGE_BOUNDS.timeline).value, 99);
  assert.equal(clampMaxResults(9999, PAGE_BOUNDS.searchArchive).value, 500);
  assert.equal(clampMaxResults(1, PAGE_BOUNDS.socialGraph).value, 1); // floor of 1 is valid
});

test('PAGE-3: exact bounds are inclusive and unclamped', () => {
  assert.equal(clampMaxResults(10, PAGE_BOUNDS.searchRecent).clamped, false);
  assert.equal(clampMaxResults(100, PAGE_BOUNDS.searchRecent).clamped, false);
});

test('PAGE-3: nonsense max_results (NaN/Infinity/fractional) is a typed validation error', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 10.5]) {
    assert.throws(
      () => clampMaxResults(bad, PAGE_BOUNDS.searchRecent),
      (e: unknown) => XError.is(e) && e.kind === 'validation' && e.fix === 'agent',
    );
  }
});

test('PAGE-3: malformed endpoint bounds are a programmer error, not an agent error', () => {
  const bad: PageBounds = { min: 100, max: 10 };
  assert.throws(
    () => clampMaxResults(50, bad),
    (e: unknown) => e instanceof Error && !XError.is(e),
  );
});

// --- PAGE-1 — tokens are opaque and round-trip verbatim ---------------------------

test('PAGE-1: toCursor returns the page_token verbatim (never parsed or trimmed)', () => {
  assert.equal(toCursor('b26v89c19zqg8o3fpds5l4k2j'), 'b26v89c19zqg8o3fpds5l4k2j');
  assert.equal(toCursor('7140dibdnow9c7btw482x="='), '7140dibdnow9c7btw482x="='); // opaque bytes preserved
});

test('PAGE-1: a missing or blank page_token means first page (no cursor)', () => {
  assert.equal(toCursor(undefined), undefined);
  assert.equal(toCursor(''), undefined);
  assert.equal(toCursor('   '), undefined);
});

test('PAGE-1: next_token from buildPage round-trips through toCursor unchanged', () => {
  const page = buildPage(items('a'), 'CURSOR-XYZ');
  assert.equal(page.next_token, 'CURSOR-XYZ');
  assert.equal(toCursor(page.next_token), 'CURSOR-XYZ');
});

// --- PAGE-2 — invalid or expired token maps to validation, never api --------------

test('PAGE-2: pageTokenError is a validation error with the restart-from-first-page message', () => {
  const err = pageTokenError();
  assert.ok(XError.is(err));
  assert.equal(err.kind, 'validation');
  assert.equal(err.fix, 'agent');
  assert.equal(err.retryable, false);
  assert.equal(err.message, PAGE_TOKEN_INVALID_MESSAGE);
  assert.match(err.message, /restart from the first page/);
});

test('PAGE-2: pageTokenError forwards structured opts (e.g. http_status) from the mapper', () => {
  const err = pageTokenError({ data: { http_status: 400 } });
  assert.equal(err.data.http_status, 400);
});

// --- PAGE-4 — last page omits next_token, always carries result_count --------------

test('PAGE-4: a full page passes next_token through and sets result_count', () => {
  const page = buildPage(items('1', '2', '3'), 'NEXT');
  assert.equal(page.result_count, 3);
  assert.equal(page.items.length, 3);
  assert.equal(page.next_token, 'NEXT');
});

test('PAGE-4: the last page omits next_token entirely (never null/undefined key)', () => {
  for (const nt of [undefined, '', undefined as string | undefined]) {
    const page = buildPage(items('1', '2'), nt);
    assert.equal(page.result_count, 2);
    assert.equal(Object.hasOwn(page, 'next_token'), false);
  }
});

// --- PAGE-5 — exactly one request per call: the module cannot auto-paginate ---------

test('PAGE-5: buildPage transforms exactly one batch and exposes no fetch loop', () => {
  // The pagination surface is (clampMaxResults, toCursor, pageTokenError, buildPage) — all
  // pure. None takes a fetcher/dispatcher, so no helper can issue a follow-up page request;
  // auto-pagination is impossible by construction. buildPage's result_count is precisely the
  // single batch it was handed. The one-HTTP-request-per-call invariant is additionally
  // asserted by the tool tasks over a mocked dispatcher.
  const batch = items('a', 'b', 'c', 'd');
  const page = buildPage(batch, 'MORE');
  assert.equal(page.result_count, batch.length);
  assert.equal(page.items, batch); // same batch, no accumulation across pages
});

// --- Zero results (REND-5) — the empty batch carries an explicit note --------------

test('PAGE-4 + zero results: an empty batch renders result_count 0 with the zero-results note', () => {
  const page = buildPage(items());
  assert.equal(page.result_count, 0);
  assert.equal(page.note, ZERO_RESULTS_NOTE);
  assert.equal(Object.hasOwn(page, 'next_token'), false);
});

test('a non-empty page with no extra note omits the note key', () => {
  const page = buildPage(items('1'));
  assert.equal(Object.hasOwn(page, 'note'), false);
});

// --- Notes composition — clamp note (PAGE-3) flows into the envelope ----------------

test('PAGE-3 note surfaces on a non-empty page via buildPage extraNote', () => {
  const { value, note } = clampMaxResults(5, PAGE_BOUNDS.searchRecent);
  assert.equal(value, 10);
  const page = buildPage(items('1', '2'), 'NEXT', note);
  assert.equal(page.note, note);
});

test('PAGE-3 + zero results: an empty clamped page joins the zero-results and adjustment notes', () => {
  const { note } = clampMaxResults(5, PAGE_BOUNDS.searchRecent);
  const page = buildPage(items(), undefined, note);
  assert.equal(page.note, `${ZERO_RESULTS_NOTE} ${note}`);
});

test('an empty extraNote never introduces a stray note on a full page', () => {
  const page = buildPage(items('1'), 'NEXT', '');
  assert.equal(Object.hasOwn(page, 'note'), false);
});
