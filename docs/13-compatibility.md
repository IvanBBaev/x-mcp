# 13 — Client compatibility

Which MCP clients this server works in, and — just as important — how confident anyone is
allowed to be about each one. Every claim on this page carries an explicit evidence level,
because a compatibility matrix that quietly upgrades "should work" into "verified" is the
kind of document that gets an operator stuck at 2 a.m. Companion pages:
[10-operator-guide.md](10-operator-guide.md) (setup, env recipes),
[11-troubleshooting.md](11-troubleshooting.md) (symptoms),
[02-architecture.md](02-architecture.md) (why the protocol surface looks like this).

> **Disclosure.** No third-party GUI client was launched while writing this page. Claude
> Desktop, Claude Code, VS Code, Cursor, Zed and Continue.dev were **not** run against this
> server. The rows for those clients describe an expectation derived from the protocol
> surface plus each client's published configuration format — nothing more. Section 7 is
> the checklist that turns those rows into observations.

## 1. Evidence vocabulary

Four levels, in descending order of trust. They are used consistently in the **Evidence**
column of the matrix and nowhere loosely.

| Level | What it means | Can it regress silently? |
|---|---|---|
| `protocol-verified` | Pinned by an in-repo automated test that speaks the real MCP protocol (SDK `Client` over `InMemoryTransport`, or a spawned process over real stdio). Cited as `file:line`. | No — CI fails first. |
| `probe-verified` | Run live against the built server during authorship, with a reproducible command recorded here. Not pinned by a test. | Yes. |
| `spec-derived` | The client's documented configuration format and advertised capabilities say this works, and the server side is `protocol-verified`. Nobody ran this server in that client. | Yes, on either side. |
| `unverified` | Plausible, but nothing was run and no client-side source is cited. Needs a human. | — |

Cell markers inside the matrix:

- **yes** — observed working at the row's evidence level.
- **exp** — *expected*: the server side is `protocol-verified`, the client documents the
  feature, but this pairing was never exercised. Not a claim of success.
- **no** — observed or documented not to work.
- **n/a** — the feature does not apply to that client.

## 2. The protocol surface every client sees

All `exp` cells in the matrix rest on this section. These are server-side facts, verified
independently of any client.

| Property | Value | Evidence |
|---|---|---|
| Transport | stdio only. One JSON-RPC frame per line on stdout; nothing else ever reaches stdout. | `protocol-verified` — [`test/mcp/spawn.test.ts:111`](../test/mcp/spawn.test.ts) |
| Protocol version | Echoes the client's request when it is one of `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`. An unrecognised version falls back to `2025-11-25`. | `probe-verified` (§7.1 reproduces it) |
| Capabilities | Exactly `{"tools":{}}`. No `listChanged`, no resources, prompts, logging, completions, sampling, elicitation or roots. | `protocol-verified` — [`src/mcp/server.ts:61`](../src/mcp/server.ts), [`test/mcp/server.test.ts:179`](../test/mcp/server.test.ts) |
| `instructions` | 944 characters returned on `initialize`. | `protocol-verified` — [`test/mcp/server.test.ts:179`](../test/mcp/server.test.ts) |
| `tools/list` | 41 tools, delivered in one response (~78 KB), `nextCursor` absent. Every tool carries `inputSchema`, `outputSchema` and `annotations`. | `protocol-verified` — [`test/mcp/spawn.test.ts:123`](../test/mcp/spawn.test.ts) (count), [`test/mcp/server.test.ts:134`](../test/mcp/server.test.ts) (schemas), [`test/mcp/structured.test.ts:174`](../test/mcp/structured.test.ts) (output-schema coverage) |
| `tools/call` success | `content[0]` is a JSON text block **and** `structuredContent` is the same object. | `protocol-verified` — [`test/mcp/structured.test.ts:134`](../test/mcp/structured.test.ts) |
| `tools/call` failure | Text-only result with `isError: true`. No `structuredContent` — deliberate, since the spec exempts error results from `outputSchema` conformance. | `protocol-verified` — [`test/mcp/server.test.ts:300`](../test/mcp/server.test.ts) |
| Unknown tool name | A typed `validation` **tool result**, not a JSON-RPC error. Clients that only surface protocol errors still see the message. | `protocol-verified` — [`test/mcp/server.test.ts:529`](../test/mcp/server.test.ts) |
| Cancellation | `notifications/cancelled` aborts the in-flight HTTP request and rejects with JSON-RPC `-32001`; the session stays usable. | Plumbing `protocol-verified` — [`test/core/registry.test.ts:484`](../test/core/registry.test.ts), [`test/tools/media.test.ts:1259`](../test/tools/media.test.ts); end-to-end over MCP `probe-verified` (402 ms against a 60 s delayed reply, the full tool list still served afterwards) |
| Progress notifications | **Not supported.** No `progressToken` handling, no `notifications/progress` — including for chunked media upload, which has an internal progress seam that is not wired to MCP. | `probe-verified` (no `progress` reference in [`src/mcp/compose.ts`](../src/mcp/compose.ts)) |
| Unknown methods | `resources/list`, `prompts/list`, anything unrecognised → `-32601 Method not found`. `ping` works (SDK built-in). | `probe-verified` (§7.1) |
| Startup failure | One `x-mcp-ai: fatal: <reason>` line on **stderr**, empty stdout, exit 1. | `protocol-verified` — [`test/mcp/spawn.test.ts:155`](../test/mcp/spawn.test.ts) |
| Shutdown | Clean exit 0 on stdin EOF, SIGINT or SIGTERM. | `protocol-verified` — [`test/mcp/spawn.test.ts:111`](../test/mcp/spawn.test.ts), [`:140`](../test/mcp/spawn.test.ts) |

