# 0002 — The 11 catalogued-but-unregistered tools: ship, drop, or split

## Status

**Decided 2026-08-09 — Option 2.** Raised 2026-08-08 during the 1.0 acceptance sweep; the
owner ratified the recommendation as written: **ship `x_bookmarks_list` and
`x_post_hide_reply`, cut the other nine from the v1 catalogue.** §Context, §Options and
§Recommendation below are the point-in-time record and are deliberately left unedited — the
numbers in them (39 tools, 74,446 B) are what was true when the question was asked. §Decision
and §Consequences carry the outcome.

## Decision

The surface is **41 tools in 12 packages**, and the catalogue now describes exactly that:
catalogue rows and registered tools are the same set, which the docs-drift gate asserts on
every run (D4 — `Every catalogued tool is registered.`). What shipped:

| Tool | Cell | Why it shipped |
|---|---|---|
| `x_bookmarks_list` | `read:content` | Completes the pair against the already-shipped `x_bookmark_set`. A server that can bookmark but cannot list bookmarks reads as a bug, not as scope. |
| `x_post_hide_reply` | `write:moderation` | Completes moderation: the server could delete its own post but not hide a reply to it. Opens the `write:moderation` cell, which had no tool at all. |

The nine cuts, grouped by the reason they were cut, each recorded in
[03-tool-catalog.md](../03-tool-catalog.md) under "Deliberate omissions":

- **Answerable by a shipped tool** — `x_liking_users_list`, `x_reposted_by_list`,
  `x_quote_posts_list`, `x_liked_posts_list`: audience reads that `x_search_recent` already
  covers via `conversation_id:` / `quotes_of:` operators, at one call instead of N.
- **Unnecessary given how the writes work** — `x_blocks_list`, `x_mutes_list`: the
  corresponding writes are absolute (`x_block_set`, `x_mute_set` set a state rather than
  toggling one), so an agent never needs to read the list to write correctly.
- **Out of shape for this server** — `x_space_get`, `x_spaces_search` (Spaces is live audio
  this server cannot render or transcribe), `x_trends_by_location` (needs a WOEID table the
  agent does not have and this server will not embed).

**Cost of the decision, measured.** `tools/list` moved 74,422 → **78,445 B** against the
unchanged 80,000 B cap — 1,555 B of headroom, ~1.9%, now less than one mean tool (~1.9 kB).
Verified byte-identical against a live MCP Inspector 2.1.0 probe on 2026-08-09
([13](../13-compatibility.md) §4.5.1), so this is what a client actually pays, not an
estimate. **The surface is full**: anything further needs description trimming or an argued
cap raise, and `scripts/context-gate.mjs` now says so in its own header comment.

**Reversibility.** Cutting a row is cheap to undo — the nine names stay reserved and the
endpoints are documented in [01-api-landscape.md](../01-api-landscape.md); any of them can
return in Phase 4 with a use case and a budget line. What is *not* reversible is shipping a
tool and then removing it: that breaks agents in the field and costs a major version. The
asymmetry is the whole argument for cutting rather than raising the cap.

## Context

**The gap.** [03-tool-catalog.md](../03-tool-catalog.md) catalogues 50 tools; 39 are
registered. The eleven that are not — the list is machine-generated inside the
`GENERATED:TOOLS` region, so it cannot silently drift — are:

| Tool | Cell | Shape | Nearest shipped analogue (measured) |
|---|---|---|---|
| `x_bookmarks_list` | `read:content` | paginated read | `x_lists_owned` 1876 B |
| `x_liked_posts_list` | `read:content` | paginated read | `x_followers_list` 2184 B |
| `x_liking_users_list` | `read:content` | paginated read | `x_followers_list` 2184 B |
| `x_reposted_by_list` | `read:content` | paginated read | `x_followers_list` 2184 B |
| `x_quote_posts_list` | `read:content` | paginated read | `x_search_recent` 2935 B |
| `x_blocks_list` | `read:social-graph` | paginated read | `x_following_list` 2187 B |
| `x_mutes_list` | `read:social-graph` | paginated read | `x_following_list` 2187 B |
| `x_spaces_search` | `read:content` | paginated read | `x_user_search` 2114 B |
| `x_space_get` | `read:content` | id lookup | `x_list_get` 1506 B |
| `x_trends_by_location` | `read:content` | id lookup + WOEID table | `x_list_get` 1506 B + table |
| `x_post_hide_reply` | `write:moderation` | boolean write | `x_like_set` 1347 B |

