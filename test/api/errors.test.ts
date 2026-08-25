// Tests for the HTTP → XError mapper (T-116, api/errors.ts). Each case drives the mapper
// from a fixture in test/fixtures/errors/ (loaded via loadFixture) so the corpus doubles as
// the provenance-checked shape record (DRIFT-4). Corner cases referenced: DX-F13 (every error
// carries actionable remediation), REND-2 (partial failures → missing[], not a thrown error),
// REND-7 (no third-party content / raw HTML in any error), plus AUTH-8, RATE-2/5/7, DRIFT-2,
// COST-6/7, NET-1.

import test from 'node:test';
import assert from 'node:assert/strict';

import { XError } from '../../src/core/errors.js';
import { mapHttpError, collectMissing } from '../../src/api/errors.js';
import type { Missing } from '../../src/api/errors.js';
import { FIELD_CAPS, TRUNCATION_MARKER } from '../../src/core/sanitize.js';
import { loadFixture } from '../helpers/index.js';

/** The scenario wrapper every fixture in test/fixtures/errors/ uses. */
interface ErrorScenario {
  readonly _provenance: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** All fixtures that represent a real error RESPONSE (i.e. everything except the 200 partial). */
const ERROR_FIXTURES = [
  '401-invalid-token.json',
  '401-insufficient-scope.json',
  '403-duplicate-content.json',
  '403-suspended-target.json',
  '403-insufficient-scope.json',
  '403-billing-access-level.json',
  '429-rate-limit.json',
  '404-not-found.json',
  '502-html.json',
  '500-json.json',
  '400-unmapped.json',
] as const;

function load(name: string): ErrorScenario {
  return loadFixture<ErrorScenario>(`errors/${name}`);
}

function map(name: string, nowMs?: number): XError {
  const fx = load(name);
  return mapHttpError(fx.status, fx.headers, fx.body, nowMs);
}

// --- Class selection (DX-F13: right class + agent/operator remediation) ----------

test('401 invalid token maps to auth (operator, non-retryable) with an authorize instruction — DX-F13', () => {
  const err = map('401-invalid-token.json');
  assert.equal(err.kind, 'auth');
  assert.equal(err.fix, 'operator');
  assert.equal(err.retryable, false);
  assert.match(err.message, /authorize/i); // actionable, operator-directed (AUTH-8)
  assert.equal(err.data.http_status, 401);
});

test('401 with an insufficient-scope body maps to scope, not auth — DX-F13', () => {
  const err = map('401-insufficient-scope.json');
  assert.equal(err.kind, 'scope');
  assert.equal(err.fix, 'operator');
  assert.match(err.message, /scope/i);
});

test('403 duplicate content maps to forbidden and passes X title/detail through — DX-F13, DRIFT-2', () => {
  const err = map('403-duplicate-content.json');
  assert.equal(err.kind, 'forbidden');
  assert.equal(err.fix, 'agent');
  assert.equal(err.retryable, false);
  // Platform title/detail pass through in data (DRIFT-2); the message stays our own prose.
  assert.equal(err.data.platform_title, 'Forbidden');
  assert.equal(
    err.data.platform_detail,
    'You are not allowed to create a Tweet with duplicate content.',
  );
});

test('403 suspended/unavailable target maps to forbidden', () => {
  const err = map('403-suspended-target.json');
  assert.equal(err.kind, 'forbidden');
});

test('403 insufficient scope maps to scope (distinct from forbidden/billing) — DX-F13', () => {
  const err = map('403-insufficient-scope.json');
  assert.equal(err.kind, 'scope');
  assert.equal(err.fix, 'operator');
});

test('403 billing/entitlement maps to billing, distinct from the local budget class — COST-6/7', () => {
  const err = map('403-billing-access-level.json');
  assert.equal(err.kind, 'billing');
  assert.equal(err.fix, 'operator');
  assert.equal(err.retryable, false);
  assert.match(err.message, /credit|access level|entitlement/i);
  assert.match(err.message, /not.*the local session budget/i); // billing ≠ budget
});

test('429 maps to rate-limit and surfaces reset_at + retry_after_seconds; later time wins — RATE-2/7', () => {
  const resetEpoch = 1900000000; // from the fixture's x-rate-limit-reset
  const nowMs = (resetEpoch - 60) * 1000; // reset is 60 s away; retry-after (30 s) is earlier
  const err = map('429-rate-limit.json', nowMs);
  assert.equal(err.kind, 'rate-limit');
  assert.equal(err.fix, 'agent');
  assert.equal(err.retryable, true);
  // RATE-7: the later of retry-after (+30 s) and x-rate-limit-reset (+60 s) wins → 60 s.
  assert.equal(err.data.retry_after_seconds, 60);
  assert.equal(err.data.reset_at, new Date(resetEpoch * 1000).toISOString());
  assert.match(err.message, /resets/i);
});

test('404 maps to not-found (agent) — DX-F13', () => {
  const err = map('404-not-found.json');
  assert.equal(err.kind, 'not-found');
  assert.equal(err.fix, 'agent');
});

test('500 with a JSON body degrades to api and is retryable (5xx) — DRIFT-2', () => {
  const err = map('500-json.json');
  assert.equal(err.kind, 'api');
  assert.equal(err.retryable, true);
  assert.equal(err.data.platform_title, 'Internal Server Error');
});

test('unmapped 4xx (400) degrades to api and is NOT retryable — DRIFT-2', () => {
  const err = map('400-unmapped.json');
  assert.equal(err.kind, 'api');
  assert.equal(err.retryable, false);
  // A legacy `errors[].message` body still yields a passed-through detail/title.
  assert.equal(err.data.platform_title, 'Invalid Request');
});

// --- REND-7: HTML error page recognised and never leaked --------------------------

test('HTML 502 maps to a clean api error; raw markup is dropped, not echoed — REND-7, NET-1', () => {
  const err = map('502-html.json');
  assert.equal(err.kind, 'api');
  assert.equal(err.retryable, true); // 5xx
  // The message is our prose only — no HTML tags, no upstream host, no sentinel secret.
  assert.doesNotMatch(err.message, /</);
  assert.equal(err.message.includes('SENTINEL_SECRET'), false);
  assert.equal(err.message.includes('twitter.local'), false);
  // And the raw HTML never sneaks into a passed-through platform_detail either.
  assert.equal(err.data.platform_detail, undefined);
  assert.equal(err.data.platform_title, undefined);
});

test('REND-7 sentinel sweep: no fixture body content leaks into any mapped error message', () => {
  for (const name of ERROR_FIXTURES) {
    const err = map(name, 1900000000000);
    // No HTML markup and no seeded secret in the human-facing message, for any error path.
    assert.doesNotMatch(err.message, /</, `HTML angle bracket leaked in ${name}`);
    assert.equal(err.message.includes('SENTINEL_SECRET'), false, `secret leaked in ${name}`);
    // Every error carries actionable prose (DX-F13) — never empty.
    assert.ok(err.message.length > 20, `remediation prose too short in ${name}`);
    assert.ok(XError.is(err));
  }
});

// --- REND-6: the platform prose that DOES pass through is sanitized (T-320 F3) -----
//
// `platform_title` / `platform_detail` are the ONE third-party-text path that never passes a
// compactor, and X quotes attacker-influenced input back at us (a duplicate-content 403 echoes
// the offending post, a 400 echoes the query). So the error payload gets the same strip and the
// same cap table as every success path.

// Built with String.fromCharCode, exactly as core/sanitize writes its class in \uXXXX form:
// a literal invisible character in a test file is unreviewable in a diff.
const ZWSP = String.fromCharCode(0x200b); // zero-width space
const RLO = String.fromCharCode(0x202e); // right-to-left override
const LRI = String.fromCharCode(0x2066); // left-to-right isolate
const ESC = String.fromCharCode(0x1b); // ANSI escape introducer
const BOM = String.fromCharCode(0xfeff);

test('platform_title/platform_detail are stripped of invisible and bidi control characters', () => {
  const err = mapHttpError(
    400,
    {},
    {
      title: `In${ZWSP}valid${RLO} Request`,
      // The ESC would otherwise reach a terminal-based agent UI as a live colour escape.
      detail: `The query ${ESC}[31mfailed${ESC}[0m to parse${LRI}.`,
    },
  );
  assert.equal(err.data.platform_title, 'Invalid Request');
  assert.equal(err.data.platform_detail, 'The query [31mfailed[0m to parse.');
});

test('a field that is nothing BUT invisible characters is omitted, not emitted empty', () => {
  const err = mapHttpError(400, {}, { title: `${ZWSP}${ZWSP}${BOM}`, detail: 'real prose' });
  assert.equal(err.data.platform_title, undefined);
  assert.equal(err.data.platform_detail, 'real prose');
});

test('an oversized platform detail is capped with the truncation marker — never silently', () => {
  const err = mapHttpError(400, {}, { detail: 'x'.repeat(50_000) });
  const detail = err.data.platform_detail ?? '';
  assert.equal(Array.from(detail).length, FIELD_CAPS.errorText);
  assert.ok(detail.endsWith(TRUNCATION_MARKER), 'the clipping must be explicit');
});

test('the 429 builder sanitizes too — it writes its own data literal', () => {
  // mapRateLimit does not go through baseData, so it is the branch most likely to drift.
  const err = mapHttpError(
    429,
    {},
    { title: `Too${ZWSP} Many Requests`, detail: 'y'.repeat(9_000) },
  );
  assert.equal(err.data.platform_title, 'Too Many Requests');
  assert.equal(Array.from(err.data.platform_detail ?? '').length, FIELD_CAPS.errorText);
});

test('a zero-width character cannot steer a response into the wrong error class', () => {
  // Sanitizing on ingest (parseProblem) rather than at the two `data` builders means the
  // classifiers read the CLEANED text: a zero-width space inside `scope` can no longer hide
  // the word from looksLikeScope and downgrade a scope failure to a generic forbidden one.
  const scoped = mapHttpError(403, {}, { detail: `Your token is missing a sco${ZWSP}pe.` });
  assert.equal(scoped.kind, 'scope');
  const billed = mapHttpError(
    403,
    {},
    { detail: `Client is not en${ZWSP}rolled in this product.` },
  );
  assert.equal(billed.kind, 'billing');
});

// --- REND-2: partial failures surface as missing[], NOT a thrown error -------------

test('200-with-errors[] yields missing[] with classified reasons, never throws — REND-2', () => {
  const fx = load('200-partial-missing.json');
  // The partial path is a pure extraction — it must not go through mapHttpError / throw.
  const missing: readonly Missing[] = collectMissing(fx.body);
  assert.equal(missing.length, 3);

  const byId = new Map(missing.map((m) => [m.id, m]));
  assert.equal(byId.get('20')?.reason, 'not-found');
  assert.equal(byId.get('20')?.resource_type, 'tweet');
  assert.equal(byId.get('111111')?.reason, 'suspended');
  assert.equal(byId.get('999999')?.reason, 'unauthorized');
});

test('collectMissing surfaces only safe scalars — no raw platform detail leaks — REND-2, REND-7', () => {
  const fx = load('200-partial-missing.json');
  const missing = collectMissing(fx.body);
  const serialized = JSON.stringify(missing);
  assert.equal(serialized.includes('SENTINEL_SECRET'), false);
  assert.equal(serialized.includes('Could not find'), false); // no free-form detail prose
});

test('collectMissing is total: a full-success or zero-results body yields []', () => {
  assert.deepEqual(collectMissing({ data: [{ id: '1' }] }), []);
  assert.deepEqual(collectMissing({ meta: { result_count: 0 } }), []); // REND-1 zero-results
  assert.deepEqual(collectMissing('not-an-object'), []);
  assert.deepEqual(collectMissing(null), []);
});

// --- Header handling parity: Headers object vs plain record -----------------------

test('mapHttpError reads a real Headers object identically to a record (RATE-4 tolerant)', () => {
  const resetEpoch = 1900000000;
  const nowMs = (resetEpoch - 45) * 1000;
  const headers = new Headers({ 'x-rate-limit-reset': String(resetEpoch) });
  const err = mapHttpError(429, headers, { title: 'Too Many Requests' }, nowMs);
  assert.equal(err.kind, 'rate-limit');
  assert.equal(err.data.retry_after_seconds, 45);

  // No rate-limit headers at all → still a rate-limit error, just without window fields (RATE-4).
  const bare = mapHttpError(429, {}, {}, nowMs);
  assert.equal(bare.kind, 'rate-limit');
  assert.equal(bare.data.reset_at, undefined);
  assert.equal(bare.data.retry_after_seconds, undefined);
});
