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

// ─── WAVE 155 (lane 155C — owner R1: "course needs to complete with quiz with acceptable passing %") ─────────────────
// The COURSE COMPLETION CONTRACT, pure. One threshold resolver, one readiness verdict, one answer sanitizer, one bounded
// retry rule and one attempt ledger shape — read by the learner action (app/actions/academy-learning.ts), the award
// evidence check (lib/gamification/lifecycle-awards.ts) and the onboarding certification gate, so the number the learner
// is shown, the number that is persisted and the number that earns are the same number.

/**
 * The course's OWN passing percentage where the row carries one (onboarding_quizzes.passing_score is such a field), else the
 * canonical MODULE_QUIZ_PASSING_SCORE. learning_modules has NO passing-score column (scripts/schema-snapshot.ts), so every
 * module resolves to 80 — no per-module override is invented (owner decision, see lane 155C notes). An out-of-range value
 * (≤ 0, > 100, non-integer) is not a rule: it falls back to the canonical bar rather than making a quiz pass on nothing.
 */
export function resolveCoursePassingScore(row: { passing_score?: unknown } | null | undefined): number {
  const v = Number(row?.passing_score)
  return Number.isInteger(v) && v >= 1 && v <= 100 ? v : MODULE_QUIZ_PASSING_SCORE
}

/**
 * Does completing this course REQUIRE a passed quiz, and can it be completed at all?
 *   quiz_ready       — valid questions exist: completion = a persisted passing attempt.
 *   not_completable  — the course requires a quiz (it is REQUIRED, or quiz rows were authored) but NO question is valid. Never
 *                      an automatic pass: the learner is told it cannot be completed yet and the author is refused publication.
 *   no_quiz          — an optional reading module with no quiz: viewing it is reading, never a completion.
 */
export type CourseQuizReadiness = "quiz_ready" | "not_completable" | "no_quiz"
export function courseQuizReadiness(required: unknown, rawQuestions: unknown): CourseQuizReadiness {
  if (parseQuizQuestions(rawQuestions).length > 0) return "quiz_ready"
  const authored = Array.isArray(rawQuestions) && rawQuestions.length > 0
  return required === true || authored ? "not_completable" : "no_quiz"
}

/** The learner-facing sentence for a course that cannot be completed yet (also the author's refusal). */
export const COURSE_NOT_COMPLETABLE_MESSAGE =
  "This course requires a quiz, but it has no valid questions yet, so it cannot be completed. Its author needs to add at least one question with two or more choices and a correct answer."

/**
 * Only integer question indexes 0..n-1 mapped to integer choice indexes survive. Everything else a client sends — `passed`,
 * `score`, `correct`, an answer key, a string index — is dropped before grading, so a forged payload grades exactly like the
 * honest answers it contains.
 */
export function sanitizeQuizAnswers(raw: unknown, questionCount: number): Record<number, number> {
  const out: Record<number, number> = {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(k)) continue
    const idx = Number(k)
    if (idx >= questionCount) continue
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) out[idx] = v
  }
  return out
}

/**
 * THE RETRY RULE. No retry rule existed for learning modules (onboarding quizzes allow unlimited attempts), and a failed attempt
 * tells the learner WHICH questions they missed — with unlimited instant retries that is an answer-key oracle (four choices ×
 * n questions are enumerable in a few dozen submissions). Three attempts per rolling 24 hours keeps a genuine retake easy
 * (fail, review the coaching, retry the same day) and makes enumeration take days. The correct choice itself is never sent
 * before a pass.
 */
export const MODULE_QUIZ_ATTEMPTS_PER_DAY = 3
export const MODULE_QUIZ_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000
/** Attempts kept on the assignment row (learning_assignments.signal_metadata.quiz_attempts) — bounded so the jsonb cannot grow forever. */
export const MODULE_QUIZ_ATTEMPT_HISTORY = 20

export interface StoredQuizAttempt {
  n: number
  at: string
  score: number
  passed: boolean
  passing_score: number
  answers: Record<number, number>
}

/** The persisted attempts on an assignment row's signal_metadata (tolerant of absent / malformed history). */
export function readQuizAttempts(signalMetadata: unknown): StoredQuizAttempt[] {
  const list = (signalMetadata as { quiz_attempts?: unknown } | null | undefined)?.quiz_attempts
  if (!Array.isArray(list)) return []
  return list.filter((a): a is StoredQuizAttempt =>
    !!a && typeof a === "object" && Number.isInteger((a as StoredQuizAttempt).n) && typeof (a as StoredQuizAttempt).at === "string" &&
    typeof (a as StoredQuizAttempt).score === "number" && typeof (a as StoredQuizAttempt).passed === "boolean")
}

/** Retry gate: may this learner submit another attempt now? `retryAt` is when the oldest attempt in the window ages out. */
export function quizRetryVerdict(attempts: StoredQuizAttempt[], now: Date): { allowed: true } | { allowed: false; retryAt: string } {
  const since = now.getTime() - MODULE_QUIZ_ATTEMPT_WINDOW_MS
  const recent = attempts.map((a) => Date.parse(a.at)).filter((t) => Number.isFinite(t) && t > since).sort((a, b) => a - b)
  if (recent.length < MODULE_QUIZ_ATTEMPTS_PER_DAY) return { allowed: true }
  return { allowed: false, retryAt: new Date(recent[recent.length - MODULE_QUIZ_ATTEMPTS_PER_DAY] + MODULE_QUIZ_ATTEMPT_WINDOW_MS).toISOString() }
}

/** signal_metadata with one more attempt appended (bounded), every other key the row already carried kept. */
export function withQuizAttempt(signalMetadata: unknown, grade: QuizGrade, answers: Record<number, number>, now: Date): { metadata: Record<string, unknown>; attempt: StoredQuizAttempt } {
  const base = signalMetadata && typeof signalMetadata === "object" && !Array.isArray(signalMetadata) ? { ...(signalMetadata as Record<string, unknown>) } : {}
  const prior = readQuizAttempts(base)
  const attempt: StoredQuizAttempt = {
    n: (prior.reduce((m, a) => Math.max(m, a.n), 0)) + 1,
    at: now.toISOString(), score: grade.score, passed: grade.passed, passing_score: grade.passingScore, answers,
  }
  return { metadata: { ...base, quiz_attempts: [...prior, attempt].slice(-MODULE_QUIZ_ATTEMPT_HISTORY) }, attempt }
}

/**
 * The evidence a completion stands on: a persisted attempt that passed AND whose stored score meets the threshold resolved NOW
 * (a stored `passed: true` with a score under the bar is not accepted — the flag is never trusted alone).
 */
export function qualifyingPassedAttempt(attempts: StoredQuizAttempt[], passingScore: number): StoredQuizAttempt | null {
  return attempts.find((a) => a.passed && a.score >= passingScore) ?? null
}

/**
 * What the learner is shown after grading. A FAIL names the missed questions and their coaching (the authored explainer) but
 * never the correct choice — the retry would otherwise be a copy. A PASS reveals the correct choices.
 */
export function learnerQuizFeedback(grade: QuizGrade): Array<{ index: number; isCorrect: boolean; correct?: number; coaching?: string }> {
  return grade.perQuestion.map((p) => grade.passed
    ? { index: p.index, isCorrect: p.isCorrect, correct: p.correct, coaching: p.explainer }
    : { index: p.index, isCorrect: p.isCorrect, coaching: p.isCorrect ? undefined : p.explainer })
}
