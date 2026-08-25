// Tests for core/policy (T-111): two-axis resolution as pure data. Covers the ratified
// precedence deny > allow > preset (POL-2/3), preset expansion incl. DM exclusion (POL-4),
// invalid-cell rejection (POL-6), and the no-unlock-hint rule for sensitive cells (POL-7).
//
// The "final preset semantics" section at the bottom (T-213, WP-2.4) pins the docs/04 §3.1
// table verbatim — exact per-preset cell lists, the strict escalation chain, the DM
// exclusion from every preset, the Phase-2 write/destructive class gating, and the exact
// denied-tool message contract — so any future drift in preset composition or denied-tool
// UX breaks a test here.

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

// T-320 F2: this used to assert the OPPOSITE — that a low-sensitivity denial "MAY include the
// unlock hint". That hint was the leaking half of a two-call escalation: the agent reads the
// sensitive cell's name from `x_auth_status`'s policy matrix, triggers any low-sensitivity
// denial to learn `X_MCP_POLICY_ALLOW` and its syntax, and relays the assembled recipe. The
// withholding is only worth anything if it is total, so the hint is gone from every cell.
test('POL-7 (F2): a low-sensitivity denial withholds the env var too — the hint was the leak', () => {
  const err = deniedToolError('write:engagement', 'read-only');
  assert.equal(err.data.cell, 'write:engagement');
  assert.ok(err.message.includes('write:engagement')); // still actionable…
  assert.equal(err.message.includes('X_MCP'), false); // …without being a recipe.
  assert.match(err.message, /operator guide/);
});

// --- Final preset semantics (T-213, WP-2.4) --------------------------------------
// Exact pins of the docs/04 §3.1 table. These are deliberately literal: if a preset ever
// gains or loses a cell, or the canonical ordering changes, a deepEqual below breaks.

test('T-213 pin: exact presetCells() list for each of the five presets (docs/04 §3.1)', () => {
  assert.deepEqual(presetCells('read-only'), [
    'read:content',
    'read:user',
    'read:account',
    'read:social-graph',
  ]);
  assert.deepEqual(presetCells('engage'), [
    'read:content',
    'read:user',
    'read:account',
    'read:social-graph',
    'write:engagement',
  ]);
  assert.deepEqual(presetCells('publish'), [
    'read:content',
    'read:user',
    'read:account',
    'read:social-graph',
    'write:content',
    'write:engagement',
    'write:moderation',
  ]);
  assert.deepEqual(presetCells('manage'), [
    'read:content',
    'read:user',
    'read:account',
    'read:social-graph',
    'write:content',
    'write:engagement',
    'write:moderation',
    'destructive:content',
  ]);
  assert.deepEqual(presetCells('full'), [
    'read:content',
    'read:user',
    'read:account',
    'read:social-graph',
    'write:content',
    'write:engagement',
    'write:moderation',
    'write:social-graph',
    'destructive:content',
    'destructive:social-graph',
  ]);
});

test('T-213: presetCells is canonical POLICY_CELLS order and equals the override-free allowed view', () => {
  for (const preset of POLICY_PRESETS) {
    const cells = new Set(presetCells(preset));
    assert.deepEqual(
      presetCells(preset),
      POLICY_CELLS.filter((cell) => cells.has(cell)),
      `${preset} must list its cells in canonical POLICY_CELLS order`,
    );
    // The matrix shown at startup/auth_status (resolved.allowed) equals the preset table
    // when no overrides are applied — same cells, same order (docs/04 §3.2).
    assert.deepEqual(
      resolvePolicy({ preset }).allowed,
      presetCells(preset),
      `${preset}: resolved allowed view must equal the preset table`,
    );
  }
});

test('T-213: presets form a STRICT escalation chain read-only ⊂ engage ⊂ publish ⊂ manage ⊂ full', () => {
  for (let i = 1; i < POLICY_PRESETS.length; i++) {
    const lower = presetCells(POLICY_PRESETS[i - 1]!);
    const higher = new Set(presetCells(POLICY_PRESETS[i]!));
    for (const cell of lower) {
      assert.ok(
        higher.has(cell),
        `${POLICY_PRESETS[i]} must contain every ${POLICY_PRESETS[i - 1]} cell (${cell})`,
      );
    }
    assert.ok(
      higher.size > lower.length,
      `${POLICY_PRESETS[i]} must grant strictly more than ${POLICY_PRESETS[i - 1]}`,
    );
  }
});

test('T-213 / POL-3/4: NO preset contains a DM cell; each is reachable only via explicit allow', () => {
  for (const preset of POLICY_PRESETS) {
    for (const dmCell of ['read:dm', 'write:dm'] as const) {
      assert.equal(
        presetCells(preset).includes(dmCell),
        false,
        `${preset} must not grant ${dmCell}`,
      );
      assert.equal(
        isCellAllowed(resolvePolicy({ preset }), dmCell),
        false,
        `${preset} must resolve ${dmCell} as denied without an override`,
      );
      // The ONLY route in: an explicit operator allow — and deny still beats it (POL-2/3).
      assert.equal(isCellAllowed(resolvePolicy({ preset, allow: [dmCell] }), dmCell), true);
      assert.equal(
        isCellAllowed(resolvePolicy({ preset, allow: [dmCell], deny: [dmCell] }), dmCell),
        false,
      );
    }
  }
});

