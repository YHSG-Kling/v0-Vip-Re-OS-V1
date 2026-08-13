import { redirect } from 'next/navigation'
import { resolveIsaCallingReadiness } from "@/lib/voice/isa-readiness"
import { createClient } from '@/lib/supabase/server'
import {
  listISACampaigns,
  getQualificationOutcomes,
  getGhostRecoveryQueue,
  getEngagementFeed,
} from '@/app/actions/ai-isa'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Phone,
  Megaphone,
  TrendingUp,
  PhoneCall,
  CheckCircle2,
  Radio,
  Brain,
  Ghost,
  ShieldAlert,
  Users,
  MessageSquare,
  UserCheck,
  AlertTriangle,
  Mic,
  ChevronDown,
  ChevronRight,
  Clock,
  Zap,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import Link from 'next/link'
import {
  QualificationRadar,
  ConversationIntelligencePanel,
  PositiveRespondersPanel,
  HardStopsPanel,
  GhostRecoveryPanel,
  RetrainingSignalsPanel,
} from './components/qualification-os'
import { HandoffQueuePanel } from '@/app/dashboard/voice/isa/handoff-queue-panel'
import { AIISAConsoleClient } from './ai-isa-console-client'
import { SpeedToLeadPanel } from './components/speed-to-lead-panel'
import { ISALeadQueuePanel } from './components/isa-lead-queue-panel'
import { getSpeedToLeadMetrics } from '@/app/actions/ai-isa/speed-to-lead-metrics'
import { ensureAgentContextInPlace } from "@/lib/identity/ensure-agent-context"

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'AI-ISA Operations Console | VIP Real Estate AI OS',
  description: 'Monitor, guide, and escalate AI lead qualification and follow-up',
}

