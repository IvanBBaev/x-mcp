# 14 — Live testing

The operator manual for `test/live/**` — the one test layer that spends real credit against a
real X account and can post publicly. Everything here describes the harness as it stands in
the tree; the binding spend policy is [05-testing-and-quality.md](05-testing-and-quality.md)
§6 and this page does not relax it. The suite exists to serve two human checkpoints in
[08-implementation-roadmap.md](08-implementation-roadmap.md): **H2 — T-132** (the COST-6
capture plus the read-fixture spot-check, §5 and §6 below) and **H3 — T-214** (authorize →
post → delete, §4 below). Neither can be closed by CI, which is why they are checkpoints and
why this document is written for a person at a terminal rather than for a pipeline.

Nothing in this suite runs unless you deliberately turn it on. The default `npm test` run
registers every live test as a visible **skip** and sends not one byte to the X API.

## 1. The account, and what the suite does to it

**Use a dedicated throwaway X account. Never a personal one.** The write tier creates a real,
public post on whatever account the stored token belongs to, and the capture tier is only
meaningful on an account whose pay-per-use credit has been deliberately exhausted — neither is
something to do to an account you care about.

docs/05 §6 states that as prose. `test/live/harness/account.ts` turns it into a check: the
operator **declares** the handle in `X_MCP_LIVE_ACCOUNT`, the run **asks** the X API who the
stored credentials belong to (`x_user_get {users:['me']}`, through the shipped pipeline), and
the write tier refuses unless the two match. Comparison is case-insensitive and
`@`-insensitive; nothing else is normalized. Every ambiguous case — no declared handle, no
reported handle, a blank handle, a mismatch — refuses. There is no "assume it is fine" branch.

The suite is split into three tiers, ordered by blast radius (`LiveTier` in
`test/live/harness/gate.ts`):

| Tier | File | What it does | Extra opt-in |
|---|---|---|---|
| `read` | `test/live/reads.live.test.ts` | Up to four cheap GETs, compared against recorded fixture shapes. Costs credit, changes nothing. | — |
| `write` | `test/live/write-e2e.live.test.ts` | Creates and deletes one real **public** post. | `X_MCP_LIVE_ACCOUNT` + user-context auth + a policy granting `write:content` and `destructive:content` |
| `capture` | `test/live/billing-capture.live.test.ts` | Provokes a billing rejection and records its raw body (COST-6). | `X_MCP_LIVE_CAPTURE=1` |

`test/live/preflight.live.test.ts` sits in front of all three (§3). The `test/live/*.test.ts`
files without `.live.` in the name — one per harness module, `gate.test.ts` among them — are
**not** live tests at all: they drive the harness from injected env snapshots and in-memory
doubles and run in the normal suite, in CI, on every commit (§7).

Every live call is priced before it is issued. A live test opens a `LiveSession`
(`test/live/harness/session.ts`) and reaches the X API one of two ways, both metered by the
same spend guard (§2): `session.call()` / `session.raw()` go through the composed MCP server
and authorize the call internally, and the drift and capture probes — which need **raw**
response envelopes rather than tool output, so they build a production HTTP client of their
own — call `session.guard.authorize(...)` on the line above each request. Same config, same
auth, same error mapper the server would use; only the caller differs.

## 2. Spend rules and the caps the harness enforces

[05-testing-and-quality.md](05-testing-and-quality.md) §6 is the authority — read it. This
section describes only how `test/live/harness/spend.ts` enforces it, and the one number an
operator has to keep an eye on.

Two independent rails, both `core/budget` in `hard` mode, both checked **before** the request
is issued, so a refusal costs nothing because nothing was sent:

| Rail | Denominated in | Limit | Source |
|---|---|---|---|
| Unit rail | API requests ("read units") | `LIVE_READ_UNIT_CAP` = **20** | docs/05 §6, hard-coded in `spend.ts` |
| Money rail | USD | `LIVE_USD_CAP` = 20 × the priciest read unit in `COST_TABLE` = **$0.20** today | derived at runtime from `src/core/budget.ts` |

Deriving the money cap rather than hard-coding `$0.20` keeps it correct if a class is
repriced. The rails coincide for pure reads by construction and diverge for writes, which is
the point: a `w:post` costs more than any read unit, and a post whose text contains a URL is
repriced from $0.015 to $0.20 (docs/07 COST-4) — one such call would consume the whole run
budget, and the money rail refuses it. If the money rail refuses after the unit rail has
already charged, the unit charge stands: the guard fails closed and it never becomes cheaper
to keep going after it said no.

