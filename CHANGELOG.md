# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The full
development chronology lives in `WORKLOG.md`.

## [Unreleased]

## [0.8.0] - 2026-08-25

First published release on npm as `x-mcp-ai`.

### Added

- Infrastructure layer for the MCP server: configuration contract (20 `X_MCP_*` environment
  variables with defaults and validation, including a named-profiles file), two-axis policy engine (12 `operation:domain` cells,
  five presets, deny > allow > preset), session credit budget (`warn`/`hard`), the
  registry-as-data tool contract (`ToolDef`), the host-scoped HTTP client with rate-limit
  tracking, the error taxonomy, and the render/resolve/paginate helpers.
- Packaging and presentation layer: `README`, `SECURITY`, `CONTRIBUTING`, this changelog,
  the MCP Registry manifest (`server.json`), and repository metadata in `package.json`
  (`mcpName`, `repository`, `homepage`, `bugs`, `keywords`, `trademark`).
- Continuous integration (build/lint/format/test on Node 22 and 24), CodeQL scanning, and
  Dependabot for npm and GitHub Actions.
- OAuth 2.0 user-context authentication: PKCE `authorize` flow (CSRF `state`, one-shot
  loopback listener, `--manual` headless mode), single-flight token refresh with
  persist-before-use, an atomic `0600` file token store with fail-closed locking, and a
  `doctor` diagnostics subcommand.
- OS-keychain token storage (`X_MCP_TOKEN_KEYCHAIN=1`) as an alternative backend to the
  token file, on macOS (`security`) and Linux (`secret-tool`). The secret always travels
  on the child process's stdin, never in argv, and never appears in an error, cause, or
  warning. It fails closed — an unsupported platform or a missing secret tool is a typed
  error at startup, with no in-memory fallback — and the two backends are mutually
  exclusive by construction. One selector answers "which backend does this configuration
  call for?" for both `serve` and `authorize`, so an operator cannot authorize into one
  store and serve from the other. Documented limitation: the keychain backend has no
  cross-process refresh lock (single-flight holds within a process, and it warns once);
  operators running several processes against one account should use `X_MCP_TOKEN_FILE`.
- Eight write/timeline tools — `x_post_create`, `x_post_delete`, `x_like_set`,
  `x_repost_set`, `x_bookmark_set`, `x_timeline_home`, `x_timeline_mentions`,
  `x_timeline_user` — joining the six Phase-1 read tools (14 registered in total).
- Final policy presets (`read-only` / `engage` / `publish` / `manage` / `full`) with a
  strict escalation chain; DM cells are excluded from every preset and require an
  explicit allow.
- Twenty-five Phase-3 tools across six packages (39 registered in total): social graph
  (`x_follow_set`, `x_mute_set`, `x_block_set`, `x_followers_list`, `x_following_list`,
  `x_user_search`), lists (ten merged tools incl. standalone `x_list_delete`), media
  (`x_media_upload` chunked INIT→APPEND→FINALIZE with optional alt text,
  `x_media_status`), DMs (three event lookups + `x_dm_send`, reachable only via an
  explicit `write:dm`/`read:dm` allow), and full-archive search/counts
  (`x_search_archive`, `x_post_counts_archive`, budget-guarded), and usage reporting
  (`x_usage_get`).
- `x_usage_get` reports the current billing cycle's post-READ COUNTS against the monthly
  project cap — with an optional per-day and per-app breakdown — alongside this process's
  local credit-spend estimate. The two halves are deliberately never reconciled: X
  publishes no spend API, so the platform figures are counts and never money, and the
  local estimate is never seeded or corrected from them (COST-2). The tool reads the
  budget and cannot change it (COST-1).
- Structured tool output: every tool advertises a JSON-Schema `outputSchema` in
  `tools/list` and returns `structuredContent` alongside the text block, both built from
  the same render object. The composition root refuses to start if a registered tool has
  no published schema.
