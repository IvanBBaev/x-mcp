# 11 — Troubleshooting

Symptom → cause → fix. Setup lives in [10-operator-guide.md](10-operator-guide.md); data
handling in [12-privacy.md](12-privacy.md).

## 1. Where failures show up

There are exactly two failure surfaces, and they need different responses.

| Surface | Looks like | Who fixes it |
|---|---|---|
| **Startup** | One line on **stderr**: `x-mcp-ai: fatal: <reason>`, then exit code 1. The client shows the server as failed/disconnected. | The operator, in the env. |
| **A tool call** | A structured tool error (`isError: true`) carrying `kind`, `message`, `retryable`, `fix`. The server stays up. | `fix: "agent"` → the model retries or corrects arguments. `fix: "operator"` → you change config or credentials. |

Non-fatal startup notices appear as `x-mcp-ai: warning: <text>` on stderr and are
suppressed at `X_MCP_LOG_LEVEL=silent`. **stdout is JSON-RPC only** — if you see anything
else there, something in your wrapper is polluting it and the client will fail to parse the
stream.

The 11 error classes and their defaults:

| `kind` | `retryable` | `fix` | Means |
|---|:--:|---|---|
| `auth` | no | operator | Missing / expired / unusable credentials. |
| `scope` | no | operator | The token lacks an OAuth scope this endpoint needs. |
| `forbidden` | no | agent | X refused this specific action (blocked, protected, duplicate content). |
| `rate-limit` | **yes** | agent | Window exhausted; carries `reset_at` / `retry_after_seconds`. |
| `budget` | no | operator | The session credit budget would be exceeded (`hard` mode). |
| `billing` | no | operator | X refused for account/credit reasons. |
| `policy` | no | operator | The tool's policy cell is not allowed. |
| `validation` | no | agent | Bad arguments. |
| `not-found` | no | agent | No such post/user/list. |
| `api` | no | agent | An X API error that fits nowhere more specific. |
| `network` | **yes** | agent | Transport failure or timeout. |

## 2. The server will not start

Run the diagnostics first — it validates the same config the server does, without making
billable calls:

```bash
node /abs/path/to/x-mcp/build/src/index.js doctor
```

Every configuration error names the environment variable, so the message is directly
actionable. Format: `invalid configuration — X_MCP_FOO: <what is wrong>`.

| Fatal reason contains | Cause | Fix |
|---|---|---|
| `X_MCP_AUTH_MODE: Invalid enum value` | Only `oauth2` and `app-only` exist. `oauth1` was dropped (decision 0001) and is now an unknown value. | Use `oauth2` or `app-only`. |
| `X_MCP_AUTH_MODE=app-only requires X_MCP_BEARER_TOKEN` | App-only mode with no bearer. | Set `X_MCP_BEARER_TOKEN`, or switch to `oauth2`. |
| `X_MCP_BEARER_TOKEN is only valid when X_MCP_AUTH_MODE=app-only` | Bearer left over from an earlier setup. | Remove it, or set the mode to `app-only`. |
| `X_MCP_CLIENT_ID / X_MCP_CLIENT_SECRET require X_MCP_AUTH_MODE=oauth2` | Same mismatch, other direction. | Remove them, or set `oauth2`. |
| `X_MCP_PROFILE is required when X_MCP_PROFILES_FILE is set` | A profiles file with no selection. | Set `X_MCP_PROFILE`. |
| `X_MCP_PROFILES_FILE is set together with direct credentials` | Two credential sources at once. | Choose one: the profiles file **or** the direct vars. |
| `X_MCP_TOKEN_KEYCHAIN=1 is mutually exclusive with an explicit X_MCP_TOKEN_FILE` | Both stores requested. | Drop one. The two backends never fall back to each other, so the server refuses rather than guess which one holds your token. |
| `invalid policy cell(s): …` / `Unknown policy preset …` | Typo in `X_MCP_POLICY`, `X_MCP_POLICY_ALLOW`, `X_MCP_POLICY_DENY`. | The message lists every valid preset / cell — copy one. |
| `X_MCP_CREDIT_BUDGET must be a positive USD amount` | `0`, negative, or non-numeric. | Use e.g. `5.00`, or unset for no cap. |
| `X_MCP_TIMEOUT_MS must be a positive integer number of milliseconds` | Non-integer or `0`. | e.g. `30000`. |
| `X_MCP_BASE_URL must use https://` / `host "…" is not *.x.com` | A custom base URL. | Unset it (default `https://api.x.com`), or set `X_MCP_ALLOW_INSECURE_BASE_URL=1` if you genuinely intend a test host. **The flag relaxes the host check only — `https://` stays mandatory no matter what it is set to**, so it will not get you a plain-`http://` endpoint. The name is broader than the behaviour; the behaviour is the conservative one. |
| `authorize needs an OAuth2 token store` | `authorize` run in `app-only` mode, which has no user token to mint. | Run it with `X_MCP_AUTH_MODE=oauth2`. Either backend works — `authorize` writes to whichever store the same configuration makes the server read from. |
| `Node … is not supported` | Node < 20 reached the launcher. | Install Node >= 22. |

