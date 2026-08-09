// The COST-6 capture harness (docs/07 COST-6; docs/05 §6 "the one required live capture").
// Owned by the live-test slice.
//
// COST-6 is the one corner case Phase-1 could not close offline: nobody has seen the real
// body X returns when a pay-per-use account runs out of credit. `test/fixtures/errors/
// 403-billing-access-level.json` stands in for it and says PROVISIONAL in its `_provenance`
// precisely because it is a guess. This module turns "run out of credit and look at the
// response" into a repeatable recording.
//
// WHERE IT HOOKS IN. `mcp/compose` builds its error mappers internally and exposes no
// `mapError` seam in `ComposeOverrides`, so the capture cannot be bolted onto the composed
// server without changing frozen composition code. It therefore runs on its own thin path:
// `createHttpClient` (the same production client compose uses) with the production
// `mapHttpError` wrapped in {@link recordingErrorMapper}. The classification that decides
// whether a response is "billing" is thus the REAL one — the recorder only observes it.
// Consequence: the capture path does not exercise the rate-limit tracker or the tool
// pipeline, which is fine, because the artifact it produces is a raw HTTP response.
//
// WHAT IT RECORDS. Status, headers, and body exactly as they arrived (the body already
// through api/http's tolerant parse: parsed JSON, or the raw string when it was not JSON).
// Headers whose NAME looks credential-bearing are redacted before anything is written,
// because the artifact is meant to be committed.
//
// The written file deliberately does NOT overwrite the provisional fixture. It lands beside
// it under a `.captured.json` name with a `_provenance` string that says, in order, exactly
// what to check and what to edit to promote it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { HeaderSource } from '../../../src/api/errors.js';
import type { ErrorMapper } from '../../../src/api/http.js';
import { XError } from '../../../src/core/errors.js';

/** A raw rejection, recorded verbatim. The exact shape of a `test/fixtures/errors/*.json`. */
export interface RawRejection {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** A fixture file as written: a rejection plus the provenance header every fixture carries. */
export interface CapturedFixture extends RawRejection {
  readonly _provenance: string;
}

/** Header NAMES whose values never reach a committed file. */
export const SENSITIVE_HEADER_PATTERN = /authorization|cookie|token|secret|api[-_]?key|bearer/i;

/** The redaction placeholder. */
export const REDACTED = '[redacted]';

/** The directory captures are written to — beside the fixture they are meant to replace. */
export const CAPTURE_DIR: readonly string[] = ['test', 'fixtures', 'errors'];

/** The file a capture lands in. The `.captured` marker says "not promoted yet". */
export const CAPTURE_FILE_NAME = 'billing-out-of-credits.captured.json';

/** Normalize any header source into a plain, lower-cased, redacted record. */
export function headersToRecord(headers: HeaderSource): Record<string, string> {
  const out: Record<string, string> = {};
  const entries: [string, string][] = [];

  // A real `Headers` is iterable; a fixture's plain record is not.
  if (typeof (headers as { forEach?: unknown }).forEach === 'function') {
    (headers as unknown as { forEach(cb: (value: string, key: string) => void): void }).forEach(
      (value, key) => entries.push([key, value]),
    );
  } else {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (value === undefined) continue;
      // Header values are strings, numbers, or (node:http style) an array of either. Anything
      // else is not a header, so it is DROPPED rather than stringified: `String({})` yields
      // "[object Object]", which would land in a captured fixture looking like a real recorded
      // value and quietly outlive the mistake that produced it.
      const first: unknown = Array.isArray(value) ? value[0] : value;
      if (typeof first === 'string') entries.push([key, first]);
      else if (typeof first === 'number') entries.push([key, String(first)]);
    }
  }

  for (const [key, value] of entries) {
    const name = key.toLowerCase();
    out[name] = SENSITIVE_HEADER_PATTERN.test(name) ? REDACTED : value;
  }
  return out;
}

/**
 * Wrap an {@link ErrorMapper} so every rejection the REAL mapper classifies as `billing`
 * is recorded verbatim. The mapper's own return value is passed through untouched — the
 * recorder observes, it never influences classification.
 */
