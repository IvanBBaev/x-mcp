// Unit tests for the untrusted-content pipeline (T-117, core/sanitize). Control and
// invisible code points are built with String.fromCharCode/fromCodePoint so this source
// file stays pure ASCII (no literal control characters embedded in the repo).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeText,
  sanitizeOptional,
  TRUNCATION_MARKER,
  DEFAULT_MAX_LENGTH,
  FIELD_CAPS,
} from '../../src/core/sanitize.js';

const ZWSP = String.fromCharCode(0x200b); // zero-width space
const ZWJ = String.fromCharCode(0x200d); // zero-width joiner
const RLO = String.fromCharCode(0x202e); // right-to-left override (bidi)
const LRI = String.fromCharCode(0x2066); // left-to-right isolate (bidi)
const BOM = String.fromCharCode(0xfeff); // byte-order mark / ZWNBSP
const ALM = String.fromCharCode(0x061c); // Arabic letter mark (bidi)
const ESC = String.fromCharCode(0x1b); // ESC — ANSI escape lead-in (C0)
const NUL = String.fromCharCode(0x00); // NUL (C0)

test('REND-6: strips zero-width, bidi-control, BOM and C0/C1 control characters', () => {
  const dirty = `he${ZWSP}llo${RLO}wor${BOM}ld${ESC}${NUL}${ALM}${LRI}`;
  assert.equal(sanitizeText(dirty), 'helloworld');
});

test('REND-6: preserves tab, newline, carriage return and ordinary unicode', () => {
  const input = `line1\nline2\tcol\r\nplain ${String.fromCodePoint(0x1f680)}`;
  assert.equal(sanitizeText(input), input);
});

test('REND-6: caps length and appends an explicit truncation marker', () => {
  const cap = 20;
  const out = sanitizeText('a'.repeat(50), { maxLength: cap });
  assert.ok(out.endsWith(TRUNCATION_MARKER));
  assert.equal(Array.from(out).length, cap);
});

test('REND-6: a value of exactly maxLength is left whole — the cap is inclusive', () => {
  // The `points.length <= max` boundary. A string that just fits must come back byte-for-byte:
  // marking it truncated would tell the agent content was dropped when none was, and would
  // also cost it real characters to make room for a marker it never needed.
  const cap = 20;
  const exact = 'a'.repeat(cap);
  assert.equal(sanitizeText(exact, { maxLength: cap }), exact);
  // One code point more is where truncation actually starts.
  const over = sanitizeText('a'.repeat(cap + 1), { maxLength: cap });
  assert.ok(over.endsWith(TRUNCATION_MARKER));
  assert.equal(Array.from(over).length, cap);
  // The same boundary in code points, not UTF-16 units: 20 emoji are 40 units but fit a
  // 20-point cap untouched.
  const emoji = String.fromCodePoint(0x1f600).repeat(cap);
  assert.equal(sanitizeText(emoji, { maxLength: cap }), emoji);
});

test('REND-6: truncation counts code points and never splits a surrogate pair', () => {
  const emoji = String.fromCodePoint(0x1f600);
  const cap = 20;
  const out = sanitizeText(emoji.repeat(30), { maxLength: cap });
  assert.equal(Array.from(out).length, cap);
  assert.ok(out.endsWith(TRUNCATION_MARKER));
  // Every kept leading unit is a full emoji code point — no lone surrogate.
  assert.ok(
    Array.from(out)
      .slice(0, cap - Array.from(TRUNCATION_MARKER).length)
      .every((c) => c === emoji),
  );
});

test('sanitizeText returns empty for empty input and applies DEFAULT_MAX_LENGTH', () => {
  assert.equal(sanitizeText(''), '');
  const out = sanitizeText('x'.repeat(DEFAULT_MAX_LENGTH + 100));
  assert.equal(Array.from(out).length, DEFAULT_MAX_LENGTH);
});

test('sanitizeOptional omits missing/blank/all-invisible so callers drop the field', () => {
  assert.equal(sanitizeOptional(undefined), undefined);
  assert.equal(sanitizeOptional(''), undefined);
  assert.equal(sanitizeOptional(ZWSP + ZWJ + BOM), undefined);
  assert.equal(sanitizeOptional('  ok  '), '  ok  '); // spaces are content, not stripped
  const capped = sanitizeOptional('x'.repeat(50), 20);
  assert.equal(capped, 'x'.repeat(20 - Array.from(TRUNCATION_MARKER).length) + TRUNCATION_MARKER);
});

test('FIELD_CAPS are positive and handle is the tightest field cap', () => {
  for (const v of Object.values(FIELD_CAPS)) assert.ok(v > 0);
  assert.ok(FIELD_CAPS.handle <= FIELD_CAPS.name);
});
