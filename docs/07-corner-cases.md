# 07 — Corner-case catalog

Consolidated catalog of corner cases the implementation must handle, each with its
**specified expected behavior** — this document is normative: a case listed here is a
requirement, and the test suite must reference these IDs (see
[05-testing-and-quality.md](05-testing-and-quality.md) and the traceability rule in
[08-implementation-roadmap.md](08-implementation-roadmap.md)).

Sources are tagged: `[ARCH-Fn]` = [architecture review](reviews/01-architecture-review.md),
`[X-Fn]` = [X-platform review](reviews/02-x-platform-review.md), `[SEC-Fn/Tn]` =
[security review](reviews/03-security-review.md), `[QA-n]` = the
[QA review](reviews/04-qa-review.md) 60-item checklist / `[QA-Fn]` its findings,
`[OPS-Fn]` = [DevOps review](reviews/05-devops-review.md), `[DX-Fn]` =
[agent-DX review](reviews/06-agent-dx-review.md), `[new]` = added in this pass.

Phase tags (`P1`–`P3`) mark when the behavior must exist, matching
[08-implementation-roadmap.md](08-implementation-roadmap.md).

---

## 1. CFG — Configuration & startup

- **CFG-1 — `~` in path-valued env vars** `P1` `[OPS-F5]`
  MCP clients pass env values verbatim and Node never expands `~`. `parseConfig`
  expands a **leading** `~/` (and bare `~`) on every path-valued var
  (`X_MCP_TOKEN_FILE`, `X_MCP_PROFILES_FILE`, `X_MCP_MEDIA_DIR`) to `os.homedir()`.
  A mid-string `~` is left untouched.

- **CFG-2 — No token path configured (OAuth2 mode)** `P1` `[OPS-F5]`
  `X_MCP_TOKEN_FILE` unset → default path: `$XDG_CONFIG_HOME/x-mcp/tokens.json`,
  falling back to `~/.config/x-mcp/tokens.json` (macOS/Linux) and
  `%APPDATA%\x-mcp\tokens.json` (Windows). The directory name is **`x-mcp`**
  everywhere (decided; the npm package name `x-mcp-ai` does not leak into paths).

- **CFG-3 — Profiles file and direct credentials both present** `P1` `[ARCH-F9]`
  If `X_MCP_PROFILES_FILE` is set, `X_MCP_PROFILE` is **required** and any direct
  credential var (`X_MCP_BEARER_TOKEN`, `X_MCP_CLIENT_ID`, `X_MCP_CLIENT_SECRET`) is a
  **startup error** naming both sources. No silent precedence — ambiguity fails loud.

- **CFG-4 — Env var set to empty string** `P1` `[new]`
  An empty-string value is treated as **unset** for optional vars and as a startup
  error for required ones (same message as missing). Never treated as a valid value.

- **CFG-5 — Invalid config refuses startup legibly** `P1` `[OPS-F9]`
  On any fatal config error the server prints one plain-text stderr line prefixed
  `x-mcp-ai: fatal: <reason>` (not JSON) and exits non-zero immediately. No retry
  loop — the MCP client owns respawn. All other logging stays single-line JSON on
  stderr.

- **CFG-6 — Profiles file permissions and content** `P1` `[SEC-T16]`
  The profiles file is a secret: on POSIX, warn at startup if readable by
  group/other (same rule as the token file). Its `policy` values are re-validated at
  load exactly like env-provided policy; an invalid profile cell refuses startup.

- **CFG-7 — `X_MCP_BASE_URL` override is loud and gated** `P1` `[SEC-T10/F4, OPS-F12]`
  The override requires `https://` and the explicit dev flag
  `X_MCP_ALLOW_INSECURE_BASE_URL=1` to take effect for a non-`*.x.com` host. When
  active it appears in the startup banner and in `auth_status`. It is env-only —
  never a tool parameter.

- **CFG-8 — Unknown `X_MCP_*` variables** `P1` `[new]`
  Any env var matching `X_MCP_*` that the server does not recognize produces a
  startup **warning** (typo detection: `X_MCP_POLCY=full` silently ignored is how
  operators end up running the wrong policy), but does not refuse startup.

- **CFG-9 — Token/profiles file on synced or network storage** `P2` `[new]`
  Advisory locks and rename atomicity are unreliable on cloud-synced directories
  (iCloud Drive, Dropbox, OneDrive) and network mounts — a sync conflict can
  resurrect a rotated-out refresh token and lock the account. `doctor` warns when
  the resolved token path lies under a known synced root; the operator docs state
  the token file belongs on local disk.

