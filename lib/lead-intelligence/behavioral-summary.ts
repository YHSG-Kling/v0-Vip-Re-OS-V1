// lib/lead-intelligence/behavioral-summary.ts
//
// THE READER for seven writer-only tables (readerless-write-census, wave 64C
// lead-scraping audit): external_behavior, nextdoor_activity,
// google_search_activity, google_search_intelligence, intelligence_signals_log,
// lead_osint_data, intelligent_outreach_log. Every writer of these lives in
// app/actions/lead-intelligence.ts and is reached only through
// enrichLeadData(leadId) → the id is resolved against `contacts` and the call
// throws on a miss (app/actions/lead-intelligence.ts ~L765), so — despite most
// of these columns being spelled `lead_id` — the value every writer stores is
// proven to be a CONTACTS.id, not a leads.id. This reader takes that same id.
//
// FLAGGED, NOT FIXED HERE (out of this pass's scope — reported per CLAUDE.md
// §1 rather than guessed): nextdoor_activity.lead_id / google_search_activity
// .lead_id / lead_osint_data.lead_id may carry the SAME contacts-id-into-a-
// leads-FK mismatch already documented and fixed for
// lead_idx_property_interactions (see syncIDXBrokerActivity's header in
// app/actions/lead-intelligence.ts). Confirming needs a live-schema FK check on
// those three tables specifically; this reader queries by value and does not
// assume either way.
//
// FAIR HOUSING (owner ruling, lib/lead-governance/protected-class-signals.ts
// header): compliance/fair-housing screening applies to OUTBOUND AD AUDIENCE
// TARGETING, not to scraping/enrichment/scoring/sourcing reads. This module is
// a read of already-collected behavioral/search signals for internal scoring —
// not an ad-targeting path — so it is deliberately NOT routed through that
// gate.
//
// TOMBSTONE (wave 66, owner ruling 2026-09-15 verbatim: "we need to get rid of
// the fair housing and anything else that is preventing from getting the full
// lead info including name, email, etc." / "there is no reason to use any
// compliance gating for these areas of intelligence etc because this is just
// gathering information about a property or potential or current client so we
// can better serve them with information."). This file used to reduce
// `lead_osint_data.data_content` to a boolean (`hasProfileContent`, never
// stored) and never fold the JSON body into the narrative or the returned
// rows — a redaction motivated by the same fair-housing reasoning the ruling
// above removes. The content is now surfaced in full: `osintProfiles` below
// carries the raw `data_content` payload per row, and the narrative names the
// social platforms it came from. Nothing about this module's SCOPE changed —
// it is still a read of already-collected signals, not an ad-audience path —
// so `assertAudienceSegmentationAllowed` / `protectedClassSegmentationIn`
// (lib/lead-governance/protected-class-signals.ts) remain untouched and still
// refuse a protected-class field from DEFINING an ad audience; that is the one
// arm this ruling does not reach.
//
// Consumers (this pass): getAllSignalsForProfile → createUnifiedLeadProfile
// (app/actions/lead-intelligence.ts), which already writes
// unified_lead_profile.confidence_score/intent_type — both rendered by
// app/crm/page.tsx and app/leads/page.tsx.
//
// NOT WIRED THIS PASS (frozen file, not a gap in this reader): the promotion
// score / urgency derivation in lib/lead-pipeline/pipeline-processor.ts
// (scoreToUrgencyLevel) is the other named consumer in the task brief, but
// lib/lead-pipeline/* is NOT in this wave's freeze-lift list — editing it is
// out of scope here. behavioralIntentScore below is shaped (0-100, same scale
// pipeline-processor.ts already uses) so that file's next lane can fold it in
// directly.

import { createServiceClient } from "@/lib/supabase/service"
import { currentMemoryFacts } from "@/lib/kernel/conversation-memory"

type Svc = ReturnType<typeof createServiceClient>

// ─── SIGNAL DECAY + INTENT VELOCITY (lane 97B, blueprint row 14) ─────────────
//
// WHAT EXISTED: the fold below took the STRONGEST reading per source plus +5 per
// extra source — AGELESS. A valuation request from last spring scored the same as
// one from this morning, and nothing could say whether a person was warming or
// cooling. signal-reaper-policy.ts's TTL is decay-by-deletion (a row is there or it
// is not), not a half-life. This section is the missing half, ON this survivor (the
// fold now calls it — there is still ONE behavioural intent number, not two).
//
// THE RULE (deterministic, in code, never in a prompt):
//   contribution_i = strength(type_i) × 0.5^(age_i / halfLife(type_i))
//   intent         = 100 × (1 − Π(1 − contribution_i/100)^corroboration), 0-100
// — a Σ bounded by probabilistic-OR saturation, so ten page views never equal one
// callback request. corroboration lifts only when ≥2 INDEPENDENT sources (distinct
// source tables/providers, not two rows of one table) contribute.
// VELOCITY = (intent(now) − intent(now−7d)) / 7, recomputed from the SAME
// observations filtered to those already seen at the earlier instant (no snapshot
// table needed — computed on read). ACCELERATION = Δvelocity between the last two
// 7-day windows / 7.
//
// Timeline is the live `contacts_timeline_check` / `leads_timeline_check`
// vocabulary — buckets only (CLAUDE.md §5), never 30/60/90.

