// lib/external/osint-free.ts
//
// ══ THE FREE OSINT LANE — ONE PROVIDER SURFACE, AND ITS HONEST BOUNDARY ══════
//
// Owner ruling: "there is a free osint selection". Enrichment must be able to
// use a FREE OSINT option, not only the paid one. This module is that option's
// provider surface, and — just as importantly — the written-down statement of
// what it CANNOT do.
//
// The platform already carried the lane as a posture row: provider-posture.ts
// maps the connectors `nominatim`, `overpass` and `census` onto the single
// keyless provider `osint_free`. What was missing was a way for the enrichment
// drain to SELECT it. That is what planEnrichmentLane + runFreeOsintLane add.
//
// ── WHAT THE FREE LANE CAN ANSWER (place-keyed facts) ───────────────────────
//   geocode                 address → lat/lng                    (OSM Nominatim)
//   neighborhood_amenities  what is within 1 km of that point    (OSM Overpass)
//   area_median_home_value  ACS median owner-occupied value, ZIP (US Census)
//   area_appreciation       that median's direction, 2018→2022   (US Census)
//
// ── WHAT IT CANNOT ANSWER, AT ANY SETTING (person-keyed facts) ──────────────
//   phone numbers · email addresses · name→identity resolution · age · gender ·
//   marital status · household size or income · net worth · employer or title ·
//   education · a person's social profiles · a person's court/public records ·
//   property records BY OWNER NAME · life events.
//
// None of Nominatim, Overpass or the Census ACS is a people index. They are a
// gazetteer, a map, and an area statistics table. THE FREE LANE IS NOT A CHEAP
// SKIP TRACE — it is a different product. A design that let a free result close
// a skip_trace queue row as "completed" would report success without doing the
// thing, which is the exact defect this wave exists to remove. So the selection
// below routes BY QUESTION, not by preference: there is deliberately no "use
// free instead" toggle, because such a toggle would be a promise the free
// sources cannot keep.
//
// COST: zero, by construction. Every call here is a keyless free tier. The lane
// still reports the calls it made so they can be METERED AT $0 rather than
// silently omitted (see VENDOR_PRICING['osint_free'] in the cost normalizer,
// which exists so a free call can never be priced by the unknown-vendor
// fallback and inflate a brokerage's budget ledger).
//
// AVAILABILITY: keyless is not the same as always-up. Overpass rate-limits hard
// and 504s under load; Nominatim throttles at 1 req/s. Every connector reports
// through FreeProbe, so "the provider was down" never renders as "there is no
// data for this address".

import { geocodeOneDetailed } from "./nominatim-geocode"
import { probeCensusAppreciation, probeCensusMedianHomeValue, CENSUS_LATEST_VINTAGE, type CensusAppreciation } from "./census-appreciation"
import { probeOverpassAmenities, hasAnyAmenity, type OSINTAmenities } from "./osint-neighborhood"
import type { FreeProbe, FreeProbeOutcome } from "./free-probe"

/** The four questions the keyless lane can actually answer. */
export type FreeOsintAnswer =
  | "geocode"
  | "neighborhood_amenities"
  | "area_median_home_value"
  | "area_appreciation"

/** Enumerated so surfaces can render the lane's scope instead of guessing it. */
export const FREE_OSINT_ANSWERS: readonly FreeOsintAnswer[] = [
  "geocode",
  "neighborhood_amenities",
  "area_median_home_value",
  "area_appreciation",
]

/**
 * The person-keyed questions ONLY the paid lane can answer. Kept as data next to
 * FREE_OSINT_ANSWERS so the boundary is one readable pair, not folklore spread
 * across call sites.
 */
export const PAID_ONLY_ANSWERS = [
  "person_identity",
  "contact_points",
  "phone_line_status",
  "person_social_profiles",
  "person_public_records",
  "person_court_records",
  "owner_property_records",
  "life_events",
] as const

export interface FreeOsintInput {
  address?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
}

