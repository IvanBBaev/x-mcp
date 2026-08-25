// Credential-egress allowlist (docs/04 T10 §4.4) — owned by T-320's F1 correction.
//
// The single hardcoded answer to one question: "may an X account credential travel to this
// host?" It is deliberately INDEPENDENT of `X_MCP_BASE_URL`. The base-URL rules in
// core/config decide *where requests go*; this list decides *where credentials go*, and
// `X_MCP_ALLOW_INSECURE_BASE_URL` relaxes only the former. Without that split the control
// is circular — the operator-supplied origin would be scoping the credential to itself,
// which is precisely the confused-deputy vector T10 names first.
//
// Two independent layers consult it, so neither is a single point of failure:
//   1. api/http `shouldAttachAuth` — the request-time header decision (bearer / access token).
//   2. core/config — refuses an OAuth2 session whose token endpoint would fall outside the
//      list, because the refresh POST and the `authorize` code exchange carry the refresh
//      token and the PKCE verifier to whatever host the base URL names.
// An app-only session against a non-x.com base URL is still allowed to start: it simply
// sends no credential (useful against a local mock, and harmless to the account).

/** The only registrable domain that may ever receive an X account credential. */
export const CREDENTIAL_DOMAIN = 'x.com';

/**
 * True when `url` is a host this server may send a credential to: HTTPS, and either the
 * credential domain itself or one of its subdomains (`api.x.com`, `upload.x.com`, …).
 *
 * The suffix test is anchored on a leading dot, so the classic look-alike
 * `api.x.com.evil.example` fails — and plaintext fails regardless of host, so a downgraded
 * scheme can never carry the token either.
 */
export function isCredentialEgressHost(url: URL): boolean {
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === CREDENTIAL_DOMAIN || host.endsWith(`.${CREDENTIAL_DOMAIN}`);
}
