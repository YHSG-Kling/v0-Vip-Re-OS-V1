import { createServiceClient } from "@/lib/supabase/service"
import { dollarsToCents, calculatePercentAmount } from "../utils"
import type { DistributionRecord } from "../types"

export async function applyGrossAdjustments(
  grossCommissionCents: number,
  transactionId: string,
  brokerageId: string
): Promise<{ adjustedGrossCents: number; grossAdjustments: DistributionRecord[] }> {
  
  const supabase = createServiceClient()
  const grossAdjustments: DistributionRecord[] = []
  let adjustedGrossCents = grossCommissionCents
  
  const { data: grossAdjs } = await supabase
    .from("commission_adjustments")
    .select("*")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .eq("applies_to", "gross")
  
  if (!grossAdjs || grossAdjs.length === 0) {
    return { adjustedGrossCents, grossAdjustments: [] }
  }
  
  for (const adj of grossAdjs) {
    const adjCents = adj.value_type === 'percent'
      ? calculatePercentAmount(grossCommissionCents, adj.value)
      : dollarsToCents(adj.value)
    
    if (adj.direction === 'credit') {
      adjustedGrossCents -= adjCents
    } else {
      adjustedGrossCents += adjCents
    }
    
    grossAdjustments.push({
      distribution_type: 'fee',
      recipient_type: adj.recipient_type,
      calculation_type: adj.value_type,
      calculation_value: adj.value,
      calculated_amount: adjCents / 100,
      source_of_funds: 'brokerage',
      notes: adj.notes
    })
  }
  
  return { adjustedGrossCents, grossAdjustments }
}
