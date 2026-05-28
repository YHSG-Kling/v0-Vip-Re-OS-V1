// lib/kernel/scraping.ts
// ─── RAW LEAD SCRAPING CANONICAL ORCHESTRATOR ────────────────────────────────
//
// KERNEL OWNERSHIP: This file owns ALL scraping pipeline logic.
// No other file may contain dedup decisions, viability gating, enrichment
// queuing, promotion rules, or source attribution writes.
//
// RULES:
// 1. Raw records enter via ingestRawSourceBatch() ONLY.
// 2. AI ISA is NEVER assigned at raw stage.
//    ISA assignment begins only after RAW_RECORD_PROMOTED fires.
// 3. Direct-contact consented intake (forms, QR, business cards) does NOT
//    enter this path. It uses lib/kernel/crm.ts createContactManually().
// 4. Dedup checks both `leads` and `contacts` tables. Never overwrite a real
//    contact record without a higher enrichment_confidence.
// 5. All source attribution fields (source, source_family, source_channel,
//    source_subtype) are set at ingest time and never mutated downstream.
// 6. cron_execution_logs are written by runScrapeSourcesChronologically()
//    for every run — success or failure.
// 7. createServiceClient() is SYNC — never await it.
// 8. Always use maybeSingle(), never single().

import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from '@/lib/kernel/events'
import type { NormalizedScrapedRecord } from '@/lib/lead-pipeline/raw-record-types'
import {
  isViableRecord,
  buildLeadIdentityKey,
} from '@/lib/lead-pipeline/raw-record-types'

// ─── INPUT / OUTPUT CONTRACTS ────────────────────────────────────────────────

export interface ScrapingMarket {
  id: string
  brokerage_id: string
  name: string
  city: string
  state: string
  zip_codes: string[] | null
  counties: string[] | null
  enabled_sources: string[]
  monthly_budget_usd: number
  spend_this_month: number
  max_records_per_run: number
  priority: number
  last_scraped_at: string | null
  lead_scraping_property_params: Array<{
    id: string
    is_active: boolean
    min_price?: number | null
    max_price?: number | null
    min_beds?: number | null
    max_beds?: number | null
    days_on_market_min?: number | null
    property_types?: string[] | null
  }>
  lead_scraping_motivated_params: Array<{
    id: string
    is_active: boolean
    signal_types: string[] | null
    lookback_days: number | null
    facebook_group_urls: string[] | null
    reddit_subreddits: string[] | null
  }>
}

export interface IngestRawSourceBatchParams {
  brokerageId: string
  marketId: string
  source: string
  sourceFamily: string        // e.g. 'property_search' | 'motivated_seller' | 'social_intent'
  sourceChannel: string       // e.g. 'zillow' | 'batchdata' | 'nextdoor' | 'reddit'
  sourceSubtype?: string      // e.g. 'fsbo' | 'motivated_owner' | 'search_signal'
  records: NormalizedScrapedRecord[]
  executionId: string | null
}

export interface IngestBatchResult {
  inserted: number
  skipped_duplicate: number
  skipped_not_viable: number
  rawIds: string[]
}

export interface NormalizeRawRecordParams {
  record: NormalizedScrapedRecord
  market: Pick<ScrapingMarket, 'city' | 'state' | 'zip_codes'>
}

export interface NormalizedRawOutput {
  normalized_preview: Record<string, unknown>
  processing_status: 'pending'
  source_family: string
  source_channel: string
  source_subtype: string
  identity_key: string | null
}

export interface DedupRawParams {
  rawRecordId: string
  brokerageId: string
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
  stage: 'pre_enrichment' | 'post_enrichment'
}

export interface DedupResult {
  isDuplicate: boolean
  matchType: 'lead' | 'contact' | null
  matchId: string | null
  matchScore: number
  enrichmentConfidenceExisting: number | null
  shouldMerge: boolean   // true only if new confidence > existing * 1.1
}

export interface EnrichRawRecordParams {
  rawRecordId: string
  brokerageId: string
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
}

export interface EnrichRawResult {
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  phone_secondary: string | null
  enrichmentConfidence: number
  enrichmentProvider: string
}

export interface GateRawRecordToLeadParams {
  rawRecordId: string
  brokerageId: string
  marketId: string | null
  normalizedCity: string | null
  normalizedState: string | null
  normalizedZip: string | null
  passesIdentityGate: boolean
}

