"use server"

/**
 * app/actions/academy-learning.ts
 *
 * The Academy LEARNER side (the authoring/publishing side lives in
 * app/actions/learning-modules.ts). Closes the gap where published
 * `learning_modules` had no in-app reader, no quiz delivery, and no
 * certification issuance even though the columns existed:
 *
 *   learning_modules.quiz_questions  — the inline quiz (never rendered)
 *   learning_assignments             — per-learner progress (viewed/completed/score)
 *   agent_certifications             — earned on passing a REQUIRED module's quiz
 *
 * Identity is resolved server-side via getAgentContext (never trusts a client id):
 *   learning_assignments.agent_user_id = auth user id (ctx.userId)
 *   agent_certifications.agent_id       = agents.id    (ctx.agentId)
 *
 * Writes use the service client AFTER an in-code authorization check, scoped to
 * the caller's own ids — the same pattern as learning-modules.ts.
 */

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import {
  parseQuizQuestions,
  resolveCoursePassingScore,
  courseQuizReadiness,
  readQuizAttempts,
  learnerQuizFeedback,
  MODULE_QUIZ_ATTEMPTS_PER_DAY,
  type ModuleQuizQuestion,
  type CourseQuizReadiness,
} from "@/lib/academy/quiz"

export interface LearnerModuleView {
  id: string
  title: string
  summary: string | null
  body: string | null
  coverImageUrl: string | null
  estimatedMinutes: number | null
  required: boolean
  /** correct_idx AND the explainer are withheld before an attempt (the explainer is the coaching a FAILED attempt returns). */
  questions: Array<Pick<ModuleQuizQuestion, "q" | "choices">>
  questionCount: number
  passingScore: number
  /** WAVE 155 (155C): quiz_ready · not_completable (a required quiz with no valid question — never an automatic pass) · no_quiz. */
  readiness: CourseQuizReadiness
  attemptsUsedToday: number
  attemptsPerDay: number
  // caller's progress, if any
  status: string | null
  viewedAt: string | null
  completedAt: string | null
  quizScore: number | null
  certified: boolean
}

/**
 * agent_certifications.cert_type admits advanced | compliance | onboarding | specialty (scripts/check-vocabularies.ts). The
 * former value "learning_module" is NOT a member: every module certificate insert was refused by the CHECK and certIssued was
 * always false (wave 155, lane 155C). A passed course's certificate is a "specialty" certificate named by the module title.
 */
const CERT_TYPE = "specialty"

/**
 * A team-authored module (learning_modules.team_id) belongs to that team only — the learning router already filters it with
 * rowInTeamScope (wave 154); the reader and the grader now apply the SAME rule, so a link cannot open another team's course.
 * A team that cannot be resolved sees tenant-wide modules only (fail closed on the team-owned ones).
 */
async function moduleInLearnerScope(
  svc: ReturnType<typeof createServiceClient>,
  ctx: { userId: string | null; agentId: string | null; brokerageId: string | null },
  mod: { brokerage_id?: string | null; team_id?: string | null },
): Promise<boolean> {
  if (mod.brokerage_id && mod.brokerage_id !== ctx.brokerageId) return false
  if (!mod.team_id) return true
  try {
    const { resolveUserTeam, rowInTeamScope } = await import("@/lib/kernel/resolve-user-team")
    const team = ctx.userId ? await resolveUserTeam(svc as never, ctx.userId, ctx.agentId) : { teamId: null }
    return rowInTeamScope(mod.team_id, team.teamId)
  } catch (e) {
    console.error("[academy-learning] team could not be resolved — team-owned module withheld:", e instanceof Error ? e.message : e)
    return false
  }
}

