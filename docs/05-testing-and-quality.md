# 05 — Testing & quality

Mirrors the servicenow-mcp-ai quality bar: `node --test`, `c8` coverage gates,
eslint + prettier, a `verify` pipeline for every change and a `check` pipeline for
release. This document also owns two policies the corpus needs before code starts:
the **testability seams** every high-risk behavior depends on (§2), and the
**release & versioning policy** (§8) that turns "the public API" into an enforced
contract. Corner-case IDs referenced below are normative in
[07-corner-cases.md](07-corner-cases.md); phase sequencing is in
[08-implementation-roadmap.md](08-implementation-roadmap.md); the task-level owners
in parentheses (`T-1xx`) are from
[09-parallel-execution-plan.md](09-parallel-execution-plan.md).

## 1. Test layers

| Layer | Scope | Doubles | Where |
|---|---|---|---|
| **Unit — core** | `core/*`: policy resolution, config/zod parsing, session budget math, render/sanitize shapes, field presets, error taxonomy, pagination clamp | none (pure) | `test/core-*.test.js` |
| **Unit — api** | endpoint wrappers, oauth2 refresh/rotation/locking, oauth1 signing *(P3, if kept)*, rate-limit table, retry policy | `undici` `MockAgent` (built into Node ≥ 20) | `test/api-*.test.js` |
| **Property-based (fast-check)** | encoding/ordering/algebra invariants: oauth1 signature base string *(P3)*, policy resolution (deny-wins, idempotent), `max_results` clamping across arbitrary integers | none / `MockAgent` | `test/prop-*.test.js` |
| **Tool-level** | each tool end-to-end inside the process: input schema → pipeline → rendered output / typed error | `MockAgent` fixtures | `test/tools-*.test.js` |
| **Contract fixtures** | recorded real v2 response JSON (sanitized) per endpoint, asserted against render output — catches API drift when refreshed (DRIFT-1/4) | fixture files w/ provenance | `test/fixtures/**` |
| **MCP integration** | a real `@modelcontextprotocol/sdk` `Client` connected to the real server object over `InMemoryTransport`: `tools/list` schemas + annotations + `instructions`, representative `tools/call` round-trips, denied-tool-as-result, parallel calls (MCP-2/4/5/8) | `InMemoryTransport` + `MockAgent` | `test/mcp-*.test.js` |
| **Spawn smoke** | spawn the CJS `bin` over real stdio, `initialize` + `tools/list`; assert **every stdout byte is a JSON-RPC frame** at the most verbose log level (MCP-1); a second job runs it through the packed tarball, not the repo layout | real process, no HTTP | `test/mcp-spawn.test.js` |
| **Live (gated, spend real money)** | `npm run inspector` / tagged tests behind `X_MCP_LIVE_TEST=1` against a **dedicated pay-per-use test account** — never in CI, spend-capped (§6) | real API | `test/live/**` |

The MCP integration and spawn-smoke layers close the gap the QA review flagged
([reviews/04-qa-review.md](reviews/04-qa-review.md) F1): every other layer stops
below the MCP boundary, so tool registration, JSON-schema emission from zod,
denied-tool-still-registered rendering, and stdout wire-purity were untested. The
InMemoryTransport harness also answers roadmap Open Question 2 (does the
registered-but-denied approach confuse clients?) empirically during Phase 1. Both
layers are wired in `mcp/` + `index.ts` (T-130) on the harness helpers in
`test/helpers/` (T-103).

## 2. Injection seams (the testability contract)

Every high-risk behavior in this server is **time-based or I/O-based**, so it must
be injectable — a test that really sleeps or really reads the wall clock either
can't assert the timing or is flaky. These seams are **frozen contracts**
([09](09-parallel-execution-plan.md) §3, defined in `core/ports.ts` /
`core/tooldef.ts` by T-102) precisely because retrofitting clock injection into
`api/oauth2` after the fact is the refactor that destabilizes the hardest code in
the project. They must exist before Phase 1 scaffolding, not as a Phase 2 cleanup.

