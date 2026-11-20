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

  // WAVE 155 (lane 155R19): the attempt (and any step completion it earns) leaves ONE receipt — session user, SESSION tenant.
  const agentId = agentContext.agentId
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const r = await ledgerSessionAction({ brokerageId: agentContext.brokerageId ?? "", action: "onboarding.quiz_attempt.submit", actor: { type: "user", userId: user.id, agentId }, subject: { type: "onboarding_quiz", id: quizId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED" }, async () => submitQuizAttempt({
    userId: user.id,
    agentId,
    quizId,
    answers,
  }))
  if (!("score" in r)) throw new Error(r.error ?? "The quiz attempt was not recorded")
  return r
}
