/**
 * LIB/EVENTS: EVENT TYPES
 *
 * Canonical type definitions for the event system.
 * Lives in lib/events/ so domain, application, and orchestrator layers can
 * all reference them without any upward or circular dependency.
 *
 * app/actions/orchestrator.ts re-exports these for backward compatibility.
 */

export interface EventInput {
  brokerage_id: string
  /** users.id of the ACTOR (lifecycle_events.actor_user_id FKs public.users). Never a contact id. */
  user_id?: string
  event_type: string
  payload: Record<string, any>
  source: "ui" | "webhook" | "system" | "cron"
  dedupe_key?: string
  /** Explicit entity — when absent, derived from payload (contact_id / listing_id / …), and
   *  the brokerage itself is the last resort: both columns are NOT NULL on the live table. */
  entity_type?: string
  entity_id?: string
}
/** @alias Event — avoids collision with DOM Event in server-action contexts. */
export type OrchestratorEvent = Event

export interface Event extends EventInput {
  id: string
  created_at: string
  processed_at?: string
  processed?: boolean
}

export const EVENT_TYPES = {
  LEAD_CREATED: "lead.created",
  // TOMBSTONE (wave 155, lane 155B2): LEAD_TAGGED_HOT ("lead.tagged_hot") and LEAD_ENGAGED ("lead.engaged") — no emitter, retired
  // with their handlers. SURVIVOR: LEAD_SCORED → AI ISA (lib/kernel/event-reactor.ts branch 27). See lib/orchestrator/internal.ts.
  LEAD_UNRESPONSIVE: "lead.unresponsive",
  LISTING_APPOINTMENT_SET: "listing.appointment_set",
  // TOMBSTONE (wave 155, lane 155B2): LISTING_SIGNED ("listing.signed") — no emitter. SURVIVOR: KernelEvent.LISTING_AGREEMENT_SIGNED
  // → lib/orchestrator/internal.ts reactToListingAgreementSigned (event-reactor.ts branch "21d").
  LISTING_LIVE: "listing.live",
  // TOMBSTONE (wave 155, lane 155B2): LISTING_PRICE_REDUCTION ("listing.price_reduction") — no emitter. SURVIVOR: app/actions/
  // listing-lifecycle.ts handlePriceReduction (the Reduce Price sheet's follow-up task, after updateListing writes the price).
  LISTING_OFFER_RECEIVED: "listing.offer_received",
  // TOMBSTONE (wave 154, lane 154A3): TRANSACTION_MILESTONE_OVERDUE ("transaction.milestone_overdue") was a second spelling nothing
  // wrote and, after the merge, nothing reads. SURVIVOR: KernelEvent.MILESTONE_OVERDUE — lib/orchestrator/internal.ts orchestrateEvent case.
  TRANSACTION_CONTINGENCY_CLEARED: "transaction.contingency_cleared",
  TRANSACTION_CLOSE_APPROACHING: "transaction.close_approaching",
  TRANSACTION_CLOSING_SOON: "transaction.closing_soon",
  // TOMBSTONE (wave 155, lane 155B2): TRANSACTION_CLOSED ("transaction.closed") — no emitter on this vocabulary. SURVIVORS: the kernel
  // close (KernelEvent.TRANSACTION_CLOSED, lib/kernel/transactions.ts) and lib/reputation/review-ask.ts for the review ask.
  CREDIT_STATUS_UPDATED: "credit.status_updated",
  CREDIT_TARGET_REACHED: "credit.target_reached",
  // TOMBSTONE (wave 155, lane 155B2): CREDIT_PARTNER_REFERRED ("credit.partner_referred") — no emitter. SURVIVOR: app/actions/
  // credit-copilot.ts referToCreditPartner → lib/credit/credit-event-handlers.ts recordCreditPartnerReferral.
  VIDEO_GENERATED: "video.generated",
  VIDEO_SCRIPT_APPROVED: "video.script_approved",
  VIDEO_PUBLISHED: "video.published",
  VIDEO_HIGH_ENGAGEMENT: "video.high_engagement",
  IMAGE_GENERATED: "image.generated",
  // Wave 89 (lane 89E, census round 34 — event-flow known gaps → handlers BUILT).
  // Both were audit-echo inserts straight into lifecycle_events (dispatched to
  // nobody). Emitted through the dispatching helpers now; routed below.
  ONBOARDING_STALLED: "onboarding.stalled",
  AGENT_DELEGATED_TO_AI: "agent.delegated_to_ai",
  AI_SUGGESTION_CREATED: "ai.suggestion_created",
  AI_SUGGESTION_ACTIONED: "ai.suggestion_actioned",
  // The client-portal journey (lanes 86F/86F2). All three are emitted from
  // app/actions/journey-tasks.ts completeTask through lib/portal/journey-milestone-
  // events.ts — the service core that inserts AND dispatches (recordLifecycleEvent);
  // stage / all-done only when that completion is the one that finished them.
  // Reactions: lib/portal/journey-event-handlers.ts.
  JOURNEY_TASK_COMPLETED: "journey.task_completed",
  JOURNEY_STAGE_COMPLETED: "journey.stage_completed",
  JOURNEY_ALL_TASKS_DONE: "journey.all_tasks_done",
} as const
