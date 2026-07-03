"use server"

import { getAgentContext } from "@/lib/identity/get-agent-context"
import { normalizeSetupRole, loadSetupReadiness, type SetupReadiness } from "@/lib/onboarding/setup-readiness"

/** Load the current user's role-aware setup readiness (for client dashboards that can't render a server card). */
export async function getMySetupReadiness(): Promise<SetupReadiness | null> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return null
  const role = normalizeSetupRole(ctx.role)
  return loadSetupReadiness({ userId: ctx.userId, role, brokerageId: ctx.brokerageId, agentId: ctx.agentId })
}
