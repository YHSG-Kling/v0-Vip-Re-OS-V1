// lib/kernel/event-reactor.ts
// THE KERNEL EVENT REACTOR (Phase 1).
//
// Today the kernel bus only NOTIFIES humans (processKernelEvent). This reactor is the second half:
// it fans the SAME event into the agentic/automation side so the lead lifecycle, marketing, and
// (in later phases) AI-ISA / video / podcast / social react in real time instead of waiting for a
// polling cron to scan lifecycle_events.
//
// Phase 1 consumer = campaign enrollment, run REACTIVELY through the canonical campaign_sequences
// spine (enrollMatchingSequences). The legacy marketing_campaign_triggers path (System B) is RETIRED
// (fold step 2) — campaign_sequences is the sole enrollment spine. The reactor only ENROLLS; the
// actual sends stay downstream behind the channel adapters' compliance/TCPA/brand gates — so
// reacting on an event never auto-sends anything ungated.
//
// Idempotency: enrollMatchingSequences skips an already-active enrollment, so the reactor and the
// campaign-sequence-steps cron never double-enroll. Never throws — a reactor failure must never
// break the notification path that calls it.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { enrollMatchingSequences, writePortalUpdate } from "@/lib/kernel/event-fanout"
import { resolveEventContacts } from "@/lib/kernel/resolve-event-contacts"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"
import { KernelEvent } from "@/lib/kernel/events"

// Valid KernelEvent string values — used to gate sequence enrollment + portal so a non-KernelEvent
// lifecycle string (e.g. "milestone.completed") never runs the campaign_sequences query or a portal
// write it was never meant to trigger.
const VALID_KERNEL_EVENTS = new Set<string>(Object.values(KernelEvent))

/**
 * linkDualJourneys, best-effort. The linker (lib/kernel/dual-intent-linker.ts)
 * is idempotent and an honest no-op for a single-sided contact; here it must
 * never throw and never block the concierge fan-out that follows. Its failure
 * is LOGGED with the contact id — a lost link is a move-up buyer whose Listing
 * Concierge never wakes, which must not vanish silently.
 */
async function linkDualIntentBestEffort(
  contactId: string,
  svc: ReturnType<typeof createServiceClient>,
): Promise<void> {
  try {
    const { linkDualJourneys } = await import("@/lib/kernel/dual-intent-linker")
    const link = await linkDualJourneys(contactId, svc)
    if (link.linked) {
      console.log(`[event-reactor] dual-intent link ensured for contact ${contactId} (dependency ${link.dependency?.reason ?? "n/a"})`)
    }
  } catch (err) {
    console.error(`[event-reactor] dual-intent link failed for contact ${contactId} (non-blocking):`, err)
  }
}

export interface ReactorResult {
  matched:  number
  enrolled: number
  skipped:  number
  errors:   number
  /** Canonical campaign_sequences enrolled for the resolved contact(s) (idempotent). */
  sequencesEnrolled: boolean
  /** Client-facing portal card(s) written (only when the event has a template). */
  portalUpdated: boolean
}

export interface DispatchKernelEventParams {
  /** KernelEvent value (its enum string) — matched against campaign_sequences.trigger_event. */
  event:        string
  brokerageId:  string
  entityType:   string
  entityId:     string
  metadata?:    Record<string, unknown> | null
  // ── Optional client-side context (forwarded by fanOutKernelEvent). When absent — e.g. an emitter
  //    that calls processKernelEvent directly — the reactor resolves the contact from entity/metadata
  //    so templated events still reach the portal regardless of which path emitted them. ──
  contactId?:        string
  buyerContactId?:   string
  sellerContactId?:  string
  transactionId?:    string
  listingId?:        string
  agentUserId?:      string
  /** Set by emitters that ARE the sequence engine (step-executor / enrollment-engine) so the events
   *  they emit don't re-trigger enrollment — preventing an enroll → execute → emit → enroll feedback
   *  loop. Notifications + portal still fire. */
  suppressEnrollment?: boolean
}

/**
 * Fan one kernel event into the agentic reactor. Routes to (A) canonical campaign_sequences
 * enrollment and (C) the template-gated client portal — now centralized here so EVERY emitter (all
 * ~98, via processKernelEvent) gets them uniformly. (B) the legacy marketing-trigger enrollment is
 * retired. The portal writer is template-gated (internal events have no template → no client card)
 * and idempotent (no duplicate cards on retry/emit/overlap).
 */
