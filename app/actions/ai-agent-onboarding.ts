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
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
// (generateObject / invalidateAgentIdentity / zod imports left with the
// functions deleted 2026-08-28 — see the tombstones below.
// resolveAgentRecipient returned with the restored certifyAgent.)
import { resolveAgentRecipient } from "@/lib/notifications/recipient-tenant"
// THE SPEND ACTOR. Every export in this "use server" file is a public HTTP
// endpoint and `agentId` is whatever the caller typed, so it can never be the
// tenant the AI ledger bills (CLAUDE.md §4). getAgentContext resolves the
// brokerage from the SESSION; the routed calls below carry that and nothing
// else, which is what makes lib/ai/models.ts's `if (request.brokerageId)` fire.
import { getAgentContext } from "@/lib/identity/get-agent-context"

// ==================== TYPES ====================
// (Emptied lane G5 2026-08-28 — see the completeAISessionStep tombstone below
// for where OnboardingChecklist and OnboardingStep went.)

// TOMBSTONE (§1.3, 2026-08-27): `AgentOnboardingSession` deleted — an aspirational
// in-memory session shape referenced by nothing, not even this file. The onboarding
// session is BUILT ANOTHER WAY: the agent_onboarding row (completion_percentage —
// read live by lib/recruiting/retention-radar.ts) plus the step/quiz kernel at
// lib/kernel/agent-onboarding.ts, which is what the onboarding actions actually
// persist and read.

// ==================== AI ONBOARDING FUNCTIONS ====================

// TOMBSTONE (§1 keep-one, lane E2 2026-08-28) — `startAgentOnboarding`
// deleted. SURVIVORS: `createAgent` (app/actions/agents.ts:237 — the gated
// agent-record provisioner wired at
// app/dashboard/admin/users/create-agent-record-button.tsx, tenant from the
// SESSION) and the kernel onboarding lane
// (lib/kernel/agent-onboarding.ts over agent_onboarding + onboarding_steps +
// agent_step_completions — wired at app/dashboard/onboarding). This twin took
// brokerageId FROM THE CALLER and inserted an agents row into any tenant a
// caller named (§4's IDOR shape on a public "use server" endpoint), then
// seeded the DEPRECATED agent_onboarding_sessions/agent_onboarding_steps
// family that the live dashboard does not read. A stripped-source census
// found zero callers outside the app/actions/index.ts barrel, which itself
// has zero importers. Nothing merged.

// TOMBSTONE (§1 keep-one, lane E2 2026-08-28) — `getOnboardingStatus`
// deleted, exactly as this file's own migration map prescribed. SURVIVOR:
// lib/kernel/agent-onboarding.ts:getAgentOnboardingDashboard (wired at
// app/dashboard/onboarding/page.tsx:99 and
// app/dashboard/onboarding/admin/agents/[id]/page.tsx:103), which reads the
// live agent_onboarding + step-completion family. This twin read the
// deprecated agent_onboarding_sessions family and spent AI tokens on a
// per-view summary; a stripped-source census found zero callers outside the
// app/actions/index.ts barrel, which itself has zero importers.

