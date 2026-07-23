// Auth/session tools (T-120): `x_auth_status` and `x_rate_limit_status`.
//
// These are COMPOSITION-ROOT tools (INT-6): they report on process/session state that is
// NOT reachable through the frozen `ToolContext`. `ToolContext = { ports, http, signal? }`
// and `Ports` carry no config, policy matrix, granted scopes, auth mode, or rate-limit
// table — so these tools cannot be plain `defineTool` constants. Instead a FACTORY closes
// over injected dependencies that the composition root (T-130) supplies:
// `createAuthTools(deps)` returns the two built tools with their handlers bound to `deps`.
// The `AuthToolDeps` interface below is the INT-6 seam the integrator wires.
//
// `x_auth_status` degrades under app-only auth (AUTH-15): no `me`, scopes may be empty, and
// a `note` explains that user-context tools are unavailable — a defined shape, never a 403.
// `x_rate_limit_status` is pure-local: it dumps the in-process rate-limit table, no API call.

import { z } from 'zod';
import { defineTool } from '../core/tooldef.js';
import type { AnyToolDef, ToolContext, ToolOutput } from '../core/tooldef.js';
import type { RateLimitStatus, RateLimitTracker } from '../api/ratelimit.js';
import { getMe } from '../api/endpoints/auth.js';

// --- INT-6 dependency seam (wired by the composition root, T-130) ----------------------

/**
 * A read-only snapshot of the process's auth/session state, assembled by the composition
 * root from config, the resolved policy matrix, the active token/auth mode, and the detected
 * availability set. `x_auth_status` renders it; it never mutates it.
 */
export interface AuthSessionInfo {
  /** `user` when a user-context token is active; `app-only` for a bearer-only process. */
  readonly authMode: 'app-only' | 'user';
  /** The authenticated user — present ONLY in user mode (AUTH-15: absent under app-only). */
  readonly me?: { readonly id: string; readonly handle?: string };
  /** Granted OAuth scopes; may be empty or unknown under app-only auth. */
  readonly scopes: readonly string[];
  /** Availability classes currently enabled (per X_MCP_AVAILABILITY + account detection). */
  readonly availability: readonly string[];
  /** The resolved policy matrix: the active preset name and each policy cell's allow bit. */
  readonly policy: {
    readonly preset: string;
    readonly cells: Readonly<Record<string, boolean>>;
  };
}

/** Supplies the current {@link AuthSessionInfo}. The composition root (T-130) implements it. */
export interface AuthSessionProvider {
  snapshot(): AuthSessionInfo;
}

/**
 * Everything the auth tools need beyond the frozen `ToolContext`. The composition root
 * (T-130) builds this once and passes it to {@link createAuthTools}. Only the read side of
 * the rate-limit tracker is needed (`status()`), so a `Pick` keeps the seam minimal — the
 * tools never mutate rate-limit state.
 */
export interface AuthToolDeps {
  readonly session: AuthSessionProvider;
  readonly rateLimit: Pick<RateLimitTracker, 'status'>;
}

// --- Handler report shape --------------------------------------------------------------

// Mutable builder for the agent-facing report: optional fields (`me`, `note`) are assigned
// only when present, so the emitted object satisfies exactOptionalPropertyTypes.
interface AuthStatusReport {
  auth_mode: AuthSessionInfo['authMode'];
  scopes: string[];
  availability: readonly string[];
  policy: AuthSessionInfo['policy'];
  me?: { id: string; handle?: string };
  note?: string;
}

const APP_ONLY_NOTE =
  'Running under app-only authentication: there is no authenticated user, so user-context ' +
  'tools (posting, DMs, home timeline, and private reads such as bookmarks/blocks/mutes) are ' +
  'unavailable. Granted scopes reflect the app context and may be empty.';

// Both tools take no input; a single strict empty schema is shared.
const EMPTY_INPUT = z.object({}).strict();

// --- Factory ---------------------------------------------------------------------------

/**
 * Build the two auth/session tools, binding each handler to `deps`. Returns
 * `[x_auth_status, x_rate_limit_status]` for the registry to collect (T-115).
 */
export function createAuthTools(deps: AuthToolDeps): AnyToolDef[] {
  const xAuthStatus = defineTool({
    name: 'x_auth_status',
    title: 'Auth status',
    description:
      'X (Twitter): report the active auth mode, the authenticated user (in user mode), ' +
      'granted OAuth scopes, detected availability, and the resolved policy matrix. Degrades ' +
      'to a defined shape under app-only auth (no user; a note explains the limitation).',
    policy: 'read:account',
    availability: 'app+user',
    scopes: ['users.read'],
    cost: 'owned',
    annotations: { title: 'Auth status', readOnlyHint: true, openWorldHint: false },
    input: EMPTY_INPUT,
    phase: 1,
    handler: async (_input, ctx): Promise<ToolOutput> => {
      const snap = deps.session.snapshot();
      const report: AuthStatusReport = {
        auth_mode: snap.authMode,
        scopes: [...snap.scopes].sort(),
        availability: snap.availability,
        policy: snap.policy,
      };
      if (snap.authMode === 'user') {
        // User mode without a `me` snapshot is a degenerate composition-root state; we simply
        // omit `me` rather than invent one.
        if (snap.me !== undefined) report.me = await resolveMe(snap.me, ctx);
      } else {
        report.note = APP_ONLY_NOTE; // AUTH-15 degraded shape.
      }
      return { data: report, summary: `auth: ${snap.authMode}` };
    },
  });

  const xRateLimitStatus = defineTool({
    name: 'x_rate_limit_status',
    title: 'Rate-limit status',
    description:
      'X (Twitter): dump the in-process rate-limit table — per bucket (endpoint-class × ' +
      "auth-context), each tracked window's limit, remaining, reset time, and whether it is " +
      'currently exhausted. Reads local state only; makes no API call.',
    policy: 'read:account',
    availability: 'app+user',
    scopes: [],
    cost: 'local',
    annotations: { title: 'Rate-limit status', readOnlyHint: true, openWorldHint: false },
    input: EMPTY_INPUT,
    phase: 1,
    handler: (): Promise<ToolOutput> => {
      const status: RateLimitStatus = deps.rateLimit.status();
      return Promise.resolve({
        data: status,
        summary: `rate-limit: ${status.buckets.length} bucket(s) tracked`,
      });
    },
  });

  return [xAuthStatus, xRateLimitStatus];
}

/**
 * Resolve the `me` block for user mode. When the snapshot already carries the handle it is
 * used verbatim; otherwise `getMe` enriches it best-effort — an `x_auth_status` read must
 * never hard-fail because the secondary `/2/users/me` call did, so a failure leaves `handle`
 * absent rather than propagating.
 */
async function resolveMe(
  me: NonNullable<AuthSessionInfo['me']>,
  ctx: ToolContext,
): Promise<{ id: string; handle?: string }> {
  if (me.handle !== undefined) return { id: me.id, handle: me.handle };
  try {
    const res = await getMe(ctx.http);
    const username = res.data?.username;
    if (username !== undefined && username !== '') return { id: me.id, handle: username };
  } catch {
    // Best-effort enrichment: a failed /2/users/me leaves the handle absent (AUTH-15-safe).
  }
  return { id: me.id };
}
