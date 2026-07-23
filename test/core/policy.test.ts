// Tests for core/policy (T-111): two-axis resolution as pure data. Covers the ratified
// precedence deny > allow > preset (POL-2/3), preset expansion incl. DM exclusion (POL-4),
// invalid-cell rejection (POL-6), and the no-unlock-hint rule for sensitive cells (POL-7).

import test from 'node:test';
import assert from 'node:assert/strict';

import { POLICY_CELLS } from '../../src/core/tooldef.js';
import type { PolicyClass } from '../../src/core/tooldef.js';
import { XError } from '../../src/core/errors.js';
import {
  POLICY_PRESETS,
  DEFAULT_POLICY_PRESET,
  presetCells,
  parsePreset,
  parsePolicyCells,
  resolvePolicy,
  resolvePolicyStrings,
  isCellAllowed,
  isSensitiveCell,
  classifyTool,
  deniedDescriptionSuffix,
  deniedToolError,
} from '../../src/core/policy.js';

const sorted = (cells: readonly PolicyClass[]): PolicyClass[] => [...cells].sort();

// --- Preset expansion (docs/04 §3.1) --------------------------------------------

test('read-only is the default and grants read:* except read:dm (POL-4)', () => {
  assert.equal(DEFAULT_POLICY_PRESET, 'read-only');
  assert.deepEqual(sorted(presetCells('read-only')), [
    'read:account',
    'read:content',
    'read:social-graph',
    'read:user',
  ]);
  // The read:* wildcard deliberately excludes the private-DM read.
  assert.equal(presetCells('read-only').includes('read:dm'), false);
});

test('presets form an escalating chain engage ⊃ read-only, publish ⊃ engage, manage ⊃ publish', () => {
  const chain: readonly ['read-only', 'engage', 'publish', 'manage'] = [
    'read-only',
    'engage',
    'publish',
    'manage',
  ];
  for (let i = 1; i < chain.length; i++) {
    const lower = new Set(presetCells(chain[i - 1]!));
    for (const cell of lower) {
      assert.ok(presetCells(chain[i]!).includes(cell), `${chain[i]} must contain ${cell}`);
    }
  }
  assert.ok(presetCells('engage').includes('write:engagement'));
  assert.ok(presetCells('publish').includes('write:content'));
  assert.ok(presetCells('publish').includes('write:moderation'));
  assert.ok(presetCells('manage').includes('destructive:content'));
});

test('full is all non-DM cells — never read:dm or write:dm even at the top preset (POL-3)', () => {
  const full = presetCells('full');
  const nonDm = POLICY_CELLS.filter((c) => c !== 'read:dm' && c !== 'write:dm');
  assert.deepEqual(sorted(full), sorted(nonDm));
  assert.equal(full.includes('read:dm'), false);
  assert.equal(full.includes('write:dm'), false);
  assert.equal(full.length, 10);
});

// --- Resolution & precedence (POL-2/3) ------------------------------------------

test('POL-3: X_MCP_POLICY_ALLOW="write:dm" enables DM sends on any preset', () => {
  for (const preset of POLICY_PRESETS) {
    const resolved = resolvePolicy({ preset, allow: ['write:dm'] });
    assert.ok(isCellAllowed(resolved, 'write:dm'), `write:dm should be allowed on ${preset}`);
  }
  // read:dm reaches the same way — no preset grants it, an explicit allow does.
  const dmRead = resolvePolicy({ preset: 'read-only', allow: ['read:dm'] });
  assert.ok(isCellAllowed(dmRead, 'read:dm'));
});

test('POL-2: deny always beats allow — a cell in both ALLOW and DENY is denied', () => {
  const resolved = resolvePolicy({
    preset: 'read-only',
    allow: ['write:dm', 'write:content'],
    deny: ['write:dm'],
  });
  assert.equal(isCellAllowed(resolved, 'write:dm'), false); // deny > allow
  assert.equal(isCellAllowed(resolved, 'write:content'), true); // allow > preset
});

test('POL-2: deny beats the preset — deny read:dm and read:social-graph off full', () => {
  const resolved = resolvePolicy({ preset: 'full', deny: ['read:social-graph'] });
  assert.equal(isCellAllowed(resolved, 'read:social-graph'), false);
  assert.equal(isCellAllowed(resolved, 'read:content'), true);
});

test('allowed/denied views are complementary and canonically ordered', () => {
  const resolved = resolvePolicy({ preset: 'engage' });
  assert.deepEqual(
    [...resolved.allowed, ...resolved.denied].sort(),
    [...POLICY_CELLS].sort(),
    'every valid cell is exactly one of allowed/denied',
  );
  // Canonical order matches the frozen POLICY_CELLS order.
  assert.deepEqual(
    resolved.allowed,
    POLICY_CELLS.filter((c) => resolved.cells.has(c)),
  );
});

