// Tests for test/live/harness/capture.ts — the COST-6 capture harness. UNGATED: this file
// runs in the normal `node --test` suite, in CI, on every commit.
//
// The capture itself is the one live artifact docs/05 §6 requires, and it runs at most a
// handful of times in the project's life — against a deliberately exhausted account, with
// the response about to be COMMITTED. That is exactly the kind of code that must be right
// the first time and cannot be debugged on the spot, so everything around the single live
// request is proven here offline: what the redaction catches, what the recorder records,
// what the provenance says, and where the file lands. No network; the only filesystem
// writes go into a `mkdtempSync` directory removed in `finally`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mapHttpError } from '../../src/api/errors.js';
import { XError, authError, billingError, forbiddenError } from '../../src/core/errors.js';

import { loadFixture } from '../helpers/index.js';
import {
  CAPTURE_DIR,
  CAPTURE_FILE_NAME,
  REDACTED,
  SENSITIVE_HEADER_PATTERN,
  buildBillingFixture,
  captureProvenance,
  createBillingRecorder,
  headersToRecord,
  promotionInstructions,
  recordingErrorMapper,
  writeCapturedFixture,
} from './harness/capture.js';
import type { CaptureContext, RawRejection } from './harness/capture.js';

/** The shape of a `test/fixtures/errors/*.json` file. */
interface ErrorFixture {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** A rejection as the recorder would hand it on: already-redacted headers, verbatim body. */
const REJECTION: RawRejection = {
  status: 403,
  headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': 'req-1' },
  body: { title: 'Client Forbidden', type: 'https://api.x.com/2/problems/client-not-enrolled' },
};

/** A deterministic capture context. */
const CONTEXT: CaptureContext = {
  endpoint: 'GET /2/users/me',
  authContext: 'oauth2 user context',
  capturedAt: '2026-09-18T10:11:12.000Z',
};

/** Run `fn` with a fresh temp directory that is removed afterwards, whatever happens. */
async function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'x-mcp-capture-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- headersToRecord: normalisation and redaction ---------------------------------------

test('headersToRecord flattens a real Headers instance into a lower-cased plain record', () => {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'X-Rate-Limit-Remaining': '0',
  });
  assert.deepEqual(headersToRecord(headers), {
    'content-type': 'application/json; charset=utf-8',
    'x-rate-limit-remaining': '0',
  });
});

test('headersToRecord accepts a plain record: strings kept, numbers stringified, arrays take the first value, undefined skipped', () => {
  const record = headersToRecord({
    'Content-Length': 42,
    'X-Request-Id': 'req-1',
    Vary: ['Accept', 'Origin'],
    'Retry-After': undefined,
  });
  assert.deepEqual(record, {
    'content-length': '42',
    'x-request-id': 'req-1',
    vary: 'Accept',
  });
});

test('headersToRecord DROPS a value that is not a header (an object, a boolean) instead of stringifying it into the fixture', () => {
  // `String({})` is "[object Object]" — a value that would look recorded and outlive the bug.
  const record = headersToRecord({
    'X-Object': { nested: true },
    'X-Bool': true,
    'X-Array-Of-Objects': [{ nested: true }],
    'X-Ok': 'kept',
  } as unknown as Record<string, string>);
  assert.deepEqual(record, { 'x-ok': 'kept' });
});

test('headersToRecord redacts every credential-bearing header NAME, case-insensitively, whatever its value', () => {
  const secrets: Record<string, string> = {
    Authorization: 'Bearer AAAA',
    authorization: 'OAuth oauth_token="t"',
    Cookie: 'session=abc',
    'Set-Cookie': 'guest_id=xyz; Path=/',
    'X-Api-Key': 'key-1',
    x_api_key: 'key-2',
    'X-ApiKey': 'key-3',
    'X-Auth-Token': 'tok-1',
    'X-Csrf-Token': 'tok-2',
    'Client-Secret': 'sec-1',
    'X-Bearer': 'b-1',
    'PROXY-AUTHORIZATION': 'Basic dXNlcjpwYXNz',
  };
  const record = headersToRecord(secrets);
  // Every one of them is present under its lower-cased name, and every value is gone.
  for (const name of Object.keys(secrets)) {
    assert.equal(record[name.toLowerCase()], REDACTED, `${name} must be redacted`);
  }
  // The pattern the provenance string advertises is the one that did the redacting.
  for (const name of Object.keys(secrets)) {
    assert.match(name, SENSITIVE_HEADER_PATTERN);
  }
  assert.equal(REDACTED, '[redacted]');
});

