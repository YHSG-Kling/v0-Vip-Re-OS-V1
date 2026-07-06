// lib/kernel/onboarding.ts
// KERNEL OS — Onboarding Workspace Commands
//
// This module provides the canonical onboarding state machine for all user roles.
//
// Commands:
//   - markOnboardingStepComplete()    — marks a step done, updates completion %
//   - loadOnboardingWorkspace()       — loads full onboarding state for the dashboard page
//   - determineFirstLoginDestination() — returns the correct route for a user's first login
//   - startOnboarding()               — creates the onboarding row if missing, emits event
//
// Contract rules:
//   - All DB calls use maybeSingle() not single()
//   - agent_onboarding has NO updated_at column — never write it
//   - Steps are in agent_onboarding_steps (brokerage-specific) or onboarding_steps (platform defaults)
//   - Completions are in agent_step_completions
//   - Errors returned as structured { success, error } — never thrown silently
//   - All writes emit canonical KernelEvents

"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "./events"
import { ROLE_DASHBOARD_ROUTES } from "./role-routes"
import { emitUserProvisionedEvent } from "./users"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface OnboardingWorkspace {
  onboardingId: string | null
  status: "pending" | "in_progress" | "completed" | "paused" | "not_started"
  completionPct: number
  currentDay: number
  certificationAchieved: boolean
  certifiedAt: string | null
  steps: OnboardingStep[]
  completedStepIds: string[]
  missingRequiredSteps: string[]
  blockers: string[]
  /** Route to show next — either the onboarding dashboard or their role dashboard */
  nextRoute: string
}

export interface OnboardingStep {
  id: string
  stepKey: string
  stepName: string
  category: string
  required: boolean
  stepOrder: number
  estimatedMinutes: number | null
  videoUrl: string | null
  instructions: string | null
}

export interface MarkStepCompleteParams {
  userId: string
  agentId: string
  brokerageId: string
  stepId: string
  quizScore?: number
  timeSpentMinutes?: number
  notes?: string
}

export interface MarkStepCompleteResult {
  success: boolean
  newCompletionPct: number
  onboardingCompleted: boolean
  error?: string
}

export interface FirstLoginDestination {
  route: string
  reason: "setup_incomplete" | "onboarding_pending" | "onboarding_complete" | "role_dashboard" | "billing_required"
}

// ─── Role-to-onboarding-route map ────────────────────────────────────────────

// Canonical role → dashboard route map lives in lib/kernel/role-routes.ts (imported at top).

// Roles that go through the onboarding flow
const ONBOARDING_ROLES = new Set(["agent", "tc", "isa", "team_lead"])

// ─── startOnboarding ─────────────────────────────────────────────────────────

/**
 * Creates the agent_onboarding row if it does not exist.
 * Safe to call repeatedly — idempotent.
 */
export async function startOnboarding(params: {
  userId: string
  agentId: string | null
  brokerageId: string
}): Promise<{ success: boolean; onboardingId: string | null; error?: string }> {
  const service = createServiceClient()

  const { data: existing } = await service
    .from("agent_onboarding")
    .select("id")
    .eq("user_id", params.userId)
    .maybeSingle()

  if (existing) return { success: true, onboardingId: existing.id }

  // Schema: NO updated_at on agent_onboarding
  const { data: created, error } = await service
    .from("agent_onboarding")
    .insert({
      user_id:                params.userId,
      agent_id:               params.agentId,
      brokerage_id:           params.brokerageId,
      status:                 "in_progress",
      completion_percentage:  0,
      current_day:            1,
      certification_achieved: false,
      start_date:             new Date().toISOString().slice(0, 10),
      created_at:             new Date().toISOString(),
    })
    .select("id")
    .maybeSingle()

  if (error) return { success: false, onboardingId: null, error: error.message }

  await emitUserProvisionedEvent({
    userId:       params.userId,
    userType:     "agent",
    brokerageId:  params.brokerageId,
    callerUserId: params.userId,
    eventType:    KernelEvent.USER_ONBOARDING_STARTED,
  })

  return { success: true, onboardingId: created?.id ?? null }
}

// ─── markOnboardingStepComplete ───────────────────────────────────────────────

/**
 * Marks a single onboarding step as complete and recalculates the overall %.
 *
 * Input contract:
 *   userId, agentId — both required for scope check
 *   stepId          — agent_onboarding_steps.id or onboarding_steps.id
 *
 * Output contract:
 *   newCompletionPct    — recalculated after marking this step done
 *   onboardingCompleted — true if all required steps are now done
 */
