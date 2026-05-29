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
import { enrollMatchingSequences } from "@/lib/kernel/event-fanout"
import { KernelEvent } from "@/lib/kernel/events"

export interface ReactorResult {
  matched:  number
  enrolled: number
  skipped:  number
  errors:   number
  /** Canonical campaign_sequences enrolled for the resolved contact (idempotent). */
  sequencesEnrolled: boolean
}

export interface DispatchKernelEventParams {
  /** KernelEvent value (its enum string) — matched against marketing_campaign_triggers.trigger_value. */
  event:        string
  brokerageId:  string
  entityType:   string
  entityId:     string
  metadata?:    Record<string, unknown> | null
}

/**
 * Fan one kernel event into the agentic reactor. Phase 1 routes to marketing enrollment; future
 * phases add capability routes (AI-ISA, video/podcast/social) onto the same dispatch.
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

  // (A) CANONICAL campaign_sequences enrollment — previously only ran for the ~10 emitters that
  // call fanOutKernelEvent. Running it here means EVERY emitter (all ~98, via processKernelEvent)
  // reactively enrolls the contact's lifecycle drips. Idempotent (skips active enrollments), so the
  // overlap with fanOutKernelEvent's own call for its 10 sites never double-enrolls.
  let sequencesEnrolled = false
  try {
    const contactId = await resolveContactFromEvent(svc, params.entityType, params.entityId, params.metadata ?? null)
    if (contactId) {
      await enrollMatchingSequences(params.event as KernelEvent, params.brokerageId, [contactId])
      sequencesEnrolled = true
    }
  } catch (err) {
    console.error("[event-reactor] sequence enrollment failed:", err)
  }

  return { ...mk, sequencesEnrolled }
}
