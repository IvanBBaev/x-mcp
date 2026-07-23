// Two-axis policy resolution — pure data, no I/O (docs/04 §3, WP-1.2 / T-111).
//
// A policy is a set of permitted `operation:domain` cells, resolved from a PRESET plus
// operator ALLOW/DENY overrides. This module owns three concerns, all pure:
//   1. Validation of preset/cell strings, rejecting unknowns loudly (POL-6).
//   2. Resolution of preset + allow + deny into an effective cell set, with the ratified
//      precedence `deny > allow > preset` — deny ALWAYS wins (POL-2/3).
//   3. Classification of a tool by its `ToolDef.policy` cell as allowed/denied, plus the
//      denied-tool message construction that withholds the unlock env var for SENSITIVE
//      cells (POL-7 / SEC-F10) while low-sensitivity cells may hint.
//
// `core` does no I/O and never reads env directly: the string entry points below take the
// raw values the config layer (core/config, T-110) extracted, and the registry
// (core/registry, T-113) consumes `resolvePolicy` + `classifyTool`.

import { POLICY_CELLS } from './tooldef.js';
import type { PolicyClass } from './tooldef.js';
import { policyError, validationError } from './errors.js';
import type { XError } from './errors.js';

// --- Presets (X_MCP_POLICY) ------------------------------------------------------

/** The five policy presets (docs/04 §3.1). `read-only` is the conservative default. */
export const POLICY_PRESETS = ['read-only', 'engage', 'publish', 'manage', 'full'] as const;
export type PolicyPreset = (typeof POLICY_PRESETS)[number];

/** Preset applied when `X_MCP_POLICY` is unset or empty (CFG-4 treats empty as unset). */
export const DEFAULT_POLICY_PRESET: PolicyPreset = 'read-only';

// The preset → allowed-cells table (docs/04 §3.1), composed exactly as the doc prose reads.
// `read:dm` and `write:dm` appear in NO preset, including `full` — DM cells are reachable
// only by an explicit ALLOW override (POL-3/4, F14).
const READ_ONLY: readonly PolicyClass[] = [
  'read:content',
  'read:user',
  'read:account',
  'read:social-graph',
];
const ENGAGE: readonly PolicyClass[] = [...READ_ONLY, 'write:engagement'];
const PUBLISH: readonly PolicyClass[] = [...ENGAGE, 'write:content', 'write:moderation'];
const MANAGE: readonly PolicyClass[] = [...PUBLISH, 'destructive:content'];
// `full` = all non-DM cells, defined explicitly to mirror the docs/04 §3.1 table row.
const FULL: readonly PolicyClass[] = [
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
];

const PRESET_CELLS = {
  'read-only': READ_ONLY,
  engage: ENGAGE,
  publish: PUBLISH,
  manage: MANAGE,
  full: FULL,
} satisfies Record<PolicyPreset, readonly PolicyClass[]>;

/** The cells a preset grants before overrides, in canonical order (logging / auth_status). */
export function presetCells(preset: PolicyPreset): readonly PolicyClass[] {
  return PRESET_CELLS[preset];
}

// SENSITIVE cells — `*:dm`, `destructive:*`, `*:social-graph` (docs/04 §3.3 / POL-7). A
// denied SENSITIVE cell must never name the env var that unlocks it (no escalation recipe).
const SENSITIVE_CELLS: ReadonlySet<PolicyClass> = new Set(
  POLICY_CELLS.filter((cell) => {
    const operation = cell.slice(0, cell.indexOf(':'));
    const domain = cell.slice(cell.indexOf(':') + 1);
    return operation === 'destructive' || domain === 'dm' || domain === 'social-graph';
  }),
);

// --- Validation (POL-6) ----------------------------------------------------------

const isPreset = (value: string): value is PolicyPreset =>
  (POLICY_PRESETS as readonly string[]).includes(value);

const isPolicyCell = (value: string): value is PolicyClass =>
  (POLICY_CELLS as readonly string[]).includes(value);

/**
 * Validate the `X_MCP_POLICY` preset string. Empty/undefined resolves to the default
 * (CFG-4). An unknown name (e.g. `read-olny`) is a startup error listing the valid presets
 * — never silently ignored (POL-6). Operator-fixable, so `fix: 'operator'`.
 */
export function parsePreset(raw: string | undefined): PolicyPreset {
  const value = (raw ?? '').trim();
  if (value === '') return DEFAULT_POLICY_PRESET;
  if (isPreset(value)) return value;
  throw validationError(
    `Unknown policy preset \`${value}\` (X_MCP_POLICY). Valid presets: ${POLICY_PRESETS.join(
      ', ',
    )}.`,
    { fix: 'operator' },
  );
}

/**
 * Parse a comma-separated `operation:domain` cell list (`X_MCP_POLICY_ALLOW` /
 * `X_MCP_POLICY_DENY`). Blank entries are skipped; an unknown cell (e.g. `write:dms`) is a
 * startup error naming the source var and listing the 12 valid cells (POL-6).
 */
