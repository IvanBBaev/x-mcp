# X platform review — x-mcp design corpus

- **Reviewer role**: Senior platform/API integration engineer, X (Twitter) developer platform
- **Date**: 2026-07-21
- **Scope**: Fact-check of [docs/01-api-landscape.md](../01-api-landscape.md) and the
  tier/scope/endpoint claims in [docs/03-tool-catalog.md](../03-tool-catalog.md) against
  live X developer documentation (docs.x.com, developer.x.com, devcommunity.x.com);
  platform-realism pass over the tool catalog.
- **Overall verdict**: **needs-rework** — the architecture, tool surface, and security
  model are sound and mostly platform-accurate, but the corpus is built on the
  **Free/Basic/Pro subscription tier model that X retired on 2026-02-06** in favor of
  pay-per-use credit pricing. Tier gating is a load-bearing design input (per-tool
  `Tier` column, tier inference from 403s, `TierGated` error type, read-budget design),
  so docs/01 §3 and the catalog's Tier column need structural revision, not just number
  updates. Everything else needed only point corrections.

---

## 1. Fact-check table

Every `(verify)`-marked claim from docs/01 (plus the tier/endpoint claims the catalog
depends on). "Legacy" means the pre-2026-02-06 subscription tiers, which still exist
**only** for developers subscribed before the cutover.

