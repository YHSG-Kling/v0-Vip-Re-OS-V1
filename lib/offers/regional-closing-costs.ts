// lib/offers/regional-closing-costs.ts
//
// REGION-AWARE CLOSING-COST CONVENTIONS (owner: "closing costs are derived by
// REGION estimates"). A PURE, provenance-labeled model of the REAL published
// closing conventions for all 50 states + DC — the things that ARE estimable
// before a lender exists: transfer taxes (and who customarily pays them), title
// insurance pricing conventions, the settlement/attorney model, recording-fee
// bands, and effective property-tax bands (which drive prepaids/escrow months).
//
// HONESTY CONTRACT:
//   - Every figure this module produces is labeled "regional estimate — {state}
//     conventions". It is NEVER presented as the lender's number; the lender's
//     Loan Estimate / Closing Disclosure remain the named authority (TRID).
//   - These are CONVENTIONS (who customarily pays, rate structures set by
//     statute or filed with insurance regulators) — not market data that drifts
//     daily, which is why they live in code, not a table.
//   - Rates are honest approximations of the published structures. Where a
//     state's reality is graduated or county-split (WA REET tiers, MD county
//     transfer, NYC RPTT), the note SAYS so instead of faking precision.
//   - The deterministic model is the floor: the optional AI refinement step can
//     only adjust WITHIN bounds of these bands (applyAiRefinements below), can
//     never touch a lender-fact line, and must explain every adjustment.

import type { BuyerCostLine } from "./buyer-closing-costs"

export type CustomaryPayer = "buyer" | "seller" | "split" | "varies" | "none"

export type TitleConvention =
  | "regulated_promulgated" // premiums promulgated by the state (TX, NM, FL, PA, LA) — identical at every title company
  | "filed_rates"           // insurer-filed rates approved by the state DOI
  | "negotiable"            // agent/attorney-quoted, shop-able
  | "state_title_guaranty"  // Iowa only: private title insurance barred; Iowa Title Guaranty flat fee

export type SettlementModel = "escrow_company" | "title_company" | "attorney" | "mixed"

export interface RegionalConventions {
  state: string      // USPS code
  stateName: string
  /** combined typical state+local transfer/deed tax as % of price (0 = none) */
  transferTaxPct: number
  transferTaxPayer: CustomaryPayer
  transferTaxNote: string
  titleConvention: TitleConvention
  /** owner's title policy premium band as % of price */
  ownerTitleLowPct: number
  ownerTitleHighPct: number
  /** who customarily pays the OWNER'S policy (contract always controls) */
  ownerTitlePayer: CustomaryPayer
  titleNote: string
  settlementModel: SettlementModel
  settlementFeeLow: number
  settlementFeeHigh: number
  /** attorney conducts/must supervise the closing (published convention) */
  attorneyClosing: boolean
  recordingFeeLow: number
  recordingFeeHigh: number
  /** effective annual property-tax band as % of value (drives prepaids) */
  propertyTaxLowPct: number
  propertyTaxHighPct: number
}

// ─── The 50-state + DC convention table ─────────────────────────────────────
// Shorthand builder keeps 51 rows readable. Order of args mirrors the interface.
const s = (
  state: string, stateName: string,
  transferTaxPct: number, transferTaxPayer: CustomaryPayer, transferTaxNote: string,
  titleConvention: TitleConvention, ownerTitleLowPct: number, ownerTitleHighPct: number,
  ownerTitlePayer: CustomaryPayer, titleNote: string,
  settlementModel: SettlementModel, settlementFeeLow: number, settlementFeeHigh: number, attorneyClosing: boolean,
  recordingFeeLow: number, recordingFeeHigh: number,
  propertyTaxLowPct: number, propertyTaxHighPct: number,
): RegionalConventions => ({
  state, stateName, transferTaxPct, transferTaxPayer, transferTaxNote,
  titleConvention, ownerTitleLowPct, ownerTitleHighPct, ownerTitlePayer, titleNote,
  settlementModel, settlementFeeLow, settlementFeeHigh, attorneyClosing,
  recordingFeeLow, recordingFeeHigh, propertyTaxLowPct, propertyTaxHighPct,
})

