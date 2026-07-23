# DevOps & release review — x-mcp design corpus

- **Reviewer role**: senior DevOps / release engineer (npm publishing, GitHub Actions,
  supply-chain security, CLI/MCP-server distribution).
- **Date**: 2026-07-21
- **Scope**: README.md + docs/01–06, reviewed strictly from the packaging /
  distribution / CI / release / operability perspective. Family baseline verified
  against the actual `servicenow-mcp-ai` repo (package.json, `bin/servicenow-mcp-ai.cjs`,
  `server.json`, `.github/workflows/{ci,codeql,publish,publish-mcp}.yml`,
  `.github/dependabot.yml`).
- **Overall verdict**: **approve-with-changes.** The runtime design is operationally
  sound (stdio-only, no daemon, no database, typed errors, stderr JSON logging), and
  the family it mirrors already has a proven release pipeline. But the DevOps surface
  of the corpus is underspecified relative to that proven baseline, and it contains
  three internal inconsistencies (authorize UX vs `scripts/`, the dependency-count
  claim, token-file pathing) that will bite at release time if not resolved in the
  docs now. Nothing here requires redesign — it requires writing down what the
  sibling project already does, plus a handful of X-specific additions.

---

## Strengths

1. **The family baseline is real, not aspirational.** servicenow-mcp-ai (npm `2.0.1`,
   live on the registry) already runs: Node 20/22/24 matrix + macOS leg + dedicated
   Windows job, a `launcher-node12` probe for the CJS bin guard, CodeQL with weekly
   cron, weekly grouped Dependabot (npm + github-actions), Codecov upload,
   `npm audit --omit=dev --audit-level=high` in CI, tag-gated `npm publish
   --provenance` from CI only with a tag==version guard, and MCP-registry publication
   chained via `workflow_run` + `mcp-publisher` with GitHub OIDC. x-mcp inherits a
   working template — the cost of "doing it right" is near zero.
2. **Operational footprint is minimal by design** (docs/02 §1): stdio transport, env
   config, no persistent state beyond the token file. That is the right shape for an
   `npx`-launched server — nothing to migrate, nothing to back up except tokens.
3. **Typed error taxonomy** (docs/02 §5.5) is as valuable for operators as for
   agents: `auth`/`scope`/`tier`/`rate-limit`/`policy` errors that name the missing
   scope, tier, or env var turn most support questions into self-service.
4. **Logging rules are correct for MCP** (docs/02 §9): stderr only, single-line JSON,
   startup banner with the resolved policy matrix and auth mode. The
   never-log-bodies/tokens/DM-text rule (docs/04 §6) is the right privacy default.
5. **Token rotation design** (docs/04 §4) — atomic tmp+rename, advisory lockfile,
   fail-closed on 401-after-refresh — is the hardest operational problem in this
   server and the design treats it with appropriate seriousness, including the
   `kill -9` exit criterion in the roadmap (Phase 2).
6. **Release hygiene instincts are present**: `check` wired as `prepublishOnly`,
   audit gate in `check`, fixtures refreshed as reviewed diffs (docs/05 §5), and the
   roadmap explicitly defers `1.0.0` until catalog parity (Phase 3).
7. **Roadmap open question 4** already flags npm-name confirmation as a Phase-0/1
   task — answered below (available).

---

## Findings

### F1 — MAJOR — docs/05 §4: CI design is below the family's own proven baseline

