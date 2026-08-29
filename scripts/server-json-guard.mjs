// MCP-registry manifest guard (WP-0.8, the 1.0 acceptance checklist in docs/08 §9).
// Companion to scripts/docs-gen.mjs, scripts/context-gate.mjs and scripts/coverage-guard.mjs
// — same house style: Node stdlib only, `process.stdout.write` for output, a non-zero exit on
// a real finding.
//
//   node scripts/server-json-guard.mjs
//
// WHY. `server.json` is the manifest the MCP registry publishes from, and it duplicates facts
// that live elsewhere in the repo: the package version, the npm package name, and the set of
// environment variables an operator is told to set. Duplicated facts drift. A stale version
// makes `mcp-publish` reject the release (or, worse, publishes a manifest pointing at a
// version that was never cut); a typo'd env var sends operators to a name the server does not
// read, and the CFG-8 unknown-variable warning is the only symptom. None of that is covered by
// the type checker or the test suite, because `server.json` is data no TypeScript file imports.
//
// WHAT IS CHECKED
//
//   1. Version lockstep — `server.json` `version`, `packages[0].version` and `package.json`
//      `version` are one number written three times.
//   2. Identity lockstep — `packages[0].identifier` is the npm package name, and the manifest
//      `name` matches `package.json` `mcpName` (npm's own registry validation compares those
//      two; a mismatch fails at publish time, which is the worst moment to find out).
//   3. Transport shape — `stdio` with the `npx` runtime hint, from an `npm` registry package.
//      This server has no HTTP transport (MCP-2); a manifest promising one would be a lie.
//   4. Secret marking — every credential-bearing variable carries `"isSecret": true`, so hosts
//      mask it instead of echoing it into a log or a shared config UI. See below.
//   5. Reachability — every variable the manifest advertises is one `src/core/config.ts`
//      actually recognizes. The converse is deliberately NOT asserted: the manifest is a
//      curated discovery aid for operators, not an exhaustive table of every knob (the full
//      table is docs/02 §4), so vars like `X_MCP_LOG_LEVEL` may legitimately be omitted.
//   6. Description length — the registry caps `description` at 100 and rejects the publish
//      with HTTP 422 `expected length <= 100` past that. The v0.8.0 backfill found out in
//      the pipeline; this guard fails before the pipeline can.
//
// THE SECRET RULE, AND WHY IT IS NOT A SUBSTRING MATCH. The obvious rule — "the name contains
// TOKEN, KEY or SECRET" — is wrong here, and wrong in a way that would have to be silenced
// with exceptions the moment it is written: `X_MCP_TOKEN_FILE` is a path and
// `X_MCP_TOKEN_KEYCHAIN` is a backend selector flag, and marking either one secret would hide
// from the operator the very value they need to see to diagnose a token-store problem.
//
// The rule used instead is grammatical rather than a name list. In an English compound noun
// the LAST word is the head — the thing itself — and everything before it is a qualifier. So a
// variable holds a credential exactly when the head of its name IS a credential noun:
//
//     X_MCP_CLIENT_SECRET   head SECRET     -> a secret            -> must be marked
//     X_MCP_BEARER_TOKEN    head TOKEN      -> a token             -> must be marked
//     X_MCP_TOKEN_FILE      head FILE       -> a file (of tokens)  -> must NOT be marked
//     X_MCP_TOKEN_KEYCHAIN  head KEYCHAIN   -> a keychain          -> must NOT be marked
//     X_MCP_CLIENT_ID       head ID         -> an identifier       -> must NOT be marked
//
// Nothing is allowlisted: the two exclusions above fall out of the grammar, and so does any
// future `*_PATH`, `*_DIR` or `*_MODE`. Conversely a future `X_MCP_API_KEY`, `X_MCP_APP_SECRET`
// or `X_MCP_WEBHOOK_TOKEN` fails this guard on the day it is added unless the flag is set.
// Segments are compared for EQUALITY, never containment, which is what keeps KEYCHAIN from
// being read as KEY. The head-noun set is the only thing to extend if a new credential shape
// appears.
//
// Over-marking (a non-credential variable flagged secret) is reported as a warning rather than
// a failure: hiding a value the operator could have seen is a usability cost, not a leak, and
// the deliberate case — a name whose head noun this list has not learned yet — should not
// break the build. Under-marking is the security bug, and that fails.

