# Context-budget headroom analysis (2026-11-19)

- **Reviewer role**: Senior AI/agent-DX engineer (same role as
  [06-agent-dx-review.md](06-agent-dx-review.md)).
- **Date**: 2026-11-19.
- **Purpose**: work out where the `tools/list` bytes go and what each way of freeing
  headroom would cost. The 80,000 B cap in [`scripts/context-gate.mjs`](../../scripts/context-gate.mjs)
  has ~2.1 kB left. That is not enough for any of the Phase 4 candidates in
  [../08-implementation-roadmap.md](../08-implementation-roadmap.md): Bookmark Folders
  including its new `POST` write (review 12 OD-4), News, or Articles. Re-scoping the cap is
  an open owner decision. This report is the input for that decision. **Analysis only**: no
  `src/`, `test/` or baseline change.
- **Baseline**: `main` at `3de33ff`, gate baseline **77,885 B** (`BASELINE_BYTES`), 42 tools in
  12 packages, `@modelcontextprotocol/sdk` 1.32.1 (lockfile).
- **Scope**:
  - the composed server's `tools/list` result under every policy preset and with
    `X_MCP_HIDE_DENIED`;
  - bytes per tool, per field and per package, and the repeated schema fragments;
  - five ways to free headroom, (a)–(e), plus a schema-hygiene option found during
    measurement;
  - byte estimates for the three Phase 4 candidates.
- **Method**:
  - The measurement reuses the gate's logic: build, compose the real server, connect a client
    over `InMemoryTransport`, call `tools/list`, and count UTF-8 bytes of
    `JSON.stringify(result)`. The gate's `BASE_ENV` was used: app-only auth, all
    availability classes.
  - The throwaway measuring and option-modelling scripts ran in the session scratchpad,
    not the repo. Each option was modelled by transforming the captured read-only
    `tools/list` JSON and re-measuring it, so every "measured" delta below is a real byte
    count, not arithmetic on averages.
  - Client behaviour was fact-checked against primary documentation fetched 2026-11-19
    (§5). Fetched content was treated as data, not instructions.
- **Verdict**:
  - The cap measures **wire bytes**. Almost half of them (**47.5 %**, 36,976 B) are
    `outputSchema`. In clients built on Anthropic-style tool definitions, which have no
    output-schema field, the model most likely never sees these bytes. The model-visible
    part (name, description, inputSchema) is **35,282 B**.
  - **Hygiene set A** (drop `inputSchema.$schema` plus two annotation fields that only
    restate the spec defaults) frees **3,642 B** with near-zero risk.
  - **Dropping the `meta` property from every outputSchema** frees another **8,106 B**. The
    `meta` block is identical in all 42 tools and `structuredContent` still carries it.
  - Together the two give **13,569 B** of headroom. That covers all three Phase 4
    candidates without touching descriptions or the cap. Recommendation in §4, owner
    questions in §6.

## 1. Where the bytes go

### 1.1 Per policy configuration

| Configuration | `tools/list` bytes | Tools listed | Headroom to 80,000 B |
|---|---:|---:|---:|
| `read-only` (default, **gate worst case**) | **77,885** | 42 | 2,115 |
| `engage` | 77,672 | 42 | 2,328 |
| `publish` | 77,471 | 42 | 2,529 |
| `manage` | 77,402 | 42 | 2,598 |
| `full` | 77,304 | 42 | 2,696 |
| `full` + DM allow override | 77,192 | 42 | 2,808 |
| `read-only` + `X_MCP_HIDE_DENIED=1` | 45,376 | 21 | 34,624 |
| `publish` + `X_MCP_HIDE_DENIED=1` | 63,014 | 33 | 16,986 |
| `full` + `X_MCP_HIDE_DENIED=1` | 69,244 | 38 | 10,756 |

- `read-only` is the worst case because 21 denied tools each carry the suffix
  ` (disabled by policy `read-only`)`. Together the suffixes add **693 B**.
- Presets move the total by at most ~700 B. Only hiding denied tools changes it
  materially, and the gate rightly measures the default, which does not hide them.
- **Every new tool costs its full size in the worst case, writes included**: under
  `read-only` a write is listed, with its suffix, not hidden.

### 1.2 Per field (read-only, summed over 42 tools)

| Field | Bytes | Share |
|---|---:|---:|
| `outputSchema` | 36,976 | 47.5 % |
| `inputSchema` | 21,178 | 27.2 % |
| `description` (incl. policy suffixes) | 11,635 | 14.9 % |
| `annotations` (incl. `title`, 1,282 B) | 4,314 | 5.5 % |
| `name` | 621 | 0.8 % |
| JSON keys, separators, envelope (53 B) | 3,161 | 4.1 % |
| **Total** | **77,885** | 100 % |

