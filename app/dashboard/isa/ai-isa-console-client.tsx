'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { acceptAIISAHandoff } from '@/app/actions/ai-isa/accept-handoff'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Progress } from '@/components/ui/progress'
import {
  CheckCircle,
  AlertTriangle,
  ShieldOff,
  Clock,
  Mail,
  MailOpen,
  Phone,
  PhoneCall,
  MessageSquare,
  Home,
  Layers,
  Pause,
  Play,
  RefreshCw,
  UserCheck,
  ChevronRight,
  Brain,
  Radio,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ──────────────────────────────────────────────────────────────
// AI-ISA State Derivation (canonical per spec)
// ──────────────────────────────────────────────────────────────

type AIISAState =
  | 'ai_active'
  | 'ai_nurturing'
  | 'awaiting_approval'
  | 'handoff_ready'
  | 'agent_handoff_required'
  | 'compliance_hold'
  | 'handoff_complete'

function deriveAIISAState(record: any): AIISAState {
  const analysis      = record.call_analyses?.[0]
  const qualification = record.ai_isa_qualifications?.[0]
  const hasContact    = !!record.contact_id
  const hasAssignedAgent = !!record.agent_id
  const callStop      = !!record.call_stop_flag
  const urgency       = analysis?.urgency_score ?? 0
  const suggested     = analysis?.suggested_next_action ?? null
  const qualStage     = qualification?.stage ?? null
  const qualResult    = qualification?.qualification_result ?? null

  if (callStop)                                     return 'compliance_hold'
  if (hasContact && hasAssignedAgent)               return 'handoff_complete'
  if (suggested === 'escalate_to_human')            return 'agent_handoff_required'
  if (urgency >= 80)                                return 'agent_handoff_required'
  if (qualStage === 'qualified' || qualResult === 'qualified') return 'handoff_ready'
  if (qualStage === 'awaiting_review' || qualResult === 'pending') return 'awaiting_approval'
  if (qualStage === 'nurturing' || qualResult === 'needs_follow_up') return 'ai_nurturing'
  if (qualStage === 'contacting' || qualResult === 'in_progress') return 'ai_active'
  return 'ai_active'
}

// ──────────────────────────────────────────────────────────────
// AIISAStateBadge component
// ──────────────────────────────────────────────────────────────

const STATE_BADGE_MAP: Record<AIISAState, { label: string; className: string }> = {
  ai_active:              { label: 'AI Active',              className: 'bg-blue-100 text-blue-800 border-blue-200' },
  ai_nurturing:           { label: 'AI Nurturing',           className: 'bg-indigo-100 text-indigo-800 border-indigo-200' },
  awaiting_approval:      { label: 'Awaiting Approval',      className: 'bg-amber-100 text-amber-800 border-amber-200' },
  handoff_ready:          { label: 'Handoff Ready',          className: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
  agent_handoff_required: { label: 'Human Handoff Required',  className: 'bg-red-100 text-red-800 border-red-200' },
  compliance_hold:        { label: 'Compliance Hold',        className: 'bg-gray-100 text-gray-700 border-gray-300' },
  handoff_complete:       { label: 'Handoff Complete',       className: 'bg-green-100 text-green-800 border-green-200' },
}

function AIISAStateBadge({ state }: { state: AIISAState }) {
  const { label, className } = STATE_BADGE_MAP[state]
  return (
    <Badge variant="outline" className={cn('text-xs font-medium', className)}>
      {label}
    </Badge>
  )
}

// ──────────────────────────────────────────────────────────────
// Channel Truth chips
// ──────────────────────────────────────────────────────────────

function ChannelChip({ label, available, blocked }: { label: string; available: boolean; blocked?: boolean }) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold border',
      blocked  ? 'bg-red-50 text-red-600 border-red-200 line-through' :
      available ? 'bg-green-50 text-green-700 border-green-200' :
                  'bg-gray-50 text-gray-400 border-gray-200'
    )}>
      {label}
    </span>
  )
}

