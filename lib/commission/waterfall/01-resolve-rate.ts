import { getDefaultCommissionStructure } from "@/lib/brokerage/get-default-commission-structure"
import { createServiceClient } from "@/lib/supabase/service"

export async function resolveGrossRate(
  transactionId: string,
  brokerageId: string
) {
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
    grossRateDecimal: structure.resolvedGrossRateDecimal,
    resolvedFrom: structure.resolvedFrom,
    agentId: transaction.agent_id,
    agentSplitPercent: structure.splitDecimal * 100,
    purchasePrice: transaction.purchase_price
  }
}
