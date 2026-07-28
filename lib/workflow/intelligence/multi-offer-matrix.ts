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
import { scoreBuyerStrength, labelStrength } from "@/lib/offers/offer-strength"
// Share the ONE net-proceeds engine. This card renders next to the interactive
// net sheet and (since b27bde3) the deterministic recommendation — three numbers
// on one screen must not disagree about which offer nets more.
import {
  computeNetProceeds, defaultSellerCosts, resolveAgreedCommission,
  type AgreementCommissionFields,
} from "@/lib/offers/net-sheet-calc"
import { deriveNetSheetClosingCostSection } from "@/lib/offers/seller-closing-costs"

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
    .select("id, address, list_price, state, hoa_dues, commission_rate, brokerage_id")
    .eq("id", input.listingId)
    .maybeSingle()

  // Pull every active offer on this listing
  const { data: offers } = await svc
    .from("offers")
    .select("id, contact_id, offer_price, earnest_money, down_payment_percent, financing_type, closing_date, contingencies, escalation_cap, closing_cost_contribution, status, created_at")
    .eq("listing_id", input.listingId)
    .in("status", ["pending", "submitted", "countered"])

  // Agreed terms + regional closing costs — the same inputs the net sheet uses.
  const { data: agreementRow } = await svc
    .from("listing_agreements")
    .select("listing_commission_rate, buyer_commission_rate, total_commission_rate, commission_is_flat_fee, commission_flat_amount, seller_transaction_fee")
    .eq("listing_id", input.listingId)
    .eq("brokerage_id", (listing as any)?.brokerage_id ?? "")
    .order("fully_executed_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()

  const agreed = resolveAgreedCommission({
    agreement: agreementRow as AgreementCommissionFields | null,
    listingCommissionRatePercent: (listing as any)?.commission_rate ?? null,
    referencePrice: (listing as any)?.list_price != null ? Number((listing as any).list_price) : null,
  })
  const sellerCosts = defaultSellerCosts({
    listPrice: (listing as any)?.list_price != null ? Number((listing as any).list_price) : null,
    commissionRateDecimal: agreed.rate,
    hoaDuesMonthly: (listing as any)?.hoa_dues != null ? Number((listing as any).hoa_dues) : null,
    transactionFee: (agreementRow as any)?.seller_transaction_fee ?? null,
  })
  const closingSection = deriveNetSheetClosingCostSection(
    (listing as any)?.list_price != null ? Number((listing as any).list_price) : null,
    (listing as any)?.state ?? null,
  )
  if (closingSection) sellerCosts.otherProratedFees = closingSection.midpoint

  const rows: OfferRow[] = []
  for (const off of (offers ?? [])) {
    let buyerName: string | null = null
    if ((off as any).contact_id) {
      const { data: c } = await svc
        .from("contacts").select("first_name, last_name").eq("id", (off as any).contact_id).maybeSingle()
      if (c) buyerName = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || null
    }

    const offerPrice = (off as any).offer_price ?? 0
    const concessions = (off as any).closing_cost_contribution ?? 0
    // Was a blanket offerPrice * 0.06 standing in for commission AND closing — it
    // ignored the agreed rate, the regional closing lines, the transaction fee and
    // the mortgage payoff, so this column could name a different winner than the
    // net sheet on the same screen.
    const netToSeller = computeNetProceeds(
      { offerPrice, buyerClosingCredit: concessions },
      sellerCosts,
    )

    const closeDate = (off as any).closing_date
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
      sellerConcessionAmount: (off as any).closing_cost_contribution,
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

// scoreBuyerStrength + labelStrength now live in the shared pure module lib/offers/offer-strength.ts
// (imported above) so the seller decision room uses identical certainty-of-close logic — no drift.

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
    .select("id, offer_price, earnest_money, closing_date, contingencies, financing_type, down_payment_percent, closing_cost_contribution, escalation_cap")
    .eq("id", input.offerId)
    .maybeSingle()

  if (!offer) {
    return { offerId: input.offerId, rows: [], bottomLine: "Offer not found" }
  }

  const fields: Array<{ key: string; label: string }> = [
    { key: "offer_price",                 label: "Price" },
    { key: "earnest_money",               label: "Earnest money" },
    { key: "closing_date",                label: "Close date" },
    { key: "closing_cost_contribution",   label: "Seller concessions" },
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
    case "closing_date":
      return { recommendation: "review", rationale: "Verify lender/title can hit the new date." }
    case "earnest_money":
      return { recommendation: "match", rationale: "Buyer can typically meet a higher EMD." }
    case "contingencies":
      return { recommendation: "review", rationale: "Contingency changes affect risk — review carefully." }
    case "closing_cost_contribution":
      return { recommendation: "review", rationale: "Concession changes affect net to buyer." }
    default:
      return { recommendation: "review", rationale: "Manual review." }
  }
}
