// lib/external/census-appreciation.ts
//
// FREE PUBLIC-RECORDS APPRECIATION (owner correction: OSINT/free public
// records CAN gain this — the Future Lens does not need a paid provider).
// US Census ACS 5-year median home value is keyless (DEMO_KEY tier); reading
// TWO vintages for the same ZIP gives a real, cited multi-year direction.
// Never throws — partial/absent data returns null, never a fabricated trend.

import { callConnector } from "@/lib/agentic-os/connector-gateway"

const CENSUS_BASE = "https://api.census.gov"
// B25077_001E = median value of owner-occupied housing units.
const OLD_VINTAGE = "2018"
const NEW_VINTAGE = "2022"

async function medianValueForVintage(zip: string, vintage: string): Promise<number | null> {
  try {
    const res = await callConnector<any[]>({
      connector: "census", baseUrl: CENSUS_BASE, path: `/data/${vintage}/acs/acs5`, method: "GET",
      query: { get: "B25077_001E", for: `zip code tabulation area:${zip}`, key: "DEMO_KEY" },
      auth: { style: "none" }, timeoutMs: 8000,
    })
    if (!res.ok || !Array.isArray(res.data) || res.data.length < 2) return null
    const v = parseInt(res.data[1][0], 10)
    return Number.isNaN(v) || v <= 0 ? null : v
  } catch {
    return null
  }
}

export interface CensusAppreciation {
  zip: string
  oldYear: number
  newYear: number
  oldValue: number
  newValue: number
  /** Total % change across the window (public-data anchor, not a forecast of the future). */
  totalPct: number
  /** Approx compound annual %, rounded. */
  annualPct: number
}

/** Two-vintage ZIP appreciation from free Census data. Null on any missing side. */
export async function fetchCensusAppreciation(zip: string): Promise<CensusAppreciation | null> {
  if (!/^\d{5}$/.test(zip)) return null
  const [oldV, newV] = await Promise.all([
    medianValueForVintage(zip, OLD_VINTAGE),
    medianValueForVintage(zip, NEW_VINTAGE),
  ])
  if (oldV == null || newV == null || oldV <= 0) return null
  const years = Number(NEW_VINTAGE) - Number(OLD_VINTAGE)
  const totalPct = ((newV - oldV) / oldV) * 100
  const annualPct = (Math.pow(newV / oldV, 1 / years) - 1) * 100
  return {
    zip,
    oldYear: Number(OLD_VINTAGE),
    newYear: Number(NEW_VINTAGE),
    oldValue: oldV,
    newValue: newV,
    totalPct: Math.round(totalPct * 10) / 10,
    annualPct: Math.round(annualPct * 10) / 10,
  }
}
