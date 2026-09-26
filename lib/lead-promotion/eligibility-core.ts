/**
 * lib/lead-promotion/eligibility-core.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The eligibility read, WITHOUT the "use server" marker.
 *
 * This body used to live in eligibility-evaluator.ts, which is a `"use server"`
 * file — and in one of those, EVERY export is a public HTTP endpoint. So
 * `evaluatePromotionEligibility(rawRecordId)` was a POST anyone could make: it
 * took an id, ran a SERVICE-ROLE client (RLS bypassed), and returned the whole
 * `raw_scraped_leads` row via `select('*')` in `rawRecord`. No session, no
 * tenant predicate. Any caller who could guess or enumerate an id read another
 * brokerage's raw lead — name, phone, email, address, enrichment output.
 *
 * Splitting it is what lets both things be true at once: internal callers and
 * the promotion simulator need the ungated read (they have no session), while
 * the public door must be gated. The gate now lives in eligibility-evaluator.ts
 * and delegates here. NOTHING in this file may be re-exported from a
 * `"use server"` module without a gate in front of it.
 */

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
export async function evaluatePromotionEligibilityCore(
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

  // 4. Canonical eligibility gate — THE predicate every promotion door shares
  //    (lib/lead-pipeline/canonical-lead-eligibility.ts). Owner rule in force (wave 84,
  //    2026-09-26): a real first name AND last name AND a phone and/or an email — a mailing
  //    address, verified or not, no longer makes a lead. Names resolve first-class column →
  //    raw_data jsonb, the same chain the pipeline processor uses, so enrichment-backfilled
  //    names count. THIS EVALUATOR SPENDS NOTHING (`'use server'` sits in front of it).
  const { evaluateCanonicalLeadEligibility } = await import("@/lib/lead-pipeline/canonical-lead-eligibility")
  const rawData = rawRecord.raw_data || {}
  const eligibility = evaluateCanonicalLeadEligibility({
    first_name: rawRecord.first_name ?? rawData.first_name ?? rawData.firstName,
    last_name:  rawRecord.last_name ?? rawData.last_name ?? rawData.lastName,
    email:      rawRecord.email ?? rawData.email,
    phone:      rawRecord.phone ?? rawData.phone,
  })
  if (!eligibility.eligible) {
    return {
      eligible: false,
      reason:   eligibility.reason,
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