## 2. AUTH — OAuth 2.0 token lifecycle

- **AUTH-1 — Persist-before-use ordering** `P2` `[QA-1]`
  After a successful refresh, the rotated pair is written to disk (atomic
  tmp+rename, `0600`) **before** the new access token is used on any request. A
  crash between refresh response and persist must never leave a used-but-unsaved
  rotation.

- **AUTH-2 — Two concurrent in-process 401s → exactly one refresh call** `P2`
  `[ARCH-F1, QA-6]`
  Refresh is **single-flight**: concurrent callers share one refresh promise. Tests
  assert exactly one HTTP call to the token endpoint for N concurrent 401s.

- **AUTH-3 — Waiter re-reads and skips refresh** `P2` `[ARCH-F1, SEC-F1]`
  After acquiring the cross-process lock, the token manager **re-reads the token
  file**. If the on-disk pair differs from the in-memory one (a peer already
  rotated), it adopts the on-disk pair and skips the refresh entirely. This is the
  rule that prevents burning a rotation and locking the account.

- **AUTH-4 — Reload-on-401 before refreshing** `P2` `[SEC-F1]`
  On any 401, reload the token file under the lock before deciding to refresh — a
  peer process (second MCP client on the same `X_MCP_TOKEN_FILE`) may have rotated
  while this process held a stale in-memory copy.

- **AUTH-5 — Stale lock is never broken into a second refresh** `P2` `[ARCH-F1, SEC-T13]`
  The lock file contains PID + timestamp and is created `O_CREAT|O_EXCL|O_NOFOLLOW`,
  `0600`, in the token file's directory. The refresh HTTP call carries a timeout
  well under the 30 s staleness threshold. On ambiguity (holder possibly alive), the
  server **fails closed** with a typed `auth` error rather than break-and-refresh.

- **AUTH-6 — Non-rotating refresh response** `P2` `[X-F8]`
  Refresh-token rotation is observed behavior, not documented contract. If the
  token response contains no new `refresh_token`, the old one is **retained**; if it
  contains the same one, that is persisted without error. Never assume rotation.

- **AUTH-7 — Eager-refresh boundary and clock skew** `P2` `[QA-7, SEC-F15]`
  Eager refresh triggers under 5 minutes of remaining lifetime, computed via the
  injected Clock. Boundary tests at 4:59 and 5:01. The reactive 401 path remains the
  source of truth — a skewed clock may cause an early refresh but must never cause a
  double refresh (AUTH-2/3 guard it).

- **AUTH-8 — Refresh rejection (`invalid_grant`/400/401)** `P2` `[QA-6]`
  A rejected refresh, after the AUTH-4 reload check, is terminal: typed `auth` error
  with the exact recovery instruction (`npx x-mcp-ai authorize`), never a retry
  loop. Applied **exactly once** per triggering request (401 → refresh → 401 →
  stop).

- **AUTH-9 — Corrupt, empty, or partial token file** `P2` `[QA-9]`
  Zero-byte file, invalid JSON, or JSON missing required fields → typed `auth` error
  naming the path and the re-authorize instruction. Never crash, never delete the
  file (the operator may want to inspect it).

- **AUTH-10 — Missing `refresh_token` in stored file** `P2` `[QA-10]`
  Access token present, refresh token absent: usable until expiry; on expiry/401 the
  error explains that no refresh is possible and re-authorization is required.

- **AUTH-11 — Missing `expires_in`/`obtained_at`** `P2` `[new]`
  If lifetime cannot be computed, skip eager refresh entirely and rely on the
  reactive 401 path. No crash, no assumption of a default lifetime.

- **AUTH-12 — Token file permissions** `P2` `[QA-8, OPS-F5]`
  Created `0600`; on POSIX, startup warns when perms are wider. On win32 the POSIX
  check is skipped with a single documented warning that ACLs are the operator's
  responsibility (`doctor` can inspect via `icacls`).

- **AUTH-13 — Authorize flow security invariants** `P2` `[SEC-F3/T12]`
  `npx x-mcp-ai authorize`: cryptographically random `state` validated on callback;
  listener bound to `127.0.0.1` only, ephemeral port, one-shot with short timeout;
  `code`/`code_verifier` never echoed to the browser page, argv, or logs. A `state`
  mismatch or late callback is rejected and reported.

