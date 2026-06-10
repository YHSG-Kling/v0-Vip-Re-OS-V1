/**
 * System 5.1D: Buyer Lifecycle Governance Hardening
 * Extension 6: SLA Metadata Definitions
 * 
 * Emits SLA expectation metadata to activities for orchestration.
 * Does NOT enforce SLAs - Phase 3 workflow systems handle that.
 */

import { createServiceClient } from "@/lib/supabase/service"
import type { BuyerState } from "../lifecycle-definitions"

export type SLAType =
  | "financial_verification"
  | "search_configuration"
  | "tour_scheduling"
  | "offer_submission"
  | "inactivity_threshold"

export type SLASeverity = "low" | "medium" | "high" | "critical"

export interface SLAExpectation {
  slaType: SLAType
  state: BuyerState
  expectedHours: number
  severity: SLASeverity
  description: string
}

/**
 * Canonical SLA expectations by buyer state
 */
export const BUYER_SLA_EXPECTATIONS: SLAExpectation[] = [
  {
    slaType: "financial_verification",
    state: "BUYER_CONTACT_CREATED",
    expectedHours: 48,
    severity: "high",
    description: "Buyer should be financially verified within 48 hours of contact creation",
  },
  {
    slaType: "search_configuration",
    state: "BUYER_FINANCIALLY_VERIFIED",
    expectedHours: 48,
    severity: "medium",
    description: "Search criteria should be configured within 48 hours of verification",
  },
  {
    slaType: "tour_scheduling",
    state: "BUYER_TOUR_ELIGIBLE",
    expectedHours: 72,
    severity: "high",
    description: "First tour should be scheduled within 72 hours of tour eligibility",
  },
  {
    slaType: "offer_submission",
    state: "BUYER_OFFER_ELIGIBLE",
    expectedHours: 168, // 7 days
    severity: "medium",
    description: "Offer should be submitted within 7 days of offer eligibility",
  },
  {
    slaType: "inactivity_threshold",
    state: "BUYER_SEARCHING",
    expectedHours: 336, // 14 days
    severity: "low",
    description: "Buyer should show activity within 14 days while searching",
  },
  {
    slaType: "inactivity_threshold",
    state: "BUYER_TOURING",
    expectedHours: 240, // 10 days
    severity: "medium",
    description: "Buyer should schedule tours within 10 days while touring",
  },
]

/**
 * Get SLA expectation for a state
 */
export function getSLAExpectation(state: BuyerState, slaType: SLAType): SLAExpectation | undefined {
  return BUYER_SLA_EXPECTATIONS.find((sla) => sla.state === state && sla.slaType === slaType)
}

/**
 * Get all SLA expectations for a state
 */
export function getSLAExpectationsForState(state: BuyerState): SLAExpectation[] {
  return BUYER_SLA_EXPECTATIONS.filter((sla) => sla.state === state)
}

/**
 * Emit SLA expectation metadata on state transition
 */