A **third** rail is the server's own. `liveConfigEnv` (`harness/session.ts`) forces
`X_MCP_BUDGET_MODE=hard` and `X_MCP_CREDIT_BUDGET=<LIVE_USD_CAP>` into the config a live run
composes, regardless of what the operator exports. A generous personal `X_MCP_CREDIT_BUDGET`
therefore cannot raise the live ceiling; the preflight asserts this (§3).

**The archive deny list is structural.** `x_search_archive` and `x_post_counts_archive` are
refused by name — before argument validation, before policy, before the budget — and
`assertDenyListIntact` checks at session-open time that those names still exist in the
composed registry, so renaming a tool cannot silently un-ban the expensive reads.

### The number to watch: the cap is per file, not per run

`node --test` runs each test **file** in its own process, so the 20-unit cap is a per-file
allowance. Each live file today is far inside it — and a new live file gets its own fresh 20.
`test/live/harness/spend.ts` carries the same warning for maintainers.

What the current files spend on a clean run, priced from `COST_TABLE` (the harness's own
accounting, not an invoice from X):

| File | Calls | Units | Estimated |
|---|---|---|---|
| `reads.live.test.ts` | `r:user`, `r:post`, `r:post`, `owned` (+ the closing `x_usage_get`) | ≤ 5 | ≈ $0.022 |
| `write-e2e.live.test.ts` | `r:user`, `w:post`, `r:post`, `w:action` ×2 (+ the closing `x_usage_get`) | 6 | ≈ $0.031 |
| `billing-capture.live.test.ts` | one `owned` probe (+ the closing `x_usage_get`) | 2 | ≈ $0.002, and $0 when the account is already out of credit |

Two more §6 rules the harness implements rather than documents:

- **Every write is paired with its cleanup in a `finally`.** `withCleanup`
  (`test/live/harness/cleanup.ts`) runs deferred cleanups in LIFO order on every exit path,
  logs each failure loudly, keeps going after one fails, and re-throws them as an
  `AggregateError` — with the body's own error as the first member when both failed. A live
  post left standing must never coexist with a green run.
- **Every run ends by printing the session budget summary**, plus `x_usage_get`.
  `printSummary` prints the guard's per-call ledger and the server budget's own total; a
  failing `x_usage_get` is printed, never swallowed, and never fails the run.

## 3. The environment: what each tier needs, and the preflight

### 3.1 The three harness variables

These belong to the test harness, not to the server, and are stripped from the snapshot before
`parseConfig` sees them — otherwise CFG-8's unknown-`X_MCP_*` typo detection would warn on
every live run.

| Variable | Value | Unlocks |
|---|---|---|
| `X_MCP_LIVE_TEST` | exactly `1` | The master switch. Every tier. |
| `X_MCP_LIVE_ACCOUNT` | the handle the run may touch (`@` optional, case-insensitive) | The `write` tier. |
| `X_MCP_LIVE_CAPTURE` | exactly `1` | The `capture` tier. |

`X_MCP_LIVE_TEST` and `X_MCP_LIVE_CAPTURE` must be **exactly** the string `1`. Unset, empty,
`0`, `true`, `yes`, `on`, `TRUE`, `2`, ` 1`, `1 ` — anything else leaves the switch shut. A
blank or `@`-only `X_MCP_LIVE_ACCOUNT` counts as unset.

### 3.2 The server variables the gate checks

The gate reads a plain env snapshot and never touches the network. Its single piece of I/O is
an `existsSync` on the resolved OAuth2 token path, because "did you actually run `authorize`?"
is the most common reason a live run would otherwise die on its first request.

