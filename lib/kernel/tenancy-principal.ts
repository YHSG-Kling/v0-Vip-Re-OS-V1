/**
 * lib/kernel/tenancy-principal.ts
 *
 * WHO GOVERNS THIS TENANCY — the ONE tier-parity rule (owner directive:
 * every tenancy shape gets the same trust system; governance never
 * belongs to an org chart the tenant doesn't have):
 *
 *   · broker / broker_admin / broker_owner / admin — always principals.
 *   · solo_agent tier — the agent IS the principal (their own shop).
 *   · team tier — the team lead (teams.team_lead_id → their agents row).
 *   · brokerage / multi_location tiers — broker/admin only.
 *
 * Shared by the Earned Autonomy grant actions and every onboarding /
 * governance surface that needs "may this user decide for the tenancy?"
 * — one rule, no drift. NOT server-only (simulator-driven).
 */

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

// Role input must be users.user_type (case-insensitive): the legacy users.role
// column holds title-cased junk live ('Admin', 'Lender') and never feeds this.
// broker_admin is a legacy INPUT spelling (canonicalizes to broker, never stored).
// super_admin/superadmin are dropped — neither is storable as users.user_type
// (0 live rows), and platform staff is a platform_role question, not a tenancy one.
// team_lead is deliberately NOT here: team-tier leads pass via the
// teams.team_lead_id FK fallback below (tenancy grain, m472/m473).
export const PRINCIPAL_ROLES = new Set(["broker", "broker_admin", "broker_owner", "admin"])

export async function isTenancyPrincipal(
  svc: Svc,
  input: { userId: string; brokerageId: string; role: string },
): Promise<boolean> {
  if (PRINCIPAL_ROLES.has(String(input.role ?? "").toLowerCase())) return true
  const { data: brk } = await svc.from("brokerages").select("plan_tier").eq("id", input.brokerageId).maybeSingle()
  const tier = String((brk as any)?.plan_tier ?? "solo_agent")
  if (tier === "solo_agent") return true
  if (tier === "team") {
    // team_lead_id is users.id (FK auth.users(id) per scripts/230; written as
    // authUserId in lib/kernel/users.ts, read as .eq(team_lead_id, userId) by the
    // team-lead brief). The prior code matched it against the caller's agents.id,
    // which never equals a users.id — so a team lead was silently denied principal
    // status and locked out of governing their own team. Compare against userId.
    const { data: lead } = await svc.from("teams").select("id")
      .eq("brokerage_id", input.brokerageId).eq("team_lead_id", input.userId)
      .is("deleted_at", null).limit(1).maybeSingle()
    return !!lead
  }
  return false
}
