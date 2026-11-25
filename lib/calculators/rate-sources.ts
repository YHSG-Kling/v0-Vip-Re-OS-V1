// lib/calculators/rate-sources.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONLY RATES A CALCULATOR MAY APPLY WITHOUT THE PERSON TYPING THEM (wave 156, lane 156H).
//
// Owner ruling (directive 156H): "Do not invent one universal percentage for commissions, taxes, insurance, costs or
// mortgages. Obtain locale-specific rules from verified sources or user-supplied inputs." So a rate reaches the math in
// exactly two ways: the person enters it, or it is one of the rows below — each a STATUTE read at its primary source on
// the date in `retrievedOn`, selected by jurisdiction, applied with its stated scope and shown with its citation.
//
// A jurisdiction with no row here is NOT given a default. The engine answers "enter a value" (lib/calculators/engine.ts).
// That includes every state not listed (Texas included — an absence of a statute is not something this file can cite),
// and every county / city add-on the caveats name. Mortgage rates, insurance, property-tax rates, title and escrow
// charges and commissions have NO row and never will: they are priced per person, per policy, per county or by contract.
//
// PURE DATA, no I/O. Usable on the server and in the browser.

export type Jurisdiction = string // "US", "US-FL", "US-CA", "US-NY" — ISO 3166-2 style

/** A tax charged per started unit of consideration: ceil(consideration / unit) × amountPerUnit. */
export interface PerUnitRule { kind: "per_unit_ceil"; unit: number; amountPerUnit: number }
/** A statutory number of days from an event. */
export interface StatutoryDaysRule { kind: "statutory_days"; days: Record<string, number> }

export interface CitedRateSource {
  key: string
  appliesTo: "transfer_tax" | "exchange_1031_deadlines"
  jurisdiction: Jurisdiction
  label: string
  rule: PerUnitRule | StatutoryDaysRule
  citation: string
  url: string
  /** The day the primary source was read for this lane (YYYY-MM-DD). */
  retrievedOn: string
  /** What the row does NOT cover. Shown beside the figure, always. */
  caveats: string
  /** Who customarily pays is set by contract and local custom — never assumed. */
  payerNote?: string
}

export const CITED_RATE_SOURCES: readonly CitedRateSource[] = Object.freeze([
  {
    key: "us_fl_documentary_stamp_deed",
    appliesTo: "transfer_tax",
    jurisdiction: "US-FL",
    label: "Florida documentary stamp tax on deeds",
    rule: { kind: "per_unit_ceil", unit: 100, amountPerUnit: 0.7 },
    citation: "Fla. Stat. § 201.02(1)(a) — 70 cents on each $100 of the consideration, or fractional part thereof",
    url: "https://www.flsenate.gov/Laws/Statutes/2024/201.02",
    retrievedOn: "2026-11-25",
    caveats: "Statewide rate. Miami-Dade County applies a different rate to single-family residences plus a surtax on other property (§ 201.02(1)(b)); that county is not modeled — enter the amount. Consideration includes mortgages assumed.",
    payerNote: "Who pays is set by your contract and local custom.",
  },
  {
    key: "us_ca_county_documentary_transfer",
    appliesTo: "transfer_tax",
    jurisdiction: "US-CA",
    label: "California county documentary transfer tax",
    rule: { kind: "per_unit_ceil", unit: 500, amountPerUnit: 0.55 },
    citation: "Cal. Rev. & Tax. Code § 11911(a) — $0.55 for each $500 or fractional part (county ordinance)",
    url: "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=RTC&sectionNum=11911",
    retrievedOn: "2026-11-25",
    caveats: "County rate only, on consideration exclusive of liens remaining on the property. Many cities levy their own transfer tax on top (§ 11911(b) and charter cities); that is not included — add it as another cost.",
    payerNote: "Who pays is set by your contract and local custom.",
  },
  {
    key: "us_ny_state_real_estate_transfer",
    appliesTo: "transfer_tax",
    jurisdiction: "US-NY",
    label: "New York State real estate transfer tax",
    rule: { kind: "per_unit_ceil", unit: 500, amountPerUnit: 2 },
    citation: "N.Y. Tax Law § 1402(a)(1) — $2 for each $500 or fractional part of the consideration",
    url: "https://www.nysenate.gov/legislation/laws/TAX/1402",
    retrievedOn: "2026-11-25",
    caveats: "State base rate only. The additional rate in cities of one million or more above the § 1402(a)(2) thresholds, the buyer's additional tax on residences of $1 million or more (§ 1402-a), and New York City's own transfer tax are not included — enter them as other costs.",
    payerNote: "Who pays is set by your contract and local custom.",
  },
  {
    key: "us_irc_1031_a_3",
    appliesTo: "exchange_1031_deadlines",
    jurisdiction: "US",
    label: "Like-kind exchange identification and receipt periods",
    rule: { kind: "statutory_days", days: { identification: 45, receipt: 180 } },
    citation: "26 U.S.C. § 1031(a)(3) — identify within 45 days; receive by the earlier of 180 days or the return due date (with extensions)",
    url: "https://www.law.cornell.edu/uscode/text/26/1031",
    retrievedOn: "2026-11-25",
    caveats: "Educational timeline only. Whether a particular sale qualifies, and how the periods apply to it, is a legal and tax question for a qualified intermediary and a tax adviser.",
  },
])

/** PURE. The cited source for one purpose in one jurisdiction, or null — never a nearest neighbour, never a national fallback. */
export function citedSourceFor(appliesTo: CitedRateSource["appliesTo"], jurisdiction: Jurisdiction | null | undefined): CitedRateSource | null {
  const j = String(jurisdiction ?? "").trim().toUpperCase()
  if (!j) return null
  return CITED_RATE_SOURCES.find((s) => s.appliesTo === appliesTo && s.jurisdiction === j) ?? null
}

/** PURE. Apply a per-unit rule. Rounded to cents. */
export function applyPerUnitRule(rule: PerUnitRule, consideration: number): number {
  if (!(consideration > 0)) return 0
  return Math.round(Math.ceil(consideration / rule.unit) * rule.amountPerUnit * 100) / 100
}

/** The jurisdictions an author may pick (every row's, de-duplicated, plus "none — the person enters every figure"). */
export const CALCULATOR_JURISDICTIONS: readonly Jurisdiction[] = Object.freeze([...new Set(CITED_RATE_SOURCES.map((s) => s.jurisdiction))])