export type IntentSignalType =
  | "callback_request"     // owner ruling: a callback is positive intent → convert
  | "appointment_request"
  | "showing_request"
  | "valuation_request"
  | "saved_listing"
  | "listing_view"
  | "page_view"
  | "search_intent"
  | "forum_activity"
  | "inbound_reply"
  | "logged_signal"
  | "stated_timeline"

export interface IntentSignalPolicy {
  /** Days for a signal's contribution to halve. */
  halfLifeDays: number
  /** 0-100 strength of a fresh signal of this type. */
  strength: number
}

/** The half-life table. A valuation request is a narrow window (~1 week); a page view
 *  is noise within days; a callback / appointment request is a long-lived commitment. */
export const INTENT_SIGNAL_POLICY: Readonly<Record<Exclude<IntentSignalType, "stated_timeline">, IntentSignalPolicy>> = Object.freeze({
  callback_request:    { halfLifeDays: 60, strength: 90 },
  appointment_request: { halfLifeDays: 45, strength: 85 },
  showing_request:     { halfLifeDays: 14, strength: 75 },
  valuation_request:   { halfLifeDays: 7,  strength: 70 },
  saved_listing:       { halfLifeDays: 10, strength: 30 },
  listing_view:        { halfLifeDays: 3,  strength: 15 },
  page_view:           { halfLifeDays: 3,  strength: 10 },
  search_intent:       { halfLifeDays: 10, strength: 25 },
  forum_activity:      { halfLifeDays: 14, strength: 20 },
  inbound_reply:       { halfLifeDays: 21, strength: 50 },
  logged_signal:       { halfLifeDays: 14, strength: 30 },
})

/** A STATED timeline decays on a months scale, per bucket. Keyed by the live CHECK. */
export const STATED_TIMELINE_POLICY: Readonly<Record<string, IntentSignalPolicy>> = Object.freeze({
  immediate:     { halfLifeDays: 30,  strength: 75 },
  "1-3_months":  { halfLifeDays: 45,  strength: 60 },
  "3-6_months":  { halfLifeDays: 90,  strength: 40 },
  "6-12_months": { halfLifeDays: 180, strength: 25 },
  "12+_months":  { halfLifeDays: 270, strength: 10 },
  researching:   { halfLifeDays: 120, strength: 5 },
})

/** An observation with no timestamp cannot be aged; it counts at this fixed fraction
 *  (conservative) and is flagged `ageUnknown` in the evidence. It never moves velocity. */
export const UNKNOWN_AGE_DECAY = 0.25
/** Corroboration lift by count of independent contributing sources. */
const CORROBORATION_LIFT: Readonly<{ two: number; threePlus: number }> = Object.freeze({ two: 1.15, threePlus: 1.25 })
/** A contribution below this is noise — it neither counts as a source nor lists as evidence. */
const MIN_CONTRIBUTION = 1
const DAY_MS = 86_400_000

export interface IntentObservation {
  type: IntentSignalType
  /** ISO timestamp the signal was observed; null = age unknown. */
  observedAt: string | null
  /** The table/provider the row came from — the independence key for corroboration. */
  source: string
  /** Optional 0-100 per-row strength (e.g. intelligence_signals_log.signal_strength). */
  strength?: number | null
  /** stated_timeline only: the CHECK bucket. */
  timelineBucket?: string | null
}

export interface IntentEvidence {
  type: IntentSignalType
  source: string
  observedAt: string | null
  ageDays: number | null
  ageUnknown: boolean
  halfLifeDays: number
  strength: number
  decay: number
  contribution: number
  timelineBucket?: string | null
}

