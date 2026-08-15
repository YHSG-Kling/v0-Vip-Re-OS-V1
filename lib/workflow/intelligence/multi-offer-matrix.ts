/**
 * lib/workflow/intelligence/multi-offer-matrix.ts
 *
 * Two intelligence helpers used by the listing-side workflow:
 *
 *   1. buildMultiOfferMatrix — when a seller has 2+ offers, builds an
 *      apples-to-apples comparison: price, net-to-seller, buyer strength,
 *      contingencies, close timing, escalation behavior. Generates a
 *      one-page seller-decision summary.
 *
 *   2. buildCounterOfferDiff — when a buyer or seller counters, produces
 *      a 3-column diff (Original | Counter | Recommendation) so the agent
 *      can review only what changed instead of re-reading 47 pages.
 *
 * Output is plain JSON the FormWizard / dashboard renders. No UI here.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"

// ───────────────────────────────────────────────────────────────────────────
// Multi-offer comparison matrix
// ───────────────────────────────────────────────────────────────────────────

export interface OfferRow {
  offerId:               string
  buyerName:             string | null
  offerPrice:            number
  emd:                   number | null
  downPaymentPercent:    number | null
  financingType:         string | null
  closeDateDays:         number | null      // days from today
  contingencies:         string[]
  escalationCap:         number | null
  sellerConcessionAmount: number | null
  netToSeller:           number             // computed: price - concessions - estimated costs
  buyerStrengthScore:    number             // 0..100
  buyerStrengthLabel:    "weak" | "moderate" | "strong" | "very_strong"
}

export interface MultiOfferMatrix {
  listingId:    string
  listingAddress: string | null
  listPrice:    number | null
  offers:       OfferRow[]
  topOffer:     { byPrice: string; byNet: string; byCertainty: string }
  aiSummary:    string                       // 3-paragraph plain-English rec for the seller
}

export async function buildMultiOfferMatrix(input: {
  listingId: string
}): Promise<MultiOfferMatrix> {
  const svc = createServiceClient()

  const { data: listing } = await svc
    .from("listings")
    .select("id, address, list_price")
    .eq("id", input.listingId)
    .maybeSingle()

  // Pull every active offer on this listing
  const { data: offers } = await svc
    .from("offers")
    .select("id, buyer_contact_id, offer_price, earnest_money, down_payment_percent, financing_type, close_date, contingencies, escalation_cap, seller_concession_amount, status, created_at")
    .eq("listing_id", input.listingId)
    .in("status", ["pending", "submitted", "countered"])

  const rows: OfferRow[] = []
  for (const off of (offers ?? [])) {
    let buyerName: string | null = null
    if ((off as any).buyer_contact_id) {
      const { data: c } = await svc
        .from("contacts").select("first_name, last_name").eq("id", (off as any).buyer_contact_id).maybeSingle()
      if (c) buyerName = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || null
    }

    const offerPrice = (off as any).offer_price ?? 0
    const concessions = (off as any).seller_concession_amount ?? 0
    const estimatedSellerCosts = offerPrice * 0.06   // realistic conservative est. (commission + closing)
    const netToSeller = offerPrice - concessions - estimatedSellerCosts

    const closeDate = (off as any).close_date
    const closeDateDays = closeDate
      ? Math.floor((new Date(closeDate).getTime() - Date.now()) / 86_400_000)
      : null

    const buyerStrengthScore = scoreBuyerStrength({
      financingType: (off as any).financing_type,
      downPaymentPercent: (off as any).down_payment_percent,
      contingencies: (off as any).contingencies ?? [],
      emd: (off as any).earnest_money,
      offerPrice,
    })

    rows.push({
      offerId:               off.id,
      buyerName,
      offerPrice,
      emd:                   (off as any).earnest_money,
      downPaymentPercent:    (off as any).down_payment_percent,
      financingType:         (off as any).financing_type,
      closeDateDays,
      contingencies:         (off as any).contingencies ?? [],
      escalationCap:         (off as any).escalation_cap,
      sellerConcessionAmount: (off as any).seller_concession_amount,
      netToSeller,
      buyerStrengthScore,
      buyerStrengthLabel:    labelStrength(buyerStrengthScore),
    })
  }

  // Identify top offer per dimension
  const byPrice    = rows.length > 0 ? [...rows].sort((a, b) => b.offerPrice - a.offerPrice)[0]?.offerId : ""
  const byNet      = rows.length > 0 ? [...rows].sort((a, b) => b.netToSeller - a.netToSeller)[0]?.offerId : ""
  const byCertainty = rows.length > 0 ? [...rows].sort((a, b) => b.buyerStrengthScore - a.buyerStrengthScore)[0]?.offerId : ""

  // AI seller-decision summary
  let aiSummary = ""
  if (rows.length > 0) {
    try {
      const prompt = `You are advising a seller on ${rows.length} offers for ${listing?.address ?? "their home"}.
List price: $${listing?.list_price?.toLocaleString() ?? "?"}.

Offers:
${rows.map((r, i) => `${i + 1}. ${r.buyerName ?? "Buyer " + (i + 1)} — $${r.offerPrice.toLocaleString()} (${r.financingType ?? "?"}, ${r.contingencies.length} contingencies, close in ${r.closeDateDays ?? "?"}d, buyer strength ${r.buyerStrengthLabel}, net to seller $${Math.round(r.netToSeller).toLocaleString()})`).join("\n")}

In 3 short paragraphs, written directly to the seller, explain:
1. Which offer maximizes total dollars (and what risk comes with it)
2. Which offer is most likely to close cleanly (and at what dollar trade-off)
3. The single recommendation given the seller's likely priorities
Don't use jargon. Be direct and balanced.`

      const result = await generateTextRouted({
        feature: "multi_offer_summary",
        messages: [{ role: "user", content: prompt }],
      })
      aiSummary = result.text
    } catch { /* best effort */ }
  }

  return {
    listingId: input.listingId,
    listingAddress: (listing as any)?.address ?? null,
    listPrice: (listing as any)?.list_price ?? null,
    offers: rows,
    topOffer: { byPrice, byNet, byCertainty },
    aiSummary,
  }
}

