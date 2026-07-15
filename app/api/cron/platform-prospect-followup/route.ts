import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runProspectFollowupSweep } from "@/lib/platform/prospect-followup"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

/**
 * Platform Prospect Follow-up Cron — the platform's own speed-to-lead. Sends
 * the intro pitch to aged 'new' prospects and ONE day-3 nudge to quiet
 * contacted ones; trial/converted/lost never touched, suppressed emails
 * skipped, failed sends retried next run (never a fake 'contacted' stamp).
 * See lib/platform/prospect-followup.ts.
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "platform-prospect-followup",
    cron_path: "/app/api/cron/platform-prospect-followup/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const svc = createServiceClient()
    const summary = await runProspectFollowupSweep(svc)
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: summary.introsSent + summary.nudgesSent,
      metadata: summary as any,
    })
    return NextResponse.json({ message: "Prospect follow-up sweep complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Prospect follow-up sweep failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