**What this means for a client.** A client needs nothing beyond stdio spawn, `env`
injection, `initialize`, `tools/list` and `tools/call`. Any client that cannot do those
five things cannot use this server; any client that can needs no other feature, because the
server advertises none. There is no tool-list-changed notification, so a client that caches
`tools/list` across a session sees a stable list — which is correct here, since the policy
is fixed at startup.

## 3. The matrix

| Client | Launch | Env passing | `tools/list` | `tools/call` | `structuredContent` | Cancellation | Instructions | Evidence | Notes |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|---|
| **Reference SDK `Client`** (`@modelcontextprotocol/sdk` 1.30.0) | yes | yes | yes | yes | yes | yes | yes | `protocol-verified` | The baseline the test suite speaks. If something breaks here, CI is red. |
| **Raw stdio JSON-RPC host** (hand-written frames) | yes | yes | yes | yes | yes | exp | yes | `probe-verified` | Lowest common denominator. See the stdin caveat in §7.4. |
| **MCP Inspector 2.1.0 — `--cli`** | yes | yes | yes | yes | yes | exp | n/a | `probe-verified` | Returned 41 tools, 41 with `outputSchema`, 41 with `annotations`; rendered a policy refusal for `x_post_create` under `read-only`. CLI mode does not display `instructions`. Re-probed 2026-08-09 at the 41-tool surface — see §4.5.1. |
| **MCP Inspector 2.1.0 — GUI** | exp | exp | exp | exp | exp | exp | exp | `unverified` | Same binary as the row above, different front end. Not launched — no browser in this environment. |
| **Claude Desktop** | exp | exp | exp | exp | exp | exp | exp | `unverified` (config shape `spec-derived`) | Config format matches [10-operator-guide §4.1](10-operator-guide.md). Not launched. |
| **Claude Code** | exp | exp | exp | exp | exp | exp | exp | `unverified` (config shape `spec-derived`) | Config format matches [10-operator-guide §4.2](10-operator-guide.md). Not launched. |
| **VS Code** (Copilot agent mode) | exp | exp | exp | exp | exp | exp | exp | `unverified` (config shape `spec-derived`) | Needs `"type": "stdio"`; supports `inputs` prompts for secrets — see [10-operator-guide §4.3](10-operator-guide.md). Not launched. |
| **Cursor** | exp | exp | exp | exp | exp | exp | exp | `unverified` (config shape `spec-derived`) | Claude Desktop config shape — see [10-operator-guide §4.4](10-operator-guide.md). Not launched. |
| **Zed** | exp | exp | exp | exp | exp | exp | exp | `unverified` | Zed calls stdio MCP servers "context servers" and configures them under `context_servers` in `settings.json`. Format not confirmed against a running Zed. |
| **Continue.dev** | exp | exp | exp | exp | exp | exp | exp | `unverified` | Configured as an MCP block in the assistant/`config.yaml`. Format not confirmed against a running Continue. |