// TOMBSTONE (§1.1 merge-then-delete, lane G5 2026-08-28) —
// `completeAISessionStep` deleted, exactly as this file's own migration map
// (line 13) prescribed. SURVIVOR:
// lib/kernel/agent-onboarding.ts:completeAISessionStep, re-exported at
// lib/kernel/index.ts:156 and wired through
// app/actions/onboarding/agent-onboarding-actions.ts:26
// (completeMyOnboardingStep) to app/dashboard/onboarding/
// OnboardingDashboardClient.tsx:507/517.
//
// SAME BUSINESS PROCESS, verified end to end before deleting: mark one
// onboarding step complete → recompute the agent's percentage → flip the
// parent record to "completed" at 100%. The twins differed only in which
// table family they wrote and how much they trusted the caller.
//
// MERGED ONTO THE SURVIVOR FIRST — the atomic
// awardAgentPoints(POINT_VALUES.ONBOARDING_COMPLETED) this copy fired at 100%.
// The kernel copy awarded nothing, so `ONBOARDING_COMPLETED: 100`
// (lib/gamification/award-points.ts:56) had no writer anywhere: an agent could
// finish the whole programme and the leaderboard would not move. It now lives
// at lib/kernel/agent-onboarding.ts, gated on the false→true edge of
// certification_achieved so it cannot top up on every re-save.
//
// DELIBERATELY NOT MERGED — the `agents.is_active = true` +
// onboarding_status='completed' auto-activation this copy performed. Going
// live is the EXAM-GATED admin act (certifyAgent, below in this file, and
// lib/onboarding/certification-engine.ts which owns agents.onboarding_status).
// Activating on mere step completion would walk around the exam gate, so
// porting it would have been a regression dressed as a merge.
//
// WHY THIS COPY COULD NOT BE THE SURVIVOR: (a) zero callers — a
// stripped-source census across app/, lib/ and scripts/ found only its own
// definition, and app/actions/index.ts no longer exists; (b) it took
// `completedBy` straight from the caller on a public "use server" endpoint
// with no auth check at all, while the survivor resolves identity through
// requireUserContext + assertCanAccessAgent; (c) it drove the DEPRECATED
// agent_onboarding_sessions / agent_onboarding_steps family, of which this
// function was the tree's ONLY reader and writer — nothing else creates a
// session row, so it operated on a family no live surface populates. The live
// dashboard reads agent_onboarding + onboarding_steps +
// agent_step_completions.
//
// The `OnboardingChecklist` and `OnboardingStep` interfaces that stood at
// line 78 went with it: OnboardingChecklist was keyed only by this function's
// checklistMap, and this file's `OnboardingStep` was already referenced by
// nothing — the live one is lib/kernel/onboarding.ts:45, exported at
// lib/kernel/index.ts:261.

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
  // GATED (lane E6 2026-08-28, added with this action's first door — the
  // AI-welcome card on /dashboard/onboarding/admin/agents/[id]): the caller
  // must be the agent themselves or a broker/admin, and the agent read below
  // re-verifies the tenant explicitly rather than leaning on RLS breadth.
  // Every export in this "use server" file is a public HTTP endpoint, and
  // spending AI tokens on another tenant's name is not a read RLS should be
  // the only thing refusing.
  if (!spendActor.isAuthenticated) return { success: false, error: "Not authenticated" }
  if (!spendActor.brokerageId) {
    return { success: false, error: "Your account is not linked to a brokerage yet." }
  }
  const { isAdminOrBroker } = await import("@/lib/auth/resolve-user-role")
  if (spendActor.agentId !== agentId && !isAdminOrBroker({ user_type: spendActor.userType })) {
    return { success: false, error: "Only a broker or admin can generate another agent's welcome message." }
  }
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
      .select("license_state, brokerage_id, user:users(first_name, last_name), brokerage:brokerages(name)")
      .eq("id", agentId)
      .single()

    if (error) throw error
    // Tenant re-verified from the row itself (§4) — a cross-tenant agents.id is
    // refused here even where an RLS policy would have let the read through.
    if (agent.brokerage_id !== spendActor.brokerageId) {
      return { success: false, error: "That agent is not in your brokerage." }
    }

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

// TOMBSTONE (§1 keep-one, lane E2 2026-08-28) — `askOnboardingBuddy` deleted.
// SURVIVOR: app/api/onboarding/assistant/route.ts (wired at
// app/components/features/onboarding/AISetupAssistant.tsx) — the streaming
// setup assistant that resolves identity from requireAuth, searches the
// knowledge base, fires SETUP_ASSISTANT_QUERY_MADE, and writes the same
// onboarding_ai_chats log on finish. This twin answered for any
// caller-supplied agents.id and read context from the deprecated
// agent_onboarding_sessions family; a stripped-source census found zero
// callers outside the app/actions/index.ts barrel, which itself has zero
// importers. Nothing merged.

