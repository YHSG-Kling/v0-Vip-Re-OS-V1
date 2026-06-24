// lib/lead-pipeline/scraper-health.ts
// ─────────────────────────────────────────────────────────────────────────────
// SCRAPER INGESTION HEALTH — the Data Steward's ownership of the SCRAPING half of
// the spine. Raw scraping is PLATFORM-owned (raw_scraped_leads.brokerage_id is NULL
// until the promotion gate resolves the territory's brokerage), so a scraper outage
// is a PLATFORM concern, not a per-brokerage one.
//
// When a scheduled scrape fails to connect (network / 403 / timeout / actor down) the
// failure was recorded to scraper_executions then ORPHANED. Now, on the Nth
// CONSECUTIVE platform-wide failure for a source, the Data Steward hands the problem
// to its self-contained fixer — the connector-healer (proposeConnectorHealing):
// AI-diagnose → the auto-applier self-fixes the SAFE cases (actor rotation, key
// rotation) AUTONOMOUSLY, and escalates everything else to PLATFORM STAFF
// (superadmin/support) for review. The Steward self-fixes; the platform admin only
// handles what can't be auto-fixed.
//
// Deduped so a flapping source doesn't spawn a proposal per execution: skip when a
// pending heal proposal for the connector already exists in the last 24h.

import type { SupabaseClient } from "@supabase/supabase-js"
import type { FailureSample } from "@/lib/agentic-os/connector-healer"

/** Consecutive failures before a source's outage is handed to the self-healer. */
export const SCRAPER_FAILURE_THRESHOLD = 3

/** scraper_executions.scraper_type → the CONNECTOR_REGISTRY connector the healer fixes.
 *  Only the sources that actually track executions appear here. */
const SCRAPER_CONNECTOR: Record<string, string> = {
  zillow_behavior:     "zenrows",
  batchdata_motivated: "batchdata",
  social_intent:       "apify",
}

export function scraperTypeToConnector(scraperType: string): string | null {
  return SCRAPER_CONNECTOR[scraperType] ?? null
}

/**
 * shouldEscalateScraperFailure — PURE. Hand to the healer only when the most recent
 * `threshold` executions are ALL failures (a sustained outage), so a single transient
 * blip never triggers a heal. `statuses` is ordered MOST-RECENT-FIRST.
 */
export function shouldEscalateScraperFailure(
  statusesMostRecentFirst: Array<string | null>,
  threshold: number = SCRAPER_FAILURE_THRESHOLD,
): boolean {
  if (statusesMostRecentFirst.length < threshold) return false
  return statusesMostRecentFirst.slice(0, threshold).every((s) => s === "failed")
}

// Injectable self-heal seam (default = the real connector-healer). Lets the simulator
// drive the loop deterministically without a live AI/Exa call.
export type ScraperHealer = (params: { connector: string; failures: FailureSample[] }) => Promise<{ proposalId: string | null }>
let healerImpl: ScraperHealer | null = null
export function setScraperHealer(fn: ScraperHealer | null): void { healerImpl = fn }

async function runHealer(params: { connector: string; failures: FailureSample[] }): Promise<{ proposalId: string | null }> {
  if (healerImpl) return healerImpl(params)
  const { proposeConnectorHealing } = await import("@/lib/agentic-os/connector-healer")
  const res = await proposeConnectorHealing({ connector: params.connector, failures: params.failures })
  return { proposalId: res.proposal?.id ?? null }
}

/**
 * escalateScraperFailureIfNeeded — read the last N PLATFORM-WIDE executions for this
 * scraper_type; if they are all failures, hand the source's connector to the
 * self-healer (autonomous fix → platform-admin escalation). Deduped on an open heal
 * proposal. Best-effort — never throws into the scraping cron.
 */
export async function escalateScraperFailureIfNeeded(
  supabase: SupabaseClient,
  params: { scraperType: string; errorMessage?: string | null; nowMs?: number },
): Promise<{ escalated: boolean; connector?: string; reason?: string }> {
  const { scraperType, errorMessage } = params
  const connector = scraperTypeToConnector(scraperType)
  if (!connector) return { escalated: false, reason: "untracked source" }
  try {
    // Platform-wide consecutive-failure detection (raw scraping is platform-owned).
    const { data } = await supabase
      .from("scraper_executions")
      .select("status")
      .eq("scraper_type", scraperType)
      .order("started_at", { ascending: false })
      .limit(SCRAPER_FAILURE_THRESHOLD)

    const statuses = ((data ?? []) as Array<{ status: string | null }>).map((r) => r.status)
    if (!shouldEscalateScraperFailure(statuses)) return { escalated: false, connector, reason: "below threshold" }

    // Dedup: the healer (or the connector-health cron) is already on it.
    const nowMs = params.nowMs ?? Date.now()
    const since = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString()
    const { data: pending } = await supabase
      .from("connector_healing_proposals")
      .select("id")
      .eq("connector", connector)
      .eq("status", "pending")
      .gte("detected_at", since)
      .limit(1)
      .maybeSingle()
    if (pending) return { escalated: false, connector, reason: "heal already pending" }

    const res = await runHealer({
      connector,
      failures: [{ status: null, path: scraperType, error: errorMessage ?? "scrape connection failed" }],
    })
    return { escalated: true, connector, reason: res.proposalId ? `heal proposed (${res.proposalId})` : "healer ran" }
  } catch (e) {
    return { escalated: false, connector, reason: `monitor error: ${(e as Error).message}` }
  }
}
