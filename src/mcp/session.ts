// The concrete AuthSessionProvider for the auth/session tools (T-130, INT-6). Derives the
// per-session snapshot from the validated Config plus the resolved policy — no I/O, built
// once at composition time (both inputs are frozen for the process lifetime).

import { DEFAULT_BASE_URL } from '../core/config.js';
import type { Config } from '../core/config.js';
import { isCellAllowed } from '../core/policy.js';
import type { ResolvedPolicy } from '../core/policy.js';
import { POLICY_CELLS } from '../core/tooldef.js';
import type { AuthSessionInfo, AuthSessionProvider, TokenStoreKind } from '../tools/auth.js';

/**
 * Build the session snapshot `x_auth_status` reports (INT-6):
 *
 *  - `authMode`  — `app-only` for a bearer-only process, `user` otherwise.
 *  - `policy`    — the full 12-cell allow matrix from the resolved policy (POL-1).
 *  - `availability` — the operator-declared surfaces (`X_MCP_AVAILABILITY`).
 *  - `scopes`    — empty by design (T-203 resolution): the persisted token file schema
 *    v1 (T-202) and the frozen `TokenPair` port carry NO granted-scopes field — the
 *    `authorize` flow prints the grant but never persists it — so there is nothing to
 *    read here without inventing a schema change. Revisit if a schema v2 adds scopes.
 *  - `me`        — omitted for the same reason (no identity in the store either); in
 *    user mode `x_auth_status` then falls back to its best-effort `GET /2/users/me`
 *    (AUTH-15), which reports live scopes/identity better than a stale snapshot could.
 *  - `tokenStore` — the credential BACKEND, derived from config alone (see
 *    {@link tokenStoreOf}); no path, no permission bits, no `stat` (T-320 F10).
 *  - `baseUrlOverride` — the non-default API host, when there is one (CFG-7). The startup
 *    banner is the operator's half of that notice; this is the agent's half.
 */
export function createSessionProvider(config: Config, policy: ResolvedPolicy): AuthSessionProvider {
  const cells: Record<string, boolean> = {};
  for (const cell of POLICY_CELLS) cells[cell] = isCellAllowed(policy, cell);

  const snapshot: AuthSessionInfo = {
    authMode: config.authMode === 'app-only' ? 'app-only' : 'user',
    scopes: [],
    availability: config.availability,
    policy: { preset: policy.preset, cells },
    tokenStore: tokenStoreOf(config),
    ...(config.baseUrl !== DEFAULT_BASE_URL ? { baseUrlOverride: config.baseUrl } : {}),
  };
  return { snapshot: () => snapshot };
}

/**
 * Which credential backend this process is running on.
 *
 * The order matters and mirrors `resolveTokenFile` in core/config: `X_MCP_TOKEN_KEYCHAIN=1`
 * wins outright (config refuses to also resolve a token file under it), and `tokenFile` is
 * only ever populated for `oauth2`. Anything else means the credential came in on the
 * environment — the app-only bearer — which is `env`, not "no store": that distinction is
 * the whole of threat T17, so the report names it rather than leaving a blank.
 */
function tokenStoreOf(config: Config): TokenStoreKind {
  if (config.tokenKeychain) return 'keychain';
  return config.tokenFile !== undefined ? 'file' : 'env';
}
