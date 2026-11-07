/**
 * lib/buyer-search/explanation-evidence.ts — CONTRACT C18, EXPLANATION EVIDENCE (wave 148, lane 148E).
 *
 * Owner (2026-11-01): "you need to be more helpful — if they need walkability or how far it is to commute or yard
 * size or quiet setting, those can have more info like a map; outdoor space is a home with acreage; quiet setting is
 * not close to neighbors. The answers need to be a helping neighbor and more personable so that they want to meet
 * with an agent. The AI is the first line of defense and how the answers are given will be a reflection on that
 * agent's business." And: "buyer search is either on in-house listings or outside properties using RentCast or the
 * tenant's IDX/MLS provider."
 *
 * THE RULE THIS MODULE HOLDS: the warm voice lives in the PROMPT and the composer; the FACTS live here. Every
 * buyer-facing claim carries { claim, evidence_source, confidence, unknown? } — and a map, a route, a distance or a
 * drive time is rendered ONLY with the provider evidence that produced it. A claim with no evidence is an UNKNOWN,
 * said as unknown, never a soft guess.
 *
 *   evidence_source   listing           — the brokerage's own listing row, or the MLS row the tenant's IDX feed returned
 *                     public_record     — an assessor / county record (reserved: no buyer path reads one today)
 *                     agent_remarks     — the listing agent's own description, ATTRIBUTED, never restated as verified
 *                     provider:rentcast — RentCast property data: NOT a verified active listing (owner ruling 8)
 *                     provider:mapbox   — a routed drive / walk / cycle time and distance (Matrix / Directions)
 *                     provider:osm      — OpenStreetMap places, buildings and roads (keyless Overpass / Nominatim)
 *                     provider:geoapify — Geoapify places (OSM-derived, keyed; the concierge POI lane)
 *
 * PURE and CLIENT-SAFE (no server import): the portal renders the source label from it, the search engine and the
 * "why this home?" door build claims with it, the model-draft validators and scripts/buyer-explanation-guard.ts read
 * it. FAIR HOUSING (owner scope): this is what WE say about a home to a buyer — the recommendation path — so it
 * describes buildings, roads, places and lots, never people; schools-by-quality, safety and "who lives here" are not
 * evidence kinds and cannot be claimed.
 */
import type { CriteriaFit, FitItem } from "./explanation-generator"
import type { LifestyleAsk } from "./conversation-criteria"
import type { SavedHomeOrigin } from "./search-engine"

export const EVIDENCE_SOURCES = [
  "listing", "public_record", "agent_remarks", "provider:rentcast", "provider:mapbox", "provider:osm", "provider:geoapify",
] as const
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number]

export type ClaimConfidence = "high" | "medium" | "low"

export type ClaimTopic =
  | "listing_source" | "price" | "size" | "location" | "property_type" | "feature" | "deal_breaker"
  | "commute" | "walkability" | "outdoor_space" | "quiet_setting" | "natural_light" | "layout" | "accessibility"

/** A map is evidence-bound: it exists only beside the provider answer that produced it. */
export interface MapEvidence {
  kind: "route" | "places"
  image_url: string
  attribution: string
  /** Which provider drew the picture (Mapbox first, Google Maps the fallback — the ONE map_render route). */
  renderer: "mapbox" | "google_maps"
  /** Which provider produced the FACTS the picture shows (a route → provider:mapbox; pins → provider:osm). */
  evidence_source: Extract<EvidenceSource, "provider:mapbox" | "provider:osm" | "provider:geoapify">
  from: { lat: number; lon: number; label: string }
  to: { lat: number; lon: number; label: string } | null
  /** Route maps only — the figures the picture stands for. */
  minutes?: number | null
  meters?: number | null
  profile?: string | null
  assumption?: string | null
  observed_at: string
}

/** The evidence a fit item carries when something other than the listing row answered it. */
export interface FitEvidence {
  source: EvidenceSource
  confidence: ClaimConfidence
  figures?: Record<string, number>
  observed_at?: string | null
  caveat?: string | null
  map?: MapEvidence | null
}

export interface ExplanationClaim {
  claim: string
  topic: ClaimTopic
  verdict: "match" | "miss" | "unknown" | "fact"
  /** null ONLY when `unknown` is true. */
  evidence_source: EvidenceSource | null
  confidence: ClaimConfidence
  unknown?: true
  figures?: Record<string, number>
  observed_at?: string | null
  caveat?: string | null
  map?: MapEvidence | null
}

