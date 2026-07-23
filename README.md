# x-mcp-ai — X (Twitter) MCP Server

<div align="center">

| | | | | |
|:--:|:--:|:--:|:--:|:--:|
| [![npm version](https://img.shields.io/npm/v/x-mcp-ai?style=flat-square)](https://www.npmjs.com/package/x-mcp-ai) | [![npm downloads](https://img.shields.io/npm/dm/x-mcp-ai?style=flat-square)](https://www.npmjs.com/package/x-mcp-ai) | [![node](https://img.shields.io/node/v/x-mcp-ai?style=flat-square)](https://nodejs.org) | [![tools](https://img.shields.io/badge/tools-50-blue?style=flat-square)](#tools) | [![license](https://img.shields.io/npm/l/x-mcp-ai?style=flat-square)](LICENSE) |
| [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/x-mcp-ai/ci.yml?branch=main&style=flat-square)](https://github.com/IvanBBaev/x-mcp-ai/actions/workflows/ci.yml) | [![coverage](https://img.shields.io/codecov/c/github/IvanBBaev/x-mcp-ai?style=flat-square)](https://codecov.io/gh/IvanBBaev/x-mcp-ai) | [![last commit](https://img.shields.io/github/last-commit/IvanBBaev/x-mcp-ai?style=flat-square)](https://github.com/IvanBBaev/x-mcp-ai/commits/main) | [![MCP](https://img.shields.io/badge/MCP-server-orange?style=flat-square)](https://modelcontextprotocol.io) | [![Known Vulnerabilities](https://snyk.io/test/npm/x-mcp-ai/badge.svg)](https://snyk.io/test/npm/x-mcp-ai) |

**Documentation site:** <https://ivanbbaev.github.io/x-mcp-ai/>

</div>

An [MCP](https://modelcontextprotocol.io) server that exposes the **X (Twitter) API v2** to
MCP clients — Claude Code, Claude Desktop, or any MCP-compatible agent — as a curated set of
**50 typed tools in 12 packages**, gated by a two-axis policy model and aware of the 2026
pay-per-use pricing so an agent can never quietly overspend.

> **Status: pre-1.0, under active development.** The infrastructure layer (config, policy,
> budget, registry, HTTP, rate-limit, error, render, resolve and pagination modules) is in
> place; the user-facing tools described below are the **designed** surface from
> [`docs/03-tool-catalog.md`](docs/03-tool-catalog.md) and are landing package by package.
> The public API is unstable until `1.0.0` — pin an exact version.

Contents: [Quick demo](#quick-demo) · [Features](#features) · [Requirements](#requirements) ·
[Setup](#setup) · [Configure credentials](#configure-credentials) · [Run / debug](#run--debug) ·
[Develop](#develop) · [Tools](#tools) · [Resources](#resources) · [Prompts](#prompts) ·
[Project structure](#project-structure) · [Security notes](#security-notes) · [Support](#support) ·
[Trademark](#trademark)

## Quick demo

Once the server is wired into your MCP client, you drive it in natural language and the model
picks the tool. Three representative asks:

```jsonc
// 1. Read (default read-only preset — no writes possible)
// "What are people saying about the Model Context Protocol this week?"
{
  "tool": "x_search_recent",
  "arguments": { "query": "\"model context protocol\" -is:retweet lang:en", "max_results": 25 }
}
```

```jsonc
// 2. Engage (requires the `engage` preset or write:engagement)
// "Like and bookmark that launch post for me."
{
  "tool": "x_like_set",
  "arguments": { "post_id": "1899…", "action": "add" }
}
```

```jsonc
// 3. Publish (requires the `publish` preset or write:content)
// "Post: 'Shipping x-mcp-ai today.' — mind the cost."
// Every result carries cost_usd + session_total_usd; a URL in the text raises the price ~13×.
{
  "tool": "x_post_create",
  "arguments": { "text": "Shipping x-mcp-ai today." }
}
```

## Features

- **50 tools across 12 packages** over the X API v2 — read posts/users/timelines, search
  (recent and, where the account allows, full-archive), engage, publish, manage lists,
  moderate replies, send DMs, upload media, and inspect Spaces, trends, rate limits and usage.
- **Two-axis policy model** (`operation:domain`) with five presets — `read-only` (default),
  `engage`, `publish`, `manage`, `full`. Writes are opt-in; `deny` always beats `allow` beats
  preset. Direct-message cells are double-locked: `read:dm`/`write:dm` are in **no** preset,
  not even `full`, and must be granted explicitly.
- **Cost awareness built in.** Since 2026-02-06 the X API v2 is pay-per-use. Every tool result
  reports its own `cost_usd` and the running `session_total_usd`; an operator-set
  `X_MCP_CREDIT_BUDGET` (USD/session) with `X_MCP_BUDGET_MODE=hard` refuses calls that would
  exceed it, and the monthly 2,000,000-post-read platform cap is tracked.
- **Three auth modes** — OAuth 2.0 PKCE (primary, with rotating refresh tokens), OAuth 1.0a
  (legacy) and app-only bearer (read-only).
- **Security-first defaults** — host-scoped `Authorization` header, no redirect following on
  token-bearing requests, `0600` token file written with `O_NOFOLLOW`/`O_EXCL`, single-flight
  refresh, untrusted-content marking on returned text, and media upload default-deny outside a
  realpath-contained `X_MCP_MEDIA_DIR`.
- **Availability-aware registration** — tools gated by account class (`app+user`, `user-only`,
  `pilot`, `premium-user`, `enterprise`) only register when their class is enabled.
- **Multi-account profiles**, live per-endpoint rate-limit tracking, cursor pagination, and
  compact + structured result rendering.

## Requirements

- **Node.js >= 22** (see [`.nvmrc`](.nvmrc)).
- An **X developer account and app** with an OAuth 2.0 client (Client ID; Client Secret only
  for confidential clients). App-only mode needs a bearer token; OAuth 1.0a needs the consumer
  key/secret and access token/secret.
- **Prepaid X API credits** — the API bills per read and per write (see
  [`docs/01-api-landscape.md`](docs/01-api-landscape.md)).

## Setup

Run straight from npm with `npx` (no global install):

```jsonc
// .mcp.json (Claude Code) / claude_desktop_config.json (Claude Desktop)
{
  "mcpServers": {
    "x": {
      "command": "npx",
      "args": ["-y", "x-mcp-ai@0.1.0"],
      "env": {
        "X_MCP_AUTH_MODE": "oauth2",
        "X_MCP_CLIENT_ID": "your-oauth2-client-id",
        "X_MCP_TOKEN_FILE": "~/.config/x-mcp/tokens.json",
        "X_MCP_POLICY": "read-only",
        "X_MCP_CREDIT_BUDGET": "5.00",
        "X_MCP_BUDGET_MODE": "hard"
      }
    }
  }
}
```

> **Pin the version while on 0.x.** The public API is unstable before `1.0.0`, so pin an exact
> release (`x-mcp-ai@0.1.0`) rather than floating the latest, and install with
> `--ignore-scripts`.

**Claude Code plugin.** In Claude Code you can also add the server from the CLI:

```bash
claude mcp add x --env X_MCP_AUTH_MODE=oauth2 --env X_MCP_POLICY=read-only -- npx -y x-mcp-ai@0.1.0
```

### Verify your setup

Before serving, run the bundled `doctor` subcommand to check Node version, resolved config,
auth context and token-file permissions without making any billable API calls:

```bash
npx x-mcp-ai@0.1.0 doctor
```

## Configure credentials

The server never prompts interactively; all configuration comes from environment variables
(see [`docs/02-architecture.md`](docs/02-architecture.md) §4 for the canonical table and
[`.env.example`](.env.example) for a starting point).

**Auth modes** (`X_MCP_AUTH_MODE`):

- `oauth2` *(default)* — OAuth 2.0 with PKCE. Run the one-time authorization dance with the
  `authorize` subcommand; tokens are stored in `X_MCP_TOKEN_FILE` and refreshed automatically.
- `app-only` — application-only bearer token (`X_MCP_BEARER_TOKEN`); read endpoints only.
- `oauth1` — OAuth 1.0a user context (consumer + access key/secret). Legacy; kept for the
  few endpoints that still require it.

### Environment variables

| Variable | Default | Secret | Purpose |
|---|---|:--:|---|
| `X_MCP_AUTH_MODE` | `oauth2` | | `oauth2` \| `oauth1` \| `app-only`. |
| `X_MCP_CLIENT_ID` | | | OAuth 2.0 client ID. |
| `X_MCP_CLIENT_SECRET` | | ✅ | OAuth 2.0 client secret (confidential clients only). |
| `X_MCP_BEARER_TOKEN` | | ✅ | App-only bearer token. |
| `X_MCP_TOKEN_FILE` | OS-resolved | | Path to the rotating OAuth 2.0 token store. |
| `X_MCP_TOKEN_KEYCHAIN` | `0` | | `1` → store tokens in the OS keychain *(planned)*. |
| `X_MCP_API_KEY` | | ✅ | OAuth 1.0a consumer key. |
| `X_MCP_API_SECRET` | | ✅ | OAuth 1.0a consumer secret. |
| `X_MCP_ACCESS_TOKEN` | | ✅ | OAuth 1.0a access token. |
| `X_MCP_ACCESS_SECRET` | | ✅ | OAuth 1.0a access secret. |
| `X_MCP_POLICY` | `read-only` | | Preset: `read-only` \| `engage` \| `publish` \| `manage` \| `full`. |
| `X_MCP_POLICY_ALLOW` | | | Comma-separated `operation:domain` cells to add. |
| `X_MCP_POLICY_DENY` | | | Comma-separated cells to remove (wins over allow/preset). |
| `X_MCP_HIDE_DENIED` | `0` | | `1` → drop denied tools from registration entirely. |
| `X_MCP_CREDIT_BUDGET` | | | Session spend cap, USD. |
| `X_MCP_BUDGET_MODE` | `warn` | | `warn` \| `hard`. |
| `X_MCP_AVAILABILITY` | | | Comma-separated availability classes to enable. |
| `X_MCP_MEDIA_DIR` | | | Directory uploads must `realpath` inside (media default-deny). |
| `X_MCP_PROFILES_FILE` | | | Multi-account profiles file. |
| `X_MCP_PROFILE` | | | Active profile name. |
| `X_MCP_BASE_URL` | `https://api.x.com` | | API base URL. |
| `X_MCP_ALLOW_INSECURE_BASE_URL` | `0` | | `1` → permit a non-HTTPS base URL (testing only). |
| `X_MCP_TIMEOUT_MS` | `30000` | | Per-request timeout, milliseconds. |
| `X_MCP_LOG_LEVEL` | `info` | | `silent` \| `error` \| `info` \| `debug`. |

### Two-axis access policy

Every tool maps to one **policy cell** — an `operation:domain` pair. Operations escalate
`read` → `write` → `destructive`; domains are `content`, `user`, `account`, `engagement`,
`social-graph`, `moderation`, `dm`. A preset unlocks a set of the 12 valid cells;
`X_MCP_POLICY_ALLOW` adds cells, `X_MCP_POLICY_DENY` removes them, and **deny > allow > preset**.

| Preset | Grants |
|---|---|
| `read-only` *(default)* | all `read:*` cells **except** `read:dm` |
| `engage` | read-only **+** `write:engagement` |
| `publish` | engage **+** `write:content`, `write:moderation` |
| `manage` | publish **+** `destructive:content`, `write:social-graph` |
| `full` | every non-DM cell (all reads except `read:dm`, all writes except `write:dm`, all destructive) |

> **DM cells are never in a preset — not even `full`.** `read:dm` and `write:dm` must be
> granted explicitly via `X_MCP_POLICY_ALLOW`, and their unlock hint is deliberately withheld
> from policy errors. Denied tools stay registered but annotated `(disabled by policy <preset>)`
> unless `X_MCP_HIDE_DENIED=1`.

## Run / debug

The default invocation starts the stdio server; MCP clients spawn it for you. To run it by
hand for debugging:

```bash
X_MCP_AUTH_MODE=oauth2 X_MCP_POLICY=read-only npx x-mcp-ai@0.1.0 serve
```

### Command-line interface

| Command | What it does |
|---|---|
| `serve` *(default)* | Start the MCP server over stdio. Running with no subcommand also serves. |
| `authorize` | Run the one-time OAuth 2.0 PKCE authorization flow and persist the token file. |
| `doctor` | Print resolved config, auth context, granted scopes and token-file permissions; makes no billable calls. |

## Develop

```bash
git clone https://github.com/IvanBBaev/x-mcp-ai.git
cd x-mcp-ai
npm ci
npm run build         # tsc → build/
npm run check         # typecheck + lint + format:check + test
```

Other scripts: `npm run typecheck`, `npm run lint`, `npm run format` / `format:check`,
`npm test`, `npm run coverage` (c8), and `npm run verify` (clean build + coverage + lint +
format check). See [`CONTRIBUTING.md`](CONTRIBUTING.md) for conventions and the full quality
gate.

## Tools

The table below is the **designed** catalog (50 tools / 12 packages) from
[`docs/03-tool-catalog.md`](docs/03-tool-catalog.md); a typical deployment registers ~28 of
them after policy and availability gating. "Read-only" marks tools in a `read:*` policy cell —
those available under the default preset.

<!-- GENERATED:TOOLS:BEGIN -->

| Package | Tool | Read-only | Description |
|---|---|:--:|---|
| auth | `x_auth_status` | ✅ | Report the current auth mode, resolved identity and granted scopes. |
| auth | `x_rate_limit_status` | ✅ | Show live rate-limit windows per endpoint. |
| auth | `x_usage_get` | ✅ | Report monthly post-read consumption against the platform cap *(conditional — registers only when enabled)*. |
| posts | `x_post_create` | | Create a post (text, reply, quote, poll or media). |
| posts | `x_post_delete` | | Delete a post you own. |
| posts | `x_post_get` | ✅ | Fetch one or more posts by ID. |
| posts | `x_post_hide_reply` | | Hide or unhide a reply to your post. |
| search | `x_search_recent` | ✅ | Search posts from the last 7 days. |
| search | `x_search_archive` | ✅ | Full-archive post search (availability-gated). |
| search | `x_post_counts_recent` | ✅ | Recent post-volume counts for a query. |
| search | `x_post_counts_archive` | ✅ | Full-archive post-volume counts (availability-gated). |
| timelines | `x_timeline_home` | ✅ | Reverse-chronological home timeline. |
| timelines | `x_timeline_mentions` | ✅ | Posts mentioning the authenticated user. |
| timelines | `x_timeline_user` | ✅ | A user's authored posts. |
| engagement | `x_like_set` | | Like or unlike a post. |
| engagement | `x_repost_set` | | Repost or undo a repost. |
| engagement | `x_bookmark_set` | | Add or remove a bookmark. |
| engagement | `x_liked_posts_list` | ✅ | Posts a user has liked. |
| engagement | `x_liking_users_list` | ✅ | Users who liked a post. |
| engagement | `x_reposted_by_list` | ✅ | Users who reposted a post. |
| engagement | `x_quote_posts_list` | ✅ | Quote posts of a post. |
| engagement | `x_bookmarks_list` | ✅ | The authenticated user's bookmarks. |
| users | `x_user_get` | ✅ | Look up users by ID or username. |
| users | `x_user_search` | ✅ | Search for users. |
| graph | `x_follow_set` | | Follow or unfollow a user. |
| graph | `x_mute_set` | | Mute or unmute a user. |
| graph | `x_block_set` | | Block or unblock a user. |
| graph | `x_followers_list` | ✅ | A user's followers. |
| graph | `x_following_list` | ✅ | Accounts a user follows. |
| graph | `x_blocks_list` | ✅ | Accounts the authenticated user blocks. |
| graph | `x_mutes_list` | ✅ | Accounts the authenticated user mutes. |
| dm | `x_dm_events_list` | ✅ | List DM events across conversations *(needs explicit `read:dm`)*. |
| dm | `x_dm_conversation_events_list` | ✅ | DM events in a conversation *(needs explicit `read:dm`)*. |
| dm | `x_dm_participant_events_list` | ✅ | DM events with a participant *(needs explicit `read:dm`)*. |
| dm | `x_dm_send` | | Send a direct message *(needs explicit `write:dm`)*. |
| lists | `x_list_create` | | Create a list. |
| lists | `x_list_update` | | Update a list's name or description. |
| lists | `x_list_delete` | | Delete a list. |
| lists | `x_list_get` | ✅ | Fetch a list's metadata. |
| lists | `x_lists_owned` | ✅ | Lists owned by a user. |
| lists | `x_list_member_set` | | Add or remove a list member. |
| lists | `x_list_members` | ✅ | Members of a list. |
| lists | `x_list_timeline` | ✅ | Posts from a list. |
| lists | `x_list_follow_set` | | Follow or unfollow a list. |
| lists | `x_list_pin_set` | | Pin or unpin a list. |
| media | `x_media_upload` | | Upload media from `X_MCP_MEDIA_DIR` for attachment. |
| media | `x_media_status` | ✅ | Check the processing status of an upload. |
| spaces | `x_space_get` | ✅ | Fetch a Space by ID. |
| spaces | `x_spaces_search` | ✅ | Search for Spaces. |
| trends | `x_trends_by_location` | ✅ | Trends for a WOEID location. |

<!-- GENERATED:TOOLS:END -->

### Tool packages

| Package | Covers |
|---|---|
| `auth` | Auth context, rate-limit windows, monthly read-usage reporting. |
| `posts` | Create/delete/get posts and hide replies. |
| `search` | Recent and full-archive post search plus volume counts. |
| `timelines` | Home, mentions and user timelines. |
| `engagement` | Likes, reposts, bookmarks and their reader lists. |
| `users` | User lookup and search. |
| `graph` | Follow/mute/block plus follower/following/block/mute lists. |
| `dm` | Direct-message reads and sends (double-locked). |
| `lists` | Full list lifecycle, membership, timeline, follow and pin. |
| `media` | Media upload and status. |
| `spaces` | Spaces lookup and search. |
| `trends` | Trends by location. |

#### Presets

Presets bundle policy cells, so they also decide which tools register. `read-only` exposes the
34 `read:*` tools (minus DM); `engage` adds the engagement writes; `publish` adds post/media
creation and reply moderation; `manage` adds destructive content and social-graph writes;
`full` unlocks every non-DM tool. DM tools require an explicit `read:dm`/`write:dm` grant under
any preset. See [Two-axis access policy](#two-axis-access-policy).

## Resources

MCP resources are **planned** — a read-only exposure of the resolved auth context and live
rate-limit table as addressable resources. Not shipped in `0.1.0`.

## Prompts

MCP prompts are **planned** — guided templates for common workflows (e.g. cost-aware posting,
audience research). Not shipped in `0.1.0`.

## Project structure

Ports & adapters; the module layout is fixed in [`docs/02-architecture.md`](docs/02-architecture.md) §3:

```
src/
├── index.ts            # composition root + stdio wiring
├── core/               # config, policy, budget, errors, ports, tooldef,
│                       #   registry, render, resolve, paginate, fields, sanitize
├── api/                # http, ratelimit, errors, oauth2/, oauth1, endpoints/
├── tools/              # one module per package (posts, search, graph, …)
├── mcp/                # server, schema, structured — the MCP adapter
└── cli/                # authorize, doctor
```

Dependency rule: `tools → core + api/endpoints`, `api → core`, `mcp → tools + core`,
`cli → core + api`. Nothing in `core` reaches outward.

## Security notes

A summary; the full threat model and operator checklist live in [`SECURITY.md`](SECURITY.md)
and [`docs/04-security.md`](docs/04-security.md).

- **Host-scoped auth.** The `Authorization` header is attached only for the API allowlist
  (`api.x.com`, `upload.x.com`); redirects are never followed on token-bearing requests
  (confused-deputy defense).
- **Token file hardening.** Written `0600` with `O_NOFOLLOW`/`O_EXCL`; refresh is single-flight
  with reload-under-lock and fails closed.
- **Untrusted content.** Post/user text returned to the model is marked as untrusted. Marking
  is not a semantic filter — the **policy model is the real control** against prompt injection.
- **Media default-deny.** Uploads are refused unless the file `realpath`s inside
  `X_MCP_MEDIA_DIR`.
- **Cost is model-immutable.** The session credit budget is operator-set; the model cannot
  raise or disable it.

## Support

If this project saves you time, support is welcome:

[![Sponsor](https://img.shields.io/badge/GitHub-Sponsors-ea4aaa?style=flat-square&logo=githubsponsors)](https://github.com/sponsors/IvanBBaev)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-ff5e5b?style=flat-square&logo=kofi)](https://ko-fi.com/ivanbbaev)
[![Donatree](https://img.shields.io/badge/Donatree-Donate-22c55e?style=flat-square)](https://donatr.ee/ivanbbaev/)

## Trademark

x-mcp-ai is an independent, unofficial project. It is **not affiliated with, endorsed by, or
sponsored by X Corp**. It talks to the official, publicly documented X API v2 and does not use
any private, undocumented or scraping-based access.

"X", "Twitter", and related names, logos and marks are trademarks of X Corp. They are used here
**nominatively**, only to describe what this software interoperates with. This project is
released under the [MIT License](LICENSE); trademark rights are not licensed.
