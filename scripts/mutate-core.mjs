// Informational mutation harness over `src/core/*.ts` (T-319, WP-3.12; QA review F14).
// Companion to scripts/coverage-guard.mjs and scripts/fuzz-tools.mjs — same house style:
// no dependency the repo does not already carry, `process.stdout.write` for output.
//
//   node scripts/mutate-core.mjs [--seed N] [--per-file N] [--file NAME] [--mutant N]
//                                [--timeout-ms N] [--report PATH] [--verbose]
//
// WHAT IT MEASURES. Coverage says a line RAN; it never says a line was CHECKED. This
// harness breaks `core/*` on purpose — one small edit at a time — and asks whether the
// core test suite notices. A mutant the tests still pass is a behaviour nothing pins
// down: either a missing assertion, or code that does not need to exist.
//
// FOUR OPERATORS, deliberately small and legible (a mutant nobody can read teaches
// nothing):
//
//   comparison    <  <=  >  >=  ===  !==  ==  !=   — each flipped to its neighbour
//   logical       &&  ->  ||        ||  ->  &&
//   literal       any non-zero numeric literal -> 0
//   condition     if (C)  ->  if (!(C))
//
// Sites are found with the TypeScript compiler's own parser (`typescript` is already a
// devDependency), not a regex — so nothing inside a string, comment, template literal,
// regex literal or type annotation is ever mutated.
//
// ALWAYS EXIT 0, NEVER TOUCH THE WORKING TREE. This is a signal, not a gate: a low score
// is a conversation, not a build failure. Everything happens in a scratch copy of `build/`
// under the OS temp dir; the repo's own `build/` and `src/` are read, never written.
// Fixtures resolve against `process.cwd()`, so the child test runs keep the repo root as
// their cwd while loading their MODULES from the scratch copy.
//
// DETERMINISM. `--seed` picks which sites are sampled; the same seed and `--per-file`
// always produce the same mutant list, so a survivor can be reproduced with
// `--file <name> --mutant <index>`.

import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
// `URL` is imported, not taken from the global scope: eslint.config.js declares no globals
// for plain .mjs, so a bare `URL` would be a `no-undef` error under `npm run lint`.
import { URL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CORE_SRC = join(REPO, 'src', 'core');
const BUILD = join(REPO, 'build');
const CORE_TESTS = join('build', 'test', 'core');

// --- CLI -----------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    seed: 1,
    perFile: 8,
    file: null,
    mutant: null,
    timeoutMs: 20000,
    report: null,
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
    else if (arg === '--per-file') opts.perFile = toInt(next(), '--per-file');
    else if (arg === '--file') opts.file = next();
    else if (arg === '--mutant') opts.mutant = toInt(next(), '--mutant');
    else if (arg === '--timeout-ms') opts.timeoutMs = toInt(next(), '--timeout-ms');
    else if (arg === '--report') opts.report = next();
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
  process.stderr.write(`mutate-core: ${message}\n`);
  usage(1);
}

function usage(code) {
  process.stdout.write(
    'usage: mutate-core.mjs [--seed N] [--per-file N] [--file NAME] [--mutant N]\n' +
      '                       [--timeout-ms N] [--report PATH] [--verbose]\n',
  );
  // Usage is the one exit this script does not force to 0 — a typo'd flag would
  // otherwise report a silent, meaningless "0 mutants".
  process.exit(code);
}

/** Informational exit: say why, then leave the build green. */
function bail(message) {
  process.stdout.write(`mutate-core: SKIPPED — ${message}\n`);
  process.exit(0);
}

// --- Deterministic PRNG ---------------------------------------------------------------

/** mulberry32 — same generator as scripts/fuzz-tools.mjs, reproducible from a 32-bit seed. */
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

/** FNV-1a over the file name, mixed with the run seed — one stream per file. */
function streamSeed(seed, name) {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Fisher-Yates over a copy — deterministic for a given stream. */
function shuffled(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1)) % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// --- Mutation operators ----------------------------------------------------------------

/** Binary operator token -> replacement text. The comparison flips are boundary flips. */
const BINARY_SWAP = new Map([
  [ts.SyntaxKind.LessThanToken, { text: '<=', operator: 'comparison' }],
  [ts.SyntaxKind.LessThanEqualsToken, { text: '<', operator: 'comparison' }],
  [ts.SyntaxKind.GreaterThanToken, { text: '>=', operator: 'comparison' }],
  [ts.SyntaxKind.GreaterThanEqualsToken, { text: '>', operator: 'comparison' }],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, { text: '!==', operator: 'comparison' }],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, { text: '===', operator: 'comparison' }],
  [ts.SyntaxKind.EqualsEqualsToken, { text: '!=', operator: 'comparison' }],
  [ts.SyntaxKind.ExclamationEqualsToken, { text: '==', operator: 'comparison' }],
  [ts.SyntaxKind.AmpersandAmpersandToken, { text: '||', operator: 'logical' }],
  [ts.SyntaxKind.BarBarToken, { text: '&&', operator: 'logical' }],
]);

