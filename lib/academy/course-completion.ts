// lib/academy/course-completion.ts
// ─────────────────────────────────────────────────────────────────────────────
// WAVE 155 (lane 155C — owner R1: "course needs to complete with quiz with acceptable passing %").
//
// THE ONE COURSE-ATTEMPT RECORDER. Grades a learner's answers through the canonical gradeQuiz (lib/academy/quiz.ts) from the
// STORED questions, at the course's resolved threshold, persists the attempt on the learner's learning_assignments row
// (signal_metadata.quiz_attempts) and — on a pass — moves the row to completed EXACTLY ONCE. The caller
// (app/actions/academy-learning.ts submitModuleQuiz) resolves the session, the tenant and the course scope first, then hands
// its service client here; certificate, competency edge and kernel event follow only when `completedNow` is true.
// Injected client, no session, no server-only import: scripts/course-completion-guard.ts executes this exact code.

import {
  gradeQuiz,
  parseQuizQuestions,
  resolveCoursePassingScore,
  courseQuizReadiness,
  sanitizeQuizAnswers,
  readQuizAttempts,
  quizRetryVerdict,
  withQuizAttempt,
  COURSE_NOT_COMPLETABLE_MESSAGE,
  MODULE_QUIZ_ATTEMPTS_PER_DAY,
  MODULE_QUIZ_ATTEMPT_WINDOW_MS,
  type QuizGrade,
  type StoredQuizAttempt,
} from "./quiz"

/** The slice of a supabase client this needs (the service client satisfies it; the proof passes an in-memory one). */
export interface CourseAttemptClient {
  from: (table: string) => any
}

export interface CourseAttemptInput {
  brokerageId: string
  /** learning_assignments.agent_user_id is a users.id (CLAUDE.md §3 — never an agents.id). */
  userId: string
  module: { id: string; required?: unknown; quiz_questions?: unknown; passing_score?: unknown }
  /** Whatever the client sent. Only integer question → integer choice pairs survive sanitizeQuizAnswers. */
  answers: unknown
  now?: Date
}

export type CourseAttemptResult =
  | { ok: true; grade: QuizGrade; attempt: StoredQuizAttempt; completedNow: boolean; attemptsLeftToday: number }
  | { ok: false; error: string; code: "not_completable" | "no_quiz" | "already_passed" | "retry_limited" | "read_refused" | "write_refused"; retryAt?: string }

export async function recordCourseAttempt(db: CourseAttemptClient, input: CourseAttemptInput): Promise<CourseAttemptResult> {
  const readiness = courseQuizReadiness(input.module.required, input.module.quiz_questions)
  if (readiness === "not_completable") return { ok: false, code: "not_completable", error: COURSE_NOT_COMPLETABLE_MESSAGE }
  const questions = parseQuizQuestions(input.module.quiz_questions)
  if (questions.length === 0) return { ok: false, code: "no_quiz", error: "This module has no quiz" }

  const { data: existing, error: readErr } = await db.from("learning_assignments")
    .select("id, status, viewed_at, signal_metadata")
    .eq("module_id", input.module.id).eq("agent_user_id", input.userId).maybeSingle()
  // Fail closed: an unreadable progress row cannot be told apart from "never attempted" — grading on it could re-issue a pass.
  if (readErr) return { ok: false, code: "read_refused", error: `Your progress could not be read, so this attempt was not graded: ${readErr.message}` }
  const row = existing as { id: string; status: string | null; viewed_at: string | null; signal_metadata: unknown } | null
  if (row?.status === "completed") return { ok: false, code: "already_passed", error: "You already passed this course. A completed course is not re-graded." }

  const now = input.now ?? new Date()
  const prior = readQuizAttempts(row?.signal_metadata)
  const retry = quizRetryVerdict(prior, now)
  if (!retry.allowed) {
    return { ok: false, code: "retry_limited", retryAt: retry.retryAt,
      error: `You have used today's ${MODULE_QUIZ_ATTEMPTS_PER_DAY} attempts. Review the lesson and the tips on the questions you missed; your next attempt opens ${retry.retryAt}.` }
  }

  const clean = sanitizeQuizAnswers(input.answers, questions.length)
  const grade = gradeQuiz(questions, clean, resolveCoursePassingScore(input.module))
  const nowIso = now.toISOString()
  const { metadata, attempt } = withQuizAttempt(row?.signal_metadata, grade, clean, now)

  if (row) {
    const update: Record<string, unknown> = { signal_metadata: metadata, quiz_score: grade.score, viewed_at: row.viewed_at ?? nowIso }
    if (grade.passed) Object.assign(update, { status: "completed", completed_at: nowIso })
    else if (!row.status || row.status === "open") update.status = "viewed"
    // `.neq("status","completed")` + the returned rows = the once-only transition: a concurrent twin that already completed
    // the row makes this update match nothing, and nothing downstream (certificate, event, points) runs twice.
    const { data: upd, error: updErr } = await db.from("learning_assignments").update(update)
      .eq("id", row.id).neq("status", "completed").select("id")
    if (updErr) return { ok: false, code: "write_refused", error: `Your attempt could not be saved, so it was not counted: ${updErr.message}` }
    if ((upd ?? []).length === 0) return { ok: false, code: "already_passed", error: "You already passed this course. A completed course is not re-graded." }
  } else {
    const { error: insErr } = await db.from("learning_assignments").insert({
      brokerage_id: input.brokerageId,
      module_id: input.module.id,
      agent_user_id: input.userId,
      signal_source: "academy_self_serve",
      status: grade.passed ? "completed" : "viewed",
      quiz_score: grade.score,
      completed_at: grade.passed ? nowIso : null,
      viewed_at: nowIso,
      signal_metadata: metadata,
    })
    // 23505 on (agent_user_id, module_id): a racing twin inserted first — this attempt is not counted; the learner retries.
    if (insErr) return { ok: false, code: "write_refused", error: `Your attempt could not be saved, so it was not counted: ${insErr.message}` }
  }

  const usedToday = prior.filter((a) => Date.parse(a.at) > now.getTime() - MODULE_QUIZ_ATTEMPT_WINDOW_MS).length + 1
  return { ok: true, grade, attempt, completedNow: grade.passed, attemptsLeftToday: Math.max(0, MODULE_QUIZ_ATTEMPTS_PER_DAY - usedToday) }
}
