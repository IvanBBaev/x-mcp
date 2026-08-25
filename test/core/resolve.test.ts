// Tests for core/resolve — identifier resolution + cache (REND-8). Covers every input
// form (numeric id / handle / @handle / status URL / profile URL / "me"), the id↔handle
// cache hit that avoids a re-lookup, and malformed input rejected as `validation`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { XError } from '../../src/core/errors.js';
import {
  classifyUserRef,
  createResolveCache,
  parsePostId,
  resolveUserId,
} from '../../src/core/resolve.js';
import type { HandleLookup, UserIdentity } from '../../src/core/resolve.js';

/** A predicate for assert.throws / assert.rejects that also checks the XError kind. */
const isKind =
  (kind: string) =>
  (err: unknown): true => {
    assert.ok(XError.is(err), 'expected an XError');
    assert.equal(err.kind, kind);
    return true;
  };

/** A handle lookup that records its calls and returns a fixed result. */
function spyLookup(result: UserIdentity | null) {
  const calls: string[] = [];
  const fn: HandleLookup = (handle) => {
    calls.push(handle);
    return Promise.resolve(result);
  };
  return { fn, calls };
}

// --- classifyUserRef: id / handle / @handle / me forms (REND-8) -------------------

test('REND-8: classifyUserRef distinguishes id, @handle, bare handle, and the "me" sentinel', () => {
  assert.deepEqual(classifyUserRef('12345'), { kind: 'id', id: '12345' });
  assert.deepEqual(classifyUserRef('@jack'), { kind: 'handle', handle: 'jack' });
  assert.deepEqual(classifyUserRef('jack'), { kind: 'handle', handle: 'jack' });
  assert.deepEqual(classifyUserRef('  jack  '), { kind: 'handle', handle: 'jack' });
  assert.deepEqual(classifyUserRef('me'), { kind: 'me' });
  assert.deepEqual(classifyUserRef('ME'), { kind: 'me' });
  // `@me` is an explicit handle, NEVER the self sentinel — a real @me account stays reachable.
  assert.deepEqual(classifyUserRef('@me'), { kind: 'handle', handle: 'me' });
  // An all-digit token is an id; `@12345` forces handle interpretation.
  assert.deepEqual(classifyUserRef('@12345'), { kind: 'handle', handle: '12345' });
});

test('REND-8: classifyUserRef extracts the handle from a profile URL', () => {
  assert.deepEqual(classifyUserRef('https://twitter.com/user'), { kind: 'handle', handle: 'user' });
  assert.deepEqual(classifyUserRef('https://x.com/Jack'), { kind: 'handle', handle: 'Jack' });
  assert.deepEqual(classifyUserRef('https://www.x.com/foo?lang=en'), {
    kind: 'handle',
    handle: 'foo',
  });
  assert.deepEqual(classifyUserRef('https://mobile.twitter.com/bar/'), {
    kind: 'handle',
    handle: 'bar',
  });
  // Protocol-less X host is still recognized as a URL.
  assert.deepEqual(classifyUserRef('x.com/baz'), { kind: 'handle', handle: 'baz' });
});

test('REND-8: classifyUserRef rejects malformed user input as `validation`', () => {
  assert.throws(() => classifyUserRef(''), isKind('validation'));
  assert.throws(() => classifyUserRef('@'), isKind('validation'));
  assert.throws(() => classifyUserRef('has space'), isKind('validation'));
  assert.throws(() => classifyUserRef('sixteen_char_nam'), isKind('validation')); // 16 chars
  assert.throws(() => classifyUserRef('foo-bar'), isKind('validation'));
  // A status URL is a post reference, not a user reference.
  assert.throws(() => classifyUserRef('https://x.com/user/status/123'), isKind('validation'));
  // A reserved app route is not a username.
  assert.throws(() => classifyUserRef('https://x.com/home'), isKind('validation'));
  // A non-X host is not accepted even though it mentions x.com in the path.
  assert.throws(() => classifyUserRef('https://evil.com/x.com/jack'), isKind('validation'));
});

// --- parsePostId: bare id / status URL forms (REND-8) ----------------------------

test('REND-8: parsePostId accepts a bare id and every status-URL form', () => {
  assert.equal(parsePostId('123'), '123');
  assert.equal(parsePostId('https://x.com/user/status/123'), '123');
  assert.equal(parsePostId('https://twitter.com/user/status/456?s=20'), '456');
  assert.equal(parsePostId('x.com/user/status/789'), '789'); // protocol-less
  assert.equal(parsePostId('https://x.com/i/web/status/321'), '321');
  assert.equal(parsePostId('https://x.com/user/status/555/photo/1'), '555');
});

test('REND-8: parsePostId rejects handles, profile URLs, and non-numeric ids as `validation`', () => {
  assert.throws(() => parsePostId(''), isKind('validation'));
  assert.throws(() => parsePostId('jack'), isKind('validation'));
  assert.throws(() => parsePostId('@jack'), isKind('validation'));
  assert.throws(() => parsePostId('https://x.com/user'), isKind('validation')); // profile, no status
  assert.throws(() => parsePostId('https://x.com/user/status/abc'), isKind('validation'));
});

