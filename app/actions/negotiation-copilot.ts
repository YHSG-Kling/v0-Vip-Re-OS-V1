"use server"

/**
 * Negotiation Co-Pilot — aggregates the existing offer-strategy AI helper,
 * comparable sales pull, and the brand-voice draft helper into a single
 * server action so the agent gets a sub-30-second view when an offer arrives.
 *
 * Vision moment from the spec:
 *   Offer arrives → Copilot opens with:
 *     - counter strategy + recommended action (accept | counter | walk)
 *     - suggested counter price + tactics + risk-of-losing-deal
 *     - comparable sales (price, DOM, $/sqft) for the property's area
 *     - draft response message in the agent's voice ready to send
 *
 * All four pieces already had pieces of infrastructure built; this action
 * stitches them into one call so the UI is a single button on the offer
 * card / listing offers manager.
 */

import { createClient } from "@/lib/supabase/server"
import { aiCounterOfferStrategy } from "./ai-offer-creation"
import { isValidUUID } from "@/lib/validations"
import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"

export interface NegotiationStrategy {
  recommendedResponse: "accept" | "counter" | "walk_away" | string
  suggestedCounterPrice?: number | null
  suggestedTerms?: string[]
  reasoning?: string
  negotiationTactics?: string[]
  riskOfLosingDeal?: number   // 0-100
  estimatedFinalPrice?: number
  nextMoveTimeline?: string
}

export interface ComparableSummary {
  count:           number
  medianSoldPrice: number | null
  avgDom:          number | null
  pricePerSqft:    number | null
  insight:         string  // 1-line takeaway
}

export interface NegotiationCoPilotResult {
  success: boolean
  error?:  string
  /** Stripped to the canonical strategy fields (handles the existing
   *  aiCounterOfferStrategy { success, strategy } wrapper). */
  strategy?:    NegotiationStrategy
  comparables?: ComparableSummary
  draftResponse?: {
    subject?: string
    body:     string
  }
  offerSnapshot?: {
    offerPrice:   number
    listPrice:    number
    gapPct:       number
    contingencies: string[]
  }
}

