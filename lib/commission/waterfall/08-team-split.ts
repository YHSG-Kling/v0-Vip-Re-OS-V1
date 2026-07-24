import { createServiceClient } from '@/lib/supabase/service'
import type { WaterfallContext, DistributionRecord } from '../types'
import { resolveTeamLeadOverride, isAgreementEffective, type TeamLeadAgreement } from '../team-lead-split'

/**
 * Resolve the closing agent's team-lead override agreement (owner rule: a team
 * lead's commission agreement applies to the team's agents). Returns null when the
 * agent has no team, no effective agreement, no positive split, or the lead cannot
 * be resolved to an AGENTS id — in every such case the override is inert.
 *
 * ID-SPACE: transactions.agent_id (context.agentId) is an agents.id; agents.team_id
 * → teams.id; teams.team_lead_id is a USERS id, so it is resolved to the lead's
 * agents.id (agents.user_id → agents.id) so the pure math + the distribution FK
 * (commission_distributions.agent_id → agents.id) stay in one id-space.
 */
async function resolveTeamLeadAgreement(
  supabase: ReturnType<typeof createServiceClient>,
  context: WaterfallContext,
): Promise<TeamLeadAgreement | null> {
  const { data: agentRow } = await supabase
    .from('agents')
    .select('team_id')
    .eq('id', context.agentId)
    .maybeSingle()
  const teamId = (agentRow as any)?.team_id as string | null
  if (!teamId) return null

  const { data: team } = await supabase
    .from('teams')
    .select('id, team_lead_id, team_split_type, team_split_percent, team_split_value, terms_effective_date')
    .eq('id', teamId)
    .maybeSingle()
  if (!team || !(team as any).team_lead_id) return null
  if (!isAgreementEffective((team as any).terms_effective_date ?? null, new Date())) return null

  // teams.team_lead_id is a USERS id → resolve to the lead's AGENTS id (same
  // brokerage). If the lead is not an agent, there is no distributable target → inert.
  const { data: leadAgent } = await supabase
    .from('agents')
    .select('id')
    .eq('user_id', (team as any).team_lead_id)
    .eq('brokerage_id', context.brokerageId)
    .maybeSingle()
  const leadAgentId = (leadAgent as any)?.id as string | null
  if (!leadAgentId) return null

  const splitType = (team as any).team_split_type === 'flat' ? 'flat' : 'percent'
  const splitValue = splitType === 'flat'
    ? Number((team as any).team_split_value ?? 0)
    : Number((team as any).team_split_percent ?? 0)

  return { teamId: (team as any).id, teamLeadId: leadAgentId, splitType, splitValue }
}

/**
 * STEP 8: Team Split
 * If agent belongs to team, split commission among team members
 * Team members can be paid from agent's portion or brokerage's portion.
 * ALSO applies the team-LEAD override (owner rule): a team lead's agreement takes
 * its cut of a team agent's net, sourced from the agent, paid to the lead.
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

  const teamDistributions: DistributionRecord[] = []
  let totalTeamDeductionCents = 0

  for (const member of teamMembers ?? []) {
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

  // TEAM-LEAD OVERRIDE (owner rule): if the closing agent belongs to a team, the
  // team lead's agreement takes its cut of the agent's net, sourced from the agent,
  // paid to the lead. Best-effort: an agreement-resolution failure must never break
  // the whole commission calc — the agent simply keeps their full net (no override,
  // never a wrong charge). Inert when the agent has no team / no effective agreement.
  let leadDeductionCents = 0
  try {
    const agreement = await resolveTeamLeadAgreement(supabase, context)
    // Net available to the lead's cut is what remains after member deductions.
    const netForLead = context.agentNetCents - totalTeamDeductionCents
    const { leadCents, distribution } = resolveTeamLeadOverride(netForLead, context.agentId, agreement)
    if (distribution) {
      leadDeductionCents = leadCents
      teamDistributions.push(distribution)
    }
  } catch (err) {
    console.error('[team-split] team-lead override skipped (non-fatal):', err)
  }

  // Calculate agent's final amount after member deductions + the team-lead override.
  const agentFinalCents = context.agentNetCents - totalTeamDeductionCents - leadDeductionCents

  // Safety check: prevent negative balance from bad configuration.
  if (agentFinalCents < 0) {
    throw new Error(
      `[team-split] Team split deductions exceed available commission. ` +
      `Agent ${context.agentId} would have negative balance. ` +
      `Available: ${context.agentNetCents / 100}, Deductions: ${(totalTeamDeductionCents + leadDeductionCents) / 100}`
    )
  }

  return {
    ...context,
    agentFinalNetCents: agentFinalCents,
    teamDistributions
  }
}
