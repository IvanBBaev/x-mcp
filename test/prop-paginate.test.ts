// Property-based tests (docs/05 §1) for core/paginate — clamp, cursor, and envelope laws.
//
// The unit suite pins the documented examples (search 5 -> 10, etc.); these properties pin
// the contracts across ALL integers and every named bounds window: PAGE-3 (clamp into the
// inclusive window, both directions, note iff adjusted), PAGE-1 (tokens round-trip
// verbatim — never parsed, trimmed, or re-encoded), and PAGE-4 (the Page envelope).

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { PAGE_BOUNDS, buildPage, clampMaxResults, toCursor } from '../src/core/paginate.js';
import { XError } from '../src/core/errors.js';
import { ZERO_RESULTS_NOTE } from '../src/core/render-shapes.js';

const boundsArb = fc.constantFrom(...Object.values(PAGE_BOUNDS));

test('PAGE-3 property: any integer clamps into [min, max]; clamped/note flags agree; re-clamping is identity', () => {
  fc.assert(
    fc.property(fc.integer(), boundsArb, (requested, bounds) => {
      const r = clampMaxResults(requested, bounds);
      assert.ok(Number.isInteger(r.value));
      assert.ok(r.value >= bounds.min && r.value <= bounds.max, `${r.value} out of window`);
      // The flag and the note travel together, and only when an adjustment happened.
      assert.equal(r.clamped, r.value !== requested);
      assert.equal(Object.hasOwn(r, 'note'), r.clamped);
      // An in-window value passes through untouched — so clamping is idempotent.
      const again = clampMaxResults(r.value, bounds);
      assert.equal(again.value, r.value);
      assert.equal(again.clamped, false);
      assert.equal(Object.hasOwn(again, 'note'), false);
    }),
  );
});

test('PAGE-3 property: every non-integer max_results raises a typed validation error, never a coercion', () => {
  const nonInteger = fc.oneof(
    fc.double({ noInteger: true, noNaN: true }),
    fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
  );
  fc.assert(
    fc.property(nonInteger, boundsArb, (requested, bounds) => {
      assert.throws(
        () => clampMaxResults(requested, bounds),
        (err: unknown) => XError.is(err) && err.kind === 'validation',
      );
    }),
  );
});

test('PAGE-1 property: page tokens round-trip verbatim; blank means first page', () => {
  fc.assert(
    fc.property(fc.string({ unit: 'binary' }), (token) => {
      const cursor = toCursor(token);
      if (token.trim().length === 0) {
        assert.equal(cursor, undefined);
      } else {
        // Identity, not similarity: the cursor is the exact string, untrimmed, un-decoded.
        assert.equal(cursor, token);
      }
    }),
  );
  assert.equal(toCursor(undefined), undefined);
});

test('PAGE-4 property: the Page envelope — count, verbatim next_token iff non-empty, notes iff warranted', () => {
  const itemsArb = fc.array(fc.record({ id: fc.string() }));
  const tokenArb = fc.option(fc.string(), { nil: undefined });
  const extraNoteArb = fc.option(fc.string({ minLength: 1 }), { nil: undefined });
  fc.assert(
    fc.property(itemsArb, tokenArb, extraNoteArb, (items, nextToken, extraNote) => {
      const page = buildPage(items, nextToken, extraNote);
      assert.equal(page.result_count, items.length);
      assert.deepEqual(page.items, items);
      // next_token: present exactly when the API returned a non-empty cursor, and verbatim
      // (PAGE-1). The last page omits the field entirely — never null, never ''.
      const expectNext = typeof nextToken === 'string' && nextToken.length > 0;
      assert.equal(Object.hasOwn(page, 'next_token'), expectNext);
      if (expectNext) assert.equal(page.next_token, nextToken);
      // Notes: the zero-results note appears iff the page is empty (REND-1); an extra note
      // is preserved; no other case invents a note.
      assert.equal(Object.hasOwn(page, 'note'), items.length === 0 || extraNote !== undefined);
      const note = page.note ?? '';
      assert.equal(note.includes(ZERO_RESULTS_NOTE), items.length === 0);
      if (extraNote !== undefined) assert.ok(note.includes(extraNote));
    }),
  );
});
