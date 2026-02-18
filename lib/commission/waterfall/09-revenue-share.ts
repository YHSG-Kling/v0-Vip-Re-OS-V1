import { createServiceClient } from '@/lib/supabase/service'
import type { WaterfallContext, DistributionRecord } from '../types'

/**
 * STEP 9: Revenue Share
 * Multi-level revenue share to sponsors (eXp/REAL model)
 * Sponsors can be paid from agent's portion or brokerage's portion
 */
export async function applyRevenueShare(
  context: WaterfallContext
): Promise<WaterfallContext> {
  const supabase = createServiceClient()

  // Query revenue share relationships for this agent
  const { data: relationships, error } = await supabase
    .from('agent_relationships')
    .select('*')
    .eq('agent_id', context.agentId)
    .eq('brokerage_id', context.brokerageId)
    .eq('is_active', true)
    .order('depth_level', { ascending: true }) // Process direct sponsor first

  if (error) {
    throw new Error(`[revenue-share] Failed to fetch relationships: ${error.message}`)
  }

  // No revenue share relationships - agent keeps full amount
  if (!relationships || relationships.length === 0) {
    return {
      ...context,
      revenueShareDistributions: []
    }
  }

  const revenueShareDistributions: DistributionRecord[] = []
  let totalRevenueShareDeductionCents = 0

  for (const rel of relationships) {
    // Calculate sponsor's share
    const shareCents = Math.round(context.agentFinalCents * (rel.revenue_share_percent / 100))

    // Only deduct from agent if source_of_funds = 'agent' (traditional mentor model)
    // If source_of_funds = 'brokerage', it's paid separately by brokerage (eXp/REAL model)
    if (rel.source_of_funds === 'agent') {
      totalRevenueShareDeductionCents += shareCents
    }

    revenueShareDistributions.push({
      distribution_type: 'residual',
      agent_id: rel.sponsor_agent_id,
      calculation_type: 'percent',
      calculation_value: rel.revenue_share_percent,
      calculated_amount: shareCents / 100, // convert to dollars
      source_of_funds: rel.source_of_funds,
      notes: `${rel.relationship_type} revenue share (level ${rel.depth_level})`
    })
  }

  // Calculate agent's final amount after revenue share deductions
  const agentFinalCents = context.agentFinalCents - totalRevenueShareDeductionCents

  return {
    ...context,
    agentFinalCents,
    revenueShareDistributions
  }
}