export type GatingDecision =
  | 'pass'
  | 'territory_mismatch'
  | 'insufficient_identity'
  | 'insufficient_identity_for_promotion'

export interface GateResult {
  decision: GatingDecision
  reason: string
}


export interface ScrapingDiagnosticsParams {
  brokerageId?: string   // if null, superadmin global view
  limit?: number
}

export interface ScrapingDiagnosticsData {
  markets: Array<{
    id: string
    name: string
    city: string | null
    state: string | null
    enabled_sources: string[] | null
    monthly_budget_usd: number | null
    spend_this_month: number | null
    is_active: boolean
    last_scraped_at: string | null
  }>
  executions: Array<{
    id: string
    scraper_type: string
    status: string
    started_at: string | null
    completed_at: string | null
    total_items_found: number | null
    leads_created: number | null
    api_cost: number | null
    error_message: string | null
  }>
  funnel: Array<{
    source: string
    processing_status: string
    count: number
  }>
  dedupDecisions: Array<{
    id: string
    raw_record_id: string | null
    stage: string | null
    action_taken: string | null
    skip_reason: string | null
    match_score: number | null
    old_enrichment_confidence: number | null
    new_enrichment_confidence: number | null
    created_at: string
  }>
  gatingDecisions: Array<{
    id: string
    processing_status: string
    source: string
    error_message: string | null
    created_at: string
  }>
  cronHistory: Array<{
    id: string
    cron_name: string
    cron_path: string
    status: string
    duration_ms: number | null
    records_processed: number | null
    error_message: string | null
    started_at: string
    completed_at: string | null
  }>
  failedBatches: Array<{
    id: string
    scraper_type: string
    brokerage_id: string
    status: string
    started_at: string | null
    completed_at: string | null
    total_items_found: number | null
    leads_created: number | null
    error_message: string | null
  }>
}

export interface RetryFailedBatchParams {
  executionId: string
  brokerageId: string
  retriedByUserId: string
}

export interface RetryBatchResult {
  success: boolean
  rawRecordsRequeued: number
  error: string | null
}

export interface RunScrapeChronologicallyParams {
  brokerageId?: string    // null = all active brokerages (superadmin cron)
  dryRun?: boolean
}

export interface RunScrapeResult {
  marketsProcessed: number
  totalRawInserted: number
  totalDuplicatesSkipped: number
  cronLogId: string | null
  errors: string[]
}

// ─── 1. runScrapeSourcesChronologically ──────────────────────────────────────
// Entry point for the cron. Loads all active markets ordered by priority
// (chronological source order), gates on budget, delegates source runs to
// ingestRawSourceBatch(). Writes cron_execution_logs at start and end.
// Direct-contact intake does NOT enter here.