**Problem.** docs/05 §4 specifies only "`check` on Node 20 + 22, macOS + ubuntu; no
live tests in CI". The sibling repo's actual `ci.yml` is substantially stronger:
Node 20/22/**24** on ubuntu + one macOS leg, a **dedicated Windows job**, a
**launcher-node12 probe** (asserts the CJS bin prints a human Node-version message
instead of a SyntaxError on ancient Node), a coverage-ratchet leg, Codecov upload,
and an audit step. None of CodeQL, Dependabot, or the Windows job appear anywhere in
the x-mcp corpus. For x-mcp specifically, **Windows CI is more important than it was
for servicenow-mcp**, because the riskiest code — token-file persistence
(tmp+rename atomicity, `0600` permissions, `.lock` files, `~` expansion) — is
exactly the code with platform-divergent semantics (see F5). A macOS+ubuntu-only
matrix would leave the highest-risk module untested on the platform where it is most
likely to break.

**Recommendation.** Rewrite docs/05 §4 to adopt the family `ci.yml` wholesale and
name the deltas: (a) ubuntu × Node 20/22/24 + macOS/22 + windows/22 legs; (b) the
`launcher-node12` bin probe (copy it verbatim — the wrapper is identical); (c) the
token-store unit tests (rotation, locking, perms warning) must run on the Windows
leg, not be skipped there; (d) CodeQL workflow with weekly cron; (e) Dependabot
weekly, minor+patch grouped, majors separate, npm + github-actions ecosystems;
(f) `npm audit --omit=dev --audit-level=high` as a CI step, not only inside `check`.

### F2 — MAJOR — No release workflow is designed anywhere in the corpus

**Problem.** docs/05 covers the *quality* pipeline but not the *release* pipeline.
docs/06 Phase 3 says only "npm publish + MCP registry (`server.json`, `mcpName:
io.github.IvanBBaev/x-mcp-ai`)". Nothing specifies: publish-from-CI-only, the
tag==`package.json` version guard, `npm publish --provenance --access public` with
`id-token: write`, the `NPM_TOKEN` handling, or the MCP-registry chain
(`workflow_run` on the Publish workflow → `mcp-publisher login github-oidc` →
`publish`). All of this exists, working, in the sibling's `publish.yml` and
`publish-mcp.yml`. Leaving it undesigned invites a first release published from a
laptop without provenance — which then permanently lacks attestations for that
version.

**Recommendation.** Add a "Release pipeline" subsection to docs/05 (or a short
docs/07-release.md) committing to: releases happen **only** via a `v*` tag pushed to
GitHub; `publish.yml` runs `npm ci` → tag/version guard → `npm run check` →
`npm publish --provenance --access public` (OIDC `id-token: write`); prefer npm
**Trusted Publishing** (registry-side OIDC binding to the repo+workflow) over a
long-lived `NPM_TOKEN` secret if the account supports it — if a token must be used,
make it a granular automation token scoped to the one package; `publish-mcp.yml`
chained via `workflow_run` exactly as in the sibling. Also carry over the
`prepublishOnly: npm run check` backstop and `release:dry` script.

### F3 — MAJOR — No versioning, changelog, or tool-name-stability policy; README quick start floats on `latest`

**Problem.** The corpus nowhere defines a semver policy, a changelog convention, or
what "stable once shipped" (docs/03 conventions: tool names are "stable once
shipped") means across versions. Meanwhile the README quick start is
`"args": ["-y", "x-mcp-ai"]` — an **unpinned** npx invocation, meaning every
Claude Desktop cold start silently pulls the newest published version. For a server
whose consumers are *agent configs* (tool names baked into prompts, allow-lists,
hooks, and CI automations), an unpinned distribution channel plus an undefined
breaking-change policy is how you break every user simultaneously with one publish.

**Recommendation.** Adopt the concrete policy in the "Proposed release & versioning
policy" section below, add it to the corpus (docs/05 or a release doc), and change
the README example to a major-pinned invocation (`"x-mcp-ai@^1"` once 1.0.0 exists;
during 0.x, pin exact or `~0.N`). Add a `CHANGELOG.md` requirement from the first
tagged release.

### F4 — MAJOR — `authorize` ergonomics are internally inconsistent and the flow as designed does not ship in the npm package

**Problem.** docs/04 §4.4 specifies the auth-failure message: *"token
expired/revoked — run `npx x-mcp-ai authorize`"*. But docs/01 §2.1 and docs/04 §4.1
place the PKCE flow in `scripts/authorize.mjs`, and the family npm `files` whitelist
is `["build", "bin"]` — **`scripts/` is not published**. As designed, the error
message tells the user to run a subcommand that does not exist, and the actual
helper is only available from a git checkout. This is the single worst
first-run-experience trap in the corpus: OAuth 2.0 users (the *primary* auth mode)
cannot complete setup from the npm artifact at all.

**Recommendation.** Make the bin a tiny subcommand dispatcher (still the family CJS
wrapper doing the Node-version guard, then dynamic-import of `build/cli.js`):

- no args → start the stdio server (unchanged default, MCP-client compatible);
- `authorize` → the PKCE localhost flow, compiled into `build/` so it ships;
- `doctor` (see F9) → config/auth diagnostics;
- `--version` / `--help` → trivial but essential for support threads.

Update docs/01 §2.1 and docs/04 §4 to reference `npx x-mcp-ai authorize` as the one
canonical path; `scripts/authorize.mjs` can remain as the dev-checkout shim that
calls the same module. Reserve `x-mcp-ai <subcommand>` namespace now so tool docs
never conflict with it.

### F5 — MAJOR — Token-file path and permission semantics are not cross-platform as specified

**Problem.** Three distinct issues:

1. **Tilde expansion.** README's quick start sets
   `"X_MCP_TOKEN_FILE": "~/.config/x-mcp/tokens.json"`. Claude Desktop passes env
   values verbatim and Node does not expand `~` — unless `core/config` expands it
   explicitly, the server will create a literal `./~/.config/...` path or fail.
   The corpus never says who expands it.
2. **Windows default location.** `~/.config` is a Linux/XDG convention; on Windows
   the correct home is `%APPDATA%\x-mcp\` and on macOS arguably
   `~/Library/Application Support/x-mcp/` (though `~/.config` is acceptable for CLI
   tools). No default path is defined at all — `X_MCP_TOKEN_FILE` appears mandatory,
   which is one more required env var for the primary auth mode.
3. **`0600` semantics.** docs/04 T1 mandates `0600` creation and a startup warning
   when "perms are wider". On Windows, `fs.chmod` mode bits are essentially a no-op
   (only the read-only flag), and the "wider than 0600" check will produce either
   false alarms or dead code. Same caveat applies to the advisory `.lock` file and
   `rename` atomicity assumptions (rename over an open file fails on Windows).

**Recommendation.** Specify in docs/02 §4 + docs/04: (a) `core/config` performs
leading-`~` expansion on all path-valued vars; (b) default token path when
`X_MCP_TOKEN_FILE` is unset: `$XDG_CONFIG_HOME/x-mcp/tokens.json` →
`~/.config/x-mcp/tokens.json` (macOS/Linux), `%APPDATA%\x-mcp\tokens.json`
(Windows) — and make the directory name **`x-mcp`** vs **`x-mcp-ai`** decision
explicit (today the repo, package, and config dir use three spellings: `x-mcp`,
`x-mcp-ai`, `~/.config/x-mcp`); (c) on win32, skip the POSIX perms check and warn
once that ACL-based protection is the user's responsibility (or check the ACL via
`icacls` in `doctor` only); (d) the rotation/locking unit tests run on the Windows
CI leg (F1). Keychain (T1, Phase 3) is fine as a later opt-in; don't let it add a
native dependency to the runtime budget — prefer shelling out to `security(1)` on
macOS.

### F6 — MINOR — The dependency-budget claim is inconsistent across three docs

**Problem.** docs/02 §1: "zero runtime dependencies beyond the MCP SDK + undici" —
but undici is *built into* Node ≥ 20 (docs/02 §2 says so itself), so it is not an
npm dependency. docs/04 §6: "dependency count is deliberately ~2 (SDK, dotenv)".
Meanwhile the architecture requires zod at runtime (`core/config`, `mcp/schema`) and
the family package ships three: `@modelcontextprotocol/sdk`, `dotenv`, `zod`. Three
different answers in one corpus weakens an otherwise good supply-chain story.

**Recommendation.** Normalize everywhere to the real budget: **runtime deps =
`@modelcontextprotocol/sdk` + `zod` (+ `dotenv` only if kept — consider dropping it:
MCP clients inject env directly and `--env-file` exists on Node ≥ 20, which would
make the budget 2 exactly)**. Add one honest sentence: the SDK brings transitive
dependencies, which is precisely why the lockfile, audit gate, and provenance matter
more than the top-level count.

### F7 — MINOR — Lockfile policy and audit cadence are unstated

**Problem.** Nothing in the corpus says `package-lock.json` is committed, that CI
installs with `npm ci` (the family does both), or how often the dependency tree is
re-audited between releases. `npm audit` only inside `check` means a high-severity
advisory in a transitive dep goes unnoticed until the next release attempt.

**Recommendation.** State in docs/05: lockfile committed; `npm ci` everywhere in CI;
Dependabot weekly (grouped minor+patch) as the update mechanism; the CI audit step
(F1f) runs on every push/PR so advisories surface within a day, plus CodeQL's weekly
cron covers the quiet periods. `.npmrc` with `engine-strict=true` and `.nvmrc`
carried over from the family.

### F8 — MINOR — MCP-registry publication details are thinner than what the registry actually requires

**Problem.** docs/06 Phase 3 names `server.json` and the `mcpName`, but omits:
(a) the **`mcpName` field must also be in the published `package.json`** — the
registry validates the npm tarball against `server.json` (the family does this);
(b) `server.json` carries its own `version` that must be bumped in lockstep with
`package.json` (the family had a real 2.0.0-vs-2.0.1 skew incident with its
extension, hence its version-sync CI check); (c) `environmentVariables` entries
should mark `X_MCP_CLIENT_SECRET`, `X_MCP_BEARER_TOKEN`, the OAuth 1.0a quadruple
etc. with `isSecret: true` so registry-driven UIs mask them.

**Recommendation.** Document all three in the Phase 3 exit criteria, and add a
cheap CI guard (in `ci.yml` or `publish.yml`) asserting
`package.json.version === server.json.version === server.json.packages[0].version`
and `package.json.mcpName === server.json.name`.

### F9 — MINOR — Startup-failure and auth-failure UX inside Claude Desktop is not designed for where stderr actually goes

**Problem.** docs/02 §4: "the server refuses to start on invalid config with a
human-readable report". Correct behavior — but in Claude Desktop that report lands
in `~/Library/Logs/Claude/mcp-server-x.log` (macOS) / `%APPDATA%\Claude\logs\`
(Windows), which users do not know exists; what they *see* is a greyed-out server
and possibly repeated respawn attempts by the client. The corpus has no offline
diagnostic path.

**Recommendation.** (a) Ship `npx x-mcp-ai doctor` (see F4): validates env parsing,
prints the resolved auth mode/policy matrix, checks token-file existence, JSON
shape, permissions, and expiry, optionally makes one `GET /2/users/me` (or app-only
equivalent) to prove connectivity — output to **stdout**, human-readable, exit 0/1;
README troubleshooting says "run this first". (b) On fatal startup errors, emit one
final plain-text (not JSON) stderr line prefixed `x-mcp-ai: fatal:` so it is
legible in client logs, and exit non-zero immediately — never retry-loop from the
server side, the client owns respawn. (c) README gets a "Where are the logs?"
table for Claude Desktop/Code per OS.

### F10 — MINOR — In-memory budget and rate-limit state does not survive the restart pattern of real MCP clients

**Problem.** docs/02 §7: `core/budget` seeds from `GET /2/usage/tweets` on first
read, then counts locally; the rate-limit table is in-memory. Claude Desktop
restarts MCP servers on every app launch and clients may spawn several concurrent
sessions — each process re-seeds (one extra API call per cold start, on `usage_get`'s
Basic-tier gating no less) and each process tracks budget independently, so the
"soft monthly cap" is per-process, not per-account. Not wrong for v1, but the docs
present it as a stronger guarantee than it is.

**Recommendation.** Document the limitation explicitly in docs/02 §7 (budget is
advisory, per-process, re-seeded on start; multiple concurrent
sessions each hold their own view). If persistence is ever wanted, a tiny JSON
sidecar next to the token file is enough — defer, but note it as the upgrade path.
This also feeds roadmap open question 1 (whether `core/budget` is worth v1
complexity — from an ops standpoint: seeding-on-restart makes it *weaker* than it
looks; shipping it in Phase 2 rather than 1 is the right call).

### F11 — NIT — npx cold-start budget: keep the tarball lean and forbid postinstall

**Problem/observation.** `npx -y x-mcp-ai` on a cold cache installs the package plus
the SDK tree before first response; Claude Desktop tolerates this, but every MB and
every lifecycle script hurts. The corpus doesn't state the family's tarball
discipline.

**Recommendation.** Carry over verbatim: `files: ["build", "!build/**/*.map", "bin"]`,
no `postinstall`/`prepare` scripts in the published package (also a supply-chain
stance worth writing down in docs/04 §6), and check tarball size in `release:dry`
review. Mention the pinned-version global install
(`npm i -g x-mcp-ai@x.y.z`) as the recommended setup for heavy users.

