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
    const { data: agentRow } = await svc.from("agents").select("id")
      .eq("user_id", input.userId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (!agentRow) return false
    const { data: lead } = await svc.from("teams").select("id")
      .eq("brokerage_id", input.brokerageId).eq("team_lead_id", (agentRow as any).id)
      .is("deleted_at", null).limit(1).maybeSingle()
    return !!lead
  }
  return false
}