- **AUTH-14 — Auth header is host-scoped** `P1` `[SEC-T10/F4]`
  The `Authorization` header is attached **only** when the resolved request host is
  on the hardcoded allowlist (`api.x.com`, `upload.x.com`, plus the explicit dev
  override host from CFG-7). Redirects (301/302/307) are **not followed** for
  token-bearing requests — a redirect is surfaced as an `api` error. Proxy env vars
  are ignored for token-bearing calls unless explicitly opted in.

- **AUTH-15 — `auth_status` in app-only mode** `P1` `[ARCH-F14]`
  App-only context has no authenticated user: `auth_status` returns
  `{context: "app-only", user: null, scopes: [...], policy: <matrix>}` — defined
  degraded shape, no 403, no invented fields.

- **AUTH-16 — Headless / no-browser authorize** `P2` `[new]`
  On SSH sessions and containers there is no local browser and the loopback
  redirect never reaches the server's listener. `authorize --manual` prints the
  authorization URL and accepts the full redirect URL pasted back; `state` is still
  validated and the code is consumed exactly once. The default browser flow detects
  launch failure and falls back to manual instructions instead of hanging.

## 3. OA1 — OAuth 1.0a signing *(dropped — decision NO-GO)*

> **Resolved 2026-07-31 (T-307):** OAuth 1.0a is **dropped** — see
> [docs/decisions/0001-oauth1-go-no-go.md](decisions/0001-oauth1-go-no-go.md).
> The signer is never built; OA1-1…4 below are retained for the record and apply
> only if the decision's revisit triggers fire. The `oauth1` auth mode and the
> credential quadruple still accepted by `core/config.ts` are removed with T-309.

- **OA1-1 — RFC 5849 reference vector** `P3` `[QA-11]`
  The HMAC-SHA1 signer reproduces the RFC 5849 §3.4.1.1 reference signature and the
  X-documented example byte-for-byte. Property-based tests (fast-check) over
  parameter sets assert canonical ordering and encoding stability.

- **OA1-2 — Percent-encoding is RFC 3986, not `encodeURIComponent`** `P3` `[QA-12]`
  Space → `%20` (never `+`); `!'()*` are encoded. Signature base string sorting is
  byte-wise after encoding, including duplicate keys.

- **OA1-3 — Body parameters in the signature** `P3` `[QA-14]`
  Form-encoded bodies participate in the signature base string; JSON bodies do not.
  v2 endpoints use JSON — a test locks the JSON-body rule so a copied form-encoding
  path can't corrupt signatures.

- **OA1-4 — OAuth1 scope blindness is warned** `P3` `[SEC-T17]`
  `auth_status` under OAuth1 states plainly that scopes are not enforced by the
  platform and the policy matrix is the only limiter.

## 4. RATE — Rate limits & caps

- **RATE-1 — Per-context tracking** `P1` `[QA-15]`
  Limits are tracked per (endpoint-class × auth context): app-only and user-context
  buckets for the same endpoint are independent. Verified with fixture headers.

- **RATE-2 — Preemptive refusal** `P1` `[QA-16]`
  When the tracked window shows `remaining === 0` and reset is in the future, the
  call is refused locally with a typed `rate-limit` error carrying the reset as ISO
  8601 **and** `retry_after_seconds` — no HTTP request is made.

- **RATE-3 — Past-reset proceeds** `P1` `[QA-17, ARCH-F15]`
  If the recorded reset time has passed, the request proceeds (window presumed
  renewed). Reset comparisons use a 5 s skew allowance (`reset − 5 s`) and prefer
  observed headers over wall-clock arithmetic.

- **RATE-4 — Missing rate-limit headers** `P1` `[QA-21]`
  A response without `x-rate-limit-*` headers leaves the tracked state unchanged —
  no crash, no reset to zero, no assumption of exhaustion.

- **RATE-5 — 429 handling: GETs retry once within 5 s, writes never** `P1` `[QA-18/19]`
  On 429: idempotent GETs may retry exactly once if the reset is ≤ 5 s away
  (injected Sleep); everything else surfaces the typed `rate-limit` error
  immediately. Writes never auto-retry on any status.

- **RATE-6 — Dual windows: 15-min user vs 24-h app caps** `P1` `[X-F10]`
  `POST /2/tweets` has both 100/15-min (user) and 10,000/24-h (app) limits with
  separate headers (`x-app-limit-24hour-*`). Both are tracked; refusal happens on
  whichever is exhausted, and the error names **which** window blocked the call.

- **RATE-7 — `retry-after` vs `x-rate-limit-reset` disagreement** `P1` `[new]`
  When both are present and disagree, the **later** time wins (conservative).

## 5. COST — Pay-per-use credits & session budget

