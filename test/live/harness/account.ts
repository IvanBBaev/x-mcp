// The dedicated-account check (docs/05 §6: "Live writes only against the dedicated test
// account — never a personal account"). Owned by the live-test slice.
//
// §6 states that as prose. Prose does not stop a `POST /2/tweets` from landing on someone's
// real timeline, so it is a CHECK here instead:
//
//   * the operator DECLARES the handle the run may touch, in `X_MCP_LIVE_ACCOUNT`;
//   * the run ASKS the X API who the stored token actually belongs to, through the shipped
//     pipeline — `x_user_get {users:['me']}`, which resolves the `me` sentinel against
//     `GET /2/users/me`. (`x_auth_status` cannot answer it: mcp/session omits `me` from the
//     snapshot and the tool only enriches an existing one, so its `me` block never appears.)
//   * the two are compared, and the write tier refuses unless they match.
//
// Refusal is the default in every ambiguous case: no declared handle, no reported handle, a
// blank handle, a mismatch. There is deliberately no "assume it is fine" branch — the cost
// of a false refusal is a puzzled operator, the cost of a false acceptance is a public post
// from the wrong account.
//
// Comparison is case-insensitive and `@`-insensitive because X handles are, and because an
// operator who writes `@MyTestbed` in a shell profile means the same account the API calls
// `mytestbed`. Nothing else is normalized — no fuzzy matching, no prefix matching.

import { normalizeHandle } from './gate.js';

/** The outcome of the check. `reason` explains BOTH verdicts, so it can always be printed. */
export interface AccountVerdict {
  readonly ok: boolean;
  readonly reason: string;
  /** The normalized handle the run is cleared to touch — only set when `ok`. */
  readonly handle?: string;
}

/**
 * Compare the declared handle (`X_MCP_LIVE_ACCOUNT`) with the handle the X API reports for
 * the authenticated user. Pure — the caller performs the lookup.
 */
export function checkDedicatedAccount(
  declared: string | undefined,
  reported: string | undefined,
): AccountVerdict {
  const want = normalizeHandle(declared);
  const got = normalizeHandle(reported);

  if (want === undefined) {
    return {
      ok: false,
      reason:
        'X_MCP_LIVE_ACCOUNT is not set — the live write tier refuses to post until the ' +
        'operator names the dedicated test account it may touch (docs/05 §6).',
    };
  }
  if (got === undefined) {
    return {
      ok: false,
      reason:
        `X_MCP_LIVE_ACCOUNT is @${want}, but the X API reported no handle for the stored ` +
        'credentials, so the target account could not be verified. Refusing to write. Check ' +
        'that the token has the `users.read` scope and re-run `npx x-mcp-ai authorize`.',
    };
  }
  if (want !== got) {
    return {
      ok: false,
      reason:
        `refusing to write: X_MCP_LIVE_ACCOUNT declares @${want}, but the stored credentials ` +
        `belong to @${got}. The live suite posts and deletes real content — point it at the ` +
        'dedicated test account, never a personal one (docs/05 §6).',
    };
  }
  return { ok: true, reason: `verified: the stored credentials belong to @${got}`, handle: got };
}

/** Throwing form of {@link checkDedicatedAccount}, for use at the top of a write test. */
export function assertDedicatedAccount(
  declared: string | undefined,
  reported: string | undefined,
): string {
  const verdict = checkDedicatedAccount(declared, reported);
  if (!verdict.ok || verdict.handle === undefined) throw new Error(verdict.reason);
  return verdict.handle;
}