**Warnings that are not fatal but usually mean something is wrong:**

- `Unknown environment variable X_MCP_… (ignored — possible typo)` — the server recognizes
  a fixed set of names; anything else is ignored. Check the spelling against the
  [README table](../README.md#environment-variables). A typo'd `X_MCP_POLCY` means you are
  silently running the default preset.
- `X_MCP_PROFILE is set but X_MCP_PROFILES_FILE is not — the selection is ignored`.
- `Using non-default X API base URL: …` and
  `X_MCP_ALLOW_INSECURE_BASE_URL is enabled` — these should never appear in production.

## 3. `doctor`

```
usage: x-mcp-ai doctor [--connect]
```

Exit code 0 = healthy (warnings allowed), 1 = at least one failing check. Output lines are
`[level] area: text` with level `ok` / `note` / `warn` / `fail`; secrets are scrubbed from
every line before printing.

What it checks:

| Check | Failure meaning |
|---|---|
| Configuration | Same validation the server runs (CFG-5). If this fails, later checks are skipped — fix it first. |
| Token directory permissions | **fail** if group/other-writable — another user could swap your tokens. Fix: `chmod 700 <dir>`. |
| Token file permissions | **warn** if wider than `0600` (`chmod 600 <file>`); **fail** if it is not a regular file (symlink/dir). |
| Leftover `<token-file>.lock` | Reported with its age. It is never removed automatically — see §4. |
| Profiles file permissions | Same hygiene as the token file. |
| `X_MCP_MEDIA_DIR` exists | **fail** if the configured media root is missing — uploads would deny everything. |
| Cloud-synced location | **warn** if the token store sits in iCloud Drive, Dropbox, OneDrive or Google Drive. Move it. |

It then prints the resolved auth mode, masked credentials, base URL, policy preset, allowed
cells, and the denied cells with their fate (annotated vs hidden). `--connect` adds one
unauthenticated `GET <base-url>/2/openapi.json` to prove DNS/TLS/HTTP reachability — no
credentials, no billing.

## 4. Authentication and refresh

**`No stored OAuth tokens to refresh` / `No stored OAuth tokens were found`** — you never
completed `authorize`, or the server is looking at a different `X_MCP_TOKEN_FILE` than the
one `authorize` wrote. Compare `doctor` output with the path you authorized under, then run
`npx x-mcp-ai authorize` (or `node build/src/index.js authorize`).

**`Stored OAuth tokens could not be read (corrupt or unreadable token store)`** — the file
is damaged or unreadable. Re-run `authorize`; it rewrites the store atomically.

**`the authorization code was rejected (invalid_grant)`** during `authorize` — the code
expired or was already used. Re-run `authorize` and complete the browser step promptly.

**`invalid_client`** during `authorize` — the client credentials do not match the app.
Verify `X_MCP_CLIENT_ID` (and `X_MCP_CLIENT_SECRET`, if the app is a confidential client)
against the X developer portal.

**`the callback state did not match this run`** — a stale redirect URL from an earlier
attempt, or a genuine CSRF attempt. Re-run `authorize` and use the URL from *that* run. In
`--manual` mode paste the **entire** redirect URL, not just the code — a bare code is
rejected by design.

**Repeated `401` on tool calls, refresh not helping** — the refresh chain broke (rotation
lost, token revoked in the portal, or the app's scopes changed). Re-run `authorize`. If the
run warns that **no refresh token was issued**, the app is missing `offline.access` in its
allowed scopes — fix that first, or the server cannot stay authenticated past the access
token's lifetime.

**`scope` errors** — the token was minted without a scope the endpoint needs (typical after
adding new tool packages, or after re-scoping the app). Re-run `authorize` to mint a token
with the current scope set.

**A `<token-file>.lock` that will not go away** — refresh is single-flight through a lock
file. The stale-lock protocol is deliberately fail-closed: a lock is only reclaimed when it
is both older than 30 s **and** its recorded PID is provably gone. If a lock survives, the
server refuses to refresh rather than racing. Confirm no other `x-mcp-ai` process is
running, then remove the lock file manually and retry.

**Token file location** — defaults: `%APPDATA%\x-mcp\tokens.json` on Windows, otherwise
`$XDG_CONFIG_HOME/x-mcp/tokens.json` or `~/.config/x-mcp/tokens.json`. Created `0600` with
`O_NOFOLLOW`/`O_EXCL`. The config directory is `x-mcp` on every platform.

**App-only limits** — with `X_MCP_AUTH_MODE=app-only` there is no user. `x_auth_status`
returns a degraded shape, and every `user-only` tool (all writes, DMs, media, home
timeline) fails with an `auth` error. That is expected; switch to `oauth2` if you need them.

## 5. Rate limits

X enforces limits **per endpoint per 15-minute window**, separately for user and app
context; `POST /2/tweets` additionally carries a 24-hour app-level cap surfaced through
`x-app-limit-24hour-*` headers.

- The server tracks the headers per bucket. When a tracked window is exhausted and its
  reset is still in the future, the call is refused **locally** — no HTTP request is made,
  no credits are spent.
- The error is `kind: "rate-limit"`, `retryable: true`, and carries `reset_at` plus
  `retry_after_seconds`. The correct response is to wait, not to re-run immediately.
- `x_rate_limit_status` prints the known windows and costs nothing.
- Rate limits are *not* the credit budget. A rate-limit refusal costs $0; a budget refusal
  means you hit **your** spend cap.

## 6. Budget refusals

`kind: "budget"`, ending with *"This is an operator-set limit; cannot be changed from
within this session."* — `X_MCP_BUDGET_MODE=hard` refused a call that would push
`session_total_usd` past `X_MCP_CREDIT_BUDGET`.

- Raise `X_MCP_CREDIT_BUDGET` (operator-side only) and restart, or switch to
  `X_MCP_BUDGET_MODE=warn` to let calls through with a warning.
- The counter is per process and resets on restart — restarting the client clears it,
  which is a footgun as much as a fix.
- A `budget_warning` on successful results means you crossed 90% of the cap.
- If the spend surprised you, check for `x_post_create` calls with URLs in the text: those
  cost $0.20 instead of $0.015.

## 7. A tool is missing from `tools/list`

Three different mechanisms, in order of likelihood:

1. **`X_MCP_HIDE_DENIED=1`.** Policy-denied tools are dropped from registration entirely.
   Unset it and the tool reappears with `(disabled by policy <preset>)` appended to its
   description — that annotation is the fastest way to see *why*.
2. **DM tools.** `read:dm` / `write:dm` are in no preset, not even `full`. Without an
   explicit `X_MCP_POLICY_ALLOW=read:dm[,write:dm]` the four DM tools are denied (and
   hidden, if `X_MCP_HIDE_DENIED=1`).
3. **Availability class-gating.** `X_MCP_AVAILABILITY` gates only the specially-provisioned
   classes (`pilot`, `premium-user`, `enterprise`); such tools are absent from the listing
   entirely, not annotated. **No tool in the current surface uses those classes** — all 41
   are `app+user` or `user-only` and always register. So if a tool is missing today, it is
   (1) or (2), not this.

Distinguishing the two failure modes at call time: a **policy** denial returns
`kind: "policy"` naming the blocked cell; an absent tool returns an MCP "unknown tool"
error. Note that a denial on a **sensitive** cell (`*:dm`, `destructive:*`,
`*:social-graph`) deliberately does **not** tell the model which variable would unlock it —
that is by design, so the model cannot hand you an escalation recipe. Consult
[04-security.md](04-security.md) §3 for the cell → preset mapping.

## 8. Media upload refusals

`x_media_upload` is default-deny:

- **`X_MCP_MEDIA_DIR` unset** → every upload is refused. Set it to a directory you control.
- **File outside the root** → refused after `realpath` resolution, so symlinks pointing out
  of the root do not help.
- **Missing media dir** → `doctor` fails this check; create the directory.
- Media uploads go to the same API origin as everything else and are subject to the same
  timeout (`X_MCP_TIMEOUT_MS`); large files on a slow link may need a higher value.

## 9. Client-side problems

| Symptom | Likely cause |
|---|---|
| Server never appears in the client | Wrong absolute path in `args`, or the build was never run (`npm run build`). Try the exact `command`+`args` by hand in a terminal — it should sit waiting on stdin, not exit. |
| Appears, then immediately disconnects | A startup fatal. Read the client's MCP log for the `x-mcp-ai: fatal:` line. |
| "Failed to parse message" / protocol errors | Something is writing to stdout. Do not wrap the command in a script that echoes. |
| Tools listed but every call fails with `auth` | `authorize` was run with different env than the client passes (usually a different `X_MCP_TOKEN_FILE`, or the client does not inherit your shell env). |
| Works in the terminal, not in the client | GUI clients do not inherit your shell profile: `node` may not be on their `PATH` and your exported env is absent. Use an absolute path to `node` and put every `X_MCP_*` value in the client's `env` block. |
| Changes to env have no effect | The client caches the spawned server. Fully restart the client. |
| Windows path errors | Escape backslashes in JSON, or use forward slashes. |

When reporting a problem, include the `doctor` output (it is already secret-scrubbed), the
client name and version, and the `kind`/`message` of the failing tool result — never a
token.