*(Pricing model per [X-platform review FINDING-1](reviews/02-x-platform-review.md):
credits, not tiers, for post-2026-02-06 developers.)*

- **COST-1 — Session credit budget is operator-set and model-immutable** `P1`
  `[ARCH-F3, DX-F4, X-F4]`
  `X_MCP_CREDIT_BUDGET` (USD per session) with `X_MCP_BUDGET_MODE=warn|hard`.
  There is **no** per-call override parameter in any tool schema. In `warn` mode
  results past 100 % carry `budget_warning`; in `hard` mode reads and writes fail
  with the typed `budget` error stating "operator-set limit; cannot be changed from
  within this session".

- **COST-2 — Unseeded budget state** `P1` `[QA-F2]`
  The budget never calls a usage API to seed. It starts at zero spend
  (state `unseeded` removed — session-scoped counting needs no seed) and counts
  the static per-endpoint cost table locally. Restart resets it; the docs state
  this is per-process, advisory accounting `[OPS-F10]`.

- **COST-3 — Per-call cost surfaces in results** `P1` `[X-F4]`
  Every result includes the estimated credit cost of the call (`cost_usd`) and the
  session running total, computed from the static cost table (e.g. $0.005/post
  read, $0.010/user read, $0.015/post create).

- **COST-4 — URL-bearing post costs $0.20 — warn before spend** `P2` `[X-F4]`
  `post_create` detects URLs in `text`; when present, the result (and, in `hard`
  mode near the cap, the pre-flight refusal) states the $0.20 URL-post price
  distinctly from the $0.015 base price. Detection errs toward warning (any
  `http(s)://` or bare domain the platform would auto-link).

- **COST-5 — Boundary: warning at 90 %, error at 100 %** `P1` `[QA-48]`
  Tested exactly at the boundaries; the check-and-increment is atomic (CONC-2), so
  two interleaved calls at remaining ≈ 1 credit cannot both pass in `hard` mode.

- **COST-6 — Platform credit exhaustion (real 402/403 shape unknown)** `P1→live`
  `[X-F1]`
  The platform-side "out of credits" error shape is not publicly documented. A
  provisional `billing` error class maps any credits/enrollment-related rejection;
  **capturing the real body is a named Phase 1 live-test task**, after which the
  fixture and mapping are locked.

- **COST-7 — 2M posts/month hard read cap** `P3` `[X-F1]`
  The platform cap is documented in the operator docs and surfaced verbatim when
  hit (as `billing`); the server does not attempt to pre-track it (monthly state
  needs persistence the design deliberately omits).

## 6. POL — Policy matrix

- **POL-1 — Generated full-matrix test** `P1` `[QA-41]`
  Every (tool × preset × override) combination is exercised from the registry as
  data — a tool missing classification fails the suite structurally `[ARCH-F2]`.

- **POL-2 — Deny always beats allow** `P1` `[QA-42]`
  `X_MCP_POLICY_DENY` wins over `X_MCP_POLICY_ALLOW` and over the preset, for every
  cell, including within the same call's resolution.

- **POL-3 — Override precedence for `write:dm` is explicit** `P1` `[QA-F4]`
  Resolution (ratified): `X_MCP_POLICY_ALLOW="write:dm"` **can** enable DM sends on
  any preset — the "never below `full`" prose in docs/03 is reworded to "not in any
  preset below `full`; reachable only by explicit operator override". Deny still
  wins over the override.

- **POL-4 — `read:dm` is not in the default preset** `P1` `[SEC-F2]`
  The `read-only` preset's `read:*` wildcard **excludes** `dm`. DM reads require an
  explicit opt-in cell (`X_MCP_POLICY_ALLOW="read:dm"`) in any preset.

- **POL-5 — Destructive classifications are consistent** `P1` `[SEC-F5/F9, DX-F8]`
  `block_create` (or merged `block_set`) is `destructive:social-graph`;
  `list_delete` is `destructive:content`. A registry test asserts the catalog
  matches the taxonomy definitions so this cannot drift.

- **POL-6 — Invalid policy cells refuse startup** `P1` `[QA-44]`
  An unknown cell in preset name, `ALLOW`, or `DENY` (e.g. `write:dms`,
  `read-olny`) is a startup error listing the valid cells — never silently ignored.

