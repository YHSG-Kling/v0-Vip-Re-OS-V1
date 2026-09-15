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
// gate. It still never surfaces demographic content: lead_osint_data.data_content
// (social-profile payloads that CAN carry protected-class fields) is read only
// for its metadata (data_type / data_source / confidence_score) — the JSON body
// itself is never folded into the narrative or returned to a caller.
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

type Svc = ReturnType<typeof createServiceClient>

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
  loggedSignalCount: number
  topSignalStrength: number | null
  outreachAttemptCount: number
  /** 0-100 — folds every source's strongest reading into one number, same
   *  0-100 scale as lib/lead-pipeline/pipeline-processor.ts's scoreToUrgencyLevel
   *  input (that file is frozen this wave — see header). */
  behavioralIntentScore: number
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
  osintSignalCount: 0, osintSources: [],
  loggedSignalCount: 0, topSignalStrength: null,
  outreachAttemptCount: 0,
  behavioralIntentScore: 0,
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
): Promise<BehavioralIntentSummary> {
  if (!contactId) return EMPTY_SUMMARY(contactId)
  const supabase = client ?? createServiceClient()

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
  // data_content IS selected (the column has to be read by name for the
  // readerless-write census to see it) but its JSON body is reduced to a
  // boolean (`hasProfileContent`) below and NEVER surfaced in the narrative or
  // returned rows — see the FAIR HOUSING note above: a social-profile payload
  // can carry protected-class fields and this module does not forward them.
  const osintQuery = supabase.from("lead_osint_data")
    .select("data_type, data_source, confidence_score, data_content")
    .eq("lead_id", contactId)
  const signalsLogQuery = supabase.from("intelligence_signals_log")
    .select("signal_type, signal_strength, detected_at, lead_profile_id, signal_data_json")
    .eq("contact_id", contactId)
  const outreachQuery = supabase.from("intelligent_outreach_log")
    .select("outreach_type, channel, content")
    .eq("contact_id", contactId)

  const [
    { data: signals, error: signalsError },
    { data: nextdoor, error: nextdoorError },
    { data: googleActivity, error: googleActivityError },
    { data: osint, error: osintError },
    { data: signalsLog, error: signalsLogError },
    { data: outreach, error: outreachError },
  ] = await Promise.all([signalsQuery, nextdoorQuery, googleActivityQuery, osintQuery, signalsLogQuery, outreachQuery])
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
      .select("source, activity_type, detected_interest_level, property_addresses_viewed, location, detected_via_zenrows, scraped_at, search_criteria_json")
      .in("behavioral_signal_id", signalIds)
    if (extError) console.error("[behavioral-summary] external_behavior read refused:", extError.message)
    else externalBehaviorRows = ext ?? []
  }

  // IDX Broker activity keys off contact_id directly (m630, applied live 2026-09-15).
  let idxRows: Array<Record<string, unknown>> = []
  {
    const { data: idx, error: idxError } = await supabase.from("lead_idx_property_interactions")
      .select("interaction_type, property_address, mls_number, property_details, interaction_metadata, occurred_at, view_duration_seconds")
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
  const topOsintConfidence = Math.max(0, ...osintRows.map((r) => Math.round((r.confidence_score ?? 0) * 100)))

  // Fold: strongest single reading across sources, plus a small bump per extra
  // corroborating source (capped). Deterministic, auditable, no model call.
  const perSourceMax = Math.max(
    topRelevance,
    topSignalStrength ?? 0,
    topOsintConfidence,
    externalBehaviorRows.length > 0 ? 60 : 0,
    googleActivityRows.length > 0 ? 55 : 0,
  )
  const activeSourceCount = [
    externalBehaviorRows.length > 0, nextdoorRows.length > 0, googleActivityRows.length > 0,
    osintRows.length > 0, outreachRows.length > 0,
  ].filter(Boolean).length
  const behavioralIntentScore = Math.max(0, Math.min(100,
    Math.round(perSourceMax + Math.max(0, activeSourceCount - 1) * 5)))

  const osintSources = [...new Set(osintRows.map((r) => r.data_source).filter((s): s is string => !!s))]

  const narrativeParts: string[] = []
  if (externalBehaviorRows.length > 0) narrativeParts.push(`${externalBehaviorRows.length} external property-view signal(s)`)
  if (nextdoorRows.length > 0) narrativeParts.push(`${nextdoorRows.length} neighborhood-forum signal(s) (top relevance ${topRelevance})`)
  if (googleActivityRows.length > 0) narrativeParts.push(`${googleActivityRows.length} search-intent hit(s)`)
  const marketDemandRows = ((googleIntelResult?.data ?? []) as Array<{ search_query: string | null; detected_location: string | null; related_searches: string[] | null; trend: string | null; potential_leads_count: number | null; scraped_at: string | null }>)
  if (marketDemandRows.length > 0) narrativeParts.push(`market search-demand trending ${marketDemandRows[0].trend ?? "unknown"} for "${marketDemandRows[0].search_query ?? "the area"}"`)
  if (osintRows.length > 0) narrativeParts.push(`${osintRows.length} OSINT enrichment source(s): ${osintSources.join(", ") || "unspecified"}`)
  if (outreachRows.length > 0) narrativeParts.push(`${outreachRows.length} prior intelligent-outreach attempt(s)`)
  const narrative = narrativeParts.length > 0
    ? `${narrativeParts.join("; ")}. Behavioral intent score ${behavioralIntentScore}/100.`
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
    loggedSignalCount: signalsLogRows.length,
    topSignalStrength,
    outreachAttemptCount: outreachRows.length,
    behavioralIntentScore,
    narrative,
  }
}
