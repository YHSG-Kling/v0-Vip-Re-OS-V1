/**
 * AGENT REGISTRY
 * Defines the AI agent types and their capabilities for the multi-agent
 * CONVERSATION-ROUTING plane.
 *
 * ── Two distinct agent planes (do not cross-wire) ───────────────────────────
 *  1. Conversation-routing plane (THIS file): who holds a conversation turn for
 *     a lead/contact/transaction, with handoffs between them. Persisted in
 *     agent_coordination_log / agent_handoffs / agent_state_machine. Vocabulary
 *     is VALID_AGENT_TYPES below.
 *  2. Managed-agent runtime plane (lib/agents/*): the autonomous per-entity
 *     "manager" agents (deal_coordinator, shopping_agent, listing_concierge,
 *     sphere_of_influence, campaign_orchestrator, marketing_agent, asset_manager)
 *     persisted in managed_agents / managed_agent_sessions. SEPARATE vocabulary.
 *
 * The two planes are intentionally separate and never join. The canonical
 * conversation-routing vocabulary is unified across all three tables by
 * migration m178 and asserted by scripts/agent-governance-simulator.ts so it
 * cannot drift again.
 *
 * THE ABSENT `lib` FIELD. Each entry used to carry a module path, e.g.
 * tc_agent -> '@/app/actions/ai-transaction-coordinator'. NOTHING read it.
 * The router uses this registry for names, capabilities and SESSION
 * bookkeeping; it never loads a module from an entry. The field cost real
 * time during the m373 audit, where it made an unwired action look reachable
 * and nearly sent a fix into dead code. A registry entry is not evidence that
 * an action is wired — so the field that implied otherwise is gone.
 */

export const AGENT_REGISTRY = {
  isa_agent: {
    name: 'ISA Agent',
    handles: ['lead_qualification', 'outreach_scheduling', 'isa_followup', 'initial_appointment'],
    entityTypes: ['lead', 'contact'],
    triggerConditions: ['new_lead', 'isa_followup_due', 'qualification_incomplete'],
    color: 'blue',
    icon: 'UserCheck',
  },
  tc_agent: {
    name: 'Transaction Coordinator Agent',
    handles: ['milestone_tracking', 'task_generation', 'deadline_alerts', 'transaction_review'],
    entityTypes: ['transaction'],
    triggerConditions: ['transaction_created', 'milestone_due', 'deal_at_risk', 'stage_changed'],
    color: 'green',
    icon: 'ClipboardList',
  },
  coaching_agent: {
    name: 'Coaching Agent',
    handles: ['weekly_report', 'stage_playbook', 'objection_coaching', 'deal_strategy'],
    entityTypes: ['contact', 'transaction', 'listing'],
    triggerConditions: ['deal_health_low', 'coaching_requested', 'weekly_cron'],
    color: 'purple',
    icon: 'GraduationCap',
  },
  content_agent: {
    name: 'Content Agent',
    handles: ['listing_announcement', 'social_post', 'email_drip', 'video_script'],
    entityTypes: ['listing', 'contact'],
    triggerConditions: ['listing_published', 'drip_sequence_due', 'content_requested'],
    color: 'orange',
    icon: 'Sparkles',
  },
} as const

// All capability strings across all agents in the registry
export type AgentCapability =
  | 'lead_qualification'
  | 'outreach_scheduling'
  | 'isa_followup'
  | 'initial_appointment'
  | 'milestone_tracking'
  | 'task_generation'
  | 'deadline_alerts'
  | 'transaction_review'
  | 'weekly_report'
  | 'stage_playbook'
  | 'objection_coaching'
  | 'deal_strategy'
  | 'listing_announcement'
  | 'social_post'
  | 'email_drip'
  | 'video_script'

// Expand AgentType to include short aliases used in coordination dashboard
export type AgentType = keyof typeof AGENT_REGISTRY | 'human' | 'none' | 'isa' | 'tc' | 'coach' | 'coordinator'

export function getAgentConfig(agentType: AgentType) {
  if (agentType === 'human' || agentType === 'none') return null
  if (agentType === 'isa') return AGENT_REGISTRY.isa_agent
  if (agentType === 'tc' || agentType === 'coordinator') return AGENT_REGISTRY.tc_agent
  if (agentType === 'coach') return AGENT_REGISTRY.coaching_agent
  const key = agentType as keyof typeof AGENT_REGISTRY
  return AGENT_REGISTRY[key] ?? null
}

export function getAgentColor(agentType: AgentType): string {
  if (agentType === 'human') return 'red'
  if (agentType === 'none') return 'gray'
  const config = getAgentConfig(agentType)
  return config?.color || 'gray'
}

export function getAgentDisplayName(agentType: AgentType): string {
  if (agentType === 'human') return 'Human Agent'
  if (agentType === 'none') return 'Unassigned'
  return (AGENT_REGISTRY as Record<string, { name: string }>)[agentType]?.name || agentType
}

/**
 * Canonical conversation-routing agent vocabulary — the SINGLE source of truth,
 * unified across agent_coordination_log / agent_handoffs / agent_state_machine
 * by migration m178. Keep in lockstep with those constraints (the governance
 * simulator asserts equality).
 *
 *   isa_agent      — AI inside-sales agent: follows up + qualifies leads
 *   tc_agent       — AI transaction-coordinator assistant (aids the human TC)
 *   coaching_agent — AI role-play / coaching
 *   content_agent  — AI content generation
 *   router         — the dispatcher itself
 *   human          — a human real-estate agent (handoff target)
 *   none           — unassigned
 */
export const VALID_AGENT_TYPES = [
  'isa_agent', 'tc_agent', 'coaching_agent', 'content_agent', 'router', 'human', 'none',
] as const
