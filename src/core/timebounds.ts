// Inbound time-bound normalization (REND-9), shared by every tool that accepts
// `start_time`/`end_time` (timelines, recent/archive search, recent/archive counts). Pure: the
// caller passes `now` from the clock port, so the clamp is deterministic under test.

import { validationError } from './errors.js';
import { toIso } from './render.js';

/**
 * X rejects an `end_time` within roughly the last 10 seconds of now with a 400. Instead of
 * surfacing that quirk, the tools clamp the value server-side to `now - 10 s` (REND-9) and
 * tell the agent via a note.
 */
export const END_TIME_MIN_AGE_MS = 10_000;

/** Normalized time-bound request params plus the agent-facing notes they generated. */
export interface TimeBounds {
  readonly startTime?: string;
  readonly endTime?: string;
  readonly notes: readonly string[];
}

/** Echo an agent-supplied value in an error, trimmed and length-capped. */
function preview(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

/** Normalize one time bound to ISO-8601 UTC, or throw a `validation` error naming it. */
function isoBound(name: 'start_time' | 'end_time', value: string): string {
  const iso = toIso(value);
  if (iso === undefined) {
    throw validationError(
      `${name} is not a recognizable timestamp: "${preview(value)}" (use ISO-8601 UTC).`,
    );
  }
  return iso;
}

/**
 * Validate + normalize `start_time`/`end_time` to ISO-8601 UTC (REND-9) and clamp an
 * `end_time` inside the API's rejection window to `now - 10 s`, noting the adjustment.
 * Throws a `validation` error for an unparseable bound — callers run this before any HTTP.
 */
export function normalizeTimeBounds(
  input: { readonly start_time?: string | undefined; readonly end_time?: string | undefined },
  nowMs: number,
): TimeBounds {
  const notes: string[] = [];
  const startTime =
    input.start_time !== undefined ? isoBound('start_time', input.start_time) : undefined;
  let endTime = input.end_time !== undefined ? isoBound('end_time', input.end_time) : undefined;

  if (endTime !== undefined) {
    const cutoff = nowMs - END_TIME_MIN_AGE_MS;
    if (Date.parse(endTime) > cutoff) {
      endTime = new Date(cutoff).toISOString();
      notes.push(
        `end_time adjusted to ${endTime} (X requires end_time at least 10 seconds in the past).`,
      );
    }
  }

  return {
    ...(startTime !== undefined ? { startTime } : {}),
    ...(endTime !== undefined ? { endTime } : {}),
    notes,
  };
}
