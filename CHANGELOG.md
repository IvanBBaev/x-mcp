# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The full
development chronology lives in `WORKLOG.md`.

## [Unreleased]

### Added

- `x_thread_create` (roadmap Phase 3): post a thread — `posts: string[]` (2-25) — in one
  call instead of chaining `x_post_create` by hand. Post 1 is standalone and every
  following post replies to the previous id; each post is sent and rate-limit tracked
  exactly like an `x_post_create` call. The whole thread is priced as the sum of its posts
  and charged to the budget upfront — not refunded if the thread stops early. Gated behind
  the same `write:content` cell, so it is callable only from the `publish` preset and
  above. A mid-thread failure is reported, not thrown: the result lists the posts already
  published and where it stopped, so you can resume with `x_post_create`'s `reply_to_id`
  — nothing already posted is auto-deleted.

### Changed

- `tools/list` is about 1.5 KB smaller. Redundant wording in tool and parameter
  descriptions — restatements of limits the schema already carries, and of what a
  parameter's own description already says — was tightened. No tool, parameter,
  constraint or behaviour changed.

- `x_search_recent`, `x_search_archive`, `x_post_counts_recent`, `x_post_counts_archive`,
  `x_post_get`, `x_list_get`, `x_list_members`, and `x_list_timeline` no longer charge the
  session budget for a call they refuse locally. A query using a removed engagement
  operator (DRIFT-3), a malformed post reference in `x_post_get`'s `ids`, and a malformed
  `list_id` are now rejected at input validation, before the budget check, instead of
  after it. The refusal is still a `validation` error and still sends nothing; its
  message keeps naming the offending field.

- `x_dm_send` no longer charges the session budget for a DM it refuses locally. Passing
  both `conversation_id` and `participant` (or neither), a malformed `conversation_id`,
  and a `participant` of `"me"` are now rejected at input validation, before the budget
  check, instead of after it. The refusal is still a `validation` error and still sends
  nothing; its message still names the offending field.

- `x_post_create` no longer charges the session budget for a post it refuses locally.
  Whitespace-only text, a poll combined with `media_ids`, and a malformed `reply_to_id`
  or `quote_id` are now rejected at input validation, before the budget check, instead
  of after it. The refusal is still a `validation` error and still sends nothing; its
  message now names the offending field.

- Fixed two follow-ups to warnings introduced earlier in this release. A too-wide
  POSIX token file no longer prints its `chmod 600` startup warning twice (once from
  the startup check, once from the store's first load); on Windows, where mode bits
  are not checked, startup now prints a single warning that securing the token file's
  ACL is the operator's responsibility, matching what `doctor` already reported
  (AUTH-12). Separately, `X_MCP_ALLOW_PROXY` is now listed in `server.json`'s
  environment variables, and the proxy startup warning is now suppressed — with
  `doctor` noting it instead — when `NO_PROXY`/`no_proxy` already exempts both
  `api.x.com` and `upload.x.com` from the proxy (AUTH-14).

- `authorize` no longer tries to launch a browser over an SSH session on macOS. Previously
  only the `xdg-open` (Linux/other) path skipped the browser under SSH; on darwin `open`
  was always spawned, which would open a browser on the *remote* Mac's own screen — a
  session the SSH user cannot reach — and the loopback redirect it produced could never
  reach the local listener either. An SSH session on macOS now gets the same immediate
  "open the URL manually, or re-run with `--manual`" fallback that an SSH session on Linux
  already got. A local (non-SSH) macOS session, and Windows over SSH, are unaffected.

- `x_post_get`, `x_user_get` and `x_list_get` now carry the untrusted-content note in
  `summary` (REND-6) whenever a result actually returned third-party text — matching
  every other tool that renders posts, users, DMs, or lists. Previously these three
  were the only readers that returned third-party text without the warning.

- Non-fatal stderr notices (startup permission warnings, the O_NOFOLLOW degradation
  notice, the keychain single-process-lock notice) are now single-line JSON,
  `{"ts", "level", "msg"}`, instead of a plain-text `x-mcp-ai: warning: <text>` line.
  The fatal-startup line (`x-mcp-ai: fatal: <reason>`) is unchanged.

- `x_search_recent`, `x_search_archive`, `x_post_counts_recent` and
  `x_post_counts_archive` now handle `start_time`/`end_time` the way the timeline tools
  do. An `end_time` inside the last 10 seconds, which X rejects with a 400, is moved to
  10 seconds in the past and the result's `note` says so. A value that is not a
  recognizable timestamp is refused with a `validation` error before anything is sent,
  and other forms (such as a `+02:00` offset) are sent as ISO 8601 UTC. Count buckets
  always report their `start`/`end` in ISO 8601 UTC.

- Paginated reads (search, timelines, followers/following, user search, owned lists,
  list members and timelines, bookmarks, DMs) now report the per-item `errors[]` X
  returns alongside an HTTP 200 as a `missing[]` list of `{id, reason}`, the same shape
  batch lookups already use. A page that came back with only errors no longer reads "No
  results matched this query."; its note says X reported the requested resource as
  unavailable and points at `missing[]`. X's own error prose is still never echoed.

- If Node's own env proxying is switched on (`NODE_USE_ENV_PROXY=1`, or `--use-env-proxy`
  in `NODE_OPTIONS`) and `HTTPS_PROXY`/`HTTP_PROXY` is set, the server now prints a
  one-line startup warning that API requests, including their `Authorization` header, go
  through that proxy; `doctor` reports the same. It still starts. Set
  `X_MCP_ALLOW_PROXY=1` to mark the proxy as trusted and silence the warning.

