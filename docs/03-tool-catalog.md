# 03 — Tool catalog

**50 tools in 12 packages** (the frozen tool-name contract other tasks build against).

- **49 are unconditional** — always registered once their phase has shipped.
- **1 is conditionally registered** — `x_usage_get`, pending the WP-3.11 go/no-go.
- A **typical default deployment** (standard pay-per-use account, Phase 1+2 shipped,
  conservative `X_MCP_AVAILABILITY`) registers **~28** tools: the surface minus the
  four Phase-3 packages (dm, lists, spaces, trends) and the other Phase-3 / conditional
  tools (`x_search_archive`, `x_post_counts_archive`, `x_user_search`, `x_usage_get`).

> Count reconciliation for T-019: the reviews and roadmap quote "~46 full / ~28
> typical". The exact post-merge surface is **50 rows / 49 unconditional / ~28–29
> typical**. Two deltas from the review estimate: (a) the reviews rounded the 60→49
> merge arithmetic to "~46"; (b) the DM redesign replaces one list-conversations tool
> with three event-lookup tools (net +1). **Availability note:** full-archive
> search/counts and profile search are `app+user` (pay-per-use reachable per the
> T-010 fact-check, docs/01 §3.2), so they are **not** availability-gated — they
> register by default once Phase 3 ships and are guarded by the credit budget, not
> hidden. docs/02 §5.1, docs/08 (WP-0.3), and docs/09 (T-012 row) carry the
> reconciled **50 / 49 / ~28** numbers.

## Conventions

- **Prefix**: every tool name is prefixed **`x_`** and every description opens with
  **"X (Twitter): …"**. Names are `snake_case`, stable once shipped.
- **Naming patterns** (agent-DX F7): actions are `<noun>_<verb>`
  (`x_post_create`); collection reads are `<noun>_list` (`x_followers_list`);
  scoped feeds are `x_timeline_<scope>`; reversible toggles are `<noun>_set` with an
  `action` enum (`x_like_set {action:"like"|"unlike"}`).
