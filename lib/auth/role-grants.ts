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
 * Authority precedence over a tenant, most authoritative first.
 *
 * This is the ONE ordering in the codebase for "several grants, one answer
 * required". It exists so that no site invents its own tie-break and so that two
 * sites reading the same user never disagree about which grant spoke.
 *
 * It is NOT a permission model and must not grow into one: it decides ORDER, not
 * ACCESS. A role absent from the list is not denied anything — it merely sorts
 * after the listed ones, and stably, by name.
 */
const ROLE_AUTHORITY_RANK = [
  "superadmin", "broker_owner", "broker", "admin", "compliance_officer",
  "team_lead", "tc", "agent", "isa", "title_agent", "lender", "vendor", "contact",
] as const

/** Comparator implementing ROLE_AUTHORITY_RANK with a stable by-name fallback. */
function byAuthority(a: { role: string | null }, b: { role: string | null }): number {
  const ra = ROLE_AUTHORITY_RANK.indexOf(String(a.role ?? "") as never)
  const rb = ROLE_AUTHORITY_RANK.indexOf(String(b.role ?? "") as never)
  // An unranked role sorts last, but still sorts STABLY — by role name — so the
  // answer never depends on the order PostgREST happened to return.
  const na = ra === -1 ? ROLE_AUTHORITY_RANK.length : ra
  const nb = rb === -1 ? ROLE_AUTHORITY_RANK.length : rb
  if (na !== nb) return na - nb
  return String(a.role ?? "").localeCompare(String(b.role ?? ""))
}

/**
 * The grant that anchors this user to a TENANT.
 *
 * A NULL brokerage_id is not a tenancy: `contact` and `lender` grants carry no
 * brokerage and must never be used as a tenant anchor — that is precisely the
 * row `.limit(1)` could pick. Among the tenanted grants the choice is made by
 * an explicit, stable precedence rather than by row order.
 *
 * Generic in the row type so a caller that needs MORE than `RoleGrant` carries
 * can run its own `select` and still get this one ordering, instead of copying
 * the precedence and drifting from it. The caller that motivated the generic —
 * lib/auth/permissions.ts, which selected the grant's own `id` and its embedded
 * brokerage record — was DELETED in wave 26 as a duplicate permission stack
 * (tombstone: lib/auth/index.ts; survivor: lib/security/permission-matrix.ts).
 * The generic stays, exercised by scripts/multi-role-seat-simulator.ts:128; the
 * in-app path is `selectTenantBrokerageId` below (app/api/internal/ai-chat and
 * ai-note), which passes plain `RoleGrant` rows.
 */
export function selectTenantGrant<T extends { role: string | null; brokerage_id: string | null }>(
  grants: T[],
): T | null {
  const tenanted = grants.filter((g) => g.brokerage_id)
  if (tenanted.length === 0) return null
  if (tenanted.length === 1) return tenanted[0]
  // Any user holding several tenanted grants (the live agent+admin+isa account is
  // the case in hand) resolves to the SAME brokerage on every call.
  return [...tenanted].sort(byAuthority)[0]
}

/** Convenience over selectTenantGrant for the common "just the id" caller. */
export function selectTenantBrokerageId(grants: RoleGrant[]): string | null {
  return selectTenantGrant(grants)?.brokerage_id ?? null
}

/**
 * The vendor-bearing grant, or null.
 *
 * The sites this replaces all wrote `.not("vendor_id","is",null).maybeSingle()`
 * with NO limit. That is shape (1) above: the constraint permits a user to hold
 * two vendor-bearing grants under different roles, and the day one does, the
 * read errors and every vendor surface reads "Not a vendor account".
 *
 * Vendor identity is single-valued in this product, so several vendor-bearing
 * grants pointing at DIFFERENT vendors is a data fault, not a choice to make
 * quietly: the caller is told, and gets null rather than an arbitrary vendor.
 *
 * Several grants pointing at the SAME vendor is not a fault (a user may hold both
 * `vendor` and, say, `contact` against one vendor), so the vendor resolves — but
 * the grant handed back is chosen by authority, never by row order, because the
 * caller may go on to read `brokerage_id` off it.
 */
