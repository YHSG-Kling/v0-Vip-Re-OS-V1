import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import {
  runCitationMonitor,
  runLandingPageCitationMonitor,
} from "@/lib/kernel/ai-search-citation-monitor"
import { runGeoGapScan } from "@/lib/intelligence/geo-gap-runner"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

/**
 * GEO-CITATION-MONITOR cron (daily) — closes the GEO / AI-search-visibility loop.
 *
 * The loop was fully built but never scheduled. This cron drives the two missing
 * ingress steps; the rest is already live:
 *
 *   1. INGRESS (here): runCitationMonitor (published /v/[slug] reels) +
 *      runLandingPageCitationMonitor (/lm/[slug] FAQ landing pages) issue one
 *      gated web search per page and record cited / not_cited / not_checked into
 *      ai_search_citation_observations / ai_search_landing_citation_observations
 *      (idempotent per page,platform,day).
 *   2. GAP → SIGNAL (here): runGeoGapScan reads those observations and, for a page
 *      persistently NOT cited (0 cited across ≥ minChecked checks over ≥ minDays
 *      days), publishes a governed `geo_visibility_gap` manager signal.
 *   3. SIGNAL → DRAFT → APPROVE (already scheduled): the manager-signals cron
 *      consumes the signal and raises a gated `regenerate_faq` proposal that
 *      rebuilds the citable FAQ + schema.org JSON-LD for human approval.
 *
 * Cost-bounded: each monitor is gated on the search rail (degrades to not_checked
 * when unavailable — never a fabricated citation) and idempotent per day.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "geo-citation-monitor",
    cron_path: "/app/api/cron/geo-citation-monitor/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let reelObs = 0
  let landingObs = 0
  let gaps = 0
  let signals = 0

  try {
    // Brokerages with citable surfaces: published reels OR active FAQ landing pages.
    const [{ data: reelRows }, { data: formRows }] = await Promise.all([
      supabase
        .from("ai_video_projects")
        .select("brokerage_id")
        .eq("is_published", true)
        .not("public_slug", "is", null)
        .limit(3000),
      supabase
        .from("lead_capture_forms")
        .select("brokerage_id")
        .eq("is_active", true)
        .not("landing_content", "is", null)
        .limit(3000),
    ])
    const brokerages = Array.from(
      new Set([
        ...((reelRows ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id),
        ...((formRows ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id),
      ]),
    ).filter(Boolean)

    for (const brokerageId of brokerages) {
      try {
        // 1 — ingress: record fresh citation observations for both page kinds.
        const reel = await runCitationMonitor(brokerageId, {}, supabase)
        reelObs += reel.observations ?? 0
        const landing = await runLandingPageCitationMonitor(brokerageId, {}, supabase)
        landingObs += landing.observations ?? 0
        // 2 — gap → governed signal (regenerate_faq is raised by the manager-signals cron).
        const scan = await runGeoGapScan(brokerageId, {}, supabase)
        gaps += scan.gapsFound
        signals += scan.signalsPublished
      } catch (e: any) {
        errors.push(`${brokerageId}: ${e?.message ?? String(e)}`)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: reelObs + landingObs + signals,
      metadata: { brokerages: brokerages.length, reelObs, landingObs, gaps, signals, errors: errors.slice(0, 20) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, brokerages: brokerages.length, reelObs, landingObs, gaps, signals, errors: errors.length })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
