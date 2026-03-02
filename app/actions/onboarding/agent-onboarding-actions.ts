"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { getAgentOnboardingDashboard, completeOnboardingStep } from "@/lib/kernel"

export async function fetchMyOnboardingDashboard() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  const { agentId } = await getAgentContext()

  return await getAgentOnboardingDashboard({ userId: user.id, agentId })
}

export async function completeMyOnboardingStep(stepId: string, data?: {
  timeSpentMinutes?: number
  quizScore?: number
  notes?: string
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  const { agentId } = await getAgentContext()

  await completeOnboardingStep({ userId: user.id, agentId, stepId, data })
}
