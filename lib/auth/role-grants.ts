/**
 * lib/auth/role-grants.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * READING `user_role_assignments` WHEN A USER MAY HOLD MORE THAN ONE GRANT.
 *
 * ── THE DEFECT THIS MODULE EXISTS TO END (tracked #221) ─────────────────────
 *
 * MEASURED on the live database, not reasoned about:
 *
 *   · The table's uniqueness constraint is
 *       user_role_assignments_user_role_unique  UNIQUE (user_id, role)
 *     — on the PAIR, **not** on user_id. One user may therefore hold many rows.
 *   · One live user holds THREE grants (agent + admin + isa).
 *   · Another holds TWO (contact + team_lead), and the `contact` one carries a
 *     NULL brokerage_id.
 *
 * Two bad shapes followed from assuming one row per user, and both were live:
 *
 *   (1) `.eq("user_id", …).maybeSingle()` — over more than one row this is an
 *       ERROR, not a pick. supabase-js RESOLVES it, so an unchecked caller reads
 *       the failure as "this user has no grant" and refuses the very users the
 *       read exists to serve. It fails for exactly the busiest accounts.
 *
 *   (2) `.limit(1).maybeSingle()` — cannot throw, and that is what makes it
 *       WORSE. With no `.order()`, PostgREST returns rows in whatever order the
 *       plan produces; the "chosen" grant is ARBITRARY. For a tenant lookup that
 *       means the tenant can silently change between two runs of the same code,
 *       and the row that wins may be the untenanted `contact` grant whose
 *       brokerage_id is NULL. Row order must never decide a tenant.
 *
 * The correct shape — established in lib/auth/require-brokerage-admin.ts and
 * generalised here — is: READ ALL THE GRANTS, THEN CHOOSE DELIBERATELY.
 *
 * ── WHY A MODULE RATHER THAN SIX INLINE FIXES ───────────────────────────────
 *
 * require-brokerage-admin.ts opens by describing a gate that was copied three
 * times, corrected once, and silently divergent thereafter. This is the same
 * rule read from six places. Centralising it is the only way the correction
 * stays correct.
 *
 * The client is INJECTED for the same reason it is there: some callers hold a
 * SERVICE client (they go on to read rows the caller cannot see) and some hold
 * the SESSION client (so RLS still applies underneath). Hard-coding either would
 * silently change a caller's security posture.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

/** One row of user_role_assignments, narrowed to what any chooser here needs. */
export type RoleGrant = {
  role: string | null
  brokerage_id: string | null
  vendor_id: string | null
  agent_id: string | null
}

export type RoleGrantsResult =
  | { ok: true; grants: RoleGrant[] }
  | { ok: false; error: string }

/**
 * Every grant held by `userId`. Never `.maybeSingle()` — see the header.
 *
 * Returns a discriminated result rather than throwing, because most callers of
 * this read are UI-facing actions that must distinguish "no grant" (a legitimate
 * absence) from "the read was refused" (an outage). Collapsing those two is the
 * second half of the defect above.
 */
export async function readRoleGrants(
  supabase: SupabaseClient<any, any, any>,
  userId: string,
): Promise<RoleGrantsResult> {
  const { data, error } = await supabase
    .from("user_role_assignments")
    .select("role, brokerage_id, vendor_id, agent_id")
    .eq("user_id", userId)

  // supabase-js RESOLVES a failed query. An unchecked read here reports a
  // permission denial as an empty grant list, which every caller below would
  // then translate into "not a vendor" / "no brokerage" — a refusal for the
  // wrong reason, and invisible.
  if (error) return { ok: false, error: error.message }

  return { ok: true, grants: (data ?? []) as RoleGrant[] }
}

/**
 * The grant that anchors this user to a TENANT.
 *
 * A NULL brokerage_id is not a tenancy: `contact` and `lender` grants carry no
 * brokerage and must never be used as a tenant anchor — that is precisely the
 * row `.limit(1)` could pick. Among the tenanted grants the choice is made by
 * an explicit, stable precedence rather than by row order.
 */
// NOT exported: `selectTenantBrokerageId` below is the only caller and the only
// shape any site needs today. An exported helper with no caller is an unfinished
// feature, not an API — if a caller ever needs the whole grant, export it then.
function selectTenantGrant(grants: RoleGrant[]): RoleGrant | null {
  const tenanted = grants.filter((g) => g.brokerage_id)
  if (tenanted.length === 0) return null
  if (tenanted.length === 1) return tenanted[0]

  // Deterministic precedence: the grant that carries the most authority over the
  // tenant wins. Any user holding several tenanted grants (the live agent+admin+isa
  // account is the case in hand) resolves to the SAME brokerage on every call.
  const RANK = ["broker_owner", "broker", "admin", "team_lead", "agent", "isa", "tc", "vendor"]
  const ranked = [...tenanted].sort((a, b) => {
    const ra = RANK.indexOf(String(a.role ?? ""))
    const rb = RANK.indexOf(String(b.role ?? ""))
    // An unranked role sorts last, but still sorts STABLY — by role name — so the
    // answer never depends on the order PostgREST happened to return.
    const na = ra === -1 ? RANK.length : ra
    const nb = rb === -1 ? RANK.length : rb
    if (na !== nb) return na - nb
    return String(a.role ?? "").localeCompare(String(b.role ?? ""))
  })
  return ranked[0]
}

/** Convenience over selectTenantGrant for the common "just the id" caller. */
export function selectTenantBrokerageId(grants: RoleGrant[]): string | null {
  return selectTenantGrant(grants)?.brokerage_id ?? null
}

/**
 * The vendor this user acts as, or null.
 *
 * The sites this replaces all wrote `.not("vendor_id","is",null).maybeSingle()`
 * with NO limit. That is shape (1) above: the constraint permits a user to hold
 * two vendor-bearing grants under different roles, and the day one does, the
 * read errors and every vendor surface reads "Not a vendor account".
 *
 * Vendor identity is single-valued in this product, so several vendor-bearing
 * grants pointing at DIFFERENT vendors is a data fault, not a choice to make
 * quietly: the caller is told, and gets null rather than an arbitrary vendor.
 */
export function selectVendorId(grants: RoleGrant[]): { vendorId: string | null; ambiguous: boolean } {
  const ids = [...new Set(grants.map((g) => g.vendor_id).filter((v): v is string => !!v))]
  if (ids.length === 0) return { vendorId: null, ambiguous: false }
  if (ids.length === 1) return { vendorId: ids[0], ambiguous: false }
  return { vendorId: null, ambiguous: true }
}