export interface FreeOsintFacts {
  /** Free geocode of the address on the record. */
  lat: number | null
  lng: number | null
  /**
   * ZIP-LEVEL ACS median owner-occupied home value. AREA data — deliberately NOT
   * named `home_value`, because it is not a valuation of this record's home.
   */
  areaMedianHomeValueZip: number | null
  /** ACS vintage the figure above came from, so it is never shown undated. */
  areaMedianHomeValueYear: number | null
  /** ZIP median-value direction across two ACS vintages. Also AREA data. */
  areaAppreciation: CensusAppreciation | null
  /** OSM amenities within 1 km of the geocoded point. */
  neighborhoodAmenities: OSINTAmenities | null
}

export interface FreeOsintConnectorReport {
  connector: "nominatim" | "overpass" | "census"
  answer: FreeOsintAnswer
  outcome: FreeProbeOutcome
  status: number | null
  detail: string | null
}

export interface FreeOsintLaneResult {
  lane: "osint_free"
  /** Always zero — keyless free tiers. Kept explicit so the ledger can prove it. */
  cost: 0
  /** True when at least one free connector ANSWERED (ok or no_data). False means
   *  the whole free lane was unreachable — an empty result here is a provider
   *  outage, NOT a finding about the record. */
  reachable: boolean
  /** Questions that came back with a real value. */
  answered: FreeOsintAnswer[]
  facts: FreeOsintFacts
  connectors: FreeOsintConnectorReport[]
  /** Human-readable lines for connectors that could not be reached at all. */
  unavailable: string[]
}

function emptyFacts(): FreeOsintFacts {
  return {
    lat: null,
    lng: null,
    areaMedianHomeValueZip: null,
    areaMedianHomeValueYear: null,
    areaAppreciation: null,
    neighborhoodAmenities: null,
  }
}

function report(
  connector: FreeOsintConnectorReport["connector"],
  answer: FreeOsintAnswer,
  probe: FreeProbe<unknown>,
): FreeOsintConnectorReport {
  return { connector, answer, outcome: probe.outcome, status: probe.status, detail: probe.error }
}

/** PURE. True when there is enough on the record for Nominatim to be worth asking.
 *  Module-private: planEnrichmentLane is the surface — callers ask the PLAN what
 *  the free lane can do rather than re-deriving the input test themselves. */
function hasGeocodableInput(input: FreeOsintInput): boolean {
  return [input.address, input.city, input.state, input.zip].some((p) => (p ?? "").toString().trim().length > 0)
}

/** PURE. True when the record carries a 5-digit ZIP the Census ZCTA tables accept. */
function hasCensusZip(input: FreeOsintInput): boolean {
  return /^\d{5}$/.test((input.zip ?? "").toString().trim())
}

// ─── SELECTION ───────────────────────────────────────────────────────────────

export interface EnrichmentLanePlan {
  free: {
    run: boolean
    /** Which of the four free questions this record has the inputs for. */
    answers: FreeOsintAnswer[]
    reason: string
  }
  paid: {
    /** Does this enrichment TYPE need the paid person lane at all? */
    required: boolean
    /** Will it actually run right now? (false when required but withheld.) */
    run: boolean
    reason: string
  }
  /** The stamp written to the ledger so a reader can see which lane produced the row. */
  label: "osint_free" | "peopledata" | "osint_free+peopledata" | "none"
}

/**
 * PURE. Decide which lane(s) serve one enrichment-queue row.
 *
 * THE SELECTION IS CAPABILITY-KEYED, and that is the deliberate design choice:
 * the two lanes answer DIFFERENT questions, so the router asks "what does this
 * row need?" rather than "which vendor does this tenant prefer?". A per-tenant
 * "prefer free" switch was rejected — it would let an operator point a
 * skip_trace row at sources that hold no person data and get a confident empty
 * answer back.
 *
 * `enrichmentType` is one of the five values the live
 * lead_enrichment_queue_enrichment_type_check admits (skip_trace |
 * property_match | phone_validation | osint_profile | duplicate_check).
 *
 * FREE FIRST, ALWAYS: whenever the record has address inputs the free lane runs
 * before any money is spent, so the address-derived facts are never bought.
 *
 * `paidAllowed` is the caller's budget/provider verdict. When it is false the
 * plan still reports `paid.required: true` — so the caller knows the row is
 * INCOMPLETE and must not close it as a success on the strength of free data.
 */
