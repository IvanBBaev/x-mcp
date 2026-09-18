// Tests for test/live/harness/cleanup.ts — the create/delete pairing of the live write tier.
// UNGATED: this file runs in the normal `node --test` suite, in CI, on every commit.
//
// The write tier itself cannot run in CI (it creates real public posts, docs/05 §6), so the
// only part of it CI can protect is the DISCIPLINE: the guarantee that every deferred delete
// runs on every exit path, and that a delete which fails is loud rather than swallowed. A
// helper that quietly dropped one cleanup would let a real post outlive a green run — the
// exact outcome the module exists to make impossible — so every exit path is driven here
// with in-memory bodies and an injected logger. No network, no session, nothing is created.

import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanupFailureMessage, withCleanup } from './harness/cleanup.js';

/** A logger that records every line so a test can assert what the operator would see. */
function recorder(): { readonly lines: string[]; readonly log: (line: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    log: (line) => {
      lines.push(line);
    },
  };
}

/** The value a promise rejected with — and a failure if it resolved instead. */
async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return assert.fail('expected the promise to reject');
}

/** The members of an `AggregateError`, or a failure when the value is anything else. */
function membersOf(err: unknown): readonly unknown[] {
  assert.ok(err instanceof AggregateError, `expected an AggregateError, got ${String(err)}`);
  return err.errors as unknown[];
}

const resolved = (): Promise<void> => Promise.resolve();

// --- The clean path --------------------------------------------------------------------

test("the body's value comes back when the body and every cleanup succeed", async () => {
  const rec = recorder();
  let deleted = false;
  const created = { id: '1900000000000000101' };

  const result = await withCleanup(
    async (scope) => {
      await resolved();
      scope.defer('delete post 1900000000000000101', async () => {
        await resolved();
        deleted = true;
      });
      return created;
    },
    { log: rec.log },
  );

  assert.equal(result, created, 'the very value the body returned');
  assert.equal(deleted, true, 'the cleanup ran on the clean path too');
  assert.deepEqual(rec.lines, [], 'nothing is logged when nothing failed');
});

test('a body that registers no cleanups is a plain pass-through', async () => {
  const rec = recorder();
  assert.equal(await withCleanup(() => Promise.resolve(42), { log: rec.log }), 42);
  assert.equal(await withCleanup(() => Promise.resolve(undefined), { log: rec.log }), undefined);
  assert.deepEqual(rec.lines, []);
});

test('the default logger is console.error — a failed cleanup is loud with no options at all', async (t) => {
  const error = t.mock.method(console, 'error', () => undefined);
  const err = await reasonOf(
    withCleanup(async (scope) => {
      await resolved();
      scope.defer('delete post 42', () => Promise.reject(new Error('403 Forbidden')));
    }),
  );
  assert.equal(membersOf(err).length, 1);
  assert.equal(error.mock.callCount(), 1);
  assert.equal(
    error.mock.calls[0]?.arguments[0],
    cleanupFailureMessage('delete post 42', new Error('403 Forbidden')),
  );
});

// --- Order -----------------------------------------------------------------------------

test('cleanups run in LIFO order — the newest artifact is removed first', async () => {
  const order: string[] = [];
  await withCleanup(
    async (scope) => {
      await resolved();
      for (const label of ['a', 'b', 'c']) {
        scope.defer(`delete ${label}`, async () => {
          await resolved();
          order.push(label);
        });
      }
    },
    { log: recorder().log },
  );
  assert.deepEqual(order, ['c', 'b', 'a']);
});

