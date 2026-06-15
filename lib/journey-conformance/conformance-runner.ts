// lib/journey-conformance/conformance-runner.ts
//
// Makes the Journey-Conformance Monitor LIVE: loads a contact's actual transition history from
// lifecycle_events, builds the legal map + gated states from the CANONICAL BUYER_LIFECYCLE_STATES
// (no re-implementation), replays it through the pure checker, and escalates any violations to the
// Command Center via the inter-manager bus. Read-only audit (it writes nothing on the contact);
// escalation is opt-in so the proof can run without publishing.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { BUYER_LIFECYCLE_STATES } from "@/lib/buyer-lifecycle/lifecycle-definitions"
import { checkJourneyConformance, type JourneyTransition, type ConformanceConfig, type ConformanceResult } from "./conformance-checker"

type Svc = ReturnType<typeof createServiceClient>

const GATE_SATISFIED_STATE = "BUYER_FINANCIALLY_VERIFIED"

/** Build the conformance config from the canonical lifecycle definitions (single source of truth). */
function buyerConfig(): ConformanceConfig {
  const legalMap: Record<string, string[]> = {}
  const gatedStates = new Set<string>()
  for (const s of BUYER_LIFECYCLE_STATES) {
    legalMap[s.state] = s.allowedFrom ?? []
    if (s.requiresFinancialVerification) gatedStates.add(s.state)
  }
  return { legalMap, gatedStates, gateSatisfiedState: GATE_SATISFIED_STATE }
}

export interface ConformanceAuditResult extends ConformanceResult {
  contactId: string
  escalated: boolean
}

/** Audit one contact's buyer-journey conformance from its real transition history. */
export async function auditJourneyConformance(
  contactId: string,
  brokerageId: string,
  opts: { escalate?: boolean } = {},
  client?: Svc,
): Promise<ConformanceAuditResult> {
  const svc = client ?? createServiceClient()

  const { data: events } = await svc.from("lifecycle_events")
    .select("event_type, metadata, created_at")
    .eq("entity_type", "contact").eq("entity_id", contactId)
    .order("created_at", { ascending: true }).limit(500)

  const transitions: JourneyTransition[] = ((events ?? []) as Record<string, any>[])
    .filter((e) => e.metadata?.from_stage && e.metadata?.to_stage)
    .map((e) => ({
      from: String(e.metadata.from_stage),
      to: String(e.metadata.to_stage),
      at: e.created_at,
      override: typeof e.event_type === "string" && e.event_type.includes("overridden"),
    }))

  const result = checkJourneyConformance(transitions, buyerConfig())

  let escalated = false
  if (!result.compliant && opts.escalate !== false) {
    try {
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      const r = await publishManagerSignal({
        brokerageId,
        fromManager: "data_steward",
        toManager: "campaign_orchestrator",
        signalType: "journey_conformance_violation",
        message: `${result.violations.length} journey-conformance violation(s) on a buyer contact — the contract's legal order / hard gate was bypassed without an authorized override.`,
        entityType: "contact",
        entityId: contactId,
        payload: { violations: result.violations, overridesUsed: result.overridesUsed },
      }, svc)
      escalated = r.ok
    } catch { /* escalation best-effort */ }
  }

  return { ...result, contactId, escalated }
}
