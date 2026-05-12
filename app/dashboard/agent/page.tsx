"use client"

import { useEffect, useState, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
// Actions
import { getAgentStats } from "@/app/actions/agents"
import { generateDailyGameplan } from "@/app/actions/copilot"
import { getTodaysBriefing, generateBriefing, getUpcomingShowings, getActiveTransactions, getUserTypeBrief } from "@/app/actions/briefing-actions"
import { TodaysFocusCard } from "@/app/components/shell/todays-focus-card"
import type { UserTypeBrief } from "@/lib/intelligence/user-type-briefs"
import { getUpcomingAnniversaries } from "@/app/actions/lifetime-customers"
import { getCommissionRecords, getExpenses } from "@/app/actions/ai-financial-management"
import { getHotLeads } from "@/app/actions/ai-auto-response"
import { getMotivatedSellers } from "@/app/actions/lead-intelligence"
import { getRecentLifeChanges } from "@/app/actions/contact-enrichment"
import { initiateWhisperBridge, triggerVapiVoiceBot } from "@/app/actions/voice-call-bridge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"
import ReactMarkdown from "react-markdown"
// Components
import { AgentCommandStrip } from "./components/agent-command-strip"
import { AgentOperatingRadar } from "./components/agent-operating-radar"
import { AgentHotLeadsPanel } from "./components/agent-hot-leads-panel"
import { AgentNextBestActions } from "./components/agent-next-best-actions"
import { AgentDealIntelligence } from "./components/agent-deal-intelligence"
import { AgentLifetimeCustomersPanel } from "./components/agent-lifetime-customers-panel"
import { AgentSuperpowersPanel } from "./components/agent-superpowers-panel"
import { WeeklyPlanWidget } from "./components/weekly-plan-widget"
import { LicenseComplianceWidget } from "./components/license-compliance-widget"
import { AgentFinancialIntelligence } from "./components/agent-financial-intelligence"
import { AgentSystemReadiness } from "./components/agent-system-readiness"
import { ThisWeekPreview } from "@/app/dashboard/calendar/components/os"
import { NewlyConvertedContactsPanel } from "./components/conversion"
import { VoiceAssistantPanel } from "@/app/components/ai-copilot"
import { PredictiveListingCard } from "./components/predictive-listing-card"
import { getTopPredictiveSellers, listQueuedAutoTouches, type PredictiveSellerRow } from "@/app/actions/predictive-listing"
import { DealRiskWidget } from "./components/deal-risk-widget"
import { getAgentAtRiskTransactions, type AgentDealRisk } from "@/app/actions/deal-risk-agent"
import { ListingRiskWidget } from "./components/listing-risk-widget"
import { getAgentAtRiskListings, type AgentListingRisk } from "@/app/actions/listing-risk-agent"
import { ApprovalsBanner } from "@/components/ApprovalsBanner"
import { MarketInsightWidget } from "@/app/components/dashboard/market-insight-widget"
import { SmarterWidget } from "@/app/components/dashboard/smarter-widget/smarter-widget"
import { SphereResonanceCard } from "@/app/components/heartbeat/sphere-resonance-card"
import { WealthAdvisorCard } from "@/app/components/heartbeat/wealth-advisor-card"
import { SmartQueue } from "@/app/components/heartbeat/smart-queue"
import AgentInsightsWidget from "@/app/dashboard/agent/components/agent-insights-widget"
import PresentationReadyBanner from "@/app/dashboard/agent/components/presentation-ready-banner"

export default function AgentDashboard() {
  const [loading, setLoading] = useState(true)
  const [agentName, setAgentName] = useState("Agent")
  const [agentId, setAgentId] = useState("")
  const [brokerageId, setBrokerageId] = useState("")
  const [stats, setStats] = useState({
    activeTransactions: 0,
    pendingGCI: 0,
    ytdGCI: 0,
    contactCount: 0,
    leadsToday: 0,
    pendingTasks: 0,
    upcomingShowings: 0
  })
  const [briefing, setBriefing] = useState<any>(null)
  const [userTypeBrief, setUserTypeBrief] = useState<UserTypeBrief | null>(null)
  const [briefRefreshing, setBriefRefreshing] = useState(false)
  const [showings, setShowings] = useState<any[]>([])
  const [transactions, setTransactions] = useState<any[]>([])
  const [anniversaries, setAnniversaries] = useState<any[]>([])
  const [lifeChanges, setLifeChanges] = useState<any[]>([])
  const [commissions, setCommissions] = useState<any[]>([])
  const [monthlyExpenses, setMonthlyExpenses] = useState<any[]>([])
  const [hotLeads, setHotLeads] = useState<any[]>([])
  const [predictedSellers, setPredictedSellers] = useState<PredictiveSellerRow[]>([])
  const [queuedAutoTouches, setQueuedAutoTouches] = useState<Array<{
    id: string
    contactId: string
    contactName: string
    channel: string | null
    scheduledSendAt: string | null
    triggeringPlsScore: number | null
    triggeringSignals: Array<{ key: string; label: string }> | null
  }>>([])
  const [userId, setUserId] = useState("")
  const [atRiskTxns, setAtRiskTxns] = useState<AgentDealRisk[]>([])
  const [atRiskListings, setAtRiskListings] = useState<AgentListingRisk[]>([])
  const [actionPlans, setActionPlans] = useState<any[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [callingId, setCallingId] = useState<string | null>(null)
  const [motivatedSellers, setMotivatedSellers] = useState<any[]>([])
  const [gameplan, setGameplan] = useState<any>(null)
  const [gameplanLoading, setGameplanLoading] = useState(false)

  useEffect(() => {
    const loadData = async () => {
      try {
        // 1. Get authenticated user
        const supabase = createClient()
        const { data: { user } } = await supabase.auth.getUser()
        
        if (!user) {
          setLoading(false)
          return
        }

        // 2. Get user profile
        const { data: profile } = await supabase
          .from("users")
          .select("first_name, last_name")
          .eq("id", user.id)
          .maybeSingle()

        if (profile?.first_name) {
          setAgentName(profile.first_name)
        }

        // 3. Get agent row
        const { data: agentRow } = await supabase
          .from("agents")
          .select("id, brokerage_id")
          .eq("user_id", user.id)
          .maybeSingle()

        if (agentRow) {
          setAgentId(agentRow.id)
          setBrokerageId(agentRow.brokerage_id)
          setUserId(user.id)

          // Predictive Listing Score — top 5 likely sellers + queued auto-touches
          getTopPredictiveSellers({
            agentId: agentRow.id,
            brokerageId: agentRow.brokerage_id,
            limit: 5,
          })
            .then(setPredictedSellers)
            .catch(() => setPredictedSellers([]))

          listQueuedAutoTouches({
            agentId: agentRow.id,
            brokerageId: agentRow.brokerage_id,
          })
            .then(setQueuedAutoTouches)
            .catch(() => setQueuedAutoTouches([]))

          // Deal Risk Radar — at-risk + critical transactions for this agent
          getAgentAtRiskTransactions({
            agentId: agentRow.id,
            brokerageId: agentRow.brokerage_id,
            limit: 5,
          })
            .then(setAtRiskTxns)
            .catch(() => setAtRiskTxns([]))

          // Listing Risk Radar — at-risk + critical active listings for this agent
          getAgentAtRiskListings({
            agentId: agentRow.id,
            brokerageId: agentRow.brokerage_id,
            limit: 5,
          })
            .then(setAtRiskListings)
            .catch(() => setAtRiskListings([]))
        }

        // 4. Calculate month start
        const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
          .toISOString().split('T')[0]

        // 5. Load action plans from activities table
        const { data: plans } = await supabase
          .from("activities")
          .select("id, title, description, priority, contact_id")
          .eq("agent_id", agentRow?.id)
          .eq("activity_type", "agent_action_plan")
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(5)

        setActionPlans(plans || [])

        // 6. Load all data in parallel
        const results = await Promise.allSettled([
          getAgentStats(user.id),
          getTodaysBriefing(),
          getUpcomingShowings(),
          getActiveTransactions(),
          getUpcomingAnniversaries(),
          getCommissionRecords({ status: 'pending' }),
          getExpenses({ startDate: monthStart }),
          getHotLeads(10),
          getRecentLifeChanges(agentRow?.id, 7).catch(() => []),
          getMotivatedSellers({ min_score: 60 }).catch(() => null),
          getUserTypeBrief({ userType: "agent" }),
        ])

        // 7. Unpack results
        if (results[0].status === 'fulfilled' && results[0].value) {
          const agentStats = results[0].value
          setStats(prev => ({
            ...prev,
            activeTransactions: agentStats.activeDeals || 0,
            pendingGCI: agentStats.pendingGCI || 0,
            ytdGCI: agentStats.ytdGCI || 0,
            contactCount: agentStats.contactCount || 0,
            leadsToday: agentStats.leadsToday || 0,
            pendingTasks: agentStats.pendingTasks || 0
          }))
        }

        if (results[1].status === 'fulfilled' && results[1].value) {
          setBriefing(results[1].value.briefing || null)
        }

        if (results[2].status === 'fulfilled' && results[2].value) {
          const showingsData = results[2].value.showings || []
          setShowings(showingsData)
          setStats(prev => ({
            ...prev,
            upcomingShowings: showingsData.length
          }))
        }

        if (results[3].status === 'fulfilled' && results[3].value) {
          setTransactions(results[3].value.transactions || [])
        }

        if (results[4].status === 'fulfilled' && results[4].value) {
          const annivResult = results[4].value as any
          setAnniversaries(annivResult.success ? (annivResult.anniversaries ?? []) : [])
        }

        if (results[5].status === 'fulfilled' && results[5].value) {
          setCommissions(results[5].value.commissions || [])
        }

        if (results[6].status === 'fulfilled' && results[6].value) {
          const expResult = results[6].value as any
          setMonthlyExpenses(expResult.success && expResult.expenses ? expResult.expenses : [])
        }

        if (results[7].status === 'fulfilled' && results[7].value) {
          setHotLeads(results[7].value.leads || [])
        }

        if (results[8].status === 'fulfilled' && results[8].value) {
          setLifeChanges(results[8].value || [])
        }

        if (results[9].status === 'fulfilled' && results[9].value) {
          const sellersResult = results[9].value as any
          setMotivatedSellers(sellersResult?.sellers ?? [])
        }

        // UserTypeBrief — feeds TodaysFocusCard with the play-aloud button.
        // Parallel to the legacy DailyBriefing loaded above.
        if (results[10].status === 'fulfilled' && results[10].value) {
          const briefResult = results[10].value as { brief?: UserTypeBrief | null }
          setUserTypeBrief(briefResult.brief ?? null)
        }

      } catch (error) {
        console.error("[v0] Error loading agent dashboard:", error)
      } finally {
        setLoading(false)
      }
    }

    loadData()

    // Load gameplan independently — doesn't block main render
    const loadGameplan = async () => {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      setGameplanLoading(true)
      try {
        const result = await generateDailyGameplan(user.id)
        setGameplan(result)
      } catch {
        // non-critical — don't surface error
      } finally {
        setGameplanLoading(false)
      }
    }
    loadGameplan()
  }, [])

  const handleRefreshBriefing = useCallback(async () => {
    setRefreshing(true)
    try {
      const result = await generateBriefing(true)
      if (result.briefing) {
        setBriefing(result.briefing)
      }
    } catch (error) {
      console.error("[v0] Error refreshing briefing:", error)
    }
    setRefreshing(false)
  }, [])

  // Refresh the UserTypeBrief that drives TodaysFocusCard (play-aloud).
  const handleRefreshUserTypeBrief = useCallback(async () => {
    setBriefRefreshing(true)
    try {
      const result = await getUserTypeBrief({ userType: "agent" })
      if (result.brief) setUserTypeBrief(result.brief)
    } catch (error) {
      console.error("[v0] Error refreshing user-type brief:", error)
    }
    setBriefRefreshing(false)
  }, [])

  const handleWhisperBridge = useCallback(async (contactId: string, context: string) => {
    setCallingId(contactId + 'whisper')
    try {
      await initiateWhisperBridge({ contactId, agentId, context })
    } catch (error) {
      console.error("[v0] Error initiating whisper bridge:", error)
    }
    setCallingId(null)
  }, [agentId])

  const handleVapiBot = useCallback(async (contactId: string, triggerEvent: string) => {
    setCallingId(contactId + 'vapi')
    try {
      await triggerVapiVoiceBot({ contactId, triggerEvent })
    } catch (error) {
      console.error("[v0] Error triggering VAPI bot:", error)
    }
    setCallingId(null)
  }, [])

  return (
    <div className="min-h-screen bg-background relative">
      {/* Voice Assistant Panel */}
      <VoiceAssistantPanel
        userId={agentId}
        userRole="agent"
        brokerageId={brokerageId}
      />

      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        <ApprovalsBanner />

        {/* Today's Focus — the "voice-read brief" card. Tap the speaker icon
            to hear the 3 priorities read aloud in the agent's cloned voice. */}
        {userTypeBrief && (
          <TodaysFocusCard
            brief={userTypeBrief}
            onRefresh={handleRefreshUserTypeBrief}
            refreshing={briefRefreshing}
          />
        )}

        <AgentCommandStrip
          agentName={agentName}
          briefing={briefing}
          actionPlans={actionPlans}
          onRefreshBriefing={handleRefreshBriefing}
          refreshing={refreshing}
        />

        <AgentOperatingRadar stats={stats} loading={loading} />

        {/* Weekly Plan widget — sits above the gameplan to set the week context */}
        {agentId && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <WeeklyPlanWidget agentId={agentId} />
            <LicenseComplianceWidget agentId={agentId} />
          </div>
        )}

        {/* Today's Gameplan */}
        {(gameplan || gameplanLoading) && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                Today&apos;s Gameplan
                {gameplanLoading && (
                  <span className="text-xs text-muted-foreground font-normal">Generating…</span>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {gameplanLoading ? (
                <div className="h-16 flex items-center justify-center text-sm text-muted-foreground">
                  Building your daily action plan…
                </div>
              ) : gameplan && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {gameplan.people_to_call?.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Call Today</p>
                      <ul className="space-y-1">
                        {gameplan.people_to_call.slice(0, 5).map((p: any, i: number) => (
                          <li key={i} className="text-sm text-foreground flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                            {p.name ?? p.contact_name ?? "Contact"}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {gameplan.deals_to_protect?.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Protect Deals</p>
                      <ul className="space-y-1">
                        {gameplan.deals_to_protect.slice(0, 5).map((d: any, i: number) => (
                          <li key={i} className="text-sm text-foreground flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                            {d.milestone_name?.replace(/_/g, " ") ?? d.description ?? "Milestone"}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {gameplan.content_to_post?.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Post Today</p>
                      <ul className="space-y-1">
                        {gameplan.content_to_post.slice(0, 3).map((c: any, i: number) => (
                          <li key={i} className="text-sm text-foreground flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                            {c.title ?? "Content"}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {gameplan.ai_summary && (
                    <div className="md:col-span-3 pt-2 border-t text-xs text-muted-foreground [&_strong]:font-semibold [&_strong]:text-foreground [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-0.5 [&_p]:my-1">
                      <ReactMarkdown>{gameplan.ai_summary}</ReactMarkdown>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {brokerageId && userId && (predictedSellers.length > 0 || queuedAutoTouches.length > 0) && (
          <PredictiveListingCard
            brokerageId={brokerageId}
            userId={userId}
            predictedSellers={predictedSellers}
            queuedAutoTouches={queuedAutoTouches}
          />
        )}

        {atRiskTxns.length > 0 && <DealRiskWidget atRisk={atRiskTxns} />}

        {atRiskListings.length > 0 && <ListingRiskWidget atRisk={atRiskListings} />}

        {/* Smart Queue — single segmented list (🔥 Hot · ⚠ At-risk · 🆕 New ·
            💎 Likely seller). Aggregates lead_score_history +
            sphere_engagement_scores + contacts.last_contacted_at +
            predictive_listing_scores. Promoted to top of contact area so
            agents see one consolidated view first. */}
        <SmartQueue />

        {/* Hot Leads quick-call panel — kept alongside SmartQueue because it
            has unique whisper-bridge + VAPI bot actions (one-tap call) that
            SmartQueue's draft_followup doesn't. Future: fold these actions
            into SmartQueue rows and retire this panel. */}
        {(hotLeads.length > 0 || loading) && (
          <AgentHotLeadsPanel
            hotLeads={hotLeads}
            agentId={agentId}
            onWhisperBridge={handleWhisperBridge}
            onVapiBot={handleVapiBot}
            callingId={callingId}
            loading={loading}
          />
        )}

        {/* Conversion Workspace — Qualified Handoffs.
            Distinct concept from SmartQueue's "new" segment: this surfaces
            lead→contact CONVERSION coaching (urgency_level, qualification
            reason, next_action, ai_summary) — not just "created recently". */}
        {agentId && brokerageId && (
          <NewlyConvertedContactsPanel agentId={agentId} brokerageId={brokerageId} />
        )}

        {/* Smarter-this-week digest — surfaces the AI improvement loop */}
        <SmarterWidget />

        {/* Predictive surfaces — Sphere Resonance + Wealth Advisor */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SphereResonanceCard />
          <WealthAdvisorCard />
        </div>

        {/* Listing presentations prepared by the daily cron — auto-hides when none */}
        <PresentationReadyBanner />

        {/* AI Coaching Insights — auto-hides when agent has fewer than 5 deals */}
        <AgentInsightsWidget />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <AgentNextBestActions
              briefingActions={briefing?.top_priority_actions || []}
              dealsAtRisk={briefing?.deals_at_risk || []}
              upcomingShowings={showings}
              actionPlans={actionPlans}
            />
            <AgentDealIntelligence transactions={transactions} loading={loading} />
            <AgentLifetimeCustomersPanel
              anniversaries={anniversaries}
              lifeChanges={lifeChanges}
              loading={loading}
            />
          </div>
          <div className="space-y-6">
            <AgentSuperpowersPanel
              agentId={agentId}
              brokerageId={brokerageId}
              hotLeadName={briefing?.hot_leads?.[0]?.name}
            />

            {/* Market Pulse — AI-generated from agent's pipeline data */}
            <MarketInsightWidget />

            <AgentFinancialIntelligence
              commissions={commissions}
              monthlyExpenses={monthlyExpenses}
              ytdGCI={stats.ytdGCI}
              activeTransactionCount={stats.activeTransactions}
              loading={loading}
            />
            {motivatedSellers.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      Motivated Seller Alerts
                    </span>
                    <Link
                      href="/leads?tab=intelligence"
                      className="text-xs text-primary font-normal underline underline-offset-2 hover:no-underline"
                    >
                      View all
                    </Link>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {motivatedSellers.slice(0, 4).map((seller: any, i: number) => {
                    const prop = seller.property
                    const address = prop?.address ?? "Unknown"
                    const score = seller.readiness_to_sell_score ?? 0
                    const timeframe = seller.predicted_timeframe ?? ""
                    return (
                      <div key={seller.id ?? i} className="flex items-center justify-between gap-2 text-sm">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-xs">{address}</p>
                          {timeframe && (
                            <p className="text-xs text-muted-foreground capitalize">{timeframe}</p>
                          )}
                        </div>
                        <Badge className="shrink-0 text-xs bg-amber-100 text-amber-700 border-amber-200">
                          {score}
                        </Badge>
                      </div>
                    )
                  })}
                </CardContent>
              </Card>
            )}
            <AgentSystemReadiness />

            {/* AgentStaleContactsPanel removed — superseded by SmartQueue's
                at_risk segment which now includes the same
                contacts.last_contacted_at >= 21d signal as a fallback when
                sphere_engagement_scores is sparse. Component file kept for
                back-compat in case any other surface mounts it. */}

            {/* My Source Performance */}
            <Card className="hover:shadow-md transition-shadow">
              <CardContent className="py-4">
                <Link
                  href="/dashboard/analytics/source"
                  className="flex items-center justify-between gap-3 group"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-semibold">My Source Performance</p>
                      <p className="text-xs text-muted-foreground">ROI by lead source and acquisition channel</p>
                    </div>
                  </div>
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-muted-foreground shrink-0 group-hover:translate-x-0.5 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </Link>
              </CardContent>
            </Card>

            {agentId && <ThisWeekPreview agentId={agentId} />}
          </div>
        </div>

      </div>
    </div>
  )
}
