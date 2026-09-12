// NOT a server-action module (2026-09-03, lane R3-A; template
// lib/behavior-learning/preference-updater.ts:1-9). The module-level "use server"
// that stood here published promoteRawRecordToLead(rawRecordId, brokerageId,
// rawData) as a public HTTP door with no gate: a service client INSERTING a lead
// under a caller-supplied brokerageId — section 4's named IDOR shape, on a
// write. Every caller is in-process server code (re-verified 2026-09-03):
//   · lib/lead-promotion/index.ts:9 (the barrel), whose only value importer is
//     scripts/raw-lead-promotion-simulator.ts:72 (tsx, outside the bundle);
//     scripts/lead-pipeline-simulator.ts:217 asserts there is NO production
//     caller outside lib/lead-promotion — the pipeline promotes through
//     lib/lead-pipeline/pipeline-processor.ts instead
// so the directive published nothing anyone needed. `server-only` makes a future
// client import fail at build time instead of bundling the service credential.
// brokerageId is now an IN-PROCESS CONTRACT: with the door closed, the server
// caller that supplies it is the gate.
import "server-only"

import { createServiceClient } from '@/lib/supabase/service'
import { extractPropertySpecs, leadSpecPatch } from '@/lib/data-steward/property-spec-extractor'

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
    // plus the first-class columns this insert reads off the row (normalized_preview,
    // email_verified, mailing/name columns) — the old single-column select left those
    // reads permanently undefined.
    const { data: rawRecord } = await supabase
      .from('raw_scraped_leads')
      .select('source_origin, normalized_preview, email_verified, mailing_address, mailing_address_verified, first_name, last_name')
      .eq('id', rawRecordId)
      .single()

    const sourceOrigin: 'platform' | 'brokerage' =
      (rawRecord?.source_origin as 'platform' | 'brokerage') ?? 'brokerage'

    // Extract fields from enriched raw_data (first-class raw columns win — the same
    // resolution order the canonical eligibility gate just evaluated, so the promoted
    // lead carries the exact first/last name that passed the round-39 name requirement)
    const firstName = (rawRecord as any)?.first_name ?? rawData.first_name
    const lastName = (rawRecord as any)?.last_name ?? rawData.last_name
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
    // Full address fidelity — the automated path (pipeline-processor) carries these; the manual
    // broker-triggered promotion was dropping them, so a hand-promoted lead lost its physical
    // address + mailing breakdown. Keep both paths lossless to the same canonical column set.
    const address      = rawData.address ?? rawData.property_address ?? null
    const city         = rawData.city ?? null
    const state        = rawData.state ?? null
    const zipCode      = rawData.zip_code ?? rawData.zip ?? propertyZipCode
    const mailingCity  = rawData.mailing_city ?? null
    const mailingState = rawData.mailing_state ?? null

    // Platform-origin leads have NO brokerage until Engine 1 distributes them.
    // Brokerage-origin leads keep the brokerage that initiated the scrape.
    const initialBrokerageId = sourceOrigin === 'platform' ? null : brokerageId

    // Insert into leads table (LOSSLESS SPECS — promote beds/baths/sqft/type/value from the raw jsonb;
    // additive, only what was scraped, parity with pipeline-processor).
    const leadSpecs = leadSpecPatch(extractPropertySpecs([rawData, (rawRecord as any)?.normalized_preview]))
    const { data: newLead, error: insertError } = await supabase
      .from('leads')
      .insert({
        ...leadSpecs,
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
        // Canonical physical-address + mailing-breakdown columns (parity with pipeline-processor).
        address: address,
        city: city,
        state: state,
        zip_code: zipCode,
        mailing_city: mailingCity,
        mailing_state: mailingState,
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
        // HONEST flag (round 39): eligibility can pass on email alone, so carry what the
        // raw record actually determined — never a blanket true (parity with pipeline-processor).
        mailing_address_verified: !!((rawRecord as any)?.mailing_address_verified ?? rawData.mailing_address_verified),
        // Propagate the actual address so AI-ISA direct_mail has something to send to.
        mailing_address: (rawRecord as any)?.mailing_address ?? rawData.mailing_address ?? null,
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

    // ── LEAD ENRICHMENT (wave 5, DIRECT HOOK) ────────────────────────────────
    // "enrichment also needs to still happen with raw leads" (owner).
    //
    // The third of the three `leads` INSERT sites in app/ + lib/. It emits no
    // kernel event, so the reactor chokepoint cannot reach it and it gets a
    // direct hook — named individually in
    // scripts/enrichment-suppression-simulator.ts, because a direct hook rots
    // silently: delete this call and nothing errors, no test goes red, the lead
    // is simply never enriched.
    //
    // `initialBrokerageId`, NOT `brokerageId`: a platform-origin lead is inserted
    // with brokerage_id NULL and only gains a tenant when Engine 1 distributes
    // it. Queueing under the SCRAPING brokerage would write a row whose tenant
    // does not match the lead's — the drain would hand it to the wrong
    // brokerage's budget and the wrong brokerage's suppression check. A parked
    // lead is left for the cron net, which picks it up once it has a home.
    //
    // BEST-EFFORT AND VOIDED: promotion must never fail because of enrichment.
    if (initialBrokerageId) {
      try {
        const { queueLeadEnrichmentBestEffort } = await import('@/lib/enrichment/lead-enrichment-core')
        queueLeadEnrichmentBestEffort({
          leadId:      newLead.id,
          brokerageId: initialBrokerageId,
          triggerType: 'raw_promotion',
        })
      } catch (err) {
        console.error('[lead-promoter] lead enrichment enqueue failed:', err)
      }
    }

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
