/**
 * System 5.1C: Buyer Lifecycle Governance Core - Lifecycle Logger
 *
 * Routes buyer state transitions through the kernel (Law 1).
 * Every state transition calls transitionLifecycle() → lifecycle_events.
 *
 * CHANGED: No longer writes to activities table.
 * The kernel's transitionLifecycle() handles all persistence.
 */

import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { KernelEvent }         from "@/lib/kernel/events"
import { createServiceClient } from "@/lib/supabase/service"
import type { BuyerState } from "./lifecycle-definitions"
import type { ActorRole } from "@/lib/kernel/types"

export interface LifecycleTransitionEvent {
  contactId: string
  fromState: BuyerState | null
  toState: BuyerState
  triggeredBy: "agent" | "system" | "ai_isa" | "voice"
  authorityRole: string
  userId: string
  sourceSystem: string
  brokerageId: string
  overrideReason?: string
  metadata?: Record<string, unknown>
}

/**
 * Maps buyer lifecycle toState values to the canonical KernelEvent.
 *
 * THIS FUNCTION WAS THE THING ITS OWN DOCSTRING WARNED ABOUT. It said it
 * "prevents loose string interpolation that won't match the kernel event map",
 * and it returned HAND-TYPED STRINGS — `"TOUR_ELIGIBLE"`, `"CONTRACT_SIGNED"`,
 * `"DEAL_CLOSED"`, `"LIFETIME_CUSTOMER"`, `"BUYER_STATE_CHANGED"` — which are the
 * MEMBER NAMES of `KernelEvent`, not its VALUES. `KernelEvent` was imported into
 * this file and never used, which is how the census found it.
 *
 * The consequence was not cosmetic. `transitionLifecycle` resolves the fan-out
 * with `LIFECYCLE_TO_KERNEL_EVENT[eventType]` (lib/kernel/lifecycle.ts), whose
 * keys are lifecycle STATE names and canonical event VALUES — never member
 * names. So five of the nine milestones this map exists to raise resolved to
 * `undefined` and called `processKernelEvent` NOT AT ALL:
 *
 *     BUYER_TOUR_ELIGIBLE   → "TOUR_ELIGIBLE"      → no key → no event
 *     BUYER_OFFER_ELIGIBLE  → "OFFER_ELIGIBLE"     → no key → no event
 *     BUYER_UNDER_CONTRACT  → "CONTRACT_SIGNED"    → no key → no event, and the
 *                             transaction milestone CALENDAR BRIDGE, which fires
 *                             only on KernelEvent.CONTRACT_SIGNED, never ran
 *     BUYER_CLOSED          → "DEAL_CLOSED"        → no key → no event
 *     (fallback)            → "BUYER_STATE_CHANGED"→ no key → no event
 *
 * and the ledger row was stamped `lifecycle.CONTRACT_SIGNED`, which no reader
 * matches either — lib/platform/tenant-webhooks-core.ts:87 subscribes to
 * `lifecycle.contract_signed`. Verified against the live database
 * (hrvaqgvukzxfskkcrwbt): 0 of 284 `lifecycle_events` rows carry an
 * upper-case event_type, so every consumer in this system reads lower_snake and
 * these five were writing into a vocabulary of one.
 *
 * Returning `KernelEvent` fixes both halves at once — the value IS the canonical
 * spelling, the ledger string becomes `lifecycle.contract_signed`, and the map's
 * identity arm (lib/kernel/lifecycle.ts) resolves it. The return TYPE is what
 * keeps it fixed: a future member-name typo is now a compile error, which is
 * exactly what the original docstring was promising and could not deliver.
 *
 * Unmapped states fall back to BUYER_STATE_CHANGED (catch-all added in B00 Edit 1).
 */
function resolveBuyerKernelEvent(toState: BuyerState): KernelEvent {
  const milestones: Partial<Record<BuyerState, KernelEvent>> = {
    BUYER_FINANCIALLY_VERIFIED: KernelEvent.BUYER_FINANCIALLY_VERIFIED,
    BUYER_SEARCH_CONFIGURED:    KernelEvent.BUYER_SEARCH_CONFIGURED,
    BUYER_TOUR_ELIGIBLE:        KernelEvent.TOUR_ELIGIBLE,
    BUYER_OFFER_ELIGIBLE:       KernelEvent.OFFER_ELIGIBLE,
    BUYER_UNDER_CONTRACT:       KernelEvent.CONTRACT_SIGNED,
    BUYER_CLOSED:               KernelEvent.DEAL_CLOSED,
    BUYER_LIFETIME:             KernelEvent.LIFETIME_CUSTOMER,
    BUYER_DISENGAGED:           KernelEvent.BUYER_DISENGAGED,
  }
  return milestones[toState] ?? KernelEvent.BUYER_STATE_CHANGED
}

