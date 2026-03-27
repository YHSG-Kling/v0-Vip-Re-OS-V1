'use server'

import { createClient } from '@/lib/supabase/server'
import { calculateFuzzyMatch } from './fuzzy-matcher'
import { skipTraceWithPeopleData } from '@/lib/external'

// ─── Processing status state machine ─────────────────────────────────────────
// pending → processing → queued_for_enrichment | duplicate_pre_enrich
//   → enriching → duplicate_post_enrich | territory_mismatch
//   | insufficient_contact_data | insufficient_identity
//   | insufficient_identity_for_promotion → promoted | error
// ─────────────────────────────────────────────────────────────────────────────

type ProcessingStatus =
  | 'pending'
  | 'processing'
  | 'queued_for_enrichment'
  | 'duplicate_pre_enrich'
  | 'enriching'
  | 'duplicate_post_enrich'
  | 'territory_mismatch'
  | 'insufficient_contact_data'
  | 'insufficient_identity'
  | 'insufficient_identity_for_promotion'
  | 'promoted'
  | 'error'

// RawRecord shape after reading from raw_scraped_leads
interface RawRecord {
  id: string
  brokerage_id: string
  market_id: string | null
  source: string
  source_record_id: string | null
  processing_status: ProcessingStatus
  raw_data: Record<string, unknown> | null
  normalized_preview: {
    firstName?: string | null
    lastName?: string | null
    email?: string | null
    phone?: string | null
    city?: string | null
    state?: string | null
    intentType?: string
    behaviorType?: string
    motivationScore?: number | null
    intentSignals?: string[]
    propertyAddress?: string | null
    sourceUrl?: string | null
    leadIdentityKey?: string | null
  } | null
  lead_id: string | null
  error_message: string | null
}

export interface PipelineResult {
  success: boolean
  action: 'created' | 'merged' | 'skipped'
  leadId?: string
  reason: string
  stage: string
}

// Helper — update processing_status on raw_scraped_leads
async function setStatus(
  supabase: Awaited<ReturnType<typeof createClient>>,
  rawRecordId: string,
  status: ProcessingStatus,
  errorMessage?: string,
) {
  await supabase
    .from('raw_scraped_leads')
    .update({
      processing_status: status,
      ...(errorMessage ? { error_message: errorMessage } : {}),
      ...(status === 'promoted' || status === 'error' ? { processed_at: new Date().toISOString() } : {}),
    })
    .eq('id', rawRecordId)
}

