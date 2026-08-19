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
 * So this lane only ever ATTACHES a permit to a lead the brokerage ALREADY owns, matched on a
 * normalized street address within the same tenant. No lead is created, no contact is created,
 * and an unmatched permit is dropped, counted, and reported — never stored as an orphan signal
 * with a NULL lead_id that no reader can ever see (every reader of this table filters
 * `.eq("lead_id", …)`; a NULL-lead row would be an unreadable write).
 *
 * ── WHAT IT REFUSES TO GUESS ─────────────────────────────────────────────────
 * Socrata datasets have no shared column vocabulary — Austin's address column is not Chicago's.
 * The field readers below try a documented candidate list and return null when none is present.
 * A permit with no readable address is SKIPPED and counted as `skipped_no_address`; it is never
 * fuzzy-matched to "the closest lead", because a wrong match writes a seller signal onto an
 * innocent person's record and every downstream score then treats it as observed fact.
 *
 * The pure half (everything above `ingestPermitSignals`) has no I/O and is simulator-driven.
 */

import { recentPermits } from "./socrata-client"
import { getMarketDatasets, type SocrataDatasetSpec } from "./socrata-market-registry"

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

/** Address column names observed across the registered portals, most-specific first. */
const ADDRESS_KEYS = [
  "original_address1", "originaladdress1", "street_address", "address", "permit_address",
  "project_address", "site_address", "full_address", "address_line_1", "house_address",
  "location_address", "primary_address", "job_address", "worksite_address",
]
const PERMIT_ID_KEYS = [
  "permit_number", "permitnum", "permit_num", "permit_id", "permitno", "permit",
  "record_id", "application_number", "job_number", "job__", "case_number", "number",
]
const DESCRIPTION_KEYS = [
  "description", "permit_type_desc", "work_description", "job_description", "permit_class",
  "work_class", "permit_type", "type_of_work", "proposed_use", "scope_of_work", "worktype",
  "permit_class_mapped", "reported_cost_description",
]
const VALUATION_KEYS = [
  "total_job_valuation", "estimated_cost", "reported_cost", "valuation", "job_value",
  "total_valuation", "declared_valuation", "estimated_project_cost", "construction_cost",
]

function pick(row: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = row?.[k]
    if (typeof v === "string" && v.trim()) return v.trim()
    if (typeof v === "number" && Number.isFinite(v)) return String(v)
  }
  return null
}

/** PURE. The permit's street address, or null when the row exposes none we recognize. */
export function readPermitAddress(row: Record<string, unknown>): string | null {
  return pick(row, ADDRESS_KEYS)
}

