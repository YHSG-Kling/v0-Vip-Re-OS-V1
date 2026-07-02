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

    await recordCronSuccessAction({ context_id: contextId, records_processed: mentorship.graduated + mentorship.nudged, metadata: { mentorship } })
    return NextResponse.json({ ok: true, mentorship }, { status: 200 })
  } catch (err) {
    console.error("[cron/onboarding-reminders] Failed:", err)
    await recordCronFailureAction({ context_id: contextId, error: err as Error | string, stage: "main-processing" })
    return NextResponse.json({ ok: false, context_id: contextId }, { status: 500 })
  }
}
