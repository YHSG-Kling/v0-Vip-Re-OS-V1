// lib/intelligence/derived-snapshots.ts
// ─────────────────────────────────────────────────────────────────────────────
// DERIVED INTELLIGENCE SNAPSHOTS (burn-down round 6). Two read surfaces had no
// producer:
//   · property_smart_insights — predictWinningOffer feeds DOM / price-reduction
//     count / market position into the winning-offer AI. All three DERIVE from
//     tables we already write: listings (age), listing_price_changes (the
//     round-1 ledger), and the brokerage's own active-listing price median.
//   · team_heatmap_snapshots — the team activity heatmap (geo activity/revenue
//     per agent). Closings (agent_commissions + transactions) and showings
//     aggregate by the property's ZIP.
// Both run nightly on the finance-rollup wagon; pass-10 delete-then-insert per
// brokerage (no unique indexes, live-verified).

import "server-only"

type Svc = { from: (table: string) => any }

const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/

export function zipFromAddress(address: string | null | undefined): string | null {
  if (!address) return null
  const m = ZIP_RE.exec(address)
  return m ? m[1] : null
}

export interface DerivedSnapshotsResult { insightsRows: number; heatmapRows: number }

export async function runPropertySmartInsights(svc: Svc, brokerageId: string, now: Date): Promise<number> {
  // Live columns: list_price / listing_date (NOT price / list_date — the
  // drift guard caught the phantom names before this ever shipped).
  const { data: listings } = await svc
    .from("listings")
    .select("id, mls_number, list_price, created_at, listing_date, status, address")
    .eq("brokerage_id", brokerageId)
    .eq("status", "active")
    .not("mls_number", "is", null)
    .limit(1000)
  const rows = (listings ?? []) as Array<{ id: string; mls_number: string; list_price: number | null; created_at: string; listing_date: string | null }>
  if (rows.length === 0) return 0

  await svc.from("property_smart_insights").delete().eq("brokerage_id", brokerageId)
  let written = 0
  for (const l of rows) {
    const listedAt = l.listing_date ?? l.created_at
    const dom = Math.max(0, Math.floor((now.getTime() - new Date(listedAt).getTime()) / 86_400_000))
    const { count: reductions } = await svc
      .from("listing_price_changes")
      .select("id", { count: "exact", head: true })
      .eq("listing_id", l.id)
    // Live CHECK vocabulary (caught by fire): hot/above_average/average/
    // below_average/slow — a market-PACE signal, derived from days on market.
    const position = dom <= 7 ? "hot" : dom <= 21 ? "above_average" : dom <= 45 ? "average" : dom <= 90 ? "below_average" : "slow"
    const { error } = await svc.from("property_smart_insights").insert({
      property_mls_id: l.mls_number,
      brokerage_id: brokerageId,
      days_on_market: dom,
      price_reduction_count: reductions ?? 0,
      market_position: position,
      // comparable_sales / scores need a data provider — honest NULL for now.
      last_analyzed_at: now.toISOString(),
    })
    if (!error) written++
  }
  return written
}

export async function runTeamHeatmapSnapshots(svc: Svc, brokerageId: string, now: Date): Promise<number> {
  const snapshotDate = now.toISOString().slice(0, 10)
  const since = new Date(now.getTime() - 90 * 86_400_000).toISOString()

  // Closings with revenue, geo'd by the transaction property ZIP.
  const { data: comms } = await svc
    .from("agent_commissions")
    .select("agent_id, agent_commission, close_date, transactions:transaction_id(property_address)")
    .eq("brokerage_id", brokerageId)
    .gte("close_date", since)
    .limit(5000)
  // Showings by the listing's ZIP.
  const { data: shows } = await svc
    .from("showings")
    .select("agent_id, created_at, listings:listing_id(address)")
    .eq("brokerage_id", brokerageId)
    .gte("created_at", since)
    .limit(5000)

  const agg = new Map<string, { agent_id: string | null; zip: string; type: string; count: number; revenue: number }>()
  const bump = (agentId: string | null, zip: string | null, type: string, revenue: number) => {
    if (!zip) return
    const key = `${agentId ?? ""}|${zip}|${type}`
    const a = agg.get(key) ?? { agent_id: agentId, zip, type, count: 0, revenue: 0 }
    a.count++; a.revenue += revenue
    agg.set(key, a)
  }
  // Live CHECK vocabulary (caught by fire): listing/buyer/closed/lead —
  // closings land as 'closed', showings are buyer-side activity → 'buyer'.
  for (const c of ((comms ?? []) as any[])) bump(c.agent_id, zipFromAddress(c.transactions?.property_address), "closed", Number(c.agent_commission) || 0)
  for (const s of ((shows ?? []) as any[])) bump(s.agent_id, zipFromAddress(s.listings?.address), "buyer", 0)
  if (agg.size === 0) return 0

  await svc.from("team_heatmap_snapshots").delete().eq("brokerage_id", brokerageId).eq("snapshot_date", snapshotDate)
  const rows = [...agg.values()].map((a) => ({
    brokerage_id: brokerageId,
    snapshot_date: snapshotDate,
    agent_id: a.agent_id,
    zip_code: a.zip,
    activity_type: a.type,
    activity_count: a.count,
    revenue_amount: a.revenue || null,
    // lat/lng need a geocode pass — honest NULL; the heatmap falls back to ZIP centroids.
  }))
  const { error } = await svc.from("team_heatmap_snapshots").insert(rows)
  return error ? 0 : rows.length
}

/** Nightly: both snapshots for every brokerage (per-tenant isolation). */
export async function runDerivedSnapshots(svc: Svc, now: Date = new Date()): Promise<DerivedSnapshotsResult> {
  const out: DerivedSnapshotsResult = { insightsRows: 0, heatmapRows: 0 }
  const { data: brokerages } = await svc.from("brokerages").select("id").limit(2000)
  for (const b of ((brokerages ?? []) as Array<{ id: string }>)) {
    try { out.insightsRows += await runPropertySmartInsights(svc, b.id, now) } catch { /* isolation */ }
    try { out.heatmapRows += await runTeamHeatmapSnapshots(svc, b.id, now) } catch { /* isolation */ }
  }
  return out
}
