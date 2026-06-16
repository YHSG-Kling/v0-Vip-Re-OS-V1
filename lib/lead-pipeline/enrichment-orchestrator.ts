// lib/lead-pipeline/enrichment-orchestrator.ts
// Processes BOTH lead_id rows (Track A) and contact_id rows (Track B).
// DO NOT TOUCH: pipeline-processor.ts, peopledata-client.ts,
//               vendor-tracking.ts, /api/cron/contact-enrichment

import { createServiceClient } from '@/lib/supabase/service'
import { skipTraceWithPeopleData } from '@/lib/external/peopledata-client'
import { scrubPhonesForPatch } from '@/lib/compliance/phone-scrub-runner'
import { peopleDataProfileToContactColumns, peopleDataProfileToLeadColumns } from '@/lib/lead-pipeline/enrichment-column-map'
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

    // Guard: a row must reference a lead or a contact to be enrichable here.
    // Raw-record rows (both null) are enriched inline by the pipeline, not via
    // this queue — fail them with a clear reason instead of looping retries.
    if (!entry.lead_id && !entry.contact_id) {
      await supabase
        .from('lead_enrichment_queue')
        .update({ status: 'failed', error_message: 'No lead_id or contact_id to enrich' })
        .eq('id', entry.id)
      continue
    }

    // Step 1: Mark processing
    await supabase
      .from('lead_enrichment_queue')
      .update({ status: 'processing' })
      .eq('id', entry.id)

    // Step 2: Determine entity type
    const entityType: EntityType = entry.lead_id ? 'lead' : 'contact'
    const entityId = (entry.lead_id ?? entry.contact_id) as string

    try {
      // Step 3: Fetch entity
      const table = entityType === 'lead' ? 'leads' : 'contacts'
      const { data: entity, error: entityError } = await supabase
        .from(table)
        .select('id, first_name, last_name, email, phone, enrichment_profile')
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

        // PHONE SCRUB + CLEAN-PRIMARY ELECTION — PeopleData returns these in arbitrary order and
        // unscrubbed. Scrub against BatchData (DNC + TCPA-litigator) and ELECT the clean line as
        // the primary so the first number the system reaches for is contactable, with dnc_status/
        // phone_status populated for the outbound gates. Provider-gated: when BatchData is
        // unconfigured/out-of-balance it DEFERS and we keep the naive ordering (no fabricated flags).
        const phoneCandidates = [primaryPhone, secondaryPhone].filter(Boolean) as string[]
        const scrub = await scrubPhonesForPatch(phoneCandidates)
        const useScrub = !scrub.deferred && Object.keys(scrub.patch).length > 0
        const naivePhonePatch = {
          ...(primaryPhone && { phone: primaryPhone }),
          ...(secondaryPhone && { phone_secondary: secondaryPhone }),
        }
        // Contacts carry the full gate columns; leads only have phone / phone_secondary, so leads
        // take the elected ORDERING without the gate fields (writing absent columns would crash).
        const contactPhonePatch = useScrub ? scrub.patch : naivePhonePatch
        const leadPhonePatch = useScrub
          ? { ...(scrub.patch.phone !== undefined && { phone: scrub.patch.phone }), phone_secondary: scrub.patch.phone_secondary ?? null }
          : naivePhonePatch

        // Mailing address from enrichment provider — prefer the structured streetAddress (PDL
        // street_addresses[0]) and fall back to the legacy single-string `address`.
        const mailingStreet = (enriched as any).streetAddress ?? enriched.address ?? null
        const hasMailingData = !!(mailingStreet || enriched.city || enriched.state)
        // PDL now reports verification flags directly (peopledata-client derives them from the
        // person likelihood + presence of structured email/address). Fall back to hasMailingData
        // for back-compat with mocks/tests.
        const mvRaw = (enriched as any).mailingAddressVerified
        const mailingVerified: boolean = typeof mvRaw === 'boolean' ? mvRaw : hasMailingData
        const emailFlagVerified: boolean = (enriched as any).emailVerified === true

        // Rich enrichment profile (downstream — AI-ISA scripts, AI Mesh, dashboards) so the full
        // PDL payload is queryable without re-calling the API. Only includes fields actually
        // returned by the provider; undefined/null are omitted so callers can use coalesce safely.
        const profile: Record<string, any> = {
          provider: 'peopledata',
          peopledata_id: (enriched as any).peopledataId,
          captured_at: new Date().toISOString(),
          confidence: enriched.enrichmentConfidence,
          full_name: enriched.fullName,
          middle_name: enriched.middleName,
          emails: enriched.emails,
          phones: enriched.phones,
          mobile_phone: enriched.mobilePhone,
          work_phone: enriched.workPhone,
          age: enriched.age,
          age_range: enriched.ageRange,
          gender: enriched.gender,
          marital_status: enriched.maritalStatus,
          children_count: enriched.childrenCount,
          household_size: enriched.householdSize,
          employer: enriched.currentEmployer,
          job_title: enriched.currentTitle,
          industry: enriched.currentIndustry,
          years_of_experience: enriched.yearsOfExperience,
          education: enriched.education,
          household_income: enriched.householdIncome,
          net_worth: enriched.netWorth,
          home_owner_status: enriched.homeOwnerStatus,
          home_value: enriched.homeValue,
          credit_score_range: enriched.creditScoreRange,
          linkedin_url: enriched.linkedinUrl,
          linkedin_username: enriched.linkedinUsername,
          facebook_url: enriched.facebookUrl,
          twitter_url: enriched.twitterUrl,
          github_url: enriched.githubUrl,
          skills: enriched.skills,
          certifications: enriched.certifications,
          life_events: (enriched as any).life_events ?? (enriched as any).lifeEvents,
        }
        // Strip undefined / null / empty arrays so the JSONB blob stays compact.
        for (const k of Object.keys(profile)) {
          const v = profile[k]
          if (v === undefined || v === null) delete profile[k]
          else if (Array.isArray(v) && v.length === 0) delete profile[k]
        }

        // Step 6a: Update entity table
        if (entityType === 'lead') {
          await supabase
            .from('leads')
            .update({
              ...(primaryEmail && { email: primaryEmail }),
              ...leadPhonePatch,
              // First-class lead enrichment (m233): promote home_owner_status + life_events out of
              // the jsonb so lead persona/segmentation read them directly (parity with contacts).
              ...peopleDataProfileToLeadColumns(profile),
              last_enriched_at: new Date().toISOString(),
              enrichment_status: 'complete',
              enrichment_provider: 'peopledata',
              enrichment_confidence: enriched.enrichmentConfidence,
              enrichment_profile: profile,
              // Verification flags drive the canonical lead-eligibility gate + AI-ISA channel
              // resolver. Write them whenever enrichment ran (false is meaningful — it explains
              // why the gate is still blocking).
              email_verified: emailFlagVerified,
              // Write mailing fields when provider returns address data
              ...(hasMailingData && {
                mailing_address: mailingStreet,
                mailing_city: enriched.city ?? null,
                mailing_state: enriched.state ?? null,
                mailing_zip: enriched.zipCode ?? null,
                mailing_address_verified: mailingVerified,
                mailing_address_source: 'enrichment',
              }),
              // Mark eligible for ISA if email is now available
              ...(primaryEmail && { minimum_viable_for_isa: true }),
            })
            .eq('id', entityId)

          // Back-fill raw_scraped_leads so a record that previously failed the canonical eligibility
          // gate can re-pass on the next sweep. Without this, a stranded raw_scraped_leads row would
          // never recover even after PDL surfaced the missing email/address.
          try {
            const { data: leadRow } = await supabase
              .from('leads').select('raw_record_id').eq('id', entityId).maybeSingle()
            const rawId = leadRow?.raw_record_id
            if (rawId) {
              await supabase.from('raw_scraped_leads').update({
                email_verified:           emailFlagVerified,
                ...(hasMailingData && {
                  mailing_address:          mailingStreet,
                  mailing_city:             enriched.city ?? null,
                  mailing_state:            enriched.state ?? null,
                  mailing_zip:              enriched.zipCode ?? null,
                  mailing_address_verified: mailingVerified,
                }),
                processed_at:             new Date().toISOString(),
                updated_at:               new Date().toISOString(),
              }).eq('id', rawId)
            }
          } catch (e) {
            console.warn('[enrichment-orchestrator] raw_scraped_leads back-fill skipped:', e)
          }
        } else {
          // Promote the rich PDL payload into the contacts FIRST-CLASS columns (age_range,
          // household_income, home_owner_status, occupation, education_level, social URLs,
          // life_events, peopledata_id, enriched_at, enrichment_source) so the data is queryable
          // by scorers / segmenters / AI-ISA — not just stranded in enrichment_profile jsonb.
          // The SECONDARY phone is conserved as a first-class, independently-gateable number
          // (m202): one line may be on the DNC while the other is reachable, so the voice/SMS
          // resolver can fall back instead of suppressing the contact. The full phone list also
          // stays in enrichment_profile.phones for audit.
          const enrichedAt = new Date().toISOString()
          const contactEnrichmentColumns = peopleDataProfileToContactColumns(profile, { enrichedAt })
          // RE-ENRICH → RE-ENGAGE HANDOFF: when a refresh returns a MATERIALLY changed fact (new
          // homeowner, job change, new life event), stamp last_life_event_detected so the EXISTING
          // life-event detector (referral-radar) treats it as a fresh opportunity for the right
          // manager — not just a quiet row update. Reuses the detector; no duplicate life-event logic.
          const { materialEnrichmentChange } = await import('@/lib/lead-pipeline/material-enrichment-change')
          const matChange = materialEnrichmentChange((entity as any).enrichment_profile, profile)
          await supabase
            .from('contacts')
            .update({
              ...(primaryEmail && { email: primaryEmail }),
              ...contactPhonePatch,
              ...contactEnrichmentColumns,
              last_enriched_at: enrichedAt,
              enrichment_confidence: enriched.enrichmentConfidence,
              email_verified: emailFlagVerified,
              enrichment_profile: profile,
              ...(matChange.changed && { last_life_event_detected: enrichedAt }),
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
          vendor: 'PeopleData',
          systemSource: 'skip_trace',
          unitCount: 1,
          brokerageId,
          metadata: { entityType, entityId, queueEntryId: entry.id, cost },
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
            event: KernelEvent.CONTACT_ENRICHMENT_COMPLETED,
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
              factors: scoreResult.factors as unknown as Record<string, unknown>,
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
          vendor: 'PeopleData',
          systemSource: 'skip_trace',
          unitCount: 1,
          brokerageId,
          metadata: { entityType, entityId, queueEntryId: entry.id, cost, result: 'no_match' },
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
