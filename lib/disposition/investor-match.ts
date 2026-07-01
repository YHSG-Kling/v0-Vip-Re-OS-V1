// lib/disposition/investor-match.ts
//
// CASH-BUYER DISPOSITION MATCH — the disposition bookend of the wholesale funnel. The app scrapes
// MOTIVATED SELLERS (probate, pre-foreclosure, tired-landlord, tax-lien) which become distressed /
// as-is / hard-to-finance listings. Retail-buyer matching (reverse-prospecting) can't move those — a
// financed retail buyer won't touch a teardown. The DISPOSITION side finds the nearby CASH INVESTORS
// (landlords, flippers, builders) who have actually been buying that exact "buy-box" and stages a
// GATED, agent-approved outreach so the agent can move a hard property FAST. No competitor
// (RealScout / Lofty / Rave) matches a property to cash investors — they do retail buyers only.
//
// The engine is the SELLER-side analog of reverse-prospecting: same shape (property → ranked people →
// gated proposal, idempotent per pair), inverse audience (EXTERNAL cash investors sourced live from
// BatchData investor-buybox, not the brokerage's own saved buyers). This file is the PURE core:
// build the buy-box query from the subject property, normalize BatchData investor records, and rank
// them — all unit-testable, no I/O. The live BatchData call + gated proposal live in the runner.

/** The rationale tag stamped on every disposition outreach proposal (idempotency key per pair). */
export const DISPOSITION_MATCH_TAG = "CASH-BUYER DISPOSITION"

/** Investors below this fit aren't worth a one-to-one disposition outreach. */
export const DISPOSITION_THRESHOLD = 0.5

export interface SubjectProperty {
  street: string
  city: string | null
  state: string | null
  zip: string | null
  bedrooms?: number | null
  bathrooms?: number | null
  livingAreaSqft?: number | null
  yearBuilt?: number | null
  /** e.g. "Single Family", "Condo" — passed through to BatchData's property_type_detail. */
  propertyTypeDetail?: string | null
}

export interface BuyBoxOptions {
  /** Radius investors buy within (default 3 miles — cash buyers work a farm, not one block). */
  distanceMiles?: number
  /** Year-built delta each way (default ±15). */
  yearBuiltDelta?: number
  /** Living-area percent delta each way (default ±25%). */
  areaPercentDelta?: number
  /** Only investors active within this many months (default 24 — a stale buyer isn't a buyer). */
  lastSoldMonths?: number
  /** Optional BatchData investor_classification filter (e.g. "LANDLORD"). */
  investorClassification?: string
}

/**
 * PURE: turn the subject property into the BatchData investor-buybox arguments. Honest about what we
 * have — filters we can't ground (no beds/baths/sqft on the row) are left OFF rather than guessed, so
 * the buy-box widens instead of silently excluding real buyers. Requires at least a street + one of
 * city/zip to be a valid geographic query; returns null otherwise (caller skips honestly).
 */
export function buildBuyBoxQuery(subject: SubjectProperty, opts: BuyBoxOptions = {}): Record<string, unknown> | null {
  if (!subject.street || !subject.street.trim()) return null
  if (!subject.city && !subject.zip) return null

  const args: Record<string, unknown> = {
    street: subject.street.trim(),
    ...(subject.city ? { city: subject.city } : {}),
    ...(subject.state ? { state: subject.state } : {}),
    ...(subject.zip ? { zip: subject.zip } : {}),
    use_distance: true,
    distance_miles: opts.distanceMiles ?? 3,
    use_year_built: subject.yearBuilt != null,
    ...(subject.yearBuilt != null
      ? { min_year_built: -(opts.yearBuiltDelta ?? 15), max_year_built: opts.yearBuiltDelta ?? 15 }
      : {}),
    use_area: subject.livingAreaSqft != null,
    ...(subject.livingAreaSqft != null
      ? { min_area_percent: -(opts.areaPercentDelta ?? 25), max_area_percent: opts.areaPercentDelta ?? 25 }
      : {}),
    ...(subject.propertyTypeDetail ? { property_type_detail: subject.propertyTypeDetail } : {}),
    ...(opts.lastSoldMonths != null ? { last_sold_date: opts.lastSoldMonths } : { last_sold_date: 24 }),
    ...(opts.investorClassification ? { investor_classification: opts.investorClassification } : {}),
  }
  return args
}

