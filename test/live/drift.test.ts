// Tests for test/live/harness/drift.ts — fixture-shape drift detection (DRIFT-1 live half).
// UNGATED: this file runs in the normal `node --test` suite, in CI, on every commit.
//
// The live read spot-checks cannot run in CI (they spend real credits, docs/05 §6), so the
// only part of drift detection CI can protect is the COMPARISON — the logic that decides
// whether a difference between a fixture and a live response is breaking or merely
// informational. That decision is asymmetric on purpose, and a comparison whose branches are
// never exercised can fail silently in the one direction that matters: a real type change
// filed as "informational" and printed rather than failed on. So every branch is driven here
// from inline literals shaped like real X envelopes — no fixture loaded from disk, no
// network, no dependence on the ambient environment.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertNoBreakingDrift,
  diffShapes,
  formatDrift,
  shapeOf,
  stripFixtureMeta,
} from './harness/drift.js';
import type { DriftReport, JsonType, Shape } from './harness/drift.js';

/** Build a shape literal without spelling out `new Map` at every call site. */
const shape = (entries: Readonly<Record<string, JsonType>>): Shape =>
  new Map(Object.entries(entries));

/** One user record in the form `/2/users/by` returns it. Individual tests vary a field. */
const USER = {
  id: '2244994945',
  name: 'jack',
  username: 'jack',
  verified: true,
  protected: false,
  public_metrics: { followers_count: 6000000, following_count: 4000 },
};

/** A fixture as it sits on disk: an X envelope plus the top-level provenance note. */
const USERS_FIXTURE = {
  _provenance: 'X API v2 GET /2/users/by — shapes verbatim from the data dictionary.',
  data: [USER, { ...USER, id: '783214', username: 'x', location: 'everywhere' }],
};

// --- shapeOf: flattening ---------------------------------------------------------------

test('shapeOf records every JSON type by path and never records the unnamed root', () => {
  const result = shapeOf({
    nothing: null,
    flag: true,
    count: 3,
    text: 'hi',
    list: [1],
    nested: { inner: 'x' },
  });
  assert.deepEqual(
    result,
    shape({
      nothing: 'null',
      flag: 'boolean',
      count: 'number',
      text: 'string',
      list: 'array',
      'list[]': 'number',
      nested: 'object',
      'nested.inner': 'string',
    }),
  );
  assert.equal(result.has(''), false, 'the root has no path and must not appear');
});

test('nested objects flatten to dotted paths, every container recorded along the way', () => {
  const result = shapeOf({ data: { public_metrics: { like_count: 12 } } });
  assert.deepEqual(
    result,
    shape({
      data: 'object',
      'data.public_metrics': 'object',
      'data.public_metrics.like_count': 'number',
    }),
  );
});

test('array indices collapse to [] so the shape of a list does not depend on its length', () => {
  const one = shapeOf({ data: [USER] });
  const three = shapeOf({ data: [USER, USER, USER] });
  const ten = shapeOf({ data: Array.from({ length: 10 }, () => USER) });
  assert.deepEqual(three, one);
  assert.deepEqual(ten, one);
  assert.equal(one.get('data[]'), 'object');
  assert.equal(one.get('data[].public_metrics.followers_count'), 'number');
  for (const path of one.keys()) {
    assert.doesNotMatch(path, /\[\d+\]/, `${path} must not carry a numeric index`);
  }
});

test('arrays of arrays collapse at every level', () => {
  const result = shapeOf({ matrix: [[1], [2, 3]] });
  assert.deepEqual(result, shape({ matrix: 'array', 'matrix[]': 'array', 'matrix[][]': 'number' }));
});

test('a field only some elements carry still contributes its path — the shape is the union', () => {
  // The second user has a `location` the first does not; the collapsed shape must know
  // about it, otherwise an optional field seen in a fixture could never be matched live.
  const result = shapeOf(USERS_FIXTURE.data);
  assert.equal(result.get('[].location'), 'string');
  assert.equal(result.get('[].id'), 'string');
});

