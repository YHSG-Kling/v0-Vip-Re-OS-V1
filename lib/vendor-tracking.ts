// WAVE 155 (lane 155R15): NOT a "use server" module any more. `trackVendorUsage` is an internal METER writer — its only caller
// is the server action app/actions/scrape-social-media.ts, which resolves the tenant itself — but as a "use server" export it
// was a public HTTP endpoint that wrote vendor_usage_tracking rows (vendor, cost, lead, brokerage) for ANY brokerage named in
// the request body (CLAUDE.md §4: every export of a "use server" file is a public endpoint). A plain server module keeps the
// one caller working and closes the door. The canonical metered path is lib/vendor-governance/track-vendor-usage.ts
// (trackVendorUsageService); merging this caller-priced writer onto it is the follow-up named in the lane notes.

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
