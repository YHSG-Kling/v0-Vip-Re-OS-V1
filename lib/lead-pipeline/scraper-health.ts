// lib/lead-pipeline/scraper-health.ts
// ─────────────────────────────────────────────────────────────────────────────
// SCRAPER INGESTION HEALTH — the Data Steward's ownership of the SCRAPING half of
// the raw → leads → contacts spine.
//
// When a scheduled scrape fails to connect to its scraper (network / 403 / timeout /
// actor down), the failure was recorded to scraper_executions.error_message and
// console — then ORPHANED. No manager, no human alert. So a dead source silently
// dried up the lead funnel for days until someone noticed leads had stopped.
//
// This closes that loop: on the Nth CONSECUTIVE failure for a (brokerage, scraper
// source), publish scraper_source_failed (campaign_orchestrator → data_steward),
// which the steward handler escalates as a HIGH notification to the brokerage
// broker/admins. The threshold avoids alert spam on a single transient blip, and the
// bus dedupes (one open alert per source until consumed).

import type { SupabaseClient } from "@supabase/supabase-js"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"

/** Consecutive failures before a source's outage is escalated to a human. */
export const SCRAPER_FAILURE_THRESHOLD = 3

/**
 * shouldEscalateScraperFailure — PURE. Escalate only when the most recent
 * `threshold` executions are ALL failures (a sustained outage), so a single
 * transient blip never pages anyone. `statuses` is ordered MOST-RECENT-FIRST.
 */
export function shouldEscalateScraperFailure(
  statusesMostRecentFirst: Array<string | null>,
  threshold: number = SCRAPER_FAILURE_THRESHOLD,
): boolean {
  if (statusesMostRecentFirst.length < threshold) return false
  return statusesMostRecentFirst.slice(0, threshold).every((s) => s === "failed")
}

/**
 * escalateScraperFailureIfNeeded — read the last N executions for this
 * (brokerage, scraper_type); if they are all failures, escalate to the Data Steward.
 * Idempotent (the bus dedupes on the open signal). Best-effort — never throws into
 * the scraping cron (a monitoring failure must not break the scrape loop).
 */
export async function escalateScraperFailureIfNeeded(
  supabase: SupabaseClient,
  params: { brokerageId: string | null | undefined; scraperType: string; errorMessage?: string | null },
): Promise<{ escalated: boolean; reason?: string }> {
  const { brokerageId, scraperType, errorMessage } = params
  if (!brokerageId || !scraperType) return { escalated: false, reason: "missing brokerage/scraper" }
  try {
    const { data } = await supabase
      .from("scraper_executions")
      .select("status")
      .eq("brokerage_id", brokerageId)
      .eq("scraper_type", scraperType)
      .order("started_at", { ascending: false })
      .limit(SCRAPER_FAILURE_THRESHOLD)

    const statuses = ((data ?? []) as Array<{ status: string | null }>).map((r) => r.status)
    if (!shouldEscalateScraperFailure(statuses)) return { escalated: false, reason: "below threshold" }

    const res = await publishManagerSignal(
      {
        brokerageId,
        fromManager: "campaign_orchestrator",
        toManager: "data_steward",
        signalType: "scraper_source_failed",
        message: `Lead scraping source "${scraperType}" has failed ${SCRAPER_FAILURE_THRESHOLD} times in a row${errorMessage ? ` (last error: ${errorMessage})` : ""}. The lead funnel from this source has stopped.`,
        entityType: "scraper_source",
        entityId: scraperType,
        payload: { scraperType, consecutiveFailures: SCRAPER_FAILURE_THRESHOLD, lastError: errorMessage ?? null },
      },
      supabase,
    )
    return { escalated: res.ok, reason: res.reason }
  } catch (e) {
    return { escalated: false, reason: `monitor error: ${(e as Error).message}` }
  }
}
