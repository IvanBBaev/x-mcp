# Security Policy

x-mcp-ai gives an LLM agent write access to a real, billed social-media account, so security
reports are taken seriously and handled with priority over feature work. This page tells you
what is supported, how to report privately, what is in scope, and what to expect in return.

## Supported versions

x-mcp-ai is pre-1.0. Only the **latest published 0.x release** receives security fixes; there
are no backports to earlier 0.x versions — the fix for a confirmed issue ships as the next 0.x
release, and the remediation is always "upgrade to latest".

| Version              | Supported          |
| -------------------- | ------------------ |
| latest 0.x release   | ✅ security fixes  |
| older 0.x releases   | ❌ upgrade instead |
| unreleased `main`    | ❌ not supported   |

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue, discussion, or pull
request for anything exploitable.

- Use **GitHub private vulnerability reporting**: on this repository, open the **Security**
  tab and choose **Report a vulnerability** (GitHub Security Advisories). The report is
  visible only to you and the maintainer until a fix is coordinated.
- There is **no security email address** for this project — the private advisory flow above
  is the only reporting channel.

A useful report includes: the x-mcp-ai version, Node version and OS, the auth mode
(`oauth2` / `app-only`) and policy preset in effect, minimal steps to reproduce, and the
impact you believe it has (which asset from the threat model is affected). **Never include
tokens, bearer values, client secrets, or token-file contents in a report** — redact them.

## Response expectations

This is a solo-maintainer project distributed under the MIT License with no warranty; response
is **best-effort and there is no formal SLA**. As a working expectation:

- **Acknowledgement** within a few days of the advisory being opened.
- **Triage verdict** (accepted / declined / needs info) typically within two weeks.
- **Fix** for confirmed issues released as promptly as a single maintainer allows, as a new
  0.x release; the advisory is published after the fix ships, with credit to the reporter
  unless you prefer otherwise.

Please practice coordinated disclosure: give the fix a chance to ship before publishing
details publicly.

## Scope

The full threat model (T1–T17) lives in [`docs/04-security.md`](docs/04-security.md); reports
are triaged against it. Terminology below matches that document.

**In scope** — anything that defeats a control the design promises:

- **Token custody.** Token or profiles file written with wide permissions, symlink/TOCTOU on
  the token store, refresh-rotation races that lock out the account, or token/secret material
  leaking into tool results, logs, or error objects (T1–T3, T13, T16, §6).
- **Bearer-token exfiltration / confused deputy.** The `Authorization` header attached to a
  host outside the `api.x.com` / `upload.x.com` allowlist, or a redirect followed on a
  token-bearing request (T8, T10, §4.4).
- **Policy bypass.** Any way to execute a tool whose `operation:domain` cell the resolved
  policy denies — including deny not beating allow, preset resolution errors, or a policy
  error leaking the unlock hint for a sensitive cell (`dm`, `destructive:*`, `social-graph`)
  (T4, §3).
- **Media-upload containment escape.** A path that escapes `X_MCP_MEDIA_DIR` via `../`
  traversal, symlinks, or a TOCTOU swap between sniff and upload (T9, §7).
- **Authorize-flow weaknesses.** Missing/unvalidated `state`, a listener reachable beyond
  `127.0.0.1`, code or verifier echoed to logs/argv/browser, multi-use codes (T12, §4.3).
- **Prompt injection via rendered third-party content, where a server-side control fails**
  — smuggling code points (zero-width, bidi overrides) surviving ingest stripping,
  third-party text interpolated into error messages or logs, missing untrusted-content
  marking, or an injection that yields any of the bypasses above (T14, §5).
- **Budget bypass.** Any way for the model to raise or disable the operator-set credit
  budget (T7).
- **Supply chain.** Anything wrong with the published artifact itself — an install script that
  should not be there, a tarball whose contents do not match the tagged source, a broken
  provenance attestation, or a typosquat package impersonating `x-mcp-ai` (T15).

