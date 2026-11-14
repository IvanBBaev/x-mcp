// The MCP progress bridge (WP-3.3 follow-up, queue Q01). Turns the media package's
// internal per-segment progress events into protocol `notifications/progress` for the
// `tools/call` that asked for them.
//
// Correlation is by the call's AbortSignal: the SDK hands every request its own signal
// (`extra.signal`), the registry threads that same object into `ToolContext.signal`, and
// the media package echoes it on every progress event. So the adapter binds
// `signal -> sink` for exactly the lifetime of one `tools/call` that carried a
// `_meta.progressToken`, and the listener looks the event's signal up. A WeakMap keeps the
// table free of per-call leaks and of cross-talk between overlapping calls (MCP-8): an
// event can only ever reach the call whose signal it carries.
//
// Progress is advisory. Nothing here can fail a call: an unbound signal is a no-op, a
// throwing sink is swallowed, and a non-increasing value is dropped (the spec requires
// `progress` to increase with every notification).

import type { MediaProgressListener } from '../tools/media.js';

/** One progress update, in the shape of the protocol notification's params. */
export interface ProgressUpdate {
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

/** Where one bound call's updates go (the adapter's `notifications/progress` sender). */
export type ProgressSink = (update: ProgressUpdate) => void;

export interface ProgressBridge {
  /** Bind a `tools/call` signal to its sink for the call's lifetime; returns the unbind. */
  bind(signal: AbortSignal, sink: ProgressSink): () => void;
  /** Report progress for the call that owns `signal`. No-op when nothing is bound. */
  report(signal: AbortSignal | undefined, update: ProgressUpdate): void;
}

interface Binding {
  readonly sink: ProgressSink;
  last: number;
}

export function createProgressBridge(): ProgressBridge {
  const bindings = new WeakMap<AbortSignal, Binding>();
  return {
    bind(signal, sink) {
      const binding: Binding = { sink, last: Number.NEGATIVE_INFINITY };
      bindings.set(signal, binding);
      return () => {
        // Only drop OUR binding — never one a later bind for the same signal installed.
        if (bindings.get(signal) === binding) bindings.delete(signal);
      };
    },
    report(signal, update) {
      if (signal === undefined) return;
      const binding = bindings.get(signal);
      if (binding === undefined || !(update.progress > binding.last)) return;
      binding.last = update.progress;
      try {
        binding.sink(update);
      } catch {
        // Progress is advisory; swallow.
      }
    },
  };
}

/**
 * The media package's `onProgress` sink, routed through the bridge: progress counts bytes
 * (strictly increasing per accepted APPEND), `total` is the file size, and the message
 * names the segment so a client can show it verbatim.
 */
export function mediaProgressListener(bridge: ProgressBridge): MediaProgressListener {
  return (event) => {
    bridge.report(event.signal, {
      progress: event.bytesUploaded,
      total: event.totalBytes,
      message:
        `Uploaded segment ${String(event.segmentIndex + 1)} of ${String(event.segments)} ` +
        `to media ${event.mediaId}.`,
    });
  };
}
