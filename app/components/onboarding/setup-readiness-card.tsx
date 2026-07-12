import { getAgentContext } from "@/lib/identity/get-agent-context"
import { normalizeSetupRole, loadSetupReadiness } from "@/lib/onboarding/setup-readiness"
import { SetupReadinessCardView } from "./setup-readiness-view"
import { DecisionRoom } from "./decision-room"
import { createServiceClient } from "@/lib/supabase/service"
import { composeOnboardingDecisions, loadOnboardingDecisionFacts, attachLessons } from "@/lib/onboarding/onboarding-decisions"

/**
 * Server setup-readiness card — resolves the viewer's role + real configured state and renders the shared
 * view. Drop it directly on any SERVER dashboard (e.g. the brokerage dashboard). Client dashboards use
 * SetupReadinessCardClient instead.
 *
 * Now TWO halves of the same first-week surface: the DECISION ROOM ("here's
 * what your AI team already prepared — approve it", evidence-backed) above
 * the checklist ("go configure X"). Decisions disappear only when done —
 * the checklist card still self-hides at 100%.
 */
export async function SetupReadinessCard() {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return null
  const role = normalizeSetupRole(ctx.role)
  const readiness = await loadSetupReadiness({
    userId: ctx.userId, role, brokerageId: ctx.brokerageId, agentId: ctx.agentId,
  })
  let decisions: ReturnType<typeof composeOnboardingDecisions> = []
  if (ctx.brokerageId) {
    try {
      const facts = await loadOnboardingDecisionFacts(createServiceClient() as any, { brokerageId: ctx.brokerageId })
      const composed = attachLessons(composeOnboardingDecisions(facts), facts.moduleIdByTopic ?? new Map())
      // The room earns its space only while something is actionable.
      if (composed.some((d) => d.state !== "done")) decisions = composed
    } catch { /* decision room is additive — the checklist always renders */ }
  }
  return (
    <div className="space-y-4">
      {decisions.length > 0 && <DecisionRoom decisions={decisions} />}
      <SetupReadinessCardView readiness={readiness} />
    </div>
  )
}