// ─── The three sources, labelled for what they are (owner ruling 8) ─────────────────────────────

/** PURE. An http(s) URL predicate shared by the engine's photo rule and the portal read model (lib/portal/saved-homes.ts). */
export const isHttpUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//.test(u)

/**
 * PURE. A search row's display photo — the engine's half of the photo rule (the portal half is the owner-upload gate in
 * lib/portal/saved-homes.ts). Owner R9/R11 (2026-11-06): RentCast carries a listing's FACTS, never its photos; only a row
 * the tenant's IDX/MLS feed licensed may show one. Lives beside `describeListingSource` because the source rule and the
 * photo rule are one ruling (wave 150 integrator move from lib/buyer-search/search-engine.ts, which imports it back).
 */
export function licensedResultPhotoUrl(source: string | null | undefined, url: string | null | undefined): string | null {
  return source === "idx" && isHttpUrl(url) ? url : null
}

export type ListingSourceKind = "in_house" | "idx" | "rentcast"

export interface ListingSourceLabel {
  kind: ListingSourceKind
  /** One line the buyer reads beside the home. */
  label: string
  /** Is this a listing an MLS or the brokerage itself reports as active? RentCast property data is NOT. */
  verified_active_listing: boolean
  caveat: string | null
  evidence_source: EvidenceSource
}

/**
 * PURE. What a result's source IS, in the buyer's words. `platform` rows are the brokerage's OWN listings (the search
 * engine bounds them to the contact's tenant); `idx` rows are the MLS through the tenant's IDX feed; `rentcast` rows are
 * a property-data service's view — "a home RentCast shows as for sale", never "an active listing".
 */
export function describeListingSource(source: string | null | undefined, opts: { brokerageName?: string | null; mlsName?: string | null } = {}): ListingSourceLabel {
  const brokerage = opts.brokerageName?.trim()
  // Wave 150 (lane 150W, owner ruling 2026-11-06): a RentCast /listings/sale row carries the originating MLS's own name
  // (`mlsName`) — that MLS is shown as the SOURCE of the listing and RentCast as the carrier of its facts. Still not a
  // verified active listing (the agent confirms), and never a photo (RentCast's schema has no photo field).
  const mls = opts.mlsName?.trim()
  if (source === "rentcast") {
    return {
      kind: "rentcast",
      label: mls ? `Listed on ${mls} · facts via RentCast — not yet confirmed active by your agent` : "From RentCast property data — not a verified active listing",
      verified_active_listing: false,
      caveat: "RentCast gathers public property records and listing data from many places, so a home can show as for sale after it has gone under contract. Your agent will confirm it's really available before you plan a visit.",
      evidence_source: "provider:rentcast",
    }
  }
  if (source === "idx") {
    return {
      kind: "idx",
      label: "From the MLS through your agent's IDX feed",
      verified_active_listing: true,
      caveat: "Status is as the MLS feed reports it today; your agent confirms showings.",
      evidence_source: "listing",
    }
  }
  return {
    kind: "in_house",
    label: brokerage ? `One of ${brokerage}'s own listings` : "One of our own listings",
    verified_active_listing: true,
    caveat: null,
    evidence_source: "listing",
  }
}

// ─── Units the buyer reads (US: feet, miles, acres) ──────────────────────────────────────────────

export const SQFT_PER_ACRE = 43_560
const METERS_PER_MILE = 1609.344
const FEET_PER_METER = 3.28084

/** PURE. "about 450 ft" under a tenth of a mile, else "about 0.4 mi". */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return "an unknown distance"
  const miles = meters / METERS_PER_MILE
  if (miles < 0.1) return `about ${Math.max(10, Math.round((meters * FEET_PER_METER) / 10) * 10)} ft`
  return `about ${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`
}

/** PURE. Acres to two significant places ("0.18 acre", "1.4 acres", "12 acres"). */
export function formatAcres(acres: number): string {
  const v = acres >= 10 ? Math.round(acres).toString() : acres >= 1 ? acres.toFixed(1).replace(/\.0$/, "") : acres.toFixed(2)
  return `${v} ${Number(v) === 1 || acres < 1 ? "acre" : "acres"}`
}

// ─── C27 — THE BUYER-STATED LOT MINIMUM (wave 149, lane 149B, owner ruling 5) ─────────────────────
//
// Owner: "The buyer decides the yard and acreage minimum. AI clarifies, never invents a minimum." A minimum exists
// ONLY when the buyer said one, in their unit, with their words kept; the AI may ask what they mean and may convert
// units, and nothing else. No platform-default bar ("1 acre is acreage", "0.25 acre is roomy") decides a fit.