- **POL-7 — Denied tools stay registered, annotated, and terminal** `P1`
  `[QA-46, DX-F6, SEC-F10]`
  Denied tools are registered with "(disabled by policy `<preset>`)" appended to
  the description. Their `policy` error carries `retryable: false, fix: "operator"`
  and — for `dm`, `destructive:*`, and `social-graph` cells — names the blocked
  cell **without** the unlock env var (no escalation recipe). Low-sensitivity cells
  may include the unlock hint. `X_MCP_HIDE_DENIED=1` removes denied tools from
  registration entirely.

## 7. PAGE — Pagination

- **PAGE-1 — Tokens are opaque and round-trip verbatim** `P1` `[QA-36]`
  `next_token` from a result is passed back as `page_token` unmodified; every list
  tool's `page_token` description states the bridge explicitly `[DX-F10]`.

- **PAGE-2 — Invalid or expired token** `P1` `[QA-37]`
  The API's rejection of a bad/expired pagination token maps to a typed
  `validation` error: "pagination token invalid or expired — restart from the first
  page". Never `api`.

- **PAGE-3 — `max_results` clamping honors per-endpoint floors** `P1` `[X-F5]`
  Bounds differ per endpoint (search 10–100/10–500, timelines 5–100,
  followers 1–1000, most engagement lists 1–100, quote_posts 10–100). Values are
  clamped into range **in both directions** — search `max_results: 5` becomes 10
  (the platform minimum) — and the result notes the effective value when it
  differs from the request.

- **PAGE-4 — Last page omits `next_token`** `P1` `[QA-39]`
  When the API returns no `next_token`, the rendered result omits it (never
  `null`), and includes `result_count` so the model can reason about paging cost
  `[DX-F10]`.

- **PAGE-5 — Exactly one HTTP request per list call** `P1` `[QA-40, QA-F12]`
  A mocked-dispatcher invariant test asserts no list tool ever issues more than one
  page request per call, regardless of parameters. Auto-pagination is a design
  refusal, enforced by test.

## 8. POST — Post creation & writes

- **POST-1 — Text passes through byte-identical** `P2` `[QA-22]`
  Unicode (NFC/NFD, ZWJ emoji, RTL) is sent exactly as provided — no normalization,
  no trimming beyond a whitespace-only rejection (`validation`). What the user
  wrote is what posts.

- **POST-2 — Weighted length is not reimplemented** `P2` `[QA-F6]`
  The server does not embed twitter-text. It performs a cheap advisory estimate
  (URLs count 23) and maps the API's authoritative 400 "too long" to `validation`
  with "text weighs ~N/280 — URLs count as 23 characters" `[DX-F12]`.

- **POST-3 — Duplicate content 403 is meaningful** `P2` `[ARCH-F6]`
  Maps to `forbidden` with "X rejected this as a duplicate of a recent identical
  post". Combined with POST-4 this is the ambiguity-resolution signal.

- **POST-4 — Timed-out `post_create` may have landed** `P2` `[ARCH-F6, QA-25]`
  The timeout error states: the post may exist; the safe probe is re-issuing the
  **identical** text — success means the original never landed, duplicate-403 means
  it did. Recovery guidance does not depend on paid timeline reads.

- **POST-5 — `post_delete` on an already-deleted post is success** `P2` `[ARCH-F6]`
  404 from DELETE is rendered as success with `already_deleted: true`. Deletion is
  idempotent from the agent's perspective.

- **POST-6 — Composite constraints are pre-validated** `P2` `[DX-F12, QA-26]`
  Poll × media mutually exclusive; ≤ 4 images or 1 video/GIF; poll
  `duration_minutes` ∈ [5, 10080]; `reply_settings` a closed enum. Violations are
  typed `validation` errors naming the conflict and the fix, before any HTTP call.

- **POST-7 — Reply/quote of a deleted or protected post** `P2` `[new]`
  The API's 400/403 maps to `not-found` ("target post deleted or protected — verify
  the id/URL") or `forbidden` respectively, never generic `api`.

- **POST-8 — Batch lookup edge sizes** `P1` `[QA-27]`
  101 ids → `validation` before HTTP (limit 100). 1 id → still the batch endpoint,
  one request. Duplicate ids are de-duplicated before sending.

- **POST-9 — Thread partial failure guidance** `P2` `[DX walkthrough A]`
  A failed `post_create` with `reply_to_id` adds: "posts already created in this
  sequence remain live; resume by replying to the last successful id".

## 9. MEDIA — Media upload *(Phase 3)*

- **MEDIA-1 — v2 dedicated paths only** `P3` `[X-F6]`
  `POST /2/media/upload/initialize` → `…/{id}/append` (segments < 5 MB) →
  `…/{id}/finalize`; `GET /2/media/upload` for STATUS. v1.1 paths (retired
  2025-06-09) never appear. `media_category` is a closed enum.

