// Context-budget gate for the MCP `tools/list` payload (T-313, WP-3.13). Companion to
// scripts/docs-gen.mjs and scripts/coverage-guard.mjs — same house style: no dependency
// beyond the compiled build, `process.stdout.write` for output, a non-zero exit on a real
// finding.
//
//   node scripts/context-gate.mjs            # measure, print the breakdown, enforce the cap
//   node scripts/context-gate.mjs --quiet    # totals only (no per-tool breakdown)
//
// WHY. Agent context is the scarce resource in an MCP session: every host pays for the whole
// serialized `tools/list` result on EVERY conversation, before a single tool is called. A
// description that grows a paragraph, an input schema that gains a nested object, or one new
// tool is invisible in a unit test and very visible in a token bill. This gate makes that
// growth a reviewable event instead of a silent regression.
//
// WHAT IS MEASURED. The real composed server (`parseConfig` + `composeServer`, exactly as
// src/index.ts does) is connected to an SDK `Client` over an `InMemoryTransport` pair — the
// same in-process protocol harness test/mcp/server.test.ts uses. The server's OUTGOING
// JSON-RPC response is captured off the transport and its `result` is serialized; the number
// enforced below is `Buffer.byteLength(JSON.stringify(result), 'utf8')`, i.e. the true UTF-8
// wire size, not the UTF-16 `.length` (tool descriptions contain `’`, `×`, `→`, so the two
// differ by ~30 bytes). No hand-rolled second definition of the tool list exists here.
//
// WHICH CONFIGURATION THE BUDGET IS DEFINED AGAINST. Two knobs change the payload:
//
//   * `X_MCP_HIDE_DENIED=1` DROPS policy-denied tools from the listing entirely (POL-7), so
//     it can only ever shrink the payload. It is therefore never the worst case and the
//     budget is defined with it OFF (the default).
//   * `X_MCP_POLICY` does NOT change how many tools register — with hide-denied off, all
//     tools stay listed — but a denied tool's description gains the
//     " (disabled by policy `<preset>`)" suffix (POL-7), so the STRICTEST preset produces the
//     LARGEST payload. `read-only` (the default) denies the most and is the worst case.
//
// The gate does not assume that: it measures every preset (plus `full` + the DM allow-list,
// the only configuration in which nothing is denied) and enforces the cap against the MAXIMUM
// it observes. `X_MCP_AVAILABILITY` is set to every gated class so availability gating
// (docs/01 §3.3) can never hide a tool from the measurement.
//
// THE BUDGET. Measured at the 41-tool surface: **78,445 bytes** worst case (`read-only`,
// hide-denied off, all availability classes; the spread across presets is only ~630 B). The
// cap is **80,000 bytes** — 1,555 B of headroom, ~1.9% of the cap. That is now under one
// mean tool (~1.9 kB): **the surface is full**. The nine remaining design-catalogue rows were
// cut for exactly this reason (docs/decisions/0002); landing anything else means trimming
// descriptions first. Raising the cap is a deliberate, reviewable act: state in the PR what
// grew and why the agent should pay for it.
//
// DETERMINISM / OFFLINE. Nothing here reads the clock, the environment or the network;
// `globalThis.fetch` is replaced by a tripwire before the server is composed, and a hit is a
// finding.

import { Buffer } from 'node:buffer';
import process from 'node:process';
import { URL } from 'node:url';

const REPO = new URL('../', import.meta.url);
const BUILD = new URL('build/src/', REPO);

/** The enforced cap, in UTF-8 bytes, on the serialized `tools/list` result. */
const BUDGET_BYTES = 80_000;

/** The measurement this budget was set from — printed so drift against it is visible. */
const BASELINE_BYTES = 78_445;

/** Per-tool advisory ceiling: no single tool should own an outsized slice of the listing. */
const PER_TOOL_WARN_BYTES = 3_000;

const DM_CELLS = 'read:dm,write:dm';

// Every availability class, so class-gating never hides a tool from the measurement.
const BASE_ENV = {
  X_MCP_AUTH_MODE: 'app-only',
  X_MCP_BEARER_TOKEN: 'context-gate-not-a-real-credential',
  X_MCP_AVAILABILITY: 'pilot,premium-user,enterprise',
};

// --- Offline tripwire ------------------------------------------------------------------

const network = { hits: 0 };
globalThis.fetch = () => {
  network.hits += 1;
  return Promise.reject(new Error('context-gate: network access is disabled'));
};

// --- Loading the build + the SDK --------------------------------------------------------

async function loadBuild() {
  try {
    return {
      config: await import(new URL('core/config.js', BUILD).href),
      compose: await import(new URL('mcp/compose.js', BUILD).href),
      policy: await import(new URL('core/policy.js', BUILD).href),
      Client: (await import('@modelcontextprotocol/sdk/client/index.js')).Client,
      InMemoryTransport: (await import('@modelcontextprotocol/sdk/inMemory.js')).InMemoryTransport,
    };
  } catch (error) {
    process.stderr.write(
      `context-gate: cannot load the compiled build from ${BUILD.href}\n` +
        `context-gate: run \`npm run build\` first (${error instanceof Error ? error.message : String(error)})\n`,
    );
    process.exit(2);
  }
}

