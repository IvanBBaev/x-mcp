// Claude Desktop bundle manifest guard (`manifest.json`, docs/08 Phase 4). Companion to
// scripts/server-json-guard.mjs — same house style: `process.stdout.write` for output, a
// non-zero exit on a real finding. It runs in `npm run gates` and before every `npm run bundle`.
//
//   node scripts/mcpb-guard.mjs
//
// WHY. `manifest.json` is the third copy of facts the repo already states twice — the version
// (package.json, server.json), the identity, and the environment surface an operator can set.
// It is data nothing imports, so neither tsc nor the test suite notices when it drifts, and a
// stale bundle manifest only shows up as a Desktop install that asks for the wrong settings.
//
// WHAT IS CHECKED
//
//   1. Spec — the manifest parses under the official strict MCPB 0.3 schema
//      (`MANIFEST_SCHEMAS['0.3']` from the `@anthropic-ai/mcpb` devDependency, the same zod
//      schema `mcpb validate` uses), and `manifest_version` is pinned to "0.3", the version
//      MANIFEST.md documents as current.
//   2. Lockstep — `version` equals package.json and server.json; `name` and `license` equal
//      package.json; `description` equals server.json (the one curated short description);
//      `repository.url` is the package.json repository; the Node runtime floor is the
//      package.json `engines.node` floor.
//   3. Server shape — a `node` server whose `entry_point` exists and is exactly what
//      `mcp_config` launches: `node ${__dirname}/<entry_point>`, no platform overrides.
//   4. Environment surface — the `mcp_config.env` key set equals the server.json variable set,
//      every key is a variable `src/core/config.ts` recognizes, and every value is exactly one
//      `${user_config.<key>}` reference to a declared option. Every option is referenced once,
//      is not `required`, and defaults to "" (see below).
//   5. Secret marking — an option is `sensitive` exactly when the variable it feeds is a
//      credential under the head-noun rule shared with server-json-guard
//      (scripts/lib/env-surface.mjs): an unmarked credential fails, a marked non-credential
//      only warns, as in server-json-guard.
//   6. Substitution — the manifest is run through `getMcpConfigForManifest` (the host-side
//      substitution the MCPB toolkit ships) with no user values, and every variable must come
//      out as "" with no `${…}` left behind.
//
// WHY EVERY OPTION DEFAULTS TO "". A host substitutes `${user_config.x}` from the user's value,
// else the option's `default`; with neither, the reference is left in place as literal text.
// So an option without a default would reach the server as the string "${user_config.policy}"
// — an invalid preset, a refused start. With `default: ""` an untouched setting arrives as an
// empty variable, which src/core/config.ts already reads as "unset", so the server's own
// defaults (and a selected profile's values) apply exactly as in an npx install. The flags
// (`X_MCP_HIDE_DENIED`, …) stay string options for the same reason: a boolean option would be
// substituted as "true"/"false", which the server's `0|1` flags reject.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

import { MANIFEST_SCHEMAS, getMcpConfigForManifest } from '@anthropic-ai/mcpb/node';

import { headNoun, isCredentialName, knownVars } from './lib/env-surface.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MANIFEST_VERSION = '0.3';
const REF = /^\$\{user_config\.([A-Za-z0-9_]+)\}$/;

const failures = [];
const warnings = [];
const fail = (message) => failures.push(message);

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

/** `git+https://host/owner/repo.git` → `https://host/owner/repo`. */
function normalizeRepoUrl(url) {
  return String(url)
    .replace(/^git\+/, '')
    .replace(/\.git$/, '');
}

/** The major version of a `>=N[.x.y]` range, or null. */
function floorMajor(range) {
  const match = /^>=\s*(\d+)(?:\.\d+){0,2}$/.exec(String(range ?? '').trim());
  return match === null ? null : Number(match[1]);
}