**Seven rows are `unverified`.** They are, in matrix order: Inspector GUI, Claude Desktop,
Claude Code, VS Code, Cursor, Zed, Continue.dev. Nothing on this page should be read as a
statement that this server has been seen working inside any of them.

## 4. Configuration snippets

These are the snippets from [10-operator-guide.md §4](10-operator-guide.md) — that page is
the source of truth for setup; this page repeats the shapes only so the matrix rows are
self-contained. Replace `/abs/path/to/x-mcp` with the checkout path. `npx -y x-mcp-ai@0.8.0`
works now that the package is published; the snippets below still spawn Node against the
built entry point, because that is the form the probes on this page were run against — the
npx form is the same process with npm resolution in front of it.

Two equivalent launch commands, both `probe-verified`:

| Command | Behaviour |
|---|---|
| `node /abs/path/to/x-mcp/build/src/index.js` | Direct entry. What all the snippets below use. |
| `node /abs/path/to/x-mcp/bin/x-mcp-ai.cjs` | The packaged launcher. Identical, plus a Node-version guard that prints `x-mcp-ai: fatal: Node <v> is not supported - Node >= 22 is required` and exits 1 on an old runtime — legible instead of a syntax error. Prefer this when the client's Node is not the one you tested with. |

### 4.1 Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "x": {
      "command": "node",
      "args": ["/abs/path/to/x-mcp/build/src/index.js"],
      "env": {
        "X_MCP_AUTH_MODE": "oauth2",
        "X_MCP_CLIENT_ID": "your-oauth2-client-id",
        "X_MCP_POLICY": "read-only",
        "X_MCP_CREDIT_BUDGET": "5.00",
        "X_MCP_BUDGET_MODE": "hard"
      }
    }
  }
}
```

### 4.2 Claude Code

```bash
claude mcp add x \
  --scope user \
  --env X_MCP_AUTH_MODE=oauth2 \
  --env X_MCP_CLIENT_ID=your-oauth2-client-id \
  --env X_MCP_POLICY=read-only \
  --env X_MCP_CREDIT_BUDGET=5.00 \
  --env X_MCP_BUDGET_MODE=hard \
  -- node /abs/path/to/x-mcp/build/src/index.js
```

Project scope writes a `.mcp.json` with the Claude Desktop shape; keep secrets out of it.

### 4.3 VS Code

`.vscode/mcp.json` — note the `servers` map (not `mcpServers`) and the explicit `type`:

```json
{
  "inputs": [
    { "id": "x-client-id", "type": "promptString", "description": "X OAuth 2.0 client ID", "password": true }
  ],
  "servers": {
    "x": {
      "type": "stdio",
      "command": "node",
      "args": ["/abs/path/to/x-mcp/build/src/index.js"],
      "env": {
        "X_MCP_AUTH_MODE": "oauth2",
        "X_MCP_CLIENT_ID": "${input:x-client-id}",
        "X_MCP_POLICY": "read-only",
        "X_MCP_CREDIT_BUDGET": "5.00",
        "X_MCP_BUDGET_MODE": "hard"
      }
    }
  }
}
```

### 4.4 Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project) — the Claude Desktop shape,
identical to §4.1.

### 4.5 MCP Inspector

```bash
# GUI (unverified — needs a browser)
npx @modelcontextprotocol/inspector node /abs/path/to/x-mcp/build/src/index.js

# CLI (probe-verified)
npx @modelcontextprotocol/inspector@2.1.0 --cli \
  node /abs/path/to/x-mcp/build/src/index.js \
  -e X_MCP_AUTH_MODE=app-only -e X_MCP_BEARER_TOKEN=AAAA -e X_MCP_LOG_LEVEL=silent \
  --method tools/list