// RESTORED (owner ruling, lane F2 2026-08-28) — `certifyAgent` is back, and
// the earlier deletion note (lane E2 2026-08-28, "overlaps with
// claimCertification — pick canonical") is REVERSED on the business-process
// comparison the owner's methodology requires:
//
//   · app/actions/onboarding/progress.ts:claimCertification is a LEARNING
//     credential — the agent themselves claims a named certificate
//     ("Platform Fundamentals" etc.) once the certification engine's
//     requirements are met. It writes agent_certifications and nothing else.
//   · certifyAgent is exam-gated AGENT ACTIVATION — a broker/admin act that
//     flips agents.is_active = true + onboarding_status = 'completed' and
//     congratulates the agent. No survivor carried that: the kernel lane
//     (lib/kernel/agent-onboarding.ts:completeAISessionStep) stamps
//     agent_onboarding.certification_achieved at 100% steps but never touches
//     the agents row, so activation was LOST with the deletion.
//
// Same-sounding names, different processes — not duplicates.
//
// Restored WITH THE FIX the deletion was reacting to: the exam score now
// comes from the STORED record (agent_quiz_attempts on the certification-
// category onboarding quiz, written by lib/kernel/agent-onboarding.ts:
// submitQuizAttempt) — never from a caller-supplied number — and the caller
// must be a broker/admin of the agent's own brokerage (§4). The 90% gate is
// kept; the score it is applied to is the record's. The disjoint-id-safe
// notification (agents.id → users.id via resolveAgentRecipient) is kept
// verbatim from the old body. Wired at
// app/dashboard/onboarding/admin/agents/[id]/certify-agent-card.tsx.

/** The activation exam gate — 90%, per the original certifyAgent ruling. */
const CERTIFICATION_PASSING_SCORE = 90

/**
 * The STORED certification-exam evidence for one agent: the best score in
 * agent_quiz_attempts across the quizzes attached to certification-category
 * onboarding steps (global + this brokerage). Every read destructures its
 * error — a refused read must surface as a refusal, never as "no attempts".
 */
/** One question the agent got WRONG on their best certification attempt. */
export interface MissedCertificationQuestion {
  /** The question text when the quiz stores one; the question id otherwise. */
  question: string
  /** What the agent answered — null when they left it blank. Rendered as text. */
  given: string | null
  /** The stored correct answer. */
  correct: string
}

async function readStoredCertificationScore(
  supabase: Awaited<ReturnType<typeof createClient>>,
  agentId: string,
  brokerageId: string,
): Promise<
  | { ok: true; bestScore: number | null; attemptCount: number; missed: MissedCertificationQuestion[] }
  | { ok: false; error: string }
