// Deterministic input fuzzer for the tool surface (T-319, WP-3.12; QA review F15).
// Companion to scripts/coverage-guard.mjs — same house style: no dependencies beyond the
// compiled build, `process.stdout.write` for output, a non-zero exit on a real finding.
//
//   node scripts/fuzz-tools.mjs [--seed N] [--cases N | --iterations N] [--tool NAME]
//                               [--case N] [--timeout-ms N] [--report PATH] [--list] [--verbose]
//
// WHAT IT ASSERTS — the product's core promise (docs/02 §5, §6):
//
//   I1  no crash          — `registry.call` always SETTLES; it never escapes as a
//                           non-`XError`, never hangs, never takes the process down.
//   I2  typed failures    — every deterministic refusal is an `XError` whose `kind` is one
//                           of the 11 taxonomy classes (core/errors) and whose rendered
//                           payload carries only the agent-safe allow-listed fields.
//   I3  no stack leak     — nothing the caller sees contains a V8 stack frame, an internal
//                           module path, a `node_modules` path or the repo root. Strings
//                           the CASE itself supplied are stripped before the scan, so a
//                           tool echoing hostile input back is not mistaken for a leak.
//   I4  no unhandled      — no `unhandledRejection` / `uncaughtException` fires.
//   I5  no pollution      — `Object.prototype` / `Array.prototype` gain no own properties
//                           (`__proto__` and `constructor` keys are part of every corpus).
//   I6  render never crashes — the SUCCESS path renders through the real
//                           `renderStructuredResult` and must not throw either.
//   I7  offline           — global `fetch` is replaced by a tripwire; a handler that
//                           reaches the network instead of its injected `EndpointInvoker`
//                           is a finding, not a flaky test.
//
// DETERMINISM. Nothing here is random-on-every-run. Each tool gets its own PRNG stream
// seeded from `hash(seed, toolName)`, so a case index means the same thing regardless of
// how many tools ran or in what order. A violation is replayed with exactly:
//
//   node scripts/fuzz-tools.mjs --seed <seed> --tool <name> --case <index>
//
// OFFLINE. Inputs enter the REAL registry choke point (`composeServer` → `registry.call`),
// but the per-call `EndpointInvoker` is a stub that answers from a canned table, so no
// socket is ever opened. The only filesystem touch is one temp directory holding a tiny
// stub image, so the media tool's open/read path is exercised for real.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as setTimer, clearTimeout as clearTimer } from 'node:timers';
import { setImmediate as nextTick, setTimeout as delay } from 'node:timers/promises';
// `URL` is imported, not taken from the global scope: eslint.config.js declares no globals
// for plain .mjs, so a bare `URL` would be a `no-undef` error under `npm run lint`.
import { URL, fileURLToPath } from 'node:url';

const BUILD = new URL('../build/src/', import.meta.url);
const { parseConfig } = await import(new URL('core/config.js', BUILD).href);
const { composeServer } = await import(new URL('mcp/compose.js', BUILD).href);
const { XError, apiError } = await import(new URL('core/errors.js', BUILD).href);
const { renderStructuredResult } = await import(new URL('mcp/structured.js', BUILD).href);

// --- Invariant vocabularies ----------------------------------------------------------

/** The 11 taxonomy classes (core/errors). A `kind` outside this set is a finding. */
const ERROR_KINDS = new Set([
  'auth',
  'scope',
  'forbidden',
  'rate-limit',
  'budget',
  'billing',
  'policy',
  'validation',
  'not-found',
  'api',
  'network',
]);

/** Exactly the keys `XError.toPayload()` may emit (`error.kind` + `XErrorData`). */
const ALLOWED_PAYLOAD_KEYS = new Set([
  'kind',
  'message',
  'retryable',
  'fix',
  'scope',
  'reset_at',
  'retry_after_seconds',
  'cell',
  'http_status',
  'platform_title',
  'platform_detail',
]);

/** Substrings that betray a stack frame or an internal path in caller-visible text (I3). */
const LEAK_MARKERS = [
  '\n    at ',
  '    at Object.',
  '    at async ',
  'node:internal',
  'node_modules',
  'file:///',
  '.ts:',
  '.mjs:',
  process.cwd(),
  fileURLToPath(BUILD),
];

/** Sentinel property names the pollution corpus tries to plant on the prototypes (I5). */
const POLLUTION_SENTINELS = ['polluted', 'fuzzed', 'isAdmin'];