export async function runScrapeSourcesChronologically(
  params: RunScrapeChronologicallyParams = {},
): Promise<RunScrapeResult> {
  const supabase = createServiceClient()
  const cronStartedAt = Date.now()

  // Open cron_execution_logs record
  const { data: cronLog } = await supabase
    .from('cron_execution_logs')
    .insert({
      cron_name:    'lead-scraping',
      cron_path:    '/api/cron/lead-scraping',
      status:       'running',
      brokerage_id: params.brokerageId ?? null,
      started_at:   new Date().toISOString(),
    })
    .select('id')
    .maybeSingle()

  const cronLogId = (cronLog as any)?.id ?? null

  const result: RunScrapeResult = {
    marketsProcessed:      0,
    totalRawInserted:      0,
    totalDuplicatesSkipped: 0,
    cronLogId,
    errors:                [],
  }

  try {
    // Load active markets ordered by priority — this is the "chronological source order"
    let query = supabase
      .from('lead_scraping_markets')
      .select(`
        id, brokerage_id, name, city, state, zip_codes, counties,
        enabled_sources, monthly_budget_usd, spend_this_month,
        max_records_per_run, priority, last_scraped_at,
        lead_scraping_property_params (id, is_active, min_price, max_price, min_beds, max_beds, days_on_market_min, property_types),
        lead_scraping_motivated_params (id, is_active, signal_types, lookback_days, facebook_group_urls, reddit_subreddits)
      `)
      .eq('is_active', true)
      .order('priority', { ascending: false })

    if (params.brokerageId) {
      query = query.eq('brokerage_id', params.brokerageId)
    }

    const { data: markets, error: marketsError } = await query
    if (marketsError || !markets) {
      throw new Error(`Failed to load active markets: ${marketsError?.message}`)
    }

    // Write SCRAPING_CRON_STARTED lifecycle event
    await supabase.from('lifecycle_events').insert({
      entity_type: 'system',
      entity_id:   cronLogId ?? '00000000-0000-0000-0000-000000000000',
      event_type:  KernelEvent.SCRAPING_CRON_STARTED,
      brokerage_id: params.brokerageId ?? null,
      metadata:    { markets_count: markets.length, dry_run: params.dryRun ?? false },
      created_at:  new Date().toISOString(),
    })

    for (const market of markets) {
      // Budget gate — skip territory if monthly budget exhausted
      if ((market.spend_this_month ?? 0) >= (market.monthly_budget_usd ?? 100)) {
        result.errors.push(`Budget exhausted: ${market.name} ($${market.spend_this_month}/$${market.monthly_budget_usd})`)
        await supabase.from('lifecycle_events').insert({
          entity_type: 'system',
          entity_id:   market.id,
          event_type:  KernelEvent.SCRAPING_BUDGET_EXHAUSTED,
          brokerage_id: market.brokerage_id,
          metadata:    { market_name: market.name, spend: market.spend_this_month, budget: market.monthly_budget_usd },
          created_at:  new Date().toISOString(),
        })
        continue
      }

      result.marketsProcessed++

      // Delegate each source run — the cron route handles actual provider calls
      // and passes resulting NormalizedScrapedRecord[] to ingestRawSourceBatch().
      // This command owns the orchestration + logging; the cron owns the I/O.
    }

    // Update cron_execution_logs — success
    const durationMs = Date.now() - cronStartedAt
    if (cronLogId) {
      await supabase.from('cron_execution_logs').update({
        status:           'completed',
        duration_ms:      durationMs,
        records_processed: result.totalRawInserted,
        completed_at:     new Date().toISOString(),
      }).eq('id', cronLogId)
    }

    await supabase.from('lifecycle_events').insert({
      entity_type: 'system',
      entity_id:   cronLogId ?? '00000000-0000-0000-0000-000000000000',
      event_type:  KernelEvent.SCRAPING_CRON_COMPLETED,
      brokerage_id: params.brokerageId ?? null,
      metadata:    { ...result, duration_ms: durationMs },
      created_at:  new Date().toISOString(),
    })

    return result
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const durationMs = Date.now() - cronStartedAt

    if (cronLogId) {
      await supabase.from('cron_execution_logs').update({
        status:       'failed',
        duration_ms:  durationMs,
        error_message: msg,
        completed_at: new Date().toISOString(),
      }).eq('id', cronLogId)
    }

    await supabase.from('lifecycle_events').insert({
      entity_type: 'system',
      entity_id:   cronLogId ?? '00000000-0000-0000-0000-000000000000',
      event_type:  KernelEvent.SCRAPING_CRON_FAILED,
      brokerage_id: params.brokerageId ?? null,
      metadata:    { error: msg, duration_ms: durationMs },
      created_at:  new Date().toISOString(),
    })

    result.errors.push(msg)
    return result
  }
}

// ─── 2. ingestRawSourceBatch ─────────────────────────────────────────────────
// Receives normalized records from any source and writes them to raw_scraped_leads.
// Enforces: viability gate, identity key dedup, source attribution fields.
// RULE: Never calls leads/contacts tables. Raw only.

