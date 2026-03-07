'use server'

import { createClient } from '@/lib/supabase/server'
import { calculateFuzzyMatch } from './fuzzy-matcher'
import { skipTraceWithPeopleData } from '@/lib/external'

interface RawRecord {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  residential_address?: string | null
  motivation_type?: string | null
  motivation_confidence?: number | null
  property_address?: string | null
  [key: string]: any
}

export interface PipelineResult {
  success: boolean
  action: 'created' | 'merged' | 'skipped'
  leadId?: string
  reason: string
  stage: string
}

export async function processRawRecord(rawRecordId: string, brokerageId: string): Promise<PipelineResult> {
    const supabase = await createClient()

    const { data: rawRecord, error: fetchError } = await supabase
      .from('batchdata_motivated_sellers_raw')
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

    const hasMinimalData = 
      rawRecord.first_name &&
      rawRecord.last_name &&
      (rawRecord.email || rawRecord.phone)

    if (!hasMinimalData) {
      return {
        success: false,
        action: 'skipped',
        reason: 'Missing required fields: first_name, last_name, and (email OR phone)',
        stage: 'validation',
      }
    }

    const preEnrichDuplicate = await findBestMatch(
      rawRecord,
      'pre_enrichment',
      supabase
    )

    if (preEnrichDuplicate) {
      await logDeduplication({
        raw_record_id: rawRecordId,
        duplicate_of_lead_id: preEnrichDuplicate.type === 'lead' ? preEnrichDuplicate.id : null,
        duplicate_of_contact_id: preEnrichDuplicate.type === 'contact' ? preEnrichDuplicate.id : null,
        stage: 'pre_enrichment',
        match_score: preEnrichDuplicate.score,
        match_details: preEnrichDuplicate.details,
        action_taken: 'queued_for_enrichment',
        skip_reason: null,
        old_enrichment_confidence: preEnrichDuplicate.enrichment_confidence,
        new_enrichment_confidence: null,
      }, supabase)
    }

    const enriched = await enrichWithPeopleData(rawRecord)

    const postEnrichDuplicate = await findBestMatch(
      enriched,
      'post_enrichment',
      supabase
    )

    if (postEnrichDuplicate) {
      const oldConfidence = postEnrichDuplicate.enrichment_confidence || 0
      const newConfidence = enriched.enrichmentConfidence || 0

      if (newConfidence > oldConfidence * 1.1) {
        const targetTable = postEnrichDuplicate.type === 'lead' ? 'leads' : 'contacts'
        
        await supabase
          .from(targetTable)
          .update({
            email: enriched.email || postEnrichDuplicate.email,
            phone: enriched.phone || postEnrichDuplicate.phone,
            enrichment_status: 'completed',
            enrichment_confidence: newConfidence,
            updated_at: new Date().toISOString(),
          })
          .eq('id', postEnrichDuplicate.id)

        await logDeduplication({
          raw_record_id: rawRecordId,
          lead_id: postEnrichDuplicate.type === 'lead' ? postEnrichDuplicate.id : null,
          duplicate_of_lead_id: postEnrichDuplicate.type === 'lead' ? postEnrichDuplicate.id : null,
          duplicate_of_contact_id: postEnrichDuplicate.type === 'contact' ? postEnrichDuplicate.id : null,
          stage: 'post_enrichment',
          match_score: postEnrichDuplicate.score,
          match_details: postEnrichDuplicate.details,
          action_taken: 'merged',
          skip_reason: null,
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
        await logDeduplication({
          raw_record_id: rawRecordId,
          duplicate_of_lead_id: postEnrichDuplicate.type === 'lead' ? postEnrichDuplicate.id : null,
          duplicate_of_contact_id: postEnrichDuplicate.type === 'contact' ? postEnrichDuplicate.id : null,
          stage: 'post_enrichment',
          match_score: postEnrichDuplicate.score,
          match_details: postEnrichDuplicate.details,
          action_taken: 'skipped',
          skip_reason: 'Existing record has equal or better confidence',
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

    if (!enriched.email) {
      await logDeduplication({
        raw_record_id: rawRecordId,
        stage: 'viability_gate',
        match_score: 0,
        match_details: {},
        action_taken: 'skipped',
        skip_reason: 'No email - required for AI ISA automation',
        new_enrichment_confidence: enriched.enrichmentConfidence,
      }, supabase)

      return {
        success: false,
        action: 'skipped',
        reason: 'No email address - required for AI ISA',
        stage: 'viability_gate',
      }
    }

    const { data: newLead, error: createError } = await supabase
      .from('leads')
      .insert({
        brokerage_id: brokerageId,
        first_name: enriched.first_name,
        last_name: enriched.last_name,
        email: enriched.email,
        phone: enriched.phone,
        phone_secondary: enriched.phone_secondary || null,
        source: 'batchdata',
        lead_type: rawRecord.motivation_type,
        property_interest: rawRecord.property_address,
        motivation_type: rawRecord.motivation_type,
        motivation_confidence: rawRecord.motivation_confidence,
        enrichment_status: 'completed',
        enrichment_confidence: enriched.enrichmentConfidence,
        last_enriched_at: new Date().toISOString(),
        lead_stage: 'new',
        source_raw_ids: [rawRecordId],
      })
      .select()
      .single()

    if (createError || !newLead) {
      throw new Error(`Failed to create lead: ${createError?.message}`)
    }

    await supabase
      .from('batchdata_motivated_sellers_raw')
      .update({ lead_id: newLead.id })
      .eq('id', rawRecordId)

    await logDeduplication({
      raw_record_id: rawRecordId,
      lead_id: newLead.id,
      stage: 'lead_creation',
      match_score: 0,
      match_details: {},
      action_taken: 'created',
      skip_reason: null,
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

async function enrichWithPeopleData(rawRecord: RawRecord): Promise<any> {
    const enrichmentResult = await skipTraceWithPeopleData({
      name: `${rawRecord.first_name} ${rawRecord.last_name}`,
      phone: rawRecord.phone || undefined,
      email: rawRecord.email || undefined,
      address: rawRecord.residential_address || undefined,
    })

    if (!enrichmentResult.data) {
      return {
        ...rawRecord,
        email: rawRecord.email,
        phone: rawRecord.phone,
        enrichmentConfidence: 0.3,
      }
    }

    const data = enrichmentResult.data

    return {
      ...rawRecord,
      first_name: data.firstName || rawRecord.first_name,
      last_name: data.lastName || rawRecord.last_name,
      email: data.emails[0] || rawRecord.email,
      phone: data.phones[0] || rawRecord.phone,
      phone_secondary: data.phones[1] || null,
      enrichmentConfidence: data.enrichmentConfidence,
      peopleDataResult: data,
    }
  }

async function findBestMatch(
    record: RawRecord,
    stage: string,
    supabase: any
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
      ...(leads || []).map((l: any) => ({ ...l, type: 'lead' as const })),
      ...(contacts || []).map((c: any) => ({ ...c, type: 'contact' as const, enrichment_confidence: null })),
    ]

    let bestMatch: typeof allRecords[0] & { score: number; details: any } | null = null
    let highestScore = 0.75

    for (const existing of allRecords) {
      const { score, details } = calculateFuzzyMatch(record, existing)

      if (score > highestScore) {
        highestScore = score
        bestMatch = { ...existing, score, details }
      }
    }

    return bestMatch
  }

async function logDeduplication(log: any, supabase: any) {
  await supabase
    .from('lead_deduplication_log')
    .insert(log)
}
