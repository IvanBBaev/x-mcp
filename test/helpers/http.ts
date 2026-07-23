// undici MockAgent helper — the T-103 network stub. api/http (T-114) sends via Node's
// global `fetch` with an injected dispatcher; in tests we inject a MockAgent so no real
// HTTP happens. The MockAgent IS an undici Dispatcher, so it drops straight into
// `Ports.dispatcher`.

import { MockAgent } from 'undici';
import type { Dispatcher } from '../../src/core/ports.js';

/** The X API v2 origin all endpoint wrappers target. */
export const X_API_ORIGIN = 'https://api.x.com';

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
    dispatcher: agent as unknown as Dispatcher,
    pool,
    assertDone: () => agent.assertNoPendingInterceptors(),
    close: () => agent.close(),
  };
}
