// lib/lead-pipeline/promotion-gate-health.ts
// ─────────────────────────────────────────────────────────────────────────────
// PROMOTION-GATE HEALTH — the Data Steward's watch over raw records that can NEVER
// become leads.
//
// The daily re-enrich sweep retries stranded raw records (insufficient identity /
// contact data) — but ONLY while promotion_attempts < MAX_PROMOTION_ATTEMPTS. Once a
// record hits the cap it is dropped from the sweep: never retried, never surfaced,
// silently accumulating in raw_scraped_leads forever. territory_mismatch records
// (scraped for an area no active brokerage owns) are never retried at all — a
// scraping-territory CONFIG drift no one is told about.
//
// Raw scraping is PLATFORM-owned, so the Data Steward reports both to PLATFORM STAFF
// (superadmin/support) — once per day (deduped) — so they can improve enrichment
// coverage, fix the scraping territory config, or purge dead weight. The cap +
// stranded-status vocabulary lives HERE so the cron sweep and this monitor can't drift.

import type { SupabaseClient } from "@supabase/supabase-js"
import { notifyPlatformStaff } from "@/lib/notifications/platform-staff"

/** Max promotion attempts before a stranded raw record is abandoned by the re-enrich sweep. */
export const MAX_PROMOTION_ATTEMPTS = 10

/** Stranded statuses the re-enrich sweep retries (identity/contact data may arrive later). */
export const STRANDED_STATUSES = [
  "insufficient_identity_for_promotion",
  "insufficient_identity",
  "insufficient_contact_data",
] as const

/** PURE: a record is permanently stuck when it's stranded AND has exhausted its retries. */
export function isPermanentlyStuck(row: {
  processing_status: string | null
  promotion_attempts: number | null
}): boolean {
  return (
    (STRANDED_STATUSES as readonly string[]).includes(row.processing_status ?? "") &&
    (row.promotion_attempts ?? 0) >= MAX_PROMOTION_ATTEMPTS
  )
}

export interface StuckRawLeadReport {
  stuckCount: number
  territoryMismatchCount: number
  notified: number
  reason?: string
  /** Per-source breakdown of the cap-exhausted stranded rows — which scraper source
   *  keeps producing unenrichable records, for the platform-staff alert copy. */
  bySource?: Array<{ source: string; count: number }>
}

/** Bound on how many stranded candidate rows a single report pass inspects — a
 *  platform-wide monitor, not a per-tenant one, so this stays generous but finite. */
const STUCK_SCAN_LIMIT = 5000

/**
 * reportStuckRawLeads — find the raw records that can never promote (cap-exhausted
 * stranded + territory_mismatch) and, when any exist, alert platform staff ONCE per
 * day (deduped on a recent raw_leads_stuck notification). Best-effort, never throws.
 *
 * The cap-exhausted count is derived through the SAME pure predicate the cron sweep's
 * gate uses (isPermanentlyStuck) rather than a second inline `.gte()` filter — merged
 * onto this ONE vocabulary (CLAUDE.md §6) so "stuck" can never mean two different
 * things between the predicate and this monitor.
 */
export async function reportStuckRawLeads(
  supabase: SupabaseClient,
  opts?: { nowMs?: number },
): Promise<StuckRawLeadReport> {
  try {
    // Candidate rows: every STRANDED-status row (the cap check runs in JS through
    // isPermanentlyStuck, not a duplicate DB-side `.gte()`).
    const { data: strandedRows } = await supabase
      .from("raw_scraped_leads")
      .select("id, source, processing_status, promotion_attempts")
      .in("processing_status", STRANDED_STATUSES as unknown as string[])
      .limit(STUCK_SCAN_LIMIT)

    const stuckRows = ((strandedRows ?? []) as Array<{
      id: string; source: string | null; processing_status: string | null; promotion_attempts: number | null
    }>).filter(isPermanentlyStuck)

    const bySourceMap = new Map<string, number>()
    for (const r of stuckRows) {
      const key = r.source ?? "unknown"
      bySourceMap.set(key, (bySourceMap.get(key) ?? 0) + 1)
    }
    const bySource = [...bySourceMap.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count)

    const { count: tmCount } = await supabase
      .from("raw_scraped_leads")
      .select("id", { count: "exact", head: true })
      .eq("processing_status", "territory_mismatch")

    const stuck = stuckRows.length
    const tm = tmCount ?? 0
    if (stuck === 0 && tm === 0) return { stuckCount: 0, territoryMismatchCount: 0, notified: 0, reason: "nothing stuck", bySource: [] }

    // Dedup: one platform alert per day.
    const nowMs = opts?.nowMs ?? Date.now()
    const since = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString()
    const { data: recent } = await supabase
      .from("notifications")
      .select("id")
      .eq("type", "raw_leads_stuck")
      .gte("created_at", since)
      .limit(1)
      .maybeSingle()
    if (recent) return { stuckCount: stuck, territoryMismatchCount: tm, notified: 0, reason: "already alerted today", bySource }

    const parts: string[] = []
    if (stuck > 0) {
      const topSources = bySource.slice(0, 5).map((s) => `${s.source} (${s.count})`).join(", ")
      parts.push(`${stuck} record(s) hit the ${MAX_PROMOTION_ATTEMPTS}-attempt promotion cap (unenrichable)${topSources ? ` — top sources: ${topSources}` : ""}`)
    }
    if (tm > 0) parts.push(`${tm} in territory_mismatch (scraped where no active brokerage owns the territory)`)

    const notified = await notifyPlatformStaff(supabase, {
      type: "raw_leads_stuck",
      title: `${stuck + tm} raw lead(s) stuck unpromotable`,
      body: `${parts.join("; ")}. Review enrichment coverage or the scraping territory config, then clear or purge.`,
      entityType: "raw_scraped_leads",
      priority: "medium",
    })
    return { stuckCount: stuck, territoryMismatchCount: tm, notified, bySource }
  } catch (e) {
    return { stuckCount: 0, territoryMismatchCount: 0, notified: 0, reason: `monitor error: ${(e as Error).message}` }
  }
}