/**
 * Emit a buyer lifecycle transition through the kernel.
 * Routes to lifecycle_events table via transitionLifecycle().
 */
export async function emitLifecycleTransition(
  event: LifecycleTransitionEvent
): Promise<{ success: boolean; error?: string; activityId?: string }> {
  const {
    contactId,
    fromState,
    toState,
    triggeredBy,
    authorityRole,
    userId,
    sourceSystem,
    brokerageId,
    overrideReason,
    metadata,
  } = event

  try {
    const result = await transitionLifecycle({
      brokerageId,
      entityType:  "buyer_lifecycle",
      entityId:    contactId,
      fromState:   fromState ?? "",   // empty string = unknown prior state; never fake with toState
      toState,
      actorUserId: userId,
      actorRole:   authorityRole as ActorRole,
      eventType:   resolveBuyerKernelEvent(toState),
      metadata: {
        triggered_by:    triggeredBy,
        source_system:   sourceSystem,
        override_reason: overrideReason,
        ...metadata,
      },
    })
    return { success: true, activityId: result.activityId }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[buyer-lifecycle] emitLifecycleTransition failed:", message)
    return { success: false, error: message }
  }
}

/**
 * Get lifecycle history for a buyer
 */
export interface LifecycleHistoryEntry {
  id: string
  fromState: BuyerState | null
  toState: BuyerState
  occurredAt: Date
  triggeredBy: string
  authorityRole: string
  userId: string
  sourceSystem: string
  overrideReason?: string
}

export async function getLifecycleHistory(
  contactId: string,
  options?: {
    limit?: number
    startDate?: Date
    endDate?: Date
  }
): Promise<LifecycleHistoryEntry[]> {
  const { limit = 100, startDate, endDate } = options || {}
  const supabase = createServiceClient()
  
  // lifecycle_events stores from_state and to_state inside the metadata jsonb column
  let query = supabase
    .from("lifecycle_events")
    .select("id, created_at, actor_user_id, metadata, event_type")
    .eq("entity_type", "buyer_lifecycle")
    .eq("entity_id", contactId)
    .order("created_at", { ascending: false })
    .limit(limit)
  
  if (startDate) {
    query = query.gte("created_at", startDate.toISOString())
  }
  
  if (endDate) {
    query = query.lte("created_at", endDate.toISOString())
  }
  
  const { data: events, error } = await query
  
  if (error) {
    console.error("[buyer-lifecycle] Error fetching lifecycle history:", error)
    return []
  }
  
  if (!events) {
    return []
  }
  
  return events.map((event) => {
    const metadata = (event.metadata as Record<string, unknown>) || {}
    return {
      id:            event.id,
      fromState:     (metadata.from_state as BuyerState) ?? null,
      toState:       (metadata.to_state   as BuyerState),
      occurredAt:    new Date(event.created_at),
      triggeredBy:   (metadata.triggered_by   as string) || "unknown",
      authorityRole: (metadata.authority_role as string) || "unknown",
      userId:        event.actor_user_id || "system",
      sourceSystem:  (metadata.source_system  as string) || "unknown",
      overrideReason: metadata.override_reason as string | undefined,
    }
  })
}

/**
 * Get current buyer state (most recent transition)
 */
export async function getCurrentBuyerState(contactId: string): Promise<BuyerState | null> {
  const history = await getLifecycleHistory(contactId, { limit: 1 })
  
  if (history.length === 0) {
    return null
  }
  
  return history[0].toState
}

/**
 * Get lifecycle statistics for brokerage
 */
export interface LifecycleStatistics {
  totalBuyers: number
  byState: Record<BuyerState, number>
  averageTimeToVerification?: number // days
  averageTimeToContract?: number // days
  conversionRate?: number // percentage who reach UNDER_CONTRACT
}

