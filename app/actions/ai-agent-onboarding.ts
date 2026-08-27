"use server"

/**
 * @deprecated MONOLITHIC ONBOARDING FILE (919 lines, 9 functions).
 * Modular replacements live in `app/actions/onboarding/*`.
 *
 * MIGRATION MAP — each function moves to its target module:
 *
 *   startAgentOnboarding       → app/actions/onboarding/progress.ts
 *   getOnboardingStatus        → merge with progress.ts:getAgentProgress
 *                                AND agent-onboarding-actions.ts:fetchMyOnboardingDashboard
 *                                (likely keep one canonical reader)
 *   completeAISessionStep      → merge with agent-onboarding-actions.ts:completeMyOnboardingStep
 *   matchMentor                → NEW app/actions/onboarding/mentorship.ts
 *   verifyAgentLicense         → RETIRED. The canonical path is
 *                                app/actions/onboarding/license.ts:submitLicenseDetails
 *                                → lib/onboarding/license-verifier.ts:runLicenseVerification,
 *                                which checks the STATE REGULATOR'S REGISTRY and
 *                                sends adverse findings to a human queue. The copy
 *                                here asked an LLM to "simulate a verification
 *                                result with high confidence" and then stamped
 *                                agent_licenses.verification_status='verified'
 *                                through the agent's OWN session. It had no .tsx
 *                                caller. See the retirement note at its former
 *                                site for what was checked before removing it.
 *   generateWelcomeMessage     → app/actions/onboarding/assistant.ts
 *   askOnboardingBuddy         → app/actions/onboarding/assistant.ts
 *   submitQuizAttempt          → RETIRED. Collapsed into the canonical
 *                                lib/kernel/agent-onboarding.ts:submitQuizAttempt,
 *                                reached via app/actions/onboarding/
 *                                onboarding-quiz-actions.ts:submitQuiz, which
 *                                resolves userId from the session and agentId
 *                                from getAgentContext. The copy here took
 *                                agentId FROM THE CALLER with no auth check and
 *                                then derived the brokerage_id stamp from that
 *                                same forgeable id. It had no .tsx caller.
 *                                Richer return (correctCount / totalQuestions /
 *                                attemptNumber / message) was ported to the
 *                                survivor first. Its completeAISessionStep call
 *                                was NOT ported — see that entry above: it
 *                                writes the legacy agent_onboarding_sessions /
 *                                agent_onboarding_steps family, not the
 *                                onboarding_steps + agent_step_completions
 *                                family the survivor's stepIds live in.
 *   certifyAgent               → app/actions/onboarding/progress.ts
 *                                (overlaps with claimCertification — pick canonical)
 *   getOnboardingAnalytics     → NEW app/actions/onboarding/analytics.ts
 *                                OR fold into onboarding-steps-admin-actions.ts
 *
 * Until the migration ships:
 *   - This file remains active. Existing callers continue to work.
 *   - Do NOT add new functions here. Add them to the target module instead.
 *   - The single direct caller is `app/dashboard/onboarding/mentorship/
 *     mentorship-client.tsx` (matchMentor) — to be updated when that
 *     function moves to mentorship.ts.
 *   - app/actions/index.ts re-exports from this file; that re-export will
 *     be redirected to the modular files as each function migrates.
 */

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { generateObject } from "@/lib/ai/generate"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { resolveAgentRecipient } from "@/lib/notifications/recipient-tenant"
// A new `agents` row invalidates any memoized "this user has no agent record" answer.
import { invalidateAgentIdentity } from "@/lib/kernel/agent-identity-resolver"
// THE SPEND ACTOR. Every export in this "use server" file is a public HTTP
// endpoint and `agentId` is whatever the caller typed, so it can never be the
// tenant the AI ledger bills (CLAUDE.md §4). getAgentContext resolves the
// brokerage from the SESSION; the routed calls below carry that and nothing
// else, which is what makes lib/ai/models.ts's `if (request.brokerageId)` fire.
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { z } from "zod"

// ==================== TYPES ====================

export interface OnboardingChecklist {
  profileComplete: boolean
  licenseVerified: boolean
  brokerageAgreementSigned: boolean
  taxFormsCompleted: boolean
  directDepositSetup: boolean
  techStackSetup: boolean
  crmTrained: boolean
  complianceTrained: boolean
  videoPersonaConfigured: boolean
  firstLeadAssigned: boolean
  mentorAssigned: boolean
  firstTransactionStarted: boolean
}

