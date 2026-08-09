// The live session — the ONE seam every live API call goes through. Owned by the live-test
// slice.
//
// A live test never touches an MCP `Client` or an `EndpointInvoker` directly. It gets a
// `LiveSession`, whose only way out to the network is `call()`, and `call()` asks the spend
// guard for permission FIRST (harness/spend.ts). That is what makes docs/05 §6's "the suite
// stops before the cap" true rather than aspirational: a refused authorization throws
// before `callTool` is invoked, so a refusal costs nothing.
//
// Three things are forced on every live run, regardless of what the operator's environment
// says:
//
//   1. `X_MCP_BUDGET_MODE=hard` and `X_MCP_CREDIT_BUDGET=<LIVE_USD_CAP>`. The composed
//      SERVER then carries its own hard cap, independent of the harness guard — two
//      independent rails have to agree before a request leaves the process. An operator who
//      exports a generous `X_MCP_CREDIT_BUDGET` for normal use does not thereby raise the
//      live-suite ceiling.
//   2. The archive deny list is checked STRUCTURALLY against the composed registry at open
//      time (`assertDenyListIntact`), so renaming a tool cannot silently un-ban it.
//   3. The `X_MCP_LIVE_*` variables are stripped before `parseConfig` sees them, so the
//      harness's own switches never show up as "unknown environment variable" warnings.
//
// The composition itself is the real production one (`mcp/compose`), reached through the
// real MCP transport (`InMemoryTransport`) — the live suite exercises the shipped pipeline,
// not a test double of it. The only injected seam is `dispatcher`, which is left UNDEFINED
// on a real live run (production default dispatcher, CFG-7) and set to a `MockAgent` by the
// ungated harness tests that prove all of the above offline.

import { randomBytes, randomUUID } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { createHttpClient } from '../../../src/api/http.js';
import type { AuthorizationProvider, ErrorMapper } from '../../../src/api/http.js';
import { createFetchRefreshHttp, createOAuth2Auth } from '../../../src/api/oauth2/index.js';
import { createConfiguredTokenStore } from '../../../src/api/oauth2/store.js';
import { parseConfig } from '../../../src/core/config.js';
import type { Config } from '../../../src/core/config.js';
import type { ResolvedCost } from '../../../src/core/budget.js';
import type { Clock, Dispatcher, Random, Sleep } from '../../../src/core/ports.js';
import type { EndpointInvoker } from '../../../src/core/tooldef.js';
import { composeServer } from '../../../src/mcp/compose.js';
import type { Composition } from '../../../src/mcp/compose.js';

import { stripLiveVars } from './gate.js';
import type { EnvSnapshot } from './gate.js';
import { LIVE_USD_CAP, assertDenyListIntact, createLiveSpendGuard } from './spend.js';
import type { LiveSpendGuard } from './spend.js';

/** The rendered success envelope every tool returns (docs/02 §5). */
export interface Rendered<T> {
  readonly data: T;
  readonly summary?: string;
  readonly meta: {
    readonly cost_usd: number;
    readonly session_total_usd: number;
    readonly budget_warning?: string;
  };
}

/** The rendered error envelope (docs/04 §3). */
export interface RenderedError {
  readonly error: {
    readonly kind: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly fix?: string;
  };
}

/** What a live test declares about a call before it is allowed to make it. */
export interface LiveSpend {
  /** API requests this call issues. Defaults to 1. */
  readonly units?: number;
  /** The cost class the production catalog declares for the tool. */
  readonly cost: ResolvedCost;
}

export interface LiveSessionOptions {
  /** Env snapshot. Defaults to `process.env`. */
  readonly env?: EnvSnapshot;
  /** Test-only: an undici `MockAgent`. Left undefined on a real live run (CFG-7). */
  readonly dispatcher?: Dispatcher;
  /** Test-only: a pre-seeded guard. Defaults to the production 20-unit / $0.20 guard. */
  readonly guard?: LiveSpendGuard;
  /** Where the end-of-run report goes. Defaults to `console.log`. */
  readonly log?: (line: string) => void;
}