The `inputSchema` total breaks down as follows:

- parameter description strings: 7,361 B across 141 parameters;
- `"$schema":"http://json-schema.org/draft-07/schema#"`, emitted by the SDK's zod-to-JSON-Schema step in all 42 tools: 2,184 B;
- `additionalProperties:false`: 1,218 B;
- type, enum and bounds structure: the remainder.

Descriptions range from 161 to 467 B, with an average of 277 B. They have already been through the 2026-09-26 trim and the shared parameter wording in `src/tools/params.ts` (`f2f08c6`).

### 1.3 Per package (bytes incl. one separator per tool)

| Package | Tools | Bytes | | Package | Tools | Bytes |
|---|---:|---:|---|---|---:|---:|
| lists | 10 | 15,192 | | search | 2 | 4,757 |
| graph | 6 | 10,134 | | media | 2 | 3,320 |
| posts | 5 | 9,167 | | auth | 2 | 2,745 |
| timelines | 3 | 8,554 | | usage | 1 | 2,319 |
| dm | 4 | 8,080 | | users | 1 | 2,053 |
| engagement | 4 | 6,664 | | archive | 2 | 4,889 |

### 1.4 Ten heaviest tools (bytes: total / description / input / output / annotations)

| # | Tool | Total | Desc | Input | Output | Ann |
|---:|---|---:|---:|---:|---:|---:|
| 1 | `x_timeline_user` | 3,006 | 227 | 980 | 1,613 | 97 |
| 2 | `x_search_archive` | 2,991 | 371 | 817 | 1,613 | 100 |
| 3 | `x_search_recent` | 2,960 | 229 | 933 | 1,613 | 96 |
| 4 | `x_timeline_mentions` | 2,823 | 200 | 818 | 1,613 | 99 |
| 5 | `x_timeline_home` | 2,722 | 254 | 671 | 1,613 | 95 |
| 6 | `x_post_get` | 2,697 | 327 | 391 | 1,809 | 86 |
| 7 | `x_list_timeline` | 2,481 | 174 | 506 | 1,613 | 99 |
| 8 | `x_bookmarks_list` | 2,452 | 286 | 368 | 1,613 | 95 |
| 9 | `x_post_create` | 2,400 | 243 | 1,572 | 409 | 89 |
| 10 | `x_usage_get` | 2,318 | 440 | 351 | 1,350 | 92 |

- **Averages**: 1,853 B for all tools, 2,741 B for post-page reads, 1,354 B for `*_set`
  toggles.
- **Smallest**: `x_list_delete` (1,113 B) and `x_post_delete` (1,164 B).
- Only `x_timeline_user` is over the gate's 3,000 B per-tool warning. **Seven of the top
  eight are post-page reads**, and their weight is the shared 1,613 B post-page
  outputSchema, not their descriptions.

### 1.5 Repeated fragments

These are the largest subtrees repeated verbatim across tools. "Waste" is
(occurrences − 1) × size, counting only maximal repeats, so nested repeats are not
double-counted.

| Fragment | Size (B) | × | Waste (B) |
|---|---:|---:|---:|
| Post-page `outputSchema` (whole, incl. its `$defs`) | 1,613 | 7 | 9,678 |
| `outputSchema.properties.meta` (`cost_usd`, `session_total_usd`, `budget_warning`) | 178 | 42 | 7,298 |
| User-page `outputSchema` | 1,129 | 4 | 3,387 |
| `$defs.compact_post` (outside the whole-schema repeats) | 480 | 8 | 3,360 |
| DM-page `outputSchema` | 979 | 3 | 1,958 |
| `$defs.compact_media` | 170 | 11 | 1,700 |
| `$defs.post_metrics` | 203 | 8 | 1,421 |
| `$defs.compact_user` | 353 | 5 | 1,412 |
| raw `anyOf` branch `{"type":"object","description":"Uncompacted X API envelope (raw: true)."}` | 73 | 18 | 1,241 |
| input `raw` parameter | 92 | 13 | 1,104 |
| input `page_token` parameter | 66 | 17 | 1,056 |
| input `list_id` parameter | 104 | 8 | 728 |
| `$defs.post_ref` | 100 | 8 | 700 |
| **All maximal repeats** | | | **≈ 43,086** |

- The `$defs` blocks take 13,374 B across 18 tools.
- The outputSchema envelope, without `data` and `$defs`, is 11,802 B.
- Repeated parameter-description strings account for 3,494 B. The biggest is the `raw`
  wording, 684 B over 13 tools.

