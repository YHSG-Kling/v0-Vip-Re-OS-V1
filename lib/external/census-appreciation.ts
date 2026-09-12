// lib/external/census-appreciation.ts
//
// FREE PUBLIC-RECORDS AREA DATA (owner correction: OSINT/free public
// records CAN gain this — the Future Lens does not need a paid provider).
// US Census ACS 5-year median home value is keyless (DEMO_KEY tier); reading
// TWO vintages for the same ZIP gives a real, cited multi-year direction.
// Never throws — partial/absent data returns null, never a fabricated trend.
//
// SCOPE, STATED PLAINLY: every figure here is ZIP-LEVEL AREA data. It is NOT a
// valuation of a specific home and NOT a fact about a specific person. Callers
// that present it as either are misrepresenting the source.
//
// CANONICAL ACS MEDIAN-HOME-VALUE READER (wave 5 merge). Two copies of the same
// B25077_001E call existed: the private `medianValueForVintage` here and the
// private `fetchCensusMedianHomeValue` in osint-neighborhood.ts. This module is
// the survivor; osint-neighborhood now imports fetchCensusMedianHomeValue below.

import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { gatewayProbe, notAttemptedProbe, unreachableProbe, type FreeProbe } from "./free-probe"

const CENSUS_BASE = "https://api.census.gov"
// B25077_001E = median value of owner-occupied housing units.
const MEDIAN_VALUE_VARIABLE = "B25077_001E"
const OLD_VINTAGE = "2018"
/** Latest ACS 5-year vintage this module reads. Exported so the free-lane
 *  assembler can cite the vintage next to the figure instead of presenting an
 *  undated number as current. */
export const CENSUS_LATEST_VINTAGE = 2022
const NEW_VINTAGE = String(CENSUS_LATEST_VINTAGE)

/**
 * ACS median owner-occupied home value for a ZIP, REPORTING WHY it failed.
 * `not_attempted` = the input was not a 5-digit ZIP so Census was never asked;
 * `unreachable` = the API refused/timed out; `no_data` = Census answered and has
 * no estimate for that ZCTA. Never throws.
 */
export async function probeCensusMedianHomeValue(
  zip: string,
  vintage: string = NEW_VINTAGE,
): Promise<FreeProbe<number>> {
  if (!/^\d{5}$/.test(zip ?? "")) {
    return notAttemptedProbe<number>("not a 5-digit ZIP — Census ZCTA lookup not attempted")
  }
  try {
    const res = await callConnector<any[]>({
      connector: "census", baseUrl: CENSUS_BASE, path: `/data/${vintage}/acs/acs5`, method: "GET",
      query: { get: MEDIAN_VALUE_VARIABLE, for: `zip code tabulation area:${zip}`, key: "DEMO_KEY" },
      auth: { style: "none" }, timeoutMs: 8000,
    })
    return gatewayProbe<number>(res, () => {
      // data[0] = header row, data[1] = first result
      if (!Array.isArray(res.data) || res.data.length < 2) return null
      const v = parseInt(res.data[1][0], 10)
      return Number.isNaN(v) || v <= 0 ? null : v
    })
  } catch (err) {
    return unreachableProbe<number>(err)
  }
}

/**
 * SURVIVOR of the two ACS median-home-value readers. Value-only convenience over
 * probeCensusMedianHomeValue for callers that cannot act on the difference between
 * "no estimate" and "Census unreachable" (the neighborhood report just omits the line).
 */
export async function fetchCensusMedianHomeValue(
  zip: string,
  vintage: string = NEW_VINTAGE,
): Promise<number | null> {
  return (await probeCensusMedianHomeValue(zip, vintage)).value
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

/**
 * Two-vintage ZIP appreciation from free Census data, REPORTING WHY it failed.
 * If EITHER vintage was unreachable the whole probe is `unreachable` — a window
 * computed from one readable side would be a fabricated trend.
 */
export async function probeCensusAppreciation(zip: string): Promise<FreeProbe<CensusAppreciation>> {
  if (!/^\d{5}$/.test(zip ?? "")) {
    return notAttemptedProbe<CensusAppreciation>("not a 5-digit ZIP — Census ZCTA lookup not attempted")
  }
  const [oldProbe, newProbe] = await Promise.all([
    probeCensusMedianHomeValue(zip, OLD_VINTAGE),
    probeCensusMedianHomeValue(zip, NEW_VINTAGE),
  ])

  const down = [oldProbe, newProbe].find((p) => p.outcome === "unreachable")
  if (down) {
    return {
      value: null,
      outcome: "unreachable",
      status: down.status,
      error: `Census ACS unreachable (${down.error ?? "unknown"})`,
    }
  }

  const oldV = oldProbe.value
  const newV = newProbe.value
  if (oldV == null || newV == null || oldV <= 0) {
    return { value: null, outcome: "no_data", status: newProbe.status ?? oldProbe.status, error: null }
  }

  const years = Number(NEW_VINTAGE) - Number(OLD_VINTAGE)
  const totalPct = ((newV - oldV) / oldV) * 100
  const annualPct = (Math.pow(newV / oldV, 1 / years) - 1) * 100
  return {
    value: {
      zip,
      oldYear: Number(OLD_VINTAGE),
      newYear: Number(NEW_VINTAGE),
      oldValue: oldV,
      newValue: newV,
      totalPct: Math.round(totalPct * 10) / 10,
      annualPct: Math.round(annualPct * 10) / 10,
    },
    outcome: "ok",
    status: newProbe.status,
    error: null,
  }
}

/** Two-vintage ZIP appreciation from free Census data. Null on any missing side. */
export async function fetchCensusAppreciation(zip: string): Promise<CensusAppreciation | null> {
  return (await probeCensusAppreciation(zip)).value
}
