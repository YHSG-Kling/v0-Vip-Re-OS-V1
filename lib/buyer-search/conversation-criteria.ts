/**
 * lib/buyer-search/conversation-criteria.ts
 *
 * SPOKEN CRITERIA → LIVING ALERT (pure half).
 *
 * When a buyer TELLS the AI what they want — on a reception/ISA call or in an
 * ISA thread — this module turns the conversation into structured alert
 * criteria by feeding the buyer's utterances through the EXISTING NL intent
 * parser (lib/buyer-search/intent-parser, round 63), merging multi-utterance
 * criteria in speaking order (later statements REFINE earlier ones: "under
 * 700" then "actually under 650" → 650), and mapping the result onto the real
 * property_alerts column shape.
 *
 * PURE: no I/O, no supabase — the voice sweep (lib/voice/call-analysis.ts)
 * and the text-thread listener (lib/buyer-search/written-criteria-alert.ts)
 * own the inserts and the approval queue owns activation. Proposals are
 * ALWAYS is_active=false — the agent approves; nothing self-activates.
 *
 * FAIR HOUSING — CAPTURE IS NOT STEERING (owner directive): a buyer may
 * lawfully ask to be "in the Mocksley school district" or for a "55+ /
 * age-restricted community" — those are the BUYER'S OWN stated criteria, and
 * honoring them is service, not steering. The NO-STEERING line is absolute
 * and it lives here: this extractor only ever captures what the BUYER SAID —
 * every captured criterion is backed by an evidence quote of their literal
 * words — and the OS never suggests, infers, or recommends demographic or
 * familial criteria in either direction. Familial-status INFERENCE stays
 * out: "good for kids" is the AI characterizing a home, not a buyer-stated
 * searchable criterion, and is never captured.
 */

import { parseNaturalLanguageQuery } from "./intent-parser"

// ─── Criteria shape ──────────────────────────────────────────────────────────

export interface ConversationCriteria {
  minPrice?: number
  maxPrice?: number
  /** Minimum bedrooms (property_alerts has bedrooms_min only — no max column). */
  minBeds?: number
  minBaths?: number
  propertyTypes?: string[]
  cities?: string[]
  /** Concrete feature words (pool, garage, …) → must_have_features. */
  features?: string[]
  /** BUYER-STATED school-district / school-zone phrases ("Mocksley school
   *  district", "Lincoln Elementary") → property_alerts.keywords. Captured
   *  only from the buyer's literal words — never inferred. */
  schoolDistricts?: string[]
  /** BUYER-STATED 55+/active-adult/age-restricted community request →
   *  must_have_features entry. Stated by the buyer, never suggested. */
  ageRestrictedCommunity?: boolean
}

export interface ExtractedConversationCriteria {
  criteria: ConversationCriteria
  /** 'high' needs ≥2 distinct CONCRETE signals (price / location / beds /
   *  baths / property type / stated school district / stated 55+ community).
   *  One signal alone is 'low' — not enough to propose an alert from. */
  confidence: "high" | "low"
  /** How many distinct concrete signal groups landed (features excluded). */
  signalCount: number
  /** The exact utterances the criteria came from — shown to the approving
   *  agent as "they said: …". */
  evidence: string[]
}

// ─── Utterance extraction ────────────────────────────────────────────────────

/** Speaker labels that mark the BUYER's side of a labeled transcript. */
const CALLER_LABEL = /^(caller|customer|buyer|lead|prospect)\s*:/i
/** Known speaker labels (either side) — presence means the transcript is
 *  labeled dialogue, not free text. Deliberately a closed list so an email
 *  line like "Budget: 400k" is never mistaken for a speaker. */
const ANY_LABEL = /^(caller|customer|buyer|lead|prospect|ai|agent|assistant|bot|rep|isa|speaker ?\d+)\s*:/i

/**
 * Split a transcript into the buyer's sentences, in speaking order.
 * Labeled transcripts ("Caller: …" / "AI: …") contribute ONLY the caller's
 * lines — what the AI suggested is never treated as the buyer's criteria.
 * Unlabeled text (an email/SMS body) is used whole.
 */
export function buyerUtterances(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const labeled = lines.some((l) => ANY_LABEL.test(l))
  const source = labeled
    ? lines.filter((l) => CALLER_LABEL.test(l)).map((l) => l.replace(CALLER_LABEL, "").trim())
    : [text.trim()]

  const sentences: string[] = []
  for (const u of source) {
    for (const part of u.split(/(?<=[.!?])\s+|;\s+/)) {
      const s = part.trim()
      if (s) sentences.push(s)
    }
  }
  return sentences
}

