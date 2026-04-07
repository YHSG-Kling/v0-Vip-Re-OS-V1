// lib/lead-pipeline/enrichment-orchestrator.ts
// Processes BOTH lead_id rows (Track A) and contact_id rows (Track B).
// DO NOT TOUCH: pipeline-processor.ts, peopledata-client.ts,
//               vendor-tracking.ts, /api/cron/contact-enrichment

import { createServiceClient } from '@/lib/supabase/service'
import { skipTraceWithPeopleData } from '@/lib/external/peopledata-client'
import { trackVendorUsageService } from '@/lib/vendor-governance'
import {
  handleLeadScored,
  processKernelEvent,
} from '@/lib/kernel'
import { KernelEvent } from '@/lib/kernel/events'

const BATCH_SIZE = 10
const MAX_RETRIES = 3

type EntityType = 'lead' | 'contact'

interface QueueEntry {
  id: string
  lead_id: string | null
  contact_id: string | null
  brokerage_id: string
  status: string
  enrichment_type: string
  trigger_type: string
  retry_count: number
  max_retries: number
}

interface EnrichmentResult {
  processed: number
  succeeded: number
  failed: number
  totalCost: number
}

export async function processEnrichmentQueue(
  brokerageId: string,
): Promise<EnrichmentResult> {
  const supabase = createServiceClient()
  const result: EnrichmentResult = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    totalCost: 0,
  }

  // Fetch pending batch
  const { data: entries, error: fetchError } = await supabase
    .from('lead_enrichment_queue')
    .select('id, lead_id, contact_id, brokerage_id, status, enrichment_type, trigger_type, retry_count, max_retries')
    .eq('brokerage_id', brokerageId)
    .eq('status', 'pending')
    .lt('retry_count', MAX_RETRIES)
    .order('queued_at', { ascending: true })
    .limit(BATCH_SIZE)

  if (fetchError) {
    console.error('[enrichment-orchestrator] Failed to fetch queue:', fetchError.message)
    return result
  }
  if (!entries || entries.length === 0) return result

  for (const entry of entries as QueueEntry[]) {
    result.processed++

    // Step 1: Mark processing
    await supabase
      .from('lead_enrichment_queue')
      .update({ status: 'processing' })
      .eq('id', entry.id)

    // Step 2: Determine entity type — constraint guarantees exactly one is set
    const entityType: EntityType = entry.lead_id ? 'lead' : 'contact'
    const entityId = (entry.lead_id ?? entry.contact_id) as string

    try {
      // Step 3: Fetch entity
      const table = entityType === 'lead' ? 'leads' : 'contacts'
      const { data: entity, error: entityError } = await supabase
        .from(table)
        .select('id, first_name, last_name, email, phone')
        .eq('id', entityId)
        .single()

      if (entityError || !entity) {
        throw new Error(`Entity not found in ${table}: ${entityId}`)
      }

      // Step 4: Validate identifier
      const hasIdentifier = entity.first_name || entity.phone || entity.email
      if (!hasIdentifier) {
        throw new Error('No identifier (first_name, phone, or email) available for skip trace')
      }

      // Step 5: Call PeopleData
      const name = [entity.first_name, entity.last_name].filter(Boolean).join(' ') || undefined
      const { data: enriched, cost } = await skipTraceWithPeopleData({
        name,
        phone: entity.phone ?? undefined,
        email: entity.email ?? undefined,
      })

      result.totalCost += cost

      // Step 6: Data returned
      if (enriched) {
        // PeopleDataEnrichment.emails and phones are string[] not object[]
        const primaryEmail = enriched.emails?.[0] ?? null
        const primaryPhone = enriched.phones?.[0] ?? null
        const secondaryPhone = enriched.phones?.[1] ?? null

        // Mailing address from enrichment provider
        const hasMailingData = !!(enriched.address || enriched.city || enriched.state)

        // Step 6a: Update entity table
        if (entityType === 'lead') {
          await supabase
            .from('leads')
            .update({
              ...(primaryEmail && { email: primaryEmail }),
              ...(primaryPhone && { phone: primaryPhone }),
              ...(secondaryPhone && { phone_secondary: secondaryPhone }),
              last_enriched_at: new Date().toISOString(),
              enrichment_status: 'complete',
              enrichment_provider: 'peopledata',
              enrichment_confidence: enriched.enrichmentConfidence,
              // Write mailing fields when provider returns address data
              ...(hasMailingData && {
                mailing_address: enriched.address ?? null,
                mailing_city: enriched.city ?? null,
                mailing_state: enriched.state ?? null,
                mailing_zip: enriched.zipCode ?? null,
                mailing_address_verified: true,
                mailing_address_source: 'enrichment',
              }),
              // Mark eligible for ISA if email is now available
              ...(primaryEmail && { minimum_viable_for_isa: true }),
            })
            .eq('id', entityId)
        } else {
          await supabase
            .from('contacts')
            .update({
              ...(primaryEmail && { email: primaryEmail }),
              ...(primaryPhone && { phone: primaryPhone }),
              ...(secondaryPhone && { phone_secondary: secondaryPhone }),
              last_enriched_at: new Date().toISOString(),
              enrichment_confidence: enriched.enrichmentConfidence,
            })
            .eq('id', entityId)
        }

        // Step 6b: Update queue entry
        await supabase
          .from('lead_enrichment_queue')
          .update({
            status: 'completed',
            enrichment_cost: cost,
            enrichment_results: enriched as unknown as Record<string, unknown>,
            completed_at: new Date().toISOString(),
          })
          .eq('id', entry.id)

        // Step 6c: Track vendor usage
        await trackVendorUsageService({
          vendorName: 'PeopleData',
          usageType: 'skip_trace',
          unitsUsed: 1,
          costPerUnit: cost,
          totalCost: cost,
          brokerageId,
          requestMetadata: { entityType, entityId, queueEntryId: entry.id },
        })

        // Step 6d: Lead-specific post-enrichment
        if (entityType === 'lead') {
          await supabase.from('lifecycle_events').insert({
            entity_type: 'lead',
            entity_id: entityId,
            brokerage_id: brokerageId,
            event_type: KernelEvent.ENRICHMENT_COMPLETED,
            metadata: { queueEntryId: entry.id, cost },
            created_at: new Date().toISOString(),
          })

          await handleLeadScored({ leadId: entityId, brokerageId })
        }

        // Step 6e: Contact-specific post-enrichment
        if (entityType === 'contact') {
          await supabase.from('lifecycle_events').insert({
            entity_type: 'contact',
            entity_id: entityId,
            brokerage_id: brokerageId,
            event_type: KernelEvent.CONTACT_ENRICHMENT_COMPLETED,
            metadata: { queueEntryId: entry.id, cost },
            created_at: new Date().toISOString(),
          })

          await processKernelEvent({
            eventType: KernelEvent.CONTACT_ENRICHMENT_COMPLETED,
            entityType: 'contact',
            entityId,
            brokerageId,
          })

          // Re-score contact into lead_score_history
          const { data: contact } = await supabase
            .from('contacts')
            .select('*')
            .eq('id', entityId)
            .single()

          if (contact) {
            const { calculateLeadScore } = await import('@/lib/lead-governance/multi-factor-scorer')
            const scoreResult = calculateLeadScore(contact)

            await supabase.from('lead_score_history').insert({
              contact_id: entityId,
              brokerage_id: brokerageId,
              score: scoreResult.finalScore,
              score_factors: scoreResult.factors as unknown as Record<string, unknown>,
              scored_at: new Date().toISOString(),
            })

            await supabase
              .from('contacts')
              .update({ last_scored_at: new Date().toISOString() })
              .eq('id', entityId)

            await supabase.from('lifecycle_events').insert({
              entity_type: 'contact',
              entity_id: entityId,
              brokerage_id: brokerageId,
              event_type: KernelEvent.CONTACT_SCORED,
              metadata: { score: scoreResult.finalScore },
              created_at: new Date().toISOString(),
            })
          }
        }

        result.succeeded++
      } else {
        // Step 7: No data returned — increment retry, log cost (API charged)
        await supabase
          .from('lead_enrichment_queue')
          .update({
            retry_count: entry.retry_count + 1,
            enrichment_cost: cost,
            status: 'pending',
            error_message: 'No match found in PeopleData',
          })
          .eq('id', entry.id)

        await trackVendorUsageService({
          vendorName: 'PeopleData',
          usageType: 'skip_trace',
          unitsUsed: 1,
          costPerUnit: cost,
          totalCost: cost,
          brokerageId,
          requestMetadata: { entityType, entityId, queueEntryId: entry.id, result: 'no_match' },
        })

        result.failed++
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const nextRetry = entry.retry_count + 1
      const isFinal = nextRetry >= (entry.max_retries ?? MAX_RETRIES)

      await supabase
        .from('lead_enrichment_queue')
        .update({
          retry_count: nextRetry,
          status: isFinal ? 'failed' : 'pending',
          error_message: message,
        })
        .eq('id', entry.id)

      // Step 8: Log to automation_errors on final retry
      if (isFinal) {
        await supabase.from('automation_errors').insert({
          brokerage_id: brokerageId,
          workflow_name: 'enrichment_processor',
          lead_id: entityType === 'lead' ? entityId : null,
          error_message: message,
          context_json: JSON.stringify({ entityType, entityId, queueEntryId: entry.id }),
          status: 'open',
          severity: 'medium',
        })
      }

      result.failed++
    }
  }

  return result
}
