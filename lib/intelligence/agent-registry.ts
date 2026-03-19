/**
 * AGENT REGISTRY
 * Defines the 4 AI agent types and their capabilities for the multi-agent coordination system.
 */

export const AGENT_REGISTRY = {
  isa_agent: {
    name: 'ISA Agent',
    handles: ['lead_qualification', 'outreach_scheduling', 'isa_followup', 'initial_appointment'],
    entityTypes: ['lead', 'contact'],
    triggerConditions: ['new_lead', 'isa_followup_due', 'qualification_incomplete'],
    lib: '@/lib/ai-isa',
    color: 'blue',
    icon: 'UserCheck',
  },
  tc_agent: {
    name: 'Transaction Coordinator Agent',
    handles: ['milestone_tracking', 'task_generation', 'deadline_alerts', 'transaction_review'],
    entityTypes: ['transaction'],
    triggerConditions: ['transaction_created', 'milestone_due', 'deal_at_risk', 'stage_changed'],
    lib: '@/app/actions/ai-transaction-coordinator',
    color: 'green',
    icon: 'ClipboardList',
  },
  coaching_agent: {
    name: 'Coaching Agent',
    handles: ['weekly_report', 'stage_playbook', 'objection_coaching', 'deal_strategy'],
    entityTypes: ['contact', 'transaction', 'listing'],
    triggerConditions: ['deal_health_low', 'coaching_requested', 'weekly_cron'],
    lib: '@/lib/intelligence/coaching-engine',
    color: 'purple',
    icon: 'GraduationCap',
  },
  content_agent: {
    name: 'Content Agent',
    handles: ['listing_announcement', 'social_post', 'email_drip', 'video_script'],
    entityTypes: ['listing', 'contact'],
    triggerConditions: ['listing_published', 'drip_sequence_due', 'content_requested'],
    lib: '@/lib/content-generation',
    color: 'orange',
    icon: 'Sparkles',
  },
} as const

export type AgentType = keyof typeof AGENT_REGISTRY | 'human' | 'none'

export function getAgentConfig(agentType: AgentType) {
  if (agentType === 'human' || agentType === 'none') {
    return null
  }
  return AGENT_REGISTRY[agentType]
}

export function getAgentColor(agentType: AgentType): string {
  if (agentType === 'human') return 'red'
  if (agentType === 'none') return 'gray'
  return AGENT_REGISTRY[agentType]?.color || 'gray'
}

export function getAgentDisplayName(agentType: AgentType): string {
  if (agentType === 'human') return 'Human Agent'
  if (agentType === 'none') return 'Unassigned'
  return AGENT_REGISTRY[agentType]?.name || agentType
}

export const VALID_AGENT_TYPES = ['isa_agent', 'tc_agent', 'coaching_agent', 'content_agent', 'human'] as const
