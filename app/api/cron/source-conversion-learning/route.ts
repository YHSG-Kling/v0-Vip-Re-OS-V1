import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { loadSourceConversions, runSourceReallocationScan } from "@/lib/lead-pipeline/source-conversion-runner"
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
    // PER-MARKET reallocation, counted apart from the brokerage-level advice.
    // Two different units — one is "brokerages advised", the other is "markets
    // signalled" — and summing them would hide which one produced nothing.
    let marketsScanned = 0, marketsSignalled = 0
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

      // PREDICTOR OUTCOME RESOLUTION — close the self-tuning loop: settle each predictor play (did the
      // contact re-engage after the gated nudge?) and record the win/loss so the predictors learn.
      try {
        const { resolvePredictorOutcomes } = await import("@/lib/intelligence/predictor-outcome-resolver")
        await resolvePredictorOutcomes(b.id, {}, svc)
      } catch { /* best-effort — never fails the source learner */ }

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

      // ── THE PER-MARKET HALF OF THE SAME LEARNING ──────────────────────────
      //
      // `recommendSourceAllocation` above answers the BROKERAGE-level question
      // ("which sources are worth money to this tenant") against the union of
      // every market's enabled set, and publishes one advisory signal. That
      // union is not actionable: `lead_scraping_markets.enabled_sources` is
      // per-market, so a source that wins in Austin and loses in Dallas is
      // averaged into a recommendation nobody can apply to either.
      //
      // `runSourceReallocationScan` is the missing half and it was written,
      // exercised by scripts/source-reallocation-simulator.ts, and never called
      // from the product: it re-scores the SAME `loadSourceConversions` output
      // per ACTIVE market and publishes a gated `lead_source_waste` signal
      // carrying that market's id, which is what turns the advice into the
      // one-tap reallocation a human approves. Read-only — the proposal and the
      // approval do the writes.
      //
      // Best-effort, matching every other rider in this loop: a per-market
      // failure must not lose the brokerage-level advice already published.
      try {
        const realloc = await runSourceReallocationScan(b.id, {}, svc)
        marketsScanned += realloc.scanned
        marketsSignalled += realloc.signalled
      } catch (reallocErr) {
        console.error("[source-conversion-learning] reallocation scan failed:", reallocErr)
      }

      // SOURCE LIFETIME-HEALTH — the full arc (lead→contact→thriving/dormant), not just first close.
      // Records each source's lifetime verdict (scraper viability accumulates it) and flags the
      // money-pits the close-rate alone misses: sources that convert cheap but produce fading
      // relationships. Best-effort; never fails the conversion learner.
      try {
        const { loadSourceLifetimeHealth } = await import("@/lib/lead-pipeline/source-lifetime-health-runner")
        const lifetime = await loadSourceLifetimeHealth(b.id, {}, svc)
        if (lifetime.fading.length > 0 || lifetime.lasting.length > 0) {
          await publishManagerSignal({
            brokerageId: b.id, fromManager: "data_steward", toManager: "campaign_orchestrator",
            signalType: "source_lifetime_health_advice",
            message: `Lifetime-quality of leads — lasting [${lifetime.lasting.join(", ") || "none"}], fading [${lifetime.fading.join(", ") || "none"}] by relationship health, not just first close.`,
            payload: { lasting: lifetime.lasting, fading: lifetime.fading, summaries: lifetime.summaries },
          }, svc)
        }
      } catch { /* best-effort — lifetime health never fails the conversion learner */ }
    }

    const summary = { scanned, advised, markets_scanned: marketsScanned, markets_signalled: marketsSignalled }
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
