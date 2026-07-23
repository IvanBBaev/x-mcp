# Agent-DX review — x-mcp design corpus

- **Reviewer role**: Senior AI/agent developer-experience engineer (tool surfaces for LLM
  agents: MCP servers, function-calling APIs, schema/token economy, error-message
  actionability).
- **Date**: 2026-07-21
- **Scope**: README.md, docs/01–06; focus on docs/03-tool-catalog.md and the tool-surface
  principles in docs/02 §5/§8. Reviewed strictly from the perspective of the model
  consuming these tools, not the implementer.
- **Overall verdict**: **approve-with-changes.** The design's instincts are the right
  ones — curated intents over REST mirroring, compact renders, typed errors, uniform
  pagination, registered-but-denied policy. But the surface as cataloged is ~60 tools
  (not the claimed ~45), heavy with mergeable create/delete pairs; the id-vs-handle
  resolution question is unaddressed; the compact render is missing the two fields
  agents need most (canonical URL, long-post/`note_tweet` handling); and one policy
  affordance (`ignore_budget`) contradicts its own stated purpose. All fixable on
  paper before Phase 1.

---

## Strengths

1. **Curated-not-generated is the correct core stance** (02 §5.1). Tools mapped to agent
   intents, with a fixed curated field preset instead of exposing `tweet.fields` as a
   free-string param (02 §8), is exactly right. Free-string field lists are the single
   most common source of invalid-request loops in v2 wrappers; two presets behind
   `raw: true` eliminates the failure class entirely.
2. **Typed, deterministic error taxonomy** (02 §5.5) with the `policy` error naming the
   cell *and the env var that would unlock it* is best-in-class agent UX. Most MCP
   servers return prose; this design lets a model branch on error type.
