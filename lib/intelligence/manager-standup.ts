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
import { loadRecentReaperActivity } from '@/lib/intelligence/reaper-net'
import { summarizeManagerTouches, type ManagerTouchSummary } from '@/lib/intelligence/manager-touch-provenance'

/** RECEIPTS — what a manager actually SENT in the window, from the shared touch
 *  ledger's provenance columns (manager-touch-provenance.ts). The standup's other
 *  fields are counts; this is the evidence behind them. */
export interface ManagerStandupTouches {
  /** Touches this manager sent in the window. */
  count: number
  /** Distinct channels they went out on. */
  channels: string[]
  /** Distinct ai_intents behind them — the "why did my client get this?" half. */
  intents: string[]
  /** How many of those touches were driven by a canonical sequence. */
  sequenceCount: number
}

export interface ManagerStandupLine {
  manager: ManagerKey
  label: string
  /** What the manager did in the last 24h (count of governed actions). */
  activity_24h: number
  /** Items waiting on a HUMAN decision right now. */
  needs_human: number
  /** Stuck items the manager's REAPER caught & escalated in 24h (autonomy receipt). */
  reaped_24h: number
  /** One broker-readable line. */
  headline: string
  /** RECEIPTS for the sends behind the counts. ABSENT — never zeroed — when the
   *  manager sent nothing in the window OR when the provenance read was refused
   *  (§3: "nobody could check" must never render as "checked, and it was zero"). */
  touches?: ManagerStandupTouches
}

