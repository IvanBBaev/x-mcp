// Composition wiring for the serve path (T-130; docs/02 §5). Everything the frozen `core`
// must not touch is built here from a validated Config: real ports, the rate-limit tracker
// and its per-bucket recording http clients (INT-3), the session budget behind the atomic
// budget gate (INT-2), the config-derived auth session (INT-6), the resolver seam, the
// registered tools, the registry, and the protocol adapter. `src/index.ts` stays a thin
// entrypoint: parse env → compose → connect stdio.

import { randomBytes, randomUUID } from 'node:crypto';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { mapHttpError } from '../api/errors.js';
import { createHttpClient } from '../api/http.js';
import type { AuthorizationProvider, ErrorMapper } from '../api/http.js';
import { createConfiguredTokenStore } from '../api/oauth2/store.js';
import { createFetchRefreshHttp, createOAuth2Auth } from '../api/oauth2/index.js';
import type { OAuth2Auth } from '../api/oauth2/index.js';
import { createRateLimitTracker, rateLimitKey } from '../api/ratelimit.js';
import type { RateLimitTracker } from '../api/ratelimit.js';
import { createHandleLookup } from '../api/endpoints/users.js';
import { createSessionBudget } from '../core/budget.js';
import type { SessionBudget } from '../core/budget.js';
import type { Config } from '../core/config.js';
import { resolvePolicy } from '../core/policy.js';
import type { Clock, Dispatcher, Ports, Random, Sleep, TokenStore } from '../core/ports.js';
import { createRegistry } from '../core/registry.js';
import type { Registry } from '../core/registry.js';
import { createResolveCache } from '../core/resolve.js';
import type { HandleLookup, ResolveCache } from '../core/resolve.js';
import type { EndpointInvoker } from '../core/tooldef.js';
import { archiveTools } from '../tools/archive.js';
import { createAuthTools } from '../tools/auth.js';
import { gateByAvailability } from '../tools/availability.js';
import { dmTools } from '../tools/dm.js';
import { engagementTools } from '../tools/engagement.js';
import { graphTools } from '../tools/graph.js';
import { listsTools } from '../tools/lists.js';
import { createMediaTools } from '../tools/media.js';
import { postsTools } from '../tools/posts.js';
import { searchTools } from '../tools/search.js';
import { timelinesTools } from '../tools/timelines.js';
import { createUsageTools } from '../tools/usage.js';
import { usersTools } from '../tools/users.js';
import { createBudgetGate, createPolicyGate, createRateLimitGate } from './gates.js';
import { buildMcpServer } from './server.js';
import { createSessionProvider } from './session.js';
import { assertOutputSchemaCoverage } from './structured.js';

/**
 * Tool → endpoint-class bucket (INT-3). The bucket names the X API rate-limit family the
 * tool's endpoint(s) belong to; combined with the auth context it forms the tracker key
 * (`rateLimitKey`). `null` marks a local-only tool: no network, nothing to track. Every
 * registered tool MUST appear here — `composeServer` enforces it at startup, the same
 * fail-structurally stance as the registry's own construction guards (POL-1).
 */
const TOOL_BUCKETS: Readonly<Record<string, string | null>> = {
  x_auth_status: 'users', // its only call is GET /2/users/me
  x_rate_limit_status: null,
  x_post_get: 'tweets',
  x_user_get: 'users',
  x_search_recent: 'search',
  x_post_counts_recent: 'counts',
  // Phase-2 writes: POST and DELETE /2/tweets are limited as separate families on X,
  // so create/delete get distinct buckets rather than sharing a coarse 'tweets-write'.
  x_post_create: 'tweets-create',
  x_post_delete: 'tweets-delete',
  x_like_set: 'likes',
  x_repost_set: 'retweets',
  x_bookmark_set: 'bookmarks',
  // Phase-2 timelines: each endpoint carries its own X rate-limit family. The inline
  // GET /2/users/me some handlers issue trains the tool's own bucket, not 'users' —
  // an accepted INT-3 approximation (one client per tool).
  x_timeline_home: 'timeline-home',
  x_timeline_mentions: 'timeline-mentions',
  x_timeline_user: 'timeline-user',
  // Phase-3 social graph: POST/DELETE following, muting and blocking are separate X
  // rate-limit families, as are the two list-reads; user search is its own family too.
  x_follow_set: 'following-write',
  x_mute_set: 'muting',
  x_block_set: 'blocking',
  x_followers_list: 'followers',
  x_following_list: 'following',
  x_user_search: 'users-search',
  // Phase-3 lists: create/update/delete share the list-management family; each read
  // endpoint and each engagement toggle (follow/pin) is its own family.
  x_list_create: 'lists-manage',
  x_list_update: 'lists-manage',
  x_list_delete: 'lists-manage',
  x_list_get: 'lists-lookup',
  x_lists_owned: 'lists-owned',
  x_list_member_set: 'lists-members',
  x_list_members: 'lists-members',
  x_list_timeline: 'lists-timeline',
  x_list_follow_set: 'lists-follow',
  x_list_pin_set: 'lists-pin',
  // Phase-3 media: the chunked upload conversation (INIT/APPEND/FINALIZE) and the STATUS
  // poll are tracked as distinct families.
  x_media_upload: 'media-upload',
  x_media_status: 'media-status',
  // Phase-3 DMs: each lookup route carries its own family; sends are limited separately.
  x_dm_events_list: 'dm-events',
  x_dm_conversation_events_list: 'dm-events-conversation',
  x_dm_participant_events_list: 'dm-events-participant',
  x_dm_send: 'dm-send',
  // Phase-3 archive: full-archive search and counts are distinct families from the
  // recent-search buckets above.
  x_search_archive: 'search-archive',
  x_post_counts_archive: 'counts-archive',
  // Phase-3 usage: GET /2/usage/tweets is its own family, unrelated to any read endpoint.
  x_usage_get: 'usage',
  // Phase-3 completions (decisions/0002): reading bookmarks is a different X family from
  // writing them, and reply moderation is its own family separate from post delete.
  x_bookmarks_list: 'bookmarks-list',
  x_post_hide_reply: 'tweets-hidden',
};

