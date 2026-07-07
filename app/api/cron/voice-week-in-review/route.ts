import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runWeekInReview } from "@/lib/kernel/week-in-review"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

/**
 * Voice Week-in-Review Cron — Monday spoken brief per agent from the persisted
 * Income Truth (runs AFTER weekly-income-digest computes it), audio creds-gated,
 * top move queued as ONE gated proposal. See lib/kernel/week-in-review.ts.
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "voice-week-in-review",
    cron_path: "/app/api/cron/voice-week-in-review/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const svc = createServiceClient()
    const summary = await runWeekInReview(svc)
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: summary.briefed,
      metadata: summary as any,
    })
    return NextResponse.json({ message: "Week-in-review complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Week-in-review failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
