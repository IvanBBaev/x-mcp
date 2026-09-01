// Property-based tests (docs/05 §1) for core/policy — the two-axis policy algebra.
//
// The unit suite (test/core/policy.test.ts) pins the documented examples; these properties
// pin the ALGEBRA across the whole input space: every preset × every allow-subset × every
// deny-subset of the 12 cells. The oracle is the ratified precedence law itself —
// `effective = (preset ∪ allow) \ deny` (POL-2/3) — computed independently with plain set
// operations, never by peeking at the implementation's internals.

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { POLICY_CELLS } from '../src/core/tooldef.js';
import type { PolicyClass } from '../src/core/tooldef.js';
import { POLICY_PRESETS, presetCells, resolvePolicy } from '../src/core/policy.js';

const presetArb = fc.constantFrom(...POLICY_PRESETS);
// `subarray` draws arbitrary subsets of the 12 valid cells (duplicates impossible, order
// canonical — resolution must not care about either).
const cellsArb = fc.subarray([...POLICY_CELLS]);

test('POL-2 property: deny wins over allow and preset for every combination', () => {
  fc.assert(
    fc.property(presetArb, cellsArb, cellsArb, (preset, allow, deny) => {
      const r = resolvePolicy({ preset, allow, deny });
      for (const cell of deny) {
        assert.equal(r.cells.has(cell), false, `denied cell ${cell} leaked into cells`);
        assert.equal(r.allowed.includes(cell), false, `denied cell ${cell} leaked into allowed`);
        assert.equal(r.denied.includes(cell), true, `denied cell ${cell} missing from denied`);
      }
    }),
  );
});

test('POL-2/3 property: resolution equals (preset ∪ allow) \\ deny, partitioned in canonical order', () => {
  fc.assert(
    fc.property(presetArb, cellsArb, cellsArb, (preset, allow, deny) => {
      // Independent model of the precedence law.
      const expected = new Set<PolicyClass>(
        [...presetCells(preset), ...allow].filter((cell) => !deny.includes(cell)),
      );
      const r = resolvePolicy({ preset, allow, deny });
      assert.deepEqual(new Set(r.cells), expected);
      // `allowed`/`denied` are exact canonical-order views that partition the 12 cells.
      assert.deepEqual(
        r.allowed,
        POLICY_CELLS.filter((cell) => expected.has(cell)),
      );
      assert.deepEqual(
        r.denied,
        POLICY_CELLS.filter((cell) => !expected.has(cell)),
      );
      assert.equal(r.allowed.length + r.denied.length, POLICY_CELLS.length);
    }),
  );
});

test('POL-2 property: a resolved policy is a fixed point (re-resolving its own views changes nothing)', () => {
  fc.assert(
    fc.property(presetArb, cellsArb, cellsArb, (preset, allow, deny) => {
      const r = resolvePolicy({ preset, allow, deny });
      // Feed the resolved matrix back in as explicit overrides: the outcome the server
      // enforces must reproduce itself exactly — what auth_status displays IS the policy.
      const again = resolvePolicy({ preset, allow: r.allowed, deny: r.denied });
      assert.deepEqual(again.allowed, r.allowed);
      assert.deepEqual(again.denied, r.denied);
      assert.deepEqual(new Set(again.cells), new Set(r.cells));
    }),
  );
});

test('POL-3/F14 property: DM cells open only via explicit allow, under EVERY preset including full', () => {
  const DM_CELLS: readonly PolicyClass[] = ['read:dm', 'write:dm'];
  fc.assert(
    fc.property(presetArb, cellsArb, cellsArb, (preset, allow, deny) => {
      const r = resolvePolicy({ preset, allow, deny });
      for (const dm of DM_CELLS) {
        const granted = allow.includes(dm) && !deny.includes(dm);
        assert.equal(
          r.cells.has(dm),
          granted,
          `${dm} under preset ${preset}: expected ${granted ? 'allowed' : 'denied'}`,
        );
      }
    }),
  );
});