// --- CLI -----------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    seed: 1,
    cases: 90,
    tool: null,
    case: null,
    timeoutMs: 5000,
    report: null,
    list: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      const v = argv[i];
      if (v === undefined) fail(`missing value for ${arg}`);
      return v;
    };
    if (arg === '--seed') opts.seed = toInt(next(), '--seed');
    // `--iterations` is an alias for `--cases`: the roadmap names the knob "iterations",
    // the report and the replay line name it "cases". Both spellings mean the same number
    // of RANDOM cases per tool (the fixed corpus is always run on top).
    else if (arg === '--cases' || arg === '--iterations') opts.cases = toInt(next(), arg);
    else if (arg === '--tool') opts.tool = next();
    else if (arg === '--case') opts.case = toInt(next(), '--case');
    else if (arg === '--timeout-ms') opts.timeoutMs = toInt(next(), '--timeout-ms');
    else if (arg === '--report') opts.report = next();
    else if (arg === '--list') opts.list = true;
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--help' || arg === '-h') usage(0);
    else fail(`unknown argument "${arg}"`);
  }
  return opts;
}

function toInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) fail(`${flag} expects a non-negative integer, got "${raw}"`);
  return n;
}

function fail(message) {
  process.stderr.write(`fuzz-tools: ${message}\n`);
  usage(1);
}

function usage(code) {
  process.stdout.write(
    'usage: fuzz-tools.mjs [--seed N] [--cases N | --iterations N] [--tool NAME]\n' +
      '                      [--case N] [--timeout-ms N] [--report PATH] [--list] [--verbose]\n',
  );
  process.exit(code);
}

// --- Deterministic PRNG ---------------------------------------------------------------

/** mulberry32 — tiny, fast, fully reproducible from a 32-bit seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the tool name, mixed with the run seed — one independent stream per tool. */
function streamSeed(seed, name) {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];

// --- Hostile value corpus --------------------------------------------------------------

const HUGE_STRING = 'A'.repeat(1_000_000);
const ZALGO = 'e' + '̴͈́͜'.repeat(400);

function deepObject(depth) {
  const root = {};
  let cursor = root;
  for (let i = 0; i < depth; i += 1) {
    cursor.next = { depth: i };
    cursor = cursor.next;
  }
  return root;
}

function cyclicObject() {
  const node = { name: 'cycle' };
  node.self = node;
  return node;
}

function throwingToString() {
  return {
    toString() {
      throw new Error('fuzz: toString tripwire');
    },
  };
}

function throwingGetter() {
  return Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      throw new Error('fuzz: getter tripwire');
    },
  });
}

/**
 * The universal hostile pool — applied to every field of every tool regardless of its
 * declared type. Each entry is built fresh per use so a mutated value can never leak
 * between cases.
 */
const HOSTILE = [
  ['null', () => null],
  ['undefined', () => undefined],
  ['empty-string', () => ''],
  ['whitespace', () => ' \t\r\n  '],
  ['zero', () => 0],
  ['negative', () => -1],
  ['negative-huge', () => -1.7976931348623157e308],
  ['nan', () => Number.NaN],
  ['infinity', () => Number.POSITIVE_INFINITY],
  ['-infinity', () => Number.NEGATIVE_INFINITY],
  ['unsafe-integer', () => Number.MAX_SAFE_INTEGER + 2],
  ['float', () => 3.9999999],
  ['bigint', () => 123456789012345678901234567890n],
  ['true', () => true],
  ['false', () => false],
  ['numeric-string', () => '000000000000000000000000042'],
  ['string-nul', () => 'a b'],
  ['string-control', () => '[31m'],
  ['string-rtl-override', () => 'gif.‮gnp.exe'],
  ['string-bidi-isolate', () => '⁦harmless⁧evil⁩'],
  ['string-zalgo', () => ZALGO],
  ['string-lone-surrogate', () => 'lead\ud800trail'],
  ['string-emoji-zwj', () => '\u{1f469}‍\u{1f469}‍\u{1f467}'.repeat(200)],
  ['string-1mb', () => HUGE_STRING],
  ['string-json-break', () => '","injected":"yes'],
  ['string-crlf', () => 'value\r\nX-Injected: 1'],
  ['string-proto-literal', () => '__proto__'],
  // The payload is the literal text `${...}` — a template-injection probe, not an
  // interpolation. Assembled from two pieces so neither this file's reader nor a static
  // analyzer mistakes it for a template literal that lost its backticks.
  ['string-template', () => '$' + '{process.env.X_MCP_BEARER_TOKEN}'],
  ['path-traversal', () => '../../../../../../etc/passwd'],
  ['path-traversal-image', () => '../../../../../../etc/hosts.png'],
  ['path-nul-suffix', () => '/tmp/ok.png .txt'],
  ['path-url-scheme', () => 'file:///etc/passwd'],
  ['path-unc', () => '\\\\attacker\\share\\payload.png'],
  ['path-home', () => '~/.ssh/id_rsa.png'],
  ['page-token-empty', () => ''],
  ['page-token-oversized', () => 'p'.repeat(100_000)],
  ['page-token-binary', () => ' ￿￾'],
  ['array-empty', () => []],
  ['array-nested', () => [[[[['deep']]]]]],
  ['array-5k', () => Array.from({ length: 5000 }, (_, i) => String(i))],
  ['array-mixed', () => ['1', 2, null, undefined, {}, []]],
  ['object-empty', () => ({})],
  ['object-deep', () => deepObject(300)],
  ['object-cyclic', () => cyclicObject()],
  ['object-proto-key', () => JSON.parse('{"__proto__":{"polluted":"yes"}}')],
  ['object-constructor-key', () => JSON.parse('{"constructor":{"prototype":{"fuzzed":"yes"}}}')],
  ['object-throwing-tostring', () => throwingToString()],
  ['object-throwing-getter', () => throwingGetter()],
  ['date', () => new Date(8.64e15)],
  // The payload here is the TYPE — a RegExp where the schema declares a string — not the
  // pattern. Kept trivial on purpose: nothing in this server ever compiles or applies a
  // caller-supplied pattern, so a catastrophically-backtracking one would test nothing and
  // would sit in the repo as a live ReDoS gadget for anyone who copied it.
  ['regexp', () => /^fuzz$/],
  ['function', () => () => 'nope'],
  ['symbol', () => Symbol('fuzz')],
  ['map', () => new Map([['k', 'v']])],
  ['typed-array', () => new Uint8Array(64)],
  ['null-prototype-object', () => Object.assign(Object.create(null), { a: 1 })],
];

