# Design reviews — index & synthesis

Six independent senior role reviews of the x-mcp design corpus, run 2026-07-21
(Phase 0 of [../06-roadmap.md](../06-roadmap.md)). Each reviewer read the full corpus;
the X-platform reviewer additionally fact-checked claims against live X developer
documentation.

## Verdicts

| # | Review | Role | Verdict | Highlights |
|---|---|---|---|---|
| 01 | [Architecture](01-architecture-review.md) | Senior software architect | approve-with-changes | 1 BLOCKER (refresh concurrency), 6 MAJOR; wants tool-registry choke point, session budget |
| 02 | [X platform](02-x-platform-review.md) | Senior X API integration engineer | **needs-rework** | 33 claims fact-checked: 20 confirmed, 8 corrected; tier model obsolete (BLOCKER) |
| 03 | [Security](03-security-review.md) | Senior application security engineer | approve-with-changes | 8 new threats (T10–T17), 4 kill-chain walkthroughs, 5 MAJOR fixes |
| 04 | [QA](04-qa-review.md) | Senior QA/test engineer | approve-with-changes | 16 findings, 60-item edge-case checklist, 8 testability changes to the architecture |
| 05 | [DevOps](05-devops-review.md) | Senior DevOps/release engineer | approve-with-changes | npm name `x-mcp-ai` verified available; release/versioning policy proposed |
| 06 | [Agent-DX](06-agent-dx-review.md) | Senior AI/agent-DX engineer | approve-with-changes | Catalog is ~60 tools not ~45; merge/cut plan to ~28 typical; id/@handle resolution missing |

## Blocking findings (must fold into the corpus before Phase 1)

1. **Pricing/tier model is obsolete** *(02, BLOCKER)*. X retired Free/Basic/Pro for
   new developers on 2026-02-06 in favor of pay-per-use credits ($0.005/read,
   $0.015/post create, $0.20/post containing a URL, 2M reads/mo cap); legacy tiers
   survive only for grandfathered subscribers. Invalidates: the Tier column in the
   tool catalog, 403-based tier inference, the `TierGated` error design, and the
   read-only framing of the budget model. Rewrite docs/01 §3 around pay-per-use with
   a legacy-tier appendix.
2. **OAuth2 refresh concurrency** *(01, BLOCKER; confirmed independently by 03 F1)*.
   The lockfile-only design still allows double-refresh (in-process concurrent 401s;
   cross-process stale in-memory tokens) → burned rotation → account lockout.
   Required: in-process single-flight + reload-under-lock before refresh +
   reload-on-401; "break stale lock" needs a safe protocol.

## Consensus findings (independently raised by ≥ 2 reviewers)

- **`ignore_budget: true` must not be a tool parameter** — it hands the human's
  budget override to the model (01 F3, 06 F4). Move to env:
  `X_MCP_READ_BUDGET_MODE=warn|hard`.
- **Budget seeding via `usage_get` cannot work on the cheapest plans** (01 F4, 04 F2)
  — and after finding 02.1 the budget should count **credits/dollars across reads and
  writes**, not post-reads. Redefine as a session-scoped spend budget in `core`,
  no API seeding, shipped in Phase 1.
- **The catalog is ~60 tools, not ~45** (01, 06). Adopt the Agent-DX merge/cut plan
  (action-enum pairs, unified user/post lookup, Pro-only packages out of default
  registration) → ~46 full / ~28 typical.
- **Policy classification is internally inconsistent** (03 F5, 04 F4/F6): `block_create`
  must be `destructive:*` per §3's own definition; the "dm_send never below `full`"
  claim contradicts the allow-override mechanism — specify override precedence
  explicitly.
- **`dm_conversations_list` is not implementable as designed** (02 M2; 04 flagged DM
  fixtures as unverifiable) — v2 has no list-conversations endpoint and DM events
  retain only 30 days. Redesign the dm package around the three DM-event lookups.
- **Windows is a real target** (04, 05): token-file semantics (rename atomicity,
  0600 no-op, `~` non-expansion, default paths) and a CI Windows leg are required,
  not nice-to-haves.
- **`authorize` must ship in the npm artifact as a CLI subcommand** (05 F4; 03 F3
  adds the security requirements: CSRF `state`, loopback bind, listener lifetime).

## The one genuine disagreement — denied-tool visibility (roadmap open question #2)

- **Architecture (01)**: hide denied tools at registration — policy is immutable per
  process, and ~28 dead write schemas per read-only session is real context waste.
- **Security (03)**: keep registered-but-erroring, but **stop naming the unlock env
  var** in policy errors for dm/destructive/social-graph (escalation recipe).
- **Agent-DX (06)**: keep registered-but-erroring, annotate descriptions with
  "(disabled by policy)", offer opt-in `X_MCP_HIDE_DENIED`.

**Proposed resolution** (to ratify): register denied tools with a one-line
"(disabled by policy)" description annotation and *no* unlock-variable hint in
errors for sensitive domains; provide `X_MCP_HIDE_DENIED=1` for context-frugal
deployments. This satisfies 03 and 06 fully and gives 01's concern an operator
switch; combined with the 06 merge/cut plan the context cost drops enough that
hiding-by-default is no longer load-bearing.

## Other high-value adoptions

- Tool-registry choke point (`ToolDef` as data + registry wrapper) so policy checks
  are structurally unavoidable; emit MCP `readOnlyHint`/`destructiveHint`
  annotations from the existing classification (01 F2 + 06 R3).
- Clock/Sleep/Random/TokenStore injection seams in Phase 1 — every high-risk
  behavior is time-based (04 F3).
- MCP-protocol test layer: InMemoryTransport integration + spawn smoke through the
  CJS launcher proving stdout wire-cleanliness (04 F1).
- id/@handle/URL resolution on every user/post parameter; `url` + `truncated` +
  `note_tweet` handling in the compact render (06 F2/F3).
- `X_MCP_MEDIA_DIR` default-deny, realpath + `O_NOFOLLOW` + same-fd sniff (03 F6);
  base-URL/Bearer host-scoping (03 F4).
- Release pipeline ported from servicenow-mcp-ai (tag-gated publish, `--provenance`,
  MCP registry chain) + semver policy where the public API = tool names + schemas +
  error codes + env vars (05 F2/F3). Reserve the `x-mcp-ai` npm name now (05).
- New platform capabilities worth a roadmap look (02): News search, Community Notes
  API, bookmark folders, post/media analytics, X Activity webhooks, official
  TypeScript XDK, new media upload paths (`/2/media/upload/initialize|append|finalize`).

## Phase 0 exit status

Corpus **not yet ratified**: the two blockers plus the consensus corrections must be
folded back into docs/01–06 first. The reviews themselves are the input for that
revision pass; each file carries its full findings list with severities and concrete
recommendations.