/** Load a published module for the current learner + their own progress row. */
export async function getModuleForLearner(
  moduleId: string,
): Promise<{ ok: true; module: LearnerModuleView } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }

  const svc = createServiceClient()
  const { data: mod, error } = await svc
    .from("learning_modules")
    .select("id, brokerage_id, team_id, title, summary, body, cover_image_url, estimated_minutes, required, status, quiz_questions")
    .eq("id", moduleId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!mod || mod.status !== "published") return { ok: false, error: "Module not found" }
  // Brokerage isolation: platform modules (brokerage_id null) are visible to all; team modules to that team only.
  if (!(await moduleInLearnerScope(svc, ctx, mod))) return { ok: false, error: "Module not found" }

  const questions = parseQuizQuestions(mod.quiz_questions)

  const { data: assignment, error: asgErr } = await svc
    .from("learning_assignments")
    .select("status, viewed_at, completed_at, quiz_score, signal_metadata")
    .eq("module_id", moduleId)
    .eq("agent_user_id", ctx.userId)
    .maybeSingle()
  if (asgErr) return { ok: false, error: `Your progress could not be read: ${asgErr.message}` }
  const since = Date.now() - 24 * 60 * 60 * 1000
  const attemptsUsedToday = readQuizAttempts((assignment as { signal_metadata?: unknown } | null)?.signal_metadata)
    .filter((a) => Date.parse(a.at) > since).length

  let certified = false
  if (ctx.agentId) {
    const { count } = await svc
      .from("agent_certifications")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", ctx.agentId)
      .eq("certification_name", mod.title as string)
      .eq("cert_type", CERT_TYPE)
    certified = (count ?? 0) > 0
  }

  return {
    ok: true,
    module: {
      id: mod.id as string,
      title: mod.title as string,
      summary: (mod.summary as string | null) ?? null,
      body: (mod.body as string | null) ?? null,
      coverImageUrl: (mod.cover_image_url as string | null) ?? null,
      estimatedMinutes: (mod.estimated_minutes as number | null) ?? null,
      required: Boolean(mod.required),
      questions: questions.map(({ q, choices }) => ({ q, choices })),
      questionCount: questions.length,
      passingScore: resolveCoursePassingScore(mod as { passing_score?: unknown }),
      readiness: courseQuizReadiness(mod.required, mod.quiz_questions),
      attemptsUsedToday,
      attemptsPerDay: MODULE_QUIZ_ATTEMPTS_PER_DAY,
      status: (assignment?.status as string | null) ?? null,
      viewedAt: (assignment?.viewed_at as string | null) ?? null,
      completedAt: (assignment?.completed_at as string | null) ?? null,
      quizScore: (assignment?.quiz_score as number | null) ?? null,
      certified,
    },
  }
}