function scoreBuyerStrength(input: {
  financingType: string | null
  downPaymentPercent: number | null
  contingencies: string[]
  emd: number | null
  offerPrice: number
}): number {
  let score = 50

  // Cash > Conventional > FHA/VA > USDA
  if (input.financingType === "cash")       score += 30
  else if (input.financingType === "conventional") score += 15
  else if (input.financingType === "fha")   score += 5
  else if (input.financingType === "va")    score += 5

  // Higher down payment = more skin in the game + appraisal cushion
  if (input.downPaymentPercent != null) {
    if (input.downPaymentPercent >= 25) score += 10
    else if (input.downPaymentPercent >= 20) score += 5
    else if (input.downPaymentPercent < 5) score -= 5
  }

  // Fewer contingencies = stronger
  const c = input.contingencies.length
  if (c === 0) score += 15
  else if (c === 1) score += 5
  else if (c >= 3) score -= 10

  // EMD as percent of price
  if (input.emd && input.offerPrice) {
    const emdPct = (input.emd / input.offerPrice) * 100
    if (emdPct >= 5) score += 10
    else if (emdPct >= 3) score += 5
    else if (emdPct < 1) score -= 10
  }

  return Math.max(0, Math.min(100, score))
}

function labelStrength(score: number): OfferRow["buyerStrengthLabel"] {
  if (score >= 85) return "very_strong"
  if (score >= 70) return "strong"
  if (score >= 50) return "moderate"
  return "weak"
}

// ───────────────────────────────────────────────────────────────────────────
// Counter-offer diff
// ───────────────────────────────────────────────────────────────────────────

export interface CounterDiffRow {
  field:           string
  labelForSeller:  string
  original:        unknown
  counter:         unknown
  changed:         boolean
  recommendation:  "accept" | "match" | "counter_back" | "decline" | "review"
  rationale:       string
}