```

**Argument order matters.** Inspector 2.1.0 treats anything before the launch command as
config-file selection and exits with `No servers found in config file` if the `-e` flags come
first. Put the `node <entry>` command immediately after `--cli`, then the `-e` pairs, then
`--method`.

#### 4.5.1 Re-probe at the 41-tool surface (2026-08-09, SDK 1.30.0)

The CLI probe is repeated whenever the tool surface or the SDK moves — most recently for the
1.29.0 → 1.30.0 dependency-advisory bump (see §6) and again after `x_bookmarks_list` and
`x_post_hide_reply` landed. Three calls: `tools/list`, `tools/call` on a denied tool, and
`tools/call` on one of the new tools. All three held:

- `tools/list` → **41 tools, 41 with `outputSchema`, 41 with `annotations`**, and **20 with
  "(disabled by policy `read-only`)"** appended to the description — the exact complement of
  the 21 cells `read-only` allows, which is the denied-tools-stay-registered rule (§3.3 of
  [04-security.md](04-security.md)) observable from outside the process.
- The serialized `tools/list` result measured **78,445 bytes** — byte-identical to what
  `npm run gate:context` reports. Worth recording: it means the context gate measures the
  real wire payload rather than an approximation of it, so its 80 kB budget is a claim about
  what a client actually pays.
- `tools/call x_post_create` under `read-only` → `isError: true` carrying
  `{"kind":"policy","retryable":false,"fix":"operator","cell":"write:content"}` and the
  message *"…(blocked cell `write:content`). Enabling it is an operator decision made outside
  this session; see the operator guide."* **No environment variable is named** — the T-320 F2
  contract confirmed end to end through a third-party client, not just in unit tests.
- `tools/call x_post_hide_reply` with `--tool-arg reply_id=1` (a JSON number, not a string) →
  a typed `validation` result naming the field: *"reply\_id: Expected string, received
  number"*. Recorded because it is the failure mode a client most often produces by itself:
  Inspector coerces bare digits to numbers, and the server rejects the coercion instead of
  accepting it. An agent gets a `fix: "agent"` error it can act on, not a silent id mangle.

### 4.6 Zed and Continue.dev — `unverified`

Both are stdio MCP hosts and need the same three facts: `command` = `node`, `args` = the
absolute entry path, and an `env` map of `X_MCP_*` strings. Zed places this under
`context_servers` in `settings.json`; Continue.dev places it in an MCP block of the
assistant config. **Neither format was confirmed against a running client** — consult that
client's current documentation and treat §7 as the acceptance test.

## 5. Minimum supported

| Requirement | Value | Evidence |
|---|---|---|
| Node.js | **>= 22**. Declared in `package.json` `engines`; enforced at launch by `bin/x-mcp-ai.cjs` before any `node:`-prefixed import, so an old runtime gets one readable fatal line rather than a parse error. | `protocol-verified` — [`test/mcp/launcher.test.ts:26`](../test/mcp/launcher.test.ts); CI job `launcher probe (Node 12)` at [`.github/workflows/ci.yml:95`](../.github/workflows/ci.yml) |
| MCP protocol | `2025-03-26` and newer, up to `2025-11-25`. `2024-11-05` and `2024-10-07` are accepted by the SDK and echoed, but are not exercised by any test — treat them as `unverified`. | `probe-verified` |
| Transport | stdio only. No HTTP, no SSE, no WebSocket. A client that can only speak a remote transport cannot use this server. | `protocol-verified` — [`src/index.ts`](../src/index.ts) uses `StdioServerTransport` exclusively |
| MCP SDK | `^1.12.0` declared, 1.30.0 installed and tested against. Bumped from 1.29.0 on 2026-08-07 by a lockfile-only `npm audit fix` closing two **high** advisories in the SDK's own transitive tree (`fast-uri` host confusion, `ip-address` SSRF/trust-boundary) plus `js-yaml`, `hono` and `undici`. Neither high advisory is reachable from this server — both sit under the SDK's HTTP/SSE transport and JSON-Schema validator, and this server is stdio-only with hand-rolled Zod validation — but `npm run check` gates on `npm audit --omit=dev --audit-level=high` and does not grade reachability, deliberately: a "not reachable today" exception is a claim that has to be re-proved on every dependency change, and nobody re-proves it. | `package.json` |
| Platforms | CI runs the full gate — including the spawned-stdio tests — on ubuntu (Node 22 and 24), macOS (Node 22) and Windows (Node 22). A packed-tarball smoke job checks that the shipped `files` set actually boots. | `protocol-verified` — [`.github/workflows/ci.yml:23`](../.github/workflows/ci.yml), [`:118`](../.github/workflows/ci.yml) |
| Client features required | Spawn a subprocess, pass `env`, `initialize`, `tools/list`, `tools/call`. Nothing else. | §2 |

## 6. Client limitations worth knowing — all `spec-derived`

None of these were observed here; they are recorded because they are the failure modes most
likely to be mistaken for a server bug.

- **`PATH` is not the shell's `PATH`.** GUI clients launched from a desktop environment
  often inherit a minimal `PATH` that does not include a version-manager shim, so a bare
  `"command": "node"` can resolve to a Node 18 that trips the version guard, or to nothing
  at all. Use an absolute interpreter path if the client's log shows `spawn node ENOENT`.
- **Relative paths do not work.** There is no defined working directory for a spawned
  server. Every path in a client config must be absolute — including
  `X_MCP_PROFILES_FILE`.
- **`env` values must be strings.** `"X_MCP_CREDIT_BUDGET": 5.00` is a JSON number and some
  clients will refuse the config outright; quote it.
- **No `.env` file is read.** Nothing in this server loads one. If you want a file, spawn
  `node --env-file=.env ...` yourself.
- **Interactive OAuth cannot happen inside a client.** `authorize` opens a browser and
  binds a loopback port; run it once from a terminal before the client ever starts the
  server. See [10-operator-guide §3](10-operator-guide.md).
- **Some clients truncate or hide `instructions`.** The 944-character instruction block is
  what tells the model about presets, budgets and confirmation tokens. If a client ignores
  it, the model may attempt denied tools and get policy refusals it does not understand —
  a UX problem, not a correctness one.
- **A large `tools/list` costs context.** 41 tools with descriptions is ~78 KB of JSON.
  Clients that inject the whole tool list into the prompt will feel it. Use
  `X_MCP_HIDE_DENIED=1` with a narrow preset to shrink the list to the callable set.

## 7. Needs a human to verify

This is the handoff. Each subsection is self-contained: exact commands, exact expected
output, and the one thing that means "stop, this is broken". Work through §7.1 first — if
the protocol surface is wrong, no client result means anything.

Every step assumes a built tree:

```bash
cd /abs/path/to/x-mcp
npm run build
```

### 7.1 Confirm the protocol surface (no client needed) — 2 minutes

```bash
npm run build
node --test "build/test/mcp/**/*.test.js"
```

**Expected:** `# fail 0`. The pass count grows as tools are added (52 at the time of
writing) — the count is not the assertion, the zero is. A failure here is a server
regression: stop and fix it before touching any client.

