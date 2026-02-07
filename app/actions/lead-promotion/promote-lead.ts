'use server'

import { createServiceClient } from '@/lib/supabase/service'
import { evaluatePromotionEligibility } from '@/lib/lead-promotion/eligibility-evaluator'
import { promoteRawRecordToLead } from '@/lib/lead-promotion/lead-promoter'
import { triggerInitialScoring } from '@/lib/lead-promotion/initial-scorer'

interface PromotionResponse {
  success: boolean
  leadId?: string
  message: string
  stage: string
}

/**
 * Main orchestration function for lead promotion system.
 * 
 * This is the ONLY public entry point. It coordinates:
 * 1. Eligibility evaluation (reads existing dedup/enrichment)
 * 2. Promotion to leads table (if eligible)
 * 3. Initial scoring trigger (separate, non-blocking)
 * 4. Audit logging to activities table
 * 
 * NEVER:
 * - Contacts leads
 * - Assigns agents
 * - Sends SMS/calls
 * - Re-runs deduplication
 */
export async function promoteLead(
  rawRecordId: string,
  brokerageId: string
): Promise<PromotionResponse> {
  const supabase = createServiceClient()

  try {
    // Step 1: Evaluate eligibility (consumes existing dedup + enrichment outputs)
    const eligibility = await evaluatePromotionEligibility(rawRecordId)

    if (!eligibility.eligible) {
      // Log rejection to activities
      await supabase
        .from('activities')
        .insert({
          brokerage_id: brokerageId,
          activity_type: 'lead_promotion_rejected',
          title: 'Lead promotion rejected',
          description: eligibility.reason,
          notes: JSON.stringify({
            raw_record_id: rawRecordId,
            reason: eligibility.reason,
            dedup_log: eligibility.dedupLog,
          }),
          status: 'completed',
          created_at: new Date().toISOString(),
        })

      return {
        success: false,
        message: eligibility.reason,
        stage: 'eligibility_check',
      }
    }

    // Step 2: Promote to leads table
    const promotion = await promoteRawRecordToLead(
      rawRecordId,
      brokerageId,
      eligibility.rawRecord?.raw_data || {}
    )

    if (!promotion.success) {
      // Log promotion failure to automation_errors
      await supabase
        .from('automation_errors')
        .insert({
          workflow_name: 'lead_promotion',
          error_message: promotion.error || 'Unknown promotion error',
          context_json: JSON.stringify({ rawRecordId, brokerageId }),
          severity: 'high',
          status: 'open',
          created_at: new Date().toISOString(),
        })

      return {
        success: false,
        message: promotion.error || 'Promotion failed',
        stage: 'promotion',
      }
    }

    // Step 3: Log successful promotion to activities
    await supabase
      .from('activities')
      .insert({
        brokerage_id: brokerageId,
        activity_type: 'lead_promotion_success',
        title: 'Lead promoted from raw record',
        description: `Raw record ${rawRecordId} promoted to lead ${promotion.leadId}`,
        notes: JSON.stringify({
          raw_record_id: rawRecordId,
          lead_id: promotion.leadId,
          promoted_at: new Date().toISOString(),
        }),
        status: 'completed',
        created_at: new Date().toISOString(),
      })

    // Step 4: Trigger initial scoring (separate, non-blocking)
    // Scoring runs AFTER promotion, not inline
    // This separation ensures promotion isn't blocked by scoring failures
    if (promotion.leadId) {
      // Fire and forget - scoring errors are logged internally
      triggerInitialScoring(promotion.leadId).catch((err) => {
        console.error(`[v0] Scoring trigger failed for ${promotion.leadId}:`, err)
      })
    }

    return {
      success: true,
      leadId: promotion.leadId,
      message: 'Lead promoted successfully',
      stage: 'completed',
    }
  } catch (error: any) {
    // Unexpected errors go to automation_errors
    await supabase
      .from('automation_errors')
      .insert({
        workflow_name: 'lead_promotion_orchestrator',
        error_message: error.message,
        context_json: JSON.stringify({ rawRecordId, brokerageId }),
        severity: 'critical',
        status: 'open',
        created_at: new Date().toISOString(),
      })

    return {
      success: false,
      message: `Unexpected error: ${error.message}`,
      stage: 'orchestration',
    }
  }
}
