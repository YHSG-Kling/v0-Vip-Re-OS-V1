// lib/kernel/seller-decision-room.ts
//
// THE SELLER DECISION ROOM — turns offer_net_sheet's net-proceeds comparison into a guided,
// SELLER-FACING decision. For each offer it models the OUTCOME (net to you + when it closes + how
// likely it is to close), names the highest-money vs the safest-bet, and recommends the one that
// balances both — killing the seller's anxiety "which offer is actually best for me?". It REUSES
// the existing pure math (computeNetProceeds + scoreBuyerStrength) — no parallel logic — and the
// real accept/counter/reject actions stay where they are (compliance-gated). PURE composer.

import { computeNetProceeds } from "@/lib/kernel/offer-net-sheet"
import { scoreBuyerStrength, labelStrength, type StrengthLabel } from "@/lib/offers/offer-strength"

export interface SellerCosts {
  commissionRate: number
  mortgagePayoff: number
  countyCityTaxes: number
  hoaDuesProration: number
  otherProratedFees: number
}

export interface DecisionOffer {
  offerId: string
  buyerName: string | null
  offerPrice: number
  financingType: string | null
  downPaymentPercent: number | null
  contingencies: string[]
  emd: number | null
  buyerClosingCredit: number
  /** Days from now to the proposed close (null when unknown). */
  closeDateDays: number | null
}

export interface DecisionCard {
  offerId: string
  buyerName: string | null
  price: number
  netProceeds: number
  closeDateDays: number | null
  strengthScore: number
  strengthLabel: StrengthLabel
  contingencyCount: number
  financingType: string | null
  isTopNet: boolean
  isTopCertainty: boolean
  /** Factual, plain-English modeled outcome for the seller (not marketing copy). */
  modeledOutcome: string
}

export interface SellerDecisionRoom {
  cards: DecisionCard[]
  /** The offer that best balances money + certainty (deterministic). */
  recommendedOfferId: string | null
  recommendationReason: string
  /** True when the highest NET offer isn't the highest STICKER price — the insight sellers miss. */
  netBeatsPrice: boolean
}

const money = (n: number) => `$${Math.round(n).toLocaleString()}`

/** Pure: build the guided seller decision. Empty in → empty out (no fabrication). */
export function buildSellerDecisionRoom(offers: DecisionOffer[], costs: SellerCosts): SellerDecisionRoom {
  if (offers.length === 0) {
    return { cards: [], recommendedOfferId: null, recommendationReason: "No active offers yet.", netBeatsPrice: false }
  }

  const enriched = offers.map((o) => {
    const netProceeds = computeNetProceeds({ offerPrice: o.offerPrice, buyerClosingCredit: o.buyerClosingCredit }, costs)
    const strengthScore = scoreBuyerStrength({
      financingType: o.financingType, downPaymentPercent: o.downPaymentPercent,
      contingencies: o.contingencies, emd: o.emd, offerPrice: o.offerPrice,
    })
    return { o, netProceeds, strengthScore }
  })

  const topNetId = [...enriched].sort((a, b) => b.netProceeds - a.netProceeds)[0].o.offerId
  const topCertaintyId = [...enriched].sort((a, b) => b.strengthScore - a.strengthScore)[0].o.offerId
  const topPriceId = [...enriched].sort((a, b) => b.o.offerPrice - a.o.offerPrice)[0].o.offerId
  const maxNet = Math.max(...enriched.map((e) => e.netProceeds), 1)

  const cards: DecisionCard[] = enriched.map((e) => {
    const isTopNet = e.o.offerId === topNetId
    const isTopCertainty = e.o.offerId === topCertaintyId
    const label = labelStrength(e.strengthScore)
    const tag = isTopNet && isTopCertainty ? "most money AND safest"
      : isTopNet ? "most money" : isTopCertainty ? "safest to close" : "in the mix"
    const closes = e.o.closeDateDays != null ? `closes in ~${e.o.closeDateDays} days` : "close date TBD"
    const fin = e.o.financingType ? e.o.financingType : "financing unspecified"
    return {
      offerId: e.o.offerId, buyerName: e.o.buyerName, price: e.o.offerPrice, netProceeds: e.netProceeds,
      closeDateDays: e.o.closeDateDays, strengthScore: e.strengthScore, strengthLabel: label,
      contingencyCount: e.o.contingencies.length, financingType: e.o.financingType, isTopNet, isTopCertainty,
      modeledOutcome: `Nets you ${money(e.netProceeds)}, ${closes}. Buyer looks ${label} (${e.strengthScore}/100 — ${fin}, ${e.o.contingencies.length} contingenc${e.o.contingencies.length === 1 ? "y" : "ies"}). The ${tag}.`,
    }
  })

  // Recommend the offer that balances money + certainty: when one offer is BOTH, pick it; else the
  // highest combined score (60% net, 40% certainty) — a deterministic, explainable tradeoff.
  let recommendedOfferId: string
  let recommendationReason: string
  if (topNetId === topCertaintyId) {
    recommendedOfferId = topNetId
    recommendationReason = "This offer is both the highest net to you AND the most likely to close — the clear pick."
  } else {
    const ranked = [...enriched].sort((a, b) =>
      (b.netProceeds / maxNet * 0.6 + b.strengthScore / 100 * 0.4) - (a.netProceeds / maxNet * 0.6 + a.strengthScore / 100 * 0.4))
    recommendedOfferId = ranked[0].o.offerId
    const topNet = enriched.find((e) => e.o.offerId === topNetId)!
    const topCert = enriched.find((e) => e.o.offerId === topCertaintyId)!
    recommendationReason = `Highest net is ${money(topNet.netProceeds)} (offer ${topNetId.slice(0, 8)}), but the safest to close scores ${topCert.strengthScore}/100. Balancing money and certainty, we'd lean toward offer ${recommendedOfferId.slice(0, 8)}.`
  }

  return { cards, recommendedOfferId, recommendationReason, netBeatsPrice: topNetId !== topPriceId }
}