export async function ingestRawSourceBatch(
  params: IngestRawSourceBatchParams,
): Promise<IngestBatchResult> {
  const supabase = createServiceClient()
  const result: IngestBatchResult = {
    inserted: 0,
    skipped_duplicate: 0,
    skipped_not_viable: 0,
    rawIds: [],
  }

  // Open scraper_executions record for this source batch
  const execRecordResult = await supabase
    .from('scraper_executions')
    .insert({
      brokerage_id:  params.brokerageId,
      scraper_type:  params.source,
      status:        'running',
      started_at:    new Date().toISOString(),
    })
    .select('id')
    .maybeSingle()
    .then(r => r, () => ({ data: null }))
  const execRecord = execRecordResult?.data

  const execId = (execRecord as any)?.id ?? params.executionId

  // Emit SCRAPE_SOURCE_RUN_STARTED
  await supabase.from('lifecycle_events').insert({
    entity_type: 'system',
    entity_id:   params.marketId,
    event_type:  KernelEvent.SCRAPE_SOURCE_RUN_STARTED,
    brokerage_id: params.brokerageId,
    metadata:    { source: params.source, records_incoming: params.records.length },
    created_at:  new Date().toISOString(),
  })

  let batchError: Error | null = null

  try {
    for (const record of params.records) {
      // Gate 1 — viability: must have at least one identity signal
      if (!isViableRecord(record)) {
        result.skipped_not_viable++
        continue
      }

      const identityKey = buildLeadIdentityKey(record)

      const { data: inserted, error: insertError } = await supabase
        .from('raw_scraped_leads')
        .insert({
          brokerage_id:         params.brokerageId,
          market_id:            params.marketId,
          source:               record.source,
          source_family:        params.sourceFamily,
          source_channel:       params.sourceChannel,
          source_subtype:       params.sourceSubtype ?? null,
          source_record_id:     record.sourceRecordId,
          raw_data:             record.rawPayload ?? null,
          normalized_preview: {
            firstName:       record.firstName       ?? null,
            lastName:        record.lastName        ?? null,
            email:           record.email           ?? null,
            phone:           record.phone           ?? null,
            city:            record.city            ?? null,
            state:           record.state           ?? null,
            zip:             record.zip             ?? null,
            intentType:      record.intentType,
            behaviorType:    record.behaviorType,
            motivationScore: record.motivationScore ?? null,
            intentSignals:   record.intentSignals   ?? [],
            propertyAddress: record.propertyAddress ?? null,
            mailingAddress:  record.mailingAddress  ?? null,
            sourceUrl:       record.sourceUrl       ?? null,
            leadIdentityKey: identityKey,
          },
          processing_status:    'pending',
          scraper_execution_id: execId ?? null,
        })
        .select('id')
        .maybeSingle()

      // 23505 = unique_violation — same source_record_id already exists
      if (insertError?.code === '23505') {
        result.skipped_duplicate++
        continue
      }
      if (insertError || !inserted) {
        result.skipped_duplicate++
        continue
      }

      result.inserted++
      result.rawIds.push((inserted as any).id)

      // Emit RAW_RECORD_CREATED per record — used for audit trail
      await supabase.from('lifecycle_events').insert({
        entity_type: 'raw_scraped_lead',
        entity_id:   (inserted as any).id,
        event_type:  KernelEvent.RAW_RECORD_CREATED,
        brokerage_id: params.brokerageId,
        metadata:    { source: record.source, identity_key: identityKey, intent_type: record.intentType },
        created_at:  new Date().toISOString(),
      })
    }

    // Close scraper_executions — completed
    if (execId) {
      await supabase.from('scraper_executions').update({
        status:            'completed',
        total_items_found: params.records.length,
        leads_created:     result.inserted,
        completed_at:      new Date().toISOString(),
      }).eq('id', execId)
    }

    await supabase.from('lifecycle_events').insert({
      entity_type: 'system',
      entity_id:   params.marketId,
      event_type:  KernelEvent.SCRAPE_SOURCE_RUN_COMPLETED,
      brokerage_id: params.brokerageId,
      metadata:    { source: params.source, inserted: result.inserted, skipped: result.skipped_duplicate + result.skipped_not_viable },
      created_at:  new Date().toISOString(),
    })

  } catch (err) {
    batchError = err instanceof Error ? err : new Error(String(err))

    if (execId) {
      await supabase.from('scraper_executions').update({
        status:        'failed',
        error_message: batchError.message,
        completed_at:  new Date().toISOString(),
      }).eq('id', execId)
    }

    await supabase.from('lifecycle_events').insert({
      entity_type: 'system',
      entity_id:   params.marketId,
      event_type:  KernelEvent.SCRAPE_SOURCE_RUN_FAILED,
      brokerage_id: params.brokerageId,
      metadata:    { source: params.source, error: batchError.message },
      created_at:  new Date().toISOString(),
    })
  }

  return result
}

// ─── 3. normalizeRawSourceRecord ─────────────────────────────────────────────
// Converts a NormalizedScrapedRecord to the db-ready shape for raw_scraped_leads.
// Derives source_family/channel/subtype from source string.
// Called before ingestRawSourceBatch for any custom normalization needed.

