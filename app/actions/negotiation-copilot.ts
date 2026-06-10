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
import { aiCounterOfferStrategy, aiCalculateEscalation } from "./ai-offer-creation"
import { buildMultiOfferMatrix } from "@/lib/workflow/intelligence/multi-offer-matrix"
import { isValidUUID } from "@/lib/validations"
import { generateText } from "ai"
import { generateObjectRouted } from "@/lib/ai/models"
import { resolveModel } from "@/lib/ai/resolve-model"
import { z } from "zod"

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

/** Escalation cap calculator output — only meaningful on the BUYER side
 *  (advising our buyer on what cap to authorize when competing offers
 *  are likely or confirmed). On seller side this is omitted. */
export interface EscalationRecommendation {
  recommended:          boolean
  startingOffer:        number
  escalationIncrement:  number
  maxEscalationPrice:   number
  capAtAppraisal:       boolean
  proofRequired:        string[]
  reasoning:            string
  riskAssessment:       string
  sampleClauseText:     string
  /** How many active competing offers we detected on the listing
   *  (via buildMultiOfferMatrix). Zero on outside listings we don't own. */
  competingOffersDetected: number
  competitionLevel:     "none" | "low" | "medium" | "high"
}

/** Concession trade-off matrix — for each scenario, the deltas to both
 *  parties so the agent can frame the trade explicitly with their client. */
export interface ConcessionScenario {
  label:            string  // "$5k repair credit, +$10k on price"
  priceDelta:       number  // can be negative
  concessionDelta:  number  // seller concession / closing cost credit
  netToSellerDelta: number  // after 6% est. cost
  netToBuyerDelta:  number  // out-of-pocket impact
  recommendation:   "buyer_favored" | "seller_favored" | "balanced"
  rationale:        string
}

export interface ConcessionMatrix {
  scenarios:     ConcessionScenario[]
  bestForSeller: string  // label of the best-for-seller scenario
  bestForBuyer:  string  // label of the best-for-buyer scenario
  bottomLine:    string  // 1-2 sentence framing
}

export interface NegotiationCoPilotResult {
  success: boolean
  error?:  string
  /** Stripped to the canonical strategy fields (handles the existing
   *  aiCounterOfferStrategy { success, strategy } wrapper). */
  strategy?:    NegotiationStrategy
  comparables?: ComparableSummary
  escalation?:  EscalationRecommendation
  concessionMatrix?: ConcessionMatrix
  draftResponse?: {
    subject?: string
    body:     string
  }
  offerSnapshot?: {
    offerPrice:   number
    listPrice:    number
    gapPct:       number
    contingencies: string[]
    /** The contact_id that "Send as counter response" routes to (the
     *  buyer on seller side, our buyer on buyer side). */
    contactId:    string | null
  }
}

