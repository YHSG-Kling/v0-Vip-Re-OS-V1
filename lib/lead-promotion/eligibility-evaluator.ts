'use server'

import { createServiceClient } from '@/lib/supabase/service'

interface EligibilityResult {
  eligible: boolean
  reason: string
  rawRecord?: any
  dedupLog?: any
}

/**
 * Evaluates whether a raw record is eligible for promotion to leads.
 * Reads existing enrichment and dedup outputs - does NOT re-run them.
 * 
 * Returns eligible: true only if:
 * 1. Enrichment is marked complete in pipeline processor
 * 2. Record is NOT marked as duplicate in dedup log
 * 3. Required identity fields exist
 */
export async function evaluatePromotionEligibility(
  rawRecordId: string
): Promise<EligibilityResult> {
  const supabase = createServiceClient()

  // 1. Fetch the raw record
  const { data: rawRecord, error: rawError } = await supabase
    .from('raw_scraped_leads')
    .select('*')
    .eq('id', rawRecordId)
    .single()

  if (rawError || !rawRecord) {
    return {
      eligible: false,
      reason: 'Raw record not found',
    }
  }

  // 2. Check if record has been enriched via the pipeline processor.
  // The pipeline processor terminal statuses are 'promoted', 'duplicate_post_enrich',
  // 'insufficient_identity_for_promotion', or 'error'.
  // 'promoted' means the record already became a lead — reject further promotion.
  // Allow re-evaluation only for 'insufficient_identity_for_promotion' (may gain identity via retry).
  const terminalStatuses = ['promoted', 'duplicate_pre_enrich', 'duplicate_post_enrich', 'territory_mismatch', 'error']
  if (terminalStatuses.includes(rawRecord.processing_status)) {
    return {
      eligible: false,
      reason: `Record is in terminal status: ${rawRecord.processing_status}`,
      rawRecord,
    }
  }
  const enrichedStatuses = ['enriching', 'queued_for_enrichment', 'insufficient_identity_for_promotion']
  if (!enrichedStatuses.includes(rawRecord.processing_status) && rawRecord.processing_status !== 'pending') {
    return {
      eligible: false,
      reason: `Enrichment not complete. Current status: ${rawRecord.processing_status}`,
      rawRecord,
    }
  }

  // 3. Check deduplication log - consume existing dedup output
  const { data: dedupLog } = await supabase
    .from('lead_deduplication_log')
    .select('*')
    .eq('raw_record_id', rawRecordId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  // If dedup log says it's a duplicate, reject promotion
  if (dedupLog && dedupLog.action_taken === 'merged') {
    return {
      eligible: false,
      reason: 'Record was merged with existing lead/contact',
      rawRecord,
      dedupLog,
    }
  }

  if (dedupLog && dedupLog.action_taken === 'skipped' && dedupLog.skip_reason) {
    return {
      eligible: false,
      reason: `Skipped: ${dedupLog.skip_reason}`,
      rawRecord,
      dedupLog,
    }
  }

  // 4. Verify required identity fields exist in raw_data
  const rawData = rawRecord.raw_data || {}
  const hasRequiredFields = 
    rawData.first_name && 
    rawData.last_name && 
    (rawData.email || rawData.phone)

  if (!hasRequiredFields) {
    return {
      eligible: false,
      reason: 'Missing required identity fields (first_name, last_name, email or phone)',
      rawRecord,
      dedupLog,
    }
  }

  // 5. All checks passed - eligible for promotion
  return {
    eligible: true,
    reason: 'All eligibility checks passed',
    rawRecord,
    dedupLog,
  }
}
