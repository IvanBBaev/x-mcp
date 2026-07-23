# 06 — Roadmap

> **Superseded 2026-07-22 by [08-implementation-roadmap.md](08-implementation-roadmap.md)**,
> which rebuilds this plan around the six review outcomes and the corner-case
> catalog ([07-corner-cases.md](07-corner-cases.md)). Kept for history; do not
> plan against this file.

Phased so every phase ships something usable and the risky infrastructure
(auth, policy, rate limits) is proven before the surface grows.

## Phase 0 — Design ratification *(current)*

- Design corpus (this repo) + role-based senior reviews in `docs/reviews/`.
- Exit: review findings triaged; blocking findings folded back into the docs;
  a Free-tier X developer app + test account exist.

## Phase 1 — Skeleton + read-only MVP

Infrastructure: repo scaffolding (tsconfig/eslint/prettier/test harness mirroring
servicenow-mcp-ai), `core/config` + `core/policy` + error taxonomy, `api/http` +
app-only bearer auth, rate-limit table.

Tools (app-only capable subset): `auth_status`, `rate_limit_status`, `post_get`,
`posts_get`, `user_get`, `user_by_username`, `users_get`, `search_recent`,
`post_counts_recent`.

Exit: `npm run check` green; works in Claude Code via `npx` against a real account.

## Phase 2 — User context + writes

- `scripts/authorize.mjs` PKCE flow; `api/oauth2` refresh/rotation/locking (the
  hardest code in the project — lands with its full test suite); OAuth 1.0a signing.
- Tools: `post_create`, `post_delete`, engagement package, `timeline_*`,
  `bookmarks`, `usage_get` + budget enforcement.
- Policy presets become meaningful (`engage`, `publish`).
- Exit: end-to-end demo — agent drafts, human approves, agent posts, verifies via
  timeline; token rotation survives a kill -9 test.

## Phase 3 — Full surface

- `graph`, `lists`, `dm` (with `full`-only gating), `media_upload` + alt text,
  `spaces`, `trends`, `user_search`, `search_all`/`post_counts_all` (tier-gated),
  `thread_create` convenience (capped, `publish`-gated).
- Keychain token storage option; profiles file; npm publish + MCP registry
  (`server.json`, `mcpName: io.github.IvanBBaev/x-mcp-ai`).
- Exit: parity with the tool catalog doc; published `1.0.0`.

## Phase 4 — Exploratory (not committed)

- Streamable HTTP transport; filtered-stream bridge (Pro tier) surfaced as MCP
  resources/notifications rather than tools.
- Community Notes / grok-adjacent endpoints if/when public.
- Prompts: packaged MCP prompts for common workflows ("draft thread from notes",
  "daily mentions triage").

## Open questions (to resolve in Phase 0 reviews)

1. Is client-side read-budget tracking (`core/budget`) worth its complexity for v1,
   or should Phase 1 rely on `usage_get` + rate-limit errors alone?
2. Denied-tool visibility: registered-but-erroring (current design) vs hidden —
   does the chosen approach confuse specific MCP clients?
3. OAuth 1.0a support in Phase 2 or drop to Phase 3? (Depends on how common
   1.0a-only hobby credentials still are.)
4. Package name: `x-mcp-ai` assumed; confirm npm availability before Phase 1 ends.