const HOSTILE_BY_NAME = new Map(HOSTILE);

/**
 * TYPE-RESPECTING hostility. The universal pool above is mostly type confusion, which zod
 * rejects at the wall — necessary, but it never exercises what lives BEHIND validation
 * (identifier resolution, pagination-token decoding, media open, compaction, rendering).
 * These subsets keep the declared type and attack the semantics instead, so a healthy
 * share of cases reaches the handler.
 */
const HOSTILE_BY_TYPE = {
  ZodString: [
    'empty-string',
    'whitespace',
    'numeric-string',
    'string-nul',
    'string-control',
    'string-rtl-override',
    'string-bidi-isolate',
    'string-zalgo',
    'string-lone-surrogate',
    'string-emoji-zwj',
    'string-1mb',
    'string-json-break',
    'string-crlf',
    'string-proto-literal',
    'string-template',
    'path-traversal',
    'path-traversal-image',
    'path-nul-suffix',
    'path-url-scheme',
    'path-unc',
    'path-home',
    'page-token-empty',
    'page-token-oversized',
    'page-token-binary',
  ],
  ZodNumber: [
    'zero',
    'negative',
    'negative-huge',
    'nan',
    'infinity',
    '-infinity',
    'unsafe-integer',
    'float',
  ],
  ZodBoolean: ['true', 'false'],
  ZodArray: ['array-empty', 'array-nested', 'array-5k', 'array-mixed'],
  ZodObject: ['object-empty', 'object-deep', 'object-proto-key', 'object-constructor-key'],
};

/** A hostile value that still satisfies the field's declared type, when one exists. */
function typedHostile(rng, field) {
  if (field.typeName === 'ZodEnum' && field.enumValues !== null) {
    // Enums have no "valid but hostile" member; near-misses are the interesting probe.
    const near = field.enumValues.map((v) => `${String(v).toUpperCase()}`);
    return [`enum-case-shift`, () => pick(rng, near)];
  }
  const names = HOSTILE_BY_TYPE[field.typeName];
  if (names === undefined) return null;
  const name = pick(rng, names);
  const make = HOSTILE_BY_NAME.get(name);
  return make === undefined ? null : [name, make];
}

// --- zod schema introspection ----------------------------------------------------------

const WRAPPERS = new Set([
  'ZodOptional',
  'ZodNullable',
  'ZodDefault',
  'ZodEffects',
  'ZodBranded',
  'ZodCatch',
  'ZodReadonly',
  'ZodPipeline',
]);

/** Peel `.optional()` / `.default()` / `.refine()` / … down to the concrete zod node. */
function unwrap(schema) {
  let node = schema;
  for (let i = 0; i < 12 && node?._def !== undefined; i += 1) {
    const def = node._def;
    if (!WRAPPERS.has(def.typeName)) return node;
    node = def.innerType ?? def.schema ?? def.in ?? def.out;
  }
  return node;
}

const typeNameOf = (schema) => unwrap(schema)?._def?.typeName ?? 'unknown';

