# Architecture review — x-mcp design corpus

**Reviewer role**: senior software architect (Node.js/TypeScript, distributed systems,
API client design, MCP). **Date**: 2026-07-21. **Scope**: README + docs/01–06, with
`servicenow-mcp-ai` (sibling) consulted for the conventions x-mcp claims to mirror.

**Overall verdict: APPROVE WITH CHANGES.** This is an unusually disciplined design
corpus for a pre-code project: the layering is sound, the policy model is the right
shape, the rate-limit and retry stances are correct and conservative, and the roadmap
sequences risk properly (auth/rotation lands with its full test suite before the
surface grows). However, there is one finding I consider blocking for design
ratification — the token-refresh concurrency story is specified only at the
cross-process level and, as written, would still burn refresh-token rotations and lock
accounts — plus a cluster of MAJOR findings around the missing tool-registry/pipeline
choke point, a budget subsystem whose lifetime model contradicts how MCP processes
actually live, an agent-escapable budget override, and an error taxonomy that conflates
distinct 403 classes and ignores v2's partial-failure responses. All are fixable in the
docs before Phase 1; none invalidates the overall architecture.

---

## Strengths

1. **Layering is genuinely clean and proven by the sibling.** `core` (pure) / `api`
   (only HTTP-speaking module) / `mcp` / `tools` with an explicit dependency rule
   (02 §3) mirrors servicenow-mcp-ai's working layout. The claim "`core` is
   unit-testable without mocks" is nearly true (see Finding 8) and is the right target.

2. **The two-axis policy model (04 §3) is the correct abstraction.** Operation ×
   domain as a cell matrix, presets as named cell sets, deny-wins overrides, DM writes
   only in `full`, and `destructive` separated from `write` — this composes well, is
   auditable at startup, and directly supports the table-driven policy test in 05 §2.2.
   The deliberate refusal to ship batch write tools (03 "Deliberate omissions") is the
   single best platform-policy decision in the corpus.

3. **Rate-limit discipline is better than most production API clients.** Never
   blind-retrying 429s, preemptive refusal when `remaining === 0`, the narrow
   exception (idempotent GET, reset ≤ 5 s), and writes never auto-retrying with an
   explicit "your POST may have landed" message (02 §6) — all correct calls.

4. **Budget-consciousness is designed in, not bolted on.** Single-page-per-call
   pagination with `next_token` (02 §5.3), curated sparse field presets instead of a
   free-string `tweet.fields` param (02 §8), and compact render shapes are the right
   defaults for both the operator's wallet and the model's context window.

5. **Error-as-contract philosophy.** "The agent should never need to parse prose to
   know what went wrong" (02 §5.5), errors naming the missing scope / required tier /
   unlocking env var — this is excellent agent DX and the sibling proves it works.

6. **Token rotation fundamentals are right.** Persist-new-pair-before-use, atomic
   tmp+rename, fail-closed on 401-after-refresh with recovery instructions, no retry
   loops (04 §4). The *ordering* insight is correct; the concurrency gap is Finding 1.

7. **Security doc quality.** T1–T9 are concrete, each with a real mitigation; the
   untrusted-content note-prefix (04 §5), the media path allowlist (T9), and the
   no-third-party-text-in-error-messages rule are thoughtful, cheap mitigations.

8. **Testing strategy is risk-ranked and registry-driven.** "Adding a tool without
   classification fails the suite" (05 §2.2) and reviewed fixture refreshes (05 §5)
   are exactly how API drift should be caught. Note: this test *requires* a tool
   registry as data, which the architecture doc does not yet specify — see Finding 2.

---

## Findings

### F1 — BLOCKER — Token-refresh concurrency is under-specified; the design as written can still burn rotations and lock accounts

**Where**: 04 §4 (token lifecycle), 04 §2 T3, 05 §2.1.

**Problem**: X's refresh rotation invalidates the old refresh token on use, so a
*double refresh* with the same token is account lockout (the top asset in the threat
model). The design addresses only the **cross-process** race (advisory lockfile) and
says nothing about:

- **In-process concurrency.** MCP clients issue concurrent tool calls; the SDK
  dispatches them concurrently. Two in-flight requests both receiving 401 (or both
  hitting the eager <5-min refresh window) will both attempt a refresh. A lockfile
  does not serialize two callers inside one process in any useful way — and even if
  it did, see the next point.
