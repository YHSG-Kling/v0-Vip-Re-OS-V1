// lib/buyer-offers/address-analysis.ts
// ─────────────────────────────────────────────────────────────────────────────
// ADDRESS-DRIVEN BUYER TOOLKIT — a buyer pastes ANY address (a Zillow link, a yard sign, a
// friend's tip) and our tools run on it: estimated value + specs + affordability. No saved
// listing required — the whole market, in our app. This PURE combiner normalizes the free OSINT
// spec lookup + the (cache/Perplexity-first, non-paid) AVM into one honest buyer-facing analysis;
// the UI runs the affordability engine on it. Honest about confidence — never a fabricated number.

export interface AddressLookupShape {
  beds: number | null
  baths: number | null
  sqft: number | null
  propertyType: string | null
  dataConfidence: "high" | "medium" | "low"
}

export interface AvmShape {
  value: number
  confidence: number // 0..1
  source: string
}

export interface AddressAnalysis {
  /** AVM estimated value — the basis for affordability on an off-market home (null when unknown). */
  estimatedValue: number | null
  /** Value range (RentCast low/high) — shown to the buyer instead of a single false-precision number. */
  valueRangeLow: number | null
  valueRangeHigh: number | null
  valueConfidence: number | null
  valueSource: string | null
  beds: number | null
  baths: number | null
  sqft: number | null
  propertyType: string | null
  /** Overall confidence in the pulled data — gates how strongly we present it. */
  dataConfidence: "high" | "medium" | "low"
  /** True when we have a usable value to run the affordability tool on. */
  hasUsableValue: boolean
  /** Honest one-liner the buyer sees about the estimate's nature. */
  estimateNote: string
}

/**
 * buildAddressAnalysis — PURE. Combine the spec lookup + AVM into the buyer-facing analysis. A
 * missing AVM means no usable value (the buyer can still see specs); confidence flows through so
 * the UI can soften a low-confidence estimate. The note always frames it as an estimate the agent
 * confirms — never presented as gospel.
 */
export function buildAddressAnalysis(
  lookup: AddressLookupShape | null,
  avm: AvmShape | null,
  range?: { low: number | null; high: number | null } | null,
): AddressAnalysis {
  const estimatedValue = avm && typeof avm.value === "number" && avm.value > 0 ? Math.round(avm.value) : null
  const valueConfidence = avm ? avm.confidence : null
  const lowConf = (avm?.confidence ?? 0) < 0.5 || (lookup?.dataConfidence ?? "low") === "low"
  return {
    estimatedValue,
    valueRangeLow: estimatedValue != null && typeof range?.low === "number" && range.low > 0 ? Math.round(range.low) : null,
    valueRangeHigh: estimatedValue != null && typeof range?.high === "number" && range.high > 0 ? Math.round(range.high) : null,
    valueConfidence,
    valueSource: avm?.source ?? null,
    beds: lookup?.beds ?? null,
    baths: lookup?.baths ?? null,
    sqft: lookup?.sqft ?? null,
    propertyType: lookup?.propertyType ?? null,
    dataConfidence: lookup?.dataConfidence ?? "low",
    hasUsableValue: estimatedValue != null,
    estimateNote: estimatedValue == null
      ? "We couldn't pull a value estimate for this address — your agent can get you the real numbers."
      : lowConf
      ? "A rough estimate from public data — your agent will confirm the real value and what to offer."
      : "An estimate from current market data — your agent confirms the exact value and offer strategy.",
  }
}
