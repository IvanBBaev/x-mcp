// Availability class-gating machinery — the executable form of docs/01 §3.3 (the T-010
// availability-detection spec; roadmap WP-0.10 / WP-3.5). Owned by the T-306 archive slice.
//
// Under pay-per-use there is no tier-enrollment 403 to infer capability from, so the
// reachable surface is an EXPLICIT, operator-declared set (`X_MCP_AVAILABILITY`, parsed by
// core/config into `Config.availability`). This module resolves that declaration and
// partitions the tool list at REGISTRATION time:
//
//  - The universally-available pay-per-use classes (`app+user`, `user-only`) are ALWAYS in
//    the resolved set — docs/01 §3.3: gating applies "only the specially-provisioned
//    classes". Full-archive search/counts and `x_user_search` are `app+user`, so they
//    register by default and are restrained by the session credit budget (COST-1), not
//    hidden here.
//  - The specially-provisioned classes (`pilot`, `premium-user`, `enterprise`) are OFF
//    until explicitly listed — the conservative default. A tool declaring one of them is
//    NOT registered at all when its class is missing from the resolved set: a tool the
//    account cannot reach should not tempt the agent into burning credits on a guaranteed
//    failure. No v1 tool uses these classes; the machinery exists for future tools.
//
// Availability gating is DISTINCT from policy denial (POL-7): a policy-denied tool stays
// registered + annotated "(disabled by policy ...)" so the refusal is self-documenting; an
// availability-excluded tool is absent entirely. The resolved set is surfaced to the
// operator via `x_auth_status` (AUTH-15) — see the integrator hook in the T-306 report.

import { AVAILABILITY_CLASSES } from '../core/tooldef.js';
import type { AnyToolDef, AvailabilityClass } from '../core/tooldef.js';

/**
 * The universally-available pay-per-use surface (docs/01 §3.3 conservative default).
 * Always present in the resolved set, whatever the operator declares.
 */
export const BASE_AVAILABILITY: readonly AvailabilityClass[] = ['app+user', 'user-only'];

/**
 * The specially-provisioned classes — the only ones `X_MCP_AVAILABILITY` actually toggles.
 * Derived from the frozen class list so the two can never drift.
 */
export const GATED_AVAILABILITY_CLASSES: readonly AvailabilityClass[] = AVAILABILITY_CLASSES.filter(
  (c) => !BASE_AVAILABILITY.includes(c),
);

/**
 * Resolve the operator-declared availability set (docs/01 §3.3). The result is
 * `BASE_AVAILABILITY` plus every declared specially-provisioned class, deduped and
 * order-stable (base first, then declared gated classes in declaration order). An unset /
 * empty declaration yields exactly the conservative default (`app+user,user-only`);
 * declaring a base class is redundant and harmless.
 */
export function resolveAvailability(
  declared: readonly AvailabilityClass[],
): readonly AvailabilityClass[] {
  const resolved: AvailabilityClass[] = [...BASE_AVAILABILITY];
  for (const cls of declared) {
    if (!resolved.includes(cls)) resolved.push(cls);
  }
  return Object.freeze(resolved);
}

/** Is this tool reachable under an already-resolved availability set? Pure, never throws. */
export function isAvailable(tool: AnyToolDef, resolved: readonly AvailabilityClass[]): boolean {
  return resolved.includes(tool.availability);
}

/** The registration-time partition of a tool list under a resolved availability set. */
export interface AvailabilityGateResult {
  /** The resolved set (base classes + declared gated classes) — surface in `auth_status`. */
  readonly resolved: readonly AvailabilityClass[];
  /** Tools to hand to `createRegistry` — their availability class is in the resolved set. */
  readonly registered: readonly AnyToolDef[];
  /** Tools dropped from registration entirely (never listed, never callable). */
  readonly excluded: readonly AnyToolDef[];
}

/**
 * Partition `tools` by availability at registration time (docs/01 §3.3 "consumed by the
 * registry"). The composition root calls this ONCE on the collected tool list, registers
 * `registered`, logs `excluded` (an operator-facing startup notice, not an error), and
 * surfaces `resolved` through the auth-session snapshot (AUTH-15). Registration order is
 * preserved so the gate never reorders the catalog.
 */
export function gateByAvailability(
  tools: readonly AnyToolDef[],
  declared: readonly AvailabilityClass[],
): AvailabilityGateResult {
  const resolved = resolveAvailability(declared);
  const registered: AnyToolDef[] = [];
  const excluded: AnyToolDef[] = [];
  for (const tool of tools) {
    (isAvailable(tool, resolved) ? registered : excluded).push(tool);
  }
  return { resolved, registered, excluded };
}
