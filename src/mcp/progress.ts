// The MCP progress bridge (WP-3.3, closed 2026-09-07). It turns the media package's
// INTERNAL per-segment upload seam into protocol `notifications/progress` for the
// `tools/call` that started the upload — the half of WP-3.3 that was deliberately left
// unwired until now.
//
// Why a bridge object and not a direct call. `src/tools/media.ts` is built once at startup
// (the INT-6 factory pattern) and closes its progress sink over at build time, while a
// `progressToken` exists only for the duration of one request. The two are correlated by
// the per-call `AbortSignal`: the adapter hands `extra.signal` to `registry.call`, the
// registry threads it into `ToolContext` unchanged (`buildToolContext`), and the media
// package copies that same object onto every event it emits. Object identity — not a
// generated id, not a mutable "current call" field — is what makes N overlapping uploads
// impossible to cross-talk, which is the same MCP-8 argument the adapter already makes.
//
// This module owns that correlation and nothing else. It never touches the transport; the
// adapter does the sending, because only the adapter has the request-scoped
// `sendNotification`.

import type { MediaProgressListener, MediaUploadProgress } from '../tools/media.js';

/** What one bound `tools/call` does with a progress event. Must never throw. */
export type ProgressEmitter = (event: MediaUploadProgress) => void;

/** The composition-root object that couples the media seam to the protocol adapter. */
export interface ProgressBridge {
  /**
   * Bind an emitter to one in-flight call. Returns the release function the adapter MUST
   * call in a `finally`: a binding left in place would hold the request's
   * `sendNotification` closure alive past the response.
   */
  readonly bind: (signal: AbortSignal, emit: ProgressEmitter) => () => void;
  /** The sink handed to `createMediaTools` at composition time. */
  readonly onProgress: MediaProgressListener;
}

/**
 * Build the bridge. One instance per composition — it is process-scoped state, but only in
 * the same sense the rate-limit table is: keyed strictly per call, with no cross-call
 * visibility and nothing to read back.
 */
export function createProgressBridge(): ProgressBridge {
  // A WeakMap, not a Map: the key is the per-call `AbortSignal`, so a binding whose release
  // was somehow skipped still cannot outlive the request that owns it. `release()` is the
  // contract; the weak reference is the backstop.
  const bound = new WeakMap<AbortSignal, ProgressEmitter>();

  return {
    bind: (signal, emit) => {
      bound.set(signal, emit);
      return () => {
        bound.delete(signal);
      };
    },
    onProgress: (event) => {
      // No signal on the event means the call carried no cancellation signal, so there is
      // nothing to correlate it with. The upload runs exactly as before; it just reports
      // nothing. Progress is advisory in both directions (MEDIA-7).
      const signal = event.signal;
      if (signal === undefined) return;
      bound.get(signal)?.(event);
    },
  };
}