**Out of scope:**

- The model **following injected instructions within cells the operator granted** — the
  untrusted-content marking of §5 is a signal, not a semantic filter, and the policy model is
  the stated control (Scenario A residual risk in docs/04).
- Vulnerabilities in the X API platform, in MCP clients, or in co-resident MCP servers
  (T11) — report those to their owners.
- Issues that require the operator to ignore the documented hardening checklist (e.g. a
  world-readable token directory, which the server already warns about or refuses).
- Denial of service against your own session, and cost overruns that the configuration never
  promised to prevent — `X_MCP_BUDGET_MODE=warn` is the documented default and warns rather
  than refuses, and no cap exists at all until `X_MCP_CREDIT_BUDGET` is set. Enforcement
  failing under `hard` with a cap set **is** in scope (see "Budget bypass" above).

## Safe harbor

Security research conducted in good faith — using only accounts and machines you own or have
permission to test, making a genuine effort to avoid privacy violations and service
disruption, and reporting through the private channel above — is considered authorized, and
the maintainer will not pursue or support legal action against you for it.

## Security model (summary)

The full design contract is [`docs/04-security.md`](docs/04-security.md); the load-bearing
controls are:

- **Two-axis policy is the real control.** Every tool maps to an `operation:domain` cell.
  Writes are opt-in; `deny` beats `allow` beats preset. This — not text filtering — is the
  primary defense against prompt injection reaching a write.
- **Direct messages are double-locked.** `read:dm` and `write:dm` belong to **no** preset, not
  even `full`, and must be granted explicitly. Their unlock hint is withheld from policy errors
  so a compromised model cannot learn how to self-escalate.
- **Host-scoped credentials (confused-deputy defense).** The `Authorization` header is attached
  only for the API allowlist (`api.x.com`, `upload.x.com`), and redirects are never followed on
  token-bearing requests, so a token cannot leak to a look-alike host.
- **Hardened token storage.** The OAuth 2.0 token file is created `0600` with
  `O_NOFOLLOW`/`O_EXCL`; refresh is single-flight with reload-under-lock and fails closed on a
  refresh error rather than falling back to a stale token.
- **Untrusted-content marking.** Post and user text returned to the model is marked as
  untrusted. Marking is a signal, **not** a semantic filter — the policy model is what actually
  contains a hostile instruction embedded in fetched content.
- **Media default-deny.** Uploads are refused unless the source file `realpath`s inside
  `X_MCP_MEDIA_DIR`, preventing an agent from exfiltrating arbitrary local files as media.
- **Operator-immutable cost budget.** `X_MCP_CREDIT_BUDGET` / `X_MCP_BUDGET_MODE` are set by
  the operator via environment; the model cannot raise or disable them, and every result
  reports `cost_usd` and the running session total.

## Hardened defaults

Out of the box, with no extra configuration, the server:

- starts on the **`read-only`** policy preset (no writes possible);
- runs in **`oauth2`** mode (public PKCE client; no long-lived secret required);
- keeps the credit budget in **`warn`** mode until an operator opts into `hard`;
- refuses **media uploads** (no `X_MCP_MEDIA_DIR` set);
- requires **HTTPS** for the API base (`X_MCP_ALLOW_INSECURE_BASE_URL=0`).

Recommended for production, from the operator checklist in [`docs/04-security.md`](docs/04-security.md) §8:
create a dedicated public OAuth client, keep the narrowest preset that works, use one profile
per purpose, keep the token file on local disk (avoid cloud-sync folders), pin the published
version and install with `--ignore-scripts`, set `X_MCP_BUDGET_MODE=hard` with a real budget,
and do not run the `full` policy alongside untrusted MCP servers in the same client.

## Trademark

x-mcp-ai is an independent, unofficial project and is not affiliated with, endorsed by, or
sponsored by X Corp. "X", "Twitter", and related marks are trademarks of X Corp, used
nominatively only to describe interoperability with the X API.
