// lib/kernel/event-reactor.ts
// THE KERNEL EVENT REACTOR (Phase 1).
//
// Today the kernel bus only NOTIFIES humans (processKernelEvent). This reactor is the second half:
// it fans the SAME event into the agentic/automation side so the lead lifecycle, marketing, and
// (in later phases) AI-ISA / video / podcast / social react in real time instead of waiting for a
// polling cron to scan lifecycle_events.
//
// Phase 1 consumer = marketing campaign enrollment, run REACTIVELY through the exact same
// processOneLifecycleEvent the safety-net cron uses (one enrollment path → no drift). The reactor
// only ENROLLS (records a campaign touchpoint); the actual sends stay downstream behind the channel
// adapters' compliance/TCPA/brand gates — so reacting on an event never auto-sends anything ungated.
//
// Idempotency: the per-(campaign × contact) cooldown in processOneLifecycleEvent means the reactor
// and the cron can both run for the same event without double-enrolling. Never throws — a reactor
// failure must never break the notification path that calls it.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { processOneLifecycleEvent } from "@/lib/marketing/trigger-engine"
import { enrollMatchingSequences, writePortalUpdate } from "@/lib/kernel/event-fanout"
import { resolveEventContacts } from "@/lib/kernel/resolve-event-contacts"
import { KernelEvent } from "@/lib/kernel/events"

// Valid KernelEvent string values — used to gate sequence enrollment + portal so a non-KernelEvent
// lifecycle string (e.g. "milestone.completed") never runs the campaign_sequences query or a portal
// write it was never meant to trigger. (The marketing-trigger system matches its own trigger table,
// so it is intentionally NOT gated here.)
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
  /** KernelEvent value (its enum string) — matched against marketing_campaign_triggers.trigger_value. */
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
 * Fan one kernel event into the agentic reactor. Routes to (B) marketing-trigger enrollment,
 * (A) canonical campaign_sequences enrollment, and (C) the template-gated client portal — the same
 * three channels fanOutKernelEvent used to run inline, now centralized here so EVERY emitter (all
 * ~98, via processKernelEvent) gets them uniformly. The portal writer is template-gated (internal
 * events have no template → no client card) and idempotent (no duplicate cards on ret//emit/overlap).
 */
export async function dispatchKernelEvent(params: DispatchKernelEventParams): Promise<ReactorResult> {
  const svc = createServiceClient()
  const isKnownEvent  = VALID_KERNEL_EVENTS.has(params.event)
  const enrollAllowed = !params.suppressEnrollment

  // (B) Marketing-trigger enrollment — reactive replacement for the marketing-trigger cron poll.
  // Matches its OWN trigger table (which may use free-form values), so it's not KernelEvent-gated;
  // but it IS suppressed for sequence-engine-originated events to avoid an enrollment feedback loop.
  let mk: { matched: number; enrolled: number; skipped: number; errors: number } =
    { matched: 0, enrolled: 0, skipped: 0, errors: 0 }
  if (enrollAllowed) {
    try {
      mk = await processOneLifecycleEvent(svc, {
        event_type:   params.event,
        entity_type:  params.entityType,
        entity_id:    params.entityId,
        brokerage_id: params.brokerageId,
        metadata:     params.metadata ?? null,
      })
    } catch (err) {
      console.error("[event-reactor] marketing-trigger enrollment failed:", err)
      mk = { matched: 0, enrolled: 0, skipped: 0, errors: 1 }
    }
  }

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

  // (D) Managed-Agent spawner — three per-entity Anthropic Managed Agents run autonomously
  // off the request path, each waking on the relevant kernel event:
  //   - Deal Coordinator      — per transaction, on OFFER_ACCEPTED / TRANSACTION_STAGE_CHANGED
  //   - Shopping Agent        — per buyer contact, on BUYER_FINANCIALLY_VERIFIED / BUYER_SEARCH_CONFIGURED
  //   - Listing Concierge     — per listing, on LISTING_PUBLISHED
  // All three post back via the Anthropic webhook (app/api/webhooks/anthropic-agent) and the
  // shared spawn-helper handles idempotency at both the agent + session layers. Never throws
  // — missing ANTHROPIC_API_KEY (dev/staging) skips silently.
  if (params.brokerageId) {
    try {
      if (
        params.entityType === "transaction" &&
        (params.event === KernelEvent.OFFER_ACCEPTED || params.event === KernelEvent.TRANSACTION_STAGE_CHANGED)
      ) {
        const { spawnDealCoordinatorForTransaction } = await import("@/lib/agents/deal-coordinator")
        await spawnDealCoordinatorForTransaction({ brokerageId: params.brokerageId, transactionId: params.entityId })
      } else if (
        params.entityType === "contact" &&
        (params.event === KernelEvent.BUYER_FINANCIALLY_VERIFIED || params.event === KernelEvent.BUYER_SEARCH_CONFIGURED)
      ) {
        const { spawnShoppingAgentForBuyer } = await import("@/lib/agents/shopping-agent")
        await spawnShoppingAgentForBuyer({ brokerageId: params.brokerageId, contactId: params.entityId })
      } else if (
        params.entityType === "listing" &&
        params.event === KernelEvent.LISTING_PUBLISHED
      ) {
        const { spawnListingConciergeForListing } = await import("@/lib/agents/listing-concierge")
        await spawnListingConciergeForListing({ brokerageId: params.brokerageId, listingId: params.entityId })
      }
    } catch (err) {
      console.error("[event-reactor] managed-agent spawn failed:", err)
    }
  }

  return { ...mk, sequencesEnrolled, portalUpdated }
}