export interface LiveSession {
  readonly composition: Composition;
  readonly guard: LiveSpendGuard;
  readonly config: Config;
  /** Call a tool through the full pipeline. Throws on a rendered error. */
  call<T>(tool: string, args: object, spend: LiveSpend): Promise<Rendered<T>>;
  /** Call a tool and return the raw MCP result, errors included. */
  raw(tool: string, args: object, spend: LiveSpend): Promise<CallToolResult>;
  /** The `@handle` the X API reports for the stored credentials (`x_user_get {users:['me']}`). */
  reportedHandle(): Promise<string | undefined>;
  /** docs/05 §6: every run ends by printing the budget summary plus `x_usage_get`. */
  printSummary(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The env a live run hands `parseConfig`: the operator's, minus the harness switches, plus
 * the two budget variables the live suite is not willing to leave to chance.
 */
export function liveConfigEnv(env: EnvSnapshot): Record<string, string | undefined> {
  return {
    ...stripLiveVars(env),
    X_MCP_BUDGET_MODE: 'hard',
    X_MCP_CREDIT_BUDGET: String(LIVE_USD_CAP),
  };
}

function realClock(): Clock {
  return { now: () => Date.now() };
}

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function realRandom(): Random {
  return {
    float: () => Math.random(),
    uuid: () => randomUUID(),
    bytes: (n) => new Uint8Array(randomBytes(n)),
  };
}

/**
 * A stand-alone production HTTP client for the paths that cannot go through the composed
 * server — today only the COST-6 capture, which needs its own `ErrorMapper` and
 * `mcp/compose` exposes no `mapError` seam in `ComposeOverrides`.
 *
 * Mirrors `mcp/compose`'s `clientFor` exactly: the same `createHttpClient`, the same
 * host-scoped authorization provider, and in oauth2 mode the same 401 → refresh → retry
 * wrapper. It is a deliberate, narrow duplication — if compose ever grows a `mapError`
 * override, delete this and use it.
 */
export function createLiveInvoker(options: {
  readonly config: Config;
  readonly mapError: ErrorMapper;
  readonly dispatcher?: Dispatcher;
}): EndpointInvoker {
  const { config, mapError, dispatcher } = options;
  const clock = realClock();
  const store = createConfiguredTokenStore(config, clock, realSleep);
  const oauth2 =
    store !== undefined && config.authMode === 'oauth2'
      ? createOAuth2Auth({
          clock,
          store,
          refreshHttp: createFetchRefreshHttp({
            baseUrl: config.baseUrl,
            ...(config.oauth2.clientId !== undefined ? { clientId: config.oauth2.clientId } : {}),
            ...(config.oauth2.clientSecret !== undefined
              ? { clientSecret: config.oauth2.clientSecret }
              : {}),
            ...(dispatcher !== undefined ? { dispatcher } : {}),
          }),
        })
      : undefined;

  const bearer = config.bearerToken;
  const appOnlyAuth: AuthorizationProvider | undefined =
    config.authMode === 'app-only' && bearer !== undefined
      ? () => Promise.resolve(`Bearer ${bearer}`)
      : undefined;
  const authorization = oauth2?.authorization ?? appOnlyAuth;

  const client = createHttpClient({
    sleep: realSleep,
    random: realRandom(),
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    mapError,
    ...(dispatcher !== undefined ? { dispatcher } : {}),
    ...(authorization !== undefined ? { authorization } : {}),
  });
  return oauth2 === undefined ? client : oauth2.withAuthRetry(client);
}

function textPayload<T>(result: CallToolResult): T {
  const block = result.content[0];
  if (block === undefined || block.type !== 'text') {
    throw new Error(`tool result carried no text content block (got ${JSON.stringify(result)})`);
  }
  return JSON.parse(block.text) as T;
}

/** Open a live session against the real composition. Performs no network I/O by itself. */
export async function openLiveSession(options: LiveSessionOptions = {}): Promise<LiveSession> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const guard = options.guard ?? createLiveSpendGuard();
  const config = parseConfig(liveConfigEnv(env));

  const composition = composeServer(config, {
    ...(options.dispatcher !== undefined ? { dispatcher: options.dispatcher } : {}),
  });

  // Guardrail 2: the deny list must still name real tools (see harness/spend.ts).
  assertDenyListIntact(composition.registry.all().map((tool) => tool.name));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'x-mcp-live', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), composition.server.connect(serverTransport)]);

  async function raw(tool: string, args: object, spend: LiveSpend): Promise<CallToolResult> {
    // Authorization happens BEFORE the call, and throws — nothing is sent when it refuses.
    guard.authorize({ tool, units: spend.units ?? 1, cost: spend.cost });
    return (await client.callTool({
      name: tool,
      arguments: args as Record<string, unknown>,
    })) as CallToolResult;
  }

  async function call<T>(tool: string, args: object, spend: LiveSpend): Promise<Rendered<T>> {
    const result = await raw(tool, args, spend);
    if (result.isError === true) {
      const payload = textPayload<RenderedError>(result);
      throw new Error(`${tool} failed [${payload.error.kind}]: ${payload.error.message}`);
    }
    return textPayload<Rendered<T>>(result);
  }

  return {
    composition,
    guard,
    config,
    call,
    raw,
    async reportedHandle(): Promise<string | undefined> {
      // Through the production pipeline, not a raw endpoint call: `x_user_get` with the
      // `me` sentinel is the shipped way to ask "who am I?". (`x_auth_status` cannot answer
      // it — mcp/session omits `me` from the snapshot and the tool only enriches an
      // existing one, so its `me` block is never present.)
      const res = await call<{ items?: { handle?: string }[] }>(
        'x_user_get',
        { users: ['me'] },
        { cost: 'r:user' },
      );
      return res.data.items?.[0]?.handle;
    },
    async printSummary(): Promise<void> {
      // docs/05 §6: every run ends with the session budget summary AND `x_usage_get`.
      log('');
      log(guard.summary());
      log(
        `  server budget: ${composition.budget.mode} mode, cap ${String(LIVE_USD_CAP)} USD, spent ${String(composition.budget.total())} USD`,
      );
      try {
        const usage = await call<unknown>('x_usage_get', {}, { cost: 'owned' });
        log(`  x_usage_get: ${JSON.stringify(usage.data)}`);
      } catch (err) {
        // Never swallow it, never fail the run on it — the summary is reporting, not a test.
        log(`  x_usage_get FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
      log('');
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}