/** PURE. A stable per-permit handle used for idempotency. Null when the row exposes none. */
export function readPermitId(row: Record<string, unknown>): string | null {
  return pick(row, PERMIT_ID_KEYS)
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

export type SignalStrength = "strong" | "moderate" | "weak"

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

// ─────────────────────────────────────────────────────────────────────────────
// PURE — matching + row building
// ─────────────────────────────────────────────────────────────────────────────

/** The minimum a lead row must carry to be matchable. */
export interface MatchableLead {
  id: string
  address: string | null
  brokerage_id?: string | null
}

export interface PermitMatch {
  leadId: string
  addressKey: string
  permitId: string | null
  permitAddress: string
  description: string | null
  valuation: number | null
  strength: SignalStrength
  raw: Record<string, unknown>
}

export interface MatchOutcome {
  matches: PermitMatch[]
  skippedNoAddress: number
  skippedNoLeadMatch: number
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
export function matchPermitsToLeads(
  permits: Array<Record<string, unknown>>,
  leads: MatchableLead[],
): MatchOutcome {
  const byKey = new Map<string, string[]>()
  for (const lead of leads) {
    const key = normalizeStreetAddress(lead.address)
    if (!key) continue
    const bucket = byKey.get(key)
    if (bucket) bucket.push(lead.id)
    else byKey.set(key, [lead.id])
  }

  const matches: PermitMatch[] = []
  let skippedNoAddress = 0
  let skippedNoLeadMatch = 0

  for (const row of permits ?? []) {
    const permitAddress = readPermitAddress(row)
    const key = normalizeStreetAddress(permitAddress)
    if (!key) { skippedNoAddress++; continue }
    const leadIds = byKey.get(key)
    if (!leadIds || leadIds.length === 0) { skippedNoLeadMatch++; continue }

    const description = readPermitDescription(row)
    const valuation = readPermitValuation(row)
    const strength = classifyPermitStrength({ description, valuation })
    for (const leadId of leadIds) {
      matches.push({
        leadId,
        addressKey: key,
        permitId: readPermitId(row),
        permitAddress: permitAddress as string,
        description,
        valuation,
        strength,
        raw: row,
      })
    }
  }
  return { matches, skippedNoAddress, skippedNoLeadMatch }
}

/** The canonical signal_type this lane writes. One value, so the idempotency read can find them. */
export const PERMIT_SIGNAL_TYPE = "permit_activity"
/** `detected_via` — the provider, matching the connector id in lib/agentic-os/connector-registry. */
export const PERMIT_DETECTED_VIA = "socrata"

export interface PermitSignalRow {
  lead_id: string
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
  return {
    lead_id: match.leadId,
    brokerage_id: params.brokerageId,
    signal_type: PERMIT_SIGNAL_TYPE,
    signal_strength: match.strength,
    detected_via: PERMIT_DETECTED_VIA,
    signal_details: {
      reason: "Building permit issued at this lead's address",
      dedupe_key: permitDedupeKey(match, dataset),
      permit_id: match.permitId,
      permit_address: match.permitAddress,
      address_key: match.addressKey,
      description: match.description,
      valuation: match.valuation,
      dataset_id: dataset.datasetId,
      dataset_host: dataset.host,
      dataset_label: dataset.label,
    },
  }
}

/**
 * PURE. Stable identity for one (permit, lead) pair.
 *
 * When the portal exposes a permit number we key on it. When it does NOT, we key on the normalized
 * address plus the dataset — coarser on purpose: without a permit number we cannot tell two permits
 * at one address apart, and collapsing them is the safe error (one signal instead of two) where
 * splitting them would re-file the same permit every single day forever.
 */
export function permitDedupeKey(match: PermitMatch, dataset: SocrataDatasetSpec): string {
  const tail = match.permitId ? `p:${match.permitId}` : `a:${match.addressKey}`
  return `${dataset.datasetId}|${tail}|${match.leadId}`
}

// ─────────────────────────────────────────────────────────────────────────────
// DB — the ingest
// ─────────────────────────────────────────────────────────────────────────────

export interface PermitScanTerritory {
  brokerage_id: string | null
  city?: string | null
  state?: string | null
}

export interface PermitIngestResult {
  brokerageId: string
  marketsConsidered: number
  datasetsQueried: number
  /** Registered permit datasets that carry no `dateColumn`, so recentPermits cannot bound them. */
  datasetsSkippedNoDateColumn: number
  /** Territories whose (state, city) is not in socrata-market-registry MARKETS at all. */
  marketsUnregistered: number
  permitsFetched: number
  skippedNoAddress: number
  skippedNoLeadMatch: number
  alreadyRecorded: number
  signalsWritten: number
  /** Every refusal, verbatim. A run with errors NEVER reports a clean success. */
  errors: string[]
}

/** Minimal client surface — accepts the SSR or service supabase client without importing either. */
type SupabaseLike = { from: (table: string) => any }

const MAX_PERMITS_PER_DATASET = 1000
const MAX_LEADS_PER_BROKERAGE = 5000
const MAX_SIGNALS_PER_RUN = 500

/**
 * Run the permit scan for ONE brokerage across its configured territories and file the matches into
 * `motivated_seller_signals`.
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
    datasetsSkippedNoDateColumn: 0,
    marketsUnregistered: 0,
    permitsFetched: 0,
    skippedNoAddress: 0,
    skippedNoLeadMatch: 0,
    alreadyRecorded: 0,
    signalsWritten: 0,
    errors: [],
  }

  // ── 1. Which registered permit datasets do this tenant's territories map to? ──
  const datasets: SocrataDatasetSpec[] = []
  const seen = new Set<string>()
  for (const t of territories) {
    result.marketsConsidered++
    const specs = getMarketDatasets({ state: t.state, city: t.city })
    if (specs.length === 0) { result.marketsUnregistered++; continue }
    for (const spec of specs) {
      if (spec.kind !== "permits") continue
      if (!spec.dateColumn) {
        // recentPermits filters and orders BY that column. Without one we cannot bound the query
        // to "recent", and pulling a whole historical dataset every day is not a cadence. Counted
        // and reported so the registry gap is visible instead of looking like an empty market.
        result.datasetsSkippedNoDateColumn++
        continue
      }
      const id = `${spec.host}/${spec.datasetId}`
      if (seen.has(id)) continue
      seen.add(id)
      datasets.push(spec)
    }
  }
  if (datasets.length === 0) return result

  // ── 2. The tenant's own leads (the ONLY things a permit may attach to) ──
  const { data: leadRows, error: leadsError } = await supabase
    .from("leads")
    .select("id, address")
    .eq("brokerage_id", brokerageId)
    .not("address", "is", null)
    .limit(MAX_LEADS_PER_BROKERAGE)
  if (leadsError) {
    result.errors.push(`leads read refused: ${leadsError.message}`)
    return result
  }
  const leads = (leadRows ?? []) as MatchableLead[]
  if (leads.length === 0) return result

  // ── 3. Already-filed permit signals for this tenant (idempotency) ──
  const { data: existingRows, error: existingError } = await supabase
    .from("motivated_seller_signals")
    .select("signal_details")
    .eq("brokerage_id", brokerageId)
    .eq("signal_type", PERMIT_SIGNAL_TYPE)
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
    const res = await recentPermits<Record<string, unknown>>({
      host: dataset.host,
      datasetId: dataset.datasetId,
      sinceIso,
      permitDateColumn: dataset.dateColumn as string,
      limit: MAX_PERMITS_PER_DATASET,
    })
    if (!res.ok) {
      result.errors.push(`${dataset.label} (${dataset.host}/${dataset.datasetId}): ${res.error ?? "socrata refused"}`)
      continue
    }
    result.permitsFetched += res.data.length

    const outcome = matchPermitsToLeads(res.data, leads)
    result.skippedNoAddress += outcome.skippedNoAddress
    result.skippedNoLeadMatch += outcome.skippedNoLeadMatch

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
  const { data: inserted, error: insertError } = await supabase
    .from("motivated_seller_signals")
    .insert(toWrite)
    .select("id")

  if (!insertError) {
    result.signalsWritten = (inserted ?? []).length
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
    if (!oneError) { if (one) result.signalsWritten++; continue }
    if ((oneError as { code?: string }).code === "23505") { result.alreadyRecorded++; continue }
    result.errors.push(`motivated_seller_signals insert refused: ${oneError.message}`)
  }
  return result
}