- Availability class-gating at registration time (`X_MCP_AVAILABILITY`): tools declaring
  a specially-provisioned class (`pilot`/`premium-user`/`enterprise`) are excluded from
  registration unless the operator opts in; the pay-per-use base classes always register.
- Generated tool reference (`docs/reference/tools.md`) built from the registry, plus a
  drift gate (`npm run docs:check`) that fails when the checked-in reference no longer
  matches the code. Regenerate with `npm run docs:gen`.
- Context-budget gate: the bytes a client spends on `tools/list` (schemas, descriptions,
  annotations) are measured and capped at 80 kB — currently 78.4 kB — so a new tool
  cannot silently crowd out the model's working context.
- `x_bookmarks_list` — reads the authenticated user's own bookmarks as a compact page.
  Completes the pair against `x_bookmark_set`, which could add a bookmark with no way to
  read one back. Resolves `me` before the read, so a failure to identify the account is
  reported as "the bookmarks endpoint cannot be addressed; nothing was read" rather than
  as an empty page.
- `x_post_hide_reply` — hides or unhides a reply in a conversation the authenticated user
  started, opening the previously empty `write:moderation` policy cell. The action is
  absolute (`hide` / `unhide` set a state rather than toggling one), so re-issuing it
  after an ambiguous network failure is safe; the 403 for "you are not the conversation
  author" is decorated to say exactly that instead of surfacing a bare platform refusal.
- Manifest lockstep guard: `server.json` is checked against the configuration contract,
  so an environment variable cannot be added to the code without being advertised (or
  deliberately excluded).
- CI job `gates` running the three checks above.

### Changed

- `npm run check` now also runs `npm run gates` (docs drift, context budget, manifest
  lockstep) in addition to verify, coverage, and the production-dependency audit.

### Fixed

- Truncated responses on stdin EOF: the server now flushes buffered stdout before exit,
  bounded by a 1 s timeout, instead of racing process teardown. A large final response is
  delivered whole rather than cut mid-frame.

### Security

- Credential egress is now governed by a hardcoded allowlist (`*.x.com`, HTTPS only) that
  is independent of `X_MCP_BASE_URL`. Previously the auth-attachment predicate scoped the
  credential to the *configured* origin, which an operator-supplied base URL controls —
  so `X_MCP_BASE_URL=https://…` together with `X_MCP_ALLOW_INSECURE_BASE_URL=1` would
  have sent the bearer token, the refresh token, and the `authorize` code plus PKCE
  verifier to that host. Two independent layers now enforce the split: the request-time
  header decision withholds the credential from any non-allowlisted host (such a session
  still runs, unauthenticated), and startup refuses an OAuth 2.0 session whose token
  endpoint would fall outside the list, because there is no unauthenticated mode to
  degrade to. `X_MCP_ALLOW_INSECURE_BASE_URL` relaxes where requests go, never where
  credentials go. See `docs/04-security.md` T10 §4.4.
- Policy denials no longer name the environment variable that would unlock the blocked
  cell — for *any* cell, not just the sensitive ones. The message still names the cell (and
  still carries it in `data.cell`), so it stays actionable; the syntax now lives only in
  `docs/10-operator-guide.md` §6.3, where a human reads it. The previous split leaked the
  half an attacker was missing: `x_auth_status` already returns the full policy matrix, so a
  prompt-injected planner could read the blocked cell's name there, trigger any
  low-sensitivity denial to learn the variable and its exact syntax, and relay a complete
  escalation recipe. Withholding only works if it is total.
- Third-party platform text is sanitized on **every** path into the model's context, not
  just the error path. `x_usage_get`'s degraded-200 branch quoted `errors[].title`/`.detail`
  into its report note verbatim on the theory that X's own text is trusted; it now goes
  through the same C0/C1, bidi and invisible-code-point strip and the same length cap as
  every other untrusted string. Origin is not a property of the bytes.