export async function markOnboardingStepComplete(
  params: MarkStepCompleteParams
): Promise<MarkStepCompleteResult> {
  const service = createServiceClient()

  try {
    const { userId, agentId, brokerageId, stepId, quizScore, timeSpentMinutes, notes } = params

    // Upsert completion row
    const { error: completionErr } = await service
      .from("agent_step_completions")
      .upsert(
        {
          step_id:             stepId,
          agent_id:            agentId,
          brokerage_id:        brokerageId,
          completed:           true,
          completed_at:        new Date().toISOString(),
          quiz_score:          quizScore ?? null,
          time_spent_minutes:  timeSpentMinutes ?? null,
          notes:               notes ?? null,
          created_at:          new Date().toISOString(),
          updated_at:          new Date().toISOString(),
        },
        { onConflict: "step_id,agent_id" }
      )

    if (completionErr) {
      return { success: false, newCompletionPct: 0, onboardingCompleted: false, error: completionErr.message }
    }

    // Recalculate completion % from agent_step_completions vs total required steps
    const [{ data: allSteps }, { data: completedSteps }, { data: onboardingRow }] =
      await Promise.all([
        service
          .from("onboarding_steps")
          .select("id, required")
          .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`),
        service
          .from("agent_step_completions")
          .select("step_id")
          .eq("agent_id", agentId)
          .eq("completed", true),
        service
          .from("agent_onboarding")
          .select("id, status")
          .eq("user_id", userId)
          .maybeSingle(),
      ])

    const totalRequired   = allSteps?.filter(s => s.required).length ?? 1
    const completedCount  = completedSteps?.length ?? 0
    const newPct          = Math.min(100, Math.round((completedCount / totalRequired) * 100))
    const allRequiredDone = (allSteps ?? [])
      .filter(s => s.required)
      .every(s => completedSteps?.some(c => c.step_id === s.id))

    const newStatus = allRequiredDone ? "completed" : "in_progress"

    // Update agent_onboarding — NO updated_at column
    if (onboardingRow?.id) {
      await service
        .from("agent_onboarding")
        .update({
          completion_percentage:  newPct,
          status:                 newStatus,
          ...(allRequiredDone ? {
            certification_achieved: true,
            certified_at:           new Date().toISOString(),
          } : {}),
        })
        .eq("id", onboardingRow.id)
    }

    // Emit completion event
    await emitUserProvisionedEvent({
      userId,
      userType:     "agent",
      brokerageId,
      callerUserId: userId,
      eventType:    allRequiredDone
        ? KernelEvent.USER_ONBOARDING_COMPLETED
        : KernelEvent.USER_ONBOARDING_STEP_COMPLETED,
      metadata: { stepId, newPct, allRequiredDone },
    })

    return { success: true, newCompletionPct: newPct, onboardingCompleted: allRequiredDone }
  } catch (err: unknown) {
    return {
      success: false,
      newCompletionPct: 0,
      onboardingCompleted: false,
      error: err instanceof Error ? err.message : "Step completion failed",
    }
  }
}

// ─── loadOnboardingWorkspace ──────────────────────────────────────────────────

/**
 * Loads the full onboarding workspace for a user.
 * Used by app/dashboard/onboarding/page.tsx.
 *
 * Returns all steps, completion state, blockers, and the correct next route.
 */
export async function loadOnboardingWorkspace(params: {
  userId: string
  agentId: string | null
  brokerageId: string
  userType: string
}): Promise<OnboardingWorkspace> {
  const service = createServiceClient()
  const { userId, agentId, brokerageId, userType } = params

  // Load onboarding record
  const { data: onboarding } = await service
    .from("agent_onboarding")
    .select("id, status, completion_percentage, current_day, certification_achieved, certified_at")
    .eq("user_id", userId)
    .maybeSingle()

  // Load steps — brokerage-specific first, then platform defaults.
  // Migration 1049 added target_role[] for role-specific staff/admin
  // curricula. A step matches when:
  //   * target_role IS NULL (legacy / universal step), OR
  //   * userType is in target_role[]
  // This gives each role its own ordered curriculum from one steps table.
  const normalizedRole = (userType ?? "agent").toLowerCase()
  const { data: stepsRaw } = await service
    .from("onboarding_steps")
    .select("id, step_key, step_name, category, required, step_order, estimated_minutes, video_url, instructions, target_role")
    .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)
    .order("step_order", { ascending: true })
  const steps = (stepsRaw ?? []).filter((s: { target_role: string[] | null }) => {
    const tr = s.target_role
    return !tr || tr.length === 0 || tr.includes(normalizedRole)
  })

  // Load completions
  const { data: completions } = agentId
    ? await service
        .from("agent_step_completions")
        .select("step_id, completed")
        .eq("agent_id", agentId)
        .eq("completed", true)
    : { data: [] }

  const completedIds = new Set((completions ?? []).map(c => c.step_id))
  const stepsTyped: OnboardingStep[] = (steps ?? []).map(s => ({
    id:                s.id,
    stepKey:           s.step_key,
    stepName:          s.step_name,
    category:          s.category,
    required:          s.required,
    stepOrder:         s.step_order,
    estimatedMinutes:  s.estimated_minutes,
    videoUrl:          s.video_url,
    instructions:      s.instructions,
  }))

  const missingRequired = stepsTyped
    .filter(s => s.required && !completedIds.has(s.id))
    .map(s => s.stepName)

  const blockers: string[] = []
  if (!agentId && ONBOARDING_ROLES.has(userType)) {
    blockers.push("Agent record missing — account needs repair")
  }

  const completionPct = onboarding?.completion_percentage ?? 0
  const isComplete    = onboarding?.status === "completed"
  const nextRoute     = isComplete
    ? ROLE_DASHBOARD_ROUTES[userType] ?? "/dashboard/agent"
    : "/dashboard/onboarding"

  return {
    onboardingId:          onboarding?.id ?? null,
    status:                (onboarding?.status as OnboardingWorkspace["status"]) ?? "not_started",
    completionPct,
    currentDay:            onboarding?.current_day ?? 1,
    certificationAchieved: onboarding?.certification_achieved ?? false,
    certifiedAt:           onboarding?.certified_at ?? null,
    steps:                 stepsTyped,
    completedStepIds:      Array.from(completedIds),
    missingRequiredSteps:  missingRequired,
    blockers,
    nextRoute,
  }
}

// ─── determineFirstLoginDestination ──────────────────────────────────────────

/**
 * Returns the correct route for a user immediately after login.
 *
 * Decision tree:
 *   1. No brokerage assigned           → /dashboard/onboarding/setup (incomplete)
 *   2. Agent role, no agents row        → /dashboard/onboarding/setup (needs repair)
 *   3. Has onboarding, not completed    → /dashboard/onboarding
 *   4. Onboarding complete / exempt     → role dashboard
 */
export async function determineFirstLoginDestination(
  userId: string
): Promise<FirstLoginDestination> {
  const service = createServiceClient()

  const [{ data: userData }, { data: agentData }, { data: onboardingData }] =
    await Promise.all([
      service.from("users").select("user_type, brokerage_id").eq("id", userId).maybeSingle(),
      service.from("agents").select("id").eq("user_id", userId).maybeSingle(),
      service.from("agent_onboarding").select("status").eq("user_id", userId).maybeSingle(),
    ])

  const userType = userData?.user_type ?? "agent"

  // No brokerage — account is incomplete
  if (!userData?.brokerage_id) {
    return { route: "/dashboard/onboarding", reason: "setup_incomplete" }
  }

  // Agent role but no agents row — repair needed
  if (ONBOARDING_ROLES.has(userType) && !agentData) {
    return { route: "/dashboard/onboarding", reason: "setup_incomplete" }
  }

  // Onboarding in progress
  if (ONBOARDING_ROLES.has(userType) && onboardingData && onboardingData.status !== "completed") {
    return { route: "/dashboard/onboarding", reason: "onboarding_pending" }
  }

  // ── BILLING PAYWALL GATE ────────────────────────────────────────────────────
  // A lapsed-trial / past-due / cancelled tenant is routed to billing so the money
  // loop closes itself. Platform staff (superadmin/support) are exempt; a brokerage
  // with no subscription row is NOT blocked (fail-open — never lock out by accident).
  if (!["superadmin", "support"].includes(userType)) {
    try {
      const { loadBillingAccess } = await import("@/lib/billing/billing-access")
      const access = await loadBillingAccess(service, userData.brokerage_id)
      if (access.blocked) {
        return { route: "/dashboard/admin/billing", reason: "billing_required" }
      }
    } catch { /* fail-open — a billing-read error must never block login */ }
  }

  // Onboarding complete or exempt from onboarding (broker, admin, etc.)
  const dashboardRoute = ROLE_DASHBOARD_ROUTES[userType] ?? "/dashboard/agent"
  const isOnboardingRequired = ONBOARDING_ROLES.has(userType)

  return {
    route: dashboardRoute,
    reason: isOnboardingRequired ? "onboarding_complete" : "role_dashboard",
  }
}
