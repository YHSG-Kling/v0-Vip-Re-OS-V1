/**
 * lib/kernel/tenancy-principal.ts
 *
 * WHO GOVERNS THIS TENANCY — the ONE tier-parity rule (owner directive:
 * every tenancy shape gets the same trust system; governance never
 * belongs to an org chart the tenant doesn't have):
 *
 *   · broker / admin / super_admin — always principals.
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

export const PRINCIPAL_ROLES = new Set(["broker", "admin", "super_admin", "superadmin"])

export async function isTenancyPrincipal(
  svc: Svc,
  input: { userId: string; brokerageId: string; role: string },
): Promise<boolean> {
  if (PRINCIPAL_ROLES.has(input.role)) return true
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