export async function processRawRecord(rawRecordId: string, brokerageId: string): Promise<PipelineResult> {
  const supabase = await createClient()

  // ── STEP 3: Read from raw_scraped_leads (not batchdata_motivated_sellers_raw) ──
  await setStatus(supabase, rawRecordId, 'processing')

  const { data: rawRecord, error: fetchError } = await supabase
    .from('raw_scraped_leads')
    .select('*')
    .eq('id', rawRecordId)
    .single()

  if (fetchError || !rawRecord) {
    return {
      success: false,
      action: 'skipped',
      reason: 'Raw record not found',
      stage: 'fetch',
    }
  }

  const rec = rawRecord as RawRecord

  // ── STEP 3: Resolve fields from normalized_preview with raw_data fallback ──
  const firstName  = rec.normalized_preview?.firstName  ?? (rec.raw_data?.firstName  as string | undefined) ?? null
  const lastName   = rec.normalized_preview?.lastName   ?? (rec.raw_data?.lastName   as string | undefined) ?? null
  const email      = rec.normalized_preview?.email      ?? (rec.raw_data?.email      as string | undefined) ?? null
  const phone      = rec.normalized_preview?.phone      ?? (rec.raw_data?.phone      as string | undefined) ?? null
  const city       = rec.normalized_preview?.city       ?? (rec.raw_data?.city       as string | undefined) ?? null
  const state      = rec.normalized_preview?.state      ?? (rec.raw_data?.state      as string | undefined) ?? null

  // ── STEP 4B: Identity gate — require at least one usable anchor ────────────
  // Anchors: email, phone, full name + location, or property address.
  const hasEmail           = !!email?.trim()
  const hasPhone           = !!phone?.trim()
  const hasFullNameAndLoc  = !!(firstName && lastName && (city || state))
  const hasPropertyAddress = !!(rec.normalized_preview?.propertyAddress ?? rec.raw_data?.propertyAddress)
  const passesIdentityGate = hasEmail || hasPhone || hasFullNameAndLoc || hasPropertyAddress

  if (!passesIdentityGate) {
    await setStatus(supabase, rawRecordId, 'insufficient_identity')
    await logDeduplication({
      raw_record_id:            rawRecordId,
      stage:                    'identity_gate',
      match_score:              0,
      match_details:            {},
      action_taken:             'skipped',
      skip_reason:              'No usable identity anchor for enrichment spend',
      new_enrichment_confidence: null,
    }, supabase)
    return {
      success: false,
      action: 'skipped',
      reason: 'No usable identity anchor for enrichment spend',
      stage: 'identity_gate',
    }
  }

  // ── Pre-enrichment deduplication ────────────────────────────────────────────
  await setStatus(supabase, rawRecordId, 'queued_for_enrichment')

  const preEnrichLookup = { first_name: firstName, last_name: lastName, email, phone }
  const preEnrichDuplicate = await findBestMatch(preEnrichLookup, 'pre_enrichment', supabase)

  if (preEnrichDuplicate) {
    await setStatus(supabase, rawRecordId, 'duplicate_pre_enrich')
    await logDeduplication({
      raw_record_id:             rawRecordId,
      duplicate_of_lead_id:      preEnrichDuplicate.type === 'lead'    ? preEnrichDuplicate.id : null,
      duplicate_of_contact_id:   preEnrichDuplicate.type === 'contact' ? preEnrichDuplicate.id : null,
      stage:                     'pre_enrichment',
      match_score:               preEnrichDuplicate.score,
      match_details:             preEnrichDuplicate.details,
      action_taken:              'skipped',
      skip_reason:               'Pre-enrichment duplicate found',
      old_enrichment_confidence: preEnrichDuplicate.enrichment_confidence,
      new_enrichment_confidence: null,
    }, supabase)
    return {
      success: false,
      action: 'skipped',
      reason: 'Pre-enrichment duplicate found',
      stage: 'pre_enrichment_dedup',
    }
  }

  // ── Enrichment ──────────────────────────────────────────────────────────────
  await setStatus(supabase, rawRecordId, 'enriching')

  const enriched = await enrichWithPeopleData({ first_name: firstName, last_name: lastName, email, phone })

  // ── Post-enrichment deduplication ───────────────────────────────────────────
  const postEnrichDuplicate = await findBestMatch(enriched, 'post_enrichment', supabase)

  if (postEnrichDuplicate) {
    const oldConfidence = postEnrichDuplicate.enrichment_confidence ?? 0
    const newConfidence = enriched.enrichmentConfidence ?? 0

    if (newConfidence > oldConfidence * 1.1) {
      const targetTable = postEnrichDuplicate.type === 'lead' ? 'leads' : 'contacts'

      await supabase
        .from(targetTable)
        .update({
          email:                enriched.email  || postEnrichDuplicate.email,
          phone:                enriched.phone  || postEnrichDuplicate.phone,
          enrichment_status:    'completed',
          enrichment_confidence: newConfidence,
          updated_at:           new Date().toISOString(),
        })
        .eq('id', postEnrichDuplicate.id)

      await setStatus(supabase, rawRecordId, 'duplicate_post_enrich')
      await logDeduplication({
        raw_record_id:             rawRecordId,
        lead_id:                   postEnrichDuplicate.type === 'lead'    ? postEnrichDuplicate.id : null,
        duplicate_of_lead_id:      postEnrichDuplicate.type === 'lead'    ? postEnrichDuplicate.id : null,
        duplicate_of_contact_id:   postEnrichDuplicate.type === 'contact' ? postEnrichDuplicate.id : null,
        stage:                     'post_enrichment',
        match_score:               postEnrichDuplicate.score,
        match_details:             postEnrichDuplicate.details,
        action_taken:              'merged',
        skip_reason:               null,
        old_enrichment_confidence: oldConfidence,
        new_enrichment_confidence: newConfidence,
      }, supabase)

      return {
        success: true,
        action: 'merged',
        leadId: postEnrichDuplicate.id,
        reason: 'Merged with existing record (higher confidence)',
        stage: 'post_enrichment_dedup',
      }
    } else {
      await setStatus(supabase, rawRecordId, 'duplicate_post_enrich')
      await logDeduplication({
        raw_record_id:             rawRecordId,
        duplicate_of_lead_id:      postEnrichDuplicate.type === 'lead'    ? postEnrichDuplicate.id : null,
        duplicate_of_contact_id:   postEnrichDuplicate.type === 'contact' ? postEnrichDuplicate.id : null,
        stage:                     'post_enrichment',
        match_score:               postEnrichDuplicate.score,
        match_details:             postEnrichDuplicate.details,
        action_taken:              'skipped',
        skip_reason:               'Existing record has equal or better confidence',
        old_enrichment_confidence: oldConfidence,
        new_enrichment_confidence: newConfidence,
      }, supabase)

      return {
        success: false,
        action: 'skipped',
        leadId: postEnrichDuplicate.id,
        reason: 'Duplicate found with better/equal confidence',
        stage: 'post_enrichment_dedup',
      }
    }
  }

  // ── STEP 4B: Promotion identity gate ────────────────────────────────────────
  // A record may remain raw without promotion if it has no email after enrichment.
  if (!enriched.email) {
    await setStatus(supabase, rawRecordId, 'insufficient_identity_for_promotion')
    await logDeduplication({
      raw_record_id:             rawRecordId,
      stage:                     'promotion_identity_gate',
      match_score:               0,
      match_details:             {},
      action_taken:              'skipped',
      skip_reason:               'No email after enrichment — cannot promote for AI ISA',
      new_enrichment_confidence: enriched.enrichmentConfidence,
    }, supabase)
    return {
      success: false,
      action: 'skipped',
      reason: 'No email after enrichment — record remains raw without promotion',
      stage: 'promotion_identity_gate',
    }
  }

  // ── STEP 5: Promote to leads with Kernel OS ownership fields ────────────────
  const { data: newLead, error: createError } = await supabase
    .from('leads')
    .insert({
      brokerage_id:          brokerageId,
      first_name:            enriched.first_name  ?? firstName,
      last_name:             enriched.last_name   ?? lastName,
      email:                 enriched.email,
      phone:                 enriched.phone        ?? phone,
      phone_secondary:       enriched.phone_secondary ?? null,
      source:                rec.source,            // STEP 5 — source from raw record
      lead_type:             rec.normalized_preview?.intentType ?? null,
      motivation_type:       (rec.raw_data?.motivation_type    as string | null) ?? null,
      motivation_confidence: (rec.raw_data?.motivation_confidence as number | null) ?? null,
      enrichment_status:     'completed',
      enrichment_confidence: enriched.enrichmentConfidence,
      last_enriched_at:      new Date().toISOString(),
      lead_stage:            'new',
      source_raw_ids:        [rawRecordId],
      // STEP 5 — Kernel OS ISA ownership fields
      lifecycle_state:       'unconsented',
      ai_isa_owner:          true,
      minimum_viable_for_isa: !!(enriched.email),
      raw_record_id:         rawRecordId,
    })
    .select()
    .single()

  if (createError || !newLead) {
    await setStatus(supabase, rawRecordId, 'error', createError?.message)
    throw new Error(`Failed to create lead: ${createError?.message}`)
  }

  // ── STEP 3: Update raw_scraped_leads with lead_id and promoted status ───────
  await supabase
    .from('raw_scraped_leads')
    .update({
      lead_id:           newLead.id,
      processing_status: 'promoted' as ProcessingStatus,
      processed_at:      new Date().toISOString(),
    })
    .eq('id', rawRecordId)

  await logDeduplication({
    raw_record_id:             rawRecordId,
    lead_id:                   newLead.id,
    stage:                     'lead_creation',
    match_score:               0,
    match_details:             {},
    action_taken:              'created',
    skip_reason:               null,
    new_enrichment_confidence: enriched.enrichmentConfidence,
  }, supabase)

  return {
    success: true,
    action: 'created',
    leadId: newLead.id,
    reason: 'New lead created successfully',
    stage: 'lead_creation',
  }
}

