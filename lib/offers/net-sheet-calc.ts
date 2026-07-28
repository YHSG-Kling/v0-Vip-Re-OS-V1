// lib/offers/net-sheet-calc.ts
//
// PURE offer net-sheet math + copy — NO server imports (no createServiceClient, no dynamic
// agent/remotion chain). Split out of lib/kernel/offer-net-sheet.ts so a CLIENT component
// (interactive-net-sheet.tsx) can import the calc without dragging the server runner's dynamic
// imports (@/lib/agents/agent-client-messages → direct-mail → @remotion/bundler) into the browser
// bundle. The server runner (lib/kernel/offer-net-sheet.ts) re-exports everything here, so existing
// importers are unchanged. SINGLE SOURCE OF TRUTH for the commission math: lib/offers/offer-math.

import { calcNetToSeller } from "@/lib/offers/offer-math"

// ─── Types ────────────────────────────────────────────────────────────────────

/** The seller-responsible costs that net proceeds deducts. */
export interface SellerCosts {
  /** decimal, e.g. 0.06 */
  commissionRate: number
  mortgagePayoff: number
  countyCityTaxes: number
  hoaDuesProration: number
  otherProratedFees: number
  /** the buyer's requested closing-cost credit (offers.closing_cost_contribution) */
  buyerClosingCredit: number
}

export interface OfferNetInput {
  offerId: string
  buyerName: string | null
  offerPrice: number
  financingType: string | null
  buyerClosingCredit: number
}

export interface OfferNetLine {
  offerId: string
  buyerName: string | null
  offerPrice: number
  financingType: string | null
  commission: number
  mortgagePayoff: number
  countyCityTaxes: number
  hoaDuesProration: number
  otherProratedFees: number
  buyerClosingCredit: number
  netProceeds: number
}

export interface OfferNetRanking {
  lines: OfferNetLine[]
  /** offerId of the highest sticker price */
  topByPrice: string | null
  /** offerId of the highest net proceeds */
  topByNet: string | null
  /** true when the offer that nets the most is NOT the highest-priced offer */
  netBeatsPrice: boolean
}

export interface OfferNetSheetResult {
  listingsScanned: number
  comparisonsProposed: number
  portalCardsPushed: number
}

// ─── Pure helpers ───────────────────────────────────────────────────────────────

/**
 * Net proceeds for ONE offer. REUSES calcNetToSeller (offer-analyzer) for the
 * commission + buyer-credit core, then subtracts the seller-responsible costs the
 * offer/listing rows don't carry (payoff, taxes, HOA, other).
 */
export function computeNetProceeds(
  offer: { offerPrice: number; buyerClosingCredit: number },
  costs: Omit<SellerCosts, "buyerClosingCredit">,
): number {
  const afterCommissionAndCredit = calcNetToSeller({
    offer_price: offer.offerPrice,
    closing_cost_contribution: offer.buyerClosingCredit,
    commission_rate: costs.commissionRate,
  })
  return (
    afterCommissionAndCredit -
    costs.mortgagePayoff -
    costs.countyCityTaxes -
    costs.hoaDuesProration -
    costs.otherProratedFees
  )
}

/** Build a per-offer net line (the breakdown the interactive sheet renders). */
export function buildNetLine(offer: OfferNetInput, costs: SellerCosts): OfferNetLine {
  const buyerClosingCredit = offer.buyerClosingCredit
  const netProceeds = computeNetProceeds(
    { offerPrice: offer.offerPrice, buyerClosingCredit },
    {
      commissionRate: costs.commissionRate,
      mortgagePayoff: costs.mortgagePayoff,
      countyCityTaxes: costs.countyCityTaxes,
      hoaDuesProration: costs.hoaDuesProration,
      otherProratedFees: costs.otherProratedFees,
    },
  )
  return {
    offerId: offer.offerId,
    buyerName: offer.buyerName,
    offerPrice: offer.offerPrice,
    financingType: offer.financingType,
    commission: offer.offerPrice * costs.commissionRate,
    mortgagePayoff: costs.mortgagePayoff,
    countyCityTaxes: costs.countyCityTaxes,
    hoaDuesProration: costs.hoaDuesProration,
    otherProratedFees: costs.otherProratedFees,
    buyerClosingCredit,
    netProceeds,
  }
}

/**
 * Rank offers by NET PROCEEDS and report whether the net winner differs from the price winner.
 */