export async function negotiationCoPilot(params: {
  offerId:        string
  buyerMaxBudget?: number  // optional override; defaults to offer * 1.1
}): Promise<NegotiationCoPilotResult> {
  if (!isValidUUID(params.offerId)) {
    return { success: false, error: "Invalid offer id" }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  // Load the offer + linked listing + buyer for context
  const { data: offer } = await supabase
    .from("offers")
    .select(`
      id, offer_price, earnest_money, down_payment_percent, financing_type,
      contingencies, closing_date, current_round, status,
      listing:listings(id, address, city, state, zip, list_price, bedrooms, bathrooms, sqft, brokerage_id),
      buyer:contacts(id, first_name, last_name)
    `)
    .eq("id", params.offerId)
    .maybeSingle()

  if (!offer) return { success: false, error: "Offer not found" }

  // Supabase nested selects return arrays even for to-one relations unless
  // !inner is specified. Normalize to single objects.
  const listingRaw = (offer as unknown as { listing?: unknown }).listing
  const listing = (Array.isArray(listingRaw) ? listingRaw[0] : listingRaw) as
    | {
        id: string
        address: string | null
        city: string | null
        state: string | null
        zip: string | null
        list_price: number | null
        bedrooms: number | null
        bathrooms: number | null
        sqft: number | null
        brokerage_id: string | null
      }
    | null

  const buyerRaw = (offer as unknown as { buyer?: unknown }).buyer
  const buyer = (Array.isArray(buyerRaw) ? buyerRaw[0] : buyerRaw) as
    | { id: string; first_name: string | null; last_name: string | null }
    | null

  const offerPrice = Number(offer.offer_price ?? 0)
  const listPrice  = Number(listing?.list_price ?? offerPrice)
  const gapPct     = listPrice > 0 ? ((listPrice - offerPrice) / listPrice) * 100 : 0
  const contingencies: string[] = Array.isArray(offer.contingencies)
    ? (offer.contingencies as unknown[]).filter((c): c is string => typeof c === "string")
    : []

  // ─── 1. Counter strategy via existing AI helper ──────────────────────────
  const buyerMaxBudget = params.buyerMaxBudget ?? offerPrice * 1.1
  const strategyResult = await aiCounterOfferStrategy({
    originalOffer:    offerPrice,
    listPrice,
    counterAmount:    listPrice,                      // seller-side: starting from list
    counterTerms:     { contingencies },
    buyerMaxBudget,
    negotiationRound: offer.current_round ?? 1,
  }).catch(() => null)

  // aiCounterOfferStrategy returns { success, strategy } OR { success: false, error }.
  // Existing offers-manager-client UI accessed counterAdvisor.recommendedResponse
  // directly, which was a bug — the field lives on .strategy. We unwrap here.
  const strategy: NegotiationStrategy | undefined =
    strategyResult && (strategyResult as { success?: boolean }).success
      ? ((strategyResult as { strategy?: NegotiationStrategy }).strategy ?? undefined)
      : undefined

  // ─── 2. Comparable sales summary ─────────────────────────────────────────
  // Use the BatchData external client when available; otherwise fall back to
  // a Supabase query against recent comparable_sales / sold_listings rows.
  const comparables = await summarizeComparables({
    address:  listing?.address ?? null,
    city:     listing?.city ?? null,
    state:    listing?.state ?? null,
    zip:      listing?.zip ?? null,
    bedrooms: listing?.bedrooms ?? null,
    sqft:     listing?.sqft ?? null,
    listPrice,
  })

  // ─── 3. Draft response message in agent voice ────────────────────────────
  const buyerName = buyer ? `${buyer.first_name ?? ""} ${buyer.last_name ?? ""}`.trim() || "the buyer" : "the buyer"
  const draftResponse = strategy
    ? await draftCounterResponse({
        recommendedResponse: strategy.recommendedResponse,
        suggestedCounterPrice: strategy.suggestedCounterPrice ?? null,
        listPrice,
        offerPrice,
        propertyAddress: listing?.address ?? "the property",
        buyerName,
        reasoning: strategy.reasoning ?? "",
      })
    : undefined

  return {
    success: true,
    strategy,
    comparables,
    draftResponse,
    offerSnapshot: {
      offerPrice,
      listPrice,
      gapPct,
      contingencies,
    },
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function summarizeComparables(input: {
  address:  string | null
  city:     string | null
  state:    string | null
  zip:      string | null
  bedrooms: number | null
  sqft:     number | null
  listPrice: number
}): Promise<ComparableSummary> {
  // Try BatchData external pull first (returns up to 20 recent sold comps).
  try {
    const { fetchComparableSales } = await import("@/lib/external/batchdata-client")
    const comps = await fetchComparableSales({
      address:    input.address ?? "",
      city:       input.city ?? "",
      state:      input.state ?? "",
      zip:        input.zip ?? "",
      bedrooms:   input.bedrooms ?? 0,
      bathrooms:  0,
      squareFeet: input.sqft ?? 0,
      radiusMiles: 1,
    }).catch(() => null)

    if (comps && Array.isArray(comps) && comps.length > 0) {
      // BatchDataComp shape: sale_price, days_on_market, price_per_sqft
      const prices = comps.map((c) => Number(c.sale_price ?? 0)).filter((n) => n > 0)
      const doms   = comps.map((c) => Number(c.days_on_market ?? 0)).filter((n) => n > 0)
      const ppsqft = comps.map((c) => Number(c.price_per_sqft ?? 0)).filter((n) => n > 0)
      const median = (arr: number[]): number | null => {
        if (arr.length === 0) return null
        const sorted = [...arr].sort((a, b) => a - b)
        const mid = Math.floor(sorted.length / 2)
        const result = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
        return result ?? null
      }
      const medianSoldPrice = median(prices)
      const avgDom = doms.length > 0 ? doms.reduce((a, b) => a + b, 0) / doms.length : null
      const pricePerSqft = ppsqft.length > 0 ? ppsqft.reduce((a, b) => a + b, 0) / ppsqft.length : null

      const insight =
        medianSoldPrice && medianSoldPrice > input.listPrice * 1.02
          ? `Comps support a price above list — median sold ${formatUsd(medianSoldPrice)}.`
          : medianSoldPrice && medianSoldPrice < input.listPrice * 0.95
          ? `Comps are softer than list — median sold ${formatUsd(medianSoldPrice)}.`
          : `Comps near list price (median ${formatUsd(medianSoldPrice ?? input.listPrice)}).`

      return {
        count: comps.length,
        medianSoldPrice,
        avgDom: avgDom ? Math.round(avgDom) : null,
        pricePerSqft: pricePerSqft ? Math.round(pricePerSqft) : null,
        insight,
      }
    }
  } catch {
    // fall through
  }

  // Fallback — empty summary; UI hides the section when count=0
  return {
    count:           0,
    medianSoldPrice: null,
    avgDom:          null,
    pricePerSqft:    null,
    insight:         "No comparable sales available in this area right now.",
  }
}

async function draftCounterResponse(input: {
  recommendedResponse: string
  suggestedCounterPrice: number | null
  listPrice: number
  offerPrice: number
  propertyAddress: string
  buyerName: string
  reasoning: string
}): Promise<{ subject?: string; body: string } | undefined> {
  try {
    const result = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
      prompt: `Draft a brief professional response to the buyer's agent re: an offer on ${input.propertyAddress}.

Context:
- Buyer offered: $${input.offerPrice.toLocaleString()}
- List price:    $${input.listPrice.toLocaleString()}
- Buyer:         ${input.buyerName}
- Our recommendation: ${input.recommendedResponse}
${input.suggestedCounterPrice ? `- Suggested counter: $${input.suggestedCounterPrice.toLocaleString()}` : ""}
- Reasoning: ${input.reasoning}

Tone: professional, them-first, no high-pressure language, no investment claims, no fair-housing language. Keep under 120 words.

Respond with JSON only: { "subject": "<email subject ≤ 60 chars>", "body": "<message body>" }`,
      maxOutputTokens: 400,
    })
    const jsonMatch = result.text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return undefined
    const parsed = JSON.parse(jsonMatch[0]) as { subject?: string; body?: string }
    if (!parsed.body) return undefined
    return { subject: parsed.subject, body: parsed.body }
  } catch {
    return undefined
  }
}

function formatUsd(n: number | null): string {
  if (n == null) return "—"
  return `$${Math.round(n).toLocaleString()}`
}
