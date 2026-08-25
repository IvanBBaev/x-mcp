# 0001 — OAuth 1.0a support: go/no-go

## Status

**Decided — NO-GO (drop).** Date 2026-07-31, task T-307 (Wave 3, WP-3.6). Default
disposition per roadmap open question Q3 ([08](../08-implementation-roadmap.md), "Resolved
open questions" item 3): _drop unless a blocked use-case materializes_. No blocked
use-case has materialized; the default stands.

## Context

**What OAuth 1.0a would buy.** Support for developer accounts that hold only a legacy
1.0a app+user key quadruple (api key/secret + access token/secret) — no scopes, no
expiry, HMAC-SHA1 request signing ([01](../01-api-landscape.md) §2.2). It is a
_convenience for legacy credentials_, not an access unlock: v2 endpoints still _accept_
OAuth 1.0a (platform review F33, CONFIRMED), but none of them _requires_ it.

**Which endpoints need it.** None in the shipped or planned surface. The historical
holdout was v1.1 media upload; that endpoint was retired 2025-06-09 and media moved to
dedicated v2 paths (`POST /2/media/upload/initialize` → `append` → `finalize`, STATUS,
`POST /2/media/metadata`, plus the one-shot small-file path) which work under OAuth 2.0
user context with the `media.write` scope ([01](../01-api-landscape.md) §1 table, §2.1
scope list, §5 media bullet). DMs, writes, timelines, lists, graph — everything in the
[03](../03-tool-catalog.md) catalog — are v2 and OAuth 2.0-reachable; no tool is marked
OAuth 1.0a-only.

**What the shipped OAuth 2.0 surface covers.** `src/api/oauth2/` (machine.ts,
filestore.ts, index.ts) implements the full PKCE user-context lifecycle: single-flight
refresh with rotation-safe persist-before-use, cross-process lock + adopt-on-disk-pair,
401 → refresh → retry-once, and a Bearer `AuthorizationProvider` for every user-context
request. App-only bearer covers the read-only research surface. Between them, every
cataloged auth class (`app-only`, `app+user`, `user-only`) is served.

**Security weight against 1.0a.** A leaked 1.0a token is full-account, unscoped, and
never expires; scopes are not platform-enforced under 1.0a, so the local policy model
would be the only limiter ([04](../04-security.md) T17, OA1-4). The security review
explicitly deprioritized OAuth 1.0a partly on this basis.

## Decision

**NO-GO.** WP-3.6 is closed without building the OAuth 1.0a signer. The OA1-1…4 build
tasks are not spawned. x-mcp v1 supports exactly two auth modes: OAuth 2.0 PKCE user
context (primary) and app-only bearer.

## Consequences

Dropped or deferred:

- `api/oauth1.ts` (HMAC-SHA1 signer) is never built; no property tests for the
  signature base string ([05](../05-testing-and-quality.md) §1 rows).
- Corner cases OA1-1…4 ([07](../07-corner-cases.md) §3) become not-applicable.
- `X_MCP_AUTH_MODE=oauth1` and the `X_MCP_API_KEY`/`X_MCP_API_SECRET`/
  `X_MCP_ACCESS_TOKEN`/`X_MCP_ACCESS_SECRET` quadruple ([02](../02-architecture.md) §4)
  are removed from the planned config surface.
- Operators holding only 1.0a credentials must create an OAuth 2.0 app in the developer
  portal (free) and run the `authorize` subcommand — documented in the README
  troubleshooting section (WP-3.10).

Revisit triggers (any one reopens Q3 as a new decision record):

- Live testing (Phase 1/2/3 live suites or the exit-gate fact-checks) shows an endpoint
  in the shipped 1.0 surface rejecting OAuth 2.0 user context while accepting 1.0a.
- The platform withdraws OAuth 2.0 support for a surface the catalog needs (e.g. a media
  or DM regression to 1.0a-only).
- Sustained user demand from 1.0a-only credential holders after 1.0.0, weighed against
  the T17 security posture.

## References

- [08-implementation-roadmap.md](../08-implementation-roadmap.md) — WP-3.6 row; resolved
  open question Q3.
- [09-parallel-execution-plan.md](../09-parallel-execution-plan.md) — task row T-307.
- [01-api-landscape.md](../01-api-landscape.md) — §1 (v1.1 media retirement), §2.1–§2.3
  (auth contexts, `media.write` scope), §5 (v2 media endpoints).
- [04-security.md](../04-security.md) — T16/T17; [07-corner-cases.md](../07-corner-cases.md) §3 (OA1-1…4).
- [reviews/01-architecture-review.md](../reviews/01-architecture-review.md) — Q3 note;
  [reviews/02-x-platform-review.md](../reviews/02-x-platform-review.md) — F33.
- `src/api/oauth2/` — shipped OAuth 2.0 machine (machine.ts, filestore.ts, index.ts).
