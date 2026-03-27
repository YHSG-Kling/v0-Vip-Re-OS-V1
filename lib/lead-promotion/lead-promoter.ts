'use server'

import { createServiceClient } from '@/lib/supabase/service'

interface PromotionResult {
  success: boolean
  leadId?: string
  error?: string
}

/**
 * Promotes an eligible raw record into the leads table.
 * 
 * DOES NOT:
 * - Assign agents
 * - Contact the lead
 * - Run deduplication (consumes existing results)
 * 
 * DOES:
 * - Insert into leads table
 * - Set initial lead_stage to 'new'
 * - Update raw_scraped_leads.lead_id link
 */
export async function promoteRawRecordToLead(
  rawRecordId: string,
  brokerageId: string,
  rawData: any
): Promise<PromotionResult> {
  const supabase = createServiceClient()

  try {
    // Extract fields from enriched raw_data
    const firstName = rawData.first_name
    const lastName = rawData.last_name
    const email = rawData.email || null
    const phone = rawData.phone || null
    const phoneSecondary = rawData.phone_secondary || null
    const source = rawData.source || 'unknown'
    const motivationType = rawData.motivation_type || null
    const motivationConfidence = rawData.motivation_confidence || null
    const propertyInterest = rawData.property_address || null
    const enrichmentConfidence = rawData.enrichmentConfidence || null

    // Insert into leads table
    const { data: newLead, error: insertError } = await supabase
      .from('leads')
      .insert({
        brokerage_id: brokerageId,
        first_name: firstName,
        last_name: lastName,
        email: email,
        phone: phone,
        phone_secondary: phoneSecondary,
        source: source,
        lead_stage: 'new', // Initial stage - NO agent assignment
        lead_type: motivationType,
        property_interest: propertyInterest,
        motivation_type: motivationType,
        motivation_confidence: motivationConfidence,
        enrichment_status: 'completed',
        enrichment_confidence: enrichmentConfidence,
        last_enriched_at: new Date().toISOString(),
        source_raw_ids: [rawRecordId],
        is_active: true,
        lead_score: 0, // Will be set by scoring system
        // Session G: promoted scraped leads must enter with unconsented lifecycle
        // and be owned by the AI-ISA engine until explicit consent is obtained.
        lifecycle_state: 'unconsented',
        ai_isa_owner: true,
        minimum_viable_for_isa: !!(rawData.email),
        raw_record_id: rawRecordId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        stage_entered_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (insertError) {
      throw new Error(`Lead insert failed: ${insertError.message}`)
    }

    // Update raw_scraped_leads to link to new lead
    await supabase
      .from('raw_scraped_leads')
      .update({ 
        lead_id: newLead.id,
        processed_at: new Date().toISOString()
      })
      .eq('id', rawRecordId)

    return {
      success: true,
      leadId: newLead.id,
    }
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    }
  }
}
