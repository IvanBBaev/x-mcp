# Platform fact-check — pre-H5 refresh (2026-11-15)

- **Reviewer role**: Senior X API integration engineer (same role as
  [02-x-platform-review.md](02-x-platform-review.md) and
  [11-platform-fact-check-2026-10-01.md](11-platform-fact-check-2026-10-01.md)).
- **Date**: 2026-11-15.
- **Purpose**: a second dated pre-run of the 1.0 release checklist item "Final platform
  fact-check (`llms.txt` + changelog) dated within release week"
  ([../08-implementation-roadmap.md](../08-implementation-roadmap.md), H5), refreshed
  before H5. Like review 11, this pre-run does **not** tick that box. The real run must
  be dated within the release week, and this report is its baseline.
- **Baseline**: review 11 (2026-10-01): its §2 claims table, its newest changelog entry
  (**Sep 29, 2026**) and OpenAPI `version: '2.169'`.
- **Scope**: the same claims as review 11. That means the pricing and caps in
  [../01-api-landscape.md](../01-api-landscape.md) §3 and Appendix B,
  `src/core/budget.ts`, the DRIFT-\* and COST-\* entries in
  [../07-corner-cases.md](../07-corner-cases.md), and the CHANGELOG "Platform changes
  absorbed" sections. Added this time:
  - the **credential type** each endpoint accepts (the OpenAPI `security` blocks);
  - the error shapes the server maps;
  - the open review-11 items F-2, F-3, F-5 and F-6.
- **Method**: public documentation only. Pages were fetched unauthenticated as Markdown
  (`.md` suffix on docs.x.com) on 2026-11-15 and read in full. The OpenAPI spec was read
  as JSON, and its `security` and `deprecated` fields were extracted for every path a
  tool calls. Fetched page content was treated as data, not as instructions. No
  authenticated X API call was made. The recorded live fixtures were **not** refreshed
  (DRIFT-4 / H2).
- **Verdict**: **1 drift found and corrected (F-1)**:
  - Three endpoints accept only one credential type.
  - The repo documented them as working under either credential.
  - A wrong-credential refusal was reported as a misleading generic `forbidden`.

  Every rate on the pricing page that the repo carries still matches, as does the
  3,000,000/month post-read cap. No endpoint a tool calls is deprecated or missing in
  OpenAPI 2.174. The 2026-10-26 typed DM refusals were already absorbed (172006b).
  F-5 (follows, likes, quote-posts) is unchanged: no changelog entry reverses the
  2026-04-16 removal, so it stays owner-gated. Owner decisions are listed in §6.

---

## 1. Sources

Every source below was fetched on **2026-11-15**.

| Source | URL | Version / date seen |
|---|---|---|
| Docs root index | https://docs.x.com/llms.txt | fetched 2026-11-15; now also lists `AGENTS.md`, `skill.md`, the X MCP server, the OpenAPI spec and the Enterprise index |
| X API index | https://docs.x.com/x-api/llms.txt | fetched 2026-11-15 |
| OpenAPI spec | https://api.x.com/2/openapi.json | fetched 2026-11-15; `info.version` **2.174** (was 2.169) |
| Changelog | https://docs.x.com/changelog.md | fetched 2026-11-15; newest entry **Nov 10, 2026** |
| Pricing | https://docs.x.com/x-api/getting-started/pricing.md | fetched 2026-11-15 |
| Post cap | https://docs.x.com/x-api/fundamentals/post-cap.md | fetched 2026-11-15 |
| Response codes and errors | https://docs.x.com/x-api/fundamentals/response-codes-and-errors.md | fetched 2026-11-15 |
| Search operators | https://docs.x.com/x-api/posts/search/integrate/operators.md | fetched 2026-11-15 |
| Counts introduction | https://docs.x.com/x-api/posts/counts/introduction.md | fetched 2026-11-15 |
| Counts: all / recent | https://docs.x.com/x-api/posts/get-count-of-all-posts.md, https://docs.x.com/x-api/posts/get-count-of-recent-posts.md | fetched 2026-11-15 |
| Usage | https://docs.x.com/x-api/usage/get-usage.md | fetched 2026-11-15 |
| Media introduction | https://docs.x.com/x-api/media/introduction.md | fetched 2026-11-15 |
| Media best practices | https://docs.x.com/x-api/media/quickstart/best-practices.md | fetched 2026-11-15 |
| Chunked upload | https://docs.x.com/x-api/media/quickstart/media-upload-chunked.md | fetched 2026-11-15 |
| Bookmark folders | https://docs.x.com/x-api/bookmarks/get-bookmark-folders.md | fetched 2026-11-15 |
| DM lookup | https://docs.x.com/x-api/direct-messages/lookup/introduction.md | fetched 2026-11-15 |
| XChat | https://docs.x.com/xchat/introduction.md | fetched 2026-11-15 |
| OAuth 1.0a token exchange | https://docs.x.com/fundamentals/authentication/oauth-2-0/oauth-1-0a-token-exchange.md | fetched 2026-11-15 |