export interface CounterOfferDiff {
  offerId:    string
  rows:       CounterDiffRow[]
  bottomLine: string                       // 1-2 sentence AI take
}

export async function buildCounterOfferDiff(input: {
  offerId:        string
  counterPayload: Record<string, unknown>      // counter terms received
}): Promise<CounterOfferDiff> {
  const svc = createServiceClient()

  const { data: offer } = await svc
    .from("offers")
    .select("id, offer_price, earnest_money, close_date, contingencies, financing_type, down_payment_percent, seller_concession_amount, escalation_cap")
    .eq("id", input.offerId)
    .maybeSingle()

  if (!offer) {
    return { offerId: input.offerId, rows: [], bottomLine: "Offer not found" }
  }

  const fields: Array<{ key: string; label: string }> = [
    { key: "offer_price",                 label: "Price" },
    { key: "earnest_money",               label: "Earnest money" },
    { key: "close_date",                  label: "Close date" },
    { key: "seller_concession_amount",    label: "Seller concessions" },
    { key: "down_payment_percent",        label: "Down payment %" },
    { key: "financing_type",              label: "Financing type" },
    { key: "contingencies",               label: "Contingencies" },
    { key: "escalation_cap",              label: "Escalation cap" },
  ]

  const rows: CounterDiffRow[] = []
  const offAny = offer as any

  for (const f of fields) {
    const original = offAny[f.key]
    const counter  = input.counterPayload[f.key]
    const changed  = counter !== undefined && JSON.stringify(original) !== JSON.stringify(counter)
    const { recommendation, rationale } = recommendForField(f.key, original, counter, changed)
    rows.push({
      field:          f.key,
      labelForSeller: f.label,
      original,
      counter:        changed ? counter : original,
      changed,
      recommendation,
      rationale,
    })
  }

  // 1-2 sentence AI take on the whole counter
  let bottomLine = ""
  try {
    const changedRows = rows.filter(r => r.changed)
    if (changedRows.length === 0) {
      bottomLine = "Counter doesn't change material terms — likely a procedural counter."
    } else {
      const prompt = `Buyer-side analysis of a counter-offer. Changed terms:
${changedRows.map(r => `- ${r.labelForSeller}: ${JSON.stringify(r.original)} → ${JSON.stringify(r.counter)}`).join("\n")}

In 1-2 sentences, write the bottom-line take for the agent: should the buyer accept, counter back, or walk? Be specific about why.`
      const r = await generateTextRouted({
        feature: "counter_offer_take",
        messages: [{ role: "user", content: prompt }],
      })
      bottomLine = r.text.trim()
    }
  } catch { /* best effort */ }

  return {
    offerId: input.offerId,
    rows,
    bottomLine,
  }
}

function recommendForField(
  key: string,
  original: unknown,
  counter: unknown,
  changed: boolean
): { recommendation: CounterDiffRow["recommendation"]; rationale: string } {
  if (!changed) return { recommendation: "accept", rationale: "Unchanged from original." }

  // Field-specific heuristics
  switch (key) {
    case "offer_price": {
      if (typeof original === "number" && typeof counter === "number") {
        const delta = counter - original
        if (delta > 0 && delta / original < 0.03) return { recommendation: "match", rationale: "Within 3% — typical bump." }
        if (delta > 0 && delta / original < 0.07) return { recommendation: "counter_back", rationale: "3-7% bump — counter at midpoint." }
        return { recommendation: "review", rationale: "Significant price move — review against buyer's max." }
      }
      return { recommendation: "review", rationale: "Manual review." }
    }
    case "close_date":
      return { recommendation: "review", rationale: "Verify lender/title can hit the new date." }
    case "earnest_money":
      return { recommendation: "match", rationale: "Buyer can typically meet a higher EMD." }
    case "contingencies":
      return { recommendation: "review", rationale: "Contingency changes affect risk — review carefully." }
    case "seller_concession_amount":
      return { recommendation: "review", rationale: "Concession changes affect net to buyer." }
    default:
      return { recommendation: "review", rationale: "Manual review." }
  }
}
