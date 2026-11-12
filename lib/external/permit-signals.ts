/**
 * lib/external/permit-signals.ts
 *
 * THE CONSUMER `lib/external/socrata-client.ts :: recentPermits` was written for.
 *
 * socrata-market-registry.ts said it in prose and then stopped: "Run `recentPermits()` /
 * `socrataQuery()` against each dataset descriptor on a daily cadence per active brokerage market."
 * Nothing did. This module is that cadence's engine; app/api/cron/permit-signal-scan/route.ts is
 * its schedule.
 *
 * ── WHAT A PERMIT IS, AS A SIGNAL ────────────────────────────────────────────
 * A city building permit is a public, dated, address-keyed record that somebody is spending money
 * on a house. Pre-listing prep (roof, paint, flooring, kitchen/bath refresh) and teardown/
 * redevelopment are the two shapes that precede a sale. That makes a permit a MOTIVATED-SELLER
 * signal — and this OS already has exactly one home for those: `motivated_seller_signals`, read by
 * lib/services/lead-management.service.ts (lead scoring) and app/actions/ai-predictions.ts
 * (conversion prediction). This lane feeds THAT spine. It does not build a second one, and it does
 * NOT write the retired `lead_motivated_seller_signals` twin.
 *
 * ── WHAT IT REFUSES TO DO ────────────────────────────────────────────────────
 * A permit is an ADDRESS, not a person. Turning an address into a lead is lead SOURCING, which
 * belongs to the scraping spine (lib/lead-pipeline) and its consent/territory gates — not here.
 * So this lane only ever ATTACHES a permit to a lead or contact the brokerage ALREADY owns,
 * matched on a normalized street address within the same tenant. No lead is created, no contact
 * is created, and an unmatched permit is dropped, counted, and reported — never stored as an
 * orphan signal with no entity column set, which no reader can ever see (every reader of this
 * table filters on `lead_id` or `contact_id`; a row with neither is an unreadable write, and
 * m517's CHECK now REFUSES one outright).
 *
 * ── TWO BOARDS, ONE TABLE (2026-08-21) ───────────────────────────────────────
 * Owner ruling, verbatim: "motivated sellers source is for leads and contacts." A permit at a
 * contact's address is the same fact as a permit at a lead's address, and the contacts board is
 * where an agent actually works. The table could only hold `lead_id` until m517 added
 * `contact_id`; `PermitMatch.entity` is the discriminator that decides which column is written,
 * and the id it discriminates is `PermitMatch.entityId` (renamed from `leadId` on 2026-08-22 —
 * the old name claimed "lead" while carrying a `contacts.id` on every contact match).
 *
 * CONVERTED LEADS ARE EXCLUDED, through the ONE conversion guard
 * (lib/contact-promotion/conversion-finality.ts `excludeConvertedLeads`), never an inline
 * predicate. `leads.contact_id` is a real FK to `contacts(id)`, so after conversion the lead row
 * and the contact row are one person at one address. Matching both would file one permit twice and
 * lead scoring COUNTS signals. The contact is the survivor.
 *
 * ── WHAT IT REFUSES TO GUESS ─────────────────────────────────────────────────
 * Socrata datasets have no shared column vocabulary — Austin's address column is not Chicago's.
 * The field readers below try a documented candidate list and return null when none is present.
 * A permit with no readable address is SKIPPED and counted as `skipped_no_address`; it is never
 * fuzzy-matched to "the closest lead", because a wrong match writes a seller signal onto an
 * innocent person's record and every downstream score then treats it as observed fact.
 *
 * ── CODE VIOLATIONS (2026-08-20) ─────────────────────────────────────────────
 * The registry has carried `kind: "code_violations"` datasets since it was written, and this file
 * threw every one of them away with `if (spec.kind !== "permits") continue`. They were dead weight
 * that LOOKED like coverage. They are ingested now, under their own signal_type `code_violation`,
 * through the same address-exact matching and the same refusals — a violation is an address too.
 * Verified live 2026-08-20: Chicago `22u3-xenr` and NYC HPD `wvxf-dwi5` serve; the Seattle and
 * Dallas violation ids in the registry do not exist and are now marked so.
 *
 * ── A SECOND PROVIDER (2026-08-20) ───────────────────────────────────────────
 * This lane was Socrata-only, and socrata-market-registry.ts marked three registered markets dead
 * with the reason "needs an ArcGIS FeatureServer adapter". They were not dead — their permits are
 * live at an endpoint the OS could not speak to. lib/external/arcgis-permits.ts is that adapter
 * and Miami is the first market it serves (Miami-Dade County, 1,161 permits in a 7-day window
 * measured 2026-08-20). The provider branch is EXACTLY ONE `if` inside the fetch loop: both
 * adapters return the same `{ ok, status, data, error }` envelope over the same flat rows, so
 * windowing, address matching, strength, dedupe and the write are untouched and shared. A second
 * provider must not become a second lane — there is one `motivated_seller_signals` spine.
 *
 * ── AND A PER-DATASET VERDICT ────────────────────────────────────────────────
 * `permitsFetched` is a sum, and under a sum a quiet dataset and a dead one are the same number.
 * `PermitIngestResult.datasetHealth` now carries one `DatasetProbe` per queried dataset so
 * "served, zero rows", "refused", and "served, truncated" stay three different answers. This
 * matters more with ArcGIS in the mix, not less: a FeatureServer reports its own errors with
 * HTTP 200, so on that provider a dead layer looks like an empty one unless something checks.
 *
 * The pure half (everything above `ingestPermitSignals`) has no I/O and is simulator-driven.
 */

import { recentPermits } from "./socrata-client"
import { recentArcgisPermits } from "./arcgis-permits"
import type { SellerSignalStrength } from "@/lib/lead-governance/seller-signal-strength"
import {
  classifyMarketCoverage, providerOf, type MarketCoverage, type SocrataDatasetSpec,
} from "./socrata-market-registry"
import { excludeConvertedLeads } from "@/lib/contact-promotion/conversion-finality"
// TYPE-ONLY, deliberately. batchdata-seller-signals imports `normalizeStreetAddress` from THIS
// file at runtime, so a value import back would be a real cycle; `import type` is erased at
// compile time and is not. Restating `"lead" | "contact"` here instead would be the two-spellings
// defect CLAUDE.md §6 names — one discriminator, one spelling.
import type { SignalEntityKind } from "./batchdata-seller-signals"

/** Local alias so the rest of this file reads without the module prefix. */
type EntityKind = SignalEntityKind

// ─────────────────────────────────────────────────────────────────────────────
// PURE — address normalization
// ─────────────────────────────────────────────────────────────────────────────

/** USPS-style suffix normalization. Left side is what appears in the wild, right side is canon. */
const SUFFIXES: Record<string, string> = {
  street: "ST", str: "ST", st: "ST",
  avenue: "AVE", aven: "AVE", ave: "AVE", av: "AVE",
  boulevard: "BLVD", boul: "BLVD", blvd: "BLVD",
  drive: "DR", driv: "DR", dr: "DR",
  road: "RD", rd: "RD",
  lane: "LN", ln: "LN",
  court: "CT", ct: "CT",
  circle: "CIR", cir: "CIR",
  place: "PL", pl: "PL",
  terrace: "TER", ter: "TER",
  parkway: "PKWY", pkwy: "PKWY",
  highway: "HWY", hwy: "HWY",
  trail: "TRL", trl: "TRL",
  way: "WAY",
  cove: "CV", cv: "CV",
  loop: "LOOP",
  square: "SQ", sq: "SQ",
  plaza: "PLZ", plz: "PLZ",
  crossing: "XING", xing: "XING",
  ridge: "RDG", rdg: "RDG",
  run: "RUN",
  path: "PATH",
}