export interface OnboardingStep {
  id: string
  name: string
  description: string
  category: "documents" | "training" | "setup" | "compliance" | "mentorship"
  required: boolean
  order: number
  estimatedMinutes: number
  aiAssisted: boolean
  completedAt?: string
  completedBy?: string
  notes?: string
}

// TOMBSTONE (§1.3, 2026-08-27): `AgentOnboardingSession` deleted — an aspirational
// in-memory session shape referenced by nothing, not even this file. The onboarding
// session is BUILT ANOTHER WAY: the agent_onboarding row (completion_percentage —
// read live by lib/recruiting/retention-radar.ts) plus the step/quiz kernel at
// lib/kernel/agent-onboarding.ts, which is what the onboarding actions actually
// persist and read.

// ==================== AI ONBOARDING FUNCTIONS ====================

/**
 * Start a new agent onboarding session
 */
export async function startAgentOnboarding(params: {
  recruitId?: string
  agentUserId: string
  agentName: string
  agentEmail: string
  licenseNumber: string
  licenseState: string
  experienceYears: number
  brokerageId: string
  teamId?: string
  referringAgentId?: string
}) {
  if (!isValidUUID(params.agentUserId) || !isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid user or brokerage ID" }
  }

  const supabase = await createClient()

  try {
    // Create the agent record first
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .insert({
        user_id: params.agentUserId,
        brokerage_id: params.brokerageId,
        team_id: params.teamId,
        license_number: params.licenseNumber,
        license_state: params.licenseState,
        license_expiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // Default 1 year
        commission_split: 70, // Default split
        is_active: false, // Not active until onboarding complete
        onboarding_status: "in_progress",
        gamification_points: 0,
        ytd_gci: 0,
        ytd_transactions: 0,
      })
      .select()
      .single()

    if (agentError) throw agentError

    // DROP THE STALE "NO SUCH AGENT" ANSWER. lib/kernel/agent-identity-resolver.ts
    // memoizes NEGATIVE lookups for the whole process lifetime, so on a warm
    // serverless instance a `null` cached before this insert would keep the agent
    // we just created unresolvable until the instance recycles. Precise: only the
    // two keys this row can have poisoned.
    invalidateAgentIdentity({
      agentRecordId: agent?.id ?? null,
      userId: params.agentUserId,
      brokerageId: params.brokerageId,
    })

    // Generate AI-personalized onboarding plan
    const { object: onboardingPlan } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: z.object({
        recommendedMentorProfile: z.string(),
        prioritizedSteps: z.array(z.string()),
        estimatedCompletionDays: z.number(),
        customTrainingRecommendations: z.array(z.string()),
        riskFactors: z.array(z.string()),
        successPrediction: z.number(),
      }),
      prompt: `Create a personalized onboarding plan for a new real estate agent:
        
Name: ${params.agentName}
Experience: ${params.experienceYears} years
License State: ${params.licenseState}
Has Referral: ${params.referringAgentId ? "Yes" : "No"}

Consider:
1. Their experience level to adjust training depth
2. State-specific compliance requirements
3. Optimal mentor matching criteria
4. Risk factors that could slow onboarding
5. Success prediction based on profile

Provide actionable recommendations.`,
    })

    // Create onboarding session
    const targetDate = new Date()
    targetDate.setDate(targetDate.getDate() + (onboardingPlan.estimatedCompletionDays || 14))

    const { data: session, error: sessionError } = await supabase
      .from("agent_onboarding_sessions")
      .insert({
        agent_id: agent.id,
        brokerage_id: params.brokerageId,
        recruit_id: params.recruitId,
        status: "in_progress",
        start_date: new Date().toISOString(),
        target_completion_date: targetDate.toISOString(),
        current_step: "profile_setup",
        progress_percentage: 0,
        ai_recommendations: onboardingPlan.customTrainingRecommendations,
        ai_success_prediction: onboardingPlan.successPrediction,
        ai_risk_factors: onboardingPlan.riskFactors,
        checklist: {
          profileComplete: false,
          licenseVerified: false,
          brokerageAgreementSigned: false,
          taxFormsCompleted: false,
          directDepositSetup: false,
          techStackSetup: false,
          crmTrained: false,
          complianceTrained: false,
          videoPersonaConfigured: false,
          firstLeadAssigned: false,
          mentorAssigned: false,
          firstTransactionStarted: false,
        },
      })
      .select()
      .single()

    if (sessionError) throw sessionError

    // Create default onboarding steps
    const defaultSteps: Omit<OnboardingStep, "id">[] = [
      { name: "Complete Agent Profile", description: "Fill out personal information, bio, photo, and specialties", category: "setup", required: true, order: 1, estimatedMinutes: 30, aiAssisted: true },
      { name: "License Verification", description: "Upload license and verify with state board", category: "compliance", required: true, order: 2, estimatedMinutes: 15, aiAssisted: true },
      { name: "Sign Brokerage Agreement", description: "Review and e-sign Independent Contractor Agreement", category: "documents", required: true, order: 3, estimatedMinutes: 20, aiAssisted: false },
      { name: "Complete W-9 Tax Forms", description: "Submit W-9 for commission payments", category: "documents", required: true, order: 4, estimatedMinutes: 10, aiAssisted: false },
      { name: "Setup Direct Deposit", description: "Configure bank account for commission deposits", category: "setup", required: true, order: 5, estimatedMinutes: 10, aiAssisted: false },
      { name: "Technology Stack Setup", description: "Configure email, CRM access, and mobile apps", category: "setup", required: true, order: 6, estimatedMinutes: 45, aiAssisted: true },
      { name: "CRM Training Module", description: "Complete CRM basics training course", category: "training", required: true, order: 7, estimatedMinutes: 60, aiAssisted: true },
      { name: "Fair Housing Compliance", description: "Complete required fair housing training", category: "compliance", required: true, order: 8, estimatedMinutes: 90, aiAssisted: true },
      { name: "Configure Video Persona", description: "Setup D-ID avatar and ElevenLabs voice for AI videos", category: "setup", required: false, order: 9, estimatedMinutes: 30, aiAssisted: true },
      { name: "Mentor Assignment", description: "Get matched with experienced mentor", category: "mentorship", required: true, order: 10, estimatedMinutes: 15, aiAssisted: true },
      { name: "First Lead Assignment", description: "Receive and respond to first lead", category: "training", required: false, order: 11, estimatedMinutes: 30, aiAssisted: true },
      { name: "Transaction Training", description: "Complete transaction workflow training", category: "training", required: true, order: 12, estimatedMinutes: 120, aiAssisted: true },
    ]

    const { data: stepBrok } = await supabase.from("agents").select("brokerage_id").eq("id", agent.id).maybeSingle()
    for (const step of defaultSteps) {
      await supabase.from("agent_onboarding_steps").insert({
        brokerage_id: stepBrok?.brokerage_id,
        agent_id: agent.id,
        session_id: session.id,
        step_title: step.name,
        step_description: `[${step.category}] ${step.description}`,
        step_type: "task",
        step_order: step.order,
        ai_generated: step.aiAssisted,
        status: "pending",
      })
    }

    // Update recruit status if applicable (recruits.status CHECK is lowercase;
    // there is no joined_at column — the provisioned fields capture the date).
    if (params.recruitId) {
      await supabase
        .from("recruits")
        .update({ status: "joined", updated_at: new Date().toISOString() })
        .eq("id", params.recruitId)
    }

    revalidatePath("/dashboard/admin/users")
    revalidatePath("/dashboard/recruiting-roi")

    return {
      success: true,
      agentId: agent.id,
      sessionId: session.id,
      onboardingPlan,
    }
  } catch (error) {
    console.error("Start onboarding error:", error)
    return handleError(error, "startAgentOnboarding")
  }
}

