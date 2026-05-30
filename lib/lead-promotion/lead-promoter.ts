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
 * - Carry the source_origin flag from the raw record (platform vs brokerage)
 * - Set brokerage_id to NULL for platform leads (Engine 1 will set it on distribution)
 * - Update raw_scraped_leads.lead_id link
 */
export async function promoteRawRecordToLead(
  rawRecordId: string,
  brokerageId: string,
  rawData: any
): Promise<PromotionResult> {
  const supabase = createServiceClient()

  try {
    // Read the raw record's source_origin (set at ingest time by lib/kernel/scraping)
    const { data: rawRecord } = await supabase
      .from('raw_scraped_leads')
      .select('source_origin')
      .eq('id', rawRecordId)
      .single()

    const sourceOrigin: 'platform' | 'brokerage' =
      (rawRecord?.source_origin as 'platform' | 'brokerage') ?? 'brokerage'

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
    const propertyZipCode =
      rawData.property_zip_code || rawData.zip_code || rawData.zip || null
    const mailingZip = rawData.mailing_zip || null

    // Platform-origin leads have NO brokerage until Engine 1 distributes them.
    // Brokerage-origin leads keep the brokerage that initiated the scrape.
    const initialBrokerageId = sourceOrigin === 'platform' ? null : brokerageId

    // Insert into leads table
    const { data: newLead, error: insertError } = await supabase
      .from('leads')
      .insert({
        brokerage_id: initialBrokerageId,
        first_name: firstName,
        last_name: lastName,
        email: email,
        phone: phone,
        phone_secondary: phoneSecondary,
        source: source,
        source_origin: sourceOrigin,
        property_zip_code: propertyZipCode,
        mailing_zip: mailingZip,
        lead_stage: 'new',
        lead_type: motivationType,
        property_interest: propertyInterest,
        motivation_type: motivationType,
        motivation_confidence: motivationConfidence,
        enrichment_status: 'completed',
        enrichment_confidence: enrichmentConfidence,
        last_enriched_at: new Date().toISOString(),
        source_raw_ids: [rawRecordId],
        is_active: true,
        lead_score: 0,
        lifecycle_state: 'unconsented',
        ai_isa_owner: true,
        minimum_viable_for_isa: !!(rawData.email),
        mailing_address_verified: true,  // canonical eligibility just confirmed it
        // Propagate the actual address so AI-ISA direct_mail has something to send to.
        mailing_address: rawData.mailing_address ?? null,
        // email_verified: read the row's column (where the verification step writes it), falling
        // back to the raw_data JSON. Drift-fix consistent with pipeline-processor.
        email_verified: !!((rawRecord as any).email_verified ?? rawData.email_verified),
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
