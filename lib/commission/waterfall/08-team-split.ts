import { createServiceClient } from '@/lib/supabase/service'
import { calculatePercentCents, sumCents } from '../utils'
import type { WaterfallContext, CommissionDistribution } from '../types'

/**
 * STEP 8: Team Split
 * Distribute agent's net to team members based on split_percent
 */
export async function applyTeamSplit(
  agentId: string,
  brokerageId: string,
  agentNetCents: number
): Promise<Pick<WaterfallContext, 'teamDistributions' | 'agentFinalCents'>> {
  const supabase = createServiceClient()

  // Get team members
  const { data: teamMembers } = await supabase
    .from('team_members')
    .select('*')
    .eq('agent_id', agentId)
    .eq('brokerage_id', brokerageId)
    .eq('is_active', true)

  if (!teamMembers || teamMembers.length === 0) {
    return {
      teamDistributions: [],
      agentFinalCents: agentNetCents
    }
  }

  const teamDistributions: CommissionDistribution[] = []

  for (const member of teamMembers) {
    const memberCents = calculatePercentCents(agentNetCents, member.split_percent)

    teamDistributions.push({
      distribution_type: 'team_member',
      agent_id: member.team_member_agent_id,
      calculatedCents: memberCents,
      source_of_funds: member.source_of_funds as 'agent' | 'brokerage',
      description: `Team split: ${member.split_percent}%`
    })
  }

  const totalTeamCents = sumCents(teamDistributions.map(d => d.calculatedCents))
  const agentFinalCents = agentNetCents - totalTeamCents

  return {
    teamDistributions,
    agentFinalCents
  }
}
