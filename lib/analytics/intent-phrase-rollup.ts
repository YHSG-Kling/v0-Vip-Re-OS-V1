/**
 * lib/analytics/intent-phrase-rollup.ts
 *
 * Reverse-cohort retargeting: aggregate the `intent.matched` phrases from every raw record that
 * SUCCESSFULLY converted (promoted → contact → first activity) so we can weight future Exa /
 * ZenRows scrape queries toward the phrases that actually produce real leads. Top-performing
 * phrases become the next pull's query bank — the system gets smarter every cycle.
 *
 * Pure-SQL aggregation; no LLM cost. Call from a dashboard widget or the daily scraping cron.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface IntentPhraseStat {
  phrase:          string
  totalRawRecords: number    // how many raw_scraped_leads had this phrase fire
  promotedToLead:  number    // how many of those produced a leads row
  becameContact:   number    // how many of THOSE were promoted to a contact
  conversionRate:  number    // becameContact / totalRawRecords
  lastSeenAt:      string | null
}

export async function rollupIntentPhrases(opts?: {
  /** Lookback window in days. */
  sinceDays?: number
  /** Hard cap on rows returned. */
  limit?:     number
  /** Min total appearances before a phrase makes the cut (filter long-tail noise). */
  minSupport?: number
}): Promise<{ stats: IntentPhraseStat[]; error: string | null }> {
  const svc = createServiceClient()
  const sinceDays = Math.max(1, Math.min(365, opts?.sinceDays ?? 60))
  const limit     = Math.max(1, Math.min(500, opts?.limit ?? 100))
  const minSupport = Math.max(1, opts?.minSupport ?? 3)
  const sinceIso = new Date(Date.now() - sinceDays * 86400_000).toISOString()

  // Pull recent raw rows with their intent.matched phrases + a promotion flag (lead_id is set when
  // the row was promoted to a lead). Then aggregate in-memory — the dataset is bounded by the
  // scraping cron's per-day cap, easily fits in a single round-trip.
  const { data: rows, error } = await svc
    .from("raw_scraped_leads")
    .select("id, lead_id, created_at, normalized_preview")
    .gte("created_at", sinceIso)
    .limit(20_000)
  if (error) return { stats: [], error: error.message }

  // Need contact-conversion: which lead_ids were promoted to contacts. One small query.
  const leadIds = Array.from(new Set((rows ?? []).map(r => r.lead_id as string | null).filter(Boolean))) as string[]
  let contactByLeadId = new Map<string, boolean>()
  if (leadIds.length > 0) {
    const { data: contacts } = await svc
      .from("contacts")
      .select("id, source, notes")
      .or(leadIds.map(id => `notes.ilike.%${id}%`).join(","))
      .limit(5000)
    for (const c of contacts ?? []) {
      // contact-creator stamps `notes` with "Promoted from lead <leadId>" so this match is the
      // existing convention — keeps us off a JSONB join.
      for (const id of leadIds) if ((c.notes as string | null)?.includes(id)) contactByLeadId.set(id, true)
    }
  }

  const agg = new Map<string, IntentPhraseStat>()
  for (const r of rows ?? []) {
    const np = (r.normalized_preview ?? {}) as any
    const matched: unknown[] = Array.isArray(np?.intent?.matched) ? np.intent.matched : []
    const isPromoted = !!r.lead_id
    const isContact  = !!(r.lead_id && contactByLeadId.get(r.lead_id as string))
    for (const raw of matched) {
      const phrase = String(raw ?? "").trim()
      if (!phrase) continue
      const cur = agg.get(phrase) ?? { phrase, totalRawRecords: 0, promotedToLead: 0, becameContact: 0, conversionRate: 0, lastSeenAt: null as string | null }
      cur.totalRawRecords++
      if (isPromoted) cur.promotedToLead++
      if (isContact)  cur.becameContact++
      const ts = r.created_at as string | null
      if (ts && (!cur.lastSeenAt || ts > cur.lastSeenAt)) cur.lastSeenAt = ts
      agg.set(phrase, cur)
    }
  }

  const stats = Array.from(agg.values())
    .filter(s => s.totalRawRecords >= minSupport)
    .map(s => ({ ...s, conversionRate: s.becameContact / Math.max(1, s.totalRawRecords) }))
    .sort((a, b) => b.conversionRate - a.conversionRate || b.becameContact - a.becameContact)
    .slice(0, limit)

  return { stats, error: null }
}