export function parsePolicyCells(raw: string | undefined, source: string): PolicyClass[] {
  const value = (raw ?? '').trim();
  if (value === '') return [];
  const cells: PolicyClass[] = [];
  for (const part of value.split(',')) {
    const cell = part.trim();
    if (cell === '') continue;
    if (!isPolicyCell(cell)) {
      throw validationError(
        `Unknown policy cell \`${cell}\` (${source}). Valid cells: ${POLICY_CELLS.join(', ')}.`,
        { fix: 'operator' },
      );
    }
    cells.push(cell);
  }
  return cells;
}

// --- Resolution (POL-2/3) --------------------------------------------------------

/** A validated policy request: a preset plus optional already-validated overrides. */
export interface PolicyInput {
  readonly preset: PolicyPreset;
  readonly allow?: readonly PolicyClass[];
  readonly deny?: readonly PolicyClass[];
}

/** The resolved, enforced policy. `allowed`/`denied` are canonical-order views of `cells`. */
export interface ResolvedPolicy {
  readonly preset: PolicyPreset;
  /** Effective permitted cells, for O(1) membership checks. */
  readonly cells: ReadonlySet<PolicyClass>;
  /** Permitted cells in canonical (POLICY_CELLS) order — for the startup/auth_status matrix. */
  readonly allowed: readonly PolicyClass[];
  /** The valid cells NOT permitted, in canonical order. */
  readonly denied: readonly PolicyClass[];
}

/**
 * Resolve preset + overrides into the effective cell set. Precedence is
 * **deny > allow > preset** (POL-2/3): the preset seeds the set, ALLOW adds any cell
 * (including `read:dm`/`write:dm`, which no preset grants), and DENY removes last so a cell
 * named in both ALLOW and DENY — or granted by the preset and denied — is DENIED. The
 * resolved matrix shown at startup/`auth_status` equals the one enforced here.
 */
export function resolvePolicy(input: PolicyInput): ResolvedPolicy {
  const cells = new Set<PolicyClass>(PRESET_CELLS[input.preset]);
  for (const cell of input.allow ?? []) cells.add(cell); // allow > preset
  for (const cell of input.deny ?? []) cells.delete(cell); // deny > allow (POL-2)
  const allowed = POLICY_CELLS.filter((cell) => cells.has(cell));
  const denied = POLICY_CELLS.filter((cell) => !cells.has(cell));
  return { preset: input.preset, cells, allowed, denied };
}

/** Raw `X_MCP_POLICY*` strings as the config layer extracted them (still unvalidated). */
export interface RawPolicyStrings {
  readonly policy?: string | undefined;
  readonly allow?: string | undefined;
  readonly deny?: string | undefined;
}

/**
 * Validate (POL-6) then resolve (POL-2/3) the three raw `X_MCP_POLICY*` env strings in one
 * step — the entry point the config layer calls. Throws on any unknown preset/cell.
 */
export function resolvePolicyStrings(raw: RawPolicyStrings): ResolvedPolicy {
  const preset = parsePreset(raw.policy);
  const allow = parsePolicyCells(raw.allow, 'X_MCP_POLICY_ALLOW');
  const deny = parsePolicyCells(raw.deny, 'X_MCP_POLICY_DENY');
  return resolvePolicy({ preset, allow, deny });
}

// --- Classification & denied-tool UX (POL-7) -------------------------------------

/** Is a single cell permitted under the resolved policy? */
export function isCellAllowed(policy: ResolvedPolicy, cell: PolicyClass): boolean {
  return policy.cells.has(cell);
}

/** True for the SENSITIVE cells whose denial must not leak an unlock recipe (POL-7). */
export function isSensitiveCell(cell: PolicyClass): boolean {
  return SENSITIVE_CELLS.has(cell);
}

/** The outcome of classifying one tool against a resolved policy. */
export interface ToolPolicyDecision {
  readonly cell: PolicyClass;
  readonly allowed: boolean;
}

/**
 * Classify a tool (by its `ToolDef.policy` cell) as allowed/denied under the resolved
 * policy. The registry (T-113) uses this to gate calls and to annotate denied tools.
 */
export function classifyTool(
  policy: ResolvedPolicy,
  tool: { readonly policy: PolicyClass },
): ToolPolicyDecision {
  return { cell: tool.policy, allowed: policy.cells.has(tool.policy) };
}

/**
 * The suffix appended to a denied tool's description so `tools/list` is self-documenting
 * about why a call will fail (docs/04 §3.3): `" (disabled by policy \`<preset>\`)"`.
 */
export function deniedDescriptionSuffix(preset: PolicyPreset): string {
  return ` (disabled by policy \`${preset}\`)`;
}

/**
 * Build the typed `policy` error for a denied tool call (POL-7 / SEC-F10). It always names
 * the blocked cell (carried in `data.cell`, `retryable: false`, `fix: 'operator'`). For a
 * SENSITIVE cell (`*:dm`, `destructive:*`, `*:social-graph`) the message stops there — it
 * MUST NOT name the env var/value that would unlock it, so the model cannot relay an
 * escalation recipe to the operator (kill-chain Scenario C). Low-sensitivity cells may hint.
 */
export function deniedToolError(cell: PolicyClass, preset: PolicyPreset): XError {
  const base = `This operation is disabled by the active \`${preset}\` policy (blocked cell \`${cell}\`).`;
  const message = isSensitiveCell(cell)
    ? base
    : `${base} An operator can enable it by adding \`${cell}\` to X_MCP_POLICY_ALLOW.`;
  return policyError(message, { data: { cell } });
}
