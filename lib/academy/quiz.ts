// lib/academy/quiz.ts
// PURE quiz grading for Academy learning modules. The canonical
// `learning_modules.quiz_questions` jsonb shape is documented in
// scripts/1041-knowledge-growth-router.sql: [{q, choices[], correct_idx, explainer}].
// No DB, no I/O — fully unit-testable; the server action and the reader both grade
// through this single function so the score the learner sees == the score we persist.

/** One authored question on a learning module. */
export interface ModuleQuizQuestion {
  q: string
  choices: string[]
  correct_idx: number
  explainer?: string
}

export interface GradedQuestion {
  index: number
  chosen: number | null
  correct: number
  isCorrect: boolean
  explainer?: string
}

export interface QuizGrade {
  total: number
  correct: number
  /** integer 0–100 (matches onboarding quiz scoring + agent_quiz_attempts) */
  score: number
  passed: boolean
  passingScore: number
  perQuestion: GradedQuestion[]
}

/** Platform-wide passing bar (onboarding_quizzes / training_courses default to 80). */
export const MODULE_QUIZ_PASSING_SCORE = 80

/**
 * Coerce the jsonb `quiz_questions` into a clean, validated question list.
 * Tolerant of nullish / malformed rows: anything without choices + a valid
 * correct_idx is dropped, so a half-authored module never throws at render time.
 */
export function parseQuizQuestions(raw: unknown): ModuleQuizQuestion[] {
  if (!Array.isArray(raw)) return []
  const out: ModuleQuizQuestion[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    const q = typeof r.q === "string" ? r.q : typeof r.question === "string" ? (r.question as string) : null
    const choices = Array.isArray(r.choices)
      ? (r.choices as unknown[]).filter((c): c is string => typeof c === "string")
      : Array.isArray(r.options)
        ? (r.options as unknown[]).filter((c): c is string => typeof c === "string")
        : []
    const correctRaw = r.correct_idx ?? r.correctIndex ?? r.correct
    const correct_idx = typeof correctRaw === "number" ? correctRaw : Number(correctRaw)
    if (!q || choices.length < 2) continue
    if (!Number.isInteger(correct_idx) || correct_idx < 0 || correct_idx >= choices.length) continue
    out.push({
      q,
      choices,
      correct_idx,
      explainer: typeof r.explainer === "string" ? r.explainer : undefined,
    })
  }
  return out
}

/** Does this module carry a gradeable quiz? */
export function hasQuiz(raw: unknown): boolean {
  return parseQuizQuestions(raw).length > 0
}

/**
 * Grade `answers` (questionIndex → chosenChoiceIndex) against the parsed questions.
 * An unanswered or out-of-range answer counts as wrong. A quiz with zero valid
 * questions grades as 0/0 → score 0, not passed (callers gate cert issuance on a
 * real quiz existing).
 */
export function gradeQuiz(
  questions: ModuleQuizQuestion[],
  answers: Record<number, number>,
  passingScore: number = MODULE_QUIZ_PASSING_SCORE,
): QuizGrade {
  const total = questions.length
  const perQuestion: GradedQuestion[] = questions.map((question, index) => {
    const chosenRaw = answers[index]
    const chosen = Number.isInteger(chosenRaw) ? chosenRaw : null
    const isCorrect = chosen === question.correct_idx
    return { index, chosen, correct: question.correct_idx, isCorrect, explainer: question.explainer }
  })
  const correct = perQuestion.filter((p) => p.isCorrect).length
  const score = total === 0 ? 0 : Math.round((correct / total) * 100)
  const passed = total > 0 && score >= passingScore
  return { total, correct, score, passed, passingScore, perQuestion }
}