// Wave 150 (lane 150W, §6 one vocabulary): the buyer's unit is spelled EXACTLY as a listing states its own lot
// (`listings.lot_size_unit` CHECK: 'acres' | 'square_feet', m954), so the buyer's minimum and the home's lot are read in
// one vocabulary and a scorer can never miss a match across two spellings. The pre-150 spelling 'sqft' is read once on
// the way in (readLotMinimum) — 0 stored rows carried it live (2026-11-06); the reader only guards a stale session.
export const LOT_UNITS = ["acres", "square_feet"] as const
export type LotUnit = (typeof LOT_UNITS)[number]

export interface LotMinimum {
  value: number
  unit: LotUnit
  /** Always the buyer — the type admits nothing else, and validLotMinimum refuses anything else at runtime. */
  stated_by: "buyer"
  /** The buyer's own words the value was read from ("at least half an acre"). */
  literal: string
  /** high = a number and a unit, plainly; low = hedged ("about an acre or so") — worth a gentle confirm. */
  confidence: "high" | "low"
}

/** PURE. The contract check (C27): a minimum is the buyer's, positive, in a known unit, with their words. */
export function validLotMinimum(v: unknown): v is LotMinimum {
  const m = v as Partial<LotMinimum> | null | undefined
  return !!m && m.stated_by === "buyer" && typeof m.value === "number" && Number.isFinite(m.value) && m.value > 0
    && (LOT_UNITS as readonly string[]).includes(String(m.unit)) && typeof m.literal === "string" && m.literal.trim().length > 0
    && (m.confidence === "high" || m.confidence === "low")
}

/** PURE. A stored minimum read in the one vocabulary (the retired 'sqft' spelling becomes 'square_feet'); null if invalid. */
export function readLotMinimum(v: unknown): LotMinimum | null {
  const m = v as (Omit<Partial<LotMinimum>, "unit"> & { unit?: string }) | null | undefined
  const fixed = m && m.unit === "sqft" ? { ...m, unit: "square_feet" } : m
  return validLotMinimum(fixed) ? fixed : null
}

/** PURE. The minimum in acres (conversion is allowed; inventing is not). */
export function lotMinimumAcres(m: LotMinimum): number {
  return m.unit === "acres" ? m.value : m.value / SQFT_PER_ACRE
}

/** PURE. The minimum said back in the BUYER's unit ("2 acres", "10,000 sq ft"). */
export function formatLotMinimum(m: LotMinimum): string {
  return m.unit === "acres" ? formatAcres(m.value) : `${Math.round(m.value).toLocaleString("en-US")} sq ft`
}

export interface LotFacts {
  acres: number | null
  sqft: number | null
  /** reported_sqft = the source said square feet (RentCast lotSize); inferred_from_magnitude = the listing row has no unit and the value can only be one; unknown_unit = it could be either. */
  basis: "reported_sqft" | "reported_acres" | "inferred_from_magnitude" | "unknown_unit"
  raw: number
  source: EvidenceSource
}

/**
 * PURE. The lot in acres, from the source's own number. RentCast reports SQUARE FEET. The listings row
 * (`listings.lot_size`, m206) records NO unit, so a value is read as acres only when it cannot be square feet
 * (≤ 50 — no lot is 50 sq ft) and as square feet only when it cannot be acres (≥ 2,000 — not a residential listing's
 * acreage); anything between is an UNKNOWN UNIT and is said as such, never converted on a guess.
 * Wave 149Z (lane 149J B1, m954 APPLIED LIVE): `listings.lot_size_unit` ('square_feet' | 'acres', never inferred — the
 * listing edit action writes it only beside the size it describes) is read FIRST: a stated unit is the record's own fact,
 * so the magnitude rule applies only to a row that states none. Unknown stays unknown.
 */
