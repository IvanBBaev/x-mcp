// Cleanup discipline for the live suite (docs/05 §6: "every write is paired with its
// cleanup in a `finally`"). Owned by the live-test slice.
//
// The live write tier creates REAL public posts. A post that is created and not deleted is
// litter on a real timeline that no later test run will ever clean up, so the deletion must
// run even when the assertion between create and delete fails — that is what `finally` is
// for. This module makes the pairing structural instead of a convention a future edit can
// forget: you cannot create inside `withCleanup` without a place to defer the delete, and
// the deferred work runs on every exit path.
//
// The other half is just as important: a cleanup that FAILS must be loud. Swallowing it
// would leave a real post up while the suite reports green, which is the worst possible
// outcome — the litter exists and nobody knows. So:
//
//   * deferred cleanups run in LIFO order (the newest artifact is removed first);
//   * every failure is logged immediately, with its label;
//   * one failing cleanup does NOT stop the others from running;
//   * failures are re-thrown as an `AggregateError`, and when the body ALSO failed the
//     body's error is the first member — neither error is ever lost.

/** The handle a body uses to pair each artifact it creates with its removal. */
export interface CleanupScope {
  /**
   * Register work that must happen on the way out, whatever else happens. `label` names the
   * artifact well enough that a failed cleanup tells the operator what to delete by hand
   * (e.g. `delete post 1900000000000000101`).
   */
  defer(label: string, fn: () => Promise<void>): void;
}

export interface WithCleanupOptions {
  /** Where loud failures go. Defaults to `console.error`. Injected in tests. */
  readonly log?: (line: string) => void;
}

interface Deferred {
  readonly label: string;
  readonly fn: () => Promise<void>;
}

/** The message a failed cleanup prints and carries. Exported so tests assert the wording. */
export function cleanupFailureMessage(label: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `LIVE CLEANUP FAILED — ${label}: ${detail}. The artifact may still exist on the live account; delete it by hand.`;
}

/**
 * Run `body` with a cleanup scope, then run every deferred cleanup in a `finally`.
 *
 * Returns the body's value when everything succeeded. Throws:
 *   * the body's error, when the body failed and all cleanups succeeded;
 *   * an `AggregateError` of the cleanup errors, when only cleanups failed;
 *   * an `AggregateError` whose first member is the body's error, when both failed.
 */
export async function withCleanup<T>(
  body: (scope: CleanupScope) => Promise<T>,
  options: WithCleanupOptions = {},
): Promise<T> {
  const log = options.log ?? ((line: string) => console.error(line));
  const deferred: Deferred[] = [];
  const scope: CleanupScope = {
    defer(label, fn) {
      deferred.push({ label, fn });
    },
  };

  // A separate flag rather than `bodyError !== undefined`: a body is free to throw a falsy
  // or undefined value, and losing that would turn a failure into a silent pass.
  let bodyFailed = false;
  let bodyError: unknown;
  let value: T | undefined;
  try {
    value = await body(scope);
  } catch (err) {
    bodyFailed = true;
    bodyError = err;
  }

  // LIFO — the most recently created artifact is removed first.
  const cleanupErrors: Error[] = [];
  for (let i = deferred.length - 1; i >= 0; i -= 1) {
    const entry = deferred[i];
    if (entry === undefined) continue;
    try {
      await entry.fn();
    } catch (err) {
      const message = cleanupFailureMessage(entry.label, err);
      log(message);
      cleanupErrors.push(new Error(message, err instanceof Error ? { cause: err } : {}));
    }
  }

  if (bodyFailed && cleanupErrors.length > 0) {
    throw new AggregateError(
      [bodyError, ...cleanupErrors],
      `the live write body failed AND ${String(cleanupErrors.length)} cleanup(s) failed`,
    );
  }
  if (bodyFailed) throw bodyError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `${String(cleanupErrors.length)} live cleanup(s) failed — real artifacts may still exist`,
    );
  }
  return value as T;
}