**Most of the payload is repetition, and almost all of that repetition is in
`outputSchema`.** It cannot be shared across tools (§2 (b)).

## 2. Options

Deltas are measured on the read-only worst case (77,885 B). Each row was modelled
independently, and the combined rows were measured as combinations, so they are not sums.

| Option | Resulting bytes | Delta (B) | Tool-selection risk | Effort |
|---|---:|---:|---|---|
| **H1** drop `inputSchema.$schema` | 75,701 | **−2,184** | none | low |
| **H2** drop `openWorldHint: true` (spec default) | 77,003 | −882 | very low | low |
| **H3** drop `destructiveHint` where `readOnlyHint: true` (24 tools) | 77,309 | −576 | low (client-bug exposure) | low |
| **A = H1 + H2 + H3** (hygiene set) | **74,243** | **−3,642** | very low | low |
| drop `annotations.title` | 76,603 | −1,282 | none for the model; UI loses titles | low |
| drop `additionalProperties: false` (input) | 76,667 | −1,218 | low–medium | low |
| (a) drop the `X (Twitter): ` prefix (26 tools) | 77,547 | −338 | medium | low |
| (a) cap descriptions at 250 / 200 / 160 B (upper bounds) | 75,895 / 74,488 / 72,968 | −1,990 / −3,397 / −4,917 | medium → high | medium |
| (a) realistic third trim pass | ≈ 76,200–76,700 | ≈ −1,200 to −1,700 | medium | medium |
| (b) cross-tool shared fragments (`$ref` to shared `$defs`) | n/a | not achievable (see below) | — | — |
| (c1) drop `meta` from every outputSchema | 69,779 | **−8,106** | none (not model-visible) | low |
| (c2) drop `summary` from every outputSchema | 76,709 | −1,176 | none | low |
| (c3) drop the raw-branch description | 76,877 | −1,008 | none | low |
| (c4) shallow outputSchema: `data: {}`, keep `summary` and `meta` | 52,795 | −25,090 | none for the model; loses the typed contract | medium |
| (c5) shallow outputSchema: only `data: {type: object}` | 43,513 | −34,372 | as c4 | medium |
| (c6) drop outputSchema entirely | 40,237 | −37,648 | as c4, and no client-side validation | medium |
| **A + c1** | **66,431** | **−11,454** | very low | low |
| A + `annotations.title` | 72,961 | −4,924 | very low | low |
| A + c4 | 49,153 | −28,732 | see c4 | medium |
| A + c1 + c4 | 41,341 | −36,544 | see c4 | medium |
| A + c6 | 36,595 | −41,290 | see c6 | medium |
| (d) static package selection by env (e.g. `X_MCP_PACKAGES`) | 77,885 (default set) | 0 by default; −2.0 to −15.2 kB per package left out (§1.3) | none for listed tools | medium |
| (d) runtime package enable + `listChanged` | 77,885 unless the default list shrinks | 0 by default | medium–high | high |
| (e) re-scope the cap | 77,885 | 0 (cap moves, bytes do not) | none | low |

### Hygiene set A: H1–H3

**H1, `$schema`.** The SDK's zod conversion stamps
`"$schema":"http://json-schema.org/draft-07/schema#"` into every inputSchema, which costs
52 B × 42 tools. Removing it is safe for these reasons:

- **The spec supplies a default.** MCP 2025-11-25 says inputSchema and outputSchema
  default to JSON Schema 2020-12 when no `$schema` is present. Implementations MUST
  support 2020-12 (§5 S1, S2).
- **Our keywords mean the same in both dialects.** The input schemas use only `type`,
  `properties`, `required`, `additionalProperties`, `description`, `enum`, `items`,
  `minItems`/`maxItems`, `minLength`/`maxLength` and `minimum`/`maximum`. Their semantics
  are identical in draft-07 and 2020-12. There is no `$ref`, `definitions`, tuple `items`,
  `dependencies` or other construct that changed between the two.
- **The outputSchemas carry no `$schema` today**, so dropping it from the inputs makes
  the two consistent.

The fix is a post-processing step next to `stripSafeIntSentinels` in `src/mcp/schema.ts`.

**H2/H3, annotation defaults.** The 2025-11-25 `ToolAnnotations` schema (§5 S3) gives
these defaults:

- `readOnlyHint` false;
- `destructiveHint` true, "meaningful only when `readOnlyHint == false`";
- `idempotentHint` false, with the same qualifier;
- `openWorldHint` true.

