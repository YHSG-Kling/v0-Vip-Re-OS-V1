"use client"

import { useEffect, useState, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
// Actions
import { getAgentStats } from "@/app/actions/agents"
import { getTodaysBriefing, generateBriefing, getUpcomingShowings, getActiveTransactions } from "@/app/actions/briefing-actions"
import { getUpcomingAnniversaries } from "@/app/actions/past-clients"
import { getCommissionRecords, getExpenses } from "@/app/actions/ai-financial-management"
import { getHotLeads } from "@/app/actions/ai-auto-response"
import { getMotivatedSellers } from "@/app/actions/lead-intelligence"
import { getRecentLifeChanges } from "@/app/actions/contact-enrichment"
import { initiateWhisperBridge, triggerVapiVoiceBot } from "@/app/actions/voice-call-bridge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"
// Components
import { AgentCommandStrip } from "./components/agent-command-strip"
import { AgentOperatingRadar } from "./components/agent-operating-radar"
import { AgentHotLeadsPanel } from "./components/agent-hot-leads-panel"
import { AgentNextBestActions } from "./components/agent-next-best-actions"
import { AgentDealIntelligence } from "./components/agent-deal-intelligence"
import { AgentLifetimeCustomersPanel } from "./components/agent-lifetime-customers-panel"
import { AgentSuperpowersPanel } from "./components/agent-superpowers-panel"
import { AgentFinancialIntelligence } from "./components/agent-financial-intelligence"
import { AgentSystemReadiness } from "./components/agent-system-readiness"
import { ThisWeekPreview } from "@/app/dashboard/calendar/components/os"
import { ApprovalsBanner } from "@/components/ApprovalsBanner"
import { NewlyConvertedContactsPanel } from "./components/conversion"
import { VoiceAssistantPanel } from "@/app/components/ai-copilot"

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
  const [showings, setShowings] = useState<any[]>([])
  const [transactions, setTransactions] = useState<any[]>([])
  const [anniversaries, setAnniversaries] = useState<any[]>([])
  const [lifeChanges, setLifeChanges] = useState<any[]>([])
  const [commissions, setCommissions] = useState<any[]>([])
  const [monthlyExpenses, setMonthlyExpenses] = useState<any[]>([])
  const [hotLeads, setHotLeads] = useState<any[]>([])
  const [actionPlans, setActionPlans] = useState<any[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [callingId, setCallingId] = useState<string | null>(null)
  const [motivatedSellers, setMotivatedSellers] = useState<any[]>([])

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
          getRecentLifeChanges(agentRow?.id, 7).catch(() => [])
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
          setAnniversaries(results[4].value || [])
        }

        if (results[5].status === 'fulfilled' && results[5].value) {
          setCommissions(results[5].value.commissions || [])
        }

        if (results[6].status === 'fulfilled' && results[6].value) {
          setMonthlyExpenses(results[6].value.expenses || [])
        }

        if (results[7].status === 'fulfilled' && results[7].value) {
          setHotLeads(results[7].value.leads || [])
        }

        if (results[8].status === 'fulfilled' && results[8].value) {
          setLifeChanges(results[8].value || [])
        }

        // Motivated sellers — loaded separately to not block main data
        getMotivatedSellers({ min_score: 60 })
          .then((r) => setMotivatedSellers(r?.sellers ?? []))
          .catch(() => null)

      } catch (error) {
        console.error("[v0] Error loading agent dashboard:", error)
      } finally {
        setLoading(false)
      }
    }

    loadData()
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

        <AgentCommandStrip
          agentName={agentName}
          briefing={briefing}
          actionPlans={actionPlans}
          onRefreshBriefing={handleRefreshBriefing}
          refreshing={refreshing}
        />

        <AgentOperatingRadar stats={stats} loading={loading} />

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

        {/* Conversion Workspace - Qualified Handoffs */}
        {agentId && brokerageId && (
          <NewlyConvertedContactsPanel agentId={agentId} brokerageId={brokerageId} />
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <AgentNextBestActions
              briefingActions={briefing?.top_priority_actions || []}
              hotLeads={briefing?.hot_leads || []}
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
            {agentId && <ThisWeekPreview agentId={agentId} />}
          </div>
        </div>

      </div>
    </div>
  )
}
