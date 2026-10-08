/**
 * lib/cma/customer-facing-guard.ts
 *
 * Wave 39 — enforces the hard business rule: a SUGGESTED LIST PRICE (or any
 * valuation of the seller's own home) is NEVER shown to the customer on a CMA /
 * pre-listing presentation. The agent reveals the price in person; everything
 * dripped to the seller beforehand sells the RELATIONSHIP + the MARKET, never a
 * number.
 *
 * Pure — no DB/network — so it is unit-tested and can be applied at every
 * customer-facing chokepoint (CMA reel inputProps, dripped presentation
 * sections, portal cards, emails).
 *
 *   · findSuggestedPriceLeaks(payload) — compliance ASSERTION: returns the
 *     paths of any leaked subject-price field (numeric). Empty = safe.
 *   · buildSellerSafeCma(presentation)  — returns a seller-safe copy with the
 *     valuation fields nulled, pricing slides removed, and price keys scrubbed.
 */

// Keys that represent a valuation/suggested price OF THE SUBJECT property.
// (Comparable SALE prices are market facts and are allowed — they are keyed
// sale_price/list_price/adjusted_price on comp rows, which are NOT matched here.)
const PRICE_LEAK_KEY_RE =
  /(?:suggested|recommended|optimal|opinion|target|asking)_?(?:list_?)?(?:price|value)|suggestedListPrice|recommendedPrice|estimated_?value(?:_?(?:mid|low|high))?|estimatedValue(?:Mid|Low|High)|estimated_?price|cma_(?:mid|low|high)_value|list_price_recommendation|ai_suggested_price/i

// Slide kinds/types that present the subject valuation.
const PRICING_SLIDE_RE = /value|pric/i

function isMeaningfulPrice(v: unknown): boolean {
  if (typeof v === "number") return v > 0
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,\s]/g, ""))
    return Number.isFinite(n) && n > 0
  }
  return false
}

/**
 * Recursively find customer-visible suggested-price leaks. Returns dot-paths of
 * offending keys whose value is a meaningful price. Empty array = compliant.
 */
export function findSuggestedPriceLeaks(payload: unknown, path = ""): string[] {
  const leaks: string[] = []
  const walk = (node: unknown, p: string) => {
    if (node == null) return
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${p}[${i}]`)); return }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const childPath = p ? `${p}.${k}` : k
        if (PRICE_LEAK_KEY_RE.test(k) && isMeaningfulPrice(v)) leaks.push(childPath)
        walk(v, childPath)
      }
    }
  }
  walk(payload, path)
  return leaks
}

/** Recursively null out any object key matching a subject-price field. */
export function scrubSuggestedPriceKeys<T>(obj: T): T {
  if (obj == null) return obj
  if (Array.isArray(obj)) return obj.map((v) => scrubSuggestedPriceKeys(v)) as unknown as T
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = PRICE_LEAK_KEY_RE.test(k) ? null : scrubSuggestedPriceKeys(v)
    }
    return out as T
  }
  return obj
}

// ── FREE TEXT ───────────────────────────────────────────────────────────────
// findSuggestedPriceLeaks / scrubSuggestedPriceKeys are KEY-based: they protect
// structured payloads. They cannot see a number that arrives inside a STRING —
// and a section/chapter TITLE is exactly that: free text, sometimes AI-written,
// that lands in an email subject line the seller reads before the appointment.
// A title like "Pricing Your Home at $675,000" passes every key-based check.
//
// Deliberately narrow so it never mangles legitimate copy: a $-amount, or a
// bare number carrying an explicit magnitude word (500k, 1.2 million). It does
// NOT touch "3 bed", "1800 sqft" or "45 seconds".
const PRICE_TEXT_RE =
  /\$\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|mm|b|million|thousand|billion)?|\b\d[\d,]*(?:\.\d+)?\s*(?:k|m|mm|million|thousand|billion)\b/gi

/** True when free text carries a currency amount a seller must not see pre-appointment. */
export function containsPriceAmount(text: string | null | undefined): boolean {
  if (!text) return false
  PRICE_TEXT_RE.lastIndex = 0
  return PRICE_TEXT_RE.test(text)
}

/**
 * Replace every currency amount in free text with a withheld marker. Used on
 * anything customer-facing that was authored outside the structured payload
 * (titles, notes) before it reaches a seller-facing email.
 */
export function redactPriceAmounts(text: string): string {
  if (!text) return text
  return text.replace(PRICE_TEXT_RE, "[withheld]")
}

/** Drop slides that present the subject valuation from a slide_deck. */
export function filterPricingSlides(slideDeck: unknown): unknown {
  if (!slideDeck || typeof slideDeck !== "object") return slideDeck
  const deck = slideDeck as Record<string, unknown>
  const slides = deck.slides
  if (!Array.isArray(slides)) return scrubSuggestedPriceKeys(slideDeck)
  const kept = slides.filter((s) => {
    const kind = String((s as any)?.kind ?? (s as any)?.type ?? "")
    return !PRICING_SLIDE_RE.test(kind)
  })
  return { ...deck, slides: scrubSuggestedPriceKeys(kept) }
}

export interface PresentationLike {
  cma_low_value?:  number | null
  cma_mid_value?:  number | null
  cma_high_value?: number | null
  slide_deck?:     unknown
  [k: string]:     unknown
}

/**
 * Seller-safe presentation: valuation fields nulled, pricing slides removed,
 * residual price keys scrubbed, and a price-withheld note added. The result
 * passes findSuggestedPriceLeaks (no customer-visible suggested price).
 */
export function buildSellerSafeCma<T extends PresentationLike>(presentation: T): T & { price_withheld: true; price_note: string } {
  const scrubbed = scrubSuggestedPriceKeys(presentation) as T
  return {
    ...scrubbed,
    cma_low_value:  null,
    cma_mid_value:  null,
    cma_high_value: null,
    slide_deck:     presentation.slide_deck != null ? filterPricingSlides(presentation.slide_deck) : presentation.slide_deck,
    price_withheld: true as const,
    price_note:     "Your home's value will be presented at our meeting.",
  }
}
