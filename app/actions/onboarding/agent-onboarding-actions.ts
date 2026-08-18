"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { completeAISessionStep } from "@/lib/kernel"

// TOMBSTONE (orphan tranche 3): fetchMyOnboardingDashboard deleted — a wrapper
// no surface called. The live survivor is app/dashboard/onboarding/page.tsx,
// which calls lib/kernel/agent-onboarding.ts:getAgentOnboardingDashboard
// directly with the m353-correct agent resolution (agents.id looked up
// explicitly, never `?? user.id` — the class mix-up this wrapper's
// getAgentContext() shortcut papered over).

export async function completeMyOnboardingStep(stepId: string, data?: {
  timeSpentMinutes?: number
  quizScore?: number
  notes?: string
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  const { agentId } = await getAgentContext()
  if (!agentId) throw new Error("Missing agent context")

  await completeAISessionStep({ userId: user.id, agentId, stepId, data })
}
