"use server"

/**
 * app/actions/critical-setup.ts — session-gated wrapper over the critical-setup
 * registry (lib/onboarding/critical-setup.ts). Resolves the caller's role,
 * agent row, and (for vendors) vendors.id, loads the honest facts with the
 * service client, and returns the composed per-category readiness. Used by the
 * client meter mounts (agent dashboard); server pages compose directly.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  composeSetupReadiness,
  loadCriticalSetupFacts,
  normalizeCriticalRole,
  type CriticalSetupReadiness,
} from "@/lib/onboarding/critical-setup"
import { readRoleGrants, selectVendorId } from "@/lib/auth/role-grants"

export async function getMyCriticalSetupReadiness(): Promise<CriticalSetupReadiness | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const svc = createServiceClient()
  const { data: profile } = await svc
    .from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  const brokerageId = (profile as { brokerage_id?: string | null } | null)?.brokerage_id ?? null
  const role = normalizeCriticalRole((profile as { user_type?: string | null } | null)?.user_type)
  if (!brokerageId || !role) return null

  let agentId: string | null = null
  if (role === "agent" || role === "team_lead") {
    const { data: agent } = await svc.from("agents").select("id")
      .eq("user_id", user.id).eq("brokerage_id", brokerageId).maybeSingle()
    agentId = (agent as { id?: string } | null)?.id ?? null
  }

  let vendorId: string | null = null
  if (role === "vendor") {
    // WAS: `.not("vendor_id","is",null).maybeSingle()` with no limit.
    // user_role_assignments is UNIQUE on (user_id, role), NOT on user_id, so the
    // constraint PERMITS a user to hold two vendor-bearing grants under different
    // roles. `.maybeSingle()` over two rows is an ERROR, not a pick, and supabase-js
    // RESOLVES it — so the day that happens this reads as "no vendor" and the whole
    // vendor setup checklist silently empties. Read all grants and choose.
    const grantsResult = await readRoleGrants(svc, user.id)
    if (!grantsResult.ok) {
      console.error("[critical-setup] role grant read failed:", grantsResult.error)
      return null
    }
    const { vendorId: resolved, ambiguous } = selectVendorId(grantsResult.grants)
    if (ambiguous) {
      console.error("[critical-setup] user holds grants for MORE THAN ONE vendor; refusing to guess:", user.id)
      return null
    }
    vendorId = resolved
  }

  const facts = await loadCriticalSetupFacts(svc, {
    brokerageId,
    userId: user.id,
    agentId,
    includeTeamLead: role === "team_lead",
    vendorId,
  })
  return composeSetupReadiness({ role, facts })
}
