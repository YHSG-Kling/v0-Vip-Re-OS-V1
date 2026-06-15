// lib/property-risk/buyer-target-analyzer.ts
//
// DEAL-KILLER RADAR — scan a buyer's TARGET property for red flags BEFORE they fall in love / write
// an offer, so the deal doesn't blow up later. Kills the agent's "is this one going to fall apart
// on me?". This is FORWARD-looking (will it fail) — deal_autopsy is BACKWARD-looking (why it failed),
// untouched. PURE: the caller fetches the data (listings.flood_zone, BatchData liens/foreclosure,
// comp median from the AVM/comps engine, days-on-market, price-cut history); this scores it. Only
// signals ACTUALLY PRESENT contribute — nothing is assumed; a missing field is silent, never a flag.

export type Severity = "critical" | "high" | "medium" | "low" | "info"

export interface RiskSignal {
  key: string
  severity: Severity
  /** What we observed (from real data only). */
  evidence: string
  /** The one due-diligence step for the agent (deterministic, agent-facing). */
  recommendation: string
}

export interface PropertyRiskInput {
  listPrice: number
  /** FEMA flood zone code from listings.flood_zone (zones starting A or V = special flood hazard). */
  floodZone?: string | null
  /** Adjusted comp median from the AVM/comps engine. */
  compMedian?: number | null
  daysOnMarket?: number | null
  priceCutCount?: number | null
  /** BatchData quickList tags. */
  quickLists?: string[] | null
  /** BatchData foreclosure status. */
  foreclosureStatus?: string | null
}

export interface PropertyRiskCard {
  /** 0–100, 100 = clean. */
  overallScore: number
  /** Driven by the highest-severity signal present. */
  riskLevel: "critical" | "high" | "medium" | "low"
  signals: RiskSignal[]
  /** Evidence strings, ranked worst-first — the ranked red-flag card. */
  redFlags: string[]
  /** Which data providers actually contributed. */
  sources: string[]
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }
const PENALTY: Record<Severity, number> = { critical: 45, high: 25, medium: 12, low: 5, info: 0 }

const LIEN_TAGS = ["notice-of-lis-pendens", "tax-default", "notice-of-default", "notice-of-sale", "preforeclosure"]

/** Pure: score a target property's pre-offer red flags from already-fetched data. */
export function analyzePropertyRisks(input: PropertyRiskInput): PropertyRiskCard {
  const signals: RiskSignal[] = []
  const sources = new Set<string>()

  // ── Title / lien cloud — the deal-killer (BatchData) ──
  const tags = (input.quickLists ?? []).map((t) => t.toLowerCase())
  const lien = LIEN_TAGS.find((t) => tags.includes(t))
  const fc = (input.foreclosureStatus ?? "").toLowerCase()
  if (lien || (fc && fc !== "none" && fc !== "no")) {
    sources.add("BatchData")
    signals.push({
      key: "title_lien", severity: "critical",
      evidence: lien ? `Public record flag: ${lien}` : `Foreclosure status: ${input.foreclosureStatus}`,
      recommendation: "Order a title search NOW — a lien/foreclosure cloud can kill the close. Confirm clear title before any offer.",
    })
  }

  // ── Flood zone (FEMA / listings.flood_zone) ──
  if (input.floodZone != null) {
    sources.add("FEMA/listing")
    const z = input.floodZone.trim().toUpperCase()
    const special = /^(A|V)/.test(z) // SFHA — mandatory flood insurance
    if (special) {
      signals.push({
        key: "flood_zone", severity: "high",
        evidence: `FEMA flood zone ${z} (special flood hazard area)`,
        recommendation: "Get a flood-insurance quote before the offer — it materially changes the carrying cost and can spook the lender.",
      })
    }
  }

  // ── Comp gap — over-priced vs comps (AVM/comps) → appraisal-gap risk ──
  if (input.compMedian && input.compMedian > 0 && input.listPrice > 0) {
    sources.add("comps/AVM")
    const gapPct = (input.listPrice - input.compMedian) / input.compMedian
    if (gapPct >= 0.15) {
      signals.push({
        key: "comp_gap", severity: "high",
        evidence: `Listed ${Math.round(gapPct * 100)}% above comp median ($${Math.round(input.compMedian).toLocaleString()})`,
        recommendation: "High appraisal-gap risk — pull comps with the buyer and plan an appraisal contingency / gap-coverage strategy.",
      })
    } else if (gapPct >= 0.10) {
      signals.push({
        key: "comp_gap", severity: "medium",
        evidence: `Listed ${Math.round(gapPct * 100)}% above comp median`,
        recommendation: "Some appraisal risk — verify the number against recent closed comps before offering at ask.",
      })
    }
  }

  // ── Days on market — staleness ──
  if (input.daysOnMarket != null) {
    sources.add("MLS")
    if (input.daysOnMarket >= 180) {
      signals.push({ key: "days_on_market", severity: "medium", evidence: `${input.daysOnMarket} days on market`,
        recommendation: "Long DOM — find out WHY (price, condition, location) before assuming it's a deal; leverage it in negotiation." })
    } else if (input.daysOnMarket >= 90) {
      signals.push({ key: "days_on_market", severity: "low", evidence: `${input.daysOnMarket} days on market`,
        recommendation: "Aging listing — there may be room to negotiate; ask the listing agent about activity." })
    }
  }

  // ── Price volatility — seller chasing the market ──
  if (input.priceCutCount != null && input.priceCutCount >= 2) {
    sources.add("MLS")
    signals.push({ key: "price_cuts", severity: "low", evidence: `${input.priceCutCount} price reductions`,
      recommendation: "Multiple price cuts signal an over-ambitious seller — there's likely negotiating room." })
  }

  // ── HOA present — can't see litigation/assessment depth, so flag to VERIFY (info) ──
  if (tags.includes("has-hoa")) {
    sources.add("BatchData")
    signals.push({ key: "hoa", severity: "info", evidence: "HOA on the property",
      recommendation: "Request HOA docs — dues, reserves, special assessments, and any pending litigation (we can't see depth from public data)." })
  }

  signals.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
  const overallScore = Math.max(0, 100 - signals.reduce((s, x) => s + PENALTY[x.severity], 0))
  const topSeverity = signals[0]?.severity ?? "low"
  const riskLevel: PropertyRiskCard["riskLevel"] =
    topSeverity === "critical" ? "critical" : topSeverity === "high" ? "high" : topSeverity === "medium" ? "medium" : "low"

  return {
    overallScore,
    riskLevel,
    signals,
    redFlags: signals.filter((s) => s.severity !== "info").map((s) => s.evidence),
    sources: [...sources],
  }
}
