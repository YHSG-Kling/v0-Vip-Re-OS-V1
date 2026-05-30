"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { getAgentOnboardingDashboard, completeAISessionStep } from "@/lib/kernel"

export async function fetchMyOnboardingDashboard() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  const { agentId } = await getAgentContext()
  if (!agentId) throw new Error("Missing agent context")

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
  if (!agentId) throw new Error("Missing agent context")

  await completeAISessionStep({ userId: user.id, agentId, stepId, data })
}
