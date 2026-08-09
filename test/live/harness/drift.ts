// Fixture-shape drift detection — the live half of T-132 / DRIFT-1. Owned by the live-test
// slice.
//
// Every offline test in this repo is only as truthful as the fixtures under
// `test/fixtures/`. Those were captured (or, in a few cases, hand-built) at a point in time;
// nothing in CI can notice when X changes a response shape, because CI never talks to X.
// The cheap live read spot-checks close that gap: call the SAME production endpoint wrapper
// the fixture was captured through, and compare the shape of what comes back with the shape
// of the fixture.
//
// "Shape" here means the set of `path -> JSON type` pairs, with array indices collapsed to
// `[]`, so a 3-element list and a 10-element list of the same thing have the same shape.
//
// WHAT COUNTS AS DRIFT is deliberately asymmetric, because the two directions mean very
// different things:
//
//   * A path present in BOTH with a DIFFERENT type is BREAKING. `public_metrics.like_count`
//     turning from a number into a string is exactly the class of change that silently
//     corrupts a renderer, and it is the reason this check exists.
//   * A path the probe declares REQUIRED but that live is missing is BREAKING. The required
//     set is small and explicit per probe (the envelope keys the renderer cannot work
//     without), so it does not fire on a legitimately absent optional field.
//   * Everything else — a field the fixture has and live does not, a field live has and the
//     fixture does not — is INFORMATIONAL. Optional fields come and go per record (a post
//     with no `note_tweet`, a user with no `location`), and X adds fields additively. These
//     are printed as a readable diff for the human to read, not failed on.
//
// The whole module is pure and offline; test/live/drift.test.ts exercises every branch of it
// in the normal (ungated) suite.

/** The JSON type names the comparison distinguishes. */
export type JsonType = 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object';

/** A flattened value shape: `path` → JSON type, array indices collapsed to `[]`. */
export type Shape = ReadonlyMap<string, JsonType>;

function typeOf(value: unknown): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'boolean' || t === 'number' || t === 'string') return t;
  return 'object';
}

/**
 * Flatten a JSON value into `path -> type` pairs. Array elements collapse onto one `[]`
 * path, so the shape of a list does not depend on its length; when elements disagree the
 * first type wins and the disagreement surfaces as a normal type conflict against the other
 * side.
 */
export function shapeOf(value: unknown, prefix = ''): Shape {
  const out = new Map<string, JsonType>();

  function walk(node: unknown, path: string): void {
    const type = typeOf(node);
    if (path !== '') out.set(path, type);
    if (type === 'array') {
      for (const item of node as unknown[]) walk(item, `${path}[]`);
      return;
    }
    if (type === 'object') {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        walk(child, path === '' ? key : `${path}.${key}`);
      }
    }
  }

  walk(value, prefix);
  return out;
}

/**
 * Drop the fixture-only metadata keys before shaping. Every fixture carries a top-level
 * `_provenance` string that is documentation, not part of the X API envelope; comparing it
 * against a live response would report it as drift on every single run.
 */
export function stripFixtureMeta(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!key.startsWith('_')) out[key] = child;
  }
  return out;
}

/** One path present in both shapes with different types. */
export interface TypeConflict {
  readonly path: string;
  readonly fixture: JsonType;
  readonly live: JsonType;
}

/** The result of comparing a fixture's shape with a live response's shape. */
export interface DriftReport {
  /** Type conflicts — always breaking. */
  readonly conflicts: readonly TypeConflict[];
  /** Declared-required paths the live response does not carry — breaking. */
  readonly missingRequired: readonly string[];
  /** In the fixture, not in live. Informational (optional fields legitimately vary). */
  readonly onlyInFixture: readonly string[];
  /** In live, not in the fixture. Informational (X adds fields additively). */
  readonly onlyInLive: readonly string[];
  /** True when nothing breaking was found. */
  readonly ok: boolean;
}

/** Compare two shapes. `required` names the paths the live side must carry. */
export function diffShapes(
  fixture: Shape,
  live: Shape,
  required: readonly string[] = [],
): DriftReport {
  const conflicts: TypeConflict[] = [];
  const onlyInFixture: string[] = [];
  const onlyInLive: string[] = [];

  for (const [path, fixtureType] of fixture) {
    const liveType = live.get(path);
    if (liveType === undefined) onlyInFixture.push(path);
    else if (liveType !== fixtureType)
      conflicts.push({ path, fixture: fixtureType, live: liveType });
  }
  for (const path of live.keys()) {
    if (!fixture.has(path)) onlyInLive.push(path);
  }

  const missingRequired = required.filter((path) => !live.has(path));

  return {
    conflicts,
    missingRequired,
    onlyInFixture: onlyInFixture.sort(),
    onlyInLive: onlyInLive.sort(),
    ok: conflicts.length === 0 && missingRequired.length === 0,
  };
}

/** Render a drift report as the readable diff a live run prints. */
export function formatDrift(label: string, fixturePath: string, report: DriftReport): string {
  const lines = [`drift check: ${label} (fixture ${fixturePath})`];
  if (report.ok && report.onlyInFixture.length === 0 && report.onlyInLive.length === 0) {
    lines.push('  shapes are identical');
    return lines.join('\n');
  }
  for (const c of report.conflicts) {
    lines.push(`  BREAKING type changed  ${c.path}: fixture ${c.fixture} -> live ${c.live}`);
  }
  for (const path of report.missingRequired) {
    lines.push(`  BREAKING required path absent from the live response: ${path}`);
  }
  for (const path of report.onlyInFixture) lines.push(`  - ${path}  (fixture only)`);
  for (const path of report.onlyInLive) lines.push(`  + ${path}  (live only)`);
  return lines.join('\n');
}

/** Throwing form: fails the test on breaking drift only, with the full diff in the message. */
export function assertNoBreakingDrift(
  label: string,
  fixturePath: string,
  report: DriftReport,
): void {
  if (report.ok) return;
  throw new Error(formatDrift(label, fixturePath, report));
}