/**
 * Every mutation site in one source file, in source order. Type nodes are not descended
 * into: a flipped `<` inside a generic argument is a compile error, not a behaviour change.
 */
function collectMutants(fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const mutants = [];

  const add = (start, end, replacement, operator, detail) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(start);
    mutants.push({
      file: fileName,
      start,
      end,
      replacement,
      operator,
      detail,
      line: line + 1,
      column: character + 1,
    });
  };

  const visit = (node) => {
    // Types carry no runtime behaviour — mutating them only produces build failures.
    if (
      ts.isTypeNode(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isImportDeclaration(node)
    ) {
      return;
    }

    if (ts.isBinaryExpression(node)) {
      const token = node.operatorToken;
      const swap = BINARY_SWAP.get(token.kind);
      if (swap) {
        add(
          token.getStart(sf),
          token.getEnd(),
          swap.text,
          swap.operator,
          `${token.getText(sf)} -> ${swap.text}`,
        );
      }
    } else if (ts.isNumericLiteral(node)) {
      const literal = node.getText(sf);
      // `0 -> 0` is not a mutation; separators and exponents are left alone so the
      // replacement text stays as legible as the original.
      if (Number(literal.replaceAll('_', '')) !== 0 && !/[eE]/.test(literal)) {
        add(node.getStart(sf), node.getEnd(), '0', 'literal', `${literal} -> 0`);
      }
    } else if (ts.isIfStatement(node)) {
      const condition = node.expression;
      add(
        condition.getStart(sf),
        condition.getEnd(),
        `!(${condition.getText(sf)})`,
        'condition',
        'if (C) -> if (!(C))',
      );
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sf, visit);
  return mutants;
}

/** Apply one mutation to the source text. */
function applyMutant(text, mutant) {
  return text.slice(0, mutant.start) + mutant.replacement + text.slice(mutant.end);
}

/** A one-line window on the mutated site, for the survivor list. */
function siteSnippet(text, mutant) {
  const from = text.lastIndexOf('\n', mutant.start) + 1;
  const to = text.indexOf('\n', mutant.end);
  const line = text.slice(from, to === -1 ? text.length : to).trim();
  return line.length > 96 ? `${line.slice(0, 93)}...` : line;
}

// --- Scratch build ---------------------------------------------------------------------

// Transpile-only: no type checking, so a mutant that is merely type-INVALID (`if (!(x))`
// on a narrowed union, a zeroed literal that no longer matches a literal type) still runs
// and can still be killed by a test. Syntax errors are caught and reported as invalid.
const TRANSPILE_OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  verbatimModuleSyntax: true,
  isolatedModules: true,
  sourceMap: false,
  newLine: ts.NewLineKind.LineFeed,
};

function transpile(fileName, text) {
  const out = ts.transpileModule(text, {
    fileName,
    compilerOptions: TRANSPILE_OPTIONS,
    reportDiagnostics: true,
  });
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    return { ok: false, reason: ts.flattenDiagnosticMessageText(errors[0].messageText, ' ') };
  }
  return { ok: true, js: out.outputText };
}

/**
 * A private copy of `build/` plus a link to the repo's `node_modules` (tests import zod).
 * The exit hook is what guarantees "never modifies the working tree" also means "leaves
 * nothing behind" — `bail()` exits straight from the middle of the run.
 */
let scratchDir = null;
process.on('exit', () => {
  if (scratchDir !== null) rmSync(scratchDir, { recursive: true, force: true });
});