export async function emitSLAExpectationMetadata(params: {
  contactId: string
  state: BuyerState
  userId: string
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, state, userId } = params

  const expectations = getSLAExpectationsForState(state)

  if (expectations.length === 0) {
    return { success: true } // No SLAs for this state
  }

  const supabase = createServiceClient()

  // Agent task (correct location, no changes) — type: buyer.lifecycle.sla_expectations, buyer.lifecycle.sla_breach, buyer.lifecycle.renewal_reminder
  // Emit one metadata event with all expectations
  const { error } = await supabase.from("activities").insert({
    activity_type: "buyer.lifecycle.sla_expectations",
    entity_type: "contact",
    entity_id: contactId,
    agent_user_id: userId,
    metadata: {
      buyer_state: state,
      expectations: expectations.map((exp) => ({
        sla_type: exp.slaType,
        expected_hours: exp.expectedHours,
        severity: exp.severity,
        description: exp.description,
        due_at: new Date(Date.now() + exp.expectedHours * 60 * 60 * 1000).toISOString(),
      })),
    },
  })

  if (error) {
    console.error("[5.1D] Error emitting SLA expectation metadata:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

/**
 * Check if SLA is breached
 */
export interface SLABreachCheck {
  isBreached: boolean
  slaType: SLAType
  expectedHours: number
  actualHours: number
  hoursOverdue?: number
  severity: SLASeverity
}

export async function checkSLABreach(params: {
  contactId: string
  state: BuyerState
  slaType: SLAType
  transitionDate: Date
}): Promise<SLABreachCheck | null> {
  const { state, slaType, transitionDate } = params

  const expectation = getSLAExpectation(state, slaType)
  if (!expectation) {
    return null // No SLA defined
  }

  const now = new Date()
  const diff = now.getTime() - transitionDate.getTime()
  const actualHours = diff / (1000 * 60 * 60)

  const isBreached = actualHours > expectation.expectedHours

  return {
    isBreached,
    slaType: expectation.slaType,
    expectedHours: expectation.expectedHours,
    actualHours: Math.floor(actualHours),
    hoursOverdue: isBreached ? Math.floor(actualHours - expectation.expectedHours) : undefined,
    severity: expectation.severity,
  }
}

/**
 * Emit SLA breach signal
 */
export async function emitSLABreachSignal(params: {
  contactId: string
  state: BuyerState
  slaType: SLAType
  hoursOverdue: number
  severity: SLASeverity
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, state, slaType, hoursOverdue, severity } = params

  const supabase = createServiceClient()

  const { error } = await supabase.from("activities").insert({
    activity_type: "buyer.lifecycle.sla_breach",
    entity_type: "contact",
    entity_id: contactId,
    metadata: {
      buyer_state: state,
      sla_type: slaType,
      hours_overdue: hoursOverdue,
      severity,
    },
  })

  if (error) {
    console.error("[5.1D] Error emitting SLA breach signal:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

/**
 * Query SLA breaches for a buyer
 */
export interface SLABreachEvent {
  id: string
  state: BuyerState
  slaType: SLAType
  hoursOverdue: number
  severity: SLASeverity
  occurredAt: Date
}

export async function querySLABreaches(
  contactId: string,
  options?: { limit?: number }
): Promise<SLABreachEvent[]> {
  const { limit = 20 } = options || {}
  const supabase = createServiceClient()

  const { data: events, error } = await supabase
    .from("activities")
    .select("id, created_at, metadata")
    .eq("activity_type", "buyer.lifecycle.sla_breach")
    .eq("entity_type", "contact")
    .eq("entity_id", contactId)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("[5.1D] Error querying SLA breaches:", error)
    return []
  }

  if (!events) {
    return []
  }

  return events.map((event) => {
    const metadata = (event.metadata as Record<string, unknown>) || {}
    return {
      id: event.id,
      state: metadata.buyer_state as BuyerState,
      slaType: metadata.sla_type as SLAType,
      hoursOverdue: metadata.hours_overdue as number,
      severity: metadata.severity as SLASeverity,
      occurredAt: new Date(event.created_at),
    }
  })
}

/**
 * Get buyers with SLA breaches (for escalation)
 */
export async function getBuyersWithSLABreaches(params: {
  brokerageId: string
  severityFilter?: SLASeverity[]
  limit?: number
}): Promise<Array<{ contactId: string; breachCount: number; highestSeverity: SLASeverity }>> {
  const { brokerageId, severityFilter, limit = 100 } = params
  const supabase = createServiceClient()

  // Get all contacts for brokerage
  const { data: contacts, error } = await supabase
    .from("contacts")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .limit(limit)

  if (error || !contacts) {
    console.error("[5.1D] Error fetching contacts:", error)
    return []
  }

  const buyersWithBreaches: Array<{ contactId: string; breachCount: number; highestSeverity: SLASeverity }> = []

  for (const contact of contacts) {
    const breaches = await querySLABreaches(contact.id)

    if (breaches.length > 0) {
      // Apply severity filter if provided
      const filteredBreaches = severityFilter
        ? breaches.filter((b) => severityFilter.includes(b.severity))
        : breaches

      if (filteredBreaches.length > 0) {
        // Determine highest severity
        const severityOrder: SLASeverity[] = ["critical", "high", "medium", "low"]
        const highestSeverity = severityOrder.find((sev) => filteredBreaches.some((b) => b.severity === sev)) || "low"

        buyersWithBreaches.push({
          contactId: contact.id,
          breachCount: filteredBreaches.length,
          highestSeverity,
        })
      }
    }
  }

  return buyersWithBreaches
}

/**
 * Emit SLA warning (before breach)
 */
export async function emitSLAWarningSignal(params: {
  contactId: string
  state: BuyerState
  slaType: SLAType
  hoursRemaining: number
  severity: SLASeverity
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, state, slaType, hoursRemaining, severity } = params

  const supabase = createServiceClient()

  const { error } = await supabase.from("activities").insert({
    activity_type: "buyer.lifecycle.sla_warning",
    entity_type: "contact",
    entity_id: contactId,
    metadata: {
      buyer_state: state,
      sla_type: slaType,
      hours_remaining: hoursRemaining,
      severity,
    },
  })

  if (error) {
    console.error("[5.1D] Error emitting SLA warning signal:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}
