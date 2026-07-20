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
    const { data: ra } = await svc.from("user_role_assignments").select("vendor_id")
      .eq("user_id", user.id).not("vendor_id", "is", null).maybeSingle()
    vendorId = (ra as { vendor_id?: string | null } | null)?.vendor_id ?? null
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