test('empty arrays and empty objects are leaves — the container path alone, no children', () => {
  const result = shapeOf({ data: [], includes: {}, meta: { result_count: 0 } });
  assert.deepEqual(
    result,
    shape({ data: 'array', includes: 'object', meta: 'object', 'meta.result_count': 'number' }),
  );
  assert.equal(result.has('data[]'), false);
});

test('a prefix names the root and is prepended to every child path', () => {
  assert.deepEqual(
    shapeOf({ id: '1', tags: ['a'] }, 'data'),
    shape({ data: 'object', 'data.id': 'string', 'data.tags': 'array', 'data.tags[]': 'string' }),
  );
  assert.deepEqual(shapeOf([1, 2], 'ids'), shape({ ids: 'array', 'ids[]': 'number' }));
  assert.deepEqual(shapeOf('x', 'leaf'), shape({ leaf: 'string' }));
  assert.deepEqual(shapeOf(null, 'leaf'), shape({ leaf: 'null' }));
});

test('a scalar root with no prefix has an empty shape — there is no path to record it under', () => {
  for (const scalar of [null, true, 42, 'text']) {
    assert.equal(shapeOf(scalar).size, 0, `${String(scalar)} produced paths`);
  }
});

test('a heterogeneous array still collapses onto ONE [] path', () => {
  const result = shapeOf([1, 'a', null]);
  assert.deepEqual([...result.keys()], ['[]']);
  const recorded = result.get('[]');
  assert.ok(recorded === 'number' || recorded === 'string' || recorded === 'null');
});

test('when array elements disagree, the FIRST element type wins, as the module documents', () => {
  assert.equal(shapeOf([1, 'a']).get('[]'), 'number');
  assert.equal(shapeOf([{ n: 1 }, { n: 'x' }]).get('[].n'), 'number');
  // And the nested case: the first element of the inner array decides, not the last.
  assert.equal(shapeOf([[1], ['a']]).get('[][]'), 'number');
});

// --- stripFixtureMeta ------------------------------------------------------------------

test('stripFixtureMeta drops every top-level underscore key and keeps the envelope (DRIFT-4)', () => {
  const fixture = {
    _provenance: 'captured 2026-07-23',
    _fact_checked: { at: '2026-08-01' },
    data: [USER],
    meta: { result_count: 1 },
  };
  const stripped = stripFixtureMeta(fixture);
  assert.deepEqual(stripped, { data: [USER], meta: { result_count: 1 } });
  assert.notEqual(stripped, fixture, 'a new object is returned');
  assert.equal(fixture._provenance, 'captured 2026-07-23', 'the input is not mutated');
});

test('stripFixtureMeta is top-level only — a nested underscore key is data, not metadata', () => {
  const stripped = stripFixtureMeta({ data: { _internal: 1, id: '1' }, list: [{ _x: 2 }] });
  assert.deepEqual(stripped, { data: { _internal: 1, id: '1' }, list: [{ _x: 2 }] });
});

test('stripFixtureMeta passes arrays and non-object values through untouched', () => {
  const list = [{ _provenance: 'x', id: '1' }];
  assert.equal(stripFixtureMeta(list), list, 'an array root is returned by reference');
  assert.equal(stripFixtureMeta(null), null);
  assert.equal(stripFixtureMeta('text'), 'text');
  assert.equal(stripFixtureMeta(7), 7);
  assert.equal(stripFixtureMeta(false), false);
});

test('the probe pipeline — strip, shape, diff — never reports the provenance note as drift', () => {
  const live = { data: USERS_FIXTURE.data };
  const unstripped = diffShapes(shapeOf(USERS_FIXTURE), shapeOf(live));
  assert.deepEqual(unstripped.onlyInFixture, ['_provenance'], 'without the strip it leaks');

  const stripped = diffShapes(shapeOf(stripFixtureMeta(USERS_FIXTURE)), shapeOf(live));
  assert.deepEqual(stripped.onlyInFixture, []);
  assert.equal(stripped.ok, true);
});

// --- diffShapes: the asymmetric policy ---------------------------------------------