| # | Claim (docs/01) | Claimed value | Verified value (as of 2026-07-21) | Source | Status |
|---|---|---|---|---|---|
| F1 | Tier model: Free/Basic/Pro/Enterprise subscriptions | current | **Replaced 2026-02-06** by pay-per-use credit pricing for all new developers; no subscriptions. Legacy Basic/Pro persist for pre-cutover subscribers only; Free tier discontinued (recently-active Free users moved to pay-per-use with a one-time $10 credit voucher) | [docs.x.com/x-api/getting-started/pricing](https://docs.x.com/x-api/getting-started/pricing), [docs.x.com/changelog](https://docs.x.com/changelog), [gigazine.net 2026-02-09](https://gigazine.net/gsc_news/en/20260209-x-api-pay-per-use/) | **CORRECTED** |
| F2 | Free price | $0 | Tier no longer exists for new signups | pricing page (no Free/Basic/Pro mentioned at all) | **CORRECTED** |
| F3 | Free writes | ~500/mo (user), ~1,500/mo (app) | Final legacy state: **500 posts/mo** (cut from 1,500 in 2024). The 500-user/1,500-app split conflates two eras. Additionally, **Like and Follow endpoints were removed from Free on 2025-08-22** | [changelog](https://docs.x.com/changelog), [postproxy.dev](https://postproxy.dev/blog/x-api-pricing-2026/) | **CORRECTED** |
| F4 | Free reads | ~100 post-reads/mo | 100 reads/mo (final legacy state) — correct historically, moot now | [postproxy.dev](https://postproxy.dev/blog/x-api-pricing-2026/) | CONFIRMED (legacy, now moot) |
| F5 | Basic price | ~$200/mo | $200/mo ($175/mo annual) — **legacy only, closed to new signups**; third-party reporting says legacy Basic accounts migrate to pay-per-use after 2026-06-01 (not confirmed on docs.x.com) | [postproxy.dev](https://postproxy.dev/blog/x-api-pricing-2026/), [wearefounders.uk](https://www.wearefounders.uk/the-x-api-price-hike-a-blow-to-indie-hackers/) | CONFIRMED (legacy) |
| F6 | Basic writes | ~3,000/mo user, ~50,000/mo app | 3,000 user / 50,000 app (legacy) | [postproxy.dev](https://postproxy.dev/blog/x-api-pricing-2026/) | CONFIRMED (legacy) |
| F7 | Basic reads | ~10,000 posts/mo | **15,000/mo** in final legacy state (10,000 was the 2023 launch figure; sources still disagree — 10k appears in some 2026 write-ups) | [postproxy.dev](https://postproxy.dev/blog/x-api-pricing-2026/), [twitterapi.io](https://twitterapi.io/blog/x-api-cost-breakdown-2026) | **CORRECTED** |
| F8 | Pro price | ~$5,000/mo | $5,000/mo ($4,500/mo annual) — legacy only | [postproxy.dev](https://postproxy.dev/blog/x-api-pricing-2026/) | CONFIRMED (legacy) |
| F9 | Pro writes | ~300,000/mo app | 300,000/mo app (legacy) | same | CONFIRMED (legacy) |
| F10 | Pro reads | ~1,000,000 posts/mo | 1,000,000/mo, full-archive search + filtered stream included (legacy) | same | CONFIRMED (legacy) |
| F11 | Enterprise | Custom | Custom; third-party reporting ~$42,000/mo entry point (not published on docs.x.com) | [xpoz.ai](https://www.xpoz.ai/blog/guides/understanding-twitter-api-pricing-tiers-and-alternatives/) | CONFIRMED (price point UNVERIFIABLE from official docs) |
| F12 | — (missing) | — | **Pay-per-use rates** (the current model): $0.005/post read, $0.010/user read, $0.010/DM event read, $0.010/follows read, $0.005/list-space-community-note read, $0.001/like-mute-block read; **$0.015 per post created, $0.20 per post containing a URL** (since 2026-04-16), $0.015/DM sent, $0.010/list created; **"Owned Reads"** of your own data at $0.001/resource; hard cap **2M post reads/mo** (above → Enterprise); credits purchased upfront, up to 20% back in xAI API credits | [pricing](https://docs.x.com/x-api/getting-started/pricing), [changelog](https://docs.x.com/changelog) | **NEW — must be added** |
| F13 | OAuth 2.0 access-token lifetime ~2 h | ~2 h | "valid for two hours" (refresh token issued only with `offline.access`) | [authorization-code](https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code) | CONFIRMED |
| F14 | Refresh-token rotation (new refresh token each use, old invalidated) | asserted | **Not explicitly documented** on docs.x.com; rotation (single-use refresh tokens) is consistently observed and community-documented. Design's atomic-persist requirement remains correct and necessary | [devcommunity 214281](https://devcommunity.x.com/t/twitter-api-refreshing-access-tokens/214281), [devcommunity 168899](https://devcommunity.x.com/t/refresh-token-expiring-with-offline-access-scope/168899) | UNVERIFIABLE in official docs (behavior CONFIRMED in practice) |
| F15 | Scope list incl. `media.write` | 21 scopes listed | All 21 listed scopes exist verbatim, incl. `media.write`. Official list also has **`users.email`** (not in doc — fine, not needed) | [authorization-code](https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code) | CONFIRMED |
| F16 | Rate-limit headers `x-rate-limit-limit/-remaining/-reset` (epoch s) | as named | Exact header names confirmed; 15-min windows standard, some endpoints 24-h windows; separate app-context vs user-context pools | [rate-limits](https://docs.x.com/x-api/fundamentals/rate-limits) | CONFIRMED |
| F17 | 24-h caps on post creation | asserted | `POST /2/tweets`: 100 req/15 min (user), **10,000 req/24 h (app)**; `DELETE /2/tweets/:id` 50/15 min (user); DM create 1,440/24 h; media initialize 1,875/15 min user, 180,000/24 h app | [rate-limits](https://docs.x.com/x-api/fundamentals/rate-limits) | CONFIRMED |
| F18 | v1.1 media upload deprecated in 2025; media moved to `POST /2/media/upload` | asserted | v2 media endpoints launched 2025-01-16; v1.1 media upload sunset **2025-06-09** (after extension from 2025-03-31). `POST /2/media/upload` (one-shot + command style) exists **and** dedicated endpoints: `POST /2/media/upload/initialize`, `POST /2/media/upload/{id}/append`, `POST /2/media/upload/{id}/finalize`, `GET /2/media/upload` (STATUS) | [devcommunity 238196](https://devcommunity.x.com/t/deprecating-the-v1-1-media-upload-endpoints/238196), [devcommunity 241818](https://devcommunity.x.com/t/media-upload-endpoints-update-and-extended-migration-deadline/241818), [initialize-media-upload](https://docs.x.com/x-api/media/initialize-media-upload) | CONFIRMED (+ new dedicated paths) |
| F19 | `POST /2/media/metadata` (alt text) | as named | Confirmed exact path `POST /2/media/metadata` | [create-media-metadata](https://docs.x.com/x-api/media/create-media-metadata) | CONFIRMED |
| F20 | `GET /2/tweets/search/recent` (7 days) | Basic+ in catalog | Path/window confirmed; now **"available to all developers"** (pay-per-use). `max_results` **10–100**. Query length 512 chars (4,096 Enterprise) | [search introduction](https://docs.x.com/x-api/posts/search/introduction), [search-recent-posts](https://docs.x.com/x-api/posts/search-recent-posts) | CONFIRMED (tier label obsolete) |
| F21 | `GET /2/tweets/search/all` Pro+ | Pro | Now **"available to pay-per-use and Enterprise customers"** — no longer a $5k-gate for new devs. `max_results` **10–500**; archive back to March 2006; query 1,024 chars | [search introduction](https://docs.x.com/x-api/posts/search/introduction) | **CORRECTED** |
| F22 | `GET /2/users/search` tier-gated (Pro in catalog) | Pro | Endpoint confirmed (`GET /2/users/search`); launched 2023-12 "exclusively on Pro & Enterprise" (legacy); now reachable pay-per-use. `max_results` **1–1000, default 100** | [users/search/introduction](https://docs.x.com/x-api/users/search/introduction), [search-users](https://docs.x.com/x-api/users/search-users), [@XDevelopers announcement](https://x.com/XDevelopers/status/1735357096777138304) | CONFIRMED (path) / CORRECTED (tier) |
| F23 | `GET /2/trends/by/woeid/:id`; catalog says Basic | Basic | Path confirmed (`/2/trends/by/woeid/{woeid}`). Launched 2023-12 as **Pro & Enterprise exclusive** — the catalog's "Basic" was never right under legacy tiers; now standard pay-per-use. `max_trends` **1–50, default 20** (not the v1.1-style 50) | [get-trends-by-woeid](https://docs.x.com/x-api/trends/get-trends-by-woeid), [devcommunity 210567](https://devcommunity.x.com/t/announcing-the-users-search-and-trends-lookup-endpoints-in-the-x-api-v2/210567) | **CORRECTED** (tier) |
| F24 | Personalized trends (tier-gated) | mentioned | `GET /2/users/personalized_trends` — requires user access tokens **and an X Premium subscription on the authenticated user**, not just an API plan | [personalized-trends](https://docs.x.com/x-api/trends/personalized-trends/introduction) | CONFIRMED (gate clarified) |
| F25 | `GET /2/usage/tweets`; catalog `usage_get` = Basic | exists, Basic | Endpoint exists; returns `daily_project_usage` + project cap; prerequisites are just an approved developer account + app bearer token (no tier named). Under pay-per-use it reports the 2M-reads cap window | [usage/introduction](https://docs.x.com/x-api/usage/introduction), [get-usage](https://docs.x.com/x-api/usage/get-usage) | CONFIRMED (tier label obsolete) |
| F26 | DM inventory: `GET /2/dm_conversations/*`, `GET /2/dm_events`, `POST /2/dm_conversations/:id/messages`, `POST /2/dm_conversations/with/:user_id/messages` | as listed | Lookup surface is exactly **three** endpoints: `GET /2/dm_events`, `GET /2/dm_conversations/with/:participant_id/dm_events`, `GET /2/dm_conversations/:dm_conversation_id/dm_events`. **There is no "list conversations" endpoint.** Manage: `POST /2/dm_conversations` (create group conv), the two create-message endpoints as listed, plus `DELETE` DM event and DM-media download. **DM events are retained only 30 days** via the API. `max_results` 1–100 | [dm lookup introduction](https://docs.x.com/x-api/direct-messages/lookup/introduction) | **CORRECTED** (wildcard misleading; retention missing) |
| F27 | Timelines: `GET /2/users/:id/tweets`, `/mentions`, `/timelines/reverse_chronological` | as listed | All three confirmed verbatim | [timelines introduction](https://docs.x.com/x-api/posts/timelines/introduction) | CONFIRMED |
| F28 | `PUT /2/tweets/:id/hidden` | as listed | Confirmed (Hide Replies family alive and documented) | [hide-reply](https://docs.x.com/x-api/posts/hide-reply) | CONFIRMED |
| F29 | Batch lookups up to 100 ids (`posts_get`, `users_get`) | 100 | `GET /2/tweets` ids: 1–100 confirmed ("Up to 100 are allowed in a single request"); users by ids/usernames same family present | [get-posts-by-ids](https://docs.x.com/x-api/posts/get-posts-by-ids) | CONFIRMED |
| F30 | Spaces: `GET /2/spaces/:id`, `GET /2/spaces/search` | as listed | Confirmed; also by-creator-ids, by-ids, space posts (tweets), ticket buyers | [spaces llms index](https://docs.x.com/x-api/llms.txt) | CONFIRMED |
| F31 | Engagement/graph/list/bookmark endpoint paths (§5) | as listed | All present: likes, retweets (`POST/DELETE /2/users/:id/retweets`), `GET /2/tweets/:id/quote_tweets` (max_results 10–100), `retweeted_by`, `liking_users`, bookmarks CRUD (max 100), follows (`GET followers/following` max_results **1–1000**), blocking, muting, lists CRUD/members/pins/follows | [x-api llms.txt index](https://docs.x.com/x-api/llms.txt), per-endpoint refs | CONFIRMED |
| F32 | App-only bearer: search, lookups, some timelines; no DMs/`me` | asserted | Consistent with current docs (DM endpoints require user context; news lookup notes app-auth + user-auth support) | [dm lookup](https://docs.x.com/x-api/direct-messages/lookup/introduction), [news introduction](https://docs.x.com/x-api/news/introduction) | CONFIRMED |
| F33 | OAuth 1.0a still accepted by v2 endpoints | asserted | Still listed as a supported auth method in fundamentals; rate-limit docs distinguish OAuth 1.0a user-context pools | [auth overview](https://docs.x.com/fundamentals/authentication/overview), [rate-limits](https://docs.x.com/x-api/fundamentals/rate-limits) | CONFIRMED |

**Tally: 20 CONFIRMED (5 of them "legacy — label now moot"), 8 CORRECTED, 1 UNVERIFIABLE
(officially) / confirmed-in-practice, 1 NEW (pay-per-use model missing entirely).**

---

## 2. Findings

### FINDING-1 — BLOCKER — docs/01 §3 (+ docs/03 Tier column, docs/02 §5.5/§7): the subscription tier model no longer exists for new developers

**Problem.** On 2026-02-06 X replaced Free/Basic/Pro with **pay-per-use credit
pricing** (see F1/F12). x-mcp's target audience (new hobby/agent developers) cannot buy
Basic or Pro at all and has **no free tier**. This invalidates, as designed:

- the catalog's per-tool **Tier** column (Free/Basic/Pro minimums);
- lazy **tier inference from 403 `client-not-enrolled`** (docs/01 §3) — new accounts
  won't produce tier-enrollment 403s; they'll produce *insufficient credits* failures;
- the `TierGated`/`tier` member of the error taxonomy (docs/02 §5.5) as the primary
  capability gate;
- the read-budget framing "monthly post-read caps" — the real budget is now **dollars
  of prepaid credit** (reads *and* writes), with one hard platform cap: 2M post
  reads/month.

**Correction.** Rewrite §3 with two co-existing models: (a) **pay-per-use** (default,
new developers): per-resource read pricing, per-request write pricing, Owned-Reads
discount, 2M reads/mo cap, credits, spending limits; (b) **legacy tiers** (grandfathered
Basic $200 / Pro $5,000 with the F5–F10 caps) with a deprecation note (reported
migration of legacy Basic to pay-per-use after 2026-06-01). In docs/03, replace the
Tier column with an **availability** column (`app+user`, `user-only`, `pilot`,
`premium-user`, `enterprise`) plus a **cost class** (per-resource price bucket). Keep
`tier` in the error taxonomy only for legacy accounts; add a `billing`/`credits` error
type for insufficient-credit failures (exact error shape should be captured during
Phase 1 against a live account — it is not yet documented publicly).

### FINDING-2 — MAJOR — docs/03 `dm` package: `dm_conversations_list` is not implementable as specified

**Problem.** The tool promises "Recent DM conversations (participants, last event
time)". The v2 API has **no endpoint that lists conversations** — only the three DM
*events* lookups (F26). docs/01 §5's `GET /2/dm_conversations/*` wildcard papers over
this. Additionally, **only the last 30 days of DM events** are retrievable, which no
doc mentions.

**Correction.** Either drop `dm_conversations_list`, or re-specify it as a client-side
aggregation over `GET /2/dm_events` (group by `dm_conversation_id`, take latest event
per group) with an explicit "derived from the last 30 days of events; max 100 events
per page" caveat. Replace the wildcard in docs/01 §5 with the three concrete lookup
paths + `POST /2/dm_conversations` + `DELETE /2/dm_events/:id`. Document the 30-day
retention in both docs.

### FINDING-3 — MAJOR — docs/03: Free-tier labels were already wrong before the pricing cutover

**Problem.** `like_create`/`like_delete`, `repost_create`/`repost_delete`,
`follow_create`/`follow_delete` are marked Free/Basic — but **Like and Follow endpoints
were removed from the Free tier on 2025-08-22** (changelog), i.e. the "Free" rows for
likes/reposts were stale even under the legacy model. `bookmarks_list`/`bookmark_*`
marked Free is likewise unverifiable for the final Free state. This reinforces
FINDING-1: the Tier column can't be point-patched, it needs the availability/cost
re-model.

**Correction.** Fold into the FINDING-1 rework; when documenting legacy tiers, note the
2025-08-22 removal so grandfathered-Free expectations are correct.

### FINDING-4 — MAJOR — docs/02 §7 / docs/01 §3: budget model tracks the wrong thing

**Problem.** `core/budget` counts *post reads* against a read cap. Under pay-per-use
(a) **writes cost real money per request** — and a post containing a URL costs
**$0.20, 13× a plain post** (2026-04-16 change); (b) reads are priced per *resource*
by type (post $0.005, user $0.010, DM event $0.010, like/mute/block $0.001), with
own-data reads at $0.001; (c) the only hard cap is 2M post reads/mo. A budget model
that ignores writes will happily let an agent spend $20 posting 100 link-bearing posts
while "under budget".

**Correction.** Reframe `X_MCP_READ_BUDGET` as `X_MCP_CREDIT_BUDGET` (approximate
dollars/credits), with a static per-endpoint cost table (resource type × count from
the response) covering reads *and* writes. Surface estimated per-call cost in tool
results (great agent legibility, cheap to compute). `post_create` should warn (or
require confirmation flag) when `text` contains a URL, naming the $0.20 price. Keep
seeding from `GET /2/usage/tweets` for the 2M-reads cap only.

### FINDING-5 — MAJOR — docs/03 search package: tier gates and `max_results` bounds

**Problem.** (a) `search_all`/`post_counts_all` marked **Pro** — full-archive search is
now available to **pay-per-use and Enterprise** customers (F21); the $5k barrier framing
is obsolete. (b) No tool documents API `max_results` bounds; two have non-obvious
**minimums of 10** (`search_recent`, `search_all`, `quote_posts_list`) — a server that
forwards `max_results: 5` will get a 400. (c) `min_likes`/`min_replies`/`min_reposts`
search operators were **deprecated 2026-01-19** — don't document/pass them.

**Correction.** Update tier labels per FINDING-1. Add an explicit per-tool
`max_results` row using verified bounds: search recent/all 10–100 / 10–500; timelines
5–100 (mentions 5–100); followers/following 1–1000; user_search 1–1000 (default 100);
liking_users/retweeted_by/bookmarks/dm_events/list members 1–100; quote_posts 10–100;
batch lookups ≤100 ids; trends `max_trends` 1–50 (default 20). Clamp *and floor*
server-side.

### FINDING-6 — MINOR — docs/01 §5 media / docs/03 `media_upload`: prefer the dedicated 2025 endpoints

**Problem.** The docs describe only the command-style `POST /2/media/upload`
INIT/APPEND/FINALIZE flow. Since 2025 the platform also exposes dedicated endpoints —
`POST /2/media/upload/initialize`, `POST /2/media/upload/{id}/append`,
`POST /2/media/upload/{id}/finalize`, `GET /2/media/upload` (STATUS) — which is where
new rate-limit documentation and fixes land (F18); the one-shot `POST /2/media/upload`
also works for small files. v1.1 sunset date: 2025-06-09.

**Correction.** Specify the dedicated-path flow as primary in both docs (APPEND
segments < 5 MB; media_category `tweet_image|tweet_gif|tweet_video|amplify_video`;
`media_type` from the documented MIME enum). Note the one-shot path as the small-image
fast path. Also available if wanted later: subtitles create/delete, media analytics,
media lookup by media key.

### FINDING-7 — MINOR — docs/03 `trends_by_location`: tier wrong even historically; personalized trends gate

**Problem.** Marked **Basic**, but trends lookup launched (2023-12) as Pro &
Enterprise-exclusive and was never Basic under legacy tiers (F23). Personalized trends
(mentioned in docs/01 §5) additionally requires the authenticated user to have an
**X Premium subscription** — an account property, not an API plan, so tier/availability
metadata can't express it; it needs a distinct marker.

**Correction.** Re-label per FINDING-1; add `max_trends` (1–50, default 20) as the
pagination cap; if personalized trends ever becomes a tool, gate it with a
`premium-user` availability marker and map its failure mode to a distinct actionable
error.

### FINDING-8 — MINOR — docs/01 §2.1 / docs/04 §4: refresh-token rotation is an undocumented platform behavior

**Problem.** The corpus states rotation as fact ("every refresh returns a new refresh
token and invalidates the old one"). Official docs confirm the 2-hour access token and
`offline.access` refresh issuance but **never document rotation**; single-use refresh
tokens are community-observed behavior (F13/F14). The engineering consequence (atomic
persist-before-use) is right regardless.

**Correction.** Keep the design; add one sentence noting rotation is observed behavior
not documented contract, so the token-refresh code must also tolerate a *non-rotating*
response (same refresh token returned) without corrupting the store. Cheap resilience,
zero cost.

### FINDING-9 — MINOR — docs/01 §2.1 scope list: complete for the catalog, one omission worth noting

**Problem.** All 21 listed scopes verified verbatim, including `media.write` (F15). The
official list additionally contains `users.email`. Not needed by any cataloged tool —
but `auth_status` claims to report "granted scopes", and an unknown-scope value
appearing in a token file shouldn't confuse it.

**Correction.** Note `users.email` exists; make scope handling in `auth_status`
pass-through (display unknown scopes verbatim rather than validating against a closed
list).

### FINDING-10 — MINOR — docs/01 §4: rate-limit specifics now verifiable — pin them

**Problem.** Header names, 15-min windows, and the existence of 24-h caps all check out
(F16/F17). The docs stop short of concrete numbers where concrete numbers are now
published and design-relevant: `POST /2/tweets` 100/15 min (user) + **10,000/24 h
(app)**; `DELETE /2/tweets/:id` 50/15 min; DM create 1,440/24 h; media initialize
1,875/15 min (user).

**Correction.** Add these as illustrative documented values (marked "as of 2026-07")
to docs/01 §4 so `rate_limit_status` and tests have realistic fixtures. Note that
Community Notes endpoints have their own caps (90/15 min all endpoints; 250/day on
note submission) if Phase 4 touches them.

### FINDING-11 — NIT — docs/01 §1: v1.1 media wording

"v1.1 media upload was deprecated in 2025" — true; tighten to "retired 2025-06-09
(deadline extended twice from 2025-03-31)" for precision. The claim that v1.1 was
"the last v1.1 holdout" for this project's surface is fair.

### FINDING-12 — NIT — docs/03 catalog counts and naming

"~45 tools in 12 packages" — actual table count is 47 tools in 12 packages; fine, but
update once the DM package is reworked (FINDING-2). Tool naming (`post_*`, "reposts")
matches current platform terminology ("Posts", "Reposts") — good; the API paths still
say `tweets`/`retweets`, which docs/01 correctly reflects.

### FINDING-13 — NIT — docs/03 Automation Rules posture: sound, one addition

The write surface is Automation-Rules-clean: single-target writes only, no batch
tools, no follower-farming, thread convenience capped and policy-gated, automated-label
disclosure documented as operator responsibility. One addition: X's automated-account
policy also expects bot accounts to link the responsible account in the bio; add that
to the operator checklist (docs/04 §7). The 10,000/24 h app-level post cap (F17) is
itself a platform anti-spam backstop worth citing in the "no bulk automation" section.

---

## 3. New/changed platform capabilities the design should know about (2025–2026)

Verified against [docs.x.com/changelog](https://docs.x.com/changelog) and the
[x-api llms.txt index](https://docs.x.com/x-api/llms.txt):

1. **Pay-per-use pricing + credits** (2026-02-06) and **URL-post pricing $0.20**
   (2026-04-16) — see FINDING-1/-4. Also "Owned Reads" ($0.001/resource on own data) —
   directly rewards the catalog's own-data tools (`timeline_mentions`,
   `bookmarks_list`, `liked_posts_list`), worth surfacing in cost estimates.
2. **News endpoints** (2025-11-19): `GET /2/news/search`, `GET /2/news/{id}` — app-auth
   and user-auth. A natural, cheap read package for agent use ("what's breaking on X
   about T"). Candidate for the catalog (Phase 3+).
3. **Community Notes API** (pilot): `GET /2/notes/search/posts_eligible_for_notes`,
   `GET /2/notes/search/notes_written`, `POST /2/evaluate_note`, `POST /2/notes`,
   delete note. Requires enrollment as an **AI Note Writer** (X Developer AI access);
   90 req/15 min, 250/day on submission. Roadmap Phase 4 already anticipates this
   ("Community Notes … if/when public") — it is public-as-pilot now; keep it out of
   the default surface (its whole point is automated posting by vetted bots).
4. **Communities endpoints**: `GET /2/communities/search`, `GET /2/communities/:id`
   — small read package candidate.
5. **AI Trends**: "Get AI trend by ID" (AI-curated trend + the posts driving it) —
   new trends family member alongside WOEID and personalized trends.
6. **Bookmark folders**: get bookmark folders / bookmarks by folder id — the
   `bookmarks_list` tool could grow an optional `folder_id`.
7. **Post & media analytics endpoints** ("Get Post Analytics", "Get Media Analytics")
   — richer own-content metrics than `public_metrics`; candidate for a Phase 3
   `post_analytics` read tool.
8. **Reposts lookup**: `GET /2/tweets/:id/retweets` (full repost objects, beyond
   `retweeted_by`) and "Reposts of me" — optional engagement additions.
9. **X Activity API (webhooks) open beta** (2025-10) + **Account Activity API v2 with
   OAuth 2.0** (2026-01-15), consolidated `POST /2/webhooks/replay` (2026-03-20) —
   for Phase 4, a webhook push model may fit MCP resources/notifications *better*
   than filtered stream for account-scoped events (DMs, mentions, follows).
10. **XDKs** (2025-11-03): official Python **and TypeScript** SDKs. The architecture's
    zero-dep undici wrapper remains a valid choice, but docs/02 §2 should record the
    deliberate decision *not* to use the official TypeScript XDK (evaluate: token
    refresh handling, tree-shaking, dependency weight) rather than appearing unaware
    of it.
11. **Search operator deprecation** (2026-01-19): `min_likes`/`min_replies`/
    `min_reposts` gone — keep out of any query-building docs/prompts.
12. **X Chat media endpoints** (chat media upload family) — new messaging surface
    adjacent to classic DMs; watch it: if XChat supersedes DMs, the `dm` package's
    API basis may shift again.
13. **DM data retention**: 30 days via lookup endpoints — see FINDING-2.

---

## 4. Recommendations

1. **Rework docs/01 §3 around pay-per-use first, legacy tiers second** (FINDING-1) and
   replace docs/03's Tier column with availability + cost-class metadata. This is the
   only blocker; it also collapses findings 3, 5, 7 into one edit.
2. **Re-spec the budget system as a credit/cost model** covering writes, with
   per-resource read pricing and the $0.20 URL-post warning in `post_create`
   (FINDING-4). This turns a platform trap into x-mcp's most differentiating feature —
   per-call cost transparency for agents.
3. **Fix the DM package** to the real endpoint surface + 30-day retention (FINDING-2)
   before any implementation; it is currently the only tool that cannot be built as
   written.
4. **Add a `max_results` bounds column** to the catalog from §2/FINDING-5's verified
   numbers, and clamp to both min and max server-side.
5. **Adopt the dedicated media-upload paths** (FINDING-6) and keep the STATUS-poll
   design; it matches the current platform exactly.
6. **Add a "billing/credits" error type** to the taxonomy and capture the real
   insufficient-credits error shape during Phase 1 live testing (it is not publicly
   documented — treat as an open question alongside the existing Phase 0 list).
7. **Consider News and Communities read packages** for Phase 3 — cheap, agent-useful,
   app-auth-capable — and note the X Activity API as the preferred Phase 4 push
   mechanism over filtered stream.
8. Re-run this fact-check **at each phase boundary** (the corpus's own §7 volatility
   list proved prescient: items 1, 2, 4, and 5 all changed within six months).
   docs.x.com now ships `llms.txt` indexes and `.md` page variants — script the
   re-check (`curl https://docs.x.com/x-api/llms.txt` + targeted page diffs) as part
   of the fixture-refresh discipline in docs/05 §5.

---

*Primary sources: [docs.x.com/x-api/getting-started/pricing](https://docs.x.com/x-api/getting-started/pricing) ·
[docs.x.com/changelog](https://docs.x.com/changelog) ·
[docs.x.com/x-api/fundamentals/rate-limits](https://docs.x.com/x-api/fundamentals/rate-limits) ·
[OAuth 2.0 authorization code](https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code) ·
[x-api llms.txt endpoint index](https://docs.x.com/x-api/llms.txt) · per-endpoint
references cited inline. Third-party sources used only for legacy-tier history and are
marked as such.*