export interface InvestorCandidate {
  name: string | null
  investorType: string | null        // "Individual" | "Company Owned" | ...
  classification: string | null      // "LANDLORD" | "HOME BUILDER" | ...
  holdingsCount: number | null
  acquisitionsCount: number | null
  lastSoldMonthsAgo: number | null    // months since their last purchase (recency)
  city: string | null
  state: string | null
  /** Stable identity for dedupe/idempotency — entity name + state, lowercased. */
  key: string
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

/**
 * PURE: normalize one raw BatchData investor record (field names vary by response shape) into our
 * candidate. Defensive — reads the documented fields (investor_classification / investor_type /
 * last_sold_date / investor_current_holdings / investor_acquisitions) plus common aliases; missing
 * data becomes null (never fabricated), and the stable key drives dedupe + per-pair idempotency.
 */
export function normalizeInvestorCandidate(raw: Record<string, any>): InvestorCandidate {
  const name = str(raw.name) ?? str(raw.investor_name) ?? str(raw.owner_name) ?? str(raw.full_name)
  const investorType = str(raw.investor_type) ?? str(raw.investorType)
  const classification = str(raw.investor_classification) ?? str(raw.classification)
  const holdingsCount =
    num(raw.holdings_count) ?? num(raw.current_holdings) ?? num(raw?.investor_current_holdings?.count) ??
    (raw?.investor_current_holdings && typeof raw.investor_current_holdings === "object" ? num(Object.keys(raw.investor_current_holdings).length) : null)
  const acquisitionsCount =
    num(raw.acquisitions_count) ?? num(raw?.investor_acquisitions?.count) ??
    (raw?.investor_acquisitions && typeof raw.investor_acquisitions === "object" ? num(Object.keys(raw.investor_acquisitions).length) : null)
  const lastSoldMonthsAgo = num(raw.last_sold_months_ago) ?? num(raw.last_sold_date_months) ?? num(raw.last_purchase_months_ago)
  const city = str(raw.city) ?? str(raw?.address?.city) ?? str(raw?.mailing_address?.city)
  const state = str(raw.state) ?? str(raw?.address?.state) ?? str(raw?.mailing_address?.state)
  const key = `${(name ?? "unknown").toLowerCase()}|${(state ?? "").toLowerCase()}`
  return { name, investorType, classification, holdingsCount, acquisitionsCount, lastSoldMonthsAgo, city, state, key }
}

export interface RankedInvestor extends InvestorCandidate {
  /** 0..1 disposition fit — recency + capacity + classification, trust-gated on data completeness. */
  matchScore: number
  /** Human reasons the agent sees. */
  reasons: string[]
}

/**
 * PURE: rank investor candidates for THIS disposition, 0 (weak) → 1 (strong cash buyer), highest first.
 *   • recency  — a purchase in the last 6mo is a hot, active buyer; >24mo is cold.
 *   • capacity — more current holdings / recent acquisitions = more ability to close cash.
 *   • fit      — a classification that matches the play (LANDLORD for rentals) nudges up.
 * TRUST-GATED: a record with NO recency AND NO capacity signal is unknown, not "good" — it's floored
 * low (0.2), never fabricated to look strong. Dedupes by stable key (same investor once).
 */
export function rankInvestorCandidates(
  candidates: InvestorCandidate[],
  opts: { preferClassification?: string } = {},
): RankedInvestor[] {
  const seen = new Set<string>()
  const ranked: RankedInvestor[] = []
  for (const c of candidates) {
    if (seen.has(c.key)) continue
    seen.add(c.key)

    const reasons: string[] = []
    let recency = 0
    if (c.lastSoldMonthsAgo != null) {
      if (c.lastSoldMonthsAgo <= 6) { recency = 1; reasons.push("Bought in the area within the last 6 months.") }
      else if (c.lastSoldMonthsAgo <= 12) { recency = 0.7; reasons.push("Active buyer in the last year.") }
      else if (c.lastSoldMonthsAgo <= 24) { recency = 0.4; reasons.push("Bought in the area within 2 years.") }
      else { recency = 0.15 }
    }
    let capacity = 0
    const holdings = c.holdingsCount ?? 0
    const acqs = c.acquisitionsCount ?? 0
    if (holdings > 0 || acqs > 0) {
      capacity = Math.min(1, (holdings + acqs * 2) / 20) // acquisitions weigh double (recent buying power)
      if (holdings > 0) reasons.push(`Owns ${holdings} propert${holdings === 1 ? "y" : "ies"} nearby.`)
      if (acqs > 0) reasons.push(`${acqs} recent acquisition${acqs === 1 ? "" : "s"} in the box.`)
    }

    const hasSignal = c.lastSoldMonthsAgo != null || holdings > 0 || acqs > 0
    let score: number
    if (!hasSignal) {
      score = 0.2 // unknown ≠ good — honest floor, never fabricated
      reasons.push("Limited activity data — verify before reaching out.")
    } else {
      score = 0.55 * recency + 0.45 * capacity
      if (opts.preferClassification && c.classification && c.classification.toUpperCase() === opts.preferClassification.toUpperCase()) {
        score = Math.min(1, score + 0.1)
        reasons.push(`Classified ${c.classification} — fits this property.`)
      }
    }
    ranked.push({ ...c, matchScore: Math.round(Math.min(1, Math.max(0, score)) * 100) / 100, reasons })
  }
  ranked.sort((a, b) => b.matchScore - a.matchScore)
  return ranked
}

/** PURE: the candidates worth a one-to-one disposition outreach (at/above the bar). */
export function qualifiedInvestors(ranked: RankedInvestor[]): RankedInvestor[] {
  return ranked.filter((r) => r.matchScore >= DISPOSITION_THRESHOLD)
}