| Variable | Why the live suite cares |
|---|---|
| `X_MCP_AUTH_MODE` | `oauth2` is required for the write tier — app-only cannot post. `app-only` is fine for reads. |
| `X_MCP_BEARER_TOKEN` | Required when `X_MCP_AUTH_MODE=app-only`; its absence is a preflight problem. |
| `X_MCP_CLIENT_ID` | Required in oauth2 mode — without it a mid-run token refresh fails with an auth error. |
| `X_MCP_TOKEN_FILE` | The gate probes that the file **exists**, i.e. that `authorize` actually wrote it. Defaults per platform (docs/10 §3). |
| `X_MCP_TOKEN_KEYCHAIN` | `1` selects the keychain backend, which gets **no** probe on purpose — reading it means spawning `security`/`secret-tool`, which the gate refuses to do. A missing keychain entry surfaces as an auth error on the first call instead. |
| `X_MCP_POLICY`, `X_MCP_POLICY_ALLOW`, `X_MCP_POLICY_DENY` | The write tier needs both `write:content` and `destructive:content` granted. `X_MCP_POLICY=manage` grants both; `publish` grants only the first and is refused. An explicit `X_MCP_POLICY_ALLOW=write:content,destructive:content` also satisfies it, and `X_MCP_POLICY_DENY` still wins over everything (POL-2). |
| `X_MCP_BUDGET_MODE`, `X_MCP_CREDIT_BUDGET` | **Overridden.** A live run forces `hard` and `$0.20` (§2); whatever you export for these is ignored by the live suite. |

Any other `X_MCP_*` variable is parsed and validated exactly as it is for a normal server run;
an invalid one is reported as a preflight problem rather than thrown at import time.

### 3.3 Precedence — the order the gate decides in

`gateFor` checks in blast-radius order, and the first failure is the one you are told about:

1. **Master switch.** `X_MCP_LIVE_TEST !== '1'` → every tier is skipped with
   *"live tests are off — set X_MCP_LIVE_TEST=1 to run them (they spend real credit against a
   real X account; see docs/14-live-testing.md)"*.
2. **Credentials.** Any preflight problem → every tier is skipped with *"live preflight failed
   (…) — see the 'live preflight' test"*, and the preflight test itself **fails** with the full
   list (§3.5).
3. **The tier's own opt-in.** For `write`: the declared account, then user-context auth, then
   the policy cells, in that order. For `capture`: `X_MCP_LIVE_CAPTURE=1`.

A tier opt-in never overrides the master switch — `X_MCP_LIVE_CAPTURE=1` with
`X_MCP_LIVE_TEST=0` opens nothing, and says so by naming `X_MCP_LIVE_TEST=1`.

### 3.4 Running a tier

Run from the repository root: the fixture loader and the capture writer both anchor on
`process.cwd()`. `npm run test:live` builds and then runs `build/test/live/*.live.test.js` —
the four live files and nothing else. The script does **not** set `X_MCP_LIVE_TEST`; that
stays with you, so an absent-minded `npm run test:live` prints four skips and spends nothing.

Reads only (app-only is enough):

```bash
X_MCP_LIVE_TEST=1 \
X_MCP_AUTH_MODE=app-only \
X_MCP_BEARER_TOKEN=… \
npm run test:live
```

Reads plus the write end-to-end, on the dedicated account:

```bash
X_MCP_LIVE_TEST=1 \
X_MCP_LIVE_ACCOUNT=@my-testbed \
X_MCP_AUTH_MODE=oauth2 \
X_MCP_CLIENT_ID=… \
X_MCP_POLICY=manage \
npm run test:live
```

The COST-6 capture adds `X_MCP_LIVE_CAPTURE=1` (§6). To run a single tier, bypass the script
and name the file — `npm run build && X_MCP_LIVE_TEST=1 … node --test
build/test/live/write-e2e.live.test.js`; each file carries its own 20-unit allowance either
way (§2). The script's glob deliberately excludes the harness's own offline tests
(`build/test/live/*.test.js` without `.live`), which are ordinary CI tests.

Authorize with the same env you will run with — a live run that points at a different
`X_MCP_TOKEN_FILE` will not find the tokens you just minted (docs/10 §3).

### 3.5 Reading the output

- **A skip is the correct result when you asked for nothing.** Live tests are registered as
  node:test skips carrying the gate's reason — visible in the report, never silently absent.
  `npm test` and `npm run check` therefore stay green and quiet on a machine with no
  credentials, and the skip line names the variable to set.
- **A skip is also the correct result for a tier you did not unlock.** Asking for reads leaves
  the write and capture tests skipped, each naming its own missing opt-in.
- **`X_MCP_LIVE_TEST=1` with a broken environment is loud, not quiet.** The preflight test is
  the one place where wanting a live run and not being able to have one **fails**: a single
  failure listing every problem, ending *"Nothing was sent to the X API. See
  docs/14-live-testing.md §3 for the exact variables each tier needs."* Skipping there would
  report green while having tested nothing live.
- **A correct run prints its accounting.** Every file ends with the budget summary — read
  units used against the cap, spend against the cap, and the per-call ledger — followed by
  `x_usage_get`. The read tier additionally prints a shape diff per fixture (§5), and the
  write tier prints the authorized handle, the created post's URL, and its removal.

