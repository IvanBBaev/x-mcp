# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for anything
exploitable.

- Preferred: open a [GitHub private security advisory](https://github.com/IvanBBaev/x-mcp-ai/security/advisories/new).
- Alternative: email **ivanbbaev@gmail.com** with `x-mcp-ai security` in the subject.

Include the version, your configuration (auth mode and policy preset), and the minimal steps to
reproduce. You will get an acknowledgement, and fixes for confirmed issues are released as
promptly as a single-maintainer project allows. This is pre-1.0 software distributed under the
MIT License with no warranty; there is no formal SLA.

## Security model (summary)

x-mcp-ai gives an LLM agent write access to a real, billed social-media account, so it is
designed defensively. The full threat model (T1–T17) lives in
[`docs/04-security.md`](docs/04-security.md); the load-bearing controls are:

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