// ─── Supplemental city detection ─────────────────────────────────────────────
//
// The parser's city list is a fixed set of major metros; a buyer saying
// "in Mocksley" would otherwise carry no location signal. This picks up a
// capitalized place name after in/near/around — conservative on purpose
// (stopworded, capitalization-gated) because a wrong city only ever reaches a
// PROPOSED alert a human reviews.

const NOT_A_CITY = new Set([
  // pronouns / articles / fillers that start capitalized sentences
  "i", "the", "a", "an", "my", "our", "we", "it", "that", "this", "there",
  "and", "or", "but", "no", "yes", "ok", "okay", "general", "town", "case",
  // time words
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "monday", "tuesday",
  "wednesday", "thursday", "friday", "saturday", "sunday",
  // state names the parser handles separately (no state column on alerts)
  "texas", "california", "florida", "tx", "ca", "fl", "ny", "co", "wa", "or",
  "az", "ga", "nc", "tn", "nv", "ut",
])

export function detectSupplementalCity(sentence: string): string | null {
  const m = sentence.match(/\b(?:in|near|around)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)/)
  if (!m) return null
  const candidate = m[1].trim()
  const words = candidate.split(/\s+/)
  if (words.some((w) => NOT_A_CITY.has(w.toLowerCase()))) return null
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
}

// ─── Buyer-STATED school district / age-restricted community ────────────────
//
// NO-STEERING LINE (absolute): the extractor may CAPTURE a school district or
// 55+/age-restricted community only when the BUYER SAID it — their literal
// quote lands in evidence to prove it — and the OS never suggests, infers, or
// recommends demographic/familial criteria either way. Characterizations
// ("good for kids", "family-friendly") are NOT stated searchable criteria and
// are never captured: the patterns below require the buyer to name a
// district/school (proper noun) or an age-restricted community type.

/** Generic words that never start a real district/school name — blocks
 *  "Good school district" from capturing "Good" as a proper noun. */
const SCHOOL_NAME_STOPWORDS = new Set([
  "the", "a", "an", "good", "great", "best", "top", "better", "nice", "any",
  "that", "this", "some", "strong", "excellent",
])

/**
 * Capture a buyer-STATED school district or school zone:
 *   "in the Mocksley school district"      → "Mocksley school district"
 *   "zoned for Lincoln Elementary"         → "Lincoln Elementary"
 * Proper-noun-gated: "good schools" / "a good school district" return null —
 * quality adjectives are characterizations, not stated criteria.
 */