Beyond the credential list, the preflight also asserts what §2 promises: that the composed
server's budget is in `hard` mode at `LIVE_USD_CAP`, that the read-unit cap really is 20, that
the archive deny list still names tools the registry exposes, and that the declared handle is
normalized. Those four run on every live invocation and make no network call.

## 4. The write end-to-end (T-214, docs/08 H3)

`test/live/write-e2e.live.test.ts` is the only file in the repository that creates public
content. Four things must all be true before a byte leaves the process — the master switch, a
declared account that matches the token's real owner, user-context auth with a usable token
store, and a policy granting `write:content` **and** `destructive:content`. The last one is
not paranoia about permissions: a create the suite cannot delete is exactly the outcome the
cleanup contract exists to prevent, so the tier refuses to start rather than risk leaving a
public post behind.

### The authorize leg is verified, not performed

Step 1 of the round trip is **manual by design**. OAuth 2.0 authorization-code + PKCE requires
a human to approve the app in a browser; automating a consent screen means automating
credential entry, which this repository will not do. Run it yourself first:

```bash
X_MCP_AUTH_MODE=oauth2 X_MCP_CLIENT_ID=… node build/src/index.js authorize
```

What the test then asserts is that a token the human already minted is present, usable, and
belongs to the declared account:

- `session.reportedHandle()` calls `x_user_get {users:['me']}` **through the production
  pipeline**, so a missing, expired or unrefreshable token surfaces here as the shipped `auth`
  error — before anything is created;
- `assertDedicatedAccount` compares that reported handle with `X_MCP_LIVE_ACCOUNT` (§1) and
  throws on any mismatch or ambiguity.

That pairing *is* the authorize leg: the consent screen is the human's, the proof that it
produced working credentials for the right account is the test's. The gate's token-file probe
(§3.2) is the same claim made one step earlier and without any I/O against X.

### Steps 2–4, automated and paired

1. **Post.** The text is `x-mcp live e2e <uuid> — automated test post, deleted immediately.`
   The nonce makes the post findable in the timeline if cleanup ever fails and a human has to
   go looking. There is deliberately **no URL** in it: a URL would reprice the post from $0.015
   to $0.20 (docs/07 COST-4) and blow through the money rail. The test asserts the result
   carries no COST-4 note, which is how it checks that.
2. **Defer the delete immediately.** `scope.defer(...)` is called on the line after the create
   returns, before any assertion can fail in between, so from that line on every exit path
   deletes.
3. **Read it back.** `x_post_get` by id proves the post really existed and that X stored the
   text byte-identical — without it, a broken create plus a tolerant delete would look like a
   passing round trip.
4. **Prove the delete landed.** The deferred delete's own result is consumed inside
   `withCleanup`, so the proof is a **repeat** delete: POST-5 renders an already-deleted post
   as success with `already_deleted: true`. `w:action` is a $0 cost class, so this costs one
   read unit and no money.

If a cleanup fails, the message names the artifact —
*"LIVE CLEANUP FAILED — delete post 1900…: … The artifact may still exist on the live account;
delete it by hand."* — and the run fails. Delete it by hand, then re-run.

### What this does and does not close

Passing this test is not by itself H3. [08-implementation-roadmap.md](08-implementation-roadmap.md)
H3 is *"the round-trip succeeds from a client, not from a test harness"*: complete the browser
consent, then drive create → read → delete from a real MCP client with `X_MCP_POLICY=manage`,
and confirm no draft or media artefact is left behind. This test proves the shipped pipeline
does the round trip (over the real SDK `Client` and the real composition, via
`InMemoryTransport`) and that the guardrails around it hold; the client leg stays human work.
Per-client verification steps live in [13-compatibility.md](13-compatibility.md) §7.

## 5. The read spot-checks (T-132, DRIFT-1)

`test/live/reads.live.test.ts` answers the one question no offline test can: **do the recorded
fixtures still match reality?** It calls the same production endpoint wrappers each fixture was
captured through and compares response **shapes** — the set of `path → JSON type` pairs, with
array indices collapsed to `[]` — against four fixtures the offline suite leans on hardest:

| Probe | Endpoint | Fixture | Notes |
|---|---|---|---|
| P1 | `GET /2/users/by` | `users/by-username.json` | Probes the public `@X` account — rich profile, so the informational half of the diff stays short. Not the test account, which has almost no profile fields set. |
| P2 | `GET /2/tweets/search/recent` | `search/recent-page.json` | Query `from:X -is:retweet`, `max_results: 10`. |
| P3 | `GET /2/tweets?ids=…` | `posts/two-posts.json` | Ids come from P2, so no hard-coded post id can rot. Skipped, with a printed line, when P2 returns nothing. |
| P4 | `GET /2/users/me` | `users/me.json` | User context only — app-only has no "me" and X answers 401 there by design. Skipped, with a printed line, in app-only mode. |

Failure policy is deliberately asymmetric (`test/live/harness/drift.ts`):

- **Breaking** — a path present in both with a *different* type (a `like_count` that turns from
  number to string is exactly the change that silently corrupts a renderer), or a path the
  probe declares required that the live response does not carry. These fail the test.
- **Informational** — a field the fixture has and live does not, or vice versa. Optional fields
  legitimately come and go per record and X adds fields additively, so these are printed as a
  readable diff for a human to read. A check that cried wolf on those would be switched off
  within a month.

The fixture's own `_provenance` key (and anything else prefixed `_`) is stripped before
shaping, so documentation never registers as drift.

This is the second half of docs/08 **H2**, whose exit condition includes *"the spot-checked
read fixtures still match live response shapes"*. A run that prints only informational diffs
satisfies it; record what you saw. Note that `scripts/refresh-fixtures.mjs` and the monthly
refresh workflow described in [05-testing-and-quality.md](05-testing-and-quality.md) §5 are not
in the tree — this file is currently the only live drift check that exists.

## 6. The COST-6 capture and fixture promotion

COST-6 is the one corner case Phase 1 could not close offline: **nobody in this project has
seen the real body X returns when a pay-per-use account runs out of credit.**
`test/fixtures/errors/403-billing-access-level.json` stands in for it and says `PROVISIONAL` in
its own `_provenance` because it is an informed guess modelled on the legacy access-level 403.
Until it is captured once, the billing-error path is tested against that guess — which is
exactly what docs/08 **H2** exists to fix.

### Before you run it

This tier needs an account whose pay-per-use credit is **already exhausted**. The test cannot
create that state and does not try; that is why the capture carries a third opt-in on top of
the master switch. Exhausting the credit is a manual step on a throwaway account — the
mechanics live in X's developer/billing console, not in this repository, so this page cannot
give you the click path.

```bash
X_MCP_LIVE_TEST=1 \
X_MCP_LIVE_CAPTURE=1 \
X_MCP_AUTH_MODE=oauth2 \
X_MCP_CLIENT_ID=… \
node --test "build/test/live/billing-capture.live.test.js"
```

### What it does

One cheap read — `GET /2/users/me`, cost class `owned` — issued through a stand-alone
production HTTP client (`createLiveInvoker`) whose error mapper is the shipped `mapHttpError`
wrapped in `recordingErrorMapper`. The decision *"is this billing?"* is therefore the real,
shipped classification; the recorder only observes it. It runs on its own thin path rather than
through the composed server because `mcp/compose` exposes no `mapError` seam — the consequence
is that the capture path does not exercise the rate-limit tracker or the tool pipeline, which
is fine, because the artifact it produces is a raw HTTP response. The probe is still authorized
through the spend guard like any other live call.

Three outcomes, all useful, none silent:

| Outcome | Result | Meaning |
|---|---|---|
| classified `billing` | **PASS** — artifact written, promotion block printed | The capture worked. |
| the request **succeeded** | **PASS** — with a message | The account still has credit; nothing to capture. Exhaust it first and re-run. Failing here would punish someone for having a working account. |
| any other rejection (`auth`, `rate-limit`, network, …) | **FAIL**, loudly | A capture run must never end "green, captured nothing". Usually an expired token or a missing scope. An `auth` rejection says nothing about what an out-of-credit account returns. |

### What gets written

`test/fixtures/errors/billing-out-of-credits.captured.json`, relative to the directory you ran
from. The `.captured` marker means "not promoted yet". The file is a normal fixture shape —
`_provenance`, `status`, `headers`, `body` — where:

- status, headers and body are **verbatim** as they arrived (the body already through
  `api/http`'s tolerant parse: parsed JSON, or the raw string when it was not JSON);
- header **names** matching `/authorization|cookie|token|secret|api[-_]?key|bearer/i` have
  their values replaced with `[redacted]` before anything is written, because the artifact is
  meant to be committed;
- header values that are not strings or numbers are dropped rather than stringified, so no
  `[object Object]` can end up looking like a recorded value.

**The provisional fixture is not touched.** The capture lands *beside* it and promotion is
manual on purpose.

### Promotion, and the supersession rule

The `_provenance` string on the captured file is written as a numbered checklist so promotion
needs no doc lookup; the same steps, for reference:

1. Read the body and confirm it is the out-of-credits rejection and carries no account
   identifiers.
2. Rename the file to `<status>-billing-out-of-credits.json`.
3. Replace the whole `_provenance` string with the settled form the checklist quotes — real
   capture date, no `CAPTURED LIVE — NOT PROMOTED YET` marker.
4. Add a case to `test/api/errors.test.ts` asserting it maps to kind `billing`.
5. **Either** drop the `PROVISIONAL` marker from `403-billing-access-level.json`'s
   `_provenance`, **or** delete that fixture if the captured one supersedes it.

Step 5 is the supersession rule, and it is a judgment call the repository does not encode:
nothing in the code defines a test for "supersedes". Two fixtures are worth keeping only if
they exercise genuinely different rejections — the captured out-of-credits body and the
access-level 403 that `403-billing-access-level.json` was modelled on are the same `billing`
class but not necessarily the same platform condition. Decide once, record the reasoning in the
promotion commit, and do not leave two fixtures both claiming to be the credit-exhaustion case.

Nothing asserts the existence of the `.captured.json` file, and no test promotes it. Until
someone walks the checklist, a capture is a recording, not a fixture. docs/08 H2 is done when
*"the fixture's `_provenance` header records a real capture date instead of `PROVISIONAL`"* —
that is step 3 plus step 5, not step 1.

## 7. Never in CI, and why

No workflow in `.github/workflows/` sets `X_MCP_LIVE_TEST`, and none should.
[05-testing-and-quality.md](05-testing-and-quality.md) §7 states it as policy: **no live tests
in CI.** The reasons are the tiers themselves — real money on every run, a real public post on
the write tier, and an account credential that would have to live in repository secrets to make
any of it possible.

That is also why the gate is built the way it is. A CI run does not "skip the live tests"
because someone remembered to exclude them from a glob: the live files are inside the default
`node --test "build/test/**/*.test.js"` pattern and are registered as skips by the gate itself.
Excluding them from the glob would be a convention; the gate is a mechanism.

What CI *can* protect is the harness itself, and it does: every module under
`test/live/harness/` has an ungated companion in `test/live/*.test.ts` that runs in the normal
suite with no network and no dependence on the machine's filesystem. `gate.test.ts` drives every
branch of the gate — the exact-`1` rule, the credential preflight, the write tier's three
refusals, the capture opt-in, handle normalization, and the CFG-8 stripping — from injected env
snapshots. `spend.test.ts` drives both rails, the deny list, the ledger, and the derivation of
the money cap from `COST_TABLE`, on in-memory guards. `session.test.ts` opens a real
`LiveSession` over an undici `MockAgent` and proves the guard is consulted before any request
leaves, that the server's own budget is an independent second rail, and that the COST-6
recorder sees a billing rejection. `capture.test.ts` covers header redaction, the recorder, the
provenance text, and the fixture write into a temp directory. `drift.test.ts` and
`cleanup.test.ts` are pure. A live suite nobody can run today is still worth having if its
guardrails are provably correct.

## 8. What this page cannot tell you

Everything above is derived from the code in this repository. These are the points where the
repository does not answer the question, listed so nobody mistakes silence for a procedure:

- **How to exhaust pay-per-use credit** on the test account (§6). It is a manual step in X's
  developer/billing console; nothing in the repository describes it.
- **The real status code and body of the out-of-credits rejection.** That is the whole point of
  COST-6. The provisional fixture guesses `403`; the capture's own file name is templated on
  whatever status actually arrives.
- **When a captured fixture supersedes the provisional one** (§6 step 5). The rule is stated in
  the code; the criterion is not.
- **Whether `x_usage_get` will answer on your account.** The endpoint authenticates on an
  approved developer account; the end-of-run summary prints a failure rather than failing the
  run, so a `x_usage_get FAILED:` line in the summary is not by itself a broken live run.
- **What X will actually bill you.** The figures in §2 are the harness's own accounting from
  `COST_TABLE`, not an invoice. The canonical prices are
  [01-api-landscape.md](01-api-landscape.md) §3.1 and Appendix B.
