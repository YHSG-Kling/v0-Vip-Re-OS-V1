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
  LEAD_TAGGED_HOT: "lead.tagged_hot",
  LEAD_ENGAGED: "lead.engaged",
  LEAD_UNRESPONSIVE: "lead.unresponsive",
  LISTING_APPOINTMENT_SET: "listing.appointment_set",
  LISTING_SIGNED: "listing.signed",
  LISTING_LIVE: "listing.live",
  LISTING_PRICE_REDUCTION: "listing.price_reduction",
  LISTING_OFFER_RECEIVED: "listing.offer_received",
  TRANSACTION_MILESTONE_OVERDUE: "transaction.milestone_overdue",
  TRANSACTION_CONTINGENCY_CLEARED: "transaction.contingency_cleared",
  TRANSACTION_CLOSE_APPROACHING: "transaction.close_approaching",
  TRANSACTION_CLOSING_SOON: "transaction.closing_soon",
  TRANSACTION_CLOSED: "transaction.closed",
  CREDIT_STATUS_UPDATED: "credit.status_updated",
  CREDIT_TARGET_REACHED: "credit.target_reached",
  CREDIT_PARTNER_REFERRED: "credit.partner_referred",
  VIDEO_GENERATED: "video.generated",
  VIDEO_SCRIPT_APPROVED: "video.script_approved",
  VIDEO_PUBLISHED: "video.published",
  VIDEO_HIGH_ENGAGEMENT: "video.high_engagement",
  IMAGE_GENERATED: "image.generated",
  AI_SUGGESTION_CREATED: "ai.suggestion_created",
  AI_SUGGESTION_ACTIONED: "ai.suggestion_actioned",
} as const