function makeScratch() {
  scratchDir = mkdtempSync(join(tmpdir(), 'x-mcp-mutate-'));
  cpSync(BUILD, join(scratchDir, 'build'), { recursive: true });
  try {
    // `junction` is ignored on POSIX and avoids the Windows symlink-privilege prompt.
    symlinkSync(join(REPO, 'node_modules'), join(scratchDir, 'node_modules'), 'junction');
  } catch (error) {
    bail(
      `cannot link node_modules into the scratch copy ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return scratchDir;
}

/**
 * Run the core suite against the scratch modules. cwd stays the REPO root because the
 * fixture loader resolves `test/fixtures/...` against `process.cwd()`.
 */
function runCoreTests(scratch, timeoutMs) {
  const dir = join(scratch, CORE_TESTS);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => join(dir, f));
  if (files.length === 0) return { passed: false, reason: 'no compiled core tests found' };

  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: '' },
  });

  // An infinite loop from a flipped `<` counts as KILLED: the suite noticed, loudly.
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGKILL';
  if (timedOut) return { passed: false, reason: `timed out after ${timeoutMs} ms`, timedOut: true };
  if (result.error) return { passed: false, reason: String(result.error.message) };
  return {
    passed: result.status === 0,
    reason: result.status === 0 ? 'green' : `exit ${result.status}`,
    files: files.length,
  };
}

// --- Run -------------------------------------------------------------------------------

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padStart(value, width) {
  const text = String(value);
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

function score(killed, survived) {
  const total = killed + survived;
  return total === 0 ? null : (killed / total) * 100;
}

function formatScore(value) {
  return value === null ? '  n/a' : `${value.toFixed(1)}%`;
}

function run(opts, sources, scratch) {
  const startedAt = Date.now();

  const baseline = runCoreTests(scratch, opts.timeoutMs);
  if (!baseline.passed) {
    bail(`the core suite is not green before any mutation (${baseline.reason}) — fix that first`);
  }

  // Every file is re-emitted from source through the transpile-only path FIRST, so the
  // resting state a mutant is compared against differs from the mutant by exactly one edit
  // — never by "tsc emit vs transpileModule emit".
  const files = [];
  for (const name of sources) {
    const abs = join(CORE_SRC, name);
    const text = readFileSync(abs, 'utf8');
    const emitted = transpile(abs, text);
    if (!emitted.ok) {
      process.stdout.write(
        `mutate-core: skipping ${name} — cannot transpile (${emitted.reason})\n`,
      );
      continue;
    }
    const target = join(scratch, 'build', 'src', 'core', name.replace(/\.ts$/, '.js'));
    writeFileSync(target, emitted.js);
    files.push({ name, text, target, baselineJs: emitted.js });
  }
  if (files.length === 0) bail('no core source file could be transpiled');

  const rebuilt = runCoreTests(scratch, opts.timeoutMs);
  if (!rebuilt.passed) {
    bail(
      `the core suite is red on an UNMUTATED transpile of src/core (${rebuilt.reason}) — ` +
        `the harness cannot tell a real survivor from a build artefact`,
    );
  }

  const rows = [];
  const survivors = [];
  const invalid = [];
  let totalKilled = 0;
  let totalSurvived = 0;

  for (const file of files) {
    const all = collectMutants(join(CORE_SRC, file.name), file.text);
    const rng = mulberry32(streamSeed(opts.seed, file.name));
    // Sample with the PRNG, then restore source order: the printed `--mutant` index is a
    // position in THIS list, so it must not depend on the shuffle's internal ordering.
    const pool = shuffled(all, rng)
      .slice(0, opts.perFile)
      .sort((a, b) => a.start - b.start);
    let sampled = pool.map((mutant, index) => ({ ...mutant, index }));
    if (opts.mutant !== null) {
      sampled = sampled.filter((m) => m.index === opts.mutant);
      if (sampled.length === 0) {
        bail(
          `mutant ${opts.mutant} is out of range for ${file.name} ` +
            `(0..${pool.length - 1} at --per-file ${opts.perFile})`,
        );
      }
    }

    let killed = 0;
    let survived = 0;
    let skipped = 0;

    for (const mutant of sampled) {
      const mutatedSource = applyMutant(file.text, mutant);
      const emitted = transpile(join(CORE_SRC, file.name), mutatedSource);
      if (!emitted.ok) {
        // e.g. `a ?? b && c` — the flip is not expressible, so it is not a mutant at all.
        skipped += 1;
        invalid.push({ ...mutant, reason: emitted.reason });
        continue;
      }
      writeFileSync(file.target, emitted.js);
      const outcome = runCoreTests(scratch, opts.timeoutMs);
      writeFileSync(file.target, file.baselineJs);

      if (outcome.passed) {
        survived += 1;
        survivors.push({ ...mutant, snippet: siteSnippet(file.text, mutant) });
      } else {
        killed += 1;
      }
      if (opts.verbose) {
        process.stdout.write(
          `  ${outcome.passed ? 'SURVIVED' : 'killed  '} ${file.name}:${mutant.line} ` +
            `[${mutant.operator}] ${mutant.detail}${outcome.timedOut ? ' (timeout)' : ''} ` +
            `(--file ${file.name} --mutant ${mutant.index})\n`,
        );
      }
    }

    totalKilled += killed;
    totalSurvived += survived;
    rows.push({
      file: file.name,
      sites: all.length,
      mutants: killed + survived,
      killed,
      survived,
      skipped,
      score: score(killed, survived),
    });
  }

  report(opts, rows, survivors, invalid, totalKilled, totalSurvived, Date.now() - startedAt);
  return 0;
}

function report(opts, rows, survivors, invalid, totalKilled, totalSurvived, durationMs) {
  const width = Math.max(12, ...rows.map((r) => r.file.length));
  const lines = [
    '',
    `mutate-core: seed ${opts.seed}, up to ${opts.perFile} mutants per file — ` +
      `${totalKilled + totalSurvived} mutants over ${rows.length} files in ` +
      `${(durationMs / 1000).toFixed(1)} s`,
    '',
    `  ${pad('file', width)}  ${padStart('sites', 6)}  ${padStart('mutants', 8)}  ` +
      `${padStart('killed', 7)}  ${padStart('survived', 9)}  ${padStart('invalid', 8)}  ` +
      `${padStart('score', 7)}`,
    `  ${'-'.repeat(width)}  ${'-'.repeat(6)}  ${'-'.repeat(8)}  ${'-'.repeat(7)}  ` +
      `${'-'.repeat(9)}  ${'-'.repeat(8)}  ${'-'.repeat(7)}`,
  ];
  for (const row of rows) {
    lines.push(
      `  ${pad(row.file, width)}  ${padStart(row.sites, 6)}  ${padStart(row.mutants, 8)}  ` +
        `${padStart(row.killed, 7)}  ${padStart(row.survived, 9)}  ${padStart(row.skipped, 8)}  ` +
        `${padStart(formatScore(row.score), 7)}`,
    );
  }
  const total = score(totalKilled, totalSurvived);
  lines.push(
    `  ${'-'.repeat(width)}  ${'-'.repeat(6)}  ${'-'.repeat(8)}  ${'-'.repeat(7)}  ` +
      `${'-'.repeat(9)}  ${'-'.repeat(8)}  ${'-'.repeat(7)}`,
    `  ${pad('TOTAL', width)}  ${padStart(
      rows.reduce((n, r) => n + r.sites, 0),
      6,
    )}  ` +
      `${padStart(totalKilled + totalSurvived, 8)}  ${padStart(totalKilled, 7)}  ` +
      `${padStart(totalSurvived, 9)}  ${padStart(
        rows.reduce((n, r) => n + r.skipped, 0),
        8,
      )}  ` +
      `${padStart(formatScore(total), 7)}`,
    '',
    `mutate-core: mutation score ${formatScore(total)} (informational — this never fails a build)`,
  );

  if (survivors.length > 0) {
    lines.push(
      '',
      `mutate-core: ${survivors.length} survivor(s) — each is behaviour no core test pins down:`,
    );
    for (const s of survivors) {
      lines.push(
        `  src/core/${basename(s.file)}:${s.line}:${s.column}  [${s.operator}] ${s.detail}`,
        `      ${s.snippet}`,
        `      replay: node scripts/mutate-core.mjs --seed ${opts.seed} ` +
          `--per-file ${opts.perFile} --file ${basename(s.file)} --mutant ${s.index}`,
      );
    }
  }
  if (invalid.length > 0 && opts.verbose) {
    lines.push('', `mutate-core: ${invalid.length} mutant(s) were not expressible:`);
    for (const m of invalid) {
      lines.push(
        `  src/core/${basename(m.file)}:${m.line} [${m.operator}] ${m.detail} — ${m.reason}`,
      );
    }
  }
  lines.push('');
  process.stdout.write(lines.join('\n'));

  if (opts.report !== null) {
    writeFileSync(
      opts.report,
      `${JSON.stringify(
        {
          seed: opts.seed,
          perFile: opts.perFile,
          node: process.version,
          durationMs,
          killed: totalKilled,
          survived: totalSurvived,
          score: total,
          files: rows,
          survivors: survivors.map((s) => ({
            file: `src/core/${basename(s.file)}`,
            line: s.line,
            column: s.column,
            operator: s.operator,
            detail: s.detail,
          })),
        },
        null,
        2,
      )}\n`,
    );
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  let sources;
  try {
    sources = readdirSync(CORE_SRC)
      .filter((f) => f.endsWith('.ts'))
      .sort();
  } catch (error) {
    bail(`cannot read src/core (${error instanceof Error ? error.message : String(error)})`);
  }
  if (opts.file !== null) {
    const wanted = basename(opts.file).replace(/\.ts$/, '');
    sources = sources.filter((f) => basename(f, '.ts') === wanted);
    if (sources.length === 0) bail(`no file in src/core matches --file "${opts.file}"`);
  }
  if (opts.mutant !== null && opts.file === null) bail('--mutant needs --file');

  try {
    readdirSync(join(BUILD, 'src', 'core'));
    readdirSync(join(REPO, CORE_TESTS));
  } catch {
    bail('no compiled build/ — run `npm run build` first');
  }

  return run(opts, sources, makeScratch());
}

// Informational by contract: any exit from here is 0.
process.exit(main());