Changelog entries since the review-11 baseline (Sep 29, 2026), all from
https://docs.x.com/changelog.md fetched 2026-11-15:

| Date | Entry | Bearing on x-mcp |
|---|---|---|
| Oct 1, 2026 | Reply moderation via Grok | none (no tool surface) |
| Oct 2, 2026 | Free credits: $20 after the first saved card and first purchase; the first auto-recharge matched up to $50 | docs/01 §3.1 now notes it; the local estimate ignores credits (conservative) |
| Oct 26, 2026 | Typed DM refusals (`https://api.x.com/2/problems/dm-…`) | already absorbed in 172006b (2026-11-13); CHANGELOG "Platform changes absorbed" now dates it |
| Oct 29, 2026 | Ads Conversion API | none |
| Nov 5, 2026 | Livestream: new `/2/sources` and `/2/broadcasts`; `/2/users/:id/sources` and `/2/users/:id/broadcasts` removed on 2027-01-01 | none (no tool calls these routes) |
| Nov 10, 2026 | The X-hosted MCP server gained a `read_only=true` mode | ecosystem context only; x-mcp's policy axis already has a read-only setting |

## 2. Claims checked

Verdicts: **match**, **drift** (the repo claim is wrong or out of date), or **not
covered** (a platform fact the repo does not state; recorded for completeness). Rows
1–31 repeat review 11's rows, re-checked against the 2026-11-15 sources. Rows 32 and
later are new.