test('identical shapes produce an empty, ok report', () => {
  const report = diffShapes(shapeOf(USER), shapeOf({ ...USER, name: 'someone else' }));
  assert.deepEqual(report, {
    conflicts: [],
    missingRequired: [],
    onlyInFixture: [],
    onlyInLive: [],
    ok: true,
  });
});

test('a path present in both with a different type is a BREAKING conflict', () => {
  // The founding case: a metric turning into a string silently corrupts a renderer.
  const fixture = shapeOf({ data: { public_metrics: { like_count: 12 } } });
  const live = shapeOf({ data: { public_metrics: { like_count: '12' } } });
  const report = diffShapes(fixture, live);
  assert.deepEqual(report.conflicts, [
    { path: 'data.public_metrics.like_count', fixture: 'number', live: 'string' },
  ]);
  assert.equal(report.ok, false);
  assert.deepEqual(report.onlyInFixture, [], 'a conflicting path is not also "missing"');
  assert.deepEqual(report.onlyInLive, []);
  assert.deepEqual(report.missingRequired, []);
});

test('a container turning into a scalar (or vice versa) is a conflict on the container path', () => {
  const report = diffShapes(shapeOf({ data: [USER] }), shapeOf({ data: null }));
  assert.deepEqual(report.conflicts, [{ path: 'data', fixture: 'array', live: 'null' }]);
  // The children the fixture had under `data` are informational — the conflict is the story.
  assert.ok(report.onlyInFixture.includes('data[].id'));
  assert.equal(report.ok, false);
});

test('a required path absent from the live response is BREAKING', () => {
  const fixture = shapeOf({ data: [USER], meta: { result_count: 1 } });
  const live = shapeOf({ data: [USER] });
  const report = diffShapes(fixture, live, ['data', 'meta']);
  assert.deepEqual(report.missingRequired, ['meta']);
  assert.equal(report.ok, false);
  assert.deepEqual(report.conflicts, []);
  // It is ALSO listed as fixture-only — the informational lists describe the diff, the
  // required list applies the policy; neither hides the other.
  assert.ok(report.onlyInFixture.includes('meta'));
});

test('a required path the fixture never had is still breaking — the required set is the contract', () => {
  const fixture = shapeOf({ data: [USER] });
  const live = shapeOf({ data: [USER] });
  const report = diffShapes(fixture, live, ['data', 'errors']);
  assert.deepEqual(report.missingRequired, ['errors']);
  assert.equal(report.ok, false);
  assert.deepEqual(report.onlyInFixture, []);
  assert.deepEqual(report.onlyInLive, []);
});

test('a required path that is present with the wrong type is a conflict, not a missing path', () => {
  const report = diffShapes(shapeOf({ data: [USER] }), shapeOf({ data: USER }), ['data']);
  assert.deepEqual(report.missingRequired, []);
  assert.deepEqual(report.conflicts, [{ path: 'data', fixture: 'array', live: 'object' }]);
  assert.equal(report.ok, false);
});

test('a field only the fixture has is informational — the report stays ok', () => {
  // A user with no `location` is a legitimate record, not drift.
  const fixture = shapeOf({ data: [{ ...USER, location: 'earth' }] });
  const live = shapeOf({ data: [USER] });
  const report = diffShapes(fixture, live);
  assert.deepEqual(report.onlyInFixture, ['data[].location']);
  assert.deepEqual(report.onlyInLive, []);
  assert.deepEqual(report.conflicts, []);
  assert.equal(report.ok, true);
});

test('a field only live has is informational — X adds fields additively (DRIFT-1)', () => {
  const fixture = shapeOf({ data: [USER] });
  const live = shapeOf({ data: [{ ...USER, subscription_type: 'Premium' }] });
  const report = diffShapes(fixture, live);
  assert.deepEqual(report.onlyInLive, ['data[].subscription_type']);
  assert.deepEqual(report.onlyInFixture, []);
  assert.equal(report.ok, true);
});

