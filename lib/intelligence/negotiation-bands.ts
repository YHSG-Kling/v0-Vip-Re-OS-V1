// lib/intelligence/negotiation-bands.ts
//
// NEGOTIATION BANDS (deal_coordinator) — closed-deal history turned into the
// number a seller actually asks: "what do homes like mine really accept?"
// Pure math over the brokerage's OWN closed deals (list price vs purchase
// price, ZIP-scoped when the sample allows): median accept-vs-ask %, the
// range, and median contract-to-close days. HONEST by construction: a band
// needs MIN_BAND_SAMPLES closed deals or it reports null (never a fabricated
// market claim — that's also a licensing/advertising exposure); ZIP bands
// fall back to brokerage-wide only when labeled so. Client-facing copy
// follows the charter: substance in everyday words, one clear idea, never a
// wall of numbers, never scary.

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export const MIN_BAND_SAMPLES = 5

export interface ClosedDealRow {
  purchase_price: number | null
  list_price: number | null
  property_address: string | null
  created_at: string | null
  close_date: string | null
}

export interface NegotiationBand {
  scope: "zip" | "brokerage"
  zip: string | null
  sample: number
  /** Median sale-to-list ratio as a % (100 = at ask; 98.5 = 1.5% under). */
  medianSaleToListPct: number
  /** Middle-half range (25th–75th percentile of sale-to-list %). */
  rangePct: [number, number]
  /** Median contract-to-close days (created→close on the closed deal). Null when undatable. */
  medianContractToCloseDays: number | null
}

/** PURE: 5-digit ZIP out of a free-text address (honest null). */
export function zipFromAddress(address: string | null | undefined): string | null {
  const m = /\b(\d{5})(?:-\d{4})?\s*$/.exec((address ?? "").trim())
  return m ? m[1] : null
}

function pct(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b)
  const idx = (s.length - 1) * p
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  return s[lo] + (s[hi] - s[lo]) * (idx - lo)
}

/** PURE: fold closed deals into a band for a scope. Null when the sample is too thin. */
export function computeNegotiationBand(rows: ClosedDealRow[], scope: "zip" | "brokerage", zip: string | null): NegotiationBand | null {
  const ratios: number[] = []
  const closeDays: number[] = []
  for (const r of rows) {
    const lp = Number(r.list_price), pp = Number(r.purchase_price)
    if (!Number.isFinite(lp) || !Number.isFinite(pp) || lp <= 0 || pp <= 0) continue
    const ratio = (pp / lp) * 100
    if (ratio < 50 || ratio > 200) continue // junk rows never poison the median
    ratios.push(ratio)
    if (r.created_at && r.close_date) {
      const d = (new Date(r.close_date).getTime() - new Date(r.created_at).getTime()) / 86_400_000
      if (Number.isFinite(d) && d > 0 && d < 365) closeDays.push(d)
    }
  }
  if (ratios.length < MIN_BAND_SAMPLES) return null
  return {
    scope,
    zip,
    sample: ratios.length,
    medianSaleToListPct: Math.round(pct(ratios, 0.5) * 10) / 10,
    rangePct: [Math.round(pct(ratios, 0.25) * 10) / 10, Math.round(pct(ratios, 0.75) * 10) / 10],
    medianContractToCloseDays: closeDays.length >= MIN_BAND_SAMPLES ? Math.round(pct(closeDays, 0.5)) : null,
  }
}

/** Load the band for a property: its ZIP first, brokerage-wide fallback. */
export async function loadNegotiationBand(svc: Svc, brokerageId: string, propertyAddress: string | null): Promise<NegotiationBand | null> {
  const { data } = await svc.from("transactions")
    .select("purchase_price, close_date, created_at, property_address, listing:listings(list_price)")
    .eq("brokerage_id", brokerageId)
    .eq("status", "closed")
    .not("purchase_price", "is", null)
    .order("close_date", { ascending: false })
    .limit(400)

  const rows: ClosedDealRow[] = ((data ?? []) as any[]).map((t) => {
    const listing = Array.isArray(t.listing) ? t.listing[0] : t.listing
    return {
      purchase_price: t.purchase_price,
      list_price: listing?.list_price ?? null,
      property_address: t.property_address ?? null,
      created_at: t.created_at ?? null,
      close_date: t.close_date ?? null,
    }
  })

  const zip = zipFromAddress(propertyAddress)
  if (zip) {
    const zipBand = computeNegotiationBand(rows.filter((r) => zipFromAddress(r.property_address) === zip), "zip", zip)
    if (zipBand) return zipBand
  }
  return computeNegotiationBand(rows, "brokerage", null)
}

/**
 * PURE: the seller-facing line — charter-calibrated (substance in everyday
 * words, one clear idea, never scary). Null when there is no honest band.
 */
export function composeSellerBandLine(band: NegotiationBand | null): string | null {
  if (!band) return null
  const where = band.scope === "zip" ? `in your ZIP (${band.zip})` : "across our closed sales"
  const at = band.medianSaleToListPct
  const posture = at >= 100
    ? `homes have typically been selling at or a touch above asking (${at}% of list)`
    : `homes have typically been accepting about ${Math.round((100 - at) * 10) / 10}% under asking`
  const close = band.medianContractToCloseDays ? ` Once under contract, most closed in about ${band.medianContractToCloseDays} days.` : ""
  return `Some real context as you weigh this: ${where}, ${posture} — based on ${band.sample} of our own closed sales, not a national average.${close} Your agent will walk you through how this offer compares.`
}
