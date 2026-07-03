import { getAgentContext } from "@/lib/identity/get-agent-context"
import { normalizeSetupRole, loadSetupReadiness } from "@/lib/onboarding/setup-readiness"
import { SetupReadinessCardView } from "./setup-readiness-view"

/**
 * Server setup-readiness card — resolves the viewer's role + real configured state and renders the shared
 * view. Drop it directly on any SERVER dashboard (e.g. the brokerage dashboard). Client dashboards use
 * SetupReadinessCardClient instead.
 */
export async function SetupReadinessCard() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return null
  const role = normalizeSetupRole(ctx.role)
  const readiness = await loadSetupReadiness({
    userId: ctx.userId, role, brokerageId: ctx.brokerageId, agentId: ctx.agentId,
  })
  return <SetupReadinessCardView readiness={readiness} />
}
