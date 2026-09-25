// DRIFT-4 guard (docs/07-corner-cases.md DRIFT-4, docs/05 §5): every X API fixture under
// test/fixtures/ carries a top-level `_provenance` string that names its source and a date,
// so a fixture can never land without saying where its shape came from and how old it is.
// `structured/` is exempt: it holds the outputSchema contract baseline, not an X envelope.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';

const ROOT = join(process.cwd(), 'test', 'fixtures');
const EXEMPT_DIRS = new Set(['structured']);

function jsonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) return jsonFiles(abs);
    return entry.name.endsWith('.json') ? [abs] : [];
  });
}

const fixtures = jsonFiles(ROOT)
  .map((abs) => relative(ROOT, abs).split(sep).join('/'))
  .filter((rel) => !EXEMPT_DIRS.has(rel.split('/')[0] ?? ''))
  .sort();

test('DRIFT-4: the fixture tree is not empty', () => {
  assert.ok(fixtures.length > 0, `no fixtures found under ${ROOT}`);
});

test('DRIFT-4: every X API fixture carries a dated _provenance string', () => {
  const failures: string[] = [];
  for (const rel of fixtures) {
    const body: unknown = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
    const provenance =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)['_provenance']
        : undefined;
    if (typeof provenance !== 'string' || provenance.trim() === '') {
      failures.push(`${rel}: missing a top-level "_provenance" string`);
    } else if (!/\b\d{4}-\d{2}-\d{2}\b/.test(provenance)) {
      failures.push(`${rel}: "_provenance" names no capture/authoring date (YYYY-MM-DD)`);
    }
  }
  assert.deepEqual(failures, [], `fixtures without usable provenance:\n${failures.join('\n')}`);
});
