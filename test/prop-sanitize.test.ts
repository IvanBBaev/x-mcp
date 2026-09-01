// Property-based tests (docs/05 §1) for core/sanitize — the untrusted-content pipeline.
//
// The oracle is FORBIDDEN_OUTPUT_RE from test/helpers/prop.ts: an independent restatement
// of the docs/02 §5.2 strip contract, so a drift that weakens the implementation's own
// STRIP_RE fails here instead of being tested against itself. The complementary property
// (clean text passes through byte-identical) guards against the opposite failure —
// over-stripping legitimate content.

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  DEFAULT_MAX_LENGTH,
  FIELD_CAPS,
  TRUNCATION_MARKER,
  sanitizeOptional,
  sanitizeText,
} from '../src/core/sanitize.js';
import { FORBIDDEN_OUTPUT_RE, dirtyText, hasLoneSurrogate } from './helpers/index.js';

const MARKER_POINTS = Array.from(TRUNCATION_MARKER).length;
const capArb = fc.constantFrom(
  FIELD_CAPS.handle,
  FIELD_CAPS.name,
  FIELD_CAPS.bio,
  FIELD_CAPS.postText,
  DEFAULT_MAX_LENGTH,
);

test('REND-6 property: output never carries a forbidden code point, a lone surrogate, or more than the cap', () => {
  fc.assert(
    fc.property(dirtyText(), capArb, (input, cap) => {
      const out = sanitizeText(input, { maxLength: cap });
      assert.equal(
        FORBIDDEN_OUTPUT_RE.test(out),
        false,
        `forbidden code point in ${JSON.stringify(out)}`,
      );
      // Truncation slices on code points, so a surrogate pair is never split.
      assert.equal(hasLoneSurrogate(out), false);
      assert.ok(Array.from(out).length <= cap);
    }),
  );
});

test('REND-6 property: sanitization is idempotent — already-safe text is a fixed point', () => {
  fc.assert(
    fc.property(dirtyText(), capArb, (input, cap) => {
      const once = sanitizeText(input, { maxLength: cap });
      assert.equal(sanitizeText(once, { maxLength: cap }), once);
    }),
  );
});

// Alphabet with NOTHING to strip: preserved whitespace (tab/LF/CR), ASCII, accented and
// CJK letters, an astral emoji. One code point per entry, so array length == point length.
const cleanChar = fc.constantFrom(
  '\t',
  '\n',
  '\r',
  ' ',
  'a',
  'Z',
  '9',
  '@',
  '#',
  'é', // e with acute (precomposed — one code point)
  '中', // CJK ideograph
  '\u{1F642}',
);

test('REND-6 property: clean text under the cap passes through byte-identical (no over-stripping)', () => {
  fc.assert(
    fc.property(fc.array(cleanChar, { maxLength: 100 }), (chars) => {
      const input = chars.join('');
      assert.equal(sanitizeText(input), input);
    }),
  );
});

test('REND-6 property: over-cap text lands exactly on the cap, ends with the marker, keeps a true prefix', () => {
  fc.assert(
    fc.property(
      fc.array(cleanChar, { minLength: 51, maxLength: 120 }),
      fc.integer({ min: MARKER_POINTS, max: 50 }),
      (chars, cap) => {
        const input = chars.join(''); // clean and strictly longer than any generated cap
        const out = sanitizeText(input, { maxLength: cap });
        const points = Array.from(out);
        assert.equal(points.length, cap); // never one over, never silently shorter
        assert.ok(out.endsWith(TRUNCATION_MARKER)); // clipping is always explicit
        const kept = points.slice(0, cap - MARKER_POINTS).join('');
        assert.ok(input.startsWith(kept)); // kept content is a prefix — never reordered
      },
    ),
  );
});

test('REND-6 property: sanitizeOptional never yields an empty string — absent instead', () => {
  fc.assert(
    fc.property(fc.option(dirtyText(), { nil: undefined }), (input) => {
      const out = sanitizeOptional(input);
      if (input === undefined) {
        assert.equal(out, undefined);
      } else if (out === undefined) {
        // Absence is only ever the empty-after-sanitize case (e.g. all zero-width input).
        assert.equal(sanitizeText(input), '');
      } else {
        assert.ok(out.length > 0);
        assert.equal(out, sanitizeText(input)); // same pipeline, no second sanitizer
      }
    }),
  );
});