3. **The ambiguous-write-timeout handling** (02 §6: "a timed-out `POST /2/tweets` may
   have landed — the error message says so and suggests checking `timeline_user`") is a
   subtle, rarely-seen touch. This is precisely the kind of remediation text that lets a
   model self-correct instead of double-posting.
4. **Budget discipline as a first-class concern**: no auto-pagination, server-capped
   `max_results`, preemptive rate-limit refusal, `budget_warning` fields. Free/Basic
   read caps are brutal; a design that treats every read as spending money will survive
   contact with reality.
5. **Writes echo their effect** (id + canonical URL) — the agent can confirm and
   reference. Correct.
6. **`auth_status` as identity anchor** (02 §4, 04 T6): leading with `@handle` and the
   resolved policy matrix before any write is the right defense against wrong-account
   writes, and gives the model a single tool to call to orient itself.
7. **The injection-guard `note` field on third-party content** (04 §5) is cheap and
   evidence-backed. Good.
8. **No batch write tools** (03 "Deliberate omissions") — correct both for platform
   policy and for agent safety; a reviewable one-call-per-action loop is what you want
   when the planner is untrusted.

---

## Findings

### F1 — MAJOR — docs/03 header vs. actual catalog: the surface is ~60 tools, not ~45

**Where**: docs/03-tool-catalog.md line 1 ("~45 tools in 12 packages"); docs/02 §5.1.

**Problem**: Counting actual tool *names* (paired rows like `like_create / like_delete`
are two tools): auth 3, posts 5, search 4, timelines 3, engagement 11, users 4, graph 10,
dm 3, lists 12, media 2, spaces 2, trends 1 = **60 tools**. The "~45" appears to count
table rows. This matters because every registered tool costs schema tokens in the
client's context window on every turn. At a realistic 120–200 tokens per definition
(name + description + JSON schema with `max_results`/`page_token`/`raw` on every read),
60 tools is **8–12k tokens of standing context** — before the user's github, slack, and
filesystem MCP servers add their own 30–80 tools. Tool-selection accuracy degrades
measurably past ~40–50 visible tools, especially when many are near-duplicates
(`like_create`/`like_delete`/`repost_create`/`repost_delete`/... differ by one word).

**Recommendation**: Merge the nine same-class create/delete pairs into action-enum tools
(see the proposals table), fold the three single-user lookups into one, and gate Pro-only
and Phase-3 packages out of the default registration. Target: **≤ 35 tools at full
surface, ≤ 25 in a default deployment**. Fix the count in both docs so later reviews and
budget estimates are grounded in the real number.

### F2 — MAJOR — No id-vs-handle resolution story: the most predictable model error is undesigned

**Where**: docs/03 (every user-targeting tool: `timeline_user`, `followers_list`,
`following_list`, `follow_create`, `liked_posts_list`, ...), docs/02 §5.

**Problem**: v2 endpoints are numeric-id-keyed, but agents live in handle-space: the
user says "summarize @naval's timeline", the model calls
`timeline_user {user_id: "@naval"}`, gets a 400, and must discover
`user_by_username` → extract id → retry. That's two wasted turns and a read spent, per
task, forever. Same for post ids: users paste URLs
(`https://x.com/naval/status/1234…`), and models will pass the URL to `post_get`.
Nothing in the corpus says whether tools accept handles/URLs or how the model learns
they don't.

**Recommendation**:
- Every user-targeting tool takes a single param `user: string` accepting **numeric id,
  `handle`, or `@handle`**; the server resolves handle→id via `users/by/username` and
  caches the mapping for the process lifetime (one extra read per unique handle per
  session — cheap, and it protects the budget better than the model's retry loop does).
- Every post-targeting tool (`post_get`, `like_*`, `repost_*`, `quote_posts_list`,
  `reply_to_id`, `quote_id`) accepts either a bare id or a full `x.com`/`twitter.com`
  status URL and extracts the id.
- `user` params default to `"me"` (the authenticated user) wherever the endpoint is
  self-scoped in practice (`timeline_mentions`, `timeline_user`, `liked_posts_list`,
  `followers_list`, ...) — see F9.
- State this convention once in the MCP server `instructions` field (see R2) and once
  per schema description.

### F3 — MAJOR — Compact post render is missing canonical `url` and will silently truncate long posts

**Where**: docs/02 §5.2 (compact shape), §8 (`post-compact` field preset).

**Problem** (two parts):
1. The compact shape `{id, author, text, created_at, metrics, reply_to?, quoted?,
   media?}` has **no `url`**. Docs/02 §5.4 promises URLs on *writes* only. Agent
   workflows are read-dominated: "summarize mentions", "find the top post" — the model's
   final answer to the human almost always needs to cite/link posts. Without a URL in
   the render, models fabricate them (and get the handle-in-path wrong) or answer with
   bare ids.
2. The `post-compact` preset (`id,text,created_at,author_id,public_metrics,
   referenced_tweets,attachments`) omits **`note_tweet`**. Long-form posts (> 280
   chars, common since 2023) return truncated `text` unless `note_tweet.text` is
   requested — the model will summarize a cut-off sentence with no signal that it's
   incomplete. Likewise, reposts carry truncated `RT @…` text unless the referenced
   tweet's full text is joined.

**Recommendation**: Add `url` (`https://x.com/i/status/<id>` as the handle-free
canonical form, or handle-based when the author expansion is present) to **every**
rendered post, read and write alike. Add `note_tweet` to the compact preset; when full
text cannot be recovered, render an explicit `truncated: true` marker — never let the
model see partial text unlabeled. Render `created_at` as ISO 8601 UTC (confirm the
render never converts to epoch or locale forms). For empty result sets, render an
explicit `{result_count: 0, note: "no matching posts"}` — the raw v2 response omits
`data` entirely on zero results, and an empty object reads as an error to many models.

### F4 — MAJOR — `ignore_budget: true` is model-controlled, contradicting "so the human stays in control"

**Where**: docs/02 §7.

**Problem**: "at 100 % reads fail with the typed `budget` error (overridable per call
with `ignore_budget: true` so the human stays in control)". The *model* composes tool
calls, not the human. Any model that reads the `budget` error (or the schema, where the
param must be declared to be usable) will set `ignore_budget: true` on the retry —
that's what agents do with self-service overrides. The design's own threat model (04 §1:
"the LLM is not trusted to self-limit") says exactly why this can't work. This is the
one place in the corpus where an affordance is handed to the wrong principal.

**Recommendation**: Remove `ignore_budget` from tool schemas entirely. Make the
override operator-side: `X_MCP_READ_BUDGET_MODE=hard|soft` (soft = warn past 100 %,
hard = typed error, changeable only by restarting with new env). The `budget` error
text should say: "monthly read budget exhausted (N/M). This is an operator-set limit;
ask the user to raise X_MCP_READ_BUDGET or set X_MCP_READ_BUDGET_MODE=soft. Do not
retry reads in this session."

### F5 — MAJOR — The `list` noun/verb collision and the `search_all` selection trap

**Where**: docs/03 lists package, engagement/graph read tools, search package.

**Problem** (naming, model-selection):
1. The catalog uses `list` in two opposite grammatical roles: as a trailing **verb**
   (`bookmarks_list`, `blocks_list`, `mutes_list`, `liked_posts_list`,
   `dm_conversations_list`, `list_members_list`) and as the leading **noun** for the X
   Lists product (`list_create`, `list_get`, `list_posts`, `lists_owned`).
   `list_posts` is maximally ambiguous — a model scanning tool names cannot tell "list
   the posts" (verb) from "posts of a List" (noun); `list_members_list` uses both roles
   in one name. In a multi-server context where github/slack servers also expose
   `list_*` tools, selection errors are near-guaranteed.
2. `search_all` reads as the *superset* of `search_recent` — a model given "find posts
   about X" will prefer the tool whose name promises more coverage, then hit the `tier`
   error on Basic (recoverable, but a wasted turn every time, forever). Same for
   `post_counts_all`.

**Recommendation**: Reserve leading `list_` exclusively for the X Lists feature and
keep trailing `_list` as the collection-read verb, with two renames to break the
ambiguity: `list_posts` → `list_timeline`, `list_members_list` → `list_members`. Rename
`search_all` → `search_archive` and `post_counts_all` → `post_counts_archive` — "archive"
signals specialization instead of superset, and the description leads with "Pro tier
only". (Full table below.)

### F6 — MAJOR — Tool-definition context cost has no mitigation lever; Pro-only and Phase-3 tools are always registered

**Where**: docs/02 §5.1, docs/03, docs/04 §3, docs/06 open question 2.

**Problem**: The registered-but-denied policy (correct in itself — see the verdict
section) means a `read-only` deployment still carries ~25 write-tool schemas in every
prompt, and a Basic-tier deployment carries `search_all`, `post_counts_all`,
`user_search` (Pro, $5k/mo — the overwhelming majority of users will never call them)
plus spaces/trends/dm/lists definitions. That's thousands of standing tokens with zero
session utility, and each unusable tool is a selection distractor.

**Recommendation**: Keep registered-but-denied as the *default*, but add two
operator-side levers: (a) `X_MCP_HIDE_DENIED=1` — long-lived read-only deployments
reclaim the tokens; (b) tier-gate registration: when the operator declares
`X_MCP_TIER=basic` (or the session has inferred the tier), tools above the tier are
hidden rather than registered-to-403. Additionally, since policy is resolved *before*
registration, append the live status to denied tools' descriptions at registration
time: "(disabled by current policy `read-only`; operator can enable via
X_MCP_POLICY=engage)". The model then learns the gate from the tool list itself,
without spending a failed call.