export default async function AIISAOperationsConsolePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')


  // Self-healing identity: provision a missing brokerage/agents row IN PLACE before
  // reading the profile, so an incomplete account renders this page instead of being
  // bounced away (the "bounce" class in the live walkthrough). The redirect below now
  // only fires for an account that genuinely cannot self-provision — a pending
  // brokerage invite, or a staff user whose brokerage comes from their org.
  await ensureAgentContextInPlace()
  const { data: profile } = await supabase
    .from('users')
    .select('brokerage_id, first_name, user_type')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-muted-foreground text-sm">
        No brokerage associated with your account.
      </div>
    )
  }

  const brokerageId = profile.brokerage_id

  // Role-based agent filter: agent sees own calls; broker/admin sees all brokerage calls
  const isAgentOnly = profile?.user_type === 'agent'

  // RAW LEAD ACCESS. app/actions/leads.ts gates every export on this exact set —
  // agents are deliberately NOT in it, because agents work CONTACTS and lead
  // visibility is role-gated. The ISA queue tab is only mounted for a role whose
  // calls the server will actually honour, so nobody is shown a control that can
  // only refuse. The server-side gate remains the real one.
  const canWorkRawLeads = ['admin', 'broker', 'broker_admin', 'superadmin', 'isa']
    .includes(profile?.user_type ?? '')
  const { data: agentRow } = isAgentOnly
    ? await supabase.from('agents').select('id').eq('user_id', user.id).maybeSingle()
    : { data: null }

  // ── NEW: AI-ISA Operations Console queries ────────────────────────────────
  // Fetch leads currently owned by AI-ISA with qualification + channel truth data
  const leadsQuery = supabase
    .from('leads')
    .select(`
      id, first_name, last_name, email, phone, source,
      contact_id, agent_id, call_stop_flag, mailing_address_verified,
      mailing_address, tcpa_consent, sms_opt_out, phone_opt_out, email_opt_out,
      direct_mail_opt_out, lifecycle_state, lead_stage, updated_at, created_at,
      ai_isa_owner, ai_outreach_paused,
      ai_isa_qualifications!lead_id(
        id, qualification_score, qualification_result, stage,
        qualified_at, assigned_at, assigned_to_agent_id, last_outreach_at
      )
    `)
    .eq('brokerage_id', brokerageId)
    .order('updated_at', { ascending: false })
    .limit(50)

  if (isAgentOnly && agentRow?.id) {
    leadsQuery.eq('agent_id', agentRow.id)
  }

  // Fetch pending AI message drafts in AI-ISA scope
  const draftsQuery = supabase
    .from('ai_message_drafts')
    .select(`
      id, channel, draft_subject, draft_body, context_summary,
      confidence_score, status, created_at, contact_id,
      contacts!contact_id( first_name, last_name )
    `)
    .eq('brokerage_id', brokerageId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(20)

  const [leadsResult, draftsResult, speedToLeadMetrics] = await Promise.all([
    leadsQuery,
    draftsQuery,
    getSpeedToLeadMetrics(brokerageId),
  ])

  const leads = (leadsResult.data ?? []) as any[]
  const rawDrafts = (draftsResult.data ?? []) as any[]

  // Enrich draft records with contact name
  const pendingDrafts = rawDrafts.map((d: any) => ({
    ...d,
    contact_name: d.contacts
      ? `${d.contacts.first_name ?? ''} ${d.contacts.last_name ?? ''}`.trim() || null
      : null,
  }))

  // Augment leads with call_analyses via voice_calls grouped by contact_id
  // We fetch voice_calls with analyses for all contacts from this lead set
  const contactIds = leads.map((l: any) => l.contact_id).filter(Boolean)
  let callAnalysesByContact: Record<string, any[]> = {}

  if (contactIds.length > 0) {
    const { data: vcData } = await supabase
      .from('voice_calls')
      .select(`
        contact_id,
        call_analyses( sentiment, intent_primary, urgency_score, suggested_next_action )
      `)
      .in('contact_id', contactIds)
      .eq('call_type', 'ai_isa_call')
      .order('started_at', { ascending: false })
      .limit(100)

    for (const vc of vcData ?? []) {
      if (!vc.contact_id || !vc.call_analyses?.length) continue
      if (!callAnalysesByContact[vc.contact_id]) {
        callAnalysesByContact[vc.contact_id] = []
      }
      callAnalysesByContact[vc.contact_id].push(...vc.call_analyses)
    }
  }

  // Merge call_analyses into lead records
  const records = leads.map((lead: any) => ({
    ...lead,
    call_analyses: lead.contact_id ? (callAnalysesByContact[lead.contact_id] ?? []) : [],
  }))

  // Fetch all data in parallel
  const [campaignResult, qualResult, ghostResult, engagementResult, handoffResult, voiceCallsResult] = await Promise.all([
    listISACampaigns(brokerageId),
    getQualificationOutcomes(brokerageId),
    getGhostRecoveryQueue(brokerageId),
    getEngagementFeed({ brokerageId, limit: 100 }),
    // Voice calls with transcripts + analyses — brokerage scoped, agent filtered if agent role
    (() => {
      let q = supabase
        .from('voice_calls')
        .select(`
          id,
          vendor_call_id,
          contact_id,
          agent_id,
          direction,
          status,
          started_at,
          ended_at,
          duration_seconds,
          summary,
          sentiment,
          outcome,
          recording_url,
          ai_notes,
          contacts ( id, first_name, last_name, phone ),
          call_transcriptions ( full_text, speaker_turns, word_count ),
          call_analyses ( sentiment, objections, next_steps, intent_primary, intent_secondary, urgency_score, suggested_next_action )
        `)
        .eq('brokerage_id', brokerageId)
        .eq('call_type', 'ai_isa_call')
        .order('started_at', { ascending: false })
        .limit(50)
      if (isAgentOnly && agentRow?.id) {
        q = q.eq('agent_id', agentRow.id)
      }
      return q
    })(),

    // Fetch handoff queue - qualified contacts ready for agent
    supabase
      .from('ai_isa_qualifications')
      .select(`
        id,
        contact_id,
        qualification_score,
        qualification_result,
        notes,
        qualified_at,
        contacts (
          id,
          first_name,
          last_name,
          phone,
          buyer_stage
        )
      `)
      .eq('brokerage_id', brokerageId)
      .eq('qualification_result', 'qualified')
      .order('qualified_at', { ascending: false })
      .limit(20),
  ])

  const campaigns = campaignResult?.campaigns || []
  const qualOutcomes = qualResult || { outcomes: [], stats: { qualified: 0, not_qualified: 0, appointment_set: 0, no_response: 0, needs_follow_up: 0 }, chartData: [] }
  const ghosts = ghostResult?.ghosts || []
  const engagements = engagementResult?.items || []
  const voiceCalls = (voiceCallsResult?.data || []) as any[]
  const handoffQueue = (handoffResult?.data || []) as any[]

  const activeCampaigns = campaigns.filter((c: any) => c.status === 'active')

  // CAN THIS BROKERAGE ACTUALLY PLACE AN AI CALL? This probed
  // VAPI_ISA_ASSISTANT_ID + VAPI_API_KEY — env vars for a vendor the voice lane
  // retired, which placeOutboundAiCall never reads. One answer, from the gates
  // the executor really enforces: lib/voice/isa-readiness.ts.
  const callingReadiness = await resolveIsaCallingReadiness(supabase, brokerageId)

  // Calculate Qualification Radar metrics from real data
  const totalContacted = qualOutcomes.outcomes?.length || 0
  const qualified = qualOutcomes.stats?.qualified || 0
  const noResponse = qualOutcomes.stats?.no_response || 0
  const needsFollowUp = qualOutcomes.stats?.needs_follow_up || 0

  // Derive positive responders from engagement feed
  const positiveResponders = engagements.filter((e: any) =>
    ['replied', 'clicked', 'opened'].includes(e.event_type)
  )

  // Build conversation intelligence from qualification signals
  const conversationIntelligence = qualOutcomes.outcomes
    ?.filter((o: any) => o.qualification_signals && o.qualification_signals.length > 0)
    .slice(0, 10)
    .map((o: any) => {
      const signals = o.qualification_signals || []
      return {
        id: o.id,
        contactId: o.contact_id,
        contactName: `${o.contact_first_name || ''} ${o.contact_last_name || ''}`.trim() || 'Unknown',
        transcriptSummary: o.notes || 'No summary available',
        topObjections: signals.filter((s: any) => s.type === 'objection').map((s: any) => s.text || s.value).slice(0, 3),
        motivationSignals: signals.filter((s: any) => s.type === 'motivation').map((s: any) => s.text || s.value).slice(0, 3),
        urgencyClues: signals.filter((s: any) => s.type === 'urgency' || s.type === 'timeline').map((s: any) => s.text || s.value).slice(0, 2),
        financingClues: signals.filter((s: any) => s.type === 'financing' || s.type === 'budget').map((s: any) => s.text || s.value).slice(0, 2),
        sentiment: o.score && o.score >= 70 ? 'positive' : o.score && o.score < 40 ? 'negative' : 'neutral',
        confidenceScore: o.score || 50,
        recommendedNextAction: o.qualification_result === 'qualified'
          ? 'Ready for agent handoff'
          : o.qualification_result === 'needs_follow_up'
            ? 'Schedule follow-up touchpoint'
            : 'Continue AI nurturing',
        createdAt: o.created_at,
      }
    }) || []

  // Build positive responders data
  const positiveRespondersData = positiveResponders.slice(0, 15).map((e: any) => ({
    id: e.id,
    contactId: e.contact_id,
    contactName: `${e.contact_first_name || ''} ${e.contact_last_name || ''}`.trim() || 'Unknown',
    phone: null,
    engagementReason: `${e.event_type} via ${e.channel}`,
    engagementScore: e.event_type === 'replied' ? 90 : e.event_type === 'clicked' ? 70 : 50,
    lastEngagedAt: e.created_at,
    isReadyForHandoff: e.event_type === 'replied',
    aiOwned: e.event_type !== 'replied',
    qualificationResult: null,
  }))

  // Build hard stops from qualifications with blocking signals
  const hardStops = qualOutcomes.outcomes
    ?.filter((o: any) => o.qualification_result === 'not_qualified')
    .slice(0, 10)
    .map((o: any) => {
      const signals = o.qualification_signals || []
      const blockingSignal = signals.find((s: any) =>
        ['compliance', 'duplicate', 'blocked', 'cooldown'].includes(s.type)
      )
      return {
        id: o.id,
        contactId: o.contact_id,
        contactName: `${o.contact_first_name || ''} ${o.contact_last_name || ''}`.trim() || 'Unknown',
        reason: (blockingSignal?.type as any) || 'insufficient_qualification',
        reasonDetail: o.notes || 'Did not meet qualification criteria',
        blockedSince: o.created_at,
        canRetryAt: null,
      }
    }) || []

  // Build retraining signals from qualification patterns
  const retrainingSignals = qualOutcomes.outcomes
    ?.flatMap((o: any) => {
      const signals = o.qualification_signals || []
      return signals
        .filter((s: any) => s.type === 'objection' || s.type === 'coaching')
        .map((s: any, idx: number) => ({
          id: `${o.id}-${idx}`,
          signalType: s.type === 'objection' ? 'failed_objection' : 'coaching_insight',
          title: s.text || s.value || 'Signal detected',
          description: s.context || 'Extracted from conversation analysis',
          frequency: 1,
          impactScore: s.confidence || 50,
          suggestedImprovement: s.suggestion || null,
          createdAt: o.created_at,
        }))
    })
    .slice(0, 10) || []

  // Radar metrics
  const radarMetrics = {
    newLeadsUnderAI: activeCampaigns.reduce((sum: number, c: any) => sum + (c.leads_targeted || 0), 0) - totalContacted,
    activelyNurturing: needsFollowUp,
    positiveResponders: positiveResponders.length,
    qualifiedHandoffReady: qualified,
    stalled: noResponse,
    blockedByHardStop: hardStops.length,
    waitingRetry: ghosts.length,
  }

  return (
    <div className="p-6 space-y-6">
      {/* Section 1 — Page Identity */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Brain className="w-6 h-6 text-indigo-600" />
            AI-ISA Operations Console
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Monitor, guide, and escalate AI lead qualification and follow-up
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/dashboard/voice/isa">
            <Button variant="outline" size="sm">
              <Phone className="w-4 h-4 mr-2" />
              Voice ISA
            </Button>
          </Link>
          <Link href="/dashboard/isa/calling">
            <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white">
              <PhoneCall className="w-4 h-4 mr-2" />
              Start Calling
            </Button>
          </Link>
        </div>
      </div>

      {/* Speed-to-Lead — automatic first-touch SLA + who is still waiting */}
      <SpeedToLeadPanel metrics={speedToLeadMetrics} />

      {/* AI-ISA Operations Console — Sections 2-9 */}
      <AIISAConsoleClient
        records={records}
        pendingDrafts={pendingDrafts}
        userId={user.id}
        brokerageId={brokerageId}
        callingReady={callingReadiness.canPlaceAiCalls}
        callingBlockedReason={callingReadiness.reason}
      />

      {/* Shown only when AI calling genuinely cannot run, naming the one thing
          the agent has to do — not a retired vendor's integration page. */}
      {!callingReadiness.canPlaceAiCalls && (
        <Alert className="border-amber-300 bg-amber-50 text-amber-900 [&>svg]:text-amber-600">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>AI calling isn&apos;t ready yet</AlertTitle>
          <AlertDescription>
            {callingReadiness.reason}{' '}
            {callingReadiness.ctaHref && (
              <Link href={callingReadiness.ctaHref} className="underline font-medium ml-1">
                {callingReadiness.ctaLabel} →
              </Link>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* Qualification Radar - Full Width */}
      <QualificationRadar {...radarMetrics} />

      {/* Main Tabs */}
      <Tabs defaultValue="handoff" className="w-full">
        <TabsList className={`grid w-full grid-cols-4 ${canWorkRawLeads ? 'md:grid-cols-9' : 'md:grid-cols-8'} h-auto`}>
          <TabsTrigger value="handoff" className="flex items-center gap-1.5 text-xs py-2">
            <UserCheck className="h-3.5 w-3.5" />
            Handoff Queue
          </TabsTrigger>
          {canWorkRawLeads && (
            <TabsTrigger value="lead-queue" className="flex items-center gap-1.5 text-xs py-2">
              <Users className="h-3.5 w-3.5" />
              ISA Queue
            </TabsTrigger>
          )}
          <TabsTrigger value="voice-calls" className="flex items-center gap-1.5 text-xs py-2">
            <Mic className="h-3.5 w-3.5" />
            Voice Calls
            {voiceCalls.length > 0 && (
              <span className="ml-1 rounded-full bg-indigo-100 text-indigo-700 text-[10px] px-1.5 font-medium">
                {voiceCalls.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="intelligence" className="flex items-center gap-1.5 text-xs py-2">
            <MessageSquare className="h-3.5 w-3.5" />
            Intelligence
          </TabsTrigger>
          <TabsTrigger value="responders" className="flex items-center gap-1.5 text-xs py-2">
            <Users className="h-3.5 w-3.5" />
            Responders
          </TabsTrigger>
          <TabsTrigger value="ghosts" className="flex items-center gap-1.5 text-xs py-2">
            <Ghost className="h-3.5 w-3.5" />
            Ghost Recovery
          </TabsTrigger>
          <TabsTrigger value="hardstops" className="flex items-center gap-1.5 text-xs py-2">
            <ShieldAlert className="h-3.5 w-3.5" />
            Hard Stops
          </TabsTrigger>
          <TabsTrigger value="retraining" className="flex items-center gap-1.5 text-xs py-2">
            <Brain className="h-3.5 w-3.5" />
            Retraining
          </TabsTrigger>
          <TabsTrigger value="campaigns" className="flex items-center gap-1.5 text-xs py-2">
            <Megaphone className="h-3.5 w-3.5" />
            Campaigns
          </TabsTrigger>
        </TabsList>

        {/* Handoff Queue Tab - Qualified leads ready for agent */}
        <TabsContent value="handoff" className="mt-4">
          {/* `user.id` is a `users.id`, which is what every column the panel
              writes actually FKs — this caller was already passing the right
              VALUE under a prop name that claimed otherwise. Only the name
              changed here; the sibling console at /dashboard/voice/isa was the
              one passing an `agents.id`. */}
          <HandoffQueuePanel
            queue={handoffQueue}
            brokerageId={brokerageId}
            assignedToUserId={user.id}
          />
        </TabsContent>

        {/* ISA Queue Tab — the raw lead queue behind everything else on this
            console: qualify, start/pause AI outreach, hand to a human agent,
            and read the per-lead outreach history. Broker/admin/ISA only. */}
        {canWorkRawLeads && (
          <TabsContent value="lead-queue" className="mt-4">
            <ISALeadQueuePanel />
          </TabsContent>
        )}

        {/* Voice Calls Tab — transcripts, intent, suggestions */}
        <TabsContent value="voice-calls" className="mt-4">
          <div className="space-y-3">
            {/* Summary row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                {
                  label: 'Total Calls',
                  value: voiceCalls.length,
                  icon: Phone,
                  color: 'text-indigo-600',
                },
                {
                  label: 'Completed',
                  value: voiceCalls.filter((c: any) => c.status === 'completed').length,
                  icon: CheckCircle2,
                  color: 'text-green-600',
                },
                {
                  label: 'Avg Duration',
                  value: voiceCalls.length
                    ? `${Math.round(voiceCalls.reduce((s: number, c: any) => s + (c.duration_seconds ?? 0), 0) / voiceCalls.length)}s`
                    : '—',
                  icon: Clock,
                  color: 'text-blue-600',
                },
                {
                  label: 'High Urgency',
                  value: voiceCalls.filter((c: any) =>
                    (c.call_analyses?.[0]?.urgency_score ?? 0) >= 70
                  ).length,
                  icon: Zap,
                  color: 'text-amber-600',
                },
              ].map((stat) => (
                <Card key={stat.label}>
                  <CardContent className="p-3 flex items-center gap-3">
                    <stat.icon className={`w-7 h-7 ${stat.color}`} />
                    <div>
                      <p className="text-xl font-bold leading-tight">{stat.value}</p>
                      <p className="text-xs text-muted-foreground">{stat.label}</p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Call list */}
            {voiceCalls.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Mic className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground">No AI voice calls recorded yet.</p>
                  {!callingReadiness.canPlaceAiCalls && callingReadiness.ctaHref && (
                    <Link href={callingReadiness.ctaHref} className="text-xs text-indigo-600 underline mt-1 block">
                      {callingReadiness.ctaLabel} to enable AI calling
                    </Link>
                  )}
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-3">
                {voiceCalls.map((call: any) => {
                  const analysis = call.call_analyses?.[0]
                  const transcript = call.call_transcriptions?.[0]
                  const contact = call.contacts
                  const contactName = contact
                    ? `${contact.first_name ?? ''} ${contact.last_name ?? ''}`.trim() || 'Unknown Contact'
                    : 'Unknown Contact'
                  const durationMin = call.duration_seconds
                    ? `${Math.floor(call.duration_seconds / 60)}m ${call.duration_seconds % 60}s`
                    : '—'
                  const sentimentColor =
                    call.sentiment === 'positive' ? 'text-green-700 bg-green-50 border-green-200' :
                    call.sentiment === 'negative' ? 'text-red-700 bg-red-50 border-red-200' :
                    'text-slate-700 bg-slate-50 border-slate-200'
                  const urgency = analysis?.urgency_score ?? 0

                  return (
                    <Card key={call.id} className="overflow-hidden">
                      <CardHeader className="pb-2 px-4 pt-3">
                        <div className="flex items-start justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2">
                            <Phone className="w-4 h-4 text-indigo-500 shrink-0" />
                            <span className="font-semibold text-sm">{contactName}</span>
                            {contact?.phone && (
                              <span className="text-xs text-muted-foreground">{contact.phone}</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant="outline" className={`text-xs ${sentimentColor}`}>
                              {call.sentiment ?? 'neutral'}
                            </Badge>
                            <Badge variant="outline" className="text-xs">
                              <Clock className="w-3 h-3 mr-1" />
                              {durationMin}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {call.started_at
                                ? new Date(call.started_at).toLocaleString()
                                : ''}
                            </span>
                          </div>
                        </div>
                      </CardHeader>
                      <CardContent className="px-4 pb-4 space-y-3">
                        {/* Intent + urgency row */}
                        {analysis && (
                          <div className="grid md:grid-cols-3 gap-3">
                            <div className="rounded-lg bg-indigo-50 border border-indigo-200 p-2.5">
                              <p className="text-[10px] font-semibold uppercase tracking-wide text-indigo-500 mb-0.5">Primary Intent</p>
                              <p className="text-sm font-medium text-indigo-900 capitalize">
                                {(analysis.intent_primary ?? 'unknown').replace(/_/g, ' ')}
                              </p>
                              {analysis.intent_secondary && (
                                <p className="text-xs text-indigo-600 capitalize">
                                  Also: {analysis.intent_secondary.replace(/_/g, ' ')}
                                </p>
                              )}
                            </div>
                            <div className="rounded-lg bg-amber-50 border border-amber-200 p-2.5">
                              <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-500 mb-1">Urgency Score</p>
                              <div className="flex items-center gap-2">
                                <Progress value={urgency} className="h-1.5 flex-1" />
                                <span className="text-xs font-bold text-amber-800">{urgency}%</span>
                              </div>
                            </div>
                            <div className="rounded-lg bg-green-50 border border-green-200 p-2.5">
                              <p className="text-[10px] font-semibold uppercase tracking-wide text-green-500 mb-0.5">Suggested Action</p>
                              <p className="text-sm font-medium text-green-900 capitalize">
                                {(analysis.suggested_next_action ?? 'continue_nurturing').replace(/_/g, ' ')}
                              </p>
                            </div>
                          </div>
                        )}

                        {/* Summary */}
                        {call.summary && (
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Summary</p>
                            <p className="text-sm text-foreground leading-relaxed">{call.summary}</p>
                          </div>
                        )}

                        {/* Objections + next steps */}
                        {analysis && (
                          <div className="grid md:grid-cols-2 gap-3">
                            {analysis.objections?.length > 0 && (
                              <div>
                                <p className="text-[10px] font-semibold uppercase tracking-wide text-red-500 mb-1">Objections</p>
                                <ul className="space-y-1">
                                  {analysis.objections.slice(0, 3).map((o: string, i: number) => (
                                    <li key={i} className="text-xs text-red-800 bg-red-50 rounded px-2 py-1">{o}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {analysis.next_steps?.length > 0 && (
                              <div>
                                <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-500 mb-1">Next Steps</p>
                                <ul className="space-y-1">
                                  {analysis.next_steps.slice(0, 3).map((s: string, i: number) => (
                                    <li key={i} className="text-xs text-blue-800 bg-blue-50 rounded px-2 py-1">{s}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Transcript */}
                        {transcript?.full_text && (
                          <details className="group">
                            <summary className="cursor-pointer flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground list-none">
                              <ChevronRight className="w-3.5 h-3.5 group-open:rotate-90 transition-transform" />
                              Full Transcript
                              {transcript.word_count && (
                                <span className="text-[10px] text-muted-foreground ml-1">({transcript.word_count} words)</span>
                              )}
                            </summary>
                            <ScrollArea className="h-48 mt-2 rounded border bg-slate-50 p-3">
                              {/* Speaker turns if available */}
                              {Array.isArray(transcript.speaker_turns) && transcript.speaker_turns.length > 0 ? (
                                <div className="space-y-2">
                                  {transcript.speaker_turns.map((turn: any, i: number) => (
                                    <div key={i} className={`flex gap-2 ${turn.role === 'assistant' ? 'flex-row' : 'flex-row-reverse'}`}>
                                      <span className={`text-[10px] font-bold shrink-0 mt-0.5 uppercase ${turn.role === 'assistant' ? 'text-indigo-500' : 'text-slate-500'}`}>
                                        {turn.role === 'assistant' ? 'AI' : 'Lead'}
                                      </span>
                                      <p className={`text-xs leading-relaxed rounded-lg px-2.5 py-1.5 max-w-[85%] ${turn.role === 'assistant' ? 'bg-indigo-100 text-indigo-900' : 'bg-white border text-slate-800'}`}>
                                        {turn.text}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">{transcript.full_text}</p>
                              )}
                            </ScrollArea>
                          </details>
                        )}

                        {/* Recording link */}
                        {call.recording_url && (
                          <a
                            href={call.recording_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-xs text-indigo-600 hover:underline"
                          >
                            <Mic className="w-3 h-3" />
                            Listen to Recording
                          </a>
                        )}
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            )}
          </div>
        </TabsContent>

        {/* Conversation Intelligence Tab */}
        <TabsContent value="intelligence" className="mt-4">
          <ConversationIntelligencePanel conversations={conversationIntelligence as any} />
        </TabsContent>

        {/* Positive Responders Tab */}
        <TabsContent value="responders" className="mt-4">
          <PositiveRespondersPanel responders={positiveRespondersData} />
        </TabsContent>

        {/* Ghost Recovery Tab */}
        <TabsContent value="ghosts" className="mt-4">
          <GhostRecoveryPanel ghosts={ghosts as any} brokerageId={brokerageId} />
        </TabsContent>

        {/* Hard Stops Tab */}
        <TabsContent value="hardstops" className="mt-4">
          <HardStopsPanel hardStops={hardStops} />
        </TabsContent>

        {/* Retraining Signals Tab */}
        <TabsContent value="retraining" className="mt-4">
          <RetrainingSignalsPanel signals={retrainingSignals} />
        </TabsContent>

        {/* Campaigns Tab */}
        <TabsContent value="campaigns" className="mt-4 space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { label: 'Active Campaigns', value: activeCampaigns.length, icon: Megaphone, color: 'text-blue-600' },
              { label: 'Total Contacted', value: totalContacted, icon: Phone, color: 'text-purple-600' },
              { label: 'Qualified Leads', value: qualified, icon: CheckCircle2, color: 'text-green-600' },
              { label: 'Conversion Rate', value: totalContacted > 0 ? `${Math.round((qualified / totalContacted) * 100)}%` : '0%', icon: TrendingUp, color: 'text-orange-600' },
            ].map((stat) => (
              <Card key={stat.label}>
                <CardContent className="p-4 flex items-center gap-3">
                  <stat.icon className={`w-8 h-8 ${stat.color}`} />
                  <div>
                    <p className="text-2xl font-bold">{stat.value}</p>
                    <p className="text-xs text-muted-foreground">{stat.label}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader><CardTitle className="text-base">Active Campaigns ({activeCampaigns.length})</CardTitle></CardHeader>
              <CardContent>
                {activeCampaigns.length === 0 ? (
                  <div className="text-center py-4">
                    <p className="text-sm text-muted-foreground mb-3">No active campaigns</p>
                    <Link href="/dashboard/isa/campaigns">
                      <Button size="sm" variant="outline">Create Campaign</Button>
                    </Link>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {activeCampaigns.slice(0, 5).map((c: any) => (
                      <div key={c.id} className="flex items-center justify-between p-2 bg-blue-50 rounded-lg">
                        <div>
                          <p className="text-sm font-medium">{c.name}</p>
                          <p className="text-xs text-muted-foreground">{c.campaign_type}</p>
                        </div>
                        <Badge className="bg-blue-100 text-blue-700 border-blue-200">Active</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Quick Navigation</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 gap-2">
                {[
                  { label: 'Calling Queue', href: '/dashboard/isa/calling' },
                  { label: 'All Campaigns', href: '/dashboard/isa/campaigns' },
                  { label: 'Calendar OS', href: '/dashboard/isa/calendar' },
                  { label: 'Analytics', href: '/dashboard/isa/analytics' },
                  { label: 'Lead Intelligence', href: '/leads' },
                  { label: 'Voice ISA', href: '/dashboard/voice/isa' },
                ].map((a) => (
                  <Link key={a.href} href={a.href}>
                    <Button variant="outline" size="sm" className="w-full">{a.label}</Button>
                  </Link>
                ))}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