export async function dispatchKernelEvent(params: DispatchKernelEventParams): Promise<ReactorResult> {
  const svc = createServiceClient()
  const isKnownEvent  = VALID_KERNEL_EVENTS.has(params.event)
  const enrollAllowed = !params.suppressEnrollment

  // (B) Marketing-trigger enrollment — RETIRED (fold step 2). System A (campaign_sequences via
  // enrollMatchingSequences, below) is now the SOLE enrollment spine; the legacy
  // marketing_campaign_triggers path + its marketing-trigger-engine cron are gone. The
  // marketing_campaign_touchpoints ledger that de-confliction / attribution / team-query read is
  // now fed by System A's own sends (lib/campaign-sequences/touchpoint-bridge.ts), so those
  // consumers keep working without the legacy enrollment path.

  let sequencesEnrolled = false
  let portalUpdated     = false

  // Sequence enrollment + portal are only meaningful for real KernelEvents (campaign_sequences and
  // PORTAL_UPDATE_TEMPLATES are both keyed by KernelEvent values). Skipping non-KernelEvent strings
  // here also avoids the wasted contact-resolution + sequence queries (code-review #4).
  if (isKnownEvent) {
    // Resolve the contact(s) once: prefer explicit ids forwarded by the emitter (buyer + seller for
    // two-sided deals); else use the shared resolver, which returns BOTH represented sides for a
    // transaction (code-review #2 — bare callers no longer drop the seller). Also enrich the
    // transaction/listing ids so the portal card links correctly.
    const explicit = [params.contactId, params.buyerContactId, params.sellerContactId].filter(Boolean) as string[]
    let contactIds = Array.from(new Set(explicit))
    let transactionId = params.transactionId
    let listingId     = params.listingId
    // Role hints passed to the portal writer so it can resolve buyer/seller WITHOUT depending on
    // contacts.contact_type (which is often null/"lead") — otherwise audience-gated seller/buyer cards
    // get silently skipped when the role can't be confirmed.
    let buyerHint  = params.buyerContactId
    let sellerHint = params.sellerContactId
    if (contactIds.length === 0) {
      try {
        const r = await resolveEventContacts(svc, params.entityType, params.entityId)
        contactIds = Array.from(new Set(
          [r.contactId, r.buyerContactId, r.sellerContactId].filter(Boolean) as string[],
        ))
        transactionId ??= r.transactionId
        listingId     ??= r.listingId
        buyerHint     ??= r.buyerContactId
        sellerHint    ??= r.sellerContactId
      } catch (err) {
        console.error("[event-reactor] contact resolution failed:", err)
      }
    }

    if (contactIds.length > 0) {
      // (A) CANONICAL campaign_sequences enrollment — idempotent (skips active enrollments); gated by
      // suppressEnrollment to break the sequence-engine feedback loop (code-review #3).
      if (enrollAllowed) {
        try {
          await enrollMatchingSequences(params.event as KernelEvent, params.brokerageId, contactIds, params.agentUserId)
          sequencesEnrolled = true
        } catch (err) {
          console.error("[event-reactor] sequence enrollment failed:", err)
        }
      }

      // (C) Client portal — template-gated (no template → no-op) + idempotent. Centralized here so a
      // templated event produces its card no matter which path emitted it.
      try {
        portalUpdated = await writePortalUpdate(
          {
            event:          params.event as KernelEvent,
            brokerageId:    params.brokerageId,
            entityType:     params.entityType,
            entityId:       params.entityId,
            contactId:      params.contactId,
            buyerContactId: buyerHint,
            sellerContactId:sellerHint,
            transactionId,
            listingId,
            agentUserId:    params.agentUserId,
            metadata:       (params.metadata ?? {}) as Record<string, any>,
          },
          contactIds,
        )
      } catch (err) {
        console.error("[event-reactor] portal update failed:", err)
      }
    }
  }

  // (D) Managed-Agent spawner — three per-entity Anthropic Managed Agents that run
  // autonomously off the request path. EARLY-START semantics: per the canonical business
  // process, the per-side agents kick the MOMENT a contact becomes buyer/seller (not
  // post-BBA / post-publish). They run phase-aware so the pre-representation work
  // (lender intro, qualification, listing-appointment scheduling, pre-listing CMA)
  // happens autonomously alongside the human agent.
  //
  // Triggers:
  //   - Deal Coordinator   — per transaction; on OFFER_ACCEPTED + TRANSACTION_STAGE_CHANGED
  //   - Buyer Concierge    — per buyer contact (or 'both'); on CONTACT_CREATED + BUYER_STATE_CHANGED
  //   - Listing Concierge  — per seller contact (or 'both'); on CONTACT_CREATED + LISTING_STAGE_CHANGED
  //
  // All three post back via the Anthropic webhook (app/api/webhooks/anthropic-agent) and
  // the shared spawn-helper handles idempotency at both the agent + session layers. Never
  // throws — missing ANTHROPIC_API_KEY (dev/staging) skips silently.
  if (params.brokerageId) {
    try {
      // Transaction-side
      if (
        params.entityType === "transaction" &&
        (params.event === KernelEvent.OFFER_ACCEPTED || params.event === KernelEvent.TRANSACTION_STAGE_CHANGED)
      ) {
        const { spawnDealCoordinatorForTransaction } = await import("@/lib/agents/deal-coordinator")
        await spawnDealCoordinatorForTransaction({ brokerageId: params.brokerageId, transactionId: params.entityId })
      }
      // Contact-side — early-start on CONTACT_CREATED + re-spawn on stage changes (idempotent).
      else if (
        params.entityType === "contact" &&
        (params.event === KernelEvent.CONTACT_CREATED ||
         params.event === KernelEvent.BUYER_STATE_CHANGED ||
         params.event === KernelEvent.BUYER_FINANCIALLY_VERIFIED ||
         params.event === KernelEvent.BUYER_SEARCH_CONFIGURED)
      ) {
        // Resolve contact_type to route to the right concierge. CONTACT_CREATED doesn't
        // carry contact_type in metadata; read from the row directly.
        const { createServiceClient } = await import("@/lib/supabase/service")
        const svc = createServiceClient()
        // DUAL-INTENT LINK — BEFORE the fan-out, so the contact_type read below sees
        // 'both' when this contact genuinely sells AND buys. linkDualJourneys had no
        // caller: the spine never writes contact_type='both' (motivationToContactType
        // maps it to buyer), so the Listing Concierge never woke for a move-up buyer
        // and the portal's dependency banner read a stamp nothing wrote. Idempotent
        // (upsert on journey_states.user_id, 24h card dedupe), an honest no-op when
        // only one side has signal; its failure is logged, never thrown — a broken
        // link must not stop the concierge that was going to spawn anyway.
        await linkDualIntentBestEffort(params.entityId, svc)
        const { data: c } = await svc
          .from("contacts").select("contact_type").eq("id", params.entityId).maybeSingle()
        const ct = (c?.contact_type as string | null) ?? null
        if (ct === "buyer" || ct === "both") {
          const { spawnShoppingAgentForBuyer } = await import("@/lib/agents/shopping-agent")
          await spawnShoppingAgentForBuyer({ brokerageId: params.brokerageId, contactId: params.entityId })
        }
        if (ct === "seller" || ct === "both") {
          const { spawnListingConciergeForSeller } = await import("@/lib/agents/listing-concierge")
          await spawnListingConciergeForSeller({ brokerageId: params.brokerageId, contactId: params.entityId })
        }
      }
      // Listing-side — re-spawn the seller-side concierge when listing stage changes (idempotent;
      // helper resolves the seller_contact_id from the listing).
      else if (
        params.entityType === "listing" &&
        (params.event === KernelEvent.LISTING_PUBLISHED || params.event === KernelEvent.LISTING_STAGE_CHANGED)
      ) {
        const { createServiceClient } = await import("@/lib/supabase/service")
        const svc = createServiceClient()
        const { data: l } = await svc
          .from("listings").select("seller_contact_id").eq("id", params.entityId).maybeSingle()
        if (l?.seller_contact_id) {
          // A seller listing appearing is the OTHER half of dual intent — the
          // seller who is also shopping. Same best-effort link as the contact side.
          await linkDualIntentBestEffort(l.seller_contact_id as string, svc)
          const { spawnListingConciergeForSeller } = await import("@/lib/agents/listing-concierge")
          await spawnListingConciergeForSeller({ brokerageId: params.brokerageId, contactId: l.seller_contact_id as string })
        }
      }
    } catch (err) {
      console.error("[event-reactor] managed-agent spawn failed:", err)
    }
  }

  // (D-bis) Wave 55 — buyer tour-completed AUTO-handoff (deliverable-gated). Reaching the
  // `tour_completed` journey stage emits TOUR_COMPLETED but spawned/produced nothing before;
  // propose a concrete next-steps follow-up to the buyer into the client_message gate.
  if (params.brokerageId && params.entityType === "contact" && params.event === KernelEvent.TOUR_COMPLETED) {
    try {
      const { produceTourFollowUp } = await import("@/lib/agents/tour-followup-producer")
      void produceTourFollowUp(params.brokerageId, params.entityId, svc)
    } catch { /* auto-producer is best-effort */ }
  }

  // (D-ter) Wave 57 — buyer offer-strategy AUTO-handoff (deliverable-gated). Reaching the
  // `offer_strategy` stage emits OFFER_STRATEGY_RECOMMENDED but reacted to nothing; propose
  // the offer game-plan to the buyer into the client_message gate before they write.
  if (params.brokerageId && params.entityType === "contact" && params.event === KernelEvent.OFFER_STRATEGY_RECOMMENDED) {
    try {
      const { produceOfferStrategyBrief } = await import("@/lib/agents/offer-strategy-producer")
      void produceOfferStrategyBrief(params.brokerageId, params.entityId, svc)
    } catch { /* auto-producer is best-effort */ }
  }

  // (D-quater) EVENT-FIRED JUST-IN-TIME EDUCATION — the spec's core thesis: deliver the stage-matched
  // lesson AT the milestone moment, not on the weekly poll. On any client-facing milestone event, fire the
  // education producer for the touched contact(s) (idempotent per contact+module; the weekly cron remains a
  // safety net). Reuses produceEducationForEvent → produceEducationDelivery; best-effort, never blocks.
  const EDUCATION_FIRING_EVENTS: KernelEvent[] = [
    KernelEvent.OFFER_ACCEPTED,
    KernelEvent.TRANSACTION_STAGE_CHANGED,
    KernelEvent.BUYER_STATE_CHANGED,
    KernelEvent.BUYER_FINANCIALLY_VERIFIED,
    KernelEvent.LISTING_PUBLISHED,
    KernelEvent.LISTING_STAGE_CHANGED,
    KernelEvent.LISTING_UNDER_CONTRACT,
  ]
  if (params.brokerageId && EDUCATION_FIRING_EVENTS.includes(params.event as KernelEvent)) {
    try {
      const { produceEducationForEvent } = await import("@/lib/agents/education-delivery-producer")
      void produceEducationForEvent({ brokerageId: params.brokerageId, entityType: params.entityType, entityId: params.entityId }, svc)
    } catch { /* just-in-time education is best-effort */ }
  }

  // (D-quinquies) CONTACT ENRICHMENT — the owner's ruling, event-driven.
  //
  //   "contact enrichment should happen as soon as a new contact comes in and
  //    also check if a life change or other change happens for the contact but
  //    not if they have an active listing or an active transaction; just before
  //    or after."
  //
  // TWO TRIGGERS, ONE SUPPRESSION.
  //
  // 1. AS SOON AS A NEW CONTACT COMES IN. There is no single code-level
  //    chokepoint for contact creation — nineteen distinct `contacts` INSERT
  //    sites exist across app/ and lib/ (enumerated in docs/wave3-enrichment.md),
  //    and hooking each one would leave the twentieth unhooked the day someone
  //    adds it. The kernel EVENT BUS is the closest thing to a chokepoint that
  //    actually exists: CONTACT_CREATED and CONTACT_CAPTURED are the two events
  //    the intake paths emit, every emitter reaches this reactor through
  //    emitKernelEvent / processKernelEvent, and a new door that emits either
  //    one is covered without being edited. The doors that emit NEITHER are
  //    picked up by the nightly net (app/api/cron/contact-enrichment), which is
  //    why that cron was revived rather than retired.
  //
  // 2. A LIFE CHANGE OR OTHER CHANGE. The re-check fires when a DEAL ENDS —
  //    which is precisely the owner's "or after". A transaction closing or a
  //    listing leaving its active stages is the moment suppression LIFTS, and it
  //    is also the moment the contact's circumstances have most likely changed
  //    (they just moved). Firing here means the re-check happens on a real
  //    signal instead of only on a 30-day timer; the timer stays in the cron as
  //    the net for contacts with no deal activity at all.
  //
  // BEST-EFFORT, ALWAYS. Both branches only ENQUEUE — one row and one event, no
  // vendor call — so contact creation is never blocked by, and can never fail
  // because of, enrichment. The queue writer applies the live-deal suppression
  // itself, and the drain re-applies it before spending, because a contact can
  // enter a deal between being queued and being processed.
  if (params.brokerageId && params.entityType === "contact") {
    const isCreate =
      params.event === KernelEvent.CONTACT_CREATED || params.event === KernelEvent.CONTACT_CAPTURED

    if (isCreate) {
      try {
        const { queueContactEnrichment } = await import("@/lib/enrichment/contact-enrichment-core")
        await queueContactEnrichment({
          contactId:   params.entityId,
          brokerageId: params.brokerageId,
          triggerType: params.event === KernelEvent.CONTACT_CREATED ? "contact_created" : "contact_captured",
          supabase:    svc,
        })
      } catch (err) {
        console.error("[event-reactor] contact enrichment enqueue failed:", err)
      }
    }
  }

  // (D-sexies) DEAL ENDED → re-check the contact for a life change.
  // Listed separately from the block above because the entity here is the
  // transaction or the listing, not the contact. Both sides of a dual deal are
  // covered: the emitter's explicit buyer/seller ids are preferred, and
  // resolveEventContacts — the same resolver the portal/sequence path uses,
  // which returns BOTH represented sides of a transaction — fills in for bare
  // emitters that forward only an entity id.
  const DEAL_END_EVENTS: string[] = [
    KernelEvent.TRANSACTION_CLOSED,
    KernelEvent.TRANSACTION_STAGE_CHANGED,
    KernelEvent.LISTING_STAGE_CHANGED,
  ]
  if (params.brokerageId && DEAL_END_EVENTS.includes(params.event)) {
    try {
      const { queueContactLifeChangeRecheck } = await import("@/lib/enrichment/contact-enrichment-core")
      let dealContacts = [
        params.contactId,
        params.buyerContactId,
        params.sellerContactId,
      ].filter((id): id is string => typeof id === "string" && id.length > 0)

      if (dealContacts.length === 0) {
        const r = await resolveEventContacts(svc, params.entityType, params.entityId)
        dealContacts = [r.contactId, r.buyerContactId, r.sellerContactId].filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        )
      }

      for (const contactId of [...new Set(dealContacts)]) {
        // The helper is the one that decides whether the deal has actually
        // ENDED — TRANSACTION_STAGE_CHANGED and LISTING_STAGE_CHANGED fire on
        // every stage move, most of which are mid-deal. It re-uses the same
        // isContactInLiveDeal predicate rather than parsing the event metadata,
        // so "the deal ended" means exactly "no live deal remains", which is the
        // condition the ruling actually names.
        await queueContactLifeChangeRecheck({
          contactId,
          brokerageId: params.brokerageId,
          triggerType: "deal_ended",
          supabase:    svc,
        })
      }
    } catch (err) {
      console.error("[event-reactor] deal-ended life-change re-check enqueue failed:", err)
    }
  }

  // (D-septies) LEAD ENRICHMENT — Track A. The owner's wave-5 ruling:
  //
  //   "enrichment also needs to still happen with raw leads"
  //
  // The DRAIN has always handled both tracks (enrichment-orchestrator.ts line 2:
  // "Processes BOTH lead_id rows (Track A) and contact_id rows (Track B)") and
  // lead_enrichment_queue carries both lead_id and contact_id. What was missing
  // was door coverage: enumerated the way wave 3 enumerated contacts, there are
  // exactly THREE `leads` INSERT sites in app/ + lib/ and not one of them queued
  // anything (docs/wave5-lead-enrichment.md).
  //
  // THE CHOKEPOINT. Only one of those three is live —
  // lib/lead-pipeline/pipeline-processor.ts — and it already emits
  // RAW_RECORD_PROMOTED with the new lead's id in metadata. So the event bus is
  // the lead-side chokepoint for the same reason it is the contact-side one: a
  // future promotion path that emits the event is covered without being edited.
  // LEAD_CAPTURED is listened for alongside it because
  // lib/kernel/lead-acquisition-handlers.ts:handleLeadCaptured emits it, and that
  // handler's own hand-rolled queue INSERT (no freshness check, no idempotency,
  // no identifier gate, no suppression, no budget gate) now routes through the
  // guarded writer instead. The two other doors emit nothing and are hooked
  // directly, by name, in the guard.
  //
  // ENTITY SHAPE. RAW_RECORD_PROMOTED's entity is the RAW RECORD, not the lead —
  // entityType 'raw_scraped_lead', entityId the raw_scraped_leads id — so the
  // lead id is read from metadata.lead_id. Using entityId here would hand a
  // raw_scraped_leads.id to a leads-keyed query: a different id space, and
  // exactly the substitution the enrichment lane refuses to make anywhere else.
  //
  // PARKED PLATFORM LEADS. A platform-origin lead is born with brokerage_id NULL
  // and only gains a tenant when Engine 1 distributes it, which happens AFTER
  // this emit. queueLeadEnrichment reads the lead `.eq("brokerage_id", …)`, so
  // such a lead returns `not_found` and is not queued — correct: nobody should
  // buy a record for a lead no tenant owns yet. The cron net
  // (listLeadsNeedingEnrichment) collects it once distribution gives it a home.
  //
  // BEST-EFFORT, ALWAYS. The branch only ENQUEUES — a few reads and one row, no
  // vendor call — and it is wrapped, so lead creation can never fail because of
  // enrichment. The writer applies suppression, freshness-by-evidence, the
  // identifier gate, the backlog cap and the budget pre-flight itself; the drain
  // re-checks before spending.
  const LEAD_CREATE_EVENTS: string[] = [
    KernelEvent.RAW_RECORD_PROMOTED,
    KernelEvent.LEAD_CAPTURED,
  ]
  if (params.brokerageId && LEAD_CREATE_EVENTS.includes(params.event)) {
    try {
      const metaLeadId = (params.metadata as Record<string, unknown> | null | undefined)?.lead_id
      const leadId =
        params.event === KernelEvent.LEAD_CAPTURED && params.entityType === "lead"
          ? params.entityId
          : typeof metaLeadId === "string" && metaLeadId.length > 0
            ? metaLeadId
            : null

      if (leadId) {
        const { queueLeadEnrichment } = await import("@/lib/enrichment/lead-enrichment-core")
        await queueLeadEnrichment({
          leadId,
          brokerageId: params.brokerageId,
          triggerType:
            params.event === KernelEvent.LEAD_CAPTURED ? "lead_captured" : "raw_record_promoted",
          supabase: svc,
        })
      }
    } catch (err) {
      console.error("[event-reactor] lead enrichment enqueue failed:", err)
    }
  }

  // (E) Contact-agent-assignment intro video — when contacts.agent_id is set
  // (the canonical assignment moment per the app rule: raw_leads → platform,
  // leads → AI ISA + brokerage, contacts → agents), fire a personalized D-ID
  // + cloned-voice intro. Trigger event m122 emits CONTACT_AGENT_ASSIGNED from
  // a Postgres trigger so every assignment path lands here uniformly.
  //
  // Gated on contacts.video_opt_out + agent_voice_profiles configured.
  // Idempotent via agent_intro_videos (m121). Never throws.
  if (
    params.brokerageId &&
    params.event === KernelEvent.CONTACT_AGENT_ASSIGNED
  ) {
    try {
      // entity_id is the contact_id (per the trigger). agent_id (agents.id)
      // comes either from metadata.agent_id or from the contact row.
      const { createServiceClient } = await import("@/lib/supabase/service")
      const svc = createServiceClient()
      const contactId = params.entityId
      const metaAgentId = (params.metadata as { agent_id?: string } | null | undefined)?.agent_id ?? null
      let agentRecordId: string | null = metaAgentId
      if (!agentRecordId) {
        const { data: c } = await svc
          .from("contacts").select("agent_id").eq("id", contactId).maybeSingle()
        agentRecordId = (c?.agent_id as string | null) ?? null
      }
      if (agentRecordId) {
        const { dispatchAssignmentIntroVideo } = await import("@/lib/video/intro-video-reactor")
        void dispatchAssignmentIntroVideo({
          brokerageId:  params.brokerageId,
          contactId,
          agentId:      agentRecordId,
          delivery:     "both",
        })
      }
    } catch (err) {
      console.error("[event-reactor] intro-video dispatch failed:", err)
    }
  }

  // (F) Just Listed auto-promo video — on LISTING_PUBLISHED, generate a
  // social-format "Just Listed" avatar video (D-ID + cloned voice) and
  // queue draft social_posts for FB / IG / LinkedIn via the downstream
  // listing-promo-social-publish cron. Idempotent via listing_promo_videos
  // (m124). Skips silently if the listing has no agent_id or its
  // brokerage_id mismatch.
  if (
    params.brokerageId &&
    params.event === KernelEvent.LISTING_PUBLISHED &&
    params.entityType === "listing"
  ) {
    try {
      const { createServiceClient } = await import("@/lib/supabase/service")
      const svc = createServiceClient()
      // listings.agent_id stores agents.id (per the live FK), but
      // listing_promo_videos.agent_id + ai_video_projects.agent_id +
      // agent_voice_profiles.agent_id all FK to users.id. Resolve via agents.user_id.
      const { data: l } = await svc
        .from("listings")
        .select("agent_id")
        .eq("id", params.entityId)
        .maybeSingle()
      const listingAgentRecordId = (l?.agent_id as string | null) ?? null
      let agentUserId: string | null = params.agentUserId ?? null
      if (!agentUserId && listingAgentRecordId) {
        const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
        agentUserId = await resolveAgentRecordToUserId(listingAgentRecordId)
      }
      if (agentUserId) {
        const { dispatchListingPromoVideo } = await import("@/lib/video/listing-promo-reactor")
        void dispatchListingPromoVideo({
          brokerageId: params.brokerageId,
          listingId:   params.entityId,
          agentUserId,
          eventType:   "just_listed",
        })
        // Wave 36 — parallel direct-mail dispatch. The mail reactor
        // reads lifecycle_promo_policy.mail_enabled per-(scope, event)
        // and skips cleanly when the brokerage hasn't opted in.
        const { dispatchLifecycleMail } = await import("@/lib/direct-mail/listing-lifecycle-mail-reactor")
        void dispatchLifecycleMail({
          brokerageId: params.brokerageId,
          listingId:   params.entityId,
          agentUserId,
          eventType:   "just_listed",
        })
      }
      // Wave 49 — cross-manager AUTO-handoff (deliverable-gated): auto-produce the
      // listing's paid-ad campaign + creative. Zero agent effort; the ONLY human gate
      // is the finished creative in the ad_creative approval queue.
      try {
        const { produceListingAdCampaign } = await import("@/lib/ads/listing-ad-producer")
        void produceListingAdCampaign(params.brokerageId, params.entityId, "just_listed", svc)
      } catch { /* auto-producer is best-effort */ }
    } catch (err) {
      console.error("[event-reactor] listing-promo dispatch failed:", err)
    }
  }

  // (F2) MARKETING HANDOFF made visible on the bus — on COMING_SOON_SENT / LISTING_PUBLISHED, announce
  // the Listing Concierge → Campaign Orchestrator handoff so the team coordination is LEGIBLE in the
  // managers-talking feed on EVERY transition path (voice/UI via transitionLifecycle AND the governance
  // layer via fanOutKernelEvent both land here). The kernel-event fanout already enrolled the marketing
  // sequences; this is the visible handoff, not a re-production. Idempotent per (listing, stage), so the
  // double-emit some callers do (direct processKernelEvent + transitionLifecycle) still publishes once.
  if (
    params.brokerageId &&
    params.entityType === "listing" &&
    (params.event === KernelEvent.COMING_SOON_SENT || params.event === KernelEvent.LISTING_PUBLISHED)
  ) {
    try {
      const { createServiceClient } = await import("@/lib/supabase/service")
      const svc = createServiceClient()
      const { data: lst } = await svc
        .from("listings")
        .select("address, city, state")
        .eq("id", params.entityId)
        .maybeSingle()
      const propertyAddress = [(lst as any)?.address, (lst as any)?.city, (lst as any)?.state]
        .filter(Boolean).join(", ") || null
      const targetStage = params.event === KernelEvent.LISTING_PUBLISHED ? "MLS_ACTIVE" : "COMING_SOON_ACTIVE"
      const { announceListingMarketingHandoff } = await import("@/lib/intelligence/listing-marketing-handoff-runner")
      await announceListingMarketingHandoff(
        { brokerageId: params.brokerageId, listingId: params.entityId, targetStage, propertyAddress },
        svc,
      )
    } catch (err) {
      console.error("[event-reactor] marketing handoff announce failed:", err)
    }
  }

  // (G) Wave 27 — extended lifecycle promo dispatcher. Each event below
  // routes through the same listing-promo-reactor with a different
  // event_type. The policy resolver inside the reactor gates auto-spawn
  // per (agent → team → brokerage → platform default), so this block is
  // safe to fan out: opted-out events return status='skipped' without
  // staging any render or spending render dollars.
  // NOTE: LISTING_PRICE_REDUCED is deliberately NOT auto-handled here. Advertising a
  // price drop is sensitive — many agents don't want it broadcast automatically — and
  // per the Lifecycle Event Contract §3 money-spending marketing must be AGENT-INITIATED,
  // not auto-fired by the system reactor. Price-reduction marketing is launched manually
  // via launchPriceReductionCampaign() (deliverable-gated in the ad_creative queue).
  if (
    params.brokerageId &&
    params.entityType === "listing" &&
    (
      params.event === KernelEvent.LISTING_STAGE_CHANGED ||
      params.event === KernelEvent.LISTING_UNDER_CONTRACT
    )
  ) {
    try {
      const { createServiceClient } = await import("@/lib/supabase/service")
      const svc = createServiceClient()
      const { data: l } = await svc
        .from("listings")
        .select("agent_id")
        .eq("id", params.entityId)
        .maybeSingle()
      const listingAgentRecordId = (l?.agent_id as string | null) ?? null
      let agentUserId: string | null = params.agentUserId ?? null
      if (!agentUserId && listingAgentRecordId) {
        const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
        agentUserId = await resolveAgentRecordToUserId(listingAgentRecordId)
      }
      // THE STAGE KEY (2026-09-07). This block read `metadata.new_stage` from wave 27
      // on; no emitter ever wrote that key. executeListingTransition
      // (app/actions/listing-lifecycle-core.ts) writes `from_stage` / `to_stage`,
      // in the UPPERCASE ListingStage vocabulary (lib/listing-lifecycle/
      // lifecycle-definitions.ts), and it is the only LISTING_STAGE_CHANGED
      // emitter carrying a stage at all. So every STAGE_CHANGED landed here with
      // newStage=null and the coming-soon / under-contract / just-sold promo,
      // mail, ad and testimonial dispatch below fired ONLY on the separate
      // LISTING_UNDER_CONTRACT event. Reader moved onto the writer's key and
      // vocabulary (§6); the comparisons below are lower-cased once here.
      const meta = params.metadata as { to_stage?: string; from_stage?: string } | null | undefined
      const newStage = meta?.to_stage ? String(meta.to_stage).toLowerCase() : null
      // Saved-home nudges to the buyers who SAVED this listing — the kinds no bus
      // signal carries (back_on_market is published by executeListingTransition as
      // listing_back_on_market; price_drop by (G2) below). Not marketing spend: a
      // 1:1 gated reel / portal note per follower, so it needs no agent policy
      // gate and no agentUserId — commissionVideo resolves the presenter later.
      {
        let savedHomeKind: import("@/lib/ai-isa/saved-home-nudge").SavedHomeNudgeKind | null = null
        if (params.event === KernelEvent.LISTING_UNDER_CONTRACT || newStage === "under_contract") savedHomeKind = "under_contract"
        else if (newStage === "coming_soon") savedHomeKind = "coming_soon"
        if (savedHomeKind) {
          const { nudgeSaversOfListing } = await import("@/lib/kernel/manager-signals")
          void nudgeSaversOfListing({ brokerageId: params.brokerageId, supabase: svc }, { listingId: params.entityId, nudgeKind: savedHomeKind })
            .catch((e) => console.error("[event-reactor] saved-home nudges failed:", e))
        }
      }
      if (agentUserId) {
        // Map kernel event → lifecycle event_type. STAGE_CHANGED inspects
        // metadata.to_stage (lower-cased above) to pick the right promo variant.
        let eventType: import("@/lib/video/listing-promo-reactor").ListingPromoEventType | null = null
        if (params.event === KernelEvent.LISTING_UNDER_CONTRACT) {
          eventType = "under_contract"
        } else if (params.event === KernelEvent.LISTING_STAGE_CHANGED) {
          if (newStage === "coming_soon")    eventType = "coming_soon"
          else if (newStage === "under_contract") eventType = "under_contract"
          else if (newStage === "sold" || newStage === "closed") eventType = "just_sold"
          // 'active' is covered by LISTING_PUBLISHED above; don't double-fire.
        }
        if (eventType) {
          // OWNER RULING (2026-09-08): "no video nudges for under contract." The
          // under_contract promo VIDEO is never auto-dispatched from here; the
          // variant stays in listing-promo-reactor for an agent-initiated launch.
          // Direct mail below is unchanged (policy-gated, not video).
          if (eventType !== "under_contract") {
            const { dispatchListingPromoVideo } = await import("@/lib/video/listing-promo-reactor")
            void dispatchListingPromoVideo({
              brokerageId: params.brokerageId,
              listingId:   params.entityId,
              agentUserId,
              eventType,
            })
          }
          // Wave 36 — parallel direct-mail dispatch (policy-gated).
          const { dispatchLifecycleMail } = await import("@/lib/direct-mail/listing-lifecycle-mail-reactor")
          void dispatchLifecycleMail({
            brokerageId: params.brokerageId,
            listingId:   params.entityId,
            agentUserId,
            eventType,
          })
          // Wave 49 — cross-manager AUTO-handoff on close: auto-produce the just-sold
          // ad creative (deliverable-gated in the ad_creative queue).
          if (eventType === "just_sold" && params.brokerageId) {
            try {
              const { produceListingAdCampaign } = await import("@/lib/ads/listing-ad-producer")
              void produceListingAdCampaign(params.brokerageId, params.entityId, "just_sold", svc)
            } catch { /* auto-producer is best-effort */ }
            // Wave 50 — deal-closed AUTO-handoff: propose a review/testimonial request to
            // the buyer + seller into the client_message gate (consent-enforced on send).
            try {
              const { produceClosingTestimonials } = await import("@/lib/agents/closing-testimonial-producer")
              void produceClosingTestimonials(params.brokerageId, params.entityId, svc)
            } catch { /* auto-producer is best-effort */ }
          }
        }
      }
    } catch (err) {
      console.error("[event-reactor] lifecycle promo dispatch failed:", err)
    }
  }

  // (G2) 2026-09-07 — a price DROP still reaches the buyers who saved the home.
  // This is the one exception to the NOTE above and it is not the thing the
  // note forbids: no broadcast, no spend — a 1:1 gated avatar reel per saved
  // follower (nudgeSaversOfListing → routeSavedHomeNudge → saved_home_reel_handoff).
  // LISTING_PRICE_REDUCED had no emitter until this wave; updateListing
  // (app/actions/listings.ts) now emits it beside the price-change ledger row.
  // The agent-initiated campaign path (app/actions/price-reduction-campaign.ts
  // → bus signal price_reduced) nudges the same savers; the bus dedupes per
  // open (contact, type), so a buyer is never nudged twice for one drop.
  if (
    params.brokerageId &&
    params.entityType === "listing" &&
    params.event === KernelEvent.LISTING_PRICE_REDUCED
  ) {
    try {
      const { createServiceClient } = await import("@/lib/supabase/service")
      const { nudgeSaversOfListing } = await import("@/lib/kernel/manager-signals")
      void nudgeSaversOfListing({ brokerageId: params.brokerageId, supabase: createServiceClient() }, { listingId: params.entityId, nudgeKind: "price_drop" })
        .catch((e) => console.error("[event-reactor] saved-home price-drop nudges failed:", e))
    } catch (err) {
      console.error("[event-reactor] saved-home price-drop dispatch failed:", err)
    }
  }

  // (H) Wave 27 — open-house announcement on schedule. Reminder is fired
  // separately by app/api/cron/open-house-reminder on a T-24h window.
  if (
    params.brokerageId &&
    params.event === KernelEvent.OPEN_HOUSE_SCHEDULED &&
    params.entityType === "open_house"
  ) {
    try {
      const { createServiceClient } = await import("@/lib/supabase/service")
      const svc = createServiceClient()
      // open_house_events row → listing_id + start_time + event_date for context
      const { data: oh } = await svc
        .from("open_house_events")
        .select("listing_id, event_date, start_time, agent_id")
        .eq("id", params.entityId)
        .maybeSingle()
      const ohRow = oh as { listing_id: string | null; event_date: string | null; start_time: string | null; agent_id: string | null } | null
      if (ohRow?.listing_id) {
        // 2026-09-07 — tell the buyers who saved this home there is an open house
        // (saved_home_message → campaign_orchestrator, gated portal note).
        try {
          const { nudgeSaversOfListing } = await import("@/lib/kernel/manager-signals")
          void nudgeSaversOfListing({ brokerageId: params.brokerageId, supabase: svc }, { listingId: ohRow.listing_id, nudgeKind: "open_house" })
            .catch((e) => console.error("[event-reactor] saved-home open-house nudges failed:", e))
        } catch { /* best-effort */ }
        // Resolve users.id from open_house_events.agent_id (FK to agents.id
        // per live schema, same pattern as listings.agent_id).
        let agentUserId: string | null = null
        if (ohRow.agent_id) {
          const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
          agentUserId = await resolveAgentRecordToUserId(ohRow.agent_id)
        }
        if (agentUserId) {
          const { dispatchListingPromoVideo } = await import("@/lib/video/listing-promo-reactor")
          const eventDateLine = [ohRow.event_date, ohRow.start_time].filter(Boolean).join(" ")
          void dispatchListingPromoVideo({
            brokerageId:  params.brokerageId,
            listingId:    ohRow.listing_id,
            agentUserId,
            eventType:    "open_house_announce",
            eventContext: eventDateLine ? { event_date: eventDateLine } : undefined,
          })
          // Wave 36 — parallel direct-mail dispatch for open-house
          // announce. (Open-house reminder direct mail fires from the
          // existing open-house-reminder cron once we add a mail
          // branch there in a follow-up commit.)
          const { dispatchLifecycleMail } = await import("@/lib/direct-mail/listing-lifecycle-mail-reactor")
          void dispatchLifecycleMail({
            brokerageId: params.brokerageId,
            listingId:   ohRow.listing_id,
            agentUserId,
            eventType:   "open_house_announce",
          })
        }
      }
    } catch (err) {
      console.error("[event-reactor] open-house announce dispatch failed:", err)
    }
  }

  // (D-octies) CROSS-MANAGER SIGNALS — kernel-event census round 3 (2026-09-09, lane EF).
  //
  // scripts/kernel-event-census-z1.ts classified these FIFTEEN KernelEvent members
  // "emitted only": a real emitter fires them (verified against each call site below),
  // and lifecycle_events records them, but nothing downstream ever reacted — the
  // insight was generated and then discarded. Per CLAUDE.md §1.2 (no duplicate exists,
  // the capability is wanted → BUILD) and the owner's ruling ("this OS runs autonomous
  // loops; every capability should run autonomously... rather than waiting for a
  // button"), each now publishes a manager_signals row (lib/kernel/manager-signals.ts,
  // the inter-manager bus) addressed to the manager whose domain should act on it. A
  // signal is NOT an outbound send and NOT spend — publishManagerSignal only inserts a
  // row the addressed manager's own loop later reads (consumeManagerSignals) and acts
  // on through its OWN gated deliverable path; nothing here dispatches anything.
  // Idempotent per (toManager, signalType, entityId) — publishManagerSignal dedupes any
  // still-open signal, so a re-emitted/retried event never doubles the inbox.
  //
  // Every block is best-effort and independently caught — a signal-publish failure must
  // never turn an event emission into a thrown error for whatever produced it.
  if (params.brokerageId) {
    // 1/2 — deal-health scan (app/api/cron/deal-health-scan/route.ts). Fires per scored
    // transaction; only signal when the score is not healthy, so a clean scan doesn't
    // spam Deal Coordinator's inbox every 6 hours.
    if (params.event === KernelEvent.DEAL_HEALTH_SCORE_UPDATED) {
      const riskLevel = (params.metadata as { risk_level?: string } | undefined)?.risk_level
      if (riskLevel && riskLevel !== "healthy") {
        try {
          await publishManagerSignal({
            brokerageId: params.brokerageId,
            fromManager: "data_steward",
            toManager:   "deal_coordinator",
            signalType:  "deal_health_score_updated",
            message:     `Transaction health score updated — risk level "${riskLevel}".`,
            entityType:  params.entityType,
            entityId:    params.entityId,
            payload:     params.metadata ?? {},
          }, svc)
        } catch { /* best-effort */ }
      }
    }
    if (params.event === KernelEvent.DEAL_AT_RISK_DETECTED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "deal_coordinator",
          signalType:  "deal_at_risk_detected",
          message:     "A transaction crossed into at-risk/critical health.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 3/4 — listing-health scan (lib/listing-health/health-scorer.ts). Same shape as the
    // deal-health pair above, addressed to Listing Concierge instead.
    if (params.event === KernelEvent.LISTING_HEALTH_SCORE_UPDATED) {
      const riskLevel = (params.metadata as { risk_level?: string } | undefined)?.risk_level
      if (riskLevel && riskLevel !== "healthy") {
        try {
          await publishManagerSignal({
            brokerageId: params.brokerageId,
            fromManager: "data_steward",
            toManager:   "listing_concierge",
            signalType:  "listing_health_score_updated",
            message:     `Listing health score updated — risk level "${riskLevel}".`,
            entityType:  params.entityType,
            entityId:    params.entityId,
            payload:     params.metadata ?? {},
          }, svc)
        } catch { /* best-effort */ }
      }
    }
    if (params.event === KernelEvent.LISTING_AT_RISK_DETECTED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "listing_concierge",
          signalType:  "listing_at_risk_detected",
          message:     "A listing crossed into at-risk/critical health.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 5 — SLA breach (lib/lead-governance/stale-lead-processor.ts). AI ISA owns lead
    // qualification/nurture and is the manager positioned to re-work a breached lead.
    if (params.event === KernelEvent.LEAD_SLA_BREACHED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "ai_isa",
          signalType:  "lead_sla_breached",
          message:     "A lead SLA target was missed.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.contactId ?? null,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 6 — buyer fatigue (lib/fatigue/fatigue-calculator.ts). Shopping Agent owns the
    // buyer journey and should throttle/vary outreach before the buyer disengages.
    if (params.event === KernelEvent.BUYER_FATIGUE_DETECTED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "shopping_agent",
          signalType:  "buyer_fatigue_detected",
          message:     "A buyer's engagement signals show fatigue.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.contactId ?? null,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 7/8 — video performance thresholds (app/api/video/engagement/route.ts). Campaign
    // Orchestrator tracks content performance; Asset Manager owns the media library and
    // decides whether to repurpose a high performer or retire a low one.
    if (params.event === KernelEvent.VIDEO_HIGH_PERFORMER_DETECTED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "campaign_orchestrator",
          toManager:   "asset_manager",
          signalType:  "video_high_performer_detected",
          message:     "A video cleared the high-performer thresholds — consider repurposing it.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }
    if (params.event === KernelEvent.VIDEO_LOW_PERFORMER_DETECTED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "campaign_orchestrator",
          toManager:   "asset_manager",
          signalType:  "video_low_performer_detected",
          message:     "A video fell below the low-performer thresholds — consider retiring or re-cutting it.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 9 — campaign ROI (lib/campaigns/roi-calculator.ts). Finance Manager tracks P&L and
    // hands the read to Campaign Orchestrator, who owns the campaign that earns/spends it.
    if (params.event === KernelEvent.CAMPAIGN_ROI_UPDATED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "finance_manager",
          toManager:   "campaign_orchestrator",
          signalType:  "campaign_roi_updated",
          message:     "A campaign's ROI figures were recalculated.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 10 — subscription cancelled (app/actions/billing.ts). Finance Manager owns the
    // brokerage's books and subscription state.
    if (params.event === KernelEvent.SUBSCRIPTION_CANCELLED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "finance_manager",
          signalType:  "subscription_cancelled",
          message:     "The brokerage's subscription was cancelled.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 11 — social post publish failure (app/api/cron/publish-social-posts/route.ts).
    // Campaign Orchestrator owns the schedule; Marketing Manager owns the brand/promotion
    // channel that needs a human or a retry.
    if (params.event === KernelEvent.SOCIAL_POST_FAILED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "campaign_orchestrator",
          toManager:   "marketing_agent",
          signalType:  "social_post_failed",
          message:     "A scheduled social post failed to publish.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 12 — agent license verification failure (lib/onboarding/license-verifier.ts).
    // Recruiting Manager owns onboarding; Compliance Officer owns regulatory governance
    // and is who can actually clear a license exception.
    if (params.event === KernelEvent.AGENT_LICENSE_FAILED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "recruiting_manager",
          toManager:   "compliance_officer",
          signalType:  "agent_license_failed",
          message:     "An agent's license verification failed and needs manual review.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 13 — appointment no-show (lib/kernel/appointment-noshow-autopilot.ts). That module
    // already proposes a gated warm re-book message to the CONTACT; this additionally
    // tells AI ISA (lead re-engagement) at the manager level so the no-show shows up in
    // its queue even if the per-contact deliverable is never approved.
    if (params.event === KernelEvent.APPOINTMENT_NO_SHOW) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "ai_isa",
          signalType:  "appointment_no_show",
          message:     "A scheduled appointment was a no-show.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.contactId ?? null,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 14 — listing stage transition refused (lib/listing-lifecycle/lifecycle-logger.ts).
    // Listing Concierge owns the seller side and needs to know a machine-gated move was
    // blocked, not just that nothing happened.
    if (params.event === KernelEvent.LISTING_STAGE_TRANSITION_FAILED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "listing_concierge",
          signalType:  "listing_stage_transition_failed",
          message:     "A listing stage transition was refused by the state machine.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 15 — sequence auto-paused on an inbound reply (lib/communication-spine/ingest-message-service.ts).
    // Campaign Orchestrator owns the sequence that paused; AI ISA owns the live
    // conversation the reply just started and should pick it up.
    if (params.event === KernelEvent.SEQUENCE_PAUSED_ON_REPLY) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "campaign_orchestrator",
          toManager:   "ai_isa",
          signalType:  "sequence_paused_on_reply",
          message:     "A nurture sequence paused because the contact replied.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.contactId ?? null,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }
  }

  // (D-novies) DISCLOSURE COMPLIANCE — AUTONOMOUS, on a transaction document
  // arriving. Owner ruling: this OS runs autonomous loops; every capability
  // should run on a manager signal / cron / kernel event rather than waiting
  // for someone to open the transaction and press "Check Disclosures". Both
  // KernelEvent.DOCUMENT_RECEIVED (app/actions/documents.ts::uploadDocument,
  // the live client_documents upload+classify path) and
  // KernelEvent.DOCUMENT_UPLOADED carry a transactionId when the document
  // belongs to a deal; only that case runs the check — an untenanted or
  // transaction-less upload (e.g. a vendor job document) has nothing for a
  // disclosure checklist to grade.
  //
  // Runs the SAME implementation the manual action calls (§6) —
  // lib/compliance/disclosure-check-runner.ts — so there is exactly one
  // disclosure-check verdict, never two. Best-effort: a failed autonomous run
  // must never break the upload that triggered it.
  const DOCUMENT_UPLOAD_EVENTS: string[] = [KernelEvent.DOCUMENT_RECEIVED, KernelEvent.DOCUMENT_UPLOADED]
  if (params.brokerageId && DOCUMENT_UPLOAD_EVENTS.includes(params.event)) {
    try {
      const meta = (params.metadata as Record<string, unknown> | null | undefined) ?? {}
      const transactionId =
        params.transactionId ||
        (typeof meta.transaction_id === "string" && meta.transaction_id.length > 0 ? meta.transaction_id : null)

      if (transactionId) {
        const { data: txn } = await svc
          .from("transactions")
          .select("property_state")
          .eq("id", transactionId)
          .eq("brokerage_id", params.brokerageId)
          .maybeSingle()

        // No property_state on file — refuse rather than guess a jurisdiction
        // (§4 fail closed: "nobody checked" must never render as "checked and
        // fine", and a disclosure list for the wrong state is worse than none).
        if (txn?.property_state) {
          const { runDisclosureComplianceCheck } = await import("@/lib/compliance/disclosure-check-runner")
          const check = await runDisclosureComplianceCheck(svc, {
            transactionId,
            brokerageId: params.brokerageId,
            userId: params.agentUserId ?? null,
            state: txn.property_state,
          })

          if (!check.success) {
            console.error(`[event-reactor] autonomous disclosure check failed for transaction ${transactionId}: ${check.error}`)
          } else if ((check.missingDisclosures?.length ?? 0) > 0 || (check.complianceScore ?? 100) < 100) {
            // Incomplete — signal deal_coordinator (owns the deal file/tasks)
            // rather than silently leaving the checklist for someone to find.
            // Never marks anything "ready" here; that verdict belongs to the
            // deal's own readiness gates, which read compliance_checklists.
            const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
            await publishManagerSignal(
              {
                brokerageId: params.brokerageId,
                fromManager: "compliance_officer",
                toManager: "deal_coordinator",
                signalType: "disclosure_check_incomplete",
                message:
                  `Disclosure compliance is at ${check.complianceScore ?? 0}% on this deal` +
                  (check.missingDisclosures?.length ? ` — missing: ${check.missingDisclosures.join(", ")}` : ""),
                entityType: "transaction",
                entityId: transactionId,
                payload: {
                  complianceScore: check.complianceScore ?? null,
                  missingDisclosures: check.missingDisclosures ?? [],
                  issues: check.issues ?? [],
                },
              },
              svc,
            )
          }
        }
      }
    } catch (err) {
      console.error("[event-reactor] autonomous disclosure check dispatch failed:", err)
    }
  }

  // matched/enrolled/skipped/errors are legacy marketing-trigger counters — System B enrollment
  // is retired, so they are always zero now (shape kept for callers of ReactorResult).
  return { matched: 0, enrolled: 0, skipped: 0, errors: 0, sequencesEnrolled, portalUpdated }
}
