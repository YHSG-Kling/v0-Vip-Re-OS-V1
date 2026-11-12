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

    // ENGAGEMENT ARRIVES AFTER THE SEND, so the rate cannot be computed at send
    // time — it is refreshed on every tick for campaigns still inside the
    // window. email_campaigns.open_rate/.click_rate were read by
    // getEmailCampaignStats, campaign-measurer and the content-topic ranker and
    // written by NOBODY, so every one of them reported 0% forever while the
    // per-recipient rows underneath held the real answer.
    const { rollupEmailCampaignRates } = await import("@/lib/marketing/engagement-rollup")
    const rates = await rollupEmailCampaignRates(svc)
    if (rates.refusals.length > 0) {
      // A refused rollup read is not "no engagement" — name it rather than
      // letting the campaign keep a stale or zero rate silently.
      console.error("[send-email-campaigns] rate rollup refusals:", rates.refusals.join(" | "))
    }
    // §1.2 (2026-09-04) — email_tracking.user_agent / .metadata now have a
    // reader. A machine-open share means the open_rate just written is inflated
    // by mail-proxy prefetches; uncorrelated events mean provider engagement
    // that matched no send row, which UNDER-counts. Both are said aloud rather
    // than folded silently into the rate.
    if (rates.machineOpens > 0) {
      console.warn(`[send-email-campaigns] ${rates.machineOpens} open(s) came from a mail proxy, not a person — open_rate is inflated by that much`)
    }
    if (rates.uncorrelatedEvents > 0) {
      console.warn(
        `[send-email-campaigns] ${rates.uncorrelatedEvents} engagement event(s) matched no email_sends row — ` +
        `provider ids: ${rates.uncorrelatedProviderIds.join(", ") || "none recorded"}`,
      )
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: summary.campaignsSent,
      metadata: { ...summary, rates } as any,
    })
    return NextResponse.json({ message: "Email campaigns processed", summary, rates })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Email campaign send failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