export interface DecayedIntent {
  /** Current intent 0-100. */
  score: number
  confidence: "none" | "low" | "medium" | "high"
  independentSources: number
  corroboration: number
  /** Δintent per day over the last 7 days. */
  velocityPerDay: number
  /** Δvelocity per day between the last two 7-day windows. */
  accelerationPerDay2: number
  trend: "rising" | "flat" | "falling"
  /** Sort key for "who needs us next": score + 7×velocity + 24.5×acceleration (unclamped).
   *  Rising moderate intent outranks high-but-declining intent. */
  momentumRank: number
  /** Contributing signals, strongest first. */
  evidence: IntentEvidence[]
}

/** PURE. 0.5^(age/halfLife); future-dated rows count as fresh; unknown age → UNKNOWN_AGE_DECAY. */
/** @proofSeam exported so scripts/lead-action-plan-simulator.ts asserts the decay / velocity / momentum ordering rules on the pure function directly. */
export function decayFactor(ageDays: number | null, halfLifeDays: number): number {
  if (ageDays === null || !Number.isFinite(ageDays)) return UNKNOWN_AGE_DECAY
  if (ageDays <= 0) return 1
  if (!(halfLifeDays > 0)) return 0
  return Math.pow(0.5, ageDays / halfLifeDays)
}

function policyFor(o: IntentObservation): IntentSignalPolicy | null {
  if (o.type === "stated_timeline") return STATED_TIMELINE_POLICY[o.timelineBucket ?? ""] ?? null
  return INTENT_SIGNAL_POLICY[o.type] ?? null
}

function intentAt(observations: readonly IntentObservation[], at: Date): { score: number; evidence: IntentEvidence[]; sources: number; corroboration: number } {
  const evidence: IntentEvidence[] = []
  for (const o of observations) {
    const policy = policyFor(o)
    if (!policy) continue
    const t = o.observedAt ? new Date(o.observedAt).getTime() : NaN
    const dated = Number.isFinite(t)
    if (dated && t > at.getTime()) continue // not yet observed at this instant
    const ageDays = dated ? (at.getTime() - t) / DAY_MS : null
    const strength = Math.max(0, Math.min(100, typeof o.strength === "number" && Number.isFinite(o.strength) ? o.strength : policy.strength))
    const decay = decayFactor(ageDays, policy.halfLifeDays)
    const contribution = strength * decay
    if (contribution < MIN_CONTRIBUTION) continue
    evidence.push({
      type: o.type, source: o.source, observedAt: dated ? o.observedAt : null,
      ageDays: ageDays === null ? null : Math.round(ageDays * 10) / 10, ageUnknown: !dated,
      halfLifeDays: policy.halfLifeDays, strength, decay: Math.round(decay * 1000) / 1000,
      contribution: Math.round(contribution * 10) / 10,
      ...(o.type === "stated_timeline" ? { timelineBucket: o.timelineBucket ?? null } : {}),
    })
  }
  const sources = new Set(evidence.map((e) => e.source)).size
  const corroboration = sources >= 3 ? CORROBORATION_LIFT.threePlus : sources === 2 ? CORROBORATION_LIFT.two : 1
  const remaining = evidence.reduce((acc, e) => acc * (1 - Math.min(100, e.contribution) / 100), 1)
  // Corroboration shrinks the REMAINING headroom (remaining^lift) instead of
  // multiplying the score: a multiplier clamps strong profiles at 100 at every
  // instant, which reads as velocity 0 while the person is actually cooling
  // (caught by VELOCITY-SIGNS in test:lead-action-plan).
  const score = Math.max(0, Math.min(100, 100 * (1 - Math.pow(remaining, corroboration))))
  evidence.sort((a, b) => b.contribution - a.contribution)
  return { score, evidence, sources, corroboration }
}

/** PURE. Current decayed intent + velocity + acceleration + the evidence list. */
/** @proofSeam exported so scripts/lead-action-plan-simulator.ts asserts the decay / velocity / momentum ordering rules on the pure function directly. */
export function scoreDecayedIntent(observations: readonly IntentObservation[], now: Date = new Date()): DecayedIntent {
  const cur = intentAt(observations, now)
  const prev = intentAt(observations, new Date(now.getTime() - 7 * DAY_MS)).score
  const prev2 = intentAt(observations, new Date(now.getTime() - 14 * DAY_MS)).score
  const velocity = (cur.score - prev) / 7
  const priorVelocity = (prev - prev2) / 7
  const acceleration = (velocity - priorVelocity) / 7
  const round2 = (n: number) => Math.round(n * 100) / 100
  const confidence: DecayedIntent["confidence"] = cur.evidence.length === 0 ? "none"
    : cur.sources >= 3 ? "high" : cur.sources === 2 ? "medium" : "low"
  return {
    score: Math.round(cur.score),
    confidence,
    independentSources: cur.sources,
    corroboration: cur.corroboration,
    velocityPerDay: round2(velocity),
    accelerationPerDay2: round2(acceleration),
    trend: velocity > 0.5 ? "rising" : velocity < -0.5 ? "falling" : "flat",
    momentumRank: round2(cur.score + 7 * velocity + 24.5 * acceleration),
    evidence: cur.evidence,
  }
}

