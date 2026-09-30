# Platform fact-check — release-week pre-run (2026-10-01)

- **Reviewer role**: Senior X API integration engineer (same role as
  [02-x-platform-review.md](02-x-platform-review.md)).
- **Date**: 2026-10-01.
- **Purpose**: a dated pre-run of the 1.0 release checklist item "Final platform
  fact-check (`llms.txt` + changelog) dated within release week"
  ([../08-implementation-roadmap.md](../08-implementation-roadmap.md), H5). This
  pre-run does **not** tick that box. The real run must be dated within the release
  week, and this report is its baseline.
- **Baseline**: the previous fact-check, 2026-09-28 (docs/01 "Last fact-checked",
  §3.1 and Appendix B; the CHANGELOG "Platform changes absorbed" entry of that date).
- **Scope**: the claims that change when the platform does. That means the pricing
  and caps in [../01-api-landscape.md](../01-api-landscape.md) §3 and Appendix B,
  `src/core/budget.ts`, the DRIFT-\* and COST-\* entries in
  [../07-corner-cases.md](../07-corner-cases.md), the README pricing section, and
  the CHANGELOG "Platform changes absorbed" sections. Three questions were carried
  over and are resolved below: Bookmark Folders, XChat versus `x_dm_send`, and the
  2026-09-01 video caps versus `x_media_upload`.
- **Method**: public documentation only. Pages were fetched unauthenticated as
  Markdown (`.md` suffix on docs.x.com) and read in full. No authenticated X API call
  was made. The recorded live fixtures were **not** refreshed (DRIFT-4; that needs
  explicit human approval).
- **Verdict**: **3 drifts found and corrected**: a behavioural fix to the DRIFT-3
  operator check (F-1), a stale video-limit comment (F-3) and the Owned Reads
  endpoint list in docs/01 (F-4). The remaining findings are recommendations for a
  product decision or a live check. Every rate on
  the pricing page that the repo carries still matches, as does the 3,000,000/month
  post-read cap. The most significant item cannot be settled from public docs: the
  2026-04-16 changelog says follows, likes and quote-posts were "removed from all
  self-serve tiers" (F-5). It needs a live check before 1.0.

---

## 1. Sources

| Source | URL | Version / date seen |
|---|---|---|
| Docs root index | https://docs.x.com/llms.txt | fetched 2026-10-01; lists X API, X Chat API, XDKs, MCP |
| X API index | https://docs.x.com/x-api/llms.txt | fetched 2026-10-01; OpenAPI pages carry `version: '2.169'` |
| X API full text | https://docs.x.com/llms-full.txt | fetched 2026-10-01 (scopes table, Chat API) |
| Changelog | https://docs.x.com/changelog.md | fetched 2026-10-01; newest entry **Sep 29, 2026** |
| Pricing | https://docs.x.com/x-api/getting-started/pricing.md | fetched 2026-10-01 |
| Post cap | https://docs.x.com/x-api/fundamentals/post-cap.md | fetched 2026-10-01 |
| Search operators | https://docs.x.com/x-api/posts/search/integrate/operators.md | fetched 2026-10-01 |
| Media introduction | https://docs.x.com/x-api/media/introduction.md | fetched 2026-10-01 |
| Media best practices | https://docs.x.com/x-api/media/quickstart/best-practices.md | fetched 2026-10-01 |
| Chunked upload | https://docs.x.com/x-api/media/quickstart/media-upload-chunked.md | fetched 2026-10-01 |
| Bookmark folders | https://docs.x.com/x-api/bookmarks/get-bookmark-folders.md, https://docs.x.com/x-api/posts/bookmarks/introduction.md | fetched 2026-10-01 |
| DM lookup | https://docs.x.com/x-api/direct-messages/lookup/introduction.md | fetched 2026-10-01 |
| XChat | https://docs.x.com/xchat/introduction.md | fetched 2026-10-01 |
| Usage | https://docs.x.com/x-api/usage/get-usage.md | fetched 2026-10-01 |
| OAuth 1.0a token exchange | https://docs.x.com/fundamentals/authentication/oauth-2-0/oauth-1-0a-token-exchange.md | fetched 2026-10-01 |

