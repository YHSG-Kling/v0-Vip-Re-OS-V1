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