/** Comparator: who needs us next — momentum first, current score as the tie-break. */
/** @proofSeam exported so scripts/lead-action-plan-simulator.ts asserts the decay / velocity / momentum ordering rules on the pure function directly. */
export function byIntentMomentumDesc(a: DecayedIntent, b: DecayedIntent): number {
  return (b.momentumRank - a.momentumRank) || (b.score - a.score)
}

export interface BehavioralIntentSummary {
  contactId: string
  externalBehaviorCount: number
  externalBehavior: Array<{
    source: string | null
    activityType: string | null
    interestLevel: string | null
    propertyAddressesViewed: string[]
    location: string | null
    viaZenrows: boolean
    scrapedAt: string | null
  }>
  /** IDX Broker property activity synced for this contact (syncIDXBrokerActivity,
   *  app/actions/lead-intelligence.ts) — the columns that insert writes and
   *  nothing else read until wave 64. */
  idxInteractionsCount: number
  idxInteractions: Array<{
    interactionType: string | null
    propertyAddress: string | null
    mlsNumber: string | null
    propertyDetails: Record<string, unknown> | null
    metadata: Record<string, unknown> | null
    occurredAt: string | null
    viewDurationSeconds: number | null
  }>
  nextdoorActivityCount: number
  nextdoorActivity: Array<{
    activityType: string | null
    neighborhood: string | null
    keywords: string[]
    relevanceScore: number | null
  }>
  googleSearchActivityCount: number
  googleSearchActivity: Array<{
    searchLocation: string | null
    searchTerms: string[]
    detectedIntent: string | null
  }>
  googleSearchIntelligenceCount: number
  /** Market-demand sampling for the contact's own market — brokerage-wide
   *  (google_search_intelligence has no per-contact column; see the docblock
   *  on analyzeGoogleSearchIntent in app/actions/lead-intelligence.ts). */
  marketSearchDemand: Array<{
    query: string | null
    location: string | null
    trend: string | null
    relatedSearches: string[]
    potentialLeadsCount: number | null
    scrapedAt: string | null
  }>
  osintSignalCount: number
  osintSources: string[]
  /** FULL `data_content` payload per OSINT row (wave 66 — see the FAIR HOUSING
   *  tombstone above). Whatever the source captured — name, email, phone,
   *  bio text, social profile fields — rides here verbatim; this module does
   *  not filter it by field name or content. */
  osintProfiles: Array<{
    dataType: string | null
    dataSource: string | null
    confidenceScore: number | null
    content: unknown
  }>
  loggedSignalCount: number
  topSignalStrength: number | null
  outreachAttemptCount: number
  /** 0-100 — folds every source's strongest reading into one number, same
   *  0-100 scale as lib/lead-pipeline/pipeline-processor.ts's scoreToUrgencyLevel
   *  input (that file is frozen this wave — see header). */
  behavioralIntentScore: number
  /** Lane 97B: the decayed intent behind behavioralIntentScore — confidence,
   *  velocity, acceleration and the evidence list (which signal, its age, its
   *  contribution). behavioralIntentScore === decayedIntent.score. */
  decayedIntent: DecayedIntent
  /** Plain-English rollup for the lead-desk panel / ISA brief. Deliberately
   *  factual and source-count based — no demographic or protected-class
   *  inference (see FAIR HOUSING note above). */
  narrative: string
}

const EMPTY_SUMMARY = (contactId: string): BehavioralIntentSummary => ({
  contactId,
  externalBehaviorCount: 0, externalBehavior: [],
  idxInteractionsCount: 0, idxInteractions: [],
  nextdoorActivityCount: 0, nextdoorActivity: [],
  googleSearchActivityCount: 0, googleSearchActivity: [],
  googleSearchIntelligenceCount: 0, marketSearchDemand: [],
  osintSignalCount: 0, osintSources: [], osintProfiles: [],
  loggedSignalCount: 0, topSignalStrength: null,
  outreachAttemptCount: 0,
  behavioralIntentScore: 0,
  decayedIntent: scoreDecayedIntent([]),
  narrative: "No external behavioral or search signals collected yet.",
})

/**
 * Read every writer-only behavioral/OSINT table for one contact and fold it
 * into one score + narrative. Never throws — a refused read on one table
 * degrades that table's contribution to zero rather than failing the whole
 * summary (the caller may be assembling a live prompt or a dashboard panel).
 */