**They are Phase 3, not Phase 4.** Six of them (`x_post_hide_reply` plus the five
engagement reads) were explicitly retagged P2 → P3 by the exit-gate-2 audit (T-214,
2026-07-31). Phase 4 in [08](../08-implementation-roadmap.md) is a different, named list —
Activity API webhooks, News, Community Notes, bookmark folders, analytics, Streamable HTTP,
MCP prompts, `.mcpb` — and none of these eleven appears on it. So the roadmap currently
implies they ship before 1.0, and Exit gate 3 is written as "full surface".

**WP-3.5's go/no-go was never resolved.** That row promises "the spaces/trends registration
go/no-go" as a deliverable. WP-3.6 discharged its equivalent obligation with a dated NO-GO
and this decision folder; WP-3.5 has no counterpart record. `x_space_get`, `x_spaces_search`
and `x_trends_by_location` are unregistered by default rather than by decision.

**The constraint that forces the question.** The context gate measures the real serialized
`tools/list` payload — verified byte-identical against a live MCP Inspector probe
([13](../13-compatibility.md) §4.5.1) — and today reads **74,446 B of an 80,000 B budget:
5,554 B of headroom.** Costing the eleven against their nearest shipped analogues gives
roughly **20,000–21,000 B**, which would land the payload near **95,000 B — about 19% over
budget**. This is not a rounding problem that tighter descriptions can absorb: the headroom
fits **two or three** of these tools, not eleven.

That budget is not arbitrary. It is the standing context cost every client pays on every
session before the model has read a single post, and the gate exists (WP-3.9, DX-F1)
precisely so the number cannot creep silently. Shipping all eleven means consciously
raising it, which is a decision about other people's context windows.

## Options

1. **Drop all eleven from the v1 catalogue**, with a dated note, and move any that attract
   real demand to Phase 4. Keeps the budget, shrinks the advertised surface, and makes the
   catalogue honest — the catalogue would then describe what exists.
2. **Ship a subset that fits the headroom** (two or three; the strongest candidates are
   `x_bookmarks_list`, which completes the bookmark pair against the shipped
   `x_bookmark_set`, and `x_post_hide_reply`, which completes moderation), drop the rest.
3. **Raise the context budget** to ~100 kB and ship all eleven. Explicit, defensible, but it
   spends roughly a quarter more of every client's standing context and weakens the gate's
   purpose.
4. **Ship all eleven behind an opt-in registration flag**, defaulting to off, so the default
   payload stays under budget. Costs a new configuration axis and a second gate
   configuration to measure — and an off-by-default tool is close to a dropped one in
   practice.

## Recommendation

**Option 2, then 1 for the remainder.** The two completions remove genuine asymmetries in
the shipped surface — a server that can bookmark but not list bookmarks, and one that can
delete its own post but not hide a reply to it, both read as bugs rather than as scope. The
other nine are all "list the things behind an engagement count", which is the part of the
surface an agent is least likely to need and the platform prices per read. Dropping them is
cheaper to reverse than raising the budget is.

This is a product-scope call, not an engineering one, so it is recorded here rather than
resolved unilaterally.

## Consequences — all discharged 2026-08-09

- [x] [03](../03-tool-catalog.md): nine rows removed (the `spaces` and `trends` package
      sections went with them, 12 → 10 catalogue sections), the two new rows added, and a
      "Deliberate omissions" entry records every cut with its rationale. The generated
      "catalogued but not registered" line now reads *Every catalogued tool is registered.*
- [x] [08](../08-implementation-roadmap.md): WP-3.5's spaces/trends go/no-go closed as
      **NO-GO**; Exit gate 3's "full surface" is defined as 41 tools in 12 packages and
      delegated to the drift gate; the acceptance checklist's docs-drift, context-size and
      compatibility-matrix entries re-verified at the new surface.
- [x] `CHANGELOG.md`: the **Notes** "50 tools across 12 packages … not all shipped yet"
      line restated; both new tools listed under **Added**.
- [x] `npm run gate:context` baseline moved 74,422 → 78,445 B, and the header comment now
      states that the surface is full and why (this record).
- [x] [13](../13-compatibility.md): re-probed at the 41-tool surface — 41 tools, 41 with
      `outputSchema`, 41 with `annotations`, 20 disabled under `read-only`, 78,445 B.