export async function negotiationCoPilot(params: {
  offerId:        string
  /** Which side of the negotiation we're advising:
   *    "seller" — an offer came IN on our listing, we're deciding the response
   *    "buyer"  — we submitted an offer + the seller countered, our buyer
   *               is deciding whether to accept / counter back / walk
   *  Defaults to "seller" (most common UI entry point at offers-manager). */
  side?:          "seller" | "buyer"
  /** Buyer's max budget — used only on the buyer side. Defaults to
   *  offer * 1.1 if unspecified. */
  buyerMaxBudget?: number
  /** Counter amount the seller is proposing — used only on the buyer side
   *  for the AI to know "what they want from us". Defaults to listPrice. */
  sellerCounter?: number
}): Promise<NegotiationCoPilotResult> {
  if (!isValidUUID(params.offerId)) {
    return { success: false, error: "Invalid offer id" }
  }
  const side: "seller" | "buyer" = params.side ?? "seller"

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  // Load the offer + linked listing + buyer for context
  const { data: offer } = await supabase
    .from("offers")
    .select(`
      id, offer_price, earnest_money, down_payment_percent, financing_type,
      contingencies, closing_date, current_round, status,
      contact_id, listing_id,
      closing_cost_contribution,
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
  // Seller side: counterAmount = listPrice (we're advising from the asking
  // position). Buyer side: counterAmount = sellerCounter ?? listPrice
  // (the seller's counter is what we're responding to).
  const buyerMaxBudget = params.buyerMaxBudget ?? offerPrice * 1.1
  const counterAmount =
    side === "seller"
      ? listPrice
      : (params.sellerCounter ?? listPrice)
  const strategyResult = await aiCounterOfferStrategy({
    originalOffer:    offerPrice,
    listPrice,
    counterAmount,
    counterTerms:     { contingencies, side },
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

  // ─── 1b. Multi-offer awareness ───────────────────────────────────────────
  // On our own listing (side=seller, listing.id present), pull the live
  // multi-offer matrix so we know how many other offers are competing.
  // On the buyer side we treat competition as "unknown unless caller
  // explicitly passes a hint" — listing isn't ours so we can't see other
  // offers in our DB. Default to "low" when uncertain.
  let competingOffersDetected = 0
  let competitionLevel: "none" | "low" | "medium" | "high" = "none"
  if (side === "seller" && listing?.id) {
    try {
      const matrix = await buildMultiOfferMatrix({ listingId: listing.id })
      // Exclude this offer from the count — competition = other live offers.
      competingOffersDetected = Math.max(0, (matrix.offers?.length ?? 0) - 1)
      competitionLevel =
        competingOffersDetected >= 3 ? "high"
        : competingOffersDetected === 2 ? "medium"
        : competingOffersDetected === 1 ? "low"
        : "none"
    } catch {
      // best effort
    }
  } else if (side === "buyer") {
    // On the buyer side we can't see the seller's other offers, but if the
    // seller is countering aggressively above our offer that's a signal.
    const counterGap = counterAmount - offerPrice
    const counterGapPct = offerPrice > 0 ? (counterGap / offerPrice) * 100 : 0
    competitionLevel =
      counterGapPct > 7 ? "high"
      : counterGapPct > 3 ? "medium"
      : counterGapPct > 0 ? "low"
      : "none"
  }

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
    brokerageId: listing?.brokerage_id ?? null,
  })

  // ─── 2b. Escalation cap calculator ───────────────────────────────────────
  // Most useful on the BUYER side (advising our buyer on what cap to
  // authorize). Also surfaces on seller side when competition >= medium —
  // sellers benefit from knowing if the leading offer has an escalation
  // and what cap would beat it cleanly.
  let escalation: EscalationRecommendation | undefined
  const shouldCalcEscalation =
    side === "buyer" ||
    (side === "seller" && (competitionLevel === "medium" || competitionLevel === "high"))
  if (shouldCalcEscalation) {
    const escResult = await aiCalculateEscalation({
      listPrice,
      initialOffer:        side === "buyer" ? offerPrice : counterAmount,
      maxBudget:           buyerMaxBudget,
      estimatedCompetition: competitionLevel,
      marketTrend:         "stable",  // listing-level trend isn't in scope here
    }).catch(() => null)
    if (escResult && (escResult as { success?: boolean }).success) {
      const e = (escResult as { escalation: {
        recommended: boolean
        startingOffer: number
        escalationIncrement: number
        maxEscalationPrice: number
        capAtAppraisal: boolean
        proofRequired: string[]
        reasoning: string
        riskAssessment: string
        sampleClauseText: string
      } }).escalation
      escalation = {
        recommended:             e.recommended,
        startingOffer:           e.startingOffer,
        escalationIncrement:     e.escalationIncrement,
        maxEscalationPrice:      e.maxEscalationPrice,
        capAtAppraisal:          e.capAtAppraisal,
        proofRequired:           e.proofRequired,
        reasoning:               e.reasoning,
        riskAssessment:          e.riskAssessment,
        sampleClauseText:        e.sampleClauseText,
        competingOffersDetected,
        competitionLevel,
      }
    }
  }

  // ─── 2c. Concession trade-off matrix ─────────────────────────────────────
  // Generate 4 scenarios (status quo, price-up vs concession-up,
  // concession-up vs price-down, balanced midpoint). Each shows the delta
  // to both parties so the agent can frame the trade for their client.
  const existingConcession = Number((offer as { closing_cost_contribution?: number }).closing_cost_contribution ?? 0)
  const concessionMatrix = await buildConcessionMatrix({
    side,
    offerPrice,
    listPrice,
    suggestedCounterPrice: strategy?.suggestedCounterPrice ?? null,
    existingConcession,
  })

  // ─── 3. Draft response message in agent voice ────────────────────────────
  const buyerName = buyer ? `${buyer.first_name ?? ""} ${buyer.last_name ?? ""}`.trim() || "the buyer" : "the buyer"
  const draftResponse = strategy
    ? await draftCounterResponse({
        side,
        recommendedResponse: strategy.recommendedResponse,
        suggestedCounterPrice: strategy.suggestedCounterPrice ?? null,
        listPrice,
        offerPrice,
        sellerCounter: side === "buyer" ? counterAmount : null,
        propertyAddress: listing?.address ?? "the property",
        buyerName,
        reasoning: strategy.reasoning ?? "",
      })
    : undefined

  // Pick the contact_id we'd route a "send as counter response" through.
  // Both sides use the offer's primary contact (buyer's contact record).
  const routableContactId = (offer as unknown as { contact_id?: string | null }).contact_id ?? null

  return {
    success: true,
    strategy,
    comparables,
    escalation,
    concessionMatrix,
    draftResponse,
    offerSnapshot: {
      offerPrice,
      listPrice,
      gapPct,
      contingencies,
      contactId: routableContactId,
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
  brokerageId: string | null
}): Promise<ComparableSummary> {
  // RentCast comps (the platform comps provider). Returns recent sold comps with
  // sale_price / days_on_market / price_per_sqft — the fields the medians use.
  try {
    const { getRentcastComps } = await import("@/lib/property/rentcast")
    const comps = input.brokerageId
      ? await getRentcastComps({
          brokerageId: input.brokerageId,
          address: [input.address, input.city, input.state, input.zip].filter(Boolean).join(", "),
          limit: 20,
        }).catch(() => null)
      : null

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
  side: "seller" | "buyer"
  recommendedResponse: string
  suggestedCounterPrice: number | null
  listPrice: number
  offerPrice: number
  sellerCounter: number | null
  propertyAddress: string
  buyerName: string
  reasoning: string
}): Promise<{ subject?: string; body: string } | undefined> {
  // Audience + framing flips per side. Seller side: we write TO the buyer's
  // agent about an offer that came in on our listing. Buyer side: we write
  // TO the listing agent about a counter the seller sent back to our buyer.
  const sellerSidePrompt = `Draft a brief professional response to the buyer's agent re: an offer on ${input.propertyAddress}.

Context (we represent the SELLER):
- Buyer offered:           $${input.offerPrice.toLocaleString()}
- Our list price:          $${input.listPrice.toLocaleString()}
- Buyer:                   ${input.buyerName}
- Our recommendation:      ${input.recommendedResponse}
${input.suggestedCounterPrice ? `- Suggested counter:       $${input.suggestedCounterPrice.toLocaleString()}` : ""}
- Reasoning:               ${input.reasoning}

Audience: BUYER's agent. Tone: professional, them-first, no high-pressure language, no investment claims, no fair-housing language. Keep under 120 words.

Respond with JSON only: { "subject": "<email subject ≤ 60 chars>", "body": "<message body>" }`

  const buyerSidePrompt = `Draft a brief professional response to the listing agent re: their counter on our buyer's offer on ${input.propertyAddress}.

Context (we represent the BUYER):
- Our buyer's offer:       $${input.offerPrice.toLocaleString()}
- Seller's list price:     $${input.listPrice.toLocaleString()}
${input.sellerCounter ? `- Seller's counter:        $${input.sellerCounter.toLocaleString()}` : ""}
- Our buyer:               ${input.buyerName}
- Our recommendation:      ${input.recommendedResponse}
${input.suggestedCounterPrice ? `- Suggested counter back:  $${input.suggestedCounterPrice.toLocaleString()}` : ""}
- Reasoning:               ${input.reasoning}

Audience: LISTING agent. Tone: professional, them-first, collaborative, no high-pressure language, no investment claims. Keep under 120 words.

Respond with JSON only: { "subject": "<email subject ≤ 60 chars>", "body": "<message body>" }`

  try {
    const result = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
      prompt: input.side === "buyer" ? buyerSidePrompt : sellerSidePrompt,
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

// ─── Concession trade-off matrix ────────────────────────────────────────────
// Generates 4 scenarios. Deterministic math (not AI) for the deltas so the
// numbers are always exact; AI is only used for the bottomLine framing.
async function buildConcessionMatrix(input: {
  side:                   "seller" | "buyer"
  offerPrice:             number
  listPrice:              number
  suggestedCounterPrice:  number | null
  existingConcession:     number
}): Promise<ConcessionMatrix | undefined> {
  const basePrice = input.suggestedCounterPrice ?? input.offerPrice
  if (basePrice <= 0) return undefined

  // Realistic seller-cost estimate (commission + closing).
  const sellerCostRate = 0.06
  const baseConcession = input.existingConcession

  const scenarios: ConcessionScenario[] = []

  const pushScenario = (label: string, priceDelta: number, concessionDelta: number, rationale: string) => {
    const newPrice  = basePrice + priceDelta
    const newConc   = baseConcession + concessionDelta
    // Net-to-seller change vs baseline: (priceDelta) - (priceDelta * costRate) - concessionDelta
    const netToSellerDelta = priceDelta * (1 - sellerCostRate) - concessionDelta
    // Net-to-buyer change (out-of-pocket): -priceDelta + concessionDelta
    const netToBuyerDelta  = -priceDelta + concessionDelta
    const recommendation: ConcessionScenario["recommendation"] =
      netToSellerDelta > 1000 && netToBuyerDelta < -1000 ? "seller_favored"
      : netToBuyerDelta > 1000 && netToSellerDelta < -1000 ? "buyer_favored"
      : "balanced"
    scenarios.push({
      label,
      priceDelta,
      concessionDelta,
      netToSellerDelta: Math.round(netToSellerDelta),
      netToBuyerDelta:  Math.round(netToBuyerDelta),
      recommendation,
      rationale,
    })
    void newPrice; void newConc
  }

  // Scenario A: status quo (the current counter / current offer)
  pushScenario(
    `Hold at ${formatUsd(basePrice)} (no concession change)`,
    0, 0,
    "Baseline — exactly the current counter terms."
  )
  // Scenario B: raise price, add concession ($5k each direction)
  pushScenario(
    `Price +$5k, concession +$5k`,
    5000, 5000,
    "Price headline rises; concession offsets buyer's out-of-pocket. Net neutral to buyer; small net gain to seller after costs."
  )
  // Scenario C: raise price more, give larger concession
  pushScenario(
    `Price +$10k, concession +$7.5k`,
    10000, 7500,
    "Higher price helps appraisal and seller's net; concession eases buyer's cash. Seller wins on net; buyer slightly worse out-of-pocket."
  )
  // Scenario D: price unchanged, give concession to close (buyer-favored)
  pushScenario(
    `Hold price, +$5k concession`,
    0, 5000,
    "Keeps the listing price for comp purposes but eats $5k from seller's net to bridge the gap."
  )

  // Best per side
  const bestSeller = [...scenarios].sort((a, b) => b.netToSellerDelta - a.netToSellerDelta)[0]
  const bestBuyer  = [...scenarios].sort((a, b) => b.netToBuyerDelta - a.netToBuyerDelta)[0]

  // Bottom-line framing (AI, best-effort)
  let bottomLine = ""
  try {
    const prompt = `You are coaching a real estate agent on the ${input.side} side of a negotiation.
Counter price baseline: $${basePrice.toLocaleString()}. Existing seller concession: $${baseConcession.toLocaleString()}.

Trade-off scenarios:
${scenarios.map((s, i) => `${i + 1}. ${s.label} — seller Δnet ${formatUsd(s.netToSellerDelta)}, buyer Δout-of-pocket ${formatUsd(-s.netToBuyerDelta)}`).join("\n")}

In 1-2 sentences, give the agent a direct framing: which scenario should they advocate for and how should they pitch it to their client (${input.side === "seller" ? "the seller" : "the buyer"})? No jargon.`
    const r = await generateObjectRouted({
      feature: "concession_trade_off",
      schema: z.object({ bottomLine: z.string() }),
      prompt,
    })
    bottomLine = r.object.bottomLine
  } catch {
    bottomLine = input.side === "seller"
      ? `Push for higher headline price even with a concession bump — seller's net is what matters.`
      : `Take the concession bump over a flat price increase — your buyer's cash position improves.`
  }

  return {
    scenarios,
    bestForSeller: bestSeller?.label ?? "",
    bestForBuyer:  bestBuyer?.label ?? "",
    bottomLine,
  }
}

