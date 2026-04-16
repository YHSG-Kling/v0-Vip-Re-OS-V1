// lib/kernel/agent-onboarding.ts
// Kernel module for agent onboarding dashboard, step completion, and step management.
// No UI code. No any types. No default exports.
// Access gate: agents can only access their own onboarding;
// admin/broker/superadmin can access any agent within their brokerage.

import { createClient } from "@/lib/supabase/server"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type OnboardingStatus = "in_progress" | "completed" | "paused"

export type OnboardingStepRow = {
  id: string
  brokerage_id: string | null
  day_number: number
  step_order: number
  step_key: string
  step_name: string
  category: "system_setup" | "training" | "practice" | "compliance" | "certification"
  required: boolean
  estimated_minutes: number | null
  video_url: string | null
  instructions: string | null
  success_criteria: Record<string, unknown> | null
}

export type AgentOnboardingRow = {
  id: string
  brokerage_id: string
  agent_id: string
  start_date: string
  current_day: number
  status: OnboardingStatus
  completion_percentage: number
  certification_achieved: boolean
  certified_at: string | null
}

export type StepCompletionRow = {
  id: string
  brokerage_id: string
  agent_id: string
  step_id: string
  completed: boolean
  completed_at: string | null
  time_spent_minutes: number | null
  quiz_score: number | null
  notes: string | null
}

// ─── INTERNAL HELPERS ─────────────────────────────────────────────────────────

async function requireUserContext(
  userId: string
): Promise<{ brokerageId: string; userType: string }> {
  const supabase = await createClient()
  const { data: user, error } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", userId)
    .single()

  if (error || !user) throw new Error("User not found")
  return { brokerageId: user.brokerage_id, userType: user.user_type }
}

async function assertCanAccessAgent(params: {
  userId: string
  agentId: string
}): Promise<{ brokerageId: string }> {
  const { brokerageId, userType } = await requireUserContext(params.userId)
  if (userType === "agent") {
    const supabase = await createClient()
    const { data: agent, error } = await supabase
      .from("agents")
      .select("user_id")
      .eq("id", params.agentId)
      .single()

    if (error || !agent) throw new Error("Agent not found")
    if (agent.user_id !== params.userId) {
      throw new Error("Forbidden: cannot access other agents' onboarding")
    }
  } else if (!["admin", "broker", "superadmin"].includes(userType)) {
    throw new Error("Forbidden: insufficient permissions")
  }
  return { brokerageId }
}

function resolveSteps(params: {
  globalSteps: OnboardingStepRow[]
  brokerageSteps: OnboardingStepRow[]
}): OnboardingStepRow[] {
  const stepMap = new Map<string, OnboardingStepRow>()

  for (const s of params.globalSteps) {
    stepMap.set(`${s.day_number}-${s.step_order}-${s.step_key}`, s)
  }
  for (const s of params.brokerageSteps) {
    stepMap.set(`${s.day_number}-${s.step_order}-${s.step_key}`, s)
  }

  return Array.from(stepMap.values()).sort((a, b) => {
    if (a.day_number !== b.day_number) return a.day_number - b.day_number
    return a.step_order - b.step_order
  })
}