/** Test seams: override any port; production passes nothing and gets the real adapters. */
export interface ComposeOverrides {
  readonly clock?: Clock;
  readonly sleep?: Sleep;
  readonly random?: Random;
  readonly tokens?: TokenStore;
  readonly dispatcher?: Dispatcher;
}

/** Everything the entrypoint (and the integrator) needs a handle on. */
export interface Composition {
  readonly server: Server;
  readonly registry: Registry;
  readonly tracker: RateLimitTracker;
  readonly budget: SessionBudget;
  /**
   * The session-scoped user resolver seam (core/resolve): the memo cache plus the
   * `@handle` → id lookup over the users-bucket client. No Phase-1 read tool consumes it
   * (they resolve inline); the Phase-2 write tools take it via `resolveUserId`.
   */
  readonly resolver: { readonly cache: ResolveCache; readonly lookup: HandleLookup };
}

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultRandom(): Random {
  return {
    float: () => Math.random(),
    uuid: () => randomUUID(),
    bytes: (n) => new Uint8Array(randomBytes(n)),
  };
}

/**
 * Stand-in store for modes with nothing to persist: app-only never touches
 * `ports.tokens`. Both oauth2 backends — file (T-202) and keychain (T-308) — wire a REAL
 * store below. `withLock` still honours the single-flight contract shape.
 */
function stubTokenStore(): TokenStore {
  return {
    load: () => Promise.resolve(null),
    persist: () => Promise.resolve(),
    withLock: (fn) => fn(),
  };
}

/**
 * The host-scoped credential provider (AUTH-14). App-only mode signs with the operator's
 * bearer verbatim; oauth2 mode is handled by the machine-backed provider from
 * `createOAuth2Auth` (composed in `composeServer`); a user-context mode that resolves no
 * token store at all returns no provider — those requests then go out unauthenticated and
 * map to clean `auth` errors rather than crashing.
 */
function createAuthorizationProvider(config: Config): AuthorizationProvider | undefined {
  if (config.authMode === 'app-only' && config.bearerToken !== undefined) {
    const header = `Bearer ${config.bearerToken}`;
    return () => Promise.resolve(header);
  }
  return undefined;
}

/**
 * Wire the OAuth2 user-context auth surface (T-201/T-202/T-203) when the config resolves
 * a token store: the T-202 file backend or the T-308 keychain backend, chosen by
 * `createConfiguredTokenStore`. The store honours the test seam (`overrides.tokens`),
 * which is consulted FIRST so a test never has to own a real backend. Returns `undefined`
 * for every other mode — their behavior is unchanged.
 */
function composeOAuth2(
  config: Config,
  overrides: ComposeOverrides,
  clock: Clock,
  sleep: Sleep,
  dispatcher: Dispatcher | undefined,
): OAuth2Auth | undefined {
  const store = overrides.tokens ?? createConfiguredTokenStore(config, clock, sleep);
  if (store === undefined || config.authMode !== 'oauth2') return undefined;
  return createOAuth2Auth({
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
  });
}