// ─── Enrichment ───────────────────────────────────────────────────────────────

async function enrichWithPeopleData(fields: {
  first_name: string | null
  last_name:  string | null
  email:      string | null
  phone:      string | null
}): Promise<any> {
  const enrichmentResult = await skipTraceWithPeopleData({
    name:  [fields.first_name, fields.last_name].filter(Boolean).join(' ') || undefined,
    phone: fields.phone   || undefined,
    email: fields.email   || undefined,
  }).catch(() => ({ data: null }))

  if (!enrichmentResult.data) {
    return {
      first_name: fields.first_name,
      last_name:  fields.last_name,
      email:      fields.email,
      phone:      fields.phone,
      enrichmentConfidence: 0.3,
    }
  }

  const data = enrichmentResult.data
  return {
    first_name:           data.firstName   || fields.first_name,
    last_name:            data.lastName    || fields.last_name,
    email:                data.emails?.[0] || fields.email,
    phone:                data.phones?.[0] || fields.phone,
    phone_secondary:      data.phones?.[1] || null,
    enrichmentConfidence: data.enrichmentConfidence ?? 0.5,
    peopleDataResult:     data,
  }
}

// ─── Deduplication matching ───────────────────────────────────────────────────

async function findBestMatch(
  record: { first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null },
  _stage: string,
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ id: string; type: 'lead' | 'contact'; score: number; details: any; enrichment_confidence: number | null; email?: string; phone?: string } | null> {

  const { data: leads } = await supabase
    .from('leads')
    .select('id, first_name, last_name, email, phone, enrichment_confidence')
    .eq('is_active', true)

  const { data: contacts } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, email, phone')
    .is('deleted_at', null)

  const allRecords = [
    ...(leads    || []).map((l: any) => ({ ...l, type: 'lead'    as const })),
    ...(contacts || []).map((c: any) => ({ ...c, type: 'contact' as const, enrichment_confidence: null })),
  ]

  let bestMatch: typeof allRecords[0] & { score: number; details: any } | null = null
  let highestScore = 0.75

  for (const existing of allRecords) {
    const { score, details } = calculateFuzzyMatch(record as any, existing)
    if (score > highestScore) {
      highestScore = score
      bestMatch = { ...existing, score, details }
    }
  }

  return bestMatch
}

// ─── Audit logging ────────────────────────────────────────────────────────────

async function logDeduplication(log: any, supabase: Awaited<ReturnType<typeof createClient>>) {
  await supabase.from('lead_deduplication_log').insert(log).catch(() => {})
}
