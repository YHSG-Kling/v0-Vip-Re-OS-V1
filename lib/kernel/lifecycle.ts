// lib/kernel/lifecycle.ts
// LAYER 0 — lifecycle state machine for all entity types.
// Only performs DB writes: one entity state UPDATE + one lifecycle_events INSERT.
// No side effects (no notifications, no compliance events, no revalidation).
// Import types from './types'; use createClient from '@/lib/supabase/server'.

import { createClient } from "@/lib/supabase/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { TransitionLifecycleParams } from "./types"
import { KernelEvent } from "./events"
import { processKernelEvent } from "./notification-engine"
import { createTransactionMilestoneCalendarEvents } from "./milestone-calendar-bridge"
import { statusForStage } from "@/lib/listings/listing-status-sync"

// ─── LIFECYCLE → KERNEL EVENT MAP ────────────────────────────────────────────
// Map lifecycle transitions to kernel events (explicit, not derived)
const LIFECYCLE_TO_KERNEL_EVENT: Record<string, KernelEvent> = {
  'new':               KernelEvent.CONTACT_CREATED,
  'verified':          KernelEvent.BUYER_VERIFIED,
  'tour_eligible':     KernelEvent.TOUR_ELIGIBLE,
  'tour_scheduled':    KernelEvent.TOUR_SCHEDULED,
  'offer_eligible':    KernelEvent.OFFER_ELIGIBLE,
  'offer_submitted':   KernelEvent.OFFER_SUBMITTED,
  'decision_pending':  KernelEvent.DECISION_PENDING,
  'price_determined':          KernelEvent.PRICE_DETERMINED,
  'listing_agreement_signed':  KernelEvent.LISTING_AGREEMENT_SIGNED,
  'listing_published':         KernelEvent.LISTING_PUBLISHED,

  // ── Listing Stage Machine — uppercase keys (lifecycle_stage values) ────────
  // Generic stage change (catch-all for stages not listed below)
  'LISTING_STAGE_CHANGED':     KernelEvent.LISTING_STAGE_CHANGED,
  // Milestone overrides — specific stages emit higher-signal events
  'MLS_ACTIVE':                KernelEvent.LISTING_PUBLISHED,   // milestone override
  'UNDER_CONTRACT':            KernelEvent.CONTRACT_SIGNED,      // milestone override
  'CLOSED':                    KernelEvent.DEAL_CLOSED,          // milestone override
  'LIFETIME_CUSTOMER':         KernelEvent.LIFETIME_CUSTOMER,    // milestone override
  // Terminal exit stages
  'SELLER_DECLINED':           KernelEvent.SELLER_DECLINED,
  'LISTING_CANCELLED':         KernelEvent.LISTING_CANCELLED,
  'LISTING_EXPIRED':           KernelEvent.LISTING_EXPIRED,
  'offer_received':    KernelEvent.OFFER_RECEIVED,
  'under_contract':    KernelEvent.CONTRACT_SIGNED,
  'on_hold':           KernelEvent.DEAL_ON_HOLD,
  'disengaged':        KernelEvent.BUYER_DISENGAGED,
  'closed':            KernelEvent.DEAL_CLOSED,
  'lifetime':          KernelEvent.LIFETIME_CUSTOMER,

  // ── Buyer lifecycle — buyer_stage column (13-state journey, lowercase DB values) ──
  'prospect':              KernelEvent.BUYER_STATE_CHANGED,
  'pre_approval_pending':  KernelEvent.BUYER_STATE_CHANGED,
  'financially_verified':  KernelEvent.BUYER_FINANCIALLY_VERIFIED,
  'search_configured':     KernelEvent.BUYER_SEARCH_CONFIGURED,
  'searching':             KernelEvent.BUYER_SEARCH_EXECUTED,
  'touring':               KernelEvent.TOUR_PLANNED,
  'tour_completed':        KernelEvent.TOUR_COMPLETED,
  'offer_strategy':        KernelEvent.OFFER_STRATEGY_RECOMMENDED,
  'buyer_under_contract':  KernelEvent.CONTRACT_SIGNED,
  'buyer_closed':          KernelEvent.DEAL_CLOSED,
  'buyer_disengaged':      KernelEvent.BUYER_DISENGAGED,
  'buyer_lifetime':        KernelEvent.LIFETIME_CUSTOMER,
  // ── Buyer lifecycle — BuyerState values (uppercase, from lifecycle-definitions.ts) ──
  'BUYER_FINANCIALLY_VERIFIED':  KernelEvent.BUYER_FINANCIALLY_VERIFIED,
  'BUYER_SEARCH_CONFIGURED':     KernelEvent.BUYER_SEARCH_CONFIGURED,
  'BUYER_SEARCHING':             KernelEvent.BUYER_SEARCH_EXECUTED,
  'BUYER_TOUR_ELIGIBLE':         KernelEvent.TOUR_ELIGIBLE,
  'BUYER_TOURING':               KernelEvent.TOUR_PLANNED,
  'BUYER_OFFER_ELIGIBLE':        KernelEvent.OFFER_ELIGIBLE,
  'BUYER_OFFER_SUBMITTED':       KernelEvent.OFFER_SUBMITTED,
  'BUYER_UNDER_CONTRACT':        KernelEvent.CONTRACT_SIGNED,
  'BUYER_ON_HOLD':               KernelEvent.DEAL_ON_HOLD,
  'BUYER_DISENGAGED':            KernelEvent.BUYER_DISENGAGED,
  'BUYER_CLOSED':                KernelEvent.DEAL_CLOSED,
  'BUYER_LIFETIME':              KernelEvent.LIFETIME_CUSTOMER,

  // ── Marketing Campaign ────────────────────────────────────────────────────
  'marketing_campaign_draft':          KernelEvent.MARKETING_CAMPAIGN_CREATED,
  'marketing_campaign_approved':       KernelEvent.MARKETING_CAMPAIGN_APPROVED,
  'marketing_campaign_live':           KernelEvent.MARKETING_CAMPAIGN_LAUNCHED,
  'marketing_campaign_paused':         KernelEvent.MARKETING_CAMPAIGN_PAUSED,
  'marketing_campaign_ended':          KernelEvent.MARKETING_CAMPAIGN_ENDED,

  // ── Layer 11: Agent Onboarding & Education ────────────────────────────────
  'license_submitted':         KernelEvent.AGENT_LICENSE_SUBMITTED,
  'license_verified':          KernelEvent.AGENT_LICENSE_VERIFIED,
  'brand_configured':          KernelEvent.BRAND_SETUP_COMPLETED,
  'integrations_configured':   KernelEvent.INTEGRATION_CONNECTED,
  'training_in_progress':      KernelEvent.TRAINING_COURSE_ENROLLED,
  'certification_pending':     KernelEvent.TRAINING_COURSE_COMPLETED,
  'onboarding_completed':      KernelEvent.ONBOARDING_COMPLETED,
  'onboarding_stalled':        KernelEvent.ONBOARDING_STALLED,
  // Direct status mappings for agent_onboarding table
  'in_progress':               KernelEvent.ONBOARDING_STALLED,   // used only when stall detected
  'completed':                 KernelEvent.ONBOARDING_COMPLETED,
}