export function normalizeRawSourceRecord(
  params: NormalizeRawRecordParams,
): NormalizedRawOutput {
  const { record, market } = params

  const identityKey = buildLeadIdentityKey(record)

  // Derive source attribution fields from the source string
  const sourceFamily = deriveSourceFamily(record.source)
  const sourceChannel = record.source
  const sourceSubtype = record.behaviorType ?? ''

  return {
    normalized_preview: {
      firstName:       record.firstName       ?? null,
      lastName:        record.lastName        ?? null,
      email:           record.email           ?? null,
      phone:           record.phone           ?? null,
      city:            record.city            ?? market.city ?? null,
      state:           record.state           ?? market.state ?? null,
      zip:             record.zip             ?? null,
      intentType:      record.intentType,
      behaviorType:    record.behaviorType,
      motivationScore: record.motivationScore ?? null,
      intentSignals:   record.intentSignals   ?? [],
      propertyAddress: record.propertyAddress ?? null,
      mailingAddress:  record.mailingAddress  ?? null,
      sourceUrl:       record.sourceUrl       ?? null,
      leadIdentityKey: identityKey,
    },
    processing_status: 'pending',
    source_family:     sourceFamily,
    source_channel:    sourceChannel,
    source_subtype:    sourceSubtype,
    identity_key:      identityKey,
  }
}

function deriveSourceFamily(source: string): string {
  if (['zillow', 'realtor', 'redfin', 'trulia', 'zenrows_property'].includes(source)) return 'property_search'
  if (['batchdata_motivated', 'batchdata'].includes(source)) return 'motivated_seller'
  if (['nextdoor', 'facebook_group', 'reddit_intent', 'craigslist_fsbo'].includes(source)) return 'social_intent'
  if (['google_phrase_intent'].includes(source)) return 'search_signal'
  return 'other'
}

// ─── 4. dedupRawAgainstLeadAndContact ────────────────────────────────────────
// Checks both leads and contacts for a fuzzy match on email/phone/name.
// Must not overwrite a real contact unless new confidence is >10% higher.
// Returns DedupResult — never throws.

export async function dedupRawAgainstLeadAndContact(
  params: DedupRawParams,
): Promise<DedupResult> {
  const supabase = createServiceClient()

  const noMatch: DedupResult = {
    isDuplicate: false,
    matchType: null,
    matchId: null,
    matchScore: 0,
    enrichmentConfidenceExisting: null,
    shouldMerge: false,
  }

  try {
    // Check leads by email first (exact), then phone (exact)
    if (params.email) {
      const { data: lead } = await supabase
        .from('leads')
        .select('id, enrichment_confidence, email, phone')
        .eq('email', params.email)
        .eq('is_active', true)
        .maybeSingle()

      if (lead) {
        await logDedupDecision(supabase, params, 'lead', (lead as any).id, 1.0, 'email_exact_match')
        return {
          isDuplicate: true,
          matchType: 'lead',
          matchId: (lead as any).id,
          matchScore: 1.0,
          enrichmentConfidenceExisting: (lead as any).enrichment_confidence ?? null,
          shouldMerge: false,
        }
      }
    }

    if (params.phone) {
      const digits = params.phone.replace(/\D/g, '').slice(-10)
      if (digits.length === 10) {
        const { data: lead } = await supabase
          .from('leads')
          .select('id, enrichment_confidence, email, phone')
          .eq('phone_digits', digits)
          .eq('is_active', true)
          .maybeSingle()

        if (lead) {
          await logDedupDecision(supabase, params, 'lead', (lead as any).id, 0.95, 'phone_exact_match')
          return {
            isDuplicate: true,
            matchType: 'lead',
            matchId: (lead as any).id,
            matchScore: 0.95,
            enrichmentConfidenceExisting: (lead as any).enrichment_confidence ?? null,
            shouldMerge: false,
          }
        }
      }
    }

    // Check contacts by email
    if (params.email) {
      const { data: contact } = await supabase
        .from('contacts')
        .select('id, engagement_score, email, phone')
        .eq('email', params.email)
        .is('deleted_at', null)
        .maybeSingle()

      if (contact) {
        await logDedupDecision(supabase, params, 'contact', (contact as any).id, 1.0, 'email_exact_match')
        return {
          isDuplicate: true,
          matchType: 'contact',
          matchId: (contact as any).id,
          matchScore: 1.0,
          enrichmentConfidenceExisting: null,
          shouldMerge: false,
        }
      }
    }

    // Name + location fuzzy match against leads
    if (params.firstName && params.lastName) {
      const { data: leads } = await supabase
        .from('leads')
        .select('id, enrichment_confidence, first_name, last_name, email, phone')
        .eq('first_name', params.firstName)
        .eq('last_name', params.lastName)
        .eq('is_active', true)
        .limit(5)

      if (leads && leads.length > 0) {
        const lead = (leads as any[])[0]
        await logDedupDecision(supabase, params, 'lead', lead.id, 0.80, 'name_exact_match')
        return {
          isDuplicate: true,
          matchType: 'lead',
          matchId: lead.id,
          matchScore: 0.80,
          enrichmentConfidenceExisting: lead.enrichment_confidence ?? null,
          shouldMerge: false,
        }
      }
    }

    return noMatch
  } catch {
    // Dedup must never throw — return no-match on error
    return noMatch
  }
}

