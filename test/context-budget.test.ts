// The judging logic of the context gate (scripts/lib/context-budget.mjs, Q13): the
// model-visible projection of a tool, the two byte caps, the exact tool-count baseline and
// the non-failing client-limit warnings — exercised with synthetic measurements. The real
// numbers come from `npm run gate:context`, which runs the same logic over the composed
// server; nothing here copies its caps or baselines (scripts/context-gate.mjs owns them).

import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface Measurement {
  label: string;
  total: number;
  modelVisible: number;
  count: number;
}

interface Limits {
  budgetBytes: number;
  modelVisibleBudgetBytes: number;
  toolCountBaseline: number;
  clientToolLimits?: Array<{ client: string; limit: number; status: string; source: string }>;
  networkHits?: number;
}

interface Verdict {
  worst: Measurement;
  worstModelVisible: Measurement;
  listed: number;
  findings: string[];
  warnings: string[];
}

interface ContextBudgetLib {
  modelVisibleView(tool: Record<string, unknown>): Record<string, unknown>;
  modelVisibleBytes(tools: Array<Record<string, unknown>>): number;
  evaluate(measurements: Measurement[], limits: Limits): Verdict;
}

// From the compiled test (<outDir>/test/) two levels up is the repo root.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const lib = (await import(
  pathToFileURL(join(ROOT, 'scripts', 'lib', 'context-budget.mjs')).href
)) as ContextBudgetLib;

const LIMITS: Limits = { budgetBytes: 1_000, modelVisibleBudgetBytes: 500, toolCountBaseline: 3 };

const at = (label: string, total: number, modelVisible: number, count = 3): Measurement => ({
  label,
  total,
  modelVisible,
  count,
});

const TOOL = {
  name: 'x_demo_get',
  description: 'X (Twitter): Demo — get one thing.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  outputSchema: { type: 'object', properties: { data: { type: 'object' } } },
  annotations: { title: 'Demo get', readOnlyHint: true, destructiveHint: false },
};

test('modelVisibleView keeps name, description, inputSchema and annotations.title only', () => {
  assert.deepEqual(lib.modelVisibleView(TOOL), {
    name: TOOL.name,
    description: TOOL.description,
    inputSchema: TOOL.inputSchema,
    annotations: { title: 'Demo get' },
  });
});

test('modelVisibleView omits absent optional fields instead of serializing them', () => {
  const view = lib.modelVisibleView({ name: 'x_bare', inputSchema: { type: 'object' } });
  assert.deepEqual(view, { name: 'x_bare', inputSchema: { type: 'object' } });
  const untitled = lib.modelVisibleView({ ...TOOL, annotations: { readOnlyHint: true } });
  assert.equal('annotations' in untitled, false);
});

test('modelVisibleBytes counts UTF-8 bytes of the projected {"tools":[…]} envelope', () => {
  const tool = { ...TOOL, description: 'X (Twitter): a → b' };
  const expected = Buffer.byteLength(
    JSON.stringify({ tools: [lib.modelVisibleView(tool)] }),
    'utf8',
  );
  assert.equal(lib.modelVisibleBytes([tool]), expected);
  // The arrow is three UTF-8 bytes but one UTF-16 unit: the count is bytes, not `.length`.
  assert.equal(expected, JSON.stringify({ tools: [lib.modelVisibleView(tool)] }).length + 2);
  assert.ok(lib.modelVisibleBytes([TOOL]) < Buffer.byteLength(JSON.stringify(TOOL), 'utf8'));
});

test('evaluate passes inside both caps and picks each worst case independently', () => {
  const verdict = lib.evaluate([at('a', 900, 400), at('b', 950, 300), at('c', 800, 450)], LIMITS);
  assert.deepEqual(verdict.findings, []);
  assert.deepEqual(verdict.warnings, []);
  assert.equal(verdict.worst.label, 'b');
  assert.equal(verdict.worstModelVisible.label, 'c');
  assert.equal(verdict.listed, 3);
});

test('evaluate treats each cap as inclusive and fails one byte over it', () => {
  assert.deepEqual(lib.evaluate([at('edge', 1_000, 500)], LIMITS).findings, []);
  const wire = lib.evaluate([at('wire', 1_001, 500)], LIMITS).findings;
  assert.equal(wire.length, 1);
  assert.match(wire[0] ?? '', /1001 B under "wire", over the 1000 B budget by 1 B/);
  const model = lib.evaluate([at('model', 1_000, 501)], LIMITS).findings;
  assert.equal(model.length, 1);
  assert.match(model[0] ?? '', /model-visible .* 501 B under "model", over the 500 B budget/);
});

test('evaluate fails a tool count that differs from the baseline in either direction', () => {
  for (const count of [2, 4]) {
    const { findings } = lib.evaluate([at('ok', 900, 400), at('off', 900, 400, count)], LIMITS);
    assert.equal(findings.length, 1, `count ${count}`);
    assert.match(findings[0] ?? '', new RegExp(`"off" lists ${count} tools, .* baseline is 3`));
  }
});

test('evaluate warns, never fails, above a client tool limit', () => {
  const clientToolLimits = [
    { client: 'Big', limit: 128, status: 'documented', source: 'https://example.test/big' },
    { client: 'Small', limit: 2, status: 'unconfirmed', source: 'https://example.test/small' },
    { client: 'Exact', limit: 3, status: 'documented', source: 'https://example.test/exact' },
  ];
  const verdict = lib.evaluate([at('a', 900, 400)], { ...LIMITS, clientToolLimits });
  assert.deepEqual(verdict.findings, []);
  assert.deepEqual(verdict.warnings, [
    '3 tools listed, above the 2-tool limit recorded for Small (unconfirmed; ' +
      'https://example.test/small)',
  ]);
});

test('evaluate reports network hits and refuses an empty measurement set', () => {
  const { findings } = lib.evaluate([at('a', 900, 400)], { ...LIMITS, networkHits: 2 });
  assert.deepEqual(findings, ['composing the server hit the network 2 time(s)']);
  assert.throws(() => lib.evaluate([], LIMITS), /no measurements/);
});