### F12 — NIT — `X_MCP_BASE_URL` override should be loudly visible at startup

**Problem.** docs/04 T8 allows overriding the pinned `api.x.com` base URL "for
testing". If an attacker (or a confused profile file) can influence env, this
silently redirects credentialed traffic.

**Recommendation.** When the override is set, print it in the startup banner and in
`auth_status`, and have `doctor` flag it in red. Do not document it in the README's
main config table — keep it in a testing appendix.

### F13 — MINOR — Reserve the npm name now, not "before Phase 1 ends"

**Problem.** docs/06 open question 4 defers name confirmation. The name is available
today (see below), but the `*-mcp` namespace is being squatted at speed —
`x-mcp-server` and `twitter-mcp` are already taken by third parties. Losing
`x-mcp-ai` would break the README, the `mcpName`, the bin name, and the family
naming symmetry at once.

**Recommendation.** Publish a placeholder `0.0.1` (README-only, clearly marked
"design phase — do not use", `publishConfig.access: public`) this week to reserve
the name, from CI with provenance so even the placeholder has attestations.
Close open question 4.

---

## npm name check result

**`x-mcp-ai` is AVAILABLE** as of 2026-07-21.

Evidence: `GET https://registry.npmjs.org/x-mcp-ai` → **HTTP 404**, body
`{"error":"Not found"}` (checked via both WebFetch and curl). Adjacent names for
context: `x-mcp` → 404 (also free), `x-mcp-server` → 200 (taken), `twitter-mcp` →
200 (taken), and the sibling `servicenow-mcp-ai` resolves normally (latest 2.0.1) —
confirming the check methodology. Per F13: reserve it now.