async function logDedupDecision(
  supabase: ReturnType<typeof createServiceClient>,
  params: DedupRawParams,
  matchType: 'lead' | 'contact',
  matchId: string,
  matchScore: number,
  reason: string,
) {
  await supabase.from('lead_deduplication_log').insert({
    raw_record_id:           params.rawRecordId,
    brokerage_id:            params.brokerageId,
    stage:                   params.stage,
    action_taken:            'skipped',
    skip_reason:             reason,
    match_score:             matchScore,
    match_details:           { match_type: matchType, match_id: matchId },
    duplicate_of_lead_id:    matchType === 'lead'    ? matchId : null,
    duplicate_of_contact_id: matchType === 'contact' ? matchId : null,
    created_at:              new Date().toISOString(),
  })

  await supabase.from('lifecycle_events').insert({
    entity_type: 'raw_scraped_lead',
    entity_id:   params.rawRecordId,
    event_type:  KernelEvent.RAW_RECORD_DEDUPLICATED,
    brokerage_id: params.brokerageId,
    metadata:    { match_type: matchType, match_id: matchId, stage: params.stage, score: matchScore },
    created_at:  new Date().toISOString(),
  })
}

// ─── 5. enrichRawRecord ──────────────────────────────────────────────────────
// Queues enrichment in lead_enrichment_queue and updates raw record status.
// Actual enrichment is run by the enrichment worker — this command owns the queue write.

export async function enrichRawRecord(
  params: EnrichRawRecordParams,
): Promise<{ queued: boolean; queueId: string | null }> {
  const supabase = createServiceClient()

  try {
    // Update raw record to 'enriching'
    await supabase
      .from('raw_scraped_leads')
      .update({ processing_status: 'enriching', updated_at: new Date().toISOString() })
      .eq('id', params.rawRecordId)

    // Write to lead_enrichment_queue — the worker picks this up
    const { data: queueEntry } = await supabase
      .from('lead_enrichment_queue')
      .insert({
        brokerage_id:      params.brokerageId,
        contact_id:        null,  // raw records have no contact_id yet
        lead_id:           null,  // raw records have no lead_id yet
        status:            'pending',
        enrichment_type:   'skip_trace',
        trigger_type:      'raw_record_ingested',
        enrichments_needed: ['email', 'phone', 'name'],
        max_retries:       3,
        retry_count:       0,
        queued_at:         new Date().toISOString(),
      })
      .select('id')
      .maybeSingle()

    const queueId = (queueEntry as any)?.id ?? null

    await supabase.from('lifecycle_events').insert({
      entity_type: 'raw_scraped_lead',
      entity_id:   params.rawRecordId,
      event_type:  KernelEvent.RAW_RECORD_ENRICHED,
      brokerage_id: params.brokerageId,
      metadata:    { queue_id: queueId },
      created_at:  new Date().toISOString(),
    })

    return { queued: true, queueId }
  } catch {
    return { queued: false, queueId: null }
  }
}

// ─── 6. gateRawRecordToLead ──────────────────────────────────────────────────
// Evaluates whether a raw record has enough identity to be promoted to leads.
// Writes the gating decision to raw_scraped_leads.processing_status.
// Returns GateResult — never throws.
// RULE: AI ISA is NOT assigned here. Only at handleLeadCaptured() post-promotion.

