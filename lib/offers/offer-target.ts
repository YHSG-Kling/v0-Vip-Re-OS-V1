// lib/offers/offer-target.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE helpers that turn a buyer's real signals into the inputs the offer-strategy brain
// needs: WHICH property the buyer is about to offer on (their hot target), and how to map
// the buyer's situation (saved-property recency, days-on-market, pre-approval, motivation)
// into the strategy advisor's parameters. No I/O — the producer resolves the rows; these
// decide. Testable in isolation, no fabrication (honest nulls when a signal is absent).

export interface SavedPropertyRow {
  /** In-house listings.id (null for an external RentCast/IDX saved reference). */
  listing_id: string | null
  /** External provider id (RentCast/IDX) — present only for external saved references. */
  external_property_id?: string | null
  /** 'rentcast' | 'idx' for external; null/other for in-house saves. */
  source?: string | null
  /** The factual price stored on the saved_properties row itself (set for external refs, and
   *  often for in-house) — OR the producer coalesces in the joined in-house listings.list_price. */
  list_price?: number | null
  /** The external/source listing URL (the buyer's deep link back to the property). */
  listing_url?: string | null
  property_address?: string | null
  saved_at: string | null
  dismissed: boolean | null
  /** Joined from in-house listings only — drives DOM. Null for external (we don't store the
   *  external listing, only its specs), in which case DOM is honestly unknown. */
  listing_date?: string | null
  status?: string | null
}

export interface BuyerTarget {
  /** In-house listings.id when in-house; the external_property_id when external. */
  targetId: string
  listPrice: number
  /** Whole days on market, or null when unknown (external refs — we don't store their list date). */
  daysOnMarket: number | null
  isExternal: boolean
  listingUrl: string | null
  address: string | null
}

/** PURE. Days-on-market from the listing's real list date (whole days, never negative). null when
 *  no date is on file — honest, not a fabricated "brand new." `now` injectable for tests. */
export function domFromListingDate(listingDate: string | null | undefined, now: Date): number | null {
  if (!listingDate) return null
  const t = new Date(listingDate).getTime()
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000))
}

/**
 * pickBuyerTargetListing — PURE. The single property a buyer is most likely about to offer on:
 * the most-recently-saved, NON-dismissed, still-active reference with a real list price —
 * IN-HOUSE (listing_id) OR EXTERNAL (RentCast/IDX, external_property_id + stored specs). Most
 * buyers shop the whole market, so external targets matter most. Returns null when no usable
 * target (honest — no fabricated property). `now` injectable.
 */
export function pickBuyerTargetListing(rows: SavedPropertyRow[] | null | undefined, now: Date): BuyerTarget | null {
  const usable = (rows ?? []).filter(
    (r) =>
      (!!r.listing_id || !!r.external_property_id) &&
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
  const isExternal = !top.listing_id && !!top.external_property_id
  return {
    targetId: (top.listing_id ?? top.external_property_id) as string,
    listPrice: top.list_price as number,
    daysOnMarket: domFromListingDate(top.listing_date, now), // null for external (unknown)
    isExternal,
    listingUrl: top.listing_url ?? null,
    address: top.property_address ?? null,
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
 *  a fast-moving listing (low DOM) reads HOT, a long-sitting one reads COOLING. Unknown DOM
 *  (null — e.g. an external ref we don't store the list date for) reads BALANCED, never a
 *  fabricated "hot." */
export function marketConditionsFromDom(daysOnMarket: number | null): "hot" | "balanced" | "cooling" {
  if (daysOnMarket == null) return "balanced"
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
