// lib/lead-pipeline/enrichment-orchestrator.ts
// Processes BOTH lead_id rows (Track A) and contact_id rows (Track B).
// DO NOT TOUCH: pipeline-processor.ts, peopledata-client.ts,
//               vendor-tracking.ts, /api/cron/contact-enrichment

import { createServiceClient } from '@/lib/supabase/service'
import { bestEffort } from '@/lib/db/best-effort'
import { skipTraceWithPeopleData } from '@/lib/external/peopledata-client'
import { scrubPhonesForPatch } from '@/lib/compliance/phone-scrub-runner'
import { peopleDataProfileToContactColumns, peopleDataProfileToLeadColumns } from '@/lib/lead-pipeline/enrichment-column-map'
import { trackVendorUsageService } from '@/lib/vendor-governance'
import {
  handleLeadScored,
  processKernelEvent,
} from '@/lib/kernel'
import { KernelEvent } from '@/lib/kernel/events'
import { MAX_RETRIES, enrichmentRetryOutcome } from './enrichment-retry'
import { isContactInLiveDeal } from '@/lib/enrichment/deal-suppression'
import {
  planEnrichmentLane,
  runFreeOsintLane,
  describeFreeLane,
  type FreeOsintInput,
  type FreeOsintLaneResult,
} from '@/lib/external/osint-free'
// NOTE: `queueContactEnrichment` is imported DYNAMICALLY at its call site below,
// not statically at module scope. lib/enrichment/contact-enrichment-core.ts is
// `server-only` (it holds the service client and the paid PeopleData/OSINT
// clients), and a static import here would pull that into every module graph
// that reaches this file — including the plain `tsx` guard simulators, which are
// not a server component and crash on `server-only` at load. lib/kernel/crm.ts
// already used the dynamic form for exactly this reason; these call sites were
// the inconsistency. The queue call is best-effort and already awaited/voided,
// so deferring the import costs nothing.

const BATCH_SIZE = 10

/**
 * PeopleData's per-record charge (lib/external/peopledata-client.ts returns
 * cost: 0.10 on both the matched and the no-match path). Used to PRE-FLIGHT the
 * brokerage vendor budget before the call, not to price it afterwards — the
 * ledger still records the cost the client actually reports.
 */
const PEOPLEDATA_UNIT_COST = 0.10

type EntityType = 'lead' | 'contact'

/**
 * Columns the entity read needs, per table. Two lists because leads and contacts
 * are different tables with different columns — verified live: `leads` carries
 * address/city/state/zip_code/property_zip_code/lat/lng, `contacts` carries
 * address/city/state/zip_code and has NO lat/lng. Selecting a column a table does
 * not have makes supabase-js resolve with an error, and this drain would then read
 * `entity` as missing and fail an otherwise-enrichable row.
 */
const ENTITY_COLUMNS: Record<EntityType, string> = {
  lead: 'id, first_name, last_name, email, phone, enrichment_profile, address, city, state, zip_code, property_zip_code, mailing_address, mailing_city, mailing_state, mailing_zip, lat, lng',
  contact: 'id, first_name, last_name, email, phone, enrichment_profile, address, city, state, zip_code, mailing_address, mailing_city, mailing_state, mailing_zip',
}

/**
 * PURE. The place-keyed inputs the FREE OSINT lane can work from, preferring the
 * record's own address and falling back to the mailing address. Returns the parts
 * as-is; the free lane decides what it can ask with them.
 */
function freeLaneInputFor(entity: Record<string, unknown>): FreeOsintInput {
  const s = (v: unknown): string | null => {
    const t = (v ?? '').toString().trim()
    return t.length > 0 ? t : null
  }
  return {
    address: s(entity.address) ?? s(entity.mailing_address),
    city: s(entity.city) ?? s(entity.mailing_city),
    state: s(entity.state) ?? s(entity.mailing_state),
    zip: s(entity.zip_code) ?? s(entity.property_zip_code) ?? s(entity.mailing_zip),
  }
}

/**
 * The free lane's facts, shaped for the enrichment_profile JSONB. Deliberately
 * nested under its own `osint_free` key and using AREA-scoped field names, so a
 * downstream reader can never mistake a ZIP median for this person's home value
 * or a free geocode for a paid skip-trace fact.
 */
