// Tool-surface invariants (T-312/T-313, WP-3.13). The two CI gates —
// `scripts/docs-gen.mjs --check` (the generated reference cannot drift from the registry)
// and `scripts/context-gate.mjs` (the serialized `tools/list` stays inside its context
// budget) — both rest on assumptions about the registered surface that nothing in the unit
// suite pinned: how many tools there are, that every name follows the `x_` convention, and
// that the listing is stable. core/registry documents `size` as "a tested number that guards
// against scope creep"; these are that test.
//
// Deliberately NOT duplicated here: the byte budget itself. Its single source of truth is
// `BUDGET_BYTES` in scripts/context-gate.mjs, which measures the real composed server; a
// second copy in TypeScript would be exactly the drift these gates exist to prevent.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseConfig } from '../../src/core/config.js';
import { composeServer } from '../../src/mcp/compose.js';
import type { Composition } from '../../src/mcp/compose.js';

/**
 * The registered tool count. Changing this number is a deliberate act: it also moves
 * docs/reference/tools.md (regenerate with `npm run docs:gen`), the docs/03-tool-catalog.md
 * reconciliation, and the context budget in scripts/context-gate.mjs.
 */
const REGISTERED_TOOLS = 41;

/** The registry packages (`src/tools/<package>.ts`) and how many tools each contributes. */
const PACKAGE_SIZES: ReadonlyArray<readonly [string, number]> = [
  ['auth', 2],
  ['posts', 4],
  ['users', 1],
  ['search', 2],
  ['engagement', 4],
  ['timelines', 3],
  ['graph', 6],
  ['lists', 10],
  ['media', 2],
  ['dm', 4],
  ['archive', 2],
  ['usage', 1],
];

/** Compose with every availability class enabled, so class-gating hides nothing (docs/01 §3.3). */
function composeFull(extra: Record<string, string> = {}): Composition {
  return composeServer(
    parseConfig({
      X_MCP_AUTH_MODE: 'app-only',
      X_MCP_BEARER_TOKEN: 'AAAA',
      X_MCP_AVAILABILITY: 'pilot,premium-user,enterprise',
      ...extra,
    }),
  );
}

test('T-312: the registry registers exactly the documented tool surface', () => {
  const { registry } = composeFull();
  assert.equal(registry.size, REGISTERED_TOOLS);
  assert.equal(
    PACKAGE_SIZES.reduce((sum, [, count]) => sum + count, 0),
    REGISTERED_TOOLS,
    'the per-package counts must reconcile with the total',
  );
});

test('T-312: every tool name follows the `x_` snake_case convention and is unique', () => {
  const names = composeFull()
    .registry.all()
    .map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');
  for (const name of names) {
    assert.match(name, /^x_[a-z0-9]+(?:_[a-z0-9]+)*$/, `"${name}" breaks the naming convention`);
  }
});

test('T-312: every registered tool declares a known policy cell and availability class', () => {
  for (const tool of composeFull().registry.all()) {
    assert.match(tool.policy, /^(?:read|write|destructive):[a-z-]+$/, tool.name);
    assert.ok(
      ['app+user', 'user-only', 'pilot', 'premium-user', 'enterprise'].includes(tool.availability),
      `${tool.name} has an unknown availability class "${tool.availability}"`,
    );
    assert.ok(tool.description.length > 0, `${tool.name} has an empty description`);
  }
});

// T-313: the context gate measures the WORST case, which it defines as hide-denied OFF. That
// is only true because hiding denied tools can never grow the listing — pinned here so the
// gate's documented configuration cannot quietly become the wrong one.
test('T-313: X_MCP_HIDE_DENIED only ever shrinks the tools/list surface', () => {
  const listed = composeFull().registry.listForMcp().length;
  const hidden = composeFull({ X_MCP_HIDE_DENIED: '1' }).registry.listForMcp().length;
  assert.equal(listed, REGISTERED_TOOLS, 'with hide-denied off every registered tool is listed');
  assert.ok(hidden < listed, `hide-denied listed ${hidden}, expected fewer than ${listed}`);
});

// T-313: the other half of the gate's worst-case claim — a stricter preset never lists fewer
// tools, it only annotates more of them "(disabled by policy …)", which is why `read-only`
// produces the largest payload (POL-7).
test('T-313: a stricter preset denies more tools without dropping any from the listing', () => {
  const readOnly = composeFull({ X_MCP_POLICY: 'read-only' }).registry.listForMcp();
  const full = composeFull({ X_MCP_POLICY: 'full' }).registry.listForMcp();
  assert.equal(readOnly.length, full.length);
  const deniedIn = (list: readonly { readonly denied: boolean }[]): number =>
    list.filter((entry) => entry.denied).length;
  assert.ok(
    deniedIn(readOnly) > deniedIn(full),
    `read-only denied ${deniedIn(readOnly)}, full denied ${deniedIn(full)}`,
  );
  for (const entry of readOnly) {
    if (entry.denied) assert.match(entry.description, /\(disabled by policy `read-only`\)$/);
  }
});
