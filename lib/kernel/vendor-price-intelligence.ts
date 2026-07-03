// lib/kernel/vendor-price-intelligence.ts
//
// VENDOR PRICE INTELLIGENCE (deal_coordinator) — the marketplace watches its own COST. Every vendor
// booking carries a real cost; this benchmarks each vendor's average against the category's median across
// the brokerage's bench and flags the ones charging materially more than their peers, so the broker can
// negotiate or switch — money the marketplace was quietly leaking. Pure + honest: a vendor is only flagged
// when there are enough peers to form a real median AND enough of the vendor's own bookings to be fair
// (thin data is never a verdict).

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** A vendor needs at least this many priced bookings before its average is fair to benchmark. */
export const MIN_VENDOR_SAMPLES = 3
/** A category needs at least this many vendors before a median is a meaningful peer benchmark. */
export const MIN_CATEGORY_VENDORS = 3
/** Flag a vendor charging at least this % above the category median. */
export const OVERPRICE_PCT = 20

export interface PricedBooking { vendorId: string; category: string | null; cost: number | null }

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 100) / 100
}

export interface OverpricedVendor {
  vendorId: string
  category: string
  avgCost: number
  categoryMedian: number
  pctAbove: number
  samples: number
}

/**
 * PURE: benchmark each vendor's average cost against the median vendor-average in its category, and flag
 * those charging OVERPRICE_PCT+ above it. Honest gating: MIN_VENDOR_SAMPLES per vendor + MIN_CATEGORY_VENDORS
 * peers before anything is flagged. Returns the overpriced vendors, worst (highest % above) first.
 */
export function flagOverpricedVendors(bookings: PricedBooking[], opts: { minSamples?: number; minCategoryVendors?: number; overpricePct?: number } = {}): OverpricedVendor[] {
  const minSamples = opts.minSamples ?? MIN_VENDOR_SAMPLES
  const minCategoryVendors = opts.minCategoryVendors ?? MIN_CATEGORY_VENDORS
  const overprice = opts.overpricePct ?? OVERPRICE_PCT

  // Average cost per (vendor, category) over priced bookings.
  const acc = new Map<string, { vendorId: string; category: string; costs: number[] }>()
  for (const b of bookings) {
    if (!b.vendorId || !b.category || !(Number(b.cost) > 0)) continue
    const key = `${b.vendorId}|${b.category}`
    const e = acc.get(key) ?? { vendorId: b.vendorId, category: b.category, costs: [] }
    e.costs.push(Number(b.cost)); acc.set(key, e)
  }
  const vendorAvgs = Array.from(acc.values())
    .filter((v) => v.costs.length >= minSamples)
    .map((v) => ({ vendorId: v.vendorId, category: v.category, avgCost: Math.round((v.costs.reduce((a, c) => a + c, 0) / v.costs.length) * 100) / 100, samples: v.costs.length }))

  // Category median of the vendor-averages (needs enough peer vendors).
  const byCategory = new Map<string, number[]>()
  for (const v of vendorAvgs) { const arr = byCategory.get(v.category) ?? []; arr.push(v.avgCost); byCategory.set(v.category, arr) }

  const out: OverpricedVendor[] = []
  for (const v of vendorAvgs) {
    const peers = byCategory.get(v.category) ?? []
    if (peers.length < minCategoryVendors) continue
    const med = median(peers)
    if (med <= 0) continue
    const pctAbove = Math.round(((v.avgCost - med) / med) * 100)
    if (pctAbove >= overprice) out.push({ vendorId: v.vendorId, category: v.category, avgCost: v.avgCost, categoryMedian: med, pctAbove, samples: v.samples })
  }
  return out.sort((a, b) => b.pctAbove - a.pctAbove)
}

export interface PriceIntelResult { vendorsBenchmarked: number; overpriced: number; briefProposed: boolean }

/** Benchmark a brokerage's vendor pricing and propose a gated brief on overpriced vendors. Best-effort. */
export async function runVendorPriceIntelligence(svc: Svc, params: { brokerageId: string; now?: Date }): Promise<PriceIntelResult> {
  const out: PriceIntelResult = { vendorsBenchmarked: 0, overpriced: 0, briefProposed: false }
  const now = params.now ?? new Date()

  const { data: vendors } = await svc.from("vendors").select("id, name, category").eq("brokerage_id", params.brokerageId).limit(2000)
  const catById = new Map<string, string | null>(((vendors ?? []) as any[]).map((v) => [v.id, v.category]))
  const nameById = new Map<string, string | null>(((vendors ?? []) as any[]).map((v) => [v.id, v.name]))
  if (catById.size === 0) return out

  const { data: bookings } = await svc.from("vendor_bookings").select("vendor_id, cost").eq("brokerage_id", params.brokerageId).not("cost", "is", null).gt("cost", 0).limit(20000)
  const priced: PricedBooking[] = ((bookings ?? []) as any[]).map((b) => ({ vendorId: b.vendor_id, category: catById.get(b.vendor_id) ?? null, cost: b.cost }))
  const overpriced = flagOverpricedVendors(priced)
  out.vendorsBenchmarked = new Set(priced.map((p) => p.vendorId)).size
  out.overpriced = overpriced.length
  if (overpriced.length === 0) return out

  const { isoWeekKey } = await import("@/lib/recruiting/switch-propensity-scout")
  const dedupeTag = `VENDOR PRICING — ${isoWeekKey(now)}`
  const { data: prior } = await svc.from("agent_client_messages").select("id")
    .eq("brokerage_id", params.brokerageId).eq("entity_type", "brokerage").eq("entity_id", params.brokerageId)
    .eq("agent_kind", "deal_coordinator").ilike("rationale", `${dedupeTag}%`).limit(1).maybeSingle()
  if (prior) return out

  const lines = [
    `Some of your vendors are charging well above their category peers — worth a negotiation or a switch:`,
    ...overpriced.slice(0, 6).map((o) => `• ${nameById.get(o.vendorId) ?? "A vendor"} (${o.category}) averages $${Math.round(o.avgCost).toLocaleString()} — ${o.pctAbove}% above the category median of $${Math.round(o.categoryMedian).toLocaleString()}.`),
    `Negotiating these down, or moving volume to a fairly-priced peer, is money straight back to your deals.`,
  ]
  try {
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: params.brokerageId, agentKind: "deal_coordinator", entityType: "brokerage", entityId: params.brokerageId,
      recipientContactId: null, audience: "agent",
      subject: `${overpriced.length} vendor${overpriced.length === 1 ? "" : "s"} pricing above peers`,
      body: lines.join("\n\n"),
      rationale: `${dedupeTag} — ${overpriced.length} overpriced; review before it reaches the broker.`,
      channel: "portal",
    }, svc)
    out.briefProposed = res.ok
  } catch { /* best-effort */ }
  return out
}

/** Autonomous: benchmark every brokerage's vendor pricing (rides the daily vendor-orchestration cron). */
export async function runVendorPriceIntelligenceAll(svc: Svc, now?: Date): Promise<{ brokerages: number; overpriced: number; briefs: number }> {
  const out = { brokerages: 0, overpriced: 0, briefs: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runVendorPriceIntelligence(svc, { brokerageId: b.id, now }); out.overpriced += r.overpriced; if (r.briefProposed) out.briefs++ } catch { /* keep going */ }
  }
  return out
}