function freeLaneProfileBlock(free: FreeOsintLaneResult): Record<string, unknown> {
  return {
    lane: free.lane,
    cost: free.cost,
    captured_at: new Date().toISOString(),
    reachable: free.reachable,
    answered: free.answered,
    lat: free.facts.lat,
    lng: free.facts.lng,
    area_median_home_value_zip: free.facts.areaMedianHomeValueZip,
    area_median_home_value_year: free.facts.areaMedianHomeValueYear,
    area_appreciation: free.facts.areaAppreciation,
    neighborhood_amenities: free.facts.neighborhoodAmenities,
    unavailable: free.unavailable,
    // Stated on every row so nothing downstream has to remember it.
    scope_note: 'Place-keyed AREA data from keyless public sources (OSM + US Census). NOT a person record and NOT a valuation of a specific home.',
  }
}

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
  /** Rows the FREE OSINT lane contributed to (at $0). Reported separately from
   *  `succeeded` so a caller can never read free coverage as paid coverage. */
  freeLaneRuns: number
  /** Rows where the paid person lane was REQUIRED but withheld (budget). These
   *  are NOT counted as succeeded — the person question went unanswered. */
  paidWithheld: number
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
    freeLaneRuns: 0,
    paidWithheld: 0,
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

    // ── Step 2a: THE OWNER'S SUPPRESSION RULE ────────────────────────────────
    // "…but not if they have an active listing or an active transaction; just
    // before or after." This is the LAST gate before money is spent, and it is
    // re-asked here even though the queue writer already asked it: a contact can
    // sign a listing agreement or go under contract between being queued and
    // being drained, and the drain runs on a 15-minute cron.
    //
    // Only CONTACTS are checked. A `leads` row is by definition pre-contact —
    // leads.id and contacts.id are disjoint id spaces, so passing a lead id to a
    // contact-keyed predicate would ask a question about the wrong row.
    //
    // isContactInLiveDeal FAILS CLOSED: an unreadable listings/transactions read
    // returns "in a live deal", so a broken read stops spend instead of
    // releasing it.
    if (entityType === 'contact') {
      const verdict = await isContactInLiveDeal({
        contactId: entityId,
        brokerageId,
        supabase,
      })
      if (verdict.inLiveDeal) {
        // NOT a failure and NOT a retry — the contact is simply not eligible
        // right now. 'skipped' keeps it out of the retry ladder (which would
        // otherwise burn its three attempts against a deal that lasts weeks) and
        // the create-time / deal-ended triggers will re-queue it once the deal
        // ends.
        await supabase
          .from('lead_enrichment_queue')
          .update({
            status: 'skipped',
            error_message: `Suppressed — contact is in a live ${verdict.reason ?? 'deal'}`
              + (verdict.error ? ` (${verdict.error})` : ''),
            completed_at: new Date().toISOString(),
          })
          .eq('id', entry.id)
        continue
      }
    }

    // ── Step 2b: LIFE-CHANGE re-checks are a different job ───────────────────
    // A row queued with enrichment_type 'osint_profile' asks "what changed?",
    // not "who is this?" — it must NOT buy a PeopleData record. Routed to the
    // OSINT-only checker instead of falling through into the skip-trace path.
    //
    // 'osint_profile' is not a token invented for this branch: it is one of the
    // five values lead_enrichment_queue_enrichment_type_check admits
    // (skip_trace | property_match | phone_validation | osint_profile |
    // duplicate_check, verified live), and it is the one that describes an OSINT
    // search. A made-up 'life_change' would have been rejected by the constraint
    // and the row would have vanished on insert — and, because the drain filters
    // on values the column can hold, nothing here would ever have run.
    if (entityType === 'contact' && entry.enrichment_type === 'osint_profile') {
      const check = await (await import("@/lib/enrichment/contact-enrichment-core")).runLifeChangeCheck({
        contactId: entityId,
        brokerageId,
        supabase,
        trigger: entry.trigger_type,
      })
      await supabase
        .from('lead_enrichment_queue')
        .update({
          status: check.success ? 'completed' : 'failed',
          error_message: check.error ?? null,
          enrichment_results: { changes_found: check.changesFound, skipped: check.skipped ?? null },
          completed_at: new Date().toISOString(),
        })
        .eq('id', entry.id)
      if (check.success) result.succeeded++
      else result.failed++
      continue
    }

    try {
      // Step 3: Fetch entity
      const table = entityType === 'lead' ? 'leads' : 'contacts'
      const { data: entity, error: entityError } = await supabase
        .from(table)
        .select(ENTITY_COLUMNS[entityType])
        .eq('id', entityId)
        .single<Record<string, any>>()

      if (entityError || !entity) {
        throw new Error(`Entity not found in ${table}: ${entityId}${entityError ? ` (${entityError.message})` : ''}`)
      }

      // ── Step 4: PROVIDER SELECTION — "there is a free osint selection" ─────
      //
      // Two lanes answer DIFFERENT questions, so the router asks what the ROW
      // needs, not which vendor anyone prefers (see the boundary written out at
      // the top of lib/external/osint-free.ts):
      //   • FREE (keyless OSM + US Census) — place-keyed facts: geocode,
      //     neighbourhood amenities, ZIP-level ACS median value + its direction.
      //   • PAID (PeopleData) — person-keyed facts: identity, contact points,
      //     demographics. No free source in this lane holds any of them.
      //
      // FREE RUNS FIRST AND ALWAYS, whenever the record has address parts: the
      // address-derived facts must never be bought. The paid call is then
      // pre-flighted against the brokerage's vendor budget, which this drain
      // never did — it metered spend AFTER the fact and would happily run a
      // batch past an exhausted cap.
      //
      // checkVendorBudget is imported DYNAMICALLY for the reason stated at the
      // top of this file: lib/vendor-governance/budget-gate.ts is `server-only`
      // and a static import here would crash the plain-tsx guard simulators that
      // reach this module. It fails OPEN (a ledger read error returns allowed)
      // so a broken budget system never stops enrichment.
      const { checkVendorBudget } = await import('@/lib/vendor-governance/budget-gate')
      const budget = await checkVendorBudget({ brokerageId, addCost: PEOPLEDATA_UNIT_COST })

      const freeInput = freeLaneInputFor(entity)
      const plan = planEnrichmentLane({
        enrichmentType: entry.enrichment_type,
        input: freeInput,
        paidAllowed: budget.allowed,
        paidBlockedReason: budget.allowed
          ? null
          : `brokerage vendor budget exhausted ($${budget.spent.toFixed(2)} of $${budget.budget.toFixed(2)} this month)`,
      })

      // Step 4a: FREE LANE — zero cost, no key, runs before any spend.
      let free: FreeOsintLaneResult | null = null
      if (plan.free.run) {
        free = await runFreeOsintLane(freeInput, plan.free.answers)
        result.freeLaneRuns++

        // Metered as FREE. VENDOR_PRICING['osint_free'].costPerUnit is 0, so this
        // records the work without adding a cent to the ledger checkVendorBudget
        // reads. Without that pricing row normalizeVendorCost would have applied
        // its $0.01/unit unknown-vendor fallback and invented spend.
        const connectorCalls = free.connectors.filter((c) => c.outcome !== 'not_attempted').length
        if (connectorCalls > 0) {
          await trackVendorUsageService({
            vendor: 'osint_free',
            systemSource: 'enrichment',
            unitCount: connectorCalls,
            brokerageId,
            ...(entityType === 'lead' ? { leadId: entityId } : { contactId: entityId }),
            metadata: {
              lane: 'osint_free',
              cost: 0,
              queueEntryId: entry.id,
              enrichmentType: entry.enrichment_type,
              answered: free.answered,
              unavailable: free.unavailable,
            },
          })
        }

        // Persist what the free lane found, on its own terms. leads.lat/lng are
        // real columns nothing else in the pipeline fills; contacts have neither,
        // so the free geocode lands only in the profile block there.
        const freeBlock = freeLaneProfileBlock(free)
        const existingProfile = (entity.enrichment_profile ?? {}) as Record<string, unknown>
        const freePatch: Record<string, unknown> = {
          enrichment_profile: { ...existingProfile, osint_free: freeBlock },
        }
        if (entityType === 'lead' && free.facts.lat != null && free.facts.lng != null
            && entity.lat == null && entity.lng == null) {
          freePatch.lat = free.facts.lat
          freePatch.lng = free.facts.lng
        }
        const { error: freeWriteError } = await supabase.from(table).update(freePatch).eq('id', entityId)
        if (freeWriteError) {
          console.warn('[enrichment-orchestrator] free-lane write failed:', freeWriteError.message)
        }
        // Keep the in-memory copy in step with the row so the paid write below
        // merges onto the free block instead of overwriting it.
        entity.enrichment_profile = freePatch.enrichment_profile
      }

      // Step 4b: FREE-ONLY ROWS TERMINATE HERE. A 'property_match' row asks an
      // address question; escalating it to a person provider would buy the wrong
      // answer. The row closes on the free lane's own honesty — completed when it
      // ANSWERED, retried when its providers were UNREACHABLE (a keyless provider
      // being down is not a finding about the record).
      if (!plan.paid.required) {
        if (!plan.free.run) {
          throw new Error(`No lane serves enrichment_type '${entry.enrichment_type}' for this record — ${plan.free.reason}`)
        }
        const laneNote = describeFreeLane(free!)
        if (free!.answered.length > 0) {
          // supabase-js RESOLVES a failed write — destructure `error`. A silently
          // failed status write leaves the row stuck in 'processing' forever, which
          // the drain's `status = 'pending'` fetch will never pick up again.
          const { error: closeError } = await supabase
            .from('lead_enrichment_queue')
            .update({
              status: 'completed',
              enrichment_cost: 0,
              enrichment_results: {
                lane: plan.label,
                person_enrichment: 'not_applicable',
                free_osint: freeLaneProfileBlock(free!),
                note: laneNote,
              },
              error_message: free!.unavailable.length ? laneNote : null,
              completed_at: new Date().toISOString(),
            })
            .eq('id', entry.id)
          if (closeError) {
            console.error('[enrichment-orchestrator] free-lane queue close failed:', closeError.message)
          }
          result.succeeded++
        } else {
          const { nextRetry, isFinal, status } = enrichmentRetryOutcome(entry.retry_count, entry.max_retries ?? MAX_RETRIES)
          const { error: retryError } = await supabase
            .from('lead_enrichment_queue')
            .update({
              retry_count: nextRetry,
              status,
              enrichment_cost: 0,
              enrichment_results: { lane: plan.label, person_enrichment: 'not_applicable', free_osint: freeLaneProfileBlock(free!) },
              error_message: laneNote,
            })
            .eq('id', entry.id)
          if (retryError) {
            console.error('[enrichment-orchestrator] free-lane queue retry write failed:', retryError.message)
          }
          if (isFinal) {
            await supabase.from('automation_errors').insert({
              brokerage_id: brokerageId,
              workflow_name: 'enrichment_processor',
              lead_id: entityType === 'lead' ? entityId : null,
              error_message: `Free OSINT lane produced nothing after max retries — ${laneNote}`,
              context_json: JSON.stringify({ entityType, entityId, queueEntryId: entry.id, lane: plan.label, reason: free!.reachable ? 'no_data' : 'provider_unavailable' }),
              status: 'open',
              severity: 'low',
            })
          }
          result.failed++
        }
        continue
      }

      // Step 4c: PAID LANE WITHHELD. The person question is REQUIRED for this row
      // and the budget says no. Whatever the free lane found is already persisted,
      // but this row is NOT complete and must never be counted as such — a partial
      // place-keyed result presented as a finished enrichment is the failure mode
      // this whole selection exists to prevent. 'skipped' keeps it out of the retry
      // ladder (retrying against an exhausted cap just burns the three attempts);
      // the create-time and persona-drift triggers re-queue it later.
      if (!plan.paid.run) {
        const { error: withheldError } = await supabase
          .from('lead_enrichment_queue')
          .update({
            status: 'skipped',
            enrichment_cost: 0,
            enrichment_results: {
              lane: plan.free.run ? 'osint_free' : 'none',
              person_enrichment: 'withheld_budget',
              free_osint: free ? freeLaneProfileBlock(free) : null,
              note: plan.paid.reason,
            },
            error_message: `${plan.paid.reason}${free ? ` — ${describeFreeLane(free)}` : ''}`,
            completed_at: new Date().toISOString(),
          })
          .eq('id', entry.id)
        if (withheldError) {
          console.error('[enrichment-orchestrator] budget-withheld queue write failed:', withheldError.message)
        }
        result.paidWithheld++
        continue
      }

      // Step 4d: Validate identifier for the PAID person call
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
        // person likelihood + presence of structured email/address).
        //
        // THE FALLBACK USED TO BE `hasMailingData` — "the provider returned an address" recorded
        // as "the address is VERIFIED". That was already documented as a lie by
        // lib/providers/mailing-cass-gate.ts ("it is NEVER CASS/USPS-verified"), and the owner's
        // wave-14 conversion ruling made the flag load-bearing at the promotion gate: with the
        // old fallback, "a mailing address verified" would have degraded right back into "any
        // address string", which is the exact arm the ruling excludes. Absent an explicit
        // provider verdict the flag stays FALSE, and lib/lead-pipeline/promotion-address-verification.ts
        // buys the real Lob verdict at the gate for the records where it actually decides.
        const mvRaw = (enriched as any).mailingAddressVerified
        const mailingVerified: boolean = mvRaw === true
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

        // WHICH LANE PRODUCED WHAT — carried on the profile itself, because the
        // writes below REPLACE enrichment_profile wholesale. Without this the
        // free block written in step 4a would be silently dropped by the paid
        // write and the record would look like a pure PeopleData enrichment.
        // The free facts stay in their own `osint_free` sub-object with
        // AREA-scoped names; they are never merged up into the person fields.
        const priorFreeBlock = (entity.enrichment_profile as Record<string, unknown> | null)?.osint_free
        const freeBlock = free ? freeLaneProfileBlock(free) : (priorFreeBlock ?? null)
        if (freeBlock) profile.osint_free = freeBlock
        profile.lane = plan.label

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
              // Names the lane(s) that produced this row — 'peopledata' or
              // 'osint_free+peopledata'. The admin lead-lineage view renders it
              // verbatim, so provenance is visible without opening the jsonb.
              enrichment_provider: plan.label,
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
          // The error is READ. This is the entire PAID enrichment result landing on
          // the row — email, phones, demographics, confidence, the profile blob. The
          // queue entry is marked done immediately below either way, so a refusal
          // (one PGRST204 phantom column refuses the WHOLE row, not part of it) meant
          // money spent, queue drained, and nothing written.
          const { error: enrichmentWriteError } = await supabase
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
          if (enrichmentWriteError) {
            console.error(`[enrichment] contact enrichment write REFUSED for ${entityId} — paid result NOT persisted:`, enrichmentWriteError.message)
          }
        }

        // Step 6b: Update queue entry. The result carries the LANE STAMP so a
        // reader never has to guess whether the free lane contributed — and, when
        // it did, what it could and could not reach.
        await supabase
          .from('lead_enrichment_queue')
          .update({
            status: 'completed',
            enrichment_cost: cost,
            enrichment_results: {
              lane: plan.label,
              person_enrichment: 'peopledata',
              free_osint: free ? freeLaneProfileBlock(free) : null,
              ...(free && free.unavailable.length ? { free_osint_note: describeFreeLane(free) } : {}),
              peopledata: enriched as unknown as Record<string, unknown>,
            },
            completed_at: new Date().toISOString(),
          })
          .eq('id', entry.id)

        // Step 6c: Track vendor usage.
        // Vendor key is LOWERCASE 'peopledata' — the key VENDOR_PRICING actually
        // holds ($0.10/record). It was 'PeopleData', which no pricing row matches,
        // so normalizeVendorCost fell through to its $0.01/unit unknown-vendor
        // default and this lane under-reported its own spend by 10x in the same
        // ledger checkVendorBudget reads. lib/enrichment/contact-enrichment-core.ts
        // already meters it lowercase.
        await trackVendorUsageService({
          vendor: 'peopledata',
          systemSource: 'skip_trace',
          unitCount: 1,
          brokerageId,
          ...(entityType === 'lead' ? { leadId: entityId } : { contactId: entityId }),
          metadata: { entityType, entityId, queueEntryId: entry.id, cost, lane: plan.label },
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

            await bestEffort(
              supabase
                .from('contacts')
                .update({ last_scored_at: new Date().toISOString() })
                .eq('id', entityId),
              'round-robin recency stamp for the scorer; the score itself is already on the lead_score_history row inserted above and re-scoring is idempotent, so a lost stamp costs an early re-score, not a fact',
            )

            await supabase.from('lifecycle_events').insert({
              entity_type: 'contact',
              entity_id: entityId,
              brokerage_id: brokerageId,
              event_type: KernelEvent.CONTACT_SCORED,
              metadata: { score: scoreResult.finalScore },
              created_at: new Date().toISOString(),
            })

            // PERSONA-AT-ENRICHMENT (burn-down round 5): the moment verified
            // demographics land, the contact's detailed persona is built from
            // them — lead scoring, open-house follow-up and persona-aware
            // content all read client_detailed_personas (empty until now).
            // Best-effort; the routed-AI summary falls back deterministically.
            try {
              const { buildContactPersona } = await import('@/lib/contacts/persona-builder')
              const { generateTextRouted } = await import('@/lib/ai/models')
              await buildContactPersona(supabase as any, {
                contactId: entityId,
                brokerageId,
                agentId: (contact as any).agent_id ?? null, // contacts.agent_id is agents-class
                facts: {
                  ageRange: enriched.ageRange ?? (enriched.age ? String(enriched.age) : null),
                  maritalStatus: enriched.maritalStatus ?? null,
                  childrenCount: enriched.childrenCount ?? null,
                  householdSize: enriched.householdSize ?? null,
                  householdIncome: enriched.householdIncome ?? null,
                  homeOwnerStatus: enriched.homeOwnerStatus ?? null,
                  homeValue: enriched.homeValue ?? null,
                  occupation: enriched.currentTitle ?? null,
                  industry: enriched.currentIndustry ?? null,
                  // education is a structured array from the provider — persona
                  // psychographics wants the strongest single line.
                  education: Array.isArray(enriched.education)
                    ? (enriched.education[0]?.degree ?? enriched.education[0]?.school ?? null)
                    : ((enriched.education as string | undefined) ?? null),
                  lifeEvents: ((enriched as any).life_events ?? (enriched as any).lifeEvents ?? null) as string[] | null,
                  contactType: (contact as any).contact_type ?? null,
                },
                summarize: async (prompt) => {
                  const { text } = await generateTextRouted({
                    feature: 'client_message', brokerageId, prompt, temperature: 0.3, maxTokens: 180,
                  })
                  return text
                },
              })
            } catch { /* persona is additive — never blocks the enrichment ledger */ }
          }
        }

        result.succeeded++
      } else {
        // Step 7: No data returned — increment retry, log cost (API charged). On the
        // FINAL attempt terminalize to 'failed' (NOT 'pending') so a permanently-
        // unmatchable lead doesn't sit as a zombie 'pending' entry the fetch will never
        // pick up again, and surface it to automation_errors like the exception path.
        const { nextRetry, isFinal, status } = enrichmentRetryOutcome(entry.retry_count, entry.max_retries ?? MAX_RETRIES)
        await supabase
          .from('lead_enrichment_queue')
          .update({
            retry_count: nextRetry,
            enrichment_cost: cost,
            status,
            // The free lane may still have answered its own (place-keyed) questions
            // on this row. Recording that here is NOT a claim the person lookup
            // succeeded — `person_enrichment: 'no_match'` says plainly that it did not.
            enrichment_results: {
              lane: plan.label,
              person_enrichment: 'no_match',
              free_osint: free ? freeLaneProfileBlock(free) : null,
            },
            error_message: 'No match found in PeopleData'
              + (free ? ` — ${describeFreeLane(free)}` : ''),
          })
          .eq('id', entry.id)

        if (isFinal) {
          await supabase.from('automation_errors').insert({
            brokerage_id: brokerageId,
            workflow_name: 'enrichment_processor',
            lead_id: entityType === 'lead' ? entityId : null,
            error_message: 'No match found in PeopleData after max retries',
            context_json: JSON.stringify({ entityType, entityId, queueEntryId: entry.id, reason: 'no_match' }),
            status: 'open',
            severity: 'low',
          })
        }

        // Lowercase 'peopledata' — see the note at the matched path above; the
        // capitalised key missed VENDOR_PRICING and priced this call at $0.01.
        await trackVendorUsageService({
          vendor: 'peopledata',
          systemSource: 'skip_trace',
          unitCount: 1,
          brokerageId,
          ...(entityType === 'lead' ? { leadId: entityId } : { contactId: entityId }),
          metadata: { entityType, entityId, queueEntryId: entry.id, cost, result: 'no_match', lane: plan.label },
        })

        result.failed++
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const { nextRetry, isFinal, status } = enrichmentRetryOutcome(entry.retry_count, entry.max_retries ?? MAX_RETRIES)

      await supabase
        .from('lead_enrichment_queue')
        .update({
          retry_count: nextRetry,
          status,
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
