// lib/property-risk/deal-killer-runner.ts
//
// Runs the deal-killer radar on a buyer's target property and, when there's a real red flag,
// proposes a GATED, persona-generated heads-up to the buyer's agent (proposeClientMessage — same
// seam deal_autopsy uses). No flag → no noise. Nothing reaches anyone without the agent approving.

import "server-only"
import { analyzePropertyRisks, type PropertyRiskInput, type PropertyRiskCard } from "./buyer-target-analyzer"
import { generatePersonaCopy, type CopyGenerator } from "@/lib/kernel/ai-copy"
import type { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

export interface DealKillerInput {
  brokerageId: string
  contactId: string
  propertyAddress: string
  risk: PropertyRiskInput
  copyGenerator?: CopyGenerator
}

export interface DealKillerResult { ok: boolean; riskLevel: PropertyRiskCard["riskLevel"]; flagged: boolean; proposalId?: string; card: PropertyRiskCard }

export async function runDealKillerRadar(input: DealKillerInput, client?: Svc): Promise<DealKillerResult> {
  const card = analyzePropertyRisks(input.risk)
  // Only escalate when there's a real (non-info) red flag — silence on a clean property.
  if (card.redFlags.length === 0) return { ok: true, riskLevel: card.riskLevel, flagged: false, card }

  const fallback = `Heads up on ${input.propertyAddress} before your buyer offers: ${card.redFlags.slice(0, 3).join("; ")}. ${card.signals[0]?.recommendation ?? ""}`.trim()
  const draft = await generatePersonaCopy(
    {
      goal: "a short heads-up to the AGENT about red flags on a buyer's target property to check before they write an offer",
      facts: [`Property: ${input.propertyAddress}`, ...card.redFlags, card.signals[0]?.recommendation ?? ""].filter(Boolean),
      channel: "portal",
      persona: { audience: "agent", situation: "pre-offer due diligence" },
      words: 60,
    },
    { body: fallback },
    { generator: input.copyGenerator },
  )

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const p = await proposeClientMessage({
    brokerageId: input.brokerageId, agentKind: "shopping_agent", entityType: "contact",
    entityId: input.contactId, recipientContactId: input.contactId, audience: "agent",
    subject: `Pre-offer red flags — ${input.propertyAddress}`, body: draft.body,
    rationale: `Deal-killer radar: ${card.riskLevel} risk on a buyer target (${card.redFlags.length} flag${card.redFlags.length === 1 ? "" : "s"})`,
    channel: "portal",
  }, client)

  // TC + agent: on HIGH/CRITICAL risk, also loop in the deal-coordination owners (the TC side) so
  // title/lien/insurability issues are surfaced BEFORE the offer, not after acceptance. The agent
  // got the gated heads-up above; this hands the same flag to the Deal Coordinator over the bus.
  if (card.riskLevel === "high" || card.riskLevel === "critical") {
    try {
      const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
      await publishManagerSignal({
        brokerageId: input.brokerageId,
        fromManager: "shopping_agent",
        toManager: "deal_coordinator",
        signalType: "buyer_target_risk",
        message: `Deal-killer radar: ${card.riskLevel} risk on a buyer's target (${input.propertyAddress}) before any offer — looping in the TC side early.`,
        entityType: "contact",
        entityId: input.contactId,
        contactId: input.contactId,
        payload: { property_address: input.propertyAddress, risk_level: card.riskLevel, red_flags: card.redFlags.slice(0, 5) },
      }, client)
    } catch (e) {
      console.error("[deal-killer] TC handoff failed:", e)
    }
  }

  return { ok: p.ok, riskLevel: card.riskLevel, flagged: true, proposalId: p.id, card }
}