async function main() {
  const manifest = readJson('manifest.json');
  const pkg = readJson('package.json');
  const serverJson = readJson('server.json');
  const known = knownVars(fs.readFileSync(path.join(ROOT, 'src/core/config.ts'), 'utf8'));
  if (known === null) fail('could not find the KNOWN_VARS literal in src/core/config.ts');

  // 1. Spec.
  if (manifest.manifest_version !== MANIFEST_VERSION) {
    fail(
      `manifest_version is ${JSON.stringify(manifest.manifest_version)}, expected "${MANIFEST_VERSION}"`,
    );
  }
  const parsed = MANIFEST_SCHEMAS[MANIFEST_VERSION].safeParse(manifest);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      fail(`schema: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
  }

  // 2. Lockstep.
  if (manifest.version !== pkg.version) {
    fail(`version ${manifest.version} != package.json ${pkg.version}`);
  }
  if (manifest.version !== serverJson.version) {
    fail(`version ${manifest.version} != server.json ${serverJson.version}`);
  }
  if (manifest.name !== pkg.name) fail(`name ${manifest.name} != package.json ${pkg.name}`);
  if (manifest.license !== pkg.license) {
    fail(`license ${manifest.license} != package.json ${pkg.license}`);
  }
  if (manifest.description !== serverJson.description) {
    fail('description differs from server.json description');
  }
  if (manifest.repository?.url !== normalizeRepoUrl(pkg.repository?.url)) {
    fail(`repository.url ${manifest.repository?.url} != package.json ${pkg.repository?.url}`);
  }
  const engineFloor = floorMajor(pkg.engines?.node);
  const runtimeFloor = floorMajor(manifest.compatibility?.runtimes?.node);
  if (engineFloor === null || runtimeFloor !== engineFloor) {
    fail(
      `compatibility.runtimes.node ${manifest.compatibility?.runtimes?.node} does not match ` +
        `package.json engines.node ${pkg.engines?.node}`,
    );
  }

  // 3. Server shape.
  const server = manifest.server ?? {};
  const config = server.mcp_config ?? {};
  if (server.type !== 'node') fail(`server.type is ${server.type}, expected node`);
  if (
    typeof server.entry_point !== 'string' ||
    !fs.existsSync(path.join(ROOT, server.entry_point))
  ) {
    fail(`server.entry_point ${server.entry_point} does not exist`);
  }
  if (config.command !== 'node') fail(`mcp_config.command is ${config.command}, expected node`);
  const expectedArgs = [`\${__dirname}/${server.entry_point}`];
  if (JSON.stringify(config.args) !== JSON.stringify(expectedArgs)) {
    fail(`mcp_config.args must be ${JSON.stringify(expectedArgs)}`);
  }
  if (config.platform_overrides !== undefined) {
    fail('mcp_config.platform_overrides is not expected; the entry point is portable');
  }

  // 4. Environment surface.
  const env = config.env ?? {};
  const options = manifest.user_config ?? {};
  const registryVars = new Set(
    (serverJson.packages?.[0]?.environmentVariables ?? []).map((variable) => variable.name),
  );
  for (const name of registryVars) {
    if (!(name in env)) fail(`${name} is in server.json but not in mcp_config.env`);
  }
  const referenced = new Map();
  for (const [name, value] of Object.entries(env)) {
    if (!registryVars.has(name)) fail(`${name} is in mcp_config.env but not in server.json`);
    if (known !== null && !known.has(name)) {
      fail(`${name} is not a variable src/core/config.ts recognizes`);
    }
    const ref = REF.exec(String(value));
    if (ref === null) {
      fail(
        `${name} must be exactly one \${user_config.<key>} reference, got ${JSON.stringify(value)}`,
      );
      continue;
    }
    const key = ref[1];
    if (!(key in options)) fail(`${name} references undeclared user_config.${key}`);
    if (referenced.has(key))
      fail(`user_config.${key} feeds both ${referenced.get(key)} and ${name}`);
    referenced.set(key, name);
  }
  for (const [key, option] of Object.entries(options)) {
    const variable = referenced.get(key);
    if (variable === undefined) {
      fail(`user_config.${key} is declared but no variable uses it`);
      continue;
    }
    if (option.required === true) fail(`user_config.${key} must not be required`);
    if (option.default !== '') {
      fail(
        `user_config.${key} must default to "" (an unset option would leak the literal reference)`,
      );
    }
    // 5. Secret marking.
    const credential = isCredentialName(variable);
    if (credential && option.sensitive !== true) {
      fail(
        `user_config.${key} feeds ${variable} (head noun ${headNoun(variable)}) but is not sensitive`,
      );
    }
    if (!credential && option.sensitive === true) {
      warnings.push(
        `user_config.${key} is sensitive but ${variable} is not a credential name — extend ` +
          'CREDENTIAL_HEADS in scripts/lib/env-surface.mjs if this is a new credential shape',
      );
    }
  }

  // 6. Substitution with no user values.
  const substituted = await getMcpConfigForManifest({
    manifest,
    extensionPath: '/bundle',
    systemDirs: {},
    userConfig: {},
    pathSeparator: '/',
  });
  if (substituted === undefined) {
    fail('getMcpConfigForManifest returned no config (a required option without a value?)');
  } else {
    for (const [name, value] of Object.entries(substituted.env ?? {})) {
      if (value !== '')
        fail(`${name} substitutes to ${JSON.stringify(value)} with no user values, expected ""`);
    }
    if (JSON.stringify(substituted.args) !== JSON.stringify([`/bundle/${server.entry_point}`])) {
      fail(`args substitute to ${JSON.stringify(substituted.args)}`);
    }
  }

  for (const warning of warnings) process.stdout.write(`mcpb-guard: WARN — ${warning}\n`);
  if (failures.length > 0) {
    for (const failure of failures) process.stdout.write(`mcpb-guard: FAIL — ${failure}\n`);
    process.exitCode = 1;
    return;
  }
  const secrets = Object.values(options).filter((option) => option.sensitive === true).length;
  process.stdout.write(
    `mcpb-guard: PASS — MCPB ${MANIFEST_VERSION}, v${manifest.version} in lockstep, ` +
      `${Object.keys(env).length} env var(s) ↔ user_config (${secrets} sensitive)\n`,
  );
}

await main();