export function rankOffersByNet(
  offers: OfferNetInput[],
  costs: Omit<SellerCosts, "buyerClosingCredit">,
): OfferNetRanking {
  const lines = offers.map((o) =>
    buildNetLine(o, { ...costs, buyerClosingCredit: o.buyerClosingCredit }),
  )
  if (lines.length === 0) {
    return { lines, topByPrice: null, topByNet: null, netBeatsPrice: false }
  }
  const byPrice = [...lines].sort((a, b) => b.offerPrice - a.offerPrice)[0]
  const byNet = [...lines].sort((a, b) => b.netProceeds - a.netProceeds)[0]
  return {
    lines,
    topByPrice: byPrice.offerId,
    topByNet: byNet.offerId,
    netBeatsPrice: byPrice.offerId !== byNet.offerId,
  }
}

export function fmtUsd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
}

function labelFor(line: OfferNetLine, idx: number): string {
  return line.buyerName ?? `Offer ${String.fromCharCode(65 + idx)}`
}

/**
 * Deterministic FALLBACK copy for the gated agent comparison summary.
 */
export function composeComparisonFallback(args: {
  listingAddress: string
  ranking: OfferNetRanking
}): { agentSummary: string; sellerCardBody: string } {
  const { listingAddress, ranking } = args
  const lines = ranking.lines
  const netWinner = lines.find((l) => l.offerId === ranking.topByNet) ?? lines[0]
  const priceWinner = lines.find((l) => l.offerId === ranking.topByPrice) ?? lines[0]
  const netWinnerIdx = lines.findIndex((l) => l.offerId === ranking.topByNet)
  const priceWinnerIdx = lines.findIndex((l) => l.offerId === ranking.topByPrice)
  const netWinnerLabel = labelFor(netWinner, netWinnerIdx < 0 ? 0 : netWinnerIdx)
  const priceWinnerLabel = labelFor(priceWinner, priceWinnerIdx < 0 ? 0 : priceWinnerIdx)

  let headline: string
  if (lines.length === 1) {
    headline = `Net sheet ready for ${listingAddress}: ${netWinnerLabel} nets the seller about ${fmtUsd(netWinner.netProceeds)} after costs.`
  } else if (ranking.netBeatsPrice) {
    const delta = netWinner.netProceeds - priceWinner.netProceeds
    headline = `Offer comparison ready for ${listingAddress}: ${netWinnerLabel} nets ~${fmtUsd(delta)} more than the highest-priced offer (${priceWinnerLabel}) despite a lower price — net proceeds beat sticker price here.`
  } else {
    headline = `Offer comparison ready for ${listingAddress}: ${netWinnerLabel} is both the highest price and the highest net to the seller (${fmtUsd(netWinner.netProceeds)} after costs).`
  }

  const agentSummary = [
    headline,
    `Side-by-side net proceeds (offer price − commission − payoff − taxes − HOA − other − buyer credit):`,
    lines
      .map((l, i) => `· ${labelFor(l, i)}: ${fmtUsd(l.offerPrice)} → nets ${fmtUsd(l.netProceeds)}`)
      .join("\n"),
    `Open the interactive net sheet to adjust the payoff, taxes, HOA and commission with the seller live, then approve the portal summary.`,
  ].join("\n")

  const sellerCardBody = [
    `We compared ${lines.length === 1 ? "your offer" : `your ${lines.length} offers`} by what you actually KEEP at closing — not just the price on the page.`,
    ranking.netBeatsPrice
      ? `The offer that puts the most in your pocket isn't the highest-priced one. Your agent will walk you through the full net sheet.`
      : `Your agent has the full net sheet ready and will walk you through every number.`,
    `This is a read-only summary — nothing is decided until you and your agent talk it through.`,
  ].join(" ")

  return { agentSummary, sellerCardBody }
}

/** A stable signature of the current offer-set (sorted, order-independent) for 24h idempotency. */
export function offerSetSignature(offerIds: string[]): string {
  return [...offerIds].sort().join(",")
}