export function lotFactsFrom(input: { lotSizeSqft?: number | null; lotSize?: number | null; lotSizeUnit?: string | null; source: EvidenceSource }): LotFacts | null {
  if (typeof input.lotSizeSqft === "number" && input.lotSizeSqft > 0) {
    return { acres: input.lotSizeSqft / SQFT_PER_ACRE, sqft: input.lotSizeSqft, basis: "reported_sqft", raw: input.lotSizeSqft, source: input.source }
  }
  const raw = typeof input.lotSize === "number" ? input.lotSize : input.lotSize != null ? Number(input.lotSize) : NaN
  if (!(raw > 0)) return null
  if (input.lotSizeUnit === "acres") return { acres: raw, sqft: Math.round(raw * SQFT_PER_ACRE), basis: "reported_acres", raw, source: input.source }
  if (input.lotSizeUnit === "square_feet") return { acres: raw / SQFT_PER_ACRE, sqft: raw, basis: "reported_sqft", raw, source: input.source }
  if (raw <= 50) return { acres: raw, sqft: Math.round(raw * SQFT_PER_ACRE), basis: "inferred_from_magnitude", raw, source: input.source }
  if (raw >= 2000) return { acres: raw / SQFT_PER_ACRE, sqft: raw, basis: "inferred_from_magnitude", raw, source: input.source }
  return { acres: null, sqft: null, basis: "unknown_unit", raw, source: input.source }
}

// ─── Location evidence a home can carry (gathered by ./location-evidence.ts, server-side) ─────────

export type AmenityKind = "park" | "grocery" | "cafe_restaurant" | "transit"

export interface PlaceEvidence { name: string; kind: AmenityKind; meters: number; lat?: number; lon?: number }

export interface TravelEvidence {
  /** The buyer's own words for the place ("Plano Medical Center"). */
  target: string
  /** What we measured to, as the geocoder placed it — shown so the buyer can see what was measured. */
  placeLabel: string
  to: { lat: number; lon: number }
  profile: string
  minutes: number | null
  meters: number | null
  assumption: string
  observed_at: string
  map: MapEvidence | null
  note?: string | null
}

export interface HomeLocationEvidence {
  home: { lat: number; lon: number; source: EvidenceSource } | null
  travel: TravelEvidence[]
  amenities: { source: Extract<EvidenceSource, "provider:osm" | "provider:geoapify">; observed_at: string; places: PlaceEvidence[]; map: MapEvidence | null } | null
  surroundings: {
    source: "provider:osm"
    observed_at: string
    nearestOtherBuildingMeters: number | null
    buildingsWithin100m: number
    nearestMajorRoad: { meters: number; name: string | null; kind: string } | null
    nearestRailMeters: number | null
  } | null
  /** Why something could not be measured (no coordinates, provider unconfigured, gate refused …). */
  notes: string[]
}

// ─── Fit → claims (the C18 shape every result carries) ───────────────────────────────────────────

const TOPIC_BY_FIELD: Record<string, ClaimTopic> = {
  maxPrice: "price", minPrice: "price", minBeds: "size", minBaths: "size", cities: "location", zipCodes: "location",
  propertyTypes: "property_type", mustHaveFeatures: "feature", dealBreakers: "deal_breaker", listingType: "price",
  "lifestyle:commute": "commute", "lifestyle:nearby_amenity": "walkability", "lifestyle:outdoor_space": "outdoor_space",
  "lifestyle:quiet_setting": "quiet_setting", "lifestyle:natural_light": "natural_light", "lifestyle:layout": "layout",
  "lifestyle:accessibility": "accessibility",
}

function claimOf(item: FitItem, verdict: ExplanationClaim["verdict"], kind: ListingSourceKind): ExplanationClaim {
  const topic = TOPIC_BY_FIELD[item.field as string] ?? "feature"
  const claim = `${item.ask} — ${item.detail}`
  if (verdict === "unknown") return { claim, topic, verdict, evidence_source: null, confidence: "low", unknown: true }
  if (item.evidence) {
    return {
      claim, topic, verdict, evidence_source: item.evidence.source, confidence: item.evidence.confidence,
      ...(item.evidence.figures ? { figures: item.evidence.figures } : {}),
      observed_at: item.evidence.observed_at ?? null, caveat: item.evidence.caveat ?? null, map: item.evidence.map ?? null,
    }
  }
  if (item.source === "listing_remarks") return { claim, topic, verdict, evidence_source: "agent_remarks", confidence: "medium", caveat: "the listing agent's own description, not an inspection" }
  // A listing-row fact: the brokerage's / the MLS's row is high confidence; a RentCast row is a property-data
  // service's view (medium — and labelled so).
  return kind === "rentcast"
    ? { claim, topic, verdict, evidence_source: "provider:rentcast", confidence: "medium", caveat: "RentCast property data — your agent confirms it" }
    : { claim, topic, verdict, evidence_source: "listing", confidence: "high" }
}

