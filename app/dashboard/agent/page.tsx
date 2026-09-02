"use client"

import { useEffect, useState, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
// Actions
import { getAgentStats } from "@/app/actions/agents"
import { getPendingFollowups } from "@/app/actions/activities"
import {
  generateDailyGameplan,
  executeCopilotTask,
  suggestNextActions,
  analyzeContactPriority,
  checkOverdueMilestones,
} from "@/app/actions/copilot"
import { getTodaysBriefing, generateBriefing, getUpcomingShowings, getActiveTransactions, getUserTypeBrief } from "@/app/actions/briefing-actions"
import { resolveAutopilotActionStatus } from "@/app/actions/open-house-kernel"
import { TodaysFocusCard } from "@/app/components/shell/todays-focus-card"
import BudgetWarningBanner from "@/app/components/shell/budget-warning-banner"
import AutonomyHaltNotice from "@/app/components/shell/autonomy-halt-notice"
import type { UserTypeBrief } from "@/lib/intelligence/user-type-briefs"
import { getUpcomingAnniversaries } from "@/app/actions/lifetime-customers"
import { getCommissionRecords, getExpenses } from "@/app/actions/ai-financial-management"
import { getHotLeads } from "@/app/actions/ai-auto-response"
import { getMotivatedSellers } from "@/app/actions/lead-intelligence"
import { getRecentLifeChanges } from "@/app/actions/contact-enrichment"
import { initiateWhisperBridge, triggerAiVoiceCall } from "@/app/actions/voice-call-bridge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
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
import { AgentCareerTierCard } from "@/app/components/agent/career-tier-card"
import { OnboardingJourneyCard } from "@/app/components/agent/onboarding-journey-card"
import { SetupReadinessCardClient } from "@/app/components/onboarding/setup-readiness-card-client"
import { CriticalSetupMeterClient } from "@/app/components/onboarding/critical-setup-meter-client"
import { AgentFinancialIntelligence } from "./components/agent-financial-intelligence"
import { AgentSystemReadiness } from "./components/agent-system-readiness"
import { ThisWeekPreview } from "@/app/dashboard/calendar/components/os"
import { NewlyConvertedContactsPanel } from "./components/conversion"
import { NewContactHandoffPanel } from "./components/handoff"
import { PredictiveListingCard } from "./components/predictive-listing-card"
import { getTopPredictiveSellers, listQueuedAutoTouches, type PredictiveSellerRow } from "@/app/actions/predictive-listing"
import { DealRiskWidget } from "./components/deal-risk-widget"
import { getAgentAtRiskTransactions, type AgentDealRisk } from "@/app/actions/deal-risk-agent"
import { ListingRiskWidget } from "./components/listing-risk-widget"
import { getAgentAtRiskListings, type AgentListingRisk } from "@/app/actions/listing-risk-agent"
import { ListingApptPrepWidget } from "./components/listing-appt-prep-widget"
import { getAgentUpcomingListingApptPreps, type ListingApptPrepRow } from "@/app/actions/listing-appointment-copilot"
import { RevenueProtectionHero } from "./components/revenue-protection-hero"
import { getAgentRevenueProtection, type AgentRevenueProtection } from "@/app/actions/revenue-protection"
import { IncomeForecastCard } from "./components/income-forecast-card"
import { getAgentIncomeForecast, type AgentIncomeForecast } from "@/app/actions/lifetime-npv"
import { OpenActionsCard } from "./components/open-actions-card"
import { ResumeIntakeCard } from "./components/resume-intake-card"
import { AgentActionQueueCard } from "./components/agent-action-queue-card"
import { TimeToValueCard } from "./components/time-to-value-card"
import { ConnectionHealthCard } from "./components/connection-health-card"
import { BrokerSelfHealPanel, BrokerExceptionCenter } from "@/app/dashboard/brokerage/components/command-center"
import { ApprovalsBanner } from "@/components/ApprovalsBanner"
import { MarketInsightWidget } from "@/app/components/dashboard/market-insight-widget"
import { SmarterWidget } from "@/app/components/dashboard/smarter-widget/smarter-widget"
import { SphereResonanceCard } from "@/app/components/heartbeat/sphere-resonance-card"
import { WealthAdvisorCard } from "@/app/components/heartbeat/wealth-advisor-card"
import { SmartQueue } from "@/app/components/heartbeat/smart-queue"
import AgentInsightsWidget from "@/app/dashboard/agent/components/agent-insights-widget"
import { AiInsightsFeedCard, type AiInsightRow } from "@/app/dashboard/agent/components/ai-insights-feed-card"
import PresentationReadyBanner from "@/app/dashboard/agent/components/presentation-ready-banner"
import { LearnThisWeekCard } from "@/app/components/learning/learn-this-week-card"
import { NpsSurveyCard } from "./components/nps-survey-card"
import { NegotiationCoPilotCard } from "@/app/components/negotiation/negotiation-copilot-card"

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
  const [upcomingListingPreps, setUpcomingListingPreps] = useState<ListingApptPrepRow[]>([])
  const [revenueProtection, setRevenueProtection] = useState<AgentRevenueProtection | null>(null)
  const [incomeForecast, setIncomeForecast] = useState<AgentIncomeForecast | null>(null)
  const [actionPlans, setActionPlans] = useState<any[]>([])
  const [aiInsights, setAiInsights] = useState<AiInsightRow[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [callingId, setCallingId] = useState<string | null>(null)
  const [motivatedSellers, setMotivatedSellers] = useState<any[]>([])
  const [gameplan, setGameplan] = useState<any>(null)
  const [gameplanLoading, setGameplanLoading] = useState(false)
  // Gameplan rows were read-only text. runCopilotTask turns each one into the
  // action it names, through the single copilot executor (executeCopilotTask ->
  // initiateWhisperBridge / sendPropertyMatches / checkTransactionDeadlines).
  const [copilotTaskId, setCopilotTaskId] = useState<string | null>(null)
  // LOOSE ENDS — suggestNextActions is the deterministic counterpart to the
  // LLM-written briefing: unanswered inbound messages, showings still missing
  // feedback, and clients who have not been contacted in 14+ days, each with the
  // ids behind them. It was complete and had no caller anywhere in the repo.
  const [nextActions, setNextActions] = useState<Array<{
    type: string
    priority: string
    action: string
    contact_ids?: string[]
    showing_ids?: string[]
  }>>([])
  // Per-contact "why is this person on my list" read (analyzeContactPriority).
  const [priorityById, setPriorityById] = useState<Record<string, {
    priority: string
    score: number
    factors: string[]
    recommended_action: string
  }>>({})
  const [priorityLoadingId, setPriorityLoadingId] = useState<string | null>(null)
  const [scanningMilestones, setScanningMilestones] = useState(false)

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

          // Listing Appointment Co-Pilot — upcoming preps (running or completed in last 7d)
          // `agentId` here is the auth user id, since workflow_runs.agent_user_id
          // is the users(id) reference (not agents.id).
          getAgentUpcomingListingApptPreps({
            agentId: user.id,
            limit: 5,
          })
            .then(setUpcomingListingPreps)
            .catch(() => setUpcomingListingPreps([]))

          // Revenue Protection Score — latest quarterly snapshot for this agent
          getAgentRevenueProtection({ agentId: user.id })
            .then((r) => setRevenueProtection(r.data ?? null))
            .catch(() => setRevenueProtection(null))

          // Income Forecast — latest 30/60/90 projection + sphere referral expected
          getAgentIncomeForecast({ agentId: user.id })
            .then((r) => setIncomeForecast(r.data ?? null))
            .catch(() => setIncomeForecast(null))
        }

        // 4. Calculate month start
        const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
          .toISOString().split('T')[0]

        // 5. Load action plans from activities table.
        // This sat OUTSIDE the `if (agentRow)` block above and re-reached for
        // agentRow?.id — with no agents row the filter matched nothing and the
        // agent's "next actions" feed rendered empty, which reads as "you are
        // all caught up" rather than "we could not look this up".
        const { data: plans } = agentRow?.id ? await supabase
          .from("activities")
          .select("id, title, description, priority, contact_id")
          .eq("agent_id", agentRow.id)
          .eq("activity_type", "agent_action_plan")
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(5) : { data: null }

        // 5b. Merge queued AI Autopilot next-actions (open-house follow-ups from
        // lib/kernel/open-house.ts) into the same suggestions feed — labeled by
        // source. ai_autopilot_actions.agent_id references agents.id.
        let autopilotPlans: any[] = []
        if (agentRow?.id) {
          const { data: autopilotActions, error: autopilotError } = await supabase
            .from("ai_autopilot_actions")
            .select("id, title, description, priority, action_type, entity_type, entity_id, scheduled_for")
            .eq("agent_id", agentRow.id)
            .eq("status", "pending")
            .order("scheduled_for", { ascending: true })
            .limit(5)

          if (!autopilotError && autopilotActions) {
            autopilotPlans = autopilotActions.map((a: any) => ({
              id: a.id,
              title: a.title || a.action_type?.replace(/_/g, " ") || "Suggested action",
              description: a.description || undefined,
              priority: a.priority || undefined,
              contact_id: a.entity_type === "contact" ? a.entity_id : null,
              source: "AI Autopilot",
            }))
          }
        }

        // 5c. Pending FOLLOW-UPS from the same `activities` table — the half of
        // it this feed had never read. Step 5 above filters
        // activity_type='agent_action_plan'; every followup / callback / reminder
        // / task row that logActivity (app/actions/activities.ts) writes is a
        // DISJOINT activity_type, so those rows were being written and never
        // shown anywhere. An agent who scheduled a callback saw it nowhere.
        //
        // Read through the gated action rather than a fourth inline query: it
        // resolves the agent from the SESSION and refuses a mismatch, and it
        // brings the contact along so the card can say who the callback is with.
        let followupPlans: any[] = []
        // agentRow.id, NOT user.id. `activities.agent_id` is AGENTS-class (the
        // same id steps 5 and 5b filter on) and getPendingFollowups compares the
        // argument against the session's resolved agents.id — handing it a
        // users.id would come back "Forbidden" for the agent's own follow-ups.
        if (agentRow?.id) {
          const followupRes = await getPendingFollowups(agentRow.id, 5)
          if (followupRes.error) {
            // Same posture as the insights feed below: this page has no error
            // surface for its dashboard reads, so a refusal is logged rather
            // than rendered as an empty "you are all caught up".
            console.error("[v0] pending follow-ups read refused:", followupRes.error)
          } else {
            followupPlans = (followupRes.followups || []).map((f: any) => ({
              id: f.id,
              title:
                f.title ||
                [f.activity_type?.replace(/_/g, " "), f.contacts?.first_name, f.contacts?.last_name]
                  .filter(Boolean)
                  .join(" ") ||
                "Follow-up",
              description: f.description || undefined,
              priority: f.priority || undefined,
              contact_id: f.contact_id ?? null,
              source: "Follow-up",
            }))
          }
        }

        setActionPlans([...(plans || []), ...autopilotPlans, ...followupPlans])

        // 5c. AI Insights feed — writers (app/actions/ai-predictions.ts) insert
        // insight_title/insight_description and almost always leave agent_id
        // null, so unattributed rows are deliberately INCLUDED: an insight about
        // a transaction or a market shift belongs to the desk, not to one agent.
        //
        // THE BROKERAGE PREDICATE IS THIS QUERY'S ONLY TENANT BOUNDARY, and it is
        // stated here rather than assumed of RLS. The policy on ai_insights is
        // `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`,
        // so the database admits every untenanted row from every tenant — the
        // widening above would have widened ACROSS brokerages, not within one.
        // agents.brokerage_id is NOT NULL and is already loaded above, so the
        // filter is `.eq`, which also excludes brokerage_id IS NULL: the 64
        // pre-rollout rows that nothing records a tenant for stay out of the
        // feed rather than being shown to whoever loads the page first.
        //
        // actionable_steps / entity_type / entity_id: every one of the eleven
        // ai_insights writers in app/actions/ai-predictions.ts records WHAT the
        // insight is about and WHAT TO DO about it, and until this select the
        // feed showed only title/description — the "do this next" half of every
        // insight was written and never read. The card turns entity_type +
        // entity_id into a deep link (see insightEntityHref in the card).
        if (agentRow?.id && agentRow?.brokerage_id) {
          const { data: insightRows, error: insightsError } = await supabase
            .from("ai_insights")
            .select("id, insight_type, insight_title, insight_description, priority, estimated_impact, created_at, actionable_steps, entity_type, entity_id")
            .eq("brokerage_id", agentRow.brokerage_id)
            .or(`agent_id.eq.${agentRow.id},agent_id.is.null`)
            .order("created_at", { ascending: false })
            .limit(8)

          // supabase-js RESOLVES a refused read, so `insightsError` is the only
          // thing that tells a refusal apart from an empty feed. This page has no
          // error surface for its dashboard reads (every one of them uses this
          // same `if (!error && data)` shape and the card simply hides when
          // empty), so the shape is left alone and the refusal is logged the way
          // this file logs its other failures — a silently empty feed is at least
          // no longer silent in the console.
          if (insightsError) {
            console.error("[v0] AI insights feed read refused:", insightsError.message)
          } else if (insightRows) {
            setAiInsights(insightRows)
          }
        }

        // 6. Load all data in parallel
        const results = await Promise.allSettled([
          getAgentStats(user.id),
          getTodaysBriefing(),
          getUpcomingShowings(),
          getActiveTransactions(),
          getUpcomingAnniversaries(),
          getCommissionRecords({ status: 'pending' }),
          // pass 12: scope to this agent's book — business_expenses.agent_id is
          // agents.id; unscoped, the read leaned on RLS breadth instead of intent.
          getExpenses({ agentId: agentRow?.id, startDate: monthStart }),
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

      // Loose ends ride alongside the gameplan — same identity, same card.
      try {
        const { suggestions } = await suggestNextActions(user.id)
        setNextActions(suggestions ?? [])
      } catch {
        // non-critical — the gameplan still renders without it
      }
    }
    loadGameplan()
  }, [])

  /**
   * ONE executor for every gameplan row. executeCopilotTask is the copilot's
   * task dispatcher — it delegates to the canonical lanes rather than
   * re-implementing them (call_hot_lead -> initiateWhisperBridge, the single
   * agent->contact calling lane; check_transaction_status -> the milestone
   * deadline reader). The result is READ, so a refusal is shown rather than
   * reported as done.
   *
   * ID CLASSES, verified against generateDailyGameplan's own queries:
   *   people_to_call rows are `contacts` rows      -> contacts.id
   *   deals_to_protect rows are transaction_milestones -> .transaction_id
   */
  const runCopilotTask = useCallback(
    async (key: string, taskType: string, params: Record<string, any>) => {
      setCopilotTaskId(key)
      try {
        const res: any = await executeCopilotTask(key, taskType, params)
        if (res?.success) {
          toast.success(res.message ?? "Done")
        } else {
          toast.error(res?.error ?? "That action did not run")
        }
      } catch (err: any) {
        toast.error(err?.message ?? "That action did not run")
      } finally {
        setCopilotTaskId(null)
      }
    },
    [],
  )

  /**
   * "Why is this person on my call list?" — analyzeContactPriority scores the
   * contact from live signals (recent property activity, recent replies,
   * timeline urgency) and names the factors plus the recommended action. The
   * gameplan listed names with no reason attached; this is the reason.
   */
  const explainContactPriority = useCallback(async (contactId: string) => {
    setPriorityLoadingId(contactId)
    try {
      const result = await analyzeContactPriority(contactId)
      setPriorityById((prev) => ({ ...prev, [contactId]: result }))
    } catch (err: any) {
      toast.error(err?.message ?? "Could not score that contact")
    } finally {
      setPriorityLoadingId(null)
    }
  }, [])

  /**
   * checkOverdueMilestones sweeps this brokerage's pending milestones past their
   * target date and emits milestone_overdue for each — the event the
   * orchestrator turns into an assistant suggestion. Complete, and nothing had
   * ever run it.
   */
  const runOverdueMilestoneScan = useCallback(async () => {
    setScanningMilestones(true)
    try {
      const res = await checkOverdueMilestones()
      toast.success(
        res.count > 0
          ? `${res.count} overdue milestone${res.count === 1 ? "" : "s"} flagged — follow-ups queued`
          : "No overdue milestones",
      )
    } catch (err: any) {
      toast.error(err?.message ?? "Milestone scan did not run")
    } finally {
      setScanningMilestones(false)
    }
  }, [])

  // Done/Skip for AI Autopilot suggestions. The rows are born 'pending'
  // (lib/kernel/open-house.ts) and this feed reads .eq("status","pending") —
  // until this handler existed the ONLY transition writer was the admin
  // Command Center, so an agent's own suggestion feed could never clear.
  // The card is removed from state only after the server confirms the
  // transition; a refusal surfaces as a toast, never as a silent "done".
  const handleResolveAutopilot = useCallback(async (planId: string, outcome: "executed" | "skipped") => {
    const res = await resolveAutopilotActionStatus({ actionId: planId, outcome })
    if (res.success) {
      setActionPlans(prev => prev.filter(p => p.id !== planId))
    } else {
      toast.error(res.error ?? "Could not update the suggestion")
    }
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

  const handleAiVoiceCall = useCallback(async (contactId: string, triggerEvent: string) => {
    setCallingId(contactId + 'ai-voice')
    try {
      await triggerAiVoiceCall({ contactId, triggerEvent })
    } catch (error) {
      console.error("[v0] Error triggering the AI voice call:", error)
    }
    setCallingId(null)
  }, [])

  return (
    <div className="min-h-screen bg-background relative">
      {/* The floating AI assistant is mounted once, globally, by AppShell (the
          typed ask+voice copilot + the gated premium voice tier) — the separate
          VoiceAssistantPanel that used to stack a third FAB here was removed in
          the 2026-07 assistant consolidation. (It still serves the mobile voice
          page, /mobile/voice.) */}

      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        <ApprovalsBanner />

        {/* Tenant→platform NPS — renders only when the quarter-eligibility
            rule says so (app/actions/nps.ts); dismiss hides for this session. */}
        <NpsSurveyCard />

        {/* Critical setup (round 42) — the compact per-agent meter: items the
            OS engines no-op without (license → signature gate, calendar →
            scheduling, push → field alerts, contacts → portal invites). */}
        <CriticalSetupMeterClient variant="compact" />

        {/* Role-aware setup readiness — what the agent still needs to configure to sell */}
        <SetupReadinessCardClient />

        {/* Staff autonomy halt — honest "your AI team is paused" notice (renders only when halted) */}
        <AutonomyHaltNotice />

        {/* Usage warning — generic, superadmin-gated (no vendor names / amounts) */}
        <BudgetWarningBanner />

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
            <AgentCareerTierCard agentId={agentId} />
            <OnboardingJourneyCard agentId={agentId} />
            {/* Unfinished voice intakes — identity is session-derived inside the
                action; hides itself when there is nothing to resume. */}
            <ResumeIntakeCard />
          </div>
        )}

        {/* Today's Gameplan */}
        {(gameplan || gameplanLoading || nextActions.length > 0) && (
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  Today&apos;s Gameplan
                  {gameplanLoading && (
                    <span className="text-xs text-muted-foreground font-normal">Generating…</span>
                  )}
                </CardTitle>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  disabled={scanningMilestones}
                  onClick={runOverdueMilestoneScan}
                >
                  {scanningMilestones ? "Scanning…" : "Scan overdue milestones"}
                </Button>
              </div>
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
                        {gameplan.people_to_call.slice(0, 5).map((p: any, i: number) => {
                          const label =
                            p.name ??
                            p.contact_name ??
                            [p.first_name, p.last_name].filter(Boolean).join(" ") ??
                            "Contact"
                          const busy = copilotTaskId === `call-${p.id}` || copilotTaskId === `match-${p.id}`
                          return (
                            <li key={p.id ?? i} className="text-sm text-foreground">
                              <div className="flex items-center gap-1.5">
                                <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                                <span className="truncate">{label}</span>
                              </div>
                              {p.id && (
                                <div className="flex gap-1 mt-1 ml-3">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-6 px-2 text-xs"
                                    disabled={busy}
                                    onClick={() =>
                                      runCopilotTask(`call-${p.id}`, "call_hot_lead", { contactId: p.id })
                                    }
                                  >
                                    Call
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-2 text-xs"
                                    disabled={busy}
                                    onClick={() =>
                                      runCopilotTask(`match-${p.id}`, "send_property_alert", { contactId: p.id })
                                    }
                                  >
                                    Send matches
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-2 text-xs"
                                    disabled={priorityLoadingId === p.id}
                                    onClick={() => explainContactPriority(p.id)}
                                  >
                                    {priorityLoadingId === p.id ? "…" : "Why?"}
                                  </Button>
                                </div>
                              )}
                              {p.id && priorityById[p.id] && (
                                <div className="ml-3 mt-1 rounded border bg-muted/30 p-1.5 text-[11px] text-muted-foreground">
                                  <span className="font-medium text-foreground">
                                    {priorityById[p.id].priority.toUpperCase()} · {priorityById[p.id].score}
                                  </span>
                                  {priorityById[p.id].factors.length > 0 && (
                                    <span> — {priorityById[p.id].factors.join(", ")}</span>
                                  )}
                                  <div className="mt-0.5">{priorityById[p.id].recommended_action}</div>
                                </div>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )}
                  {gameplan.deals_to_protect?.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Protect Deals</p>
                      <ul className="space-y-1">
                        {gameplan.deals_to_protect.slice(0, 5).map((d: any, i: number) => (
                          <li key={d.id ?? i} className="text-sm text-foreground">
                            <div className="flex items-center gap-1.5">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                              <span className="truncate">
                                {d.milestone_name?.replace(/_/g, " ") ?? d.description ?? "Milestone"}
                              </span>
                            </div>
                            {d.transaction_id && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-6 px-2 mt-1 ml-3 text-xs"
                                disabled={copilotTaskId === `deadlines-${d.id}`}
                                onClick={() =>
                                  runCopilotTask(`deadlines-${d.id}`, "check_transaction_status", {
                                    transactionId: d.transaction_id,
                                  })
                                }
                              >
                                Check deadlines
                              </Button>
                            )}
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

              {/* LOOSE ENDS — deterministic, id-backed follow-ups. */}
              {nextActions.length > 0 && (
                <div className="mt-4 pt-3 border-t">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                    Loose Ends
                  </p>
                  <ul className="space-y-1">
                    {nextActions.map((s, i) => (
                      <li key={`${s.type}-${i}`} className="text-sm text-foreground flex items-start gap-1.5">
                        <span
                          className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${
                            s.priority === "high" ? "bg-red-500" : "bg-amber-500"
                          }`}
                        />
                        <span>{s.action}</span>
                      </li>
                    ))}
                  </ul>
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

        {brokerageId && userId && (
          <RevenueProtectionHero
            data={revenueProtection}
            brokerageId={brokerageId}
            agentUserId={userId}
          />
        )}

        {/* Agent OS Action Queue — Sprint 6. THE morning starting point.
            Composes deal-health, listing-health, NPV-due, and portal-event
            actions into one priority-ranked list. Hidden when zero items. */}
        <AgentActionQueueCard />

        {/* Connection health — the tenant's own connectivity-fabric view: what
            broke, what it costs, one tap to fix. Renders only when unhealthy. */}
        <ConnectionHealthCard />

        {/* PRINCIPAL seats only (solo agent / team lead — subscriptions with
            no broker above them): the OS's own maintenance surfaces. The
            actions gate on PRINCIPAL_TYPES server-side; for overseen seats
            these render nothing. */}
        <BrokerSelfHealPanel />
        <BrokerExceptionCenter />

        {/* Time-to-Value Radar — hours your AI team saved you (adoption story). */}
        <TimeToValueCard />

        <OpenActionsCard />

        {/* Sprint 8 — Negotiation Co-Pilot: persisted strategy recs per
            open offer with the customer-mirror panel inline. Hides on empty. */}
        <NegotiationCoPilotCard />

        {/* Sprint 7 — Knowledge & Growth Router: surfaces the top
            learning modules picked by the actor's gap_tags + tenure.
            Hides on empty. */}
        {userId && <LearnThisWeekCard actorKind="agent" actorId={userId} />}

        {brokerageId && userId && (
          <IncomeForecastCard
            data={incomeForecast}
            brokerageId={brokerageId}
            agentUserId={userId}
          />
        )}

        {atRiskTxns.length > 0 && <DealRiskWidget atRisk={atRiskTxns} />}

        {atRiskListings.length > 0 && <ListingRiskWidget atRisk={atRiskListings} />}

        {upcomingListingPreps.length > 0 && <ListingApptPrepWidget preps={upcomingListingPreps} />}

        {/* FIRST-TOUCH ACKNOWLEDGEMENT — owner ruling: "their needs to be an
            agent side first touch acknolegement becaue the agent needs a heads
            up that a new contact has been added and contact welcome package
            sent." Sits ABOVE SmartQueue because it is a HEADS-UP, not a work
            queue: a contact that arrived without the agent asking for it, and
            the verified state of its welcome package. It is the only caller of
            acknowledgeLeadHandoffAction — the sole writer of
            assignment_log.claimed, which daily-briefing-generator,
            isa-overnight (handoffs_unclaimed) and user-type-briefs/team-lead all
            read as "still awaiting first touch". Self-scoping: it resolves the
            caller's own agents row server-side and needs no props. Auto-hides
            (empty state) when nothing is pending. */}
        <NewContactHandoffPanel />

        {/* Smart Queue — single segmented list (🔥 Hot · ⚠ At-risk · 🆕 New ·
            💎 Likely seller). Aggregates lead_score_history +
            sphere_engagement_scores + contacts.last_contacted_at +
            predictive_listing_scores. Promoted to top of contact area so
            agents see one consolidated view first. */}
        <SmartQueue />

        {/* Hot Leads quick-call panel — kept alongside SmartQueue because it
            has unique whisper-bridge + AI voice-bot actions (one-tap call) that
            SmartQueue's draft_followup doesn't. Future: fold these actions
            into SmartQueue rows and retire this panel. */}
        {(hotLeads.length > 0 || loading) && (
          <AgentHotLeadsPanel
            hotLeads={hotLeads}
            agentId={agentId}
            onWhisperBridge={handleWhisperBridge}
            onAiVoiceCall={handleAiVoiceCall}
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

        {/* AI Insights feed — latest predictions/opportunities/risks written by
            app/actions/ai-predictions.ts. Hidden when empty. */}
        {aiInsights.length > 0 && <AiInsightsFeedCard insights={aiInsights} />}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <AgentNextBestActions
              briefingActions={briefing?.top_priority_actions || []}
              dealsAtRisk={briefing?.deals_at_risk || []}
              upcomingShowings={showings}
              actionPlans={actionPlans}
              onResolveAutopilot={handleResolveAutopilot}
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
                  {/* No link out — /leads is a broker/admin desk; agents work contacts.
                      The alerts themselves render right here. */}
                  <CardTitle className="text-sm flex items-center gap-1.5">
                    Motivated Seller Alerts
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
                superseded by SmartQueue at_risk; component deleted. */}

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
