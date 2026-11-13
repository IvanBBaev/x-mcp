// F-5 self-serve removal note: only a `forbidden` XError is decorated; everything else
// passes through as the very same value.

import test from 'node:test';
import assert from 'node:assert/strict';

import { XError } from '../../src/core/errors.js';
import { selfServeRemovalNote, withSelfServeRemovalNote } from '../../src/tools/self-serve.js';

test('F-5: a forbidden XError keeps its class, retryable, fix and data and gains the note', () => {
  const original = new XError('forbidden', 'X refused.', {
    retryable: false,
    fix: 'operator',
    data: { http_status: 403 },
  });
  const out = withSelfServeRemovalNote(original, 'follow');
  assert.ok(XError.is(out));
  assert.notEqual(out, original);
  assert.equal(out.kind, 'forbidden');
  assert.equal(out.message, 'X refused.' + selfServeRemovalNote('follow'));
  assert.equal(out.retryable, false);
  assert.equal(out.fix, 'operator');
  assert.deepEqual(out.data, { http_status: 403 });
  assert.equal(out.cause, original);
});

test('F-5: other error kinds and non-XError values pass through untouched', () => {
  const rateLimited = new XError('rate-limit', 'Slow down.', { retryable: true });
  assert.equal(withSelfServeRemovalNote(rateLimited, 'like'), rateLimited);
  const plain = new Error('boom');
  assert.equal(withSelfServeRemovalNote(plain, 'quote'), plain);
  assert.equal(withSelfServeRemovalNote('text', 'like'), 'text');
});

test('F-5: the note names each surface', () => {
  assert.match(selfServeRemovalNote('like'), /likes via the API/);
  assert.match(selfServeRemovalNote('follow'), /follows via the API/);
  assert.match(selfServeRemovalNote('quote'), /quote-posts via the API/);
});