Changelog entries since the 2026-09-28 baseline: only **Sep 29, 2026**
(`broadcast.chat.remove` X Activity API event), which has no bearing on the tool
surface. The rest of the drift below comes from entries that are older than the
baseline but were missed by it.

## 2. Claims checked

Verdicts: **match**, **drift** (the repo claim is wrong or out of date), or **not
covered** (a platform fact the repo does not state; recorded for completeness).

| # | Claim | Repo location | Live source | Verdict |
|---|---|---|---|---|
| 1 | Posts: Read $0.005 / resource | `src/core/budget.ts` `r:post`; docs/01 App. B | Pricing, read table | match |
| 2 | User: Read $0.010 | `budget.ts` `r:user` | Pricing | match |
| 3 | Following/Followers: Read $0.010 | `budget.ts` `r:follows` | Pricing | match |
| 4 | DM Event: Read $0.010 | `budget.ts` `r:dm` | Pricing | match |
| 5 | List / Space: Read $0.005 | `budget.ts` `r:list` | Pricing | match |
| 6 | Like / Mute / Block: Read $0.001 | `budget.ts` `r:engage` | Pricing | match |
| 7 | Owned Reads $0.001 | `budget.ts` `owned`; docs/01 §3.1 | Pricing, "Owned Reads" | match (rate); see F-4 for the endpoint list |
| 8 | Post: Create $0.015; with URL $0.20 | `budget.ts` `w:post`; COST-4 | Pricing, write table | match |
| 9 | DM Interaction: Create $0.015 | `budget.ts` `w:dm` | Pricing | match |
| 10 | List: Create $0.010 | `budget.ts` `w:list` | Pricing | match |
| 11 | User Interaction: Create $0.015; Interaction: Delete $0.010; Mute: Delete $0.005 | `budget.ts` `*_USD` | Pricing | match |
| 12 | Content: Manage / List: Manage / Bookmark / Media Metadata $0.005 | `budget.ts` `*_USD` | Pricing | match |
| 13 | Counts: All $0.010 | `budget.ts` `COUNTS_ARCHIVE_USD` | Pricing | match |
| 14 | 3,000,000 post reads per monthly billing cycle, Enterprise above | docs/01 §3.1; COST-7 | Pricing; Post cap | match |
| 15 | Up to 20 % back in xAI credits | docs/01 §3.1 | Pricing | match |
| 16 | Usage endpoint `GET /2/usage/tweets`, bearer token, no dollar figure | docs/01 §3.5 | Pricing "Monitoring usage"; Usage | match |
| 17 | `min_likes`/`min_replies`/`min_reposts` removed 2026-01-19 and refused locally | `src/tools/search.ts`, `src/tools/archive.ts`; DRIFT-3 | Changelog May 4, 2026; Search operators | **drift — fixed (F-1)** |
| 18 | OAuth 2.0 scope list "additionally contains `users.email`" | docs/01 §2.1 | llms-full scopes table (`users.email`) | match |
| 19 | Chunked APPEND segments < 5 MB (repo sends 4 MiB) | docs/01 §5; MEDIA-1; `MEDIA_SEGMENT_BYTES` | Chunked upload (≤ 5 MB recommended, 8 MB server max) | match |
| 20 | Image 5 MiB, GIF 15 MiB caps | `MEDIA_SIZE_CAPS` | Media introduction | match |
| 21 | Video cap 512 MiB described as "the X limit" | `src/api/endpoints/media.ts` comment | Changelog Sep 1, 2026; Media introduction | **drift — comment fixed; cap kept (F-3)** |
| 22 | DM endpoints (`/2/dm_conversations…`, `/2/dm_events`) and 30-day retention | docs/01 §5; DM-2 | DM lookup | match; docs now name them legacy/unencrypted (F-6) |
| 23 | `auth_status` / `usage_get` are Owned Reads | docs/01 §3.1, App. B; `cost: 'owned'` | Pricing, Owned Reads list | **drift — docs corrected; pricing recommendation (F-4)** |
| 24 | Post: Create (summoned) $0.010 | — | Pricing; Changelog Apr 16, 2026 | not covered (repo charges $0.015, conservative) (F-7) |
| 25 | Counts: Recent $0.005 per request | `x_post_counts_recent` `r:post` per unit | Pricing | not covered as a request price (conservative) |
| 26 | Deduplication of a resource within one 24 h UTC window | — | Pricing "Deduplication" | not covered (local estimate over-counts; conservative) |
| 27 | Trends, Privacy: Update, Profile Update / Community / Note: Read, webhook events | — | Pricing | not covered (no tool uses them) |
| 28 | Follows, likes, quote-posts removed from self-serve tiers | — | Changelog Apr 16, 2026 | **not covered — needs a live check (F-5)** |
| 29 | Replies only when the replier is "summoned" | — | Changelog Feb 23, 2026 | not covered (F-7) |
| 30 | Bookmark Folders endpoints | docs/08 Phase 4; decisions/0002 | Bookmark folders pages | not covered (post-1.0; F-2) |
| 31 | OAuth 1.0a → 2.0 token exchange | docs/01 §2.2 (legacy mode) | Changelog Sep 21, 2026; token-exchange page | not covered (F-8) |

