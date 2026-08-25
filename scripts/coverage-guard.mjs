// Coverage guard for `npm run test:coverage` (and therefore `npm run check` /
// `prepublishOnly`) — ported from the servicenow-mcp-ai family and extended with
// the mechanical floors docs/05 §4 requires (reviews/04-qa-review.md F8).
//
// Two modes:
//   node scripts/coverage-guard.mjs preflight   — before c8 runs
//   node scripts/coverage-guard.mjs floors      — after c8 wrote coverage-summary.json
//
// c8 itself enforces the GLOBAL thresholds (--check-coverage --lines 90
// --branches 80 --functions 95). This script enforces what c8 cannot express in
// one run: a per-file lines floor so an entirely untested new file cannot ride
// in on over-covered neighbors, and per-module 100/100 floors for the small,
// security-load-bearing modules. Ratchets go UP only — never lower a number here.

import { readFileSync } from 'node:fs';
import process from 'node:process';

// Per-file floor (docs/05 §4): every measured source file needs ≥ 80% lines.
const PER_FILE_LINES_FLOOR = 80;

// Per-module floors (docs/05 §4): pure, small, and security-load-bearing —
// core/policy and core/budget hold 100 lines / 100 branches from day one.
const MODULE_FLOORS = [
  { match: /src\/core\/policy\.(?:ts|js)$/, lines: 100, branches: 100 },
  { match: /src\/core\/budget\.(?:ts|js)$/, lines: 100, branches: 100 },
];

const SUMMARY_PATH = 'coverage/coverage-summary.json';

function preflight() {
  // c8@10/11 pull yargs@17, whose extensionless CJS entry lives under a
  // "type":"module" package; Node >= 25 loads it as ESM and crashes with a
  // cryptic `ReferenceError: require is not defined in ES module scope` before
  // any coverage runs. Fail fast with an actionable message instead.
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major >= 25) {
    process.stderr.write(
      `\nCoverage (c8) is not supported on Node ${process.versions.node}.\n` +
        `c8's yargs dependency crashes on Node >= 25 and has no compatible release yet.\n\n` +
        `  • Use the pinned runtime:        nvm use      (.nvmrc pins Node 22)\n` +
        `  • Or run a coverage-free gate:   npm run verify\n\n`,
    );
    process.exit(1);
  }
}

function floors() {
  let summary;
  try {
    summary = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8'));
  } catch (error) {
    process.stderr.write(
      `coverage-guard: cannot read ${SUMMARY_PATH} — run c8 with --reporter=json-summary first ` +
        `(${error instanceof Error ? error.message : String(error)})\n`,
    );
    process.exit(1);
  }

  const failures = [];
  for (const [file, metrics] of Object.entries(summary)) {
    if (file === 'total') continue;
    const lines = metrics.lines?.pct ?? 0;
    const branches = metrics.branches?.pct ?? 0;
    if (lines < PER_FILE_LINES_FLOOR) {
      failures.push(`${file}: lines ${lines}% < per-file floor ${PER_FILE_LINES_FLOOR}%`);
    }
    for (const floor of MODULE_FLOORS) {
      if (!floor.match.test(file)) continue;
      if (lines < floor.lines)
        failures.push(`${file}: lines ${lines}% < module floor ${floor.lines}%`);
      if (branches < floor.branches) {
        failures.push(`${file}: branches ${branches}% < module floor ${floor.branches}%`);
      }
    }
  }

  if (failures.length > 0) {
    process.stderr.write(`coverage-guard: FAIL\n  ${failures.join('\n  ')}\n`);
    process.exit(1);
  }
  process.stdout.write('coverage-guard: per-file and module floors hold\n');
}

const mode = process.argv[2];
if (mode === 'preflight') preflight();
else if (mode === 'floors') floors();
else {
  process.stderr.write('coverage-guard: usage — coverage-guard.mjs <preflight|floors>\n');
  process.exit(1);
}