export async function getLifecycleStatistics(
  brokerageId: string,
  options?: {
    startDate?: Date
    endDate?: Date
  }
): Promise<LifecycleStatistics> {
  const { startDate, endDate } = options || {}
  const supabase = createServiceClient()

  // TWO queries, not N+1. This used to fetch every contact in the brokerage — with no
  // limit — and then call getCurrentBuyerState(contactId) in a loop, each one its own
  // SELECT on lifecycle_events. A brokerage with 5,000 contacts issued 5,001 round trips
  // to render one panel. "Latest row per group" is a set operation; m367's
  // buyer_lifecycle_current_states does it in a single DISTINCT ON pass.
  //
  // The two counts are deliberately separate reads because they answer different
  // questions: totalBuyers counts every contact in the window INCLUDING those that have
  // never transitioned, while byState can only count contacts that have a state. Deriving
  // the total from the state rows would silently drop every never-transitioned buyer.
  let totalQuery = supabase
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId)

  if (startDate) totalQuery = totalQuery.gte("created_at", startDate.toISOString())
  if (endDate)   totalQuery = totalQuery.lte("created_at", endDate.toISOString())

  const [{ count: totalBuyers, error: countError }, { data: stateRows, error: stateError }] =
    await Promise.all([
      totalQuery,
      supabase.rpc("buyer_lifecycle_current_states", {
        p_brokerage_id: brokerageId,
        p_start: startDate ? startDate.toISOString() : null,
        p_end:   endDate   ? endDate.toISOString()   : null,
      }),
    ])

  if (countError || stateError) {
    // Report the real failure. The old loop swallowed a contacts error into a zeroed
    // result, so a broken read and a brokerage with no buyers looked identical.
    console.error("[buyer-lifecycle] statistics read failed:", countError?.message ?? stateError?.message)
    return {
      totalBuyers: 0,
      byState: {} as Record<BuyerState, number>,
    }
  }

  const byState: Record<string, number> = {}
  for (const row of (stateRows ?? []) as Array<{ current_state: string | null }>) {
    const state = row.current_state
    if (state) byState[state] = (byState[state] || 0) + 1
  }

  return {
    totalBuyers: totalBuyers ?? 0,
    byState: byState as Record<BuyerState, number>,
    // TODO: Calculate timing metrics from history
  }
}

/**
 * Get buyers in specific state
 */
export async function getBuyersInState(
  brokerageId: string,
  state: BuyerState,
  options?: {
    limit?: number
  }
): Promise<string[]> {
  const { limit = 100 } = options || {}
  const supabase = createServiceClient()

  // ONE query. This was the same N+1 as the statistics reader — every contact fetched,
  // then one lifecycle_events SELECT per contact to test its state.
  //
  // It also mis-read its own `limit`. The old code applied it to the CONTACTS fetched and
  // then filtered by state afterwards, so `limit` capped how many contacts were LOOKED AT,
  // not how many buyers came back: a brokerage with 500 contacts of which 20 are touring
  // would ask for 100 and receive however many of the first 100 contacts happened to be
  // touring — often a handful, sometimes zero, and never the same answer twice as contacts
  // were added. The limit now bounds the RESULT, which is what every caller assumed.
  const { data: stateRows, error } = await supabase.rpc("buyer_lifecycle_current_states", {
    p_brokerage_id: brokerageId,
    p_start: null,
    p_end:   null,
  })

  if (error) {
    console.error("[buyer-lifecycle] buyers-in-state read failed:", error.message)
    return []
  }

  return ((stateRows ?? []) as Array<{ contact_id: string; current_state: string | null }>)
    .filter((r) => r.current_state === state)
    .slice(0, limit)
    .map((r) => r.contact_id)
}

/**
 * Batch emit lifecycle transitions (for migration/admin tools)
 */
export async function batchEmitLifecycleTransitions(
  events: LifecycleTransitionEvent[]
): Promise<{
  success: boolean
  successCount: number
  failureCount: number
  errors: Array<{ contactId: string; error: string }>
}> {
  let successCount = 0
  let failureCount = 0
  const errors: Array<{ contactId: string; error: string }> = []
  
  for (const event of events) {
    const result = await emitLifecycleTransition(event)
    if (result.success) {
      successCount++
    } else {
      failureCount++
      errors.push({
        contactId: event.contactId,
        error: result.error || "Unknown error",
      })
    }
  }
  
  return {
    success: failureCount === 0,
    successCount,
    failureCount,
    errors,
  }
}