export function planEnrichmentLane(params: {
  enrichmentType: string
  input: FreeOsintInput
  paidAllowed: boolean
  paidBlockedReason?: string | null
}): EnrichmentLanePlan {
  const { enrichmentType, input, paidAllowed } = params

  const answers: FreeOsintAnswer[] = []
  if (hasGeocodableInput(input)) answers.push("geocode", "neighborhood_amenities")
  if (hasCensusZip(input)) answers.push("area_median_home_value", "area_appreciation")

  // Which lane serves which enrichment type. Person questions are paid-only;
  // the address question is free-only (the paid person provider is not an
  // address index either, so escalating a property_match to it would buy the
  // wrong answer).
  let freeServes: boolean
  let paidRequired: boolean
  /** Why this TYPE routes the way it does — kept distinct from "this record lacks
   *  the inputs", because those are different problems with different fixes. */
  let typeNote: string
  switch (enrichmentType) {
    case "property_match":
      freeServes = true
      paidRequired = false
      typeNote = "'property_match' is an address question — the keyless lane owns it and the person provider is not an address index"
      break
    case "skip_trace":
      // The person answer is paid-only; the free lane rides along at $0 to fill
      // the place-keyed facts the skip trace was never going to return.
      freeServes = true
      paidRequired = true
      typeNote = "'skip_trace' needs the paid person lane; the keyless lane rides along at $0 for the place-keyed facts"
      break
    case "phone_validation":
    case "osint_profile":
      freeServes = false
      paidRequired = true
      typeNote = `'${enrichmentType}' is person-keyed — no keyless source in this lane holds it`
      break
    case "duplicate_check":
      freeServes = false
      paidRequired = false
      typeNote = "'duplicate_check' is an INTERNAL record-matching job — no external provider, free or paid, answers it; it must not be routed to the enrichment providers"
      break
    default:
      // Unknown type — the CHECK constraint should have stopped it. Do not
      // invent a lane for it; let the caller fail the row loudly.
      freeServes = false
      paidRequired = false
      typeNote = `unknown enrichment_type '${enrichmentType}' — not one of the five the lead_enrichment_queue CHECK admits; no lane assigned`
      break
  }

  const freeRun = freeServes && answers.length > 0
  const paidRun = paidRequired && paidAllowed

  const freeReason = !freeServes
    ? typeNote
    : answers.length === 0
      ? "no address, city, state or ZIP on the record — nothing for the free lane to ask about"
      : `free lane can answer: ${answers.join(", ")}`

  const paidReason = !paidRequired
    ? typeNote
    : paidAllowed
      ? "paid person lane required and allowed"
      : `paid person lane required but WITHHELD — ${params.paidBlockedReason ?? "not allowed by caller"}`

  const label: EnrichmentLanePlan["label"] =
    freeRun && paidRun ? "osint_free+peopledata" : freeRun ? "osint_free" : paidRun ? "peopledata" : "none"

  return {
    free: { run: freeRun, answers, reason: freeReason },
    paid: { required: paidRequired, run: paidRun, reason: paidReason },
    label,
  }
}

// ─── EXECUTION ───────────────────────────────────────────────────────────────

/**
 * Run the keyless lane for one record. Real network calls to Nominatim, Overpass
 * and the US Census through the connector-gateway. Never throws, costs nothing,
 * and reports per-connector availability so an outage is never mistaken for an
 * absence of data.
 *
 * `answers` narrows the work to the questions the plan says are worth asking.
 */
