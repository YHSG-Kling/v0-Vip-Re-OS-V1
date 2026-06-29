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
import { KernelEvent } from "@/lib/kernel/events"

// Valid KernelEvent string values — used to gate sequence enrollment + portal so a non-KernelEvent
// lifecycle string (e.g. "milestone.completed") never runs the campaign_sequences query or a portal
// write it was never meant to trigger.
const VALID_KERNEL_EVENTS = new Set<string>(Object.values(KernelEvent))

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
      if (agentUserId) {
        // Map kernel event → lifecycle event_type. STAGE_CHANGED inspects
        // metadata.new_stage to pick the right promo variant.
        const meta = params.metadata as { new_stage?: string } | null | undefined
        const newStage = meta?.new_stage ?? null
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
          const { dispatchListingPromoVideo } = await import("@/lib/video/listing-promo-reactor")
          void dispatchListingPromoVideo({
            brokerageId: params.brokerageId,
            listingId:   params.entityId,
            agentUserId,
            eventType,
          })
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

  // matched/enrolled/skipped/errors are legacy marketing-trigger counters — System B enrollment
  // is retired, so they are always zero now (shape kept for callers of ReactorResult).
  return { matched: 0, enrolled: 0, skipped: 0, errors: 0, sequencesEnrolled, portalUpdated }
}