test('headersToRecord redacts on a Headers instance too, and passes innocuous headers through untouched', () => {
  const headers = new Headers({
    Authorization: 'Bearer AAAA',
    'Content-Type': 'application/problem+json',
    'X-Rate-Limit-Limit': '15',
    Date: 'Thu, 18 Sep 2026 10:11:12 GMT',
  });
  const record = headersToRecord(headers);
  assert.equal(record.authorization, REDACTED);
  assert.equal(record['content-type'], 'application/problem+json');
  assert.equal(record['x-rate-limit-limit'], '15');
  assert.equal(record.date, 'Thu, 18 Sep 2026 10:11:12 GMT');
  assert.equal(Object.keys(record).length, 4);
});

test('the sensitive-name pattern leaves ordinary names alone — no false positives on the headers X actually sends', () => {
  for (const name of [
    'content-type',
    'content-length',
    'date',
    'x-rate-limit-limit',
    'x-rate-limit-remaining',
    'x-rate-limit-reset',
    'x-app-limit-24hour-remaining',
    'x-request-id',
    'x-transaction-id',
    'retry-after',
    'strict-transport-security',
    'cache-control',
    'server',
  ]) {
    assert.doesNotMatch(name, SENSITIVE_HEADER_PATTERN, `${name} must not be redacted`);
  }
});

// --- recordingErrorMapper / createBillingRecorder ----------------------------------------

test('recordingErrorMapper calls the inner mapper and returns ITS result untouched — the recorder observes, it never classifies', () => {
  const seen: RawRejection[] = [];
  const innerCalls: [number, unknown][] = [];
  const billing = billingError('out of credit');
  const mapper = recordingErrorMapper(
    (status, _headers, body) => {
      innerCalls.push([status, body]);
      return billing;
    },
    (r) => seen.push(r),
  );

  const headers = new Headers({ 'content-type': 'application/json', Authorization: 'Bearer AAAA' });
  const body = { type: 'about:blank', detail: 'x' };
  const mapped = mapper(402, headers, body);

  assert.equal(mapped, billing, 'the very same XError instance must come back');
  assert.deepEqual(innerCalls, [[402, body]]);
  assert.deepEqual(seen, [
    {
      status: 402,
      headers: { 'content-type': 'application/json', authorization: REDACTED },
      body,
    },
  ]);
});

test('recordingErrorMapper records ONLY billing-class results: auth and forbidden rejections pass through unrecorded', () => {
  const seen: RawRejection[] = [];
  const outcomes = [authError('bad token'), forbiddenError('no'), billingError('out of credit')];
  let i = 0;
  const mapper = recordingErrorMapper(
    () => outcomes[i++] ?? billingError('unreachable'),
    (r) => seen.push(r),
  );

  const headers = new Headers({ 'content-type': 'application/json' });
  assert.equal(mapper(401, headers, { a: 1 }).kind, 'auth');
  assert.equal(mapper(403, headers, { b: 2 }).kind, 'forbidden');
  assert.equal(mapper(403, headers, { c: 3 }).kind, 'billing');
  assert.deepEqual(
    seen.map((r) => r.body),
    [{ c: 3 }],
  );
});

test('createBillingRecorder collects every billing rejection in arrival order, with the body verbatim', () => {
  const recorder = createBillingRecorder(() => billingError('out of credit'));
  const headers = new Headers({ 'content-type': 'application/json' });
  recorder.mapError(402, headers, { first: true });
  recorder.mapError(403, headers, 'not even json');
  assert.deepEqual(
    recorder.captured.map((r) => [r.status, r.body]),
    [
      [402, { first: true }],
      [403, 'not even json'],
    ],
  );
});