const CONVENTIONS: Record<string, RegionalConventions> = {
  AL: s("AL", "Alabama", 0.1, "seller", "deed tax $0.50 per $500 — customarily seller-paid, negotiable",
    "negotiable", 0.3, 0.55, "buyer", "attorney-agent market; owner's policy optional but standard",
    "attorney", 600, 1200, false, 50, 150, 0.35, 0.45),
  AK: s("AK", "Alaska", 0, "none", "no state transfer tax",
    "filed_rates", 0.25, 0.5, "varies", "escrow/title closings; owner's-policy payer varies by region",
    "title_company", 600, 1400, false, 100, 250, 0.95, 1.25),
  AZ: s("AZ", "Arizona", 0, "none", "no transfer tax (flat $2 recording transfer fee)",
    "filed_rates", 0.3, 0.5, "seller", "seller customarily pays the owner's policy; escrow fee split",
    "escrow_company", 800, 1800, false, 30, 100, 0.5, 0.7),
  AR: s("AR", "Arkansas", 0.33, "seller", "real property transfer tax $3.30 per $1,000, customarily seller-paid",
    "filed_rates", 0.3, 0.55, "varies", "payer varies by county custom",
    "title_company", 500, 1000, false, 50, 150, 0.55, 0.7),
  CA: s("CA", "California", 0.11, "seller", "county documentary transfer tax $1.10 per $1,000; city taxes add more (LA, SF, Oakland…); customarily seller-paid in most counties",
    "filed_rates", 0.2, 0.45, "varies", "Northern CA custom: buyer pays owner's policy; Southern CA: seller",
    "escrow_company", 1000, 2500, false, 100, 250, 1.1, 1.3), // Prop 13: ~1% of PURCHASE price + local add-ons — statewide 'effective' averages understate a NEW purchase
  CO: s("CO", "Colorado", 0.01, "buyer", "documentary fee $0.01 per $100 — nominal, customarily buyer-paid",
    "filed_rates", 0.4, 0.6, "seller", "seller customarily pays the owner's policy",
    "title_company", 400, 900, false, 50, 150, 0.45, 0.55),
  CT: s("CT", "Connecticut", 1.0, "seller", "state conveyance 0.75% (1.25% over $800k) + 0.25% municipal, seller-paid",
    "negotiable", 0.3, 0.6, "buyer", "attorney-agent market",
    "attorney", 1000, 2000, true, 150, 350, 1.7, 2.0),
  DE: s("DE", "Delaware", 4.0, "split", "4% total transfer tax, customarily split 50/50 (buyer side ~2%); first-time-buyer reduction on the state share",
    "negotiable", 0.3, 0.5, "buyer", "attorney closing state",
    "attorney", 900, 1800, true, 100, 300, 0.5, 0.65),
  DC: s("DC", "District of Columbia", 2.2, "split", "1.1% recordation (buyer) + 1.1% transfer (seller); 1.45% each over $400k",
    "filed_rates", 0.3, 0.5, "buyer", "title-company closings",
    "title_company", 800, 1800, false, 150, 350, 0.55, 0.85),
  FL: s("FL", "Florida", 0.7, "seller", "doc stamps $0.70 per $100 on the deed ($0.60 + surtax in Miami-Dade), customarily seller-paid; the BUYER also owes note stamps (0.35%) + intangible tax (0.2%) on any MORTGAGE — pending the loan amount",
    "regulated_promulgated", 0.5, 0.6, "varies", "promulgated premium (~$5.75/$1,000 first $100k); seller pays owner's policy in most counties, buyer in Miami-Dade/Broward",
    "title_company", 500, 1200, false, 100, 250, 0.8, 0.95),
  GA: s("GA", "Georgia", 0.1, "seller", "transfer tax $1 per $1,000, seller-paid; buyer owes intangibles tax on the mortgage ($1.50/$500 of loan) — pending the loan amount",
    "negotiable", 0.25, 0.45, "buyer", "attorney closing state (attorney must conduct)",
    "attorney", 800, 1500, true, 25, 100, 0.85, 1.0),
  HI: s("HI", "Hawaii", 0.15, "seller", "conveyance tax tiered 0.1%–1.25%+ by price and owner-occupancy, seller-paid",
    "filed_rates", 0.3, 0.5, "split", "escrow state; owner's policy customarily split ~60/40 seller/buyer",
    "escrow_company", 900, 2000, false, 100, 300, 0.28, 0.35),
  ID: s("ID", "Idaho", 0, "none", "no transfer tax",
    "filed_rates", 0.3, 0.5, "seller", "seller customarily pays the owner's policy",
    "title_company", 500, 1000, false, 45, 120, 0.55, 0.7),
  IL: s("IL", "Illinois", 0.15, "seller", "state 0.10% + county 0.05%, seller-paid; Chicago adds $3.75/$500 CITY portion customarily BUYER-paid",
    "filed_rates", 0.25, 0.5, "seller", "seller customarily provides the owner's policy; attorney review customary in Chicago metro",
    "attorney", 800, 1800, false, 60, 150, 2.0, 2.3),
  IN: s("IN", "Indiana", 0, "none", "no transfer tax",
    "filed_rates", 0.3, 0.55, "buyer", "title-company closings",
    "title_company", 400, 900, false, 45, 120, 0.75, 0.9),
  IA: s("IA", "Iowa", 0.16, "seller", "revenue tax $1.60 per $1,000 (first $500 exempt), seller-paid",
    "state_title_guaranty", 0, 0.05, "buyer", "private title insurance is barred in Iowa — Iowa Title Guaranty issues coverage at a low flat fee (~$175 up to $750k)",
    "mixed", 500, 1200, false, 50, 150, 1.4, 1.6),
  KS: s("KS", "Kansas", 0, "none", "no transfer tax (mortgage registration tax repealed 2019)",
    "filed_rates", 0.3, 0.55, "split", "owner's policy customarily split",
    "title_company", 500, 1100, false, 60, 150, 1.3, 1.45),
  KY: s("KY", "Kentucky", 0.1, "seller", "deed tax $0.50 per $500, seller-paid",
    "filed_rates", 0.3, 0.55, "buyer", "attorney closings customary",
    "attorney", 600, 1200, false, 50, 150, 0.8, 0.9),
  LA: s("LA", "Louisiana", 0, "none", "no state transfer tax (New Orleans levies a flat documentary tax ~$325)",
    "regulated_promulgated", 0.35, 0.6, "buyer", "premiums set by the Dept. of Insurance; notary/attorney closing state",
    "attorney", 800, 1600, true, 100, 300, 0.5, 0.65),
  ME: s("ME", "Maine", 0.44, "split", "transfer tax $2.20 per $500 total — half buyer, half seller by statute",
    "filed_rates", 0.3, 0.5, "buyer", "title-company and attorney closings both common",
    "mixed", 600, 1300, false, 50, 150, 1.2, 1.4),
  MD: s("MD", "Maryland", 1.5, "split", "0.5% state transfer + county transfer (up to 1.5%) + recordation tax; customarily split 50/50; first-time-buyer relief on the state share",
    "filed_rates", 0.35, 0.6, "buyer", "attorney or title-company settlements",
    "mixed", 800, 1800, false, 100, 300, 1.0, 1.15),
  MA: s("MA", "Massachusetts", 0.456, "seller", "deed excise $4.56 per $1,000, seller-paid",
    "negotiable", 0.25, 0.45, "buyer", "attorney closing state (conveyancing attorney)",
    "attorney", 1000, 2000, true, 150, 300, 1.1, 1.25),
  MI: s("MI", "Michigan", 0.86, "seller", "state 0.75% + county 0.11%, seller-paid",
    "filed_rates", 0.3, 0.55, "seller", "seller customarily pays the owner's policy",
    "title_company", 500, 1100, false, 50, 150, 1.3, 1.5),
  MN: s("MN", "Minnesota", 0.33, "seller", "deed tax 0.33% (0.34% Hennepin/Ramsey), seller-paid; buyer owes mortgage registry tax 0.23% of any loan — pending the loan amount",
    "filed_rates", 0.25, 0.45, "buyer", "title-company closings",
    "title_company", 500, 1200, false, 50, 150, 1.05, 1.15),
  MS: s("MS", "Mississippi", 0, "none", "no transfer tax",
    "filed_rates", 0.3, 0.55, "buyer", "attorney closing state",
    "attorney", 700, 1400, true, 50, 150, 0.65, 0.8),
  MO: s("MO", "Missouri", 0, "none", "no transfer tax",
    "filed_rates", 0.3, 0.5, "seller", "seller customarily pays the owner's policy",
    "title_company", 400, 900, false, 50, 150, 0.9, 1.0),
  MT: s("MT", "Montana", 0, "none", "no transfer tax",
    "filed_rates", 0.3, 0.5, "seller", "seller customarily pays the owner's policy",
    "title_company", 500, 1100, false, 50, 150, 0.7, 0.85),
  NE: s("NE", "Nebraska", 0.225, "seller", "documentary stamp tax $2.25 per $1,000, seller-paid",
    "filed_rates", 0.3, 0.55, "split", "owner's policy customarily split",
    "title_company", 400, 1000, false, 50, 150, 1.5, 1.65),
  NV: s("NV", "Nevada", 0.51, "seller", "real property transfer tax $1.95–$2.55 per $500 by county (Clark $2.55), customarily seller-paid",
    "filed_rates", 0.25, 0.45, "seller", "seller customarily pays the owner's policy; buyer pays the lender's",
    "escrow_company", 700, 1500, false, 40, 120, 0.5, 0.6),
  NH: s("NH", "New Hampshire", 1.5, "split", "transfer tax $1.50 per $100 total — half buyer, half seller by statute",
    "filed_rates", 0.3, 0.5, "buyer", "title-company and attorney closings both common",
    "mixed", 700, 1400, false, 60, 150, 1.85, 2.1),
  NJ: s("NJ", "New Jersey", 1.0, "seller", "graduated realty transfer fee ~1%, seller-paid; the BUYER pays the 1% 'mansion tax' at $1M+",
    "filed_rates", 0.4, 0.55, "buyer", "North Jersey: attorney-review closings; South Jersey: title companies",
    "mixed", 800, 1800, false, 100, 300, 2.1, 2.4),
  NM: s("NM", "New Mexico", 0, "none", "no transfer tax",
    "regulated_promulgated", 0.4, 0.6, "varies", "premiums promulgated statewide; payer custom varies",
    "title_company", 600, 1300, false, 50, 150, 0.7, 0.85),
  NY: s("NY", "New York", 0.4, "seller", "state transfer 0.4% seller-paid (+0.65% over $3M); NYC adds 1%–1.425% RPTT (seller); the BUYER pays the graduated 'mansion tax' (1% at $1M, up to 3.9%)",
    "filed_rates", 0.4, 0.6, "buyer", "TIRSA-filed rates; attorney closing state",
    "attorney", 1500, 3000, true, 200, 500, 1.3, 1.6),
  NC: s("NC", "North Carolina", 0.2, "seller", "excise tax $1 per $500, seller-paid; a few coastal counties add a 1% land-transfer tax",
    "filed_rates", 0.2, 0.4, "buyer", "attorney closing state (attorney must supervise)",
    "attorney", 800, 1500, true, 50, 150, 0.7, 0.85),
  ND: s("ND", "North Dakota", 0, "none", "no transfer tax",
    "filed_rates", 0.3, 0.5, "seller", "seller customarily pays the owner's policy",
    "title_company", 500, 1100, false, 40, 120, 0.95, 1.05),
  OH: s("OH", "Ohio", 0.2, "seller", "0.1% state conveyance + county permissive up to 0.3% (most levy it), seller-paid",
    "filed_rates", 0.3, 0.55, "split", "owner's policy customarily split evenly in much of Ohio",
    "title_company", 500, 1200, false, 60, 150, 1.45, 1.6),
  OK: s("OK", "Oklahoma", 0.15, "seller", "documentary stamps $0.75 per $500, seller-paid",
    "negotiable", 0.3, 0.55, "buyer", "abstract-and-attorney-opinion tradition alongside title policies",
    "mixed", 500, 1200, false, 40, 120, 0.85, 1.0),
  OR: s("OR", "Oregon", 0, "none", "no transfer tax (constitutionally barred) except Washington County's 0.1%",
    "filed_rates", 0.25, 0.45, "split", "escrow state; title + escrow charges customarily split",
    "escrow_company", 800, 1600, false, 100, 250, 0.85, 1.0),
  PA: s("PA", "Pennsylvania", 2.0, "split", "1% state + ~1% local (Philadelphia total ~4.28%, Pittsburgh ~5%), customarily split 50/50",
    "regulated_promulgated", 0.5, 0.7, "buyer", "TIRBOP promulgated ALL-INCLUSIVE rate — the premium bundles most settlement services",
    "title_company", 500, 1200, false, 150, 400, 1.35, 1.55),
  RI: s("RI", "Rhode Island", 0.46, "seller", "conveyance tax $2.30 per $500, seller-paid",
    "negotiable", 0.3, 0.5, "buyer", "attorney closing state",
    "attorney", 900, 1800, true, 100, 250, 1.3, 1.5),
  SC: s("SC", "South Carolina", 0.37, "seller", "deed recording fee $1.85 per $500, seller-paid",
    "filed_rates", 0.25, 0.45, "buyer", "attorney closing state (attorney must supervise)",
    "attorney", 800, 1500, true, 25, 100, 0.5, 0.6),
  SD: s("SD", "South Dakota", 0.1, "seller", "transfer fee $0.50 per $500, seller-paid",
    "filed_rates", 0.3, 0.5, "split", "owner's policy customarily split",
    "title_company", 400, 1000, false, 50, 150, 1.1, 1.25),
  TN: s("TN", "Tennessee", 0.37, "buyer", "recordation transfer tax $0.37 per $100 — customarily BUYER-paid; buyer also owes mortgage recordation tax 0.115% of any loan",
    "filed_rates", 0.3, 0.5, "buyer", "title-company and attorney closings both common",
    "mixed", 600, 1300, false, 50, 150, 0.55, 0.7),
  TX: s("TX", "Texas", 0, "none", "no transfer tax",
    "regulated_promulgated", 0.5, 0.7, "seller", "premiums promulgated by TDI — identical at every title company; seller customarily pays the owner's policy",
    "title_company", 350, 700, false, 100, 250, 1.6, 1.8),
  UT: s("UT", "Utah", 0, "none", "no transfer tax",
    "filed_rates", 0.25, 0.45, "seller", "seller customarily pays the owner's policy",
    "title_company", 400, 900, false, 40, 120, 0.5, 0.6),
  VT: s("VT", "Vermont", 1.25, "buyer", "property transfer tax 1.25% (0.5% on the first $100k of a primary residence) — paid by the BUYER",
    "filed_rates", 0.3, 0.5, "buyer", "attorney closing state",
    "attorney", 800, 1600, true, 60, 180, 1.7, 1.9),
  VA: s("VA", "Virginia", 0.35, "split", "buyer pays ~0.25% recordation; seller pays 0.1% grantor tax (+0.15% regional add-on in NoVA/Hampton Roads)",
    "filed_rates", 0.25, 0.45, "buyer", "attorney or title-agency settlements both common",
    "mixed", 700, 1400, false, 60, 150, 0.75, 0.9),
  WA: s("WA", "Washington", 1.28, "seller", "graduated REET: 1.1% under ~$525k up to 3% on the top tier (1.28% mid-band), seller-paid",
    "filed_rates", 0.25, 0.45, "seller", "escrow state; seller customarily pays the owner's policy",
    "escrow_company", 900, 2000, false, 100, 300, 0.85, 1.0),
  WV: s("WV", "West Virginia", 0.44, "seller", "state $1.10 per $500 + county at least the same (~0.44% combined), seller-paid",
    "negotiable", 0.3, 0.55, "buyer", "attorney closing state",
    "attorney", 600, 1300, true, 50, 150, 0.5, 0.6),
  WI: s("WI", "Wisconsin", 0.3, "seller", "transfer fee 0.3%, seller-paid",
    "filed_rates", 0.25, 0.45, "seller", "seller customarily provides title evidence + owner's policy",
    "title_company", 400, 900, false, 30, 100, 1.5, 1.7),
  WY: s("WY", "Wyoming", 0, "none", "no transfer tax",
    "filed_rates", 0.3, 0.5, "seller", "seller customarily pays the owner's policy",
    "title_company", 400, 1000, false, 50, 150, 0.55, 0.65),
}