export async function buildBehavioralIntentSummary(
  contactId: string,
  brokerageId: string | null,
  client?: Svc,
  opts: { now?: Date } = {},
): Promise<BehavioralIntentSummary> {
  if (!contactId) return EMPTY_SUMMARY(contactId)
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()

  // external_behavior keys off behavioral_signal_id, not the contact directly —
  // resolve this contact's signal id(s) first (identifyVisitor / trackBehavior
  // both stamp behavioral_signals.contact_id once a visitor is identified).
  const signalsQuery = supabase.from("behavioral_signals").select("id")
    .eq("contact_id", contactId)
  const nextdoorQuery = supabase.from("nextdoor_activity")
    .select("activity_type, activity_url, content_snippet, neighborhood, detected_keywords, relevance_score")
    .eq("lead_id", contactId)
  const googleActivityQuery = supabase.from("google_search_activity")
    .select("search_location, search_terms, detected_intent, scraped_via, search_patterns")
    .eq("lead_id", contactId)
  const googleIntelQuery = brokerageId
    ? supabase.from("google_search_intelligence")
      .select("search_query, detected_location, related_searches, trend, potential_leads_count, scraped_at", { count: "exact" })
      .eq("brokerage_id", brokerageId)
      .order("scraped_at", { ascending: false })
      .limit(10)
    : null
  // data_content is selected AND surfaced in full (wave 66 — see the FAIR
  // HOUSING tombstone above): the JSON body rides into `osintProfiles`
  // verbatim, whatever fields the source captured.
  const osintQuery = supabase.from("lead_osint_data")
    .select("data_type, data_source, confidence_score, data_content")
    .eq("lead_id", contactId)
  const signalsLogQuery = supabase.from("intelligence_signals_log")
    .select("signal_type, signal_strength, detected_at, lead_profile_id, signal_data_json")
    .eq("contact_id", contactId)
  const outreachQuery = supabase.from("intelligent_outreach_log")
    .select("outreach_type, channel, content")
    .eq("contact_id", contactId)
  // Lane 97B — the DATED first-party intent rows the decay needs. Tenant-scoped when
  // the caller knows the brokerage (the contact id is the row key either way).
  let valuationQuery = supabase.from("valuation_requests")
    .select("submitted_at, appointment_scheduled, appointment_at")
    .eq("contact_id", contactId)
  if (brokerageId) valuationQuery = valuationQuery.eq("brokerage_id", brokerageId)
  let callbackQuery = supabase.from("tasks")
    .select("created_at, status")
    .eq("contact_id", contactId)
    .eq("source", "ai_callback")
  if (brokerageId) callbackQuery = callbackQuery.eq("brokerage_id", brokerageId)
  let contactQuery = supabase.from("contacts")
    .select("timeline, metadata")
    .eq("id", contactId)
  if (brokerageId) contactQuery = contactQuery.eq("brokerage_id", brokerageId)

  const [
    { data: signals, error: signalsError },
    { data: nextdoor, error: nextdoorError },
    { data: googleActivity, error: googleActivityError },
    { data: osint, error: osintError },
    { data: signalsLog, error: signalsLogError },
    { data: outreach, error: outreachError },
    { data: valuations, error: valuationError },
    { data: callbacks, error: callbackError },
    { data: contactRow, error: contactError },
  ] = await Promise.all([signalsQuery, nextdoorQuery, googleActivityQuery, osintQuery, signalsLogQuery, outreachQuery,
    valuationQuery.limit(20), callbackQuery.limit(20), contactQuery.maybeSingle()])
  if (valuationError) console.error("[behavioral-summary] valuation_requests read refused:", valuationError.message)
  if (callbackError) console.error("[behavioral-summary] tasks(ai_callback) read refused:", callbackError.message)
  if (contactError) console.error("[behavioral-summary] contacts(timeline) read refused:", contactError.message)
  const googleIntelResult = googleIntelQuery ? await googleIntelQuery : null

  if (signalsError) console.error("[behavioral-summary] behavioral_signals read refused:", signalsError.message)
  if (nextdoorError) console.error("[behavioral-summary] nextdoor_activity read refused:", nextdoorError.message)
  if (googleActivityError) console.error("[behavioral-summary] google_search_activity read refused:", googleActivityError.message)
  if (osintError) console.error("[behavioral-summary] lead_osint_data read refused:", osintError.message)
  if (signalsLogError) console.error("[behavioral-summary] intelligence_signals_log read refused:", signalsLogError.message)
  if (outreachError) console.error("[behavioral-summary] intelligent_outreach_log read refused:", outreachError.message)
  if (googleIntelResult?.error) console.error("[behavioral-summary] google_search_intelligence read refused:", googleIntelResult.error.message)

  const signalIds = ((signals ?? []) as Array<{ id: string }>).map((s) => s.id)
  let externalBehaviorRows: Array<Record<string, unknown>> = []
  if (signalIds.length > 0) {
    const { data: ext, error: extError } = await supabase.from("external_behavior")
      .select("source, activity_type, detected_interest_level, property_addresses_viewed, location, detected_via_zenrows, scraped_at, occurred_at, search_criteria_json")
      .in("behavioral_signal_id", signalIds)
    if (extError) console.error("[behavioral-summary] external_behavior read refused:", extError.message)
    else externalBehaviorRows = ext ?? []
  }

  // IDX Broker activity keys off contact_id directly (m630, applied live 2026-09-15).
  let idxRows: Array<Record<string, unknown>> = []
  {
    const { data: idx, error: idxError } = await supabase.from("lead_idx_property_interactions")
      .select("interaction_type, property_address, mls_number, property_details, interaction_metadata, occurred_at, view_duration_seconds, requested_showing, saved")
      .eq("contact_id", contactId)
      .order("occurred_at", { ascending: false })
      .limit(50)
    if (idxError) console.error("[behavioral-summary] lead_idx_property_interactions read refused:", idxError.message)
    else idxRows = idx ?? []
  }

  const nextdoorRows = (nextdoor ?? []) as Array<{ activity_type: string | null; neighborhood: string | null; detected_keywords: string[] | null; relevance_score: number | null }>
  const googleActivityRows = (googleActivity ?? []) as Array<{ search_location: string | null; search_terms: string[] | null; detected_intent: string | null }>
  const osintRows = (osint ?? []) as Array<{ data_type: string | null; data_source: string | null; confidence_score: number | null; data_content: unknown }>
  const outreachRows = (outreach ?? []) as Array<{ outreach_type: string | null; channel: string | null; content: string | null }>
  const signalsLogRows = (signalsLog ?? []) as Array<{ signal_type: string | null; signal_strength: number | null; detected_at: string | null }>

  const topRelevance = Math.max(0, ...nextdoorRows.map((r) => r.relevance_score ?? 0))
  const topSignalStrength = signalsLogRows.length > 0
    ? Math.max(...signalsLogRows.map((r) => r.signal_strength ?? 0))
    : null

  // TOMBSTONE (lane 97B): the AGELESS fold lived here — max(per-source reading)
  // + 5 per extra active source, which also counted lead_osint_data's identity-
  // match confidence and OUR OWN intelligent_outreach_log attempts as the person's
  // intent. Survivor: scoreDecayedIntent (this file, above) — every DATED row is
  // aged on its type's half-life; undated rows count at UNKNOWN_AGE_DECAY; OSINT
  // and our outreach are not the person's intent and no longer score.
  const observations: IntentObservation[] = []
  for (const r of externalBehaviorRows) {
    const lvl = String(r.detected_interest_level ?? "").toLowerCase()
    observations.push({
      type: "listing_view", source: "external_behavior",
      observedAt: ((r.occurred_at ?? r.scraped_at) as string | null) ?? null,
      strength: lvl === "high" ? 45 : lvl === "medium" ? 25 : null,
    })
  }
  for (const r of idxRows) {
    const type: IntentSignalType = r.requested_showing === true ? "showing_request" : r.saved === true ? "saved_listing" : "listing_view"
    observations.push({ type, source: "lead_idx_property_interactions", observedAt: (r.occurred_at as string | null) ?? null })
  }
  for (const r of signalsLogRows) {
    observations.push({ type: "logged_signal", source: "intelligence_signals_log", observedAt: r.detected_at, strength: r.signal_strength })
  }
  for (const r of nextdoorRows) {
    observations.push({ type: "forum_activity", source: "nextdoor_activity", observedAt: null, strength: r.relevance_score })
  }
  for (let i = 0; i < googleActivityRows.length; i++) {
    observations.push({ type: "search_intent", source: "google_search_activity", observedAt: null })
  }
  for (const r of (valuations ?? []) as Array<{ submitted_at: string | null; appointment_scheduled: boolean | null }>) {
    observations.push({ type: "valuation_request", source: "valuation_requests", observedAt: r.submitted_at })
    if (r.appointment_scheduled === true) {
      observations.push({ type: "appointment_request", source: "valuation_requests", observedAt: r.submitted_at })
    }
  }
  for (const r of (callbacks ?? []) as Array<{ created_at: string | null }>) {
    observations.push({ type: "callback_request", source: "tasks.ai_callback", observedAt: r.created_at })
  }
  // STATED TIMELINE: aged from the memory fact's observed_at when the context spine
  // holds a current one (lane 97B memory compiler); otherwise the column alone, age unknown.
  const contact = (contactRow ?? null) as { timeline?: string | null; metadata?: Record<string, unknown> | null } | null
  const timelineFact = currentMemoryFacts(contact?.metadata?.context_spine, now).find((f) => f.key === "timeline")
  if (timelineFact) {
    observations.push({ type: "stated_timeline", source: `memory.${timelineFact.source}`, observedAt: timelineFact.observedAt, timelineBucket: timelineFact.value })
  } else if (contact?.timeline) {
    observations.push({ type: "stated_timeline", source: "contacts.timeline", observedAt: null, timelineBucket: contact.timeline })
  }
  const decayedIntent = scoreDecayedIntent(observations, now)
  const behavioralIntentScore = decayedIntent.score

  const osintSources = [...new Set(osintRows.map((r) => r.data_source).filter((s): s is string => !!s))]

  const narrativeParts: string[] = []
  if (externalBehaviorRows.length > 0) narrativeParts.push(`${externalBehaviorRows.length} external property-view signal(s)`)
  if (nextdoorRows.length > 0) narrativeParts.push(`${nextdoorRows.length} neighborhood-forum signal(s) (top relevance ${topRelevance})`)
  if (googleActivityRows.length > 0) narrativeParts.push(`${googleActivityRows.length} search-intent hit(s)`)
  const marketDemandRows = ((googleIntelResult?.data ?? []) as Array<{ search_query: string | null; detected_location: string | null; related_searches: string[] | null; trend: string | null; potential_leads_count: number | null; scraped_at: string | null }>)
  if (marketDemandRows.length > 0) narrativeParts.push(`market search-demand trending ${marketDemandRows[0].trend ?? "unknown"} for "${marketDemandRows[0].search_query ?? "the area"}"`)
  if (osintRows.length > 0) {
    narrativeParts.push(`${osintRows.length} OSINT enrichment source(s): ${osintSources.join(", ") || "unspecified"}`)
    // Wave 66: fold the captured content's own field names into the narrative
    // (e.g. a scraped profile's name/email/bio keys), not just the row count —
    // the fair-housing reduction this replaced is the tombstone above.
    const contentKeys = new Set<string>()
    for (const r of osintRows) {
      if (r.data_content && typeof r.data_content === "object" && !Array.isArray(r.data_content)) {
        for (const k of Object.keys(r.data_content as Record<string, unknown>)) contentKeys.add(k)
      }
    }
    if (contentKeys.size > 0) narrativeParts.push(`captured fields: ${[...contentKeys].join(", ")}`)
  }
  if ((valuations ?? []).length > 0) narrativeParts.push(`${(valuations ?? []).length} home-valuation request(s)`)
  if ((callbacks ?? []).length > 0) narrativeParts.push(`${(callbacks ?? []).length} callback request(s)`)
  if (outreachRows.length > 0) narrativeParts.push(`${outreachRows.length} prior intelligent-outreach attempt(s)`)
  const narrative = narrativeParts.length > 0
    ? `${narrativeParts.join("; ")}. Behavioral intent score ${behavioralIntentScore}/100 (${decayedIntent.trend}, ${decayedIntent.velocityPerDay}/day, ${decayedIntent.confidence} confidence).`
    : EMPTY_SUMMARY(contactId).narrative

  return {
    contactId,
    externalBehaviorCount: externalBehaviorRows.length,
    externalBehavior: externalBehaviorRows.map((r) => ({
      source: (r.source as string) ?? null,
      activityType: (r.activity_type as string) ?? null,
      interestLevel: (r.detected_interest_level as string) ?? null,
      propertyAddressesViewed: (r.property_addresses_viewed as string[]) ?? [],
      location: (r.location as string) ?? null,
      viaZenrows: !!r.detected_via_zenrows,
      scrapedAt: (r.scraped_at as string) ?? null,
    })),
    idxInteractionsCount: idxRows.length,
    idxInteractions: idxRows.map((r) => ({
      interactionType: (r.interaction_type as string) ?? null,
      propertyAddress: (r.property_address as string) ?? null,
      mlsNumber: (r.mls_number as string) ?? null,
      propertyDetails: (r.property_details as Record<string, unknown>) ?? null,
      metadata: (r.interaction_metadata as Record<string, unknown>) ?? null,
      occurredAt: (r.occurred_at as string) ?? null,
      viewDurationSeconds: (r.view_duration_seconds as number) ?? null,
    })),
    nextdoorActivityCount: nextdoorRows.length,
    nextdoorActivity: nextdoorRows.map((r) => ({
      activityType: r.activity_type, neighborhood: r.neighborhood,
      keywords: r.detected_keywords ?? [], relevanceScore: r.relevance_score,
    })),
    googleSearchActivityCount: googleActivityRows.length,
    googleSearchActivity: googleActivityRows.map((r) => ({
      searchLocation: r.search_location, searchTerms: r.search_terms ?? [], detectedIntent: r.detected_intent,
    })),
    googleSearchIntelligenceCount: googleIntelResult?.count ?? 0,
    marketSearchDemand: marketDemandRows.map((r) => ({
      query: r.search_query, location: r.detected_location, trend: r.trend,
      relatedSearches: r.related_searches ?? [], potentialLeadsCount: r.potential_leads_count, scrapedAt: r.scraped_at,
    })),
    osintSignalCount: osintRows.length,
    osintSources,
    osintProfiles: osintRows.map((r) => ({
      dataType: r.data_type ?? null,
      dataSource: r.data_source ?? null,
      confidenceScore: r.confidence_score ?? null,
      content: r.data_content ?? null,
    })),
    loggedSignalCount: signalsLogRows.length,
    topSignalStrength,
    outreachAttemptCount: outreachRows.length,
    behavioralIntentScore,
    decayedIntent,
    narrative,
  }
}

