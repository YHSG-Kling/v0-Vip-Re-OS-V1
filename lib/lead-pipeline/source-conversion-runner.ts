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