- The keychain helper is spawned with an explicit environment allowlist, so no `X_MCP_*`
  variable — and no loader-injection variable (`DYLD_INSERT_LIBRARIES`, `LD_PRELOAD`,
  `NODE_OPTIONS`) — is inherited by the child. A variable added in future is excluded by
  default rather than by someone remembering to exclude it.
- Dependency advisories: a lockfile-only `npm audit fix` closes two **high** advisories in
  the MCP SDK's transitive tree (`fast-uri` host confusion, `ip-address` SSRF /
  trust-boundary bypass) plus `js-yaml`, `hono` and `undici`. Declared runtime dependencies
  are unchanged (`@modelcontextprotocol/sdk` `^1.12.0` + `zod` `^3.23.8`); the installed SDK
  moves 1.29.0 → 1.30.0. Neither high advisory is reachable from this server — both sit
  under the SDK's HTTP/SSE transport and JSON-Schema validator, and this server is
  stdio-only — but the audit gate does not grade reachability on purpose.

### Decided

- OAuth 1.0a request signing is dropped (go/no-go resolved NO-GO 2026-07-31); v1 media
  upload uses the OAuth 2.0 `/2/media/upload` path instead. See
  `docs/decisions/0001-oauth1-go-no-go.md`.
- The eleven catalogued-but-unregistered tools are resolved 2026-08-09: `x_bookmarks_list`
  and `x_post_hide_reply` ship, the other nine are cut from the v1 catalogue. Four were
  audience reads that `x_search_recent` already answers with `conversation_id:` /
  `quotes_of:`; two listed blocks/mutes, which an agent never needs because the
  corresponding writes are absolute; three were Spaces (live audio) and WOEID trends,
  both out of shape for this server. This also closes WP-3.5's spaces/trends go/no-go as
  NO-GO. See `docs/decisions/0002-remaining-catalogued-tools.md`.

### Platform changes absorbed

- X retired the Free/Basic/Pro subscription tiers for new developers (2026-02-06);
  pay-per-use credit pricing is the only model available to the target audience. Cost
  handling is a per-call dollar estimate against a session credit budget, not a monthly
  read count (rates verified 2026-07-22).
- Post creation is priced per request: $0.015 base, raised to $0.20 (13×) when the text
  contains a URL (platform change effective 2026-04-16). `x_post_create` resolves its
  cost dynamically and warns distinctly on URL-bearing text.
- Engagement writes (like/repost/bookmark, deletes, hide-reply) are not separately
  priced on the platform's pricing page as of 2026-07-22; the `w:action` cost class is
  carried at $0 locally until a Phase-1 live capture confirms the real price.
- Rate limits are enforced per endpoint per 15-minute window, separately for user and
  app context; `POST /2/tweets` additionally carries a per-user window and a 24-hour
  app-level cap surfaced via `x-app-limit-24hour-*` headers, which the rate-limit
  tracker parses alongside the standard headers.
- The duplicate-content 403 on `POST /2/tweets` is mapped to a typed error and doubles
  as the safe-probe signal after an ambiguous create failure; `DELETE /2/tweets/:id` on
  an already-deleted post is reported as idempotent success (`already_deleted`) rather
  than an error.
- Timeline endpoints reject an `end_time` inside roughly the last 10 seconds with a
  400; the timeline tools clamp `end_time` to now−10 s and surface the adjustment as a
  page note.

### Notes

- Pre-1.0. The user-facing tool surface is **41 tools across 12 packages**; the catalogue
  in `docs/03-tool-catalog.md` and the registry are the same set, and a CI gate fails if
  they diverge. The original 50-row design catalogue was cut to 41 on 2026-08-09: nine rows
  were dropped rather than shipped, because the measured `tools/list` payload leaves 1,555 B
  of an 80,000 B budget and the nine cost roughly 17 kB between them. Each cut is recorded
  with its rationale under "Deliberate omissions" in the catalogue and in
  `docs/decisions/0002-remaining-catalogued-tools.md`. The public API is unstable until
  `1.0.0` — pin an exact version.