/** Upsert the learner's assignment to 'viewed' and bump the module view counter. Idempotent. */
export async function markModuleViewed(
  moduleId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }

  const svc = createServiceClient()
  const { data: existing } = await svc
    .from("learning_assignments")
    .select("id, status, viewed_at")
    .eq("module_id", moduleId)
    .eq("agent_user_id", ctx.userId)
    .maybeSingle()

  if (!existing) {
    const { error } = await svc.from("learning_assignments").insert({
      brokerage_id: ctx.brokerageId,
      module_id: moduleId,
      agent_user_id: ctx.userId,
      signal_source: "academy_self_serve",
      status: "viewed",
      viewed_at: new Date().toISOString(),
    })
    if (error) return { ok: false, error: error.message }
  } else if (!existing.viewed_at && existing.status !== "completed") {
    await sentinelWrite(svc, svc
      .from("learning_assignments")
      .update({ status: existing.status === "assigned" || !existing.status ? "viewed" : existing.status, viewed_at: new Date().toISOString() })
      .eq("id", existing.id), { table: "learning_assignments", flow: "learning_assignments_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
  }

  // Best-effort view counter (single canonical RPC).
  try { await svc.rpc("increment_learning_module_view", { p_module_id: moduleId }) } catch { /* non-fatal */ }

  return { ok: true }
}

export interface QuizSubmitResult {
  ok: true
  score: number
  passed: boolean
  passingScore: number
  correct: number
  total: number
  certIssued: boolean
  /** WAVE 155 (155C): 1-based attempt number persisted for this learner + module. */
  attemptNumber: number
  /** True only on the call that moved the course to completed (the once-only transition). */
  completedNow: boolean
  /** Attempts left in the rolling 24 hours after this one. */
  attemptsLeftToday: number
  /** FAIL: missed questions + coaching, never the correct choice. PASS: the correct choices revealed. */
  perQuestion: Array<{ index: number; isCorrect: boolean; correct?: number; coaching?: string }>
}

/**
 * THE COURSE COMPLETION CONTRACT (wave 155, lane 155C — owner R1). A course whose quiz is required completes ONLY on a
 * persisted attempt graded HERE by gradeQuiz from the STORED questions and the submitted answers, at the course's resolved
 * threshold. Opening, viewing or narrating never completes it (markModuleViewed writes 'viewed' only). The client supplies
 * answers and nothing else: any `passed`, score or answer key in the payload is dropped by sanitizeQuizAnswers. A pass is a
 * once-only transition (`.neq("status","completed")` + the returned row count) — a later submission never re-grades,
 * re-certifies, re-emits or overwrites it. A FAIL is persisted (signal_metadata.quiz_attempts), returns the missed areas and
 * coaching, and is bounded by MODULE_QUIZ_ATTEMPTS_PER_DAY. On the pass: the certificate row (required courses), the kernel
 * event TRAINING_COURSE_COMPLETED (entity learning_module — the reactor awards TRAINING_COMPLETED only after re-reading this
 * persisted evidence) and the completed_education edge (the competency signal).
 */
export async function submitModuleQuiz(
  moduleId: string,
  answers: Record<number, number>,
): Promise<QuizSubmitResult | { ok: false; error: string; retryAt?: string; alreadyPassed?: boolean }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) return { ok: false, error: "Unauthorized" }

  const svc = createServiceClient()
  const { data: mod, error } = await svc
    .from("learning_modules")
    .select("id, brokerage_id, team_id, title, required, status, quiz_questions")
    .eq("id", moduleId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!mod || mod.status !== "published") return { ok: false, error: "Module not found" }
  if (!(await moduleInLearnerScope(svc, ctx, mod))) return { ok: false, error: "Module not found" }

  // THE ONE RECORDER (lib/academy/course-completion.ts): readiness, retry rule, sanitize → gradeQuiz → persist, once-only pass.
  const { recordCourseAttempt } = await import("@/lib/academy/course-completion")
  const recorded = await recordCourseAttempt(svc, { brokerageId: ctx.brokerageId, userId: ctx.userId, module: mod as { id: string }, answers })
  if (!recorded.ok) return { ok: false, error: recorded.error, retryAt: recorded.retryAt, alreadyPassed: recorded.code === "already_passed" }
  const { grade, attempt, completedNow } = recorded
  const nowIso = attempt.at

  let certIssued = false
  if (completedNow) {
    // RELATIONSHIP GRAPH (wave 105, lane 105D): a PASS is a completed_education fact (agent user → education_module) — the
    // competency signal. Derived after the assignment row landed; never blocks the grade.
    try {
      const { deriveEducationCompletedEdge } = await import("@/lib/kernel/relationship-graph")
      const r = await deriveEducationCompletedEdge(svc, { brokerageId: ctx.brokerageId, learner: { type: "agent", id: ctx.userId as string }, moduleId, source: "academy_quiz_pass", completedAt: nowIso, actorUserId: ctx.userId ?? null })
      if (r.errors.length > 0 && !r.degraded) console.error(`[academy-learning] completed_education edge not derived: ${r.errors.join("; ")}`)
    } catch (e) {
      console.error("[academy-learning] relationship edge derivation failed (non-blocking)", e)
    }

    // Certificate — REQUIRED courses only, once per agent + course name (the row is the certificate record).
    if (mod.required && ctx.agentId) {
      const { count, error: certReadErr } = await svc
        .from("agent_certifications")
        .select("id", { count: "exact", head: true })
        .eq("agent_id", ctx.agentId)
        .eq("certification_name", mod.title as string)
        .eq("cert_type", CERT_TYPE)
      if (certReadErr) console.error(`[academy-learning] certificate read refused — not issued this time: ${certReadErr.message}`)
      else if ((count ?? 0) === 0) {
        const { error: certErr } = await svc.from("agent_certifications").insert({
          agent_id: ctx.agentId,
          brokerage_id: ctx.brokerageId,
          certification_name: mod.title as string,
          cert_type: CERT_TYPE,
          issued_at: nowIso,
          issued_by: ctx.userId,
        })
        if (certErr) console.error(`[academy-learning] certificate NOT issued: ${certErr.message}`)
        certIssued = !certErr
      }
    }

    // THE KERNEL EVENT — one emit (row + reactor fan-out). The reactor's TRAINING_COMPLETED rule re-reads the persisted pass
    // before it awards (lib/gamification/lifecycle-awards.ts courseEvidence), so this event alone earns nothing.
    try {
      const { emitKernelEvent } = await import("@/lib/kernel/emit")
      const { KernelEvent } = await import("@/lib/kernel/events")
      const emitted = await emitKernelEvent({
        brokerageId: ctx.brokerageId,
        event: KernelEvent.TRAINING_COURSE_COMPLETED,
        entityType: "learning_module",
        entityId: moduleId,
        actorUserId: ctx.userId,
        agentUserId: ctx.userId,
        metadata: { agent_id: ctx.agentId, module_id: moduleId, score: grade.score, passing_score: grade.passingScore, attempt: attempt.n, graded_by: "gradeQuiz" },
        dedupeKey: `course-pass-${ctx.userId}-${moduleId}`,
        dedupeWindowSec: 7 * 86_400,
      })
      if (emitted.error) console.error(`[academy-learning] TRAINING_COURSE_COMPLETED not recorded: ${emitted.error}`)
    } catch (e) {
      console.error("[academy-learning] TRAINING_COURSE_COMPLETED emit failed (the completion stands):", e)
    }
  }

  revalidatePath(`/academy/module/${moduleId}`)
  revalidatePath("/academy")
  return {
    ok: true,
    score: grade.score,
    passed: grade.passed,
    passingScore: grade.passingScore,
    correct: grade.correct,
    total: grade.total,
    certIssued,
    attemptNumber: attempt.n,
    completedNow,
    attemptsLeftToday: recorded.attemptsLeftToday,
    perQuestion: learnerQuizFeedback(grade),
  }
}

