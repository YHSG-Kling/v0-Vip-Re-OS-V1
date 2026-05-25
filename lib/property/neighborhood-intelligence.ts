// lib/property/neighborhood-intelligence.ts
// Neighborhood intelligence report — a premium feature for the most advanced plans
// (brokerage / multi_location). Combines free authoritative facts (OpenStreetMap
// amenities + transit + US Census median value, via fetchOSINTNeighborhoodData) with
// an AI livability narrative grounded by web search. The narrative is validated
// through the existing Fair-Housing detector: any high-severity steering language
// (protected-class references, "good/bad area", family/age targeting) causes the AI
// narrative to be replaced by a purely factual, compliance-safe summary.
//
// Pure helpers (tier gate, livability score, facts block, narrative fallback) are
// exported and unit-tested in the simulator without network or model calls.

import "server-only"
import { generateObject } from "ai"
import { z } from "zod"
import { resolveModel } from "@/lib/ai/resolve-model"
import { fetchOSINTNeighborhoodData, type OSINTNeighborhoodData } from "@/lib/external/osint-neighborhood"
import { webSearch, formatWebSearchContext } from "@/lib/ai/web-search"
import { detectFairHousingViolations } from "@/lib/compliance-rules/fair-housing-patterns"
import {
  isNeighborhoodReportAllowed,
  computeLivabilityScore,
  assembleFactsBlock,
  factualNarrative,
} from "./neighborhood-scoring"

export {
  isNeighborhoodReportAllowed,
  computeLivabilityScore,
  assembleFactsBlock,
  factualNarrative,
  type LivabilityResult,
} from "./neighborhood-scoring"

// ─── Report shape ─────────────────────────────────────────────────────────────
export interface NeighborhoodReport {
  tierGated: boolean
  address: string
  city: string
  state: string
  zip: string
  livabilityScore: number
  livabilityLabel: string
  amenities: OSINTNeighborhoodData["amenities"]
  censusMedianHomeValue: number | null
  narrative: string | null
  fairHousingClean: boolean
  dataSource: OSINTNeighborhoodData["dataSource"]
}

const NarrativeSchema = z.object({
  narrative: z.string().describe("3-4 sentences on the location's amenities, walkability, and commute. FACTUAL only."),
})

/**
 * Generate a neighborhood intelligence report. Tier-gated: only the most advanced
 * plans receive the full report; others get { tierGated: true } with no data fetched
 * (so no cost is incurred). Never throws — degrades to a factual report on any failure.
 */
export async function generateNeighborhoodReport(params: {
  brokerageId: string
  planTier: string | null | undefined
  address: string
  city: string
  state: string
  zip: string
}): Promise<NeighborhoodReport> {
  const base: NeighborhoodReport = {
    tierGated: false,
    address: params.address,
    city: params.city,
    state: params.state,
    zip: params.zip,
    livabilityScore: 0,
    livabilityLabel: "Limited data",
    amenities: { restaurants: [], grocery: [], parks: [], schools: [], transit: [] },
    censusMedianHomeValue: null,
    narrative: null,
    fairHousingClean: true,
    dataSource: "none",
  }

  if (!isNeighborhoodReportAllowed(params.planTier)) {
    return { ...base, tierGated: true }
  }

  // 1. Free authoritative facts (OSM amenities + transit + Census median value).
  const osint = await fetchOSINTNeighborhoodData(params.address, params.city, params.state, params.zip)
  const liv = computeLivabilityScore(osint)

  const report: NeighborhoodReport = {
    ...base,
    livabilityScore: liv.score,
    livabilityLabel: liv.label,
    amenities: osint.amenities,
    censusMedianHomeValue: osint.censusMedianHomeValue,
    dataSource: osint.dataSource,
    narrative: factualNarrative(osint, liv),
  }

  if (osint.dataSource === "none") return report

  // 2. AI narrative grounded by facts + web search (research mode = Tavily-first).
  try {
    const grounding = await webSearch({
      query: `things to do, parks, dining, and commute near ${params.address}, ${params.city}, ${params.state}`,
      maxResults: 5,
      mode: "research",
    }).catch(() => null)
    const webContext = grounding ? formatWebSearchContext(grounding, 4) : ""

    const { object } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: NarrativeSchema,
      maxOutputTokens: 300,
      system:
        "You write FAIR-HOUSING-COMPLIANT neighborhood descriptions for real estate. " +
        "Describe ONLY the property's location features: walkability, amenities, parks, transit, commute, dining. " +
        "NEVER reference or imply race, religion, national origin, family/marital status, age, disability, or whether an area is " +
        "'good', 'bad', 'safe', or suited to any group of people. Describe places, not people.",
      prompt: `Facts:\n${assembleFactsBlock(osint, liv)}\n\nWeb context:\n${webContext}\n\nWrite a 3-4 sentence factual neighborhood summary for a listing.`,
    })

    const violations = detectFairHousingViolations(object.narrative)
    const hasHigh = violations.some((v) => v.severity === "high")
    if (hasHigh) {
      // Reject the AI narrative; keep the safe factual one.
      report.narrative = factualNarrative(osint, liv)
      report.fairHousingClean = false
    } else {
      report.narrative = object.narrative
      report.fairHousingClean = true
    }
  } catch {
    // AI/web failure — factual narrative already set on `report`.
  }

  return report
}