test('T-213: Phase-2 tool classes gate correctly per preset (post/like/repost/bookmark/timelines)', () => {
  // Cells carried by the Phase-2 tools: x_post_create -> write:content, x_post_delete ->
  // destructive:content, x_like_set / x_repost_set / x_bookmark_set -> write:engagement,
  // timelines -> read:content.
  const readOnly = resolvePolicy({ preset: 'read-only' });
  const engage = resolvePolicy({ preset: 'engage' });
  const publish = resolvePolicy({ preset: 'publish' });
  const manage = resolvePolicy({ preset: 'manage' });

  // Timelines (read:content) are readable under every preset.
  for (const preset of POLICY_PRESETS) {
    assert.equal(isCellAllowed(resolvePolicy({ preset }), 'read:content'), true);
  }

  // read-only: every write:* and destructive:* cell is denied.
  for (const cell of POLICY_CELLS) {
    if (!cell.startsWith('read:')) {
      assert.equal(isCellAllowed(readOnly, cell), false, `read-only must deny ${cell}`);
    }
  }

  // engage: like/repost/bookmark toggles allowed; posting and deleting are not.
  assert.equal(isCellAllowed(engage, 'write:engagement'), true);
  assert.equal(isCellAllowed(engage, 'write:content'), false);
  assert.equal(isCellAllowed(engage, 'destructive:content'), false);

  // publish: posting allowed; deleting still needs manage.
  assert.equal(isCellAllowed(publish, 'write:content'), true);
  assert.equal(isCellAllowed(publish, 'destructive:content'), false);

  // manage: deleting own posts allowed without jumping to full (docs/04 §3.1).
  assert.equal(isCellAllowed(manage, 'destructive:content'), true);
});

test('T-213 pin: exact denied-tool message contract (POL-7 / SEC-F10 / T-320 F2)', () => {
  // One message shape for every cell — the sensitive/low-sensitivity split is gone (F2).
  assert.equal(
    deniedToolError('write:dm', 'publish').message,
    'This operation is disabled by the active `publish` policy (blocked cell `write:dm`). ' +
      'Enabling it is an operator decision made outside this session; see the operator guide.',
  );
  assert.equal(
    deniedToolError('write:content', 'read-only').message,
    'This operation is disabled by the active `read-only` policy (blocked cell `write:content`). ' +
      'Enabling it is an operator decision made outside this session; see the operator guide.',
  );
});

test('T-213 / POL-7: EVERY cell x every preset denies without ANY env-var mention (F2)', () => {
  for (const preset of POLICY_PRESETS) {
    for (const cell of POLICY_CELLS) {
      const err = deniedToolError(cell, preset);
      assert.equal(err.kind, 'policy');
      assert.equal(err.retryable, false);
      assert.equal(err.fix, 'operator');
      assert.equal(err.data.cell, cell);
      assert.ok(err.message.includes(cell), `message must name the blocked cell ${cell}`);
      assert.ok(err.message.includes(preset), 'message must name the active preset');
      // The escalation recipe is withheld wholesale: no X_MCP_* variable may appear
      // (covers X_MCP_POLICY, _ALLOW, _DENY, and any future variable alike).
      assert.equal(
        err.message.includes('X_MCP'),
        false,
        `${cell} under ${preset} must not name any env var`,
      );
    }
  }
});

// `isSensitiveCell` survives F2 — it is still the right classification, it just no longer
// decides what a denial message says. This pins that the two are now decoupled: sensitive and
// low-sensitivity cells produce the SAME message shape, so no denial is a probe for the other.
test('T-213 / POL-7 (F2): sensitivity no longer changes the denial message', () => {
  const sensitive = POLICY_CELLS.filter((c) => isSensitiveCell(c));
  const ordinary = POLICY_CELLS.filter((c) => !isSensitiveCell(c));
  assert.ok(sensitive.length > 0 && ordinary.length > 0, 'both classes must be non-empty');

  const shapeOf = (cell: PolicyClass): string =>
    deniedToolError(cell, 'read-only').message.replaceAll(cell, '<cell>');
  const expected = shapeOf(sensitive[0] as PolicyClass);
  for (const cell of POLICY_CELLS) {
    assert.equal(shapeOf(cell), expected, `message shape must not vary with ${cell}`);
  }
});

test('T-213 pin: deniedDescriptionSuffix for every preset, with no env-var leakage', () => {
  assert.equal(deniedDescriptionSuffix('read-only'), ' (disabled by policy `read-only`)');
  assert.equal(deniedDescriptionSuffix('engage'), ' (disabled by policy `engage`)');
  assert.equal(deniedDescriptionSuffix('publish'), ' (disabled by policy `publish`)');
  assert.equal(deniedDescriptionSuffix('manage'), ' (disabled by policy `manage`)');
  assert.equal(deniedDescriptionSuffix('full'), ' (disabled by policy `full`)');
  for (const preset of POLICY_PRESETS) {
    assert.equal(deniedDescriptionSuffix(preset).includes('X_MCP'), false);
  }
});