/** Resolve the signed-in learner's real identity for the Academy client (no client-supplied ids). */
export interface MyLearningProgress {
  completed: Array<{ id: string; title: string; type: string }>
  inProgress: Array<{ id: string; title: string; type: string }>
  /** ADAPTIVE DEVELOPMENT (wave 106, lane 106D) — the signed-in agent's OWN last development cycle
   *  (agent_action_ledger development.competency.update, scoped to the session's agents.id + tenant):
   *  the focus competency and the module the loop queued for it. Null when no cycle ran. */
  development: { focus: string; score: number; moduleTitle: string | null; improved: string[]; cycleAt: string } | null
}

/**
 * The current learner's real progress — learning_assignments joined to their
 * modules. Feeds the Academy "My Progress" panel, which previously rendered
 * hardcoded empty arrays (always 0/0).
 */
export async function getMyLearningProgress(): Promise<MyLearningProgress> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { completed: [], inProgress: [], development: null }

  const svc = createServiceClient()
  const { data } = await svc
    .from("learning_assignments")
    .select("status, module_id, priority_score, learning_modules ( id, title )")
    .eq("agent_user_id", ctx.userId)
    .order("viewed_at", { ascending: false })
    .limit(100)

  // The development loop's last cycle for THIS agent only (session identity, tenant from the session).
  let development: MyLearningProgress["development"] = null
  if (ctx.agentId && ctx.brokerageId) {
    const { data: dev, error: devErr } = await svc
      .from("agent_action_ledger").select("detail, created_at")
      .eq("brokerage_id", ctx.brokerageId).eq("action", "development.competency.update").eq("subject_type", "agent").eq("subject_id", ctx.agentId).eq("status", "executed")
      .order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (devErr) console.error("[academy] development ledger read refused:", devErr.message)
    else if (dev) {
      const { developmentBlock } = await import("@/lib/intelligence/agent-scorecard")
      const { COMPETENCY_LABEL } = await import("@/lib/education/skill-freshness")
      const block = developmentBlock((dev as any).detail, (dev as any).created_at)
      if (block.weakest) {
        const { data: queued } = await svc.from("learning_assignments").select("learning_modules ( title )")
          .eq("agent_user_id", ctx.userId).eq("signal_source", "adaptive_development").in("status", ["open", "viewed"]).order("created_at", { ascending: false }).limit(1).maybeSingle()
        const mod = (queued as any)?.learning_modules
        const label = (COMPETENCY_LABEL as Record<string, string>)[block.weakest.skill] ?? block.weakest.skill
        development = { focus: label, score: block.weakest.score, moduleTitle: (Array.isArray(mod) ? mod[0]?.title : mod?.title) ?? null, improved: block.improvedLastCycle.map((s) => (COMPETENCY_LABEL as Record<string, string>)[s] ?? s), cycleAt: block.cycleAt }
      }
    }
  }

  const completed: MyLearningProgress["completed"] = []
  const inProgressRanked: Array<{ id: string; title: string; type: string; priorityScore: number }> = []
  for (const r of (data ?? []) as any[]) {
    const mod = Array.isArray(r.learning_modules) ? r.learning_modules[0] : r.learning_modules
    if (!mod?.id) continue
    const row = { id: mod.id as string, title: (mod.title as string) ?? "Module", type: "module" }
    if (r.status === "completed") completed.push(row)
    // 'dismissed' deliberately excluded — a learner who dismissed an assignment
    // asked it OFF their "Continue Learning" list, not to see it forever.
    else if (r.status === "viewed" || r.status === "assigned") {
      inProgressRanked.push({ ...row, priorityScore: Number(r.priority_score ?? 0) })
    }
  }
  // Highest priority_score first — the "Continue Learning" strip only shows the
  // top 3 (training-progress-panel.tsx), so which 3 THAT is depends on this.
  inProgressRanked.sort((a, b) => b.priorityScore - a.priorityScore)
  const inProgress: MyLearningProgress["inProgress"] = inProgressRanked.map(({ priorityScore, ...row }) => row)
  return { completed, inProgress, development }
}

