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
import { resolveBrokerageContext, renderBrokerageContextForKickoff } from "./brokerage-context"
import { resolvePersonaContext } from "./persona-context"

const DEAL_COORDINATOR_SYSTEM = `You are the Deal Coordinator for a real-estate transaction. You serve under whichever
brokerage the kickoff names — the brokerage's name, subscription tier, brand voice, and
signature policy are passed in the kickoff context block. NEVER substitute a hardcoded
brokerage name in your output.

You COMPOSE with the existing kernel — do NOT reinvent flows the kernel already runs:
   - Brand voice + compliance gates: lib/kernel/brand-voice.ts + lib/kernel/compliance.ts.
   - Email signature: auto-wrapped by lib/kernel/communications/assemble-email.ts.
   - Deal health: lib/deal-health/health-scorer.ts already runs; read its output, don't
     re-score.
   - Provider docs: lib/transactions/sync-from-provider.ts (m106/m107) pulls envelope
     state from the configured transaction provider; read transaction_documents.

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
    .select("id, deal_name, property_address, stage, status, contract_date, purchase_price, external_provider_source, brokerage_id, buyer_contact_id, seller_contact_id")
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!txn) return { ok: false, error: "transaction not found in this brokerage" }

  // Resolve buyer + seller persona so the Deal Coordinator drafts both sides in their
  // respective voices (e.g. first_time_buyer hears reassurance, luxury_seller hears
  // sophistication). Brand voice resolution uses 'buyer' journey type — the brokerage's
  // resolved tone applies across both sides for a transaction in flight.
  let buyerPersonaKey  = "first_time_buyer"
  let sellerPersonaKey = "first_time_seller"
  if (txn.buyer_contact_id) {
    const { data: b } = await svc.from("contacts").select("contact_persona").eq("id", txn.buyer_contact_id).maybeSingle()
    buyerPersonaKey = (b?.contact_persona as string | null) ?? buyerPersonaKey
  }
  if (txn.seller_contact_id) {
    const { data: s } = await svc.from("contacts").select("contact_persona").eq("id", txn.seller_contact_id).maybeSingle()
    sellerPersonaKey = (s?.contact_persona as string | null) ?? sellerPersonaKey
  }
  const buyerPersona  = resolvePersonaContext(buyerPersonaKey, "buyer")
  const sellerPersona = resolvePersonaContext(sellerPersonaKey, "seller")
  const brokerage = await resolveBrokerageContext({
    brokerageId: params.brokerageId,
    journeyType: "buyer",   // transaction has both sides; brand voice rules tend to
                            // overlap, and the resolver doesn't have a "both" option.
    persona:     buyerPersonaKey,
  })

  const kickoff = params.kickoff ?? [
    renderBrokerageContextForKickoff(brokerage),
    "",
    "──── TRANSACTION CONTEXT ────",
    `Deal: ${txn.deal_name ?? txn.property_address ?? "(unnamed)"}`,
    `Stage: ${txn.stage ?? "n/a"}`,
    `Status: ${txn.status ?? "n/a"}`,
    `Contract date: ${txn.contract_date ?? "n/a"}`,
    `Purchase price: ${txn.purchase_price ?? "n/a"}`,
    `Provider: ${txn.external_provider_source ?? "none"}`,
    "",
    `BUYER VOICE (use for buyer_update): ${buyerPersona.aiContext}`,
    `SELLER VOICE (use for seller_update): ${sellerPersona.aiContext}`,
    (buyerPersona.sensitive || sellerPersona.sensitive)
      ? "⚠️  SENSITIVE CONTEXT on one side — use extra care; never bridge details across sides."
      : "",
    "",
    "Produce your initial buyer + seller update + agent briefing per your response format.",
    "Match the brokerage compliance/voice gates. Output JSON only.",
  ].filter(Boolean).join("\n")

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