Every x-mcp tool is open-world, so `openWorldHint: true` restates the default 42 times.
`destructiveHint: false` on the 24 read-only tools is meaningless by the spec's own
wording.

The risk is client bugs, not the spec:

- A client that reads `destructiveHint` without checking `readOnlyHint` would treat a read
  as destructive (default true) and might add a confirmation prompt. That is a UX cost,
  never a safety loss.
- A client that treats a missing `openWorldHint` as false is wrong against the spec.

H3 is the only part of A with a real (small) exposure. The owner can take H1 + H2 alone
(−3,066 B) and skip H3.

**Not recommended.** These two looked cheap but each carries a cost:

- **Dropping `additionalProperties: false`** (−1,218 B) changes the advertised input
  contract. It is also the shape OpenAI-style strict function calling expects, so keep
  it.
- **Dropping `annotations.title`** (−1,282 B) removes the human display name. Per the
  spec, clients prefer it over `name` for display. That is a UI cost, not a model cost.
  It is optional.

### (a) Description trims

- **Bytes.** The theoretical ceiling is large: capping every description at 160 B frees
  4.9 kB. The realistic gain is small, though. Two passes have already removed the
  redundancy, and the shared parameter wording lives in one place (`params.ts`). A third
  pass would most likely free ~10–15 % of the 11.6 kB, about **1.2–1.7 kB**. The
  `X (Twitter): ` prefix is only 338 B.
- **Risk: medium, and the highest per byte of any option here.** Descriptions are the
  model-visible text. Anthropic's tool-definition guidance calls detailed descriptions
  "by far the most important factor in tool performance" and asks for 3–4 sentences
  (§5 S4). The descriptions in question carry things the model needs:
  - policy and availability notes;
  - id/URL acceptance;
  - the `since_id`/`start_time` exclusivity;
  - the "charge before refuse" guidance.

  The prefix exists for disambiguation when several social servers are connected, and
  the project convention pins it.
- **Effort: medium.** Per-tool editing, re-running the scenario suite and
  `docs:gen`.
- **Verdict.** Do not fund new tools from descriptions.

### (b) Deduplicated or shared schema fragments

- **Cross-tool sharing is not available in MCP.**
  - Each `Tool` carries its own self-contained `inputSchema`/`outputSchema` object.
    `tools/list` has no shared-definitions container (§5 S3).
  - A `$ref` can only point inside the same schema, or to an external URI that the
    client would have to fetch. Implementations cannot be assumed to dereference
    remote references, and fetching them would add a network dependency and an
    injection surface. Neither is acceptable for a local stdio server.
- **Within-tool sharing is already done.** `src/mcp/structured.ts` already factors
  `compact_post`, `post_ref`, `post_metrics`, `compact_media`, `compact_user`,
  `user_metrics`, `compact_dm` and `compact_list` into per-tool `$defs` with `$ref`. The
  remaining repetition (§1.5) is across tools, which is exactly what MCP cannot share.
- **The input schemas have no intra-tool repetition worth a `$ref`.** Introducing `$ref`
  into inputSchema would also add a client-support risk. Some model providers' function-calling schema subsets
  have historically restricted `$ref`/`$defs`. This review did not fact-check any
  provider's current subset, so treat that as an unverified caveat. It is moot for the
  recommendation, which adds no `$ref` to input schemas.
- **Bytes**: ≈ 0. **Verdict**: closed. The repetition is real, but the fix lives in (c).

### (c) outputSchema slimming or dropping

- **Bytes.** `outputSchema` is the single biggest lever: 36,976 B, 47.5 %.
- **Model visibility.** What the model actually sees is client-dependent:
  - The Anthropic Messages API tool definition has `name`, `description`, `input_schema`
    and `input_examples`, but **no output-schema field** (§5 S4).
  - The Claude Code MCP documentation describes how tool definitions and descriptions are
    loaded and cut off, and never mentions outputSchema (§5 S5).
  - The MCP spec frames outputSchema as a contract the **client** uses to validate
    `structuredContent`: servers MUST conform and clients SHOULD validate (§5 S1).

  So in Claude clients the outputSchema most likely costs wire bytes and client
  validation work, not model tokens. That was not verified for every client, and a
  client could fold it into the prompt.
- **c1, `meta` (−8,106 B).**
  - Every tool declares the same `meta` object:
    `{cost_usd, session_total_usd, budget_warning?}`, required.
  - The outputSchema root is open (no `additionalProperties: false`), so
    `structuredContent` that still carries `meta` keeps conforming after the declaration
    is removed. Nothing at runtime changes.
  - What is lost is the typed declaration of `meta` for programmatic consumers. It can be
    documented once (README / docs/03 result-shape section) instead of 42 times.