test('resolvePolicyStrings parses raw env strings end to end', () => {
  const resolved = resolvePolicyStrings({
    policy: 'publish',
    allow: ' write:dm , read:dm ', // whitespace + blanks tolerated
    deny: 'write:content,,',
  });
  assert.equal(resolved.preset, 'publish');
  assert.ok(isCellAllowed(resolved, 'write:dm'));
  assert.ok(isCellAllowed(resolved, 'read:dm'));
  assert.equal(isCellAllowed(resolved, 'write:content'), false); // denied despite publish granting it
});

test('empty/undefined X_MCP_POLICY resolves to the default preset (CFG-4)', () => {
  assert.equal(parsePreset(undefined), 'read-only');
  assert.equal(parsePreset(''), 'read-only');
  assert.equal(parsePreset('   '), 'read-only');
  assert.deepEqual(parsePolicyCells(undefined, 'X_MCP_POLICY_ALLOW'), []);
  assert.deepEqual(parsePolicyCells('', 'X_MCP_POLICY_ALLOW'), []);
});

// --- Invalid-cell rejection (POL-6) ---------------------------------------------

test('POL-6: an unknown preset name is a startup error listing valid presets', () => {
  assert.throws(
    () => parsePreset('read-olny'),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.equal(err.fix, 'operator');
      assert.match(err.message, /read-olny/);
      for (const preset of POLICY_PRESETS) assert.match(err.message, new RegExp(preset));
      return true;
    },
  );
});

test('POL-6: an unknown cell in ALLOW/DENY is a startup error listing the 12 valid cells', () => {
  assert.throws(
    () => parsePolicyCells('write:dms', 'X_MCP_POLICY_ALLOW'),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.equal(err.fix, 'operator');
      assert.match(err.message, /write:dms/);
      assert.match(err.message, /X_MCP_POLICY_ALLOW/);
      for (const cell of POLICY_CELLS) assert.ok(err.message.includes(cell));
      return true;
    },
  );
  // Same guard fires through the combined string entry point.
  assert.throws(() => resolvePolicyStrings({ deny: 'destroy:everything' }), XError);
});

// --- Classification & denied-tool UX (POL-7) ------------------------------------

test('classifyTool decides allowed/denied by the tool policy cell', () => {
  const resolved = resolvePolicy({ preset: 'read-only' });
  assert.deepEqual(classifyTool(resolved, { policy: 'read:content' }), {
    cell: 'read:content',
    allowed: true,
  });
  assert.deepEqual(classifyTool(resolved, { policy: 'write:content' }), {
    cell: 'write:content',
    allowed: false,
  });
});

test('deniedDescriptionSuffix names the active preset for tools/list self-documentation', () => {
  assert.equal(deniedDescriptionSuffix('read-only'), ' (disabled by policy `read-only`)');
});

test('sensitive cells are *:dm, destructive:*, and *:social-graph', () => {
  const expected: PolicyClass[] = [
    'read:dm',
    'write:dm',
    'destructive:content',
    'destructive:social-graph',
    'read:social-graph',
    'write:social-graph',
  ];
  for (const cell of POLICY_CELLS) {
    assert.equal(isSensitiveCell(cell), expected.includes(cell), `sensitivity of ${cell}`);
  }
});

test('POL-7: a denied SENSITIVE cell error names the cell but NOT the unlock env var', () => {
  for (const cell of [
    'write:dm',
    'read:dm',
    'destructive:content',
    'write:social-graph',
  ] as const) {
    const err = deniedToolError(cell, 'publish');
    assert.ok(XError.is(err));
    assert.equal(err.kind, 'policy');
    assert.equal(err.retryable, false);
    assert.equal(err.fix, 'operator');
    assert.equal(err.data.cell, cell); // blocked cell is named
    assert.ok(err.message.includes(cell));
    // No escalation recipe: the unlock variable must never appear (kill-chain Scenario C).
    assert.equal(err.message.includes('X_MCP_POLICY_ALLOW'), false);
  }
});

test('POL-7: a low-sensitivity denied cell MAY include the unlock hint', () => {
  const err = deniedToolError('write:engagement', 'read-only');
  assert.equal(err.data.cell, 'write:engagement');
  assert.match(err.message, /X_MCP_POLICY_ALLOW/);
  assert.ok(err.message.includes('write:engagement'));
});
