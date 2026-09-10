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
import type { ManagerKey } from "@/lib/kernel/manager-registry"
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
    // spam Deal Coordinator's inbox every 6 hours. CADENCE, not an edge trigger — fires on
    // every scan of this transaction while unhealthy (see D-undecies #1 deal_health_changed,
    // the TIER-TRANSITION edge sibling, for the full three-way relationship with
    // DEAL_AT_RISK_DETECTED below).
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

    // 7/8 — video performance thresholds (app/api/video/engagement/route.ts). Wave 50
    // owner ruling ("video snippet should be asset manager from"): every video/asset-lane
    // moment is published FROM Asset Manager, the asset owner — not Campaign Orchestrator,
    // who never ran the video pipeline. Asset Manager decides whether to repurpose a high
    // performer or retire a low one, so it is also the TO (a self-addressed feed entry,
    // same shape as the rest of the video lane below).
    if (params.event === KernelEvent.VIDEO_HIGH_PERFORMER_DETECTED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
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
          fromManager: "asset_manager",
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
    // brokerage's books and subscription state — the billing action happens IN Finance's
    // own domain, so it is the FROM (wave 50: never a default data_steward stamp when a
    // domain-owning manager's own action caused the moment), self-addressed for its feed.
    if (params.event === KernelEvent.SUBSCRIPTION_CANCELLED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "finance_manager",
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
    // TOMBSTONE (m618) — was campaign_orchestrator (schedule owner) -> marketing_agent
    // (retired "brand/promotion channel" seat). Survivor campaign_orchestrator now owns
    // BOTH ends, so a same-manager route is invalid (validSignalRoute requires from !==
    // to); cron_manager (the scheduled-send infra that detected the failure — same shape
    // as CRON_FAILED and PODCAST_EPISODE_FAILED's infra-manager -> content-owner pattern)
    // reports it to campaign_orchestrator, who owns the channel and must retry or flag it.
    if (params.event === KernelEvent.SOCIAL_POST_FAILED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "cron_manager",
          toManager:   "campaign_orchestrator",
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
    // Listing Concierge owns the seller side and the state machine that refused the move —
    // a listing-domain moment (wave 50), not a data-quality/ledger one, so it is the FROM,
    // self-addressed so it needs to know a machine-gated move was blocked, not just that
    // nothing happened.
    if (params.event === KernelEvent.LISTING_STAGE_TRANSITION_FAILED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "listing_concierge",
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

  // (D-decies) CROSS-MANAGER SIGNALS — kernel-event census round 4 (2026-09-09, wave 47).
  //
  // scripts/kernel-event-census-z1.ts classified these TWENTY MORE KernelEvent members
  // "emitted only" after wave 46's fifteen (D-octies): a real emitter fires them and
  // lifecycle_events records them, but nothing downstream ever reacted. Same ruling as
  // D-octies (CLAUDE.md §1.2 + the owner's "every capability should run autonomously"):
  // each publishes a manager_signals row addressed to the manager whose domain should act
  // on it. EIGHT of the twenty are HANDLED — a real consumer proposes a gated deliverable
  // (a client message, a task-due reminder, a social post, an earnings notification)
  // through the SAME existing gated primitives D-octies and the rest of this file use
  // (proposeClientMessage / transaction task / notifications insert) — never an outbound
  // send, never spend. The rest are feed_only: visibility for the owning manager, same as
  // most of D-octies. Every block is best-effort and independently caught — a signal-
  // publish failure must never turn an event emission into a thrown error for whatever
  // produced it. Idempotent per (toManager, signalType, entityId) via publishManagerSignal's
  // own dedupe.
  if (params.brokerageId) {
    // 16 — AI ISA scheduled an appointment through the GENERAL booking path
    // (lib/ai-isa/appointment-scheduler.ts — self-serve/chat/link booking; distinct from
    // the dial-batch CALL outcome, which already fires isa_call_appointment above). Routed
    // by contact side so the right concierge preps the follow-up: seller contacts to
    // Listing Concierge, everyone else (buyer contacts; a lead defaults buyer-side until it
    // converts, since a lead has no contact_type to read) to Shopping Agent. HANDLED —
    // both consumers propose the same gated prep-follow-up message.
    if (params.event === KernelEvent.ISA_APPOINTMENT_SCHEDULED) {
      try {
        let toManager: "shopping_agent" | "listing_concierge" = "shopping_agent"
        if (params.entityType === "contact" && params.entityId) {
          const { data: c } = await svc
            .from("contacts").select("contact_type")
            .eq("id", params.entityId).eq("brokerage_id", params.brokerageId).maybeSingle()
          if ((c as { contact_type?: string } | null)?.contact_type === "seller") toManager = "listing_concierge"
        }
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "ai_isa",
          toManager,
          signalType:  "isa_appointment_scheduled",
          message:     "AI ISA scheduled an appointment.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.entityType === "contact" ? params.entityId : (params.contactId ?? null),
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 17 — a client portal message has gone past the reply SLA (app/api/cron/
    // message-needs-response). HANDLED — AI ISA notifies the assigned agent directly
    // (metadata.agent_id is an AGENTS id, resolved to the user in the handler) so the
    // overdue reply surfaces beyond the portal's own unread badge.
    if (params.event === KernelEvent.MESSAGE_NEEDS_RESPONSE) {
      try {
        const meta = (params.metadata as { agent_id?: string | null; sla_hours?: number } | null | undefined) ?? {}
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "ai_isa",
          signalType:  "message_needs_response",
          message:     `A client portal message has gone unanswered past the ${meta.sla_hours ?? "SLA"}h target.`,
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.contactId ?? null,
          payload:     { agent_id: meta.agent_id ?? null },
        }, svc)
      } catch { /* best-effort */ }
    }

    // 18 — an agent finished onboarding + certification (lib/onboarding/
    // certification-engine.ts completeOnboarding). HANDLED — Recruiting Manager (owns
    // onboarding) hands it to Campaign Orchestrator (content/social owner), which
    // proposes a GATED welcome/congrats social post — the positive-milestone mirror of
    // the certification_issued handoff wave 46 already built.
    if (params.event === KernelEvent.ONBOARDING_COMPLETED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "recruiting_manager",
          toManager:   "campaign_orchestrator",
          signalType:  "onboarding_completed",
          message:     "An agent completed onboarding and certification.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 19 — a scanned business card was APPROVED (app/actions/business-card/
    // business-card-actions.ts). Wave 48 (owner ruling 2026-09-10, verbatim): "the
    // kernel events scanned business card shouldn't be assumed contact ... sphere of
    // influence/other agent/potential contact ... card reader or agents notes can
    // determine." Wave 47's original body here ALWAYS routed to Sphere assuming a
    // contacts row existed — exactly the assumption this ruling forbids. Now routed
    // by metadata.card_subject_type (lib/contacts/card-classifier.ts classifyCardSubject,
    // folded with the action's own existing-user/contact/vendor match + review-surface
    // picker), one signal_type per class, each addressed to the manager that owns that
    // relationship shape:
    //   sphere / contact  → Sphere of Influence  (warm first-touch intro — unchanged)
    //   potential_contact → AI ISA               (gated first-touch, no outbound send)
    //   agent             → Recruiting Manager    (a recruiting prospect, never a CRM contact)
    //   vendor            → Asset Manager         (a bench candidate — most vendor families a
    //                                              card names, photographer/videographer/
    //                                              drone_pilot/3d_tour foremost, ARE Asset
    //                                              Manager's own content-creation supply chain)
    //   unknown           → Sphere of Influence, FEED-ONLY (ask the agent to classify — never
    //                                              silently treated as any of the above)
    if (params.event === KernelEvent.BUSINESS_CARD_APPROVED) {
      try {
        const meta = (params.metadata ?? {}) as { card_subject_type?: string | null }
        // Pre-wave-48 emitters (if any survive in a queued/replayed event) carried no
        // classification at all — NOT the same as a card the wave-48 action classified
        // 'unknown'; treat that absence as the legacy always-a-contact shape so an old
        // event still reaches Sphere, never a wrong new manager.
        const subjectType = meta.card_subject_type ?? "contact"
        // subject_user_type (owner ruling 2026-09-10: "should be a userid user
        // type") rides through untouched below — business-card-actions.ts
        // resolved it from the REAL matched users.user_type row, not a reader
        // guess, and payload:params.metadata forwards it to the receiving
        // manager (e.g. recruiting_manager sees the actual seat type, not just
        // that a card LOOKED like an agent's).
        const ROUTE: Record<string, { toManager: ManagerKey; signalType: string; message: string }> = {
          sphere: {
            toManager: "sphere_of_influence", signalType: "business_card_approved",
            message: "A scanned business card was classified SPHERE OF INFLUENCE — a warm first-touch intro, not a CRM contact.",
          },
          contact: {
            toManager: "sphere_of_influence", signalType: "business_card_approved",
            message: "A scanned business card was approved into a contact.",
          },
          potential_contact: {
            toManager: "ai_isa", signalType: "business_card_potential_contact_candidate",
            message: "A scanned business card was classified a POTENTIAL contact — propose a gated first-touch (no outbound send).",
          },
          agent: {
            toManager: "recruiting_manager", signalType: "business_card_recruit_candidate",
            message: "A scanned business card was classified AGENT (a fellow real-estate agent) — a recruiting prospect, never a CRM contact.",
          },
          vendor: {
            toManager: "asset_manager", signalType: "business_card_vendor_candidate",
            message: "A scanned business card was classified VENDOR — a bench candidate for the content-creation vendors (photographer/videographer/drone/3D-tour) Asset Manager sources.",
          },
          unknown: {
            toManager: "sphere_of_influence", signalType: "business_card_classification_needed",
            message: "A scanned business card could not be classified from the reader or the agent's notes — classify it on the card review surface.",
          },
        }
        const picked = ROUTE[subjectType] ?? ROUTE.unknown
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   picked.toManager,
          signalType:  picked.signalType,
          message:     picked.message,
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.entityType === "contact" ? params.entityId : (params.contactId ?? null),
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 20 — a task is due within 24h (app/api/cron/task-due). HANDLED — Deal Coordinator
    // reminds the assigned agent directly (metadata.assigned_to_agent_id is an AGENTS id,
    // resolved to the user in the handler) rather than leaving it to be found on a board.
    if (params.event === KernelEvent.TASK_DUE) {
      try {
        const meta = (params.metadata as { assigned_to_agent_id?: string | null; title?: string | null } | null | undefined) ?? {}
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "deal_coordinator",
          signalType:  "task_due",
          message:     `"${meta.title ?? "A task"}" is due within 24 hours.`,
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.contactId ?? null,
          payload:     { assigned_to_agent_id: meta.assigned_to_agent_id ?? null, title: meta.title ?? null },
        }, svc)
      } catch { /* best-effort */ }
    }

    // 21 — a commission was recorded (lib/kernel/financial.ts createCommissionRecord —
    // canonical table agent_commissions). HANDLED — Finance Manager flags the earnings
    // ledger to the producing agent (resolved through agent_commissions.agent_id in the
    // handler) so the new commission is visible beyond the financials page. Money moment
    // (wave 50) — Finance Manager's own books recorded it, so it is the FROM too, not a
    // data_steward stamp.
    if (params.event === KernelEvent.COMMISSION_PAID) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "finance_manager",
          toManager:   "finance_manager",
          signalType:  "commission_paid",
          message:     "A commission was recorded.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 22 — a review landed (lib/reputation/review-landed.ts). HANDLED — Sphere of
    // Influence proposes a gated thank-you to the reviewer when the rating is positive
    // (or unrated); a lower rating is left feed-visible for a human to follow up
    // personally rather than an automated thank-you.
    if (params.event === KernelEvent.REVIEW_RECEIVED) {
      try {
        const meta = (params.metadata as { platform?: string | null; rating?: number | null } | null | undefined) ?? {}
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "sphere_of_influence",
          signalType:  "review_received",
          message:     `A ${meta.platform ?? ""} review landed${typeof meta.rating === "number" ? ` (${meta.rating}★)` : ""}.`.replace("  ", " "),
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.contactId ?? null,
          payload:     { platform: meta.platform ?? null, rating: meta.rating ?? null },
        }, svc)
      } catch { /* best-effort */ }
    }

    // 23 — a known website visitor was identified (app/api/track/identify). HANDLED —
    // Campaign Orchestrator ensures they're enrolled in the passive newsletter channel
    // (the same idempotent, unsubscribe/opt-out-honoring enrollment newsletter_touch_handoff
    // uses) — a known visitor returning to the site is a nurture signal, not a page view
    // to discard.
    if (params.event === KernelEvent.WEBSITE_VISITOR_IDENTIFIED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "campaign_orchestrator",
          signalType:  "website_visitor_identified",
          message:     "A known website visitor was identified.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // ── feed_only from here — visibility for the owning manager, same shape as most of
    // D-octies. No automated consumer by design (see each `what` in signal-registry.ts).

    // 24 — a transaction task was completed (app/actions/tasks.ts completeTask). A deal-
    // domain action, not a sweep (wave 50) — Deal Coordinator's own task board is the FROM.
    if (params.event === KernelEvent.TASK_COMPLETED) {
      try {
        const meta = (params.metadata as { title?: string | null } | null | undefined) ?? {}
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "deal_coordinator",
          toManager:   "deal_coordinator",
          signalType:  "task_completed",
          message:     `"${meta.title ?? "A task"}" was completed.`,
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.contactId ?? null,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 25/26 — a listing was archived / restored from the archive (app/actions/listings.ts).
    // Listing-domain actions (wave 50), not a data sweep — Listing Concierge is the FROM.
    if (params.event === KernelEvent.LISTING_ARCHIVED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "listing_concierge",
          toManager:   "listing_concierge",
          signalType:  "listing_archived",
          message:     "A listing was archived.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }
    if (params.event === KernelEvent.LISTING_UNARCHIVED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "listing_concierge",
          toManager:   "listing_concierge",
          signalType:  "listing_unarchived",
          message:     "A listing was restored from the archive.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 27 — a lead was scored (lib/kernel/lead-acquisition-handlers.ts). The ISA
    // qualification loop already runs synchronously right after this fires
    // (handleISAQualificationStarted) — this signal is purely visibility so AI ISA's own
    // feed shows the score that drove its next move, not a duplicate action.
    if (params.event === KernelEvent.LEAD_SCORED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "ai_isa",
          signalType:  "lead_scored",
          message:     "A lead was scored.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 28 — a contact was (re-)scored (lib/contact-pipeline/contact-capture.ts).
    if (params.event === KernelEvent.CONTACT_SCORED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "sphere_of_influence",
          signalType:  "contact_scored",
          message:     "A contact's relationship score was recomputed.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 29 — auto-assignment failed for a lead (lib/lead-assignment/assignment-engine.ts —
    // the sole assignment path per its own header, so this covers every caller).
    if (params.event === KernelEvent.LEAD_ASSIGNMENT_FAILED) {
      try {
        const meta = (params.metadata as { reason?: string | null } | null | undefined) ?? {}
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "ai_isa",
          signalType:  "lead_assignment_failed",
          message:     `A lead could not be auto-assigned${meta.reason ? ` (${meta.reason})` : ""}.`,
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 30 — a bulk lead import finished (app/actions/lead-import/import-actions.ts).
    if (params.event === KernelEvent.LEAD_IMPORT_COMPLETED) {
      try {
        const meta = (params.metadata as { created?: number; merged?: number; failed?: number } | null | undefined) ?? {}
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "ai_isa",
          signalType:  "lead_import_completed",
          message:     `A lead import finished — ${meta.created ?? 0} created, ${meta.merged ?? 0} merged, ${meta.failed ?? 0} failed.`,
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 31 — two contact records were merged (lib/contact-pipeline/contact-capture.ts).
    if (params.event === KernelEvent.CONTACT_DEDUP_MERGED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "sphere_of_influence",
          signalType:  "contact_dedup_merged",
          message:     "A duplicate contact was merged into the surviving record.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 32 — a newsletter campaign send completed (app/api/cron/publish-newsletters).
    // TOMBSTONE (m618) — was campaign_orchestrator -> marketing_agent (retired). Survivor
    // campaign_orchestrator owns both ends now, so this follows the same shape as the other
    // "infra observed a content-lane outcome" signals: cron_manager (the publish-newsletters
    // cron that performed the send — the same infra→owner shape as SOCIAL_POST_FAILED) reports
    // completion to campaign_orchestrator (the content owner). Not data_steward: wave-50 ruling,
    // the FROM manager owns the moment and data_steward is reserved for data-quality moments.
    if (params.event === KernelEvent.NEWSLETTER_SENT) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "cron_manager",
          toManager:   "campaign_orchestrator",
          signalType:  "newsletter_sent",
          message:     "A newsletter campaign finished sending.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 33 — a brokerage subscribed (app/actions/auth/signup-brokerage.ts). A money moment
    // (wave 50) landing in Finance Manager's own books — Finance Manager is the FROM.
    if (params.event === KernelEvent.SUBSCRIPTION_CREATED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "finance_manager",
          toManager:   "finance_manager",
          signalType:  "subscription_created",
          message:     "A new brokerage subscription was created.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 34 — an AI negotiation strategy finished drafting for an offer
    // (lib/negotiation/strategy-writer.ts). Named negotiation_strategy_drafted (not the
    // event's own "ready" spelling) so the feed-render kind stays "update" — the strategy
    // is a customer-mirror artifact for the portal, not a manager hand-off (the portal
    // already carries the live "ready" moment via KERNEL_EVENT_TO_PORTAL).
    if (params.event === KernelEvent.NEGOTIATION_STRATEGY_READY) {
      try {
        const meta = (params.metadata as { side?: string | null; recommended_action?: string | null } | null | undefined) ?? {}
        // A deal-domain artifact (wave 50) — Deal Coordinator's own negotiation drafted it.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "deal_coordinator",
          toManager:   "deal_coordinator",
          signalType:  "negotiation_strategy_drafted",
          message:     `An AI negotiation strategy is ready to review${meta.side ? ` (${meta.side} side)` : ""}.`,
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.contactId ?? null,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 35 — a scheduled cron job failed (lib/kernel/cron-logging.ts logCronComplete). That
    // module stamps brokerageId as the literal string "system" for a platform-wide cron
    // with no single tenant (`logEntry.brokerage_id || "system"`) — manager_signals is
    // tenant-anchored (brokerage_id NOT NULL, a real FK), so "system" is skipped rather
    // than attempted and silently swallowed by the catch below.
    if (params.event === KernelEvent.CRON_FAILED && params.brokerageId !== "system") {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "cron_manager",
          toManager:   "data_steward",
          signalType:  "cron_failed",
          message:     "A scheduled job failed.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }
  }

  // (D-undecies) CROSS-MANAGER SIGNALS — kernel-event census round 5 (2026-09-10, wave 48,
  // lane EF). scripts/kernel-event-census-z1.ts classified these TWENTY-FIVE KernelEvent
  // members "emitted only" after wave 47's twenty (D-decies) — a real emitter fires each
  // (verified against its call site below), lifecycle_events records it, but nothing
  // downstream ever reacted. Same ruling as D-octies/D-decies (CLAUDE.md §1.2 + the owner's
  // "every capability should run autonomously"): each publishes a manager_signals row
  // addressed to the manager whose domain should act on it. NINE are HANDLED — a real
  // SIGNAL_HANDLERS consumer proposes a gated deliverable (a client portal message, a
  // transaction task, a compliance-ledger/notification record) through the SAME existing
  // gated primitives the rest of this file uses — never an outbound send, never spend. The
  // rest are feed_only, same shape as most of D-octies/D-decies. Every block is best-effort
  // and independently caught; publishManagerSignal's own (toManager, signalType, entityId)
  // dedupe makes a retried/re-emitted event never double an inbox.
  //
  // Four events census flagged as emitted-only are DELIBERATELY NOT wired here because the
  // capability already exists under a different name (CLAUDE.md §1.3 — functionality already
  // lives elsewhere, no new signal minted to avoid a second spelling): OFFER_AI_EXTRACTED
  // (lib/offers/offer-extractor.ts) already publishes offers_compare_handoff synchronously
  // right after this same emit — a reader here would double that inbox. OFFER_COMPARISON_
  // GENERATED (lib/offers/offer-analyzer.ts) is the RESULT of that same offers_compare_handoff
  // handler running runOfferNetSheets, which already proposes the gated seller comparison — a
  // reader here would propose it twice. HOME_VALUE_CONTACT_CREATED (#13 below) is the one
  // exception that reuses rather than skips: it is the SAME "homeowner requested a value"
  // moment as the public lead-magnet's home_value_seller_intent (lib/intelligence/
  // inbound-seller-intent-runner.ts), just reached through the authenticated portal tool
  // instead of the anonymous form — so it publishes the EXISTING signal type onto the
  // EXISTING listing_concierge:home_value_seller_intent handler rather than mint a twin.
  // LEAD_CONVERTED_TO_CONTACT is the FOURTH such exception, added wave 49 (owner ruling
  // 2026-09-10: the lead→contact welcome comes from listing_concierge or shopping_agent by
  // CONTACT TYPE, with portal credentials + welcome video + a situational message — never a
  // generic one). What stood here as case "3" — a generic, always-sphere_of_influence,
  // hardcoded "Hi ${firstName} — welcome!" proposeClientMessage call — is DELETED. TOMBSTONE:
  // survivor is lib/contact-promotion/conversion-welcome.ts:342 `deliverConversionWelcome`,
  // which already runs the CORRECT sequence (portal grant → avatar-video commission →
  // situational, generatePersonaCopy-authored send, owned by listing_concierge for a seller /
  // shopping_agent for a buyer / both for `both`, per lib/kernel/client-welcome.ts
  // `resolveWelcomeManagers`) and is called SYNCHRONOUSLY, in-process, by the ONLY code path
  // that ever dispatches this KernelEvent — lib/kernel/lead-acquisition-handlers.ts's
  // `handleLeadAssigned`, at line 680-698, moments before it calls `processKernelEvent` for
  // this very event at line 598-603. So the deleted case ran the WRONG welcome a few
  // milliseconds AFTER the RIGHT one had already gone out for the same contact — a second,
  // generic, sphere-routed message the ruling forbids, on every single conversion. Verified
  // there is no other emitter that reaches this reader without also reaching the survivor:
  // `grep -rn "event:\s*KernelEvent\.LEAD_CONVERTED_TO_CONTACT" -- '*.ts'` has exactly the one
  // call site named above. (lib/kernel/crm.ts's manual lead-desk `convertLeadToContact` writes
  // `lifecycle_events` directly and never calls `processKernelEvent` for this event, so it was
  // never reachable here either way — wave 49 wired it onto the SAME survivor separately; see
  // the tombstone at lib/kernel/crm.ts's welcome call.)
  if (params.brokerageId) {
    // 1 — deal-health TIER TRANSITION (lib/deal-health/health-scorer.ts:967, `if
    // (tierChanged)`). CADENCE RESOLUTION (CLAUDE.md §6 — flagged overlap with
    // DEAL_HEALTH_SCORE_UPDATED, already read by D-octies #1): these are two MOMENTS, not
    // two spellings. SCORE_UPDATED fires every scan (gated to "not healthy" before it
    // signals); DEAL_AT_RISK_DETECTED (also D-octies) fires every scan while AT the bad
    // state; DEAL_HEALTH_CHANGED fires ONLY on the tier actually flipping, in EITHER
    // direction — the only one of the three that reports a RECOVERY. Feed-only: Deal
    // Coordinator already runs the deal-save huddle / stand-down directly off this same
    // tierChanged branch (lib/kernel/deal-save-huddle.ts) — this signal is the visibility
    // trail of the tier-flip moment itself, not a second trigger for that huddle.
    if (params.event === KernelEvent.DEAL_HEALTH_CHANGED) {
      try {
        const meta = (params.metadata as { previous_risk_level?: string; new_risk_level?: string } | null | undefined) ?? {}
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "deal_coordinator",
          signalType:  "deal_health_changed",
          message:     `A transaction's health tier changed${meta.previous_risk_level && meta.new_risk_level ? ` (${meta.previous_risk_level} → ${meta.new_risk_level})` : ""}.`,
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // ── HANDLED — a real SIGNAL_HANDLERS consumer proposes a gated deliverable ──

    // 2 — TCPA consent captured on a lead-first track (lib/kernel/lead-acquisition-
    // handlers.ts:319, handleConsentReceived). HANDLED — Compliance Officer records the
    // consent capture as a low-priority audit notification (the contact-side sibling,
    // contact_consent_events, already has its own writer; this is the lead-side moment).
    if (params.event === KernelEvent.CONSENT_RECEIVED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "ai_isa",
          toManager:   "compliance_officer",
          signalType:  "consent_received",
          message:     "TCPA consent was captured on a lead.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 3 — REMOVED (wave 49). TOMBSTONE: see the LEAD_CONVERTED_TO_CONTACT exception
    // paragraph above this `if (params.brokerageId)` block — survivor is
    // lib/contact-promotion/conversion-welcome.ts:342 `deliverConversionWelcome`.

    // 4 — the buyer-side "you're under contract" moment (lib/transactions/offer-
    // bridge.ts:614, only when we represent the buyer). HANDLED — Deal Coordinator opens a
    // gated closing-prep task for the deal's agent (earnest money + inspection deadlines).
    if (params.event === KernelEvent.BUYER_UNDER_CONTRACT) {
      try {
        // A deal-domain moment (wave 50) — Deal Coordinator's own offer bridge caused it.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "deal_coordinator",
          toManager:   "deal_coordinator",
          signalType:  "buyer_under_contract",
          message:     "A buyer went under contract.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 5 — earnest money milestone completed (app/actions/transaction-inspections.ts:602).
    // HANDLED — Finance Manager proposes a gated buyer confirmation message ("your earnest
    // money was received and processed") — a real money moment the buyer should hear about.
    if (params.event === KernelEvent.EARNEST_MONEY_MILESTONE_COMPLETED) {
      try {
        // A money moment (wave 50) — earnest money is Finance Manager's own ledger.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "finance_manager",
          toManager:   "finance_manager",
          signalType:  "earnest_money_milestone_completed",
          message:     "An earnest money milestone was completed.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 6 — an agent submitted their license for onboarding (app/actions/onboarding/
    // license.ts:396). HANDLED — Compliance Officer records the pending review on the
    // compliance ledger (compliance_flags), same ledger license_lapsing already uses, so a
    // submitted-but-not-yet-verified license is tracked rather than silently pending.
    if (params.event === KernelEvent.AGENT_LICENSE_SUBMITTED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "recruiting_manager",
          toManager:   "compliance_officer",
          signalType:  "agent_license_submitted",
          message:     "An agent submitted a license for verification.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 7 — an AI CMA finished generating (lib/cma/ai-cma-engine.ts:238). HANDLED — Listing
    // Concierge proposes a gated seller message sharing the fresh comps-grounded valuation.
    if (params.event === KernelEvent.CMA_GENERATED) {
      try {
        // A listing-domain valuation tool (wave 50) — Listing Concierge is the FROM.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "listing_concierge",
          toManager:   "listing_concierge",
          signalType:  "cma_generated",
          message:     "A CMA finished generating for a listing.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 8 — a referral was received (app/actions/referrals/referral-actions.ts:264). HANDLED —
    // Sphere of Influence proposes a warm welcome message to the referred contact (mirrors
    // business_card_approved; referral_reciprocity stays the separate partner-payback signal).
    if (params.event === KernelEvent.REFERRAL_RECEIVED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "sphere_of_influence",
          signalType:  "referral_received",
          message:     "A referral was received.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.contactId ?? null,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 9 — a lead was auto-assigned to an agent (lib/kernel/lead-acquisition-
    // handlers.ts:445-449, fires alongside LEAD_CONVERTED_TO_CONTACT from the same call,
    // AFTER the lead has already been converted to a contact in that same call). HANDLED
    // — owner ruling (wave 49, 2026-09-10, verbatim): "if a lead gets assigned it is the
    // ai isa to nurture which is a system agent". This USED TO directly notify the
    // resolved agent ("A new lead was assigned to you") — wrong on two counts: it named a
    // LEAD to an agent (agents never see leads, only contacts — §5), and it duplicated the
    // agent-facing heads-up that ALREADY exists on the acknowledge-handoff path
    // (app/actions/lead-assignment/assign-lead.ts acknowledgeLeadHandoffAction +
    // new-contact-handoff-panel.tsx). The handler now hands the newly-assigned contact to
    // AI ISA, whose speed-to-lead cron (lib/ai-isa/speed-to-lead.ts) already owns first-
    // touch nurture for every newly-assigned contact after the agent's grace window — this
    // signal is that ownership becoming visible, not a second nurture trigger (§6: the
    // grace-window decision is NOT re-implemented here, avoiding a second spelling of
    // lib/ai-isa/speed-to-lead-policy.ts firstTouchDecision).
    if (params.event === KernelEvent.LEAD_ASSIGNED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "ai_isa",
          signalType:  "lead_assigned",
          message:     "A lead was auto-assigned to an agent.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 10 — a vendor was assigned to a transaction (app/actions/vendor-marketplace.ts:1329).
    // HANDLED — Deal Coordinator opens a gated confirm-scope task for the deal's agent.
    if (params.event === KernelEvent.VENDOR_ASSIGNED_TO_TRANSACTION) {
      try {
        // A deal-domain action (wave 50) — Deal Coordinator's own transaction assigned it.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "deal_coordinator",
          toManager:   "deal_coordinator",
          signalType:  "vendor_assigned_to_transaction",
          message:     "A vendor was assigned to a transaction.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 11 — an existing portal contact requested an in-app AI home valuation (app/actions/
    // home-value.ts:616). REUSES the existing home_value_seller_intent signal type + its
    // listing_concierge handler (see header note above) rather than minting a near-duplicate
    // spelling — the same strongest-inbound-seller-signal moment, a different entry door.
    if (params.event === KernelEvent.HOME_VALUE_CONTACT_CREATED && params.contactId) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "ai_isa",
          toManager:   "listing_concierge",
          signalType:  "home_value_seller_intent",
          message:     "A homeowner requested a home value estimate.",
          entityType:  "contact",
          entityId:    params.contactId,
          contactId:   params.contactId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // ── feed_only from here — visibility for the owning manager, same shape as most of
    // D-octies/D-decies. No automated consumer by design (see each `what` in signal-registry.ts).

    // 12 — TOMBSTONE (owner ruling, wave 49, 2026-09-10): "no kernel event for
    // agent claiming a lead" — KernelEvent.LEAD_CLAIMED is retired (see the
    // tombstone at lib/kernel/events.ts). This reader used to publish
    // "lead_claimed" here; the underlying acknowledgement still happens
    // (lib/lead-assignment/assignment-engine.ts claimLead flips
    // assignment_log.claimed directly, no event).

    // 13 — a lead cleared consent and is ready for the assignment engine (lib/kernel/
    // lead-acquisition-handlers.ts:346). Visibility only — the assignment engine already
    // acts off this same event (mirrors the D-decies lead_scored precedent).
    if (params.event === KernelEvent.LEAD_READY_FOR_ASSIGNMENT) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "ai_isa",
          signalType:  "lead_ready_for_assignment",
          message:     "A lead is ready for assignment.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 14 — a transaction inspection was marked complete (app/actions/transaction-
    // inspections.ts:261, kept separate from the generic MILESTONE_COMPLETED alias).
    if (params.event === KernelEvent.INSPECTION_COMPLETED) {
      try {
        // A deal-domain action (wave 50) — Deal Coordinator's own transaction inspection.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "deal_coordinator",
          toManager:   "deal_coordinator",
          signalType:  "inspection_completed",
          message:     "A transaction inspection was completed.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 15 — an agent's submitted license was verified (lib/onboarding/license-verifier.ts:394)
    // — closes the loop #6 opened; visibility only (the compliance_flags row from #6 is not
    // auto-resolved here, left for a human review to close deliberately).
    if (params.event === KernelEvent.AGENT_LICENSE_VERIFIED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "recruiting_manager",
          toManager:   "compliance_officer",
          signalType:  "agent_license_verified",
          message:     "An agent's license was verified.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 16 — a governance sweep found a lead going stale (lib/lead-governance/stale-lead-
    // processor.ts:205-217, a DIFFERENT module from the AI ISA's own ghost-detection loop —
    // wave 47 ruled GHOST_LEAD_DETECTED a double-signal duplicate of REENGAGEMENT_STARTED;
    // this is the governance-side dwell alert, not a second outreach trigger, so it stays
    // feed_only rather than proposing a second automated touch on the same lead).
    if (params.event === KernelEvent.STALE_LEAD_ALERT) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "ai_isa",
          signalType:  "stale_lead_alert",
          message:     "A lead has gone stale.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 17 — the predictive-pricing engine flagged a listing's list price vs its AI-predicted
    // price (lib/pricing/predictive-pricing.ts:210-224). Listing Concierge sees the
    // price-strategy signal (mirrors listing_stall_predicted's early-warning shape).
    if (params.event === KernelEvent.PRICE_ALERT_TRIGGERED) {
      try {
        // A listing-domain pricing-strategy tool (wave 50) — Listing Concierge is the FROM.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "listing_concierge",
          toManager:   "listing_concierge",
          signalType:  "price_alert_triggered",
          message:     "A predictive-pricing alert fired for a listing.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 18 — a seller started the listing-agreement paperwork stage (app/actions/seller-
    // listing/execution-engine.ts:515).
    if (params.event === KernelEvent.LISTING_AGREEMENT_INITIATED) {
      try {
        // A listing-domain action (wave 50) — Listing Concierge's own paperwork stage.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "listing_concierge",
          toManager:   "listing_concierge",
          signalType:  "listing_agreement_initiated",
          message:     "A listing agreement was initiated.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 19 — a buyer requested a showing from the public listing landing page (app/actions/
    // listing-landing.ts:840).
    if (params.event === KernelEvent.SHOWING_REQUESTED) {
      try {
        // A listing-domain moment (wave 50) — a showing request against THIS listing.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "listing_concierge",
          toManager:   "listing_concierge",
          signalType:  "showing_requested",
          message:     "A showing was requested from a listing page.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.contactId ?? null,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 20 — an e-sign envelope was requested for a form submission (lib/kernel/
    // forms.ts:715, provider-resolved per wave-47's "never assume dotloop" ruling).
    if (params.event === KernelEvent.ESIGN_ENVELOPE_REQUESTED) {
      try {
        // A compliance moment (wave 50) — the e-sign envelope is Compliance's own record.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "compliance_officer",
          toManager:   "compliance_officer",
          signalType:  "esign_envelope_requested",
          message:     "An e-sign envelope was requested.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 21 — an AI-ISA campaign was marked ended (app/actions/ai-isa.ts:477). Owner ruling
    // (wave 49, 2026-09-10): routes TO Campaign Orchestrator — the campaign manager — NOT
    // Finance Manager, who has nothing to do with a campaign ending (fixed from the
    // original wiring, which sent it there). Wave 50 FROM fix: the entity that ended is an
    // AI-ISA nurture campaign (app/actions/ai-isa.ts owns it), a lead/ISA moment — AI ISA
    // is the FROM (the mover), Campaign Orchestrator the cross-manager TO, not a default
    // data_steward stamp.
    if (params.event === KernelEvent.MARKETING_CAMPAIGN_ENDED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "ai_isa",
          toManager:   "campaign_orchestrator",
          signalType:  "marketing_campaign_ended",
          message:     "A marketing campaign ended.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 22 — an accounting sync run completed (app/api/accounting/sync/route.ts:176).
    if (params.event === KernelEvent.SYSTEM_SYNC_COMPLETED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "finance_manager",
          signalType:  "system_sync_completed",
          message:     "An accounting sync run completed.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 23 — a human agent claimed an AI-ISA qualified contact from the handoff queue
    // (app/actions/ai-isa/claim-handoff.ts:75). Owner ruling (wave 49, 2026-09-10):
    // routes by the CONTACT's type — Listing Concierge for a seller, Shopping Agent for a
    // buyer, never a generic "agent handoff" manager (deal_coordinator, the original
    // wiring, has no reason to own this). Same branch shape as ISA_APPOINTMENT_SCHEDULED
    // above (#16) — contacts.contact_type read once, one dynamic toManager. Unknown/unset
    // type: AI ISA keeps the handoff and asks, rather than guess — it does NOT fall through
    // to either agent-side manager.
    if (params.event === KernelEvent.AI_ISA_HANDOFF_TO_AGENT) {
      try {
        let toManager: "listing_concierge" | "shopping_agent" | "ai_isa" = "ai_isa"
        if (params.contactId) {
          const { data: c } = await svc
            .from("contacts").select("contact_type")
            .eq("id", params.contactId).eq("brokerage_id", params.brokerageId).maybeSingle()
          const contactType = (c as { contact_type?: string | null } | null)?.contact_type ?? null
          if (contactType === "seller") toManager = "listing_concierge"
          else if (contactType === "buyer") toManager = "shopping_agent"
          // any other value (null / unset / unrecognised) leaves toManager "ai_isa"
        }
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "ai_isa",
          toManager,
          signalType:  "ai_isa_handoff_to_agent",
          message:     toManager === "ai_isa"
            ? "AI ISA handed a qualified contact to an agent, but the contact's buyer/seller type is unset — AI ISA is holding the routing and asking."
            : "AI ISA handed a qualified contact off to an agent.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.contactId ?? null,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 24 — an AI concierge session escalated to a human (lib/intelligence/multi-agent-
    // router.ts:378-391, which already writes its own smart_assistant_suggestions row for
    // the assigned agent — this is the cross-manager visibility trail beside it). Owner
    // ruling (wave 49, 2026-09-10): routes to Recruiting Manager (not deal_coordinator, the
    // original wiring) — an escalation to a human is a coaching/staffing moment Recruiting
    // owns, HANDLED by notifying the escalating agent's team lead (metadata.agent_id is an
    // AGENTS id, same convention as #17 MESSAGE_NEEDS_RESPONSE — the emitter now also mirrors
    // it into metadata so this reader can resolve it).
    if (params.event === KernelEvent.AGENT_ESCALATED_TO_HUMAN) {
      try {
        const meta = (params.metadata as { agent_id?: string | null; urgency?: string; reason?: string } | null | undefined) ?? {}
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "ai_isa",
          toManager:   "recruiting_manager",
          signalType:  "agent_escalated_to_human",
          message:     "An AI concierge session escalated to a human.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     { agent_id: meta.agent_id ?? null, urgency: meta.urgency ?? null, reason: meta.reason ?? null },
        }, svc)
      } catch { /* best-effort */ }
    }

    // 25 — an AI neighborhood report finished generating for a listing (app/actions/
    // neighborhood-reports.ts:497).
    if (params.event === KernelEvent.NEIGHBORHOOD_REPORT_GENERATED) {
      try {
        // A listing-domain report tool (wave 50) — Listing Concierge is the FROM.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "listing_concierge",
          toManager:   "listing_concierge",
          signalType:  "neighborhood_report_generated",
          message:     "A neighborhood report finished generating.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }
  }

  // (D-duodecies) CROSS-MANAGER SIGNALS — kernel-event census round 6 (2026-09-10, wave 49,
  // lane HC). scripts/kernel-event-census-z1.ts classified these TWENTY KernelEvent members
  // "emitted only" in the video/podcast/social/onboarding/intelligence lanes: a real emitter
  // fires each (verified against its call site below), lifecycle_events records it, but nothing
  // downstream ever reacted. Same ruling as D-octies through D-undecies (CLAUDE.md §1.2 + the
  // owner's "every capability should run autonomously"): each publishes a manager_signals row
  // addressed to the manager whose domain should act on it. EIGHT are HANDLED — a real
  // SIGNAL_HANDLERS consumer (lib/kernel/manager-signals.ts) proposes a gated deliverable (a
  // notification to the creator, a gated social-snippet post) through the SAME existing gated
  // primitives the rest of this file uses — never an outbound send, never spend. The rest are
  // feed_only, same shape as most of D-octies/D-decies/D-undecies. Every block is best-effort
  // and independently caught; publishManagerSignal's own (toManager, signalType, entityId)
  // dedupe makes a retried/re-emitted event never double an inbox.
  if (params.brokerageId) {
    // ── HANDLED — a real SIGNAL_HANDLERS consumer proposes a gated deliverable ──

    // 1 — an AI video script finished generating (app/api/video-scripts/route.ts /
    // app/actions/video-generation.ts, entityType "video_script"). HANDLED — Asset Manager
    // notifies the script's author it's ready for review before it becomes a video. Wave 50
    // owner ruling ("video snippet should be asset manager from"): every video/asset-lane
    // moment publishes FROM Asset Manager, the asset owner, never a default data_steward
    // stamp.
    if (params.event === KernelEvent.SCRIPT_GENERATED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
          toManager:   "asset_manager",
          signalType:  "script_generated",
          message:     "An AI video script finished generating.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 2 — a cloned voice passed quality and is ready to use (app/actions/video-voice.ts,
    // entityType "voice_profile", quality gated >=70 before this fires). HANDLED — Asset
    // Manager notifies the owning agent their voice clone is ready for video generation.
    if (params.event === KernelEvent.VOICE_CLONE_READY) {
      try {
        // Video/asset lane (wave 50) — FROM Asset Manager, the asset owner.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
          toManager:   "asset_manager",
          signalType:  "voice_clone_ready",
          message:     "A cloned voice passed quality and is ready to use.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 3 — a platform video snippet was cut (app/actions/video-repurposing.ts createSnippet,
    // entityType "video_snippet", approval_status "pending_review" at insert). HANDLED —
    // Campaign Orchestrator (the distribution-channel owner) notifies the creator it's
    // waiting for review before it can be scheduled. Video/asset lane (wave 50) — the
    // snippet was CUT by Asset Manager's own pipeline, so Asset Manager is the FROM;
    // Campaign Orchestrator (who acts next, scheduling it) stays the TO.
    if (params.event === KernelEvent.SNIPPET_CREATED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
          toManager:   "campaign_orchestrator",
          signalType:  "snippet_created",
          message:     "A video snippet was cut and is pending review.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 4 — a piece of content finished being repurposed into a new format
    // (app/actions/video-repurposing.ts logRepurposedContent, entityType
    // "repurposed_content" — the manual repurposer, distinct from the Omni-Presence
    // pipeline's own internal log, which carries no kernel event). HANDLED — Campaign
    // Orchestrator notifies the creator the new asset is ready for review.
    if (params.event === KernelEvent.CONTENT_REPURPOSED) {
      try {
        // Video/asset lane (wave 50) — Asset Manager's own pipeline repurposed it; FROM
        // Asset Manager, TO Campaign Orchestrator (who acts next).
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
          toManager:   "campaign_orchestrator",
          signalType:  "content_repurposed",
          message:     "Content finished being repurposed into a new format.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 5 — an Omni-Presence repurpose pipeline finished a run (lib/repurpose/actions.ts,
    // entityType "repurpose_pipeline" — distributable formats are already scheduled as
    // social_posts inside the run itself; this is the run's completion). HANDLED — Campaign
    // Orchestrator notifies the pipeline's owner the run is done.
    if (params.event === KernelEvent.OMNIPRESENCE_PIPELINE_COMPLETED) {
      try {
        // Video/asset lane (wave 50) — Asset Manager's own repurpose pipeline ran it; FROM
        // Asset Manager, TO Campaign Orchestrator (who acts next).
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
          toManager:   "campaign_orchestrator",
          signalType:  "omnipresence_pipeline_completed",
          message:     "An omni-presence repurpose pipeline finished running.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 6 — a podcast episode finished generating (app/actions/podcast-generation.ts /
    // lib/kernel/marketing.ts, entityType "podcast_episode"). HANDLED — Asset Manager
    // (the podcast/video creator) hands it to Campaign Orchestrator (m618: survivor of
    // the retired marketing_agent seat), which proposes a GATED social snippet post
    // teasing the new episode — a rendered asset should not sit undistributed just
    // because nobody remembered to cross-post it.
    if (params.event === KernelEvent.PODCAST_EPISODE_GENERATED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
          toManager:   "campaign_orchestrator",
          signalType:  "podcast_episode_generated",
          message:     "A podcast episode finished generating.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 7 — a podcast episode failed to generate or distribute (app/actions/podcast-
    // generation.ts / app/api/cron/distribute-podcast-episodes, entityType
    // "podcast_episode", status already flipped to "failed"/error_message set before this
    // fires). HANDLED — Asset Manager notifies the owning agent so a failed episode is
    // never silently left in "failed" with nobody told.
    if (params.event === KernelEvent.PODCAST_EPISODE_FAILED) {
      try {
        // Video/asset lane (wave 50) — Asset Manager's own podcast pipeline failed.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
          toManager:   "asset_manager",
          signalType:  "podcast_episode_failed",
          message:     "A podcast episode failed.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 8 — an agent completed all required onboarding TRAINING videos (app/api/onboarding/
    // training/progress/route.ts, entityType "agent", entityId is agents.id per
    // getAgentContext). HANDLED — Recruiting Manager (owns onboarding) sends the
    // next-step nudge (congrats + point at certification) rather than leaving the agent
    // to notice on their own the training tab went green.
    if (params.event === KernelEvent.TRAINING_COURSE_COMPLETED) {
      try {
        // Onboarding/training moment (wave 50) — Recruiting Manager owns onboarding.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "recruiting_manager",
          toManager:   "recruiting_manager",
          signalType:  "training_course_completed",
          message:     "An agent completed all required onboarding training.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // ── feed_only from here — visibility for the owning manager, same shape as most of
    // D-octies/D-decies/D-undecies. No automated consumer by design (see each `what` in
    // signal-registry.ts).

    // 9 — an AI-generated script variation was created (app/actions/video-generation.ts,
    // entityType "video_script"). Video/asset lane (wave 50) — FROM Asset Manager.
    if (params.event === KernelEvent.SCRIPT_VARIATION_CREATED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
          toManager:   "asset_manager",
          signalType:  "script_variation_created",
          message:     "A script variation was created.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 10 — a voice clone profile was created for an agent (app/actions/video-voice.ts,
    // entityType "voice_profile", before training starts).
    if (params.event === KernelEvent.VOICE_CLONE_PROFILE_CREATED) {
      try {
        // Video/asset lane (wave 50) — FROM Asset Manager.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
          toManager:   "asset_manager",
          signalType:  "voice_clone_profile_created",
          message:     "A voice clone profile was created.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 11 — voice clone training started with a provider (app/actions/video-voice.ts,
    // entityType "voice_training").
    if (params.event === KernelEvent.VOICE_CLONE_TRAINING_STARTED) {
      try {
        // Video/asset lane (wave 50) — FROM Asset Manager.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
          toManager:   "asset_manager",
          signalType:  "voice_clone_training_started",
          message:     "Voice clone training started.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 12 — an agent set their default voice clone (app/actions/video-voice.ts, entityType
    // "voice_profile").
    if (params.event === KernelEvent.VOICE_CLONE_DEFAULT_SET) {
      try {
        // Video/asset lane (wave 50) — FROM Asset Manager.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
          toManager:   "asset_manager",
          signalType:  "voice_clone_default_set",
          message:     "An agent set a default voice clone.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 13 — a video snippet was scheduled for publish (app/actions/video-repurposing.ts,
    // entityType "video_snippet" — the scheduling half beside snippet_created's HANDLED
    // creation-review notice above).
    if (params.event === KernelEvent.SNIPPET_SCHEDULED) {
      try {
        // Video/asset lane (wave 50) — Asset Manager is the FROM; Campaign Orchestrator
        // (the distribution-channel owner) stays the TO.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
          toManager:   "campaign_orchestrator",
          signalType:  "snippet_scheduled",
          message:     "A video snippet was scheduled for publish.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 14 — a repurpose batch (multiple snippets/formats from one source) finished
    // (app/actions/video-repurposing.ts, entityType-varies per caller).
    if (params.event === KernelEvent.REPURPOSE_BATCH_COMPLETED) {
      try {
        // Video/asset lane (wave 50) — FROM Asset Manager.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
          toManager:   "asset_manager",
          signalType:  "repurpose_batch_completed",
          message:     "A repurpose batch finished.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 15 — a delivered video's performance metrics were refreshed (app/api/video/
    // engagement/route.ts / app/actions/video-generation.ts, entityType "video_project" —
    // the video_high_performer_detected / video_low_performer_detected alerts (D-octies)
    // already fire off the SAME underlying scan; this is the raw metrics-refreshed moment
    // beside them, visibility only so Asset Manager sees every tick, not just the outliers).
    if (params.event === KernelEvent.VIDEO_PERFORMANCE_UPDATED) {
      try {
        // Video/asset lane (wave 50) — FROM Asset Manager.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
          toManager:   "asset_manager",
          signalType:  "video_performance_updated",
          message:     "A video's performance metrics were refreshed.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 16 — a podcast episode finished distributing to its publish channels (app/api/cron/
    // distribute-podcast-episodes, entityType "podcast_episode" — the success mirror of
    // the HANDLED podcast_episode_failed above). Wave 50: marketing_agent retired — organic
    // distribution routes to Campaign Orchestrator.
    if (params.event === KernelEvent.PODCAST_EPISODE_DISTRIBUTED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
          toManager:   "campaign_orchestrator",
          signalType:  "podcast_episode_distributed",
          message:     "A podcast episode finished distributing.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 17 — a newsletter campaign was scheduled to send (app/actions/ai-newsletter.ts,
    // entityType "newsletter_campaign" — newsletter_sent (D-decies) already covers the
    // completed-send moment; this is the scheduling moment ahead of it). Campaign/
    // newsletter moment (wave 50) — FROM Campaign Orchestrator, its own scheduling action;
    // marketing_agent retired — organic newsletter routes to Campaign Orchestrator too
    // (no spend here, never Ads Manager), self-addressed.
    if (params.event === KernelEvent.NEWSLETTER_SCHEDULED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "cron_manager",
          toManager:   "campaign_orchestrator",
          signalType:  "newsletter_scheduled",
          message:     "A newsletter campaign was scheduled to send.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 18 — an agent's AI daily briefing was generated and delivered (lib/intelligence/
    // daily-briefing-generator.ts, entityType "ai_daily_briefing" — the function already
    // notifications-inserts straight to the agent in the SAME call; this is the
    // cross-manager visibility trail beside that direct delivery, not a second notice).
    if (params.event === KernelEvent.DAILY_BRIEFING_GENERATED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "cron_manager",
          toManager:   "data_steward",
          signalType:  "daily_briefing_generated",
          message:     "An agent's daily briefing was generated.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 19 — the onboarding AI assistant escalated a question it couldn't answer
    // (app/api/onboarding/assistant/route.ts, entityType "agent" — a
    // smart_assistant_suggestions row already reaches the agent directly in the same
    // call; this is Recruiting Manager's cross-manager visibility into the gap).
    if (params.event === KernelEvent.SETUP_ASSISTANT_ESCALATED) {
      try {
        // Onboarding moment (wave 50) — Recruiting Manager owns onboarding, FROM too.
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "recruiting_manager",
          toManager:   "recruiting_manager",
          signalType:  "setup_assistant_escalated",
          message:     "The onboarding AI assistant escalated a question it could not answer.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 20 — the onboarding-health sweep found an agent's onboarding has stalled
    // (app/api/cron/onboarding-health, entityType "agent_onboarding" — a
    // smart_assistant_suggestions row already reaches the agent directly in the same
    // sweep; this is Recruiting Manager's cross-manager visibility into who is stalling).
    if (params.event === KernelEvent.ONBOARDING_STALLED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "recruiting_manager",
          signalType:  "onboarding_stalled",
          message:     "An agent's onboarding has stalled.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }
  }

  // (D-terdecies) CROSS-MANAGER SIGNALS — kernel-event census round 7 (2026-09-10, wave 50,
  // lane HD). scripts/kernel-event-census-z1.ts classified these TWENTY KernelEvent members
  // "emitted only" in the open-house/ISA/lead-capture/deal/video/campaign lanes: a real
  // emitter fires each (verified against its call site below), lifecycle_events records it,
  // but nothing downstream ever reacted. Same ruling as D-octies through D-duodecies
  // (CLAUDE.md §1.2 + the owner's "every capability should run autonomously"): each publishes
  // a manager_signals row addressed to the manager whose domain should act on it. Routed per
  // the wave-50 rulings: FROM is the manager that OWNS the moment (never a default
  // data_steward stamp) — listing_concierge for the open-house lane, ai_isa for the ISA/lead
  // lane, deal_coordinator for the buyer-offer lane, asset_manager for the video lane,
  // campaign_orchestrator for the campaign/form-capture lane, compliance_officer for the
  // authority gate, data_steward ONLY for the two genuine data-quality moments (contact
  // enrichment, the business-card OCR extraction). NEVER marketing_agent — it is being
  // retired onto campaign_orchestrator/ads_manager this wave (lane IA) and no new signal
  // routes through it. EIGHT are HANDLED — a real SIGNAL_HANDLERS consumer (lib/kernel/
  // manager-signals.ts) proposes a gated deliverable (a notification to the responsible
  // agent) through the SAME existing gated primitives the rest of this file uses — never an
  // outbound send, never spend. Two (isa_outreach_paused, isa_qualified_lead) branch
  // EXPLICITLY on the contact's/lead's buyer-vs-seller side per the wave-50 "branch where an
  // event has multiple use cases" ruling, mirroring D-undecies' ai_isa_handoff_to_agent. The
  // rest are feed_only, same shape as most of D-octies through D-duodecies. Every block is
  // best-effort and independently caught; publishManagerSignal's own (toManager, signalType,
  // entityId) dedupe makes a retried/re-emitted event never double an inbox.
  if (params.brokerageId) {
    // ── HANDLED — a real SIGNAL_HANDLERS consumer proposes a gated deliverable ──

    // 1 — open house marketing was approved and the listing entered the OPEN_HOUSE_MARKETING
    // stage (app/actions/seller-listing/execution-engine.ts approveOpenHouseMarketing,
    // entityType "listing_stage_machine", entityId the listings.id). HANDLED — Listing
    // Concierge (owns the listing lifecycle) hands it to Campaign Orchestrator, which
    // notifies the listing's agent that open-house marketing is live.
    if (params.event === KernelEvent.OPEN_HOUSE_MARKETING_STARTED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "listing_concierge",
          toManager:   "campaign_orchestrator",
          signalType:  "open_house_marketing_started",
          message:     "Open house marketing was approved for a listing.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 2 — a resolved open-house attendee's contact record was linked to the open house for
    // source attribution (lib/kernel/open-house.ts attachOpenHouseSourceAttribution,
    // entityType "contact", metadata.agent_id is the working agent's AGENTS id — same
    // convention as D-undecies' agent_escalated_to_human). HANDLED — Listing Concierge hands
    // the attribution to AI ISA, which notifies the working agent for follow-up.
    if (params.event === KernelEvent.OPEN_HOUSE_CONTACT_RESOLVED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "listing_concierge",
          toManager:   "ai_isa",
          signalType:  "open_house_contact_resolved",
          message:     "An open-house attendee was attributed to a contact.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.contactId ?? params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 3 — a compliance/TCPA authority gate BLOCKED an outreach step in a nurture sequence
    // (lib/campaign-sequences/step-executor.ts, entityType "contact" — only fires when a
    // contactId is present). HANDLED — Compliance Officer (the gate's owner) hands it to
    // Campaign Orchestrator, which notifies the contact's assigned agent that automated
    // outreach did not go out.
    if (params.event === KernelEvent.AUTHORITY_BLOCKED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "compliance_officer",
          toManager:   "campaign_orchestrator",
          signalType:  "authority_blocked",
          message:     "An authority gate blocked an automated outreach step.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.contactId ?? params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 4 — a direct-call contact enrichment attempt FAILED (app/api/cron/contact-enrichment,
    // the direct-call lane distinct from the frozen lead-pipeline queue orchestrator,
    // entityType "contact"). Data-quality moment — HANDLED, data_steward hands it to AI ISA,
    // which notifies the contact's assigned agent that auto-enrichment came up short.
    if (params.event === KernelEvent.CONTACT_ENRICHMENT_FAILED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "ai_isa",
          signalType:  "contact_enrichment_failed",
          message:     "A contact's automatic enrichment attempt failed.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.contactId ?? params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 5 — AI ISA nurture PAUSED because the contact/lead has a transaction UNDER_CONTRACT
    // (lib/ai-isa/isa-outreach-logger.ts isaTouchGovernor). Branches explicitly per wave-50:
    // only a real CONTACT (a lead has no contact_type yet) routes by contacts.contact_type —
    // seller to Listing Concierge, buyer to Shopping Agent — so the side-appropriate agent
    // picks up direct communication; an unresolved/lead-side case publishes nothing (mirrors
    // D-undecies' ai_isa_handoff_to_agent "hold and ask" shape). HANDLED on both resolved
    // sides — a real notification, never a send.
    if (params.event === KernelEvent.ISA_OUTREACH_PAUSED) {
      try {
        if (params.entityType === "contact" && params.entityId) {
          const { data: c } = await svc
            .from("contacts").select("contact_type")
            .eq("id", params.entityId).eq("brokerage_id", params.brokerageId).maybeSingle()
          const contactType = (c as { contact_type?: string | null } | null)?.contact_type ?? null
          const toManager: "listing_concierge" | "shopping_agent" | null =
            contactType === "seller" ? "listing_concierge" : contactType === "buyer" ? "shopping_agent" : null
          if (toManager) {
            await publishManagerSignal({
              brokerageId: params.brokerageId,
              fromManager: "ai_isa",
              toManager,
              signalType:  "isa_outreach_paused",
              message:     "AI ISA nurture paused — the contact is now under contract.",
              entityType:  params.entityType,
              entityId:    params.entityId,
              contactId:   params.entityId,
            }, svc)
          }
        }
      } catch { /* best-effort */ }
    }

    // 6 — TRACK B lead capture: a public form was submitted and captureContact() created a
    // consented contact directly (app/api/forms/submit/route.ts, entityType "contact"; "No
    // lead created" per the file's own header comment). HANDLED — Campaign Orchestrator (owns
    // the lead-capture form as a marketing asset) hands the new, consented contact to AI ISA,
    // which stages ONE gated first-touch message through the same proposeClientMessage rail
    // D-undecies' handoff first-touch uses — a human approves before it sends.
    if (params.event === KernelEvent.FORM_SUBMISSION_RECEIVED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "campaign_orchestrator",
          toManager:   "ai_isa",
          signalType:  "form_submission_received",
          message:     "A public form submission captured a new consented contact.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.contactId ?? params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 7 — a buyer started drafting an offer (app/actions/buyer-offers.ts startOfferDraft,
    // entityType "buyer_lifecycle", entityId the buyer contact's id; listingId forwarded when
    // the draft is tied to an in-house listing). HANDLED — Deal Coordinator hands it to
    // Listing Concierge, which notifies the LISTING's agent a buyer is drafting an offer;
    // no-op (left open) when the draft has no listingId to resolve an agent from.
    if (params.event === KernelEvent.BUYER_OFFER_DRAFT_STARTED) {
      try {
        if (params.listingId) {
          await publishManagerSignal({
            brokerageId: params.brokerageId,
            fromManager: "deal_coordinator",
            toManager:   "listing_concierge",
            signalType:  "buyer_offer_draft_started",
            message:     "A buyer started drafting an offer on a listing.",
            entityType:  "listing",
            entityId:    params.listingId,
            contactId:   params.contactId ?? params.entityId,
            payload:     { listing_id: params.listingId },
          }, svc)
        }
      } catch { /* best-effort */ }
    }

    // 8 — a business card was scanned and OCR-extracted (app/actions/business-card/business-
    // card-actions.ts, entityType "business_card", entityId business_card_scans.id). The raw
    // OCR extraction (confidence score, viability gate) IS a data-quality moment — HANDLED,
    // data_steward hands it to Sphere of Influence (the eventual default owner once
    // classified — business_card_approved, wave 47), which notifies the scanning agent their
    // card is ready for review/classification. Classification itself stays on
    // business_card_approved/business_card_*_candidate (D-decies/D-undecies) — this is only
    // the pre-classification "it's ready to look at" moment.
    if (params.event === KernelEvent.BUSINESS_CARD_UPLOADED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "sphere_of_influence",
          signalType:  "business_card_uploaded",
          message:     "A business card was scanned and is ready for review.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // ── feed_only from here — visibility for the owning manager, same shape as most of
    // D-octies through D-duodecies. No automated consumer by design (see each `what` in
    // signal-registry.ts).

    // 9 — an open-house attendee was captured and walked in (app/api/open-house/attend/
    // route.ts, entityType "listing_stage_machine" — the instant 90-second greeting already
    // fires directly in the same call; this is Listing Concierge's cross-manager visibility
    // trail into AI ISA beside that direct greeting, not a second one).
    if (params.event === KernelEvent.OPEN_HOUSE_ATTENDEE_CAPTURED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "listing_concierge",
          toManager:   "ai_isa",
          signalType:  "open_house_attendee_captured",
          message:     "An open-house attendee was captured.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 10 — a contact's enrichment was queued (lib/enrichment/contact-enrichment-core.ts,
    // entityType "contact"). Data-quality moment — data_steward's queue-side visibility trail
    // beside the HANDLED contact_enrichment_failed outcome above.
    if (params.event === KernelEvent.CONTACT_ENRICHMENT_QUEUED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "data_steward",
          toManager:   "ai_isa",
          signalType:  "contact_enrichment_queued",
          message:     "A contact's enrichment was queued.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 11 — AI ISA began qualifying a lead (lib/kernel/lead-acquisition-handlers.ts, entityType
    // 'lead').
    if (params.event === KernelEvent.ISA_QUALIFICATION_STARTED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "ai_isa",
          toManager:   "data_steward",
          signalType:  "isa_qualification_started",
          message:     "AI ISA began qualifying a lead.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 12 — AI ISA sent an outreach touch through a nurture sequence step (lib/campaign-
    // sequences/step-executor.ts, entityType "contact" — the SEND already happened via the
    // provider dispatch in the same call; this is visibility only, never a second send).
    if (params.event === KernelEvent.ISA_OUTREACH_SENT) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "ai_isa",
          toManager:   "data_steward",
          signalType:  "isa_outreach_sent",
          message:     "AI ISA sent a nurture outreach touch.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 13 — an inbound reply was routed to AI ISA (app/api/providers/inbound/route.ts,
    // entityType "lead" | "contact" — the SAME call already runs AI ISA's own inbound-intent
    // classification synchronously right after this; this is cross-manager visibility beside
    // that real-time handling, not a second reaction).
    if (params.event === KernelEvent.ISA_REPLY_RECEIVED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "ai_isa",
          toManager:   "data_steward",
          signalType:  "isa_reply_received",
          message:     "An inbound reply was routed to AI ISA.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 14 — AI ISA qualified a lead (lib/ai-isa/qualification-evaluator.ts, entityType 'lead'
    // — fires regardless of whether auto-assignment succeeds afterward). Branches explicitly
    // per wave-50: leads.motivation_type/lead_type run through the SAME canonical
    // motivationToContactType classifier lib/contact-promotion/contact-creator.ts already
    // uses for the real lead→contact conversion (never a second, hand-rolled classifier) —
    // seller-leaning routes to Listing Concierge, buyer-leaning to Shopping Agent; unresolved
    // is left as visibility to data_steward rather than guessing. Feed-only: the qualification
    // loop itself already runs synchronously off this same event (mirrors D-decies'
    // lead_scored precedent) — this is the side-appropriate manager's early look, not a second
    // trigger.
    if (params.event === KernelEvent.ISA_QUALIFIED_LEAD) {
      try {
        let toManager: "listing_concierge" | "shopping_agent" | "data_steward" = "data_steward"
        if (params.entityId) {
          const { data: l } = await svc
            .from("leads").select("motivation_type, lead_type")
            .eq("id", params.entityId).eq("brokerage_id", params.brokerageId).maybeSingle()
          const lead = l as { motivation_type?: string | null; lead_type?: string | null } | null
          if (lead) {
            const { motivationToContactType } = await import("@/lib/contact-promotion/contact-creator")
            const contactType = motivationToContactType(lead.motivation_type) ?? motivationToContactType(lead.lead_type)
            if (contactType === "seller") toManager = "listing_concierge"
            else if (contactType === "buyer") toManager = "shopping_agent"
          }
        }
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "ai_isa",
          toManager,
          signalType:  "isa_qualified_lead",
          message:     "AI ISA qualified a lead.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          contactId:   params.contactId ?? null,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 15 — AI ISA's nurture sequence exhausted its touches with no engagement (lib/campaign-
    // sequences/step-executor.ts, entityType "contact" — GHOST_LEAD_DETECTED already covers
    // the ghost-detection verdict itself; this is the raw exhaustion moment beside it).
    if (params.event === KernelEvent.ISA_MAX_TOUCHES_REACHED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "ai_isa",
          toManager:   "data_steward",
          signalType:  "isa_max_touches_reached",
          message:     "AI ISA's nurture sequence exhausted its touches.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 16 — a QR code was scanned (app/api/qr/scan/route.ts, entityType 'qr_scan' — the scan is
    // still anonymous, no contact yet; fanOutKernelEvent already runs the staff alert +
    // campaign_sequences auto-enroll in the same call).
    if (params.event === KernelEvent.QR_SCAN_RECEIVED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "campaign_orchestrator",
          toManager:   "data_steward",
          signalType:  "qr_scan_received",
          message:     "A QR code was scanned.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }

    // 17 — a D-ID video generation was requested (app/api/did/generate-video/route.ts,
    // entityType "video_project" — the poll-did-videos cron owns following up, not a second
    // manager).
    if (params.event === KernelEvent.VIDEO_GENERATION_REQUESTED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
          toManager:   "data_steward",
          signalType:  "video_generation_requested",
          message:     "A video generation was requested.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 18 — a D-ID video finished generating (app/api/cron/poll-did-videos, entityType
    // "video_project" — the owning agent already gets a direct "video ready" notification in
    // the same call; this is Asset Manager's cross-manager visibility trail into Campaign
    // Orchestrator beside that direct notice, not a second one).
    if (params.event === KernelEvent.VIDEO_GENERATION_COMPLETED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "asset_manager",
          toManager:   "campaign_orchestrator",
          signalType:  "video_generation_completed",
          message:     "A video finished generating.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 19 — a marketing campaign was created in draft (app/actions/marketing-studio.ts,
    // entityType "marketing_campaign" — nothing to act on until it launches).
    if (params.event === KernelEvent.MARKETING_CAMPAIGN_CREATED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "campaign_orchestrator",
          toManager:   "data_steward",
          signalType:  "marketing_campaign_created",
          message:     "A marketing campaign was created.",
          entityType:  params.entityType,
          entityId:    params.entityId,
        }, svc)
      } catch { /* best-effort */ }
    }

    // 20 — a marketing campaign LAUNCHED (lib/marketing/campaign-publisher.ts, entityType
    // "marketing_campaign" — an organic channel campaign: newsletter/email/sms/direct_mail/
    // social/blog/podcast/video; paid ad spend is the separate AD_CAMPAIGN_LAUNCHED event, not
    // this one).
    if (params.event === KernelEvent.MARKETING_CAMPAIGN_LAUNCHED) {
      try {
        await publishManagerSignal({
          brokerageId: params.brokerageId,
          fromManager: "campaign_orchestrator",
          toManager:   "data_steward",
          signalType:  "marketing_campaign_launched",
          message:     "A marketing campaign launched.",
          entityType:  params.entityType,
          entityId:    params.entityId,
          payload:     params.metadata ?? {},
        }, svc)
      } catch { /* best-effort */ }
    }
  }

  // matched/enrolled/skipped/errors are legacy marketing-trigger counters — System B enrollment
  // is retired, so they are always zero now (shape kept for callers of ReactorResult).
  return { matched: 0, enrolled: 0, skipped: 0, errors: 0, sequencesEnrolled, portalUpdated }
}
