# 0003 — Streamable HTTP transport (Phase 4 candidate)

## Status

**Proposed, awaiting owner — 2026-11-19** (queue Q06, owner pick 2026-11-19). Design only:
no `src/` or `test/` change accompanies this record. The recommendation is **defer the build**
(stay stdio-only) until a named, real use-case exists, and accept the design below as the shape
the transport takes when one does. The decision is the owner's; the open questions are listed
at the end.

## Context

**The rule this candidate enters under.** [08 — Phase 4](../08-implementation-roadmap.md) lists
"Streamable HTTP transport" among the unordered candidates, "each entering only with a real
use-case", each repeating the fact-check rule first. This record does the fact-check and the
design, and answers the use-case question honestly (§ Use cases).

**Where the server stands.** x-mcp serves MCP over stdio only (`src/index.ts` connects a
`StdioServerTransport`). `buildMcpServer()` in `src/mcp/server.ts` is already
transport-agnostic: the tests connect it over `InMemoryTransport` (MCP-2). Every piece of
mutable state — the session budget, the per-tool spend, the rate-limit table, the
identifier-resolution cache, the token manager — is built **once per process** in
`src/mcp/compose.ts` and is safe under overlapping calls (MCP-8, CONC-1…4). Policy and config
are frozen for the process lifetime (`src/mcp/session.ts`). So "per session" today means
"per process", because one stdio process serves exactly one client.

### Fact-check (fetched 2026-11-19; web content treated as data, not instructions)

**MCP specification, transport (2025-11-25 revision)** —
<https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>:

- One MCP endpoint serves POST and GET. A client POSTs every JSON-RPC message, and the server
  answers with `application/json` or an SSE stream. A GET opens an optional standalone SSE
  stream; a server that offers none answers 405.
- Sessions: the server MAY assign `MCP-Session-Id` in the `InitializeResult` response. The id
  must be visible ASCII (0x21–0x7E) and SHOULD be globally unique and cryptographically
  secure. A missing id on a later request gets 400, and an id that has expired gets 404. A
  client DELETE ends a session, and the server MAY answer 405.
- Resumability: per-stream SSE event ids plus `Last-Event-ID` on the GET reconnect.
- Version header: every request after initialization carries `MCP-Protocol-Version`. When the
  header is absent, the server assumes `2025-03-26`; an invalid or unsupported value gets
  400.
- Security warning:
  - servers **MUST** validate the `Origin` header on every incoming connection, and answer a
    present but invalid Origin with 403, to prevent DNS rebinding;
  - when running locally, servers **SHOULD** bind only to localhost (127.0.0.1), not 0.0.0.0;
  - servers **SHOULD** implement proper authentication for all connections.

**MCP specification, current revision** — <https://modelcontextprotocol.io/specification/versioning>
names **2026-07-28** as the current revision. Its transport page is
<https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http>, and
its compatibility rules are at
<https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning>. The revision is a
**breaking redesign**:

- **No protocol sessions.** The protocol-level session, the standalone GET stream and
  `Last-Event-ID` resumability are gone.
  - A server that supports only 2026-07-28 answers GET and DELETE with 405 and ignores
    `Mcp-Session-Id`.
  - State that spans requests becomes an explicit handle passed as a tool argument ("state
    handle hijacking" in the security page).
- **Per-request version, no handshake.**
  - Every request carries `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers. The
    server checks them against the body: a mismatch gets 400 with `HeaderMismatch`, and an
    unsupported version gets `UnsupportedProtocolVersionError` (-32022).
  - Each request also carries `_meta` with `io.modelcontextprotocol/protocolVersion`, client
    info and client capabilities.
  - `server/discover` replaces `initialize`.
- **Other changes:**
  - Server→client requests move to the MRTR `InputRequiredResult` pattern.
  - `subscriptions/listen` is new.
  - Over HTTP, **closing the response stream is cancellation**; `notifications/cancelled`
    remains for stdio.
- **Compatibility.** "Legacy" means `initialize`-based revisions (2025-11-25 and earlier). A
  dual-era server MAY serve both, and a server that speaks only the legacy revision fails
  against modern-only clients.
- **Deprecations** (<https://modelcontextprotocol.io/specification/2026-07-28/deprecated>):
  - HTTP+SSE has been deprecated since 2025-03-26.
  - Roots, Sampling, Logging and Dynamic Client Registration are deprecated in 2026-07-28, with
    the earliest removal on or after 2027-07-28.

**MCP authorization** — <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>
and the 2026-07-28 page of the same path agree on what matters here:

- Authorization is **OPTIONAL**. An HTTP transport that supports it SHOULD follow the spec; a
  stdio transport SHOULD NOT, and takes credentials from the environment.
- A supporting server acts as an OAuth 2.1 resource server and:
  - **MUST** publish RFC 9728 Protected Resource Metadata;
  - **MUST** validate that tokens were issued for it (RFC 8707 audience);
  - **MUST NOT** accept or transit any other token. This is the token-passthrough
    prohibition: the client's token must never be forwarded upstream.
- Error codes: 401 for a missing or invalid token, 403 for insufficient scope.

**MCP security best practices** —
<https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices>,
"Local MCP Server Compromise":

- It names DNS rebinding against "an insecure local server that's left running on localhost"
  as an attack.
- It says a locally-run server SHOULD "use the `stdio` transport to limit access to just the
  MCP client", or, if it uses HTTP, SHOULD "require an authorization token" or use unix
  sockets / IPC with restricted access.

**`@modelcontextprotocol/sdk` v1, server side.** package.json pins `^1.23.0` and the lockfile
resolves **1.32.1**; the npm registry's latest v1 is 1.32.2 (fetched 2026-11-19). What 1.32.1
offers, read from the installed `dist/esm/server/*.d.ts` and `dist/esm/types.d.ts`:

- **Protocol versions.** `LATEST_PROTOCOL_VERSION = '2025-11-25'`; the supported list runs from
  2025-11-25 down to 2024-10-07. **The SDK does not implement 2026-07-28.** The v2 line
  (`@modelcontextprotocol/server` 2.4.0, with `@modelcontextprotocol/core` 2.4.0 and
  `@modelcontextprotocol/node` 2.1.2) also reports `LATEST_PROTOCOL_VERSION = '2025-11-25'`.
- **The transport class.** `StreamableHTTPServerTransport` (`server/streamableHttp.js`)
  implements the 2025-11-25 transport.
  - It is called as
    `handleRequest(req: IncomingMessage & { auth?: AuthInfo }, res: ServerResponse, parsedBody?)`,
    so it runs on **plain `node:http`** and needs no express. Internally it wraps the
    web-standard transport through `@hono/node-server`.
  - Its options are `sessionIdGenerator` (left undefined it means stateless mode),
    `onsessioninitialized`, `onsessionclosed`, `enableJsonResponse`, `eventStore`
    (resumability), `retryInterval`, `keepAliveMs` (default 15 s) and `maxRequestBodySize`
    (default 4 MiB, answering 413).
- **Deprecated DNS-rebinding options.** The built-in `allowedHosts`, `allowedOrigins` and
  `enableDnsRebindingProtection` options are marked **@deprecated** ("use external
  middleware"). The middleware the SDK ships for this (`hostHeaderValidation`,
  `localhostHostValidation`, `createMcpExpressApp`) is **express-based**, and so are the auth
  helpers (`requireBearerAuth`, `mcpAuthRouter`, `mcpAuthMetadataRouter`).
- **One Server per transport.** `Protocol.connect()` throws on a second transport ("use a
  separate Protocol instance per connection"), so each HTTP session needs its own `Server`
  instance.
- **Dependencies.** The SDK declares express, hono, `@hono/node-server`, cors and jose as its
  *own* dependencies. They arrive transitively whether or not x-mcp uses them. x-mcp's
  **direct** runtime dependencies can stay `@modelcontextprotocol/sdk` + `zod`.

**Bridges** (npm registry, fetched 2026-11-19):

- `supergateway` 4.2.2 (MIT): "Run MCP stdio servers over SSE, Streamable HTTP or vice versa".
- `mcp-proxy` 6.11.0 (MIT): "A TypeScript SSE proxy for MCP servers that use stdio transport".

Their bind, Origin and auth defaults were **not** audited for this record.

## Use cases — are they real?

Honest answer: **no concrete use-case exists yet.** Nobody has asked for HTTP: not the owner,
not a user, not an issue. Every client the docs target (Claude Code, Claude Desktop via the
`.mcpb` bundle, VS Code, Cursor) launches stdio servers natively. The candidates, with an
honest assessment of each:

| # | Use-case | Real today? | Does a loopback HTTP transport serve it? |
|---|---|---|---|
| U1 | Several local clients share **one** process: one token refresher, one budget, one rate-limit table, instead of N stdio processes sharing a token file (CONC-4) | Plausible, unproven. CONC-4 already makes N processes safe | Yes |
| U2 | A remote or hosted client, e.g. a claude.ai custom connector that needs a public HTTPS URL | Hypothetical, and it would need the full authorization spec (resource server, RFC 9728, audience validation, TLS) | **No.** A loopback-only design deliberately excludes it |
| U3 | A client that speaks only HTTP | None identified; all target clients speak stdio | Yes |
| U4 | Headless or container deployment (a sidecar, a long-lived daemon) | Hypothetical | Partly: it needs a non-loopback bind, which this design refuses by default |

None of these clears the Phase 4 bar. U1 is the only one the safe design serves, and it is an
efficiency gain over a configuration that already works.

## Decision (proposed)

1. **Do not build now; stay stdio-only.** Revisit when a named use-case appears (see Revisit
   triggers). This record fixes the design so that the build, when it comes, is mechanical.
2. **When built, the transport has this shape** (sections below):
   - off by default, loopback-only, and a required local bearer secret;
   - Host and Origin validated by x-mcp's own code;
   - plain `node:http` plus the SDK's `StreamableHTTPServerTransport`, no new runtime
     dependency;
   - one `Server` per HTTP session over **one** process-wide registry, budget, policy and
     token manager;
   - **no** MCP OAuth resource-server role, and never token passthrough.
3. **Build against the SDK the project is on at the time**, and gate the build on the SDK
   question. A transport built today speaks the 2025-11-25 session model, which the current
   2026-07-28 revision removes. The SDK v2 migration (owner-gated in the queue) and SDK support
   for 2026-07-28 should be settled first, or the transport ships knowing it is "legacy-era"
   and will be reworked.

### Design

**Config and env surface.** All settings are env-only, like the rest of `src/core/config.ts`.
Every default is the safe one.

| Variable | Default | Meaning / validation |
|---|---|---|
| `X_MCP_TRANSPORT` | `stdio` | `stdio` \| `http`. Any other value is a startup config error (the CFG style). `http` never also serves stdio |
| `X_MCP_HTTP_HOST` | `127.0.0.1` | Accepts only `127.0.0.1`, `::1` or `localhost`. Any other value is refused at startup unless `X_MCP_HTTP_ALLOW_NON_LOOPBACK=1`, which is out of scope for the first build (open question Q-3) |
| `X_MCP_HTTP_PORT` | none (required when `http`) | An integer from 1 to 65535. No implicit default port, so a stray `X_MCP_TRANSPORT=http` cannot silently open a well-known listener |
| `X_MCP_HTTP_TOKEN_FILE` | none (required when `http`) | Path to a file holding a high-entropy bearer secret. It gets the same mode checks as `X_MCP_TOKEN_FILE` (§4.2): `0600`, and the server refuses group- or other-readable files. The secret is never accepted from argv, and an env form is open question Q-2. It is compared in constant time |
| `X_MCP_HTTP_ALLOWED_ORIGINS` | empty | An exact-match list. With the list empty, **any** request carrying an `Origin` header gets 403. Non-browser clients send no Origin; browsers always do |
| `X_MCP_HTTP_PATH` | `/mcp` | The single MCP endpoint. Every other path gets 404 |

The startup banner (stderr) prints the bound `host:port`, and says "HTTP transport, loopback,
bearer required". It never prints the secret or its path.

**Request pipeline.** Each step runs before the SDK sees the request:

1. Method and path check.
2. **Host** header check: it must equal `<loopback-name>:<port>` (DNS rebinding defence 1).
3. **Origin** check (defence 2; 403).
4. `Authorization: Bearer` check against the secret (401, `WWW-Authenticate: Bearer`).
5. Body size cap, which is the SDK's own 413.
6. Hand off to `transport.handleRequest()`.

The pipeline sends **no CORS headers**: no `Access-Control-Allow-*`, so browser preflights fail
closed. This is roughly 80 lines of x-mcp code on `node:http`. It replaces the deprecated SDK
options and the express-only middleware.

**Sessions.** Stateful mode (`sessionIdGenerator: randomUUID`) is used with a
`Map<sessionId, {server, transport}>`:

- `initialize` creates a `buildMcpServer(sharedDeps)` instance and its transport. The
  instance is built over the **same** `deps` object.
- DELETE, `onsessionclosed` or an idle timeout tears the instance down.
- A session cap (for example 8) answers further `initialize` requests with 503, so a local
  loop cannot exhaust memory.
- The `eventStore` stays off: no resumability in the first build. The current spec has dropped
  it anyway, so it is not worth building.

Stateless mode was rejected because the SDK then needs a new Server per request.
`notifications/cancelled` would land on an instance that never saw the request, breaking MCP-7.

**What each session gets.** The rule is: one process, one principal, one budget. Nothing is
per-session except the SDK transport state.

- **Policy:** process-wide and frozen, identical for every session. There is no per-session
  policy, because there is no per-session principal: the bearer secret identifies "a local
  client", not a person. Q-4 asks whether per-session policy is ever wanted.
- **Budget:** the **one** `SessionBudget` and `SpendByTool` instance in `compose.ts` serves
  every session.
  - The check-and-reserve stays atomic (CONC-2) across sessions; nothing changes in the gate.
  - The documentation must say that "session budget" means **process** budget under HTTP:
    concurrent clients draw from one limit, and `x_usage_get` reports the shared total.
- **Rate limits, the resolve cache and the token manager:** shared, as today (MCP-8).
- **Progress:** the progress bridge stays per call (`_meta.progressToken`). Notifications ride
  that request's SSE response stream, so they reach only the caller.
- **Cancellation:** `notifications/cancelled` arrives on the same session's Server and aborts
  the call's `AbortSignal` (MCP-7). A dropped response stream should also abort; a spike must
  verify this (HTTP-7) before it is claimed, because only 2026-07-28 makes it normative.
- **Prompts:** stateless and registry-derived (`src/mcp/prompts.ts`), so they are identical in
  every session.
- **`instructions`:** the same text for every session. The server stays one fixed identity,
  so T6 is unchanged.

**Credential boundary.** The inbound bearer secret is a local access control for the HTTP
listener **only**:

- It is never forwarded to X; only the token manager supplies the X `Authorization` header,
  host-scoped per §4.4 and T10.
- It never appears in a tool result or a log line (T2).

x-mcp does **not** become an MCP OAuth resource server in this design. The authorization spec
is OPTIONAL, and a loopback listener with a local secret is what the security best-practices
page asks of a local HTTP server. A remote deployment would need the full authorization spec;
that is U2 and out of scope.

### Threat model delta (extends [04 §2](../04-security.md))

| Id | Threat | Vector | Mitigation in this design |
|---|---|---|---|
| T-H1 | The token file's power reaches *any* local process, not only the spawning parent | Under stdio, only the client that spawned the process can drive it. A listener can be reached by every process and every OS user on the host | Loopback bind; the required bearer secret in a `0600` file, refused when group- or other-readable; a session cap. Residual risk: a process running as the same OS user can read the secret file, the same as it can read `X_MCP_TOKEN_FILE` today, so the boundary does not get worse for a same-user attacker |
| T-H2 | DNS rebinding: a web page drives the local server through the browser | A malicious site resolves its name to 127.0.0.1 and POSTs JSON-RPC | Exact Host check, Origin 403 by default, no CORS. The bearer secret is unknown to the page. Three independent controls |
| T-H3 | Spend-budget drain across clients | Client A, or a looping agent in A, burns the credit limit client B relies on | One shared atomic budget (CONC-2) with the operator-set `X_MCP_CREDIT_BUDGET`; `x_usage_get` shows the shared total; docs state the process-budget semantics. Per-session sub-budgets are Q-5 |
| T-H4 | Policy confusion across clients | An operator expects one client to be read-only and another write-capable | Not offered: one frozen policy per process. Different policies mean different processes, each on its own port. Documented |
| T-H5 | Token passthrough / confused deputy | Inbound `Authorization` forwarded to `api.x.com` | Structurally impossible: the request handler never reads the inbound header into a `CallContext`, and the http client's auth comes only from the token manager (T10). A test asserts it (HTTP-9) |
| T-H6 | Session-id hijack | Another local process guesses or sniffs `MCP-Session-Id` | Ids are random UUIDs; every request still needs the bearer secret, because a session id is never treated as authentication |
| T-H7 | Resource exhaustion | Many `initialize` requests, large bodies, idle streams held open | The session cap (503), the SDK body cap (413), an idle timeout and the SDK keep-alive |
| T-H8 | Accidental network exposure | The operator sets a LAN or 0.0.0.0 host | Refused at startup; the opt-in variable is out of scope for the first build (Q-3) |

### Runtime dependencies

No new runtime dependency. The design uses `node:http`, `node:crypto` (`randomUUID`,
`timingSafeEqual`) and the SDK's `server/streamableHttp.js`. The SDK pulls in express, hono and
`@hono/node-server` itself, but x-mcp imports none of them directly and does not use
`createMcpExpressApp` or the express middleware. `npm audit --omit=dev` already covers those
transitive packages today, because they come with the SDK under stdio too.

### Context budget impact

**0 B.** The transport changes no tool, schema, description or prompt, and `tools/list` is
byte-identical over both transports. The context gate needs no baseline change. A test asserts
the byte equality (HTTP-10).

### Test plan (proposed docs/07 section "HTTP — Streamable HTTP transport")

All tests run in-process against an ephemeral loopback port (`port: 0`) with the SDK client's
`StreamableHTTPClientTransport`. They do not make live X calls.

| Case | Priority | Assertion |
|---|---|---|
| HTTP-1 — off by default | P1 | With no `X_MCP_TRANSPORT`, nothing listens; `http` without a port or token file is a startup config error (the CFG style) |
| HTTP-2 — loopback only | P1 | `X_MCP_HTTP_HOST=0.0.0.0` or a LAN IP is refused at startup with a clear message |
| HTTP-3 — Host check | P1 | A wrong `Host` header (for example `evil.example:port`) gets 403 or 421 before the SDK sees the request |
| HTTP-4 — Origin check | P1 | A present, non-allow-listed `Origin` gets 403; an absent Origin passes; responses carry no CORS headers; an OPTIONS preflight fails |
| HTTP-5 — bearer required | P1 | A missing or wrong secret gets 401 with `WWW-Authenticate: Bearer`; the comparison is constant-time; the secret file's mode is enforced (the §4.2 style) |
| HTTP-6 — session lifecycle | P1 | `initialize` returns `MCP-Session-Id`; an unknown id gets 404; a missing id gets 400; DELETE ends the session; the session cap answers 503 |
| HTTP-7 — cancellation | P2 | `notifications/cancelled` aborts the in-flight HTTP call (MCP-7). A client stream disconnect also aborts it; this is a spike, and the record is amended if the SDK does not surface it |
| HTTP-8 — shared budget | P1 | Two sessions interleave paid calls at about 1 credit remaining: exactly one proceeds in `hard` mode (CONC-2 across sessions), and `x_usage_get` from either session shows the shared total |
| HTTP-9 — no token passthrough | P1 | An inbound `Authorization: Bearer <secret>` never appears in any outbound request to the recorded X endpoint; outbound auth equals the token manager's token |
| HTTP-10 — parity | P1 | `tools/list` and `prompts/list` are byte-identical over stdio and HTTP (0 B context delta); one representative `tools/call` gives the same result |
| HTTP-11 — progress isolation | P2 | A progress-token call in session A emits `notifications/progress` only on A's stream |
| HTTP-12 — stdout discipline | P1 | Under `http`, stdout stays empty (MCP-1's rule generalised); diagnostics go to stderr |
| HTTP-13 — limits | P2 | An oversized body gets 413; an idle session is reaped after the timeout |

The fuzz harness (`npm run fuzz`) and the mutation run are unchanged; the pipeline's guard
functions are pure and get unit tests of their own.

### Rollout (if accepted and a use-case lands)

1. Settle the SDK question first: v1 or v2, and 2026-07-28 support (Q-1).
2. One work package (`src/mcp/http.ts`, a config extension, the tests above, the docs/07
   section, docs/04 T-H rows, the operator guide and the troubleshooting entries), marked
   **experimental** in docs/13 and the README.
3. Ship in a minor release behind `X_MCP_TRANSPORT=http`, so stdio behaviour is unchanged. The
   `.mcpb` bundle stays stdio.
4. Dogfood with two local clients for a week. Promote out of experimental, or drop it, at the
   next release review.

## Alternatives

1. **Stay stdio-only (recommended now).** Zero new attack surface, zero code, and the spec's
   own best-practices advice for local servers. Its cost is U1: N clients run N processes,
   which CONC-4 already makes safe.
2. **Point users at a bridge (`supergateway`, `mcp-proxy`).** This works today with no x-mcp
   code: the bridge spawns x-mcp over stdio and exposes HTTP. The costs:
   - the security posture (bind address, Origin, auth) is the bridge's and not under our
     tests;
   - every bridged client shares one stdio session, so per-call progress and cancellation
     routing depend on the bridge.

   If a user needs HTTP before the owner accepts a build, document this as "unsupported, your
   responsibility" in the troubleshooting guide. Do not endorse a specific bridge without
   auditing its defaults.
3. **Build now on SDK v1, 2025-11-25 sessions.** Rejected for now. There is no use-case, and
   it would ship a legacy-era transport that has to be redone when the SDK adopts 2026-07-28.
4. **Build as a full MCP OAuth resource server (remote-capable).** Rejected for this scope. It
   needs RFC 9728 metadata, an authorization server, audience validation and TLS, all for U2,
   which is hypothetical.

## Open owner questions

- **Q-1 — SDK and spec era.**
  - Wait for SDK support of 2026-07-28, and the v2 migration, before any build? The
    recommendation is yes.
  - Or accept a 2025-11-25 "legacy-era" transport?
- **Q-2 — Secret delivery.** Use only `X_MCP_HTTP_TOKEN_FILE` (recommended), or also an env
  form (`X_MCP_HTTP_TOKEN`), which leaks through `/proc/<pid>/environ` and crash dumps?
- **Q-3 — Non-loopback.** Is an `X_MCP_HTTP_ALLOW_NON_LOOPBACK=1` opt-in ever wanted? Without
  TLS and OAuth the recommendation is no.
- **Q-4 — Per-session policy.** Is one policy per process acceptable, with different policies
  run as different processes?
- **Q-5 — Per-session sub-budgets.** Shared process budget only (recommended), or an optional
  per-session cap on top?
- **Q-6 — Bridge guidance.** Should the troubleshooting guide mention bridges as an
  unsupported route before a build exists?

## Consequences

- No code, schema, test or context-budget change now.
- docs/08 Phase 4 links this record. The candidate stays unchecked.
- If the owner accepts the design with no build:
  - the threat rows, the test cases and the config table are pre-agreed;
  - the build becomes one work package;
  - docs/04 and docs/07 gain their rows in that package, not before.

**Revisit triggers:**

- A named user or owner use-case: U1 with a measured cost, or a client that speaks only HTTP.
- The SDK releases 2026-07-28 support.
- The SDK v2 migration is scheduled.
- The bridge route produces a security report against x-mcp.

## References

- [08-implementation-roadmap.md — Phase 4](../08-implementation-roadmap.md)
- [04-security.md — threat model, §4.2 token store, §4.4 host-scoping](../04-security.md)
- [07-corner-cases.md — MCP-1/7/8, CONC-2/4](../07-corner-cases.md)
- [02-architecture.md — the MCP adapter](../02-architecture.md)
- [0001-oauth1-go-no-go.md](0001-oauth1-go-no-go.md), [0002-remaining-catalogued-tools.md](0002-remaining-catalogued-tools.md)
- MCP transports 2025-11-25: <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>
- MCP Streamable HTTP 2026-07-28: <https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http>
- MCP versioning: <https://modelcontextprotocol.io/specification/versioning>,
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning>
- MCP deprecations: <https://modelcontextprotocol.io/specification/2026-07-28/deprecated>
- MCP authorization: <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>,
  <https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>
- MCP security best practices: <https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices>
- `@modelcontextprotocol/sdk` 1.32.1 `dist/esm/server/streamableHttp.d.ts`, `dist/esm/types.d.ts`
  (installed via `npm ci`); npm registry entries for `@modelcontextprotocol/sdk`,
  `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `supergateway`, `mcp-proxy`
  (all fetched 2026-11-19)