/**
 * Get agent onboarding status with AI insights
 */
export async function getOnboardingStatus(agentId: string) {
  if (!isValidUUID(agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  // Tenant for the AI cost ledger — SESSION, never `agentId` (§4).
  const spendActor = await getAgentContext()
  const supabase = await createClient()

  try {
    const { data: session, error: sessionError } = await supabase
      .from("agent_onboarding_sessions")
      .select(`
        *,
        agent:agents(*),
        steps:agent_onboarding_steps(*)
      `)
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    if (sessionError) throw sessionError

    const completedSteps = session.steps.filter((s: any) => s.completed_at).length
    const totalSteps = session.steps.length
    const progressPercentage = Math.round((completedSteps / totalSteps) * 100)

    // Generate AI status summary
    const { text: aiSummary } = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
      model: "openai/gpt-4o-mini",
      prompt: `Summarize onboarding progress for agent:
        
Progress: ${progressPercentage}%
Completed Steps: ${completedSteps}/${totalSteps}
Days Since Start: ${Math.floor((Date.now() - new Date(session.start_date).getTime()) / (1000 * 60 * 60 * 24))}
Target Completion: ${new Date(session.target_completion_date).toLocaleDateString()}
Risk Factors: ${JSON.stringify(session.ai_risk_factors || [])}

Provide a brief 2-3 sentence summary with encouragement and next priority action.`,
    })

    return {
      success: true,
      session: {
        ...session,
        progressPercentage,
        completedSteps,
        totalSteps,
      },
      aiSummary,
    }
  } catch (error) {
    console.error("Get onboarding status error:", error)
    return handleError(error, "getOnboardingStatus")
  }
}