Then confirm the tool count that the matrix quotes:

```bash
npx @modelcontextprotocol/inspector --cli \
  -e X_MCP_AUTH_MODE=app-only -e X_MCP_BEARER_TOKEN=AAAA -e X_MCP_LOG_LEVEL=silent \
  node "$PWD/build/src/index.js" --method tools/list 2>/dev/null | node -e '
let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const t=JSON.parse(s).tools;
console.log("tools",t.length,
"| outputSchema",t.filter(x=>x.outputSchema).length,
"| annotations",t.filter(x=>x.annotations).length);});'
```

**Expected output, exactly:** `tools 39 | outputSchema 39 | annotations 39`.

The `2>/dev/null` is required — npm deprecation warnings otherwise mix into the JSON.

### 7.2 Promote each GUI client from `unverified` — 10 minutes each

Run this identically for **Claude Desktop, Claude Code, VS Code, Cursor, Zed,
Continue.dev, Inspector GUI**. Do not skip step 2; a client that starts the server but
silently drops `env` will still list tools, and the failure only shows up as a confusing
auth error much later.

1. **Configure** using the matching snippet from §4. Use `X_MCP_POLICY=read-only` and
   `X_MCP_CREDIT_BUDGET=1.00`, `X_MCP_BUDGET_MODE=hard` — the cheapest possible blast
   radius. Restart the client fully; most read MCP config only at startup.