- **c2/c3** (`summary` −1,176 B; raw-branch description −1,008 B) are the same kind of
  change, but smaller. The raw-branch description is the only place a schema-reading
  client learns what `raw: true` returns, so c3 is a weaker candidate than c1.
- **c4–c6 (−25 to −38 kB)** remove the typed `data` contract:
  - These shapes are public API: they are pinned by
    `test/fixtures/structured/output-schemas.json`, and the semver policy counts
    schemas as API.
  - Clients that validate (or generate types from) outputSchema lose that.
  - It is a large one-way door, taken only to make room the roadmap does not currently
    need.
- **Effort.**
  - c1: low — `META` in `structured.ts`, the fixture, docs/03 wording, the baseline and
    the CHANGELOG.
  - c4–c6: medium, plus a compatibility note in [../13-compatibility.md](../13-compatibility.md).
- **Timing.** All of (c) is cheaper **before** the 1.0 tag (H5). After 1.0, narrowing a
  published schema needs a semver argument.

### (d) Dynamic tool packages and `listChanged`

- **Today.** The server declares `capabilities.tools` without `listChanged`, because
  policy is fixed per process. Two mechanisms are possible.
- **d1, static selection by env** (e.g. `X_MCP_PACKAGES=posts,search,timelines`). This
  is the same mechanism class as `X_MCP_HIDE_DENIED`:
  - It is resolved at startup and needs no client support.
  - The savings are per package (§1.3): `lists` alone is 15.2 kB, `graph` 10.1 kB, `dm`
    8.1 kB.
  - It does not move the gate's worst case unless the **default** set shrinks, which
    would be a product decision about what "full surface" means (decisions/0002).
  - Its best use is a release valve for a 13th or 14th package that ships **off by
    default**. Its cost is then outside the default payload, and the gate could measure
    "default set" and "all packages" separately.
  - Effort: medium (config, registry filter, docs, drift gate).
- **d2, runtime enable plus `notifications/tools/list_changed`.** A small meta-tool (or
  prompt) lets the agent enable a package mid-session, and the server re-lists.
  - Client support is uneven:
    - The spec only says servers that declare `listChanged` SHOULD notify (§5 S1).
    - Claude Code documents handling `list_changed` by re-fetching the tool list (§5 S5).
    - VS Code's tools page does not mention it (§5 S6).
    - The MCP client feature matrix that used to live at modelcontextprotocol.io/clients
      now redirects to the introduction page (fetched 2026-11-19), so this review could
      not cite per-client `listChanged` support.
  - It also reopens the architecture review's "policy is immutable per process" argument
    (review 01), and it puts surface changes under model control.
  - Effort: high. **Not recommended** before a real use case.

### (e) Re-scoping the cap

What clients actually do with large tool lists (§5):

- **Claude Code** defers MCP tool definitions by default (tool search):
  - "Only tool names and server instructions load at session start". Full definitions
    load on demand, on current Opus/Sonnet/Haiku models. A per-tool `_meta`
    `anthropic/alwaysLoad` can override this.
  - "Claude Code doesn't impose a fixed per-server tool cap; the practical limit is
    your context window budget".
  - Descriptions are cut off at 4,096 characters upfront (16,384 via tool search). The
    longest x-mcp description is 467 B.
  - **For Claude Code the 80 kB wire size is close to irrelevant**: upfront it loads ~621 B
    of names.