/**
 * Complete an onboarding step with AI verification
 */
export async function completeAISessionStep(params: {
  sessionId: string
  stepId: string
  completedBy: string
  notes?: string
  attachments?: string[]
}) {
  if (!isValidUUID(params.sessionId) || !isValidUUID(params.stepId)) {
    return { success: false, error: "Invalid session or step ID" }
  }

  const supabase = await createClient()

  try {
    // Get step details
    const { data: step, error: stepError } = await supabase
      .from("agent_onboarding_steps")
      .select("*")
      .eq("id", params.stepId)
      .single()

    if (stepError) throw stepError

    // Mark step as complete
    const { error: updateError } = await supabase
      .from("agent_onboarding_steps")
      .update({
        completed_at: new Date().toISOString(),
        completed_by: params.completedBy,
        notes: params.notes,
        attachments: params.attachments,
      })
      .eq("id", params.stepId)

    if (updateError) throw updateError

    // Get session and recalculate progress
    const { data: session, error: sessionError } = await supabase
      .from("agent_onboarding_sessions")
      .select(`
        *,
        steps:agent_onboarding_steps(*)
      `)
      .eq("id", params.sessionId)
      .single()

    if (sessionError) throw sessionError

    const completedSteps = session.steps.filter((s: any) => s.completed_at).length
    const totalSteps = session.steps.length
    const progressPercentage = Math.round((completedSteps / totalSteps) * 100)

    // Update checklist based on step completed
    const checklist = session.checklist || {}
    const checklistMap: Record<string, keyof OnboardingChecklist> = {
      "Complete Agent Profile": "profileComplete",
      "License Verification": "licenseVerified",
      "Sign Brokerage Agreement": "brokerageAgreementSigned",
      "Complete W-9 Tax Forms": "taxFormsCompleted",
      "Setup Direct Deposit": "directDepositSetup",
      "Technology Stack Setup": "techStackSetup",
      "CRM Training Module": "crmTrained",
      "Fair Housing Compliance": "complianceTrained",
      "Configure Video Persona": "videoPersonaConfigured",
      "First Lead Assignment": "firstLeadAssigned",
      "Mentor Assignment": "mentorAssigned",
      "Transaction Training": "firstTransactionStarted",
    }

    if (checklistMap[step.name]) {
      checklist[checklistMap[step.name]] = true
    }

    // Find next step
    const incompleteSteps = session.steps
      .filter((s: any) => !s.completed_at)
      .sort((a: any, b: any) => a.order - b.order)
    const nextStep = incompleteSteps[0]?.name || "completed"

    // Update session
    const isComplete = progressPercentage === 100

    await supabase
      .from("agent_onboarding_sessions")
      .update({
        progress_percentage: progressPercentage,
        current_step: nextStep,
        checklist,
        status: isComplete ? "completed" : "in_progress",
        actual_completion_date: isComplete ? new Date().toISOString() : null,
      })
      .eq("id", params.sessionId)

    // If onboarding complete, activate agent
    if (isComplete) {
      await supabase
        .from("agents")
        .update({
          is_active: true,
          onboarding_status: "completed",
        })
        .eq("id", session.agent_id)

      // AWARD GAMIFICATION POINTS — AN INCREMENT, NOT AN OVERWRITE.
      //
      // This read `gamification_points: 100`. Not "+100": the agent's total was SET
      // to 100, so an agent who finished onboarding after earning 2,400 points was
      // silently reset to 100 — dropped from Silver back below Bronze, with their
      // ledger still showing every award they had earned. The total and the ledger
      // could not be reconciled afterwards because nothing recorded the loss.
      //
      // It now rides the one atomic award path (m484: public.award_agent_points),
      // which adds the points and writes the ledger row in one transaction.
      const { awardAgentPoints, POINT_VALUES } = await import("@/lib/gamification/award-points")
      const awarded = await awardAgentPoints(supabase, {
        agentId: session.agent_id,
        points: POINT_VALUES.ONBOARDING_COMPLETED,
        reason: "ONBOARDING_COMPLETED",
        referenceType: "agent_onboarding_session",
        referenceId: params.sessionId,
      })
      if (!awarded.ok) {
        console.error(`[completeAISessionStep] onboarding completion points not awarded: ${awarded.error}`)
      }
    }

    revalidatePath("/dashboard/admin/users")

    return {
      success: true,
      progressPercentage,
      nextStep,
      isComplete,
    }
  } catch (error) {
    console.error("Complete step error:", error)
    return handleError(error, "completeAISessionStep")
  }
}

