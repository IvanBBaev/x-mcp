// Token-store backend selector (CFG-1/CFG-2 + docs/02 §4). One question — "which store
// does this Config call for?" — asked identically by the serve path (mcp/compose) and by
// the `authorize` subcommand (index.ts). Keeping it in one place is what stops the two
// from drifting: an operator who authorized into the keychain must have the server read
// from the keychain, and a mismatch would look exactly like a lost token.
//
// The two backends are mutually exclusive by construction: `parseConfig` refuses
// `X_MCP_TOKEN_KEYCHAIN=1` together with an explicit `X_MCP_TOKEN_FILE`, and resolves no
// default token file at all in keychain mode.

import type { Clock, Sleep, TokenStore } from '../../core/ports.js';
import type { Config } from '../../core/config.js';
import { createFileTokenStore } from './filestore.js';
import { createKeychainTokenStore } from './keychain.js';

/**
 * Build the token store the configuration asks for, or `undefined` when the mode has
 * nothing to persist (app-only). Never falls back between backends: an unsupported
 * platform or an unusable identifier makes {@link createKeychainTokenStore} throw a typed
 * `auth` error here, at startup, rather than degrading to a store that would silently
 * forget a rotated refresh token.
 *
 * The keychain entry is filed under the ACTIVE PROFILE's name when there is one, so two
 * profiles on one machine cannot overwrite each other's token — the same separation the
 * file backend gets from distinct `token_file` paths.
 */
export function createConfiguredTokenStore(
  config: Config,
  clock: Clock,
  sleep: Sleep,
): TokenStore | undefined {
  if (config.authMode !== 'oauth2') return undefined;
  if (config.tokenKeychain) {
    return createKeychainTokenStore(
      config.profile !== undefined ? { account: config.profile.name } : {},
    );
  }
  if (config.tokenFile !== undefined) {
    return createFileTokenStore({ path: config.tokenFile, clock, sleep });
  }
  return undefined;
}