/** PURE. Every fit item as a C18 claim, the source label first. Unknowns stay unknowns. */
export function claimsFromFit(fit: CriteriaFit, source: ListingSourceLabel): ExplanationClaim[] {
  const out: ExplanationClaim[] = [{
    claim: source.label, topic: "listing_source", verdict: "fact", evidence_source: source.evidence_source,
    confidence: source.verified_active_listing ? "high" : "medium", caveat: source.caveat,
  }]
  for (const m of fit.matches) out.push(claimOf(m, "match", source.kind))
  for (const m of fit.misses) out.push(claimOf(m, "miss", source.kind))
  for (const u of fit.unknowns) out.push(claimOf(u, "unknown", source.kind))
  // C27 (wave 149): a measured fact the buyer has not given a bar for (the lot, with no stated minimum) — evidence-backed,
  // no verdict. The verdict is the buyer's to give.
  for (const f of fit.facts ?? []) out.push(claimOf(f, "fact", source.kind))
  return out
}

/**
 * PURE. The contract check: every claim names its evidence or says it is unknown; an unknown carries no figures; a
 * map appears only with the evidence that drew it (a route map needs the routed minutes and both ends).
 */
export function validateClaims(claims: ExplanationClaim[]): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  const known = new Set<string>(EVIDENCE_SOURCES)
  claims.forEach((c, i) => {
    const at = `claim ${i + 1} (${c.topic})`
    if (c.unknown) {
      if (c.evidence_source !== null) problems.push(`${at}: unknown but names evidence`)
      if (c.figures && Object.keys(c.figures).length) problems.push(`${at}: unknown but states figures`)
      if (c.map) problems.push(`${at}: unknown but carries a map`)
      return
    }
    if (!c.evidence_source) problems.push(`${at}: a claim with no evidence source`)
    else if (!known.has(c.evidence_source)) problems.push(`${at}: unknown evidence source "${c.evidence_source}"`)
    if (c.map) {
      const m = c.map
      if (!m.image_url || !m.observed_at) problems.push(`${at}: map without its evidence`)
      if (m.kind === "route" && (m.evidence_source !== "provider:mapbox" || m.minutes == null || !m.to)) problems.push(`${at}: route map without a routed time and both ends`)
      if (m.kind === "places" && m.evidence_source === "provider:mapbox") problems.push(`${at}: places map attributed to the router`)
    }
  })
  return { ok: problems.length === 0, problems }
}

// ─── Model-draft guards: no invented place, a warm and helpful voice ─────────────────────────────

/** Amenity words a draft could use to imply a place exists nearby. Schools / worship are not evidence kinds at all. */
// ("market" and "dining" are deliberately absent: "on the market" and "dining room" are home words, not places.)
const AMENITY_WORD = /\b(parks?|trails?|greenbelts?|playgrounds?|grocery|groceries|supermarkets?|coffee shops?|caf[eé]s?|restaurants?|bakery|shops|shopping|mall|gyms?|transit|bus stops?|train|station|light rail|beach|lake|hospital|schools?|church(?:es)?|synagogues?|mosques?|temples?)\b/gi

/** Capitalised names a draft may use without them appearing in the facts (vendors we cite, the pronoun I). */
const ALLOWED_PROPER = new Set(["i", "mapbox", "openstreetmap", "rentcast", "mls", "idx", "hoa", "google", "maps"])

/**
 * PURE. The places / amenities a draft names that the facts do not hold — an INVENTED amenity. Two checks:
 * (1) every amenity word in the draft must appear in the facts (a "short walk to the park" needs a park in the
 * evidence); (2) every capitalised name that is not a sentence opener must appear in the facts ("Riverside Park",
 * "Whole Foods"). Returns the offending phrases; [] = grounded.
 */
