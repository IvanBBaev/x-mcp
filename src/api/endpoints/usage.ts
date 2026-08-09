// Typed endpoint wrapper for the X API v2 platform usage endpoint (docs/01 §3.5 + §5 "Ops";
// docs/03 `x_usage_get`). Owned by the T-317 usage slice (WP-3.11).
//
// The T-010 fact-check (docs/01 §3.5, 2026-07-22) verified that `GET /2/usage/tweets` still
// exists under pay-per-use and reports post-read COUNTS against the monthly project cap —
// never dollar/credit spend. There is no documented spend/credits API, so this module is the
// whole platform-side accounting surface the server can reach.
//
// Auth: an app bearer token on an approved developer account; the endpoint names no OAuth
// scope (it is project-level, not user-level), so the request declares none — `scopes` on
// `XApiRequest` is a declarative hint used for token selection/precise 403s, and inventing a
// user scope here would be a lie. Nothing here owns transport, auth, retries, or error
// mapping — that is the injected `EndpointInvoker` (api/http, T-114). Optional query keys are
// OMITTED when undefined (exactOptionalPropertyTypes-safe), so an unset `days` never becomes
// an empty `?days=`.

import type { EndpointInvoker } from '../../core/tooldef.js';

/**
 * Every documented `usage.fields` value, requested explicitly so the response shape is
 * deterministic rather than dependent on the endpoint's evolving defaults (DRIFT-1).
 */
const USAGE_FIELDS =
  'cap_reset_day,daily_client_app_usage,daily_project_usage,project_cap,project_id,project_usage';

/**
 * One day of the usage breakdown. X returns the counters as JSON **strings** on this
 * endpoint (unlike the numeric `public_metrics` elsewhere), so both are accepted and the
 * tool layer coerces defensively (DRIFT-1).
 */
export interface RawDailyUsage {
  readonly date?: string;
  readonly usage?: string | number;
}

/** Per-client-app breakdown: the app's id plus its own daily series. */
export interface RawClientAppUsage {
  readonly client_app_id?: string;
  readonly usage?: readonly RawDailyUsage[];
  readonly usage_result_count?: number;
}

/**
 * The `GET /2/usage/tweets` response envelope. Not modelled in core/render — it carries only
 * ids, counters and dates, never post or profile text — so it is defined locally. Every field
 * is optional: the API omits fields freely and may add new ones (DRIFT-1).
 */
export interface RawUsageResponse {
  readonly data?: {
    readonly project_id?: string;
    readonly project_usage?: string | number;
    readonly project_cap?: string | number;
    readonly cap_reset_day?: string | number;
    readonly daily_project_usage?: readonly RawDailyUsage[];
    readonly daily_client_app_usage?: readonly RawClientAppUsage[];
  };
  /**
   * A 200 body may carry `errors[]` INSTEAD of `data` (the partial-failure convention,
   * REND-2). There is nothing to reconcile per-resource here — the whole report is either
   * present or not — so the tool layer only quotes the reason into its degradation note.
   */
  readonly errors?: readonly {
    readonly title?: string;
    readonly detail?: string;
  }[];
}

/** Parameters for {@link getUsage}. */
export interface UsageParams {
  /** Days of daily breakdown to return (1-90; the API defaults to 7). Clamped by the caller. */
  readonly days?: number;
}

/**
 * `GET /2/usage/tweets` — posts read this billing cycle vs the project cap (docs/03
 * `x_usage_get`). Returns counts only; dollar/credit spend is not exposed by any X API.
 */
export async function getUsage(
  http: EndpointInvoker,
  params: UsageParams = {},
): Promise<RawUsageResponse> {
  return http.send<RawUsageResponse>({
    method: 'GET',
    path: '/2/usage/tweets',
    query: {
      'usage.fields': USAGE_FIELDS,
      ...(params.days !== undefined ? { days: params.days } : {}),
    },
  });
}

/** The exact `usage.fields` value put on the wire — re-exported so tests can pin it. */
export { USAGE_FIELDS };
