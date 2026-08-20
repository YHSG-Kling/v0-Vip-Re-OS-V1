'use server'

import { createClient } from '@/lib/supabase/server'
import type { RawProcessingStatus } from "./processing-status"
import { calculateFuzzyMatch, isConfidentMatch } from './fuzzy-matcher'
import { extractPropertySpecs, leadSpecPatch } from '@/lib/data-steward/property-spec-extractor'
import { skipTraceWithPeopleData } from '@/lib/external'
import { mergeEnrichment, shouldGapFill, enrichViaPerplexity, type BaseEnrichment } from './perplexity-enrichment'
import { KernelEvent } from '@/lib/kernel/events'
import { emitKernelEvent } from '@/lib/kernel/emit'
import {
  calculateSourceScore,
  getSourceSemantics,
  scoreToUrgencyLevel,
  recordMatchesTerritory,
} from './source-intent-map'

// ─── Processing status state machine ─────────────────────────────────────────
// pending → processing → queued_for_enrichment | duplicate_pre_enrich
//   → enriching → duplicate_post_enrich | territory_mismatch
//   | insufficient_contact_data | insufficient_identity
//   | insufficient_identity_for_promotion → promoted | error
// ─────────────────────────────────────────────────────────────────────────────

// The vocabulary moved to lib/lead-pipeline/processing-status.ts so the cockpit
// and the database CHECK are generated from the SAME list. It used to be
// declared here and hand-copied into lead-intake-cockpit's REJECTION_STATUSES.
type ProcessingStatus = RawProcessingStatus

// RawRecord shape after reading from raw_scraped_leads
interface RawRecord {
  id: string
  brokerage_id: string
  market_id: string | null
  source: string
  source_record_id: string | null
  processing_status: ProcessingStatus
  raw_data: Record<string, unknown> | null
  // First-class identity + physical-address columns (parity with leads/contacts).
  // Mirror normalized_preview; preferred when resolving so the raw row maps column-to-column.
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  phone?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  zip_code?: string | null
  normalized_preview: {
    firstName?: string | null
    lastName?: string | null
    email?: string | null
    phone?: string | null
    city?: string | null
    state?: string | null
    zip?: string | null
    intentType?: string
    behaviorType?: string
    motivationScore?: number | null
    intentSignals?: string[]
    propertyAddress?: string | null
    mailingAddress?: string | null
    sourceUrl?: string | null
    leadIdentityKey?: string | null
  } | null
  // First-class mailing breakdown columns on raw_scraped_leads (populated at
  // ingestion / enrichment). Kept distinct from the physical address because a
  // contact can own a property but not live there.
  mailing_address?: string | null
  mailing_address_source?: string | null
  mailing_address_verified?: boolean | null
  mailing_city?: string | null
  mailing_state?: string | null
  mailing_zip?: string | null
  /** 'platform' (platform-scraped inventory, Engine 1 distributes) | 'brokerage'. */
  source_origin?: 'platform' | 'brokerage' | null
  lead_id: string | null
  error_message: string | null
}

export interface PipelineResult {
  success: boolean
  action: 'created' | 'merged' | 'skipped'
  leadId?: string
  reason: string
  stage: string
}

// Helper — update processing_status on raw_scraped_leads
async function setStatus(
  supabase: Awaited<ReturnType<typeof createClient>>,
  rawRecordId: string,
  status: ProcessingStatus,
  errorMessage?: string,
) {
  await supabase
    .from('raw_scraped_leads')
    .update({
      processing_status: status,
      ...(errorMessage ? { error_message: errorMessage } : {}),
      ...(status === 'promoted' || status === 'error' ? { processed_at: new Date().toISOString() } : {}),
    })
    .eq('id', rawRecordId)
}