export function selectVendorGrant(grants: RoleGrant[]): { grant: RoleGrant | null; ambiguous: boolean } {
  const bearing = grants.filter((g) => g.vendor_id)
  const ids = [...new Set(bearing.map((g) => g.vendor_id))]
  if (ids.length === 0) return { grant: null, ambiguous: false }
  if (ids.length > 1) return { grant: null, ambiguous: true }
  return { grant: [...bearing].sort(byAuthority)[0], ambiguous: false }
}

/** Convenience over selectVendorGrant for the common "just the id" caller. */
export function selectVendorId(grants: RoleGrant[]): { vendorId: string | null; ambiguous: boolean } {
  const { grant, ambiguous } = selectVendorGrant(grants)
  return { vendorId: grant?.vendor_id ?? null, ambiguous }
}

/**
 * The agents row this user IS, or null.
 *
 * Same treatment as the vendor above, and for a stronger reason: MEASURED,
 * `public.agents` carries `agents_user_id_key UNIQUE (user_id)`, so one user has
 * AT MOST ONE agents row and therefore their grants can only correctly carry ONE
 * distinct agent_id. Two different ones is not a choice to make quietly, it is a
 * provable data fault — and picking either would hand a caller someone else's
 * production, commissions and pipeline under their own identity.
 *
 * Several grants carrying the SAME agent_id is ordinary (the live admin+agent+isa
 * seat is exactly that shape), so that resolves.
 *
 * Replaces `grants.find((g) => g.agent_id)?.agent_id`, which skipped the
 * agent_id-less grants correctly but still let row order settle a tie it should
 * have reported. This module exists so no site invents its own tie-break; that
 * includes this one.
 */
export function selectAgentId(grants: RoleGrant[]): { agentId: string | null; ambiguous: boolean } {
  const ids = [...new Set(grants.map((g) => g.agent_id).filter((v): v is string => !!v))]
  if (ids.length === 0) return { agentId: null, ambiguous: false }
  if (ids.length > 1) return { agentId: null, ambiguous: true }
  return { agentId: ids[0], ambiguous: false }
}

/**
 * Does this user hold ANY of `roles`?
 *
 * The question most "is the caller an admin?" sites are really asking. Comparing
 * ONE resolved role name against a list gets the wrong answer for a user whose
 * admin grant is not the one that happened to be picked — which, in a tenant
 * where one person carries transactions AND compliance AND admin, is the norm.
 * Case-insensitive because `users.role` is legacy free-form ("Admin", "Lender").
 */
export function holdsAnyRole(grants: RoleGrant[], roles: readonly string[]): boolean {
  const wanted = new Set(roles.map((r) => r.toLowerCase()))
  return grants.some((g) => wanted.has(String(g.role ?? "").toLowerCase()))
}

/** Every distinct role this user holds, lowercased, in authority order. */
export function allRoles(grants: RoleGrant[]): string[] {
  const seen = new Set<string>()
  return [...grants]
    .sort(byAuthority)
    .map((g) => String(g.role ?? "").toLowerCase())
    .filter((r) => r && !seen.has(r) && (seen.add(r), true))
}

/**
 * ONE role name, for the sites that can only act on one (an AI system prompt's
 * "you are talking to a …", a context loader that picks one branch).
 *
 * `preferred` — normally `users.user_type`, the seat's own declared identity — WINS
 * whenever the user actually holds a grant for it. That is deliberate: the seat
 * says what this person primarily is, and the grant table says what else they
 * carry. Falling straight to authority order would silently re-label the live
 * agent+admin+isa account as an admin and swing its assistant context, which no
 * one asked for. Only when `preferred` is absent or ungranted does authority
 * order decide — and then it decides the same way on every call.
 *
 * Returns null when the user holds no grants at all; the caller keeps its own
 * fallback, because "no grant" is a different thing from "grant read failed".
 */
export function selectPrimaryRole(grants: RoleGrant[], preferred?: string | null): string | null {
  const roles = allRoles(grants)
  if (roles.length === 0) return null
  const want = String(preferred ?? "").toLowerCase()
  if (want && roles.includes(want)) return want
  return roles[0]
}
