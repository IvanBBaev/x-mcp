// Tests for core/errors.ts (T-102): the frozen `XError` taxonomy. Most of the taxonomy's
// behaviour (kind/retryable/fix defaults, `toPayload`) is already pinned indirectly by every
// other test/core file that throws through it. This file covers the one piece nothing else
// exercises: `cause` propagation into the native `Error` chain (docs/02 §5.5 — "Underlying
// cause ... never surfaced to the agent").

import test from 'node:test';
import assert from 'node:assert/strict';

import { networkError, XError } from '../../src/core/errors.js';

test('a supplied cause is attached to the resulting error, unwrapped and unmodified', () => {
  const cause = new Error('ECONNRESET');
  const err = networkError('Connection reset.', { cause });
  assert.equal(err.cause, cause);
});

test('with no cause supplied, the error carries no `cause` property at all', () => {
  const err = networkError('Connection reset.');
  assert.equal(err.cause, undefined);
  assert.equal(Object.hasOwn(err, 'cause'), false);
});

test('XError.is narrows unknown values thrown across an async boundary', () => {
  const err: unknown = networkError('boom');
  assert.equal(XError.is(err), true);
  assert.equal(XError.is(new Error('plain')), false);
});