| Seam | Shape | Injected into | Makes testable (IDs) |
|---|---|---|---|
| **Clock** | `now(): number`, default `Date.now` | `api/oauth2` (expiry, eager-refresh boundary, stale-lock age), `api/ratelimit` (reset comparisons, preemptive refusal), `core/budget` | AUTH-5/7, RATE-2/3, PLAT-4 |
| **Sleep** | `sleep(ms): Promise<void>`, instant-resolve fake asserts the requested duration | 429 ≤ 5 s GET retry, jittered backoff, media `STATUS` polling — **no bare `setTimeout` in business logic** | RATE-5, NET-3, MEDIA-3 |
| **Random** | `random(): number`, default `Math.random`, pinned in tests | backoff jitter (250–750 ms bounds asserted exactly). *PKCE/`state` entropy uses `crypto`, not this seam* | NET-3, boundary at 250/750 ms |
| **TokenStore** | `{ load(); save(tokens); lock(); unlock() }`, fs backend default | `api/oauth2` — splits pure rotation from persistence; a fake whose `save` throws mid-rename simulates the crash **between refresh and persist** deterministically (not kill-9 folklore) | AUTH-1/9, PLAT-1/2, CONC-4 |
| **dispatcher** | optional undici `dispatcher` option on `api/http`, not only `setGlobalDispatcher` | HTTP client — tests stop sharing mutable global state; the MCP-integration layer runs a fully-wired server against a `MockAgent` in-process | AUTH-14, NET-1/2/3, PAGE-5 |
| **parseConfig** | `parseConfig(env, profilesJson?)` — never reads `process.env` internally | startup — config tests don't mutate process state | CFG-1…9 |
| **registry-as-data** | the `ToolDef` array (`name, title, description, package, class, availability, scopes, endpointClass, annotations, input, handler`) | drives generated tests: a tool missing a classification **fails the suite structurally** | POL-1, MCP-4, PAGE-5 |

The `kill -9` recovery test (Phase 2, T-206) stays as a manual complement to the
TokenStore-fake crash-window tests, not as their only coverage.

## 3. What must be tested exhaustively (risk-ranked)