export async function processRawRecord(rawRecordId: string, brokerageId?: string | null): Promise<PipelineResult> {
  const supabase = await createClient()

  // ── STEP 3: Read from raw_scraped_leads (not batchdata_motivated_sellers_raw) ──
  await setStatus(supabase, rawRecordId, 'processing')

  const { data: rawRecord, error: fetchError } = await supabase
    .from('raw_scraped_leads')
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

  const rec = rawRecord as RawRecord

  // ── STEP 3: Resolve fields — first-class raw column → normalized_preview → raw_data ──
  const firstName  = rec.first_name ?? rec.normalized_preview?.firstName  ?? (rec.raw_data?.firstName  as string | undefined) ?? null
  const lastName   = rec.last_name  ?? rec.normalized_preview?.lastName   ?? (rec.raw_data?.lastName   as string | undefined) ?? null
  const email      = rec.email      ?? rec.normalized_preview?.email      ?? (rec.raw_data?.email      as string | undefined) ?? null
  const phone      = rec.phone      ?? rec.normalized_preview?.phone      ?? (rec.raw_data?.phone      as string | undefined) ?? null
  const city       = rec.city       ?? rec.normalized_preview?.city       ?? (rec.raw_data?.city       as string | undefined) ?? null
  const state      = rec.state      ?? rec.normalized_preview?.state      ?? (rec.raw_data?.state      as string | undefined) ?? null

  // ── Territory gate — block before enrichment spend ────────────────────────
  // Load the market this record was scraped for and check city/state/zip match.
  // Raw records are platform-owned (brokerage_id NULL) until promotion; the
  // owning brokerage is resolved here from the scraped market's territory.
  let marketBrokerageId: string | null = null
  if (rec.market_id) {
    const { data: market } = await supabase
      .from('lead_scraping_markets')
      .select('city, state, zip_codes, brokerage_id')
      .eq('id', rec.market_id)
      .single()

    if (market) {
      marketBrokerageId = (market as { brokerage_id?: string | null }).brokerage_id ?? null
      const recordGeo = {
        city:  rec.normalized_preview?.city  ?? (rec.raw_data?.city  as string | null) ?? null,
        state: rec.normalized_preview?.state ?? (rec.raw_data?.state as string | null) ?? null,
        zip:   (rec.normalized_preview as any)?.zip ?? (rec.raw_data?.zip as string | null) ?? null,
      }

      const inTerritory = recordMatchesTerritory(recordGeo, market)

      if (!inTerritory) {
        await setStatus(supabase, rawRecordId, 'territory_mismatch')
        await logDeduplication({
          raw_record_id:             rawRecordId,
          stage:                     'territory_gate',
          match_score:               0,
          match_details:             { record_city: recordGeo.city, record_state: recordGeo.state, record_zip: recordGeo.zip, market_city: market.city, market_state: market.state },
          action_taken:              'skipped',
          skip_reason:               `Territory mismatch: ${recordGeo.city ?? recordGeo.zip} not in market ${market.city}, ${market.state}`,
          new_enrichment_confidence: null,
        }, supabase)
        return {
          success: false,
          action:  'skipped',
          reason:  `Territory mismatch: record geography is outside the scraped market`,
          stage:   'territory_gate',
        }
      }
    }
  }

  // ── Resolve the owning brokerage ──────────────────────────────────────────
  // Prefer an explicit brokerageId (manual broker-triggered scrapes) and fall
  // back to the brokerage that owns the scraped market (scheduled platform
  // scraping leaves raw_scraped_leads.brokerage_id NULL). Without either, the
  // record cannot be promoted to a tenant-scoped lead.
  const effectiveBrokerageId = brokerageId ?? marketBrokerageId
  if (!effectiveBrokerageId) {
    await setStatus(supabase, rawRecordId, 'unassigned_no_market')
    return {
      success: false,
      action: 'skipped',
      reason: 'Cannot resolve owning brokerage (no brokerageId passed and no market territory)',
      stage: 'brokerage_resolution',
    }
  }

  // ── Source semantics — score and derive intent fields ─────────────────────
  // Computed once before the identity gate; used on promotion.
  const sourceSemantics = getSourceSemantics(rec.source)
  const computedScore   = calculateSourceScore(
    rec.source,
    rec.normalized_preview?.intentSignals ?? [],
  )
  // urgency_level is derived from the FUSED score at promotion (scoreToUrgencyLevel below),
  // so the deterministic source baseline alone is no longer used for it here.

  // ── STEP 4B: Identity gate — require at least one usable anchor ────────────
  // Anchors: email, phone, full name + location, or property address.
  const hasEmail           = !!email?.trim()
  const hasPhone           = !!phone?.trim()
  const hasFullNameAndLoc  = !!(firstName && lastName && (city || state))
  const hasPropertyAddress = !!(rec.normalized_preview?.propertyAddress ?? rec.raw_data?.propertyAddress)
  const passesIdentityGate = hasEmail || hasPhone || hasFullNameAndLoc || hasPropertyAddress

  if (!passesIdentityGate) {
    await setStatus(supabase, rawRecordId, 'insufficient_identity')
    await logDeduplication({
      raw_record_id:            rawRecordId,
      stage:                    'identity_gate',
      match_score:              0,
      match_details:            {},
      action_taken:             'skipped',
      skip_reason:              'No usable identity anchor for enrichment spend',
      new_enrichment_confidence: null,
    }, supabase)
    return {
      success: false,
      action: 'skipped',
      reason: 'No usable identity anchor for enrichment spend',
      stage: 'identity_gate',
    }
  }

  // ── Pre-enrichment deduplication — THREE tables (canonical, owner round 38):
  // raw_scraped_leads AND leads AND contacts. Same identity resolution
  // (calculateFuzzyMatch email/phone/name normalization) across all three.
  await setStatus(supabase, rawRecordId, 'queued_for_enrichment')

  const dedupScope = { excludeRawId: rawRecordId, rawCreatedAt: (rawRecord as { created_at?: string | null }).created_at ?? null, marketId: rec.market_id }
  const preEnrichLookup = { first_name: firstName, last_name: lastName, email, phone }
  const preEnrichDuplicate = await findBestMatch(preEnrichLookup, 'pre_enrichment', effectiveBrokerageId, supabase, dedupScope)

  if (preEnrichDuplicate) {
    await setStatus(supabase, rawRecordId, 'duplicate_pre_enrich')
    await logDeduplication({
      raw_record_id:             rawRecordId,
      duplicate_of_lead_id:      preEnrichDuplicate.type === 'lead'    ? preEnrichDuplicate.id : null,
      duplicate_of_contact_id:   preEnrichDuplicate.type === 'contact' ? preEnrichDuplicate.id : null,
      stage:                     'pre_enrichment',
      match_score:               preEnrichDuplicate.score,
      match_details:             { ...preEnrichDuplicate.details, match_table: preEnrichDuplicate.type, ...(preEnrichDuplicate.type === 'raw' ? { duplicate_of_raw_id: preEnrichDuplicate.id } : {}) },
      action_taken:              'skipped',
      skip_reason:               'Pre-enrichment duplicate found',
      old_enrichment_confidence: preEnrichDuplicate.enrichment_confidence,
      new_enrichment_confidence: null,
    }, supabase)
    return {
      success: false,
      action: 'skipped',
      reason: 'Pre-enrichment duplicate found',
      stage: 'pre_enrichment_dedup',
    }
  }

  // ── Enrichment ──────────────────────────────────────────────────────────────
  await setStatus(supabase, rawRecordId, 'enriching')

  const enriched = await enrichWithPeopleData({ first_name: firstName, last_name: lastName, email, phone, city, state, brokerageId: effectiveBrokerageId })

  // ── Post-enrichment deduplication — same THREE tables as the pre-enrich pass
  // (raw_scraped_leads + leads + contacts), now with enrichment-filled identity.
  const postEnrichDuplicate = await findBestMatch(enriched, 'post_enrichment', effectiveBrokerageId, supabase, dedupScope)

  if (postEnrichDuplicate && postEnrichDuplicate.type === 'raw') {
    // Duplicate of another (older / already-promoted) RAW record that hasn't
    // become a lead/contact yet — skip this row; the earlier raw row owns the
    // identity and will promote (or already failed a gate honestly).
    await setStatus(supabase, rawRecordId, 'duplicate_post_enrich')
    await logDeduplication({
      raw_record_id:             rawRecordId,
      stage:                     'post_enrichment',
      match_score:               postEnrichDuplicate.score,
      match_details:             { ...postEnrichDuplicate.details, match_table: 'raw', duplicate_of_raw_id: postEnrichDuplicate.id },
      action_taken:              'skipped',
      skip_reason:               'Post-enrichment duplicate of an earlier raw record',
      new_enrichment_confidence: enriched.enrichmentConfidence,
    }, supabase)
    return {
      success: false,
      action: 'skipped',
      reason: 'Post-enrichment duplicate of an earlier raw record',
      stage: 'post_enrichment_dedup',
    }
  }

  if (postEnrichDuplicate) {
    const oldConfidence = postEnrichDuplicate.enrichment_confidence ?? 0
    const newConfidence = enriched.enrichmentConfidence ?? 0

    if (newConfidence > oldConfidence * 1.1) {
      const targetTable = postEnrichDuplicate.type === 'lead' ? 'leads' : 'contacts'

      // enrichment_status exists only on leads; contacts tracks confidence only.
      const mergeUpdate: Record<string, unknown> = {
        email:                 enriched.email || postEnrichDuplicate.email,
        phone:                 enriched.phone || postEnrichDuplicate.phone,
        enrichment_confidence: newConfidence,
        updated_at:            new Date().toISOString(),
      }
      if (targetTable === 'leads') {
        mergeUpdate.enrichment_status = 'completed'
      }

      await supabase
        .from(targetTable)
        .update(mergeUpdate)
        .eq('id', postEnrichDuplicate.id)

      await setStatus(supabase, rawRecordId, 'duplicate_post_enrich')
      await logDeduplication({
        raw_record_id:             rawRecordId,
        lead_id:                   postEnrichDuplicate.type === 'lead'    ? postEnrichDuplicate.id : null,
        duplicate_of_lead_id:      postEnrichDuplicate.type === 'lead'    ? postEnrichDuplicate.id : null,
        duplicate_of_contact_id:   postEnrichDuplicate.type === 'contact' ? postEnrichDuplicate.id : null,
        stage:                     'post_enrichment',
        match_score:               postEnrichDuplicate.score,
        match_details:             postEnrichDuplicate.details,
        action_taken:              'merged',
        skip_reason:               null,
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
      // Lossless dedup (data_steward dedup_merge contract — "fill empties, never drop"):
      // even though we keep the existing higher/equal-confidence record, FILL any empty
      // reachable contact field it lacks from this duplicate. A duplicate with a phone the
      // existing record is missing must not silently drop that phone.
      const fillEmpty: Record<string, unknown> = {}
      if (!postEnrichDuplicate.email && enriched.email) fillEmpty.email = enriched.email
      if (!postEnrichDuplicate.phone && enriched.phone) fillEmpty.phone = enriched.phone
      if (Object.keys(fillEmpty).length > 0) {
        await supabase
          .from(postEnrichDuplicate.type === 'lead' ? 'leads' : 'contacts')
          .update({ ...fillEmpty, updated_at: new Date().toISOString() })
          .eq('id', postEnrichDuplicate.id)
      }

      await setStatus(supabase, rawRecordId, 'duplicate_post_enrich')
      await logDeduplication({
        raw_record_id:             rawRecordId,
        duplicate_of_lead_id:      postEnrichDuplicate.type === 'lead'    ? postEnrichDuplicate.id : null,
        duplicate_of_contact_id:   postEnrichDuplicate.type === 'contact' ? postEnrichDuplicate.id : null,
        stage:                     'post_enrichment',
        match_score:               postEnrichDuplicate.score,
        match_details:             postEnrichDuplicate.details,
        action_taken:              Object.keys(fillEmpty).length > 0 ? 'merged' : 'skipped',
        skip_reason:               'Existing record has equal or better confidence (empties filled)',
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

  // ── STEP 4B: Promotion eligibility gate (CANONICAL — shared with lead-promoter) ─
  // Owner's canonical rule (wave 14): after enrichment + second dedup, promote when the
  // record carries a FIRST NAME and a LAST NAME plus at least ONE reachable channel —
  // an EMAIL and/or a PHONE and/or a VERIFIED MAILING ADDRESS. Names are fed
  // post-enrichment (enriched.first_name ?? firstName) so enrichWithPeopleData can SUPPLY
  // a missing name before this pass. Single source of truth in canonical-lead-eligibility
  // so the two historical paths can never drift apart.
  const { evaluateCanonicalLeadEligibility } =
    await import("@/lib/lead-pipeline/canonical-lead-eligibility")
  const rawAddrVerified = (rawRecord as any)?.mailing_address_verified
                        ?? (rawRecord.raw_data as any)?.mailing_address_verified
                        ?? false
  // Resolution order for the mailing address (same chain the lead insert uses):
  // enrichment result → raw first-class column → preview/raw_data jsonb.
  let resolvedMailingAddress =
    (enriched as any).mailing_address
    ?? rec.mailing_address
    ?? rec.normalized_preview?.mailingAddress
    ?? (rec.raw_data as any)?.mailing_address
    ?? null
  let resolvedMailingCity  = (enriched as any).mailing_city  ?? rec.mailing_city  ?? (rec.raw_data as any)?.mailing_city  ?? null
  let resolvedMailingState = (enriched as any).mailing_state ?? rec.mailing_state ?? (rec.raw_data as any)?.mailing_state ?? null
  let resolvedMailingZip   = (enriched as any).mailing_zip   ?? rec.mailing_zip   ?? (rec.raw_data as any)?.mailing_zip   ?? null
  let resolvedMailingVerified = !!((enriched as any).mailing_address_verified ?? rawAddrVerified)
  let resolvedMailingSource: string | null =
    (enriched as any).mailing_address_source
    ?? rec.mailing_address_source
    ?? (rec.raw_data as any)?.mailing_address_source
    ?? null

  const promoCandidate = {
    first_name:               enriched.first_name ?? firstName,
    last_name:                enriched.last_name  ?? lastName,
    email:                    enriched.email,
    phone:                    enriched.phone ?? phone,
    mailing_address:          resolvedMailingAddress,
    mailing_address_verified: resolvedMailingVerified,
  }
  let promoEligibility = evaluateCanonicalLeadEligibility(promoCandidate)

  // ── THE VERIFIED-ADDRESS ARM'S WRITER ──────────────────────────────────────
  // "a mailing address VERIFIED" is only a real arm of the gate if something
  // actually verifies. When the record is refused for want of a channel and its
  // address is the ONLY candidate anchor (no email, no phone), buy ONE Lob
  // US-verification (~$0.0025) and persist the verdict onto the raw row, then
  // re-evaluate against the same canonical gate. Bounded by construction: a
  // record reachable by email or phone never reaches this call, and an address
  // Lob already ruled undeliverable is never re-bought.
  // FAIL CLOSED: no LOB_API_KEY / a transient Lob failure verifies nothing, the
  // gate's refusal stands, and the record stays raw and retryable.
  if (!promoEligibility.eligible && promoEligibility.failing === "contact_anchor") {
    const { verifyMailingAddressForPromotion } =
      await import("@/lib/lead-pipeline/promotion-address-verification")
    const addrVerdict = await verifyMailingAddressForPromotion({
      candidate: {
        email:                    enriched.email,
        phone:                    enriched.phone ?? phone,
        mailing_address:          resolvedMailingAddress,
        mailing_city:             resolvedMailingCity,
        mailing_state:            resolvedMailingState,
        mailing_zip:              resolvedMailingZip,
        mailing_address_verified: resolvedMailingVerified,
        mailing_address_source:   resolvedMailingSource,
      },
      supabase,
      table: "raw_scraped_leads",
      id:    rawRecordId,
    })
    if (addrVerdict.ran) {
      resolvedMailingVerified = addrVerdict.verified
      // Carry Lob's STANDARDIZED parts onto the lead too — the raw row already
      // took the patch, and a lead holding the pre-standardized string would put
      // the two rows out of agreement the moment direct mail reads either one.
      const p = addrVerdict.patch
      if (typeof p.mailing_address_source === "string") resolvedMailingSource  = p.mailing_address_source
      if (typeof p.mailing_address        === "string") resolvedMailingAddress = p.mailing_address
      if (typeof p.mailing_city           === "string") resolvedMailingCity    = p.mailing_city
      if (typeof p.mailing_state          === "string") resolvedMailingState   = p.mailing_state
      if (typeof p.mailing_zip            === "string") resolvedMailingZip     = p.mailing_zip
      promoEligibility = evaluateCanonicalLeadEligibility({
        ...promoCandidate,
        mailing_address_verified: resolvedMailingVerified,
      })
    }
  }

  if (!promoEligibility.eligible) {
    await setStatus(supabase, rawRecordId, 'insufficient_identity_for_promotion')
    await logDeduplication({
      raw_record_id:             rawRecordId,
      stage:                     'promotion_identity_gate',
      match_score:               0,
      match_details:             { failing: promoEligibility.failing },
      action_taken:              'skipped',
      skip_reason:               promoEligibility.reason,
      new_enrichment_confidence: enriched.enrichmentConfidence,
    }, supabase)
    return {
      success: false,
      action: 'skipped',
      reason: `${promoEligibility.reason} — record remains raw without promotion`,
      stage: 'promotion_identity_gate',
    }
  }
  const promoFirst = (enriched.first_name ?? firstName ?? '').trim()
  const promoLast  = (enriched.last_name  ?? lastName  ?? '').trim()

  // ── AI INTENT AT INGEST — read the content, fuse it into the score ─────────
  // Best-effort: a confident high-intent read on content-bearing sources (social/search)
  // lifts the deterministic source baseline and fills lead_type when the source is ambiguous.
  // Structured sources (no text) and any model failure return null → source score stands.
  const {
    classifyRawRecordIntent, assembleRecordContent, fuseLeadScore, resolveLeadType,
  } = await import("@/lib/lead-pipeline/ai-intent-classifier")
  const { analyzeLead } = await import("@/lib/ai/lead-analyzer")
  const recordContent = assembleRecordContent(rec)
  const aiIntent = await classifyRawRecordIntent(
    { content: recordContent, authorName: [promoFirst, promoLast].filter(Boolean).join(" ") || undefined },
    analyzeLead,
  )
  const fusedScore = fuseLeadScore(computedScore, aiIntent)
  const fusedUrgency = scoreToUrgencyLevel(fusedScore)
  const sourceLeadType = sourceSemantics.leadType !== 'unknown'
    ? sourceSemantics.leadType
    : (rec.normalized_preview?.intentType as 'buyer' | 'seller' | 'unknown' | undefined ?? 'unknown')
  const fusedLeadType = aiIntent ? resolveLeadType(sourceLeadType, aiIntent.intentType) : sourceLeadType
  const fusedMotivationConfidence = aiIntent
    ? Math.max((rec.raw_data?.motivation_confidence as number | null) ?? (computedScore / 100), aiIntent.confidence * (aiIntent.score / 100))
    : ((rec.raw_data?.motivation_confidence as number | null) ?? (computedScore / 100))

  // ── STEP 5: Promote to leads with Kernel OS ownership fields ────────────────
  // LOSSLESS SPECS — pull beds/baths/sqft/type/value out of the raw jsonb so they're first-class on the
  // lead (additive: only sets what was actually scraped, never fabricated).
  const leadSpecs = leadSpecPatch(extractPropertySpecs([rec.raw_data as any, rec.normalized_preview as any]))
  const { data: newLead, error: createError } = await supabase
    .from('leads')
    .insert({
      ...leadSpecs,
      // PARKED-UNTIL-DISTRIBUTED (owner, round 39): platform-origin leads are born with
      // brokerage_id NULL — Engine 1 (distributePlatformLead, fired below) assigns the
      // subscriber brokerage by zip rotation. If NO subscriber serves the zip yet, the
      // lead stays PARKED (brokerage_id NULL, distribution_brokerage_id NULL): no tenant
      // sees it, the AI ISA never engages it (every ISA sweep selects by brokerage_id,
      // and initiate-engagement hard-refuses brokerage-less leads), and it is NEVER
      // deleted — the 2-hour platform-lead-distribution sweep retries until a subscriber
      // joins the zip, which un-parks it. Brokerage-origin leads keep the scraping
      // brokerage exactly as before. Parity with lib/lead-promotion/lead-promoter.ts.
      brokerage_id:          (rec.source_origin ?? 'brokerage') === 'platform' ? null : effectiveBrokerageId,
      first_name:            enriched.first_name  ?? firstName,
      last_name:             enriched.last_name   ?? lastName,
      email:                 enriched.email,
      phone:                 enriched.phone        ?? phone,
      phone_secondary:       enriched.phone_secondary ?? null,
      source:                rec.source,
      // Carry the platform/brokerage origin flag onto the lead — Engine 1
      // (platform distribution below) keys off leads.source_origin.
      source_origin:         rec.source_origin ?? 'brokerage',
      // STEP 5 + source-intent-map + AI intent fusion: source baseline, lifted by a confident
      // content read (lead_type filled when the source is ambiguous; score/urgency fused).
      lead_type:             fusedLeadType !== 'unknown' ? fusedLeadType : null,
      motivation_type:       (rec.raw_data?.motivation_type as string | null) ?? sourceSemantics.motivationType,
      motivation_confidence: fusedMotivationConfidence,
      urgency_level:         fusedUrgency,
      lead_score:            fusedScore,
      enrichment_status:     'completed',
      enrichment_confidence: enriched.enrichmentConfidence,
      last_enriched_at:      new Date().toISOString(),
      lead_stage:            'new',
      source_raw_ids:        [rawRecordId],
      // STEP 5 — Kernel OS ISA ownership fields
      lifecycle_state:       'unconsented',
      ai_isa_owner:          true,
      minimum_viable_for_isa: !!(enriched.email),
      // HONEST flag: eligibility can now pass on email alone (owner canonical rule), so the
      // verified flag carries what enrichment/raw actually determined — never a blanket true.
      // email_verified propagates whatever the enrichment determined (PeopleData / verification
      // step); when false the ISA email channel is blocked until a verification step lifts it.
      mailing_address_verified: resolvedMailingVerified,
      // Propagate the actual address (not just the flag) so the AI-ISA direct_mail channel has
      // something to send to — the resolver requires `lead.mailing_address && verified`.
      // Resolution order for every mailing field: enrichment result → raw first-class
      // column → preview/raw_data jsonb. The raw layer keeps mailing_* as first-class
      // columns, so they must be in the fallback chain or the breakdown is silently lost.
      mailing_address:       resolvedMailingAddress,
      // Carries 'lob_cass' when the gate's own verification ruled on this address,
      // so the direct-mail CASS gate does not re-buy a verdict we already paid for.
      mailing_address_source: resolvedMailingSource,
      // Carry the FULL address fidelity into leads (was dropping these → enrichment looked
      // incomplete and they never reached the contact): physical address + mailing breakdown.
      address:               rec.address ?? (rec.normalized_preview?.propertyAddress as string | null) ?? (rec.raw_data?.propertyAddress as string | null) ?? null,
      city:                  city,
      state:                 state,
      zip_code:              rec.zip_code ?? rec.normalized_preview?.zip ?? (rec.raw_data?.zip as string | null) ?? null,
      mailing_city:          resolvedMailingCity,
      mailing_state:         resolvedMailingState,
      mailing_zip:           resolvedMailingZip,
      email_verified:        (enriched as any).email_verified        ?? (rec as any).email_verified                  ?? (rec.raw_data as any)?.email_verified ?? false,
      raw_record_id:         rawRecordId,
    })
    .select()
    .single()

  if (createError || !newLead) {
    await setStatus(supabase, rawRecordId, 'error', createError?.message)
    throw new Error(`Failed to create lead: ${createError?.message}`)
  }

  // ── STEP 3: Update raw_scraped_leads with lead_id and promoted status ───────
  await supabase
    .from('raw_scraped_leads')
    .update({
      lead_id:           newLead.id,
      processing_status: 'promoted' as ProcessingStatus,
      processed_at:      new Date().toISOString(),
    })
    .eq('id', rawRecordId)

  await logDeduplication({
    raw_record_id:             rawRecordId,
    lead_id:                   newLead.id,
    stage:                     'lead_creation',
    match_score:               0,
    match_details:             {},
    action_taken:              'created',
    skip_reason:               null,
    new_enrichment_confidence: enriched.enrichmentConfidence,
  }, supabase)

  // Emit RAW_RECORD_PROMOTED through the canonical kernel emitter (does INSERT + reactor fan-out
  // in one call: notifications + sequences + portal). Non-blocking: emit() is never-throws and
  // the audit signal here must not break the lead-creation primary write.
  void emitKernelEvent({
    event:       KernelEvent.RAW_RECORD_PROMOTED,
    brokerageId: effectiveBrokerageId,
    entityType:  'raw_scraped_lead',
    entityId:    rawRecordId,
    metadata:    { lead_id: newLead.id, source: rec.source },
  })

  // ── Engine 1 — Platform Distribution (AUTOMATIC pipeline is the ONLY door) ──
  // Platform-origin leads route to the next-in-rotation subscriber brokerage by
  // zip service area; brokerage-origin leads skip (skip_non_platform_origin).
  // This used to fire only from the (removed) manual promoteLead action — the
  // canonical automatic pipeline now completes the platform lane itself.
  // Awaited so the lead has its distributed brokerage before downstream ISA work.
  if ((rec.source_origin ?? 'brokerage') === 'platform') {
    try {
      const { distributePlatformLead } = await import('@/lib/platform/distribution-engine')
      const distResult = await distributePlatformLead({ leadId: newLead.id })
      if (!distResult.success && distResult.reason !== 'skip_non_platform_origin') {
        // WRITTEN DELIBERATELY UNTENANTED, and it is the same defended case as
        // the platform-wide cron sweeps — not an oversight.
        //
        // This branch only runs for a PLATFORM-ORIGIN lead, which is created with
        // `brokerage_id: null` on purpose (the parked-until-distributed rule two
        // hundred lines above: "no tenant sees it"). What failed is Engine 1's
        // zip rotation deciding WHICH subscriber should get it — a platform
        // decision about a lead no brokerage owns yet.
        //
        // `effectiveBrokerageId` is in scope and is deliberately NOT used: it is
        // the market-territory owner, and stamping it would surface a platform
        // rotation failure inside one tenant's automations console, about a lead
        // that tenant is explicitly not permitted to see. The row is instead left
        // for the audience it belongs to — `lib/platform/ai-ops.ts:73` reads
        // `automation_errors` cross-tenant with NO brokerage predicate and its row
        // type carries `brokerageId: string | null`, and
        // `resolveAutomationErrorAction` resolves by id alone, so it is both
        // visible and resolvable there.
        const { error: distributionLogError } = await supabase.from('automation_errors').insert({
          brokerage_id: null,
          workflow_name: 'platform_lead_distribution',
          error_message: distResult.reason,
          context_json: JSON.stringify({ leadId: newLead.id, rawRecordId }),
          severity: 'high',
          status: 'open',
          created_at: new Date().toISOString(),
        })
        if (distributionLogError) {
          console.error('[pipeline-processor] automation_errors insert refused:', distributionLogError.message)
        }
      }
    } catch (err: any) {
      console.error(`[v0] Distribution engine failed for ${newLead.id}:`, err)
    }
  }

  return {
    success: true,
    action: 'created',
    leadId: newLead.id,
    reason: 'New lead created successfully',
    stage: 'lead_creation',
  }
}

// ─── Enrichment ───────────────────────────────────────────────────────────────

async function enrichWithPeopleData(fields: {
  first_name: string | null
  last_name:  string | null
  email:      string | null
  phone:      string | null
  city?:      string | null
  state?:     string | null
  brokerageId?: string | null
}): Promise<any> {
  const enrichmentResult = await skipTraceWithPeopleData({
    name:  [fields.first_name, fields.last_name].filter(Boolean).join(' ') || undefined,
    phone: fields.phone   || undefined,
    email: fields.email   || undefined,
  }).catch(() => ({ data: null }))

  const data = enrichmentResult.data
  let base: BaseEnrichment & {
    phone_secondary?: string | null
    peopleDataResult?: unknown
    email_verified?: boolean
    mailing_address?: string | null
    mailing_address_verified?: boolean
    mailing_address_source?: string | null
  } = data
    ? {
        first_name:               data.firstName   || fields.first_name,
        last_name:                data.lastName    || fields.last_name,
        email:                    data.emails?.[0] || fields.email,
        phone:                    data.phones?.[0] || fields.phone,
        phone_secondary:          data.phones?.[1] || null,
        enrichmentConfidence:     data.enrichmentConfidence ?? 0.5,
        // Surface PDL verification + structured mailing so the canonical eligibility gate +
        // AI-ISA channel resolver downstream actually have signal (previously these were dropped).
        email_verified:           (data as any).emailVerified === true,
        mailing_address:          (data as any).streetAddress ?? data.address ?? null,
        mailing_address_verified: (data as any).mailingAddressVerified === true,
        mailing_address_source:   (data as any).mailingAddressVerified ? 'enrichment' : null,
        peopleDataResult:         data,
      }
    : {
        first_name: fields.first_name,
        last_name:  fields.last_name,
        email:      fields.email,
        phone:      fields.phone,
        enrichmentConfidence: 0.3,
      }

  // Cost-gated Perplexity gap-fill: only when skip-trace left a full-name lead
  // without an email (high-value, identity-promising). No spend otherwise.
  if (shouldGapFill(base) && base.first_name && base.last_name) {
    const findings = await enrichViaPerplexity({
      firstName: base.first_name,
      lastName:  base.last_name,
      city:      fields.city,
      state:     fields.state,
      brokerageId: fields.brokerageId ?? undefined,
    })
    base = { ...base, ...mergeEnrichment(base, findings) }
  }

  return base
}

// ─── Deduplication matching ───────────────────────────────────────────────────
// CANONICAL THREE-TABLE DEDUP (owner round 38): every pass checks
// raw_scraped_leads AND leads AND contacts with the same identity resolution
// (calculateFuzzyMatch — normalized email/phone/name). Both the pre-enrich and
// post-enrich passes call this one function so the table set can never drift.

interface DedupScope {
  /** The raw record being processed — never match it against itself. */
  excludeRawId?: string | null
  /** Deterministic older-wins rule: only raw rows created BEFORE this row (or
   *  already promoted) count as the duplicate owner. */
  rawCreatedAt?: string | null
  marketId?: string | null
}

async function findBestMatch(
  record: { first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null },
  _stage: string,
  brokerageId: string,
  supabase: Awaited<ReturnType<typeof createClient>>,
  scope?: DedupScope,
): Promise<{ id: string; type: 'lead' | 'contact' | 'raw'; score: number; details: any; enrichment_confidence: number | null; email?: string; phone?: string } | null> {

  // Dedup must never reach across tenants: a brokerage's incoming lead can only
  // match its own existing leads/contacts. Without this filter a fuzzy match
  // could merge one brokerage's record into another's (PII cross-tenant leak).
  const { data: leads } = await supabase
    .from('leads')
    .select('id, first_name, last_name, email, phone, enrichment_confidence')
    .eq('brokerage_id', brokerageId)
    .eq('is_active', true)

  const { data: contacts } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, email, phone')
    .is('deleted_at', null)
    .eq('brokerage_id', brokerageId)

  // RAW-vs-RAW dedup: the same person scraped twice (different sources, or a
  // re-scrape) must not be enriched/promoted twice. Raw rows are platform-owned
  // (brokerage_id NULL) until promotion, so tenant scoping goes through the
  // markets this brokerage owns (market_id → lead_scraping_markets.brokerage_id)
  // plus any rows already stamped with this brokerage_id. Candidates are
  // narrowed by exact email/phone (a name-only raw match is never confident) and
  // confirmed by the same fuzzy matcher as leads/contacts.
  let rawRows: any[] = []
  if (record.email?.trim() || record.phone?.trim()) {
    const { data: brokerageMarkets } = await supabase
      .from('lead_scraping_markets')
      .select('id')
      .eq('brokerage_id', brokerageId)
    const marketIds = ((brokerageMarkets ?? []) as Array<{ id: string }>).map((m) => m.id)

    const identityFilters = [
      ...(record.email?.trim() ? [`email.eq.${record.email.trim()}`] : []),
      ...(record.phone?.trim() ? [`phone.eq.${record.phone.trim()}`] : []),
    ].join(',')
    const scopeFilters = [
      `brokerage_id.eq.${brokerageId}`,
      ...(marketIds.length > 0 ? [`market_id.in.(${marketIds.join(',')})`] : []),
    ].join(',')

    const { data: rawCandidates } = await supabase
      .from('raw_scraped_leads')
      .select('id, first_name, last_name, email, phone, lead_id, processing_status, created_at')
      .or(identityFilters)
      .or(scopeFilters)
      .limit(25)

    rawRows = ((rawCandidates ?? []) as any[]).filter((r) => {
      if (scope?.excludeRawId && r.id === scope.excludeRawId) return false
      // Deterministic older-wins: an earlier row (or one already promoted to a
      // lead) owns the identity; later rows are the duplicates.
      if (r.processing_status === 'promoted' || r.lead_id) return true
      if (!scope?.rawCreatedAt || !r.created_at) return false
      return r.created_at < scope.rawCreatedAt
    })
  }

  const allRecords = [
    ...(leads    || []).map((l: any) => ({ ...l, type: 'lead'    as const })),
    ...(contacts || []).map((c: any) => ({ ...c, type: 'contact' as const, enrichment_confidence: null })),
    // A raw duplicate that already promoted resolves to ITS LEAD (merge target);
    // an unpromoted older raw row surfaces as type 'raw' (skip, no merge target).
    ...rawRows.map((r: any) => r.lead_id
      ? { ...r, id: r.lead_id, type: 'lead' as const, enrichment_confidence: null }
      : { ...r, type: 'raw' as const, enrichment_confidence: null }),
  ]

  let bestMatch: typeof allRecords[0] & { score: number; details: any } | null = null
  let highestScore = 0

  for (const existing of allRecords) {
    const result = calculateFuzzyMatch(record as any, existing)
    // Auto-merge ONLY on a confident match — a high score backed by a STRONG identifier
    // (exact email or phone). A name-only match (score 1.0 from name alone) is NOT
    // enough: it would conflate distinct people who share a name. Such records proceed
    // to enrichment and are re-deduped once they carry a real identifier.
    if (isConfidentMatch(result) && result.score > highestScore) {
      highestScore = result.score
      bestMatch = { ...existing, score: result.score, details: result.details }
    }
  }

  return bestMatch
}

// ─── Audit logging ────────────────────────────────────────────────────────────

async function logDeduplication(log: any, supabase: Awaited<ReturnType<typeof createClient>>) {
  try {
    await supabase.from('lead_deduplication_log').insert(log)
  } catch (err: unknown) {
    // Silent fail - logging should not block deduplication
  }
}
