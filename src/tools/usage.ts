// Platform usage + session-spend tool (docs/03 `x_usage_get`). Owned by the T-317 usage slice
// (WP-3.11), whose go/no-go the T-010 fact-check resolved GO-scoped: docs/01 §3.5 verified
// (2026-07-22) that `GET /2/usage/tweets` still exists under pay-per-use, is gated only on an
// approved developer account (no tier), and reports POST-READ COUNTS against the 2 M/month
// project cap — never dollar or credit spend. So this tool ships as a read-cap reporter, not
// as a credit-spend mirror.
//
// This is a COMPOSITION-ROOT tool (INT-6), like tools/auth: half of what docs/03 promises —
// "local session-spend budget state" — is process state that the frozen `ToolContext`
// (`{ ports, http, signal? }`) does not carry. A factory closes over the injected budget:
// `createUsageTools({ budget })`, wired by the composition root (T-130).
//
// The corner cases this tool exists to keep honest:
//  - COST-1: the credit budget is operator-set and model-immutable. The input schema is
//    `.strict()` and carries NO limit/mode/reset key, so an agent cannot raise or clear the
//    cap by "reporting" on it; the tool only reads.
//  - COST-2: the local session estimate is never seeded from a usage API. These platform
//    counts are rendered ALONGSIDE the estimate, never folded into it — the handler calls
//    `budget.total()` and nothing else; there is no write path from the response to the counter.
//  - COST-7: the 2 M posts/month cap is surfaced as the platform states it (and verbatim as a
//    `billing` error when actually hit). The server does not pre-track it between sessions,
//    which is exactly why an on-demand read of the platform's own number is useful.
//  - DRIFT-1: every response field is optional and the counters come back as JSON strings on
//    this endpoint, so the response is read defensively and a missing block degrades to a
//    stated "unknown", never to a silent zero.

import { z } from 'zod';

import { defineTool } from '../core/tooldef.js';
import type { AnyToolDef, ToolOutput } from '../core/tooldef.js';
import type { BudgetMode, SessionBudget } from '../core/budget.js';
import { validationError } from '../core/errors.js';
import { toIso } from '../core/render.js';
import { sanitizePlatformText } from '../core/sanitize.js';
import { getUsage } from '../api/endpoints/usage.js';
import type { RawUsageResponse } from '../api/endpoints/usage.js';

// --- INT-6 dependency seam (wired by the composition root, T-130) ----------------------

/**
 * Everything this tool needs beyond the frozen `ToolContext`. Only the READ side of the
 * session budget is taken (`limit`, `mode`, `total`) — deliberately not `reserve`, so the
 * seam itself makes it impossible for this tool to mutate the counter (COST-1/COST-2).
 */
export interface UsageToolDeps {
  readonly budget: Pick<SessionBudget, 'limit' | 'mode' | 'total'>;
}

// --- Rendered report shape ------------------------------------------------------------

/** One day of the project-wide read series. */
export interface UsageDaily {
  readonly date: string;
  readonly posts_read: number;
}

/** One client app's share of the reads in the requested window. */
export interface UsageByApp {
  readonly client_app_id: string;
  readonly posts_read: number;
}

/** The platform's own accounting: counts against the monthly project cap, never dollars. */
export interface PlatformUsage {
  readonly project_id?: string;
  readonly posts_read: number;
  readonly cap?: number;
  /** `posts_read` as a percentage of `cap`, 1 dp. Absent when the cap is unknown or zero. */
  readonly percent_used?: number;
  readonly cap_reset_day?: number;
  readonly daily?: readonly UsageDaily[];
  readonly by_app?: readonly UsageByApp[];
}

/** The local, in-process credit estimate (COST-2/COST-3) — advisory, not a platform ledger. */
export interface SessionBudgetReport {
  readonly spent_usd: number;
  readonly mode: BudgetMode;
  readonly limit_usd?: number;
  readonly remaining_usd?: number;
  /** `spent_usd` as a percentage of `limit_usd`, 1 dp. Absent when uncapped (COST-1). */
  readonly percent_used?: number;
}

/** The compact `x_usage_get` payload. */
export interface UsageReport {
  readonly platform: PlatformUsage;
  readonly session_budget: SessionBudgetReport;
  readonly note: string;
}

