// lib/kernel/seller-listing-timeline.ts
//
// SELLER TIME-TO-LIST — the missing TIME dimension on top of scoreSellerIntent. The radar already
// scores HOW MOTIVATED a homeowner is; this answers WHEN they're likely to list, so the AI ISA
// works the right seller at the RIGHT MOMENT, not just the most motivated. Different distress
// signals carry different, known timelines: pre-foreclosure is a FORCED 30–90 day auction clock;
// probate runs a 6–12 month court timeline; a fresh expired listing is a 0–90 day OPPORTUNITY
// window; FSBO is selling RIGHT NOW. Pure — uses ONLY the signals actually present (never assumes).
//
// This ANNOTATES a scraped candidate (predicted_days_to_list / listing_class) — it does NOT promote
// anything. The canonical gate (listing-inventory-radar → raw_scraped_leads → processRawRecord)
// still decides if a record becomes a lead; a scraped record never skips the gate.

export interface SellerTimelineSignals {
  /** quickLists + intent signals + motivation type + source, joined — matched case-insensitively. */
  tags: string[]
  /** Days since a listing expired/withdrew (recency matters for the opportunity window). */
  expiredDaysAgo?: number | null
  /** Years the owner has held the home. */
  tenureYears?: number | null
  /** Equity percent (0–100). */
  equityPct?: number | null
}

export type ListingClass = "forced" | "active" | "opportunity" | "eventual" | "unknown"

export interface SellerTimeline {
  listingClass: ListingClass
  /** Predicted window to list, in days (low/high). null when no timeline signal is present. */
  windowDaysLow: number | null
  windowDaysHigh: number | null
  /** The single best representative "days to list" (window midpoint) for ranking. */
  predictedDaysToList: number | null
  /** Real reasons only — no fabrication. */
  reasons: string[]
}

function has(tags: string[], ...needles: string[]): boolean {
  const hay = tags.join(" ").toLowerCase()
  return needles.some((n) => hay.includes(n.toLowerCase()))
}

const mid = (lo: number, hi: number) => Math.round((lo + hi) / 2)

/**
 * PURE: predict a seller's time-to-list window from the present signals. Precedence reflects how
 * BINDING each timeline is: a forced auction clock (pre-foreclosure/tax) dominates a court-paced
 * probate, which dominates a discretionary opportunity (expired/divorce), which dominates an
 * "eventual" downsizer. FSBO is an ACTIVE seller (now). Returns unknown when nothing time-bound.
 */
export function computeSellerListingTimeline(s: SellerTimelineSignals): SellerTimeline {
  const reasons: string[] = []
  const out = (listingClass: ListingClass, lo: number, hi: number, reason: string): SellerTimeline => {
    reasons.push(reason)
    return { listingClass, windowDaysLow: lo, windowDaysHigh: hi, predictedDaysToList: mid(lo, hi), reasons }
  }

  // FORCED — auction/sale clock; shortest, most binding.
  if (has(s.tags, "notice-of-sale", "auction")) return out("forced", 14, 45, "notice of sale — forced auction clock")
  if (has(s.tags, "pre_foreclosure", "preforeclosure", "notice-of-default", "notice-of-lis-pendens", "foreclosure")) {
    return out("forced", 30, 90, "pre-foreclosure — forced timeline")
  }
  if (has(s.tags, "tax_lien", "tax-default", "involuntary-lien")) return out("forced", 60, 120, "tax lien — forced resolution window")

  // ACTIVE — already trying to sell right now.
  if (has(s.tags, "fsbo", "for-sale-by-owner")) return out("active", 0, 45, "FSBO — actively selling now")

  // OPPORTUNITY — a discretionary but time-sensitive trigger.
  if (has(s.tags, "expired", "withdrawn", "canceled", "cancelled")) {
    const ago = s.expiredDaysAgo ?? 0
    // Fresh expired = imminent re-list; the window widens as it ages.
    return ago <= 30 ? out("opportunity", 7, 60, "fresh expired listing — imminent re-list")
                     : out("opportunity", 30, 120, "expired listing — re-list opportunity")
  }
  if (has(s.tags, "divorce")) return out("opportunity", 60, 180, "divorce — disposition window")
  if (has(s.tags, "probate", "inherited")) return out("opportunity", 120, 365, "probate/inherited — court-paced disposition")

  // EVENTUAL — high probability, uncertain timing (downsizer / absentee).
  if ((s.equityPct ?? 0) >= 60 && (s.tenureYears ?? 0) >= 12) return out("eventual", 90, 365, "long-tenure + high equity — likely downsizer")
  if (has(s.tags, "absentee", "out-of-state", "vacant", "mailing-address-vacant")) return out("eventual", 90, 365, "absentee/vacant — willing, untimed")

  return { listingClass: "unknown", windowDaysLow: null, windowDaysHigh: null, predictedDaysToList: null, reasons: ["no time-bound signal present"] }
}

/** Rank helper: a lower predictedDaysToList sorts first (work the imminent sellers now).
 *  unknown timelines sort last. */
export function timelineRank(t: SellerTimeline): number {
  return t.predictedDaysToList ?? Number.MAX_SAFE_INTEGER
}