- **Re-check after acquiring the lock.** The fatal sequence: caller A acquires the
  lock, refreshes, persists, releases; caller B (who was waiting) acquires the lock
  and *refreshes again with the token it read before waiting* — the now-invalidated
  one. X rejects it, the design "fails closed", and the operator must re-authorize.
  The algorithm must be: acquire lock → **re-read the token file** → if the token is
  already fresh, use it and skip the refresh → else refresh. 05 §2.1's "concurrent
  refresh blocked by lockfile" does not capture this; a test could pass while the
  behavior is still wrong.
- **Stale-lock breaking is itself a race.** "A stale lock (> 30 s) is broken with a
  warning" — if the lock holder is alive but slow (laptop sleep, network stall
  mid-refresh), breaking its lock re-creates the double-refresh. Prefer: lock file
  contains PID + timestamp, refresh HTTP call carries a timeout well under 30 s, and
  on ambiguity fail closed rather than break-and-refresh.

**Recommendation**: Specify the full refresh algorithm in 04 §4 as a small state
machine before Phase 2 starts: (1) in-process **single-flight** — one shared refresh
promise; all concurrent callers await it and then re-read credentials; (2)
cross-process advisory lock with **re-read-after-acquire**; (3) persist-before-use
retained; (4) stale-lock policy that never breaks a lock into a second refresh of the
same token. Extend 05 §2.1 with the specific case "waiter re-reads and skips refresh"
and "two concurrent in-process 401s cause exactly one refresh HTTP call".

---

### F2 — MAJOR — No tool-registry / pipeline choke point: policy enforcement is structurally optional

**Where**: 02 §3 (module layout), 02 §6 (pipeline), vs. sibling `src/mcp/define.ts` +
`src/mcp/registry.ts`.

**Problem**: The dependency rule allows `tools → api/endpoints` directly, and the
pipeline (validation → policy → budget → preflight → send) is described as a sequence
but **no module owns it**. If each tool file composes the steps by hand, then a tool
that forgets the policy check ships a policy bypass, and nothing but review catches
it. The whole safety story (goal 2 in 02 §1) currently rests on convention. Related
gaps that all resolve with the same fix:

- The policy classification, minimum tier, required scopes, and rate-limit
  endpoint-class of a tool exist only in a markdown table (03), not as data in the
  design. 05 §2.2's registry-generated policy test cannot exist without them as data.
- The rate-limit **preflight needs the endpoint class before the endpoint wrapper
  builds the request** (02 §6 ordering) — that key must come from tool metadata, or
  the preflight must move after request building; currently unspecified.
