# 01 — X API landscape

Everything the server builds on. Facts below reflect the X developer platform as of
**mid-2026**. The platform changed its **entire business model** between this project's
first design and its senior review (subscription tiers → pay-per-use credits, see §3),
so treat every number as perishable: re-verify against
[`https://docs.x.com/x-api/llms.txt`](https://docs.x.com/x-api/llms.txt) and the
[X API changelog](https://docs.x.com/changelog) at every phase boundary (standing rule 2
of [08-implementation-roadmap.md](08-implementation-roadmap.md)). **Last fact-checked:
2026-07-22.**

## 1. API generations

| Generation | Status | Relevance to x-mcp |
|---|---|---|
| **API v2** (`api.x.com/2/*`) | Current, actively developed | The only API surface x-mcp targets |
| API v1.1 | Legacy; most endpoints retired | Not used. Media upload — historically the last v1.1 holdout — moved to v2 dedicated endpoints; **v1.1 media upload retired 2025-06-09** (deadline extended twice from 2025-03-31) |
| Enterprise (Gnip-heritage: PowerTrack, etc.) | Contract-only | Out of scope |

## 2. Authentication

Three auth contexts exist; x-mcp supports all three, selected by `X_MCP_AUTH_MODE`.

### 2.1 OAuth 2.0 Authorization Code with PKCE (user context) — **primary**

- Fine-grained scopes; tokens are scoped, short-lived access tokens (~2 h) plus a
  refresh token when `offline.access` is granted.
- **Refresh-token rotation**: in practice every refresh returns a *new* refresh token
  and invalidates the old one. This rotation is **observed behavior, not documented
  contract** on docs.x.com — so the refresh code must persist the new pair atomically
  (a hard correctness requirement, see [04-security.md](04-security.md) §4) **and**
  tolerate a *non-rotating* response (the same refresh token returned) without
  corrupting the store (see [07-corner-cases.md](07-corner-cases.md) AUTH-6).
- Scopes the tool catalog needs (superset; requested per policy preset):
  `tweet.read tweet.write tweet.moderate.write users.read follows.read follows.write
  like.read like.write list.read list.write bookmark.read bookmark.write
  dm.read dm.write mute.read mute.write block.read block.write space.read
  media.write offline.access`
  The official scope list additionally contains `users.email` (not needed by any
  cataloged tool); `auth_status` displays granted scopes **verbatim** rather than
  validating against a closed list, so an unknown scope in a token file never confuses it.
- x-mcp does **not** run the browser authorization flow itself in v1; the `authorize`
  subcommand performs the one-time PKCE dance locally (loopback redirect) and writes the
  initial token file. The server only *uses and refreshes* tokens.

### 2.2 OAuth 1.0a user context — legacy fallback

- Still accepted by v2 endpoints; some developer accounts have long-lived 1.0a
  app+user key quadruples (api key/secret + access token/secret).
- No scopes, no expiry, HMAC-SHA1 request signing. Supported because many existing
  hobby apps only have these credentials; feature-gated identically to OAuth 2.0.

### 2.3 App-only Bearer token (application context)

- Read-only surface: search, post/user lookup, some timelines. No engagement writes,
  no DMs, no `me`.
- Simplest possible setup (`X_MCP_BEARER_TOKEN`), ideal for read-only research use.

## 3. Access model: pay-per-use credits & availability

On **2026-02-06** X retired the Free/Basic/Pro **subscription tiers** for new developers
and replaced them with **pay-per-use credit pricing**. x-mcp's target audience (new
hobby/agent developers) therefore *cannot* buy Basic or Pro and has **no free tier** —
pay-per-use is the only model available to them. The legacy tiers survive **only for
developers who subscribed before the cutover** and are documented in
[Appendix A](#appendix-a--legacy-tiers-grandfathered), not the main flow.

This is a structural change, not a number update. It removes three load-bearing
assumptions from the original design: (a) a per-tool *minimum tier*, (b) *tier inference
from 403 responses*, and (c) a *monthly post-read cap* as the budget unit. §3.2–§3.4
replace all three.

### 3.1 Pay-per-use credit pricing *(verified 2026-07-22)*

No subscriptions — credits are purchased upfront and spent per resource read and per
write request. Rates (source:
[docs.x.com/x-api/getting-started/pricing](https://docs.x.com/x-api/getting-started/pricing),
[changelog](https://docs.x.com/changelog)):

| Operation | Price | Cost class (see [Appendix B](#appendix-b--per-endpoint-static-cost-table)) |
|---|---|---|
| Post read (per post returned) | **$0.005** | `read-post` |
| User read (per user) | **$0.010** | `read-user` |
| DM event read (per event) | $0.010 | `read-dm` |
| Follows read — follower/following (per resource) | $0.010 | `read-follows` |
| List / Space / Community-Note read (per resource) | $0.005 | `read-list-space` |
| Like / Mute / Block read (per resource) | $0.001 | `read-lmb` |
| **Owned Reads** — your own data (per resource) | **$0.001** | `read-owned` |
| Post created | **$0.015** | `write-post` |
| **Post containing a URL** (since **2026-04-16**) | **$0.20** | `write-post-url` |
| DM sent | $0.015 | `write-dm` |
| List created | $0.010 | `write-list` |
| Engagement writes (like/repost/bookmark/follow/mute/block, list follow/pin, deletes, media, hide-reply) | **not separately priced** on the pricing page as of 2026-07-22 | `write-engagement` — capture in Phase 1 live test |

- **Hard platform cap: 2,000,000 post reads per monthly billing cycle.** Higher volumes
  require an Enterprise plan. This is the *only* hard cap under pay-per-use.
- Credits are purchased upfront; the platform advertises up to 20 % back in xAI API
  credits.
- **Owned Reads** ($0.001/resource) make own-data tools (`timeline_mentions`,
  `bookmarks_list`, `liked_posts_list`, own `timeline_user`, `auth_status`, `usage_get`)
  an order of magnitude cheaper — worth surfacing in the per-call cost estimate.

**Design consequences.** Every write costs real money; a link-bearing post costs **13×**
a plain post. So (a) each result surfaces its estimated `cost_usd`
([07](07-corner-cases.md) COST-3), (b) `post_create` warns on URL-bearing text
distinctly (COST-4), and (c) the budget must be *dollars of prepaid credit spanning
reads and writes* (§3.4), not a read count. And because there is **no tier-enrollment
403 anymore**, capability is discovered from a declared availability set (§3.3), never
inferred lazily from 403s.

### 3.2 Availability classes (replaces the *Tier* column)

Every endpoint / tool declares an **availability class** and a **cost class** instead of
a minimum tier. Availability classes are consumed by
[03-tool-catalog.md](03-tool-catalog.md) (its former *Tier* column becomes
*availability* + *cost class*) and by the registry (§3.3).

| Availability class | Meaning | In the conservative default? |
|---|---|---|
| `app+user` | Reachable with an app-only bearer **or** user tokens (search incl. full-archive, lookups, some timelines, counts). Full-archive search/counts are **pay-per-use reachable** as of 2026 (no longer a Pro gate). | **Yes** |
| `user-only` | Requires user-context OAuth 2.0/1.0a tokens (writes, DMs, home timeline, `me`, engagement). Degrades to an app-only shape (no 403) when running app-only — [07](07-corner-cases.md) AUTH-15. | **Yes** |
| `pilot` | Behind an enrollment/pilot program (e.g. Community Notes *AI Note Writer* — X Developer AI access). | No — opt-in |
| `premium-user` | Requires an **account property on the authenticated user** (an X Premium subscription), not an API plan — e.g. personalized trends. | No — opt-in |
| `enterprise` | Only on an Enterprise contract (> 2 M reads/mo, compliance/firehose/replay). | No — opt-in |

The **cost class** is the per-resource / per-request price bucket from §3.1; the full
endpoint→class mapping is [Appendix B](#appendix-b--per-endpoint-static-cost-table).

### 3.3 Availability detection (replaces 403-based tier inference)

The retired design "infers capability lazily from 403 responses and caches it for the
session." That is **dead under pay-per-use**: a new account never emits a
tier-enrollment 403 — it emits *insufficient-credit* (`billing`) failures instead, which
say nothing about which surfaces the account can reach. The replacement is an **explicit,
operator-declared availability set** (roadmap WP-0.10):

- **`X_MCP_AVAILABILITY`** — comma-separated availability classes the operator asserts
  the account can reach. **Conservative default (unset):** `app+user,user-only` (the
  universally-available pay-per-use surface). The specially-provisioned classes
  (`pilot`, `premium-user`, `enterprise`) are **off** until explicitly listed.
- **Surfaced in `auth_status`.** The resolved availability set is reported alongside
  `context` / `user` / `scopes` / `policy` ([07](07-corner-cases.md) AUTH-15), so the
  agent and operator can see exactly what the account is declared to reach.
- **Consumed by the registry** ([08](08-implementation-roadmap.md) WP-1.3): a tool whose
  declared availability class is **not** in the resolved set is **not registered at
  all**. This gates only the specially-provisioned classes — `pilot` (Community Notes),
  `premium-user` (personalized trends), `enterprise` (firehose/compliance). Full-archive
  search/counts and `user_search` are `app+user` (§3.2), so they are **not** gated here;
  they register on the conservative default and are restrained by the credit budget, not
  by availability. Availability gating is *registration-time* and is **distinct** from
  policy denial (POL-7, which keeps denied tools registered + annotated): a tool the
  account cannot reach should not tempt the agent into burning credits on a guaranteed
  failure.
- **`doctor` may probe on request** ([08](08-implementation-roadmap.md) WP-2.2): the
  `doctor` subcommand may, **only when asked** (an explicit flag), issue **one** call to
  a gated endpoint to confirm reachability and help the operator populate
  `X_MCP_AVAILABILITY`. Because the probe spends a credit, it is never automatic.
- **Error taxonomy.** The former `tier` / `TierGated` class is **demoted to legacy-only**
  (grandfathered enrollment 403s — [Appendix A](#appendix-a--legacy-tiers-grandfathered)).
  Under pay-per-use the primary capability signals are: **`billing`** (platform
  credit/enrollment rejection — real error body is captured in the Phase 1 live test,
  [07](07-corner-cases.md) COST-6, since it is not publicly documented), **`budget`**
  (the local session budget, §3.4), and **availability gating** (registration-time,
  above). *The taxonomy itself lives in [02-architecture.md](02-architecture.md) §5 and
  `core/errors.ts` — this doc drives those changes; see the T-010 handoff for T-011/T-102.*

### 3.4 Session credit budget

The budget unit is **dollars of prepaid credit for the session**, covering **reads and
writes** (roadmap WP-0.1). The old monthly-read-cap model and its usage-API seeding are
removed.

- **`X_MCP_CREDIT_BUDGET`** — optional soft budget in **USD per session**.
  **`X_MCP_BUDGET_MODE`** — `warn` (default) | `hard`. These replace the removed
  `X_MCP_READ_BUDGET`.
- **Priced from the static cost table** ([Appendix B](#appendix-b--per-endpoint-static-cost-table)):
  resource type × count for reads, per-request price for writes.
- **State is per-process and advisory** ([07](07-corner-cases.md) COST-2): it starts at
  **zero spend**, counts locally, and **resets on restart**. It **never seeds from a
  usage API** — the platform's usage endpoint reports read *counts*, not dollars (§3.5),
  so it cannot seed a dollar budget. This is not authoritative platform accounting.
- **Behavior.** Every result carries `cost_usd` and the session running total (COST-3).
  A warning fires at **90 %** (COST-5); in `warn` mode results past **100 %** carry a
  `budget_warning` and proceed; in `hard` mode reads **and** writes past 100 % fail with
  the typed `budget` error — *"operator-set limit; cannot be changed from within this
  session"* (COST-1). Check-and-reserve is atomic so two interleaved near-limit calls
  cannot both pass in `hard` mode (CONC-2). URL-bearing posts price the $0.20 line
  distinctly from the $0.015 base (COST-4).
- **No per-call override** exists in any tool schema (COST-1): the operator sets the
  limit; the model cannot raise it (the old `ignore_budget` per-call flag is removed).
- The **2 M post-reads/month** platform cap is **not** pre-tracked locally (monthly
  state needs persistence the design deliberately omits); it surfaces verbatim as
  `billing` when hit (COST-7) and can be inspected on demand via `usage_get` (§3.5).

### 3.5 Platform usage endpoint — fact-check *(decides WP-3.11 / T-317)*

**Finding (2026-07-22): `GET /2/usage/tweets` still exists under pay-per-use.**
Verified against
[docs.x.com/x-api/usage/get-usage](https://docs.x.com/x-api/usage/get-usage) and the
[llms.txt index](https://docs.x.com/x-api/llms.txt).

- **Returns:** `project_id`, `project_usage` (posts read this cycle), `project_cap`
  (= 2,000,000), `cap_reset_day`, `daily_project_usage[]`, `daily_client_app_usage[]`.
  Query params: `days` (1–90, default 7), `usage.fields`. Auth: **app bearer token** +
  an approved developer account — **no tier named** (the old "Basic" label is obsolete).
- **It reports post-read *counts* against the 2 M cap only — NOT dollar/credit spend.**
  Credit and dollar spend are visible only in the Developer Console (`console.x.com`);
  there is **no documented spend/credits API**.
- **Consequence for WP-3.11 / T-317 — GO, scoped:** `x_usage_get` *can* ship, but as a
  **read-cap reporter** (posts read vs the 2 M cap), **not** a credit-spend mirror. It
  does **not** close the COST-1 loop for *dollars* — no spend API exists — so the local
  session estimate (§3.4) remains the only per-dollar signal. Because it reports counts
  and not dollars, it is **not** used to seed the session credit budget.

## 4. Rate limiting

- Enforced **per endpoint, per 15-minute window**, separately for user context and app
  context. Every response carries `x-rate-limit-limit`, `x-rate-limit-remaining`,
  `x-rate-limit-reset` (epoch seconds).
- Some write endpoints additionally have 24-hour caps with their own headers — e.g.
  `POST /2/tweets` is 100/15 min (user) **and** 10,000/24 h (app,
  `x-app-limit-24hour-*`). Rate limits are orthogonal to the pay-per-use **credit
  budget** (§3.4) and the 2 M-reads/mo platform cap (§3.1); all three can bite
  independently.
- x-mcp behavior (details in [02-architecture.md](02-architecture.md) §7):
  - Track the latest headers per (endpoint-class, auth-context) in memory; expose via
    `rate_limit_status`.
  - On 429: **never** blind-retry; return a typed `rate-limit` error carrying the
    reset timestamp so the agent can decide, except for idempotent GETs where a single
    delayed retry is attempted if the reset is ≤ 5 s away.
  - Preemptive refusal when `remaining === 0` and reset is in the future — saves the
    request and gives the model a deterministic error instead of a 429.

## 5. Endpoint inventory used by the tool catalog

Grouped as the tool packages group them ([03-tool-catalog.md](03-tool-catalog.md)).
Availability classes in parentheses are from §3.2; everything unmarked is `app+user` or
`user-only` by auth context.

- **Posts**: `POST /2/tweets`, `DELETE /2/tweets/:id`, `GET /2/tweets`, `GET
  /2/tweets/:id`, `PUT /2/tweets/:id/hidden` (hide reply)
- **Search & counts**: `GET /2/tweets/search/recent` (7 days), `GET
  /2/tweets/search/all` (full-archive since 2006 — `app+user`, pay-per-use reachable),
  `GET /2/tweets/counts/recent`, `GET /2/tweets/counts/all`
- **Timelines**: `GET /2/users/:id/tweets`, `GET /2/users/:id/mentions`, `GET
  /2/users/:id/timelines/reverse_chronological`
- **Engagement**: likes (`POST/DELETE /2/users/:id/likes`, `GET /2/tweets/:id/liking_users`,
  `GET /2/users/:id/liked_tweets`), reposts (`POST/DELETE /2/users/:id/retweets`,
  `GET /2/tweets/:id/retweeted_by`), quotes (`GET /2/tweets/:id/quote_tweets`),
  bookmarks (`POST/DELETE/GET /2/users/:id/bookmarks`)
- **Users**: `GET /2/users/me`, `GET /2/users/:id`, `GET /2/users/by/username/:u`,
  batch variants, `GET /2/users/search` (`app+user`, pay-per-use reachable)
- **Social graph**: follows (`POST/DELETE /2/users/:id/following`, `GET
  /2/users/:id/followers`, `GET /2/users/:id/following`), blocks, mutes
- **DMs** *(three event lookups only — there is **no** list-conversations endpoint)*:
  `GET /2/dm_events`, `GET /2/dm_conversations/with/:participant_id/dm_events`, `GET
  /2/dm_conversations/:dm_conversation_id/dm_events`; send via `POST
  /2/dm_conversations/:id/messages` and `POST /2/dm_conversations/with/:user_id/messages`;
  create group conv `POST /2/dm_conversations`; `DELETE /2/dm_events/:id`. **DM events
  are retained only 30 days** via the API (surfaced per [07](07-corner-cases.md) DM-2).
- **Lists**: full CRUD `POST/PUT/DELETE /2/lists*`, members, pins, follows, `GET
  /2/lists/:id/tweets`
- **Media** *(dedicated v2 paths — primary)*: `POST /2/media/upload/initialize` →
  `POST /2/media/upload/{id}/append` (segments < 5 MB) → `POST
  /2/media/upload/{id}/finalize`; `GET /2/media/upload` (STATUS); `POST /2/media/metadata`
  (alt text). The one-shot `POST /2/media/upload` remains a small-file fast path. v1.1
  paths (retired 2025-06-09) never appear.
- **Spaces**: `GET /2/spaces/:id`, `GET /2/spaces/search`
- **Trends**: `GET /2/trends/by/woeid/:id`; personalized trends
  (`GET /2/users/personalized_trends` — `premium-user`: requires X Premium on the
  authenticated user)
- **Ops**: `GET /2/usage/tweets` (reports posts-read vs the 2 M/mo cap; **no dollar
  spend** — §3.5)

Expansions & fields: v2 is sparse by default; almost every read accepts
`tweet.fields`, `user.fields`, `expansions`, `media.fields`, `poll.fields`,
`place.fields`. The server requests a **curated default field set** tuned for LLM
consumption (see architecture §8) rather than exposing raw field lists as tool params.

## 6. Platform policy constraints (Developer Agreement & Automation Rules)

Not legal boilerplate — these shape the tool design:

- **No spam / bulk engagement**: mass-follow, mass-like, duplicate posting are
  banned. x-mcp adds friction by classifying these as `write:social-graph` /
  `write:content` operations that require explicit policy opt-in, and never exposes
  batch write tools (no "follow these 50 users" tool). The 10,000/24 h app-level post
  cap (§4) is itself a platform anti-spam backstop.
- **Automated posts must be disclosed** where the product requires it (automated
  account labels); X also expects bot accounts to link the responsible account in the
  bio. Documented as an operator responsibility in the README.
- **Data retention**: full post objects fetched via the API may be cached only
  transiently; x-mcp stores nothing on disk beyond tokens and config, which keeps it
  compliant by construction.
- **User consent**: user-context tokens act as the human; the policy model exists so
  an agent can't silently escalate from "read my timeline" to "DM my followers".

## 7. Known volatility

Things most likely to have changed at any point in time (re-verify on every release —
standing rule 2 of [08](08-implementation-roadmap.md); items 1–4 below all changed
within the six months before this rewrite):

1. **Pay-per-use rates** (§3.1) — post/user/write prices, the $0.20 URL-post line, the
   Owned-Reads discount, and the 2 M-reads cap. The whole model replaced tiers on
   2026-02-06 and the URL-post price landed 2026-04-16.
2. Which surfaces the legacy tiers still include, and when grandfathered accounts are
   migrated to pay-per-use ([Appendix A](#appendix-a--legacy-tiers-grandfathered)).
3. Media upload path details (v1.1 → v2 dedicated-endpoint migration tail).
4. DM endpoint surface and the 30-day retention window (XChat may shift the basis again).
5. Trends and Spaces endpoints (newest surface, still evolving); personalized-trends
   `premium-user` gating.

The re-check is scripted as part of the fixture-refresh discipline
([05-testing-and-quality.md](05-testing-and-quality.md)): `curl
https://docs.x.com/x-api/llms.txt` + targeted `.md` page diffs at each phase boundary.

---

## Appendix A — Legacy tiers (grandfathered)

The Free/Basic/Pro/Enterprise **subscription** model below was **retired for new
developers on 2026-02-06** and is **closed to new signups**. It survives **only** for
developers who subscribed before the cutover, and only the `tier` error class (legacy
enrollment 403s) applies to them. New developers use pay-per-use (§3) exclusively; this
appendix exists so the server can still reason about a grandfathered account and so the
history behind the numbers is not lost.

| Tier | Price | Writes | Reads | Notes |
|---|---|---|---|---|
| **Free** | $0 | ~500 posts/mo (final legacy state; the earlier ~1,500 figure was an older era) | ~100 post-reads/mo | **Like and Follow endpoints removed from Free on 2025-08-22.** Discontinued for new signups; recently-active Free users were moved to pay-per-use with a one-time $10 credit voucher |
| **Basic** | ~$200/mo ($175/mo annual) | ~3,000/mo user, ~50,000/mo app | ~15,000 posts/mo (final legacy; the ~10,000 launch figure still appears in some 2026 write-ups) | Closed to new signups; third-party reporting says legacy Basic migrates to pay-per-use after 2026-06-01 (**not confirmed on docs.x.com**) |
| **Pro** | ~$5,000/mo ($4,500/mo annual) | ~300,000/mo app | ~1,000,000 posts/mo | Full-archive search + filtered stream included (legacy) |
| **Enterprise** | Custom | Custom | Custom | Streams, replay, compliance firehose. Third-party reporting cites a ~$42,000/mo entry point — **unverifiable from official docs** |

*Legacy prices/caps are corrected against the X-platform review fact-check
([reviews/02-x-platform-review.md](reviews/02-x-platform-review.md) F3–F11). Third-party
sources were used only for legacy-tier history and are marked as such there.*

## Appendix B — Per-endpoint static cost table

Input to `core/budget`'s static cost table ([08](08-implementation-roadmap.md) WP-1.2,
task T-112) and to the per-tool *cost class* column added to
[03-tool-catalog.md](03-tool-catalog.md) (task T-012). Prices are the pay-per-use rates
verified 2026-07-22 (§3.1). Reads are priced **per resource returned** (count from the
response); writes **per request**.

| Cost class | Unit price | Applies to (endpoint families / tools) |
|---|---|---|
| `read-post` | $0.005 / post | `post_get`, `posts_get`, `search_recent`, `search_all`, `post_counts_*`, `timeline_*` (non-owned), `list_posts`, `quote_posts_list`, `reposted_by_list` |
| `read-user` | $0.010 / user | `user_get`, `users_get`, `user_by_username`, `user_search`, `followers_list`/`following_list` payload users |
| `read-follows` | $0.010 / resource | follower/following graph reads (`followers_list`, `following_list`) |
| `read-dm` | $0.010 / event | `dm_events_list` |
| `read-list-space` | $0.005 / resource | `list_get`, `lists_owned`, `list_members_list`, `space_get`, `spaces_search`, Community-Note reads |
| `read-lmb` | $0.001 / resource | like/mute/block reads (`liking_users_list`, `blocks_list`, `mutes_list`) |
| `read-owned` | $0.001 / resource | **own-data** reads: `timeline_mentions`, own `timeline_user`, `bookmarks_list`, `liked_posts_list`, `auth_status`, `usage_get` (Owned Reads discount) |
| `write-post` | $0.015 / request | `post_create` (no URL) |
| `write-post-url` | $0.20 / request | `post_create` when `text` contains a URL (COST-4) |
| `write-dm` | $0.015 / request | `dm_send` |
| `write-list` | $0.010 / request | `list_create` |
| `write-engagement` | **unpriced on the pricing page (2026-07-22)** — capture in Phase 1 live test, treat as nominal/$0 locally until confirmed | `like_*`, `repost_*`, `bookmark_*`, `follow_*`, `mute_*`, `block_*`, `post_delete`, `list_update`/`list_delete`, `list_members_*`, `list_follow`/`list_unfollow`/`list_pin`, `post_hide_reply`, `media_upload`, `media_metadata_set` |

Notes:

- The **same read** can fall in `read-owned` instead of its base class when it targets
  the authenticated user's own data. Of the shipped tools only `x_timeline_mentions`
  models this discount locally (cost class `owned`); `x_timeline_user` prices
  statically as `read-post` even when the target resolves to `me` — the own-vs-other
  cost resolution is not modeled for it (noted 2026-07-31, T-214 audit; revisit if
  the Owned Reads discount proves material in live captures).
- `write-engagement` is the one gap in the published price list; its real cost (and the
  real `billing` error body, COST-6) is a named Phase 1 live-capture task. Until then
  the budget counts it as $0 and the docs flag the uncertainty rather than guessing.
- A URL-post is **13×** a plain post ($0.20 vs $0.015) — the single most expensive
  routine operation; `post_create` must warn distinctly (COST-4).
