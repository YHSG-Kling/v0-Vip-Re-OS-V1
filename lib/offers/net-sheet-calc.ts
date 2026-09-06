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
  /**
   * Brokerage transaction fee charged to the SELLER at closing — a flat dollar
   * amount, never a percentage. Distinct from agent_commission_profiles.transaction_fee
   * and agents.transaction_fee, which are AGENT-side (paid out of the agent's split)
   * and must never reduce the seller's proceeds.
   */
  transactionFee: number
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
  transactionFee: number
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
    costs.otherProratedFees -
    costs.transactionFee
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
      transactionFee: costs.transactionFee,
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
    transactionFee: costs.transactionFee,
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
  /** Brokerage transaction fee charged to the seller — flat dollars, default 0. */
  transactionFee?: number | null
}): Omit<SellerCosts, "buyerClosingCredit"> {
  const price = args.listPrice ?? 0
  return {
    commissionRate: args.commissionRateDecimal,
    mortgagePayoff: 0,
    countyCityTaxes: Math.round(price * 0.005),
    hoaDuesProration: args.hoaDuesMonthly ? Math.round(args.hoaDuesMonthly) : 0,
    otherProratedFees: Math.round(price * 0.01),
    transactionFee: args.transactionFee != null ? Math.round(Number(args.transactionFee)) : 0,
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

export type CostLineKey = "commissionRate" | "mortgagePayoff" | "countyCityTaxes" | "hoaDuesProration" | "otherProratedFees" | "transactionFee"

export type SellerCostProvenance = Record<CostLineKey, CostLineSource>

/** Everything starts as a default estimate until something better lands. */
export function defaultProvenance(): SellerCostProvenance {
  return {
    commissionRate: "template", // the brokerage's own rate — policy, not a guess
    mortgagePayoff: "default",
    countyCityTaxes: "default",
    hoaDuesProration: "default",
    otherProratedFees: "default",
    // A brokerage transaction fee is policy, not a guess — but it defaults to
    // zero, and zero is a real answer (many brokerages charge none).
    transactionFee: "template",
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
  // ── THE NEGOTIATED CONCESSION ────────────────────────────────────────────
  // An agent who discounts a military or repeat-client seller records it HERE,
  // on the agreement, the moment the agreement is uploaded
  // (app/actions/seller-listing/execution-engine.ts:899-902). The commission
  // LEDGER row that reduces the invoice at closing
  // (`commission_adjustments`, read by the waterfall) can only be written when
  // a TRANSACTION already exists — which, for a listing that has just gone
  // live, it does not. So between "the agreement is signed" and "the deal is
  // under contract" — exactly the window in which every net sheet on this page
  // is produced — the agreement was the ONLY record of the discount, and no
  // sheet read it. Every seller net sheet quoted the FULL commission the agent
  // had already promised to cut.
  //
  // OPTIONAL on purpose: a caller whose select does not name these columns is
  // unchanged, and gets exactly the unadjusted number it got before.
  has_commission_adjustment?: boolean | null
  /** The REASON vocabulary (military, repeat_client, …) — carried for labelling only. */
  adjustment_type?: string | null
  /** The magnitude. Its UNIT is adjustment_value_type and is never assumed. */
  adjustment_value?: number | null
  /** Live CHECK: 'percent' | 'flat' (scripts/check-vocabularies.ts:853). */
  adjustment_value_type?: string | null
}

/** The two units the live CHECK allows on listing_agreements.adjustment_value_type. */
const ADJUSTMENT_VALUE_TYPES = ["percent", "flat"] as const

/**
 * How the recorded concession was (or was not) applied to the rate. NEVER
 * collapsed into "no adjustment" — a discount that could not be priced is a
 * different fact from a seller who negotiated none, and the difference is money.
 */
export type CommissionAdjustmentState =
  /** No concession is recorded on the agreement. */
  | "none"
  /** Applied: a percentage came off the total rate. */
  | "applied_percent"
  /** Applied: a flat dollar amount came off the commission. */
  | "applied_flat"
  /** Recorded, but adjustment_value_type is NULL or outside the CHECK — the unit
   *  is unknown, so applying it would be a guess about a dollar figure. */
  | "unit_unknown"
  /** Recorded with no value, or against a price of 0 for a flat amount — nothing
   *  to subtract. */
  | "not_priceable"
  /** Recorded, but the base is a flat FEE, not a rate: the concession belongs on
   *  the fee itself and this resolver will not invent that arithmetic. */
  | "flat_fee_base"

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
  /** What happened to the agreement's recorded concession. See the type. */
  adjustmentState: CommissionAdjustmentState
  /** The rate BEFORE the concession, when one was applied; null otherwise. */
  rateBeforeAdjustment: number | null
  /**
   * TRUE when a concession IS recorded on the agreement and this resolver could
   * not price it ('unit_unknown', 'not_priceable', 'flat_fee_base'). The number
   * returned is then the UNDISCOUNTED commission, i.e. the seller's net is
   * understated — the caller must say so rather than print it flat.
   */
  adjustmentUnpriced: boolean
}

/** The house fallback when nothing is on file. Matches defaultSellerCosts. */
export const FALLBACK_TOTAL_COMMISSION_RATE = 0.06

/**
 * PURE. Apply the agreement's recorded commission concession to a resolved rate,
 * HONOURING THE STORED UNIT.
 *
 * `adjustment_value` is a bare number; `adjustment_value_type` is the only thing
 * that says whether 1 means one PERCENT of the sale price or one DOLLAR. On a
 * $700,000 sale those two readings differ by roughly $6,999 in the seller's
 * pocket — which is why the unit is never assumed here. Where the ledger writer
 * falls back to "percent" when the type is absent
 * (execution-engine.ts:963, `?? "percent"`), this refuses instead: the caller is
 * told the concession could not be priced and the UNDISCOUNTED number is
 * returned, because understating a discount is a number the agent can spot and
 * fix, while silently applying the wrong unit is not.
 *
 * The concession is a CREDIT (a reduction) — that is the direction the ledger
 * writer stamps for a seller-negotiated listing concession — and the resulting
 * rate is floored at 0: a discount larger than the commission zeroes it, it
 * never pays the seller.
 */
function applyAgreementAdjustment(
  base: AgreedCommission,
  a: AgreementCommissionFields | null | undefined,
  price: number,
): AgreedCommission {
  const value = a?.adjustment_value
  // has_commission_adjustment is the agent's own "yes, there is one" flag; a
  // value without it (or vice versa) is still treated as recorded, because
  // either half alone is evidence a concession was entered.
  const recorded = !!(a && (a.has_commission_adjustment || value != null))
  if (!recorded) return base

  const unit = a?.adjustment_value_type
  const unitKnown = typeof unit === "string" && (ADJUSTMENT_VALUE_TYPES as readonly string[]).includes(unit)
  const unpriced = (state: CommissionAdjustmentState): AgreedCommission => ({
    ...base,
    adjustmentState: state,
    rateBeforeAdjustment: null,
    adjustmentUnpriced: true,
  })

  if (!unitKnown) return unpriced("unit_unknown")
  if (value == null || !Number.isFinite(Number(value))) return unpriced("not_priceable")
  if (base.isFlatFee) return unpriced("flat_fee_base")

  const v = Number(value)
  if (unit === "percent") {
    const adjusted = Math.max(0, base.rate - v / 100)
    return {
      ...base,
      rate: adjusted,
      rateBeforeAdjustment: base.rate,
      adjustmentState: "applied_percent",
      adjustmentUnpriced: false,
      label: `${base.label} · less ${v}% ${commissionConcessionLabel(a?.adjustment_type)}`,
    }
  }

  // 'flat': dollars off the commission. Expressing it as a rate needs a price to
  // divide by; without one there is nothing to express and nothing is guessed.
  if (!(price > 0)) return unpriced("not_priceable")
  const adjusted = Math.max(0, base.rate - v / price)
  return {
    ...base,
    rate: adjusted,
    rateBeforeAdjustment: base.rate,
    adjustmentState: "applied_flat",
    adjustmentUnpriced: false,
    label: `${base.label} · less ${fmtUsd(v)} ${commissionConcessionLabel(a?.adjustment_type)}`,
  }
}

/** Reason → a short human tail for the provenance label. Unknown reasons say so. */
function commissionConcessionLabel(reason: string | null | undefined): string {
  if (!reason) return "agreed concession"
  return `${reason.replace(/_/g, " ")} concession`
}

/**
 * PURE. Resolve the commission rate a seller net sheet should charge.
 * Precedence: flat fee → total rate → listing+buyer rates → listings.commission_rate
 * → house default. Anything below an executed agreement is flagged as an estimate.
 *
 * Then, and only on an agreement-backed base, the agreement's recorded concession
 * is applied through applyAgreementAdjustment above — see that function for why
 * the stored unit is honoured rather than defaulted.
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
  /** Defaults every branch below shares: no concession seen yet. */
  const unadjusted = { adjustmentState: "none" as CommissionAdjustmentState, rateBeforeAdjustment: null, adjustmentUnpriced: false }

  if (a?.commission_is_flat_fee && a.commission_flat_amount != null) {
    const flat = Number(a.commission_flat_amount)
    return applyAgreementAdjustment({
      rate: price > 0 ? flat / price : 0,
      isFlatFee: true,
      flatAmount: flat,
      source: "confirmed",
      label: "Flat fee per listing agreement",
      isEstimate: false,
      ...unadjusted,
    }, a, price)
  }

  if (a?.total_commission_rate != null) {
    return applyAgreementAdjustment({
      rate: Number(a.total_commission_rate) / 100,
      isFlatFee: false, flatAmount: null, source: "confirmed",
      label: "Total rate per listing agreement", isEstimate: false,
      ...unadjusted,
    }, a, price)
  }

  if (a && (a.listing_commission_rate != null || a.buyer_commission_rate != null)) {
    const listing = Number(a.listing_commission_rate ?? 0)
    const buyer = Number(a.buyer_commission_rate ?? 0)
    return applyAgreementAdjustment({
      rate: (listing + buyer) / 100,
      isFlatFee: false, flatAmount: null, source: "confirmed",
      label: `Listing ${listing}% + buyer ${buyer}% per listing agreement`,
      isEstimate: false,
      ...unadjusted,
    }, a, price)
  }

  // Below this line there is no agreement backing the rate, so there is no
  // agreement concession to apply either.
  if (args.listingCommissionRatePercent != null) {
    return {
      rate: Number(args.listingCommissionRatePercent) / 100,
      isFlatFee: false, flatAmount: null, source: "template",
      label: "Listing-side rate only — no executed agreement on file",
      isEstimate: true,
      ...unadjusted,
    }
  }

  return {
    rate: FALLBACK_TOTAL_COMMISSION_RATE,
    isFlatFee: false, flatAmount: null, source: "default",
    label: "Estimate — no commission terms on file",
    isEstimate: true,
    ...unadjusted,
  }
}

// ── Closing-cost tiering (owner ruling, round 4) ─────────────────────────────

export interface ResolvedClosingCosts {
  amount: number
  source: CostLineSource
  /** Seller-readable provenance — never present an estimate as a fact. */
  label: string
  isEstimate: boolean
}

/** The house fallback when a brokerage has configured nothing and the state is unknown. */
export const FALLBACK_CLOSING_COST_PERCENT = 0.02

/**
 * PURE. Resolve the seller's closing-cost line, with provenance.
 *
 * Precedence (owner's ruling): a real, entered figure → the BROKERAGE's configured
 * percent → the county-customary regional band → the 2% house default.
 *
 * THE SUBTLETY THAT MAKES THIS HONEST. brokerage_settings.financial_defaults
 * .closing_cost_percent has a hardcoded fallback of 0.02 in get-brokerage-settings,
 * so a brokerage that never configured it reports exactly the same 0.02 as one that
 * deliberately chose it. Ranking that above the regional band would let the house
 * default masquerade as brokerage policy AND outrank real county title/doc-stamp
 * math — the precise dishonesty this provenance system exists to prevent.
 *
 * So the brokerage tier only applies when its percent DIFFERS from the house
 * fallback. At exactly 2% it is indistinguishable from "unset", and the regional
 * band — which is strictly better information — wins and is labelled as the
 * estimate it is.
 */
export function resolveClosingCosts(args: {
  /** An agent-entered or agreement figure, in dollars. */
  explicitAmount: number | null | undefined
  /** brokerage financial_defaults.closing_cost_percent, a FRACTION (0.02 = 2%). */
  brokerageClosingCostPercent: number | null | undefined
  /** deriveNetSheetClosingCostSection(...).midpoint, in dollars. */
  regionalMidpoint: number | null | undefined
  salePrice: number
}): ResolvedClosingCosts {
  const price = Number(args.salePrice) || 0

  const explicit = args.explicitAmount
  if (explicit != null && Number.isFinite(Number(explicit))) {
    return {
      amount: Number(explicit),
      source: "confirmed",
      label: "Closing costs as entered",
      isEstimate: false,
    }
  }

  const pct = Number(args.brokerageClosingCostPercent)
  const brokerageConfigured =
    Number.isFinite(pct) && pct > 0 && Math.abs(pct - FALLBACK_CLOSING_COST_PERCENT) > 1e-9
  if (brokerageConfigured) {
    return {
      amount: price * pct,
      source: "template",
      label: `Brokerage default (${(pct * 100).toFixed(2).replace(/\.?0+$/, "")}%)`,
      isEstimate: true,
    }
  }

  const regional = Number(args.regionalMidpoint)
  if (Number.isFinite(regional) && regional > 0) {
    return {
      amount: regional,
      source: "regional_estimate",
      label: "County-customary estimate for this state",
      isEstimate: true,
    }
  }

  return {
    amount: price * FALLBACK_CLOSING_COST_PERCENT,
    source: "default",
    label: "Estimated at 2% — no state or brokerage figure on file",
    isEstimate: true,
  }
}