- MCP **tool annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`) are never mentioned, although the sibling makes them mandatory on
  every `ToolSpec` and clients use them for confirmation UX. The two-axis
  classification maps almost 1:1 onto them — this is free safety signal being left
  on the table.

**Recommendation**: Add a §to 02 specifying a `ToolDef` carrying `{name, title,
description, package, class: "op:domain", minTier, scopes, endpointClass, annotations,
input, handler}` and a registry (mirroring the sibling's `define.ts`/`registry.ts`)
that wraps **every** handler in the pipeline exactly once. Tools declare data;
enforcement lives in one place. This also gives the docs/README generators and the
policy test suite their single source of truth.

---

### F3 — MAJOR — `ignore_budget: true` as a tool parameter defeats the threat it mitigates

**Where**: 02 §7, vs. 04 §2 T7.

**Problem**: "overridable per call with `ignore_budget: true` so the human stays in
control" — but tool parameters are set by the **model**, not the human. T7's threat
actor is a runaway (or prompt-injected) agent burning the operator's paid read caps;
giving that same agent a self-service override reduces the hard budget stop to a
suggestion. This is the one place in the corpus where the "LLM is untrusted" axiom
(04 §1) is violated.

**Recommendation**: Move the override to operator space: `X_MCP_READ_BUDGET_MODE=
warn|hard` (env, per profile). In `warn` mode results carry `budget_warning` and never
fail; in `hard` mode the typed `budget` error is final for the session. Drop the
per-call parameter entirely, or keep it only in `warn` mode where it is harmless.

---

### F4 — MAJOR — The budget subsystem's lifetime model contradicts how MCP servers live

**Where**: 02 §3 (`core/budget` "in-memory, seeded by usage API"), 02 §7, 01 §3.

**Problem**: Four compounding issues:

1. **Process lifetime ≪ month.** A stdio MCP server is spawned per client session and
   dies with it. An in-memory *monthly* counter resets many times a day; it can never
   faithfully track a monthly cap.
2. **Seeding is tier-gated the wrong way.** `usage_get` (`GET /2/usage/tweets`)
   requires Basic (03 auth table), but the budget pain is most acute on **Free**
   (~100 post-reads/mo, 01 §3). Exactly the users who need the budget cannot seed it.
3. **Hidden request inside the pipeline.** "Seeds … on first read tool use" injects an
   extra API call, with its own latency/failure/rate-limit surface, into an unrelated
   tool call — the pipeline diagram (02 §6) doesn't show it and its failure behavior
   is unspecified.
4. **Layering.** `core` may not import `api` (02 §3), so `core/budget` cannot perform
   the seeding itself; the orchestration is unowned.

**Recommendation**: See the answer to open question #1 below — redefine the budget as
**session-scoped** and cut the seeding machinery. If a monthly counter is ever truly
needed, it requires a small persisted counter file (atomic, next to the token file) —
acknowledge that in the doc rather than pretending memory can do it.

---

### F5 — MAJOR — Error taxonomy: 403 conflation, missing `budget` in the canonical list, and no partial-failure story

**Where**: 02 §5.5, 02 §7, 03 (posts/users batch tools), 05 §2.4.

**Problem**:

1. **403 is at least five different failures on X**: missing scope, tier gating
   (`client-not-enrolled`), duplicate content, suspended/write-restricted account,
   and protected-account access. The taxonomy names `scope` and `tier` but funnels
   the rest into the generic `api` bucket — losing exactly the actionability the
   design promises. A duplicate-post 403 telling the agent "api error" instead of
   "X rejected this as a duplicate of an existing post" will cause retry loops.
2. **`budget` is used but not declared.** 02 §7 specifies a "typed `budget` error";
   02 §5.5's canonical list omits it. Doc drift inside the corpus.
3. **Partial failures are unaddressed.** v2 batch lookups (`posts_get`, `users_get`)
   and even single lookups return **HTTP 200 with an `errors[]` array** for deleted,
   suspended, or protected items alongside successful `data`. Neither the taxonomy
   nor the render-shape section says how per-item errors surface. An agent asking for
   100 posts and silently receiving 87 is a correctness bug.

**Recommendation**: (a) Add a `forbidden` class — "the platform refused this specific
action" — carrying X's `title`/`detail`, distinct from `api` (unexpected). (b) Add
`budget` to 02 §5.5. (c) Specify the partial-result contract: list-returning shapes
gain an optional `missing: [{id, reason}]` field, and the fixture suite (05 §2.4/2.5)
must include a 200-with-errors body.

---

### F6 — MAJOR — Write idempotency and ambiguous-outcome recovery are not designed per tool

**Where**: 02 §6 (retry policy), 03 (write tools), 04 T5.

**Problem**: X API v2 has **no idempotency-key mechanism**, so the "a timed-out
`POST /2/tweets` may have landed" problem is real and the design's only answer is
"the error message … suggests checking `timeline_user`". Gaps:

- **The suggested recovery is tier-gated above the failure.** `timeline_user` is
  Basic; on Free tier an ambiguous `post_create` outcome is unverifiable through the
  proposed path. The recovery guidance must be tier-aware.
- **Natural idempotency varies per write and is undocumented.** like/repost/follow/
  bookmark/mute/block are effectively idempotent at the platform level (re-liking is
  a no-op/benign error); `post_create` is not — but X's **duplicate-content
  rejection** acts as a de-facto short-window dedupe: re-issuing the *identical* text
  is safe (it either succeeds because the first never landed, or is rejected as a
  duplicate because it did). That rejection is precisely the signal that resolves the
  ambiguity, and the design doesn't exploit it.
- These properties are also what `idempotentHint` (F2) should be derived from.

**Recommendation**: Add an "idempotency & ambiguity" column/note per write tool in
03. For `post_create`, specify: on timeout, the error instructs the agent that
re-issuing the identical text is the safe probe (duplicate rejection ⇒ the original
landed), and maps that duplicate 403 to the `forbidden` class with a message that
includes this interpretation. `post_delete` on 404 should be treated as success
(already deleted) — say so.

---

### F7 — MAJOR — `media_upload` as one blocking tool call will hit client timeouts for video

**Where**: 03 media, 02 §6, 01 §5.

**Problem**: The tool wraps INIT → APPEND(×n) → FINALIZE → **STATUS polling for video
processing** in a single call. Video processing on X routinely takes tens of seconds
to minutes; MCP clients impose tool-call timeouts and users see a hung agent. There
is also no mention of MCP **cancellation** (the client can cancel a request) or
**progress notifications**, both of which exist in the protocol and matter exactly
here.

**Recommendation**: Split the surface: `media_upload` returns after FINALIZE with
`{media_id, processing_state}`; add a `media_status` tool for the STATUS poll (the
agent loops, each iteration a fast call — this also matches the one-page-per-call
pagination philosophy). Honor cancellation via `AbortSignal` threaded through
`api/http`; emit MCP progress notifications during APPEND chunks. Note in 02 §4 that
`X_MCP_TIMEOUT_MS` is per HTTP request, not per tool call.

---

### F8 — MINOR — `core` purity leaks: config reads the environment and a file

**Where**: 02 §3 ("core/config.ts — env/profile parsing", "no I/O").

**Problem**: "Env/profile parsing" in `core` implies reading `process.env` (ambient
state) and `X_MCP_PROFILES_FILE` (file I/O) — both violate the module's own "no I/O"
charter, and file reading definitively does. Same pattern risk as F4's seeding.

**Recommendation**: The composition root (`index.ts`) reads `process.env` and the
profiles file; `core/config` exports `parseConfig(env: Record<string, string |
undefined>, profilesJson?: unknown): Config` — pure, exhaustively unit-testable,
exactly as the layer promises. One sentence in 02 §3 fixes this.

---

### F9 — MINOR — Config env-var table is not canonical, and env/profile precedence is undefined

**Where**: 02 §4, vs. 02 §9, 04 T1/T8/T9.

**Problem**: Variables referenced elsewhere are missing from the table that presents
itself as the config surface: `X_MCP_LOG_LEVEL` (02 §9), `X_MCP_BASE_URL` (04 T8),
`X_MCP_MEDIA_DIR` (04 T9), `X_MCP_TOKEN_KEYCHAIN` (04 T1), plus the
`X_MCP_READ_BUDGET_MODE` proposed in F3. Separately, precedence is unspecified when
both direct credentials (`X_MCP_BEARER_TOKEN`) and a profiles file are present — does
the profile win, or is ambiguity an error? Silent precedence is how wrong-account
writes (T6) happen despite the one-profile-per-process rule.

**Recommendation**: Make 02 §4 the single canonical table (add the stragglers). Rule
I'd adopt: if `X_MCP_PROFILES_FILE` is set, `X_MCP_PROFILE` is required and direct
credential vars are a **startup error** (fail loud, not fallback). The
one-profile-per-process decision itself is correct — keep it.

---

### F10 — MINOR — Dependency claims are mutually inconsistent (and zod is unaccounted for)

**Where**: 02 §1 goal 4 ("zero runtime dependencies beyond the MCP SDK + undici"),
04 §6 ("dependency count is deliberately ~2 (SDK, dotenv)"), 02 §3/§4 (zod
throughout), sibling `package.json` (SDK + dotenv + zod).

**Problem**: Three different lists. zod is load-bearing in the design (config
validation, tool schemas) yet appears in no dependency claim. undici: Node ≥ 20
bundles it, but `MockAgent` and client tuning argue for an explicit (at least dev)
dependency and a pinned version — "built in" and "pinned behavior" are in tension.

**Recommendation**: State once, in 02 §2: runtime deps = `@modelcontextprotocol/sdk`,
`zod`, `dotenv` (matching the sibling); undici explicit as a dev dependency for
`MockAgent`, runtime via Node's bundled copy (or pin it — but decide and write it
down). Fix 02 §1 and 04 §6 to reference that.

---

### F11 — MINOR — `post-compact` preset omits `note_tweet`: long posts silently truncate

**Where**: 02 §8, 03 posts/search/timelines.

**Problem**: For long-form posts (past the classic 280 chars), v2 returns the
truncated legacy `text` and the full text in the `note_tweet` field — which the
compact preset does not request. The server's core job is letting an agent *read
posts*; the default preset would hand the model silently truncated content with no
indication anything is missing.

**Recommendation**: Add `note_tweet` to `post-compact`; `core/render` should prefer
`note_tweet.text` over `text` when present. More generally, add a Phase 1 exit item:
verify every preset against the live v2 field inventory (the corpus already flags
platform volatility in 01 §7 — presets belong on that re-verify list).

---

### F12 — MINOR — No schema/shape evolution or versioning policy

**Where**: 02 §5, 03 conventions ("stable once shipped"), 06 Phase 3 ("published
1.0.0").

**Problem**: Tool *names* are declared stable, but nothing governs input schemas,
render shapes, or error payloads — which are equally part of the contract agents (and
operators' saved prompts) depend on. What constitutes a breaking change for an MCP
server is undefined, so semver at 1.0.0 is unenforceable.

**Recommendation**: One short section in 02: render shapes and input schemas are
public API; changes are additive-only within a major; field removal/rename or
error-class semantics change = major bump; the contract-fixture suite (05 §2.4/§5) is
the enforcement mechanism (a fixture diff that removes a field fails review).

---

### F13 — NIT — "~45 tools" is materially wrong: the catalog enumerates 60

**Where**: 03 header, 02 §5.1, README.

**Problem**: Counting the rows that define multiple tools (`like_create /
like_delete` etc.), the catalog contains **60** tools, not ~45. This matters beyond
tidiness: 60 tool schemas is a real context-window load, which strengthens the case
for hiding denied tools (open question #2).

**Recommendation**: Correct the number everywhere; consider it an input to Q2.

### F14 — NIT — `auth_status` promises `me` in app-only mode

**Where**: 03 auth (marked ⓐ), 01 §2.3 ("no `me`" in app context).

App-only context has no authenticated user; define the degraded `auth_status` shape
(`user: null`, `context: "app-only"`) so the tool doesn't 403 or invent fields.

### F15 — NIT — Preemptive rate-limit refusal should tolerate clock skew

**Where**: 01 §4, 02 §7. `x-rate-limit-reset` is server epoch time; a skewed local
clock could refuse requests after the window reset (or admit them early). Compute
against a skew allowance (e.g. treat reset as `reset − 5 s`) and prefer the
observed-headers path over wall-clock arithmetic where possible.

### F16 — NIT — Built-in WOEID table is data that rots

**Where**: 03 trends. A name→WOEID table baked into the binary will drift. Keep it
tiny (top ~20 metros + countries), document it as best-effort, and always accept a
raw `woeid` input as the authoritative path.

---

## Answers to open questions (06 §Open questions)

### Q1 — Client-side read-budget tracking: worth it for v1?

**Recommendation: not as designed — redefine it as a session budget, and ship *that*
in Phase 1 (it's trivial); cut the monthly seeding machinery entirely.**

Reasoning:

1. **A stdio MCP process lives for one client session**, not a month. In-memory
   monthly accounting is structurally incapable of its stated job (F4.1); faithful
   monthly tracking would require persisted state, which contradicts the
   no-database/no-storage stance for marginal benefit.
2. **The actual threat (T7) is a runaway session**, not calendar accounting. A
   per-session cap ("this session may consume at most N post-reads") is deterministic,
   needs no seeding, no persistence, no tier-gated `usage_get` call, and directly
   stops the runaway-loop scenario. Monthly truth already has an owner: X's own
   `GET /2/usage/tweets`, surfaced verbatim via `usage_get`.
3. **The seeding path is broken for its main audience** — `usage_get` needs Basic,
   while Free tier is where ~100 reads/mo makes budgeting existential (F4.2).

Concretely: `X_MCP_READ_BUDGET` becomes a per-session cap; `core/budget` shrinks to a
pure counter (fits `core` perfectly, no API dependency, no hidden pipeline request);
`budget_warning` at 90 % and the typed `budget` error at 100 % stay as designed;
enforcement mode via env, not tool param (F3). Revisit persisted monthly counting
only if real operators ask for it.

### Q2 — Denied-tool visibility: registered-but-erroring vs hidden?

**Recommendation: hide statically denied tools at registration time. Reverse the
current design.**

Reasoning:

1. **The stated rationale doesn't hold for this design.** "Registration-time hiding
   breaks client tool caching" (04 §3) presumes the tool list can change mid-session
   — it cannot: policy is resolved from env at startup and is immutable for the
   process lifetime. A cached list is stale only when the operator *changes config
   and restarts*, which is exactly when the list *should* change. If dynamic policy
   ever arrives, MCP's `listChanged` notification is the designed mechanism.
2. **Context economics.** The catalog is 60 tools (F13), not 45. In the default
   `read-only` preset, ~28 write/destructive tool schemas would be loaded into every
   session's context only to return errors. That is a real token and
   attention cost on every single conversation, paid for a hypothetical benefit.
3. **Safety optics and attack surface.** A read-only server that advertises `dm_send`
   invites both operator distrust ("why is this tool here?") and prompt-injection
   probing. A tool that does not exist cannot be argued into being called; a
   registered tool returning errors can still burn agent turns on retries.
4. **The sibling already hides.** servicenow-mcp-ai's registry gates package
   registration on denied/read-only settings — so "mirror the sibling's conventions"
   argues for hiding, not against it.
5. **The legibility benefit survives.** The genuine value of erroring tools — "the
   agent learns *why*" — is preserved more cheaply: `auth_status` returns the full
   resolved matrix including denied cells and the env var that unlocks each, and the
   MCP server `instructions` string states the active preset and that further tools
   exist behind policy opt-in. An agent asked to DM someone under `read-only` will
   check `auth_status` (or the client will relay the instructions) and report
   accurately, instead of discovering `dm_send` and hammering it.

Implementation note: this collapses to a one-line filter in the registry from F2
(`tools.filter(t => policy.allows(t.class))`), which is another reason to build the
registry first.

### Brief notes on Q3 and Q4 (not formally in scope)

- **Q3 (OAuth 1.0a timing)**: move to Phase 3, behind demand. Phase 2 already carries
  the hardest code in the project (rotation); shrinking its blast radius is worth
  more than serving legacy hobby credentials earlier. Media upload works under
  OAuth 2.0 on the v2 path, removing the historical reason to keep 1.0a close.
- **Q4 (npm name)**: `npm view x-mcp-ai` costs one minute — do it now, not "before
  Phase 1 ends"; the name is embedded in docs, `bin`, and the MCP registry id.

---

## Recommendations for Phase 1 (what to build and prove first)

1. **Build the ToolDef + registry + pipeline wrapper first** (F2) — before any
   endpoint work. Everything else hangs off it: single-point policy enforcement, the
   registry-generated policy tests (05 §2.2), MCP annotations, denied-tool filtering
   (Q2), endpoint-class metadata for the rate-limit preflight, and future docs
   generators. This is the architectural keystone and it is currently the least
   specified module.
2. **Prove the error-taxonomy mapping with fixtures before widening the surface.**
   Land canned bodies for 401, all 403 variants (scope, tier, duplicate, protected),
   429, and **200-with-errors[] partial results** (F5) against the nine Phase 1 read
   tools. If the taxonomy is wrong, every later tool inherits the mistake.
3. **Make `core` provably pure now**: `parseConfig(env)` with injected environment
   (F8) and the session-scoped budget counter (Q1) — both fall out naturally if done
   before any I/O code exists, and both are expensive to retrofit.
4. **Write the OAuth2 refresh state machine as a design section during Phase 1**,
   even though the code is Phase 2 (F1). It is the highest-risk component; its
   algorithm (single-flight, lock, re-read-after-acquire, stale-lock policy) should
   be reviewed as text before it is reviewed as code.
5. **Ship `auth_status` with the degraded app-only shape (F14) and the resolved
   policy matrix from day one** — it is the tool every agent session should call
   first, and it carries the Q2 denied-capability story.
6. **Fix the corpus drift before ratification**: canonical env table (F9), `budget`
   in the taxonomy list (F5.2), one dependency statement (F10), tool count (F13),
   `note_tweet` in the preset (F11). Cheap now; confusing forever if they leak into
   Phase 1 code comments and the README.
7. **Reserve the npm package name immediately** (Q4).
