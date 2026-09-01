// Shared arbitraries and oracles for the property-based layer (docs/05 §1,
// `test/prop-*.test.ts`). Kept next to the T-103 harness helpers so every property file
// draws adversarial text and checks output hygiene against the SAME oracle.
//
// FORBIDDEN_OUTPUT_RE below is an independent restatement of the sanitization CONTRACT
// (docs/02 §5.2, REND-6): the code points that may never reach an agent -- C0 controls
// except tab/LF/CR, DEL + C1 controls, the Arabic Letter Mark, zero-width characters
// (ZWSP/ZWNJ/ZWJ + the LRM/RLM marks), the Word Joiner, bidi embeddings/overrides, bidi
// isolates, and the BOM. It is written out here from the docs, not imported from
// src/core/sanitize.ts, so a drift that weakens the implementation's strip set fails
// these tests instead of silently weakening the oracle with it. Everything is spelled
// with explicit \uXXXX escapes (same rule as sanitize.ts) so this file stays ASCII-only
// and diff-safe.

import fc from 'fast-check';

/** Matches any code point the docs/02 §5.2 contract says must never survive sanitization. */
export const FORBIDDEN_OUTPUT_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2060\u202a-\u202e\u2066-\u2069\ufeff]/;

// A concrete pool of the nastiest members of that set, so generated inputs actually
// exercise the strip (uniform full-unicode draws almost never hit these code points).
const DANGEROUS_CHARS = [
  '\u0000', // NUL
  '\u0007', // BEL
  '\u0008', // BS
  '\u000b', // VT
  '\u001b', // ESC -- ANSI terminal-escape injection
  '\u007f', // DEL
  '\u0085', // NEL (C1)
  '\u009b', // CSI (C1) -- 8-bit ANSI escape
  '\u061c', // Arabic Letter Mark
  '\u200b', // zero-width space
  '\u200c', // zero-width non-joiner
  '\u200d', // zero-width joiner
  '\u200e', // left-to-right mark
  '\u200f', // right-to-left mark
  '\u2060', // word joiner
  '\u202a', // LRE
  '\u202b', // RLE
  '\u202c', // PDF
  '\u202d', // LRO
  '\u202e', // RLO -- the classic display-spoofing override
  '\u2066', // LRI
  '\u2067', // RLI
  '\u2068', // FSI
  '\u2069', // PDI
  '\ufeff', // BOM / ZWNBSP
];

/**
 * Adversarial third-party text: arbitrary well-formed unicode interleaved with the
 * invisible/bidi/control code points above and with legitimate whitespace + emoji
 * (including a ZWJ family sequence, which arrives as third-party content in the wild).
 */
export function dirtyText(maxParts = 40): fc.Arbitrary<string> {
  return fc
    .array(
      fc.oneof(
        { weight: 3, arbitrary: fc.string({ unit: 'binary', maxLength: 5 }) },
        { weight: 2, arbitrary: fc.constantFrom(...DANGEROUS_CHARS) },
        {
          weight: 1,
          arbitrary: fc.constantFrom(
            '\t',
            '\n',
            '\r',
            ' ',
            'a',
            '@',
            '\u{1F642}', // slightly smiling face
            '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}', // family emoji (ZWJ sequence)
          ),
        },
      ),
      { maxLength: maxParts },
    )
    .map((parts) => parts.join(''));
}

/**
 * True when `s` contains a lone UTF-16 surrogate half -- i.e. the string is not
 * well-formed unicode. (Node 22 has `String.prototype.isWellFormed`, but the repo's TS
 * lib is ES2023, so the check is spelled out.)
 */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return true;
      i += 1; // valid pair -- skip the low half
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true; // low half with no preceding high half
    }
  }
  return false;
}

/** Platform-shaped resource ids, drawn from a small pool so that generated `includes`
 *  expansions sometimes resolve and sometimes dangle (REND-5 both ways). */
export const idPool = fc.constantFrom('1', '7', '42', '1234567890123456789', '999');

/** Media keys from a small pool so `attachments.media_keys` sometimes resolve. */
export const mediaKeyPool = fc.constantFrom('3_1', '3_2', '7_9', 'zz');