// ─── One-click "Send draft as counter response" ─────────────────────────────
// Takes the draft body from the panel + the offer id, resolves the contact
// route (buyer contact on both sides — outbound message goes to the contact
// tied to the offer, routed through the spine so compliance + activity
// logging happen). Channel defaults to email but can be sms/portal.
//
// Compliance: this routes through sendInboxMessage which calls
// evaluateOutbound + enforces DNC/TCPA hard stops. If a soft-rule block
// occurs, the caller should fall back to forceComplianceOverrideAndSend
// (broker-only) via the existing inbox surface.

export interface SendDraftAsCounterParams {
  offerId: string
  body:    string
  subject?: string
  channel?: "sms" | "email" | "portal" | "chat"
}

export async function sendDraftAsCounterResponse(params: SendDraftAsCounterParams): Promise<{
  success:  boolean
  error?:   string
  messageId?: string
  blocked?: boolean
  blockedReason?: string
}> {
  if (!isValidUUID(params.offerId)) {
    return { success: false, error: "Invalid offer id" }
  }
  if (!params.body || params.body.trim().length < 10) {
    return { success: false, error: "Message body is too short to send." }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  // Resolve the contact for this offer
  const { data: offer } = await supabase
    .from("offers")
    .select("id, contact_id")
    .eq("id", params.offerId)
    .maybeSingle()
  if (!offer) return { success: false, error: "Offer not found" }
  const contactId = (offer as { contact_id?: string | null }).contact_id ?? null
  if (!contactId) {
    return { success: false, error: "No contact linked to this offer — can't route." }
  }

  // Email-prefix subject into the body when channel=email so the spine
  // doesn't have to split (sendInboxMessage takes a body, not subject).
  const channel = params.channel ?? "email"
  const fullBody = channel === "email" && params.subject
    ? `Subject: ${params.subject}\n\n${params.body}`
    : params.body

  const { sendInboxMessage } = await import("./inbox")
  const result = await sendInboxMessage({
    contactId,
    body: fullBody,
    channel,
  })

  if (!result.success) {
    // Detect compliance-block vs hard error from the result shape.
    const errStr = result.error ?? ""
    const isBlocked = /block|compliance|tcpa|dnc|fair housing|brand voice|them.first/i.test(errStr)
    return {
      success: false,
      error: errStr || "Send failed",
      blocked: isBlocked,
      blockedReason: isBlocked ? errStr : undefined,
    }
  }

  return { success: true, messageId: result.messageId }
}
