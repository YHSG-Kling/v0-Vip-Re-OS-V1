import { getDefaultCommissionStructure } from "@/lib/brokerage/get-default-commission-structure"
import { createServiceClient } from "@/lib/supabase/service"
import { dollarsToCents } from "../utils"
import type { WaterfallContext } from "../types"

export async function resolveGrossRate(
  transactionId: string,
  brokerageId: string
): Promise<WaterfallContext> {
  const supabase = createServiceClient()
  
  const { data: transaction } = await supabase
    .from("transactions")
    .select("agent_id, commission_percentage, purchase_price")
    .eq("id", transactionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  
  if (!transaction) {
    throw new Error(`[commission-engine:resolve-rate] Transaction ${transactionId} not found`)
  }
  
  if (!transaction.agent_id) {
    throw new Error(`[commission-engine:resolve-rate] Transaction ${transactionId} has no agent assigned`)
  }
  
  const structure = await getDefaultCommissionStructure(
    brokerageId,
    transaction.agent_id,
    transaction.commission_percentage ?? undefined
  )
  
  return {
    transactionId,
    brokerageId,
    agentId: transaction.agent_id,
    purchasePriceCents: dollarsToCents(transaction.purchase_price),
    grossRateDecimal: structure.resolvedGrossRateDecimal,
    agentSplitPercent: structure.splitDecimal * 100,
    resolvedFrom: structure.resolvedFrom,
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
