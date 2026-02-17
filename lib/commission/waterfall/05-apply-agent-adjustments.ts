import { createServiceClient } from "@/lib/supabase/service"
import { dollarsToCents, calculatePercentAmount } from "../utils"
import type { DistributionRecord } from "../types"

export async function applyAgentAdjustments(
  agentPortionCents: number,
  transactionId: string,
  brokerageId: string
): Promise<{ adjustedAgentCents: number; agentAdjustments: DistributionRecord[] }> {
  
  const supabase = createServiceClient()
  const agentAdjustments: DistributionRecord[] = []
  let adjustedAgentCents = agentPortionCents
  
  const { data: agentAdjs } = await supabase
    .from("commission_adjustments")
    .select("*")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .eq("applies_to", "agent")
  
  if (!agentAdjs || agentAdjs.length === 0) {
    return { adjustedAgentCents, agentAdjustments: [] }
  }
  
  for (const adj of agentAdjs) {
    const adjCents = adj.value_type === 'percent'
      ? calculatePercentAmount(agentPortionCents, adj.value)
      : dollarsToCents(adj.value)
    
    if (adj.direction === 'credit') {
      adjustedAgentCents -= adjCents
    } else {
      adjustedAgentCents += adjCents
    }
    
    agentAdjustments.push({
      distribution_type: 'fee',
      recipient_type: adj.recipient_type,
      calculation_type: adj.value_type,
      calculation_value: adj.value,
      calculated_amount: adjCents / 100,
      source_of_funds: 'agent',
      notes: adj.notes
    })
  }
  
  return { adjustedAgentCents, agentAdjustments }
}