## 3. Findings

### F-1 — DRIFT-3 refused operators X had restored *(drift, fixed)*

The 2026-05-04 changelog entry moved all four search and counts endpoints to a new
index and brought back `min_likes:`, `min_replies:` and `min_reposts:`. The operators
page lists all three on recent and full-archive search. x-mcp still refused them
locally with "operator removed by X", so a valid query failed. It cost nothing, but
the tool could not do its job. The same page warns that the X **web-search**
spellings `min_faves:` and `min_retweets:` are not valid X API operators and fail
with a 400. That is exactly the paid-read burn DRIFT-3 exists to prevent.

**Fix**:
- The schema-level check in `src/tools/search.ts` and `src/tools/archive.ts` now
  refuses `min_faves:`/`min_retweets:` and names the valid operator to use. It still
  runs at registry step 1, before the step-4 charge, so nothing is sent or billed.
- DRIFT-3 in docs/07 and the DRIFT-3 tests in `test/tools/search.test.ts` and
  `test/tools/archive.test.ts` were updated.
- A new test asserts that the three restored operators pass pre-validation.
- There is a user-visible CHANGELOG entry under Unreleased → Changed.

No tool description changed, so the `tools/list` context gate is unaffected.

The same changelog entry also notes that keyword search no longer returns reposts.
No repo text claims otherwise.

### F-2 — Bookmark Folders *(resolved; recommendation only)*

v2 now has two read-only endpoints:
- `GET /2/users/{id}/bookmarks/folders` lists folders.
- `GET /2/users/{id}/bookmarks/folders/{folder_id}` returns the posts in a folder.

Both page with `max_results` 1–100 and `pagination_token`. Both take an OAuth 2.0
user token with `users.read` + `bookmark.read` (or an OAuth 1.0a user token). There
is no tier gate under pay-per-use. There is no dedicated pricing row, and neither
endpoint is on the Owned Reads list, so the price is unknown until a live capture.

The repo already schedules this as post-1.0 Phase 4 (docs/08; decisions/0002).
**Recommendation**: keep it post-1.0. When it is picked up, add a read tool priced
conservatively (`r:post` per post returned) until a capture confirms the rate. No
write endpoints exist.

### F-3 — Video size cap is below the 2026-09-01 platform limit *(drift in a comment, fixed; cap is a product decision)*

The 2026-09-01 changelog entry (plus the media introduction and best-practices
pages) raised the video limits:

