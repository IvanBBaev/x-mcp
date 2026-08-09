# 10 — Operator guide

How to install, authorize, wire into an MCP client, and budget the server. Everything on
this page describes the code as it stands; the canonical env-var table is
[02-architecture.md](02-architecture.md) §4 and the canonical price table is
[01-api-landscape.md](01-api-landscape.md) §3.

Companion pages: [11-troubleshooting.md](11-troubleshooting.md) (when something fails),
[12-privacy.md](12-privacy.md) (what data goes where).

## 1. Before you start

| You need | Notes |
|---|---|
| **Node.js >= 22** | The launcher refuses Node < 20 with a legible message; `engines` requires >= 22. |
| **An X developer app** | Get the **OAuth 2.0 Client ID** from the app's "User authentication settings". A client secret exists only for confidential clients — PKCE public clients omit it. |
| **A redirect URL on the app** | Add `http://127.0.0.1:8371/callback` (and any other port you plan to pass to `authorize --port`) to the app's callback URLs. |
| **Prepaid X API credits** | The API bills per read and per write — see [§5](#5-cost-and-the-session-budget). |
| **App-only alternative** | For read-only deployments you can skip OAuth entirely and use an app-only **bearer token** (`X_MCP_AUTH_MODE=app-only`). It cannot reach user-context tools. |

Scopes are requested by `authorize`; you do not configure them. The set includes
`offline.access`, without which X issues no refresh token and the server cannot keep
itself authenticated.

## 2. Install

> **Not published to npm yet.** The name `x-mcp-ai` is reserved pending the 1.0.0 release,
> so `npx -y x-mcp-ai` does **not** work today. Install from the repository. Once the
> package is published, the client snippets below become
> `"command": "npx", "args": ["-y", "x-mcp-ai@<version>"]` with nothing else changed.

```bash
git clone https://github.com/IvanBBaev/x-mcp.git
cd x-mcp
npm ci
npm run build          # tsc → build/src/index.js
```

Three equivalent ways to invoke the built server — pick one and use it consistently in
your client config:

| Invocation | When to use |
|---|---|
| `node /abs/path/to/x-mcp/build/src/index.js` | Recommended. Fewest moving parts, no npm resolution at spawn time. |
| `node /abs/path/to/x-mcp/bin/x-mcp-ai.cjs` | Same thing through the packaged launcher (adds the Node-version guard). |
| `npx /abs/path/to/x-mcp` | Resolves the `bin` entry from the local checkout; slower to start. |

On Windows use the native path form and escape backslashes in JSON
(`"C:\\path\\to\\x-mcp\\build\\src\\index.js"`).

Quick smoke test, no API calls and no billing:

```bash
node build/src/index.js doctor
```

## 3. Authorize once (OAuth 2.0 user context)

Needed for every write, DMs, media upload, and the home timeline. Skip it if you are
running app-only.

```bash
X_MCP_AUTH_MODE=oauth2 \
X_MCP_CLIENT_ID=your-oauth2-client-id \
node build/src/index.js authorize
```

`usage: x-mcp-ai authorize [--manual] [--port <port>]`

- Opens `https://x.com/i/oauth2/authorize` in your browser, listens once on
  `127.0.0.1:<port>/callback` (nominal port `8371`), verifies the CSRF `state`, exchanges
  the code with PKCE (S256), and writes the token file.
- `--manual` — no local listener: print the URL, then paste the **full redirect URL** back.
  A bare authorization code is rejected, because the `state` must be verifiable.
- The callback wait times out after 5 minutes; nothing is written on timeout.
- Refresh tokens rotate. The server refreshes on its own from then on; you only re-run
  `authorize` if the refresh chain breaks (see
  [11-troubleshooting.md](11-troubleshooting.md) §4).

**Where the token file lives** (`X_MCP_TOKEN_FILE` overrides it; a leading `~/` is
expanded):

| Platform | Default path |
|---|---|
| Windows | `%APPDATA%\x-mcp\tokens.json` |
| Everything else | `$XDG_CONFIG_HOME/x-mcp/tokens.json`, else `~/.config/x-mcp/tokens.json` |

The file is created `0600` (owner read/write only) with `O_NOFOLLOW`/`O_EXCL`. Keep it
out of cloud-synced folders — `doctor` warns if it is inside one.

Authorize with the **same env** you will serve with. If the client config points at a
different `X_MCP_TOKEN_FILE`, the server will not find the tokens you just minted.

## 4. Per-client setup

All four clients are **documented to** spawn the server as a stdio subprocess and pass
`env` verbatim — that is derived from each client's own documentation, not from an
observed run, so treat it as the expectation rather than a guarantee. Proving that `env`
actually arrived is the first step of the per-client walkthrough in
[13-compatibility.md](13-compatibility.md) §7.2, and takes about ten seconds. Values must
be strings. Nothing is read from a `.env` file automatically — if you prefer one, run Node
with `--env-file=.env` yourself.

Client config formats do change; if a snippet is rejected, check that client's current
documentation — the `command`/`args`/`env` triple is what matters.

### 4.1 Claude Desktop

`claude_desktop_config.json` —
macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`,
Windows: `%APPDATA%\Claude\claude_desktop_config.json`.

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

Restart Claude Desktop after editing. The server writes nothing to stdout except JSON-RPC;
diagnostics go to stderr and land in the client's MCP log.

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

Everything after `--` is the command line to spawn. Use `--scope project` to write a
committed `.mcp.json` instead of your user config — in that case keep secrets out of it and
inject them from the environment.

Project-scoped `.mcp.json` has the same shape as the Claude Desktop file:

```json
{
  "mcpServers": {
    "x": {
      "command": "node",
      "args": ["/abs/path/to/x-mcp/build/src/index.js"],
      "env": { "X_MCP_POLICY": "read-only" }
    }
  }
}
```

Verify with `/mcp` in the session, or `claude mcp list`.

### 4.3 VS Code

`.vscode/mcp.json` (workspace) or the user-level `mcp.json`. VS Code uses a `servers` map
and an explicit transport `type`, and can prompt for secrets via `inputs`:

```json
{
  "inputs": [
    {
      "id": "x-client-id",
      "type": "promptString",
      "description": "X OAuth 2.0 client ID",
      "password": true
    }
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

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project) — the Claude Desktop shape:

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

### 4.5 Any other MCP client / MCP Inspector

The server is a plain stdio MCP server with no custom handshake:

```bash
npx @modelcontextprotocol/inspector node /abs/path/to/x-mcp/build/src/index.js
```

## 5. Cost and the session budget

> **Pay-per-use is the only pricing model.** X retired the Free/Basic/Pro subscription
> tiers for new developers on **2026-02-06**. Every read and every write draws down prepaid
> credits — there is no free allowance to fall back on. An unattended agent left on a broad
> preset can spend real money quickly. Set a budget.

Indicative per-call prices (rates verified 2026-07-22; the authoritative table is
[01-api-landscape.md](01-api-landscape.md) §3):

| Cost class | Price | Typical tools |
|---|---|---|
| `local` | $0 | `x_rate_limit_status`, `x_media_status` |
| `owned` | $0.001 | `x_auth_status`, `x_lists_owned`, `x_timeline_mentions` |
| `r:post` | ~$0.005 / post | post lookup, search, timelines, counts |
| `r:list` | ~$0.005 | list metadata |
| `r:user` | ~$0.010 / user | user lookup, user search, list members |
| `r:follows` | ~$0.010 | followers / following |
| `r:dm` | ~$0.010 / event | DM event lookups |
| `w:post` | **$0.015 — $0.20** | `x_post_create` |
| `w:dm` | $0.015 | `x_dm_send` |
| `w:list` | $0.010 | `x_list_create` |
| `w:action` | $0 (carried locally) | likes, reposts, bookmarks, follows, deletes — not separately priced on X's pricing page as of 2026-07-22 |

**The URL multiplier.** Since **2026-04-16** a post whose text contains a URL costs
**$0.20** instead of $0.015 — **13×**. `x_post_create` resolves this dynamically and warns
distinctly when the text carries a URL. A loop that posts links is the most expensive thing
this server can do.

**The platform read cap.** X caps post reads at **2,000,000 per month**, independent of
credit balance.

**The guardrail** is the session credit budget:

| Variable | Effect |
|---|---|
| `X_MCP_CREDIT_BUDGET` | Session spend cap in USD (e.g. `5.00`). Unset = no cap. |
| `X_MCP_BUDGET_MODE=warn` *(default)* | Calls proceed; a warning is attached once spend crosses **90%** and again over the cap. |
| `X_MCP_BUDGET_MODE=hard` | A call whose cost would exceed the cap is refused **before** it runs, with a typed `budget` error. |

Properties worth knowing before you rely on it:

- **Per-process and advisory.** The counter lives in memory, starts at 0 on every server
  start, and never seeds itself from an X usage API. Restarting the client resets it.
- **Model-immutable.** There is no per-call budget override and no tool that raises the
  cap. A refusal says so: *"This is an operator-set limit; cannot be changed from within
  this session."*
- **Surfaced per call.** Every result carries `meta.cost_usd` and
  `meta.session_total_usd`.
- **An estimate.** It is the local price table applied to calls made, not a bill. Reconcile
  against your X developer portal.

## 6. Env recipes

The full variable table is in the [README](../README.md#environment-variables); docs/02 §4
is canonical. Five deployments worth copying:

### 6.1 Minimal, app-only, read-only

No OAuth dance, no token file, no writes possible. User-context tools stay listed but fail
at call time.

```json
{
  "X_MCP_AUTH_MODE": "app-only",
  "X_MCP_BEARER_TOKEN": "your-app-only-bearer-token",
  "X_MCP_POLICY": "read-only",
  "X_MCP_CREDIT_BUDGET": "2.00",
  "X_MCP_BUDGET_MODE": "hard"
}
```

`X_MCP_BEARER_TOKEN` is valid **only** with `app-only`, and `app-only` requires it —
either mismatch is a startup error.

### 6.2 OAuth 2.0 user context

Run `authorize` once with the same values, then:

```json
{
  "X_MCP_AUTH_MODE": "oauth2",
  "X_MCP_CLIENT_ID": "your-oauth2-client-id",
  "X_MCP_TOKEN_FILE": "~/.config/x-mcp/tokens.json",
  "X_MCP_POLICY": "read-only",
  "X_MCP_CREDIT_BUDGET": "5.00",
  "X_MCP_BUDGET_MODE": "hard"
}
```

`X_MCP_TOKEN_FILE` is optional — omit it to take the OS default from §3. Add
`X_MCP_CLIENT_SECRET` only for a confidential client. `X_MCP_CLIENT_ID` /
`X_MCP_CLIENT_SECRET` require `X_MCP_AUTH_MODE=oauth2`.

### 6.3 Preset escalation

Presets are the main safety dial. Each one is a superset of the one above it:

| `X_MCP_POLICY` | Adds | Callable tools (of 41) |
|---|---|--:|
| `read-only` *(default)* | reads except DM reads | 21 |
| `engage` | `write:engagement` — like / repost / bookmark / list follow & pin | 26 |
| `publish` | `write:content`, `write:moderation` — post create, media upload, list create/update/members, hide reply | 32 |
| `manage` | `destructive:content` — post delete, list delete | 34 |
| `full` | `write:social-graph`, `destructive:social-graph` — follow, mute, block | 37 |

Prefer a low preset plus a targeted allow over jumping a level:

```json
{ "X_MCP_POLICY": "read-only", "X_MCP_POLICY_ALLOW": "write:engagement" }
```

Deny beats allow beats preset, per cell. To run `full` minus blocking:

```json
{ "X_MCP_POLICY": "full", "X_MCP_POLICY_DENY": "destructive:social-graph" }
```

An unknown preset or cell name is a startup error listing the valid values — never
silently ignored.

**This section is where a blocked call points you.** A denied tool returns *"blocked cell
`<cell>`… see the operator guide"* and deliberately stops there — it names the cell but never
the variable that unlocks it. That is not to make your life harder: the server also tells the
model the full policy matrix via `x_auth_status`, so a denial that spelled out the variable
and its syntax would hand a prompt-injected agent a complete, ready-to-paste escalation line
for a cell you chose not to grant. Take the cell name from the error, look it up in the table
above, and set the variable yourself.

### 6.4 Direct messages — explicit allow required

`read:dm` and `write:dm` are in **no** preset, not even `full`. They exist only if you
name them:

```json
{
  "X_MCP_POLICY": "read-only",
  "X_MCP_POLICY_ALLOW": "read:dm"
}
```

Adds the three DM event-lookup tools. `"read:dm,write:dm"` also enables `x_dm_send`
(4 tools, total 41 callable when combined with `full`). DM tools are `user-only` — they
need OAuth 2.0 user context, not a bearer token. DM content is private third-party data;
read [12-privacy.md](12-privacy.md) before enabling this.

### 6.5 Budget and hygiene

```json
{
  "X_MCP_CREDIT_BUDGET": "1.00",
  "X_MCP_BUDGET_MODE": "hard",
  "X_MCP_HIDE_DENIED": "1",
  "X_MCP_LOG_LEVEL": "info",
  "X_MCP_TIMEOUT_MS": "30000"
}
```

`X_MCP_HIDE_DENIED=1` drops policy-denied tools from `tools/list` entirely — smaller
context, at the cost of the self-documenting "(disabled by policy …)" annotation.

**Media uploads** are default-deny: `x_media_upload` refuses every file unless
`X_MCP_MEDIA_DIR` is set and the file's `realpath` is inside it.

```json
{ "X_MCP_MEDIA_DIR": "~/Pictures/x-uploads" }
```

## 7. Command-line interface

| Command | What it does |
|---|---|
| `serve` *(default)* | Start the MCP server over stdio. No subcommand also serves. |
| `authorize [--manual] [--port <port>]` | One-time OAuth 2.0 PKCE flow; writes the token file. |
| `doctor [--connect]` | Print resolved config, path/permission checks and the policy matrix. `--connect` adds one unauthenticated `GET /2/openapi.json`. Exit 1 on any failing check. |

There is no `--help` or `--version` flag. Unknown leading tokens fall through to `serve`
and are rejected by the config contract.

## 8. Operating notes

- **stdout is JSON-RPC only.** All diagnostics, warnings and fatal reasons go to stderr.
  Never wrap the command in a shell script that echoes to stdout.
- **Startup is fail-closed.** A configuration problem prints one
  `x-mcp-ai: fatal: <reason>` line and exits non-zero rather than starting degraded.
- **Proxy variables are ignored.** `HTTP_PROXY`/`HTTPS_PROXY` have no effect; the client
  dials the API origin directly.
- **The base URL is pinned** to `https://api.x.com`. Any other host needs
  `X_MCP_ALLOW_INSECURE_BASE_URL=1` and is warned about loudly — testing only.
- **Tell the agent to call `x_auth_status` first** in any session that will write or needs
  user context. It reports auth mode, identity, granted scopes and the resolved policy
  matrix, and costs $0.001.
- **Rate limits are per endpoint per 15-minute window**, tracked separately for user and
  app context. An exhausted window is refused locally, without an HTTP request.
