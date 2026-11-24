// Context-budget gate for the MCP `tools/list` payload (T-313, WP-3.13). Companion to
// scripts/docs-gen.mjs and scripts/coverage-guard.mjs — same house style: no dependency
// beyond the compiled build, `process.stdout.write` for output, a non-zero exit on a real
// finding.
//
//   node scripts/context-gate.mjs            # measure, print the breakdown, enforce the cap
//   node scripts/context-gate.mjs --quiet    # totals only (wire, model-visible, tool count)
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
// THE BUDGET. Measured at the 42-tool surface (Phase 3's `x_thread_create` added): **79,987
// bytes** worst case (`read-only`, hide-denied off, all availability classes; the spread
// across presets is only ~700 B). The cap is **80,000 bytes** — 13 B of headroom, effectively
// none. `x_thread_create` landed at its terse-wording floor (see its description/schema) to fit
// inside the ~1,555 B that remained at the 41-tool baseline. Tightening redundant description
// wording (restatements of what the JSON Schema or a parameter's own description already
// carries) then brought the surface to **78,434 bytes**, and moving the parameter wording that
// recurs across tools (page_token, raw, max_results, the time bounds, list_id) into one terse
// source (src/tools/params.ts) to **76,816 bytes**; x_usage_get's per-tool `by_tool` map
// then added 69 B, to **76,885 bytes**, x_thread_create's resume `reply_to_id` 120 B,
// to **77,005 bytes**, and `since_id` on the four search/timeline reads 464 B, to
// **77,469 bytes**. The optional `paid_partnership` flag (x_post_create input + the
// compact-post output field inlined into every post-returning schema) then cost 416 B:
// **77,885 bytes** — ~2,115 B of headroom. Q08 (review 13 H1 + H2) then dropped the
// converter's `$schema` stamp from every inputSchema (−2,184 B) and the spec-default
// `openWorldHint: true` from the annotations (−882 B; the two closed-world tools keep an
// explicit `false`, +44 B): **74,863 bytes** — ~5,137 B of headroom. Q09 (review 13 c1) then
// dropped the identical `meta` block from all 42 outputSchemas (−8,106 B; `structuredContent`
// still carries it, documented once in docs/03 "Result shape"): **66,757 bytes** — ~13,243 B
// of headroom. Q10 (OD-4, review 13 §6 Q4) then added the three bookmark-folder tools —
// x_bookmark_folders_list 1,147 B, x_bookmark_folder_posts 1,308 B, x_bookmark_folder_create
// 702 B (+3,160 B with the list framing): **69,917 bytes** — ~10,083 B of headroom. Q11
// (owner go 2026-11-20) then added the two read-only news tools — x_news_search 1,593 B,
// x_news_get 1,080 B (+2,675 B with the list framing): **72,592 bytes** — ~7,408 B of
// headroom. Q12 (owner go 2026-11-20) then added the two Article writes —
// x_article_draft_create 1,437 B, x_article_publish 759 B (+2,198 B with the list framing):
// **74,790 bytes** — ~5,210 B of headroom. The
// nine remaining design-catalogue rows were already cut for the same reason (docs/decisions/
// 0002); landing anything else means trimming descriptions first, or raising the cap as a
// deliberate, reviewable act — state in the PR what grew and why the agent should pay for it.
//
// THE MODEL-VISIBLE SUB-MEASURE (Q13, review 13 §2 e1, owner pick 2026-11-21). The wire
// size is a proxy: about half of it is `outputSchema`, which Anthropic-style tool definitions
// have no field for, so a model most likely never sees those bytes. Next to the wire cap
// the gate therefore measures, from the same captured response, what a client that puts
// every definition into the prompt actually spends: per tool `name`, `description`,
// `inputSchema` and `annotations.title`, kept in their wire positions inside a
// `{"tools":[…]}` envelope (scripts/lib/context-budget.mjs `modelVisibleView`). It is taken
// over the same configurations and enforced against its own worst case (again `read-only`,
// whose " (disabled by policy …)" suffixes sit in the descriptions). Measured at the 49-tool
// surface: **39,802 bytes**. The cap was set at 40,000 B in Q13 (198 B of headroom, effectively a
// freeze) and raised by the owner on 2026-11-24 to **44,000 bytes** — ~4,198 B (9.5%) of
// headroom, enough for a few small additions while still catching silent growth. The wire cap stays
// 80,000 B; the two caps are independent and both must hold.
//
// THE TOOL-COUNT GUARD (Q13, review 13 §2 e3). The limits clients actually enforce are tool
// COUNTS, not bytes. With hide-denied off every configuration lists the whole surface, so
// every measured configuration must list exactly TOOL_COUNT_BASELINE tools; a mismatch
// fails, and a count change is a deliberate baseline edit, like the bytes (it moves together
// with REGISTERED_TOOLS in test/mcp/surface.test.ts). Separately, a listed count above a
// known client limit (CLIENT_TOOL_LIMITS, each with its source and how firm it is) prints a
// warning and never fails: those limits are shared with every other server the user runs,
// so x-mcp alone cannot decide whether a session crosses them.
//
// DETERMINISM / OFFLINE. Nothing here reads the clock, the environment or the network;
// `globalThis.fetch` is replaced by a tripwire before the server is composed, and a hit is a
// finding.

