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

  const quiz = await getQuizForStep({
    userId: user.id,
    agentId: agentContext.agentId,
    stepId,
  })
  if (!quiz) return null
  // WAVE 155 (lane 155C): the answer key never leaves the server. getQuizForStep returns the stored questions WITH their
  // correctAnswer; this public endpoint handed them to the browser, so any learner could read the key before answering
  // (OnboardingQuizClient never reads it — grading is server-side in submitQuizAttempt).
  return { ...quiz, questions: quiz.questions.map((q) => withoutAnswerKey(q)) }
}

/** A question with every answer-key spelling removed. Module-internal (not exported from a "use server" file). */
function withoutAnswerKey(q: Record<string, unknown>): Record<string, unknown> {
  const { correctAnswer: _a, correct_answer: _b, correct_idx: _c, correctIndex: _d, correct: _e, answer: _f, explanation: _g, ...rest } = q
  return rest
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
