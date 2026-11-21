// The pure judging logic of scripts/context-gate.mjs (Q13, review 13 §2 e1 + e3), split out
// so test/context-budget.test.ts can exercise it with synthetic measurements instead of a
// composed server. Node stdlib only; nothing here reads the clock, the environment or the
// network. The reasoning behind each measure is in the header of scripts/context-gate.mjs.

import { Buffer } from 'node:buffer';

/** UTF-8 byte length — the true wire size, not the UTF-16 `.length`. */
export const bytes = (value) => Buffer.byteLength(value, 'utf8');

/**
 * The part of one `tools/list` entry a model is shown: name, description, inputSchema and
 * `annotations.title`. `outputSchema` and the behavioural hints are dropped — Anthropic-style
 * tool definitions have no field for either. The title keeps its wire position under
 * `annotations`, so this is a projection of the served object, not a re-encoding of it.
 */
export function modelVisibleView(tool) {
  const view = { name: tool.name };
  if (tool.description !== undefined) view.description = tool.description;
  view.inputSchema = tool.inputSchema;
  if (tool.annotations?.title !== undefined) view.annotations = { title: tool.annotations.title };
  return view;
}

/** Bytes of `{"tools":[…]}` holding only the model-visible view of every listed tool. */
export function modelVisibleBytes(tools) {
  return bytes(JSON.stringify({ tools: tools.map(modelVisibleView) }));
}

const maxBy = (entries, key) =>
  entries.reduce((max, entry) => (entry[key] > max[key] ? entry : max));

/**
 * Judge a set of per-configuration measurements (`{ label, total, modelVisible, count }`)
 * against the caps and baselines. Returns the worst cases, the failing `findings` and the
 * non-failing `warnings`; the caller decides how to print them.
 *
 *   * wire bytes: the worst `total` must stay within `budgetBytes`;
 *   * model-visible bytes: the worst `modelVisible` must stay within `modelVisibleBudgetBytes`;
 *   * tool count: EVERY configuration must list exactly `toolCountBaseline` tools (with
 *     hide-denied off no preset hides a tool, so a mismatch is a surface change that has to
 *     be a deliberate baseline edit);
 *   * client limits: a count above a known client tool limit is a warning, never a failure.
 */
export function evaluate(measurements, limits) {
  const {
    budgetBytes,
    modelVisibleBudgetBytes,
    toolCountBaseline,
    clientToolLimits = [],
    networkHits = 0,
  } = limits;
  if (measurements.length === 0) throw new Error('context-budget: no measurements to judge');

  const worst = maxBy(measurements, 'total');
  const worstModelVisible = maxBy(measurements, 'modelVisible');
  const findings = [];
  const warnings = [];

  if (networkHits > 0) {
    findings.push(`composing the server hit the network ${networkHits} time(s)`);
  }
  if (worst.total > budgetBytes) {
    findings.push(
      `tools/list is ${worst.total} B under "${worst.label}", over the ${budgetBytes} B budget ` +
        `by ${worst.total - budgetBytes} B — shrink the largest descriptions/schemas, or ` +
        `raise BUDGET_BYTES in scripts/context-gate.mjs with a justification in the PR`,
    );
  }
  if (worstModelVisible.modelVisible > modelVisibleBudgetBytes) {
    findings.push(
      `the model-visible part of tools/list is ${worstModelVisible.modelVisible} B under ` +
        `"${worstModelVisible.label}", over the ${modelVisibleBudgetBytes} B budget by ` +
        `${worstModelVisible.modelVisible - modelVisibleBudgetBytes} B — shrink descriptions/` +
        `input schemas, or raise MODEL_VISIBLE_BUDGET_BYTES in scripts/context-gate.mjs with a ` +
        `justification in the PR`,
    );
  }
  const offCount = measurements.filter((entry) => entry.count !== toolCountBaseline);
  for (const entry of offCount) {
    findings.push(
      `"${entry.label}" lists ${entry.count} tools, the recorded baseline is ` +
        `${toolCountBaseline} — a tool-count change is deliberate: update TOOL_COUNT_BASELINE ` +
        `in scripts/context-gate.mjs and say in the PR why the agent should carry the tool`,
    );
  }

  const listed = Math.max(...measurements.map((entry) => entry.count));
  for (const client of clientToolLimits) {
    if (listed > client.limit) {
      warnings.push(
        `${listed} tools listed, above the ${client.limit}-tool limit recorded for ` +
          `${client.client} (${client.status}; ${client.source})`,
      );
    }
  }

  return { worst, worstModelVisible, listed, findings, warnings };
}