test('over the REAL mapHttpError, the provisional billing fixture is classified billing and lands in the recorder; the invalid-token fixture does not (COST-6)', () => {
  const billing = loadFixture<ErrorFixture>('errors/403-billing-access-level.json');
  const unauthorized = loadFixture<ErrorFixture>('errors/401-invalid-token.json');
  const recorder = createBillingRecorder(mapHttpError);

  const mappedBilling = recorder.mapError(
    billing.status,
    new Headers({ ...billing.headers, Authorization: 'Bearer AAAA' }),
    billing.body,
  );
  assert.ok(XError.is(mappedBilling));
  assert.equal(mappedBilling.kind, 'billing');

  const mappedAuth = recorder.mapError(
    unauthorized.status,
    new Headers(unauthorized.headers),
    unauthorized.body,
  );
  assert.equal(mappedAuth.kind, 'auth');

  assert.equal(recorder.captured.length, 1);
  assert.deepEqual(recorder.captured[0], {
    status: 403,
    headers: { ...billing.headers, authorization: REDACTED },
    body: billing.body,
  });
});

// --- captureProvenance / buildBillingFixture ---------------------------------------------

test('captureProvenance is marked CAPTURED LIVE — NOT PROMOTED YET, never PROVISIONAL, and names the live file, the date, the endpoint and the auth context', () => {
  const prov = captureProvenance(REJECTION, CONTEXT);
  assert.ok(prov.startsWith('CAPTURED LIVE — NOT PROMOTED YET. Raw HTTP 403 recorded by'), prov);
  // The provisional fixture's marker is a leading `PROVISIONAL.` — this one must not carry it.
  assert.doesNotMatch(prov, /^PROVISIONAL/);
  assert.ok(prov.includes('test/live/billing-capture.live.test.ts'));
  assert.ok(prov.includes(`on ${CONTEXT.capturedAt},`));
  assert.ok(prov.includes(`from ${CONTEXT.endpoint} in ${CONTEXT.authContext},`));
  assert.ok(prov.includes('COST-6'));
});

test('captureProvenance documents the redaction it applied: the exact pattern source and the placeholder', () => {
  const prov = captureProvenance(REJECTION, CONTEXT);
  assert.ok(prov.includes(SENSITIVE_HEADER_PATTERN.source));
  assert.ok(prov.includes(`"${REDACTED}"`));
});

test('captureProvenance spells out the five promotion steps, the promoted file name, the settled provenance with the capture date, and the supersession rule', () => {
  const prov = captureProvenance(REJECTION, CONTEXT);
  const promote = prov.slice(prov.indexOf('TO PROMOTE:'));
  assert.ok(promote.length > 0, 'the checklist must be present');
  for (const step of ['(1)', '(2)', '(3)', '(4)', '(5)']) {
    assert.ok(promote.includes(step), `step ${step} must be listed`);
  }
  // Steps come in order.
  const positions = ['(1)', '(2)', '(3)', '(4)', '(5)'].map((s) => promote.indexOf(s));
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
  );
  // (2): the promoted name is derived from the status that was actually recorded.
  assert.ok(promote.includes('rename this file to 403-billing-out-of-credits.json'));
  // (3): the settled form carries the DATE half of the timestamp, and only that.
  assert.ok(promote.includes('Captured 2026-09-18 from a live account'));
  assert.ok(!promote.includes('Captured 2026-09-18T'));
  // (4): the offline error test must learn the new case.
  assert.ok(promote.includes('add a case to test/api/errors.test.ts'));
  // (5): the provisional fixture is either un-marked or superseded — never silently kept.
  assert.ok(promote.includes("drop the PROVISIONAL marker from 403-billing-access-level.json's"));
  assert.ok(promote.includes('or delete that fixture if this one supersedes it'));
  assert.ok(promote.includes('docs/14-live-testing.md §6'));
});

test('captureProvenance follows the recorded status — a 402 capture promotes to a 402 file name', () => {
  const prov = captureProvenance({ ...REJECTION, status: 402 }, CONTEXT);
  assert.ok(prov.startsWith('CAPTURED LIVE — NOT PROMOTED YET. Raw HTTP 402 '));
  assert.ok(prov.includes('rename this file to 402-billing-out-of-credits.json'));
  assert.ok(prov.includes('"Real X API v2 402 pay-per-use billing rejection.'));
});