1. **OAuth2 rotation** (T3 — account-lockout risk, the roadmap's "hardest code"):
   persist-before-use ordering (AUTH-1); single-flight for N concurrent 401s →
   exactly one token-endpoint call (AUTH-2, CONC-1); reload-under-lock / adopt
   on-disk pair (AUTH-3/4); stale-lock fail-closed, never break-and-refresh
   (AUTH-5); non-rotating tolerance (AUTH-6); eager-refresh boundary at 4:59 / 5:01
   via fake Clock (AUTH-7); refresh rejection is terminal, applied once (AUTH-8);
   corrupt/partial token file (AUTH-9); two processes sharing a token file, no
   lockout, no double refresh (CONC-4); Windows rename semantics (PLAT-1).
2. **Policy matrix**: every (tool × preset × override) from the registry-as-data
   (POL-1) — a tool missing classification fails the suite; deny-beats-allow for
   every cell (POL-2); `write:dm` reachable only by explicit override (POL-3);
   `read:dm` excluded from the default preset (POL-4); destructive classifications
   consistent with the taxonomy (POL-5); invalid cells refuse startup (POL-6);
   denied tools stay registered + annotated + terminal, sensitive cells carry **no**
   unlock hint (POL-7).
3. **Rate-limit behavior**: per-context tracking (RATE-1); preemptive refusal with
   no HTTP call (RATE-2); past-reset proceeds with skew allowance (RATE-3); missing
   headers leave state unchanged (RATE-4); 429 — GET retries once ≤ 5 s via fake
   Sleep, writes never (RATE-5); dual 15-min/24-h windows named in the error
   (RATE-6); `retry-after` vs reset disagreement → later wins (RATE-7); concurrent
   updates are last-reset-wins (CONC-3).
4. **Error taxonomy mapping** — including the unhappy-parser paths: canned
   401 / every 403 variant / 429 / 200-with-`errors[]` / 400 bodies → the correct
   typed class (`auth`, `forbidden`, `rate-limit`, `policy`, `budget`, `billing`,
   `validation`, `not-found`, `api`, `network`) with the correct actionable
   message. Unknown codes degrade to `api` with platform `title`/`detail`
   (DRIFT-2); `forbidden` (duplicate-403, closed DMs) is distinct from unexpected
   `api` (POST-3, DM-4); HTML 502 / truncated JSON / empty body never crash the
   parser and never leak raw HTML (NET-1); socket errors map to `network` with
   distinct `detail` (NET-2). The real out-of-credits `billing` body is a **live
   capture**, not guessed (COST-6, §6).
5. **Render shapes & partial results**: zero-results note (REND-1); partial
   failures as `missing[]` with reasons (REND-2); long posts never silently
   truncated (REND-3); canonical `url` on every post (REND-4); degraded `includes`
   per-field, never a whole-item drop (REND-5); identifier resolution on input
   (REND-8); ISO-8601 UTC + `end_time` clamp (REND-9); `raw: true` capped at 25
   (REND-10).
6. **Untrusted content & secret redaction**: the per-result untrusted-content note
   on **all** third-party text (bios, display names, handles, DM bodies), inbound
   zero-width/bidi stripping, length caps — never applied to the user's own
   outbound text (REND-6, POST-1); a sentinel sweep asserting no post/DM text, bio,
   or token material ever appears in a thrown error or log line at any level
   (REND-7).
7. **Session budget**: operator-set, model-immutable, no per-call override
   (COST-1); unseeded, counts the static cost table locally (COST-2); `cost_usd` +
   running total in every result (COST-3); URL-post $0.20 warned distinctly
   (COST-4); atomic check-and-reserve so two interleaved calls at remaining ≈ 1
   cannot both pass in `hard` mode (COST-5, CONC-2).
8. **Pagination**: opaque round-trip tokens (PAGE-1); bad/expired token →
   `validation`, never `api` (PAGE-2); `max_results` clamped both directions with
   the effective value noted (PAGE-3); last page omits `next_token` (PAGE-4);
   **exactly one HTTP request per list call** asserted on the mocked dispatcher for
   every registry list tool — the mechanical proof of the no-auto-pagination
   promise (PAGE-5).
9. **MCP protocol & process hygiene**: stdout carries only JSON-RPC (MCP-1);
   InMemoryTransport round-trips (MCP-2); stdin-EOF / SIGTERM clean exit, EPIPE no
   crash-loop (MCP-3); annotations match classification (MCP-4); `instructions`
   carry the conventions (MCP-5); ancient-Node launcher guard (MCP-6); cancellation
   aborts in-flight HTTP everywhere (MCP-7, P2); parallel `tools/call` safe under
   interleaving (MCP-8).
10. **media_upload** *(Phase 3)*: v2 dedicated paths only (MEDIA-1); chunk-boundary
    sizes and zero-byte refusal (MEDIA-2); upload vs processing as separate calls
    (MEDIA-3); failed-processing error (MEDIA-4); the full **path-security battery**
    — default-deny `X_MCP_MEDIA_DIR`, `realpath`, `O_NOFOLLOW`, same-fd sniff, `../`
    and symlink rejection (MEDIA-5); magic-byte vs extension mismatch (MEDIA-6);
    cancellation mid-APPEND (MEDIA-7).
11. **Cross-platform** (all on the Windows CI leg, §7): rename atomicity and
    perms/`O_NOFOLLOW` win32 branches (PLAT-1/2); backslash/drive-letter/`%APPDATA%`
    paths (PLAT-3); sleep/resume recompute-on-use, no long-lived timers (PLAT-4).

## 4. Coverage gates

`test:coverage` runs c8 `--check-coverage --lines 90 --branches 80 --functions 95`
to start, ratcheting **up** toward the servicenow-mcp-ai family thresholds
(94 / 82 / 97); the ratchet **never** goes down. Three mechanical additions the QA
review requires ([reviews/04-qa-review.md](reviews/04-qa-review.md) F8):

- **`--per-file`** with a per-file lines floor (e.g. 80) so an entirely untested new
  file cannot ride in on over-covered neighbors.
- **Port `scripts/coverage-guard.mjs`** from the family — the coverage-guard port
  makes the ratchet and the new-file floor mechanical, not a discipline someone has
  to remember. This is the family-threshold guard the exit gates check.
- **Per-module floors**: `core/policy` and `core/budget` at **100 / 100 branches**
  from day one — pure, small, and security-load-bearing, so there is no excuse.
- **`src/index.ts` is excluded** from unit coverage and covered by the §1
  spawn-smoke instead of chasing entrypoint lines.

## 5. Fixture provenance & refresh discipline

Fixtures are sanitized recordings (ids scrambled, handles fictional) or, where the
data is private or the endpoint is unavailable to the test account, **synthetic**.
DM fixtures are always synthetic — never recorded — and are generated from the X
API v2 OpenAPI shapes, not free-typed.

- **Provenance header** on every fixture (DRIFT-4): `{recorded_at, endpoint,
  availability, auth_context, sanitized: true | synthetic}`. The fixture loader
  (T-103) asserts the header is present and well-formed; the test suite **prints**
  (does not fail on) a staleness report so ageing fixtures are visible.
- **Monthly refresh** (not "on demand"): a scheduled GitHub Actions workflow runs
  `scripts/refresh-fixtures.mjs` against the live account for every *recordable*
  endpoint and opens a PR when diffs appear — so platform drift arrives as a
  readable diff, not silent breakage. A refresh no older than 30 days is a release
  checklist item. "Recordable" is bounded by both **availability** (the account can
  reach the endpoint) and **spend** — archive/full-archive endpoints are excluded
  from routine refresh because they are expensive (§6).
- **Synthetic-only list**: docs/05 keeps an explicit list of endpoints that are
  synthetic-only under the current account availability (DMs always; archive/premium
  until the account can reach them). Those are validated against the official X API
  v2 OpenAPI specification in a dedicated `fixtures-schema` test so hand-written
  fixtures at least conform to the declared contract. One manual live-DM
  verification (test account ↔ second test account) is a release-checklist item
  once availability allows it.

## 6. Live-suite spend rules

The platform is **pay-per-use** — a careless live run spends real credits (README
carries the "spends real money" warning). Live tests are gated behind
`X_MCP_LIVE_TEST=1`, never run in CI, and obey hard spend discipline
([reviews/04-qa-review.md](reviews/04-qa-review.md) F9; WP-1.8 / T-132):

- **≤ 20 read units per run**, enforced by the suite itself via `core/budget` in
  `hard` mode (dogfooding the budget). The suite stops before the cap, it does not
  merely report crossing it.
- **No archive / full-archive endpoints** (`x_search_archive`,
  `x_post_counts_archive`) in the live suite — they are the expensive reads; keep
  them on synthetic fixtures.
- **Live writes only against the dedicated test account** (never a personal
  account), always followed by cleanup (`x_post_delete`, etc.) in a **`finally`** so
  a mid-test failure never leaves public posts behind.
- **Every run ends by printing the session budget summary** (and `x_usage_get` if it
  ships — go/no-go in T-317).
- **The one required live capture**: the real out-of-credits `billing` error body
  (COST-6). It is a named Phase 1 live-test task and a **human checkpoint** (real
  credits) — after capture the fixture and mapping are locked and everything else
  stays on fixtures / `MockAgent`.

## 7. Pipelines & CI matrix

- `npm run verify` = build + lint + format:check + tests — required before every
  commit.
- `npm run check` = verify + coverage gates + `npm audit --omit=dev
  --audit-level=high` — required for release; wired as `prepublishOnly`.
- `npm run release:dry` — packs the tarball and reviews its size/contents before a
  real publish.
- Lockfile committed; CI installs with `npm ci` everywhere; `.npmrc`
  (`engine-strict=true`) and `.nvmrc` carried over from the family. Dependabot
  weekly (minor+patch grouped, majors separate; npm + github-actions). CodeQL with a
  weekly cron. `npm audit` runs on **every push/PR** (F1f), not only inside `check`,
  so an advisory in a transitive dep surfaces within a day rather than at the next
  release attempt.

**CI matrix** — the roadmap's **four OS legs incl. Windows** plus the launcher
probe (docs/08 WP-1.1; T-101 owns `ci.yml`):

| Leg | OS | Node | Runs |
|---|---|---|---|
| 1 | ubuntu-latest | 20 | full `check` |
| 2 | ubuntu-latest | 24 | full `check` + coverage-guard ratchet + Codecov upload |
| 3 | macOS-latest | 22 | full `check` |
| 4 | **windows-latest** | 22 | full `check` **incl.** the token-store persistence / locking / perms suite — rotation, tmp+rename atomicity, `0600` warning, `.lock` semantics, two-process interleave (PLAT-1/2/3, AUTH-5/7/12, CONC-4). Not skipped — this is the platform where the highest-risk module is most likely to break. |
| probe | ubuntu-latest | **12** | **launcher-node12**: the CJS `bin` on ancient Node prints a human-readable version message, not a `SyntaxError` (MCP-6 / OPS-F1) — asserted, not assumed. |

Node **20 / 22 / 24** are all covered across legs 1–4; the ubuntu leg also uploads
coverage and drives the ratchet. One CI job additionally runs the §1 spawn smoke
through the **packed tarball** (`npm pack` + run from the tarball) so the published
artifact — not the repo layout — is what is smoke-tested (F16). No live tests in CI.

## 8. Release & versioning policy

The consumers of this package are **agent configurations** — tool names live in
prompts, allow-lists, hooks, and CI automations; env-var names live in
`claude_desktop_config.json` files nobody revisits. An unpinned distribution channel
plus an undefined breaking-change policy is how you break every user with one
publish. This section is the enforced contract (docs/08 standing rule 4;
[reviews/05-devops-review.md](reviews/05-devops-review.md) F2/F3/F4/F8/F9).

### 8.1 The public API (the semver surface)

The public API is, exactly: **tool names + tool input schemas + rendered output
shapes + typed error codes + env-var names/semantics + policy preset meanings + CLI
subcommands/exit codes + the token-file format.** When `outputSchema` /
`structuredContent` is adopted (WP-3.8, REND-11), the output schemas join this
surface. Contract-fixture tests enforce that changes to it are **additive only**
between majors.

### 8.2 SemVer rules against that surface

- **MAJOR** — remove or rename a tool; remove or repurpose an input field; change a
  preset's allowed cells or the **default** preset; remove/rename an env var; change
  an error `code`; change the token-file format without an automatic forward
  migration; drop a supported Node major.
- **MINOR** — add tools; add optional inputs; add output fields (additive only); add
  env vars, presets, or CLI subcommands; raise an **availability**/scope requirement
  only when the platform forces it (called out in the changelog — see §8.4).
- **PATCH** — fixes, error-message wording, dependency bumps with no behavioral
  change, docs.

### 8.3 0.x → 1.0.0 plan

**0.x through Phases 1–2**, with the stated convention "0.MINOR bumps may break".
**1.0.0 at Phase 3 exit** (tool-catalog parity), matching the roadmap. `v0.1.0`
publishes over the WP-0.9 placeholder via the tag-gated pipeline, exercising the
release chain early. From 1.0.0 on, a tool rename keeps the old name registered as a
deprecated alias for at least one full major (see §8.8).

### 8.4 CHANGELOG

`CHANGELOG.md` in Keep-a-Changelog format; an entry is **mandatory** for every
tagged release. Every release carries a **"Platform changes absorbed"** section
recording the per-phase-boundary fact-check outcome (docs/08 standing rule 2):
because X shifts caps/pricing/endpoints under the server, an availability/cap change
that alters which tools *work* (not their schema) is PATCH or MINOR — **never
silent**.

### 8.5 Release mechanics

Releases happen **only** via a `v*` tag pushed to GitHub — laptop publishing is
prohibited (a first release from a laptop permanently lacks provenance
attestations).

1. Bump `package.json` **and** `server.json` (+ the lockstep guard below), update
   `CHANGELOG.md`, commit, tag `vX.Y.Z`, push the tag.
2. `publish.yml`: `npm ci` → **tag == `package.json` version guard** → `npm run
   check` → `npm publish --provenance --access public` (OIDC `id-token: write`).
   Prefer npm **Trusted Publishing** (registry-side OIDC bound to repo+workflow)
   over a stored `NPM_TOKEN`; if a token is unavoidable, scope a granular automation
   token to this one package. `prepublishOnly: npm run check` remains the backstop.
3. `publish-mcp.yml` chained via `workflow_run` → `mcp-publisher login github-oidc`
   → `publish`, marking secret env vars `isSecret: true` so registry UIs mask them.
4. **Dist-tags**: `latest` = stable only; pre-releases (`1.1.0-rc.0`) go to `next`
   and are never what `npx -y x-mcp-ai` resolves.

**`server.json` lockstep guard** — a cheap CI assertion (in `ci.yml` / `publish.yml`)
that `package.json.version === server.json.version ===
server.json.packages[0].version` and `package.json.mcpName === server.json.name`.
The family had a real version-skew incident; this guard prevents it.

### 8.6 The `bin` subcommand dispatcher

The published `bin` is the family CJS wrapper (Node-version guard, then dynamic
`import('build/cli.js')`) acting as a subcommand dispatcher — everything ships
inside `build/`, because the `files` whitelist is `["build", "bin"]` and `scripts/`
is **not** published (OPS-F4: the old design told users to run a subcommand that did
not exist in the npm artifact):

| Invocation | Effect | Exit |
|---|---|---|
| *(no args)* | start the stdio server — the MCP-client default, unchanged | runs until stdin EOF / SIGTERM (MCP-3) |
| `authorize` | PKCE localhost flow (CSRF `state`, one-shot loopback, `--manual`); AUTH-13/16 | `0` on success, non-zero on failure |
| `doctor` | validate env/paths/perms, warn on synced storage (CFG-9), print resolved auth+policy, optional one connectivity GET | `0` healthy / `1` problem |
| `--version` / `--help` | trivial but essential for support threads | `0` |

`x-mcp-ai <subcommand>` is a reserved namespace — tool docs never conflict with it.
`scripts/authorize.mjs` may remain as a dev-checkout shim that calls the same
compiled module.

### 8.7 Token-file format & migration rule

The token file carries a `"version"` field from the first write (its shape is part
of the public API, §8.1). Migration is **forward-only and never guesses**:

- File `version` **<** what the server understands → migrate forward automatically on
  load/next write.
- File `version` **>** what the server understands → **refuse to start** with a typed
  `auth` error naming the file and instructing the operator to upgrade the server.
  The server never downgrades, never overwrites, and never guesses the newer shape —
  a newer file means a newer server rotated it, and guessing risks resurrecting a
  rotated-out refresh token and locking the account (T-202 / AUTH-9).

### 8.8 Tool-deprecation flow (post-1.0)

Deprecating a tool after 1.0.0 is a two-release process:

1. Append a deprecation note to the tool's `description` (and MCP annotations) for
   **at least one full minor release** — the tool keeps working; agents see the
   notice in `tools/list`.
2. Actual removal or rename lands **only at the next major**. A rename additionally
   keeps the old name registered as a deprecated alias for at least one full major.

### 8.9 Distribution ergonomics: pins & logs

**README version pins during 0.x** (T-015 owns the README edit; this is the policy):
the quick start pins an exact version or `~0.N` during 0.x, and `x-mcp-ai@^1` once
1.0.0 exists, with an explicit sentence that an unpinned `npx -y x-mcp-ai` means
silent upgrades on every client cold-start. Pins are dropped at 1.0.0 (1.x floats).

**"Where are the logs?"** — a fatal startup error emits one plain-text (not JSON)
`x-mcp-ai: fatal: <reason>` line to stderr and exits non-zero immediately (CFG-5,
the client owns respawn). Inside a client that report is easy to miss, so `doctor`
is the offline diagnostic path and the README carries this table:

| Client / OS | Where stderr lands |
|---|---|
| Claude Desktop — macOS | `~/Library/Logs/Claude/mcp-server-x.log` |
| Claude Desktop — Windows | `%APPDATA%\Claude\logs\mcp-server-x.log` |
| Claude Desktop — Linux | `~/.config/Claude/logs/` |
| Claude Code | client MCP log (`claude --debug`) |
| any client | `npx x-mcp-ai doctor` — human-readable diagnostics to **stdout**, exit 0/1 |
