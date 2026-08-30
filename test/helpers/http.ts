// undici MockAgent helper — the T-103 network stub. api/http (T-114) sends via Node's
// global `fetch` with an injected dispatcher; in tests we inject a MockAgent so no real
// HTTP happens. The MockAgent IS an undici Dispatcher, so it drops straight into
// `Ports.dispatcher` — modulo the protocol bridge below.
//
// undici 8 bridge: Node 22's global `fetch` is the runtime's BUNDLED undici (dispatch
// protocol v1 — it drives the dispatcher with onConnect/onHeaders/onData/onComplete/
// onError callbacks), while the npm `undici` MockAgent speaks protocol v2 (it fires
// onRequestStart/onResponseStart/onResponseData/onResponseEnd/onResponseError against a
// controller object). Handing the raw v8 agent to global fetch therefore hangs forever:
// the mock fires callbacks the bundled v1 handler never implemented, so the response
// promise never settles. undici 8 ships `Dispatcher1Wrapper` for exactly this bridge,
// but its dispatch() also forces `allowH2: false`, and the v8 Agent keys clients as
// `${origin}#http1-only` for such requests — missing the MockPool registered under the
// plain origin and escaping to the REAL network (nodejs/undici, as of 8.10.0). So
// `mockHttp` wraps the agent in a minimal dispatcher that adapts ONLY the handler
// protocol (v1 → v2) and leaves the dispatch options untouched.
//
// Request bodies get the same treatment: the bundled fetch dispatches a body as an async
// iterable stream, but undici 8's mock matcher compares `opts.body` as-is (string pins
// via `===`, matcher functions get the raw value) — only undici 8's OWN fetch hands it a
// comparable value. The bridge buffers a streamed body to its utf8 text before
// dispatching, so `body:` pins and matcher callbacks keep seeing the wire text exactly as
// they did under undici 6.

import { MockAgent } from 'undici';
import type { Dispatcher as V2Dispatcher } from 'undici';
import type { Dispatcher } from '../../src/core/ports.js';

/** The X API v2 origin all endpoint wrappers target. */
export const X_API_ORIGIN = 'https://api.x.com';

/**
 * The v1 dispatch handler shape Node's bundled fetch implements (undici 6 protocol).
 * `onHeaders`/`onData` return `false` to apply backpressure; `rawHeaders`/`rawTrailers`
 * are the flat `[name, value, ...]` Buffer pairs of the wire format.
 */
interface V1DispatchHandler {
  onConnect?(abort: (reason?: Error) => void, context?: unknown): void;
  onHeaders?(
    statusCode: number,
    rawHeaders: Array<Buffer | string>,
    resume: () => void,
    statusMessage?: string,
  ): boolean | void;
  onData?(chunk: Buffer): boolean | void;
  onComplete?(rawTrailers: Array<Buffer | string>): void;
  onError?(err: Error): void;
  onBodySent?(chunk: unknown): void;
  onRequestSent?(): void;
}

/** Flatten a parsed header object back into `[name, value, ...]` pairs (v1 raw shape). */
function toRawPairs(headers: unknown): string[] {
  if (typeof headers !== 'object' || headers === null) return [];
  const raw: string[] = [];
  for (const [name, value] of Object.entries(headers as Record<string, string | string[]>)) {
    for (const v of Array.isArray(value) ? value : [value]) raw.push(name, String(v));
  }
  return raw;
}

/**
 * Adapt a v1 handler (Node's bundled fetch) to the v2 callbacks the undici 8 MockAgent
 * fires. Mirrors undici 8's own `LegacyHandlerWrapper` semantics: controller-provided
 * raw pairs are preferred, backpressure maps `false` → `controller.pause()`, and the
 * mock's error path may pass a `null` controller.
 */
function adaptV1Handler(handler: V1DispatchHandler): V2Dispatcher.DispatchHandler {
  return {
    onRequestStart(controller, context) {
      handler.onConnect?.((reason) => controller.abort(reason as Error), context);
    },
    onResponseStart(controller, statusCode, headers, statusMessage) {
      const rawHeaders = (controller?.rawHeaders ?? toRawPairs(headers)) as Array<Buffer | string>;
      if (
        handler.onHeaders?.(statusCode, rawHeaders, () => controller.resume(), statusMessage) ===
        false
      ) {
        controller.pause();
      }
    },
    onResponseData(controller, chunk) {
      if (handler.onData?.(chunk) === false) controller.pause();
    },
    onResponseEnd(controller, trailers) {
      const rawTrailers = (controller?.rawTrailers ?? toRawPairs(trailers)) as Array<
        Buffer | string
      >;
      handler.onComplete?.(rawTrailers);
    },
    onResponseError(_controller, err) {
      if (!handler.onError) throw err;
      handler.onError(err);
    },
    onBodySent(chunk) {
      handler.onBodySent?.(chunk);
    },
    onRequestSent() {
      handler.onRequestSent?.();
    },
  };
}

/** Buffer an async-iterable request body (the bundled fetch's shape) to its utf8 text. */
async function bufferBody(body: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Wrap the v8 MockAgent so global fetch (a v1 consumer) can drive it. */
function bridgeToV1(agent: MockAgent): Dispatcher {
  const bridge = {
    dispatch(opts: V2Dispatcher.DispatchOptions, handler: V1DispatchHandler): boolean {
      // A handler that already speaks v2 passes through untouched (upstream behavior).
      const v2 =
        'onRequestStart' in handler
          ? (handler as V2Dispatcher.DispatchHandler)
          : adaptV1Handler(handler);
      const body: unknown = opts.body;
      // Strings, byte views, and empty bodies already compare cleanly — dispatch as-is.
      // Only a streamed body needs buffering, and that read is async, so the dispatch is
      // re-issued once the wire text is in hand (the mock replies asynchronously anyway).
      if (
        body != null &&
        typeof body !== 'string' &&
        !ArrayBuffer.isView(body) &&
        typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function'
      ) {
        bufferBody(body as AsyncIterable<Uint8Array>).then(
          (text) => agent.dispatch({ ...opts, body: text }, v2),
          (err: Error) => v2.onResponseError?.(null as never, err),
        );
        return true;
      }
      return agent.dispatch(opts, v2);
    },
    close: () => agent.close(),
    destroy: () => agent.destroy(),
  };
  return bridge as unknown as Dispatcher;
}

export interface MockHttp {
  /** Pass as `Ports.dispatcher`. */
  readonly dispatcher: Dispatcher;
  /** The mock interceptor pool for the X API origin — add `.intercept(...)` replies on it. */
  readonly pool: ReturnType<MockAgent['get']>;
  /** Assert every queued interceptor was consumed; call in test teardown. */
  assertDone(): void;
  close(): Promise<void>;
}

/**
 * Build an offline MockAgent scoped to the X API origin. Net connect is disabled, so an
 * unmocked request throws loudly instead of hitting the real API.
 */
export function mockHttp(origin: string = X_API_ORIGIN): MockHttp {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const pool = agent.get(origin);
  return {
    dispatcher: bridgeToV1(agent),
    pool,
    assertDone: () => agent.assertNoPendingInterceptors(),
    close: () => agent.close(),
  };
}