export async function runFreeOsintLane(
  input: FreeOsintInput,
  answers: readonly FreeOsintAnswer[] = FREE_OSINT_ANSWERS,
): Promise<FreeOsintLaneResult> {
  const facts = emptyFacts()
  const connectors: FreeOsintConnectorReport[] = []
  const answered: FreeOsintAnswer[] = []
  const want = new Set(answers)

  // 1. Geocode first — Overpass needs the point. Census does not, so the two
  //    branches below stay independent of a geocode failure.
  const wantsPoint = want.has("geocode") || want.has("neighborhood_amenities")
  if (wantsPoint && hasGeocodableInput(input)) {
    const geo = await geocodeOneDetailed(input)
    connectors.push(report("nominatim", "geocode", geo))
    if (geo.value) {
      facts.lat = geo.value.lat
      facts.lng = geo.value.lng
      if (want.has("geocode")) answered.push("geocode")
    }
  }

  // 2. Overpass amenities + Census figures in parallel — independent requests.
  const tasks: Array<Promise<void>> = []

  if (want.has("neighborhood_amenities") && facts.lat != null && facts.lng != null) {
    const lat = facts.lat
    const lng = facts.lng
    tasks.push(
      (async () => {
        const probe = await probeOverpassAmenities(lat, lng, 1000)
        connectors.push(report("overpass", "neighborhood_amenities", probe))
        if (probe.value && hasAnyAmenity(probe.value)) {
          facts.neighborhoodAmenities = probe.value
          answered.push("neighborhood_amenities")
        }
      })(),
    )
  }

  if (want.has("area_median_home_value") && hasCensusZip(input)) {
    const zip = (input.zip ?? "").toString().trim()
    tasks.push(
      (async () => {
        const probe = await probeCensusMedianHomeValue(zip)
        connectors.push(report("census", "area_median_home_value", probe))
        if (probe.value != null) {
          facts.areaMedianHomeValueZip = probe.value
          facts.areaMedianHomeValueYear = CENSUS_LATEST_VINTAGE
          answered.push("area_median_home_value")
        }
      })(),
    )
  }

  if (want.has("area_appreciation") && hasCensusZip(input)) {
    const zip = (input.zip ?? "").toString().trim()
    tasks.push(
      (async () => {
        const probe = await probeCensusAppreciation(zip)
        connectors.push(report("census", "area_appreciation", probe))
        if (probe.value) {
          facts.areaAppreciation = probe.value
          answered.push("area_appreciation")
        }
      })(),
    )
  }

  await Promise.all(tasks)

  const attempted = connectors.filter((c) => c.outcome !== "not_attempted")
  const reachable = attempted.some((c) => c.outcome !== "unreachable")
  const unavailable = attempted
    .filter((c) => c.outcome === "unreachable")
    .map((c) => `${c.connector} unreachable${c.status != null ? ` (HTTP ${c.status})` : ""}${c.detail ? `: ${c.detail}` : ""}`)

  return { lane: "osint_free", cost: 0, reachable, answered, facts, connectors, unavailable }
}

/**
 * PURE. One line describing what the free lane actually did, for an error_message
 * or a ledger note. Says "unreachable" when it was unreachable and "no data" when
 * the providers answered and had nothing — never blurs the two.
 */
export function describeFreeLane(result: FreeOsintLaneResult): string {
  if (result.connectors.length === 0) return "free OSINT lane not run (no usable address input)"
  if (!result.reachable) return `free OSINT lane UNAVAILABLE — ${result.unavailable.join("; ")}`
  if (result.answered.length === 0) {
    const tail = result.unavailable.length ? ` (${result.unavailable.join("; ")})` : ""
    return `free OSINT lane reachable but returned no data for this record${tail}`
  }
  const tail = result.unavailable.length ? `; unavailable: ${result.unavailable.join("; ")}` : ""
  return `free OSINT lane answered: ${result.answered.join(", ")}${tail}`
}
