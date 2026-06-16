import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { loadSourceConversions } from "@/lib/lead-pipeline/source-conversion-runner"
import { recommendSourceAllocation } from "@/lib/lead-pipeline/source-conversion-learning"
import { verifyCronAuth } from "@/lib/cron-auth"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"

/**
 * Source-Conversion Learner — weekly cron.
 *
 * Per brokerage, aggregates real per-source conversion (lead→contact→close) over the trailing
 * window, scores each source (trust-gated, honest on thin data), and publishes an ADVISORY
 * recommendation (enable winners / disable money-pits) to the Command Center via the inter-manager
 * bus. Read-only + advisory — humans keep lead_scraping_markets.enabled_sources.
 */

const MAX_BROKERAGES = 300

export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "source-conversion-learning",
    cron_path: "/app/api/cron/source-conversion-learning/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const svc = createServiceClient()
  try {
    const { data: brokerages } = await svc.from("brokerages").select("id").limit(MAX_BROKERAGES)
    let scanned = 0, advised = 0
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")

    for (const b of (brokerages ?? []) as { id: string }[]) {
      scanned++

      // LEARNING CONDUCTOR (copy) — promote the winning ai_intent variant per A/B step (reply-rate,
      // sample+margin gated). Same weekly cadence as the source learner; best-effort.
      try {
        const { runSequenceCopyLearning } = await import("@/lib/campaign-sequences/copy-learning-conductor")
        await runSequenceCopyLearning(b.id, svc)
      } catch { /* best-effort — never fails the source learner */ }

      // CHANNEL-ORDER learning — recommend the lead channel per brokerage by real reply rate (advisory).
      try {
        const { runChannelOrderLearning } = await import("@/lib/campaign-sequences/channel-order-runner")
        await runChannelOrderLearning(b.id, svc)
      } catch { /* best-effort */ }

      const scored = await loadSourceConversions(b.id, {}, svc)
      if (scored.ranked.length === 0) continue

      const { data: markets } = await svc.from("lead_scraping_markets").select("enabled_sources").eq("brokerage_id", b.id)
      const enabled = [...new Set(((markets ?? []) as { enabled_sources: string[] | null }[]).flatMap((m) => m.enabled_sources ?? []))]
      const rec = recommendSourceAllocation(scored, enabled)

      if (rec.enable.length > 0 || rec.disable.length > 0) {
        await publishManagerSignal({
          brokerageId: b.id, fromManager: "data_steward", toManager: "campaign_orchestrator",
          signalType: "source_allocation_advice",
          message: `Lead-source advice — enable [${rec.enable.join(", ") || "none"}], disable [${rec.disable.join(", ") || "none"}] based on real conversion + ROI.`,
          payload: { enable: rec.enable, disable: rec.disable, hold: rec.hold, reasons: rec.reasons },
        }, svc)
        advised++
      }
    }

    const summary = { scanned, advised }
    await recordCronSuccessAction({ context_id: contextId, records_processed: advised, metadata: summary })
    return NextResponse.json({ message: "Source-conversion learning complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Source-conversion learning failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