test('REND-8: a pathological identifier is echoed back capped, not in full', () => {
  // Every refusal quotes the input so the agent can see what it sent — which makes the echo
  // an amplification path: a 1 MB argument would otherwise land verbatim in the model's
  // context, once per retry. The cap is 80 code points, with the last three spent on the
  // ellipsis that tells the agent the value was shortened.
  const long = 'z'.repeat(5000);
  assert.throws(
    () => parsePostId(long),
    (error: unknown) => {
      assert.ok(XError.is(error));
      const quoted = /"([^"]*)"/.exec(error.message)?.[1];
      assert.ok(quoted !== undefined, 'the refusal did not quote its input at all');
      assert.equal(quoted.length, 80);
      assert.ok(quoted.endsWith('...'));
      return true;
    },
  );
  // A value that fits is echoed WHOLE — no ellipsis, nothing shaved off the end.
  const short = 'z'.repeat(80);
  assert.throws(
    () => parsePostId(short),
    (error: unknown) => XError.is(error) && error.message.includes(`"${short}"`),
    'an 80-character input was truncated even though it fits',
  );
});

test('REND-8: a handle passed where a post id belongs is named as such, not lumped in with junk', () => {
  // Both refusals are `validation`, so asserting the kind alone leaves the branch that
  // distinguishes them free to invert unnoticed — a mutation run over this module proved it.
  // The message IS the value here: an agent that confused the two argument kinds needs to be
  // told which one it supplied, or its retry is a guess.
  for (const handle of ['@jack', 'jack', 'JackDorsey_99']) {
    assert.throws(
      () => parsePostId(handle),
      (error: unknown) =>
        XError.is(error) &&
        error.kind === 'validation' &&
        /not a handle/.test(error.message) &&
        error.message.includes(handle),
      `parsePostId("${handle}") did not identify its input as a handle`,
    );
  }
  // Anything that is neither a handle nor an id falls through to the generic refusal, which
  // must NOT claim the input was a handle.
  for (const junk of ['???', 'a b c', 'https://example.com/status/1']) {
    assert.throws(
      () => parsePostId(junk),
      (error: unknown) =>
        XError.is(error) && error.kind === 'validation' && !/not a handle/.test(error.message),
      `parsePostId("${junk}") mislabeled a non-handle as a handle`,
    );
  }
});

// --- cache -----------------------------------------------------------------------

test('REND-8: createResolveCache maps id↔handle both ways, case-insensitively', () => {
  const cache = createResolveCache();
  assert.equal(cache.size, 0);
  assert.equal(cache.getIdByHandle('jack'), undefined);

  cache.set({ id: '1', handle: 'Jack' });
  assert.equal(cache.getIdByHandle('jack'), '1');
  assert.equal(cache.getIdByHandle('JACK'), '1');
  assert.equal(cache.getIdByHandle('@Jack'), '1');
  assert.equal(cache.getHandleById('1'), 'Jack'); // display casing preserved
  assert.equal(cache.size, 1);

  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.getIdByHandle('jack'), undefined);
});

// --- resolveUserId orchestration -------------------------------------------------

test('REND-8: resolveUserId passes a numeric id through without calling the lookup', async () => {
  const lookup = spyLookup(null);
  assert.equal(await resolveUserId('42', { lookup: lookup.fn }), '42');
  assert.equal(lookup.calls.length, 0);
});

test('REND-8: resolveUserId resolves a handle miss via the injected lookup and caches it', async () => {
  const cache = createResolveCache();
  const lookup = spyLookup({ id: '99', handle: 'jack' });

  assert.equal(await resolveUserId('@jack', { lookup: lookup.fn, cache }), '99');
  assert.deepEqual(lookup.calls, ['jack']);
  assert.equal(cache.getIdByHandle('jack'), '99');
  assert.equal(cache.getHandleById('99'), 'jack');
});

test('REND-8: resolveUserId serves a cache hit and avoids a re-lookup', async () => {
  const cache = createResolveCache();
  cache.set({ id: '99', handle: 'jack' });
  const lookup = spyLookup({ id: 'WRONG', handle: 'jack' });

  assert.equal(await resolveUserId('jack', { lookup: lookup.fn, cache }), '99');
  assert.equal(lookup.calls.length, 0, 'cache hit must not hit the network');
});

test('REND-8: resolveUserId surfaces an unknown handle as `not-found` naming the form', async () => {
  const lookup = spyLookup(null);
  await assert.rejects(resolveUserId('@ghost', { lookup: lookup.fn }), (err: unknown): true => {
    assert.ok(XError.is(err));
    assert.equal(err.kind, 'not-found');
    assert.match(err.message, /@ghost/);
    return true;
  });
  assert.deepEqual(lookup.calls, ['ghost']);
});

test('resolveUserId resolves "me" from the provided self id, and errors without it', async () => {
  const lookup = spyLookup(null);
  assert.equal(await resolveUserId('me', { lookup: lookup.fn, me: '7' }), '7');
  assert.equal(lookup.calls.length, 0, '"me" must never reach the username lookup');

  await assert.rejects(resolveUserId('me', { lookup: lookup.fn }), isKind('validation'));
});

test('REND-8: resolveUserId rejects malformed input before any lookup', async () => {
  const lookup = spyLookup({ id: '1', handle: 'x' });
  await assert.rejects(resolveUserId('foo bar', { lookup: lookup.fn }), isKind('validation'));
  assert.equal(lookup.calls.length, 0);
});