- **MEDIA-2 — Chunk boundary sizes** `P3` `[QA-29/30]`
  A file exactly at a chunk multiple produces no empty trailing APPEND. A zero-byte
  file is `validation` before INIT. Files over the per-type size cap are refused
  locally with the cap stated.

- **MEDIA-3 — Upload and processing are separate tool calls** `P3` `[ARCH-F7]`
  `media_upload` returns after FINALIZE with `{media_id, processing_state}`;
  `media_status` polls STATUS (fast calls the agent loops on). Video processing
  never blocks a single tool call past client timeouts. `alt_text` is an optional
  `media_upload` param (no separate metadata tool) `[DX table]`.

- **MEDIA-4 — Failed processing state** `P3` `[QA-32]`
  STATUS `failed` renders a typed `api` error carrying the platform's failure
  reason; the `media_id` is reported as unusable.

- **MEDIA-5 — Path escapes are impossible** `P3` `[SEC-F6, QA-33]`
  `X_MCP_MEDIA_DIR` is **required** for `media_upload` (default-deny). The path is
  resolved with `realpath` after symlink resolution, must land inside the media
  dir, the final component is opened `O_NOFOLLOW`, and magic-byte sniffing and
  upload read the **same file descriptor** (no TOCTOU swap). `../` traversal and
  symlinks out of the dir are `validation` errors.

- **MEDIA-6 — Magic-byte vs extension mismatch** `P3` `[QA-34]`
  A `.png` that is not a PNG is refused locally (`validation`, naming both the
  claimed and sniffed types). The sniffed type wins for `media_category` selection.

- **MEDIA-7 — Cancellation mid-APPEND** `P3` `[ARCH-F7]`
  MCP cancellation aborts the in-flight APPEND via `AbortSignal`; no FINALIZE is
  sent; the error notes the partial upload will expire server-side.

## 10. DM — Direct messages *(Phase 3, redesigned)*

- **DM-1 — No conversations-list pretense** `P3` `[X-F2]`
  v2 has no list-conversations endpoint. The package exposes exactly the three
  DM-event lookups (all events / by conversation / with participant). No tool named
  or described as "list conversations" exists.

- **DM-2 — 30-day retention is surfaced** `P3` `[X-F2]`
  Every DM read result carries `note: "X returns at most the last 30 days of DM
  events"` so the model never presents the window as complete history.

- **DM-3 — DM renders are minimized** `P3` `[SEC-F7/T14]`
  The compact DM shape returns ids, timestamps, and participants; message **bodies**
  require an explicit `include_text: true` param. Bodies and sender display names
  get the strongest untrusted-content treatment (REND-6).

- **DM-4 — `dm_send` failure modes** `P3` `[new]`
  Sending to a user who doesn't follow / has DMs closed → `forbidden` with the
  platform reason; the 1,440/24-h cap is tracked as a RATE-6-style window.

## 11. REND — Rendering & partial results

- **REND-1 — Zero results render explicitly** `P1` `[DX-F3]`
  v2 omits `data` entirely on empty result sets. The render is
  `{result_count: 0, note: "no matching results"}` — never an empty object, never
  an error.

- **REND-2 — Partial failures surface as `missing[]`** `P1` `[ARCH-F5]`
  200-with-`errors[]` responses (deleted/suspended/protected items in batch or
  single lookups) render successful items plus
  `missing: [{id, reason: "deleted" | "suspended" | "protected" | …}]`. An agent
  asking for 100 posts and receiving 87 always sees why.

- **REND-3 — Long posts are never silently truncated** `P1` `[ARCH-F11, DX-F3]`
  `post-compact` includes `note_tweet`; render prefers `note_tweet.text` over
  `text`. When full text is unrecoverable, `truncated: true` is set. Reposts join
  the referenced tweet's full text where available.

- **REND-4 — Every rendered post has a canonical `url`** `P1` `[DX-F3]`
  `https://x.com/i/status/<id>` (handle-free canonical), reads and writes alike, so
  models cite instead of fabricating URLs.

- **REND-5 — Degraded `includes`** `P1` `[QA-52]`
  Missing expansions (author object absent for a returned post) degrade per-field
  (`author: {id}` only) — never a crash, never dropping the whole item.

