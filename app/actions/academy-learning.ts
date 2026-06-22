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

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import {
  gradeQuiz,
  parseQuizQuestions,
  MODULE_QUIZ_PASSING_SCORE,
  type ModuleQuizQuestion,
} from "@/lib/academy/quiz"

export interface LearnerModuleView {
  id: string
  title: string
  summary: string | null
  body: string | null
  coverImageUrl: string | null
  estimatedMinutes: number | null
  required: boolean
  questions: Array<Omit<ModuleQuizQuestion, "correct_idx">> // correct_idx withheld from the client
  questionCount: number
  passingScore: number
  // caller's progress, if any
  status: string | null
  viewedAt: string | null
  completedAt: string | null
  quizScore: number | null
  certified: boolean
}

const CERT_TYPE = "learning_module"

/** Load a published module for the current learner + their own progress row. */
export async function getModuleForLearner(
  moduleId: string,
): Promise<{ ok: true; module: LearnerModuleView } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }

  const svc = createServiceClient()
  const { data: mod, error } = await svc
    .from("learning_modules")
    .select("id, brokerage_id, title, summary, body, cover_image_url, estimated_minutes, required, status, quiz_questions")
    .eq("id", moduleId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!mod || mod.status !== "published") return { ok: false, error: "Module not found" }
  // Brokerage isolation: platform modules (brokerage_id null) are visible to all.
  if (mod.brokerage_id && mod.brokerage_id !== ctx.brokerageId) return { ok: false, error: "Module not found" }

  const questions = parseQuizQuestions(mod.quiz_questions)

  const { data: assignment } = await svc
    .from("learning_assignments")
    .select("status, viewed_at, completed_at, quiz_score")
    .eq("module_id", moduleId)
    .eq("agent_user_id", ctx.userId)
    .maybeSingle()

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
      questions: questions.map(({ q, choices, explainer }) => ({ q, choices, explainer })),
      questionCount: questions.length,
      passingScore: MODULE_QUIZ_PASSING_SCORE,
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
    await svc
      .from("learning_assignments")
      .update({ status: existing.status === "assigned" || !existing.status ? "viewed" : existing.status, viewed_at: new Date().toISOString() })
      .eq("id", existing.id)
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
  perQuestion: Array<{ index: number; correct: number; isCorrect: boolean; explainer?: string }>
}

/**
 * Grade the learner's answers against the authoritative server-side
 * quiz_questions (the client never receives correct_idx), persist the result to
 * learning_assignments, and — on a pass of a REQUIRED module — issue an
 * agent_certifications row (idempotent per agent+module).
 */
export async function submitModuleQuiz(
  moduleId: string,
  answers: Record<number, number>,
): Promise<QuizSubmitResult | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }

  const svc = createServiceClient()
  const { data: mod, error } = await svc
    .from("learning_modules")
    .select("id, brokerage_id, title, required, status, quiz_questions")
    .eq("id", moduleId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!mod || mod.status !== "published") return { ok: false, error: "Module not found" }
  if (mod.brokerage_id && mod.brokerage_id !== ctx.brokerageId) return { ok: false, error: "Module not found" }

  const questions = parseQuizQuestions(mod.quiz_questions)
  if (questions.length === 0) return { ok: false, error: "This module has no quiz" }

  const grade = gradeQuiz(questions, answers)

  // Persist progress (update-or-insert; no reliance on a unique constraint).
  const nowIso = new Date().toISOString()
  const progress = {
    status: grade.passed ? "completed" : "viewed",
    quiz_score: grade.score,
    completed_at: grade.passed ? nowIso : null,
    viewed_at: nowIso,
  }
  const { data: existing } = await svc
    .from("learning_assignments")
    .select("id, viewed_at")
    .eq("module_id", moduleId)
    .eq("agent_user_id", ctx.userId)
    .maybeSingle()
  if (existing) {
    await svc
      .from("learning_assignments")
      .update({ ...progress, viewed_at: existing.viewed_at ?? nowIso })
      .eq("id", existing.id)
  } else {
    await svc.from("learning_assignments").insert({
      brokerage_id: ctx.brokerageId,
      module_id: moduleId,
      agent_user_id: ctx.userId,
      signal_source: "academy_self_serve",
      ...progress,
    })
  }

  // Certification — only for REQUIRED modules, only on a pass, idempotent.
  let certIssued = false
  if (grade.passed && mod.required && ctx.agentId) {
    const { count } = await svc
      .from("agent_certifications")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", ctx.agentId)
      .eq("certification_name", mod.title as string)
      .eq("cert_type", CERT_TYPE)
    if ((count ?? 0) === 0) {
      const { error: certErr } = await svc.from("agent_certifications").insert({
        agent_id: ctx.agentId,
        brokerage_id: ctx.brokerageId,
        certification_name: mod.title as string,
        cert_type: CERT_TYPE,
        issued_at: nowIso,
        issued_by: ctx.userId,
      })
      certIssued = !certErr
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
    perQuestion: grade.perQuestion.map(({ index, correct, isCorrect, explainer }) => ({ index, correct, isCorrect, explainer })),
  }
}

/** Resolve the signed-in learner's real identity for the Academy client (no client-supplied ids). */
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
