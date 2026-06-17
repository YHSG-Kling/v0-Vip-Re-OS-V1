// lib/intelligence/geo-gap-runner.ts
//
// Live side of the GEO LOOP CLOSURE. Reads the honest citation observations the monitor recorded for a
// brokerage's lead-magnet / FAQ landing pages (ai_search_landing_citation_observations), and for any
// page that is PERSISTENTLY invisible (checked enough, across enough days, never cited) publishes a
// feed-only geo_visibility_gap signal from the Asset Manager (who built the page) to the Campaign
// Orchestrator (who owns GEO) with a precise refresh recommendation. Idempotent per page via the
// publish dedupe. Best-effort; never throws. NOT server-only-importable from the simulator's pure layer
// — the runner is imported dynamically in the live layer.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { assessGeoGap, geoGapRecommendation, type GeoGapStats } from "./geo-gap"

type Svc = ReturnType<typeof createServiceClient>

export interface GeoGapScanResult {
  pagesEvaluated: number
  gapsFound: number
  signalsPublished: number
}

export async function runGeoGapScan(
  brokerageId: string,
  opts: { windowDays?: number; minChecked?: number; minDays?: number; now?: Date } = {},
  client?: Svc,
): Promise<GeoGapScanResult> {
  const svc = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const windowDays = opts.windowDays ?? 30
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10)

  const result: GeoGapScanResult = { pagesEvaluated: 0, gapsFound: 0, signalsPublished: 0 }

  const { data: rows } = await svc
    .from("ai_search_landing_citation_observations")
    .select("form_id, public_slug, outcome, observed_on")
    .eq("brokerage_id", brokerageId)
    .gte("observed_on", since)
  const obs = (rows ?? []) as Array<{ form_id: string; public_slug: string; outcome: string; observed_on: string }>
  if (obs.length === 0) return result

  // Group by page.
  const byForm = new Map<string, { slug: string; cited: number; notCited: number; notChecked: number; checkedDays: Set<string> }>()
  for (const o of obs) {
    const g = byForm.get(o.form_id) ?? { slug: o.public_slug, cited: 0, notCited: 0, notChecked: 0, checkedDays: new Set<string>() }
    if (o.outcome === "cited") { g.cited++; g.checkedDays.add(o.observed_on) }
    else if (o.outcome === "not_cited") { g.notCited++; g.checkedDays.add(o.observed_on) }
    else g.notChecked++
    byForm.set(o.form_id, g)
  }

  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")

  for (const [formId, g] of byForm) {
    result.pagesEvaluated += 1
    const stats: GeoGapStats = { cited: g.cited, notCited: g.notCited, notChecked: g.notChecked, distinctCheckedDays: g.checkedDays.size }
    const verdict = assessGeoGap(stats, { minChecked: opts.minChecked, minDays: opts.minDays })
    if (!verdict.needsRemediation) continue
    result.gapsFound += 1
    try {
      const r = await publishManagerSignal({
        brokerageId,
        fromManager: "asset_manager",       // built the citable page
        toManager: "campaign_orchestrator", // owns GEO distribution + remediation
        signalType: "geo_visibility_gap",
        message: geoGapRecommendation(g.slug, stats),
        entityType: "lead_capture_form",
        entityId: formId,
        payload: {
          slug: g.slug, visibility: verdict.visibility, reason: verdict.reason,
          cited: g.cited, not_cited: g.notCited, checked_days: g.checkedDays.size,
        },
      }, svc)
      if ((r as any).ok) result.signalsPublished += 1
    } catch {
      // best-effort
    }
  }
  return result
}
