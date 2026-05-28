import { createServiceClient } from '@/lib/supabase/service'
import type { WaterfallContext, DistributionRecord } from '../types'

/**
 * STEP 8: Team Split
 * If agent belongs to team, split commission among team members
 * Team members can be paid from agent's portion or brokerage's portion
 */
export async function applyTeamSplit(
  context: WaterfallContext
): Promise<WaterfallContext> {
  const supabase = createServiceClient()

  // Query team members for this agent
  const { data: teamMembers, error } = await supabase
    .from('team_members')
    .select('*')
    .eq('agent_id', context.agentId)
    .eq('brokerage_id', context.brokerageId)
    .eq('is_active', true)

  if (error) {
    throw new Error(`[team-split] Failed to fetch team members: ${error.message}`)
  }

  // No team members - agent keeps full amount
  if (!teamMembers || teamMembers.length === 0) {
    return {
      ...context,
      teamDistributions: []
    }
  }

  const teamDistributions: DistributionRecord[] = []
  let totalTeamDeductionCents = 0

  for (const member of teamMembers) {
    // Calculate member's share
    const memberCents = Math.round(context.agentNetCents * (member.split_percent / 100))

    // Only deduct from agent if source_of_funds = 'agent'
    // If source_of_funds = 'brokerage', it's paid separately (tracked in distribution but not deducted)
    if (member.source_of_funds === 'agent') {
      totalTeamDeductionCents += memberCents
    }

    teamDistributions.push({
      distribution_type: 'team_member',
      agent_id: member.agent_id,
      team_id: member.team_id,
      calculation_type: 'percent',
      calculation_value: member.split_percent,
      calculated_amount: memberCents / 100, // convert to dollars
      source_of_funds: member.source_of_funds,
      notes: `Team ${member.role} split`
    })
  }

  // Calculate agent's final amount after team deductions
  const agentFinalCents = context.agentNetCents - totalTeamDeductionCents
  
  // Safety check: prevent negative balance from bad configuration
  if (agentFinalCents < 0) {
    throw new Error(
      `[team-split] Team split deductions exceed available commission. ` +
      `Agent ${context.agentId} would have negative balance. ` +
      `Available: ${context.agentNetCents / 100}, Deductions: ${totalTeamDeductionCents / 100}`
    )
  }

  return {
    ...context,
    agentFinalNetCents: agentFinalCents,
    teamDistributions
  }
}