import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

const REPO = new URL('../', import.meta.url);

const MANIFEST = 'server.json';
const MANIFEST_PACKAGE = 'package.json';
const CONFIG = 'src/core/config.ts';

/**
 * Head nouns that mean "this value IS a credential". Matched against the final
 * underscore-delimited segment of the variable name, by equality — see the header.
 */
const CREDENTIAL_HEADS = new Set([
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

/**
 * The registry's hard cap on the manifest description, learned the honest way: the v0.8.0
 * backfill publish came back HTTP 422 `expected length <= 100` for a 155-character
 * description. Measured here in UTF-8 bytes — the strictest reading of "length" — so a
 * multi-byte character cannot pass a code-point count locally and still trip the registry.
 */
const MAX_DESCRIPTION_BYTES = 100;

/** The transport shape this server actually implements (MCP-2). */
const EXPECTED_TRANSPORT = 'stdio';
const EXPECTED_RUNTIME_HINT = 'npx';
const EXPECTED_REGISTRY_TYPE = 'npm';

// --- Repo access --------------------------------------------------------------------------

function readRepoFile(relative) {
  return fs.readFileSync(new URL(relative, REPO), 'utf8');
}

function readJson(relative) {
  try {
    return JSON.parse(readRepoFile(relative));
  } catch (error) {
    process.stderr.write(
      `server-json-guard: cannot read ${relative}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  }
}

/**
 * The set of variables `src/core/config.ts` recognizes, read out of its `KNOWN_VARS` literal —
 * the same list that drives the CFG-8 unknown-variable warning, so membership here is exactly
 * "the server reacts to this name". Parsed from source rather than imported because the
 * constant is module-private, and a public export existing only for this guard would be worse.
 */
function knownVars(source) {
  const block = /const KNOWN_VARS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source);
  if (block === null) return null;
  return new Set([...block[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]));
}

/** True when the name's head noun is a credential noun — the rule documented in the header. */
function isCredentialName(name) {
  const segments = name.split('_');
  return CREDENTIAL_HEADS.has(segments[segments.length - 1]);
}

// --- Checks -------------------------------------------------------------------------------

function checkLockstep(findings, manifest, pkg, entry) {
  const versions = [
    [`${MANIFEST} version`, manifest.version],
    [`${MANIFEST} packages[0].version`, entry?.version],
    [`${MANIFEST_PACKAGE} version`, pkg.version],
  ];
  const distinct = new Set(versions.map(([, value]) => value));
  if (distinct.size !== 1) {
    findings.push(
      `version is not in lockstep: ${versions.map(([label, value]) => `${label}=${value ?? '(missing)'}`).join(', ')}`,
    );
  }

  if (entry?.identifier !== pkg.name) {
    findings.push(
      `${MANIFEST} packages[0].identifier is "${entry?.identifier ?? '(missing)'}", ` +
        `the npm package is "${pkg.name}"`,
    );
  }
  if (manifest.name !== pkg.mcpName) {
    findings.push(
      `${MANIFEST} name is "${manifest.name ?? '(missing)'}", ` +
        `${MANIFEST_PACKAGE} mcpName is "${pkg.mcpName ?? '(missing)'}" — npm rejects the ` +
        `publish when those disagree`,
    );
  }
}

function checkDescription(findings, manifest) {
  const description = manifest.description;
  if (typeof description !== 'string' || description.trim().length === 0) {
    findings.push(`${MANIFEST} has no description — the registry listing would say nothing`);
    return;
  }
  const bytes = Buffer.byteLength(description, 'utf8');
  if (bytes > MAX_DESCRIPTION_BYTES) {
    findings.push(
      `${MANIFEST} description is ${bytes} bytes, the MCP Registry rejects anything over ` +
        `${MAX_DESCRIPTION_BYTES} (HTTP 422 "expected length <= 100")`,
    );
  }
}

function checkTransport(findings, entry) {
  if (entry?.transport?.type !== EXPECTED_TRANSPORT) {
    findings.push(
      `${MANIFEST} packages[0].transport.type is "${entry?.transport?.type ?? '(missing)'}", ` +
        `this server only speaks "${EXPECTED_TRANSPORT}"`,
    );
  }
  if (entry?.runtimeHint !== EXPECTED_RUNTIME_HINT) {
    findings.push(
      `${MANIFEST} packages[0].runtimeHint is "${entry?.runtimeHint ?? '(missing)'}", ` +
        `expected "${EXPECTED_RUNTIME_HINT}"`,
    );
  }
  if (entry?.registryType !== EXPECTED_REGISTRY_TYPE) {
    findings.push(
      `${MANIFEST} packages[0].registryType is "${entry?.registryType ?? '(missing)'}", ` +
        `expected "${EXPECTED_REGISTRY_TYPE}"`,
    );
  }
}

function checkEnvironment(findings, warnings, entry, recognized) {
  const vars = entry?.environmentVariables ?? [];
  if (vars.length === 0) {
    findings.push(`${MANIFEST} lists no environment variables — the operator has nothing to set`);
    return vars;
  }

  const seen = new Set();
  for (const variable of vars) {
    const name = variable?.name;
    if (typeof name !== 'string' || name.length === 0) {
      findings.push(`${MANIFEST} has an environment variable with no name`);
      continue;
    }
    if (seen.has(name)) findings.push(`${MANIFEST} lists ${name} twice`);
    seen.add(name);

    if (typeof variable.description !== 'string' || variable.description.trim().length === 0) {
      findings.push(`${MANIFEST}: ${name} has no description`);
    }

    const credential = isCredentialName(name);
    if (credential && variable.isSecret !== true) {
      findings.push(
        `${MANIFEST}: ${name} names a credential (head noun ` +
          `"${name.split('_').pop()}") but is not marked "isSecret": true — hosts will echo it`,
      );
    }
    if (!credential && variable.isSecret === true) {
      warnings.push(
        `${MANIFEST}: ${name} is marked secret but its head noun ` +
          `"${name.split('_').pop()}" is not a credential noun — either the marking is ` +
          `over-cautious or CREDENTIAL_HEADS in this guard needs the noun added`,
      );
    }

    if (recognized === null) continue;
    if (!recognized.has(name)) {
      findings.push(
        `${MANIFEST}: ${name} is not recognized by ${CONFIG} — an operator who sets it gets ` +
          `the CFG-8 "unknown variable" warning and no effect`,
      );
    }
  }
  return vars;
}

// --- Main -----------------------------------------------------------------------------------

function main() {
  const manifest = readJson(MANIFEST);
  const pkg = readJson(MANIFEST_PACKAGE);
  const entry = Array.isArray(manifest.packages) ? manifest.packages[0] : undefined;

  const findings = [];
  const warnings = [];

  if (entry === undefined) {
    findings.push(`${MANIFEST} has no packages[0] entry — nothing to publish`);
  }

  const recognized = knownVars(readRepoFile(CONFIG));
  if (recognized === null) {
    // Same stance as the docs gate: a check that quietly stops checking is worse than none.
    findings.push(
      `cannot find the KNOWN_VARS set in ${CONFIG} — this guard can no longer verify that the ` +
        `advertised variables are read; fix the anchor or this check`,
    );
  }

  checkLockstep(findings, manifest, pkg, entry);
  checkDescription(findings, manifest);
  checkTransport(findings, entry);
  const vars = checkEnvironment(findings, warnings, entry, recognized);

  for (const warning of warnings) process.stdout.write(`server-json-guard: warning: ${warning}\n`);

  if (findings.length > 0) {
    process.stderr.write(`server-json-guard: FAIL — ${findings.length} finding(s)\n\n`);
    for (const finding of findings) process.stderr.write(`  ${finding}\n`);
    process.stderr.write('\n');
    return 1;
  }

  const secrets = vars.filter((variable) => variable.isSecret === true).length;
  process.stdout.write(
    `server-json-guard: PASS — v${manifest.version} in lockstep, ` +
      `${EXPECTED_TRANSPORT}/${EXPECTED_RUNTIME_HINT} transport, ` +
      `${vars.length} env var(s) all read by ${CONFIG} (${secrets} marked secret)\n`,
  );
  return 0;
}

process.exit(main());