const DIRECTIONALS: Record<string, string> = {
  north: "N", south: "S", east: "E", west: "W",
  northeast: "NE", northwest: "NW", southeast: "SE", southwest: "SW",
  n: "N", s: "S", e: "E", w: "W", ne: "NE", nw: "NW", se: "SE", sw: "SW",
}

/** Unit markers — everything from the marker onward is dropped before comparison. */
const UNIT_MARKERS = new Set(["APT", "UNIT", "STE", "SUITE", "#", "BLDG", "FL", "FLOOR", "RM", "ROOM", "LOT", "TRLR"])

/**
 * PURE. Reduce a free-text US street address to a comparable key.
 *
 * "1234 N. Lamar Boulevard, Apt 5B" and "1234 north lamar blvd #5b" both become "1234 N LAMAR BLVD".
 * Returns "" for anything with no house number AND no street words — an empty key NEVER matches
 * (see `matchPermitsToLeads`), so an unusable address cannot silently join to another unusable one.
 */
export function normalizeStreetAddress(input: string | null | undefined): string {
  if (!input) return ""
  // Drop anything after the first comma: city/state/zip live there and the caller already scoped
  // the query to one territory, so keeping them only creates spurious mismatches.
  const head = String(input).split(",")[0]
  const tokens = head
    .toUpperCase()
    .replace(/[.’']/g, "")
    .replace(/[^A-Z0-9#\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)

  const out: string[] = []
  for (const raw of tokens) {
    const t = raw.replace(/^#+/, "#")
    if (UNIT_MARKERS.has(t) || t.startsWith("#")) break // unit and everything after it is noise
    const lower = t.toLowerCase()
    if (out.length > 0 && SUFFIXES[lower]) { out.push(SUFFIXES[lower]); continue }
    if (DIRECTIONALS[lower]) { out.push(DIRECTIONALS[lower]); continue }
    out.push(t)
  }
  const key = out.join(" ").trim()
  // A key with no digits is a street with no house number — not specific enough to match a home.
  return /\d/.test(key) ? key : ""
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE — tolerant field readers over a Socrata row
// ─────────────────────────────────────────────────────────────────────────────

/** Address column names observed across the registered portals, most-specific first.
 *
 *  ── CASE IS PART OF THE NAME (2026-08-20) ───────────────────────────────────
 *  `pick` does EXACT key lookup, and every entry here was lowercase because Socrata lowercases
 *  every column it serves. ArcGIS does not: Miami-Dade publishes `PropertyAddress`, and the first
 *  run of the new provider read null for the address of every single row — the readers "covered"
 *  a portal they could not see one field of. Lower-casing the lookup was the tempting fix and is
 *  the wrong one: the registry's `dateColumn` and the ArcGIS `where` clause BOTH require the
 *  exact-case name, so the row's keys must stay as published, and the candidate list learns the
 *  new spelling instead. That is the same thing this list has done for every portal before it. */
const ADDRESS_KEYS = [
  "original_address1", "originaladdress1", "street_address", "address", "permit_address",
  "project_address", "site_address", "full_address", "address_line_1", "house_address",
  "location_address", "primary_address", "job_address", "worksite_address",
  // ArcGIS / Miami-Dade (live row 2026-08-20: "2960 SW 109 CT"). Single column, no assembly.
  "PropertyAddress",
]
const PERMIT_ID_KEYS = [
  // `permit_` is Chicago's field name for the column labelled "PERMIT#" — Socrata turns a
  // trailing `#` into `_`, which is also where NYC's `job__` comes from. Without it the
  // dedupe handle m490 relies on was null for every Chicago row.
  "permit_number", "permitnum", "permit_num", "permit_id", "permitno", "permit_", "permit",
  "record_id", "application_number", "job_number", "job__", "case_number", "number",
  // Los Angeles labels its permit number "PCIS Permit #" → pcis_permit.
  "pcis_permit",
  // Code-violation handles. NYC HPD publishes `violationid` ("19075125", live 2026-08-20).
  // A bare `id` is deliberately absent from this list even though Chicago's violations dataset
  // has one: `id` is a ROW id, not a case id, and a row id that moves when the portal republishes
  // would file a brand-new signal every single day — the exact defect m490's index exists to stop.
  "violationid", "violation_number", "novid",
  // NYC DOB NOW (rbx6-tga4) numbers its filings `job_filing_number` ("M01301984-S1"), and LA's
  // current permits feed (pi9x-tg5x) uses `permit_nbr` ("23016-10000-02499"). Both were registered
  // 2026-08-20 and neither id was readable before, which would have left every row of two of the
  // largest markets in the country dedupe-keyed on address+date instead of on its own record
  // number — coarser than it needs to be, and wrong the moment two permits land on one day.
  "job_filing_number", "permit_nbr",
  // ArcGIS / Miami-Dade (live row 2026-08-20: "2026065888"). CamelCase — see the note on
  // ADDRESS_KEYS about why these are added rather than the lookup being case-folded.
  "PermitNumber",
]

// ─── COMPOSITE ADDRESS COMPONENTS ────────────────────────────────────────────
// Most permit portals do NOT publish a single address column. Of the three registered
// portals whose live shape was checked, ZERO did:
//
//   Chicago  street_number "7529" · street_direction "N"  · street_name "CLARK ST"
//   SF       street_number "930"  · street_name "Sutter"  · street_suffix "St"
//   NYC      house__       "60"   · street_name "BAY 34 ST"
//
// so readPermitAddress returned null for every row of every one of them, the sweep counted
// them all as skippedNoAddress, and a market that could not be READ was indistinguishable
// from a market with nothing happening in it. Assembling the parts is the whole fix.
// `address_start` is Los Angeles: LADBS publishes a house-number RANGE (address_start /
// address_end) and the start is the house number. Generic key, not an LA branch.
//
// `stno` / `stname` are Montgomery County MD (live 2026-08-20: stno "7721", stname "POLARA",
// suffix "PL"); `housenumber` is NYC HPD's violations feed (live 2026-08-20: housenumber "116",
// streetname "LENOX ROAD"). Both were unreadable before, which would have made two newly-verified
// datasets report every row as skippedNoAddress — a covered market reading as a silent one.
// `house_no` is NYC DOB NOW (rbx6-tga4, live 2026-08-20: house_no "315", street_name
// "WEST 29 STREET"). It is a THIRD spelling of the same idea in one city — BIS publishes `house__`,
// HPD publishes `housenumber`, DOB NOW publishes `house_no` — which is precisely why this list is
// a list and not a branch.
const NUMBER_KEYS = [
  "street_number", "house__", "house_number", "housenumber", "house_no", "street_no",
  "address_number", "str_number", "address_start", "stno",
]
const PREDIR_KEYS = [
  "street_direction", "street_dir", "predirection", "street_predirection", "direction", "predir",
]
const NAME_KEYS = ["street_name", "streetname", "street", "stname"]
const SUFFIX_KEYS = ["street_suffix", "suffix", "street_type", "streettype"]
const DESCRIPTION_KEYS = [
  "description", "permit_type_desc", "work_description", "job_description", "permit_class",
  "work_class", "permit_type", "type_of_work", "proposed_use", "scope_of_work", "worktype",
  "permit_class_mapped", "reported_cost_description",
  // Code violations describe the work that must be done, not work being done. Chicago publishes
  // `violation_description` ("REPAIR DOOR, INT."), NYC HPD `novdescription` (the ADM CODE text).
  "violation_description", "novdescription", "violation_ordinance",
  // Registered 2026-08-20. `work_type` is NYC DOB NOW's work category ("Plumbing", "General
  // Construction") and is ALSO a sparsely-populated Chicago column ("Masonry Work"); `work_desc`
  // and `permit_sub_type` are LA pi9x-tg5x's ("ADDITION TO (E) SINGLE FMAILY DWELLING PER WFPP.",
  // "1 or 2 Family Dwelling"). Widening the description widens what classifyPermitStrength can
  // SEE, and it can only ever move a permit UP the ladder from "weak" — which is the correct
  // direction when the reason it read weak was that nobody read the column naming the work.
  "work_type", "work_desc", "permit_sub_type",
  // ArcGIS / Miami-Dade, live row 2026-08-20: DetailDescriptionComments "REROOF" ·
  // ApplicationTypeDescription "RE-ROOF/REPAIR" · PermitType "MBLD" · ProposedUseDescription
  // "SINGLE FAM RES-CLUST-ZERO LOT-TOWN HOUSE". The first two are where the WORK is named, and
  // without them a re-roof — the archetypal pre-listing permit — read as `weak`.
  "DetailDescriptionComments", "ApplicationTypeDescription", "PermitType", "ProposedUseDescription",
]
const VALUATION_KEYS = [
  "total_job_valuation", "estimated_cost", "reported_cost", "valuation", "job_value",
  "total_valuation", "declared_valuation", "declaredvaluation", "estimated_project_cost",
  "construction_cost",
  // NYC DOB NOW (rbx6-tga4), live 2026-08-20: estimated_job_costs "8000" / "63410".
  "estimated_job_costs",
  // ArcGIS / Miami-Dade, live 2026-08-20: EstimatedValue "1800" — a STRING on the wire, which
  // readPermitValuation already handles (it strips $ and , and Number()s the rest).
  "EstimatedValue",
]
/** Violation disposition. Chicago `violation_status` is OPEN / COMPLIED / NO ENTRY; NYC HPD
 *  `violationstatus` is Open / Close. Both read live 2026-08-20. */
const STATUS_KEYS = [
  "violation_status", "violationstatus", "case_status", "currentstatus", "current_status", "status",
]

function pick(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row?.[k]
    if (typeof v === "string" && v.trim()) return v.trim()
    if (typeof v === "number" && Number.isFinite(v)) return String(v)
  }
  return null
}

/**
 * PURE. The permit's street address, or null when the row exposes none we recognize.
 *
 * Single-column portals win outright; the composite assembly is the fallback. A composite is
 * only built when BOTH a house number and a street name are present — a street name with no
 * number names a block, not a home, and matching a seller signal onto a whole block is exactly
 * the fuzzy match this lane refuses to make. (normalizeStreetAddress independently drops any
 * key with no digit, so this is belt and braces, but the intent belongs here where the parts
 * are still separable.)
 */
export function readPermitAddress(row: Record<string, unknown>): string | null {
  const single = pick(row, ADDRESS_KEYS)
  if (single) return single

  const number = pick(row, NUMBER_KEYS)
  const name = pick(row, NAME_KEYS)
  if (!number || !name) return null

  return [number, pick(row, PREDIR_KEYS), name, pick(row, SUFFIX_KEYS)]
    .filter((p): p is string => !!p)
    .join(" ")
}

/** PURE. A stable per-permit handle used for idempotency. Null when the row exposes none. */
export function readPermitId(row: Record<string, unknown>): string | null {
  return pick(row, PERMIT_ID_KEYS)
}

/**
 * PURE. The date the permit event actually happened, as `YYYY-MM-DD`, or null when the row does
 * not carry a readable one.
 *
 * WHY THIS EXISTS. A portal's only *queryable* timestamp is not always the event's date. NYC DOB's
 * `dobrundate` is the day DOB re-published the row, and DOB re-publishes decades-old permits — a
 * live row on 2026-08-19 carried `dobrundate: "2026-08-14"` with `issuance_date: "08/14/1998"`.
 * Bounding the query on the re-publish date is correct (it is the only column Socrata can filter);
 * treating a 1998 permit as this week's seller signal is not. So the query bounds, and this filters.
 *
 * `format` is declared per dataset in the registry because the wire shape is not inferable safely:
 * "01/02/2020" is January 2nd in the US portals and February 1st elsewhere, and a two-digit year
 * ("03/13/20", which is what Dallas publishes) is ambiguous in the century — both are REFUSED with
 * null rather than guessed, because a guessed date silently widens or narrows the window.
 */
export function readPermitEventDate(
  row: Record<string, unknown>,
  column: string,
  format: "iso" | "mdy" = "iso",
): string | null {
  const raw = pick(row, [column])
  if (!raw) return null
  if (format === "mdy") {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(raw)
    if (!m) return null // two-digit years and anything else: refused, never guessed
    const [, mm, dd, yyyy] = m
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`
  }
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(raw)
  return iso ? iso[1] : null
}

/** PURE. Free-text work description, or null. */
export function readPermitDescription(row: Record<string, unknown>): string | null {
  const parts = DESCRIPTION_KEYS
    .map((k) => row?.[k])
    .filter((v): v is string => typeof v === "string" && !!v.trim())
    .map((v) => v.trim())
  if (parts.length === 0) return null
  return [...new Set(parts)].join(" · ").slice(0, 400)
}

/** PURE. Declared job value in dollars, or null when unreadable (never 0-as-unknown). */
export function readPermitValuation(row: Record<string, unknown>): number | null {
  const raw = pick(row, VALUATION_KEYS)
  if (raw === null) return null
  const n = Number(String(raw).replace(/[$,]/g, ""))
  return Number.isFinite(n) && n >= 0 ? n : null
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE — strength
// ─────────────────────────────────────────────────────────────────────────────

/** Teardown / redevelopment — the owner is not planning to live in it. */
const STRONG_TERMS = ["demolition", "demolish", "teardown", "tear down", "raze", "wrecking"]
/** Work typical of pre-listing preparation. */
const MODERATE_TERMS = [
  "remodel", "renovation", "renovate", "rehab", "kitchen", "bathroom", "bath remodel",
  "roof", "reroof", "re-roof", "siding", "window replacement", "flooring", "interior finish",
  "addition", "deck", "paint",
]

/**
 * The strength levels THIS LANE emits. A narrowed subset of the one vocabulary
 * for `motivated_seller_signals.signal_strength` — see
 * lib/lead-governance/seller-signal-strength.ts, which owns the full ladder
 * ("weak" | "moderate" | "strong" | "urgent") and the "what counts as strong"
 * threshold the scorer applies.
 *
 * Narrowed ON PURPOSE: "urgent" is a judgement about a PERSON'S situation (the
 * unified-profile lane emits it from a motivation read), and a building permit
 * is a fact about a STRUCTURE. Nothing this lane can observe justifies the top
 * of the ladder, so it cannot spell it. Deriving the type from the canonical
 * list rather than restating the literals is what keeps a fifth level, added
 * there, from silently failing to typecheck here.
 */
export type SignalStrength = Extract<SellerSignalStrength, "strong" | "moderate" | "weak">

/**
 * PURE. Deterministic strength for a permit signal. Same permit, same verdict, always.
 *
 * DELIBERATELY CONSERVATIVE. A permit is circumstantial: most renovation is somebody improving a
 * home they intend to keep. Only demolition/teardown reads as "strong" (the structure is going
 * away, which precedes a land sale or a rebuild-to-sell). Pre-listing cosmetic work reads
 * "moderate". Everything else — solar, HVAC, water heater, fence, electrical, a sign permit —
 * reads "weak", because calling routine maintenance a strong seller signal is how a scoring model
 * learns to chase homeowners who are not selling.
 *
 * A large declared valuation raises a weak permit to moderate: someone spending six figures on a
 * property is doing something that shows up either way.
 */
export function classifyPermitStrength(params: {
  description: string | null
  valuation: number | null
}): SignalStrength {
  const text = (params.description ?? "").toLowerCase()
  if (STRONG_TERMS.some((t) => text.includes(t))) return "strong"
  if (MODERATE_TERMS.some((t) => text.includes(t))) return "moderate"
  if ((params.valuation ?? 0) >= 100_000) return "moderate"
  return "weak"
}

/** PURE. Free-text disposition of a code violation, or null. */
export function readViolationStatus(row: Record<string, unknown>): string | null {
  return pick(row, STATUS_KEYS)
}

/**
 * A violation status that means the owner is still carrying it. Anchored at the START of the
 * value, not searched inside it, because the closed vocabulary contains the open one as a
 * substring ("Close"/"Closed" vs "Open") and a `.includes` here would invert the verdict.
 * Grounded on the values these two datasets actually publish (read live 2026-08-20):
 *   Chicago 22u3-xenr violation_status → OPEN | COMPLIED | NO ENTRY
 *   NYC     wvxf-dwi5 violationstatus  → Open | Close
 */
const OPEN_VIOLATION_STATUS = /^(open|nov sent|active|unresolved|in violation)/

/**
 * PURE. Deterministic strength for a code-violation signal.
 *
 * WHY A VIOLATION IS A SIGNAL AT ALL: a permit says somebody is SPENDING on a house; a violation
 * says the city is billing them for one they are not maintaining. Accruing fines on a property the
 * owner is not fixing is pressure, and pressure is what "motivated seller" means.
 *
 * SAME CONSERVATISM AS PERMITS, DELIBERATELY. Only demolition language reads "strong" — that rule
 * belongs to the lane, not to permits, and a violation ordering a structure razed is the same fact
 * as a demolition permit. An OPEN violation reads "moderate": real, dated, unresolved, but a great
 * many of them are one broken handrail. A CLOSED or COMPLIED violation reads "weak" — it is
 * evidence the owner FIXED the problem, which is close to the opposite of distress, and calling it
 * a strong seller signal would teach the scorer to chase people who maintain their homes.
 */
export function classifyViolationStrength(params: {
  description: string | null
  status: string | null
}): SignalStrength {
  const text = (params.description ?? "").toLowerCase()
  if (STRONG_TERMS.some((t) => text.includes(t))) return "strong"
  const status = (params.status ?? "").trim().toLowerCase()
  if (!status) return "weak" // cannot read the disposition → never assume it is open
  return OPEN_VIOLATION_STATUS.test(status) ? "moderate" : "weak"
}

// ─────────────────────────────────────────────────────────────────────────────
// PURE — matching + row building
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHICH BOARD A MATCH BELONGS TO. Owner ruling 2026-08-21: "motivated sellers
 * source is for leads and contacts." Re-exported from the BatchData lane rather
 * than restated, so the two seller-signal sources cannot drift into two
 * spellings of one discriminator (CLAUDE.md §6).
 */
/** The minimum a lead or contact row must carry to be matchable. */
export interface MatchableLead {
  id: string
  address: string | null
  brokerage_id?: string | null
  /**
   * Which table `id` came from. OPTIONAL, defaulting to "lead", and that
   * default is a compatibility decision rather than a guess: every pre-existing
   * caller of `matchPermitsToLeads` in the tree passes rows read from `leads`
   * (scripts/external-signal-lanes-simulator.ts:188, :408, :621, :933), and the
   * DB ingest below states the kind explicitly on both reads. A future caller
   * that reads contacts and forgets this field files a lead — so the ingest
   * states it, and the simulator asserts it.
   */
  entity?: EntityKind
}

export interface PermitMatch {
  /**
   * The matched entity's id — a `leads.id` when `entity` is "lead", a
   * `contacts.id` when it is "contact".
   *
   * RENAMED 2026-08-22 from `leadId`, which was a LIE half the time: this lane
   * has matched contacts since m517 added `contact_id`, so a field spelled
   * "lead" carried a `contacts.id` on every contact match. The name is now the
   * SAME SPELLING the sibling seller-signal source already uses for the same
   * idea — `entityId` beside `entity` in lib/external/batchdata-seller-signals.ts
   * (:858, :920) — because two spellings of one discriminated id are the defect
   * CLAUDE.md §6 names, not a style choice.
   *
   * NOTHING ON A WIRE CHANGED. This is a TypeScript field name only. The
   * database columns are `lead_id` / `contact_id` (chosen from `entity` in
   * `buildPermitSignalRow`), the jsonb keys in `signal_details` are snake_case
   * and none was ever spelled `leadId`, and `permitDedupeKey` emits the same
   * string it emitted before — so no stored row and no response body moves.
   */
  entityId: string
  entity: EntityKind
  addressKey: string
  permitId: string | null
  permitAddress: string
  description: string | null
  valuation: number | null
  strength: SignalStrength
  /** Disposition, for code violations. Null for permits and for rows that publish none. */
  status: string | null
  /**
   * The day the event happened, `YYYY-MM-DD`, when the dataset declares a readable date column.
   * Carried for ONE reason: it is the second half of the dedupe key when the portal publishes no
   * stable record number (see `permitDedupeKey`).
   */
  eventDate: string | null
  raw: Record<string, unknown>
}

export interface MatchOutcome {
  matches: PermitMatch[]
  skippedNoAddress: number
  skippedNoLeadMatch: number
  /** Rows whose event date parsed and fell BEFORE the window — real permits, just not recent. */
  skippedOutsideWindow: number
  /** Rows whose declared event-date column was absent or unparseable. Cannot read ≠ not recent. */
  skippedNoEventDate: number
}

/**
 * Applied only when the dataset's query bound is a publication date rather than the event date
 * (see `readPermitEventDate`). Absent = the query bound already was the event date, and every
 * fetched row is in-window by construction.
 */
export interface PermitEventWindow {
  column: string
  format?: "iso" | "mdy"
  /** Inclusive lower bound, `YYYY-MM-DD`. */
  sinceIso: string
}

/**
 * PURE. Join permit rows to the brokerage's own leads on a normalized address key.
 *
 * EXACT key equality only. An address that normalizes to "" (no house number, or unreadable) is
 * excluded on BOTH sides so two unusable addresses can never collide into a false match.
 * When several leads share one address (a couple filed as two leads, or a duplicate), EVERY
 * matching lead gets the signal — the permit is genuinely about all of them, and picking one
 * silently would hide the other.
 */
/**
 * Per-dataset facts the matcher needs that are not part of windowing.
 *
 * `dateColumn` is separate from `PermitEventWindow` on purpose: EVERY dataset has a date column to
 * stamp matches with, but only the datasets whose query bound is a re-publish date need a window
 * to filter on. Conflating them would mean an unwindowed dataset (Chicago, Seattle, Montgomery)
 * could not stamp an event date, and its id-less rows would lose the only thing that tells two
 * violations at one address apart.
 */
export interface PermitDatasetShape {
  /** Column carrying the event's own date, for stamping `PermitMatch.eventDate`. */
  dateColumn?: string
  dateFormat?: "iso" | "mdy"
  /** Chooses the strength classifier. Defaults to permit semantics. */
  kind?: "permits" | "code_violations"
}

export function matchPermitsToLeads(
  permits: Array<Record<string, unknown>>,
  leads: MatchableLead[],
  window?: PermitEventWindow,
  shape?: PermitDatasetShape,
): MatchOutcome {
  // Keyed to (id, entity) pairs, not bare ids. Two DISJOINT uuid namespaces meet
  // in this map — `leads.id` and `contacts.id` — and an address at which the
  // tenant holds both a lead and a contact must produce two DISTINCT matches
  // filed into two DIFFERENT columns, not one match under an ambiguous id.
  const byKey = new Map<string, Array<{ id: string; entity: EntityKind }>>()
  for (const lead of leads) {
    const key = normalizeStreetAddress(lead.address)
    if (!key) continue
    const entry = { id: lead.id, entity: lead.entity ?? ("lead" as const) }
    const bucket = byKey.get(key)
    if (bucket) bucket.push(entry)
    else byKey.set(key, [entry])
  }

  const matches: PermitMatch[] = []
  let skippedNoAddress = 0
  let skippedNoLeadMatch = 0
  let skippedOutsideWindow = 0
  let skippedNoEventDate = 0

  for (const row of permits ?? []) {
    if (window) {
      const eventDate = readPermitEventDate(row, window.column, window.format ?? "iso")
      // Both branches are counted separately and on purpose. "This permit is from 1998" and "this
      // portal did not tell me when this permit happened" are different facts, and collapsing them
      // is the same mistake that made an unreadable New York look like an idle New York.
      if (!eventDate) { skippedNoEventDate++; continue }
      if (eventDate < window.sinceIso) { skippedOutsideWindow++; continue }
    }
    const permitAddress = readPermitAddress(row)
    const key = normalizeStreetAddress(permitAddress)
    if (!key) { skippedNoAddress++; continue }
    const leadIds = byKey.get(key)
    if (!leadIds || leadIds.length === 0) { skippedNoLeadMatch++; continue }

    const description = readPermitDescription(row)
    const valuation = readPermitValuation(row)
    const status = shape?.kind === "code_violations" ? readViolationStatus(row) : null
    const strength = shape?.kind === "code_violations"
      ? classifyViolationStrength({ description, status })
      : classifyPermitStrength({ description, valuation })
    const eventDate = shape?.dateColumn
      ? readPermitEventDate(row, shape.dateColumn, shape.dateFormat ?? "iso")
      : null
    for (const entity of leadIds) {
      matches.push({
        entityId: entity.id,
        entity: entity.entity,
        addressKey: key,
        permitId: readPermitId(row),
        permitAddress: permitAddress as string,
        description,
        valuation,
        strength,
        status,
        eventDate,
        raw: row,
      })
    }
  }
  return { matches, skippedNoAddress, skippedNoLeadMatch, skippedOutsideWindow, skippedNoEventDate }
}

/** The canonical signal_type this lane writes for a building permit. */
export const PERMIT_SIGNAL_TYPE = "permit_activity"
/**
 * …and for a code violation. A SECOND value, not a widened first one: lead scoring and the
 * intelligence panel both read signal_type, and collapsing "someone is spending money on this
 * house" into "the city is citing this house" would make the two indistinguishable downstream.
 */
export const VIOLATION_SIGNAL_TYPE = "code_violation"
/** Every signal_type this lane writes — the set the idempotency read and m499's unique index cover.
 *  Adding a kind here without adding it to the index is how a daily sweep starts duplicating. */
export const SOCRATA_SIGNAL_TYPES: readonly string[] = [PERMIT_SIGNAL_TYPE, VIOLATION_SIGNAL_TYPE]
/** `detected_via` — the provider, matching the connector id in lib/agentic-os/connector-registry. */
export const PERMIT_DETECTED_VIA = "socrata"
/** …and for a dataset read over an ArcGIS FeatureServer (lib/external/arcgis-permits.ts). */
export const ARCGIS_DETECTED_VIA = "arcgis"

/**
 * PURE. The `detected_via` a dataset's rows are stamped with.
 *
 * A SECOND VALUE, NOT A WIDENED FIRST ONE. `detected_via` names the provider the fact came from,
 * and stamping a Miami-Dade FeatureServer row "socrata" would be a false provenance on a column
 * whose only job is provenance — the operator tracing a bad signal would go read a Socrata portal
 * that never served it. The two providers also fail in different ways (see arcgis-permits.ts:
 * ArcGIS reports its errors inside a 200), so telling them apart in the stored row is what makes
 * a per-provider outage legible after the fact.
 */
export function detectedViaForDataset(dataset: SocrataDatasetSpec): string {
  return providerOf(dataset) === "arcgis" ? ARCGIS_DETECTED_VIA : PERMIT_DETECTED_VIA
}

/** PURE. The signal_type a dataset's rows are filed under. */
export function signalTypeForKind(kind: SocrataDatasetSpec["kind"]): string {
  return kind === "code_violations" ? VIOLATION_SIGNAL_TYPE : PERMIT_SIGNAL_TYPE
}

/**
 * EXACTLY ONE of `lead_id` / `contact_id` is present; the other is omitted
 * rather than sent as null. m517 adds `contact_id` and the CHECK that makes
 * "exactly one" a database fact instead of a convention.
 */
export interface PermitSignalRow {
  lead_id?: string
  contact_id?: string
  brokerage_id: string
  signal_type: string
  signal_strength: SignalStrength
  detected_via: string
  signal_details: Record<string, unknown>
}

/**
 * PURE. Build the `motivated_seller_signals` row. Columns verified against the live table
 * (project hrvaqgvukzxfskkcrwbt): lead_id, brokerage_id, signal_type, signal_strength,
 * detected_via, signal_details jsonb, detected_at (defaults now()).
 *
 * `dedupe_key` inside signal_details is what makes a DAILY cadence safe on a table that carries no
 * unique constraint: the next run reads back the keys it already wrote and skips them.
 */
export function buildPermitSignalRow(params: {
  match: PermitMatch
  brokerageId: string
  dataset: SocrataDatasetSpec
}): PermitSignalRow {
  const { match, dataset } = params
  const isViolation = dataset.kind === "code_violations"
  return {
    // The column is chosen from `match.entity`, NEVER from the id field's name.
    // A contact filed into `lead_id` is a row no reader can ever see — the
    // failure tombstoned at app/actions/lead-intelligence.ts:2444. The field is
    // `entityId` (renamed from `leadId` on 2026-08-22) precisely so the name can
    // no longer suggest the wrong column to the next reader.
    ...(match.entity === "contact"
      ? { contact_id: match.entityId }
      : { lead_id: match.entityId }),
    brokerage_id: params.brokerageId,
    signal_type: signalTypeForKind(dataset.kind),
    signal_strength: match.strength,
    detected_via: detectedViaForDataset(dataset),
    signal_details: {
      // Fixed sentences, not generated ones. Nothing here is authored by a model, and nothing
      // written into a field whose name implies a measurement is anything but a read value.
      reason: isViolation
        ? "City code violation recorded at this lead's address"
        : "Building permit issued at this lead's address",
      dedupe_key: permitDedupeKey(match, dataset),
      permit_id: match.permitId,
      permit_address: match.permitAddress,
      // Repeated here as well as implied by the populated column: in a jsonb
      // dump the NULL column is invisible and the row stops being
      // self-describing.
      entity: match.entity,
      address_key: match.addressKey,
      description: match.description,
      valuation: match.valuation,
      event_date: match.eventDate,
      violation_status: match.status,
      dataset_kind: dataset.kind,
      dataset_id: dataset.datasetId,
      dataset_host: dataset.host,
      dataset_label: dataset.label,
    },
  }
}

/**
 * PURE. Stable identity for one (record, lead) pair.
 *
 * When the portal exposes a permit or violation number we key on it. When it does NOT, we key on
 * the normalized address plus the record's own EVENT DATE — which is stable across re-reads (a
 * violation issued on the 18th was still issued on the 18th tomorrow) and is the only thing that
 * distinguishes two citations at one address. This matters far more for violations than permits:
 * Chicago's violations feed publishes no case number at all, and without the date every violation
 * a property ever collects would collapse into ONE signal, turning the accrual that makes a
 * violation predictive into a single flat fact.
 *
 * With neither an id nor a date we fall back to address-plus-dataset — coarser on purpose, because
 * collapsing two records into one signal is the safe error where splitting them would re-file the
 * same record every single day forever.
 */
export function permitDedupeKey(match: PermitMatch, dataset: SocrataDatasetSpec): string {
  const tail = match.permitId
    ? `p:${match.permitId}`
    : match.eventDate
      ? `a:${match.addressKey}@${match.eventDate}`
      : `a:${match.addressKey}`
  // THE ENTITY KIND IS PART OF THE KEY. `leads.id` and `contacts.id` are
  // disjoint uuid namespaces filed in one table, so a key naming only the id
  // cannot say which board it belongs to. The dataset prefix is unchanged, which
  // is what scripts/external-signal-lanes-simulator.ts:942 asserts on.
  //
  // THIS FORMAT CHANGED on 2026-08-21 (the tail gained `lead:` / `contact:`).
  // Safe only because the live table is EMPTY — `select count(*) from
  // motivated_seller_signals` → 0 against project hrvaqgvukzxfskkcrwbt on
  // 2026-08-21. With rows present, every one would have re-filed on the next
  // daily sweep.
  return `${dataset.datasetId}|${tail}|${match.entity}:${match.entityId}`
}

// ─────────────────────────────────────────────────────────────────────────────
// DB — the ingest
// ─────────────────────────────────────────────────────────────────────────────

export interface PermitScanTerritory {
  brokerage_id: string | null
  city?: string | null
  state?: string | null
}

/**
 * ONE QUERIED DATASET'S OWN VERDICT.
 *
 * WHY THIS EXISTS, AND IT IS THE CENTRAL DEFECT OF THIS LANE ARRIVING FOR THE SIXTH TIME.
 * `permitsFetched` is a SUM across every dataset in the run. Under a sum, a dataset that returns
 * zero rows and a dataset that has quietly died are THE SAME NUMBER — the total just gets
 * smaller, and nothing in the output says which feed stopped. That is the identical sentence
 * socrata-market-registry.ts has now written five times about five different failure shapes, one
 * level up: this time the thing that cannot be told apart is not two datasets but two RUNS.
 *
 * So every queried dataset now reports for itself. `ok` + `rows` are independent facts and the
 * three states stay three:
 *   ok:true,  rows:0   → the feed served, and this window is genuinely quiet
 *   ok:false, rows:0   → the feed REFUSED, and `error` says so in the vendor's own words
 *   ok:true,  rows:N   → data
 * A fourth, `truncated`, is only reachable on ArcGIS and means the page cap cut the window short
 * — rows returned, but not all of them, which is not the same as a complete quiet answer either.
 */
export interface DatasetProbe {
  /** `"host/datasetId"` — the same key the sweep dedupes datasets on. */
  dataset: string
  label: string
  provider: string
  /** HTTP status when there was one. Null for a refusal built before any request left. */
  status: number | null
  ok: boolean
  /** Rows the adapter handed back. Meaningful ONLY when ok — never read this alone. */
  rows: number
  /** Rows that survived windowing and address-matching into a signal candidate. */
  matched: number
  /** True when the provider capped the page and more matching rows exist than were read. */
  truncated: boolean
  /** Stated reason when ok is false. Null when ok. */
  error: string | null
}

export interface PermitIngestResult {
  brokerageId: string
  marketsConsidered: number
  datasetsQueried: number
  /**
   * ONE ENTRY PER DATASET ACTUALLY QUERIED, in query order. The run's most diagnostic output:
   * `permitsFetched` says how much the sweep saw in total, and this says which feed it came from
   * and which feed said nothing — the difference between "a quiet week" and "a dead endpoint".
   */
  datasetHealth: DatasetProbe[]
  /** Registered datasets (either kind) that carry no `dateColumn`, so recentPermits cannot bound
   *  them. Distinct from `unavailable`: the portal is alive, our descriptor is incomplete. */
  datasetsSkippedNoDateColumn: number
  /**
   * Registered datasets marked `unavailable` in the registry — a dead dataset id, a stale
   * feed, or a host that is not a Socrata portal at all. Never queried, always reported, with the
   * registry's stated reason attached, so a broken portal reads as broken and not as a quiet market.
   */
  datasetsUnavailable: number
  /** The `unavailable` reasons, verbatim, so the operator sees WHY without opening the registry. */
  unavailableReasons: string[]
  /** Territories whose (state, city) is not in socrata-market-registry MARKETS at all. */
  marketsUnregistered: number
  /**
   * ONE VERDICT PER ACTIVE TERRITORY, NAMED. The owner ruling is "all markets from the active
   * tenant territories" — so the unit of reporting is the TERRITORY, not the registry entry. A
   * market this OS cannot see appears here by name with the status `unregistered`; it is the whole
   * reason a tenant farming an unregistered city can no longer be served silence that looks
   * identical to "no permits this week".
   */
  coverage: MarketCoverage[]
  /** `"FL:Pensacola"`-style labels for every territory that produced no queryable dataset. The
   *  cron surfaces this list verbatim; it is the actionable half of `coverage`. */
  marketGaps: string[]
  permitsFetched: number
  skippedNoAddress: number
  /** Fetched rows whose address matched NO lead and NO contact this tenant owns.
   *  The name predates contacts being matchable and is kept because MatchOutcome
   *  publishes the same field under the same name; it now means "no ENTITY
   *  matched". */
  skippedNoLeadMatch: number
  /** Fetched rows that were genuinely older than the window (portals that re-publish history). */
  skippedOutsideWindow: number
  /** Fetched rows whose declared event-date column was missing or unparseable. */
  skippedNoEventDate: number
  // ── THE TWO BOARDS, COUNTED APART ─────────────────────────────────────────
  // Owner ruling 2026-08-21: "motivated sellers source is for leads and
  // contacts." A single `signals_written` covering both would make a run that
  // filed forty lead signals and zero contact signals read exactly like one that
  // did the reverse — and "contacts are covered" would be a claim rather than a
  // measurement.
  /** Unconverted leads with a usable address that were candidates for a match. */
  leadsMatchable: number
  /** Live contacts with a usable address that were candidates for a match. */
  contactsMatchable: number
  /** Leads excluded because they are already converted (`leads.contact_id` set).
   *  Their CONTACT is matched instead; without this counter the exclusion looks
   *  like a shrinking lead base. */
  leadsSkippedConverted: number
  alreadyRecorded: number
  signalsWritten: number
  /** `signalsWritten` split by the column the row actually landed in. */
  signalsWrittenByEntity: { lead: number; contact: number }
  /** Every refusal, verbatim. A run with errors NEVER reports a clean success. */
  errors: string[]
}

/** Minimal client surface — accepts the SSR or service supabase client without importing either. */
type SupabaseLike = { from: (table: string) => any }

const MAX_PERMITS_PER_DATASET = 1000
const MAX_LEADS_PER_BROKERAGE = 5000
const MAX_SIGNALS_PER_RUN = 500

/**
 * Run the Socrata scan for ONE brokerage across its configured territories and file the matches
 * into `motivated_seller_signals` — building permits AND code violations.
 *
 * COVERAGE IS AN OUTPUT, NOT A PRECONDITION. Every territory the tenant configured comes back in
 * `coverage` with a verdict, and `marketGaps` names the ones that produced nothing. A run that
 * queries zero datasets is a legitimate, INFORMATIVE result — it says which markets this OS cannot
 * see — where before it was indistinguishable from a quiet week.
 *
 * TENANT SCOPING: every read and every write is pinned to `brokerageId`. The lead read filters
 * `.eq("brokerage_id", brokerageId)`, the idempotency read filters on it, and each written row
 * carries it. A permit in Austin can only ever attach to a lead owned by the brokerage whose
 * territory named Austin.
 *
 * REFUSALS: supabase-js RESOLVES a refused query, so every call here destructures `{ data, error }`
 * and pushes the message onto `errors`. A refused lead read is reported as an error and the run
 * writes nothing for that brokerage — it is never reported as "0 matches".
 */
export async function ingestPermitSignals(params: {
  supabase: SupabaseLike
  brokerageId: string
  territories: PermitScanTerritory[]
  /** Only permits issued on/after this ISO date are considered. */
  sinceIso: string
}): Promise<PermitIngestResult> {
  const { supabase, brokerageId, territories, sinceIso } = params
  const result: PermitIngestResult = {
    brokerageId,
    marketsConsidered: 0,
    datasetsQueried: 0,
    datasetHealth: [],
    datasetsSkippedNoDateColumn: 0,
    datasetsUnavailable: 0,
    unavailableReasons: [],
    marketsUnregistered: 0,
    coverage: [],
    marketGaps: [],
    permitsFetched: 0,
    skippedNoAddress: 0,
    skippedNoLeadMatch: 0,
    skippedOutsideWindow: 0,
    skippedNoEventDate: 0,
    leadsMatchable: 0,
    contactsMatchable: 0,
    leadsSkippedConverted: 0,
    alreadyRecorded: 0,
    signalsWritten: 0,
    signalsWrittenByEntity: { lead: 0, contact: 0 },
    errors: [],
  }

  // ── 1. WALK THE TENANT'S TERRITORIES AND GIVE EVERY ONE A VERDICT ──
  //
  // This loop used to iterate the REGISTRY's answer for each territory and silently move on when
  // there wasn't one. It now iterates the TERRITORIES and records what happened to each, because
  // the two are not the same list and the difference is exactly where a tenant disappears: a
  // brokerage farming a city nobody registered got `marketsUnregistered++` — a NUMBER, with no name
  // attached — and then a run reporting zero signals. `coverage` names them.
  const datasets: SocrataDatasetSpec[] = []
  const seen = new Set<string>()
  const seenMarkets = new Set<string>()
  for (const t of territories) {
    result.marketsConsidered++
    const verdict = classifyMarketCoverage({ state: t.state, city: t.city })

    // One verdict per distinct market, even when several territory rows name the same city — and
    // case-insensitively, because `lead_scraping_markets.city` is free text a human typed and
    // "Pensacola" and "pensacola" are one market, not two.
    const marketKey = verdict.market.toLowerCase()
    if (!seenMarkets.has(marketKey)) {
      seenMarkets.add(marketKey)
      result.coverage.push(verdict)
      if (verdict.status !== "covered") result.marketGaps.push(`${verdict.market} (${verdict.status})`)
    }
    if (verdict.status === "unregistered") { result.marketsUnregistered++; continue }

    // The per-DATASET counters the cron already reports are kept, and are still counted once per
    // territory row: a dead portal named by three territories is three refusals to serve.
    // `unavailableReasons` stays strictly about datasets the registry marks UNAVAILABLE — the
    // other exclusion reasons (no verified date column, a registered kind this lane cannot ingest
    // yet) ride in `coverage[].reasons`, because a field named for one thing must not quietly
    // start carrying three.
    for (const spec of verdict.ingestible) {
      if (spec.unavailable) {
        result.datasetsUnavailable++
        const reason = `${spec.label} (${spec.host}/${spec.datasetId}): ${spec.unavailable}`
        if (!result.unavailableReasons.includes(reason)) result.unavailableReasons.push(reason)
        continue
      }
      if (!spec.dateColumn) { result.datasetsSkippedNoDateColumn++; continue }
    }

    for (const spec of verdict.queryable) {
      const id = `${spec.host}/${spec.datasetId}`
      if (seen.has(id)) continue
      seen.add(id)
      datasets.push(spec)
    }
  }
  // NOTE: we do NOT return early on an empty dataset list any more. `coverage` and `marketGaps` are
  // the run's most important output when nothing is queryable — returning here with them populated
  // is correct, and the caller reports them.
  if (datasets.length === 0) return result

  // ── 2a. The tenant's own UNCONVERTED leads ──────────────────────────────
  //
  // `.is("contact_id", null)` IS LOAD-BEARING. `leads.contact_id` REFERENCES
  // contacts(id) (verified live, constraint leads_contact_id_fkey), so a
  // converted lead and its contact are the SAME PERSON at the SAME ADDRESS.
  // Matching a permit to both would file the identical permit twice under two
  // dedupe keys, and lead scoring COUNTS signals — one roof permit would become
  // two independent reasons to believe somebody is selling. The owner ruled that
  // after conversion only the contact is acted on, so the contact is the
  // survivor and the lead row is excluded here.
  //
  // THE PREDICATE IS NOT SPELLED HERE. `excludeConvertedLeads`
  // (lib/contact-promotion/conversion-finality.ts) is the ONE conversion guard
  // and it owns the marker column — three converters in this tree write
  // different "converted" flags and `leads.contact_id` is the only one every
  // path sets. A second inline copy of that decision is how one copy later
  // stops matching (CLAUDE.md §6).
  const { data: leadRows, error: leadsError } = await excludeConvertedLeads(
    supabase
      .from("leads")
      .select("id, address")
      .eq("brokerage_id", brokerageId),
  )
    .not("address", "is", null)
    .limit(MAX_LEADS_PER_BROKERAGE)
  if (leadsError) {
    result.errors.push(`leads read refused: ${leadsError.message}`)
    return result
  }
  const leadEntities: MatchableLead[] = ((leadRows ?? []) as MatchableLead[])
    .map((l) => ({ ...l, entity: "lead" as const }))
  result.leadsMatchable = leadEntities.length

  const { count: convertedCount, error: convertedError } = await supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId)
    .not("contact_id", "is", null)
    .not("address", "is", null)
  if (convertedError) result.errors.push(`converted-lead count refused: ${convertedError.message}`)
  else result.leadsSkippedConverted = convertedCount ?? 0

  // ── 2b. …and the tenant's own CONTACTS ──────────────────────────────────
  //
  // Owner ruling 2026-08-21: "motivated sellers source is for leads and
  // contacts." `contacts.id` is the PRIMARY KEY and the column
  // `leads.contact_id` points at — NOT `contacts.contact_id`, the secondary
  // unique uuid this table also carries (CLAUDE.md §3). Live on 2026-08-21 all
  // four contact rows have id <> contact_id, so choosing wrong would produce a
  // permit lane that matched nothing and looked like a quiet market.
  const { data: contactRows, error: contactsError } = await supabase
    .from("contacts")
    .select("id, address")
    .eq("brokerage_id", brokerageId)
    .is("deleted_at", null)
    .not("address", "is", null)
    .limit(MAX_LEADS_PER_BROKERAGE)
  if (contactsError) {
    result.errors.push(`contacts read refused: ${contactsError.message}`)
    return result
  }
  const contactEntities: MatchableLead[] = ((contactRows ?? []) as MatchableLead[])
    .map((c) => ({ ...c, entity: "contact" as const }))
  result.contactsMatchable = contactEntities.length

  const leads: MatchableLead[] = [...leadEntities, ...contactEntities]
  if (leads.length === 0) return result

  // ── 3. Already-filed Socrata signals for this tenant (idempotency) ──
  //
  // `.in`, not `.eq`. This read was pinned to permit_activity, and the moment code_violation
  // started being written an `.eq` here would have read back NONE of yesterday's violations,
  // re-filed the entire rolling window every day, and — because lead scoring COUNTS signals —
  // turned one broken handrail into a new reason to believe somebody is selling, daily, forever.
  // m499 widens the unique index to match; this is the fast path in front of it.
  const { data: existingRows, error: existingError } = await supabase
    .from("motivated_seller_signals")
    .select("signal_details")
    .eq("brokerage_id", brokerageId)
    .in("signal_type", SOCRATA_SIGNAL_TYPES)
  if (existingError) {
    // Without the existing set we cannot tell a new permit from one filed yesterday. Writing
    // anyway would duplicate the whole window on every daily run, so this refuses instead.
    result.errors.push(`existing-signal read refused: ${existingError.message}`)
    return result
  }
  const alreadyKeys = new Set<string>()
  for (const row of (existingRows ?? []) as Array<{ signal_details: { dedupe_key?: string } | null }>) {
    const k = row?.signal_details?.dedupe_key
    if (typeof k === "string" && k) alreadyKeys.add(k)
  }

  // ── 4. Per dataset: fetch recent permits, match, build ──
  const toWrite: PermitSignalRow[] = []
  for (const dataset of datasets) {
    result.datasetsQueried++
    const provider = providerOf(dataset)
    const datasetKey = `${dataset.host}/${dataset.datasetId}`

    // ── THE PROVIDER BRANCH ──────────────────────────────────────────────────
    // The ONLY place the two providers differ. Both adapters return the same
    // `{ ok, status, data, error }` envelope over the same flat row shape, so everything below
    // this — windowing, address matching, strength, dedupe, the write — is provider-agnostic and
    // stays that way. A second provider that forked the whole pipeline would be a second lane.
    const res = provider === "arcgis"
      ? await recentArcgisPermits({
          serviceUrl: dataset.serviceUrl as string,
          dateField: dataset.dateColumn as string,
          sinceIso,
          limit: MAX_PERMITS_PER_DATASET,
        })
      : await recentPermits<Record<string, unknown>>({
          host: dataset.host,
          datasetId: dataset.datasetId,
          sinceIso,
          permitDateColumn: dataset.dateColumn as string,
          limit: MAX_PERMITS_PER_DATASET,
        })
    const truncated = "truncated" in res ? res.truncated === true : false

    const probe: DatasetProbe = {
      dataset: datasetKey,
      label: dataset.label,
      provider,
      status: res.status,
      ok: res.ok,
      rows: res.ok ? res.data.length : 0,
      matched: 0,
      truncated,
      error: res.ok ? null : (res.error ?? `${provider} refused`),
    }
    result.datasetHealth.push(probe)

    if (!res.ok) {
      result.errors.push(`${dataset.label} (${datasetKey}): ${res.error ?? `${provider} refused`}`)
      continue
    }
    // A capped page is a REPORTED fact, not a silent one: the window was wider than the read.
    // It is not pushed onto `errors` — the rows we did get are real and usable — but a run that
    // truncated has not seen the whole week and must not be able to claim it has.
    if (truncated) {
      result.errors.push(
        `${dataset.label} (${datasetKey}): page cap reached — more permits matched this window than were read`,
      )
    }
    result.permitsFetched += res.data.length

    // When the dataset's query bound is a re-publish date, the fetched rows are NOT all recent —
    // filter them on the column that carries the real event date before anything becomes a signal.
    const outcome = matchPermitsToLeads(
      res.data,
      leads,
      dataset.eventDateColumn
        ? { column: dataset.eventDateColumn, format: dataset.eventDateFormat ?? "iso", sinceIso }
        : undefined,
      {
        // Stamp the event date from whichever column actually carries it — the event column when
        // the query bound is a re-publish date, otherwise the query bound itself.
        dateColumn: dataset.eventDateColumn ?? dataset.dateColumn,
        dateFormat: dataset.eventDateColumn ? (dataset.eventDateFormat ?? "iso") : "iso",
        kind: dataset.kind === "code_violations" ? "code_violations" : "permits",
      },
    )
    result.skippedNoAddress += outcome.skippedNoAddress
    result.skippedNoLeadMatch += outcome.skippedNoLeadMatch
    result.skippedOutsideWindow += outcome.skippedOutsideWindow
    result.skippedNoEventDate += outcome.skippedNoEventDate
    probe.matched = outcome.matches.length

    for (const match of outcome.matches) {
      const key = permitDedupeKey(match, dataset)
      if (alreadyKeys.has(key)) { result.alreadyRecorded++; continue }
      alreadyKeys.add(key) // also dedupes WITHIN this run (same permit in two datasets)
      toWrite.push(buildPermitSignalRow({ match, brokerageId, dataset }))
      if (toWrite.length >= MAX_SIGNALS_PER_RUN) break
    }
    if (toWrite.length >= MAX_SIGNALS_PER_RUN) break
  }

  if (toWrite.length === 0) return result

  // ── 5. Write ──
  //
  // m490 added `motivated_seller_signals_permit_dedupe`, a partial UNIQUE index on
  // signal_details->>'dedupe_key' for signal_type='permit_activity'. The read in step 3 is the
  // fast path; the index is the guarantee. A batch INSERT is one statement, so ONE duplicate
  // (a concurrent run, a re-dispatch) would reject the whole batch — so a 23505 falls back to
  // per-row inserts, which lets every genuinely-new signal through and counts the collisions as
  // what they are: already recorded. Any OTHER error is reported, never swallowed.
  // Counted from WHICH COLUMN THE ROW CARRIES, never from a variable the loop
  // was holding: the split counter exists to PROVE contacts land in contact_id,
  // and deriving it from anything but the row would prove only that the code
  // believed so.
  const countByEntity = (rows: PermitSignalRow[]) => {
    for (const r of rows) result.signalsWrittenByEntity[r.contact_id ? "contact" : "lead"]++
  }

  const { data: inserted, error: insertError } = await supabase
    .from("motivated_seller_signals")
    .insert(toWrite)
    .select("id")

  if (!insertError) {
    result.signalsWritten = (inserted ?? []).length
    countByEntity(toWrite)
    return result
  }
  if ((insertError as { code?: string }).code !== "23505") {
    result.errors.push(`motivated_seller_signals insert refused: ${insertError.message}`)
    return result
  }

  for (const row of toWrite) {
    const { data: one, error: oneError } = await supabase
      .from("motivated_seller_signals")
      .insert(row)
      .select("id")
      .maybeSingle()
    if (!oneError) { if (one) { result.signalsWritten++; countByEntity([row]) } ; continue }
    if ((oneError as { code?: string }).code === "23505") { result.alreadyRecorded++; continue }
    result.errors.push(`motivated_seller_signals insert refused: ${oneError.message}`)
  }
  return result
}