/** Is this field omissible (`.optional()` / `.default()`)? Required fields drive baselines. */
function isOptional(schema) {
  let node = schema;
  for (let i = 0; i < 12 && node?._def !== undefined; i += 1) {
    const def = node._def;
    if (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault') return true;
    if (!WRAPPERS.has(def.typeName)) return false;
    node = def.innerType ?? def.schema ?? def.in ?? def.out;
  }
  return false;
}

/** The tool's top-level fields: `{ key, typeName, optional, enumValues, element }`. */
function describeSchema(schema) {
  const root = unwrap(schema);
  if (root?._def?.typeName !== 'ZodObject') return [];
  const shape = typeof root.shape === 'function' ? root.shape() : root.shape;
  return Object.entries(shape).map(([key, field]) => {
    const inner = unwrap(field);
    const def = inner?._def ?? {};
    return {
      key,
      typeName: def.typeName ?? 'unknown',
      optional: isOptional(field),
      enumValues: Array.isArray(def.values) ? def.values : null,
      element: def.type !== undefined ? typeNameOf(def.type) : null,
    };
  });
}

/**
 * A plausible value per field, so a share of the corpus actually reaches the HANDLER
 * instead of stopping at zod. Deliberately boring: ids are numeric strings, `me` is the
 * documented self-sentinel, page sizes sit inside every clamp.
 */
function plausible(field, mediaPath) {
  switch (field.typeName) {
    case 'ZodString':
      if (field.key === 'path') return mediaPath;
      if (field.key === 'page_token') return 'cursor-1';
      if (field.key.startsWith('start_') || field.key.startsWith('end_')) {
        return '2026-01-01T00:00:00Z';
      }
      if (field.key === 'query') return 'from:xdevelopers -is:retweet';
      if (field.key === 'user' || field.key === 'participant') return 'me';
      if (field.key === 'text' || field.key === 'description') return 'hello from the fuzzer';
      if (field.key === 'name') return 'fuzz-list';
      if (field.key === 'alt_text') return 'a stub image';
      return '1234567890123456789';
    case 'ZodNumber':
      return 10;
    case 'ZodBoolean':
      return false;
    case 'ZodEnum':
      return field.enumValues?.[0] ?? 'unknown';
    case 'ZodArray':
      return ['1234567890123456789'];
    case 'ZodObject':
      return { options: ['yes', 'no'], duration_minutes: 60 };
    default:
      return '1234567890123456789';
  }
}

/** The all-required-fields-filled argument object — the deepest reaching case. */
function baselineArgs(fields, mediaPath, { includeOptional = false } = {}) {
  const args = {};
  for (const field of fields) {
    if (field.optional && !includeOptional) continue;
    args[field.key] = plausible(field, mediaPath);
  }
  return args;
}

// --- Case generation --------------------------------------------------------------------

/**
 * Build this tool's full case list. Indices are STABLE: the fixed battery always occupies
 * the low indices, the sampled cases follow in PRNG order, so `--case N` replays exactly
 * the same argument object for a given `--seed`.
 */
function buildCases(tool, seed, sampled, mediaPath) {
  const rng = mulberry32(streamSeed(seed, tool.name));
  const fields = describeSchema(tool.input);
  const base = () => baselineArgs(fields, mediaPath);
  const cases = [];
  const add = (label, args) => cases.push({ label, args });

  // Fixed battery — the classes that must run for every tool on every seed.
  add('root:undefined', undefined);
  add('root:null', null);
  add('root:array', []);
  add('root:string', 'not-an-object');
  add('root:number', 42);
  add('root:boolean', true);
  add('root:empty-object', {});
  add('root:cyclic', cyclicObject());
  add('root:deep-300', deepObject(300));
  add('proto:__proto__', JSON.parse('{"__proto__":{"polluted":"yes"}}'));
  add('proto:constructor', JSON.parse('{"constructor":{"prototype":{"fuzzed":"yes"}}}'));
  add('proto:baseline+__proto__', {
    ...base(),
    ...JSON.parse('{"__proto__":{"isAdmin":true}}'),
  });
  add('extra-keys:500', {
    ...base(),
    ...Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i])),
  });
  add('baseline:required', base());
  add('baseline:all-fields', baselineArgs(fields, mediaPath, { includeOptional: true }));
  for (const [name, make] of [
    ['null', () => null],
    ['nul-string', () => ' '],
    ['1mb-string', () => HUGE_STRING],
    ['negative', () => -1],
  ]) {
    const args = {};
    for (const field of fields) args[field.key] = make();
    add(`all-fields:${name}`, args);
  }

  // Sampled battery — 1..3 fields per case replaced with a hostile value, on top of the
  // baseline, so both the validation wall and the handler path stay exercised.
  const fixed = cases.length;
  for (let i = 0; i < sampled; i += 1) {
    const args = rng() < 0.7 ? base() : {};
    if (fields.length === 0) {
      // Field-less tools (x_auth_status, x_rate_limit_status) still get hostile ROOTS.
      const [name, make] = pick(rng, HOSTILE);
      add(`root-hostile:${name}`, make());
      continue;
    }
    // Half the cases stay type-valid so they clear zod and hit the handler; the rest are
    // free-for-all type confusion that must die cleanly at the validation wall.
    const typed = rng() < 0.5;
    const mutations = 1 + Math.floor(rng() * 3);
    const labels = [];
    for (let m = 0; m < mutations; m += 1) {
      const field = pick(rng, fields);
      const entry = (typed ? typedHostile(rng, field) : null) ?? pick(rng, HOSTILE);
      const [name, make] = entry;
      args[field.key] = make();
      labels.push(`${field.key}=${name}`);
    }
    if (rng() < 0.15) args[pick(rng, ['__proto__', 'constructor', 'prototype'])] = { polluted: 1 };
    add(labels.join(','), args);
  }
  return { cases, fixed, fields };
}