2. **Prove `env` arrived.** Ask the model to call `x_auth_status`. Expected: a result whose
   `structuredContent` reports the configured auth mode (`app-only` or `oauth2`) and the
   active policy preset `read-only`. If it reports a *different* mode, or the server failed
   to start with `X_MCP_AUTH_MODE must be set`, the client is not passing `env` — record
   **env passing: no** and stop for that client.
3. **Prove `tools/list`.** Open the client's tool/MCP panel and count the tools it shows.
   Expected: **39** (with `X_MCP_HIDE_DENIED` unset). Fewer means the client paginates,
   caps, or filters the list — record the number in the Notes column; it is a real
   compatibility limit worth documenting.
4. **Prove `tools/call`.** Ask for `x_rate_limit_status`. Expected: a successful result. No
   network call is required for this tool, so it works even without live credentials.
5. **Prove `structuredContent`.** In the client's raw/log view for that same call, confirm
   the response object has **both** a `content` text block and a `structuredContent` field
   carrying the same JSON. Record **yes** only if you saw `structuredContent` — many
   clients render only the text block, which is not evidence either way about whether they
   parsed the structured field.
6. **Prove policy refusal.** Ask for `x_post_create` with any text. Expected: an **error
   result** (`isError: true`) whose text explains that the tool is denied by the
   `read-only` preset. Expected: **no post is created**. If a post appears, stop
   everything — that is a policy-enforcement bug, not a compatibility finding.
7. **Prove `instructions`.** Ask the model, in a fresh session, "what policy preset is this
   X server running and what does it let you do?" A client that surfaced the instructions
   answers from them without calling a tool. If it must call `x_auth_status` to answer,
   record **Instructions: no**.
8. **Prove cancellation** (optional, needs live credentials). Start a long call —
   `x_search_recent` with a broad query and a large `max_results` — and press the client's
   stop/interrupt control. Expected: the call rejects promptly (well under a second in the
   in-repo probe, versus a 60 s upstream delay) and **the session remains usable** — the
   next `tools/list` still returns 39. A client that has no stop control is **exp**, not
   **no**.
9. **Record the result** by editing the matrix row: change `unverified` to
   `protocol-verified` only if you add a test, otherwise `probe-verified`, and put the
   client version and OS in Notes. A row that says `probe-verified` without a version is
   not much better than `unverified`.

### 7.3 Confirm the Node floor — 1 minute

With any Node older than 22 available (nvm, Docker, whatever):

```bash
node18 /abs/path/to/x-mcp/bin/x-mcp-ai.cjs ; echo "exit=$?"
```

**Expected:** exactly one line on stderr matching
`x-mcp-ai: fatal: Node 18.x.x is not supported - Node >= 22 is required`, nothing on
stdout, and `exit=1`. CI already asserts this on Node 12
([`.github/workflows/ci.yml:95`](../.github/workflows/ci.yml)); this step exists so you can
recognise the message when a client's bundled Node is old.

### 7.4 Caveat for anyone scripting a raw stdio check

Do **not** verify by piping frames into the server and closing stdin immediately:

```bash
# DO NOT do this — the response is truncated
printf '%s\n' "$INIT" "$INITIALIZED" "$LIST" | node build/src/index.js
```

Closing stdin fires the EOF shutdown path while the ~74 KB `tools/list` response is still
buffered, and the process exits before the pipe drains. Measured across three consecutive
runs: **66,589 of 75,496 bytes** arrived, every time, with the second frame cut mid-JSON.
Real clients keep stdin open for the life of the session, so this never affects them — but
a batch smoke test written this way reports corrupt JSON and sends you hunting for a
serialisation bug that does not exist. Read the response frame **first**, then close stdin
or send `SIGTERM`. The Inspector CLI recipe in §7.1 does the right thing already.
