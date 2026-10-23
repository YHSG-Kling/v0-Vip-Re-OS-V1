import { getDefaultCommissionStructure } from "@/lib/brokerage"
import { createServiceClient } from "@/lib/supabase/service"
import { dollarsToCents } from "../utils"
import { agreementAsOf, loadAgentAgreementAsOf } from "../agreement-terms"
import type { WaterfallContext } from "../types"

export async function resolveGrossRate(
  transactionId: string,
  brokerageId: string
): Promise<WaterfallContext> {
  const supabase = createServiceClient()
  
  const { data: transaction, error: transactionError } = await supabase
    .from("transactions")
    .select("agent_id, commission_percentage, purchase_price, close_date, estimated_close_date, contract_date")
    .eq("id", transactionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  // supabase-js RESOLVES a refusal — a swallowed one reads as "transaction not found" (CLAUDE.md §3).
  if (transactionError) {
    throw new Error(`[commission-engine:resolve-rate] Transaction ${transactionId} read refused: ${transactionError.message}`)
  }
  
  if (!transaction) {
    throw new Error(`[commission-engine:resolve-rate] Transaction ${transactionId} not found`)
  }
  
  if (!transaction.agent_id) {
    throw new Error(`[commission-engine:resolve-rate] Transaction ${transactionId} has no agent assigned`)
  }
  
  // WAVE 143 (lane 143C) — THE AGREEMENT IN FORCE ON THE DEAL'S DATE, not today's profile. The agent's split,
  // fees and caps come from the version applicable to the transaction's period (close_date, else the dates
  // lib/commission/agreement-terms.ts agreementAsOf names), and the resolution rides the context so stage 08
  // (team terms), stage 10 (fees) and stage 11 (the engine_inputs snapshot) all price the SAME agreement.
  const asOf = agreementAsOf(transaction, new Date().toISOString().slice(0, 10))
  const agreement = await loadAgentAgreementAsOf(supabase, { brokerageId, agentId: transaction.agent_id, asOf })
  for (const f of agreement.findings) console.warn(`[commission-engine:agreement] ${transactionId}: ${f}`)

  const structure = await getDefaultCommissionStructure(
    brokerageId,
    transaction.agent_id,
    transaction.commission_percentage ?? undefined,
    agreement.terms,
  )
  
  return {
    transactionId,
    brokerageId,
    agentId: transaction.agent_id,
    purchasePriceCents: dollarsToCents(transaction.purchase_price),
    grossRateDecimal: structure.resolvedGrossRateDecimal,
    agentSplitPercent: structure.splitDecimal * 100,
    resolvedFrom: structure.resolvedFrom,
    agreement,
    grossCommissionCents: 0,
    adjustedGrossCents: 0,
    agentPortionCents: 0,
    brokeragePortionCents: 0,
    agentNetCents: 0,
    brokerageFinalCents: 0,
    agentFinalNetCents: 0,
    totalFeesCents: 0,
    capApplied: false,
    capStatus: 'n/a',
    amountTowardsCap: 0,
    grossAdjustments: [],
    agentAdjustments: [],
    brokerageAdjustments: [],
    teamDistributions: [],
    revenueShareDistributions: [],
    feeDistributions: []
  }
}
