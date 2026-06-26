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

  // NOTE: deliberately AGENT-ONLY. A pre-offer property red flag rarely results in a written
  // offer, so looping in the TC/Deal Coordinator before any offer exists would be noise — the
  // agent gets the gated heads-up and decides whether the buyer still proceeds.
  return { ok: p.ok, riskLevel: card.riskLevel, flagged: true, proposalId: p.id, card }
}