/** Default seller-responsible cost assumptions when the data isn't on file (editable starting points). */
export function defaultSellerCosts(args: {
  listPrice: number | null
  commissionRateDecimal: number
  hoaDuesMonthly: number | null
}): Omit<SellerCosts, "buyerClosingCredit"> {
  const price = args.listPrice ?? 0
  return {
    commissionRate: args.commissionRateDecimal,
    mortgagePayoff: 0,
    countyCityTaxes: Math.round(price * 0.005),
    hoaDuesProration: args.hoaDuesMonthly ? Math.round(args.hoaDuesMonthly) : 0,
    otherProratedFees: Math.round(price * 0.01),
  }
}

// ─── Line-item PROVENANCE + confidence (the Seller Decision trust layer) ──────
//
// Every cost line knows WHERE its number came from, so the sheet can say
// "verified" vs "estimate — confirm with your agent" instead of presenting a
// default as a fact. Same discipline as the document kernel's per-field
// ledger, applied to the seller's money.

export type CostLineSource =
  | "public_record"      // pulled from a records lookup (tax data)
  | "confirmed"          // a human confirmed/entered the real figure
  | "template"           // brokerage/market template value
  | "regional_estimate"  // state-convention band (lib/offers/seller-closing-costs) — a LABELED estimate
  | "default"            // heuristic starting point — an ESTIMATE, not a fact

export type CostLineKey = "commissionRate" | "mortgagePayoff" | "countyCityTaxes" | "hoaDuesProration" | "otherProratedFees"

export type SellerCostProvenance = Record<CostLineKey, CostLineSource>

/** Everything starts as a default estimate until something better lands. */
export function defaultProvenance(): SellerCostProvenance {
  return {
    commissionRate: "template", // the brokerage's own rate — policy, not a guess
    mortgagePayoff: "default",
    countyCityTaxes: "default",
    hoaDuesProration: "default",
    otherProratedFees: "default",
  }
}

export type NetSheetConfidence = "high" | "medium" | "low"

/**
 * PURE: how much can a seller trust these numbers? The PAYOFF dominates —
 * a defaulted payoff of $0 silently overstates net proceeds by the whole
 * mortgage balance (the single worst failure a net sheet can have).
 */
export function netSheetConfidence(prov: SellerCostProvenance): NetSheetConfidence {
  const strong = (s: CostLineSource) => s === "confirmed" || s === "public_record"
  if (!strong(prov.mortgagePayoff)) return "low"
  if (strong(prov.countyCityTaxes) && strong(prov.hoaDuesProration)) return "high"
  return "medium"
}

export interface NetSheetPolicyVerdict {
  decision: "green" | "amber" | "red"
  reasons: string[]
  /** the lines still carrying estimates the agent should confirm. */
  needsConfirmation: CostLineKey[]
}

/**
 * PURE: may these numbers go seller-facing? green = presentation-grade;
 * amber = usable with estimate disclosure; red = the DOLLAR FIGURES stay
 * agent-only until the payoff is real (the comparison narrative may still
 * flow — it carries no numbers).
 */
export function decideNetSheetPolicy(prov: SellerCostProvenance): NetSheetPolicyVerdict {
  const confidence = netSheetConfidence(prov)
  // regional_estimate is BETTER than a blind default (labeled state-convention
  // band) but it is still an estimate — it stays on the disclose-first list.
  const needsConfirmation = (Object.keys(prov) as CostLineKey[]).filter(
    (k) => prov[k] === "default" || prov[k] === "regional_estimate",
  )
  if (confidence === "low") {
    return {
      decision: "red",
      reasons: ["the mortgage payoff is an unconfirmed default — net figures would overstate what the seller keeps"],
      needsConfirmation,
    }
  }
  if (confidence === "medium") {
    return {
      decision: "amber",
      reasons: [`estimates remain on: ${needsConfirmation.join(", ") || "prorations"} — disclose before presenting`],
      needsConfirmation,
    }
  }
  return { decision: "green", reasons: ["payoff and prorations verified or confirmed"], needsConfirmation }
}

// ─── Counter what-if (the scenario builder's pure core) ───────────────────────

export interface CounterScenario {
  counterPrice: number
  netProceeds: number
  /** net delta vs the offer as written. */
  deltaVsOffer: number
  /** plain-language tradeoff line — factual, no persuasion. */
  explanation: string
}