/**
 * AI-powered mentor matching
 */
// matchMentor RETIRED — replaced by the canonical DETERMINISTIC weighted matcher at
// app/actions/onboarding/mentorship.ts (lib/recruiting/mentor-match.ts). The old LLM-freeform pick wrote
// the deprecated agent_onboarding_sessions table; the canonical path writes agent_mentor_relationships.

// verifyAgentLicense RETIRED — a stub that FABRICATED a compliance fact.
//
// Its prompt read, verbatim: "In production, this would use OCR on the uploaded
// image. For now, simulate a verification result with high confidence." It then
// took that simulated answer and, through the AGENT'S OWN SESSION, wrote
// agent_licenses.verification_status = 'verified' + verified_at, stamped
// agents.license_expiry from a date the model invented, and logged the step as
// "AI verified with N% confidence". A real-estate licence marked verified by a
// language model that never saw a registry.
//
// The canonical path was already live and already richer:
//   app/actions/onboarding/license.ts:submitLicenseDetails
//     -> lib/onboarding/license-verifier.ts:runLicenseVerification
// which queries the STATE REGULATOR'S REGISTRY (the source of truth for a real-
// estate licence), routes an adverse finding to a human review queue with the
// evidence and a one-click portal link, never rejects on its own, and runs on
// the SERVICE client so the licence holder is not the one grading themselves.
//
// NOTHING WAS LOST IN THE MERGE. The one input this copy had that the survivor
// might have lacked is the uploaded document: submitLicenseDetails already
// forwards `documentUrl` into runLicenseVerification, which carries a
// `document_ai` method for exactly that. The step it completed lived in
// agent_onboarding_sessions / agent_onboarding_steps, the deprecated tables this
// file's own header calls out (see the matchMentor note above); the canonical
// flow records progress through agent_step_completions instead.
//
// It had no .tsx caller — only a re-export in app/actions/index.ts, removed with
// it. m459 now also makes the shape impossible at the database: a trigger
// refuses any change to verification_status / verified_at that arrives with a
// session belonging to someone who is not a brokerage or platform admin.

/**
 * Generate personalized onboarding welcome message
 */
