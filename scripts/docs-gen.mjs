// Tool-reference generator and registry <-> docs drift gate (T-312, WP-3.13).
// Companion to scripts/fuzz-tools.mjs and scripts/coverage-guard.mjs — same house style: no
// dependency beyond the compiled build, `process.stdout.write` for output, a non-zero exit on
// a real finding.
//
//   node scripts/docs-gen.mjs            # regenerate every generated surface
//   node scripts/docs-gen.mjs --check    # verify only: print a diff and exit 1 on drift
//
// THE SINGLE SOURCE OF TRUTH IS THE LIVE REGISTRY. This script composes the real server the
// way src/index.ts does — `parseConfig` + `composeServer` — with an app-only credential, the
// `full` preset, every availability class and an explicit DM allow, so that every registered
// tool is present. Names, titles, descriptions, policy cells, availability, cost classes,
// phases, scopes, MCP hints and input fields are then READ OUT OF THE `ToolDef` VALUES. No
// list is maintained by hand here; if a surface disagrees with the registry, the surface is
// wrong.
//
// THREE GENERATED SURFACES:
//
//   1. docs/reference/tools.md            — the full generated reference page (whole file).
//   2. README.md          `GENERATED:TOOLS` region — the compact tool table.
//   3. docs/03-tool-catalog.md `GENERATED:TOOLS` region — the registered-surface summary of
//                                           the designed catalog (which is deliberately
//                                           larger: it also carries not-yet-implemented rows).
//
// Only surface 1 is a whole file this generator owns. Surfaces 2 and 3 are GENERATED REGIONS
// inside files whose surrounding prose belongs to a human: the generator rewrites what is
// between the markers and never a byte outside them, and every hand-written number nearby is
// ASSERTED and REPORTED, never silently corrected.
//
// TWO ASSERTED-ONLY SURFACES are checked but NEVER written:
//
//   * docs/10-operator-guide.md — its §6.3 preset-escalation table and §6.4 DM note quote
//     counts the policy engine owns. T-317 is why that check exists: landing `x_usage_get` (a
//     `read:account` tool, and therefore in every preset) moved all six numbers by one, and the
//     guide kept the old ones.
//   * server.json — the registry-listing `description` quotes the tool and package counts.
//     (Its structural invariants — version lockstep, transport shape, secret marking — belong
//     to scripts/server-json-guard.mjs; this gate owns only the two derived numbers.)
//
// THE DRIFT GATE checks that the live registry, the tool table in docs/03-tool-catalog.md, the
// generated reference, and the operator-facing counts all agree:
//
//   D1  every registered tool has a catalog row              (a new tool without a docs row)
//   D2  every catalog row matches the ToolDef it describes    (class / availability / cost /
//                                                              phase drift, per field)
//   D3  no duplicate catalog rows
//   D4  the not-yet-registered list is exactly the catalog minus the registry (a docs row for
//       a tool that no longer exists shows up as drift in the generated region, D3/G3)
//   D5  every count in prose agrees with the registry — the README badge, the "N tools across
//       M packages" claims, the per-preset callable table, the catalog's "N tools in M
//       packages" / "All N are unconditional" / "N / M / ~K" reconciliation
//   D6  the three generated surfaces are byte-identical to what this generator produces
//
// Every failure names the exact offending tool, file and number.
//
// DETERMINISM. Nothing here reads the clock, the environment or the network. Ordering is the
// registry's own registration order (packages in first-appearance order), so two runs of the
// same build produce byte-identical output. Files are read with CRLF normalised to LF so the
// gate behaves identically on the Windows CI leg.
//
// OFFLINE. `globalThis.fetch` is replaced by a tripwire before the server is composed;
// composing must not touch the network, and a hit is a finding.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const REPO = new URL('../', import.meta.url);
const BUILD = new URL('build/src/', REPO);

const GENERATOR = 'scripts/docs-gen.mjs';
const REFERENCE = 'docs/reference/tools.md';
const CATALOG = 'docs/03-tool-catalog.md';
const README = 'README.md';
const GUIDE = 'docs/10-operator-guide.md';
const MANIFEST = 'server.json';

const BEGIN = '<!-- GENERATED:TOOLS:BEGIN -->';
const END = '<!-- GENERATED:TOOLS:END -->';

const DM_CELLS = 'read:dm,write:dm';

// --- Offline tripwire ------------------------------------------------------------------

const network = { hits: 0 };
globalThis.fetch = () => {
  network.hits += 1;
  return Promise.reject(new Error('docs-gen: network access is disabled'));
};

// --- Small file helpers ----------------------------------------------------------------

/** Read a repo-relative file with CRLF normalised, so the gate is identical on Windows. */
function readRepoFile(relative) {
  return readFileSync(fileURLToPath(new URL(relative, REPO)), 'utf8').replace(/\r\n/g, '\n');
}

