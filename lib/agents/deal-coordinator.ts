/**
 * lib/agents/deal-coordinator.ts
 *
 * Deal Coordinator — one Anthropic Managed Agent per brokerage that runs a per-transaction
 * session from OFFER_ACCEPTED through CLOSED.
 *
 * Implementation delegates to `lib/agents/spawn-helper.ts` for the (create-or-find agent →
 * create-or-find session → kickoff → persist) machinery shared with Shopping Agent and
 * Listing Concierge. This file owns only the kind-specific config: system prompt,
 * model, and the per-transaction kickoff that inlines the current transaction context.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { spawnManagedAgentSession, type AgentTemplate, type SpawnResult } from "./spawn-helper"

const DEAL_COORDINATOR_SYSTEM = `You are the Deal Coordinator for a real-estate transaction at a Vip-RE-OS brokerage.

YOUR JOB:
1. Read the transaction state (milestones, deal-health, document status from the configured provider).
2. Identify the top items at risk and their deadline pressure (next 7-14 days).
3. Draft proactive, plain-language updates for the buyer AND seller (separately) explaining
   what happened, what's next, who's responsible. Keep each update under 80 words.
4. Flag escalations the agent needs to handle PERSONALLY (e.g. inspection finding, lender
   underwriting issue, title cloud, low appraisal).

NEVER:
- Send anything directly to a client — your output is reviewed by the agent before publishing.
- Make commitments on behalf of the title/lender/inspector. Identify the responsible party only.
- Speculate about price, value, or comparables. The CMA tools handle that.
- Reveal one side's negotiation posture to the other. Keep buyer + seller updates separate.

RESPONSE FORMAT:
{
  "buyer_update":   "...",  // 80 words max, what to say to the buyer
  "seller_update":  "...",  // 80 words max, what to say to the seller
  "agent_briefing": "...",  // bullets — what needs the agent's attention TODAY
  "risk_score":     number, // 0-100, where 100 is highest urgency
  "next_check_at":  "ISO8601 timestamp — when YOU should re-evaluate this transaction"
}`

const TEMPLATE: AgentTemplate = {
  kind:    "deal_coordinator",
  nameFor: (brokerageId) => `Deal Coordinator (${brokerageId.slice(0, 8)})`,
  model:   "claude-sonnet-4-6",
  system:  DEAL_COORDINATOR_SYSTEM,
}

export async function spawnDealCoordinatorForTransaction(params: {
  brokerageId:    string
  transactionId:  string
  environmentId?: string
  kickoff?:       string
}): Promise<SpawnResult> {
  const svc = createServiceClient()
  // Tenant scope — also filter by brokerage_id so a cross-brokerage caller can't read
  // (or spawn an agent on) someone else's transaction. A missing row collapses both
  // "doesn't exist" and "not yours" into one error, which is the correct shape.
  const { data: txn } = await svc
    .from("transactions")
    .select("id, deal_name, property_address, stage, status, contract_date, purchase_price, external_provider_source, brokerage_id")
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!txn) return { ok: false, error: "transaction not found in this brokerage" }

  const kickoff = params.kickoff ?? `Transaction ${txn.deal_name ?? txn.property_address ?? "(unnamed)"} just went under contract.
- Stage: ${txn.stage ?? "n/a"}
- Status: ${txn.status ?? "n/a"}
- Contract date: ${txn.contract_date ?? "n/a"}
- Purchase price: ${txn.purchase_price ?? "n/a"}
- Provider: ${txn.external_provider_source ?? "none"}

Produce your initial buyer + seller update + agent briefing per your response format.`

  return spawnManagedAgentSession(TEMPLATE, {
    brokerageId:   params.brokerageId,
    entityType:    "transaction",
    entityId:      params.transactionId,
    environmentId: params.environmentId,
    title:         `Deal: ${txn.deal_name ?? txn.property_address ?? params.transactionId.slice(0, 8)}`,
    kickoff,
    metadata: {
      transaction_id: params.transactionId,
      provider:       (txn.external_provider_source as string | null) ?? "none",
    },
  })
}
