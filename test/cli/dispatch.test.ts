// The T-101 subcommand router. It has no other test home: cli.test.ts drives the built
// binary end to end, while the routing table itself — especially the deliberate
// unknown-token fallthrough to `serve` (CFG-5 rejects the token later, with a real
// message, instead of the router guessing) — is a pure function worth pinning directly.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSubcommand } from '../../src/cli/dispatch.js';

test('the three known subcommands route by their first token, shifting it off rest', () => {
  assert.deepEqual(parseSubcommand(['authorize', '--manual']), {
    command: 'authorize',
    rest: ['--manual'],
  });
  assert.deepEqual(parseSubcommand(['doctor']), { command: 'doctor', rest: [] });
  assert.deepEqual(parseSubcommand(['serve']), { command: 'serve', rest: [] });
});

test('no subcommand and an unknown token both fall through to serve with argv intact', () => {
  // The bare invocation is the production default: `npx x-mcp-ai` serves.
  assert.deepEqual(parseSubcommand([]), { command: 'serve', rest: [] });
  // An unknown token is NOT swallowed — it rides along in `rest` so the composition
  // root can refuse it via the config contract instead of the router silently guessing.
  assert.deepEqual(parseSubcommand(['sevre', '--flag']), {
    command: 'serve',
    rest: ['sevre', '--flag'],
  });
});