function writeRepoFile(relative, text) {
  const absolute = fileURLToPath(new URL(relative, REPO));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

/** Escape a value for a markdown table cell: no pipes, no newlines. */
function cell(value) {
  return String(value).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

const code = (value) => `\`${value}\``;
const codeList = (values) => (values.length === 0 ? '—' : values.map(code).join(', '));

// --- Loading the live registry ---------------------------------------------------------

const BASE_ENV = {
  X_MCP_AUTH_MODE: 'app-only',
  X_MCP_BEARER_TOKEN: 'docs-gen-not-a-real-credential',
  // Every availability class, so availability gating never hides a tool from the reference.
  X_MCP_AVAILABILITY: 'pilot,premium-user,enterprise',
};

async function loadBuild() {
  try {
    return {
      config: await import(new URL('core/config.js', BUILD).href),
      compose: await import(new URL('mcp/compose.js', BUILD).href),
      schema: await import(new URL('mcp/schema.js', BUILD).href),
      registry: await import(new URL('core/registry.js', BUILD).href),
      policy: await import(new URL('core/policy.js', BUILD).href),
    };
  } catch (error) {
    process.stderr.write(
      `docs-gen: cannot load the compiled build from ${BUILD.href}\n` +
        `docs-gen: run \`npm run build\` first (${error instanceof Error ? error.message : String(error)})\n`,
    );
    process.exit(2);
  }
}

/** A permissive stand-in for the injected dependencies of a `create*Tools` factory. */
function makeStub() {
  const stub = new Proxy(function stubFn() {}, {
    get: () => stub,
    apply: () => stub,
    has: () => true,
  });
  return stub;
}

const looksLikeToolDef = (value) =>
  value !== null &&
  typeof value === 'object' &&
  typeof value.name === 'string' &&
  typeof value.policy === 'string' &&
  value.input !== undefined;

/**
 * Map every tool name to the module that defines it — `src/tools/<package>.ts` IS the package
 * boundary (docs/02 §3), so the module basename is the package name. Modules export either a
 * ToolDef array, a bare ToolDef, or a `create*Tools(deps)` factory; factories are called with
 * a stub because a ToolDef is pure data and its handler is never invoked here.
 */
async function derivePackages(toolNames) {
  const modules = [
    'auth',
    'posts',
    'users',
    'search',
    'engagement',
    'timelines',
    'graph',
    'lists',
    'media',
    'dm',
    'archive',
    'usage',
  ];
  const stub = makeStub();
  const packageOf = new Map();
  const conflicts = [];

  for (const name of modules) {
    const module = await import(new URL(`tools/${name}.js`, BUILD).href);
    const found = [];
    for (const [exportName, value] of Object.entries(module)) {
      if (Array.isArray(value)) {
        for (const item of value) if (looksLikeToolDef(item)) found.push(item);
      } else if (looksLikeToolDef(value)) {
        found.push(value);
      } else if (typeof value === 'function' && /^create.*Tools$/.test(exportName)) {
        const produced = value(stub);
        if (Array.isArray(produced)) {
          for (const item of produced) if (looksLikeToolDef(item)) found.push(item);
        }
      }
    }
    for (const tool of found) {
      const previous = packageOf.get(tool.name);
      if (previous !== undefined && previous !== name) {
        conflicts.push(`${tool.name} is exported by both src/tools/${previous}.ts and ${name}.ts`);
      }
      packageOf.set(tool.name, name);
    }
  }

  const unmapped = toolNames.filter((name) => !packageOf.has(name));
  return { packageOf, conflicts, unmapped };
}

/** The static cost class; the one per-call resolver (`x_post_create`) reports its base class. */
function costClass(tool) {
  if (typeof tool.cost !== 'function') return tool.cost;
  try {
    const resolved = tool.cost({});
    return typeof resolved === 'string' ? resolved : resolved.class;
  } catch {
    return 'dynamic';
  }
}

const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|approx|no|cf|Dr|Mr|Ms)\.$/i;

/**
 * First sentence of a tool description, with the mandated `X (Twitter): ` opener stripped —
 * the reference page is entirely about X, so repeating it 39 times is noise.
 */
function oneLine(description) {
  const flat = String(description).replace(/\s+/g, ' ').trim();
  const body = flat.replace(/^X \(Twitter\):\s*/, '');
  let sentence = body;
  for (const match of body.matchAll(/[.!?](?=\s|$)/g)) {
    const end = match.index + 1;
    const head = body.slice(0, end);
    if (ABBREVIATION.test(head)) continue;
    const rest = body.slice(end).trimStart();
    if (rest === '' || /^[A-Z`"'(*[]/.test(rest)) {
      sentence = head;
      break;
    }
  }
  return sentence.replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

/** MCP hints as derived by the registry from the policy cell (MCP-4). */
function hints(annotations) {
  const flags = [];
  if (annotations.readOnlyHint === true) flags.push('read-only');
  if (annotations.destructiveHint === true) flags.push('destructive');
  if (annotations.idempotentHint === true) flags.push('idempotent');
  if (annotations.idempotentHint === false) flags.push('non-idempotent');
  return flags.length === 0 ? '—' : flags.join(', ');
}

// --- JSON Schema -> markdown -----------------------------------------------------------

function constraintsOf(node) {
  const parts = [];
  if (node.type === 'string') {
    if (node.minLength !== undefined && node.maxLength !== undefined) {
      parts.push(`${node.minLength}–${node.maxLength} chars`);
    } else if (node.minLength === 1) {
      parts.push('non-empty');
    } else if (node.minLength !== undefined) {
      parts.push(`min ${node.minLength} chars`);
    } else if (node.maxLength !== undefined) {
      parts.push(`max ${node.maxLength} chars`);
    }
    if (typeof node.format === 'string') parts.push(node.format);
  }
  if (node.type === 'array') {
    if (node.minItems !== undefined && node.maxItems !== undefined) {
      parts.push(`${node.minItems}–${node.maxItems} items`);
    } else if (node.minItems !== undefined) {
      parts.push(`min ${node.minItems} items`);
    } else if (node.maxItems !== undefined) {
      parts.push(`max ${node.maxItems} items`);
    }
  }
  if (node.type === 'integer' || node.type === 'number') {
    if (node.minimum !== undefined && node.maximum !== undefined) {
      parts.push(`${node.minimum}–${node.maximum}`);
    } else if (node.minimum !== undefined) {
      parts.push(`min ${node.minimum}`);
    } else if (node.maximum !== undefined) {
      parts.push(`max ${node.maximum}`);
    }
  }
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

/**
 * A short type label. Item-level constraints are dropped inside an array (`string[] (1–4
 * items)` reads better than `string (non-empty)[] (1–4 items)`); the item constraints are
 * still enforced, and the field description carries the interesting ones.
 */
function typeLabel(node, withConstraints = true) {
  if (node === undefined || node === null || typeof node !== 'object') return 'any';
  const suffix = withConstraints ? constraintsOf(node) : '';
  if (Array.isArray(node.enum)) return node.enum.map((value) => code(String(value))).join(' \\| ');
  for (const key of ['anyOf', 'oneOf']) {
    if (Array.isArray(node[key])) return node[key].map((child) => typeLabel(child)).join(' \\| ');
  }
  const base = Array.isArray(node.type) ? node.type.join(' \\| ') : (node.type ?? 'any');
  if (base === 'array') {
    const item = typeLabel(node.items, false);
    return `${item.includes('\\|') ? `(${item})` : item}[]${suffix}`;
  }
  return `${base}${suffix}`;
}

/** Flatten an input schema to table rows; nested objects are shown one level deep. */
function schemaFields(schema, prefix = '', depth = 0) {
  const rows = [];
  const properties = schema.properties ?? {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const [key, node] of Object.entries(properties)) {
    rows.push({
      name: `${prefix}${key}`,
      type: typeLabel(node),
      required: required.has(key),
      description: typeof node.description === 'string' ? node.description : '',
    });
    if (depth >= 1) continue;
    if (node.type === 'object' && node.properties !== undefined) {
      rows.push(...schemaFields(node, `${prefix}${key}.`, depth + 1));
    }
    if (node.type === 'array' && node.items?.type === 'object' && node.items.properties) {
      rows.push(...schemaFields(node.items, `${prefix}${key}[].`, depth + 1));
    }
  }
  return rows;
}

// --- The surface -----------------------------------------------------------------------

async function loadSurface() {
  const build = await loadBuild();
  const compose = (policy, allow) =>
    build.compose.composeServer(
      build.config.parseConfig({
        ...BASE_ENV,
        X_MCP_POLICY: policy,
        ...(allow === undefined ? {} : { X_MCP_POLICY_ALLOW: allow }),
      }),
    );

  const { registry } = compose('full', DM_CELLS);
  const defs = registry.all();
  const { packageOf, conflicts, unmapped } = await derivePackages(defs.map((def) => def.name));

  const tools = defs.map((def) => ({
    name: def.name,
    title: def.title,
    summary: oneLine(def.description),
    package: packageOf.get(def.name) ?? '(unknown)',
    policy: def.policy,
    availability: def.availability,
    cost: costClass(def),
    phase: def.phase,
    conditional: def.conditional === true,
    scopes: [...def.scopes],
    hints: hints(build.registry.deriveAnnotations(def)),
    fields: schemaFields(build.schema.toolInputSchema(def)),
  }));

  const packages = [];
  for (const tool of tools) {
    let entry = packages.find((candidate) => candidate.name === tool.package);
    if (entry === undefined) {
      entry = { name: tool.package, tools: [] };
      packages.push(entry);
    }
    entry.tools.push(tool);
  }

  const presets = [];
  for (const preset of build.policy.POLICY_PRESETS) {
    const scoped = compose(preset).registry;
    const list = scoped.listForMcp();
    const callable = list.filter((entry) => !entry.denied).length;
    presets.push({ name: preset, allow: null, callable, denied: scoped.size - callable });
  }
  const withDm = registry.listForMcp().filter((entry) => !entry.denied).length;
  presets.push({
    name: 'full',
    allow: DM_CELLS,
    callable: withDm,
    denied: registry.size - withDm,
  });

  // The DM surface, derived from the cells rather than from tool names: `read:dm` /
  // `write:dm` are in no preset, so docs quote this count on its own (docs/10 §6.4).
  const dmTools = defs.filter((def) => def.policy.endsWith(':dm')).length;

  return { tools, packages, presets, dmTools, conflicts, unmapped, size: registry.size };
}

// --- Rendering: docs/reference/tools.md -------------------------------------------------

function presetLabel(preset) {
  if (preset.allow !== null)
    return `${code(preset.name)} + ${code(`X_MCP_POLICY_ALLOW=${preset.allow}`)}`;
  if (preset.name === 'read-only') return `${code(preset.name)} *(default)*`;
  return code(preset.name);
}

function renderPresetTable(surface) {
  return [
    '| Preset | Callable | Denied |',
    '|---|--:|--:|',
    ...surface.presets.map(
      (preset) => `| ${presetLabel(preset)} | ${preset.callable} | ${preset.denied} |`,
    ),
  ];
}

function renderToolSection(tool) {
  const lines = [
    `### ${code(tool.name)}`,
    '',
    `**${cell(tool.title)}** — ${cell(tool.summary)}`,
    '',
    '| Package | Cell | Availability | Cost | Phase | MCP hints | OAuth scopes |',
    '|---|---|---|---|---|---|---|',
    `| ${code(tool.package)} | ${code(tool.policy)} | ${code(tool.availability)} | ` +
      `${code(tool.cost)} | ${tool.phase} | ${tool.hints} | ${codeList(tool.scopes)} |`,
    '',
  ];
  if (tool.fields.length === 0) {
    lines.push('Takes no input fields.', '');
    return lines;
  }
  lines.push('| Field | Type | Required | Description |', '|---|---|:--:|---|');
  for (const field of tool.fields) {
    lines.push(
      `| ${code(field.name)} | ${field.type} | ${field.required ? '✅' : ''} | ` +
        `${cell(field.description)} |`,
    );
  }
  lines.push('');
  return lines;
}

function renderReference(surface) {
  const lines = [
    '<!-- GENERATED FILE — DO NOT EDIT BY HAND. -->',
    `<!-- Generated by ${GENERATOR} from the live tool registry. -->`,
    '<!-- `npm run docs:gen` rewrites this file; `npm run docs:check` fails CI on drift. -->',
    '',
    '# Tool reference (generated)',
    '',
    `**${surface.size} tools in ${surface.packages.length} packages.** Every field on this ` +
      'page is read out of the registered',
    '`ToolDef` values, so this is the surface the server actually exposes — not the surface it',
    'was designed to have. The designed catalog, including tools that are not implemented yet,',
    'is [`../03-tool-catalog.md`](../03-tool-catalog.md).',
    '',
    '## Packages',
    '',
    '| Package | Tools | Registered tools |',
    '|---|--:|---|',
    ...surface.packages.map(
      (entry) =>
        `| ${code(entry.name)} | ${entry.tools.length} | ` +
        `${entry.tools.map((tool) => code(tool.name)).join(', ')} |`,
    ),
    '',
    '## Policy presets',
    '',
    'Callable = tools whose policy cell the preset grants. Denied tools stay registered and',
    'annotated; they refuse the call (POL-7). DM cells are in no preset, not even `full`.',
    '',
    ...renderPresetTable(surface),
    '',
    '## Reading the tables',
    '',
    '- **Cell** is the `operation:domain` policy classification ([../04-security.md](../04-security.md) §3).',
    '- **Availability** is the credential class the tool needs — `app+user` works with an',
    '  app-only bearer token, `user-only` requires OAuth 2.0 user context.',
    '- **Cost** is the pay-per-use bucket; the price table lives in',
    '  [`../01-api-landscape.md`](../01-api-landscape.md) §3. `x_post_create` resolves per call —',
    '  `w:post` normally, but a post whose text contains a URL costs 13× more.',
    '- **MCP hints** are derived from the cell, never hand-set (MCP-4).',
    '- A nested field (`poll.options`) is required only when its parent object is supplied.',
    '- Every input schema rejects unknown fields; only the fields listed are accepted.',
    '',
  ];

  for (const entry of surface.packages) {
    lines.push(`## ${code(entry.name)}`, '');
    for (const tool of entry.tools) lines.push(...renderToolSection(tool));
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

// --- Rendering: the README region -------------------------------------------------------

function renderReadmeRegion(surface) {
  const lines = [
    '| Package | Tool | Cell | Read-only | User | Description |',
    '|---|---|---|:--:|:--:|---|',
  ];
  for (const entry of surface.packages) {
    for (const tool of entry.tools) {
      const readOnly = tool.policy.startsWith('read:') ? '✅' : '';
      const user = tool.availability === 'user-only' ? '✅' : '';
      lines.push(
        `| ${entry.name} | ${code(tool.name)} | ${tool.policy} | ${readOnly} | ${user} | ` +
          `${cell(tool.summary)} |`,
      );
    }
  }
  return lines.join('\n');
}

// --- Rendering: the docs/03 region ------------------------------------------------------

/** Catalogued tool names the registry does not (yet) register, alphabetically. */
function pendingTools(surface, catalog) {
  const registered = new Set(surface.tools.map((tool) => tool.name));
  return catalog.rows
    .map((row) => row.name)
    .filter((name) => !registered.has(name))
    .sort();
}

function renderCatalogRegion(surface, catalog) {
  const pending = pendingTools(surface, catalog);
  const presets = surface.presets.map((preset) =>
    preset.allow === null ? code(preset.name) : `${code(preset.name)} + DM allow`,
  );

  const lines = [
    `<!-- Generated by ${GENERATOR} from the live registry — do not edit by hand. -->`,
    '<!-- `npm run docs:gen` regenerates; `npm run docs:check` fails CI on drift. -->',
    '',
    '### Registered surface',
    '',
    `**${surface.size} of the ${catalog.rows.length} catalogued tools are registered today**, ` +
      `in ${surface.packages.length} registry packages`,
    '(`src/tools/<package>.ts`). Per-tool detail — titles, input fields, scopes, MCP hints — is',
    'in the generated [`reference/tools.md`](reference/tools.md).',
    '',
    '| Registry package | Registered | Tools |',
    '|---|--:|---|',
    ...surface.packages.map(
      (entry) =>
        `| ${code(entry.name)} | ${entry.tools.length} | ` +
        `${entry.tools.map((tool) => code(tool.name)).join(', ')} |`,
    ),
    '',
    'Callable tools per `X_MCP_POLICY` preset (denied tools stay registered and refuse the call):',
    '',
    `| ${presets.join(' | ')} |`,
    `|${presets.map(() => '--:').join('|')}|`,
    `| ${surface.presets.map((preset) => preset.callable).join(' | ')} |`,
    '',
  ];

  if (pending.length === 0) {
    lines.push('Every catalogued tool is registered.');
  } else {
    lines.push(
      `**Catalogued but not registered yet (${pending.length}):** ${pending.map(code).join(', ')}.`,
    );
  }
  return lines.join('\n');
}

// --- Parsing the committed docs ---------------------------------------------------------

function stripRegion(text) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1) return text;
  return `${text.slice(0, start)}${text.slice(end + END.length)}`;
}

/** Parse the designed catalog: its `## <package>` sections and every `| \`x_…\` |` row. */
function parseCatalog(text) {
  const rows = [];
  const sections = [];
  let current = null;
  let lineNumber = 0;
  let inRegion = false;
  for (const line of text.split('\n')) {
    lineNumber += 1;
    // Skip this generator's own output, but keep counting so line numbers stay real.
    if (line.includes(BEGIN)) inRegion = true;
    if (line.includes(END)) {
      inRegion = false;
      continue;
    }
    if (inRegion) continue;
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      current = { name: heading[1].split(/\s+[—-]\s+/)[0].trim(), rows: 0 };
      sections.push(current);
      continue;
    }
    const row = /^\|\s*`(x_[a-z0-9_]+)`\s*\|/.exec(line);
    if (row === null) continue;
    const cells = line.split('|').map((value) => value.trim());
    rows.push({
      name: row[1],
      section: current?.name ?? '(none)',
      policy: cells[2] ?? '',
      availability: cells[3] ?? '',
      cost: cells[4] ?? '',
      phase: cells[5] ?? '',
      line: lineNumber,
    });
    if (current !== null) current.rows += 1;
  }
  return { rows, sections, packageSections: sections.filter((section) => section.rows > 0) };
}

// --- The gate ---------------------------------------------------------------------------

function claim(text, pattern) {
  const match = pattern.exec(text);
  return match === null ? null : match;
}

/**
 * Verify a numeric claim in prose. `expected` is one `[value, source]` pair per capture group;
 * `source` names what the number is checked against, so the message is actionable.
 */
function checkCounts(findings, file, text, pattern, label, expected) {
  const match = claim(text, pattern);
  if (match === null) {
    findings.push(`${file}: expected a "${label}" claim, found none — the gate cannot verify it`);
    return;
  }
  expected.forEach(([want, source], index) => {
    const got = Number(match[index + 1]);
    if (got !== want) {
      findings.push(
        `${file}: stale count in "${match[0].trim()}" — ${label} says ${got}, ${source} is ${want}`,
      );
    }
  });
}

/**
 * Verify a hand-written "callable tools per preset" table: one `| \`<preset>\` | … | N |` row
 * per preset, whose LAST numeric column must equal what the policy engine actually grants.
 * Shared by the README table and the docs/10 §6.3 escalation table — the same numbers are
 * quoted in both, and T-317 proved they drift independently (`x_usage_get` is a `read:account`
 * tool, so landing it moved EVERY row by one).
 *
 * A row that cannot be found is a finding, not a silent skip: a gate that quietly stops
 * checking a number is worse than no gate at all.
 */
function checkPresetTable(findings, file, text, surface) {
  for (const preset of surface.presets) {
    if (preset.allow !== null) continue; // the DM combination is prose, checked separately
    const row = new RegExp(`^\\|\\s*\`${preset.name}\`.*\\|\\s*(\\d+)\\s*\\|\\s*$`, 'm').exec(text);
    if (row === null) {
      findings.push(
        `${file}: no preset table row for \`${preset.name}\` — the gate cannot verify it`,
      );
      continue;
    }
    if (Number(row[1]) !== preset.callable) {
      findings.push(
        `${file}: preset \`${preset.name}\` is documented as ${row[1]} callable tools, the registry says ${preset.callable}`,
      );
    }
  }
}

/**
 * docs/10 §6.3/§6.4 — the operator-facing derived counts. This file is NOT generated: the gate
 * only ASSERTS its numbers and reports, it never rewrites the operator's prose. Three claims
 * carry numbers that the policy engine owns:
 *
 *   - the §6.3 table header  "Callable tools (of N)"  -> the registered tool count
 *   - each §6.3 preset row                            -> that preset's callable count
 *   - the §6.4 parenthetical "(N tools, total M callable when combined with `full`)"
 *                                                     -> the DM tool count, and full+DM callable
 *
 * The neighbouring "Adds the three DM event-lookup tools" is deliberately NOT parsed: a spelled
 * -out number in flowing prose buys no coverage the parenthetical does not already give, and
 * would fail the build on an innocuous rewording.
 */
function checkOperatorGuide(surface, guideText, findings) {
  checkCounts(
    findings,
    GUIDE,
    guideText,
    /\|\s*Callable tools \(of (\d+)\)\s*\|/,
    'the §6.3 table header',
    [[surface.size, 'the registered tool count']],
  );
  checkPresetTable(findings, GUIDE, guideText, surface);

  const withDm = surface.presets.find((preset) => preset.allow !== null);
  checkCounts(
    findings,
    GUIDE,
    guideText,
    /\((\d+) tools, total (\d+) callable when combined with `full`\)/,
    'the §6.4 DM note',
    [
      [surface.dmTools, 'the DM-cell tool count'],
      [withDm?.callable ?? surface.size, 'full + DM allow callable'],
    ],
  );
}

/**
 * server.json's `description` is the copy the MCP registry shows in its listing, and it quotes
 * the tool and package counts — a third place the same two numbers are written by hand, and the
 * only one nobody in the repo ever reads again after publishing.
 *
 * This is a JSON string field, not markdown prose, so it is cheap and safe to check: the
 * manifest is parsed and one anchored pattern is matched against a single field. The gate only
 * ASSERTS — server.json is hand-maintained (scripts/server-json-guard.mjs owns its structural
 * invariants; this owns its two derived numbers).
 */
function checkManifest(surface, findings) {
  let description;
  try {
    description = JSON.parse(readRepoFile(MANIFEST)).description ?? '';
  } catch (error) {
    findings.push(
      `${MANIFEST}: cannot be parsed (${error instanceof Error ? error.message : String(error)})`,
    );
    return;
  }
  checkCounts(
    findings,
    MANIFEST,
    description,
    /(\d+) typed tools across (\d+) packages/,
    'the registry description',
    [
      [surface.size, 'the registered tool count'],
      [surface.packages.length, 'the registry package count'],
    ],
  );
}

/** The committed "not registered yet" list, or `null` when the region has never been filled. */
function committedPending(catalogText) {
  if (/Every catalogued tool is registered\./.test(catalogText)) return [];
  const paragraph = /\*\*Catalogued but not registered yet \(\d+\):\*\*([^\n]*)/.exec(catalogText);
  if (paragraph === null) return null;
  return [...paragraph[1].matchAll(/`(x_[a-z0-9_]+)`/g)].map((match) => match[1]);
}

function checkSemantics(surface, catalog, catalogText, readme, findings) {
  for (const conflict of surface.conflicts) findings.push(`registry: ${conflict}`);
  for (const name of surface.unmapped) {
    findings.push(`registry: tool \`${name}\` is not exported by any src/tools/<package>.ts`);
  }

  // D3 — duplicate catalog rows.
  const seen = new Map();
  for (const row of catalog.rows) {
    if (seen.has(row.name)) {
      findings.push(
        `${CATALOG}: tool \`${row.name}\` has two rows (sections "${seen.get(row.name)}" and "${row.section}")`,
      );
    }
    seen.set(row.name, row.section);
  }

  // D1/D2 — every registered tool has a catalog row, and that row is accurate.
  const byName = new Map(catalog.rows.map((row) => [row.name, row]));
  for (const tool of surface.tools) {
    const row = byName.get(tool.name);
    if (row === undefined) {
      findings.push(
        `${CATALOG}: tool \`${tool.name}\` is registered (package ${tool.package}) but has no catalog row — add it`,
      );
      continue;
    }
    const expected = [
      ['class', row.policy, tool.policy],
      ['availability', row.availability, tool.availability],
      ['cost', row.cost, tool.cost],
      ['phase', row.phase, `P${tool.phase}`],
    ];
    for (const [field, documented, actual] of expected) {
      if (documented !== actual) {
        findings.push(
          `${CATALOG}:${row.line}: tool \`${tool.name}\` ${field} is documented as "${documented}" but the registry says "${actual}"`,
        );
      }
    }
    if (tool.conditional) {
      findings.push(
        `${CATALOG}: tool \`${tool.name}\` is conditional, which contradicts the "All N are unconditional" claim`,
      );
    }
  }

  // D4 — a catalog row whose tool the registry does not register must be declared as such.
  const pending = pendingTools(surface, catalog);
  const declared = committedPending(catalogText);
  if (declared !== null) {
    for (const name of pending) {
      if (!declared.includes(name)) {
        findings.push(
          `${CATALOG}: tool \`${name}\` has a catalog row but is not registered — drop the row if the tool is gone, or run \`npm run docs:gen\` if it is still planned`,
        );
      }
    }
    for (const name of declared) {
      if (!pending.includes(name)) {
        findings.push(
          `${CATALOG}: tool \`${name}\` is listed as "not registered yet" but the registry now registers it — run \`npm run docs:gen\``,
        );
      }
    }
  }

  // D5 — prose counts.
  const rowCount = [catalog.rows.length, 'the catalog row count'];
  const toolCount = [surface.size, 'the registered tool count'];
  const prose = stripRegion(catalogText);
  checkCounts(findings, CATALOG, prose, /\*\*(\d+) tools in (\d+) packages\*\*/, 'the header', [
    rowCount,
    [catalog.packageSections.length, 'the catalogued package section count'],
  ]);
  checkCounts(
    findings,
    CATALOG,
    catalogText,
    /\*\*All (\d+) are unconditional\*\*/,
    'the unconditional claim',
    [rowCount],
  );
  checkCounts(
    findings,
    CATALOG,
    catalogText,
    /\*\*(\d+) \/ (\d+) \/ ~\d+\*\*/,
    'the count reconciliation',
    [rowCount, rowCount],
  );

  const readmeText = stripRegion(readme);
  checkCounts(findings, README, readmeText, /badge\/tools-(\d+)-/, 'the tools badge', [toolCount]);
  checkCounts(
    findings,
    README,
    readmeText,
    /The (\d+) tools registered today/,
    'the tools section intro',
    [toolCount],
  );
  checkCounts(findings, README, readmeText, /\(all (\d+) tools callable\)/, 'the DM unlock note', [
    toolCount,
  ]);
  for (const match of readmeText.matchAll(/\*\*(\d+) tools across (\d+) packages\*\*/g)) {
    if (Number(match[1]) !== surface.size || Number(match[2]) !== surface.packages.length) {
      findings.push(
        `${README}: stale count in "${match[0]}" — the registry has ${surface.size} tools in ${surface.packages.length} packages`,
      );
    }
  }
  // The hand-written "Tool packages" table must describe exactly the registry's packages.
  const section = /^### Tool packages$([\s\S]*?)(?=^#{2,3} )/m.exec(readmeText);
  if (section === null) {
    findings.push(`${README}: no "### Tool packages" section — the gate cannot verify it`);
  } else {
    const documented = [...section[1].matchAll(/^\|\s*`([a-z][a-z-]*)`\s*\|/gm)].map(
      (match) => match[1],
    );
    const known = new Set(surface.packages.map((entry) => entry.name));
    for (const name of documented) {
      if (!known.has(name)) {
        findings.push(
          `${README}: "Tool packages" lists \`${name}\`, which is not a registry package (src/tools/${name}.ts)`,
        );
      }
    }
    for (const name of known) {
      if (!documented.includes(name)) {
        findings.push(
          `${README}: package \`${name}\` is registered but missing from "Tool packages"`,
        );
      }
    }
  }

  checkPresetTable(findings, README, readmeText, surface);
}

// --- Diffing -----------------------------------------------------------------------------

const MAX_DIFF_LINES = 30;
const MAX_DIFF_INPUT = 4000;

/** Longest-common-subsequence edit script over lines. `-` is committed, `+` is generated. */
function editScript(got, want) {
  const rows = got.length;
  const columns = want.length;
  const table = new Uint32Array((rows + 1) * (columns + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      const here = i * (columns + 1) + j;
      table[here] =
        got[i] === want[j]
          ? table[here + columns + 2] + 1
          : Math.max(table[here + columns + 1], table[here + 1]);
    }
  }
  const script = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    const here = i * (columns + 1) + j;
    if (got[i] === want[j]) {
      script.push({ sign: ' ', line: got[i], at: i });
      i += 1;
      j += 1;
    } else if (table[here + columns + 1] >= table[here + 1]) {
      script.push({ sign: '-', line: got[i], at: i });
      i += 1;
    } else {
      script.push({ sign: '+', line: want[j], at: i });
      j += 1;
    }
  }
  while (i < rows) {
    script.push({ sign: '-', line: got[i], at: i });
    i += 1;
  }
  while (j < columns) {
    script.push({ sign: '+', line: want[j], at: i });
    j += 1;
  }
  return script;
}

/** A readable, dependency-free diff of the committed file against the generated one. */
function renderDiff(expected, actual) {
  const want = expected.split('\n');
  const got = actual.split('\n');
  if (want.length > MAX_DIFF_INPUT || got.length > MAX_DIFF_INPUT) {
    let head = 0;
    while (head < want.length && head < got.length && want[head] === got[head]) head += 1;
    return `    @@ first difference at line ${head + 1} @@\n    - ${got[head] ?? ''}\n    + ${want[head] ?? ''}`;
  }

  const script = editScript(got, want);
  const keep = new Set();
  script.forEach((entry, index) => {
    if (entry.sign === ' ') return;
    for (let offset = -1; offset <= 1; offset += 1) keep.add(index + offset);
  });

  const lines = [];
  let elided = 0;
  let previous = -2;
  for (let index = 0; index < script.length; index += 1) {
    if (!keep.has(index)) continue;
    const entry = script[index];
    if (lines.length >= MAX_DIFF_LINES) {
      if (entry.sign !== ' ') elided += 1;
      continue;
    }
    if (index !== previous + 1) lines.push(`    @@ line ${entry.at + 1} @@`);
    lines.push(`    ${entry.sign} ${entry.line}`);
    previous = index;
  }
  if (elided > 0) lines.push(`    @@ … ${elided} more differing line(s) @@`);
  return lines.join('\n');
}

/** Splice a generated body between the markers, keeping the markers themselves. */
function spliceRegion(file, text, body, findings) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    findings.push(
      `${file}: no ${BEGIN} … ${END} region — the generated tool table has nowhere to go`,
    );
    return null;
  }
  return `${text.slice(0, start)}${BEGIN}\n\n${body}\n\n${text.slice(end)}`;
}

