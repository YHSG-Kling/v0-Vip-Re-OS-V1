// lib/kernel/lifecycle.ts
// LAYER 0 — lifecycle state machine for all entity types.
// Only performs DB writes: one entity state UPDATE + one lifecycle_events INSERT.
// No side effects (no notifications, no compliance events, no revalidation).
// Import types from './types'; use createClient from '@/lib/supabase/server'.

import { createClient } from "@/lib/supabase/server"
import type { TransitionLifecycleParams } from "./types"
import { KernelEvent } from "./events"
import { processKernelEvent } from "./notification-engine"
import { createTransactionMilestoneCalendarEvents } from "./milestone-calendar-bridge"

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
  'offer_received':    KernelEvent.OFFER_RECEIVED,
  'under_contract':    KernelEvent.CONTRACT_SIGNED,
  'on_hold':           KernelEvent.DEAL_ON_HOLD,
  'disengaged':        KernelEvent.BUYER_DISENGAGED,
  'closed':            KernelEvent.DEAL_CLOSED,
  'lifetime':          KernelEvent.LIFETIME_CUSTOMER,
}

// ─── ENTITY → TABLE + STATE COLUMN MAP ───────────────────────────────────────
// Derived from live schema. Each EntityType maps to one table and its state column.

const ENTITY_MAP: Record<
  string,
  { table: string; stateColumn: string }
> = {
  buyer:       { table: "contacts",       stateColumn: "status"        },
  seller:      { table: "contacts",       stateColumn: "status"        },
  listing:     { table: "listings",       stateColumn: "status"        },
  transaction: { table: "transactions",   stateColumn: "stage"         },
  document:    { table: "document_checklist", stateColumn: "status"   },
  offer:       { table: "offers",         stateColumn: "status"        },
  tour:        { table: "tours",          stateColumn: "status"        },
  repair:      { table: "property_upgrades", stateColumn: "status"    },
  financial:   { table: "commissions",    stateColumn: "status"        },
  lead:        { table: "leads",          stateColumn: "lifecycle_state" },
  journey:     { table: "journey_states", stateColumn: "current_stage" },
  showing:     { table: "showings",       stateColumn: "status"        },
}

// ─── MAIN FUNCTION ────────────────────────────────────────────────────────────

export async function transitionLifecycle(
  params: TransitionLifecycleParams
): Promise<{ ok: true; activityId: string }> {
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
    const supabase = await createClient()

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
    return { ok: true, activityId: noopEvent.id }
  }

  // 2. Resolve table + state column for the given entityType.
  const entityDef = ENTITY_MAP[entityType.toLowerCase()]
  if (!entityDef) {
    throw new Error(
      `[lifecycle] Unknown entityType "${entityType}". ` +
      `Known types: ${Object.keys(ENTITY_MAP).join(", ")}`
    )
  }

  const supabase = await createClient()

  // 3. Atomically update the state column on the entity row.
  //    Cast through `any` once — the table name is dynamic so we cannot use
  //    the generated Supabase types directly here.
  const { error: updateError } = await (supabase as any)
    .from(entityDef.table)
    .update({
      [entityDef.stateColumn]: toState,
      updated_at: new Date().toISOString(),
    })
    .eq("id", entityId)

  if (updateError) {
    throw new Error(
      `[lifecycle] Failed to update ${entityDef.table}.${entityDef.stateColumn} ` +
      `for entity ${entityId}: ${updateError.message}`
    )
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
    throw new Error(
      `[lifecycle] Entity state updated but event insert failed for ` +
      `entity ${entityId}: ${eventError.message}`
    )
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

  return { ok: true, activityId: event.id }
}