// ─── ENTITY → TABLE + STATE COLUMN MAP ───────────────────────────────────────
// Derived from live schema. Each EntityType maps to one table and its state column.

const ENTITY_MAP: Record<
  string,
  { table: string; stateColumn: string }
> = {
  buyer:          { table: "contacts", stateColumn: "status"      },  // raw CRM lead/contact state
  buyer_lifecycle: { table: "contacts", stateColumn: "buyer_stage" }, // 13-state buyer journey
  seller:      { table: "contacts",       stateColumn: "status"        },
  listing:               { table: "listings",  stateColumn: "status"         },
  // Separate entry for the listing stage machine — do NOT merge with 'listing' (MLS status only)
  listing_stage_machine: { table: "listings",  stateColumn: "lifecycle_stage" },
  transaction: { table: "transactions",   stateColumn: "stage"         },
  // Separate entry for the transaction stage machine — parallels listing_stage_machine pattern
  transaction_stage_machine: { table: "transactions", stateColumn: "stage" },
  document:    { table: "document_checklist", stateColumn: "status"   },
  offer:       { table: "offers",         stateColumn: "status"        },
  tour:        { table: "tours",          stateColumn: "status"        },
  repair:      { table: "property_upgrades", stateColumn: "status"    },
  financial:   { table: "commissions",    stateColumn: "status"        },
  lead:        { table: "leads",          stateColumn: "lifecycle_state" },
  journey:     { table: "journey_states", stateColumn: "current_stage" },
  showing:     { table: "showings",       stateColumn: "status"        },
  // ── Layer 9 — Marketing Campaign State Machine ───────────────────────────
  marketing_campaign_machine: { table: 'marketing_campaigns', stateColumn: 'status' },

  // ── Layer 11 — Agent Onboarding State Machine ────────────────────────────
  agent_onboarding_machine: { table: 'agent_onboarding', stateColumn: 'status' },
  agent_onboarding: { table: 'agent_onboarding', stateColumn: 'status' },
}

// ─── MAIN FUNCTION ────────────────────────────────────────────────────────────

