// lib/intelligence/manager-standup.ts
//
// The MANAGER DAILY STANDUP — the broker's one-glance answer to "what did my ten
// Claude managers do while I slept, and what do they need from a human?" Every line
// is manager-attributed (manager-registry keys) and built from REAL operational
// tables — no model narration in the numbers.
//
// Surfaces in the broker brief (user-type-briefs/broker.ts): items needing a human
// become priorities; the activity counts become metrics. This is the egress made
// visible: governed autonomy with a daily accountability report.

import { createServiceClient } from '@/lib/supabase/service'
import { MANAGERS, type ManagerKey } from '@/lib/kernel/manager-registry'

export interface ManagerStandupLine {
  manager: ManagerKey
  label: string
  /** What the manager did in the last 24h (count of governed actions). */
  activity_24h: number
  /** Items waiting on a HUMAN decision right now. */
  needs_human: number
  /** One broker-readable line. */
  headline: string
}

export async function generateManagerStandup(brokerageId: string): Promise<ManagerStandupLine[]> {
  const supabase = createServiceClient()
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const [handoffs, hotIsa, proposedMsgs, enrichQueue, activeListings, rendersDone, matches24h] =
    await Promise.all([
      supabase.from('assignment_log').select('id', { count: 'exact', head: true })
        .eq('brokerage_id', brokerageId).gte('created_at', since),
      supabase.from('leads').select('id', { count: 'exact', head: true })
        .eq('brokerage_id', brokerageId).eq('ai_isa_owner', true).eq('lead_temperature', 'hot'),
      supabase.from('agent_client_messages').select('id', { count: 'exact', head: true })
        .eq('brokerage_id', brokerageId).eq('status', 'proposed'),
      supabase.from('lead_enrichment_queue').select('id', { count: 'exact', head: true })
        .eq('brokerage_id', brokerageId).eq('status', 'pending'),
      supabase.from('listings').select('id', { count: 'exact', head: true })
        .eq('brokerage_id', brokerageId).in('lifecycle_stage', ['MLS_ACTIVE', 'COMING_SOON_ACTIVE', 'SHOWINGS_ACTIVE']),
      supabase.from('remotion_composition_renders').select('id', { count: 'exact', head: true })
        .eq('brokerage_id', brokerageId).eq('render_status', 'completed').gte('completed_at', since),
      supabase.from('property_matches').select('id', { count: 'exact', head: true })
        .eq('brokerage_id', brokerageId).gte('created_at', since),
    ])

  const n = (r: { count: number | null }) => r.count ?? 0
  const lines: ManagerStandupLine[] = [
    {
      manager: 'ai_isa', label: MANAGERS.ai_isa.label,
      activity_24h: n(handoffs), needs_human: 0,
      headline: `${n(handoffs)} qualified handoff${n(handoffs) === 1 ? '' : 's'} in 24h · working ${n(hotIsa)} hot conversation${n(hotIsa) === 1 ? '' : 's'}`,
    },
    {
      manager: 'campaign_orchestrator', label: MANAGERS.campaign_orchestrator.label,
      activity_24h: n(proposedMsgs), needs_human: n(proposedMsgs),
      headline: n(proposedMsgs) > 0
        ? `${n(proposedMsgs)} client message${n(proposedMsgs) === 1 ? '' : 's'} proposed — awaiting your approval`
        : 'No client messages awaiting approval',
    },
    {
      manager: 'data_steward', label: MANAGERS.data_steward.label,
      activity_24h: n(enrichQueue), needs_human: 0,
      headline: n(enrichQueue) > 0
        ? `${n(enrichQueue)} enrichment job${n(enrichQueue) === 1 ? '' : 's'} queued`
        : 'Spine clean — no enrichment backlog',
    },
    {
      manager: 'listing_concierge', label: MANAGERS.listing_concierge.label,
      activity_24h: n(activeListings), needs_human: 0,
      headline: `${n(activeListings)} listing${n(activeListings) === 1 ? '' : 's'} in active marketing stages`,
    },
    {
      manager: 'asset_manager', label: MANAGERS.asset_manager.label,
      activity_24h: n(rendersDone), needs_human: 0,
      headline: `${n(rendersDone)} video render${n(rendersDone) === 1 ? '' : 's'} completed in 24h`,
    },
    {
      manager: 'shopping_agent', label: MANAGERS.shopping_agent.label,
      activity_24h: n(matches24h), needs_human: 0,
      headline: `${n(matches24h)} buyer property match${n(matches24h) === 1 ? '' : 'es'} generated in 24h`,
    },
  ]
  // Only report managers with something to say (quiet managers don't add noise).
  return lines.filter((l) => l.activity_24h > 0 || l.needs_human > 0)
}