const NAME_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.values(CONVENTIONS).map((c) => [c.stateName.toLowerCase(), c.state]),
)

export const ALL_REGION_CODES = Object.keys(CONVENTIONS) // 50 states + DC

/** "CA" | "ca" | "California" → "CA"; anything unknown → null (honest absence). */
export function normalizeStateCode(input: string | null | undefined): string | null {
  if (!input) return null
  const t = String(input).trim()
  if (!t) return null
  const upper = t.toUpperCase()
  if (upper in CONVENTIONS) return upper
  return NAME_TO_CODE[t.toLowerCase()] ?? null
}

export function getRegionalConventions(state: string | null | undefined): RegionalConventions | null {
  const code = normalizeStateCode(state)
  return code ? CONVENTIONS[code] : null
}

/** The label every regionally-derived figure carries. */
export function regionalLabel(conv: RegionalConventions): string {
  return `regional estimate — ${conv.stateName} conventions`
}

/** Buyer's customary share of a payer-attributed cost, as a [low, high] factor.
 *  Honest widths: "varies" spans 0–half rather than faking a custom. */
export function buyerShareFactor(payer: CustomaryPayer): { low: number; high: number } {
  switch (payer) {
    case "buyer": return { low: 1, high: 1 }
    case "split": return { low: 0.5, high: 0.5 }
    case "varies": return { low: 0, high: 0.5 }
    case "seller": return { low: 0, high: 0 }
    case "none": return { low: 0, high: 0 }
  }
}

