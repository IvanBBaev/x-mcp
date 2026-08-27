# x-mcp-ai — X (Twitter) MCP Server

<div align="center">

| | | | | | |
|:--:|:--:|:--:|:--:|:--:|:--:|
| [![npm](https://img.shields.io/npm/v/x-mcp-ai?style=flat-square)](https://www.npmjs.com/package/x-mcp-ai) | [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/x-mcp/ci.yml?branch=main&style=flat-square)](https://github.com/IvanBBaev/x-mcp/actions/workflows/ci.yml) | [![tools](https://img.shields.io/badge/tools-41-blue?style=flat-square)](#tools) | [![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square)](https://nodejs.org) | [![MCP](https://img.shields.io/badge/MCP-server-orange?style=flat-square)](https://modelcontextprotocol.io) | [![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE) |

</div>

An [MCP](https://modelcontextprotocol.io) server that exposes the **X (Twitter) API v2** to
MCP clients — Claude Code, Claude Desktop, VS Code, Cursor, or any MCP-compatible agent — as
a curated set of **typed tools**, gated by a two-axis policy model and aware of the 2026
pay-per-use pricing so an agent can never quietly overspend.

> **Status: pre-1.0, under active development, published on npm as
> [`x-mcp-ai`](https://www.npmjs.com/package/x-mcp-ai)** (currently `0.8.0`, published from
> CI with npm provenance). Pin an exact version while the project is on `0.x`
> ([Setup](#setup)). **41 tools across 12 packages** are registered today; the full designed
> surface lives in [`docs/03-tool-catalog.md`](docs/03-tool-catalog.md) and is landing
> package by package. The public API is unstable until `1.0.0`.

Contents: [Quick demo](#quick-demo) · [Features](#features) · [Requirements](#requirements) ·
[Setup](#setup) · [Configure credentials](#configure-credentials) · [Cost](#cost) ·
[Run / debug](#run--debug) · [Develop](#develop) · [Tools](#tools) ·
[Resources](#resources) · [Prompts](#prompts) · [Project structure](#project-structure) ·
[Security notes](#security-notes) · [Data handling](#data-handling) ·
[Documentation](#documentation) · [Support](#support) · [Trademark](#trademark)

## Quick demo

Once the server is wired into your MCP client, you drive it in natural language and the
model picks the tool. Three representative asks:

```jsonc
// 1. Read (default read-only preset — no writes possible)
// "What are people saying about the Model Context Protocol this week?"
{
  "tool": "x_search_recent",
  "arguments": { "query": "\"model context protocol\" -is:retweet lang:en", "max_results": 25 }
}
```

```jsonc
// 2. Engage (requires the `engage` preset or an explicit write:engagement allow)
// "Like that launch post for me."
{
  "tool": "x_like_set",
  "arguments": { "post_id": "1899…", "action": "like" }
}
```

```jsonc
// 3. Publish (requires the `publish` preset or write:content)
// "Post: 'Shipping x-mcp-ai today.' — mind the cost."
// Every result carries cost_usd + session_total_usd; a URL in the text raises the price 13×.
{
  "tool": "x_post_create",
  "arguments": { "text": "Shipping x-mcp-ai today." }
}
```

## Features

- **41 tools across 12 packages** over the X API v2 — read posts, users and timelines,
  search (recent and full-archive), engage, publish, manage lists, upload media, walk the
  social graph, and read/send DMs behind an explicit opt-in.
- **Two-axis policy model** (`operation:domain`) with five presets — `read-only` (default),
  `engage`, `publish`, `manage`, `full`. Writes are opt-in; **deny beats allow beats
  preset**, per cell. Direct-message cells are double-locked: `read:dm`/`write:dm` are in
  **no** preset, not even `full`.
- **Cost awareness built in.** Since 2026-02-06 the X API v2 is pay-per-use. Every result
  reports its own `cost_usd` and the running `session_total_usd`; an operator-set
  `X_MCP_CREDIT_BUDGET` with `X_MCP_BUDGET_MODE=hard` refuses calls that would exceed it,
  and the model cannot raise the cap.
- **Two auth modes** — OAuth 2.0 PKCE user context (primary, rotating refresh tokens,
  single-flight refresh) and app-only bearer for read-only deployments.
- **Security-first defaults** — host-scoped `Authorization` header, redirects never followed
  on token-bearing requests, `0600` token file written with `O_NOFOLLOW`/`O_EXCL`,
  untrusted-content marking on returned text, and media upload default-deny outside a
  realpath-contained `X_MCP_MEDIA_DIR`.
- **Typed failures.** Eleven error classes, each carrying `retryable` and
  `fix: "agent" | "operator"`, so the model retries what is retryable and escalates what is
  not.
- **Structured output.** Every tool advertises a JSON-Schema `outputSchema` and returns
  `structuredContent` alongside the text block.
- **Availability class-gating**, live per-endpoint rate-limit tracking (including the
  24-hour app cap on post creation), cursor pagination, and compact result rendering.

## Requirements

- **Node.js >= 22** (see [`.nvmrc`](.nvmrc)).
- An **X developer account and app** with an OAuth 2.0 client (Client ID; Client Secret only
  for confidential clients). App-only mode needs a bearer token instead.
- **Prepaid X API credits** — the API bills per read and per write (see [Cost](#cost)).

## Setup

The recommended install is the published package, pinned to an exact version while the
project is on `0.x` — nothing to clone or build:

```bash
npx -y x-mcp-ai@0.8.0 doctor   # sanity check; makes no billable calls
```

Then point your MCP client at it:

```jsonc
// claude_desktop_config.json (Claude Desktop) / .mcp.json (Claude Code) / .cursor/mcp.json
{
  "mcpServers": {
    "x": {
      "command": "npx",
      "args": ["-y", "x-mcp-ai@0.8.0"],
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

Running from a local checkout instead? Use `"command": "node"` with
`"args": ["/abs/path/to/x-mcp/build/src/index.js"]` and the same `env` map.

Claude Code from the CLI:

```bash
claude mcp add x --env X_MCP_POLICY=read-only -- npx -y x-mcp-ai@0.8.0
```

**Per-client instructions** — Claude Desktop, Claude Code, VS Code (`.vscode/mcp.json`),
Cursor and MCP Inspector — are in
[`docs/10-operator-guide.md`](docs/10-operator-guide.md) §4, together with the `authorize`
flow and ready-made env recipes.

### From source (development)

Still fully supported — build the entry point and spawn it with `node` instead of `npx`:

```bash
git clone https://github.com/IvanBBaev/x-mcp.git
cd x-mcp
npm ci
npm run build          # tsc → build/src/index.js
node build/src/index.js doctor   # sanity check; makes no billable calls
```

## Configure credentials

The server never prompts interactively; all configuration comes from environment variables
(canonical table: [`docs/02-architecture.md`](docs/02-architecture.md) §4; a starting point:
[`.env.example`](.env.example)).

**Auth modes** (`X_MCP_AUTH_MODE`):

- `oauth2` *(default)* — OAuth 2.0 with PKCE. Run the one-time authorization flow with the
  `authorize` subcommand; tokens land in `X_MCP_TOKEN_FILE` and are refreshed automatically.
- `app-only` — application-only bearer token (`X_MCP_BEARER_TOKEN`); read endpoints only, no
  user context.

```bash
X_MCP_AUTH_MODE=oauth2 X_MCP_CLIENT_ID=… node build/src/index.js authorize
```

### Environment variables

| Variable | Default | Secret | Purpose |
|---|---|:--:|---|
| `X_MCP_AUTH_MODE` | `oauth2` | | `oauth2` \| `app-only`. |
| `X_MCP_CLIENT_ID` | | | OAuth 2.0 client ID (required for `authorize` and refresh). |
| `X_MCP_CLIENT_SECRET` | | ✅ | OAuth 2.0 client secret (confidential clients only). |
| `X_MCP_BEARER_TOKEN` | | ✅ | App-only bearer token; valid only with `app-only`. |
| `X_MCP_TOKEN_FILE` | OS-resolved | | Path to the rotating OAuth 2.0 token store (`~` expanded). |
| `X_MCP_TOKEN_KEYCHAIN` | `0` | | `1` → store tokens in the OS keychain (macOS `security`, Linux `secret-tool`). Mutually exclusive with `X_MCP_TOKEN_FILE`. |
| `X_MCP_POLICY` | `read-only` | | Preset: `read-only` \| `engage` \| `publish` \| `manage` \| `full`. |
| `X_MCP_POLICY_ALLOW` | | | Comma-separated `operation:domain` cells to add. |
| `X_MCP_POLICY_DENY` | | | Comma-separated cells to remove (wins over allow and preset). |
| `X_MCP_HIDE_DENIED` | `0` | | `1` → drop denied tools from registration entirely. |
| `X_MCP_CREDIT_BUDGET` | | | Session spend cap, USD (e.g. `5.00`). Unset = no cap. |
| `X_MCP_BUDGET_MODE` | `warn` | | `warn` \| `hard`. |
| `X_MCP_AVAILABILITY` | | | Comma-separated availability classes to enable (`pilot`, `premium-user`, `enterprise`). |
| `X_MCP_MEDIA_DIR` | | | Directory uploads must `realpath` inside (media default-deny). |
| `X_MCP_PROFILES_FILE` | | | Multi-account profiles file. |
| `X_MCP_PROFILE` | | | Active profile name (required with a profiles file). |
| `X_MCP_BASE_URL` | `https://api.x.com` | | API base URL; must be `https://` and `*.x.com`. |
| `X_MCP_ALLOW_INSECURE_BASE_URL` | `0` | | `1` → permit a non-`x.com` base URL (testing only). |
| `X_MCP_TIMEOUT_MS` | `30000` | | Per-request timeout, milliseconds. |
| `X_MCP_LOG_LEVEL` | `info` | | `silent` \| `error` \| `info` \| `debug`. |

Any other `X_MCP_*` variable is ignored with a startup warning — that is the typo detector.
Every fatal configuration error names the variable at fault.

### Two-axis access policy

Every tool maps to one **policy cell** — an `operation:domain` pair. Operations escalate
`read` → `write` → `destructive`; domains are `content`, `user`, `account`, `engagement`,
`social-graph`, `moderation`, `dm`. A preset unlocks a set of the 12 valid cells;
`X_MCP_POLICY_ALLOW` adds cells, `X_MCP_POLICY_DENY` removes them, and
**deny > allow > preset**.

| Preset | Grants | Callable tools |
|---|---|--:|
| `read-only` *(default)* | all `read:*` cells **except** `read:dm` | 21 |
| `engage` | read-only **+** `write:engagement` | 26 |
| `publish` | engage **+** `write:content`, `write:moderation` | 32 |
| `manage` | publish **+** `destructive:content` | 34 |
| `full` | every non-DM cell — adds `write:social-graph`, `destructive:social-graph` | 37 |

> **DM cells are never in a preset — not even `full`.** `read:dm` and `write:dm` must be
> granted explicitly via `X_MCP_POLICY_ALLOW` (all 41 tools callable). Their unlock hint is
> deliberately withheld from policy errors, as it is for every other sensitive cell.
> Denied tools stay registered but annotated `(disabled by policy <preset>)` unless
> `X_MCP_HIDE_DENIED=1`.

Note that `manage` grants destructive **content** operations only — follow/mute/block need
`full` or an explicit `write:social-graph` / `destructive:social-graph` allow.

## Cost

> **Pay-per-use is the only pricing model.** X retired the Free/Basic/Pro subscription tiers
> for new developers on **2026-02-06**; every read and write draws down prepaid credits.
> Since **2026-04-16**, a post whose text contains a **URL costs $0.20 instead of $0.015 —
> 13×**. Set `X_MCP_CREDIT_BUDGET` before pointing an agent at a real account.

Indicative rates (verified 2026-07-22): post reads ~$0.005 each, user lookups and
follower/following reads ~$0.010, own-data reads ~$0.001, DM events ~$0.010, post create
$0.015 (or $0.20 with a URL), DM send $0.015, list create $0.010, engagement writes
currently $0. X also caps post reads at **2,000,000 per month**. The authoritative table is
[`docs/01-api-landscape.md`](docs/01-api-landscape.md) §3; the operator's view is
[`docs/10-operator-guide.md`](docs/10-operator-guide.md) §5.

The budget is per process, advisory, resets on restart, and is **model-immutable** — there
is no per-call override and no tool that raises it.

## Run / debug

MCP clients spawn the server for you. To run it by hand:

```bash
X_MCP_POLICY=read-only node build/src/index.js serve
```

### Command-line interface

| Command | What it does |
|---|---|
| `serve` *(default)* | Start the MCP server over stdio. Running with no subcommand also serves. |
| `authorize [--manual] [--port <port>]` | Run the one-time OAuth 2.0 PKCE authorization flow and persist the token file. |
| `doctor [--connect]` | Print resolved config, path/permission checks and the policy matrix; no billable calls. `--connect` adds one unauthenticated reachability GET. |

stdout carries JSON-RPC only; diagnostics, warnings and the single
`x-mcp-ai: fatal: <reason>` startup line go to stderr. Symptom-driven fixes are in
[`docs/11-troubleshooting.md`](docs/11-troubleshooting.md).

## Develop

```bash
git clone https://github.com/IvanBBaev/x-mcp.git
cd x-mcp
npm ci
npm run build         # tsc → build/
npm run check         # typecheck + lint + format:check + test
```

Other scripts: `npm run typecheck`, `npm run lint`, `npm run format` / `format:check`,
`npm test`, `npm run coverage` (c8), and `npm run verify` (clean build + coverage + lint +
format check). See [`CONTRIBUTING.md`](CONTRIBUTING.md) for conventions and the full quality
gate.

## Tools

The 41 tools registered today. "Read-only" marks tools in a `read:*` policy cell — those
callable under the default preset (DM reads excepted: they need an explicit allow).
"User" marks `user-only` tools, which require OAuth 2.0 user context and are unreachable
with an app-only bearer token. The designed surface, including tools not yet implemented,
is [`docs/03-tool-catalog.md`](docs/03-tool-catalog.md); the full per-tool reference —
schemas, scopes, cost class, availability — is
[`docs/reference/tools.md`](docs/reference/tools.md).

> The table below is **generated** from the tool registry by `npm run docs:gen`. Do not edit
> it by hand: `npm run check` regenerates and diffs it, so an edit fails CI rather than
> shipping. Same for `docs/reference/tools.md`.

<!-- GENERATED:TOOLS:BEGIN -->

| Package | Tool | Cell | Read-only | User | Description |
|---|---|---|:--:|:--:|---|
| auth | `x_auth_status` | read:account | ✅ |  | Report the active auth mode, the authenticated user (in user mode), granted OAuth scopes, the credential backend, detected availability, and the resolved policy matrix. |
| auth | `x_rate_limit_status` | read:account | ✅ |  | Dump the in-process rate-limit table — per bucket (endpoint-class × auth-context), each tracked window's limit, remaining, reset time, and whether it is currently exhausted. |
| posts | `x_post_get` | read:content | ✅ |  | Batch-fetch one or more X (Twitter) posts by numeric id or status URL (1-100 per call). |
| posts | `x_post_create` | write:content |  | ✅ | Create a post — text, optional reply_to_id, quote_id, media_ids[], poll {options[], duration_minutes}, reply_settings. |
| posts | `x_post_delete` | destructive:content |  | ✅ | Delete own post by id. |
| posts | `x_post_hide_reply` | write:moderation |  | ✅ | Hide or unhide a reply to one of your own posts. |
| users | `x_user_get` | read:user | ✅ |  | Batch fetch of X (Twitter) user profiles by numeric id, @handle, bare handle, or the sentinel `me` (the authenticated user). |
| search | `x_search_recent` | read:content | ✅ |  | Search X (Twitter) posts from the last 7 days using the full v2 query syntax (from:, to:, conversation_id:, boolean operators). |
| search | `x_post_counts_recent` | read:content | ✅ |  | Return a volume histogram (post counts per time bucket) for an X (Twitter) v2 query over the last 7 days, at minute/hour/day granularity. |
| engagement | `x_like_set` | write:engagement |  | ✅ | Like or unlike a post as the authenticated user. |
| engagement | `x_repost_set` | write:engagement |  | ✅ | Repost (retweet) a post as the authenticated user, or undo that repost. |
| engagement | `x_bookmark_set` | write:engagement |  | ✅ | Add a post to the authenticated user's bookmarks or remove it. |
| engagement | `x_bookmarks_list` | read:content | ✅ | ✅ | The authenticated user's own bookmarks, newest first — the read half of `x_bookmark_set`. |
| timelines | `x_timeline_home` | read:content | ✅ | ✅ | Read the authenticated X (Twitter) user's home timeline in reverse-chronological order (the accounts they follow, newest first). |
| timelines | `x_timeline_mentions` | read:content | ✅ |  | Read posts mentioning an X (Twitter) user (defaults to the authenticated user). |
| timelines | `x_timeline_user` | read:content | ✅ |  | Read an X (Twitter) user's own posts, newest first, optionally excluding replies and/or reposts, within optional time bounds. |
| graph | `x_follow_set` | write:social-graph |  | ✅ | Follow or unfollow a user as the authenticated user. |
| graph | `x_mute_set` | write:social-graph |  | ✅ | Mute or unmute a user as the authenticated user. |
| graph | `x_block_set` | destructive:social-graph |  | ✅ | Block or unblock a user as the authenticated user. |
| graph | `x_followers_list` | read:social-graph | ✅ |  | List the accounts following an X (Twitter) user. |
| graph | `x_following_list` | read:social-graph | ✅ |  | List the accounts an X (Twitter) user follows. |
| graph | `x_user_search` | read:user | ✅ |  | Keyword search over X (Twitter) user profiles (names, handles, bios). |
| lists | `x_list_create` | write:content |  | ✅ | Create a list owned by the authenticated user. |
| lists | `x_list_update` | write:content |  | ✅ | Update the authenticated user's own list metadata — `name`, `description`, and/or `private`. |
| lists | `x_list_delete` | destructive:content |  | ✅ | Permanently delete the authenticated user's own list. |
| lists | `x_list_get` | read:content | ✅ |  | Read one list's metadata — name, description, privacy, member and follower counts, and owner handle. |
| lists | `x_lists_owned` | read:content | ✅ |  | The lists a user owns (defaults to the authenticated user). |
| lists | `x_list_member_set` | write:content |  | ✅ | Add a user to the authenticated user's own list or remove one — a single user per call. |
| lists | `x_list_members` | read:content | ✅ |  | The members of a list. |
| lists | `x_list_timeline` | read:content | ✅ |  | Posts from a list's timeline (recent posts by its members). |
| lists | `x_list_follow_set` | write:engagement |  | ✅ | Follow a list as the authenticated user, or unfollow it. |
| lists | `x_list_pin_set` | write:engagement |  | ✅ | Pin a list in the authenticated user's list view, or unpin it. |
| media | `x_media_upload` | write:content |  | ✅ | Upload a local image, GIF, or video via the chunked v2 flow and return a `media_id` to attach with `x_post_create`. |
| media | `x_media_status` | read:content | ✅ | ✅ | Check the async processing state of an uploaded media by `media_id`. |
| dm | `x_dm_events_list` | read:dm | ✅ | ✅ | List all recent direct-message events across the authenticated X (Twitter) user's conversations, newest first. |
| dm | `x_dm_conversation_events_list` | read:dm | ✅ | ✅ | List the direct-message events of one X (Twitter) DM conversation, newest first. |
| dm | `x_dm_participant_events_list` | read:dm | ✅ | ✅ | List the direct-message events of the 1:1 X (Twitter) DM conversation with one participant, newest first. |
| dm | `x_dm_send` | write:dm |  | ✅ | Send an X (Twitter) direct message to exactly one target: an existing conversation (conversation_id) or a user (participant), creating the 1:1 conversation if needed. |
| archive | `x_search_archive` | read:content | ✅ |  | Search the complete X (Twitter) archive back to 2006 using the full v2 query syntax (from:, to:, conversation_id:, boolean operators). |
| archive | `x_post_counts_archive` | read:content | ✅ |  | Return a volume histogram (post counts per time bucket) for an X (Twitter) v2 query over the complete archive back to 2006, at minute/hour/day granularity. |
| usage | `x_usage_get` | read:account | ✅ |  | Report the post-read consumption of the current billing cycle against the monthly project cap (with an optional per-day and per-app breakdown), alongside the local credit-spend estimate for this session. |

<!-- GENERATED:TOOLS:END -->

DM reads return ids, timestamps and participants only; message bodies require an explicit
`include_text: true` on the call.

### Tool packages

| Package | Covers |
|---|---|
| `auth` | Auth context and rate-limit windows. |
| `usage` | Platform read-cap consumption and the local session-spend estimate. |
| `posts` | Create, read and delete posts. |
| `search` | Recent post search and volume counts. |
| `archive` | Full-archive search and counts. |
| `timelines` | Home, mentions and user timelines. |
| `engagement` | Likes, reposts and bookmarks. |
| `users` | User lookup. |
| `graph` | Profile search, follow/mute/block, follower and following lists. |
| `lists` | Full list lifecycle, membership, timeline, follow and pin. |
| `media` | Chunked media upload and status. |
| `dm` | Direct-message reads and sends (double-locked). |

## Resources

MCP resources are **planned** — a read-only exposure of the resolved auth context and live
rate-limit table as addressable resources. Not shipped.

## Prompts

MCP prompts are **planned** — guided templates for common workflows (e.g. cost-aware
posting, audience research). Not shipped.

## Project structure

Ports & adapters; the module layout is fixed in
[`docs/02-architecture.md`](docs/02-architecture.md) §3:

```
src/
├── index.ts            # composition root + stdio wiring
├── core/               # config, policy, budget, errors, ports, tooldef,
│                       #   registry, render, resolve, paginate, sanitize
├── api/                # http, ratelimit, errors, oauth2/, endpoints/
├── tools/              # one module per package (posts, search, graph, …)
├── mcp/                # compose, server, schema, structured, gates, session
└── cli/                # dispatch, authorize, doctor
```

Dependency rule: `tools → core + api/endpoints`, `api → core`, `mcp → tools + core`,
`cli → core + api`. Nothing in `core` reaches outward or does I/O.

## Security notes

A summary; the full threat model and operator checklist live in
[`SECURITY.md`](SECURITY.md) and [`docs/04-security.md`](docs/04-security.md).

- **Host-scoped auth.** The `Authorization` header is attached only for the configured API
  origin; redirects are never followed on token-bearing requests (confused-deputy defense).
  Proxy environment variables are ignored.
- **Token file hardening.** Written `0600` with `O_NOFOLLOW`/`O_EXCL`; refresh is
  single-flight with reload-under-lock and fails closed rather than racing.
- **Untrusted content.** Post/user/DM text returned to the model is marked as untrusted.
  Marking is not a semantic filter — the **policy model is the real control** against
  prompt injection.
- **No escalation recipes.** A denial on a sensitive cell (`*:dm`, `destructive:*`,
  `*:social-graph`) names the blocked cell but never the variable that would unlock it, so
  the model cannot relay an escalation recipe to you.
- **Media default-deny.** Uploads are refused unless the file `realpath`s inside
  `X_MCP_MEDIA_DIR`.
- **Cost is model-immutable.** The session credit budget is operator-set; the model cannot
  raise or disable it.
- **Supply chain: pin the exact version.** An unpinned `npx -y x-mcp-ai` executes the
  newest publish on every client cold-start — in a process holding your tokens. Releases
  are published from CI with npm provenance. The npm package name is `x-mcp-ai`; `x-mcp`
  is only the repository name.

## Data handling

Full statement: [`docs/12-privacy.md`](docs/12-privacy.md).

- **Nothing phones home.** No telemetry, no analytics, no update check. The project runs no
  server; the only outbound destination is the X API at your configured base URL.
- **Credentials stay local.** Client id/secret and bearer tokens live in the process
  environment; OAuth tokens live in a `0600` file on your machine. No tool ever returns a
  credential, and `doctor` masks them.
- **Cost telemetry is local-only.** The spend counter is in memory, per process, reported to
  the calling model and nowhere else.
- **Content you read leaves X for your model.** Posts, profiles and DM events fetched by a
  tool are returned to your MCP client and therefore reach its model provider. Nothing is
  cached or persisted by this server.

## Documentation

| Page | For |
|---|---|
| [10 — Operator guide](docs/10-operator-guide.md) | Install, authorize, per-client config, env recipes, cost control. |
| [11 — Troubleshooting](docs/11-troubleshooting.md) | Startup errors, `doctor`, auth/refresh, rate limits, missing tools. |
| [12 — Privacy & data handling](docs/12-privacy.md) | What is sent where, what is stored, how to delete it. |
| [01 — API landscape](docs/01-api-landscape.md) | Pay-per-use pricing, availability classes, platform caps. |
| [02 — Architecture](docs/02-architecture.md) | Module layout and the canonical env-var table. |
| [03 — Tool catalog](docs/03-tool-catalog.md) | The designed tool surface and its classifications. |
| [04 — Security](docs/04-security.md) | Threat model, policy model, token lifecycle. |

## Support

If this project saves you time, support is welcome:

[![Sponsor](https://img.shields.io/badge/GitHub-Sponsors-ea4aaa?style=flat-square&logo=githubsponsors)](https://github.com/sponsors/IvanBBaev)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-ff5e5b?style=flat-square&logo=kofi)](https://ko-fi.com/ivanbbaev)
[![Donatree](https://img.shields.io/badge/Donatree-Donate-22c55e?style=flat-square)](https://donatr.ee/ivanbbaev/)

## Trademark

x-mcp-ai is an independent, unofficial project. It is **not affiliated with, endorsed by, or
sponsored by X Corp**. It talks to the official, publicly documented X API v2 and does not
use any private, undocumented or scraping-based access.

"X", "Twitter", and related names, logos and marks are trademarks of X Corp. They are used
here **nominatively**, only to describe what this software interoperates with. This project
is released under the [MIT License](LICENSE); trademark rights are not licensed.