| Media | Default account | X Premium |
|---|---|---|
| Post video (`tweet_video` / `amplify_video`) | 0.5 s–20 min, 8 GB | 125 min, 16 GB |
| DM video (`dm_video`) | 140 s, 512 MB | 10 min, 1 GB |
| Image | 5 MB | 5 MB |
| GIF | 15 MB | 15 MB |

`initialize` accepts `total_bytes` up to 16 GB. A video longer than the account
allows is refused with a 403 at **post creation**, not at upload.

`MEDIA_SIZE_CAPS.tweet_video` is 512 MiB, and its comment called that "the X
composer limit". The cap is still safe: it never lets through a file that X would
reject. But it now refuses valid 512 MiB–8 GB Post videos.

**Fixed**: the comment in `src/api/endpoints/media.ts` and the docs/01 §5 media
bullet now state the current limits and say that the 512 MiB cap is deliberately
stricter.

**Recommendation** (product decision):
- Raise the cap to 8 GiB (or make it operator-configurable). A multi-GB upload holds
  one tool call for its whole duration (MEDIA-3, MEDIA-7), so decide this on purpose.
- Map the post-create duration 403 ("not allowed to post a video longer than N
  minutes") to a clear `forbidden` message.

### F-4 — Owned Reads endpoint list and the app-owner condition *(drift in docs, corrected; pricing recommendation)*

The pricing page limits Owned Reads to the `GET /2/users/{id}/…` family: posts,
mentions, liked posts, bookmarks, followers, following, blocking, muting,
owned/followed/pinned lists and list memberships. It applies only when `{id}` is
the authenticated user **and** that user owns the developer app.

docs/01 §3.1 and Appendix B also listed `auth_status` (`GET /2/users/me`) and
`usage_get` (`GET /2/usage/tweets`) as Owned Reads. Neither endpoint is on the list.
docs/01 §3.1 now states the list and the app-owner condition, and marks the two
tools' `owned` class as an estimate.

**Recommendation**:
- (a) `x_auth_status` calls `/2/users/me` only when the handle is not already
  cached. That call is plausibly User: Read ($0.010), so the local $0.001 may
  under-count by $0.009 on that path. Consider `r:user` for the network path and
  `local` otherwise (this touches `src/tools/auth.ts`, docs/03 and the tests, so it
  is out of scope for a fact-check).
- (b) No published rate exists for `/2/usage/tweets`. Confirm it by a live capture.
- (c) When the user is not the app owner, the `owned` tools under-count.
  Mentions, for example, bill at $0.005, not $0.001. x-mcp's normal deployment (an
  operator using their own app) meets the condition, but the README pricing
  section should say so.

### F-5 — Follows, likes and quote-posts "removed from all self-serve tiers" *(not covered; needs a live check before 1.0)*

The 2026-04-16 changelog entry ends with: "Following, Likes, and Quote-Posts via the
API have been removed from all self-serve tiers." x-mcp ships `x_like_set` and
`x_follow_set`, and docs/01 §5 lists the quote-posts lookup.

Public docs point both ways:
- The endpoint reference pages for like, follow and quoted posts are still published
  without a deprecation notice.
- The pricing page still prices User Interaction: Create ($0.015), which covers those
  writes.
- The Activity API still bills `follow.follow` events.

The sentence may mean "removed from the legacy Basic/Pro tiers", but that cannot be
decided from public docs.

**Recommendation** (high priority for the release-week run):
- Verify with one approved live call per surface (like, follow, quote-posts lookup)
  on a pay-per-use account.
- If they are refused, map the refusal to a clear availability error and say so in
  the README. Removing the tools would be a product decision.
- Until then, no repo text should promise these surfaces work under pay-per-use
  without that check.

### F-6 — XChat versus `x_dm_send` *(resolved; docs updated, recommendation)*