export function recordingErrorMapper(
  inner: ErrorMapper,
  onBilling: (rejection: RawRejection) => void,
): ErrorMapper {
  return (status, headers, body) => {
    const mapped = inner(status, headers, body);
    if (XError.is(mapped) && mapped.kind === 'billing') {
      onBilling({ status, headers: headersToRecord(headers), body });
    }
    return mapped;
  };
}

/** A recorder plus the list it fills. */
export interface BillingRecorder {
  readonly mapError: ErrorMapper;
  /** Every billing rejection seen, in arrival order. */
  readonly captured: readonly RawRejection[];
}

/** Build a {@link BillingRecorder} over the production mapper (or a stand-in, in tests). */
export function createBillingRecorder(inner: ErrorMapper): BillingRecorder {
  const captured: RawRejection[] = [];
  return {
    mapError: recordingErrorMapper(inner, (r) => captured.push(r)),
    captured,
  };
}

/** What the capture knows about the circumstances, for the provenance string. */
export interface CaptureContext {
  /** e.g. `GET /2/users/me`. */
  readonly endpoint: string;
  /** `app-only` or `oauth2 user context`. */
  readonly authContext: string;
  /** ISO timestamp. Injected so the builder is deterministic in tests. */
  readonly capturedAt: string;
}

/**
 * The `_provenance` header the captured fixture carries. Same convention as every other
 * fixture (a single prose string, first key in the file), but written as a CHECKLIST: the
 * promotion steps are the point of the capture, so they are impossible to miss.
 */
export function captureProvenance(rejection: RawRejection, ctx: CaptureContext): string {
  return (
    `CAPTURED LIVE — NOT PROMOTED YET. Raw HTTP ${String(rejection.status)} recorded by the gated ` +
    `live suite (test/live/billing-capture.live.test.ts) on ${ctx.capturedAt}, from ` +
    `${ctx.endpoint} in ${ctx.authContext}, against an X account whose pay-per-use credit was ` +
    `exhausted. This is the COST-6 capture docs/05 §6 calls the one required live artifact. ` +
    `Status, headers and body are verbatim; header names matching ` +
    `${SENSITIVE_HEADER_PATTERN.source} were replaced with "${REDACTED}". ` +
    `TO PROMOTE: (1) read the body and confirm it is the out-of-credits rejection and carries ` +
    `no account identifiers; (2) rename this file to ` +
    `${String(rejection.status)}-billing-out-of-credits.json; (3) replace this whole ` +
    `_provenance string with the settled form — "Real X API v2 ${String(rejection.status)} ` +
    `pay-per-use billing rejection. Captured ${ctx.capturedAt.slice(0, 10)} from a live account ` +
    `with exhausted credit (COST-6). Exercises: billing class (COST-6/7), distinct from the ` +
    `local budget class."; (4) add a case to test/api/errors.test.ts asserting it maps to kind ` +
    `"billing"; (5) drop the PROVISIONAL marker from 403-billing-access-level.json's ` +
    `_provenance, or delete that fixture if this one supersedes it. See docs/14-live-testing.md §6.`
  );
}

/** Build the fixture object. Pure — the caller decides whether to write it. */
export function buildBillingFixture(rejection: RawRejection, ctx: CaptureContext): CapturedFixture {
  return {
    _provenance: captureProvenance(rejection, ctx),
    status: rejection.status,
    headers: rejection.headers,
    body: rejection.body,
  };
}

/**
 * Write a captured fixture. Returns the absolute path written. `baseDir` defaults to the
 * repo root the npm scripts run from — the same `process.cwd()` anchor `loadFixture` uses,
 * because tsc does not copy `.json` into `build/`.
 */
export function writeCapturedFixture(
  fixture: CapturedFixture,
  options: { readonly baseDir?: string; readonly fileName?: string } = {},
): string {
  const dir = join(options.baseDir ?? process.cwd(), ...CAPTURE_DIR);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, options.fileName ?? CAPTURE_FILE_NAME);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  return path;
}

/** The block printed after a successful capture, so promotion needs no doc lookup. */
export function promotionInstructions(path: string): string {
  return [
    '',
    '='.repeat(78),
    'COST-6 CAPTURED — a real billing rejection was recorded.',
    `  written to : ${path}`,
    '  next       : read the file, then follow the numbered steps in its _provenance string.',
    '               Nothing was promoted automatically; the provisional fixture is untouched.',
    '='.repeat(78),
    '',
  ].join('\n');
}
