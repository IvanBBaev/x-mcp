// F-5 (docs/reviews/11): X's 2026-04-16 changelog says "Following, Likes, and Quote-Posts
// via the API have been removed from all self-serve tiers." The endpoint pages and the
// pricing rows are still published, so whether a pay-per-use account is refused is not
// settled until a live check runs. Until then a `forbidden` from one of those surfaces
// keeps its class and gains one sentence naming the likely cause, so the agent stops
// retrying and tells the user instead.
//
// ASSUMPTION: no capture of this refusal exists, so the note is keyed on the error CLASS
// (`forbidden`) and the surface only, never on the platform's wording. A `forbidden` that
// another rule already explained (duplicate post, POST-10, POST-11) is left alone by its
// caller.

import { XError } from '../core/errors.js';

/** The surfaces the changelog names. */
export type SelfServeSurface = 'like' | 'follow' | 'quote';

const SURFACE_LABEL: Record<SelfServeSurface, string> = {
  like: 'likes',
  follow: 'follows',
  quote: 'quote-posts',
};

/** The sentence appended to the refusal for `surface`. */
export function selfServeRemovalNote(surface: SelfServeSurface): string {
  return (
    ` X's 2026-04-16 changelog says ${SURFACE_LABEL[surface]} via the API were removed ` +
    'from all self-serve tiers. If this account is on pay-per-use or another self-serve ' +
    'plan, this refusal is likely that restriction and retrying will not help.'
  );
}

/**
 * Append the F-5 note to a `forbidden` XError raised by `surface`; any other value passes
 * through unchanged. The class, `retryable`, `fix` and platform `data` are preserved.
 */
export function withSelfServeRemovalNote(err: unknown, surface: SelfServeSurface): unknown {
  if (!XError.is(err) || err.kind !== 'forbidden') return err;
  return new XError(err.kind, err.message + selfServeRemovalNote(surface), {
    retryable: err.retryable,
    fix: err.fix,
    data: err.data,
    cause: err,
  });
}
