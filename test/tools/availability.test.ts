// Tests for the availability class-gating machinery (T-306; docs/01 §3.3). Pure unit
// tests — the gate is registration-time data shuffling with no I/O. The scenarios pin the
// spec's three guarantees: the conservative default when `X_MCP_AVAILABILITY` is unset,
// specially-provisioned classes staying OFF until explicitly declared, and base classes
// never being lockable-out. Contrast POL-7 (policy denial keeps a tool registered and
// annotated) — an availability-excluded tool is absent from the registry entirely; the
// resolved set is what `x_auth_status` surfaces to the operator (AUTH-15).

import test from 'node:test';
import assert from 'node:assert/strict';

import { z } from 'zod';

import { defineTool } from '../../src/core/tooldef.js';
import type { AnyToolDef, AvailabilityClass } from '../../src/core/tooldef.js';
import {
  BASE_AVAILABILITY,
  GATED_AVAILABILITY_CLASSES,
  gateByAvailability,
  isAvailable,
  resolveAvailability,
} from '../../src/tools/availability.js';
import { archiveTools } from '../../src/tools/archive.js';

/** Minimal real ToolDef in a given availability class (no future gated tool exists yet). */
function fakeTool(name: string, availability: AvailabilityClass): AnyToolDef {
  return defineTool({
    name,
    title: name,
    description: `Test stand-in tool in the ${availability} class.`,
    policy: 'read:content',
    availability,
    scopes: [],
    cost: 'local',
    annotations: { title: name, readOnlyHint: true },
    input: z.object({}).strict(),
    handler: () => Promise.resolve({ data: null }),
    phase: 3,
  });
}

test('resolveAvailability: unset declaration yields the conservative default (app+user, user-only)', () => {
  // core/config parses an unset X_MCP_AVAILABILITY to [] — the gate resolves that to the
  // docs/01 §3.3 conservative default, never to "nothing reachable".
  assert.deepEqual([...resolveAvailability([])], ['app+user', 'user-only']);
});

test('resolveAvailability: base classes are always present, even when only gated classes are declared', () => {
  // Declaring pilot must never unregister the universally-available surface.
  assert.deepEqual([...resolveAvailability(['pilot'])], ['app+user', 'user-only', 'pilot']);
});

test('resolveAvailability: dedupes and keeps a stable order (base first, then declared)', () => {
  assert.deepEqual(
    [...resolveAvailability(['app+user', 'pilot', 'pilot', 'enterprise', 'user-only'])],
    ['app+user', 'user-only', 'pilot', 'enterprise'],
  );
  // Idempotent: resolving an already-resolved set changes nothing.
  const once = resolveAvailability(['premium-user']);
  assert.deepEqual([...resolveAvailability(once)], [...once]);
});

test('GATED_AVAILABILITY_CLASSES: exactly the specially-provisioned classes, none in the base set', () => {
  assert.deepEqual([...GATED_AVAILABILITY_CLASSES], ['pilot', 'premium-user', 'enterprise']);
  for (const cls of GATED_AVAILABILITY_CLASSES) {
    assert.ok(!BASE_AVAILABILITY.includes(cls));
  }
});

test('gateByAvailability: gated classes are OFF by default — a pilot tool is excluded, never registered', () => {
  const pilotTool = fakeTool('x_future_pilot_tool', 'pilot');
  const { resolved, registered, excluded } = gateByAvailability([pilotTool], []);
  assert.deepEqual([...resolved], ['app+user', 'user-only']);
  assert.deepEqual(registered, []);
  assert.deepEqual(
    excluded.map((t) => t.name),
    ['x_future_pilot_tool'],
  );
});

test('gateByAvailability: declaring a class registers its tools; undeclared gated classes stay excluded', () => {
  const tools = [
    fakeTool('x_base_tool', 'user-only'),
    fakeTool('x_pilot_tool', 'pilot'),
    fakeTool('x_enterprise_tool', 'enterprise'),
  ];
  const { registered, excluded } = gateByAvailability(tools, ['pilot']);
  assert.deepEqual(
    registered.map((t) => t.name),
    ['x_base_tool', 'x_pilot_tool'], // registration order preserved.
  );
  assert.deepEqual(
    excluded.map((t) => t.name),
    ['x_enterprise_tool'],
  );
});

test('gateByAvailability: the archive tools (app+user) register under the conservative default', () => {
  // The T-010 fact-check outcome, executable: full-archive search/counts are budget-guarded
  // (COST-1), never availability-gated, so an unset X_MCP_AVAILABILITY still registers them.
  const { registered, excluded } = gateByAvailability(archiveTools, []);
  assert.deepEqual(
    registered.map((t) => t.name),
    ['x_search_archive', 'x_post_counts_archive'],
  );
  assert.deepEqual(excluded, []);
});

test('isAvailable: pure membership check against a resolved set', () => {
  const resolved = resolveAvailability(['premium-user']);
  assert.equal(isAvailable(fakeTool('a', 'app+user'), resolved), true);
  assert.equal(isAvailable(fakeTool('b', 'premium-user'), resolved), true);
  assert.equal(isAvailable(fakeTool('c', 'pilot'), resolved), false);
});