/**
 * Dismiss an assigned-but-unwanted module — the "not now" the learner never had
 * (status='dismissed' + dismissed_at is a CHECK-valid pair that nothing wrote
 * before this: only the retake reset in onboarding/progress.ts CLEARED the
 * field, and getMyLearningProgress above is the reader that now honors it).
 * Never dismisses a REQUIRED module — those stay on the list until completed.
 */
export async function dismissLearningAssignmentAction(
  moduleId: string,
): Promise<{ success: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId) return { success: false, error: "Not authenticated" }

  // WAVE 155 (155R17): the receipt — the SESSION's user and tenant; an account with no tenant runs unreceipted (no valid row).
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const run = async (): Promise<{ success: boolean; error?: string }> => {
  const svc = createServiceClient()
  const { data: mod } = await svc
    .from("learning_modules")
    .select("id, required")
    .eq("id", moduleId)
    .maybeSingle()
  if ((mod as { required?: boolean } | null)?.required) {
    return { success: false, error: "Required modules can't be dismissed" }
  }

  const { data, error } = await svc
    .from("learning_assignments")
    .update({ status: "dismissed", dismissed_at: new Date().toISOString() })
    .eq("agent_user_id", ctx.userId)
    .eq("module_id", moduleId)
    // 'assigned' is NOT a member of learning_assignments_status_check (live
    // vocabulary: completed | dismissed | open | superseded | viewed) — only
    // 'open' and 'viewed' name an active, not-yet-resolved row.
    .in("status", ["open", "viewed"])
    .select("id")

  if (error) return { success: false, error: error.message }
  if (!data || data.length === 0) return { success: false, error: "Assignment not found or already resolved" }

  revalidatePath("/academy")
  return { success: true }
  }
  return ctx.brokerageId ? ledgerSessionAction({ brokerageId: ctx.brokerageId, action: "academy.learning_assignment.dismiss", actor: { type: "user", userId: ctx.userId, agentId: ctx.agentId ?? null }, subject: { type: "learning_module", id: moduleId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED" }, run) : run()
}

export async function getAcademyViewer(): Promise<
  { agentId: string; brokerageId: string; agentName: string } | null
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return null
  const supabase = await createClient()
  const { data } = await supabase
    .from("users")
    .select("first_name, last_name")
    .eq("id", ctx.userId)
    .maybeSingle()
  const agentName = [data?.first_name, data?.last_name].filter(Boolean).join(" ") || "Agent"
  return { agentId: ctx.agentId ?? "", brokerageId: ctx.brokerageId, agentName }
}

/** The single highest-priority published module — powers the Academy "Featured" card (real, not mock). */
export async function getFeaturedModule(): Promise<
  { id: string; title: string; summary: string | null; estimatedMinutes: number | null; hasQuiz: boolean } | null
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return null
  const supabase = await createClient()
  const { data } = await supabase
    .from("learning_modules")
    .select("id, title, summary, estimated_minutes, quiz_questions")
    .eq("status", "published")
    .order("display_priority", { ascending: false })
    .order("view_count", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!data) return null
  return {
    id: data.id as string,
    title: data.title as string,
    summary: (data.summary as string | null) ?? null,
    estimatedMinutes: (data.estimated_minutes as number | null) ?? null,
    hasQuiz: parseQuizQuestions(data.quiz_questions).length > 0,
  }
}