export async function generateWelcomeMessage(agentId: string) {
  if (!isValidUUID(agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  // Tenant for the AI cost ledger — SESSION, never `agentId` (§4).
  const spendActor = await getAgentContext()
  const supabase = await createClient()

  try {
    // WAS: `.select("*, user:users(*), brokerage:brokerages(*)")`.
    //
    // The starred embeds are what hid the defect (#214): the schema-drift guard
    // checks the columns an embed NAMES, and `(*)` names none — so the target's
    // columns went unchecked and a phantom property read off the result was
    // invisible to it.
    //
    // `agent.user?.name` IS such a phantom. public.users has NO `name` column —
    // it carries first_name / last_name / username / email. So the expression
    // was permanently undefined and this prompt has ALWAYS addressed the new
    // agent as the literal fallback "New Agent". Every welcome message this
    // action has ever produced was impersonal, and nothing surfaced it because
    // `||` turned the phantom into a plausible-looking default.
    //
    // `brokerages.name` is real, so `agent.brokerage?.name` genuinely worked and
    // is preserved verbatim below.
    //
    // Columns are named now so the guard can see them. Only what this function
    // reads is selected: the agent's own license_state, the user's name parts,
    // and the brokerage's name.
    const { data: agent, error } = await supabase
      .from("agents")
      .select("license_state, user:users(first_name, last_name), brokerage:brokerages(name)")
      .eq("id", agentId)
      .single()

    if (error) throw error

    // NORMALIZED, NOT ASSERTED. Naming the embed's columns makes supabase-js
    // type these as ARRAYS: it infers to-one only from a unique constraint on
    // the FK column, and neither agents.user_id nor agents.brokerage_id carries
    // one. At runtime PostgREST returns a single object for a to-one embed, so
    // both shapes are real depending on the client version — casting would paper
    // over exactly the drift this select was rewritten to expose.
    const one = <T,>(v: T | T[] | null | undefined): T | undefined =>
      Array.isArray(v) ? v[0] : (v ?? undefined)

    const agentUser = one(agent.user as { first_name?: string | null; last_name?: string | null } | Array<{ first_name?: string | null; last_name?: string | null }>)
    const agentBrokerage = one(agent.brokerage as { name?: string | null } | Array<{ name?: string | null }>)

    // Rebuilt from the columns that exist. Trimmed because a user with a
    // first_name and no last_name must not become "Ada " with a trailing space,
    // and one with neither must fall back rather than render an empty string.
    const agentName =
      [agentUser?.first_name, agentUser?.last_name].filter(Boolean).join(" ").trim() || "New Agent"

    const { text: welcomeMessage } = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
      model: "openai/gpt-4o-mini",
      prompt: `Generate a warm, professional welcome message for a new real estate agent joining a brokerage:

Agent Name: ${agentName}
Brokerage: ${agentBrokerage?.name || "Our Brokerage"}
License State: ${agent.license_state}

The message should:
1. Welcome them enthusiastically
2. Highlight key benefits of the brokerage
3. Explain what to expect in onboarding
4. Encourage them to reach out with questions
5. Be warm but professional (2-3 paragraphs)`,
    })

    return {
      success: true,
      welcomeMessage,
    }
  } catch (error) {
    console.error("Generate welcome error:", error)
    return handleError(error, "generateWelcomeMessage")
  }
}

/**
 * AI Onboarding Buddy - 24/7 question answering assistant
 */
export async function askOnboardingBuddy(params: {
  agentId: string
  question: string
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  // Tenant for the AI cost ledger — SESSION, never `params.agentId` (§4).
  const spendActor = await getAgentContext()
  const supabase = await createClient()

  try {
    // Get agent's onboarding context
    const { data: session } = await supabase
      .from("agent_onboarding_sessions")
      .select("current_step, progress_percentage, status")
      .eq("agent_id", params.agentId)
      .single()

    // Generate AI response
    const { text: answer } = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
      model: "openai/gpt-4o-mini",
      prompt: `You are the AI Onboarding Buddy for new real estate agents on this platform.

Your Role:
- Help new agents learn the system
- Answer questions about features and workflows
- Provide encouragement and motivation
- Guide them through tasks step-by-step
- Never judge or make them feel stupid

Personality:
- Supportive and patient (like a friendly mentor)
- Enthusiastic about their progress
- Clear and concise in explanations
- Uses analogies and examples
- Celebrates small wins

Agent Context:
- Current Progress: ${session?.progress_percentage || 0}%
- Current Step: ${session?.current_step || "Getting Started"}
- Status: ${session?.status || "Starting"}

Question: ${params.question}

Provide a helpful, encouraging answer in 2-3 paragraphs. Include actionable next steps and relevant tips.`,
    })

    // Log the conversation
    const { data: chatBrok } = await supabase.from("agents").select("brokerage_id").eq("id", params.agentId).maybeSingle()
    await supabase.from("onboarding_ai_chats").insert({
      brokerage_id: chatBrok?.brokerage_id,
      agent_id: params.agentId,
      question: params.question,
      ai_response: answer,
      created_at: new Date().toISOString(),
    })

    return {
      success: true,
      answer,
    }
  } catch (error) {
    console.error("AI Buddy error:", error)
    return handleError(error, "askOnboardingBuddy")
  }
}

/**
 * Certify agent after final exam
 */
