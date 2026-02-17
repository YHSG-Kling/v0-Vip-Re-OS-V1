import { createServiceClient } from '@/lib/supabase/service'
import { calculatePercentCents } from '../utils'
import type { WaterfallContext, CommissionDistribution } from '../types'

/**
 * STEP 9: Revenue Share (Multi-Level Sponsor Tree)
 * Distribute residuals to sponsors based on agent_relationships
 */
export async function applyRevenueShare(
  agentId: string,
  brokerageId: string,
  agentFinalCents: number
): Promise<Pick<WaterfallContext, 'revenueShareDistributions' | 'agentFinalCents'>> {
  const supabase = createServiceClient()

  // Get sponsor relationships ordered by depth
  const { data: relationships } = await supabase
    .from('agent_relationships')
    .select('*')
    .eq('agent_id', agentId)
    .eq('brokerage_id', brokerageId)
    .eq('relationship_type', 'sponsor')
    .eq('is_active', true)
    .order('depth_level', { ascending: true })

  if (!relationships || relationships.length === 0) {
    return {
      revenueShareDistributions: [],
      agentFinalCents
    }
  }

  const revenueShareDistributions: CommissionDistribution[] = []
  let remainingAgentCents = agentFinalCents

  for (const rel of relationships) {
    const shareCents = calculatePercentCents(agentFinalCents, rel.revenue_share_percent)

    if (rel.source_of_funds === 'agent') {
      remainingAgentCents -= shareCents
    }
    // else: brokerage pays from their portion (tracked separately)

    revenueShareDistributions.push({
      distribution_type: 'residual',
      agent_id: rel.sponsor_agent_id,
      calculatedCents: shareCents,
      source_of_funds: rel.source_of_funds as 'agent' | 'brokerage',
      description: `Revenue share L${rel.depth_level}: ${rel.revenue_share_percent}%`
    })
  }

  return {
    revenueShareDistributions,
    agentFinalCents: remainingAgentCents
  }
}