/** PURE: "what if we counter at X?" — recomputed net + the tradeoff, live. */
export function counterScenario(
  offer: { offerPrice: number; buyerClosingCredit: number },
  counterPrice: number,
  costs: Omit<SellerCosts, "buyerClosingCredit">,
): CounterScenario {
  const baseNet = computeNetProceeds(offer, costs)
  const counterNet = computeNetProceeds({ offerPrice: counterPrice, buyerClosingCredit: offer.buyerClosingCredit }, costs)
  const delta = counterNet - baseNet
  const explanation =
    delta === 0
      ? `Countering at ${fmtUsd(counterPrice)} nets the same as the offer as written.`
      : delta > 0
        ? `Countering at ${fmtUsd(counterPrice)} would net ${fmtUsd(delta)} more — if the buyer accepts. Weigh that against the risk of losing them.`
        : `Countering at ${fmtUsd(counterPrice)} would net ${fmtUsd(-delta)} less than the offer as written.`
  return { counterPrice, netProceeds: counterNet, deltaVsOffer: delta, explanation }
}

// ─── AGREED COMMISSION RESOLUTION ────────────────────────────────────────────
//
// Every net sheet must price the commission the seller ACTUALLY agreed to, not a
// house default. The agreed terms live on listing_agreements (rates stored as
// PERCENT values — 3 means 3% — matching lib/revenue-protection/scorer.ts and
// app/actions/seller-cma.ts). The seller normally pays BOTH sides, so a single
// listing-side rate understates the commission and OVERSTATES the seller's net.
//
// One resolver, used by every sheet, so the CMA tab and the offers tab cannot
// quote a seller two different numbers for the same listing.

export interface AgreementCommissionFields {
  listing_commission_rate: number | null
  buyer_commission_rate: number | null
  total_commission_rate: number | null
  commission_is_flat_fee: boolean | null
  commission_flat_amount: number | null
}

export interface AgreedCommission {
  /** Decimal rate to apply to the sale price (0.055 = 5.5%). */
  rate: number
  isFlatFee: boolean
  flatAmount: number | null
  source: CostLineSource
  /** Short provenance label for the UI — never present an estimate as a fact. */
  label: string
  /** True when no executed listing agreement backed the number. */
  isEstimate: boolean
}

/** The house fallback when nothing is on file. Matches defaultSellerCosts. */
export const FALLBACK_TOTAL_COMMISSION_RATE = 0.06

/**
 * PURE. Resolve the commission rate a seller net sheet should charge.
 * Precedence: flat fee → total rate → listing+buyer rates → listings.commission_rate
 * → house default. Anything below an executed agreement is flagged as an estimate.
 */
export function resolveAgreedCommission(args: {
  agreement: AgreementCommissionFields | null | undefined
  /** listings.commission_rate, a PERCENT value (listing side only). */
  listingCommissionRatePercent: number | null | undefined
  /** Price the flat fee is expressed against (list price or the offer price). */
  referencePrice: number | null | undefined
}): AgreedCommission {
  const a = args.agreement
  const price = Number(args.referencePrice ?? 0)

  if (a?.commission_is_flat_fee && a.commission_flat_amount != null) {
    const flat = Number(a.commission_flat_amount)
    return {
      rate: price > 0 ? flat / price : 0,
      isFlatFee: true,
      flatAmount: flat,
      source: "confirmed",
      label: "Flat fee per listing agreement",
      isEstimate: false,
    }
  }

  if (a?.total_commission_rate != null) {
    return {
      rate: Number(a.total_commission_rate) / 100,
      isFlatFee: false, flatAmount: null, source: "confirmed",
      label: "Total rate per listing agreement", isEstimate: false,
    }
  }

  if (a && (a.listing_commission_rate != null || a.buyer_commission_rate != null)) {
    const listing = Number(a.listing_commission_rate ?? 0)
    const buyer = Number(a.buyer_commission_rate ?? 0)
    return {
      rate: (listing + buyer) / 100,
      isFlatFee: false, flatAmount: null, source: "confirmed",
      label: `Listing ${listing}% + buyer ${buyer}% per listing agreement`,
      isEstimate: false,
    }
  }

  if (args.listingCommissionRatePercent != null) {
    return {
      rate: Number(args.listingCommissionRatePercent) / 100,
      isFlatFee: false, flatAmount: null, source: "template",
      label: "Listing-side rate only — no executed agreement on file",
      isEstimate: true,
    }
  }

  return {
    rate: FALLBACK_TOTAL_COMMISSION_RATE,
    isFlatFee: false, flatAmount: null, source: "default",
    label: "Estimate — no commission terms on file",
    isEstimate: true,
  }
}