export async function transitionLifecycle(
  params: TransitionLifecycleParams,
  // Optional injected client. Pass a service-role client from contexts with no
  // user session (webhooks, crons); defaults to the request-scoped server client.
  injectedClient?: SupabaseClient,
): Promise<{ ok: boolean; success: boolean; activityId: string; error?: string }> {
  const {
    brokerageId,
    entityType,
    entityId,
    fromState,
    toState,
    actorUserId,
    eventType,
    metadata = {},
  } = params

  // 1. No-op guard — idempotent; caller doesn't need to special-case this.
  if (fromState === toState) {
    // Insert a no-op event so the caller has an activityId to reference,
    // but do NOT update the entity row (avoids spurious updated_at bumps).
    const supabase = injectedClient ?? await createClient()

    const { data: noopEvent, error: noopError } = await supabase
      .from("lifecycle_events")
      .insert({
        brokerage_id: brokerageId,
        entity_type:  entityType,
        entity_id:    entityId,
        event_type:   `lifecycle.${eventType}.noop`,
        actor_user_id: actorUserId,
        metadata: {
          from_state: fromState,
          to_state:   toState,
          noop:       true,
          reason:     "fromState === toState",
          ...metadata,
        },
      })
      .select("id")
      .single()

    if (noopError) throw noopError
    return { ok: true, success: true, activityId: noopEvent.id }
  }

  // 2. Resolve table + state column for the given entityType.
  const entityDef = ENTITY_MAP[entityType.toLowerCase()]
  if (!entityDef) {
    const msg = `[lifecycle] Unknown entityType "${entityType}". Known types: ${Object.keys(ENTITY_MAP).join(", ")}`
    console.error(msg)
    return { ok: false, success: false, activityId: "", error: msg }
  }

  const supabase = injectedClient ?? await createClient()

  // 3. Atomically update the state column on the entity row.
  const updatePayload: Record<string, any> = {
    [entityDef.stateColumn]: toState,
    updated_at: new Date().toISOString(),
  }
  // Keep the coarse listings.status in lockstep with the listing stage machine — same atomic write — so
  // buyer search, public listing pages, and dashboards never read a stale status (e.g. lifecycle_stage
  // MLS_ACTIVE but status still 'coming_soon'). Only market-state boundaries map; intermediate stages
  // leave status untouched. See lib/listings/listing-status-sync.ts.
  if (entityType.toLowerCase() === "listing_stage_machine") {
    const syncedStatus = statusForStage(toState)
    if (syncedStatus) updatePayload.status = syncedStatus
  }
  const { error: updateError } = await (supabase as any)
    .from(entityDef.table)
    .update(updatePayload)
    .eq("id", entityId)

  if (updateError) {
    const msg = `[lifecycle] Failed to update ${entityDef.table}.${entityDef.stateColumn} for entity ${entityId}: ${updateError.message}`
    console.error(msg)
    return { ok: false, success: false, activityId: "", error: updateError.message }
  }

  // 4. Insert one lifecycle event — exact shape from the spec.
  const { data: event, error: eventError } = await supabase
    .from("lifecycle_events")
    .insert({
      brokerage_id:  brokerageId,
      entity_type:   entityType,
      entity_id:     entityId,
      event_type:    `lifecycle.${eventType}`,
      actor_user_id: actorUserId,
      metadata: {
        from_state: fromState,
        to_state:   toState,
        ...metadata,
      },
    })
    .select("id")
    .single()

  if (eventError) {
    const msg = `[lifecycle] Entity state updated but event insert failed for entity ${entityId}: ${eventError.message}`
    console.error(msg)
    return { ok: false, success: false, activityId: "", error: eventError.message }
  }

  if (event) {
    const kernelEvent = LIFECYCLE_TO_KERNEL_EVENT[params.eventType]

    if (kernelEvent) {
      // FAILURE ISOLATION: Notification processing is non-blocking
      // If processKernelEvent fails, it is logged but does NOT prevent state transition
      // This ensures lifecycle state changes ALWAYS succeed even if notifications fail
      await processKernelEvent({
        event: kernelEvent,
        brokerageId: params.brokerageId,
        entityType: params.entityType,
        entityId: params.entityId,
        lifecycleEventId: event.id,
      }).catch(err => {
        console.error('[Lifecycle] Notification processing failed (non-blocking):', err)
        // INTENTIONAL: Do not rethrow. State transition must not be blocked by notification failure.
      })

      if (kernelEvent === KernelEvent.CONTRACT_SIGNED) {
        await createTransactionMilestoneCalendarEvents({
          brokerageId: params.brokerageId,
          transactionId: params.entityId,
          inspectionDate: params.metadata?.inspectionDate,
          appraisalDate: params.metadata?.appraisalDate,
          financingDeadline: params.metadata?.financingDeadline,
          closingDate: params.metadata?.closingDate,
        }).catch(err => {
          console.error('[Lifecycle] Calendar bridge failed (non-blocking):', err)
        })
      }
    }
  }

  return { ok: true, success: true, activityId: event.id }
}