> {
  const { data: certSteps, error: stepsError } = await supabase
    .from("onboarding_steps")
    .select("id")
    .eq("category", "certification")
    .or(`brokerage_id.is.null,brokerage_id.eq.${brokerageId}`)
  if (stepsError) return { ok: false, error: `Could not read certification steps: ${stepsError.message}` }
  const stepIds = (certSteps ?? []).map((s: { id: string }) => s.id)
  if (stepIds.length === 0) {
    return { ok: false, error: "No certification step is configured for this brokerage, so there is no exam to certify against." }
  }

  // `questions` rides along: it is the only place the correct answer lives, and without
  // it the stored `answers` map is an unreadable id→value blob.
  const { data: quizzes, error: quizError } = await supabase
    .from("onboarding_quizzes")
    .select("id, questions")
    .in("step_id", stepIds)
  if (quizError) return { ok: false, error: `Could not read the certification exam: ${quizError.message}` }
  const quizIds = (quizzes ?? []).map((q: { id: string }) => q.id)
  if (quizIds.length === 0) {
    return { ok: false, error: "No exam is attached to the certification step, so there is no stored score to certify against." }
  }

  // WHAT THE AGENT ACTUALLY GOT WRONG — the reader half of agent_quiz_attempts.answers
  // (written on every attempt by lib/kernel/agent-onboarding.ts:submitQuizAttempt and read
  // by NOBODY, w26 lane C8). The broker on the certify screen saw one number and an attempt
  // count; the exam response that produced the number was write-only, so a broker deciding
  // whether to activate an agent could not see which competency the agent missed — and a
  // reviewer deciding without the evidence is the defect.
  const { data: attempts, error: attemptsError } = await supabase
    .from("agent_quiz_attempts")
    .select("score, answers, quiz_id")
    .eq("agent_id", agentId)
    .in("quiz_id", quizIds)
  if (attemptsError) return { ok: false, error: `Could not read the agent's exam attempts: ${attemptsError.message}` }

  type AttemptRow = { score: number | null; answers: Record<string, unknown> | null; quiz_id: string }
  const attemptRows = (attempts ?? []) as unknown as AttemptRow[]
  const scores = attemptRows
    .map((a) => a.score)
    .filter((s): s is number => typeof s === "number" && Number.isFinite(s))
  const bestScore = scores.length > 0 ? Math.max(...scores) : null

  // The BEST attempt is the one the 90% gate is applied to, so it is the one whose misses
  // matter. Ties keep the first — any of them produced the same score.
  const best = bestScore == null ? null : attemptRows.find((a) => a.score === bestScore) ?? null
  const questionsByQuiz = new Map<string, Array<Record<string, unknown>>>()
  for (const q of (quizzes ?? []) as Array<{ id: string; questions: unknown }>) {
    questionsByQuiz.set(q.id, Array.isArray(q.questions) ? (q.questions as Array<Record<string, unknown>>) : [])
  }

  const missed: MissedCertificationQuestion[] = []
  if (best && best.answers && typeof best.answers === "object") {
    const answers = best.answers as Record<string, unknown>
    for (const q of questionsByQuiz.get(best.quiz_id) ?? []) {
      const qid = typeof q.id === "string" ? q.id : null
      if (!qid) continue
      const given = answers[qid]
      const correct = q.correctAnswer
      // SAME COMPARISON THE SCORER USES (agent-onboarding.ts:601) — strict equality — so
      // this list can never disagree with the score it sits next to.
      if (given === correct) continue
      const label = typeof q.question === "string" && q.question.trim()
        ? (q.question as string)
        : typeof q.prompt === "string" && (q.prompt as string).trim()
          ? (q.prompt as string)
          : qid
      missed.push({
        question: label,
        // Blank is blank. An unanswered question is not "answered wrongly with undefined".
        given: given === undefined || given === null || given === "" ? null : String(given),
        correct: correct === undefined || correct === null ? "—" : String(correct),
      })
    }
  }

  return {
    ok: true,
    bestScore,
    attemptCount: attemptRows.length,
    missed,
  }
}

/**
 * Read-only companion for the certify affordance: is this agent certifiable on
 * the STORED record? Admin-gated and tenant-pinned like certifyAgent itself —
 * it reveals another agent's exam history, so it carries the same gate.
 */
export async function getCertificationReadiness(agentId: string): Promise<
  | {
      success: true
      bestScore: number | null
      attemptCount: number
      passingScore: number
      eligible: boolean
      alreadyActive: boolean
      onboardingStatus: string | null
      /** What the agent got WRONG on the attempt the gate is applied to, from the
       *  STORED agent_quiz_attempts.answers. Empty when they answered everything
       *  correctly, when no attempt exists, or when the stored quiz carries no
       *  questions — never padded with a guess. */
      missed: MissedCertificationQuestion[]
    }
  | { success: false; error: string }