// --- Main ---------------------------------------------------------------------------------

async function main() {
  const checkOnly = process.argv.includes('--check');
  const findings = [];
  const surface = await loadSurface();

  const readmeText = readRepoFile(README);
  const catalogText = readRepoFile(CATALOG);
  const catalog = parseCatalog(catalogText);

  checkSemantics(surface, catalog, catalogText, readmeText, findings);
  checkOperatorGuide(surface, readRepoFile(GUIDE), findings);
  checkManifest(surface, findings);

  const outputs = [{ file: REFERENCE, expected: renderReference(surface) }];
  const readmeExpected = spliceRegion(README, readmeText, renderReadmeRegion(surface), findings);
  if (readmeExpected !== null) outputs.push({ file: README, expected: readmeExpected });
  const catalogExpected = spliceRegion(
    CATALOG,
    catalogText,
    renderCatalogRegion(surface, catalog),
    findings,
  );
  if (catalogExpected !== null) outputs.push({ file: CATALOG, expected: catalogExpected });

  let drifted = 0;
  let written = 0;
  for (const output of outputs) {
    let committed = null;
    try {
      committed = readRepoFile(output.file);
    } catch {
      committed = null;
    }
    if (committed === output.expected) continue;
    if (checkOnly) {
      drifted += 1;
      findings.push(
        `${output.file}: drifted from the registry — run \`npm run docs:gen\`\n` +
          `${renderDiff(output.expected, committed ?? '')}`,
      );
      continue;
    }
    writeRepoFile(output.file, output.expected);
    written += 1;
    process.stdout.write(`docs-gen: wrote ${output.file}\n`);
  }

  if (network.hits > 0) {
    findings.push(`docs-gen: composing the server hit the network ${network.hits} time(s)`);
  }

  process.stdout.write(
    `docs-gen: ${surface.size} tools in ${surface.packages.length} packages, ` +
      `${surface.presets.map((preset) => `${preset.allow === null ? preset.name : 'full+dm'} ${preset.callable}`).join(', ')}\n`,
  );

  const unique = [...new Set(findings)];
  if (unique.length > 0) {
    process.stderr.write(`\ndocs-gen: FAIL — ${unique.length} drift finding(s)\n\n`);
    for (const finding of unique) process.stderr.write(`  ${finding}\n`);
    process.stderr.write('\n');
    return 1;
  }

  if (checkOnly) {
    process.stdout.write(`docs-gen: PASS — ${outputs.length} generated surface(s) up to date\n`);
  } else {
    process.stdout.write(
      `docs-gen: PASS — ${written} file(s) written, ${outputs.length - written - drifted} unchanged\n`,
    );
  }
  return 0;
}

process.exit(await main());
