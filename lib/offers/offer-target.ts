// lib/offers/offer-target.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE helpers that turn a buyer's real signals into the inputs the offer-strategy brain
// needs: WHICH property the buyer is about to offer on (their hot target), and how to map
// the buyer's situation (saved-property recency, days-on-market, pre-approval, motivation)
// into the strategy advisor's parameters. No I/O — the producer resolves the rows; these
// decide. Testable in isolation, no fabrication (honest nulls when a signal is absent).

export interface SavedPropertyRow {
  listing_id: string | null
  saved_at: string | null
  dismissed: boolean | null
  /** Joined from listings — the real list price + listing date the strategy is grounded in. */
  list_price?: number | null
  listing_date?: string | null
  status?: string | null
}

export interface BuyerTarget {
  listingId: string
  listPrice: number
  daysOnMarket: number
}

/** PURE. Days-on-market from the listing's real list date (whole days, never negative). 0 when
 *  no date is on file — honest, not fabricated. `now` injectable for deterministic tests. */
export function domFromListingDate(listingDate: string | null | undefined, now: Date): number {
  if (!listingDate) return 0
  const t = new Date(listingDate).getTime()
  if (Number.isNaN(t)) return 0
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000))
}

/**
 * pickBuyerTargetListing — PURE. The single property a buyer is most likely about to offer on:
 * the most-recently-saved, NON-dismissed, still-active listing that has a real list price.
 * Returns null when there's no usable target (honest — no fabricated property). `now` injectable.
 */
export function pickBuyerTargetListing(rows: SavedPropertyRow[] | null | undefined, now: Date): BuyerTarget | null {
  const usable = (rows ?? []).filter(
    (r) =>
      !!r.listing_id &&
      r.dismissed !== true &&
      (r.status == null || r.status === "active") &&
      typeof r.list_price === "number" &&
      (r.list_price ?? 0) > 0,
  )
  if (usable.length === 0) return null
  // Most recently saved first (the freshest intent).
  usable.sort((a, b) => {
    const ta = a.saved_at ? new Date(a.saved_at).getTime() : 0
    const tb = b.saved_at ? new Date(b.saved_at).getTime() : 0
    return tb - ta
  })
  const top = usable[0]
  return {
    listingId: top.listing_id as string,
    listPrice: top.list_price as number,
    daysOnMarket: domFromListingDate(top.listing_date, now),
  }
}

/** PURE. Map a buyer's stored timeline/motivation hint to the advisor's motivation enum. */
export function motivationFromBuyer(
  input: { timeline?: string | null; motivation_type?: string | null; buyer_stage?: string | null },
): "must_have" | "would_like" | "nice_to_have" {
  const t = `${input.timeline ?? ""} ${input.motivation_type ?? ""} ${input.buyer_stage ?? ""}`.toLowerCase()
  if (/asap|immediate|urgent|0-3|under 3|offer|ready|relocat|must/.test(t)) return "must_have"
  if (/browsing|someday|exploring|just looking|no rush|nice/.test(t)) return "nice_to_have"
  return "would_like"
}

/** PURE. Days-on-market is the cleanest market-heat proxy we can ground without fabrication:
 *  a fast-moving listing (low DOM) reads HOT, a long-sitting one reads COOLING. */
export function marketConditionsFromDom(daysOnMarket: number): "hot" | "balanced" | "cooling" {
  if (daysOnMarket <= 14) return "hot"
  if (daysOnMarket >= 60) return "cooling"
  return "balanced"
}

/** PURE. The buyer's max budget for the advisor — pre-approval amount when present, else a
 *  conservative ceiling derived from the list price (never above ~110% of list without a real
 *  pre-approval signal). Returns null when neither is usable (caller skips the numeric plan). */
export function resolveBuyerMaxBudget(
  preApprovalAmount: number | null | undefined,
  listPrice: number,
): number | null {
  if (typeof preApprovalAmount === "number" && preApprovalAmount > 0) return preApprovalAmount
  if (listPrice > 0) return Math.round(listPrice * 1.1)
  return null
}