test('buildBillingFixture puts _provenance first and copies status, headers and body verbatim', () => {
  const fixture = buildBillingFixture(REJECTION, CONTEXT);
  assert.deepEqual(Object.keys(fixture), ['_provenance', 'status', 'headers', 'body']);
  assert.equal(fixture._provenance, captureProvenance(REJECTION, CONTEXT));
  assert.equal(fixture.status, REJECTION.status);
  assert.deepEqual(fixture.headers, REJECTION.headers);
  assert.deepEqual(fixture.body, REJECTION.body);
});

// --- writeCapturedFixture / promotionInstructions ----------------------------------------

test('writeCapturedFixture writes the .captured.json beside the error fixtures under baseDir, creating the directories, and the file round-trips', async () => {
  await withTempDir((dir) => {
    const fixture = buildBillingFixture(REJECTION, CONTEXT);
    const written = writeCapturedFixture(fixture, { baseDir: dir });

    assert.equal(written, join(dir, ...CAPTURE_DIR, CAPTURE_FILE_NAME));
    assert.equal(CAPTURE_FILE_NAME, 'billing-out-of-credits.captured.json');
    assert.deepEqual(CAPTURE_DIR, ['test', 'fixtures', 'errors']);
    assert.ok(existsSync(written));

    const text = readFileSync(written, 'utf8');
    assert.ok(text.endsWith('}\n'), 'pretty-printed with a trailing newline');
    assert.deepEqual(JSON.parse(text), fixture);
    // Key order survives the round-trip: `_provenance` is the first key in the file.
    assert.ok(text.startsWith('{\n  "_provenance": "CAPTURED LIVE — NOT PROMOTED YET.'));
  });
});

test('a captured fixture written from a recorded rejection carries redacted headers, never the credential', async () => {
  await withTempDir((dir) => {
    const recorder = createBillingRecorder(() => billingError('out of credit'));
    recorder.mapError(
      403,
      new Headers({
        Authorization: 'Bearer SECRET-VALUE',
        'Set-Cookie': 'guest_id=SECRET-COOKIE',
        'Content-Type': 'application/json',
      }),
      REJECTION.body,
    );
    const recorded = recorder.captured[0];
    assert.ok(recorded !== undefined);

    const written = writeCapturedFixture(buildBillingFixture(recorded, CONTEXT), { baseDir: dir });
    const text = readFileSync(written, 'utf8');
    assert.ok(!text.includes('SECRET-VALUE'));
    assert.ok(!text.includes('SECRET-COOKIE'));
    const parsed = JSON.parse(text) as { headers: Record<string, string> };
    assert.deepEqual(parsed.headers, {
      authorization: REDACTED,
      'set-cookie': REDACTED,
      'content-type': 'application/json',
    });
  });
});

test('writeCapturedFixture honours a fileName override and never touches the default name', async () => {
  await withTempDir((dir) => {
    const fixture = buildBillingFixture(REJECTION, CONTEXT);
    const written = writeCapturedFixture(fixture, { baseDir: dir, fileName: 'probe.json' });
    assert.equal(written, join(dir, ...CAPTURE_DIR, 'probe.json'));
    assert.ok(existsSync(written));
    assert.equal(existsSync(join(dir, ...CAPTURE_DIR, CAPTURE_FILE_NAME)), false);
  });
});

test('promotionInstructions names the written path, says COST-6 was captured, points at the _provenance checklist, and promises nothing was promoted', () => {
  const path = '/somewhere/test/fixtures/errors/billing-out-of-credits.captured.json';
  const block = promotionInstructions(path);
  const lines = block.split('\n');
  assert.equal(lines[0], '');
  assert.equal(lines[1], '='.repeat(78));
  assert.equal(lines[2], 'COST-6 CAPTURED — a real billing rejection was recorded.');
  assert.equal(lines[3], `  written to : ${path}`);
  assert.match(lines[4] ?? '', /follow the numbered steps in its _provenance string/);
  assert.match(
    lines[5] ?? '',
    /Nothing was promoted automatically; the provisional fixture is untouched/,
  );
  assert.equal(lines[6], '='.repeat(78));
  assert.equal(lines[7], '');
  assert.equal(lines.length, 8);
});
