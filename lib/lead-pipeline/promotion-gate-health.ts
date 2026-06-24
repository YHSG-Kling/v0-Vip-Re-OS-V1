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
}

/**
 * reportStuckRawLeads — count the raw records that can never promote (cap-exhausted
 * stranded + territory_mismatch) and, when any exist, alert platform staff ONCE per
 * day (deduped on a recent raw_leads_stuck notification). Best-effort, never throws.
 */
export async function reportStuckRawLeads(
  supabase: SupabaseClient,
  opts?: { nowMs?: number },
): Promise<StuckRawLeadReport> {
  try {
    const { count: stuckCount } = await supabase
      .from("raw_scraped_leads")
      .select("id", { count: "exact", head: true })
      .in("processing_status", STRANDED_STATUSES as unknown as string[])
      .gte("promotion_attempts", MAX_PROMOTION_ATTEMPTS)

    const { count: tmCount } = await supabase
      .from("raw_scraped_leads")
      .select("id", { count: "exact", head: true })
      .eq("processing_status", "territory_mismatch")

    const stuck = stuckCount ?? 0
    const tm = tmCount ?? 0
    if (stuck === 0 && tm === 0) return { stuckCount: 0, territoryMismatchCount: 0, notified: 0, reason: "nothing stuck" }

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
    if (recent) return { stuckCount: stuck, territoryMismatchCount: tm, notified: 0, reason: "already alerted today" }

    const parts: string[] = []
    if (stuck > 0) parts.push(`${stuck} record(s) hit the ${MAX_PROMOTION_ATTEMPTS}-attempt promotion cap (unenrichable)`)
    if (tm > 0) parts.push(`${tm} in territory_mismatch (scraped where no active brokerage owns the territory)`)

    const notified = await notifyPlatformStaff(supabase, {
      type: "raw_leads_stuck",
      title: `${stuck + tm} raw lead(s) stuck unpromotable`,
      body: `${parts.join("; ")}. Review enrichment coverage or the scraping territory config, then clear or purge.`,
      entityType: "raw_scraped_leads",
      priority: "medium",
    })
    return { stuckCount: stuck, territoryMismatchCount: tm, notified }
  } catch (e) {
    return { stuckCount: 0, territoryMismatchCount: 0, notified: 0, reason: `monitor error: ${(e as Error).message}` }
  }
}
