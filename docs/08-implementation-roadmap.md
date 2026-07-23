# 08 — Implementation roadmap

**This document supersedes [06-roadmap.md](06-roadmap.md).** It rebuilds the phased
plan around the outcomes of the six senior reviews
([reviews/README.md](reviews/README.md)): the two BLOCKERs, the consensus
corrections, and the corner-case catalog ([07-corner-cases.md](07-corner-cases.md)),
which is the normative test-scope companion to this plan.

Work packages are labeled `WP-<phase>.<n>` with sizes **S** (≤ half a day),
**M** (1–2 days), **L** (3+ days). Dependencies are stated explicitly; anything not
listed as a dependency can proceed in parallel.

**Execution companion:** [09-parallel-execution-plan.md](09-parallel-execution-plan.md)
decomposes every WP below into small, independently assignable tasks (`T-xxx`)
with exclusive file ownership, frozen shared contracts, and a wave schedule for
parallel multi-agent development. This document stays authoritative for scope and
phase sequencing; 09 is authoritative for who builds what concurrently.

---

## Standing rules (all phases)

1. **Corner-case traceability.** Every `P<n>`-tagged case in
   [07-corner-cases.md](07-corner-cases.md) must have a referencing test (by ID, in
   a test-name or comment) before its phase's exit gate passes. A case consciously
   dropped is edited out of 07 with a dated note — never silently skipped.
2. **Platform re-fact-check at every phase boundary** *(X-platform rec 8)*.
   Re-check pricing, endpoints, and limits against `https://docs.x.com/x-api/llms.txt`
   and the changelog; fold differences into the corpus before the next phase starts.
   The X API changed its entire business model between our design and its review —
   assume it will drift again.
3. **No code before Phase 0R exits.** The corpus is the contract; writing code
   against un-ratified docs re-creates the drift the reviews just caught.
4. **Public API discipline from the first tag** *(DevOps F3)*: tool names, input
   schemas, rendered shapes, error codes, env vars, preset meanings, CLI
   subcommands/exit codes, and the token-file format are the public API. 0.x during
   Phases 1–2, `1.0.0` at Phase 3 exit; contract-fixture tests enforce
   additive-only changes.

---

## Phase 0R — Corpus revision & ratification *(now; docs only)*

