// lib/lead-pipeline/source-conversion-runner.ts
//
// Makes the Source-Conversion Learner LIVE: aggregates real per-source outcomes from the existing
// source path (leads.source → leads.contact_id = converted; transactions via contact_id = closed)
// + cost_per_record, and folds them through the pure scorer. Read-only, tenant-scoped. The
// recommendation (advisory) is produced by recommendSourceAllocation against enabled_sources.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { scoreSourceConversions, type SourceConversionRow, type ScoredSources } from "./source-conversion-learning"

type Svc = ReturnType<typeof createServiceClient>

/** Load + score per-source conversion performance for a brokerage over a trailing window. */
export async function loadSourceConversions(
  brokerageId: string,
  opts: { sinceDays?: number } = {},
  client?: Svc,
): Promise<ScoredSources> {
  const svc = client ?? createServiceClient()
  const since = new Date(Date.now() - (opts.sinceDays ?? 180) * 86_400_000).toISOString()

  const { data: leads } = await svc.from("leads")
    .select("source, contact_id, cost_per_record")
    .eq("brokerage_id", brokerageId).gte("created_at", since).limit(5000)
  const leadRows = (leads ?? []) as { source: string | null; contact_id: string | null; cost_per_record: number | null }[]
  if (leadRows.length === 0) return { sources: {}, ranked: [] }

  // Which converted contacts reached a closed transaction (+ the revenue).
  const closedByContact = new Map<string, number>()
  const contactIds = leadRows.map((l) => l.contact_id).filter(Boolean) as string[]
  if (contactIds.length > 0) {
    const { data: txns } = await svc.from("transactions")
      .select("contact_id, status, purchase_price")
      .eq("brokerage_id", brokerageId).in("status", ["closed", "completed"]).in("contact_id", contactIds)
    for (const t of (txns ?? []) as { contact_id: string | null; purchase_price: number | null }[]) {
      if (t.contact_id) closedByContact.set(t.contact_id, (closedByContact.get(t.contact_id) ?? 0) + (t.purchase_price ?? 0))
    }
  }

  // Fold per source.
  const agg = new Map<string, SourceConversionRow>()
  for (const l of leadRows) {
    const source = l.source ?? "unknown"
    const row = agg.get(source) ?? { source, leadCount: 0, contactCount: 0, closedCount: 0, revenue: 0, spend: 0 }
    row.leadCount++
    row.spend += l.cost_per_record ?? 0
    if (l.contact_id) {
      row.contactCount++
      const rev = closedByContact.get(l.contact_id)
      if (rev !== undefined) { row.closedCount++; row.revenue += rev }
    }
    agg.set(source, row)
  }

  return scoreSourceConversions([...agg.values()])
}

/**
 * Close the lead-source learning loop: score the brokerage's sources, and for each active market whose
 * enabled set has a CLEAR enable/disable delta (trusted ROI past the floor — never on thin samples),
 * publish a GATED lead_source_waste signal so the team proposes a one-tap reallocation a human approves.
 * Read-only here (the proposal + approval do the writes). Capped + idempotent (dedupe per market).
 */
export async function runSourceReallocationScan(
  brokerageId: string,
  opts: { sinceDays?: number; maxMarkets?: number } = {},
  client?: Svc,
): Promise<{ scanned: number; signalled: number }> {
  if (!brokerageId) return { scanned: 0, signalled: 0 }
  const svc = client ?? createServiceClient()
  const scored = await loadSourceConversions(brokerageId, { sinceDays: opts.sinceDays }, svc)
  if (scored.ranked.length === 0) return { scanned: 0, signalled: 0 }

  const { data: markets } = await svc.from("lead_scraping_markets")
    .select("id, city, state, enabled_sources").eq("brokerage_id", brokerageId).eq("is_active", true)
    .order("priority", { ascending: true }).limit(opts.maxMarkets ?? 25)
  const rows = (markets ?? []) as Array<{ id: string; city: string | null; state: string | null; enabled_sources: string[] | null }>
  if (rows.length === 0) return { scanned: 0, signalled: 0 }

  const { recommendSourceAllocation } = await import("./source-conversion-learning")
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
  let signalled = 0
  for (const m of rows) {
    const rec = recommendSourceAllocation(scored, m.enabled_sources ?? [])
    if (rec.enable.length === 0 && rec.disable.length === 0) continue
    const where = [m.city, m.state].filter(Boolean).join(", ") || "this market"
    const parts: string[] = []
    if (rec.disable.length) parts.push(`turn OFF ${rec.disable.join(", ")} (costing more than they return)`)
    if (rec.enable.length) parts.push(`turn ON ${rec.enable.join(", ")} (proven winners)`)
    const r = await publishManagerSignal({
      brokerageId, fromManager: "data_steward", toManager: "campaign_orchestrator",
      signalType: "lead_source_waste",
      message: `Lead-source learning for ${where}: ${parts.join("; ")}.`,
      entityType: "lead_scraping_market", entityId: m.id,
      payload: { market_id: m.id, enable: rec.enable, disable: rec.disable, reasons: rec.reasons },
    }, svc)
    if (r.ok) signalled++
  }
  return { scanned: rows.length, signalled }
}