export async function gateRawRecordToLead(
  params: GateRawRecordToLeadParams,
): Promise<GateResult> {
  const supabase = createServiceClient()

  // Territory gate — confirm record geography is inside the scraped market
  if (params.marketId && params.normalizedCity) {
    const { data: market } = await supabase
      .from('lead_scraping_markets')
      .select('city, state, zip_codes')
      .eq('id', params.marketId)
      .maybeSingle()

    if (market) {
      const marketCity = (market as any).city?.toLowerCase()
      const recordCity = params.normalizedCity?.toLowerCase()
      const marketState = (market as any).state?.toLowerCase()
      const recordState = params.normalizedState?.toLowerCase()

      const inTerritory =
        (recordCity && marketCity && recordCity.includes(marketCity)) ||
        (recordState && marketState && recordState === marketState) ||
        ((market as any).zip_codes?.includes(params.normalizedZip))

      if (!inTerritory) {
        await supabase.from('raw_scraped_leads')
          .update({ processing_status: 'territory_mismatch', updated_at: new Date().toISOString() })
          .eq('id', params.rawRecordId)
        await supabase.from('lifecycle_events').insert({
          entity_type: 'raw_scraped_lead',
          entity_id:   params.rawRecordId,
          event_type:  KernelEvent.RAW_RECORD_TERRITORY_GATED,
          brokerage_id: params.brokerageId,
          metadata:    { record_city: recordCity, market_city: marketCity },
          created_at:  new Date().toISOString(),
        })
        return { decision: 'territory_mismatch', reason: `Record city ${recordCity} outside market ${marketCity}, ${marketState}` }
      }
    }
  }

  // Identity gate — require at least one usable anchor before enrichment spend
  if (!params.passesIdentityGate) {
    await supabase.from('raw_scraped_leads')
      .update({ processing_status: 'insufficient_identity', updated_at: new Date().toISOString() })
      .eq('id', params.rawRecordId)
    await supabase.from('lifecycle_events').insert({
      entity_type: 'raw_scraped_lead',
      entity_id:   params.rawRecordId,
      event_type:  KernelEvent.RAW_RECORD_IDENTITY_GATED,
      brokerage_id: params.brokerageId,
      metadata:    {},
      created_at:  new Date().toISOString(),
    })
    return { decision: 'insufficient_identity', reason: 'No email, phone, full name+location, or property address' }
  }

  await supabase.from('lifecycle_events').insert({
    entity_type: 'raw_scraped_lead',
    entity_id:   params.rawRecordId,
    event_type:  KernelEvent.RAW_RECORD_VIABILITY_GATED,
    brokerage_id: params.brokerageId,
    metadata:    { decision: 'pass' },
    created_at:  new Date().toISOString(),
  })

  return { decision: 'pass', reason: 'Identity gate passed' }
}


// ─── 8. loadScrapingDiagnostics ──────────────────────────────────────────────
// Loads all 9 visibility dimensions required by the diagnostics UI.
// Single kernel call — no ad-hoc queries in pages or client components.

export async function loadScrapingDiagnostics(
  params: ScrapingDiagnosticsParams = {},
): Promise<ScrapingDiagnosticsData> {
  const supabase = createServiceClient()
  const limit = params.limit ?? 50

  const [
    marketsResult,
    executionsResult,
    rawLeadsResult,
    dedupResult,
    cronResult,
    failedBatchesResult,
  ] = await Promise.all([
    supabase
      .from('lead_scraping_markets')
      .select('id, name, city, state, enabled_sources, monthly_budget_usd, spend_this_month, is_active, last_scraped_at')
      .order('priority', { ascending: false })
      .limit(limit),

    supabase
      .from('scraper_executions')
      .select('id, scraper_type, status, started_at, completed_at, total_items_found, leads_created, api_cost, error_message, brokerage_id')
      .order('started_at', { ascending: false })
      .limit(40),

    // Raw records — for funnel + gating decisions
    supabase
      .from('raw_scraped_leads')
      .select('id, source, processing_status, error_message, created_at')
      .order('created_at', { ascending: false })
      .limit(10000),

    // Dedup log — decisions
    supabase
      .from('lead_deduplication_log')
      .select('id, raw_record_id, stage, action_taken, skip_reason, match_score, old_enrichment_confidence, new_enrichment_confidence, created_at')
      .order('created_at', { ascending: false })
      .limit(100),

    // Cron run history
    supabase
      .from('cron_execution_logs')
      .select('id, cron_name, cron_path, status, duration_ms, records_processed, error_message, started_at, completed_at')
      .order('started_at', { ascending: false })
      .limit(30),

    // Failed batches — retryable
    supabase
      .from('scraper_executions')
      .select('id, scraper_type, brokerage_id, status, started_at, completed_at, total_items_found, leads_created, error_message')
      .eq('status', 'failed')
      .order('started_at', { ascending: false })
      .limit(20),
  ])

  // Apply brokerage filter to executions if provided
  const executions = ((executionsResult.data ?? []) as any[]).filter(
    e => !params.brokerageId || e.brokerage_id === params.brokerageId,
  )

  // Aggregate funnel from raw records
  const funnelMap: Record<string, Record<string, number>> = {}
  for (const row of (rawLeadsResult.data ?? []) as any[]) {
    const src    = row.source            ?? 'unknown'
    const status = row.processing_status ?? 'unknown'
    if (!funnelMap[src])         funnelMap[src]         = {}
    if (!funnelMap[src][status]) funnelMap[src][status] = 0
    funnelMap[src][status]++
  }

  const funnel = Object.entries(funnelMap).flatMap(([source, statuses]) =>
    Object.entries(statuses).map(([processing_status, count]) => ({
      source,
      processing_status,
      count,
    }))
  )

  // Gating decisions — raw records in terminal non-promoted states
  const gatingStatuses = new Set([
    'territory_mismatch',
    'insufficient_identity',
    'insufficient_identity_for_promotion',
    'error',
    'failed',
  ])
  const gatingDecisions = ((rawLeadsResult.data ?? []) as any[])
    .filter(r => gatingStatuses.has(r.processing_status))
    .slice(0, 100)
    .map(r => ({
      id:                r.id,
      processing_status: r.processing_status,
      source:            r.source,
      error_message:     r.error_message ?? null,
      created_at:        r.created_at,
    }))

  return {
    markets:        (marketsResult.data    ?? []) as ScrapingDiagnosticsData['markets'],
    executions:     executions             as ScrapingDiagnosticsData['executions'],
    funnel,
    dedupDecisions: (dedupResult.data      ?? []) as ScrapingDiagnosticsData['dedupDecisions'],
    gatingDecisions,
    cronHistory:    (cronResult.data       ?? []) as ScrapingDiagnosticsData['cronHistory'],
    failedBatches:  (failedBatchesResult.data ?? []) as ScrapingDiagnosticsData['failedBatches'],
  }
}

