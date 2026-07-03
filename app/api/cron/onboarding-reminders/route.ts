import {
NextResponse } from "next/server"
import { findStuckAgentsAndNotify } from "@/lib/kernel/onboarding-reminders"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "onboarding-reminders",
    cron_path: "/app/api/cron/onboarding-reminders/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[OnboardingReminders] Failed to record cron start:", startRecordResult.error)
  }

  try {
    await findStuckAgentsAndNotify()

    // MENTORSHIP LIFECYCLE — check-in nudges for active pairings + graduate the ones whose mentee
    // finished onboarding (agent_mentor_relationships was previously a static, never-touched record).
    let mentorship = { graduated: 0, nudged: 0 }
    try {
      const { createServiceClient } = await import("@/lib/supabase/service")
      const { runMentorshipLifecycleAll } = await import("@/lib/recruiting/mentorship-lifecycle")
      const r = await runMentorshipLifecycleAll(createServiceClient())
      mentorship = { graduated: r.graduated, nudged: r.nudged }
    } catch (e) {
      console.error("[OnboardingReminders] mentorship lifecycle:", e)
    }

    // SKILL-FRESHNESS RADAR — continuing-competency loop: nudge agents to refresh a decayed skill
    // (objection drill / knowledge check / course review) BEFORE it goes stale, so their edge stays sharp.
    let skillRefreshers = 0
    try {
      const { createServiceClient } = await import("@/lib/supabase/service")
      const { runSkillFreshnessRadarAll } = await import("@/lib/education/skill-freshness-radar")
      const r = await runSkillFreshnessRadarAll(createServiceClient())
      skillRefreshers = r.nudged
    } catch (e) {
      console.error("[OnboardingReminders] skill freshness radar:", e)
    }

    // ONBOARDING FALL-BEHIND — a new agent materially behind their 90-day ramp (red) → ONE gated broker
    // intervention with a check-in script (the agent-facing reminder handles the gentler cases).
    let fallBehindInterventions = 0
    try {
      const { createServiceClient } = await import("@/lib/supabase/service")
      const { runOnboardingFallBehindAll } = await import("@/lib/kernel/onboarding-fallbehind")
      const r = await runOnboardingFallBehindAll(createServiceClient())
      fallBehindInterventions = r.interventions
    } catch (e) {
      console.error("[OnboardingReminders] fall-behind:", e)
    }

    await recordCronSuccessAction({ context_id: contextId, records_processed: mentorship.graduated + mentorship.nudged + skillRefreshers + fallBehindInterventions, metadata: { mentorship, skillRefreshers, fallBehindInterventions } })
    return NextResponse.json({ ok: true, mentorship, skillRefreshers, fallBehindInterventions }, { status: 200 })
  } catch (err) {
    console.error("[cron/onboarding-reminders] Failed:", err)
    await recordCronFailureAction({ context_id: contextId, error: err as Error | string, stage: "main-processing" })
    return NextResponse.json({ ok: false, context_id: contextId }, { status: 500 })
  }
}