export async function generateManagerStandup(brokerageId: string, client?: ReturnType<typeof createServiceClient>): Promise<ManagerStandupLine[]> {
  const supabase = client ?? createServiceClient()
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const [handoffs, hotIsa, proposedMsgs, enrichQueue, activeListings, rendersDone, matches24h,
         dealTasks, adsProposed, mktProposed, sphereProposed, recruitProposed,
         closedDeals24h, complianceOpenSignals] =
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
        .eq('brokerage_id', brokerageId).eq('render_status', 'succeeded').gte('completed_at', since),
      supabase.from('property_matches').select('id', { count: 'exact', head: true })
        .eq('brokerage_id', brokerageId).gte('created_at', since),
      // Deal Coordinator — transaction tasks advanced in 24h (workload actually moving).
      supabase.from('transaction_tasks').select('id', { count: 'exact', head: true })
        .eq('brokerage_id', brokerageId).gte('updated_at', since),
      // Ads Manager — paid-campaign actions awaiting a human's spend approval.
      supabase.from('ad_manager_actions').select('id', { count: 'exact', head: true })
        .eq('brokerage_id', brokerageId).eq('status', 'proposed'),
      // Marketing Manager — brand/content actions awaiting approval.
      supabase.from('marketing_agent_actions').select('id', { count: 'exact', head: true })
        .eq('brokerage_id', brokerageId).eq('status', 'proposed'),
      // Sphere Manager — repeat/referral touches proposed (attributed by agent_kind).
      supabase.from('agent_client_messages').select('id', { count: 'exact', head: true })
        .eq('brokerage_id', brokerageId).eq('agent_kind', 'sphere_of_influence').eq('status', 'proposed'),
      // Recruiting Manager — candidate outreach drafts proposed.
      supabase.from('agent_client_messages').select('id', { count: 'exact', head: true })
        .eq('brokerage_id', brokerageId).eq('agent_kind', 'recruiting_manager').eq('status', 'proposed'),
      // Finance Manager — deals that CLOSED in 24h (commission-bearing events to reconcile).
      supabase.from('transactions').select('id', { count: 'exact', head: true })
        .eq('brokerage_id', brokerageId).eq('status', 'closed').gte('close_date', since.slice(0, 10)),
      // Compliance Officer — open compliance items routed on the bus awaiting handling.
      supabase.from('manager_signals').select('id', { count: 'exact', head: true })
        .eq('brokerage_id', brokerageId).eq('to_manager', 'compliance_officer').eq('status', 'open'),
    ])

  const n = (r: { count: number | null }) => r.count ?? 0
  const baseLines: Omit<ManagerStandupLine, 'reaped_24h'>[] = [
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
    {
      manager: 'deal_coordinator', label: MANAGERS.deal_coordinator.label,
      activity_24h: n(dealTasks), needs_human: 0,
      headline: `${n(dealTasks)} transaction task${n(dealTasks) === 1 ? '' : 's'} advanced in 24h`,
    },
    {
      manager: 'ads_manager', label: MANAGERS.ads_manager.label,
      activity_24h: n(adsProposed), needs_human: n(adsProposed),
      headline: n(adsProposed) > 0
        ? `${n(adsProposed)} ad action${n(adsProposed) === 1 ? '' : 's'} proposed — awaiting your spend approval`
        : 'No ad spend awaiting approval',
    },
    {
      manager: 'marketing_agent', label: MANAGERS.marketing_agent.label,
      activity_24h: n(mktProposed), needs_human: n(mktProposed),
      headline: n(mktProposed) > 0
        ? `${n(mktProposed)} marketing action${n(mktProposed) === 1 ? '' : 's'} proposed — awaiting your approval`
        : 'No marketing actions awaiting approval',
    },
    {
      manager: 'sphere_of_influence', label: MANAGERS.sphere_of_influence.label,
      activity_24h: n(sphereProposed), needs_human: n(sphereProposed),
      headline: n(sphereProposed) > 0
        ? `${n(sphereProposed)} repeat/referral touch${n(sphereProposed) === 1 ? '' : 'es'} proposed — awaiting your approval`
        : 'No sphere touches awaiting approval',
    },
    {
      manager: 'recruiting_manager', label: MANAGERS.recruiting_manager.label,
      activity_24h: n(recruitProposed), needs_human: n(recruitProposed),
      headline: n(recruitProposed) > 0
        ? `${n(recruitProposed)} recruiting draft${n(recruitProposed) === 1 ? '' : 's'} ready to send`
        : 'No recruiting drafts pending',
    },
    {
      manager: 'finance_manager', label: MANAGERS.finance_manager.label,
      activity_24h: n(closedDeals24h), needs_human: 0,
      headline: n(closedDeals24h) > 0
        ? `${n(closedDeals24h)} deal${n(closedDeals24h) === 1 ? '' : 's'} closed in 24h — commissions to reconcile`
        : 'No closings in 24h',
    },
    {
      manager: 'compliance_officer', label: MANAGERS.compliance_officer.label,
      activity_24h: n(complianceOpenSignals), needs_human: n(complianceOpenSignals),
      headline: n(complianceOpenSignals) > 0
        ? `${n(complianceOpenSignals)} compliance item${n(complianceOpenSignals) === 1 ? '' : 's'} awaiting review`
        : 'No open compliance items',
    },
  ]

  // Overlay the REAPER NET's 24h activity from the ledger: each manager's line gains
  // a "your AI team caught N stuck item(s)" receipt, and escalations count as needs_human.
  //
  // Overlay 2 — TOUCH PROVENANCE: the same 24h window, read off the shared touch ledger's
  // provenance columns, so the line shows RECEIPTS ("3 touches on email, sms — a warm
  // re-engagement") and not only counts. Key is metadata.manager, stamped by
  // lib/campaign-sequences/touchpoint-bridge.ts:99 via touchpointManagerForChannel — whose
  // whole value set (ai_isa, marketing_agent, asset_manager, campaign_orchestrator, and the
  // campaign_orchestrator default) is a SUBSET of ManagerKey, so this map cannot silently
  // miss (§6). Touches with no manager aggregate to 'unattributed', which matches no
  // ManagerKey and is therefore dropped rather than mis-credited to a manager.
  const [reaperActivity, touchSummaries] = await Promise.all([
    loadRecentReaperActivity(brokerageId, 24, supabase),
    summarizeManagerTouches(supabase, brokerageId, 1),
  ])
  // null = the provenance read was REFUSED (§3). Leave EVERY line without touches; do not
  // render an unreadable ledger as "this manager sent nothing".
  const touchByManager = new Map<string, ManagerTouchSummary>(
    (touchSummaries ?? []).map((s) => [s.manager, s]),
  )

  const lines: ManagerStandupLine[] = baseLines.map((l) => {
    const ra = reaperActivity[l.manager]
    const reaped_24h = ra ? ra.escalated + ra.reaped : 0
    let headline = l.headline
    if (ra && (ra.escalated > 0 || ra.reaped > 0)) {
      headline += ` · AI caught ${ra.escalated + ra.reaped} stuck item${ra.escalated + ra.reaped === 1 ? '' : 's'}`
    }
    const ts = touchByManager.get(l.manager)
    const touches: ManagerStandupTouches | undefined = ts && ts.touchCount > 0
      ? { count: ts.touchCount, channels: ts.channels, intents: ts.sampleIntents, sequenceCount: ts.sequenceTouchCount }
      : undefined
    if (touches) {
      headline += ` · sent ${touches.count} touch${touches.count === 1 ? '' : 'es'}`
        + (touches.channels.length > 0 ? ` on ${touches.channels.join(', ')}` : '')
    }
    return { ...l, reaped_24h, needs_human: l.needs_human + (ra?.escalated ?? 0), headline, ...(touches ? { touches } : {}) }
  })

  // Only report managers with something to say (quiet managers don't add noise). A manager
  // whose only 24h output is SENT TOUCHES has something to say — that is the receipt this
  // overlay exists to surface — so touches qualify a line alongside activity/needs/reaped.
  return lines.filter((l) => l.activity_24h > 0 || l.needs_human > 0 || l.reaped_24h > 0 || (l.touches?.count ?? 0) > 0)
}
