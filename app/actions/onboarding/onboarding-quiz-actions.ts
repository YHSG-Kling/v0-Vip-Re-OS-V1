'use server'

import { createClient } from "@/lib/supabase/server"
import { getQuizForStep, submitQuizAttempt } from "@/lib/kernel"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export async function fetchQuiz(stepId: string): Promise<{
  quizId: string
  quizName: string
  passingScore: number
  questions: Record<string, unknown>[]
} | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  const agentContext = await getAgentContext()
  if (!agentContext?.agentId) throw new Error("Agent context not found")

  return getQuizForStep({
    userId: user.id,
    agentId: agentContext.agentId,
    stepId,
  })
}

export async function submitQuiz(
  quizId: string,
  answers: Record<string, unknown>
): Promise<{
  score: number
  passed: boolean
  correctCount: number
  totalQuestions: number
  attemptNumber: number
  passingScore: number
  message: string
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) throw new Error("Unauthorized")

  const agentContext = await getAgentContext()
  if (!agentContext?.agentId) throw new Error("Agent context not found")

  return submitQuizAttempt({
    userId: user.id,
    agentId: agentContext.agentId,
    quizId,
    answers,
  })
}
