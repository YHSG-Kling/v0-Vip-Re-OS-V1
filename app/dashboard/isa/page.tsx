import { redirect } from 'next/navigation'
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
} from 'lucide-react'
import Link from 'next/link'
import {
  QualificationRadar,
  ConversationIntelligencePanel,
  PositiveRespondersPanel,
  HardStopsPanel,
  GhostRecoveryPanel,
  RetrainingSignalsPanel,
} from './components/qualification-os'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Qualification OS | VIP Real Estate AI OS',
  description: 'AI-powered lead qualification command center',
}

export default async function QualificationOSPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('users')
    .select('brokerage_id, first_name')
    .eq('id', user.id)
    .single()

  if (!profile?.brokerage_id) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-muted-foreground text-sm">
        No brokerage associated with your account.
      </div>
    )
  }

  const brokerageId = profile.brokerage_id

  // Fetch all data in parallel
  const [campaignResult, qualResult, ghostResult, engagementResult] = await Promise.all([
    listISACampaigns(brokerageId),
    getQualificationOutcomes(brokerageId),
    getGhostRecoveryQueue(brokerageId),
    getEngagementFeed({ brokerageId, limit: 100 }),
  ])

  const campaigns = campaignResult?.campaigns || []
  const qualOutcomes = qualResult || { outcomes: [], stats: { qualified: 0, not_qualified: 0, appointment_set: 0, no_response: 0, needs_follow_up: 0 }, chartData: [] }
  const ghosts = ghostResult?.ghosts || []
  const engagements = engagementResult?.items || []

  const activeCampaigns = campaigns.filter((c: any) => c.status === 'active')

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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Radio className="w-6 h-6 text-indigo-600" />
            Qualification OS
          </h1>
          <p className="text-muted-foreground text-sm">
            AI-powered lead qualification command center - autonomous first owner of all raw leads
          </p>
        </div>
        <div className="flex items-center gap-2">
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

      {/* Qualification Radar - Full Width */}
      <QualificationRadar {...radarMetrics} />

      {/* Main Tabs */}
      <Tabs defaultValue="intelligence" className="w-full">
        <TabsList className="grid w-full grid-cols-2 md:grid-cols-6 h-auto">
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

        {/* Conversation Intelligence Tab */}
        <TabsContent value="intelligence" className="mt-4">
          <ConversationIntelligencePanel conversations={conversationIntelligence} />
        </TabsContent>

        {/* Positive Responders Tab */}
        <TabsContent value="responders" className="mt-4">
          <PositiveRespondersPanel responders={positiveRespondersData} />
        </TabsContent>

        {/* Ghost Recovery Tab */}
        <TabsContent value="ghosts" className="mt-4">
          <GhostRecoveryPanel ghosts={ghosts} brokerageId={brokerageId} />
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