- **REND-6 — Untrusted-content handling applies to all third-party text** `P1`
  `[SEC-F8]`
  The untrusted-content `note` marks every result carrying third-party text —
  including bios, display names, handles, and DM bodies, not just list/search.
  Zero-width (U+200B–200D, U+FEFF) and bidi-override (U+202A–202E, U+2066–2069)
  code points are stripped from **inbound** third-party text (never from the
  user's own outbound text — POST-1); individual free-text fields are length-capped
  with an explicit truncation marker. The note is per-result, not per-item.

- **REND-7 — Third-party text never appears in error messages** `P1` `[QA-54]`
  A secret-and-content sentinel test sweeps every error path: no post text, DM
  text, bio, or token material in any thrown error or log line `[QA-F11]`.

- **REND-8 — Identifier resolution on input** `P1` `[DX-F2]`
  Every user param accepts numeric id, `handle`, or `@handle` (resolved via
  `users/by/username`, cached per process); every post param accepts a bare id or a
  full `x.com`/`twitter.com` status URL. Self-scoped tools default `user` to
  `"me"`. Resolution failures are `not-found`, naming the input form tried.

- **REND-9 — Timestamps are ISO 8601 UTC everywhere** `P1` `[DX-F3/F9]`
  Renders never emit epoch or locale forms. Inbound `end_time` values are clamped
  server-side to ≥ 10 s in the past (v2 quirk) instead of surfacing a 400.

- **REND-10 — `raw: true` is capped** `P1` `[DX-F11]`
  With `raw: true`, `max_results` is capped at 25. The raw payload is the exact API
  JSON including `includes`/`meta`.
  The cap is applied silently: there is **no log layer** in the shipped server (§6 of
  docs/04), so "a warning is logged" — the original wording — described a sink that does
  not exist, and a per-result note would have had to ride on `data`, breaking the
  byte-for-byte guarantee this rule exists to give (T-320 F10). What a `raw` read *does*
  always carry is the REND-6 untrusted-content warning, on `summary` (see `rawSummary`).

- **REND-11 — Structured content parity** `P3` `[new]`
  When tool `outputSchema`/`structuredContent` (MCP spec 2025-06) is adopted
  (roadmap WP-3.8), the structured payload and the text content are generated from
  the **same** render object and can never diverge; output schemas join the public
  API under the semver rules.

## 12. NET — Network & parser failures

- **NET-1 — Non-JSON error bodies** `P1` `[QA-F10]`
  HTML from an intermediary (Cloudflare 502), truncated JSON, or an empty body maps
  to typed `api`/`network` errors with the status code — never a JSON.parse crash,
  and never raw HTML in the error message.

- **NET-2 — Connection failures are distinguished** `P1` `[QA-F10]`
  `ECONNRESET` mid-body, connect timeout, and read timeout all map to `network`
  with distinct `detail` values; for write calls the POST-4 ambiguity text is
  attached.

- **NET-3 — GET retry policy is bounded** `P1` `[QA-19]`
  Idempotent GETs retry exactly once on 5xx/network failure; writes never retry.
  The mocked dispatcher asserts total request counts.

- **NET-4 — 5xx on writes** `P2` `[new]`
  A 5xx on a write surfaces immediately with the ambiguity note (the request may
  have been applied before the error) — same contract as POST-4.

## 13. CONC — In-process concurrency

- **CONC-1 — Refresh single-flight** `P2` `[QA-F13]`
  See AUTH-2/3/4. Test: N concurrent 401-triggering calls → one token-endpoint
  request, all N succeed with the new token.

- **CONC-2 — Budget check-and-increment is atomic** `P1` `[QA-51]`
  Two interleaved calls at remaining ≈ 1 credit: in `hard` mode exactly one
  proceeds. The counter is a synchronous check-and-reserve, not check-then-spend.

- **CONC-3 — Rate-limit table updates don't interleave destructively** `P1` `[new]`
  Concurrent responses for the same endpoint-class update the tracked window
  last-reset-wins by reset timestamp (never older data overwriting newer).

- **CONC-4 — Two processes sharing a token file** `P2` `[SEC-F1]`
  The two-manager interleaving test (shared tmp file, interleaved refreshes)
  asserts no lockout and no double refresh of the same token.

## 14. MCP — Protocol & process lifecycle

- **MCP-1 — stdout carries only JSON-RPC** `P1` `[QA-58/59]`
  A spawn smoke test through the CJS bin at the most verbose log level asserts every
  stdout byte parses as JSON-RPC frames. All logging is stderr.

- **MCP-2 — InMemoryTransport integration layer** `P1` `[QA-F1]`
  `tools/list` and representative `tools/call` round-trips run against the real
  server object over InMemoryTransport — schemas, annotations, and instructions are
  asserted at the protocol level, not the unit level.

- **MCP-3 — stdin EOF means exit** `P1` `[new]`
  When the client dies and stdin closes, the server exits promptly and cleanly (no
  orphan processes accumulating per Claude Desktop restart). SIGINT/SIGTERM also
  exit cleanly; an EPIPE writing to a dead client does not produce a crash loop.

- **MCP-4 — Tool annotations match classification** `P1` `[ARCH-F2, DX-R3]`
  `read:*` → `readOnlyHint: true`; `destructive:*` → `destructiveHint: true`;
  idempotent merged `*_set` tools → `idempotentHint: true`; all →
  `openWorldHint: true`. Generated from the registry, asserted by test.

- **MCP-5 — Server `instructions` carry the conventions** `P1` `[DX-R2]`
  The initialize response's `instructions` string states: accepted identifier
  forms, the `page_token`↔`next_token` bridge, `raw` semantics/cost, the policy
  model in one sentence, and "call `auth_status` first in write sessions".

- **MCP-6 — Ancient-Node launcher guard** `P1` `[OPS-F1]`
  The CJS bin on Node < 20 prints a human-readable version message (no
  SyntaxError); the `launcher-node12` CI probe asserts it.

- **MCP-7 — Cancellation aborts in-flight HTTP everywhere** `P3` `[ARCH-F7 generalized]`
  MCP cancellation propagates an `AbortSignal` to the in-flight HTTP request on
  **every** tool, not just media: the request is torn down, no retry fires, and for
  writes the POST-4 ambiguity note applies (the platform may already have applied
  the write). Retagged P2 → P3 on 2026-07-31 (exit-gate-2 audit, T-214): the
  roadmap builds generalized cancellation in WP-3.8/T-311 — the original tag
  predated that scheduling.

- **MCP-8 — Parallel tool calls from one client** `P1` `[new]`
  MCP clients may issue concurrent `tools/call` requests. All shared state (budget
  counter, rate-limit table, identifier-resolution cache, token manager) is safe
  under interleaving (CONC-1…4); no per-request global mutable context exists. An
  InMemoryTransport test drives overlapping calls.

## 15. PLAT — Cross-platform

- **PLAT-1 — Windows rename semantics** `P2` `[OPS-F5, QA checklist]`
  Atomic tmp+rename works when no reader holds the file open; rename-over-open-file
  failures on win32 are retried briefly, then surfaced as `auth` (persist failed —
  rotated token in memory is still used, and the error instructs checking the
  path). The rotation/locking suite **runs on the Windows CI leg**, not skipped.

- **PLAT-2 — POSIX-only checks degrade explicitly on win32** `P2` `[OPS-F5]`
  `0600` checks and `O_NOFOLLOW` behaviors have explicit win32 branches (skip with
  a one-time warning / nearest equivalent), each with its own test.

- **PLAT-3 — Path handling** `P1` `[OPS-F5]`
  Backslash paths, drive letters, and `%APPDATA%` defaults work; no hardcoded `/`
  joins. CFG-1/CFG-2 tests run on the Windows leg.

- **PLAT-4 — System sleep/resume** `P2` `[new]`
  After a laptop resume, elapsed-time assumptions break: eager-refresh scheduling
  and rate-limit windows are recomputed from the injected Clock **on next use** —
  no long-lived timers that fire late and act on stale state. The reactive 401 path
  and response headers remain authoritative after wake.

## 16. DRIFT — API drift & platform volatility

- **DRIFT-1 — Unknown response fields are ignored** `P1` `[new]`
  New fields appearing in v2 payloads never break parsing (forward-compatible
  parsers; no closed-object validation on responses).

- **DRIFT-2 — Unknown error codes degrade to `api` with platform detail** `P1`
  `[ARCH-F5]`
  The platform `title`/`detail` pass through (minus third-party text — REND-7);
  the `forbidden` class carries platform-refusal semantics distinct from
  unexpected `api`.

- **DRIFT-3 — Deprecated operators are pre-flagged** `P1` `[X fact-check]`
  `min_likes`/`min_replies`/`min_reposts` (removed 2026-01-19) are rejected by
  query pre-validation with "operator removed by X" — not sent to burn a paid read.

- **DRIFT-4 — Fixtures carry provenance and are re-fact-checked** `P1` `[QA-F5]`
  Every fixture records source + capture date; a scheduled monthly refresh runs
  the comparison, and each phase boundary re-runs the platform fact-check
  (`https://docs.x.com/x-api/llms.txt`) per the roadmap's standing task `[X-rec 8]`.
