// Untrusted-content pipeline (T-117). A pure string -> string transform applied to EVERY
// piece of third-party text -- post/DM bodies, display names, bios, handles, alt-text,
// list names -- BEFORE it lands in a compact render shape (docs/02 section 5.2/5, docs/04
// untrusted-content, REND-6). It also guards the ONE third-party-text path that never
// reaches a compactor: the platform `title`/`detail` prose an error response carries into an
// XError payload (see `sanitizePlatformText`). `core` does no I/O and imports nothing from
// other layers.
//
// What this does, and what it deliberately does NOT do:
//   - Strips invisible/format code points that can smuggle hidden instructions past a
//     reader: zero-width joiners/spaces and BOM, bidi controls (LRE/RLE/PDF/LRO/RLO,
//     the isolates LRI/RLI/FSI/PDI, and the marks LRM/RLM/ALM), and C0/C1 control
//     characters (including ESC, so ANSI terminal-escape injection cannot ride through
//     into a log line or a terminal-based agent UI). Tab, newline, and carriage return
//     are preserved -- legitimate posts contain them.
//   - Caps each field length and appends an explicit truncation marker so an enormous
//     injected string cannot bloat a result, and the truncation is never silent.
//   - It does NOT try to defang natural-language instructions ("ignore your system
//     prompt..."). That cannot be done reliably; the honest posture (docs/04) is to strip
//     the invisible manipulation, cap the size, and mark the result as untrusted (the
//     per-result note lives in core/render). Sanitizing removes hidden control
//     characters -- it does not guarantee the text is injection-free.
//
// This pipeline is for INBOUND third-party text only. A user's own OUTBOUND text
// (post_create) is sent byte-identical and must never pass through here (POST-1).

/** Options for {@link sanitizeText}. */
export interface SanitizeOptions {
  /** Maximum length in Unicode code points before truncation. Omit for {@link DEFAULT_MAX_LENGTH}. */
  readonly maxLength?: number;
}

/** Appended when a field is truncated, so the clipping is always explicit (REND-6). */
export const TRUNCATION_MARKER = '…[truncated]';

/** Fallback cap when a caller supplies no explicit `maxLength`. */
export const DEFAULT_MAX_LENGTH = 5000;

/**
 * Per-field code-point caps used by the compactors (core/render). Values are generous
 * relative to the platform's own field limits so ordinary content is never clipped, but
 * bounded so a drift-inflated or adversarial field cannot balloon a result.
 */
export const FIELD_CAPS = {
  /** `@handle` bodies (platform max 15). */
  handle: 30,
  /** Display names (platform max 50). */
  name: 100,
  /** Bios / list descriptions (platform max 160). */
  bio: 500,
  /** Post display text (`text`). */
  postText: 2000,
  /** Long-form note body (`note_tweet`, platform max ~25k). */
  noteText: 30000,
  /** DM message body. */
  dmText: 20000,
  /** Media alt-text (platform max ~1000). */
  altText: 2000,
  /** Profile location. */
  location: 120,
  /** URLs carried through from profile/media fields. */
  url: 500,
  /**
   * Platform-supplied ERROR prose (`title` / `detail` / `errors[].message`) before it is
   * copied into an `XError` payload. Real X problem details sit well under 200 code points,
   * so 500 never clips a genuine one while still bounding a drift-inflated or adversarial
   * body. Lives in this table, not at the call site, so the error path cannot drift away
   * from the caps every success path already obeys.
   */
  errorText: 500,
} as const;

// One character class covering every stripped code point, written entirely with explicit
// \uXXXX escapes so the source stays legible, ASCII-only, and diff-safe. Grouped by intent
// (U+ notation avoids embedding any literal invisible/control character in this file):
//   U+0000-0008, U+000B, U+000C, U+000E-001F  C0 controls except TAB, LF, CR
//   U+007F-009F                                DEL and the C1 controls
//   U+061C                                     Arabic Letter Mark (bidi)
//   U+200B-200F                                ZWSP, ZWNJ, ZWJ, LRM, RLM
//   U+2060                                     Word Joiner (invisible)
//   U+202A-202E                                bidi embeddings/overrides (LRE..RLO)
//   U+2066-2069                                bidi isolates (LRI, RLI, FSI, PDI)
//   U+FEFF                                     ZWNBSP / BOM
// Note: stripping ZWJ (U+200D) can break inbound ZWJ emoji sequences (family/profession
// emoji) in third-party names/bios -- an accepted trade-off, because that same joiner is
// exactly what an attacker uses to hide characters. Outbound user text keeps its ZWJ.
const STRIP_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2060\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Sanitize one field of inbound third-party text (REND-6). Strips invisible/format and
 * control code points, then caps to `maxLength` code points with {@link TRUNCATION_MARKER}.
 * Pure and total: any input string yields a safe string (empty in -> empty out).
 */
export function sanitizeText(input: string, opts: SanitizeOptions = {}): string {
  const max = opts.maxLength ?? DEFAULT_MAX_LENGTH;
  const stripped = input.replace(STRIP_RE, '');
  return capLength(stripped, max);
}

/**
 * Sanitize an optional field: returns `undefined` for a missing/blank value so the
 * caller can OMIT the shape field (exactOptionalPropertyTypes) rather than emit an empty
 * string. A value that sanitizes to empty (e.g. all zero-width) is treated as absent.
 */
export function sanitizeOptional(
  input: string | undefined,
  maxLength?: number,
): string | undefined {
  if (input === undefined) return undefined;
  const out = sanitizeText(input, maxLength === undefined ? {} : { maxLength });
  return out.length > 0 ? out : undefined;
}

/**
 * Sanitize platform-supplied ERROR prose before it is copied into an `XError` payload
 * (REND-6/REND-7). Errors are the one third-party-text path the compactors never see: an X
 * error whose `detail` echoes attacker-influenced input (a duplicate-content 403 quoting the
 * offending post, a 400 quoting the query) would otherwise reach the planner with bidi and
 * invisible code points intact and unbounded in length. Same strip, same cap table, same
 * truncation marker as every success path — this is a thin alias, never a second sanitizer.
 *
 * Our OWN remediation prose never goes through here: it is authored in this codebase rather
 * than read off the wire, and capping it would clip the instructions DX-F13 requires.
 *
 * Returns `undefined` for an absent value or one that sanitizes to nothing, so the caller
 * OMITS the field (exactOptionalPropertyTypes) instead of emitting an empty string.
 */
export function sanitizePlatformText(input: string | undefined): string | undefined {
  return sanitizeOptional(input, FIELD_CAPS.errorText);
}

// Code-point-safe truncation: slice on `Array.from` units so a surrogate pair is never
// split. The result never exceeds `max` code points (when `max` >= the marker length).
function capLength(value: string, max: number): string {
  const points = Array.from(value);
  if (points.length <= max) return value;
  const markerLen = Array.from(TRUNCATION_MARKER).length;
  const keep = Math.max(0, max - markerLen);
  return points.slice(0, keep).join('') + TRUNCATION_MARKER;
}