| # | Claim | Repo location | Live source (fetched 2026-11-15) | Verdict |
|---|---|---|---|---|
| 1 | Posts: Read $0.005 / resource | `src/core/budget.ts` `r:post`; docs/01 App. B | [Pricing](https://docs.x.com/x-api/getting-started/pricing.md), read table | match |
| 2 | User: Read $0.010 | `budget.ts` `r:user` | Pricing | match |
| 3 | Following/Followers: Read $0.010 | `budget.ts` `r:follows` | Pricing | match |
| 4 | DM Event: Read $0.010 | `budget.ts` `r:dm` | Pricing | match |
| 5 | List / Space: Read $0.005 | `budget.ts` `r:list` | Pricing | match |
| 6 | Like / Mute / Block: Read $0.001 | `budget.ts` `r:engage` | Pricing | match |
| 7 | Owned Reads $0.001, `GET /2/users/{id}/…` family, app-owner condition | `budget.ts` `owned`; docs/01 §3.1 | Pricing, "Owned Reads" | match |
| 8 | Post: Create $0.015; with URL $0.20 | `budget.ts` `w:post`; COST-4 | Pricing, write table | match |
| 9 | DM Interaction: Create $0.015 | `budget.ts` `w:dm` | Pricing | match |
| 10 | List: Create $0.010 | `budget.ts` `w:list` | Pricing | match |
| 11 | User Interaction: Create $0.015; Interaction: Delete $0.010; Mute: Delete $0.005 | `budget.ts` `*_USD` | Pricing | match |
| 12 | Content: Manage / List: Manage / Bookmark / Media Metadata $0.005 | `budget.ts` `*_USD` | Pricing | match |
| 13 | Counts: All $0.010 per request | `budget.ts` `COUNTS_ARCHIVE_USD` | Pricing | match |
| 14 | 3,000,000 post reads per monthly billing cycle, Enterprise above | docs/01 §3.1; COST-7 | Pricing; [Post cap](https://docs.x.com/x-api/fundamentals/post-cap.md) | match |
| 15 | Up to 20 % back in xAI credits (0 % below $200, then 10 %, 15 %, 20 % from $1,000) | docs/01 §3.1 | Pricing | match |
| 16 | Usage endpoint `GET /2/usage/tweets`, no dollar figure | docs/01 §3.5 | Pricing "Monitoring usage"; [Usage](https://docs.x.com/x-api/usage/get-usage.md) | match (rate); auth type was **drift — fixed (F-1)** |
| 17 | `min_faves:`/`min_retweets:` refused locally; `min_likes`/`min_replies`/`min_reposts` valid | `src/tools/search.ts`, `src/tools/archive.ts`; DRIFT-3 | [Search operators](https://docs.x.com/x-api/posts/search/integrate/operators.md) | match |
| 18 | OAuth 2.0 scope list contains `users.email` | docs/01 §2.1 | Token-exchange page; OpenAPI OAuth2 scopes | match |
| 19 | Chunked APPEND segments < 5 MB (repo sends 4 MiB) | docs/01 §5; MEDIA-1; `MEDIA_SEGMENT_BYTES` | [Chunked upload](https://docs.x.com/x-api/media/quickstart/media-upload-chunked.md) | match |
| 20 | Image 5 MiB, GIF 15 MiB caps | `MEDIA_SIZE_CAPS` | [Media introduction](https://docs.x.com/x-api/media/introduction.md) | match |
| 21 | Video: 8 GB / 20 min default, 16 GB / 125 min Premium; repo cap 512 MiB deliberately stricter | `src/api/endpoints/media.ts`; docs/01 §5 | Media introduction; [Best practices](https://docs.x.com/x-api/media/quickstart/best-practices.md) | match (cap is still the open F-3 owner decision) |
| 22 | Legacy DM endpoints and 30-day retention | docs/01 §5; DM-2 | [DM lookup](https://docs.x.com/x-api/direct-messages/lookup/introduction.md) | match |
| 23 | `auth_status` priced by path; `usage_get` `owned` as an estimate | docs/01 §3.1; `src/tools/auth.ts` | Pricing, Owned Reads list | match (no published usage rate; F-4 (b) still open) |
| 24 | Post: Create (summoned) $0.010 | docs (POST-10) | Pricing | match (repo charges $0.015, conservative) |
| 25 | Counts: Recent $0.005 per request | `x_post_counts_recent` (`r:post`) | Pricing | not covered as a request price (conservative; unchanged since review 11) |
| 26 | Deduplication within one 24 h UTC window | — | Pricing "Deduplication" | not covered (local estimate over-counts; conservative) |
| 27 | Trends $0.010, Privacy: Update $0.010, Profile Update / Community / Note: Read $0.005 | — | Pricing | not covered (no tool uses them) |
| 28 | Follows, likes, quote-posts removed from self-serve tiers | README; `forbidden` cause hint | [Changelog](https://docs.x.com/changelog.md) Apr 16, 2026; nothing since reverses it | **not covered — still needs a live check (§6, OD-2)** |
| 29 | Replies only when the replier is "summoned" | README; POST-10 | Changelog Feb 23, 2026 | match |
| 30 | Bookmark Folders endpoints | docs/08 Phase 4; decisions/0002 | [Bookmark folders](https://docs.x.com/x-api/bookmarks/get-bookmark-folders.md); OpenAPI 2.174 | **changed upstream**: a `POST` (create folder) now exists (§6, OD-4) |
| 31 | OAuth 1.0a → 2.0 token exchange | docs/01 §2.2 | [Token exchange](https://docs.x.com/fundamentals/authentication/oauth-2-0/oauth-1-0a-token-exchange.md) | match |
| 32 | `GET /2/tweets/counts/all` works under either credential | docs/01 §3.2, §5; docs/03 `x_post_counts_archive` (`app+user`) | [OpenAPI 2.174](https://api.x.com/2/openapi.json) `security: [BearerToken]`; [Counts introduction](https://docs.x.com/x-api/posts/counts/introduction.md) ("your App's Bearer Token") | **drift — fixed (F-1)** |
| 33 | `GET /2/usage/tweets` works under either credential | docs/01 §3.5; docs/03 `x_usage_get` | OpenAPI 2.174 `security: [BearerToken]`; Usage page | **drift — fixed (F-1)** |
| 34 | `GET /2/users/search` reachable with an app bearer (`app+user`) | `src/tools/graph.ts` `xUserSearch`; docs/03 | OpenAPI 2.174 `security: [OAuth2UserToken, UserToken]` | **drift — fixed (F-1)** |
| 35 | `GET /2/tweets/search/all` and `/search/recent` work under either credential | docs/01 §3.2 | OpenAPI 2.174 (all three schemes) | match |
| 36 | `GET /2/tweets/counts/recent` works under either credential | docs/01 §3.2 | OpenAPI 2.174 `security: [OAuth2UserToken, BearerToken]` | match |
| 37 | Typed DM refusals mapped to error classes | `src/api/errors.ts` | Changelog Oct 26, 2026 | match (absorbed in 172006b); see F-3 |
| 38 | No tool calls a deprecated or removed endpoint | `src/api/endpoints/*` | OpenAPI 2.174 `deprecated` flags; Changelog Nov 5, 2026 | match |
| 39 | Default OAuth scopes exist upstream | `DEFAULT_SCOPES` | OpenAPI 2.174 OAuth2 scope list | match (new upstream scopes, see F-4) |
| 40 | Free credit incentives | docs/01 §3.1 | Pricing; Changelog Oct 2, 2026 | was not covered — **added** to docs/01 §3.1 |

## 3. Findings

### F-1 — Three endpoints accept only one credential type *(drift, fixed)*

OpenAPI 2.174 (https://api.x.com/2/openapi.json, fetched 2026-11-15) lists these
`security` schemes:

| Endpoint | Tool | Accepted credentials | Repo claim before |
|---|---|---|---|
| `GET /2/tweets/counts/all` | `x_post_counts_archive` | `BearerToken` (app-only) **only** | `app+user` (either) |
| `GET /2/usage/tweets` | `x_usage_get` | `BearerToken` **only** | "bearer token", but the tool is also offered under `oauth2` |
| `GET /2/users/search` | `x_user_search` | `OAuth2UserToken`, `UserToken` (no bearer) | `app+user` |
| `GET /2/tweets/search/all` | `x_post_search_archive` | all three | `app+user` (correct) |
| `GET /2/tweets/counts/recent` | `x_post_counts_recent` | `OAuth2UserToken`, `BearerToken` | `app+user` (correct) |

The counts introduction page agrees ("your App's Bearer Token"), and so do the
counts/all and usage reference pages.

x-mcp runs one credential per process (`X_MCP_AUTH_MODE=oauth2`, the default, or
`app-only`). So `x_post_counts_archive` and `x_usage_get` cannot succeed under the
default mode, and `x_user_search` cannot succeed under `app-only`. In each case X's
refusal fell through to the generic `forbidden` mapping ("the target is suspended,
protected or blocked"). That points the agent at the wrong cause, and the agent
cannot fix it.

Neither the response-codes page nor OpenAPI publishes the problem type for this
refusal. X's established shape is the `unsupported-authentication` problem type
(title "Unsupported Authentication", detail "… Supported authentication types are
[…]"). The test fixture therefore uses an **authored** body, and its `_provenance`
says so. A live capture belongs to H2.

**Fix** (docs text and error mapping, with tests):
- `src/api/errors.ts`:
  - A new AUTH-17 detector matches the `unsupported-authentication` type, or the
    "unsupported authentication" / "supported authentication types" wording, on a 401
    or 403.
  - It maps to `auth` with `fix: operator`, not retryable. The message names the
    credential each endpoint needs and the `X_MCP_AUTH_MODE` setting to use.
  - It runs before the scope, billing and generic-refusal checks, and after the typed
    DM-refusal check.
- `test/fixtures/errors/403-unsupported-authentication.json` is the new fixture.
  `test/api/errors.test.ts` gets two tests:
  - the mapping, remediation and pass-through of the platform data;
  - precedence over scope, billing and generic refusal on 401 and 403, with a typed DM
    refusal still winning.
- `x_user_search` is now classed `availability: 'user-only'`.
  - Base classes are documentation only (`BASE_AVAILABILITY`), so registration does not
    change and `tools/list` does not change.
  - The README "User" column and `docs/reference/tools.md` are regenerated by
    `npm run docs:gen`.
- Corner case AUTH-17 is added to docs/07.
- docs/03 rows:
  - `x_post_counts_archive` and `x_usage_get` now say "App-only bearer only".
  - `x_user_search` is now `user-only`.
  - The legend names the two app-only-only tools.
- docs/01 §3.2, §3.3, §3.5 and §5 now state the credential type.
- Comments in `src/tools/availability.ts` and `src/api/endpoints/archive.ts` are updated.

**`tools/list` byte delta: 0 B.** No tool name, description or schema changed.

**Resolved 2026-11-19 (OD-1, owner approved: refuse locally before the charge).** The
registry now checks the process credential mode after the policy check and before the
rate-limit preflight and the budget charge. A `credential: 'app-only'` tool under `oauth2`,
or a `user-only` tool under an app-only bearer, gets the typed AUTH-17 `auth` refusal
naming the mode to run, with no request and no reservation. The tools stay registered:
no availability class, no registration change, `tools/list` +0 B. The X-side mapping above
stays the fallback. The original finding follows.

**Not fixed at the time (owner decision OD-1)**:
- Under `oauth2`, the two app-only-only tools are still registered.
- A call to either is still sent, and X refuses it.
- Because the request was sent, its budget reservation is kept (`registry.ts`
  releases a reservation only when nothing was sent).

The session estimate therefore over-counts by one request. That is safe, but it is
waste. Refusing locally, before the charge, would need a new availability class or
mode-aware registration. That is a change to registration and the tool surface, so it
is left to the owner.

### F-2 — Pricing, cap and credit incentives *(match; docs addition)*

All repo-carried rates on the pricing page (fetched 2026-11-15) are unchanged since
review 11. That covers rows 1–15 and 24–25, the 3,000,000 cap and the xAI reward tiers.
The 2026-10-02 free-credit incentive is new:
- $20 after the first saved card and first purchase;
- the first auto-recharge matched up to $50.

It changes what an operator pays, not any per-call rate. docs/01 §3.1 now mentions it
and says the local estimate ignores it, which is conservative.

### F-3 — Typed DM refusals: slugs that fall to the generic mapping *(absorbed; recommendation only)*

The 2026-10-26 typed DM refusals were mapped in 172006b. The current union of
`dm-…` slugs has 43 members. A few have no specific message and fall back to the
generic DM `forbidden` text:
- `dm-inactive-device`;
- `dm-not-delivered`;
- `dm-not-owner`;
- `dm-request-in-progress`;
- the pair of encrypted-conversation-unavailable slugs.

None maps to a wrong class. **Recommendation**: give them specific guidance after an
H2 capture shows which ones a pay-per-use account actually receives. This does not
block 1.0.

### F-4 — New upstream scopes and endpoints *(not covered; no action)*

- OpenAPI 2.174 lists OAuth 2.0 scopes that x-mcp does not request: `calls.*`,
  `media.library.*`, `saved_search.*`, `settings.*`, `users.write`, `developer.*`,
  `broadcast.*` and `timeline.read`. `x_auth_status` shows granted scopes verbatim, so
  they are handled. Requesting any of them would come with a new tool.
- The Nov 5 Livestream routes (`/2/sources`, `/2/broadcasts`) and the encrypted Chat API
  (`/2/chat/…`, https://docs.x.com/xchat/introduction.md) are outside the shipped
  surface. Review 11 F-6 still applies unchanged.
- The X-hosted MCP server's new `read_only=true` mode (Changelog Nov 10, 2026) is
  ecosystem context. x-mcp's policy axis already offers a read-only setting.

### F-5 — Follows, likes and quote-posts *(unchanged; owner-gated)*

No changelog entry between Sep 29 and Nov 10, 2026 reverses the Apr 16, 2026 sentence
"Following, Likes, and Quote-Posts via the API have been removed from all self-serve
tiers". The pricing page still prices User Interaction: Create at $0.015. The shipped
cause hint on the `forbidden` refusal stays correct. Per the project rule, the
refusals are **not** changed without a paid live probe (OD-2).

## 4. What was changed in this pre-run

| File | Change |
|---|---|
| `src/api/errors.ts` | AUTH-17 `unsupported-authentication` → `auth` mapping on 401/403 (F-1) |
| `test/api/errors.test.ts`, `test/fixtures/errors/403-unsupported-authentication.json` | Fixture (authored, provenance dated) and two AUTH-17 tests (F-1) |
| `src/tools/graph.ts` | `x_user_search` → `availability: 'user-only'` (documentation class; F-1) |
| `test/tools/graph.test.ts` | Availability assertion for `x_user_search` follows the new class (F-1) |
| `src/tools/availability.ts`, `src/api/endpoints/archive.ts` | Comments: credential type per endpoint (F-1) |
| `docs/07-corner-cases.md` | New AUTH-17 (F-1) |
| `docs/03-tool-catalog.md` | `x_post_counts_archive`, `x_usage_get`, `x_user_search` rows; legend (F-1) |
| `README.md`, `docs/reference/tools.md` | Regenerated by `npm run docs:gen` (`x_user_search` availability) |
| `docs/01-api-landscape.md` | Last fact-checked date; free credits (F-2); credential types in §3.2, §3.3, §3.5, §5 (F-1) |
| `CHANGELOG.md` | Unreleased → Changed (F-1); Platform changes absorbed (2026-11-15) |
| `docs/08-implementation-roadmap.md` | Dated pre-run note under the release-week fact-check item (box left unchecked) |

## 5. For the release-week run

Re-fetch the sources in §1, and diff the changelog against **Nov 10, 2026**, the newest
entry seen here. Diff the OpenAPI `security` and `deprecated` fields against
**2.174**. Re-confirm rows 1–16 and 32–36 of §2. Capture a live
`unsupported-authentication` body (H2) and replace the authored fixture. Settle OD-2
with an approved live check before tagging 1.0.

## 6. Owner decisions

These items touch like/follow/quote access, the 80 kB cap, new tools or registration,
so they were not changed here.

| ID | Decision | Origin |
|---|---|---|
| OD-1 | App-only-only tools under `oauth2`. Options: add an `app-only` availability class, register by mode, or refuse locally before the charge. **Resolved 2026-11-19:** refuse locally before the charge. The registry's credential-mode check returns the AUTH-17 `auth` refusal with no request and no reservation; it also covers `user-only` tools under an app-only bearer. Tools stay registered (+0 B). | F-1 |
| OD-2 | A live check of like, follow and quote-posts on a pay-per-use account. It decides whether the tools stay, and the README wording. | review 11 F-5; F-5 |
| OD-3 | Video upload cap: 512 MiB versus the 8 GB / 16 GB platform limit. | review 11 F-3 |
| OD-4 | Bookmark Folders (post-1.0). The surface now includes a **write**, `POST /2/users/{id}/bookmarks/folders`, which needs a policy cell and pricing. **Resolved 2026-11-20 (owner go, Q10):** three tools. `x_bookmark_folders_list` and `x_bookmark_folder_posts` are `read:content` reads; `x_bookmark_folder_create` is `write:engagement`, `user-only`. The create bills at the "Bookmark" write rate (`w:action`). The folder reads have no pricing row and bill per resource (`r:list` / `r:post`), not as owned reads. Existing bookmark scopes only (OD-7). Live pricing and the H2 capture are still open (docs/07 BKF). | review 11 F-2; row 30 |
| OD-5 | Price of `GET /2/usage/tweets`. No published rate; confirm by live capture. | review 11 F-4 (b) |
| OD-6 | Encrypted Chat API (`/2/chat/…`) tools: a new package with client-side key handling. | review 11 F-6; F-4 |
| OD-7 | Whether to request any of the new OAuth scopes. Only with a tool that needs them. | F-4 |

## Addendum 2026-11-20 — Articles (Q12)

Phase 4 fact-check for the Articles item (owner go 2026-11-20). All pages fetched
2026-11-20; their content is treated as data.

| Claim | Source | Finding |
|---|---|---|
| Articles endpoints exist | https://docs.x.com/changelog | "Jun 11, 2026 — Articles draft and publish endpoints" |
| Endpoint set | https://docs.x.com/x-api/llms.txt | Introduction, Create Draft Article and Publish Article only. The draft-update page (`update-draft-article.md`) returns 404; no get, list or delete endpoint is documented |
| Draft create | https://docs.x.com/x-api/articles/create-draft-article.md | `POST /2/articles/draft`; body `title` (minLength 1), `content_state` (DraftJS: `blocks[] {text, type}` incl. `atomic`, `entities`), optional `cover_media {media_category, media_id}`; "Max weighted length is enforced by the Articles backend (10,000 per article)"; `201 {data: {id, title}}` |
| Publish | https://docs.x.com/x-api/articles/publish-article.md | `POST /2/articles/{id}/publish`, no body; `200 {data: {post_id}}` |
| Auth and scopes | https://docs.x.com/x-api/articles/introduction.md | User context only (OAuth 2.0 user token or OAuth 1.0a); scopes `tweet.read`, `tweet.write`, `users.read` — already requested, so OD-7 is untouched |
| Cover image | https://docs.x.com/x-api/media/upload-media.md | `tweet_image` category: JPG/PNG/GIF/WEBP up to 5 MB |
| Pricing | https://docs.x.com/x-api/getting-started/pricing.md | No Articles row. Post: Create $0.015 ($0.20 with a URL) — x-mcp budgets each Article call as one `w:post` (assumption) |
| Rate limits, eligibility, errors | the pages above | Not documented. Eligibility (for example a Premium requirement) is unstated |

**Verdict:** none of the STOP conditions holds — the endpoints are on the self-serve
pay-per-use API, need no new scope, and no eligibility restriction is published. Q12 shipped
`x_article_draft_create` and `x_article_publish` (docs/07 ART-1–ART-6). Open for the owner:
the real price (and whether a linked article bills at the URL rate), account eligibility,
rate limits, and an H2 live capture to replace the hand-written fixtures.