// --- Canned upstream responses ------------------------------------------------------------

/**
 * What the stub `EndpointInvoker` answers. A handler must survive a garbage envelope and a
 * hostile throw exactly as it survives a real one — the registry's job is to turn ANY of
 * these into a typed result.
 *
 * Every body here is REACHABLE: `send<T>` returns `await response.json()`, so a body is
 * always the output of a JSON parse. That rules out cycles, BigInt and functions (they
 * would only ever fail `renderStructuredResult` in a way production cannot reproduce) and
 * rules IN own `__proto__` keys and attacker-controlled post text, which are exactly what
 * a hostile upstream WOULD send.
 */
const RESPONSES = [
  ['empty-object', () => ({})],
  ['null-data', () => ({ data: null })],
  ['empty-page', () => ({ data: [], meta: { result_count: 0 } })],
  ['wrong-types', () => ({ data: { id: 1234, text: { nested: true } }, includes: 'not-object' })],
  ['string-body', () => 'not json at all'],
  ['array-body', () => [1, 2, 3]],
  ['proto-body', () => JSON.parse('{"data":{"__proto__":{"polluted":"yes"},"id":"7"}}')],
  ['hostile-text-body', () => ({ data: { id: '7', text: `${ZALGO}‮${HUGE_STRING}` } })],
  ['throw:xerror', () => new Error('sentinel')], // replaced below with a real XError
  ['throw:typeerror', () => new TypeError('upstream boom')],
  ['throw:string', () => 'plain string throw'],
];

function respond(mode) {
  const [name, make] = RESPONSES[mode % RESPONSES.length];
  if (name === 'throw:xerror') throw apiError('Upstream refused the request.');
  if (name.startsWith('throw:')) throw make();
  return make();
}

// --- Harness ---------------------------------------------------------------------------

/** Ports with no I/O and no wall clock; `sleep` trips a guard rather than spinning forever. */
function fuzzPorts(state) {
  return {
    clock: { now: () => 1_700_000_000_000 },
    sleep: () => {
      state.sleeps += 1;
      if (state.sleeps > 200) {
        return Promise.reject(new Error('fuzz-tools: runaway sleep loop in a handler'));
      }
      return Promise.resolve();
    },
    random: {
      float: () => 0.42,
      uuid: () => '00000000-0000-4000-8000-000000000001',
      bytes: (n) => new Uint8Array(n),
    },
    tokens: {
      load: () => Promise.resolve(null),
      persist: () => Promise.resolve(),
      withLock: (fn) => fn(),
    },
  };
}

/** Snapshot the prototypes so I5 can diff them after every case. */
function protoSnapshot() {
  return {
    object: Object.getOwnPropertyNames(Object.prototype).join(','),
    array: Object.getOwnPropertyNames(Array.prototype).join(','),
  };
}

function pollutionFindings(before) {
  const now = protoSnapshot();
  const found = [];
  if (now.object !== before.object) found.push('Object.prototype own properties changed');
  if (now.array !== before.array) found.push('Array.prototype own properties changed');
  for (const sentinel of POLLUTION_SENTINELS) {
    if (sentinel in {}) found.push(`Object.prototype.${sentinel} is set`);
  }
  return found;
}

// --- Caller-visible-text inspection -------------------------------------------------------

/** Distinct strings kept for the scrub — plenty for any one case, still bounded. */
const LEAF_LIMIT = 2000;

/**
 * Per-CONTAINER walk budget. It is deliberately not a global one: a 5 000-element array
 * must not consume the budget its SIBLINGS need, or a hostile value the case itself
 * supplied under a later key survives the scrub and is misread as a leak (seed 2 /
 * `x_list_pin_set` did exactly that — the echoed `action` enum value looked like a
 * `file:///` leak because the array's index keys had already exhausted the walk).
 */