Closes the open item from the review synthesis: fold every BLOCKER/MAJOR back into
docs/01–06. Exit requires an explicit disposition (doc change or dated won't-fix)
for **every** finding in the six reviews.

| WP | Size | Work | Sources |
|---|---|---|---|
| WP-0.1 | M | **Pricing rewrite (BLOCKER 1).** Rewrite docs/01 §3 around pay-per-use credits; legacy-tier appendix. Catalog: replace *Tier* column with *availability* (`app+user` / `user-only` / `pilot` / `premium-user` / `enterprise`) + *cost class*. Error taxonomy: `tier` → availability semantics; add `billing` and `budget` classes. Budget → session **credit** budget (`X_MCP_CREDIT_BUDGET` USD + `X_MCP_BUDGET_MODE=warn\|hard`), covering reads **and** writes; static per-endpoint cost table as an appendix. | X-F1/F4, ARCH-F3/F4 |
| WP-0.2 | M | **OAuth2 refresh state-machine spec (BLOCKER 2).** New design section in docs/02: single-flight, reload-under-lock/adopt-on-disk-pair, reload-on-401, persist-before-use, stale-lock protocol (PID+timestamp, HTTP timeout < staleness threshold, fail-closed). States + transitions + the two canonical tests named. Code lands in Phase 2; the *design* is a Phase 0R deliverable. | ARCH-F1, SEC-F1 |
| WP-0.3 | M | **Catalog rework.** Adopt the Agent-DX merge/cut plan verbatim (nine `*_set` merges, unified `user_get`/`post_get` batch lookups, renames, destructive ops never behind enums, `alt_text` folded into `media_upload`) → 50 rows / 49 unconditional / ~28 typical. Adopt the `x_` name prefix and "X (Twitter): …" description openers. Add *phase* and *availability* columns. Redesign the dm package around the three DM-event lookups + 30-day retention. Split `media_upload`/`media_status`. | DX-F1/F2/F5/F14, X-F2/F6, ARCH-F7/F13 |
| WP-0.4 | S | **Policy corrections.** `block_*` → `destructive:social-graph`; `list_delete` → `destructive:content`; `read:dm` out of the `read-only` preset; add `manage` preset (publish + destructive:content); DM decomposed from `full`; explicit override-precedence rule (allow can enable `write:dm`; deny always wins). Ratify the denied-tool resolution: registered + "(disabled by policy)" annotation + no unlock hint for sensitive cells + `X_MCP_HIDE_DENIED=1`. | SEC-F2/F5/F9/F10/F14, QA-F4, DX-F6 |
| WP-0.5 | S | **Config canonicalization.** One env-var table (add `X_MCP_LOG_LEVEL`, `X_MCP_BASE_URL`, `X_MCP_MEDIA_DIR`, `X_MCP_TOKEN_KEYCHAIN`, budget vars); profiles-file+direct-creds conflict rule; token-path defaults incl. Windows; `~` expansion; config dir fixed as `x-mcp`; one dependency statement (SDK + zod; decide dotenv vs Node `--env-file`). | ARCH-F9/F10, OPS-F5/F6 |
| WP-0.6 | M | **Security fold-in.** T10–T17 into docs/04; authorize-flow spec (CSRF `state`, loopback one-shot listener); Authorization host-scoping; media default-deny + realpath/`O_NOFOLLOW`/same-fd; untrusted-content hardening (all third-party text, zero-width/bidi stripping, length caps, honest "does not prevent injection" note); redaction list expansion; kill-chain scenarios as appendix. | SEC-F3/F4/F6/F7/F8/F11 |
| WP-0.7 | S | **Testing doc update.** Injection seams (Clock/Sleep/Random/TokenStore/dispatcher/parseConfig/registry-as-data); MCP-protocol layer (InMemoryTransport + spawn smoke); per-file coverage + coverage-guard port; fixture provenance + monthly refresh; live-suite spend rules under pay-per-use. | QA-F1/F3/F5/F8/F9 |
| WP-0.8 | S | **Release/versioning policy into docs/05 + README.** Public-API definition, 0.x plan, CHANGELOG with "Platform changes absorbed" section, tag-gated publish with provenance, `server.json` lockstep guard, bin subcommand dispatcher (`server` default / `authorize` / `doctor`), "Where are the logs?" table, README pins exact versions during 0.x. Plus: token-file `version` migration rule (file newer than the server understands → refuse with an upgrade instruction, never guess) and the post-1.0 tool **deprecation flow** (deprecation note in the description for ≥ 1 minor, removal only at the next major). | OPS-F2/F3/F4/F8/F9 |
| WP-0.9 | S | **Reserve the npm name — do not wait for Phase 1.** Create the GitHub repo, `git init` (harness files into `.git/info/exclude` first), add the MIT `LICENSE` file (README promises it; npm needs it), minimal CI, publish `x-mcp-ai@0.0.1` placeholder (README-only, "design phase — do not use") **from CI with `--provenance`**. Name verified available 2026-07-21; availability is perishable. | OPS-F13 |
| WP-0.10 | S | **Availability-detection spec.** Pay-per-use killed 403-based tier inference (old docs/01 §3), but WP-3.5 still needs to know what the account can reach. Define the mechanism: explicit `X_MCP_AVAILABILITY` env (conservative default), surfaced in `auth_status`, consumed by the registry to gate `pilot`/`premium-user`/`enterprise` registration (archive & `user_search` are `app+user`, budget-guarded — not gated); `doctor` may probe one gated endpoint on request. Include a fact-check: does `GET /2/usage/tweets` (or a credits/usage endpoint) still exist under pay-per-use → feeds WP-3.11. | X-F1 follow-up |

**Exit gate 0R:** every review finding dispositioned; docs/01–06 internally
consistent (env table, tool count, dep list, budget model all match); npm name
owned; [07](07-corner-cases.md) + this document referenced from README.

---

## Phase 1 — Skeleton + read-only core *(0.1.0)*

Goal unchanged from the old roadmap — a healthy stdio server exposing the app-only
read subset — but re-sequenced so the **registry and error taxonomy exist before any
endpoint**, and every Phase-1 testability seam is in from day one.

| WP | Size | Work | Depends on |
|---|---|---|---|
| WP-1.1 | S | **Scaffold from the family.** Copy servicenow-mcp-ai's `ci.yml` (ubuntu 20/22/24 + macOS + **Windows leg** + launcher-node12 probe), `codeql.yml`, `dependabot.yml`, `.npmrc` (`engine-strict`), `.nvmrc`, `files`/`scripts` blocks, coverage-guard, eslint flat + prettier, bin CJS wrapper with Node guard. `npm audit --omit=dev --audit-level=high` per push. | 0R |
| WP-1.2 | M | **Pure core.** `parseConfig(env, profilesJson?)` (CFG-1…8); Clock/Sleep/Random ports; session credit budget with atomic check-and-reserve (COST-1/2/3/5, CONC-2); policy resolution as pure data (POL-2/3/6). No I/O anywhere in `core/`. | 1.1 |
| WP-1.3 | M | **ToolDef registry + pipeline choke point.** Registry as data (`name, title, description, package, class, availability, scopes, endpointClass, annotations, input, handler`); one wrapper applying validation → policy → budget → rate-limit preflight; MCP annotations + denied-tool description annotations generated from it (POL-1/5/7, MCP-4). *Nothing registers a tool except through this.* | 1.2 |
| WP-1.4 | M | **`api/http`.** undici with injectable dispatcher; host-scoped Authorization + no-redirect-follow + proxy-env ignore (AUTH-14, CFG-7); per-request `X_MCP_TIMEOUT_MS`; GET-retry-once/writes-never (NET-3); non-JSON body tolerance (NET-1/2); rate-limit tracker (RATE-1…7, CONC-3). | 1.2 |
| WP-1.5 | M | **Error taxonomy + fixture corpus.** All classes incl. `forbidden`, `billing`, `budget`; `retryable` + `fix` + per-class remediation texts (DX-F13); partial-failure `missing[]` contract (REND-2); fixtures: 401, every 403 variant, 429, 200-with-`errors[]`, HTML 502 — each with provenance headers (DRIFT-2/4, REND-7 sentinel). | 1.3, 1.4 |
| WP-1.6 | L | **The nine read tools** in final merged shapes: `x_auth_status` (app-only degraded shape, AUTH-15), `x_rate_limit_status`, `x_post_get` (batch, ids/URLs), `x_user_get` (batch, ids/handles, `"me"` stub), `x_search_recent`, `x_post_counts_recent`. Identifier resolution + cache (REND-8); compact renders with `url`/`note_tweet`/`truncated`/`author`/`result_count`/zero-results note (REND-1…5, 9, 10); pagination contract (PAGE-1…5); untrusted-content pipeline (REND-6). | 1.5 |
| WP-1.7 | M | **MCP layer + process hygiene.** Server `instructions` (MCP-5); InMemoryTransport integration suite (MCP-2); spawn smoke via bin CJS asserting stdout purity (MCP-1); stdin-EOF/SIGTERM exit (MCP-3); `x-mcp-ai: fatal:` startup contract (CFG-5); launcher probe green (MCP-6). | 1.6 |
| WP-1.8 | S | **Live capture task.** With a real (cheap) credit account: capture the actual out-of-credits error body → lock the `billing` fixture (COST-6); spot-verify 3–4 read fixtures; ≤ 20 reads total, cleanup in `finally`. | 1.6 |

**Exit gate 1:** all `P1` corner cases referenced by passing tests; coverage gate at
family thresholds; CI green on all four OS legs incl. Windows; spawn smoke +
InMemoryTransport suites green; `billing` fixture is real, not guessed; tag
`v0.1.0` published over the placeholder via the tag-gated pipeline (exercises
release chain early — OPS-F2).

---

## Phase 2 — User context + writes *(0.2.0 → 0.x)*

The hardest code in the project lands here: the refresh state machine exactly as
specified in WP-0.2.

| WP | Size | Work | Depends on |
|---|---|---|---|
| WP-2.1 | L | **OAuth2 token manager.** Implements the WP-0.2 state machine: single-flight, cross-process lock, reload-under-lock, persist-before-use, stale-lock fail-closed, non-rotating tolerance, eager-refresh boundary (AUTH-1…12, CONC-1/4). TokenStore port with file backend; atomic tmp+rename incl. win32 semantics (PLAT-1/2). | Phase 1 |
| WP-2.2 | M | **`authorize` + `doctor` subcommands** in the bin dispatcher, compiled into `build/` so they ship (OPS-F4). Authorize per the security spec (AUTH-13) plus a `--manual` no-browser mode for headless machines (AUTH-16); doctor validates env/paths/perms, warns on synced-storage token paths (CFG-9), prints resolved auth+policy, optional one connectivity GET, exit 0/1 (OPS-F9). | 2.1 |
| WP-2.3 | L | **Write tools.** `x_post_create` (composite validation, weighted-length advisory, URL-cost warning, duplicate-403 semantics, timeout ambiguity + safe-probe text, thread-resume prose: POST-1…9, COST-4, NET-4); `x_post_delete` (idempotent-404); engagement `*_set` merges (like/repost/bookmark); `x_timeline_home`/`x_timeline_mentions`/`x_timeline_user` with time bounds + end_time clamp (REND-9). | 2.1 |
| WP-2.4 | S | **Policy becomes meaningful.** Presets `read-only`/`engage`/`publish`/`manage`/`full` live; denied-tool UX final (POL-4/7); `X_MCP_HIDE_DENIED`. | 2.3 |
| WP-2.5 | M | **Concurrency & crash test suite.** Two-process interleaved refresh via shared tmp token file (CONC-4); `kill -9` between refresh and persist → clean recovery on restart; fake-clock stale-lock matrix (AUTH-5/7). Rotation suite runs on the Windows CI leg. | 2.1 |

**Exit gate 2:** all `P2` corner cases referenced; e2e demo — authorize → post →
delete from a real MCP client; the two canonical refresh tests (one-refresh-for-N-401s,
waiter-adopts-disk-pair) plus kill-9 recovery green on all OS legs; changelog's
"Platform changes absorbed" section current after the boundary fact-check.

---

## Phase 3 — Full surface + 1.0.0

| WP | Size | Work | Depends on |
|---|---|---|---|
| WP-3.1 | M | Social graph + users: follow/mute/block `_set` (block = destructive), followers/following, `x_user_search` (`app+user`, registers by default, budget-guarded). | Phase 2 |
| WP-3.2 | M | Lists (post-merge: 10 tools incl. `x_list_timeline`, `x_list_members`), `x_list_delete` destructive. | Phase 2 |
| WP-3.3 | L | Media: chunked upload + `x_media_status`, full path-security battery, cancellation + progress notifications (MEDIA-1…7). | Phase 2 |
| WP-3.4 | M | DMs as redesigned: three event lookups + `x_dm_send`, minimized renders, opt-in bodies, retention note (DM-1…4); gated per POL-3/4. | Phase 2 |
| WP-3.5 | S | Availability registration mechanism + spaces/trends go/no-go. **Reframe (T-010 fact-check 2026-07-22):** full-archive search/counts, `x_user_search`, and WOEID trends are `app+user`-reachable under pay-per-use, so they **register by default** once Phase 3 ships (guarded by the credit budget), **not** behind an availability gate; the genuinely gated classes are `premium-user` (personalized trends), `pilot` (Community Notes), `enterprise` (>2M/compliance) — none of which has a v1 tool. This WP therefore delivers the class-gating machinery (for future premium/pilot/enterprise tools) plus the spaces/trends registration go/no-go. | 3.1 |
| WP-3.6 | M | OAuth1 signer **only if a concrete blocked use-case has appeared** (roadmap Q3: default is *drop*; media/DM v2 coverage has removed most of the old need). If built: OA1-1…4 + property tests. | Phase 2 |
| WP-3.7 | M | Operator polish: keychain backend (`X_MCP_TOKEN_KEYCHAIN`), profiles file (CFG-3/6), README operator checklist incl. bot-disclosure note (X-F13). | Phase 2 |
| WP-3.8 | M | **Modern MCP surface.** Tool `outputSchema` + `structuredContent` generated from the same render objects as the text content (REND-11) — output schemas join the public API; cancellation generalized to every in-flight HTTP call (MCP-7); parallel-call safety test (MCP-8). | Phase 2 |
| WP-3.9 | M | **Docs generation + drift gates.** User-facing tool reference generated from the registry; CI guard asserting registry ↔ docs/03 ↔ generated reference agreement (names, count, classes, availability) — same pattern as syncrona's docs-drift gate; CI **context-size guard**: serialized `tools/list` stays under a fixed byte budget so the standing context cost can never silently creep (DX-F1 made this a number worth defending). | 3.1–3.5, 3.8 |
| WP-3.10 | M | **Operator docs & repo hygiene.** README rewritten for users, not designers: per-client setup (Claude Desktop, Claude Code, VS Code, Cursor), troubleshooting, an explicit "this server spends real money" pricing section; privacy/data-handling statement (fetched content incl. DM bodies reaches the model host — SEC-F7); `SECURITY.md` vulnerability-disclosure policy; issue templates; client compatibility matrix verified against MCP Inspector + at least two real clients. | 3.9 |
| WP-3.11 | S | **Usage/credits tool go/no-go.** If WP-0.10's fact-check confirms a usage/credits endpoint under pay-per-use, ship `x_usage_get` (real platform spend beside the local session estimate — closes the loop on COST-1); otherwise drop it from the catalog with a dated note. | 0.10, Phase 2 |
| WP-3.12 | M | **Acceptance & hardening.** The three agent-DX walkthroughs (thread+image, mentions triage, most-engaged) scripted as e2e scenario tests over fixtures; scheduled fuzz job on tool inputs (QA-F15) + one informational mutation-testing run over `core/*` (QA-F14); **implementation re-audit against the threat model** — walk T1–T17 and kill-chains A–D against the real code, not the design; ≥ 1 week of dogfooding as a daily driver. | 3.1–3.10 |
| WP-3.13 | S | **1.0.0 release.** Full chain: tag → publish `--provenance` → `publish-mcp.yml` → MCP registry with `isSecret` env markers; `server.json` lockstep guard green; contract-fixture suite frozen as the semver baseline; placeholder README replaced; version pins in README dropped (1.0 floats). | 3.1–3.12 |

**Exit gate 3:** all `P3` corner cases referenced; drift and context-size CI gates
green; compatibility matrix documented; scenario suite and threat-model re-audit
done; 1.0.0 on npm with provenance badge and the registry listing verified. The
"1.0 acceptance checklist" below is the gate's full definition.

## Phase 4 — Exploratory *(post-1.0, demand-driven)*

Unordered candidates, each entering only with a real use-case: X Activity API
webhooks (replaces the old filtered-stream idea), News endpoints, Community Notes
API (pilot), bookmark folders, post/media analytics, Streamable HTTP transport, MCP
prompts, `.mcpb` Desktop bundle (OPS optional). Each candidate repeats the
fact-check rule first — this is the fastest-moving part of the platform.

---

## 1.0 acceptance checklist

Consolidated definition of "done" for `v1.0.0` — everything here is covered by a WP
above; this is the single list to walk before tagging:

- [ ] Every corner case in [07-corner-cases.md](07-corner-cases.md) has a
      referencing test or a dated won't-fix edit (standing rule 1).
- [ ] Docs-drift gate green: registry ↔ docs/03 ↔ generated tool reference agree.
- [ ] Context-size gate green: `tools/list` serialization under the fixed cap.
- [ ] Security re-audit of the **implementation** against T1–T17 + kill-chains A–D.
- [ ] Client compatibility matrix: MCP Inspector, Claude Desktop, Claude Code,
      ≥ 1 third-party client.
- [ ] Scenario suite (walkthroughs A–C) green; ≥ 1 week dogfood without a P1 issue.
- [ ] `LICENSE`, `SECURITY.md`, privacy/data-handling statement, per-client setup
      docs, pricing warning — all published.
- [ ] CHANGELOG complete incl. "Platform changes absorbed"; token-file migration
      and tool-deprecation policies documented.
- [ ] Final platform fact-check (`llms.txt` + changelog) dated within release week.
- [ ] npm provenance badge + MCP registry listing verified; `server.json` lockstep
      guard green.

## Resolved open questions (from the old roadmap)

1. **Budget?** Yes — session-scoped **credit** budget in Phase 1, no API seeding
   (WP-0.1, WP-1.2).
2. **Denied tools?** Registered + annotated + no unlock hint for sensitive cells +
   `X_MCP_HIDE_DENIED=1` (WP-0.4; ratified over the architect's hide-by-default).
3. **OAuth1?** Phase 3, default **drop** unless a blocked use-case materializes
   (WP-3.6).
4. **npm name?** `x-mcp-ai`, reserved in WP-0.9 — this week, not "later".

## Top risks

| Risk | Mitigation |
|---|---|
| Platform pricing/endpoints drift again mid-build | Standing rule 2 (per-boundary fact-check) + fixture provenance + CHANGELOG "Platform changes absorbed" |
| Refresh-rotation bug locks the dev account during Phase 2 | State machine specified before code (WP-0.2); two-process + kill-9 suite (WP-2.5); dedicated dev account, never a personal one |
| Pay-per-use makes live testing expensive | Live suite spend rules (≤ 20 reads, no archive endpoints); everything else on fixtures/MockAgent |
| Windows regressions land late | Windows CI leg + rotation tests on it from WP-1.1/WP-2.5, not a Phase-3 cleanup |
| Scope creep past ~46 tools re-inflates agent context | Registry-as-data makes the count a tested number; new tools require a catalog row + phase tag first |
