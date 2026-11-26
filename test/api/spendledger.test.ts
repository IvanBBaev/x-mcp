// api/spendledger — the append-only JSONL LedgerStore behind the Q15 spend ledger (docs/07
// §21 LEDGER-5/6/7). Real files in a private temp dir, plus an injected fs for the failures.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileLedgerStore, parseLedgerLine } from '../../src/api/spendledger.js';
import type { LedgerFs } from '../../src/api/spendledger.js';
import { createSpendLedger } from '../../src/core/ledger.js';

import { fakeClock } from '../helpers/index.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'x-mcp-spendledger-test-'));
let seq = 0;
const freshPath = (): string => join(tmpRoot, `case-${++seq}`, 'spend-ledger.jsonl');

test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const NOON = Date.UTC(2026, 10, 26, 12);

test('parseLedgerLine accepts only finite {t,u} entries', () => {
  assert.deepEqual(parseLedgerLine('{"t":1,"u":0.5}'), { at: 1, usd: 0.5 });
  assert.deepEqual(parseLedgerLine('{"t":1,"u":-0.5,"x":true}'), { at: 1, usd: -0.5 });
  for (const bad of [
    '',
    '   ',
    'nope',
    '[]',
    'null',
    '{"t":"1","u":1}',
    '{"t":1}',
    '{"t":1,"u":1e999}',
  ]) {
    assert.equal(parseLedgerLine(bad), undefined, bad);
  }
});

test('LEDGER-1: a missing file reads as empty and is not created by reading', () => {
  const path = freshPath();
  const store = createFileLedgerStore(path);
  assert.deepEqual(store.readNew(), { reset: false, entries: [] });
  assert.throws(() => statSync(path), { code: 'ENOENT' });
});

test('LEDGER-2: append creates the directory and file, one JSON line per entry', () => {
  const path = freshPath();
  const store = createFileLedgerStore(path);
  store.append({ at: NOON, usd: 0.005 });
  store.append({ at: NOON, usd: -0.005 });
  assert.equal(readFileSync(path, 'utf8'), `{"t":${NOON},"u":0.005}\n{"t":${NOON},"u":-0.005}\n`);
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(path, '..')).mode & 0o777, 0o700);
  }
});

test('LEDGER-5: readNew returns only what was appended since the last read — by anyone', () => {
  const path = freshPath();
  const mine = createFileLedgerStore(path);
  const theirs = createFileLedgerStore(path);
  mine.append({ at: 1, usd: 1 });
  assert.deepEqual(mine.readNew().entries, [{ at: 1, usd: 1 }]);
  theirs.append({ at: 2, usd: 2 });
  assert.deepEqual(mine.readNew(), { reset: false, entries: [{ at: 2, usd: 2 }] });
  assert.deepEqual(mine.readNew().entries, []);
  assert.deepEqual(theirs.readNew().entries, [
    { at: 1, usd: 1 },
    { at: 2, usd: 2 },
  ]);
});

test('LEDGER-6: a trailing partial line waits until its newline arrives', () => {
  const path = freshPath();
  const store = createFileLedgerStore(path);
  store.append({ at: 1, usd: 1 });
  appendFileSync(path, '{"t":2,"u":');
  assert.deepEqual(store.readNew().entries, [{ at: 1, usd: 1 }]);
  assert.deepEqual(store.readNew().entries, []);
  appendFileSync(path, '2}\n');
  assert.deepEqual(store.readNew().entries, [{ at: 2, usd: 2 }]);
});

test('LEDGER-6: malformed lines are skipped, the rest still counts', () => {
  const path = freshPath();
  createFileLedgerStore(path).append({ at: 1, usd: 1 });
  appendFileSync(path, 'garbage\n{"t":2}\n\n{"t":3,"u":3}\n');
  assert.deepEqual(createFileLedgerStore(path).readNew().entries, [
    { at: 1, usd: 1 },
    { at: 3, usd: 3 },
  ]);
});

