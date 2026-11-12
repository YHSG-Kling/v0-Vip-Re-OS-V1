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
  /**
   * TENANT ANCHOR. When set, only that brokerage's raw rows are rolled up.
   *
   * Added when this was wired to its first caller (the admin Scrape
   * Diagnostics page). This runs on the SERVICE client, which bypasses RLS, so
   * without a predicate here every caller gets a PLATFORM-WIDE aggregate —
   * fine for platform staff, wrong for a brokerage admin. The caller decides:
   * pass the brokerage for a tenant view, omit it only from a platform-staff
   * surface.
   */
  brokerageId?: string | null
}): Promise<{ stats: IntentPhraseStat[]; error: string | null }> {
  const svc = createServiceClient()
  const sinceDays = Math.max(1, Math.min(365, opts?.sinceDays ?? 60))
  const limit     = Math.max(1, Math.min(500, opts?.limit ?? 100))
  const minSupport = Math.max(1, opts?.minSupport ?? 3)
  const sinceIso = new Date(Date.now() - sinceDays * 86400_000).toISOString()

  // Pull recent raw rows with their intent.matched phrases + a promotion flag (lead_id is set when
  // the row was promoted to a lead). Then aggregate in-memory — the dataset is bounded by the
  // scraping cron's per-day cap, easily fits in a single round-trip.
  let rawQuery = svc
    .from("raw_scraped_leads")
    .select("id, lead_id, brokerage_id, created_at, normalized_preview")
    .gte("created_at", sinceIso)
  if (opts?.brokerageId) rawQuery = rawQuery.eq("brokerage_id", opts.brokerageId)
  const { data: rows, error } = await rawQuery.limit(20_000)
  if (error) return { stats: [], error: error.message }

  // Which of those lead_ids became a contact? contact-creator stamps `notes` with
  // "Promoted from lead <leadId>". Building a single PostgREST `.or()` over up to 20k UUIDs would
  // blow the URL length AND interpolating raw ids into the `.or()` grammar is unsafe. Instead:
  // pull every contact whose `source` is one of the lead-conversion buckets within the same
  // window, parse the embedded lead-uuid out of `notes` locally, and intersect with the leadIds
  // set we already have in memory.
  const leadIds = new Set<string>(
    (rows ?? []).map(r => r.lead_id as string | null).filter((x): x is string => !!x),
  )
  // tenant anchor (scope burn-down): the contact probe is limited to the
  // brokerages that own the raw rows we're rolling up — never a platform-wide
  // contacts scan. Raw rows without a tenant can't have promoted contacts.
  const brokerageIds = [...new Set(
    (rows ?? []).map(r => (r as { brokerage_id?: string | null }).brokerage_id ?? null).filter((x): x is string => !!x),
  )]
  const contactByLeadId = new Map<string, boolean>()
  if (leadIds.size > 0 && brokerageIds.length > 0) {
    const { data: contacts } = await svc
      .from("contacts")
      .select("id, source, notes, created_at")
      .in("brokerage_id", brokerageIds)
      .in("source", ["lead_promotion", "lead_import", "lead_conversion", "crm_import"])
      .gte("created_at", sinceIso)
      .limit(20_000)
    const NOTES_LEAD_RE = /Promoted from lead ([0-9a-f-]{32,36})/i
    for (const c of contacts ?? []) {
      const m = NOTES_LEAD_RE.exec(((c as any).notes as string | null) ?? "")
      if (m && leadIds.has(m[1])) contactByLeadId.set(m[1], true)
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
