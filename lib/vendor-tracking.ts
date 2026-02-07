'use server'

import { createClient } from '@/lib/supabase/server'

export async function trackVendorUsage(params: {
  vendorName: string
  usageType: string
  unitsUsed: number
  costPerUnit: number
  totalCost: number
  leadId?: string
  brokerageId: string
  agentId?: string
  requestMetadata?: any
}) {
  const supabase = await createClient()

  const { error } = await supabase
    .from('vendor_usage_tracking')
    .insert({
      vendor_name: params.vendorName,
      usage_type: params.usageType,
      units_used: params.unitsUsed,
      cost_per_unit: params.costPerUnit,
      total_cost: params.totalCost,
      lead_id: params.leadId,
      brokerage_id: params.brokerageId,
      agent_id: params.agentId,
      request_metadata: params.requestMetadata,
    })

  if (error) throw error
}