export async function certifyAgent(params: {
  agentId: string
  examScore: number
  sessionId: string
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    if (params.examScore < 90) {
      return {
        success: false,
        message: `Score: ${params.examScore}%. Need 90% to certify. Review training materials and try again.`,
      }
    }

    // Grant certification
    await supabase
      .from("agent_onboarding_sessions")
      .update({
        status: "completed",
        progress_percentage: 100,
        certification_achieved: true,
        certified_at: new Date().toISOString(),
        actual_completion_date: new Date().toISOString(),
      })
      .eq("id", params.sessionId)

    // Activate agent
    await supabase
      .from("agents")
      .update({
        is_active: true,
        onboarding_status: "completed",
      })
      .eq("id", params.agentId)

    // Send certification notification.
    //
    // RECIPIENT + TENANT, resolved ONCE through the record this row is filed
    // against: `params.agentId` is an agents.id, and `notifications.user_id` is
    // `REFERENCES users(id)` — DISJOINT spaces. The previous
    // `certAgent?.user_id ?? params.agentId` fell back ACROSS that boundary, so
    // whenever the agents read came back empty (or was refused, which arrives
    // identically when `error` is not destructured) the insert carried an
    // agents.id into a users FK and Postgres refused it 23503. The congrats did
    // not arrive late; it did not arrive.
    //
    // The tenant is the RECIPIENT's `users.brokerage_id` — the exact value
    // app/api/dashboard/badge-counts/route.ts:62 compares against. Unstamped,
    // `NULL = <uuid>` is NULL and the certification never counts toward the
    // bell, on the one notification whose entire job is to be seen.
    const certRecipient = await resolveAgentRecipient(supabase, params.agentId)
    if (!certRecipient.ok) {
      console.error(`[ai-agent-onboarding] certifyAgent: ${certRecipient.reason} — certification notification NOT written`)
    } else if (!certRecipient.userId || !certRecipient.brokerageId) {
      console.error(
        `[ai-agent-onboarding] certifyAgent: agent ${params.agentId} resolves to no user or no brokerage — certification notification NOT written rather than written where the bell cannot count it`,
      )
    } else {
      const { error: certNotifyError } = await supabase.from("notifications").insert({
        user_id: certRecipient.userId,
        brokerage_id: certRecipient.brokerageId,
        type: "certification_achieved",
        title: "Congratulations! You're Certified!",
        body: "Welcome to the team. You now have full access to the platform.",
        priority: "high",
        created_at: new Date().toISOString(),
      })
      if (certNotifyError) {
        console.error("[ai-agent-onboarding] certification notification insert refused:", certNotifyError.message)
      }
    }

    revalidatePath("/dashboard/admin/users")

    return {
      success: true,
      certified: true,
      message: "Certification complete! Welcome to the team.",
    }
  } catch (error) {
    console.error("Certify agent error:", error)
    return handleError(error, "certifyAgent")
  }
}

/**
 * Get onboarding analytics for admin dashboard
 */
export async function getOnboardingAnalytics(brokerageId: string) {
  if (!isValidUUID(brokerageId)) {
    return { success: false, error: "Invalid brokerage ID" }
  }

  const supabase = await createClient()

  try {
    // Get all sessions for brokerage
    const { data: sessions, error } = await supabase
      .from("agent_onboarding_sessions")
      .select(`
        *,
        agent:agents!inner(brokerage_id)
      `)
      .eq("agent.brokerage_id", brokerageId)

    if (error) throw error

    const analytics = {
      totalOnboarding: sessions.length,
      inProgress: sessions.filter((s: any) => s.status === "in_progress").length,
      completed: sessions.filter((s: any) => s.status === "completed").length,
      onHold: sessions.filter((s: any) => s.status === "on_hold").length,
      averageCompletionDays: 0,
      averageProgressPercentage: 0,
      bottleneckSteps: [] as string[],
    }

    // Calculate averages
    const completedSessions = sessions.filter((s: any) => s.status === "completed")
    if (completedSessions.length > 0) {
      const totalDays = completedSessions.reduce((sum: number, s: any) => {
        const start = new Date(s.start_date)
        const end = new Date(s.actual_completion_date)
        return sum + Math.floor((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
      }, 0)
      analytics.averageCompletionDays = Math.round(totalDays / completedSessions.length)
    }

    const inProgressSessions = sessions.filter((s: any) => s.status === "in_progress")
    if (inProgressSessions.length > 0) {
      const totalProgress = inProgressSessions.reduce((sum: number, s: any) => sum + (s.progress_percentage || 0), 0)
      analytics.averageProgressPercentage = Math.round(totalProgress / inProgressSessions.length)
    }

    return {
      success: true,
      analytics,
    }
  } catch (error) {
    console.error("Get analytics error:", error)
    return handleError(error, "getOnboardingAnalytics")
  }
}
