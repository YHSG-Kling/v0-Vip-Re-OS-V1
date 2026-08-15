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
    await recordCronSuccessAction({ context_id: contextId, records_processed: 0 })
    return NextResponse.json({ ok: true }, { status: 200 })
  } catch (err) {
    console.error("[cron/onboarding-reminders] Failed:", err)
    await recordCronFailureAction({ context_id: contextId, error: err as Error | string, stage: "main-processing" })
    return NextResponse.json({ ok: false, context_id: contextId }, { status: 500 })
  }
}
