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
import { processOneLifecycleEvent, resolveContactFromEvent } from "@/lib/marketing/trigger-engine"
import { enrollMatchingSequences, writePortalUpdate } from "@/lib/kernel/event-fanout"
import { KernelEvent } from "@/lib/kernel/events"

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

  // (B) Marketing-trigger enrollment — the reactive replacement for the marketing-trigger cron poll.
  let mk: { matched: number; enrolled: number; skipped: number; errors: number }
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

  // Resolve the contact(s) once: prefer explicit ids forwarded by fanOutKernelEvent (buyer + seller
  // for two-sided deals); otherwise fall back to entity/metadata resolution so direct-emit callers
  // still reach the portal + sequences.
  const explicit = [params.contactId, params.buyerContactId, params.sellerContactId].filter(Boolean) as string[]
  let contactIds = Array.from(new Set(explicit))
  if (contactIds.length === 0) {
    try {
      const resolved = await resolveContactFromEvent(svc, params.entityType, params.entityId, params.metadata ?? null)
      if (resolved) contactIds = [resolved]
    } catch (err) {
      console.error("[event-reactor] contact resolution failed:", err)
    }
  }

  // (A) CANONICAL campaign_sequences enrollment — runs for every emitter now, not just the ~10 that
  // call fanOutKernelEvent. Idempotent (skips active enrollments) so reactor + fanOut + cron overlap
  // never double-enrolls.
  let sequencesEnrolled = false
  if (contactIds.length > 0) {
    try {
      await enrollMatchingSequences(params.event as KernelEvent, params.brokerageId, contactIds, params.agentUserId)
      sequencesEnrolled = true
    } catch (err) {
      console.error("[event-reactor] sequence enrollment failed:", err)
    }
  }

  // (C) Client portal — template-gated (no template → no-op) + idempotent. Centralizing it here means
  // a templated event produces its card no matter which code path emitted it (no "dead templates"),
  // while internal events (no template) are still excluded.
  let portalUpdated = false
  if (contactIds.length > 0) {
    try {
      portalUpdated = await writePortalUpdate(
        {
          event:          params.event as KernelEvent,
          brokerageId:    params.brokerageId,
          entityType:     params.entityType,
          entityId:       params.entityId,
          contactId:      params.contactId,
          buyerContactId: params.buyerContactId,
          sellerContactId:params.sellerContactId,
          transactionId:  params.transactionId,
          listingId:      params.listingId,
          agentUserId:    params.agentUserId,
          metadata:       (params.metadata ?? {}) as Record<string, any>,
        },
        contactIds,
      )
    } catch (err) {
      console.error("[event-reactor] portal update failed:", err)
    }
  }

  return { ...mk, sequencesEnrolled, portalUpdated }
}
