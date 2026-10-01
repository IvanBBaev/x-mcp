// Tests for the HTTP → XError mapper (T-116, api/errors.ts). Each case drives the mapper
// from a fixture in test/fixtures/errors/ (loaded via loadFixture) so the corpus doubles as
// the provenance-checked shape record (DRIFT-4). Corner cases referenced: DX-F13 (every error
// carries actionable remediation), REND-2 (partial failures → missing[], not a thrown error),
// REND-7 (no third-party content / raw HTML in any error), plus AUTH-8, RATE-2/5/7, DRIFT-2,
// COST-6/7, NET-1, RATE-4, PAGE-2.

import test from 'node:test';
import assert from 'node:assert/strict';

import { XError } from '../../src/core/errors.js';
import { mapHttpError } from '../../src/api/errors.js';
import { renderMissing, renderPosts } from '../../src/core/render.js';
import type { RawListResponse, RawTweet } from '../../src/core/render.js';
import { PAGE_TOKEN_INVALID_MESSAGE } from '../../src/core/paginate.js';
import { FIELD_CAPS, TRUNCATION_MARKER } from '../../src/core/sanitize.js';
import { loadFixture } from '../helpers/index.js';

/** The scenario wrapper every fixture in test/fixtures/errors/ uses. */
interface ErrorScenario {
  readonly _provenance: string;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

test('COST-7: a usage-capped 429 is billing, not a rate limit to wait out', () => {
  const err = map('429-usage-capped.json');
  assert.equal(err.kind, 'billing');
  assert.equal(err.fix, 'operator');
  assert.equal(err.retryable, false);
  assert.equal(err.data.http_status, 429);
  // No reset window is advertised: the fixture's near reset would otherwise invite a retry.
  assert.equal(err.data.reset_at, undefined);
  assert.equal(err.data.retry_after_seconds, undefined);
  assert.equal(err.data.platform_title, 'UsageCapExceeded');
  assert.match(String(err.data.platform_detail), /Monthly product cap/);
  assert.match(err.message, /monthly usage cap/);
  assert.match(err.message, /NOT the local session budget/);
  assert.match(err.message, /NOT a rate-limit window/);
});

test('COST-7: the cap is recognised by its type or by its title/detail alone', () => {
  const byTitle = mapHttpError(429, {}, { title: 'UsageCapExceeded' });
  assert.equal(byTitle.kind, 'billing');
  const byDetail = mapHttpError(429, {}, { detail: 'Usage cap exceeded: Monthly product cap' });
  assert.equal(byDetail.kind, 'billing');
  // An ordinary 429 — and one merely mentioning credits — stays a rate limit.
  assert.equal(map('429-rate-limit.json').kind, 'rate-limit');
  assert.equal(
    mapHttpError(429, {}, { detail: 'Too many requests for your credits' }).kind,
    'rate-limit',
  );
});

/** All fixtures that represent a real error RESPONSE (i.e. everything except the 200 partial). */
const ERROR_FIXTURES = [
  '401-invalid-token.json',
  '401-insufficient-scope.json',
  '403-duplicate-content.json',
  '403-suspended-target.json',
  '403-insufficient-scope.json',
  '403-billing-access-level.json',
  '402-payment-required.json',
  '429-rate-limit.json',
  '429-usage-capped.json',
  '404-not-found.json',
  '502-html.json',
  '500-json.json',
  '400-unmapped.json',
  '400-invalid-pagination-token.json',
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

test('a scope signal without a dotted scope name still maps to scope; the name is simply omitted — DX-F13', () => {
  // The fixtures all name the missing scope (`users.read`); a body that only SAYS "scope" — or
  // signals it through `type` alone, with no detail at all — has nothing for `data.scope`, and
  // the message must not render an empty parenthetical.
  const type = 'https://api.twitter.com/2/problems/oauth-scopes-insufficient';
  const bodies = [
    {
      title: 'Forbidden',
      type,
      detail: 'Your token is missing a required scope for this endpoint.',
    },
    { title: 'Forbidden', type },
  ];
  for (const body of bodies) {
    for (const status of [401, 403]) {
      const err = mapHttpError(status, {}, body);
      assert.equal(err.kind, 'scope', `status ${status}`);
      assert.equal(err.data.scope, undefined);
      assert.doesNotMatch(err.message, /\(`/);
      assert.match(err.message, /authorize/);
    }
  }
});

test('403 billing/entitlement maps to billing, distinct from the local budget class — COST-6/7', () => {
  const err = map('403-billing-access-level.json');
  assert.equal(err.kind, 'billing');
  assert.equal(err.fix, 'operator');
  assert.equal(err.retryable, false);
  assert.match(err.message, /credit|access level|entitlement/i);
  assert.match(err.message, /not.*the local session budget/i); // billing ≠ budget
});

test('402 maps to billing on the status alone — the body need not name credits — COST-6', () => {
  // The fixture body is deliberately neutral (no credit / entitlement wording): unlike the 403
  // path, which has to sniff the problem text, a 402 IS the billing signal.
  const err = map('402-payment-required.json');
  assert.equal(err.kind, 'billing');
  assert.equal(err.fix, 'operator');
  assert.equal(err.retryable, false);
  assert.equal(err.data.http_status, 402);
  assert.match(err.message, /not.*the local session budget/i);
  // Same remediation prose as the 403 variant — one billing story, two status codes.
  assert.equal(err.message, map('403-billing-access-level.json').message);
  // And with no body at all the class still holds — nothing to sniff, nothing needed.
  assert.equal(mapHttpError(402, {}, undefined).kind, 'billing');
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

test('a 400 rejecting the pagination cursor maps to validation (agent), not api — PAGE-2', () => {
  const err = map('400-invalid-pagination-token.json');
  assert.equal(err.kind, 'validation');
  assert.equal(err.fix, 'agent');
  assert.equal(err.retryable, false);
  assert.equal(err.message, PAGE_TOKEN_INVALID_MESSAGE);
  // The platform prose still passes through (DRIFT-2); the echoed cursor stays out of the message.
  assert.equal(err.data.http_status, 400);
  assert.equal(err.data.platform_title, 'Invalid Request');
  assert.equal(err.message.includes('cursor==stale'), false);
});

test('the cursor is recognised by parameter key or message, under either wire name, in any entry — PAGE-2', () => {
  const byKey = mapHttpError(400, {}, { errors: [{ parameters: { next_token: ['x'] } }] });
  assert.equal(byKey.kind, 'validation');

  const byMessage = mapHttpError(
    400,
    {},
    {
      errors: [{ message: 'The `next_token` query parameter value [x] is not valid' }],
    },
  );
  assert.equal(byMessage.kind, 'validation');

  // A multi-parameter rejection still names the cursor, even when it is not the first entry.
  const second = mapHttpError(
    400,
    {},
    {
      errors: [
        'not an object',
        { parameters: { max_results: ['500'] }, message: 'The `max_results` value is not valid' },
        { parameters: { pagination_token: ['x'] } },
      ],
    },
  );
  assert.equal(second.kind, 'validation');
});

test('a cursor mention outside a 400, or a 400 without one, keeps its normal class — PAGE-2, DRIFT-2', () => {
  const body = { errors: [{ parameters: { pagination_token: ['x'] } }] };
  assert.equal(mapHttpError(404, {}, body).kind, 'not-found');
  assert.equal(mapHttpError(500, {}, body).kind, 'api');
  // Only whole parameter names count — a look-alike name is not the cursor.
  const lookAlike = { errors: [{ parameters: { pagination_tokens: ['x'] }, message: 'bad' }] };
  assert.equal(mapHttpError(400, {}, lookAlike).kind, 'api');
  assert.equal(mapHttpError(400, {}, { errors: 'nope' }).kind, 'api');
});

test('a legacy errors[].message body with no top-level problem fields still yields title/detail — DRIFT-2', () => {
  // The v1.1-era shape has neither `title` nor `detail` at the top level: both come from the
  // first entry, `title`/`detail` when present, else the single `message`.
  const legacy = mapHttpError(
    400,
    {},
    { errors: [{ message: 'Sorry, that page does not exist', code: 34 }] },
  );
  assert.equal(legacy.kind, 'api');
  assert.equal(legacy.data.platform_title, 'Sorry, that page does not exist');
  assert.equal(legacy.data.platform_detail, 'Sorry, that page does not exist');

  const nested = mapHttpError(
    400,
    {},
    { errors: [{ title: 'Invalid Request', detail: 'Bad id.' }] },
  );
  assert.equal(nested.data.platform_title, 'Invalid Request');
  assert.equal(nested.data.platform_detail, 'Bad id.');
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

test('markup is recognised by its first byte when the content-type does not say html — REND-7, NET-1', () => {
  // The 502 fixture is caught by its `text/html` content-type; a gateway that mislabels its
  // error page (or serves XML) is caught by the leading `<` instead — the page is still dropped.
  const pages: ReadonlyArray<readonly [Record<string, string>, string]> = [
    [{ 'content-type': 'application/xml' }, '<?xml version="1.0"?><error>SENTINEL_SECRET</error>'],
    [{ 'content-type': 'application/octet-stream' }, '<!DOCTYPE html><p>SENTINEL_SECRET</p>'],
    [{}, '  <html><body>SENTINEL_SECRET</body></html>'],
  ];
  for (const [headers, body] of pages) {
    const err = mapHttpError(503, headers, body);
    assert.equal(err.kind, 'api');
    assert.equal(err.retryable, true);
    assert.match(err.message, /non-JSON HTML error page/);
    assert.doesNotMatch(err.message, /</, `markup leaked for ${body.slice(0, 12)}`);
    assert.equal(err.message.includes('SENTINEL_SECRET'), false);
    assert.equal(err.data.platform_detail, undefined);
  }
  // A non-markup string body (truncated JSON) takes the generic unmapped path instead.
  const truncated = mapHttpError(503, {}, '{"title":"Service Unav');
  assert.equal(truncated.kind, 'api');
  assert.doesNotMatch(truncated.message, /HTML/);
  assert.equal(truncated.message.includes('Service Unav'), false);
});

test('an HTML page with an unmapped 4xx status says "do not retry" and is not retryable — REND-7, DRIFT-2', () => {
  // Same drop-the-markup path as the 502 above, but a 4xx is not transient: the remediation
  // must not invite the retry the 5xx wording allows.
  const err = mapHttpError(400, { 'content-type': 'text/html' }, '<html>SENTINEL_SECRET</html>');
  assert.equal(err.kind, 'api');
  assert.equal(err.retryable, false);
  assert.match(err.message, /non-JSON HTML error page with HTTP 400/);
  assert.match(err.message, /do not retry/);
  assert.doesNotMatch(err.message, /may retry once/);
  assert.doesNotMatch(err.message, /</);
  assert.equal(err.data.platform_detail, undefined);
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
  // The partial path is a pure render — it must not go through mapHttpError / throw.
  const out = renderPosts(fx.body as RawListResponse<RawTweet>);
  assert.equal(out.items.length, 1);
  assert.deepEqual(out.missing, [
    { id: '20', reason: 'not-found' },
    // X sends a suspended user as `Forbidden` + resource-not-found; only `detail` says why.
    { id: '111111', reason: 'suspended' },
    { id: '999999', reason: 'protected' },
  ]);
});

test('missing[] surfaces only safe scalars — no raw platform detail leaks — REND-2, REND-7', () => {
  const fx = load('200-partial-missing.json');
  const serialized = JSON.stringify(renderPosts(fx.body as RawListResponse<RawTweet>).missing);
  assert.equal(serialized.includes('SENTINEL_SECRET'), false);
  assert.equal(serialized.includes('Could not find'), false); // no free-form detail prose
});

test('missing[] classifies detail-only protected and deleted signals and tolerates sparse entries — REND-2', () => {
  assert.deepEqual(
    renderMissing([
      // No `resource_id` → the requested `value` is the id.
      { value: '1', title: 'Forbidden', detail: 'User [1] is protected.' },
      { resource_id: '2', resource_type: 'tweet', detail: 'The Tweet [2] has been deleted.' },
      { title: 'Not Found Error' },
      // No id field and no classifiable text at all → empty id, unavailable.
      {},
    ]),
    [
      { id: '1', reason: 'protected' },
      { id: '2', reason: 'deleted' },
      { id: '', reason: 'not-found' },
      { id: '', reason: 'unavailable' },
    ],
  );
});

test('missing[] is total: no errors[] yields no missing key — REND-2', () => {
  assert.deepEqual(renderMissing(undefined), []);
  assert.equal('missing' in renderPosts({ data: [{ id: '1' }] }), false);
  assert.equal('missing' in renderPosts({ meta: { result_count: 0 } }), false); // REND-1
});

test('an unparseable x-rate-limit-reset is treated as absent — backoff prose, no reset_at — RATE-4', () => {
  const nowMs = 1900000000000;
  for (const reset of ['soon', 'Infinity', 'NaN']) {
    const err = mapHttpError(429, { 'x-rate-limit-reset': reset }, {}, nowMs);
    assert.equal(err.kind, 'rate-limit', reset);
    assert.equal(err.data.reset_at, undefined, reset);
    assert.equal(err.data.retry_after_seconds, undefined, reset);
    assert.match(err.message, /Retry after a short backoff/);
    assert.doesNotMatch(err.message, /resets at/);
  }
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

test('mapHttpError reads Node-style header records: numeric, string[] and absent values (RATE-4 tolerant)', () => {
  const resetEpoch = 1900000000;
  const nowMs = (resetEpoch - 45) * 1000;
  const body = { title: 'Too Many Requests' };

  // `IncomingHttpHeaders` may carry a number, and a repeated header arrives as an array —
  // the first value is the one that counts. Case is matched loosely on the key.
  const numeric = mapHttpError(429, { 'X-Rate-Limit-Reset': resetEpoch }, body, nowMs);
  assert.equal(numeric.data.retry_after_seconds, 45);
  const repeated = mapHttpError(
    429,
    { 'x-rate-limit-reset': [String(resetEpoch), '1'] },
    body,
    nowMs,
  );
  assert.equal(repeated.data.retry_after_seconds, 45);

  // A key present with an `undefined` value is the same as no header at all (RATE-4), and so
  // is a repeated header that arrived with no values.
  for (const value of [undefined, []] as const) {
    const absent = mapHttpError(429, { 'x-rate-limit-reset': value }, body, nowMs);
    assert.equal(absent.kind, 'rate-limit');
    assert.equal(absent.data.reset_at, undefined);
    assert.equal(absent.data.retry_after_seconds, undefined);
  }
});