export function detectStatedSchoolDistrict(sentence: string): string | null {
  const district = sentence.match(/\b((?:[A-Z][A-Za-z'’.-]+\s+)*[A-Z][A-Za-z'’.-]+)\s+[Ss]chool [Dd]istrict\b/)
  if (district) {
    const words = district[1].split(/\s+/).filter((w) => !SCHOOL_NAME_STOPWORDS.has(w.toLowerCase()))
    if (words.length > 0) return `${words.join(" ")} school district`
  }
  const zoned = sentence.match(/\bzoned for\s+((?:[A-Z][A-Za-z'’.-]+\s+)+(?:Elementary|Middle|High)(?:\s+School)?)\b/)
  if (zoned) {
    const words = zoned[1].split(/\s+/).filter((w) => !SCHOOL_NAME_STOPWORDS.has(w.toLowerCase()))
    if (words.length > 1) return words.join(" ") // needs a name, not bare "Elementary"
  }
  return null
}

/** Canonical must_have_features entry for a buyer-stated 55+ request. */
export const AGE_RESTRICTED_LABEL = "55+ / age-restricted community"

/** Buyer-STATED age-restricted community request ("55+ community",
 *  "55-plus", "active adult", "age-restricted"). Age words about anything
 *  other than a community type do not match. */
export function detectStatedAgeRestrictedCommunity(sentence: string): boolean {
  return /(\b55\s*\+|\b55[-\s]plus\b|\bactive[-\s]adult\b|\bage[-\s]restricted\b)/i.test(sentence)
}

// ─── Extraction + merge ──────────────────────────────────────────────────────

function unionInto(target: string[] | undefined, add: string[]): string[] {
  const out = [...(target ?? [])]
  for (const v of add) if (!out.includes(v)) out.push(v)
  return out
}

/**
 * Run every buyer utterance through the intent parser and merge in speaking
 * order. Scalars (price/beds/baths) OVERWRITE — the later statement is the
 * refinement ("under 700" … "actually under 650" → 650). Lists (cities,
 * property types, features) UNION — an alert matching any named city serves
 * the buyer better than dropping one.
 */
export function extractCriteriaFromTranscript(text: string): ExtractedConversationCriteria {
  const criteria: ConversationCriteria = {}
  const evidence: string[] = []

  for (const sentence of buyerUtterances(text ?? "")) {
    const parsed = parseNaturalLanguageQuery(sentence)
    let contributed = false

    if (parsed.minPrice != null && Number.isFinite(parsed.minPrice)) { criteria.minPrice = parsed.minPrice; contributed = true }
    if (parsed.maxPrice != null && Number.isFinite(parsed.maxPrice)) { criteria.maxPrice = parsed.maxPrice; contributed = true }
    if (parsed.minBeds != null)  { criteria.minBeds  = parsed.minBeds;  contributed = true }
    if (parsed.minBaths != null) { criteria.minBaths = parsed.minBaths; contributed = true }
    if (parsed.propertyTypes?.length) { criteria.propertyTypes = unionInto(criteria.propertyTypes, parsed.propertyTypes); contributed = true }
    if (parsed.features?.length)      { criteria.features      = unionInto(criteria.features, parsed.features);           contributed = true }

    const cities = parsed.cities ?? []
    if (cities.length === 0) {
      const supplemental = detectSupplementalCity(sentence)
      if (supplemental) cities.push(supplemental)
    }
    if (cities.length > 0) { criteria.cities = unionInto(criteria.cities, cities); contributed = true }

    // Buyer-STATED school district / 55+ community — capture, never infer.
    // The contributing sentence lands in evidence: the quote IS the proof the
    // buyer asked (the no-steering line above).
    const school = detectStatedSchoolDistrict(sentence)
    if (school) { criteria.schoolDistricts = unionInto(criteria.schoolDistricts, [school]); contributed = true }
    if (detectStatedAgeRestrictedCommunity(sentence)) { criteria.ageRestrictedCommunity = true; contributed = true }

    if (contributed) evidence.push(sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence)
  }

  // A dropped min above a refined max ("300-400" … "under 350" is fine, but a
  // later "under 250" would leave min 300 > max 250) — the refinement wins.
  if (criteria.minPrice != null && criteria.maxPrice != null && criteria.minPrice > criteria.maxPrice) {
    delete criteria.minPrice
  }

  let signalCount = 0
  if (criteria.minPrice != null || criteria.maxPrice != null) signalCount++
  if (criteria.cities?.length) signalCount++
  if (criteria.minBeds != null) signalCount++
  if (criteria.minBaths != null) signalCount++
  if (criteria.propertyTypes?.length) signalCount++
  // Buyer-stated school district / 55+ community are CONCRETE signals — the
  // buyer named a searchable criterion in their own words.
  if (criteria.schoolDistricts?.length) signalCount++
  if (criteria.ageRestrictedCommunity) signalCount++

  return {
    criteria,
    confidence: signalCount >= 2 ? "high" : "low",
    signalCount,
    evidence: evidence.slice(0, 6),
  }
}

// ─── Alert-row mapping ───────────────────────────────────────────────────────

/** The source vocabulary is free text in code ('agent_created' is the only
 *  other writer) — this names the spoken-criteria lane. */
export const SPOKEN_ALERT_SOURCE = "voice_conversation"

/** Prefix on the proposal's paused_reason — the state discriminator that
 *  separates a PROPOSED alert (awaiting approval) from an alert an agent
 *  merely paused. Approval clears paused_reason, so a later pause can never
 *  put an approved alert back in the queue. */
export const VOICE_PROPOSAL_MARKER = "[VOICE_PROPOSAL]"

/** Dedupe marker embedded in alert_name — one proposal per source call. */
export function spokenAlertCallMarker(callId: string): string {
  return `[call:${callId}]`
}

/** TEXT-THREAD lane (inbound email/SMS) — honest provenance: a written
 *  criterion is not a spoken one. The approval queue accepts BOTH sources. */
export const TEXT_ALERT_SOURCE = "text_conversation"

/** paused_reason state marker for a TEXT-thread proposal — same discriminator
 *  contract as VOICE_PROPOSAL_MARKER (approval clears paused_reason). */
export const TEXT_PROPOSAL_MARKER = "[TEXT_PROPOSAL]"

/** Dedupe marker embedded in alert_name — one proposal per source message,
 *  mirroring [call:<id>]. `ref` is the provider message id when the ingress
 *  has one, else a stable content hash (hashConversationText). */
export function writtenAlertMessageMarker(ref: string): string {
  return `[msg:${ref}]`
}

/** FNV-1a 32-bit hex — a stable dedupe ref for ingresses with no message id
 *  (a re-delivered webhook of the same body hashes identically). */
export function hashConversationText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/** Short human label — "3+ bed under $650k in Mocksley". */
export function describeCriteria(criteria: ConversationCriteria): string {
  const parts: string[] = []
  if (criteria.minBeds != null) parts.push(`${criteria.minBeds}+ bed`)
  if (criteria.minBaths != null) parts.push(`${criteria.minBaths}+ bath`)
  if (criteria.propertyTypes?.length) parts.push(criteria.propertyTypes.join("/").replace(/_/g, " "))
  if (criteria.minPrice != null && criteria.maxPrice != null) parts.push(`${fmtPrice(criteria.minPrice)}–${fmtPrice(criteria.maxPrice)}`)
  else if (criteria.maxPrice != null) parts.push(`under ${fmtPrice(criteria.maxPrice)}`)
  else if (criteria.minPrice != null) parts.push(`over ${fmtPrice(criteria.minPrice)}`)
  if (criteria.cities?.length) parts.push(`in ${criteria.cities.join(", ")}`)
  for (const s of criteria.schoolDistricts ?? []) {
    parts.push(s.endsWith("school district") ? `in the ${s}` : `zoned for ${s}`)
  }
  if (criteria.ageRestrictedCommunity) parts.push("55+ community")
  return parts.length > 0 ? parts.join(" ") : "Buyer search"
}

function fmtPrice(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`
  return `$${n}`
}

/** The exact property_alerts insert shape a proposal uses — only real columns
 *  (mirrors createPropertyAlert's write shape), always inactive. */
export interface ProposedAlertRow {
  brokerage_id: string
  contact_id: string
  agent_user_id: string | null
  alert_name: string
  source: string
  is_active: false
  min_price: number | null
  max_price: number | null
  bedrooms_min: number | null
  bathrooms_min: number | null
  property_types: string[]
  cities: string[]
  zip_codes: string[]
  must_have_features: string[]
  keywords: string | null
  new_listings_only: boolean
  include_coming_soon: boolean
  include_price_reductions: boolean
  price_reduction_min_percent: number
  frequency: string
  delivery_channels: string[]
  max_results_per_alert: number
}

/** Map merged conversation criteria onto the property_alerts row shape.
 *  Defaults follow createPropertyAlert (app/actions/property-alerts).
 *  `source` defaults to the voice lane; the text-thread listener passes
 *  TEXT_ALERT_SOURCE so provenance stays honest. */
export function criteriaToAlertRow(
  criteria: ConversationCriteria,
  ids: { contactId: string; agentUserId: string | null; brokerageId: string; alertName: string; source?: string },
): ProposedAlertRow {
  return {
    brokerage_id:                ids.brokerageId,
    contact_id:                  ids.contactId,
    agent_user_id:               ids.agentUserId,
    alert_name:                  ids.alertName,
    source:                      ids.source ?? SPOKEN_ALERT_SOURCE,
    is_active:                   false, // PROPOSED — only agent approval activates
    min_price:                   criteria.minPrice ?? null,
    max_price:                   criteria.maxPrice ?? null,
    bedrooms_min:                criteria.minBeds ?? null,
    bathrooms_min:               criteria.minBaths ?? null,
    property_types:              criteria.propertyTypes ?? [],
    cities:                      criteria.cities ?? [],
    zip_codes:                   [],
    // Buyer-STATED criteria only (see the no-steering block above): a stated
    // 55+ request lands as a must-have feature; stated school-district
    // phrases land as keywords. Both trace to evidence quotes.
    must_have_features:          [
      ...(criteria.features ?? []),
      ...(criteria.ageRestrictedCommunity ? [AGE_RESTRICTED_LABEL] : []),
    ],
    keywords:                    criteria.schoolDistricts?.length ? criteria.schoolDistricts.join(", ") : null,
    new_listings_only:           true,
    include_coming_soon:         true,
    include_price_reductions:    true,
    price_reduction_min_percent: 2,
    frequency:                   "daily",
    delivery_channels:           ["email", "in_app"],
    max_results_per_alert:       10,
  }
}