- **VS Code / GitHub Copilot.**
  - The limit is **128 tools per request** ("Cannot have more than 128 tools per
    request"), counted across all servers and built-ins.
  - An experimental `github.copilot.chat.virtualTools.threshold` setting groups tools
    "for on-demand discovery".
  - The limit is a tool **count**, not a byte size. 42 is a third of it, but it is
    shared with every other server.
- **Cursor.** The forum documents a historic limit of only the first 40 tools being sent
  to the agent. A 2026 thread mentions 80 and "Dynamic Context Discovery". This is
  community sources only, and the current limit is **unconfirmed**. If 40 still applied,
  x-mcp's 42 would already be over it, independent of bytes.
- **Generic MCP clients** that put every definition into the prompt pay roughly the
  model-visible bytes, ~35 kB. As a rough estimate (not measured), that is on the order
  of 9–12 k tokens, if the client does not also serialise outputSchema.

So the 80,000 B figure is a sound **proxy** for "do not crowd the context of clients that
load everything". It is not a hard client limit anywhere this review found. The binding
external limits are tool **counts** (128 in VS Code; possibly 40/80 in Cursor), and
deferred loading makes bytes matter less over time.

Options for re-scoping:

- **e1.** Keep 80,000 B wire, and add a reported (later gated) **model-visible**
  sub-measure: name, description, inputSchema and `annotations.title`. Today that is
  ≈ 36.6 kB. Gate it at e.g. 40,000 B. This makes the gate measure what costs tokens.
- **e2.** Raise the wire cap, e.g. to 96,000 B. It is honest about the proxy nature, but it
  spends headroom on outputSchema bytes that may not be model-visible.
- **e3.** Add a **tool-count** guard alongside the bytes (e.g. warn above 48 in the default
  set). It tracks the limits clients actually enforce.

Effort is low for all three (script and docs). The risk is zero for tool selection.
The risk is to the guarantee the gate gives: e2 loosens it, e1 and e3 sharpen it.

## 3. What each candidate costs

Each estimate is modelled on the closest existing tool, measured today, and again after
A + c1 (the shapes a new tool would ship with if §4 is adopted). Per the Phase 4 rule,
the endpoint shapes still need their own fact-check before design.

**Bookmark Folders** (review 11 F-2; review 12 row 30 / OD-4):

| Candidate tool | Modelled on | Today (B) | After A + c1 (B) |
|---|---|---:|---:|
| folders list (`GET /2/users/{id}/bookmarks/folders`, paged) | `x_lists_owned` (1,756) | ≈ 1,650–1,800 | ≈ 1,400–1,500 |
| posts in a folder (`GET …/folders/{folder_id}`) | `x_bookmarks_list` (2,453) | ≈ 2,450–2,550 | ≈ 2,150–2,250 |
| create folder (`POST /2/users/{id}/bookmarks/folders`, OD-4) | `x_list_create` (1,221) | ≈ 1,200–1,300 | ≈ 950–1,050 |
| **subtotal, three tools** | | **≈ 5.3–5.6 kB** | **≈ 4.5–4.8 kB** |
| alt: the two reads merged (optional `folder_id`, output `anyOf` of a folder page or a post page) | | ≈ 2.6–3.1 kB, so the package ≈ 3.8–4.4 kB | ≈ 2.3–2.8 kB, so the package ≈ 3.3–3.8 kB |

The write needs a policy cell (`publish`-class bookmark organisation, analogous to
`x_bookmark_set`) and a price (OD-4). Under `read-only` it is listed with the ~33 B suffix,
which the estimates include.

**News** ("News endpoints", docs/08 Phase 4; not fact-checked here):

| Candidate tool | Modelled on | Today (B) | After A + c1 (B) |
|---|---|---:|---:|
| news search (query, paging, `raw`, compact news def ~300 B) | `x_user_search` (2,004) + def | ≈ 2,100–2,500 | ≈ 1,850–2,250 |
| news get by id | `x_list_get` (1,457) + def | ≈ 1,500–1,800 | ≈ 1,250–1,550 |
| **subtotal** | | **≈ 2.1–4.3 kB** (one or two tools) | **≈ 1.9–3.8 kB** |

**Articles** (draft/publish endpoints, changelog 2026-06-11, review 11 F-9; not fact-checked here):

| Candidate tool | Modelled on | Today (B) | After A + c1 (B) |
|---|---|---:|---:|
| article draft create/update (title, body, media) | `x_post_create` (2,401), lighter output | ≈ 1,600–2,400 | ≈ 1,350–2,150 |
| article publish (id action) | `x_post_delete` / `x_list_delete` (1,113–1,164) | ≈ 1,100–1,250 | ≈ 850–1,000 |
| **subtotal** | | **≈ 2.7–3.7 kB** | **≈ 2.2–3.2 kB** |

What fits:

| Headroom scenario | Bytes free | Bookmark Folders | + News | + Articles |
|---|---:|---|---|---|
| today | 2,115 | no | no | no |
| A | 5,757 | yes (merged reads, 3.8–4.4 kB) | not with Folders | not with Folders |
| A + `title` | 7,039 | yes | one News tool, tight | no |
| **A + c1** | **13,569** | yes (4.5–4.8 kB) | yes (≤ 3.8 kB) | yes (≤ 3.2 kB): all three ≈ 8.6–11.8 kB, leaving ≥ 1.7 kB |
| A + c1 + c4 | 38,659 | yes | yes | yes, plus roughly 3–4 more packages |

Note the count side:

- All three candidates add 5–7 tools, taking the default set to **47–49**.
- This is still well inside VS Code's 128.
- It is further past the unconfirmed Cursor figure of 40.

## 4. Recommendation

1. **Take hygiene set A now** (−3,642 B, low effort, near-zero risk).
   - H1 (`$schema`) is free.
   - H2 restates a spec default.
   - H3 is optional if the owner wants zero client-bug exposure. Without it the saving
     is −3,066 B.
   - Land it as its own item with a baseline update. Like any byte change, it states its
     delta.
2. **Take c1 before the 1.0 tag** (−8,106 B, low effort).
   - Document `meta` once in the result-shape docs.
   - Keep the full typed `data`, `summary` and raw-branch contract.
   - Together with A: **66,431 B, 13,569 B of headroom.** That is enough for Bookmark
     Folders (incl. the OD-4 write), News and Articles with ≥ 1.7 kB to spare.
3. **Do not fund features from descriptions** (option a) and **do not pursue
   cross-tool `$ref`** (option b). The first is the highest-risk byte. The second is not
   available in MCP.
4. **Keep c4–c6 and d2 in reserve.**
   - The shallow-outputSchema options are the only lever that frees tens of kB. Use
     them only if a real roadmap need appears, and before 1.0 if at all.
   - Runtime `listChanged` packages wait for a use case and for wider, citable client
     support.
5. **Re-scope the gate rather than the cap** (e1 + e3):
   - keep the 80,000 B wire cap;
   - add a reported model-visible sub-measure, and later gate it (≈ 40,000 B);
   - add a default-set tool-count warning.

   If a 13th+ package ever needs to ship off by default, d1 (`X_MCP_PACKAGES`) is the
   cheap valve, and the gate then measures the default set plus an "all packages"
   report line.

## 5. Sources (all fetched 2026-11-19)

| # | Source | Used for |
|---|---|---|
| S1 | MCP spec 2025-11-25, Server → Tools: https://modelcontextprotocol.io/specification/2025-11-25/server/tools | schema dialect default, outputSchema MUST/SHOULD, `structuredContent`, `listChanged`, annotations untrusted, no tool-count/size guidance |
| S2 | MCP spec 2025-11-25, Basic → JSON Schema usage: https://modelcontextprotocol.io/specification/2025-11-25/basic | 2020-12 default dialect, MUST support 2020-12, graceful handling of unsupported dialects |
| S3 | MCP schema reference 2025-11-25: https://modelcontextprotocol.io/specification/2025-11-25/schema | `Tool` shape (self-contained input/output schema, `$schema` optional), `ToolAnnotations` defaults and "meaningful only when `readOnlyHint == false`", `ListToolsResult` |
| S4 | Claude API docs, Define tools: https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools | tool definition fields (no output schema), "by far the most important factor" description guidance |
| S5 | Claude Code docs, MCP: https://code.claude.com/docs/en/mcp | tool search / deferred loading, no per-server tool cap, description cut-offs, `list_changed` handling |
| S6 | VS Code docs, agent tools: https://code.visualstudio.com/docs/copilot/agents/agent-tools | 128 tools per request, `github.copilot.chat.virtualTools.threshold` |
| S7 | Cursor forum, "Tools limited to 40 total": https://forum.cursor.com/t/tools-limited-to-40-total/67976 and "Regarding the quantity limit of MCP tools" (2026): https://forum.cursor.com/t/regarding-the-quantity-limit-of-mcp-tools/153432 | historic 40-tool limit; 2026 mention of 80 / dynamic context discovery (**community source, unconfirmed**) |
| — | https://modelcontextprotocol.io/clients | now redirects to the introduction page; the per-client feature matrix could not be cited |

## 6. Owner questions

1. **Hygiene set A.** Take all of H1 + H2 + H3 (−3,642 B), or H1 + H2 only (−3,066 B) to
   avoid any client misreading `destructiveHint` on read-only tools?
   **Answered 2026-11-19 (owner): H1 + H2 only; H3 is skipped, so read-only tools keep
   `destructiveHint: false`.** Landed 2026-11-20 as Q08: −3,022 B, 77,885 → 74,863 B.
   That is 44 B less than the −3,066 B estimate because `x_auth_status` and
   `x_rate_limit_status` declare `openWorldHint: false`. They now advertise that `false`;
   the registry used to override it with a blanket `true`, which this report did not catch.
   The baseline in `scripts/context-gate.mjs` was updated.
2. **c1, `meta`.** May `meta` leave the 42 outputSchemas (−8,106 B, `structuredContent`
   unchanged, documented once) before the 1.0 tag? After 1.0 it needs a semver call.
   **Answered 2026-11-19 (owner): yes, option c1.** Landed 2026-11-20 as Q09: −8,106 B, exactly
   the estimate, 74,863 → 66,757 B (13,243 B of headroom). `meta` left both `properties` and
   the envelope's `required`. The root stays open, and a test validates real
   `structuredContent` with `meta` (with and without `budget_warning`) against every served
   outputSchema using the SDK's own Ajv validator. `meta` is documented once in docs/03
   "Result shape" and the README; the CHANGELOG flags it as a declared-schema change. The
   baseline in `scripts/context-gate.mjs` was updated.
3. **Gate scope.** Keep the 80,000 B wire cap and add a model-visible sub-measure (e1)
   and a tool-count warning (e3)? Or raise the wire cap (e2), and to what figure?
   **Answered 2026-11-21 (owner): e1 + e3; the 80,000 B wire cap stays.** Landed 2026-11-21
   as Q13 in `scripts/context-gate.mjs` (judging logic in `scripts/lib/context-budget.mjs`,
   tested by `test/context-budget.test.ts`):
   - **e1.** A model-visible sub-measure: per tool `name`, `description`, `inputSchema`
     and `annotations.title`, in their wire positions inside a `{"tools":[…]}` envelope,
     taken over the same configurations as the wire size. Re-measured at the 49-tool
     surface: **39,802 B** worst case (`read-only`; 39,010 B under `full` + DM allow),
     gated at **40,000 B** with its own baseline, so **198 B** of headroom. The ≈ 36.6 kB in
     §2 (e) was an estimate. The same projection gives 35,063 B for the 42 pre-Q10 tools,
     and the seven Bookmark Folders, News and Articles tools add 4,739 B. The wire size is
     unchanged at 74,790 B.
   - **e3.** A fixed "warn above 48" would fire on every run, because all 49 tools are
     listed in every preset with hide-denied off. The guard is therefore an exact count
     instead: every configuration must list `TOOL_COUNT_BASELINE` (49) tools, and a
     mismatch fails. Separately, a count above a recorded client limit prints a warning
     and never fails. The limits are VS Code / Copilot at 128 (documented, S6) and Cursor
     at 40. The Cursor figure is a historic community number: Cursor's MCP docs
     (https://cursor.com/docs/context/mcp, fetched 2026-11-21) publish no numeric cap,
     and a staff reply on the forum (https://forum.cursor.com/t/cli-mcp-tool-limits/165642,
     2026-07-14) describes "a per-model provider cap on the number of tools". In
     September 2026 the Cursor CLI moved to loading tool definitions on demand. The Cursor
     warning prints today (49 > 40), which keeps Q6 visible for H3.
4. **Candidate order.** Which candidate takes the freed headroom first? This report
   assumes Bookmark Folders with the OD-4 write (merged reads or two tools?), then News,
   then Articles. Each still needs its own Phase 4 fact-check and real use case.
   **Answered 2026-11-20 (owner): Bookmark Folders first, with the OD-4 write.** Landed
   2026-11-20 as Q10, as three tools rather than merged reads: `x_bookmark_folders_list`,
   `x_bookmark_folder_posts` and `x_bookmark_folder_create`. The folder-posts endpoint
   returns post ids only and takes no `fields`/`expansions`, so it cannot share
   `x_bookmarks_list`'s compact-post shape. +3,160 B, 66,757 → 69,917 B (10,083 B of
   headroom). News and Articles remain open.
   **News landed 2026-11-20 as Q11 (owner go):** two read-only tools, `x_news_search` and
   `x_news_get`, in the `search` package. News search is unpaginated, so the search tool
   carries no `page_token`. +2,675 B (1,593 + 1,080 with the list framing), inside the
   modelled 1.9–3.8 kB, 69,917 → 72,592 B (7,408 B of headroom). Articles remain open.
   **Articles landed 2026-11-20 as Q12 (owner go):** two writes in the `posts` package,
   `x_article_draft_create` and `x_article_publish` (`write:content`, `user-only`). X
   documents no draft update, get, list or delete endpoint, so the surface stops at create +
   publish. +2,198 B (1,437 + 759 with the list framing), 72,592 → 74,790 B (5,210 B of
   headroom). All three candidates have now landed.
5. **Off-by-default packages.** Is d1 (`X_MCP_PACKAGES`, default = today's 12 packages)
   acceptable as the mechanism for any package beyond the three candidates? Or does
   "full surface" (decisions/0002) have to stay "everything listed by default"?
6. **Cursor.** Does the 40-tool Cursor figure matter? If so, H3 real-client e2e should
   record Cursor's current limit, since the default set is already 42.
