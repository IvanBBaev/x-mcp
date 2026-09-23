// The PLAT-2 degradation notice in openNoFollow (media.ts) defaults to process.stderr
// when the caller wires no `warn` port. The once-latch is module-level, so this test
// lives in its own file: media.test.ts latches the flag through its injected-warn
// MEDIA-5 test, which would make the default arm unreachable in that process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openNoFollow } from '../../src/tools/media.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'x-mcp-media-nofollow-test-'));
test.after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('MEDIA-5/PLAT-2: with no warn port the degradation notice lands on stderr, once', async () => {
  const target = join(tmpRoot, 'plain.png');
  writeFileSync(target, 'contents are irrelevant here');
  const writes: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    writes.push(String(chunk));
    return true;
  };
  try {
    // Two degraded opens (`nofollow: 0` pins the win32 branch on every platform); the
    // operator must be told about the weaker check exactly once, not once per upload.
    for (let i = 0; i < 2; i += 1) {
      const handle = await openNoFollow(target, target, { mediaDir: tmpRoot }, 0);
      await handle.close();
    }
  } finally {
    process.stderr.write = realWrite;
  }
  const notices = writes.filter((line) => line.includes('O_NOFOLLOW'));
  assert.equal(notices.length, 1, `expected one stderr notice, got ${String(notices.length)}`);
  assert.match(notices[0] ?? '', /O_NOFOLLOW is unavailable/);
  assert.match(notices[0] ?? '', /PLAT-2/);
  // Same single-line JSON envelope as every other non-fatal notice (CFG-5): {ts, level, msg}.
  const record: unknown = JSON.parse(notices[0] ?? '');
  assert.deepEqual(Object.keys(record as object).sort(), ['level', 'msg', 'ts']);
  assert.equal((record as { level: string }).level, 'warn');
  assert.match((record as { msg: string }).msg, /^O_NOFOLLOW is unavailable/);
  // The default writer terminates the line itself — stderr is a stream, not a logger.
  assert.ok((notices[0] ?? '').endsWith('\n'));
});