function computeProgress(params: {
  steps: OnboardingStepRow[]
  completions: StepCompletionRow[]
}): { completionPercentage: number; nextCurrentDay: number } {
  const requiredSteps = params.steps.filter(s => s.required)
  const completedSet = new Set(
    params.completions.filter(c => c.completed).map(c => c.step_id)
  )

  const completedRequired = requiredSteps.filter(s => completedSet.has(s.id)).length
  const totalRequired = requiredSteps.length

  const completionPercentage =
    totalRequired > 0
      ? Math.round((completedRequired / totalRequired) * 100)
      : 0

  // current_day = first day that still has an incomplete required step
  for (let day = 1; day <= 7; day++) {
    const requiredForDay = requiredSteps.filter(s => s.day_number === day)
    const allDone = requiredForDay.every(s => completedSet.has(s.id))
    if (!allDone) return { completionPercentage, nextCurrentDay: day }
  }

  return { completionPercentage, nextCurrentDay: 7 }
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

export async function getAgentOnboardingDashboard(params: {
  userId: string
  agentId: string
}): Promise<{
  onboarding: AgentOnboardingRow
  steps: OnboardingStepRow[]
  completions: StepCompletionRow[]
}> {
  const supabase = await createClient()
  const { brokerageId, userType } = await requireUserContext(params.userId)

  await assertCanAccessAgent({
    userId: params.userId,
    agentId: params.agentId,
  })

  // Ensure onboarding row exists
  let { data: onboarding, error: fetchError } = await supabase
    .from("agent_onboarding")
    .select("*")
    .eq("agent_id", params.agentId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (fetchError || !onboarding) {
    const { error: insertError } = await supabase.from("agent_onboarding").insert({
      brokerage_id: brokerageId,
      agent_id: params.agentId,
      start_date: new Date().toISOString().split("T")[0],
      current_day: 1,
      status: "in_progress",
      completion_percentage: 0,
      certification_achieved: false,
      certified_at: null,
    })

    if (insertError) {
      throw new Error(`Failed to create onboarding record: ${insertError.message}`)
    }

    const { data: refetched, error: refetchError } = await supabase
      .from("agent_onboarding")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("brokerage_id", brokerageId)
      .single()

    if (refetchError || !refetched) {
      throw new Error("Failed to load onboarding record after insert")
    }

    onboarding = refetched
  }

  // Load global steps (brokerage_id is null)
  const { data: globalSteps, error: globalError } = await supabase
    .from("onboarding_steps")
    .select("*")
    .is("brokerage_id", null)

  if (globalError) throw new Error(`Failed to load global onboarding steps: ${globalError.message}`)

  // Load brokerage-specific steps
  const { data: brokerageSteps, error: brokerageError } = await supabase
    .from("onboarding_steps")
    .select("*")
    .eq("brokerage_id", brokerageId)

  if (brokerageError) throw new Error(`Failed to load brokerage onboarding steps: ${brokerageError.message}`)

  const steps = resolveSteps({
    globalSteps: (globalSteps ?? []) as OnboardingStepRow[],
    brokerageSteps: (brokerageSteps ?? []) as OnboardingStepRow[],
  })

  // Load completions for this agent
  const { data: completions, error: completionsError } = await supabase
    .from("agent_step_completions")
    .select("*")
    .eq("agent_id", params.agentId)
    .eq("brokerage_id", brokerageId)

  if (completionsError) throw new Error(`Failed to load step completions: ${completionsError.message}`)

  return {
    onboarding: onboarding as AgentOnboardingRow,
    steps,
    completions: (completions ?? []) as StepCompletionRow[],
  }
}

export async function completeAISessionStep(params: {
  userId: string
  agentId: string
  stepId: string
  data?: {
    timeSpentMinutes?: number
    quizScore?: number
    notes?: string
  }
}): Promise<void> {
  const supabase = await createClient()
  const { brokerageId, userType } = await requireUserContext(params.userId)

  await assertCanAccessAgent({
    userId: params.userId,
    agentId: params.agentId,
  })

  const now = new Date().toISOString()

  const { error: upsertError } = await supabase
    .from("agent_step_completions")
    .upsert(
      {
        brokerage_id: brokerageId,
        agent_id: params.agentId,
        step_id: params.stepId,
        completed: true,
        completed_at: now,
        updated_at: now,
        ...(params.data?.timeSpentMinutes !== undefined && {
          time_spent_minutes: params.data.timeSpentMinutes,
        }),
        ...(params.data?.quizScore !== undefined && {
          quiz_score: params.data.quizScore,
        }),
        ...(params.data?.notes !== undefined && {
          notes: params.data.notes,
        }),
      },
      { onConflict: "agent_id,step_id" }
    )

  if (upsertError) {
    throw new Error(`Failed to record step completion: ${upsertError.message}`)
  }

  // Recompute progress
  const { onboarding, steps, completions } = await getAgentOnboardingDashboard({
    userId: params.userId,
    agentId: params.agentId,
  })

  const { completionPercentage, nextCurrentDay } = computeProgress({ steps, completions })

  const isComplete = completionPercentage === 100

  const { error: updateError } = await supabase
    .from("agent_onboarding")
    .update({
      completion_percentage: completionPercentage,
      current_day: nextCurrentDay,
      status: isComplete ? "completed" : "in_progress",
      certification_achieved: isComplete,
      certified_at: isComplete ? now : null,
      updated_at: now,
    })
    .eq("id", onboarding.id)
    .eq("brokerage_id", brokerageId)

  if (updateError) {
    throw new Error(`Failed to update onboarding progress: ${updateError.message}`)
  }
}

export async function createOnboardingStepForBrokerage(params: {
  userId: string
  step: {
    day_number: number
    step_order: number
    step_key: string
    step_name: string
    category: OnboardingStepRow["category"]
    required: boolean
    estimated_minutes?: number | null
    video_url?: string | null
    instructions?: string | null
  }
}): Promise<{ id: string }> {
  const { brokerageId, userType } = await requireUserContext(params.userId)

  if (!["admin", "broker", "superadmin"].includes(userType)) {
    throw new Error("Forbidden: insufficient permissions to create onboarding steps")
  }

  const supabase = await createClient()

  const { data: inserted, error } = await supabase
    .from("onboarding_steps")
    .insert({
      brokerage_id: brokerageId,
      day_number: params.step.day_number,
      step_order: params.step.step_order,
      step_key: params.step.step_key,
      step_name: params.step.step_name,
      category: params.step.category,
      required: params.step.required,
      estimated_minutes: params.step.estimated_minutes ?? null,
      video_url: params.step.video_url ?? null,
      instructions: params.step.instructions ?? null,
    })
    .select("id")
    .single()

  if (error) throw new Error(`Failed to create onboarding step: ${error.message}`)
  if (!inserted) throw new Error("Failed to create onboarding step: no row returned")

  return { id: inserted.id }
}

export async function updateOnboardingStepForBrokerage(params: {
  userId: string
  stepId: string
  updates: Partial<
    Pick<
      OnboardingStepRow,
      | "day_number"
      | "step_order"
      | "step_key"
      | "step_name"
      | "category"
      | "required"
      | "estimated_minutes"
      | "video_url"
      | "instructions"
    >
  >
}): Promise<void> {
  const { brokerageId, userType } = await requireUserContext(params.userId)

  if (!["admin", "broker", "superadmin"].includes(userType)) {
    throw new Error("Forbidden: insufficient permissions to update onboarding steps")
  }

  const supabase = await createClient()

  // Verify the step belongs to this brokerage (never allow editing global steps where brokerage_id is null)
  const { data: existing, error: fetchError } = await supabase
    .from("onboarding_steps")
    .select("id, brokerage_id")
    .eq("id", params.stepId)
    .single()

  if (fetchError || !existing) throw new Error("Onboarding step not found")
  if (existing.brokerage_id === null) {
    throw new Error("Forbidden: cannot modify global onboarding steps")
  }
  if (existing.brokerage_id !== brokerageId) {
    throw new Error("Forbidden: step does not belong to your brokerage")
  }

  const { error } = await supabase
    .from("onboarding_steps")
    .update(params.updates)
    .eq("id", params.stepId)
    .eq("brokerage_id", brokerageId)

  if (error) throw new Error(`Failed to update onboarding step: ${error.message}`)
}

export async function deleteOnboardingStepForBrokerage(params: {
  userId: string
  stepId: string
}): Promise<void> {
  const { brokerageId, userType } = await requireUserContext(params.userId)

  if (!["admin", "broker", "superadmin"].includes(userType)) {
    throw new Error("Forbidden: insufficient permissions to delete onboarding steps")
  }

  const supabase = await createClient()

  // Verify the step belongs to this brokerage (never allow deleting global steps)
  const { data: existing, error: fetchError } = await supabase
    .from("onboarding_steps")
    .select("id, brokerage_id")
    .eq("id", params.stepId)
    .single()

  if (fetchError || !existing) throw new Error("Onboarding step not found")
  if (existing.brokerage_id === null) {
    throw new Error("Forbidden: cannot delete global onboarding steps")
  }
  if (existing.brokerage_id !== brokerageId) {
    throw new Error("Forbidden: step does not belong to your brokerage")
  }

  const { error } = await supabase
    .from("onboarding_steps")
    .delete()
    .eq("id", params.stepId)
    .eq("brokerage_id", brokerageId)

  if (error) throw new Error(`Failed to delete onboarding step: ${error.message}`)
}

export async function listOnboardingSteps(params: {
  userId: string
}): Promise<OnboardingStepRow[]> {
  const { brokerageId, userType } = await requireUserContext(params.userId)

  if (!["admin", "broker", "superadmin"].includes(userType)) {
    throw new Error("Forbidden: insufficient permissions to list onboarding steps")
  }

  const supabase = await createClient()

  const { data: globalSteps, error: globalError } = await supabase
    .from("onboarding_steps")
    .select("*")
    .is("brokerage_id", null)

  if (globalError) throw new Error(`Failed to load global onboarding steps: ${globalError.message}`)

  const { data: brokerageSteps, error: brokerageError } = await supabase
    .from("onboarding_steps")
    .select("*")
    .eq("brokerage_id", brokerageId)

  if (brokerageError) throw new Error(`Failed to load brokerage onboarding steps: ${brokerageError.message}`)

  return resolveSteps({
    globalSteps: (globalSteps ?? []) as OnboardingStepRow[],
    brokerageSteps: (brokerageSteps ?? []) as OnboardingStepRow[],
  })
}

// ─── QUIZ TYPES ────────────────────────────────────────────────────────────────

type QuizQuestion = {
  id: string
  correctAnswer: unknown
  [key: string]: unknown
}

type QuizRow = {
  id: string
  step_id: string
  quiz_name: string
  passing_score: number
  questions: QuizQuestion[]
}

// ─── QUIZ FUNCTIONS ────────────────────────────────────────────────────────────

export async function getQuizForStep(params: {
  userId: string
  agentId: string
  stepId: string
}): Promise<{
  quizId: string
  quizName: string
  passingScore: number
  questions: Record<string, unknown>[]
} | null> {
  await assertCanAccessAgent({
    userId: params.userId,
    agentId: params.agentId,
  })

  const supabase = await createClient()

  const { data: quiz, error } = await supabase
    .from("onboarding_quizzes")
    .select("id, quiz_name, passing_score, questions")
    .eq("step_id", params.stepId)
    .maybeSingle()

  if (error) throw new Error(`Failed to load quiz for step: ${error.message}`)
  if (!quiz) return null

  return {
    quizId: quiz.id,
    quizName: quiz.quiz_name,
    passingScore: quiz.passing_score,
    questions: (quiz.questions as Record<string, unknown>[]) ?? [],
  }
}

export async function submitQuizAttempt(params: {
  userId: string
  agentId: string
  quizId: string
  answers: Record<string, unknown>
}): Promise<{ score: number; passed: boolean }> {
  const { brokerageId } = await assertCanAccessAgent({
    userId: params.userId,
    agentId: params.agentId,
  })

  const supabase = await createClient()

  // Load full quiz (questions + passing_score + step_id)
  const { data: quiz, error: quizError } = await supabase
    .from("onboarding_quizzes")
    .select("id, step_id, passing_score, questions")
    .eq("id", params.quizId)
    .single()

  if (quizError || !quiz) {
    throw new Error(`Quiz not found: ${quizError?.message ?? "no data"}`)
  }

  const questions = (quiz.questions as QuizQuestion[]) ?? []

  // Score: count correct answers
  let correctCount = 0
  for (const question of questions) {
    if (params.answers[question.id] === question.correctAnswer) {
      correctCount++
    }
  }
  const score = questions.length > 0
    ? Math.round((correctCount / questions.length) * 100)
    : 0
  const passed = score >= quiz.passing_score

  // Count existing attempts for attempt_number
  const { count: prevAttempts } = await supabase
    .from("agent_quiz_attempts")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", params.agentId)
    .eq("quiz_id", params.quizId)

  const attemptNumber = (prevAttempts ?? 0) + 1

  // Insert attempt record
  const { error: insertError } = await supabase
    .from("agent_quiz_attempts")
    .insert({
      brokerage_id: brokerageId,
      agent_id: params.agentId,
      quiz_id: params.quizId,
      score,
      answers: params.answers,
      passed,
      attempt_number: attemptNumber,
    })

  if (insertError) throw new Error(`Failed to record quiz attempt: ${insertError.message}`)

  // If passed: update step_completion quiz_score
  if (passed) {
    const { error: completionError } = await supabase
      .from("agent_step_completions")
      .update({ quiz_score: score })
      .eq("agent_id", params.agentId)
      .eq("step_id", quiz.step_id)

    if (completionError) {
      // Non-fatal: attempt is already recorded; log but do not throw
      console.error("[AgentOnboarding] Failed to update quiz_score on step_completion:", completionError.message)
    }
  }

  return { score, passed }
}