- **Class** column is the policy classification `operation:domain`
  ([04-security.md](04-security.md) §3). Operation is `read` → `write` →
  `destructive`; domain is `content` / `engagement` / `social-graph` / `user` /
  `dm` / `moderation` / `account`. `read:*` tools (except `read:dm`) work in the
  read-only preset; everything else needs opt-in. MCP tool annotations
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`) are generated from this
  column (corner case MCP-4).
- **Availability** column — replaces the retired Free/Basic/Pro tier column
  (X moved to pay-per-use 2026-02-06; platform review FINDING-1). Values:
  - `app+user` — reachable with an app-only bearer token **and** with user context.
  - `user-only` — requires user-context OAuth (writes, DMs, home timeline, and own
    private reads such as bookmarks/blocks/mutes).
  - `pilot` — behind an enrollment/pilot program (e.g. Community Notes *AI Note
    Writer*); registered only when `X_MCP_AVAILABILITY` lists it (WP-0.10). **No v1
    tool uses this class** — archive & profile search are `app+user`, not `pilot`
    (see docs/01 §3.2).
  - `premium-user` — requires the authenticated user to hold X Premium (reserved; no
    current tool — personalized trends would land here).
  - `enterprise` — enterprise-contract only (reserved; nothing in this surface).
- **Cost** column — indicative pay-per-use bucket; the **authoritative price table
  lives in [01-api-landscape.md](01-api-landscape.md) §3** (owned by T-010). The
  reported per-call cost is surfaced in every response; there is **no per-call budget
  override** — the session spend budget is env-side only (corner case COST-1).
  Legend:
  - `local` — no X API spend (in-process state).
  - `owned` — own-data read, ~$0.001/resource.
  - `r:post` ~$0.005/post · `r:user` ~$0.010/user · `r:follows` ~$0.010 ·
    `r:list` ~$0.005 (lists/spaces/trends) · `r:engage` ~$0.001 (like/mute/block
    reads) · `r:dm` ~$0.010/event.
  - `w:post` $0.015 (**$0.20 when the post contains a URL**) · `w:dm` $0.015 ·
    `w:list` $0.010 (list create) · `w:action` per-write (engagement/graph/moderation
    writes and deletes; see 01 §3).
- **Phase** column — the roadmap phase a tool ships in (docs/08). `P1` read-only
  core, `P2` auth + writes, `P3` full surface. Registration is gated by phase and by
  availability independently.
- **Identifier resolution** (corner case REND-8): every `post`/`user`/`list`
  argument accepts the canonical id, and where noted a `@handle`/handle or a status
  URL; the server resolves them before calling the API.
- **Pagination**: all list-returning tools take `max_results` + `page_token`, return
  `next_token` + `result_count`. `page_token` bridges to the v2 `next_token` cursor
  (corner case PAGE-2); `max_results` is clamped to each endpoint's bounds in both
  directions (PAGE-3). All read tools accept optional `raw: true` (uncompacted
  payload, size-capped per corner case REND-9).
- **Untrusted content**: post/user/DM text is third-party data and is rendered as
  inert content, never as instructions (corner case REND-6).
- **Destructive-op rule**: irreversible **content deletion** is never hidden behind
  an action enum — `x_post_delete` and `x_list_delete` stay standalone so policy
  denial and human review can target them precisely. The one destructive tool that
  merges is `x_block_set` (block/unblock is a reversible toggle); it is classified at
  the higher class `destructive:social-graph` (policy POL-5).

## auth — identity & operations

| Tool | Class | Availability | Cost | Phase | What it does |
|---|---|---|---|---|---|
| `x_auth_status` | read:account | app+user | owned | P1 | X (Twitter): active profile, auth mode, authenticated user (`me`), granted scopes, detected availability, resolved policy matrix. Degraded shape under app-only auth (corner case AUTH-15) |
| `x_rate_limit_status` | read:account | app+user | local | P1 | X (Twitter): known per-endpoint rate-limit table (limit / remaining / reset) |
| `x_usage_get` | read:account | app+user | owned | P3 | X (Twitter): monthly post-read consumption vs caps (`GET /2/usage/tweets`) + local session-spend budget state. **Conditional — ship/drop decided at WP-3.11** |

## posts — create, read, delete

| Tool | Class | Availability | Cost | Phase | What it does |
|---|---|---|---|---|---|
| `x_post_create` | write:content | user-only | w:post | P2 | X (Twitter): create a post — `text`, optional `reply_to_id`, `quote_id`, `media_ids[]`, `poll {options[], duration_minutes}`, `reply_settings`. Returns id + URL. Note: a URL in the text raises the per-post cost to $0.20 |
| `x_post_delete` | destructive:content | user-only | w:action | P2 | X (Twitter): delete own post by id. Standalone (never behind an enum) |
| `x_post_get` | read:content | app+user | r:post | P1 | X (Twitter): batch post lookup — `ids: string[]` (1–100), each an id or a status URL. Compact shape (author, text, metrics, refs, media) |
| `x_post_hide_reply` | write:moderation | user-only | w:action | P2 | X (Twitter): hide / unhide a reply to own post (`PUT /2/tweets/:id/hidden`) |

## search — discovery

| Tool | Class | Availability | Cost | Phase | What it does |
|---|---|---|---|---|---|
| `x_search_recent` | read:content | app+user | r:post | P1 | X (Twitter): last-7-days search, full v2 query syntax (`from:`, `to:`, `conversation_id:`, operators). Input `query`, optional `sort_order`, time bounds. `max_results` 10–100 |
| `x_search_archive` | read:content | app+user | r:post | P3 | X (Twitter): full-archive search since 2006. `max_results` 10–500. High-volume read — guard with the credit budget (renamed from `search_all`) |
| `x_post_counts_recent` | read:content | app+user | r:post | P1 | X (Twitter): volume histogram for a query, last 7 days, granularity minute/hour/day |
| `x_post_counts_archive` | read:content | app+user | r:post | P3 | X (Twitter): full-archive volume histogram (renamed from `post_counts_all`) |

## timelines

| Tool | Class | Availability | Cost | Phase | What it does |
|---|---|---|---|---|---|
| `x_timeline_home` | read:content | user-only | r:post | P2 | X (Twitter): authenticated user's reverse-chronological home timeline. `max_results` 5–100 |
| `x_timeline_mentions` | read:content | app+user | owned | P2 | X (Twitter): mentions of a user (defaults to `me`). `max_results` 5–100 |
| `x_timeline_user` | read:content | app+user | r:post | P2 | X (Twitter): a user's posts (`exclude` replies/reposts flags, time bounds). `max_results` 5–100 |

## engagement — likes, reposts, bookmarks

| Tool | Class | Availability | Cost | Phase | What it does |
|---|---|---|---|---|---|
| `x_like_set` | write:engagement | user-only | w:action | P2 | X (Twitter): like or unlike a post — `{post, action:"like"\|"unlike"}` (merged from `like_create`/`like_delete`) |
| `x_repost_set` | write:engagement | user-only | w:action | P2 | X (Twitter): repost or undo repost — `{post, action:"repost"\|"unrepost"}` (merged from `repost_create`/`repost_delete`) |
| `x_bookmark_set` | write:engagement | user-only | w:action | P2 | X (Twitter): add or remove a bookmark (private to the user) — `{post, action:"add"\|"remove"}` (merged from `bookmark_create`/`bookmark_delete`) |
| `x_liked_posts_list` | read:content | app+user | r:post | P2 | X (Twitter): posts a user has liked. `max_results` 5–100 |
| `x_liking_users_list` | read:content | app+user | r:user | P2 | X (Twitter): who liked a post. `max_results` 1–100 |
| `x_reposted_by_list` | read:content | app+user | r:user | P2 | X (Twitter): who reposted a post. `max_results` 1–100 |
| `x_quote_posts_list` | read:content | app+user | r:post | P2 | X (Twitter): quote posts of a post. `max_results` 10–100 |
| `x_bookmarks_list` | read:content | user-only | owned | P2 | X (Twitter): own bookmarks. `max_results` 1–100 |

## users

| Tool | Class | Availability | Cost | Phase | What it does |
|---|---|---|---|---|---|
| `x_user_get` | read:user | app+user | r:user | P1 | X (Twitter): batch user lookup — `users: string[]` (1–100), each an id, a handle, or a `@handle`; `"me"` resolves the authenticated user. Compact profile (handle, name, bio, metrics, created). Merged from `user_get`/`user_by_username`/`users_get` |
| `x_user_search` | read:user | app+user | r:user | P3 | X (Twitter): keyword search over profiles. `max_results` 1–1000 |

## graph — follows, blocks, mutes

| Tool | Class | Availability | Cost | Phase | What it does |
|---|---|---|---|---|---|
| `x_follow_set` | write:social-graph | user-only | w:action | P3 | X (Twitter): follow or unfollow a user — `{user, action:"follow"\|"unfollow"}` (single target, no batch, by design). Merged from `follow_create`/`follow_delete` |
| `x_mute_set` | write:social-graph | user-only | w:action | P3 | X (Twitter): mute or unmute a user — `{user, action:"mute"\|"unmute"}` (merged from `mute_create`/`mute_delete`) |
| `x_block_set` | destructive:social-graph | user-only | w:action | P3 | X (Twitter): block or unblock a user — `{user, action:"block"\|"unblock"}`. Classified `destructive:social-graph` — the one destructive tool that merges, because block/unblock is reversible (policy POL-5). Merged from `block_create`/`block_delete` |
| `x_followers_list` | read:social-graph | app+user | r:follows | P3 | X (Twitter): followers of a user. `max_results` 1–1000 |
| `x_following_list` | read:social-graph | app+user | r:follows | P3 | X (Twitter): accounts a user follows. `max_results` 1–1000 |
| `x_blocks_list` | read:social-graph | user-only | r:engage | P3 | X (Twitter): own block list. `max_results` 1–1000 |
| `x_mutes_list` | read:social-graph | user-only | r:engage | P3 | X (Twitter): own mute list. `max_results` 1–1000 |

## dm — direct messages

Redesigned around the three v2 DM-event lookups (platform review FINDING-2). There is
**no list-conversations endpoint** in v2, so the former `dm_conversations_list` is
**removed** (corner case DM-1). Every DM read is subject to the platform's **~30-day
event-retention window** and the note is surfaced on each response (corner case DM-2);
message bodies require `include_text: true` in the request (corner case DM-3).

| Tool | Class | Availability | Cost | Phase | What it does |
|---|---|---|---|---|---|
| `x_dm_events_list` | read:dm | user-only | r:dm | P3 | X (Twitter): all recent DM events for the authenticated user (`GET /2/dm_events`), newest first. `max_results` 1–100. ~30-day retention |
| `x_dm_conversation_events_list` | read:dm | user-only | r:dm | P3 | X (Twitter): events in one conversation (`GET /2/dm_conversations/:dm_conversation_id/dm_events`). `max_results` 1–100. ~30-day retention |
| `x_dm_participant_events_list` | read:dm | user-only | r:dm | P3 | X (Twitter): events in the 1:1 conversation with a participant (`GET /2/dm_conversations/with/:participant_id/dm_events`). `max_results` 1–100. ~30-day retention |
| `x_dm_send` | write:dm | user-only | w:dm | P3 | X (Twitter): send a DM to a conversation or directly to a user id. Subject to the ~1,440/24h send cap (corner case DM-4). **Never enabled by any preset below `full`** |

## lists

| Tool | Class | Availability | Cost | Phase | What it does |
|---|---|---|---|---|---|
| `x_list_create` | write:content | user-only | w:list | P3 | X (Twitter): create a list (name, description, private) |
| `x_list_update` | write:content | user-only | w:action | P3 | X (Twitter): update own list metadata |
| `x_list_delete` | destructive:content | user-only | w:action | P3 | X (Twitter): delete own list. Standalone (never behind an enum) |
| `x_list_get` | read:content | app+user | r:list | P3 | X (Twitter): list metadata |
| `x_lists_owned` | read:content | app+user | owned | P3 | X (Twitter): lists owned by a user (defaults to `me`) |
| `x_list_member_set` | write:content | user-only | w:action | P3 | X (Twitter): add or remove a list member — `{list_id, user, action:"add"\|"remove"}` (single user per call). Merged from `list_members_add`/`list_members_remove` |
| `x_list_members` | read:content | app+user | r:user | P3 | X (Twitter): members of a list. Renamed from `list_members_list`. `max_results` 1–100 |
| `x_list_timeline` | read:content | app+user | r:post | P3 | X (Twitter): posts from a list's timeline. Renamed from `list_posts`. `max_results` 1–100 |
| `x_list_follow_set` | write:engagement | user-only | w:action | P3 | X (Twitter): follow or unfollow a list — `{list_id, action:"follow"\|"unfollow"}` (merged from `list_follow`/`list_unfollow`) |
| `x_list_pin_set` | write:engagement | user-only | w:action | P3 | X (Twitter): pin or unpin a list — `{list_id, action:"pin"\|"unpin"}` (merged from `list_pin`, adds the missing unpin) |

## media

Split into two tools (corner case MEDIA-3); `alt_text` is folded into upload (former
`media_metadata_set` is **cut**).

| Tool | Class | Availability | Cost | Phase | What it does |
|---|---|---|---|---|---|
| `x_media_upload` | write:content | user-only | w:action | P3 | X (Twitter): upload image/GIF/video from a local file path via the dedicated v2 chunked path (`POST /2/media/upload` INIT→APPEND→FINALIZE; platform review FINDING-6). Optional `alt_text` (accessibility). Returns `{media_id, processing_state}` for `x_post_create` |
| `x_media_status` | read:content | user-only | local | P3 | X (Twitter): poll async media processing STATUS by `media_id` until `succeeded`/`failed` (for video/large uploads) |

## spaces

| Tool | Class | Availability | Cost | Phase | What it does |
|---|---|---|---|---|---|
| `x_space_get` | read:content | app+user | r:list | P3 | X (Twitter): Space by id (state, title, hosts, participant counts) |
| `x_spaces_search` | read:content | app+user | r:list | P3 | X (Twitter): live/upcoming Spaces by keyword |

## trends

| Tool | Class | Availability | Cost | Phase | What it does |
|---|---|---|---|---|---|
| `x_trends_by_location` | read:content | app+user | r:list | P3 | X (Twitter): trends for a WOEID location (`GET /2/trends/by/woeid/:id`); input accepts a place name resolved via a small built-in WOEID table for common locations. `max_trends` 1–50 |

## Deliberate omissions

- **No batch write tools** (mass-follow, mass-like, thread-blast) — Automation Rules
  risk; a thread is composed one `x_post_create` (with `reply_to_id`) at a time, which
  keeps the human/agent in a reviewable loop. A `x_thread_create` convenience tool is
  Phase 3, gated behind the `publish` policy, capped at 25 posts.
- **No filtered-stream tools** in v1 — long-lived connections don't fit the stdio
  request/response model; revisit with Streamable HTTP (roadmap Phase 4).
- **No list-conversations DM tool** — v2 exposes no such endpoint; DM reads go through
  the three event lookups above (corner case DM-1).
- **No compliance/batch endpoints** (enterprise-only).
- **No follower-farming helpers** of any kind ("who doesn't follow me back") — policy
  stance, documented in README non-goals.