// --- Notes ----------------------------------------------------------------------------

/**
 * Stated on every compact result so the two halves are never conflated. Deliberately
 * self-contained (no doc paths): the agent reading it cannot open this repo's docs.
 */
const USAGE_NOTE =
  'Platform figures are post-READ COUNTS against the monthly project cap, not money: X ' +
  'exposes no credit- or dollar-spend API, so no tool here can report actual billed spend. ' +
  'session_budget is a local advisory estimate kept by this process — it starts at zero on every ' +
  'restart, is computed from a static per-endpoint price table, and is never seeded or ' +
  'corrected from these platform counts. Its limit is operator-set and cannot be changed from ' +
  'within this session. The monthly cap is reported exactly as the platform states it and is ' +
  'not tracked between sessions.';

/** DRIFT-1: a missing `data` block must not read as "nothing was consumed". */
const DEGRADED_NOTE =
  'The platform returned no usage block, so the platform figures are UNKNOWN, not zero — do ' +
  'not read the absence as "no posts read this cycle".';

/**
 * Quote the platform's own reason for an empty report (REND-2: a 200 body may carry
 * `errors[]` instead of `data`), so a degraded result says WHY rather than only that it is
 * degraded. One sentence, first error only.
 *
 * The text is X's, not a user's — but it is still THIRD-PARTY text on its way into the
 * model's context, so it goes through `sanitizePlatformText` (strip C0/C1, bidi and
 * invisible code points, cap at `FIELD_CAPS.errorText`) exactly like the error payload does
 * on the failure path (T-320 F3). "Trusted origin" is not a property of the bytes; assuming
 * it here is what left the error path unguarded in the first place.
 */
function platformReason(res: RawUsageResponse): string[] {
  const first = res.errors?.[0];
  if (first === undefined) return [];
  const reason = [sanitizePlatformText(first.title), sanitizePlatformText(first.detail)]
    .filter((s) => s !== undefined && s !== '')
    .join(': ');
  return reason === '' ? [] : [`Platform reason: ${reason}`];
}

// --- Defensive coercion (DRIFT-1) -----------------------------------------------------

/** Round to 1 dp for percentages. */
function pct(part: number, whole: number): number | undefined {
  if (!Number.isFinite(whole) || whole <= 0) return undefined;
  return Math.round((part / whole) * 1000) / 10;
}