function ChannelTruth({ record }: { record: any }) {
  const hasContact   = !!record.contact_id
  const hasEmail     = !!record.email
  const hasMailAddr  = !!record.mailing_address_verified
  const smsBlocked   = !!record.sms_opt_out || !!record.call_stop_flag
  const phoneBlocked = !!record.phone_opt_out || !!record.call_stop_flag

  return (
    <div className="flex flex-wrap gap-1 mt-2">
      <ChannelChip label="Email"       available={hasEmail}   blocked={!!record.email_opt_out} />
      <ChannelChip label="Direct Mail" available={hasMailAddr} blocked={false} />
      <ChannelChip label="SMS"         available={hasContact} blocked={!hasContact || smsBlocked} />
      <ChannelChip label="Phone"       available={hasContact} blocked={!hasContact || phoneBlocked} />
      <ChannelChip label="Portal"      available={hasContact} blocked={!hasContact} />
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Main client component
// ──────────────────────────────────────────────────────────────

interface AIISAConsoleClientProps {
  records: any[]
  pendingDrafts: any[]
  userId: string
  brokerageId: string
  vapiConfigured?: boolean
}

const TAB_FILTERS: { label: string; value: string; states: AIISAState[] | 'all' }[] = [
  { label: 'All',                    value: 'all',              states: 'all' },
  { label: 'AI Active',              value: 'ai_active',        states: ['ai_active', 'ai_nurturing'] },
  { label: 'Handoff Ready',          value: 'handoff_ready',    states: ['handoff_ready'] },
  { label: 'Human Handoff Required', value: 'takeover',         states: ['agent_handoff_required'] },
  { label: 'Awaiting Approval',      value: 'approval',         states: ['awaiting_approval'] },
  { label: 'Compliance Hold',        value: 'compliance',       states: ['compliance_hold'] },
  { label: 'Completed',              value: 'completed',        states: ['handoff_complete'] },
]

export function AIISAConsoleClient({ records, pendingDrafts, userId, brokerageId, vapiConfigured = false }: AIISAConsoleClientProps) {
  const router = useRouter()
  const supabase = createClient()
  const [activeTab, setActiveTab] = useState('all')
  const [isPending, startTransition] = useTransition()

  // ── Priority queue derivation ──────────────────────────────
  const aiisaPriorityQueue = useMemo(() => {
    return records
      .map((record: any) => {
        const analysis      = record.call_analyses?.[0]
        const qualification = record.ai_isa_qualifications?.[0]
        const urgency       = analysis?.urgency_score ?? qualification?.qualification_score ?? 0
        const intent        = analysis?.intent_primary ?? 'unknown'
        const state         = deriveAIISAState(record)
        const lastTouchAt   =
          qualification?.last_outreach_at ??
          record.updated_at ??
          record.created_at

        let priorityBoost = 0
        if (state === 'agent_handoff_required') priorityBoost += 100
        if (state === 'handoff_ready')          priorityBoost += 80
        if (state === 'awaiting_approval')      priorityBoost += 60
        if (state === 'compliance_hold')        priorityBoost += 40
        if (['ready_to_buy','ready_to_list','price_inquiry','timeline_now'].includes(intent)) priorityBoost += 30

        return {
          ...record,
          aiisa_state:   state,
          urgency_score: urgency,
          intent_primary: intent,
          last_touch_at: lastTouchAt,
          priority_score: urgency + priorityBoost,
        }
      })
      .sort((a: any, b: any) => b.priority_score - a.priority_score)
      .slice(0, 12)
  }, [records])

  // ── Blocker stats ──────────────────────────────────────────
  const blockerStats = useMemo(() => ({
    active:               records.filter(r => ['ai_active','ai_nurturing'].includes(deriveAIISAState(r))).length,
    handoffReady:         records.filter(r => deriveAIISAState(r) === 'handoff_ready').length,
    agentTakeover:        records.filter(r => deriveAIISAState(r) === 'agent_handoff_required').length,
    awaitingApproval:     records.filter(r => deriveAIISAState(r) === 'awaiting_approval').length,
    complianceHolds:      records.filter(r => deriveAIISAState(r) === 'compliance_hold').length,
    missingEmail:         records.filter(r => !r.email).length,
    missingVerifiedMail:  records.filter(r => !r.contact_id && !r.mailing_address_verified).length,
    unassignedQualified:  records.filter(r => deriveAIISAState(r) === 'handoff_ready' && !r.agent_id).length,
  }), [records])

  // ── Tab-filtered queue ─────────────────────────────────────
  const tabQueue = useMemo(() => {
    const tab = TAB_FILTERS.find(t => t.value === activeTab)
    if (!tab || tab.states === 'all') return aiisaPriorityQueue
    return aiisaPriorityQueue.filter(r => (tab.states as AIISAState[]).includes(r.aiisa_state))
  }, [aiisaPriorityQueue, activeTab])

  // ── Tab counts ─────────────────────────────────────────────
  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const tab of TAB_FILTERS) {
      if (tab.states === 'all') {
        counts[tab.value] = aiisaPriorityQueue.length
      } else {
        counts[tab.value] = aiisaPriorityQueue.filter(r =>
          (tab.states as AIISAState[]).includes(r.aiisa_state)
        ).length
      }
    }
    return counts
  }, [aiisaPriorityQueue])

  // ── Actions ────────────────────────────────────────────────
  async function handlePauseAI(leadId: string) {
    const { error } = await supabase
      .from('leads')
      .update({ ai_outreach_paused: true, updated_at: new Date().toISOString() })
      .eq('id', leadId)
    if (error) { toast.error('Failed to pause AI'); return }
    toast.success('AI-ISA paused for this record')
    router.refresh()
  }

  async function handleResumeAI(leadId: string) {
    const { error } = await supabase
      .from('leads')
      .update({ ai_outreach_paused: false, updated_at: new Date().toISOString() })
      .eq('id', leadId)
    if (error) { toast.error('Failed to resume AI'); return }
    toast.success('AI-ISA resumed')
    router.refresh()
  }

  async function handleForceReassess(leadId: string) {
    try {
      const { evaluateLeadQualification } = await import('@/lib/ai-isa/qualification-evaluator')
      await evaluateLeadQualification(leadId)
      toast.success('AI-ISA is reassessing this lead')
      router.refresh()
    } catch {
      toast.error('Failed to trigger reassessment')
    }
  }

  function handleAcceptHandoff(record: any) {
    if (record.contact_id) {
      toast.success('Opening assigned contact')
      router.push(`/crm?contact=${record.contact_id}`)
      return
    }

    startTransition(async () => {
      const result = await acceptAIISAHandoff({
        leadId: record.id,
        brokerageId,
        actorUserId: userId,
      })
      if (result.success && result.contactId) {
        toast.success('Handoff accepted — contact created')
        router.push(`/crm?contact=${result.contactId}`)
      } else {
        toast.error(result.error ?? 'Failed to accept handoff')
      }
    })
  }

  async function handleEscalate(record: any) {
    const { error } = await supabase.from('notifications').insert({
      brokerage_id: brokerageId,
      user_id: userId,
      type: 'ai_escalation_required',
      title: `AI-ISA escalation required for ${record.first_name ?? ''} ${record.last_name ?? ''}`.trim(),
      body: 'Review this record immediately — AI-ISA cannot resolve without human intervention.',
      entity_type: record.contact_id ? 'contact' : 'lead',
      entity_id: record.contact_id ?? record.id,
      is_read: false,
      priority: 'high',
      created_at: new Date().toISOString(),
    })
    if (error) { toast.error('Failed to create escalation notice'); return }
    toast.success('Escalation notice sent to broker/admin')
  }

  async function handleComplianceHold(leadId: string, hold: boolean) {
    const { error } = await supabase
      .from('leads')
      .update({ call_stop_flag: hold, updated_at: new Date().toISOString() })
      .eq('id', leadId)
    if (error) { toast.error('Failed to update compliance hold'); return }
    toast.success(hold ? 'Compliance hold applied' : 'Compliance hold removed')
    router.refresh()
  }

  // ── Send AI Email Now ──────────────────────────────────────
  async function handleSendEmailNow(record: any) {
    if (!record.email) { toast.error('No email address on this record'); return }
    try {
      const { initiateAIISAEngagement } = await import('@/app/actions/ai-isa/initiate-engagement')
      await initiateAIISAEngagement(record.id, { forceChannel: 'email' })
      toast.success('AI email queued for immediate send')
      router.refresh()
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to send email')
    }
  }

  // ── Send Direct Mail Now ───────────────────────────────────
  async function handleSendDirectMail(record: any) {
    if (!record.mailing_address && !record.address) {
      toast.error('No mailing address on this record')
      return
    }
    try {
      const { initiateAIISAEngagement } = await import('@/app/actions/ai-isa/initiate-engagement')
      await initiateAIISAEngagement(record.id, { forceChannel: 'direct_mail' })
      toast.success('Direct mail piece queued for dispatch')
      router.refresh()
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to queue direct mail')
    }
  }

  // ── AI Call Now ───────────────────────��────────────────────
  async function handleAICallNow(record: any) {
    const phone = record.phone
    if (!phone) { toast.error('No phone number on this record'); return }
    try {
      const res = await fetch('/api/voice/initiate-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: phone,
          contactId: record.contact_id ?? undefined,
          leadId: record.id,
          agentId: userId,
          brokerageId,
          callPurpose: 'isa_qualification',
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (data.vapiNotConfigured) {
          toast.error('Configure VAPI to enable AI calling', {
            description: 'Go to Settings → AI-ISA to add your VAPI assistant ID.',
            action: { label: 'Configure', onClick: () => router.push('/settings?tab=ai-isa') },
          })
        } else if (data.blocked) {
          toast.error(`Call blocked: ${data.reason}`)
        } else {
          toast.error(data.error ?? 'Failed to initiate call')
        }
        return
      }
      toast.success(`AI call initiated — Call ID: ${data.callId}`)
      router.refresh()
    } catch {
      toast.error('Network error initiating AI call')
    }
  }

  // ── Draft actions ──────────────────────────────────────────
  async function approveDraft(draftId: string) {
    const { error } = await supabase
      .from('ai_message_drafts')
      .update({ status: 'approved', acted_at: new Date().toISOString() })
      .eq('id', draftId)
    if (error) { toast.error('Failed to approve draft'); return }
    toast.success('Draft approved for sending')
    router.refresh()
  }

  async function dismissDraft(draftId: string) {
    const { error } = await supabase
      .from('ai_message_drafts')
      .update({ status: 'dismissed', acted_at: new Date().toISOString() })
      .eq('id', draftId)
    if (error) { toast.error('Failed to dismiss draft'); return }
    toast.success('Draft dismissed')
    router.refresh()
  }

  function editDraft(draftId: string) {
    router.push(`/dashboard/communications/inbox?draftId=${draftId}`)
  }

  // ──────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────

  const urgentCount = blockerStats.handoffReady + blockerStats.agentTakeover + blockerStats.awaitingApproval + blockerStats.complianceHolds

  return (
    <div className="space-y-6">

      {/* AI-ISA Status Strip — named 3-state banner (spec requirement) */}
      <div className="flex flex-col sm:flex-row gap-2 rounded-lg border bg-muted/30 p-3">
        {/* State 1: AI-ISA Active */}
        <div className={cn(
          'flex-1 flex items-center gap-2.5 rounded-md px-3 py-2 border',
          blockerStats.active > 0
            ? 'bg-blue-50 border-blue-200 text-blue-800'
            : 'bg-background border-border text-muted-foreground',
        )}>
          <Radio className={cn('h-4 w-4 shrink-0', blockerStats.active > 0 && 'animate-pulse')} />
          <div>
            <p className="text-xs font-semibold">AI-ISA Active</p>
            <p className="text-xs">{blockerStats.active} record{blockerStats.active !== 1 ? 's' : ''} under AI management</p>
          </div>
        </div>

        {/* State 2: AI-ISA Paused */}
        {(() => {
          const pausedCount = records.filter((r: any) => r.ai_outreach_paused).length
          return (
            <div className={cn(
              'flex-1 flex items-center gap-2.5 rounded-md px-3 py-2 border',
              pausedCount > 0
                ? 'bg-orange-50 border-orange-200 text-orange-800'
                : 'bg-background border-border text-muted-foreground',
            )}>
              <Pause className="h-4 w-4 shrink-0" />
              <div>
                <p className="text-xs font-semibold">AI-ISA Paused</p>
                <p className="text-xs">{pausedCount} record{pausedCount !== 1 ? 's' : ''} with outreach paused</p>
              </div>
            </div>
          )
        })()}

        {/* State 3: Human Handoff Required */}
        <div className={cn(
          'flex-1 flex items-center gap-2.5 rounded-md px-3 py-2 border',
          blockerStats.agentTakeover > 0
            ? 'bg-red-50 border-red-200 text-red-800'
            : 'bg-background border-border text-muted-foreground',
        )}>
          <AlertTriangle className={cn('h-4 w-4 shrink-0', blockerStats.agentTakeover > 0 && 'text-red-600')} />
          <div>
            <p className="text-xs font-semibold">Human Handoff Required</p>
            <p className="text-xs">{blockerStats.agentTakeover} record{blockerStats.agentTakeover !== 1 ? 's' : ''} need immediate attention</p>
          </div>
        </div>
      </div>

      {/* KPI strip — Section 7 */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        {[
          { label: 'AI Managed',       value: records.length,                        color: 'text-indigo-600' },
          { label: 'Handoff Ready',    value: blockerStats.handoffReady,             color: 'text-yellow-600' },
          { label: 'Agent Takeover',   value: blockerStats.agentTakeover,            color: 'text-red-600' },
          { label: 'Comp. Holds',      value: blockerStats.complianceHolds,          color: 'text-gray-500' },
          { label: 'No Email',         value: blockerStats.missingEmail,             color: 'text-orange-600' },
          { label: 'No Mailing Addr',  value: blockerStats.missingVerifiedMail,      color: 'text-orange-600' },
          { label: 'Unassigned Qual.', value: blockerStats.unassignedQualified,      color: 'text-red-500' },
          { label: 'Pending Drafts',   value: pendingDrafts.length,                  color: 'text-amber-600' },
        ].map(stat => (
          <Card key={stat.label} className="shadow-none">
            <CardContent className="p-3 text-center">
              <p className={cn('text-2xl font-bold leading-tight', stat.color)}>{stat.value}</p>
              <p className="text-[10px] text-muted-foreground leading-tight mt-0.5">{stat.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* AI Draft Approval Surface — Section 6 */}
      {pendingDrafts.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Brain className="h-4 w-4 text-amber-600" />
              AI Drafts Waiting Approval
              <Badge variant="outline" className="ml-auto bg-amber-100 text-amber-700 border-amber-300">
                {pendingDrafts.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingDrafts.map((draft: any) => (
              <div key={draft.id} className="rounded-lg border border-amber-200 bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{draft.contact_name ?? 'Lead draft'}</p>
                    <p className="text-xs text-muted-foreground capitalize">{draft.channel}</p>
                  </div>
                  <Badge variant="outline" className="text-[10px] shrink-0">Pending approval</Badge>
                </div>
                {draft.draft_subject && (
                  <p className="text-xs font-medium mt-2">{draft.draft_subject}</p>
                )}
                <p className="text-sm mt-1 line-clamp-3 text-foreground">{draft.draft_body}</p>
                <div className="flex gap-2 mt-3">
                  <Button size="sm" onClick={() => approveDraft(draft.id)}>Send</Button>
                  <Button size="sm" variant="outline" onClick={() => editDraft(draft.id)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => dismissDraft(draft.id)}>Dismiss</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Priority Queue with supervision tabs — Sections 3 & 4 */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-base font-semibold">AI-ISA Priority Queue</h2>
            <p className="text-xs text-muted-foreground">
              Highest-priority records the AI-ISA is actively managing or escalating
            </p>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="h-auto flex-wrap gap-1 bg-transparent p-0 mb-4">
            {TAB_FILTERS.map(tab => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="text-xs h-8 data-[state=active]:bg-foreground data-[state=active]:text-background"
              >
                {tab.label}
                {tabCounts[tab.value] > 0 && (
                  <span className="ml-1.5 rounded-full bg-muted text-muted-foreground text-[10px] px-1.5 font-medium">
                    {tabCounts[tab.value]}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value={activeTab} className="mt-0 space-y-3">
            {tabQueue.length === 0 ? (
              /* Empty state — Section 9 */
              <div className="text-center py-16">
                <CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-3" />
                <p className="font-semibold">AI-ISA is running smoothly</p>
                <p className="text-sm text-muted-foreground">
                  No escalations, handoffs, or compliance issues need attention right now.
                </p>
              </div>
            ) : (
              tabQueue.map((item: any) => (
                <Card
                  key={item.id}
                  className={cn(
                    'border transition-colors',
                    item.aiisa_state === 'agent_handoff_required' && 'border-red-300 bg-red-50',
                    item.aiisa_state === 'handoff_ready'          && 'border-yellow-300 bg-yellow-50',
                    item.aiisa_state === 'awaiting_approval'      && 'border-amber-300 bg-amber-50',
                    item.aiisa_state === 'compliance_hold'        && 'border-gray-300 bg-gray-50',
                    item.aiisa_state === 'handoff_complete'       && 'border-green-300 bg-green-50',
                    (item.aiisa_state === 'ai_active' || item.aiisa_state === 'ai_nurturing') && 'border-indigo-200 bg-indigo-50',
                  )}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        {/* Name + state badges */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium text-sm">
                            {item.first_name} {item.last_name}
                          </p>
                          <AIISAStateBadge state={item.aiisa_state} />
                          {item.intent_primary && item.intent_primary !== 'unknown' && (
                            <Badge variant="outline" className="text-xs capitalize">
                              {item.intent_primary.replace(/_/g, ' ')}
                            </Badge>
                          )}
                          {item.ai_outreach_paused && (
                            <Badge variant="outline" className="text-xs bg-orange-50 text-orange-700 border-orange-200">
                              Paused
                            </Badge>
                          )}
                        </div>

                        {/* Meta row */}
                        <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                          <span>Urgency: {item.urgency_score}/100</span>
                          <span>Source: {item.source ?? 'unknown'}</span>
                          <span>
                            Last AI touch:{' '}
                            {item.last_touch_at
                              ? formatDistanceToNow(new Date(item.last_touch_at), { addSuffix: true })
                              : 'never'}
                          </span>
                        </div>

                        {/* Urgency bar */}
                        {item.urgency_score > 0 && (
                          <Progress
                            value={item.urgency_score}
                            className="h-1 mt-2 max-w-[200px]"
                          />
                        )}

                        {/* Suggested next action */}
                        {item.call_analyses?.[0]?.suggested_next_action && (
                          <p className="text-xs font-medium text-indigo-700 mt-2 flex items-center gap-1">
                            <ChevronRight className="h-3 w-3 shrink-0" />
                            {item.call_analyses[0].suggested_next_action.replace(/_/g, ' ')}
                          </p>
                        )}

                        {/* Escalation reason box */}
                        {item.aiisa_state === 'agent_handoff_required' && (
                          <div className="mt-2 rounded border border-red-200 bg-red-100 p-2">
                            <p className="text-xs font-medium text-red-800">AI-ISA escalation reason</p>
                            <p className="text-xs text-red-700 mt-0.5">
                              {item.call_analyses?.[0]?.sentiment === 'negative' ? 'Negative sentiment detected. ' : ''}
                              {item.urgency_score >= 80 ? 'High urgency detected. ' : ''}
                              {item.call_analyses?.[0]?.suggested_next_action
                                ? item.call_analyses[0].suggested_next_action.replace(/_/g, ' ')
                                : 'Human follow-up recommended.'}
                            </p>
                          </div>
                        )}

                        {/* Compliance hold notice */}
                        {item.aiisa_state === 'compliance_hold' && (
                          <div className="mt-2 rounded border border-gray-300 bg-white p-2">
                            <p className="text-xs text-gray-700">
                              Outreach restricted due to compliance settings or channel restrictions.
                            </p>
                          </div>
                        )}

                        {/* Channel Truth panel — Section 8 */}
                        <ChannelTruth record={item} />
                      </div>

                      {/* Action rail */}
                      <div className="flex flex-col gap-1.5 shrink-0 min-w-[158px]">

                        {/* Primary: open full CRM record */}
                        <Button size="sm" variant="default" className="w-full justify-start" asChild>
                          <Link href={`/crm?contact=${item.contact_id ?? ''}&leadId=${item.contact_id ? '' : item.id}`}>
                            Open Record
                          </Link>
                        </Button>

                        {/* AI Call Now — triggers VAPI outbound via /api/voice/initiate-call */}
                        {item.phone && !item.call_stop_flag && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full justify-start text-green-700 border-green-300 hover:bg-green-50"
                            onClick={() => handleAICallNow(item)}
                          >
                            <PhoneCall className="h-3.5 w-3.5 mr-1.5" />
                            AI Call Now
                          </Button>
                        )}

                        {/* Send AI Email Now — force immediate email dispatch */}
                        {item.email && !item.email_opt_out && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full justify-start text-blue-700 border-blue-300 hover:bg-blue-50"
                            onClick={() => handleSendEmailNow(item)}
                          >
                            <Mail className="h-3.5 w-3.5 mr-1.5" />
                            Send Email Now
                          </Button>
                        )}

                        {/* Send Direct Mail Now — force direct mail dispatch */}
                        {(item.mailing_address || item.address) && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full justify-start text-purple-700 border-purple-300 hover:bg-purple-50"
                            onClick={() => handleSendDirectMail(item)}
                          >
                            <MailOpen className="h-3.5 w-3.5 mr-1.5" />
                            Send Direct Mail
                          </Button>
                        )}

                        {/* Hand Off to Human Agent — handoff_ready, agent_handoff_required, awaiting_approval */}
                        {(
                          item.aiisa_state === 'handoff_ready' ||
                          item.aiisa_state === 'agent_handoff_required' ||
                          item.aiisa_state === 'awaiting_approval'
                        ) && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="w-full justify-start"
                            onClick={() => handleAcceptHandoff(item)}
                            disabled={isPending}
                          >
                            <UserCheck className="h-3.5 w-3.5 mr-1.5" />
                            Hand Off to Human Agent
                          </Button>
                        )}

                        {/* Pause AI-ISA — only when actively running */}
                        {(item.aiisa_state === 'ai_active' || item.aiisa_state === 'ai_nurturing') && !item.ai_outreach_paused && (
                          <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => handlePauseAI(item.id)}>
                            <Pause className="h-3.5 w-3.5 mr-1.5" />
                            Pause AI-ISA
                          </Button>
                        )}

                        {/* Resume AI-ISA — only when paused */}
                        {item.ai_outreach_paused && (
                          <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => handleResumeAI(item.id)}>
                            <Play className="h-3.5 w-3.5 mr-1.5" />
                            Resume AI-ISA
                          </Button>
                        )}

                        {/* Force Reassess — re-run qualification evaluation */}
                        <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => handleForceReassess(item.id)}>
                          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                          Force Reassess
                        </Button>

                        {/* View Call History — shortcut to CRM calls tab */}
                        <Button size="sm" variant="ghost" className="w-full justify-start text-muted-foreground" asChild>
                          <Link href={`/crm?contact=${item.contact_id ?? ''}&leadId=${item.contact_id ? '' : item.id}&tab=calls`}>
                            <Phone className="h-3.5 w-3.5 mr-1.5" />
                            View Call History
                          </Link>
                        </Button>

                        {/* Escalate — sends urgent notification to broker/admin */}
                        {item.aiisa_state !== 'handoff_complete' && (
                          <Button size="sm" variant="ghost" className="w-full justify-start text-orange-600 hover:text-orange-700" onClick={() => handleEscalate(item)}>
                            <AlertTriangle className="h-3.5 w-3.5 mr-1.5" />
                            Escalate
                          </Button>
                        )}

                        {/* Compliance Hold toggle */}
                        {item.aiisa_state === 'compliance_hold' ? (
                          <Button size="sm" variant="ghost" className="w-full justify-start text-green-700" onClick={() => handleComplianceHold(item.id, false)}>
                            <CheckCircle className="h-3.5 w-3.5 mr-1.5" />
                            Remove Hold
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" className="w-full justify-start text-muted-foreground" onClick={() => handleComplianceHold(item.id, true)}>
                            <ShieldOff className="h-3.5 w-3.5 mr-1.5" />
                            Compliance Hold
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}
