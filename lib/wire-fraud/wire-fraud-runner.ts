// lib/wire-fraud/wire-fraud-runner.ts
//
// Runs the Wire-Fraud Sentinel on a wire-instruction submission and, on a real risk, fires a
// CRITICAL escalation — a high-priority notification to the agent + an inter-manager signal from
// the Deal Coordinator — so a human verifies BEFORE a cent moves. Read-only on the deal; never
// throws into the caller (a closing-window event path).

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { detectWireFraudRisk, type WireFraudInput, type WireFraudVerdict } from "./wire-fraud-sentinel"

type Svc = ReturnType<typeof createServiceClient>

export interface WireFraudRunInput {
  brokerageId: string
  /** The buyer contact this wire endangers. */
  contactId: string
  /** The agent to alert (users.id). */
  agentUserId?: string | null
  wire: WireFraudInput
  escalate?: boolean
}

export interface WireFraudRunResult { verdict: WireFraudVerdict; escalated: boolean; notificationId?: string }

export async function runWireFraudSentinel(input: WireFraudRunInput, client?: Svc): Promise<WireFraudRunResult> {
  const svc = client ?? createServiceClient()
  const verdict = detectWireFraudRisk(input.wire)

  if (verdict.riskLevel === "ok" || input.escalate === false) return { verdict, escalated: false }

  let escalated = false
  let notificationId: string | undefined
  try {
    // CRITICAL alert to the agent — this is the one notification you never want missed.
    if (input.agentUserId) {
      const { data: notif } = await svc.from("notifications").insert({
        user_id: input.agentUserId, brokerage_id: input.brokerageId, type: "wire_fraud_alert",
        title: verdict.riskLevel === "block" ? "⛔ Possible WIRE FRAUD — stop the wire" : "⚠️ Verify these wire instructions",
        body: `${verdict.flags.map((f) => f.evidence).join(" • ")} — ${verdict.protectiveAction}`,
        entity_type: "contact", entity_id: input.contactId, priority: "critical",
      }).select("id").single()
      notificationId = (notif as any)?.id
    }
    // Surface it on the inter-manager bus (Deal Coordinator stands guard).
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const sig = await publishManagerSignal({
      brokerageId: input.brokerageId, fromManager: "deal_coordinator", toManager: "campaign_orchestrator",
      signalType: "wire_fraud_risk", message: `Wire-fraud ${verdict.riskLevel} on a buyer's closing wire — verify by phone before any funds move.`,
      entityType: "contact", entityId: input.contactId, payload: { riskLevel: verdict.riskLevel, flags: verdict.flags },
    }, svc)
    escalated = !!notificationId || sig.ok
  } catch { /* escalation best-effort — the verdict still returns */ }

  return { verdict, escalated, notificationId }
}