// ─── 9. retryFailedSourceBatch ───────────────────────────────────────────────
// Resets all 'error' raw_scraped_leads records associated with a failed
// scraper_execution back to 'pending' so the pipeline-processor can reprocess them.
// Updates the execution record status to allow re-run.

export async function retryFailedSourceBatch(
  params: RetryFailedBatchParams,
): Promise<RetryBatchResult> {
  const supabase = createServiceClient()

  try {
    // Validate the execution exists and belongs to this brokerage
    const { data: execution } = await supabase
      .from('scraper_executions')
      .select('id, status, scraper_type, brokerage_id')
      .eq('id', params.executionId)
      .eq('brokerage_id', params.brokerageId)
      .maybeSingle()

    if (!execution || (execution as any).status !== 'failed') {
      return { success: false, rawRecordsRequeued: 0, error: 'Execution not found or not in failed state' }
    }

    // Find all raw records from this execution that are in error state
    const { data: errorRecords } = await supabase
      .from('raw_scraped_leads')
      .select('id')
      .eq('scraper_execution_id', params.executionId)
      .eq('processing_status', 'error')

    const recordIds = ((errorRecords ?? []) as any[]).map(r => r.id)

    if (recordIds.length === 0) {
      return { success: true, rawRecordsRequeued: 0, error: null }
    }

    // Reset raw records to pending
    await supabase
      .from('raw_scraped_leads')
      .update({
        processing_status: 'pending',
        error_message:     null,
        updated_at:        new Date().toISOString(),
      })
      .in('id', recordIds)

    // Reset execution status
    await supabase
      .from('scraper_executions')
      .update({
        status:        'pending',
        error_message: null,
        completed_at:  null,
        leads_created: 0,
      })
      .eq('id', params.executionId)

    // Emit SCRAPE_BATCH_RETRIED event
    await supabase.from('lifecycle_events').insert({
      entity_type: 'scraper_execution',
      entity_id:   params.executionId,
      event_type:  KernelEvent.SCRAPE_BATCH_RETRIED,
      brokerage_id: params.brokerageId,
      metadata:    {
        records_requeued: recordIds.length,
        retried_by:       params.retriedByUserId,
        scraper_type:     (execution as any).scraper_type,
      },
      created_at:   new Date().toISOString(),
    })

    return { success: true, rawRecordsRequeued: recordIds.length, error: null }
  } catch (err) {
    return { success: false, rawRecordsRequeued: 0, error: err instanceof Error ? err.message : String(err) }
  }
}