- A token file readable by group or other now triggers a one-line `chmod 600` warning
  on stderr as soon as the server starts, not only on its first X call. On Windows the
  warning and `doctor` now say that securing the file is your responsibility and print
  the `icacls "<tokenFile>"` command to inspect it.

- A startup failure is now always a single `x-mcp-ai: fatal:` line on stderr, even when
  the reason contains line breaks (a profiles-file path with a newline, or a multi-line
  module-load error from the `npx` launcher). Hosts that read the first stderr line now
  get the whole reason.

- `authorize` now opens the authorization URL in your default browser (`open` on macOS,
  `xdg-open` on Linux, `rundll32` on Windows). When no browser can be launched — no opener
  installed, no graphical session, or an SSH session — it says so right away and points
  at the printed URL and `--manual`, instead of silently waiting out the 5-minute
  callback timeout.

- When `X_MCP_CREDIT_BUDGET_MODE=hard` refuses an `x_post_create` whose text contains a
  URL, the refusal now says the post is priced at $0.20 instead of the $0.015 base. URL
  detection also covers internationalized and punycode domains (for example `xn--p1ai`)
  and a domain glued to a word by `_`, so those posts are no longer under-quoted.

- In a batch lookup's `missing[]`, a suspended account is now reported as `suspended`
  rather than `not-found`, and a "Not Authorized" item as `protected` rather than
  `unavailable`. X sends a suspended user with a generic not-found type, and only the
  error detail names the suspension. The detail is read to classify the item but is still
  never echoed.

- `x_list_get` on a list X cannot return (missing, or private to someone else) now fails
  with a `not-found` error naming the reason. X answers such a lookup with a 200 that
  carries only `errors[]`, and the tool used to render that as an empty list.

- A call refused locally because the rate-limit window is known to be exhausted no longer
  counts against `X_MCP_CREDIT_BUDGET`. Nothing is sent to X for such a call, but it was
  charged, so retries inside an exhausted window could use up a `hard`-mode budget.

- A paginated `raw: true` read called without `max_results` now sends `max_results=10`
  instead of none. X's own default is 100 on the follower/following, liker, bookmark and
  list endpoints, so the raw payload could exceed its documented 25-item cap (REND-10).

- Hitting X's monthly usage cap now returns a `billing` error that says the cap will not
  lift until the monthly period renews, instead of a `rate-limit` error that suggested
  waiting a few minutes and retrying.

- When X issues or refreshes a token without saying how long it lives, the server no
  longer breaks. Previously the refreshed token was saved in a form the next start
  rejected as a corrupt token file, forcing a fresh `authorize`; `authorize` itself
  silently assumed a 2-hour lifetime. The lifetime is now recorded as unknown: the token
  is refreshed on the first 401 after it expires instead of ahead of time.
- A write that fails with a 5xx or a network error — sending a DM, liking, following,
  managing a list, and so on, not only post tools — now returns a non-retryable error
  that says X may have applied the write anyway and that the effect should be verified
  before re-issuing it. Previously these errors were marked retryable, inviting a blind
  retry that could duplicate the write.
- A `page_token` that X rejects as stale or invalid now returns a `validation` error
  ("pagination token invalid or expired — restart from the first page") instead of an
  opaque `api` error, so the agent knows to drop the cursor and page again from the start.
- A read that hits a rate limit whose window renews within 5 seconds now waits for the
  reset and retries once instead of failing: the 429 is absorbed and the call returns
  normally, a few seconds later. A reset further away still returns the `rate-limit`
  error immediately, and writes are never retried on any status.

- Rate-limit tracking now learns from every response, not only from failures: a successful
  call whose headers report an exhausted window trains the table, so the next call in that
  bucket is refused locally before the platform answers 429, and `x_rate_limit_status`
  shows a bucket after its first successful call instead of after its first failure.
- `cost_usd` now reflects how many resources a call returned. X bills reads per resource and
  writes per request, but every read was previously charged a single unit price — a search
  returning 100 posts reported $0.005 instead of $0.50. Multi-resource reads are now priced
  `unit price × resources returned`, an empty page costs nothing, and single-resource
  lookups and writes are unchanged. Expect the session total to be substantially higher
  than before for the same workload; it is closer to the real invoice, and a
  `X_MCP_CREDIT_BUDGET` tuned against the old numbers will now be reached much sooner.

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