/** Months of property tax typically escrowed/prepaid at closing — heavier-tax
 *  states front-load a larger cushion. Convention band, not a lender quote. */
export function taxEscrowMonths(conv: RegionalConventions): { low: number; high: number } {
  const mid = (conv.propertyTaxLowPct + conv.propertyTaxHighPct) / 2
  return mid >= 1.5 ? { low: 3, high: 6 } : { low: 2, high: 4 }
}

/** Lender's-policy pricing convention (used only as a NOTE while the loan
 *  amount is pending, and to scale the line once a real loan is on file). */
export function lenderTitleConvention(conv: RegionalConventions): {
  pctOfLoanLow: number
  pctOfLoanHigh: number
  note: string
} {
  if (conv.titleConvention === "state_title_guaranty") {
    return { pctOfLoanLow: 0, pctOfLoanHigh: 0.03, note: "Iowa Title Guaranty flat-fee coverage — no private title premium" }
  }
  if (conv.titleConvention === "regulated_promulgated") {
    return { pctOfLoanLow: 0.02, pctOfLoanHigh: 0.1, note: "promulgated simultaneous-issue rate — the lender's policy is cheap when issued with the owner's" }
  }
  return { pctOfLoanLow: 0.15, pctOfLoanHigh: 0.3, note: "typical lender's-policy band" }
}

