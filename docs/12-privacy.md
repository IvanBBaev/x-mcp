# 12 — Privacy & data handling

What this server sends, where it sends it, and what it keeps. Written for operators who
must answer that question before pointing an agent at a real X account (platform-review
finding SEC-F7). Companion pages: [10-operator-guide.md](10-operator-guide.md),
[11-troubleshooting.md](11-troubleshooting.md), [04-security.md](04-security.md) (threat
model).

## 1. The short version

- **Nothing phones home.** There is no telemetry, no analytics, no crash reporting, no
  update check, no vendor endpoint. The project operates no server of any kind.
- **The only outbound destination is the X API** (`https://api.x.com` by default). Every
  network call in the codebase targets the configured base URL.
- **Credentials never leave your machine** except to X's own token endpoint, which is where
  they are meant to go.
- **Cost accounting is local.** The running total is an in-memory counter in the server
  process; it is reported to the calling model and to nobody else.
- **The content you read *does* leave X.** Posts, profiles and DM events fetched by a tool
  are returned to your MCP client and therefore reach whatever model provider that client
  uses. That is the point of the server, and it is the exposure to reason about.

## 2. Every outbound connection

| Destination | Sent | When | Carries credentials |
|---|---|---|:--:|
| `<X_MCP_BASE_URL>` (default `https://api.x.com`) | Tool requests: queries, ids, and the content of posts/DMs/media you create. | On each tool call. | Yes |
| `<X_MCP_BASE_URL>/2/oauth2/token` | `refresh_token`, `client_id` (+ HTTP Basic for confidential clients). | On token refresh. | Yes |
| `https://api.x.com/2/oauth2/token` | Authorization code, PKCE verifier, `client_id`. | During `authorize` only. | Yes |
| `https://x.com/i/oauth2/authorize` | Opened **in your browser** — the server does not request it. | During `authorize` only. | No (browser session) |
| `<X_MCP_BASE_URL>/2/openapi.json` | Nothing. Unauthenticated reachability probe. | Only `doctor --connect`. | No |

There are no other network call sites. The runtime dependency set is two packages —
`@modelcontextprotocol/sdk` and `zod` — neither of which reports usage.

**Host-scoping.** The `Authorization` header is attached **only** when the request URL
matches the configured API origin, and redirects are never followed on token-bearing
requests, so a token can never chase a `Location` header to a foreign host. Proxy
environment variables (`HTTP_PROXY`/`HTTPS_PROXY`) are deliberately ignored — traffic is
not silently diverted through a middlebox.

**A non-default base URL is loud.** It must be `https://` and a `*.x.com` host unless you
set `X_MCP_ALLOW_INSECURE_BASE_URL=1`, and both facts are printed as startup warnings and
shown by `doctor`. If your API traffic is going somewhere unexpected, the server said so.

## 3. Credentials

| Secret | Where it lives | Notes |
|---|---|---|
| `X_MCP_CLIENT_ID` / `X_MCP_CLIENT_SECRET` | Environment of the server process (your MCP client config). | Never written to disk by the server. |
| `X_MCP_BEARER_TOKEN` (app-only) | Environment only. | Never written to disk. |
| OAuth 2.0 access + rotating refresh token | The token file — `%APPDATA%\x-mcp\tokens.json` on Windows, else `$XDG_CONFIG_HOME/x-mcp/tokens.json` / `~/.config/x-mcp/tokens.json`. Override with `X_MCP_TOKEN_FILE`. | Written `0600` with `O_NOFOLLOW`/`O_EXCL`, replaced atomically, persisted **before** first use so a rotation is never lost. |

- **Never returned to the model.** No tool exposes a token, a client secret or a bearer.
  `x_auth_status` reports the auth mode, the authenticated identity, granted scopes and the
  policy matrix — not the credentials.
- **Masked in diagnostics.** `doctor` runs every line it prints through a redactor built
  from the current environment, so pasting its output into an issue is safe.
- **Not in logs.** The server logs to stderr only; it opens no log file.
- **Your responsibility:** the token file is a live credential for the linked X account.
  Keep it out of cloud-synced folders (`doctor` warns), out of backups you would not trust
  with a password, and out of version control.

## 4. Content: what reaches the model

Every read tool returns X content into the MCP client's context, which the client sends to
its model provider. This server cannot see or control what happens after that. Assume that
anything a tool returns becomes training-adjacent context in the client's own privacy
regime.

Mitigations that *are* in the server:

- **Compact rendering by default.** Read tools return a reduced shape; `raw: true` returns
  the full X envelope only when explicitly requested (same credit cost, much larger
  output).
- **DM minimization.** DM event lookups return ids, timestamps and participants only.
  Message **bodies** require an explicit `include_text: true` on the call, and the response
  carries a note saying so. X itself retains roughly the last 30 days of DM events.
- **Untrusted-content marking.** Post/user/DM text is third-party data and is rendered as
  inert content, never as instructions. Marking is not a semantic filter — the policy model
  is the real control against prompt injection.
- **Policy first.** Content the policy does not permit is never fetched, so it can never
  reach the model. The default preset (`read-only`) cannot read DMs at all: `read:dm` is in
  no preset, including `full`, and needs an explicit operator opt-in.

**Third-party data.** Posts, profiles and especially DMs are other people's personal data.
If you enable `read:dm`, you are routing private correspondence — including messages
written by people who never consented to an AI reading them — into a model context. Treat
that as a deliberate decision with a legal basis, not a convenience toggle.

## 5. What the server stores

| Data | Persisted? | Lifetime |
|---|---|---|
| OAuth tokens | Yes — the `0600` token file (plus a short-lived `.lock` during refresh). | Until you re-authorize or delete the file. |
| Session credit spend | **No.** In-memory counter in the server process. | Resets to 0 on every restart. |
| Rate-limit windows | **No.** In-memory, parsed from response headers. | Process lifetime. |
| Fetched posts / users / DMs | **No.** Rendered into the tool result and discarded. | None — no cache, no database. |
| Uploaded media | **No.** Read from `X_MCP_MEDIA_DIR` and streamed to X. | Your files stay yours. |
| Logs | **No file.** stderr only; the client decides whether to persist its MCP log. | Client-controlled. |

There is no cache, no analytics store and no crash dump. Deleting the token file returns
the machine to a clean state.

## 6. Deleting your data

1. **Unlink the account:** delete the token file (`doctor` prints its resolved path) and,
   if one is present, the `.lock` beside it.
2. **Revoke server-side:** remove the app's authorization from your X account settings, and
   rotate the client secret / bearer token in the X developer portal if they were ever
   exposed.
3. **Clear the client:** remove the `env` block from the MCP client config; secrets you put
   there live in that file.
4. **Content already sent to X** (posts, DMs, media) is governed by X's own retention and
   deletion policy, not by this server. `x_post_delete` and `x_list_delete` ask X to delete;
   what X keeps afterwards is X's business.

## 7. Legal notes

This project is an independent client for the official, publicly documented X API v2. It
does not scrape, and it uses no private or undocumented access. Your use of the API is
governed by X's developer agreement and policy; if you process other people's personal data
through it — DMs above all — the legal basis for that processing is yours to establish, not
this server's.

The software is provided under the [MIT License](../LICENSE), without warranty.
