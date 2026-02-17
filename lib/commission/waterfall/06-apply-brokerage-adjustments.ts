import { createServiceClient } from "@/lib/supabase/service"
import { dollarsToCents, calculatePercentAmount } from "../utils"
import type { DistributionRecord } from "../types"

export async function applyBrokerageAdjustments(
  brokeragePortionCents: number,
  transactionId: string,
  brokerageId: string
): Promise<{ adjustedBrokerageCents: number; brokerageAdjustments: DistributionRecord[] }> {
  
  const supabase = createServiceClient()
  const brokerageAdjustments: DistributionRecord[] = []
  let adjustedBrokerageCents = brokeragePortionCents
  
  const { data: brokerageAdjs } = await supabase
    .from("commission_adjustments")
    .select("*")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .eq("applies_to", "brokerage")
  
  if (!brokerageAdjs || brokerageAdjs.length === 0) {
    return { adjustedBrokerageCents, brokerageAdjustments: [] }
  }
  
  for (const adj of brokerageAdjs) {
    const adjCents = adj.value_type === 'percent'
      ? calculatePercentAmount(brokeragePortionCents, adj.value)
      : dollarsToCents(adj.value)
    
    if (adj.direction === 'credit') {
      adjustedBrokerageCents -= adjCents
    } else {
      adjustedBrokerageCents += adjCents
    }
    
    brokerageAdjustments.push({
      distribution_type: 'fee',
      recipient_type: adj.recipient_type,
      calculation_type: adj.value_type,
      calculation_value: adj.value,
      calculated_amount: adjCents / 100,
      source_of_funds: 'brokerage',
      notes: adj.notes
    })
  }
  
  return { adjustedBrokerageCents, brokerageAdjustments }
}