test('LEDGER-6: truncation, replacement and removal each reset the fold', () => {
  const path = freshPath();
  const store = createFileLedgerStore(path);
  store.append({ at: 1, usd: 1 });
  store.append({ at: 2, usd: 2 });
  store.readNew();

  truncateSync(path, 0);
  writeFileSync(path, '{"t":9,"u":0.5}\n');
  assert.deepEqual(store.readNew(), { reset: true, entries: [{ at: 9, usd: 0.5 }] });

  const replacement = `${path}.new`;
  writeFileSync(replacement, '{"t":7,"u":7}\n{"t":8,"u":8}\n{"t":9,"u":9}\n');
  renameSync(replacement, path); // new inode, even if it is larger
  assert.deepEqual(store.readNew(), {
    reset: true,
    entries: [
      { at: 7, usd: 7 },
      { at: 8, usd: 8 },
      { at: 9, usd: 9 },
    ],
  });

  unlinkSync(path);
  assert.deepEqual(store.readNew(), { reset: true, entries: [] });
  assert.deepEqual(store.readNew(), { reset: false, entries: [] });
});

test(
  'LEDGER-6: append never follows a symlink planted at the ledger path',
  {
    skip: process.platform === 'win32',
  },
  () => {
    const path = freshPath();
    const target = join(tmpRoot, `target-${seq}`);
    writeFileSync(target, '');
    createFileLedgerStore(path).append({ at: 1, usd: 1 }); // creates the directory
    unlinkSync(path);
    symlinkSync(target, path);
    assert.throws(() => createFileLedgerStore(path).append({ at: 2, usd: 2 }), { code: 'ELOOP' });
    assert.equal(readFileSync(target, 'utf8'), '');
  },
);

test('LEDGER-2/5: two ledgers over one real file share the daily cap across restarts', () => {
  const path = freshPath();
  const clock = fakeClock(NOON);
  const options = { clock, mode: 'hard' as const, dailyUsd: 1 };
  const a = createSpendLedger({ store: createFileLedgerStore(path), ...options });
  a.reserve(0.6);
  const b = createSpendLedger({ store: createFileLedgerStore(path), ...options });
  assert.equal(b.snapshot().day.spent_usd, 0.6);
  assert.throws(() => b.reserve(0.5), /over the daily budget of \$1/);
  b.reserve(0.4);
  assert.equal(a.snapshot().day.spent_usd, 1);
});

/** An fs whose every call delegates to node:fs unless the named call is set to fail. */
function failingFs(fail: Partial<Record<keyof LedgerFs, string>>): LedgerFs {
  const real = nodeFs as unknown as Record<keyof LedgerFs, (...a: unknown[]) => unknown>;
  const wrap = <K extends keyof LedgerFs>(name: K): LedgerFs[K] =>
    ((...args: unknown[]) => {
      const code = fail[name];
      if (code !== undefined) throw Object.assign(new Error(`${name} failed`), { code });
      return real[name](...args);
    }) as LedgerFs[K];
  return {
    statSync: wrap('statSync'),
    openSync: wrap('openSync'),
    fstatSync: wrap('fstatSync'),
    readSync: wrap('readSync'),
    writeSync: wrap('writeSync'),
    closeSync: wrap('closeSync'),
    mkdirSync: wrap('mkdirSync'),
  };
}

test('LEDGER-7: non-ENOENT stat errors and write errors propagate with their code', () => {
  const path = freshPath();
  assert.throws(() => createFileLedgerStore(path, failingFs({ statSync: 'EACCES' })).readNew(), {
    code: 'EACCES',
  });
  assert.throws(
    () => createFileLedgerStore(path, failingFs({ mkdirSync: 'EROFS' })).append({ at: 1, usd: 1 }),
    { code: 'EROFS' },
  );
});

test('LEDGER-7: a failed write still closes the descriptor', () => {
  const path = freshPath();
  createFileLedgerStore(path).append({ at: 1, usd: 1 });
  let closed = 0;
  const base = failingFs({ writeSync: 'ENOSPC' });
  const fs: LedgerFs = {
    ...base,
    closeSync: (fd) => {
      closed += 1;
      base.closeSync(fd);
    },
  };
  assert.throws(() => createFileLedgerStore(path, fs).append({ at: 2, usd: 2 }), {
    code: 'ENOSPC',
  });
  assert.equal(closed, 1);
});