import process from 'node:process';
import { URL } from 'node:url';

import { bytes, evaluate, modelVisibleBytes } from './lib/context-budget.mjs';

const REPO = new URL('../', import.meta.url);
const BUILD = new URL('build/src/', REPO);

/** The enforced cap, in UTF-8 bytes, on the serialized `tools/list` result. */
const BUDGET_BYTES = 80_000;

/** The measurement this budget was set from — printed so drift against it is visible. */
const BASELINE_BYTES = 74_790;

/** The enforced cap, in UTF-8 bytes, on the model-visible view (header, Q13 / e1). */
const MODEL_VISIBLE_BUDGET_BYTES = 44_000;

/** The model-visible measurement its cap was set from. */
const MODEL_VISIBLE_BASELINE_BYTES = 39_802;

/** Listed tools in every configuration (hide-denied off). Changing it is deliberate (e3). */
const TOOL_COUNT_BASELINE = 49;

/**
 * Client tool-count limits a listing above which prints a warning (never a failure).
 * Fact-checked 2026-11-21; `status` says how firm each figure is.
 */
const CLIENT_TOOL_LIMITS = [
  {
    client: 'VS Code / GitHub Copilot',
    limit: 128,
    status: 'documented, per request across all servers',
    source: 'https://code.visualstudio.com/docs/copilot/agents/agent-tools',
  },
  {
    client: 'Cursor',
    limit: 40,
    status:
      'historic community figure, unconfirmed — the official MCP docs publish no cap as of ' +
      '2026-11-21; staff cite a per-model provider cap',
    source: 'https://forum.cursor.com/t/tools-limited-to-40-total/67976',
  },
];

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
    modelVisible: modelVisibleBytes(response.result.tools),
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

  const { worst, worstModelVisible, listed, findings, warnings } = evaluate(measurements, {
    budgetBytes: BUDGET_BYTES,
    modelVisibleBudgetBytes: MODEL_VISIBLE_BUDGET_BYTES,
    toolCountBaseline: TOOL_COUNT_BASELINE,
    clientToolLimits: CLIENT_TOOL_LIMITS,
    networkHits: network.hits,
  });

  if (!quiet) {
    process.stdout.write(`context-gate: tools/list size by configuration (hide-denied off)\n`);
    process.stdout.write(
      `  ${'configuration'.padEnd(16)} ${'wire'.padStart(8)}  ${'model'.padStart(8)}\n`,
    );
    for (const entry of measurements) {
      const marker = entry === worst ? ' <- worst case' : '';
      process.stdout.write(
        `  ${entry.label.padEnd(16)} ${pad(entry.total, 6)} B  ${pad(entry.modelVisible, 6)} B  ` +
          `${pad(entry.count, 3)} tools${marker}\n`,
      );
    }
    process.stdout.write(`\ncontext-gate: per-tool breakdown for "${worst.label}"\n`);
    process.stdout.write(`${renderBreakdown(worst)}\n\n`);
  }

  for (const warning of warnings) process.stdout.write(`context-gate: warning — ${warning}\n`);

  if (findings.length > 0) {
    process.stderr.write(`context-gate: FAIL — ${findings.length} finding(s)\n\n`);
    for (const finding of findings) process.stderr.write(`  ${finding}\n`);
    process.stderr.write('\n');
    return 1;
  }

  const drift = (value, baseline) => `${value >= baseline ? '+' : ''}${value - baseline} B`;
  const headroom = (value, cap) => `${(((cap - value) / cap) * 100).toFixed(1)}% headroom`;
  process.stdout.write(
    `context-gate: PASS — ${worst.count} tools, ${worst.total} B / ${BUDGET_BYTES} B budget ` +
      `(${headroom(worst.total, BUDGET_BYTES)}, ${drift(worst.total, BASELINE_BYTES)} vs the ` +
      `${BASELINE_BYTES} B baseline)\n` +
      `context-gate: PASS — model-visible ${worstModelVisible.modelVisible} B / ` +
      `${MODEL_VISIBLE_BUDGET_BYTES} B budget under "${worstModelVisible.label}" ` +
      `(${headroom(worstModelVisible.modelVisible, MODEL_VISIBLE_BUDGET_BYTES)}, ` +
      `${drift(worstModelVisible.modelVisible, MODEL_VISIBLE_BASELINE_BYTES)} vs the ` +
      `${MODEL_VISIBLE_BASELINE_BYTES} B baseline)\n` +
      `context-gate: PASS — tool count ${listed} = the ${TOOL_COUNT_BASELINE}-tool baseline\n`,
  );
  return 0;
}

process.exit(await main());