test('cleanups run one at a time — each is awaited before the next starts', async () => {
  const events: string[] = [];
  const cleanup = (label: string) => async () => {
    events.push(`start ${label}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    events.push(`end ${label}`);
  };
  await withCleanup(
    async (scope) => {
      await resolved();
      scope.defer('delete a', cleanup('a'));
      scope.defer('delete b', cleanup('b'));
    },
    { log: recorder().log },
  );
  assert.deepEqual(events, ['start b', 'end b', 'start a', 'end a']);
});

// --- Every exit path -------------------------------------------------------------------

test("cleanups run when the body throws, and the body's own error is what comes out", async () => {
  const rec = recorder();
  const order: string[] = [];
  const failure = new Error('the assertion between create and delete failed');

  const err = await reasonOf(
    withCleanup(
      async (scope) => {
        await resolved();
        scope.defer('delete post 1', async () => {
          await resolved();
          order.push('1');
        });
        scope.defer('delete post 2', async () => {
          await resolved();
          order.push('2');
        });
        throw failure;
      },
      { log: rec.log },
    ),
  );

  assert.equal(err, failure, 'the same error object, not a wrapper');
  assert.deepEqual(order, ['2', '1'], 'every cleanup registered before the throw still ran');
  assert.deepEqual(rec.lines, [], 'a body failure is not a cleanup failure — nothing logged');
});

test('a body that throws a falsy value still fails — the flag decides, not the value', async () => {
  for (const value of [undefined, null, 0, '', false]) {
    let cleaned = false;
    const err = await reasonOf(
      withCleanup(
        async (scope) => {
          await resolved();
          scope.defer('delete post', async () => {
            await resolved();
            cleaned = true;
          });
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- the non-Error arm is the point
          throw value;
        },
        { log: recorder().log },
      ),
    );
    assert.equal(err, value, `throwing ${String(value)} must reject with ${String(value)}`);
    assert.equal(cleaned, true, `the cleanup must run after throwing ${String(value)}`);
  }
});

// --- Loud failures ---------------------------------------------------------------------

test('one failing cleanup does not stop the others, and the failure is logged with its label', async () => {
  const rec = recorder();
  const order: string[] = [];
  const boom = new Error('429 Too Many Requests');

  const err = await reasonOf(
    withCleanup(
      async (scope) => {
        await resolved();
        scope.defer('delete post a', async () => {
          await resolved();
          order.push('a');
        });
        scope.defer('delete post b', () => Promise.reject(boom));
        scope.defer('delete post c', async () => {
          await resolved();
          order.push('c');
        });
      },
      { log: rec.log },
    ),
  );

  assert.deepEqual(order, ['c', 'a'], 'the cleanup registered before the failing one still ran');
  assert.deepEqual(rec.lines, [cleanupFailureMessage('delete post b', boom)]);
  assert.match(rec.lines[0] ?? '', /LIVE CLEANUP FAILED/);
  assert.match(rec.lines[0] ?? '', /delete post b/);
  assert.match(rec.lines[0] ?? '', /delete it by hand/);
  assert.equal(membersOf(err).length, 1);
});

test('cleanup failures alone are re-thrown as an AggregateError carrying every failure, in run order', async () => {
  const rec = recorder();
  const first = new Error('delete 1 failed');
  const second = new Error('delete 2 failed');

  const err = await reasonOf(
    withCleanup(
      async (scope) => {
        await resolved();
        scope.defer('delete post 1', () => Promise.reject(first));
        scope.defer('delete post 2', () => Promise.reject(second));
      },
      { log: rec.log },
    ),
  );

  assert.ok(err instanceof AggregateError);
  assert.match(err.message, /2 live cleanup\(s\) failed/);
  assert.match(err.message, /real artifacts may still exist/);
  const members = membersOf(err);
  assert.equal(members.length, 2);
  assert.equal(rec.lines.length, 2, 'each failure was logged as it happened');

  // LIFO: post 2 was attempted (and failed) first, so it leads the list.
  const [m0, m1] = members;
  assert.ok(m0 instanceof Error);
  assert.ok(m1 instanceof Error);
  assert.equal(m0.message, cleanupFailureMessage('delete post 2', second));
  assert.equal(m1.message, cleanupFailureMessage('delete post 1', first));
  assert.equal(m0.cause, second, 'the original error rides along as `cause`');
  assert.equal(m1.cause, first);
});

test('a cleanup that throws a non-Error value is wrapped with its text and without a cause', async () => {
  const rec = recorder();
  const err = await reasonOf(
    withCleanup(
      async (scope) => {
        await resolved();
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error arm is the point
        scope.defer('delete post 7', () => Promise.reject('socket hang up'));
      },
      { log: rec.log },
    ),
  );
  const [member] = membersOf(err);
  assert.ok(member instanceof Error);
  assert.match(member.message, /delete post 7: socket hang up/);
  assert.equal(member.cause, undefined);
  assert.deepEqual(rec.lines, [cleanupFailureMessage('delete post 7', 'socket hang up')]);
});

test("when the body AND a cleanup fail, the AggregateError leads with the body's error", async () => {
  const rec = recorder();
  const bodyFailure = new Error('x_post_get read-back returned 0 items');
  const cleanupFailure = new Error('x_post_delete: 503');

  const err = await reasonOf(
    withCleanup(
      async (scope) => {
        await resolved();
        scope.defer('delete post 9', () => Promise.reject(cleanupFailure));
        throw bodyFailure;
      },
      { log: rec.log },
    ),
  );

  assert.ok(err instanceof AggregateError);
  assert.match(err.message, /body failed AND 1 cleanup\(s\) failed/);
  const members = membersOf(err);
  assert.equal(members.length, 2, 'neither error is lost');
  assert.equal(members[0], bodyFailure, "the body's error is the first member");
  const [, wrapped] = members;
  assert.ok(wrapped instanceof Error);
  assert.equal(wrapped.cause, cleanupFailure);
  assert.equal(rec.lines.length, 1, 'the cleanup failure was still logged');
});

test("a non-Error body value is still the first member when both fail — the body's throw is kept verbatim", async () => {
  const err = await reasonOf(
    withCleanup(
      async (scope) => {
        await resolved();
        scope.defer('delete post 9', () => Promise.reject(new Error('503')));
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the non-Error arm is the point
        throw 'boom';
      },
      { log: recorder().log },
    ),
  );
  assert.equal(membersOf(err)[0], 'boom');
});

test('every failed cleanup is logged, even when the body failed too', async () => {
  const rec = recorder();
  const err = await reasonOf(
    withCleanup(
      async (scope) => {
        await resolved();
        scope.defer('delete post 1', () => Promise.reject(new Error('one')));
        scope.defer('delete post 2', () => Promise.reject(new Error('two')));
        scope.defer('delete post 3', async () => {
          await resolved();
        });
        throw new Error('body');
      },
      { log: rec.log },
    ),
  );
  assert.equal(membersOf(err).length, 3, 'body + two cleanup failures');
  assert.deepEqual(
    rec.lines.map((line) => /delete post \d/.exec(line)?.[0]),
    ['delete post 2', 'delete post 1'],
  );
});

// --- cleanupFailureMessage -------------------------------------------------------------

test('cleanupFailureMessage carries the label and the Error message, and says to delete by hand', () => {
  const message = cleanupFailureMessage('delete post 1900000000000000101', new Error('403'));
  assert.match(message, /^LIVE CLEANUP FAILED/);
  assert.match(message, /delete post 1900000000000000101: 403/);
  assert.match(message, /may still exist on the live account/);
  assert.match(message, /delete it by hand/);
});

test('cleanupFailureMessage stringifies a non-Error thrown value', () => {
  assert.match(
    cleanupFailureMessage('delete post 1', 'socket hang up'),
    /delete post 1: socket hang up\./,
  );
  assert.match(cleanupFailureMessage('delete post 1', 503), /delete post 1: 503\./);
  assert.match(cleanupFailureMessage('delete post 1', undefined), /delete post 1: undefined\./);
});