// ─── UNCONVERTED LEADS (wave 98, lane 98B — 97B "still open": the lead sweep passed no intent) ──
// A lead in the plan sweep has NO contact row (conversion finality: contact_id IS NULL), so the
// contact-keyed reader above has nothing to read. What IS keyed by leads.id AND has a writer:
//   · isa_outreach_log.lead_id + replied_at — the person REPLIED to a touch (inbound_reply;
//     written by app/actions/ai-isa/handle-inbound-email.ts);
//   · leads.timeline — the stated bucket, with no stated-at (age unknown → UNKNOWN_AGE_DECAY).
// NOT READ, deliberately (documented gap, not guessed):
//   · lead_idx_property_interactions.lead_id has NO writer by owner ruling ("leads not for idx or
//     rentcast, only contacts" — lib/kernel/manager-registry.ts leads_never_reach_property_providers);
//     reading it would be a reader with no writer (test:opposite-missing 1b);
//   · valuation_requests, tasks (callback), behavioral_signals, intelligence_signals_log key on
//     contact_id only; external_behavior hangs off behavioral_signals. A lead's site / valuation /
//     IDX activity therefore counts once the lead is converted to a contact.

export interface LeadIntentRows {
  replies: ReadonlyArray<{ replied_at?: string | null }>
  timeline: string | null
}