Encrypted DMs (XChat) have their own Chat API under `/2/chat/…`: conversations,
keys, members, messages, read and typing state, and media upload. Encryption happens
on the client through the Chat XDK, with the `dm.read`/`dm.write` scopes. The pricing
page bills a `chat.received` webhook event at $0.010.

The `/2/dm_conversations…` and `/2/dm_events` endpoints that `x_dm_send` and the
three DM read tools use are unchanged. They carry no deprecation notice. The docs
now call them the "legacy (unencrypted)" DM system, and the 30-day retention (DM-2)
still stands.

**Consequence**: the DM tools can neither see nor send into encrypted XChat
conversations. docs/01 §5 and §7 now say so, and the CHANGELOG records it under
"Platform changes absorbed".

**Recommendation**: a note in the DM tools' README rows. Chat API tools would be a
post-1.0 product decision; they need client-side key handling, which is a
significant security-design item.

### F-7 — Summoned replies *(not covered; recommendation)*

Two changelog entries apply:
- 2026-02-23: on self-serve tiers, a programmatic reply is allowed only when the
  original author "summoned" the replier, by @mentioning that account or quoting one
  of its posts.
- 2026-04-16: summoned replies cost $0.010, not $0.015.

x-mcp does not model either rule. Its $0.015 estimate for such a reply
over-counts, which is safe.

**Recommendation**:
- Map the non-summoned reply refusal (a 403 on `POST /2/tweets` with `reply_to_id`)
  to a distinct, explained error next to POST-7.
- Mention the rule in `x_post_create`'s documentation. That is a README/docs change;
  changing the tool description needs the context-gate budget.

### F-8 — OAuth 1.0a → OAuth 2.0 token exchange *(not covered; recommendation)*

The 2026-09-21 changelog entry: `POST /2/oauth2/token` with
`grant_type=urn:ietf:params:oauth:grant-type:token-exchange` turns a stored OAuth
1.0a token pair into an OAuth 2.0 access + refresh token. There is no consent screen,
and `offline.access` is always included.

**Recommendation**: mention it in docs/01 §2.2 as the migration path off x-mcp's
legacy OAuth 1.0a mode. It could later become an `authorize` subcommand option (a
post-1.0 product decision).

### F-9 — Minor platform additions *(not covered; no action)*

- `paid_partnership` post field (2026-06-03).
- Articles draft/publish endpoints (2026-06-11).
- X Activity API post, mute/block and broadcast-chat events (2026-06-04,
  2026-07-21, 2026-09-29).
- Additional OAuth scopes in the OpenAPI security schemes (`broadcast.*`,
  `developer.*`, `timeline.read`).

None of these affects a shipped tool. `auth_status` shows granted scopes verbatim,
so new scopes are handled.

## 4. What was changed in this pre-run

| File | Change |
|---|---|
| `src/tools/search.ts`, `src/tools/archive.ts` | DRIFT-3 check refuses `min_faves:`/`min_retweets:` instead of the restored operators (F-1) |
| `test/tools/search.test.ts`, `test/tools/archive.test.ts` | DRIFT-3 tests retargeted; new test for the restored operators (F-1) |
| `src/api/endpoints/media.ts` | Stale "X limit" comment on the video cap corrected (F-3) |
| `docs/07-corner-cases.md` | DRIFT-3 rewritten (F-1) |
| `docs/01-api-landscape.md` | Last fact-checked date; Owned Reads list and app-owner condition (F-4); legacy/XChat DM note (F-6); 2026-09-01 media limits (F-3); volatility item 4 |
| `CHANGELOG.md` | Unreleased → Changed (F-1); Platform changes absorbed (2026-10-01) |
| `docs/08-implementation-roadmap.md` | Pre-run note under the release-week fact-check item (box left unchecked) |

## 5. For the release-week run

Re-fetch the sources in §1 and diff the changelog against **Sep 29, 2026**, the
newest entry seen here. Re-confirm rows 1–16 of §2. Settle F-5 with an approved live
check. Decide F-3 and F-4 (a) before tagging 1.0.