> {
  if (!isValidUUID(agentId)) return { success: false, error: "Invalid agent ID" }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
  if (!ctx.brokerageId) return { success: false, error: "Your account is not linked to a brokerage yet." }
  const { isAdminOrBroker } = await import("@/lib/auth/resolve-user-role")
  if (!isAdminOrBroker({ user_type: ctx.userType })) {
    return { success: false, error: "Only a broker or admin can review certification readiness." }
  }

  const supabase = await createClient()
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("id, is_active, onboarding_status")
    .eq("id", agentId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()
  if (agentError) return { success: false, error: `Could not read the agent: ${agentError.message}` }
  if (!agent) return { success: false, error: "That agent is not in your brokerage." }

  const exam = await readStoredCertificationScore(supabase, agentId, ctx.brokerageId)
  if (!exam.ok) return { success: false, error: exam.error }

  return {
    success: true,
    bestScore: exam.bestScore,
    attemptCount: exam.attemptCount,
    passingScore: CERTIFICATION_PASSING_SCORE,
    eligible: exam.bestScore !== null && exam.bestScore >= CERTIFICATION_PASSING_SCORE,
    alreadyActive: agent.is_active === true && agent.onboarding_status === "completed",
    onboardingStatus: agent.onboarding_status ?? null,
    missed: exam.missed,
  }
}

/**
 * Certify an agent after the final exam — exam-gated AGENT ACTIVATION.
 *
 * On certification: agents.is_active = true, onboarding_status = 'completed',
 * agent_onboarding.certification_achieved stamped, and the agent is notified.
 * The exam score is read from the STORED quiz record server-side (§4) — the
 * caller supplies only WHICH agent, and must be a broker/admin of that
 * agent's brokerage.
 */
export async function certifyAgent(agentId: string) {
  if (!isValidUUID(agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  // ── Identity and tenant come from the SESSION (§4) ─────────────────────────
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
  if (!ctx.brokerageId) return { success: false, error: "Your account is not linked to a brokerage yet." }
  const { isAdminOrBroker } = await import("@/lib/auth/resolve-user-role")
  if (!isAdminOrBroker({ user_type: ctx.userType })) {
    return { success: false, error: "Only a broker or admin can certify and activate an agent." }
  }

  const supabase = await createClient()

  try {
    // The target agent must be in the CALLER's brokerage — the read is pinned
    // to the session tenant, so a cross-tenant agents.id matches nothing.
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .select("id, is_active, onboarding_status")
      .eq("id", agentId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()
    if (agentError) return { success: false, error: `Could not read the agent: ${agentError.message}` }
    if (!agent) return { success: false, error: "That agent is not in your brokerage." }

    // ── THE SCORE COMES FROM THE RECORD, NEVER THE CALLER ────────────────────
    const exam = await readStoredCertificationScore(supabase, agentId, ctx.brokerageId)
    if (!exam.ok) return { success: false, error: exam.error }
    if (exam.bestScore === null) {
      return {
        success: false,
        error: "No certification exam attempt is on record for this agent. The agent must take the exam before they can be certified.",
      }
    }
    if (exam.bestScore < CERTIFICATION_PASSING_SCORE) {
      return {
        success: false,
        error: `Best stored exam score is ${exam.bestScore}%. ${CERTIFICATION_PASSING_SCORE}% is required to certify — the agent should review the training materials and retake the exam.`,
      }
    }

    const now = new Date().toISOString()

    // ── Activate the agent — THE act this function exists for ────────────────
    // .select() the update and count what came back: an UPDATE that matches
    // nothing also resolves with error null, and "nobody was activated" must
    // never render as "activated".
    const { data: activated, error: activateError } = await supabase
      .from("agents")
      .update({ is_active: true, onboarding_status: "completed", updated_at: now })
      .eq("id", agentId)
      .eq("brokerage_id", ctx.brokerageId)
      .select("id")
    if (activateError) return { success: false, error: `Activation refused: ${activateError.message}` }
    if (!activated || activated.length === 0) {
      return { success: false, error: "The database accepted the request but activated no agent — nothing was changed." }
    }

    // ── Stamp the kernel onboarding record (the LIVE family) ─────────────────
    // agent_onboarding is what the onboarding dashboards read. certified_at is
    // stamped only where it is still null so a re-certify never rewrites
    // history; zero rows here is fine (already stamped, or the agent never
    // opened the onboarding dashboard so no row exists) and is reported, not
    // failed on — the activation above is the act that matters.
    const { data: stamped, error: stampError } = await supabase
      .from("agent_onboarding")
      .update({ certification_achieved: true, certified_at: now, updated_at: now })
      .eq("agent_id", agentId)
      .eq("brokerage_id", ctx.brokerageId)
      .is("certified_at", null)
      .select("id")
    if (stampError) {
      console.error(`[ai-agent-onboarding] certifyAgent: agent activated but agent_onboarding stamp refused: ${stampError.message}`)
    }

    // Send certification notification.
    //
    // RECIPIENT + TENANT, resolved ONCE through the record this row is filed
    // against: `agentId` is an agents.id, and `notifications.user_id` is
    // `REFERENCES users(id)` — DISJOINT spaces. A fallback across that boundary
    // (the pre-hardening `certAgent?.user_id ?? agentId` shape) handed an
    // agents.id to a users FK and Postgres refused it 23503: the congrats did
    // not arrive late; it did not arrive.
    //
    // The tenant is the RECIPIENT's `users.brokerage_id` — the exact value
    // app/api/dashboard/badge-counts/route.ts compares against. Unstamped,
    // `NULL = <uuid>` is NULL and the certification never counts toward the
    // bell, on the one notification whose entire job is to be seen.
    const certRecipient = await resolveAgentRecipient(supabase, agentId)
    if (!certRecipient.ok) {
      console.error(`[ai-agent-onboarding] certifyAgent: ${certRecipient.reason} — certification notification NOT written`)
    } else if (!certRecipient.userId || !certRecipient.brokerageId) {
      console.error(
        `[ai-agent-onboarding] certifyAgent: agent ${agentId} resolves to no user or no brokerage — certification notification NOT written rather than written where the bell cannot count it`,
      )
    } else {
      const { error: certNotifyError } = await supabase.from("notifications").insert({
        user_id: certRecipient.userId,
        brokerage_id: certRecipient.brokerageId,
        type: "certification_achieved",
        title: "Congratulations! You're Certified!",
        body: "Welcome to the team. You now have full access to the platform.",
        priority: "high",
        created_at: now,
      })
      if (certNotifyError) {
        console.error("[ai-agent-onboarding] certification notification insert refused:", certNotifyError.message)
      }
    }

    revalidatePath("/dashboard/admin/users")
    revalidatePath(`/dashboard/onboarding/admin/agents/${agentId}`)

    return {
      success: true,
      certified: true,
      examScore: exam.bestScore,
      onboardingStamped: (stamped?.length ?? 0) > 0,
      message: `Certification complete (stored exam score ${exam.bestScore}%). The agent is now active.`,
    }
  } catch (error) {
    console.error("Certify agent error:", error)
    return handleError(error, "certifyAgent")
  }
}

// TOMBSTONE (§1 keep-one, lane E2 2026-08-28) — `getOnboardingAnalytics`
// deleted. SURVIVOR: app/actions/onboarding/progress.ts:
// getAdminOnboardingOverview (wired at
// app/dashboard/onboarding/OnboardingDashboardClient.tsx:228) — the
// admin-gated, session-tenanted onboarding rollup over the live kernel
// family. This twin took brokerageId FROM THE CALLER (§4) and aggregated the
// deprecated agent_onboarding_sessions family; a stripped-source census found
// zero callers outside the app/actions/index.ts barrel, which itself has zero
// importers.