### F7 — MINOR — Naming convention is not uniformly applied

**Where**: docs/03 throughout.

**Problem**: The stated convention is `<noun>_<verb>`, but the catalog mixes patterns:
noun_qualifier with no verb (`timeline_user`, `timeline_home`, `search_recent`),
participle-noun chains (`liked_posts_list`, `liking_users_list`, `reposted_by_list`),
noun_adjective (`lists_owned`), and singular/plural drift (`bookmark_create` vs
`bookmarks_list`; `post_get` vs `posts_get`). Models don't need perfect grammar, but
they *do* pattern-match: once they've seen `bookmark_create`, they'll guess
`bookmark_list` (singular) and miss. Inconsistency taxes guessability and makes the
sorted tool list harder to scan.

**Recommendation**: Adopt three explicit patterns and state them in docs/03's header:
(1) actions: `<noun>_<verb>`; (2) collection reads: `<plural-noun>_list`; (3)
scoped feeds: `timeline_<scope>`. Normalize the outliers (`liked_posts_list` →
`liked_posts` is acceptable if pattern 2 is "plural noun, `_list` optional when the
plural already implies a collection" — but pick one and apply it everywhere).

### F8 — MINOR — `block` classification contradicts docs/04's own destructive definition

**Where**: docs/03 graph package (`block_create` = `write:social-graph`) vs docs/04 §3
("**destructive** (delete/block — hard to undo or socially loud)").

**Problem**: Docs/04 names *block* as the canonical example of `destructive`, but the
catalog classifies `block_create`/`block_delete` as `write:social-graph`. Beyond doc
hygiene, this decides whether `full`-minus-`destructive` deployments can block — and it
matters for the merge proposals: a merged `block_set` must carry a single
classification, and `destructive:social-graph` is the defensible one for the block
action.

**Recommendation**: Resolve the contradiction explicitly. Suggested: `block` action =
`destructive:social-graph`, `unblock` = `write:social-graph`; if merged into one tool,
classify the tool at the higher class (a policy that can't block also can't unblock —
acceptable, and simpler than per-action classification).

### F9 — MINOR — Self-scoped tools should default to the authenticated user; time bounds under-specified

**Where**: docs/03 timelines, engagement reads.

**Problem**: `timeline_mentions` is described as "Mentions of a user" — if the input
requires a user id, every mentions workflow starts with an `auth_status`/`user` lookup
detour (see walkthrough B). `timeline_user` lists "time bounds" as an input;
`timeline_mentions` doesn't, though the underlying endpoint supports
`start_time`/`end_time` — and "today's mentions" is *the* canonical mentions task.

**Recommendation**: All self-scopable tools (`timeline_mentions`, `timeline_user`,
`liked_posts_list`, `followers_list`, `following_list`) take `user` defaulting to
`"me"`. Give `timeline_mentions` (and `timeline_home`) explicit `start_time`/`end_time`
ISO 8601 params. Document the v2 quirk that `end_time` must be ≥ ~10 s in the past —
handle it server-side (clamp) rather than surfacing a confusing 400.

### F10 — MINOR — Pagination token naming asymmetry needs an explicit bridge in every description

**Where**: docs/02 §5.3, docs/03 conventions.

**Problem**: Input is `page_token`, output is `next_token`. Models handle this fine
*when told*; untold, a nontrivial fraction will pass `next_token` back as `next_token`
and get a validation error.

**Recommendation**: Either rename the input to `next_token` (symmetric round-trip — the
model copies the field verbatim), or keep the pair but make every list tool's
`page_token` description read: "pass the `next_token` value from the previous result to
fetch the next page." Also return `result_count` alongside `next_token` so the model
can reason about whether paging is worth the budget.

### F11 — MINOR — `raw: true` on all ~30 read tools: right escape hatch, needs cargo-cult guards

**Where**: docs/02 §5.2, docs/03 conventions.

**Problem**: The flag itself is well designed (off by default, full-fidelity behind it).
Two risks: (a) it adds a param to every read schema — small per-tool, ~1–2k tokens
across the surface; (b) models cargo-cult `raw: true` "to be safe" or after one
confusing compact result, and a single raw search page of 100 expansion-joined posts
can be 30–60k tokens — a context-window bomb.

**Recommendation**: Keep the flag. Description discipline: "Debugging only. Returns the
unprocessed X API v2 payload; typically 10–50× larger than the default output." When
`raw: true`, server-side cap `max_results` lower (e.g. ≤ 25) and log a warning. Confirm
`raw` returns the *exact* API JSON including `includes`/`meta` — its only legitimate use
is inspecting what the API really said.

### F12 — MINOR — `post_create` schema constraints are undescribed where the model will hit them

**Where**: docs/03 posts package.

**Problem**: The composite shape (`text`, `reply_to_id`, `quote_id`, `media_ids[]`,
`poll{}`, `reply_settings`) has invisible constraint edges: poll × media are mutually
exclusive; max 4 images or 1 video/GIF; poll `duration_minutes` ∈ [5, 10080];
`reply_settings` values unenumerated; and the 280-char limit is *weighted* (URLs count
as 23 via t.co) so naive `text.length` checks mislead in both directions. Left to the
API, these all surface as opaque 400s.

**Recommendation**: Encode every constraint as zod refinements returning typed
`validation` errors that name the conflict and the fix ("`poll` and `media_ids` cannot
be combined — remove one"). Pre-validate weighted length and report it: "text weighs
312/280 — shorten by ~32 characters (URLs count as 23)". Make `reply_settings`,
`sort_order`, `granularity`, and timeline `exclude` proper enums with all values listed
in the schema — enums are the strongest anti-hallucination device a schema has. Put 2–3
example queries in `search_recent`'s `query` description (`from:user`, `conversation_id:`,
`-is:retweet`): few-shot in descriptions is the cheapest accuracy lever available.

### F13 — MINOR — Error taxonomy lacks a machine-readable "who can fix this" axis

**Where**: docs/02 §5.5.

**Problem**: The types are right, but the model's *branch decision* on every error is
binary: "can I fix this by acting differently, or must a human change something?"
Today that's implied by prose. `validation`/`not-found`/`rate-limit(short)` are
agent-recoverable; `auth`/`scope`/`tier`/`policy`/`budget` are operator-only — and a
model that doesn't know that will burn turns retrying or "working around".

**Recommendation**: Every typed error carries two structured fields:
`retryable: boolean` and `fix: "agent" | "operator"`, plus type-specific remediation
text:
- `scope`: "missing OAuth scope `like.write`. Operator must re-run
  `npx x-mcp-ai authorize` after enabling the scope. Do not retry."
- `tier`: "requires Pro tier; this account is Basic (inferred). Do not retry; tell the
  user this endpoint needs a plan upgrade."
- `rate-limit`: reset as ISO **and** `retry_after_seconds`; note that limits are
  per-endpoint — "other tools remain available."
- `policy`: current text (cell + env var) **plus** "this is a local operator setting;
  it cannot be changed from within this session."
- `not-found` (posts): "post may be deleted, from a protected account, or the id/URL
  may be wrong."
- `validation`: field path, expected form, received value, one valid example.

### F14 — NIT — `like_create` / "create a like" is semantically off; `list_pin` has no `list_unpin`

**Where**: docs/03 engagement, lists.

**Problem**: Nobody "creates a like" — the CRUD verb is imported from REST, not from the
domain; minor, but domain-natural verbs measurably help selection ("like this post" →
`like…`). Separately, the catalog can pin a list but not unpin it — an asymmetry the
model will discover only by failing.

**Recommendation**: Both are solved by the action-enum merges below (`like_set` with
`action: "like" | "unlike"`; `list_pin_set` with `pin | unpin`). Note the catalog
already embraces the toggle pattern in `post_hide_reply` ("Hide/unhide") — the merges
just extend the design's own precedent.

### F15 — NIT — Compact author shape should keep the id

**Where**: docs/02 §5.2 (`author: "@handle"`).

**Problem**: Flattening author to a handle string discards the id the model may need
for follow-up calls, and forces re-resolution (a read). With F2 adopted the cost is
small, but keeping both is nearly free.

**Recommendation**: `author: {id, handle, name}` — three short fields, still compact.

---

## Workflow walkthroughs

### A. "Post a thread of 3 posts with an image on the first"

Preconditions: `X_MCP_POLICY=publish` (media_upload and post_create are both
`write:content` — same preset unlocks both; good coherence).

| # | Tool call | Result |
|---|---|---|
| 1 | `media_upload {path: "chart.png"}` | `media_id` |
| 2 | `media_metadata_set {media_id, alt_text: "…"}` | ok |
| 3 | `post_create {text: t1, media_ids: [media_id]}` | `id1` + URL |
| 4 | `post_create {text: t2, reply_to_id: id1}` | `id2` + URL |
| 5 | `post_create {text: t3, reply_to_id: id2}` | `id3` + URL |

**Works end-to-end with cataloged tools.** Friction log:
- **Partial-failure recovery is undesigned.** If call 4 fails (rate limit, 24-h cap),
  the account shows a dangling one-post "thread". Nothing tells the model how to
  resume. Fix: the write-path error text for a `post_create` with `reply_to_id` should
  add "posts already created in this sequence remain live; resume by replying to the
  last successful id" — cheap prose, prevents both double-posting and abandonment.
  (The Phase-3 `thread_create` will subsume this; until then the prose carries it.)
- **Nothing nudges alt text.** Step 2 is skippable and models will skip it. Consider:
  `media_upload` result includes `note: "consider media_metadata_set to add alt text"` —
  or accept `alt_text` directly as an optional `media_upload` param and cut
  `media_metadata_set` entirely (one fewer tool, one fewer round trip; the underlying
  metadata call becomes an implementation detail).
- **Video would stretch the model of a single tool call**: `media_upload` internally
  polls STATUS for processing — fine for images, but a 2-minute video processing wait
  inside one stdio tool call risks client timeouts. Document expected duration in the
  description; consider MCP progress notifications in Phase 3.
- Duplicate-content rejection (identical `text` re-posted) will surface as an `api`
  error — worth a dedicated mapping to `validation` with "X rejects duplicate post
  text; vary the wording".

### B. "Summarize today's mentions and draft replies"

Runs entirely under the default `read-only` policy — a genuinely nice property (the
riskiest daily workflow needs no write opt-in because drafting stays in-model).

| # | Tool call | Result |
|---|---|---|
| 1 | `timeline_mentions {start_time: "2026-07-21T00:00:00Z", max_results: 50}` | mentions, compact |
| 2 | (per ambiguous mention) `post_get {id: parent_id}` or `search_recent {query: "conversation_id:…"}` | thread context |
| 3 | — model summarizes and drafts replies in its answer — | |

Friction log:
- **As cataloged, step 1 may not exist in this form**: `timeline_mentions` is "mentions
  of a user" (id input?) and doesn't list time bounds (F9). Without the `user: "me"`
  default and `start_time`, the flow becomes: `auth_status` → extract my id →
  `timeline_mentions {user_id}` → client-side date filtering over paged results —
  three extra steps and wasted read budget for the platform's most common agent task.
  F9 fixes this.
- **Reply context requires the compact shape to carry `reply_to`/`quoted` refs** — it
  does (02 §5.2). Good. `conversation_id:` search for deep threads is Basic-tier; fine.
- Canonical URLs on each mention (F3) matter here: the natural output is "…and here are
  the mentions worth replying to: [links]".
- The injection-guard note (04 §5) earns its keep in exactly this workflow — mentions
  are adversarial text by construction. Ensure the note is one field per *result*, not
  per item (token economy, and repetition dulls the warning).

### C. "Find the most-engaged post about topic T this week and quote-post it"

| # | Tool call | Result |
|---|---|---|
| 1 | (optional) `post_counts_recent {query: "T -is:retweet", granularity: "day"}` | volume shape — cheap signal whether one page will do |
| 2 | `search_recent {query: "T -is:retweet lang:en", max_results: 100, sort_order: "relevancy"}` | 100 compact posts with metrics |
| 3 | — model ranks client-side by `metrics` (likes+reposts+quotes) — | winner id |
| 4 | `post_create {text: "…", quote_id: winner_id}` | id + URL |

Friction log:
- **"Most-engaged" cannot be expressed to the API**: v2 recent search has no
  engagement-sort and no `min_likes`-style operator at Basic tier. Client-side ranking
  over one page is the only path — workable *because* the compact shape includes
  `public_metrics` (good), but it's a sampling of ≤ 100 posts, not a true maximum. The
  `search_recent` description should say so explicitly: "to find top-engaged posts,
  fetch a page and rank by `metrics` client-side; results are a sample, not a global
  maximum." An undocumented gap here means the model will confidently claim "the most
  engaged post" from a biased sample.
- Step 1→2 synergy (`post_counts_recent` to size the search) is a nice emergent
  pattern — worth mentioning in the counts tool's description.
- `sort_order` must be an enum with both values documented (F12); "relevancy" partially
  proxies engagement and is the right hint for this task.
- The one-page/no-auto-pagination rule (02 §5.3) bites hardest here; it's still the
  right trade — the budget rationale wins — but combined with the sampling caveat above.
- Step 4 crosses the policy boundary mid-workflow (read → `write:content`). Under
  `read-only`, the model does steps 1–3, then hits the `policy` error at step 4 — with
  F6's description annotation it would know *before* starting that step 4 needs
  operator action, and could say so upfront. Good test case for the
  registered-but-denied verdict below.

---

## Concrete renaming / merge / cut proposals

Legend: **M** = merge, **R** = rename, **C** = cut/defer from v1 registration, **K** = keep.

| Current | Proposed | Why |
|---|---|---|
| `like_create` / `like_delete` | **M** → `like_set {post, action: "like" \| "unlike"}` | Same policy class (`write:engagement`); halves count; domain-natural verbs (F14). Enum over an `undo` boolean — enums don't require negation reasoning. |
| `repost_create` / `repost_delete` | **M** → `repost_set {post, action: "repost" \| "unrepost"}` | Same as above. |
| `bookmark_create` / `bookmark_delete` | **M** → `bookmark_set {post, action: "add" \| "remove"}` | Same. |
| `follow_create` / `follow_delete` | **M** → `follow_set {user, action: "follow" \| "unfollow"}` | Same class (`write:social-graph`); single-target stays enforced. |
| `mute_create` / `mute_delete` | **M** → `mute_set {user, action: "mute" \| "unmute"}` | Same. |
| `block_create` / `block_delete` | **M** → `block_set {user, action: "block" \| "unblock"}`, classified `destructive:social-graph` | Merge after resolving F8; classify at the higher class. |
| `list_members_add` / `list_members_remove` | **M** → `list_member_set {list_id, user, action: "add" \| "remove"}` | Same class; single-user-per-call preserved. |
| `list_follow` / `list_unfollow` / `list_pin` (+ missing unpin) | **M** → `list_follow_set {list_id, action: "follow" \| "unfollow"}` and `list_pin_set {list_id, action: "pin" \| "unpin"}` | Fixes the pin/unpin asymmetry (F14); 3 broken tools → 2 complete ones. |
| `user_get` / `user_by_username` / `users_get` | **M** → `user_get {users: string[] (1–100), each: id \| handle \| @handle}` | One lookup tool; kills the id-vs-handle fork at the source (F2); 3 → 1. |
| `post_get` / `posts_get` | **M** → `post_get {ids: string[] (1–100), each: id \| status URL}` | Batch subsumes single; URL acceptance per F2; 2 → 1. |
| `list_posts` | **R** → `list_timeline` | Breaks the noun/verb ambiguity (F5) and aligns with the `timeline_*` family. |
| `list_members_list` | **R** → `list_members` | Removes the double-role `list…list` name (F5). |
| `search_all` | **R** → `search_archive` | Kills the "all ⊃ recent" selection trap (F5); description leads with "Pro tier". |
| `post_counts_all` | **R** → `post_counts_archive` | Same. |
| `list_create` / `list_update` / `list_delete` | **K** separate | `list_delete` is `destructive:content` — destructive ops stay standalone tools so policy denial and human review can target them precisely; never put a destructive action behind an enum value. Same rule keeps `post_delete` standalone. |
| `media_metadata_set` | **C** (fold into `media_upload {alt_text?}`) | One fewer tool and round trip; alt text at upload time is the ergonomic moment (walkthrough A). |
| `user_search`, `search_archive`, `post_counts_archive` | **C** from default registration — register only when tier ≥ Pro (config/inferred) | Pro-only ($5k/mo); standing schema cost + selection distractors for ~all users (F6). |
| `space_get`, `spaces_search`, `trends_by_location` | **C** to Phase 3 (roadmap already says so — mark it in the catalog) | Marginal for agent workflows; reclaim the tokens in v1. |
| `dm_*` (3), lists package (10 post-merge) | **K** design, **C** to Phase 3 registration (per roadmap) | Catalog should carry an explicit "phase" column so the v1 surface is readable from the doc. |

**Net effect**: 60 → ~46 at full surface after merges; a default Basic-tier
Phase-2 deployment registers ~28 tools. Both numbers should replace "~45" in docs/02
§5.1 and docs/03.

**On the `x_` prefix**: adopt it (`x_post_create`, `x_search_recent`, `x_user_get`).
Reasoning: X's domain nouns are the most collision-prone in the entire MCP ecosystem —
`post`, `user`, `list`, `search`, `media`, `timeline` all mean something in github,
slack, gdrive, and notion servers. Claude Code namespaces (`mcp__x__post_create`), so
there the prefix is redundant-but-harmless (~1–2 tokens/tool); but other clients
flatten tool lists, and even under namespacing the model's selection is driven by the
name+description string, where `x_` is the cheapest possible platform prior (one
character of brand). The double-prefix aesthetic (`mcp__x__x_post_create`) is a fair
objection but loses to cross-client robustness. Independent of the decision: **every
tool description must start with a platform anchor** — "X (Twitter): …" — descriptions
are the second-strongest selection signal and cost nothing.

---

## Registered-but-denied — verdict on roadmap open question #2

**Verdict: keep registered-but-denied as the default. It is the agent-friendly choice.**
From the model's perspective:

1. A typed `policy` error naming the cell and env var converts "tool missing" —
   which models resolve by hallucinating alternative approaches or declaring the task
   impossible — into "capability exists, gate is X, human can open it". That is
   strictly better information. Walkthrough C step 4 is the canonical case: the model
   can do the read work, then tell the user exactly what to enable.
2. A stable tool list across sessions and policy changes is prompt-cache-friendly:
   tool definitions sit in the cached prefix in Claude-family clients, and a list that
   never changes shape means cache hits and no client re-negotiation.
3. The failure mode to guard: models retrying denied tools or attempting workarounds.
   The error text must be terminal-sounding — "denied by local policy
   (`write:dm` not in preset `read-only`); this cannot be changed from within this
   session; ask the operator to set X_MCP_POLICY. Do not retry." Belt-and-braces with
   `retryable: false, fix: "operator"` (F13).
4. The real cost is context, not confusion (F6) — hence the two levers:
   `X_MCP_HIDE_DENIED=1` opt-in for hardened read-only deployments, and
   registration-time description annotation "(disabled by current policy …)" so the
   state is visible *before* a wasted call. With those, the design is strictly better
   than hiding.

---

## Recommendations (prioritized)

**R1 — Do before Phase 1 freeze (shapes the catalog):**
- Apply the merge/rename/cut table; restate the real tool counts (F1, F5, F14).
- Specify the identifier-resolution convention: `user` accepts id/handle/@handle with
  server-side cached resolution; post params accept ids or status URLs; self-scoped
  tools default to `"me"` (F2, F9).
- Add `url` to every rendered post; add `note_tweet` to the compact preset with an
  explicit `truncated` marker; define the zero-results render (F3).
- Replace `ignore_budget` with the env-side `X_MCP_READ_BUDGET_MODE` (F4).
- Resolve the block/destructive classification contradiction (F8).

**R2 — Use the MCP server `instructions` field.** The corpus repeats conventions
(pagination, `raw`, policy model, id resolution) that would otherwise need restating in
~30 descriptions. The MCP initialize response carries a server-level `instructions`
string that capable clients inject once into the system context. Put the five
conventions there (~150 tokens, once): identifier forms accepted, `page_token` ↔
`next_token` bridge, `raw` semantics and cost, the policy model in one sentence, "call
`auth_status` first in write sessions". This is the single highest-leverage/lowest-cost
DX addition available and the corpus currently doesn't mention it.

**R3 — Emit MCP tool annotations.** The two-axis classification maps directly onto the
spec's tool annotations: `read:*` → `readOnlyHint: true`; `destructive:*` →
`destructiveHint: true`; merged `*_set` tools → `idempotentHint: true` where true; all →
`openWorldHint: true`. Clients (including Claude) use these for permission-prompt
policy and display. The classification work is already done — this is free signal being
left on the table. Add to docs/02 §5 and the ToolDef type.

**R4 — Error taxonomy: add `retryable` + `fix: "agent" | "operator"` structured fields
and the per-type remediation texts from F13.** Keep the excellent ambiguous-write
prose. Add the thread-resume prose to `post_create` failures (walkthrough A) and the
sampling caveat to `search_recent`'s description (walkthrough C).

**R5 — Schema polish pass (Phase 1, alongside implementation):** enums for
`reply_settings`/`sort_order`/`granularity`/`exclude`; documented ranges and defaults
for `max_results`; weighted-length pre-validation with actionable message; poll/media
exclusivity refinements; example queries in `search_recent`; `raw` description warning
+ tighter cap; `author: {id, handle, name}` (F11, F12, F15).

**R6 — Add a "phase" column to docs/03** so the v1-registered surface is readable from
the catalog itself, and mark Pro-only tools as conditionally registered (F6). Reviews,
budget math, and the README all become checkable against one table.

None of the findings undermine the architecture — they are all catalog- and
contract-level. With R1–R4 folded into the docs, this design would be among the most
agent-legible MCP surfaces I've reviewed, and I'd expect it to hold the line as the
surface grows in Phase 3.
