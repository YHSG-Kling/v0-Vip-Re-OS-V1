import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * Send Email Campaigns Cron (every 15 min, campaign_orchestrator) — the
 * consumer the schedule never had: scheduleEmailCampaign set
 * status='scheduled' + send_date and NOTHING read it, so scheduled
 * campaigns (and the per-contact email_sends queues behind listing
 * campaigns) never went out. Each due campaign now ships through the ONE
 * sender (consent-gated dispatchEmail per recipient, honest sent counts,
 * double-send claimed via the 'sending' status).
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "send-email-campaigns",
    cron_path: "/app/api/cron/send-email-campaigns/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const svc = createServiceClient()
    const { runScheduledEmailCampaigns } = await import("@/lib/marketing/email-campaign-sender")
    const summary = await runScheduledEmailCampaigns(svc)
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: summary.campaignsSent,
      metadata: summary as any,
    })
    return NextResponse.json({ message: "Email campaigns processed", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Email campaign send failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