test('the required set is per probe: one pair of shapes is ok for one probe and breaking for another', () => {
  const fixture = shapeOf({ data: [USER], includes: { tweets: [] } });
  const live = shapeOf({ data: [USER] });

  const lenient = diffShapes(fixture, live); // `required` defaults to nothing
  assert.equal(lenient.ok, true);
  assert.deepEqual(lenient.missingRequired, []);

  const strict = diffShapes(fixture, live, ['includes']);
  assert.equal(strict.ok, false);
  assert.deepEqual(strict.missingRequired, ['includes']);

  const satisfied = diffShapes(fixture, live, ['data', 'data[].id']);
  assert.equal(satisfied.ok, true, 'required paths that live carries are not flagged');
});

test('the informational lists come back sorted, so the printed diff is stable across runs', () => {
  const fixture = shape({ zeta: 'string', alpha: 'number', 'mid.b': 'boolean', 'mid.a': 'null' });
  const live = shape({ omega: 'string', beta: 'number' });
  const report = diffShapes(fixture, live);
  assert.deepEqual(report.onlyInFixture, ['alpha', 'mid.a', 'mid.b', 'zeta']);
  assert.deepEqual(report.onlyInLive, ['beta', 'omega']);
});

test('breaking and informational findings coexist in one report without masking each other', () => {
  const fixture = shapeOf({ data: [{ ...USER, location: 'earth' }], meta: { result_count: 1 } });
  const live = shapeOf({ data: [{ ...USER, verified: 'yes', subscription_type: 'Basic' }] });
  const report = diffShapes(fixture, live, ['meta']);
  assert.deepEqual(report.conflicts, [
    { path: 'data[].verified', fixture: 'boolean', live: 'string' },
  ]);
  assert.deepEqual(report.missingRequired, ['meta']);
  assert.deepEqual(report.onlyInFixture, ['data[].location', 'meta', 'meta.result_count']);
  assert.deepEqual(report.onlyInLive, ['data[].subscription_type']);
  assert.equal(report.ok, false);
});

// --- formatDrift: the readable diff ----------------------------------------------------

const IDENTICAL: DriftReport = {
  conflicts: [],
  missingRequired: [],
  onlyInFixture: [],
  onlyInLive: [],
  ok: true,
};

const INFORMATIONAL: DriftReport = {
  ...IDENTICAL,
  onlyInFixture: ['data[].location'],
  onlyInLive: ['data[].subscription_type'],
};

const BREAKING: DriftReport = {
  conflicts: [
    { path: 'data[].public_metrics.like_count', fixture: 'number', live: 'string' },
    { path: 'data[].verified', fixture: 'boolean', live: 'string' },
  ],
  missingRequired: ['meta', 'meta.result_count'],
  onlyInFixture: ['data[].location'],
  onlyInLive: ['data[].subscription_type'],
  ok: false,
};

const lines = (text: string): string[] => text.split('\n');

test('formatDrift names the probe and the fixture in its header line', () => {
  const [header] = lines(formatDrift('user batch lookup', 'users/by-username.json', IDENTICAL));
  assert.ok(header?.includes('user batch lookup'), header);
  assert.ok(header?.includes('users/by-username.json'), header);
  assert.match(header ?? '', /drift check/);
});

test('formatDrift says so when the shapes are identical, and says nothing else', () => {
  const out = lines(formatDrift('probe', 'f.json', IDENTICAL));
  assert.equal(out.length, 2);
  assert.match(out[1] ?? '', /shapes are identical/);
});

test('formatDrift prints a type conflict as BREAKING with the path and both types, fixture first', () => {
  const out = formatDrift('probe', 'f.json', {
    ...IDENTICAL,
    conflicts: [{ path: 'data[].public_metrics.like_count', fixture: 'number', live: 'string' }],
    ok: false,
  });
  const line = lines(out).find((l) => l.includes('like_count'));
  assert.ok(line !== undefined, out);
  assert.match(line, /BREAKING/);
  assert.match(line, /type changed/);
  assert.match(line, /fixture number\s*->\s*live string/);
  assert.doesNotMatch(out, /shapes are identical/);
});