const CHILDREN_PER_CONTAINER = 128;

/** Every string leaf of the case arguments — stripped before the leak scan (see I3). */
function stringLeaves(value, out = new Set(), seen = new WeakSet(), depth = 0) {
  if (depth > 6 || out.size >= LEAF_LIMIT) return out;
  if (typeof value === 'string') {
    if (value.length > 3) out.add(value);
    return out;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  const keys = Object.keys(value);
  const walked =
    keys.length > CHILDREN_PER_CONTAINER ? keys.slice(0, CHILDREN_PER_CONTAINER) : keys;
  for (const key of walked) {
    // Array index keys are never scrub tokens — blanking "1000" out of a message would
    // hide real leaks rather than reveal echoes.
    if (key.length > 3 && !/^\d+$/.test(key)) out.add(key);
    let child;
    try {
      child = value[key];
    } catch {
      continue; // a throwing getter is itself hostile input, not a leak
    }
    stringLeaves(child, out, seen, depth + 1);
  }
  return out;
}

/** Strip case-supplied text, then look for stack frames / internal paths (I3). */
function leaksInternals(text, args) {
  let scrubbed = text;
  // Longest first: stripping "file:///etc/passwd" before "file" leaves nothing behind that
  // a shorter, overlapping leaf could have fragmented.
  const leaves = [...stringLeaves(args)].sort((a, b) => b.length - a.length);
  for (const leaf of leaves) {
    if (scrubbed.includes(leaf)) scrubbed = scrubbed.split(leaf).join('');
  }
  return LEAK_MARKERS.filter((marker) => marker.length > 0 && scrubbed.includes(marker));
}

/** Replay-friendly rendering of an argument object — cycles, BigInt and symbols included. */
function describeArgs(value, depth = 0, seen = new WeakSet()) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') {
    return value.length > 120
      ? `${JSON.stringify(value.slice(0, 120))} + '…' /* length ${value.length} */`
      : JSON.stringify(value);
  }
  if (type === 'bigint') return `${value.toString()}n`;
  if (type === 'symbol') return value.toString();
  if (type === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (type !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (depth > 4) return '[…]';
  if (Array.isArray(value)) {
    const head = value.slice(0, 8).map((v) => describeArgs(v, depth + 1, seen));
    if (value.length > 8) head.push(`… ${value.length - 8} more`);
    return `[${head.join(', ')}]`;
  }
  if (value instanceof Date) return `new Date(${value.getTime()})`;
  if (value instanceof RegExp) return value.toString();
  const keys = Object.keys(value);
  const parts = keys.slice(0, 12).map((key) => {
    let child;
    try {
      child = value[key];
    } catch {
      return `${JSON.stringify(key)}: [throwing getter]`;
    }
    return `${JSON.stringify(key)}: ${describeArgs(child, depth + 1, seen)}`;
  });
  if (keys.length > 12) parts.push(`… ${keys.length - 12} more keys`);
  return `{ ${parts.join(', ')} }`;
}

// --- The run ------------------------------------------------------------------------------

async function runCase(registry, tool, testCase, index, opts, state) {
  const violations = [];
  const record = (invariant, detail) => violations.push({ invariant, detail });
  const before = protoSnapshot();
  state.sleeps = 0;
  state.current = { tool: tool.name, index, label: testCase.label };

  const ctx = {
    ports: state.ports,
    http: {
      send: () => {
        state.calls += 1;
        return Promise.resolve(respond(index + state.calls));
      },
    },
  };

  let timer;
  const timeout = new Promise((_resolve, reject) => {
    // Deliberately NOT unref'd. An unref'd watchdog cannot fire in the one scenario it
    // exists for: when the handler never settles, the pending timer is the only thing left
    // on the loop, and an unref'd one lets Node exit first — the run would end with a
    // cryptic "unsettled top-level await" instead of a legible `I1 hang` finding. The
    // `finally` below clears it on every path, so nothing is kept alive.
    timer = setTimer(() => reject(new Error('__fuzz_timeout__')), opts.timeoutMs);
  });

  let settled;
  try {
    const result = await Promise.race([registry.call(tool.name, testCase.args, ctx), timeout]);
    settled = { ok: true, result };
  } catch (error) {
    settled = { ok: false, error };
  } finally {
    clearTimer(timer);
  }

  if (settled.ok) {
    state.outcomes.ok += 1;
    // I6 — the success path renders through the real adapter; a throw here is a crash.
    let rendered;
    try {
      rendered = renderStructuredResult(settled.result);
    } catch (error) {
      record('I6 render-crash', `renderStructuredResult threw: ${errorLabel(error)}`);
    }
    if (rendered !== undefined) {
      let text;
      try {
        text = JSON.stringify(rendered);
      } catch (error) {
        record('I6 render-crash', `result is not JSON-serializable: ${errorLabel(error)}`);
      }
      if (text !== undefined) {
        for (const marker of leaksInternals(text, testCase.args)) {
          record('I3 stack-leak', `success result contains ${JSON.stringify(marker)}`);
        }
      }
    }
  } else {
    const error = settled.error;
    if (error instanceof Error && error.message === '__fuzz_timeout__') {
      record('I1 hang', `no settlement within ${opts.timeoutMs} ms`);
    } else if (!XError.is(error)) {
      // I1/I2 — anything that is not an XError escaped the choke point untyped.
      record('I2 untyped-throw', `${errorLabel(error)}`);
    } else {
      state.outcomes.byKind[error.kind] = (state.outcomes.byKind[error.kind] ?? 0) + 1;
      if (!ERROR_KINDS.has(error.kind)) {
        record('I2 unknown-kind', `kind ${JSON.stringify(error.kind)} is outside the taxonomy`);
      }
      // Mirrors mcp/server.ts `renderError` — the exact bytes the caller receives.
      const payload = error.toPayload();
      for (const key of Object.keys(payload.error ?? {})) {
        if (!ALLOWED_PAYLOAD_KEYS.has(key)) {
          record('I2 payload-key', `error payload carries unexpected key ${JSON.stringify(key)}`);
        }
      }
      let text;
      try {
        text = JSON.stringify({ isError: true, content: [{ type: 'text', text: payload }] });
      } catch (serializeError) {
        record('I2 payload-unserializable', errorLabel(serializeError));
      }
      if (text !== undefined) {
        for (const marker of leaksInternals(text, testCase.args)) {
          record('I3 stack-leak', `error payload contains ${JSON.stringify(marker)}`);
        }
        // Key-shaped, not substring-shaped: `fix` prose legitimately contains "because".
        for (const forbidden of ['"stack":', '"cause":', '"stack" :', '"cause" :']) {
          if (text.includes(forbidden)) {
            record('I3 stack-leak', `error payload carries a ${forbidden} field`);
          }
        }
      }
    }
  }

  // Let a pending rejection surface before the case is attributed to the next one.
  await nextTick();
  for (const finding of pollutionFindings(before)) record('I5 prototype-pollution', finding);
  return violations;
}

function errorLabel(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `${typeof error} thrown: ${String(error)}`;
}

// --- main -----------------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  const workDir = mkdtempSync(join(tmpdir(), 'x-mcp-fuzz-'));
  const mediaPath = join(workDir, 'stub.png');
  // 8-byte PNG signature + padding: enough for the media tool to open, stat and chunk it.
  writeFileSync(mediaPath, Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]));

  const state = {
    ports: null,
    sleeps: 0,
    calls: 0,
    current: null,
    async: [],
    network: [],
    outcomes: { ok: 0, byKind: {} },
  };
  state.ports = fuzzPorts(state);

  // I4 — nothing may escape as an unhandled rejection or an uncaught exception.
  const onUnhandled = (reason) => {
    state.async.push({ kind: 'unhandledRejection', at: state.current, detail: errorLabel(reason) });
  };
  const onUncaught = (error) => {
    state.async.push({ kind: 'uncaughtException', at: state.current, detail: errorLabel(error) });
  };
  process.on('unhandledRejection', onUnhandled);
  process.on('uncaughtException', onUncaught);

  // I7 — the offline tripwire. Handlers must go through their injected EndpointInvoker.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    state.network.push({ at: state.current, detail: String(args[0]) });
    return Promise.reject(new Error('fuzz-tools: network access is disabled'));
  };

  // The widest possible surface, on purpose: `full` + every availability class + the two DM
  // cells (which even `full` withholds until explicitly allowed). A tool that stops at the
  // policy gate never reaches its handler, and the handler is where the interesting parsing
  // lives. Denied-path behavior is covered by the registry's own tests, not here.
  const config = parseConfig({
    X_MCP_AUTH_MODE: 'app-only',
    X_MCP_BEARER_TOKEN: 'fuzz-token-not-a-real-credential',
    X_MCP_POLICY: 'full',
    X_MCP_POLICY_ALLOW: 'read:dm,write:dm',
    X_MCP_AVAILABILITY: 'pilot,premium-user,enterprise',
    X_MCP_BUDGET_MODE: 'warn',
    // Without a media dir the upload tool refuses before it opens anything, and the whole
    // traversal corpus would be answered by one early guard. Pointing it at the scratch dir
    // puts the real open/stat/containment path under the fuzz.
    X_MCP_MEDIA_DIR: workDir,
  });
  const { registry } = composeServer(config);

  let tools = registry.all();
  if (opts.tool !== null) {
    tools = tools.filter((tool) => tool.name === opts.tool);
    if (tools.length === 0) {
      process.stderr.write(`fuzz-tools: no registered tool named "${opts.tool}"\n`);
      process.exit(1);
    }
  }

  if (opts.list) {
    for (const tool of tools) {
      const fields = describeSchema(tool.input).map((f) => `${f.key}:${f.typeName}`);
      process.stdout.write(`${tool.name.padEnd(32)} ${fields.join(' ') || '(no fields)'}\n`);
    }
    rmSync(workDir, { recursive: true, force: true });
    return 0;
  }

  const findings = [];
  const perTool = [];
  let totalCases = 0;

  for (const tool of tools) {
    const { cases, fixed } = buildCases(tool, opts.seed, opts.cases, mediaPath);
    const selected =
      opts.case === null
        ? cases.map((c, i) => [i, c])
        : [[opts.case, cases[opts.case]]].filter(([, c]) => c !== undefined);
    if (opts.case !== null && selected.length === 0) {
      process.stderr.write(
        `fuzz-tools: case ${opts.case} is out of range for ${tool.name} ` +
          `(0..${cases.length - 1} at --cases ${opts.cases})\n`,
      );
      process.exit(1);
    }
    let toolFindings = 0;
    for (const [index, testCase] of selected) {
      totalCases += 1;
      const violations = await runCase(registry, tool, testCase, index, opts, state);
      for (const violation of violations) {
        toolFindings += 1;
        findings.push({
          tool: tool.name,
          case: index,
          label: testCase.label,
          invariant: violation.invariant,
          detail: violation.detail,
          args: describeArgs(testCase.args),
        });
      }
      if (opts.verbose) {
        process.stdout.write(`  ${tool.name} #${index} ${testCase.label}\n`);
      }
    }
    perTool.push({ tool: tool.name, cases: selected.length, fixed, findings: toolFindings });
  }

  // Give late rejections a chance to land before the verdict.
  await delay(150);
  process.off('unhandledRejection', onUnhandled);
  process.off('uncaughtException', onUncaught);
  globalThis.fetch = realFetch;
  rmSync(workDir, { recursive: true, force: true });

  for (const event of state.async) {
    findings.push({
      tool: event.at?.tool ?? '(post-run)',
      case: event.at?.index ?? -1,
      label: event.at?.label ?? '(after the last case)',
      invariant: `I4 ${event.kind}`,
      detail: event.detail,
      args: '(see the case index)',
    });
  }
  for (const event of state.network) {
    findings.push({
      tool: event.at?.tool ?? '(unknown)',
      case: event.at?.index ?? -1,
      label: event.at?.label ?? '(unknown)',
      invariant: 'I7 network-access',
      detail: `global fetch called with ${event.detail}`,
      args: '(see the case index)',
    });
  }

  const durationMs = Date.now() - startedAt;
  const report = {
    seed: opts.seed,
    casesPerTool: opts.cases,
    timeoutMs: opts.timeoutMs,
    node: process.version,
    startedAt: new Date(startedAt).toISOString(),
    durationMs,
    tools: perTool,
    totalTools: perTool.length,
    totalCases,
    upstreamCalls: state.calls,
    outcomes: state.outcomes,
    violations: findings,
  };
  if (opts.report !== null) {
    writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
  }

  const kinds = Object.entries(state.outcomes.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind} ${count}`)
    .join(', ');
  process.stdout.write(
    `fuzz-tools: seed ${opts.seed} — ${perTool.length} tools x ` +
      `${opts.case === null ? `${totalCases / Math.max(perTool.length, 1)} cases` : '1 case'} ` +
      `= ${totalCases} calls in ${durationMs} ms (${state.calls} stub upstream calls)\n` +
      `fuzz-tools: outcomes — ${state.outcomes.ok} ok, ${kinds}\n`,
  );

  if (findings.length === 0) {
    process.stdout.write('fuzz-tools: PASS — every case returned a typed result, no leaks\n');
    return 0;
  }

  process.stderr.write(`\nfuzz-tools: FAIL — ${findings.length} violation(s)\n`);
  for (const finding of findings) {
    process.stderr.write(
      `\n  ${finding.invariant}\n` +
        `    tool:   ${finding.tool}\n` +
        `    case:   #${finding.case} (${finding.label})\n` +
        `    detail: ${finding.detail}\n` +
        `    args:   ${finding.args}\n` +
        `    replay: node scripts/fuzz-tools.mjs --seed ${opts.seed} ` +
        `--cases ${opts.cases} --tool ${finding.tool} --case ${finding.case}\n`,
    );
  }
  process.stderr.write('\n');
  return 1;
}

process.exit(await main());