export function inventedPlaces(draft: string, facts: string): string[] {
  const f = facts.toLowerCase()
  const bad = new Set<string>()
  for (const m of draft.matchAll(AMENITY_WORD)) {
    const w = m[0].toLowerCase()
    const stem = /ies$/.test(w) ? w.replace(/ies$/, "y") : /(?:s|sh|ch|x)es$/.test(w) ? w.replace(/es$/, "") : w.replace(/s$/, "")
    if (!f.includes(stem)) bad.add(m[0])
  }
  // Capitalised runs not at a sentence start: "… near Riverside Park" / "… by Whole Foods".
  const re = /(?<![.!?]\s|^)(?<=\s|\()((?:[A-Z][a-zA-Z'’.-]+)(?:\s+(?:[A-Z][a-zA-Z'’.-]+|of|the|and|&))*)/g
  for (const m of draft.matchAll(re)) {
    const phrase = m[1].replace(/[.,;:]+$/, "").trim()
    const words = phrase.split(/\s+/).filter((w) => /^[A-Z]/.test(w))
    if (words.every((w) => ALLOWED_PROPER.has(w.toLowerCase().replace(/['’]s$/, "")))) continue
    if (!f.includes(phrase.toLowerCase())) bad.add(phrase)
  }
  return [...bad]
}

const PRESSURE = /\b(act (?:now|fast)|won'?t last|hurry|don'?t miss|today only|must[- ]see|before it'?s gone|limited time|once in a lifetime|grab it|snap (?:it|this) up)\b/i
const ROBOTIC = /\b(score[ds]?|algorithm|artificial intelligence|our system|the system|data feed|matching engine|criteria matched|percent match|\d+\s?% match|as an ai)\b/i
const ACKNOWLEDGES = /\b(you (?:told|asked|said|mentioned|wanted|shared)|what you(?:'re| are) (?:looking for|after)|matters? (?:most )?to you|you'd (?:like|love|want))\b/i
const GENTLE_OFFER = /\b(happy to|glad to|would you like|want me to|i can (?:set up|arrange|ask)|i'd be happy|love to show|just say the word)\b/i

/**
 * PURE. THE WARM-VOICE RUBRIC (owner: "a helping neighbor and more personable so that they want to meet with an
 * agent … be kind and neighborly"). A buyer-facing explanation passes when it speaks TO the buyer, shows it heard
 * them, says something specific, asks one gentle question, offers the agent without pressure, and never sounds like
 * a machine or a salesperson. Used to gate a model draft (conversational-search.ts narrateFitExplanation) and by
 * scripts/buyer-explanation-guard.ts on every deterministic composition.
 */
export function warmVoiceRubric(text: string, opts: { agentName?: string | null } = {}): { pass: boolean; failures: string[] } {
  const t = (text ?? "").trim()
  const failures: string[] = []
  const words = t.split(/\s+/).filter(Boolean).length
  if (!/\byou(?:r|'re|'ll|'d)?\b/i.test(t)) failures.push("does not speak to the buyer (no 'you')")
  if (!ACKNOWLEDGES.test(t)) failures.push("does not show it heard what the buyer said")
  if (!/\d/.test(t)) failures.push("says nothing specific (no figure)")
  const q = (t.match(/\?/g) ?? []).length
  if (q < 1) failures.push("asks no follow-up question")
  if (q > 2) failures.push("asks too many questions")
  const agent = opts.agentName?.trim()
  const namesAgent = /\bagent\b/i.test(t) || (!!agent && new RegExp(`\\b${agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t))
  if (!namesAgent || !GENTLE_OFFER.test(t)) failures.push("no gentle offer to connect with the agent")
  if (PRESSURE.test(t)) failures.push("pressure or urgency language")
  if (ROBOTIC.test(t)) failures.push("sounds like a machine (internal words)")
  if (/!/.test(t)) failures.push("exclamation marks")
  if (words < 25) failures.push("too thin to be helpful")
  if (words > 190) failures.push("too long for a quick read")
  return { pass: failures.length === 0, failures }
}

// ═════════════════════════════════════════════════════════════════════════════
// STATED HARD CONSTRAINTS (wave 150, lane 150W, canary 7; folded in from lib/buyer-search/buyer-constraints.ts by the
// integrator beside the lot-minimum evidence it is built on — test:proxy-graph-budget; the search engine is its caller). Original module header follows.
// /**
//  * lib/buyer-search/buyer-constraints.ts — THE BUYER'S OWN MUST-HAVES, HELD (wave 150, lane 150W — directive canary 7,
//  * contracts C27 + C18).
//  *
//  * Directive canary 7: "One buyer requesting a 2-acre minimum and a 25-minute commute receives only licensed active
//  * options with the stated constraints, or a helpful shortage explanation."
//  *
//  * A HARD constraint exists only when the BUYER stated a number for it (never a platform bar — C27):
//  *   · lot minimum — `LifestyleAsk.lotMinimum` (stated_by buyer, in the buyer's own unit, the `lot_size_unit` vocabulary)
//  *   · commute     — a commute ask with a named place AND a stated maximum (`maxMinutes`)
//  * An option is OFFERED only when (1) it comes from a licensed source and is reported ACTIVE — the tenant's own listing,
//  * the tenant's IDX/MLS feed, or a RentCast /listings/sale row whose status is Active (labelled, never photographed); a
//  * home a buyer pasted from a link is their own find, kept in their saved homes and never offered back as a match — and
//  * (2) the explanation already PROVED each stated constraint met (a C18 `match` carrying its evidence figures). A miss is
//  * left out; an UNKNOWN (no lot size published, a drive not measured yet) is left out too and COUNTED, so the buyer hears
//  * how many homes could not be judged rather than being shown a guess.
//  *
//  * When nothing qualifies, the answer is a SHORTAGE EXPLANATION built only from the measured figures: how many active
//  * homes were looked at, how many failed which must-have, the nearest misses, and what would change if the buyer chose
//  * to bend one — the buyer decides; we never relax a constraint for them. Care-first, plain, no pressure (R10).
//  */

export type ConstraintField = "lifestyle:outdoor_space" | "lifestyle:commute"

export interface StatedConstraint {
  field: ConstraintField
  /** The bar said back in the buyer's own words/unit ("2 acres", "25 minutes to Fort Hood"). */
  said: string
  /** The bar in the unit the evidence is measured in (acres / minutes). */
  bar: number
}

/** PURE. The buyer's HARD constraints — only what they stated with a number. */
export function statedHardConstraints(lifestyle: readonly LifestyleAsk[] | null | undefined): StatedConstraint[] {
  const out: StatedConstraint[] = []
  for (const ask of lifestyle ?? []) {
    if (ask.kind === "outdoor_space" && ask.direction !== "less") {
      const min = readLotMinimum(ask.lotMinimum)
      if (min && !out.some((c) => c.field === "lifestyle:outdoor_space")) out.push({ field: "lifestyle:outdoor_space", said: formatLotMinimum(min), bar: lotMinimumAcres(min) })
    }
    if (ask.kind === "commute" && ask.target && typeof ask.maxMinutes === "number" && ask.maxMinutes > 0 && !out.some((c) => c.field === "lifestyle:commute")) {
      out.push({ field: "lifestyle:commute", said: `${ask.maxMinutes} minutes to ${ask.target}`, bar: ask.maxMinutes })
    }
  }
  return out
}

/** Where a candidate came from — THE saved-home origin vocabulary (lib/portal/saved-homes.ts SAVED_HOME_ORIGINS; §6). */
export type CandidateOrigin = SavedHomeOrigin

export interface ConstraintCandidate {
  ref: string
  label: string
  origin: CandidateOrigin
  /** The status as the source reports it ("active", "Active", "pending" …); null = unknown, never upgraded. */
  status: string | null
  fit: CriteriaFit | null
}

/** PURE. Licensed AND reported active. A buyer's pasted link and a manual row are never offered as matches. */
function isLicensedActive(c: Pick<ConstraintCandidate, "origin" | "status">): boolean {
  if (c.origin !== "tenant_listing" && c.origin !== "idx_mls" && c.origin !== "rentcast_listing") return false
  return String(c.status ?? "").trim().toLowerCase() === "active"
}

type Verdict = { state: "met" | "missed" | "unknown"; figure: number | null }

function verdictOf(fit: CriteriaFit | null, field: ConstraintField): Verdict {
  const fig = (i: FitItem | undefined) => {
    const f = i?.evidence?.figures
    if (!f) return null
    const v = field === "lifestyle:commute" ? f.minutes : f.acres
    return typeof v === "number" && Number.isFinite(v) ? v : null
  }
  const m = fit?.matches.find((i) => i.field === field)
  if (m) return { state: fig(m) != null ? "met" : "unknown", figure: fig(m) } // a match with no measured figure is not proof
  const x = fit?.misses.find((i) => i.field === field)
  if (x) return { state: "missed", figure: fig(x) }
  const f = [...(fit?.unknowns ?? []), ...(fit?.facts ?? [])].find((i) => i.field === field)
  return { state: "unknown", figure: fig(f) }
}

export interface ConstraintAnswer {
  constraints: StatedConstraint[]
  /** Refs of the options that meet every stated constraint, licensed and active — the only ones shown. */
  options: string[]
  counts: { looked: number; notLicensedActive: number; meetsAll: number; missed: Record<ConstraintField, number>; unknown: Record<ConstraintField, number> }
  /** null when at least one option qualifies. */
  shortage: { headline: string; lines: string[]; ideas: string[]; transparency: string } | null
}

const NOUN: Record<ConstraintField, string> = { "lifestyle:outdoor_space": "land", "lifestyle:commute": "drive" }

/**
 * PURE. Hold the buyer's stated must-haves over a page of candidates. With no stated constraint every licensed active
 * candidate passes (nothing to hold) and `shortage` stays null.
 */
export function answerStatedConstraints(candidates: readonly ConstraintCandidate[], constraints: readonly StatedConstraint[]): ConstraintAnswer {
  const fields = constraints.map((c) => c.field)
  const missed = { "lifestyle:outdoor_space": 0, "lifestyle:commute": 0 } as Record<ConstraintField, number>
  const unknown = { "lifestyle:outdoor_space": 0, "lifestyle:commute": 0 } as Record<ConstraintField, number>
  const active = candidates.filter(isLicensedActive)
  const options: string[] = []
  // Nearest misses: a home that meets every OTHER constraint and misses this one by the smallest margin.
  const nearest: Partial<Record<ConstraintField, { figure: number; homes: number }>> = {}
  for (const c of active) {
    const vs = fields.map((f) => [f, verdictOf(c.fit, f)] as const)
    for (const [f, v] of vs) { if (v.state === "missed") missed[f]++; if (v.state === "unknown") unknown[f]++ }
    if (vs.every(([, v]) => v.state === "met")) { options.push(c.ref); continue }
    const failing = vs.filter(([, v]) => v.state !== "met")
    if (failing.length === 1 && failing[0][1].state === "missed" && failing[0][1].figure != null) {
      const [f, v] = failing[0]
      const prev = nearest[f]
      const fig = v.figure!
      const closer = !prev || (f === "lifestyle:commute" ? fig < prev.figure : fig > prev.figure)
      nearest[f] = closer ? { figure: fig, homes: 1 } : prev && prev.figure === fig ? { figure: fig, homes: prev.homes + 1 } : prev
    }
  }
  const counts = { looked: candidates.length, notLicensedActive: candidates.length - active.length, meetsAll: options.length, missed, unknown }
  if (fields.length === 0 || options.length > 0) return { constraints: [...constraints], options, counts, shortage: null }

  const said = constraints.map((c) => c.said)
  const both = said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}` : said[0]
  const lines: string[] = []
  lines.push(active.length === 0
    ? "I didn't see any active listings in this search to check against what you asked for."
    : `I checked ${active.length} active ${active.length === 1 ? "home" : "homes"} against ${both}.`)
  for (const c of constraints) {
    if (missed[c.field] > 0) lines.push(`${missed[c.field]} ${missed[c.field] === 1 ? "was" : "were"} measured and came up short on the ${NOUN[c.field]} (${c.said}).`)
    if (unknown[c.field] > 0) lines.push(c.field === "lifestyle:commute"
      ? `${unknown[c.field]} I couldn't measure the drive for yet — your agent can check those for you.`
      : `${unknown[c.field]} don't publish a lot size, so I can't tell — your agent can find out.`)
  }
  const ideas: string[] = []
  const lot = constraints.find((c) => c.field === "lifestyle:outdoor_space")
  const drive = constraints.find((c) => c.field === "lifestyle:commute")
  const nd = nearest["lifestyle:commute"]
  if (drive && nd) ideas.push(`If about ${Math.ceil(nd.figure)} minutes could work for you, ${nd.homes} ${nd.homes === 1 ? "home already has" : "homes already have"} the ${lot ? lot.said : "space"} you want.`)
  const nl = nearest["lifestyle:outdoor_space"]
  if (lot && nl) ideas.push(`If ${formatAcres(nl.figure)} could feel like enough, ${nl.homes} ${nl.homes === 1 ? "home is" : "homes are"} within your ${drive ? drive.said : "range"}.`)
  ideas.push("Or keep both exactly as they are — I'll keep watching and let you know the moment a home fits.")
  return {
    constraints: [...constraints], options, counts,
    shortage: {
      headline: `Nothing active fits ${both} right now — here's what I found.`,
      lines,
      ideas,
      transparency: "This comes from the listing data and measured drive times; homes that don't publish a lot size, or that I couldn't measure yet, are counted rather than guessed. Your choices stay yours — I won't loosen what you asked for.",
    },
  }
}