// ─── AI refinement (pure clamp — the deterministic model is the floor) ──────
//
// The AI layer (app/actions/buyer-closing-costs.ts → generateObjectRouted) may
// propose per-line adjustments grounded in the deal's real facts, but THIS
// function is the only way they land, and it enforces the honesty bounds:
//   - lender-fact lines are untouchable (real records beat any model)
//   - pending lines are untouchable (no loan terms → nothing to refine)
//   - each adjustment is clamped within [0.5×, 1.5×] of the regional band
//   - every adjustment must carry a stated reason, which travels into the label

export interface AiLineAdjustment {
  label: string
  low: number
  high: number
  reason: string
}

export interface AiRefineOutcome {
  lines: BuyerCostLine[]
  applied: string[]
  rejected: Array<{ label: string; why: string }>
}

export function applyAiRefinements(
  lines: BuyerCostLine[],
  adjustments: AiLineAdjustment[],
  conv: RegionalConventions,
): AiRefineOutcome {
  const out = lines.map((l) => ({ ...l }))
  const applied: string[] = []
  const rejected: Array<{ label: string; why: string }> = []

  for (const adj of adjustments) {
    const line = out.find((l) => l.label === adj.label)
    if (!line) { rejected.push({ label: adj.label, why: "no such line" }); continue }
    if (line.source === "lender_fact") { rejected.push({ label: adj.label, why: "lender-fact line — real records are never AI-adjusted" }); continue }
    if (line.pending) { rejected.push({ label: adj.label, why: "pending the lender's terms — nothing to refine yet" }); continue }
    const reason = String(adj.reason ?? "").trim()
    if (!reason) { rejected.push({ label: adj.label, why: "no reason stated — unexplained adjustments are refused" }); continue }
    if (!Number.isFinite(adj.low) || !Number.isFinite(adj.high) || adj.low < 0 || adj.high < adj.low) {
      rejected.push({ label: adj.label, why: "not a sane range" }); continue
    }
    if (line.high <= 0) { rejected.push({ label: adj.label, why: "no regional band to refine within (customarily not a buyer cost here)" }); continue }

    // Clamp into [0.5×low, 1.5×high] of the deterministic band — the floor holds.
    const boundLow = Math.floor(line.low * 0.5)
    const boundHigh = Math.ceil(line.high * 1.5)
    const clampedLow = Math.min(Math.max(adj.low, boundLow), boundHigh)
    const clampedHigh = Math.min(Math.max(adj.high, boundLow), boundHigh)
    line.low = Math.min(clampedLow, clampedHigh)
    line.high = Math.max(clampedLow, clampedHigh)
    line.source = "ai_refined"
    line.sourceLabel = `AI-refined within the ${conv.stateName} regional band — ${reason}`
    applied.push(adj.label)
  }

  return { lines: out, applied, rejected }
}