test('formatDrift prints a missing required path as BREAKING and names the path', () => {
  const out = formatDrift('probe', 'f.json', {
    ...IDENTICAL,
    missingRequired: ['meta'],
    ok: false,
  });
  const line = lines(out).find((l) => l.includes('meta'));
  assert.ok(line !== undefined, out);
  assert.match(line, /BREAKING/);
  assert.match(line, /required path absent/);
  assert.doesNotMatch(out, /shapes are identical/);
});

test('formatDrift prints informational entries as -/+ lines with no BREAKING marker', () => {
  const out = formatDrift('probe', 'f.json', INFORMATIONAL);
  assert.doesNotMatch(out, /BREAKING/);
  assert.doesNotMatch(out, /shapes are identical/);
  const fixtureOnly = lines(out).find((l) => l.includes('data[].location'));
  const liveOnly = lines(out).find((l) => l.includes('data[].subscription_type'));
  assert.match(fixtureOnly ?? '', /^\s*-\s/);
  assert.match(fixtureOnly ?? '', /fixture only/);
  assert.match(liveOnly ?? '', /^\s*\+\s/);
  assert.match(liveOnly ?? '', /live only/);
});

test('formatDrift prints every finding, one per line, breaking before informational', () => {
  const out = lines(formatDrift('probe', 'f.json', BREAKING));
  // 1 header + 2 conflicts + 2 missing + 1 fixture-only + 1 live-only.
  assert.equal(out.length, 7, out.join('\n'));
  const at = (needle: string): number => out.findIndex((l) => l.includes(needle));
  const lastConflict = at('data[].verified');
  const firstMissing = at('required path absent');
  const fixtureOnly = at('fixture only');
  const liveOnly = at('live only');
  assert.ok(at('like_count') < lastConflict, 'conflicts keep their reported order');
  assert.ok(lastConflict < firstMissing, 'type conflicts print before missing required paths');
  assert.ok(firstMissing < fixtureOnly, 'breaking lines print before informational ones');
  assert.ok(fixtureOnly < liveOnly, 'fixture-only lines print before live-only lines');
  assert.equal(out.filter((l) => l.includes('BREAKING')).length, 4);
});

// --- assertNoBreakingDrift ------------------------------------------------------------

test('assertNoBreakingDrift is silent on an identical report', () => {
  assert.doesNotThrow(() => assertNoBreakingDrift('probe', 'f.json', IDENTICAL));
  assert.equal(assertNoBreakingDrift('probe', 'f.json', IDENTICAL), undefined);
});

test('assertNoBreakingDrift does not throw on informational-only drift', () => {
  assert.doesNotThrow(() => assertNoBreakingDrift('probe', 'f.json', INFORMATIONAL));
});

test('assertNoBreakingDrift throws on a type conflict, naming the path and both types', () => {
  const report: DriftReport = {
    ...IDENTICAL,
    conflicts: [{ path: 'data[].public_metrics.like_count', fixture: 'number', live: 'string' }],
    ok: false,
  };
  assert.throws(
    () => assertNoBreakingDrift('post batch lookup', 'posts/two-posts.json', report),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /data\[\]\.public_metrics\.like_count/);
      assert.match(err.message, /number/);
      assert.match(err.message, /string/);
      assert.match(err.message, /post batch lookup/);
      assert.match(err.message, /posts\/two-posts\.json/);
      return true;
    },
  );
});

test('assertNoBreakingDrift throws on a missing required path, with the FULL diff in the message', () => {
  const report: DriftReport = { ...INFORMATIONAL, missingRequired: ['meta'], ok: false };
  assert.throws(
    () => assertNoBreakingDrift('recent search page', 'search/recent-page.json', report),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /required path absent[^\n]*meta/);
      // The informational lines ride along so the operator reads one diff, not two.
      assert.match(err.message, /data\[\]\.subscription_type[^\n]*live only/);
      assert.equal(
        err.message,
        formatDrift('recent search page', 'search/recent-page.json', report),
      );
      return true;
    },
  );
});
