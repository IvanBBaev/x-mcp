// Shared by the two manifest guards (scripts/server-json-guard.mjs for the MCP-registry
// `server.json`, scripts/mcpb-guard.mjs for the Claude Desktop `manifest.json`). Both
// advertise the same environment surface, so the rules that judge it — which variables the
// server reads, and which ones hold a credential — live here once instead of drifting apart.
// Node stdlib only. The reasoning behind the credential rule is in the header of
// scripts/server-json-guard.mjs.

/**
 * Head nouns that mean "this value IS a credential". Matched against the final
 * underscore-delimited segment of the variable name, by equality — never containment, which
 * is what keeps KEYCHAIN from being read as KEY.
 */
export const CREDENTIAL_HEADS = new Set([
  'SECRET',
  'SECRETS',
  'TOKEN',
  'TOKENS',
  'KEY',
  'KEYS',
  'APIKEY',
  'PASSWORD',
  'PASSWORDS',
  'PASSWD',
  'PASSPHRASE',
  'CREDENTIAL',
  'CREDENTIALS',
  'COOKIE',
  'PAT',
]);

/** True when the name's head noun is a credential noun. */
export function isCredentialName(name) {
  const segments = name.split('_');
  return CREDENTIAL_HEADS.has(segments[segments.length - 1]);
}

/** The head noun of a variable name, for messages. */
export function headNoun(name) {
  return name.split('_').pop();
}

/**
 * The set of variables `src/core/config.ts` recognizes, read out of its `KNOWN_VARS` literal —
 * the same list that drives the CFG-8 unknown-variable warning, so membership here is exactly
 * "the server reacts to this name". Parsed from source rather than imported because the
 * constant is module-private, and a public export existing only for the guards would be worse.
 * Returns null when the anchor is gone, so a guard can fail instead of quietly checking less.
 */
export function knownVars(source) {
  const block = /const KNOWN_VARS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source);
  if (block === null) return null;
  return new Set([...block[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]));
}