/** PURE. The lead-keyed rows → observations, on the SAME type/source mapping the contact reader uses. */
/** @proofSeam exported so scripts/lead-action-plan-simulator.ts asserts the lead-keyed mapping (replies age, timeline age-unknown) on the pure function directly. */
export function leadIntentObservations(rows: LeadIntentRows): IntentObservation[] {
  const out: IntentObservation[] = []
  for (const r of rows.replies) {
    if (r.replied_at) out.push({ type: "inbound_reply", source: "isa_outreach_log.replied_at", observedAt: r.replied_at })
  }
  if (rows.timeline) out.push({ type: "stated_timeline", source: "leads.timeline", observedAt: null, timelineBucket: rows.timeline })
  return out
}

/**
 * LIVE. The decayed intent of an UNCONVERTED lead from its lead-keyed rows, or null when the lead
 * has none (the plan then decides on cadence alone, exactly as before). Tenant-pinned; a refused
 * read degrades that source to empty and is said, never thrown.
 */
export async function buildLeadDecayedIntent(
  supabase: Svc,
  brokerageId: string,
  lead: { id: string; timeline?: string | null },
  now: Date = new Date(),
): Promise<DecayedIntent | null> {
  const replyRes = await supabase.from("isa_outreach_log")
    .select("replied_at")
    .eq("brokerage_id", brokerageId).eq("lead_id", lead.id)
    .not("replied_at", "is", null).limit(20)
  if (replyRes.error) console.error(`[behavioral-summary] lead ${lead.id}: isa_outreach_log replies read refused:`, replyRes.error.message)
  const observations = leadIntentObservations({
    replies: (replyRes.error ? [] : replyRes.data ?? []) as LeadIntentRows["replies"],
    timeline: lead.timeline ?? null,
  })
  return observations.length > 0 ? scoreDecayedIntent(observations, now) : null
}