---

## Proposed release & versioning policy

The consumers of this package are **agent configurations** — tool names live in
prompts, allow-lists, and automation configs; env var names live in
`claude_desktop_config.json` files that users never revisit. The public API is
therefore defined as: **tool names + tool input/output schemas + typed error codes +
env variable names/semantics + policy preset meanings + CLI subcommands/exit codes +
the token-file format.** Concretely:

1. **SemVer against that API surface.**
   - **MAJOR**: remove or rename a tool; remove/repurpose an input field; change a
     policy preset's allowed cells or the *default* preset; remove/rename an env
     var; change an error `code`; change the token-file format without an automatic
     migration; drop a supported Node major.
   - **MINOR**: add tools; add optional inputs; add output fields (additive only);
     add env vars, presets, or CLI subcommands; raise a tier/scope requirement only
     if forced by the platform (call it out in the changelog under a "platform
     forced" heading).
   - **PATCH**: fixes, error-message wording, dependency bumps with no behavioral
     change, docs.
2. **0.x during Phases 1–2** with the stated convention "0.MINOR bumps may break";
   **1.0.0 at Phase 3 exit** (tool-catalog parity), matching the roadmap. From 1.0.0
   on, tool renames keep the old name registered as a deprecated alias for at least
   one full major.
3. **Token-file format is versioned** (`"version": 1` field) from the first write;
   newer servers migrate older files forward automatically; never backward.
4. **Release mechanics** (family-identical): bump `package.json` + `server.json`
   (+ `mcpName` sync check in CI), update `CHANGELOG.md` (Keep a Changelog format,
   entry mandatory), commit, tag `vX.Y.Z`, push tag. `publish.yml`: `npm ci` →
   tag==version guard → `npm run check` → `npm publish --provenance --access
   public` (OIDC; prefer npm Trusted Publishing over a stored token). Then
   `publish-mcp.yml` via `workflow_run` → `mcp-publisher login github-oidc` →
   `publish`. Laptop publishing is prohibited; `prepublishOnly: npm run check`
   remains as the backstop.
5. **Dist-tags**: `latest` = stable only; pre-releases (`1.1.0-rc.0`) go to `next`
   and are never what `npx -y x-mcp-ai` resolves.
6. **README pinning guidance**: quick start uses `x-mcp-ai@^1` (exact pin during
   0.x); an explicit sentence tells operators that unpinned `npx` means silent
   upgrades.
7. **Platform-drift releases**: because X tier caps/pricing shift under the server
   (docs/01 §7), each release's changelog gets a "Platform changes absorbed"
   section; a tier/cap change that alters which tools *work* (not their schema) is
   PATCH/MINOR, never silent.

---

## Recommendations

Priority-ordered; F-numbers reference the findings.

1. **Now (Phase 0, doc edits only)**: fold the family CI + release pipeline into
   docs/05 (F1, F2); add the versioning/changelog policy above (F3); fix the
   `authorize` inconsistency by promoting it to a shipped CLI subcommand and
   speccing `doctor` alongside it (F4, F9); specify token-path defaults, `~`
   expansion, and Windows semantics (F5); reconcile the dependency-count claim
   (F6); state lockfile + audit cadence (F7); extend Phase 3 exit criteria with the
   `mcpName`/`server.json` sync + `isSecret` details (F8); document the budget
   restart caveat (F10).
2. **This week**: reserve `x-mcp-ai` on npm with a provenance-published placeholder
   (F13) and close roadmap open question 4.
3. **Phase 1 scaffold**: copy `ci.yml` (with the Windows leg and launcher probe),
   `codeql.yml`, `dependabot.yml`, `.npmrc`, `.nvmrc`, and the `files`/scripts
   blocks from servicenow-mcp-ai on day one — do not defer CI to "when there are
   enough tests" (F1, F7, F11).
4. **Phase 2**: land `authorize` + `doctor` in the same phase as OAuth2 itself —
   the token-rotation code is only operable with its diagnostic counterpart (F4,
   F9); run the rotation/locking suite on the Windows CI leg (F5).
5. **Phase 3**: first `1.0.0` release exercises the full tag → npm-with-provenance
   → MCP-registry chain end-to-end; verify the registry entry renders the env-var
   secrets masked (F2, F8).
6. **Consider for Phase 3/4** (optional, family precedent exists): a Claude Desktop
   extension bundle (`.mcpb`) to eliminate the env-var-editing setup path for
   non-technical users — the 13-variable surface (docs/02 §4) is fine for CLI users
   but is the main setup friction for Desktop ones.