/** Build the whole serve-path object graph from a validated Config. Pure wiring, no I/O. */
export function composeServer(config: Config, overrides: ComposeOverrides = {}): Composition {
  const clock = overrides.clock ?? { now: () => Date.now() };
  const sleep = overrides.sleep ?? defaultSleep;
  const random = overrides.random ?? defaultRandom();
  const dispatcher = overrides.dispatcher; // production: undefined → default dispatcher (CFG-7)
  const oauth2 = composeOAuth2(config, overrides, clock, sleep, dispatcher);
  // The oauth2 facade and `ports.tokens` must share ONE store instance (single-flight
  // locking, AUTH-2); other modes keep the inert stub unless a test injected its own.
  const tokens = oauth2?.store ?? overrides.tokens ?? stubTokenStore();

  const ports: Ports = {
    clock,
    sleep,
    random,
    tokens,
    ...(dispatcher !== undefined ? { dispatcher } : {}),
  };

  const tracker = createRateLimitTracker(clock);
  const authContext: 'app' | 'user' = config.authMode === 'app-only' ? 'app' : 'user';
  const authorization = oauth2?.authorization ?? createAuthorizationProvider(config);

  // Each bucket's client signs via the provider; in oauth2 mode it is additionally
  // wrapped with the 401 → refresh → retry-once orchestration (§4A step 6, AUTH-8).
  function clientFor(mapError: ErrorMapper): EndpointInvoker {
    const client = createHttpClient({
      sleep,
      random,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      mapError,
      ...(dispatcher !== undefined ? { dispatcher } : {}),
      ...(authorization !== undefined ? { authorization } : {}),
    });
    return oauth2 === undefined ? client : oauth2.withAuthRetry(client);
  }

  // One http client per endpoint-class bucket (INT-3): its error mapper first records the
  // response's rate-limit headers into the tracker under the bucket key, then delegates to
  // the rich mapper — so a 429 (or any limited error) trains the preflight table (RATE-1).
  // api/http exposes no success-path header hook, so only non-2xx responses feed the
  // table; see the integrator note in the T-130 report.
  const invokers = new Map<string, EndpointInvoker>();
  for (const bucket of new Set(Object.values(TOOL_BUCKETS))) {
    if (bucket === null) continue;
    const key = rateLimitKey(bucket, authContext);
    invokers.set(
      bucket,
      clientFor((status, headers, body) => {
        tracker.record(key, headers, status);
        return mapHttpError(status, headers, body, clock.now());
      }),
    );
  }
  // Local-only tools still receive a working (non-recording) invoker, defensively.
  const fallback = clientFor((status, headers, body) =>
    mapHttpError(status, headers, body, clock.now()),
  );
  const invokerFor = (toolName: string): EndpointInvoker => {
    const bucket = TOOL_BUCKETS[toolName];
    return (bucket != null ? invokers.get(bucket) : undefined) ?? fallback;
  };

  const policy = resolvePolicy({
    preset: config.policy.preset,
    allow: config.policy.allow,
    deny: config.policy.deny,
  });
  const budget = createSessionBudget({
    mode: config.budget.mode,
    ...(config.budget.creditUsd !== undefined ? { limit: config.budget.creditUsd } : {}),
  });

  const session = createSessionProvider(config, policy);
  const tools = [
    ...createAuthTools({ session, rateLimit: tracker }),
    ...postsTools,
    ...usersTools,
    ...searchTools,
    ...engagementTools,
    ...timelinesTools,
    ...graphTools,
    ...listsTools,
    // INT-6 factory, NOT the default-deny `mediaTools` export: `X_MCP_MEDIA_DIR` lives in
    // Config, and `ToolContext` deliberately carries no config, so the directory can only
    // reach x_media_upload by being closed over here. Registering the unbound instances
    // would make every upload refuse with "no media directory is configured" even when the
    // operator set one (MEDIA-5's fail-closed default, misapplied).
    ...createMediaTools(config.mediaDir !== undefined ? { mediaDir: config.mediaDir } : {}),
    ...dmTools,
    ...archiveTools,
    // INT-6, like createAuthTools: the report reads process state (the session credit
    // estimate) that the frozen ToolContext does not carry, so the budget is injected here.
    // Only the READ side of the budget is in the seam's type — the tool cannot charge.
    ...createUsageTools({ budget }),
  ];
  for (const tool of tools) {
    if (!(tool.name in TOOL_BUCKETS)) {
      // Same fail-at-construction stance as the registry's duplicate/unknown-cell guards.
      throw new Error(`no rate-limit bucket mapping for tool "${tool.name}" (INT-3)`);
    }
  }
  // REND-11: a tool that renders structured content without a published schema is a wiring
  // bug. Asserted over EVERY built tool, not just the registered ones, so a tool that is
  // merely gated out today cannot ship schema-less and surface later.
  assertOutputSchemaCoverage(tools.map((tool) => tool.name));

  // Availability class-gating (docs/01 §3.3, T-306): tools whose availability class is not
  // in the operator-resolved set are dropped BEFORE registration — never listed, never
  // callable (contrast POL-7, where denied tools stay listed + annotated). Every v1 tool
  // declares a base class (`app+user` / `user-only`), so `gate.excluded` is empty today;
  // the partition is wired now so future gated-class tools cannot bypass it.
  const gate = gateByAvailability(tools, config.availability);

  const registry = createRegistry(gate.registered, {
    policy: createPolicyGate(policy, config.policy.hideDenied),
    budget: createBudgetGate(budget),
    rateLimit: createRateLimitGate(tracker, (tool) => {
      const bucket = TOOL_BUCKETS[tool.name];
      return bucket == null ? null : rateLimitKey(bucket, authContext);
    }),
  });

  const server = buildMcpServer({ registry, ports, invokerFor });
  const resolver = {
    cache: createResolveCache(),
    lookup: createHandleLookup(invokerFor('x_user_get')),
  };

  return { server, registry, tracker, budget, resolver };
}