/** Round money to 6 dp so binary-float tails never surface in the report. */
function usd(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Read a counter that the endpoint may return as a number, as a numeric string, or not at
 * all. Anything unparseable becomes `undefined` — never a fabricated 0.
 */
function toCount(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// --- days clamp -----------------------------------------------------------------------

const DAYS_MIN = 1;
const DAYS_MAX = 90;

/**
 * Clamp the daily-breakdown window into the documented 1-90 range. `days` is not a paging
 * `max_results`, so core/paginate's PAGE_BOUNDS does not model it; the clamp is local and
 * reports itself in the note rather than silently rewriting the caller's intent.
 */
function clampDays(requested: number): { value: number; note?: string } {
  if (!Number.isInteger(requested)) throw validationError('days must be a whole number.');
  if (requested < DAYS_MIN) {
    return { value: DAYS_MIN, note: `days ${requested} raised to the minimum of ${DAYS_MIN}.` };
  }
  if (requested > DAYS_MAX) {
    return { value: DAYS_MAX, note: `days ${requested} lowered to the maximum of ${DAYS_MAX}.` };
  }
  return { value: requested };
}

// --- Rendering ------------------------------------------------------------------------

function renderPlatform(res: RawUsageResponse): PlatformUsage {
  const data = res.data;
  const postsRead = toCount(data?.project_usage);
  const cap = toCount(data?.project_cap);
  const capResetDay = toCount(data?.cap_reset_day);

  const daily: UsageDaily[] = [];
  for (const day of data?.daily_project_usage ?? []) {
    const date = toIso(day.date); // REND-9: ISO-8601 UTC.
    if (date === undefined) continue;
    daily.push({ date, posts_read: toCount(day.usage) ?? 0 });
  }

  const byApp: UsageByApp[] = [];
  for (const app of data?.daily_client_app_usage ?? []) {
    if (app.client_app_id === undefined) continue;
    const total = (app.usage ?? []).reduce((sum, day) => sum + (toCount(day.usage) ?? 0), 0);
    byApp.push({ client_app_id: app.client_app_id, posts_read: total });
  }

  const percent = postsRead !== undefined && cap !== undefined ? pct(postsRead, cap) : undefined;
  return {
    ...(data?.project_id !== undefined ? { project_id: data.project_id } : {}),
    posts_read: postsRead ?? 0,
    ...(cap !== undefined ? { cap } : {}),
    ...(percent !== undefined ? { percent_used: percent } : {}),
    ...(capResetDay !== undefined ? { cap_reset_day: capResetDay } : {}),
    ...(daily.length > 0 ? { daily } : {}),
    ...(byApp.length > 0 ? { by_app: byApp } : {}),
  };
}

function renderBudget(budget: UsageToolDeps['budget']): SessionBudgetReport {
  const spent = usd(budget.total());
  const limit = budget.limit;
  if (limit === undefined) return { spent_usd: spent, mode: budget.mode };
  const percent = pct(spent, limit);
  return {
    spent_usd: spent,
    mode: budget.mode,
    limit_usd: usd(limit),
    remaining_usd: usd(Math.max(0, limit - spent)),
    ...(percent !== undefined ? { percent_used: percent } : {}),
  };
}

// --- Factory --------------------------------------------------------------------------

/**
 * Build the usage tools, binding the handler to `deps`. Returns `[x_usage_get]` for the
 * registry to collect (T-115); the composition root spreads it like `createAuthTools`.
 */
export function createUsageTools(deps: UsageToolDeps): AnyToolDef[] {
  const xUsageGet = defineTool({
    name: 'x_usage_get',
    title: 'Usage and spend',
    description:
      'X (Twitter): report the post-read consumption of the current billing cycle against the ' +
      'monthly project cap (with an optional per-day and per-app breakdown), alongside the ' +
      'local credit-spend estimate for this session. The platform numbers are READ COUNTS, ' +
      'not money — X ' +
      'publishes no spend API — and the session estimate is a local, advisory figure that ' +
      'resets when the server restarts. Use it to check headroom before a high-volume read.',
    policy: 'read:account',
    availability: 'app+user',
    // The endpoint authenticates with the app bearer token on an approved developer account
    // and names no user-level OAuth scope, so none is declared rather than inventing one.
    scopes: [],
    cost: 'owned',
    annotations: { title: 'Usage and spend', readOnlyHint: true, openWorldHint: true },
    phase: 3,
    input: z
      .object({
        days: z
          .number()
          .int()
          .optional()
          .describe(
            'Days of daily breakdown to return (1-90; the API defaults to 7). Out-of-range ' +
              'values are clamped into the window.',
          ),
        raw: z
          .boolean()
          .optional()
          .describe('Return the exact API JSON instead of the compact report.'),
      })
      .strict(),
    handler: async (input, ctx): Promise<ToolOutput> => {
      const clamp = input.days !== undefined ? clampDays(input.days) : undefined;
      const res = await getUsage(ctx.http, clamp !== undefined ? { days: clamp.value } : {});

      if (input.raw === true) {
        return { data: res, summary: 'Raw usage response.' };
      }

      const platform = renderPlatform(res);
      const notes = [
        ...(res.data === undefined ? [DEGRADED_NOTE, ...platformReason(res)] : []),
        ...(clamp?.note !== undefined ? [clamp.note] : []),
        USAGE_NOTE,
      ];
      const report: UsageReport = {
        platform,
        session_budget: renderBudget(deps.budget),
        note: notes.join(' '),
      };

      const capPart =
        platform.cap !== undefined
          ? `${platform.posts_read} of ${platform.cap} posts read` +
            (platform.percent_used !== undefined ? ` (${platform.percent_used}%)` : '')
          : res.data === undefined
            ? 'platform usage unknown'
            : `${platform.posts_read} posts read`;
      return {
        data: report,
        summary: `${capPart}; local session estimate $${report.session_budget.spent_usd}.`,
      };
    },
  });

  return [xUsageGet];
}