const bytes = (value) => Buffer.byteLength(value, 'utf8');

/**
 * Compose the real server for one configuration, connect an SDK client over an in-memory
 * transport pair (MCP-2, as test/mcp/server.test.ts does), issue `tools/list`, and return the
 * server's own outgoing `result` object — the exact payload the host is charged for.
 */
async function measure(build, label, env) {
  const composition = build.compose.composeServer(
    build.config.parseConfig({ ...BASE_ENV, ...env }),
  );
  const [clientTransport, serverTransport] = build.InMemoryTransport.createLinkedPair();

  // Capture what the SERVER puts on the wire rather than what the client's zod schema hands
  // back: the response object is measured verbatim, with no reordering or unknown-key
  // stripping between the adapter and the byte count.
  const sent = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = (message, options) => {
    sent.push(message);
    return send(message, options);
  };

  const client = new build.Client({ name: 'context-gate', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), composition.server.connect(serverTransport)]);
  await client.listTools();
  await client.close();

  const response = sent.find((message) => Array.isArray(message?.result?.tools));
  if (response === undefined) {
    process.stderr.write(`context-gate: the server never answered tools/list for "${label}"\n`);
    process.exit(2);
  }

  const json = JSON.stringify(response.result);
  const tools = response.result.tools.map((tool) => ({
    name: tool.name,
    bytes: bytes(JSON.stringify(tool)),
  }));
  tools.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));

  return {
    label,
    total: bytes(json),
    count: tools.length,
    tools,
    // Everything that is not a tool object: the `{"tools":[…]}` envelope and the separators.
    envelope: bytes(json) - tools.reduce((sum, tool) => sum + tool.bytes, 0),
  };
}

// --- Reporting ---------------------------------------------------------------------------

function pad(value, width) {
  return String(value).padStart(width);
}

function renderBreakdown(worst) {
  const nameWidth = Math.max(...worst.tools.map((tool) => tool.name.length));
  const lines = [];
  for (const tool of worst.tools) {
    const share = ((tool.bytes / worst.total) * 100).toFixed(1);
    const flag = tool.bytes > PER_TOOL_WARN_BYTES ? '  <- large' : '';
    lines.push(
      `  ${tool.name.padEnd(nameWidth)}  ${pad(tool.bytes, 6)} B  ${pad(share, 5)}%${flag}`,
    );
  }
  lines.push(
    `  ${'(envelope + separators)'.padEnd(nameWidth)}  ${pad(worst.envelope, 6)} B  ` +
      `${pad(((worst.envelope / worst.total) * 100).toFixed(1), 5)}%`,
  );
  return lines.join('\n');
}

// --- Main ---------------------------------------------------------------------------------

async function main() {
  const quiet = process.argv.includes('--quiet');
  const build = await loadBuild();

  const measurements = [];
  for (const preset of build.policy.POLICY_PRESETS) {
    measurements.push(await measure(build, preset, { X_MCP_POLICY: preset }));
  }
  measurements.push(
    await measure(build, 'full + DM allow', {
      X_MCP_POLICY: 'full',
      X_MCP_POLICY_ALLOW: DM_CELLS,
    }),
  );

  const worst = measurements.reduce((max, entry) => (entry.total > max.total ? entry : max));

  if (!quiet) {
    process.stdout.write(`context-gate: tools/list size by configuration (hide-denied off)\n`);
    for (const entry of measurements) {
      const marker = entry === worst ? ' <- worst case' : '';
      process.stdout.write(
        `  ${entry.label.padEnd(16)} ${pad(entry.total, 6)} B  ${pad(entry.count, 3)} tools${marker}\n`,
      );
    }
    process.stdout.write(`\ncontext-gate: per-tool breakdown for "${worst.label}"\n`);
    process.stdout.write(`${renderBreakdown(worst)}\n\n`);
  }

  const findings = [];
  if (network.hits > 0) {
    findings.push(`composing the server hit the network ${network.hits} time(s)`);
  }
  if (worst.total > BUDGET_BYTES) {
    findings.push(
      `tools/list is ${worst.total} B under "${worst.label}", over the ${BUDGET_BYTES} B budget ` +
        `by ${worst.total - BUDGET_BYTES} B — shrink the largest descriptions/schemas above, or ` +
        `raise BUDGET_BYTES in ${'scripts/context-gate.mjs'} with a justification in the PR`,
    );
  }

  if (findings.length > 0) {
    process.stderr.write(`context-gate: FAIL — ${findings.length} finding(s)\n\n`);
    for (const finding of findings) process.stderr.write(`  ${finding}\n`);
    process.stderr.write('\n');
    return 1;
  }

  const drift = worst.total - BASELINE_BYTES;
  const sign = drift >= 0 ? '+' : '';
  process.stdout.write(
    `context-gate: PASS — ${worst.count} tools, ${worst.total} B / ${BUDGET_BYTES} B budget ` +
      `(${(((BUDGET_BYTES - worst.total) / BUDGET_BYTES) * 100).toFixed(1)}% headroom, ` +
      `${sign}${drift} B vs the ${BASELINE_BYTES} B baseline)\n`,
  );
  return 0;
}

process.exit(await main());
