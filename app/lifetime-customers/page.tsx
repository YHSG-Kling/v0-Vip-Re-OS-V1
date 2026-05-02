"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { createClient } from "@/lib/supabase/client"
import { toast } from "sonner"
import {
  Heart,
  Sparkles,
  TrendingUp,
  ExternalLink,
  Star,
  Search,
  Phone,
  Mail,
  MessageSquare,
  Calendar,
  CalendarPlus,
  Home,
  User,
  Clock,
  Loader2,
  Send,
  Copy,
  AlertCircle,
  Gift,
  PartyPopper,
  Users,
  RefreshCw,
  Zap,
  BrainCircuit,
  CheckCircle2,
} from "lucide-react"
import {
  getLifetimeCustomers,
  logTouchpoint,
  sendMarketUpdate,
  scheduleTouchpoint,
  getTouchpointTimeline,
  getUpcomingAnniversaries,
  getAISuggestedTouchpoint,
  scoreSphereEngagement,
  segmentSphere,
  getUpcomingMilestones,
  generateTouchpoint,
  optimizeReferralAsk,
  getLifeChangeSignals,
  findReferralOpportunities,
} from "@/app/actions/lifetime-customers"
import { generateReferralRequest, nurturePendingReferral, recommendReferralReward } from "@/app/actions/ai-referral-management"
import { loadReferralPipelineAction } from "@/app/actions/reputation-kernel"
import { LifeSignalBadge } from "@/app/components/shared/LifeSignalBadge"
import { ReputationPanel } from "@/app/components/reputation/ReputationPanel"
import { CampaignsGiftingPanel } from "./components/campaigns-gifting-panel"

// Types
interface PastClient {
  id: string
  first_name: string
  last_name: string
  email?: string
  phone?: string
  transactions: {
    id: string
    actual_close_date: string
    status: string
    property_address?: string
    sale_price?: number
  }[]
  client_engagement_scores?: {
    engagement_score: number
    referral_potential_score: number
    last_touchpoint_date?: string
    computed_at?: string
  }[]
}

interface Touchpoint {
  id: string
  contact_id: string
  touchpoint_type: string
  channel: string
  notes?: string
  status: string
  sent_at: string
}

interface Anniversary {
  id: string
  actual_close_date: string
  property_address: string
  sale_price?: number
  contacts: {
    id: string
    first_name: string
    last_name: string
    email?: string
    phone?: string
  }
}

// Helper functions
function getEngagementBadge(score: number) {
  if (score >= 70) return { label: "Hot", className: "bg-green-100 text-green-700 border-green-300" }
  if (score >= 40) return { label: "Warm", className: "bg-amber-100 text-amber-700 border-amber-300" }
  return { label: "Cold", className: "bg-slate-100 text-slate-500 border-slate-300" }
}

function getDaysSinceContact(lastTouchpointDate?: string): number | null {
  if (!lastTouchpointDate) return null
  const now = new Date()
  const last = new Date(lastTouchpointDate)
  return Math.floor((now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24))
}

function getTouchpointIcon(type: string) {
  switch (type) {
    case "call": return <Phone className="w-4 h-4" />
    case "email": return <Mail className="w-4 h-4" />
    case "market_update": return <TrendingUp className="w-4 h-4" />
    case "anniversary": return <PartyPopper className="w-4 h-4" />
    case "check_in": return <MessageSquare className="w-4 h-4" />
    default: return <Clock className="w-4 h-4" />
  }
}

export default function LifetimeCustomersPage() {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()
  const searchParams = useSearchParams()

  // Tab state — supports ?tab= URL param for deep-linking (e.g. from redirects)
  const VALID_TABS = ["feed", "intelligence", "radar", "portal", "reputation", "referrals", "reviews", "gifting"]
  const tabParam = searchParams.get("tab")
  const TAB_ALIAS: Record<string, string> = {
    referrals: "radar",
    reviews: "reputation",
    gifting: "intelligence",
  }
  const resolvedTab = tabParam
    ? TAB_ALIAS[tabParam] ?? (VALID_TABS.includes(tabParam) ? tabParam : "feed")
    : "feed"
  const [activeTab, setActiveTab] = useState(resolvedTab)

  // Data state
  const [clients, setClients] = useState<PastClient[]>([])
  const [anniversaries, setAnniversaries] = useState<Anniversary[]>([])
  const [loading, setLoading] = useState(true)
  const [currentAgentId, setCurrentAgentId] = useState("")
  const [currentUserId, setCurrentUserId] = useState("")
  const [currentBrokerageId, setCurrentBrokerageId] = useState("")

  // Filter state
  const [search, setSearch] = useState("")
  const [engagementFilter, setEngagementFilter] = useState("all")

  // Selected client state
  const [selectedClient, setSelectedClient] = useState<PastClient | null>(null)
  const [touchpointTimeline, setTouchpointTimeline] = useState<Touchpoint[]>([])
  const [loadingTimeline, setLoadingTimeline] = useState(false)

  // Touchpoint draft dialog
  const [touchpointDraft, setTouchpointDraft] = useState<string | null>(null)
  const [touchpointDialogOpen, setTouchpointDialogOpen] = useState(false)
  const [touchpointDialogTitle, setTouchpointDialogTitle] = useState("AI Generated Message")

  // Log touchpoint modal
  const [showLogTouchpoint, setShowLogTouchpoint] = useState(false)
  const [touchpointType, setTouchpointType] = useState("call")
  const [touchpointNotes, setTouchpointNotes] = useState("")

  // Schedule touchpoint dialog
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false)
  const [scheduleContactId, setScheduleContactId] = useState<string | null>(null)
  const [scheduleContactName, setScheduleContactName] = useState("")
  const [scheduleDate, setScheduleDate] = useState("")
  const [scheduleType, setScheduleType] = useState("call")
  const [scheduleNotes, setScheduleNotes] = useState("")

  // AI suggested touchpoints per contact
  const [aiSuggestions, setAiSuggestions] = useState<Record<string, any>>({})
  const [aiSuggestionLoading, setAiSuggestionLoading] = useState<string | null>(null)

  // Track which contact opened the touchpoint draft dialog (for market update send)
  const [touchpointContactId, setTouchpointContactId] = useState<string | null>(null)

  // Referral script generator dialog
  const [referralScriptContactId, setReferralScriptContactId] = useState<string | null>(null)
  const [referralScriptChannel, setReferralScriptChannel] = useState<"email" | "text" | "call_script">("email")
  const [referralScriptOpen, setReferralScriptOpen] = useState(false)

  // Priority sub-tab within the Relationship Feed
  const [priorityTab, setPriorityTab] = useState("all")

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkSending, setBulkSending] = useState(false)
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null)

  // Reach All sheet state
  const [reachAllOpen, setReachAllOpen] = useState(false)

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (selectedIds.size === filteredClients.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(filteredClients.map((c) => c.id)))
    }
  }

  async function handleBulkMarketUpdate() {
    const targets = filteredClients.filter((c) => selectedIds.has(c.id))
    if (targets.length === 0) return
    setBulkSending(true)
    setBulkProgress({ done: 0, total: targets.length })
    let done = 0
    for (const client of targets) {
      try {
        const draftResult = await generateTouchpoint({ contactId: client.id, touchpointType: "market_update" })
        const draftMessage = draftResult.success && 'data' in draftResult && draftResult.data ? (draftResult.data as any).message : undefined
        if (draftMessage) {
          await sendMarketUpdate({ contactId: client.id, messageBody: draftMessage })
        }
      } catch {
        // continue — don't abort bulk on single failure
      }
      done++
      setBulkProgress({ done, total: targets.length })
      toast.success(`Sending to ${done}/${targets.length}...`)
    }
    toast.success(`Market updates sent to ${done} contacts`)
    setBulkSending(false)
    setBulkProgress(null)
    setSelectedIds(new Set())
  }

  // Sphere intelligence state
  const [sphereScores, setSphereScores] = useState<any>(null)
  const [sphereSegments, setSphereSegments] = useState<any>(null)
  const [milestones, setMilestones] = useState<any[]>([])
  const [lifeSignals, setLifeSignals] = useState<any[]>([])
  const [referralOpportunities, setReferralOpportunities] = useState<any[]>([])
  const [referralPipeline, setReferralPipeline] = useState<any[]>([])
  const [nurtureResults, setNurtureResults] = useState<Record<string, any>>({})
  const [rewardResults, setRewardResults] = useState<Record<string, any>>({})

  // Resolve current agent ID once on mount
  useEffect(() => {
    async function resolveAgent() {
      const supabase = createClient()
      const { data: { user: authUser } } = await supabase.auth.getUser()
      if (!authUser) return
      setCurrentUserId(authUser.id)
      const [{ data: agentRow }, { data: userRow }] = await Promise.all([
        supabase.from("agents").select("id").eq("user_id", authUser.id).maybeSingle(),
        supabase.from("users").select("brokerage_id").eq("id", authUser.id).maybeSingle(),
      ])
      setCurrentAgentId(agentRow?.id ?? authUser.id)
      setCurrentBrokerageId(userRow?.brokerage_id ?? "")
    }
    resolveAgent()
  }, [])

  // Load initial data
  useEffect(() => {
    async function loadData() {
      setLoading(true)
      try {
        const [clientsResult, anniversariesResult] = await Promise.all([
          getLifetimeCustomers({ search, engagementFilter }),
          getUpcomingAnniversaries(),
        ])

        if (clientsResult.success && clientsResult.clients) {
          setClients(clientsResult.clients)
        }
        if (anniversariesResult.success && anniversariesResult.anniversaries) {
          setAnniversaries(anniversariesResult.anniversaries as unknown as Anniversary[])
        }
      } catch (e) {
        console.error("Error loading data:", e)
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [search, engagementFilter])

  // Load timeline when client selected
  useEffect(() => {
    async function loadTimeline() {
      if (!selectedClient) {
        setTouchpointTimeline([])
        return
      }
      setLoadingTimeline(true)
      try {
        const result = await getTouchpointTimeline(selectedClient.id)
        if (result.success && result.touchpoints) {
          setTouchpointTimeline(result.touchpoints)
        }
      } catch (e) {
        console.error("Error loading timeline:", e)
      } finally {
        setLoadingTimeline(false)
      }
    }
    loadTimeline()
  }, [selectedClient])

  // Stats
  const totalClients = clients.length
  const champions = sphereScores?.tiers?.champions?.length || clients.filter(c => (c.client_engagement_scores?.[0]?.engagement_score || 0) >= 70).length
  const highReferral = clients.filter(c => (c.client_engagement_scores?.[0]?.referral_potential_score || 0) >= 75).length
  const cooling = sphereScores?.tiers?.cooling?.length || clients.filter(c => {
    const score = c.client_engagement_scores?.[0]?.engagement_score || 0
    return score >= 30 && score < 50
  }).length
  const atRisk = sphereScores?.tiers?.atRisk?.length || clients.filter(c => {
    const days = getDaysSinceContact(c.client_engagement_scores?.[0]?.last_touchpoint_date)
    return days === null || days > 90
  }).length

  // Handlers
  function handleLogTouchpoint() {
    if (!selectedClient) return
    startTransition(async () => {
      const result = await logTouchpoint({
        contactId: selectedClient.id,
        touchpointType,
        notes: touchpointNotes,
      })
      if (result.success) {
        setShowLogTouchpoint(false)
        setTouchpointNotes("")
        const timelineResult = await getTouchpointTimeline(selectedClient.id)
        if (timelineResult.success && timelineResult.touchpoints) {
          setTouchpointTimeline(timelineResult.touchpoints)
        }
        toast.success("Touchpoint logged")
      }
    })
  }

  async function handleGenerateTouchpoint(contactId: string, type: 'anniversary' | 'birthday' | 'check_in' | 'market_update' | 'holiday' | 'referral_ask', title?: string) {
    setTouchpointContactId(contactId)
    startTransition(async () => {
      const result = await generateTouchpoint({ contactId, touchpointType: type })
      const genMessage = result.success && 'data' in result && result.data ? (result.data as any).message : undefined
      if (genMessage) {
        setTouchpointDraft(genMessage)
        setTouchpointDialogTitle(title || `AI ${type.replace('_', ' ')} Message`)
        setTouchpointDialogOpen(true)
      }
    })
  }

  async function handleOptimizeReferral(contactId: string) {
    startTransition(async () => {
      const result = await optimizeReferralAsk(contactId)
      const refMessage = result.success && 'data' in result && result.data ? (result.data as any).message ?? (result.data as any).askScript : undefined
      if (refMessage) {
        setTouchpointDraft(refMessage)
        setTouchpointDialogTitle("Optimized Referral Ask")
        setTouchpointDialogOpen(true)
      }
    })
  }

  function openReferralScriptDialog(contactId: string) {
    setReferralScriptContactId(contactId)
    setReferralScriptChannel("email")
    setReferralScriptOpen(true)
  }

  async function handleGenerateReferralScript() {
    if (!referralScriptContactId || !currentUserId) return
    setReferralScriptOpen(false)
    startTransition(async () => {
      const result = await generateReferralRequest({
        contactId: referralScriptContactId,
        agentId: currentUserId,
        channel: referralScriptChannel,
      })
      if (result.success && (result as any).referralRequest) {
        setTouchpointDraft((result as any).referralRequest)
        setTouchpointDialogTitle(
          referralScriptChannel === "email" ? "Referral Ask — Email Script"
          : referralScriptChannel === "text" ? "Referral Ask — Text Message"
          : "Referral Ask — Call Script"
        )
        setTouchpointDialogOpen(true)
      } else {
        toast.error((result as any).error ?? "Failed to generate referral script")
      }
    })
  }

  async function handleScheduleTouchpoint() {
    if (!scheduleContactId || !scheduleDate) return
    const result = await scheduleTouchpoint({
      contactId: scheduleContactId,
      touchpointType: scheduleType,
      scheduledFor: new Date(scheduleDate).toISOString(),
      notes: scheduleNotes || undefined,
    })
    if (result.success) {
      toast.success(`Touchpoint scheduled for ${new Date(scheduleDate).toLocaleDateString()}`)
      setScheduleDialogOpen(false)
      setScheduleDate("")
      setScheduleNotes("")
      setScheduleContactId(null)
    } else {
      toast.error("Failed to schedule touchpoint")
    }
  }

  async function handleSendMarketUpdate(contactId: string, firstName: string) {
    startTransition(async () => {
      // Generate a market update draft then immediately send it to the portal
      const draftResult = await generateTouchpoint({ contactId, touchpointType: "market_update" })
      const mktMessage = draftResult.success && 'data' in draftResult && draftResult.data ? (draftResult.data as any).message : undefined
      if (mktMessage) {
        const sendResult = await sendMarketUpdate({ contactId, messageBody: mktMessage })
        if (sendResult.success) {
          toast.success(`Market update sent to ${firstName}`)
        } else {
          toast.error("Failed to send market update")
        }
      } else {
        toast.error("Failed to generate market update")
      }
    })
  }

  async function handleGetAISuggestion(contactId: string) {
    setAiSuggestionLoading(contactId)
    try {
      const result = await getAISuggestedTouchpoint(contactId)
      if (result.success && result.suggestion) {
        setAiSuggestions((prev) => ({ ...prev, [contactId]: result.suggestion }))
      }
    } finally {
      setAiSuggestionLoading(null)
    }
  }

  async function handleScoreSphere() {
    startTransition(async () => {
      const result = await scoreSphereEngagement()
      if (result.success) {
        setSphereScores(result)
        toast.success("Sphere analyzed")
      }
    })
  }

  async function handleSegmentSphere() {
    startTransition(async () => {
      const result = await segmentSphere()
      if (result.success) {
        setSphereSegments(result)
        toast.success("Sphere segmented")
      }
    })
  }

  async function handleLoadMilestones() {
    startTransition(async () => {
      const result = await getUpcomingMilestones(30)
      if (result.success && 'data' in result && result.data) {
        const milestonesData = result.data as any[]
        setMilestones(milestonesData)
        toast.success(`Found ${milestonesData.length} milestones`)
      }
    })
  }

  async function handleLoadLifeSignals() {
    startTransition(async () => {
      const result = await getLifeChangeSignals(7)
      if (Array.isArray(result)) {
        setLifeSignals(result)
        toast.success(`Found ${result.length} life signals`)
      }
    })
  }

  async function handleFindReferrals() {
    startTransition(async () => {
      const result = await findReferralOpportunities()
      if (result.success && result.opportunities) {
        setReferralOpportunities(result.opportunities)
        toast.success(`Found ${result.opportunities.length} referral opportunities`)
      }
    })
  }

  async function handleLoadReferralPipeline() {
    startTransition(async () => {
      try {
        const result = await loadReferralPipelineAction()
        if (result.success && (result as any).data?.referrals) {
          setReferralPipeline((result as any).data.referrals)
          toast.success(`Loaded ${(result as any).data.referrals.length} referral${(result as any).data.referrals.length !== 1 ? "s" : ""}`)
        } else if (!result.success) {
          toast.error((result as any).error ?? "Failed to load referral pipeline")
        } else {
          setReferralPipeline([])
          toast.info("No referrals found in pipeline")
        }
      } catch {
        toast.error("Failed to load referral pipeline")
      }
    })
  }

  async function handleNurtureReferral(referralId: string) {
    if (!currentAgentId) return
    startTransition(async () => {
      try {
        const result = await nurturePendingReferral({ referralId, agentId: currentAgentId })
        if (result.success) {
          setNurtureResults(prev => ({ ...prev, [referralId]: result.nurtureStrategy }))
          toast.success("AI nurture strategy generated")
        } else {
          toast.error(result.error ?? "Failed to generate nurture strategy")
        }
      } catch {
        toast.error("Failed to generate nurture strategy")
      }
    })
  }

  async function handleRecommendReward(referralId: string) {
    if (!currentAgentId) return
    startTransition(async () => {
      try {
        const result = await recommendReferralReward({ referralId, agentId: currentAgentId })
        if (result.success) {
          setRewardResults(prev => ({ ...prev, [referralId]: result.rewardRecommendation }))
          toast.success("AI reward recommendation ready")
        } else {
          toast.error(result.error ?? "Failed to generate reward recommendation")
        }
      } catch {
        toast.error("Failed to generate reward recommendation")
      }
    })
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text)
    toast.success("Copied to clipboard")
  }

  // Filter clients
  const filteredClients = clients.filter(client => {
    if (engagementFilter === "all") return true
    const score = client.client_engagement_scores?.[0]?.engagement_score || 0
    if (engagementFilter === "hot") return score >= 70
    if (engagementFilter === "warm") return score >= 40 && score < 70
    if (engagementFilter === "cold") return score < 40
    return true
  })

  // Priority tab derived lists — use real schema column names
  // last_interaction is the real column; last_touchpoint_date degrades to undefined gracefully
  function getDaysSinceContactReal(client: PastClient): number | null {
    const date = client.client_engagement_scores?.[0]?.last_touchpoint_date
      ?? (client.client_engagement_scores?.[0] as any)?.last_interaction
    return date ? getDaysSinceContact(date) : null
  }

  const needsTouchNow = filteredClients.filter(c => {
    const days = getDaysSinceContactReal(c)
    return days === null || days > 30
  })

  const hasAnniversaryThisMonth = filteredClients.filter(c => {
    const closeDate = c.transactions?.[0]?.actual_close_date
    if (!closeDate) return false
    return new Date(closeDate).getMonth() === new Date().getMonth()
  })

  const hasReferralOpportunity = filteredClients.filter(c => {
    // Use real schema: score column (no referral_likelihood in DB)
    const score = (c.client_engagement_scores?.[0] as any)?.score
      ?? c.client_engagement_scores?.[0]?.engagement_score
      ?? 0
    return score >= 70
  })

  function getSuggestedAction(client: PastClient, daysSince: number | null): string {
    if (!daysSince || daysSince > 365) return "Schedule annual check-in call"
    const closeDate = client.transactions?.[0]?.actual_close_date
      ? new Date(client.transactions[0].actual_close_date) : null
    const isAnniversaryMonth = closeDate && closeDate.getMonth() === new Date().getMonth()
    if (isAnniversaryMonth) return "Send home anniversary message"
    const score = (client.client_engagement_scores?.[0] as any)?.score
      ?? client.client_engagement_scores?.[0]?.engagement_score
      ?? 0
    if (score >= 70) return "Ask for a referral"
    if (daysSince > 90) return "Send market update for their neighborhood"
    return "Quick check-in message"
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Sphere of Influence</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Your relationship intelligence engine
            </p>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search by name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 w-64"
            />
          </div>
        </div>

        {/* Main Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="w-full grid grid-cols-6">
            <TabsTrigger value="feed" className="flex items-center gap-2">
              <Heart className="w-4 h-4" />
              <span className="hidden sm:inline">Relationship Feed</span>
            </TabsTrigger>
            <TabsTrigger value="intelligence" className="flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              <span className="hidden sm:inline">Sphere Intelligence</span>
            </TabsTrigger>
            <TabsTrigger value="campaigns" className="flex items-center gap-2">
              <Send className="w-4 h-4" />
              <span className="hidden sm:inline">Campaigns &amp; Gifting</span>
            </TabsTrigger>
            <TabsTrigger value="radar" className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4" />
              <span className="hidden sm:inline">Opportunity Radar</span>
            </TabsTrigger>
            <TabsTrigger value="portal" className="flex items-center gap-2">
              <ExternalLink className="w-4 h-4" />
              <span className="hidden sm:inline">Portal Actions</span>
            </TabsTrigger>
            <TabsTrigger value="reputation" className="flex items-center gap-2">
              <Star className="w-4 h-4" />
              <span className="hidden sm:inline">Reputation</span>
            </TabsTrigger>
          </TabsList>

          {/* TAB 1: Relationship Feed */}
          <TabsContent value="feed" className="space-y-6">
            {/* Anniversaries Strip */}
            {anniversaries.length > 0 && (
              <Card className="border-purple-200 bg-purple-50/30">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Home className="w-5 h-5 text-purple-600" />
                    Upcoming Home Anniversaries
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-4 overflow-x-auto pb-2">
                    {anniversaries.map((ann) => {
                      const anniversary = new Date(ann.actual_close_date)
                      const thisYear = new Date()
                      anniversary.setFullYear(thisYear.getFullYear())
                      const yearsAgo = thisYear.getFullYear() - new Date(ann.actual_close_date).getFullYear()

                      return (
                        <div
                          key={ann.id}
                          className="flex-shrink-0 p-4 bg-background rounded-lg border min-w-[280px]"
                        >
                          <div className="flex items-start gap-3">
                            <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center shrink-0">
                              <Home className="w-5 h-5 text-purple-600" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm">
                                {ann.contacts?.first_name}'s {yearsAgo}-Year Home Anniversary
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {anniversary.toLocaleDateString()}
                              </p>
                              <Button
                                size="sm"
                                variant="outline"
                                className="mt-2"
                                onClick={() => handleGenerateTouchpoint(ann.contacts.id, 'anniversary', 'Anniversary Celebration')}
                                disabled={isPending}
                              >
                                {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
                                Send Celebration Message
                              </Button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Priority Sub-Tabs */}
            <Tabs value={priorityTab} onValueChange={setPriorityTab}>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <TabsList className="h-auto flex-wrap">
                  <TabsTrigger value="all" className="text-xs">
                    All Clients
                    <span className="ml-1.5 text-xs text-muted-foreground">({filteredClients.length})</span>
                  </TabsTrigger>
                  <TabsTrigger value="needs_touch" className="text-xs">
                    Needs Touch
                    {needsTouchNow.length > 0 && (
                      <Badge className="ml-1.5 bg-red-100 text-red-700 border-red-200 text-[10px] px-1.5 py-0 h-4">
                        {needsTouchNow.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="anniversary" className="text-xs">
                    Anniversaries
                    {hasAnniversaryThisMonth.length > 0 && (
                      <Badge className="ml-1.5 bg-purple-100 text-purple-700 border-purple-200 text-[10px] px-1.5 py-0 h-4">
                        {hasAnniversaryThisMonth.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="referral" className="text-xs">
                    Referral Ready
                    {hasReferralOpportunity.length > 0 && (
                      <Badge className="ml-1.5 bg-green-100 text-green-700 border-green-200 text-[10px] px-1.5 py-0 h-4">
                        {hasReferralOpportunity.length}
                      </Badge>
                    )}
                  </TabsTrigger>
                </TabsList>
                <div className="flex items-center gap-3 ml-auto">
                  <input
                    type="checkbox"
                    aria-label="Select all clients"
                    checked={filteredClients.length > 0 && selectedIds.size === filteredClients.length}
                    ref={(el) => {
                      if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < filteredClients.length
                    }}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-border accent-foreground cursor-pointer"
                  />
                  <Select value={engagementFilter} onValueChange={setEngagementFilter}>
                    <SelectTrigger className="w-32">
                      <SelectValue placeholder="Engagement" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="hot">Hot</SelectItem>
                      <SelectItem value="warm">Warm</SelectItem>
                      <SelectItem value="cold">Cold</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

            {/* Bulk action bar */}
            {selectedIds.size > 0 && (
              <div className="flex items-center gap-3 p-3 rounded-lg border border-foreground/10 bg-muted/40">
                <span className="text-sm font-medium">{selectedIds.size} selected</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={handleBulkMarketUpdate}
                  disabled={bulkSending}
                >
                  {bulkSending ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      {bulkProgress ? `Sending ${bulkProgress.done}/${bulkProgress.total}...` : "Sending..."}
                    </>
                  ) : (
                    <>
                      <TrendingUp className="w-3.5 h-3.5" />
                      Send Market Update to Selected ({selectedIds.size})
                    </>
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => setSelectedIds(new Set())}
                  disabled={bulkSending}
                >
                  Clear
                </Button>
              </div>
            )}

            {/* Client List — respects priority sub-tab */}
            {(() => {
              const activeList =
                priorityTab === "needs_touch" ? needsTouchNow :
                priorityTab === "anniversary" ? hasAnniversaryThisMonth :
                priorityTab === "referral" ? hasReferralOpportunity :
                filteredClients
              return (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 space-y-3">
                {activeList.map((client) => {
                  const engagementScore = client.client_engagement_scores?.[0]?.engagement_score || 0
                  const badge = getEngagementBadge(engagementScore)
                  const lastTouchpoint = client.client_engagement_scores?.[0]?.last_touchpoint_date
                    ?? (client.client_engagement_scores?.[0] as any)?.last_interaction
                  const daysSince = getDaysSinceContact(lastTouchpoint)
                  const transaction = client.transactions?.[0]
                  const isSelected = selectedClient?.id === client.id
                  const suggestedAction = getSuggestedAction(client, daysSince)

                  const daysSinceClass =
                    daysSince === null ? "text-red-600" :
                    daysSince > 60 ? "text-red-600" :
                    daysSince > 30 ? "text-amber-600" : "text-green-600"

                  const daysSinceLabel =
                    daysSince === null ? "Never contacted" :
                    daysSince === 0 ? "Today" :
                    daysSince === 1 ? "Yesterday" :
                    `${daysSince} days ago`

                  return (
                    <Card
                      key={client.id}
                      onClick={() => setSelectedClient(client)}
                      className={`cursor-pointer transition-all hover:shadow-md ${isSelected ? "ring-2 ring-primary" : ""}`}
                    >
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-4">
                          <input
                            type="checkbox"
                            aria-label={`Select ${client.first_name} ${client.last_name}`}
                            checked={selectedIds.has(client.id)}
                            onChange={() => toggleSelect(client.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="mt-1 h-4 w-4 rounded border-border accent-foreground cursor-pointer shrink-0"
                          />
                          <div className="flex items-start gap-3 flex-1 min-w-0">
                            <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
                              <User className="w-5 h-5 text-slate-500" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <h3 className="font-semibold truncate">
                                  {client.first_name} {client.last_name}
                                </h3>
                                <Badge variant="outline" className={badge.className}>
                                  {badge.label}
                                </Badge>
                              </div>
                              {transaction && (
                                <p className="text-xs text-muted-foreground truncate">
                                  {transaction.property_address || "Address N/A"}
                                </p>
                              )}
                              <div className="flex items-center gap-3 mt-1">
                                <span className={`text-xs font-medium ${daysSinceClass}`}>
                                  {daysSinceLabel}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  &rarr; {suggestedAction}
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={(e) => { e.stopPropagation(); if (client.phone) window.location.href = `tel:${client.phone}` }}>
                              <Phone className="w-4 h-4" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={(e) => { e.stopPropagation(); if (client.email) window.location.href = `mailto:${client.email}` }}>
                              <Mail className="w-4 h-4" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={(e) => { e.stopPropagation(); handleGenerateTouchpoint(client.id, 'check_in', 'AI Suggested Touch') }}>
                              <Sparkles className="w-4 h-4" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={(e) => { e.stopPropagation(); setSelectedClient(client); setShowLogTouchpoint(true) }}>
                              <Calendar className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>

                        {/* Second row: AI suggest + Schedule + Market Update */}
                        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-muted" onClick={(e) => e.stopPropagation()}>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs gap-1 text-muted-foreground"
                            onClick={() => handleGetAISuggestion(client.id)}
                            disabled={aiSuggestionLoading === client.id}
                          >
                            {aiSuggestionLoading === client.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <BrainCircuit className="w-3 h-3" />
                            )}
                            AI Suggest
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs gap-1 text-muted-foreground"
                            onClick={() => {
                              setScheduleContactId(client.id)
                              setScheduleContactName(`${client.first_name} ${client.last_name}`)
                              setScheduleDialogOpen(true)
                            }}
                          >
                            <CalendarPlus className="w-3 h-3" />
                            Schedule
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs gap-1 text-muted-foreground"
                            onClick={() => handleSendMarketUpdate(client.id, client.first_name)}
                            disabled={isPending}
                          >
                            <TrendingUp className="w-3 h-3" />
                            Market Update
                          </Button>
                        </div>

                        {/* Inline AI suggestion panel */}
                        {aiSuggestions[client.id] && (
                          <div className="mt-2 p-2.5 bg-purple-50 rounded-md border border-purple-100" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-1.5 mb-1">
                              <CheckCircle2 className="w-3.5 h-3.5 text-purple-600 shrink-0" />
                              <p className="text-xs font-medium text-purple-800 capitalize">
                                AI Recommends: {String(aiSuggestions[client.id].type || "").replace(/_/g, " ")}
                              </p>
                            </div>
                            <p className="text-xs text-purple-700">{aiSuggestions[client.id].reason}</p>
                            {aiSuggestions[client.id].type && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="mt-2 h-6 text-xs gap-1 border-purple-200 text-purple-800 hover:bg-purple-100"
                                onClick={() => {
                                  const suggestionType = aiSuggestions[client.id].type as string
                                  // Pre-fill the schedule dialog with the AI-suggested type
                                  // Map newsletter to check_in since it's not a scheduled_touchpoints type
                                  const mappedType = ["call","email","text","meeting","market_update","check_in","anniversary"].includes(suggestionType)
                                    ? suggestionType
                                    : "check_in"
                                  setScheduleType(mappedType)
                                  // Default to 7 days from today as suggested date
                                  const suggested = new Date()
                                  suggested.setDate(suggested.getDate() + 7)
                                  setScheduleDate(suggested.toISOString().split("T")[0])
                                  setScheduleNotes(aiSuggestions[client.id].reason ?? "")
                                  setScheduleContactId(client.id)
                                  setScheduleContactName(`${client.first_name} ${client.last_name}`)
                                  setScheduleDialogOpen(true)
                                }}
                              >
                                <CalendarPlus className="w-3 h-3" />
                                Schedule It
                              </Button>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )
                })}
              </div>

              {/* Detail Panel */}
              <div className="space-y-4">
                {selectedClient ? (
                  <>
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base">
                          {selectedClient.first_name} {selectedClient.last_name}
                        </CardTitle>
                        <CardDescription>Touchpoint Timeline</CardDescription>
                      </CardHeader>
                      <CardContent>
                        {loadingTimeline ? (
                          <div className="flex justify-center py-4">
                            <Loader2 className="w-6 h-6 animate-spin" />
                          </div>
                        ) : touchpointTimeline.length === 0 ? (
                          <p className="text-sm text-muted-foreground text-center py-4">
                            No touchpoints yet
                          </p>
                        ) : (
                          <div className="space-y-3">
                            {touchpointTimeline.slice(0, 5).map((tp) => (
                              <div key={tp.id} className="flex items-start gap-3">
                                <div className="p-2 bg-slate-100 rounded-full">
                                  {getTouchpointIcon(tp.touchpoint_type)}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium capitalize">
                                    {tp.touchpoint_type.replace('_', ' ')}
                                  </p>
                                  {tp.notes && (
                                    <p className="text-xs text-muted-foreground line-clamp-2">
                                      {tp.notes}
                                    </p>
                                  )}
                                  <p className="text-xs text-muted-foreground mt-1">
                                    {new Date(tp.sent_at).toLocaleDateString()}
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardContent className="p-4">
                        <Button
                          className="w-full"
                          onClick={() => handleGenerateTouchpoint(selectedClient.id, 'check_in')}
                          disabled={isPending}
                        >
                          {isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Sparkles className="w-4 h-4 mr-2" />}
                          AI Suggested Touch
                        </Button>
                      </CardContent>
                    </Card>
                  </>
                ) : (
                  <Card>
                    <CardContent className="p-8 text-center text-muted-foreground">
                      <User className="w-12 h-12 mx-auto mb-4 opacity-30" />
                      <p>Select a client to view details</p>
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
              )
            })()}
            </Tabs>
          </TabsContent>

          {/* TAB 2: Sphere Intelligence */}
          <TabsContent value="intelligence" className="space-y-6">
            <div className="flex flex-wrap gap-3">
              <Button onClick={handleScoreSphere} disabled={isPending}>
                {isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Sparkles className="w-4 h-4 mr-2" />}
                Analyze My Sphere
              </Button>
              <Button variant="outline" onClick={handleSegmentSphere} disabled={isPending}>
                <Users className="w-4 h-4 mr-2" />
                Segment My Sphere
              </Button>
              <Button variant="outline" onClick={handleLoadMilestones} disabled={isPending}>
                <Calendar className="w-4 h-4 mr-2" />
                Load Milestones
              </Button>
            </div>

            {/* Tier Cards */}
            {sphereScores && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card className="bg-green-50 border-green-200">
                  <CardContent className="p-4">
                    <p className="text-sm font-medium text-green-700">Champions</p>
                    <p className="text-2xl font-bold text-green-800">{sphereScores.tiers?.champions?.length || 0}</p>
                  </CardContent>
                </Card>
                <Card className="bg-blue-50 border-blue-200">
                  <CardContent className="p-4">
                    <p className="text-sm font-medium text-blue-700">Engaged</p>
                    <p className="text-2xl font-bold text-blue-800">{sphereScores.tiers?.engaged?.length || 0}</p>
                  </CardContent>
                </Card>
                <Card className="bg-amber-50 border-amber-200">
                  <CardContent className="p-4">
                    <p className="text-sm font-medium text-amber-700">Cooling</p>
                    <p className="text-2xl font-bold text-amber-800">{sphereScores.tiers?.cooling?.length || 0}</p>
                  </CardContent>
                </Card>
                <Card className="bg-red-50 border-red-200">
                  <CardContent className="p-4">
                    <p className="text-sm font-medium text-red-700">At Risk</p>
                    <p className="text-2xl font-bold text-red-800">{sphereScores.tiers?.atRisk?.length || 0}</p>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Segments */}
            {sphereSegments && sphereSegments.segments && (
              <div className="space-y-4">
                <h3 className="font-semibold">Segments</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {sphereSegments.segments.map((seg: any, i: number) => (
                    <Card key={i}>
                      <CardContent className="p-4">
                        <p className="font-medium">{seg.name}</p>
                        <p className="text-sm text-muted-foreground">{seg.count} contacts</p>
                        <p className="text-xs text-muted-foreground mt-1">{seg.description}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Milestones */}
            {milestones.length > 0 && (
              <div className="space-y-4">
                <h3 className="font-semibold">Upcoming Milestones</h3>
                <div className="space-y-3">
                  {milestones.map((m: any, i: number) => (
                    <Card key={i}>
                      <CardContent className="p-4 flex items-center justify-between">
                        <div>
                          <p className="font-medium">{m.contactName}</p>
                          <p className="text-sm text-muted-foreground">{m.type}: {m.date}</p>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleGenerateTouchpoint(m.contactId, m.type === 'anniversary' ? 'anniversary' : 'birthday')}
                            disabled={isPending}
                          >
                            <Sparkles className="w-4 h-4 mr-1" />
                            AI Message
                          </Button>
                          {m.referralPotential === 'high' && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => openReferralScriptDialog(m.contactId)}
                                disabled={isPending}
                              >
                                <Sparkles className="w-4 h-4 mr-1" />
                                AI Script
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleOptimizeReferral(m.contactId)}
                                disabled={isPending}
                              >
                                <Gift className="w-4 h-4 mr-1" />
                                Ask Referral
                              </Button>
                            </>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </TabsContent>

          {/* TAB 3: Campaigns & Gifting */}
          <TabsContent value="campaigns" className="space-y-6">
            <CampaignsGiftingPanel
              brokerageId={currentBrokerageId}
              agentId={currentAgentId}
              contacts={clients.map((c) => ({
                id: c.id,
                first_name: c.first_name,
                last_name: c.last_name,
                email: c.email,
              }))}
            />
          </TabsContent>

          {/* TAB 4: Opportunity Radar */}
          <TabsContent value="radar" className="space-y-6">
            {/* Top Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card>
                <CardContent className="p-4 text-center">
                  <p className="text-2xl font-bold text-green-600">{champions}</p>
                  <p className="text-sm text-muted-foreground">Champions</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <p className="text-2xl font-bold text-purple-600">{highReferral}</p>
                  <p className="text-sm text-muted-foreground">High Referral</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <p className="text-2xl font-bold text-amber-600">{cooling}</p>
                  <p className="text-sm text-muted-foreground">Cooling</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4 text-center">
                  <p className="text-2xl font-bold text-red-600">{atRisk}</p>
                  <p className="text-sm text-muted-foreground">At Risk</p>
                </CardContent>
              </Card>
            </div>

            {/* Action Buttons */}
            <div className="flex flex-wrap gap-3">
              <Button onClick={handleLoadLifeSignals} disabled={isPending}>
                <RefreshCw className="w-4 h-4 mr-2" />
                Load Life Signals
              </Button>
              <Button variant="outline" onClick={handleFindReferrals} disabled={isPending}>
                <Zap className="w-4 h-4 mr-2" />
                Find Referral Opportunities
              </Button>
              <Button variant="outline" onClick={handleLoadReferralPipeline} disabled={isPending}>
                <RefreshCw className="w-4 h-4 mr-2" />
                Load Referral Pipeline
              </Button>
            </div>

            {/* Life Events Intelligence */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Life Events Intelligence</CardTitle>
                <CardDescription>Recent life changes detected in your sphere</CardDescription>
              </CardHeader>
              <CardContent>
                {lifeSignals.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    Life signals appear as they're discovered.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {lifeSignals.map((signal: any, i: number) => (
                      <div key={i} className="flex items-center justify-between p-3 rounded-lg border">
                        <div className="flex items-center gap-3">
                          <LifeSignalBadge signal={signal} />
                          <div>
                            <p className="font-medium text-sm">{signal.contactName}</p>
                            <p className="text-xs text-muted-foreground">{signal.type}</p>
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleGenerateTouchpoint(signal.contactId, 'check_in')}
                          disabled={isPending}
                        >
                          <Sparkles className="w-4 h-4 mr-1" />
                          Generate Check-In
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Referral Opportunities */}
            {referralOpportunities.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Referral Opportunities</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {referralOpportunities.map((opp: any, i: number) => (
                    <div key={i} className="flex items-center justify-between p-3 rounded-lg border">
                      <div>
                        <p className="font-medium text-sm">{opp.contactName}</p>
                        <p className="text-xs text-muted-foreground">{opp.reason}</p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openReferralScriptDialog(opp.contactId)}
                          disabled={isPending}
                        >
                          <Sparkles className="w-4 h-4 mr-1" />
                          AI Script
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleOptimizeReferral(opp.contactId)}
                          disabled={isPending}
                        >
                          <Gift className="w-4 h-4 mr-1" />
                          Ask
                        </Button>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Referral Pipeline — actual referral records with Nurture + Reward */}
            {referralPipeline.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Referral Pipeline</CardTitle>
                  <CardDescription>Active referrals — nurture and reward your best referrers</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {referralPipeline.map((ref: any) => (
                    <div key={ref.id} className="p-3 rounded-lg border space-y-2">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium text-sm">{ref.referral_name || "Unknown Referral"}</p>
                          <p className="text-xs text-muted-foreground capitalize">
                            Status: {ref.status?.replace(/_/g, " ")} · Source: {ref.referral_source || "direct"}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleNurtureReferral(ref.id)}
                            disabled={isPending}
                          >
                            <Sparkles className="w-3.5 h-3.5 mr-1" />
                            AI Nurture
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleRecommendReward(ref.id)}
                            disabled={isPending}
                          >
                            <Gift className="w-3.5 h-3.5 mr-1" />
                            Reward
                          </Button>
                        </div>
                      </div>
                      {nurtureResults[ref.id] && (
                        <div className="mt-2 p-2 rounded bg-blue-50 border border-blue-200 text-xs space-y-1">
                          <p className="font-medium text-blue-800">Next Action: {nurtureResults[ref.id].nextBestAction?.action}</p>
                          <p className="text-blue-700">{nurtureResults[ref.id].nextBestAction?.message}</p>
                          <p className="text-blue-600">Conversion probability: {Math.round((nurtureResults[ref.id].conversionProbability ?? 0) * 100)}%</p>
                        </div>
                      )}
                      {rewardResults[ref.id] && (
                        <div className="mt-2 p-2 rounded bg-green-50 border border-green-200 text-xs space-y-1">
                          <p className="font-medium text-green-800">
                            Recommended: {rewardResults[ref.id].recommendedReward?.specific} (${rewardResults[ref.id].recommendedReward?.value})
                          </p>
                          <p className="text-green-700">{rewardResults[ref.id].recommendedReward?.reasoning}</p>
                        </div>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* TAB 4: Portal Actions */}
          <TabsContent value="portal" className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">Portal Access</CardTitle>
                    <CardDescription>{clients.length} clients with portal access</CardDescription>
                  </div>
                  <Button variant="outline" onClick={() => setReachAllOpen(true)}>
                    Reach All
                  </Button>

                  {/* Reach All Dialog — creates real drafts in ai_message_drafts */}
                  <Dialog open={reachAllOpen} onOpenChange={setReachAllOpen}>
                    <DialogContent className="max-w-md">
                      <DialogHeader>
                        <DialogTitle>Send Market Update to All Lifetime Customers</DialogTitle>
                      </DialogHeader>
                      <div className="space-y-3 text-sm text-muted-foreground">
                        <p>This will save drafts in your inbox for review before sending.</p>
                        <p>
                          Creating drafts for{" "}
                          <span className="font-semibold text-foreground">{clients.length}</span> contacts
                        </p>
                        <div className="rounded-lg border bg-muted/40 px-4 py-3 text-foreground">
                          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">Subject preview</p>
                          <p>Market Update from your agent</p>
                        </div>
                        <div className="rounded-lg border bg-muted/40 px-4 py-3 text-foreground">
                          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1">Body preview</p>
                          <p className="text-xs leading-relaxed">Hi [First Name], here&apos;s what&apos;s happening in your market...</p>
                        </div>
                      </div>
                      <DialogFooter className="mt-2">
                        <Button
                          variant="outline"
                          onClick={() => setReachAllOpen(false)}
                          disabled={bulkSending}
                        >
                          Cancel
                        </Button>
                        <Button
                          disabled={bulkSending || clients.length === 0}
                          onClick={async () => {
                            setBulkSending(true)
                            try {
                              const supabase = createClient()
                              const { data: { user } } = await supabase.auth.getUser()
                              if (!user) { toast.error("Not authenticated"); return }

                              const { data: userRow } = await supabase
                                .from("users")
                                .select("brokerage_id, first_name, last_name")
                                .eq("id", user.id)
                                .single()

                              const agentName = userRow
                                ? `${userRow.first_name ?? ""} ${userRow.last_name ?? ""}`.trim()
                                : "your agent"

                              const inserts = clients
                                .filter((c) => c.email)
                                .map((c) => ({
                                  agent_user_id: user.id,
                                  brokerage_id: userRow?.brokerage_id ?? null,
                                  contact_id: c.id,
                                  channel: "email",
                                  draft_subject: `Market Update from ${agentName}`,
                                  draft_body: `Hi ${c.first_name}, here's what's happening in your market...`,
                                  status: "pending",
                                  trigger_event: "bulk_past_client_reach",
                                }))

                              const { error } = await supabase.from("ai_message_drafts").insert(inserts)
                              if (error) throw error

                              toast.success(`${inserts.length} drafts created — review in Communications`)
                              setReachAllOpen(false)
                              router.push("/dashboard/communications/inbox")
                            } catch (err: any) {
                              toast.error(err.message || "Failed to create drafts")
                            } finally {
                              setBulkSending(false)
                            }
                          }}
                        >
                          {bulkSending ? (
                            <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creating drafts...</>
                          ) : (
                            "Create Drafts"
                          )}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {clients.slice(0, 10).map((client) => (
                  <div key={client.id} className="flex items-center justify-between p-3 rounded-lg border">
                    <div>
                      <p className="font-medium text-sm">{client.first_name} {client.last_name}</p>
                      <p className="text-xs text-muted-foreground">{client.email}</p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" asChild>
                        <a href={`/portal/${client.id}`} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="w-4 h-4 mr-1" />
                          Open Portal
                        </a>
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleGenerateTouchpoint(client.id, 'check_in', 'Send Message')}
                        disabled={isPending}
                      >
                        <Send className="w-4 h-4 mr-1" />
                        Message
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleOptimizeReferral(client.id)}
                        disabled={isPending}
                      >
                        <Gift className="w-4 h-4 mr-1" />
                        Referral
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleGenerateTouchpoint(client.id, 'market_update', 'Market Update')}
                        disabled={isPending}
                      >
                        <TrendingUp className="w-4 h-4 mr-1" />
                        Update
                      </Button>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>

          {/* TAB 5: Reputation */}
          <TabsContent value="reputation">
            <ReputationPanel
              agentId={currentAgentId}
              clients={clients}
              reviews={[]}
              recentClosings={clients.filter(c => c.transactions?.[0]?.actual_close_date).map(c => ({
                id: c.id,
                actual_close_date: c.transactions[0].actual_close_date,
                property_address: c.transactions[0].property_address,
                contacts: { first_name: c.first_name, last_name: c.last_name },
              }))}
            />
          </TabsContent>
        </Tabs>

        {/* Shared Touchpoint Draft Dialog */}
        <Dialog open={touchpointDialogOpen} onOpenChange={setTouchpointDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{touchpointDialogTitle}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Textarea
                value={touchpointDraft || ""}
                onChange={(e) => setTouchpointDraft(e.target.value)}
                rows={6}
                className="resize-none"
              />
            </div>
            <DialogFooter className="flex-wrap gap-2">
              <Button variant="outline" onClick={() => copyToClipboard(touchpointDraft || "")}>
                <Copy className="w-4 h-4 mr-2" />
                Copy
              </Button>
              {touchpointDialogTitle.toLowerCase().includes("market update") && touchpointContactId && (
                <Button
                  variant="default"
                  onClick={async () => {
                    if (!touchpointContactId || !touchpointDraft) return
                    const clientName = clients.find(c => c.id === touchpointContactId)?.first_name || "client"
                    const sendResult = await sendMarketUpdate({ contactId: touchpointContactId, messageBody: touchpointDraft })
                    if (sendResult.success) {
                      toast.success(`Market update sent to ${clientName}`)
                      setTouchpointDialogOpen(false)
                    } else {
                      toast.error("Failed to send market update")
                    }
                  }}
                  disabled={isPending}
                >
                  <Send className="w-4 h-4 mr-2" />
                  Send to Portal
                </Button>
              )}
              <Button variant="outline" onClick={() => setTouchpointDialogOpen(false)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Schedule Touchpoint Dialog */}
        <Dialog open={scheduleDialogOpen} onOpenChange={setScheduleDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Schedule Next Touchpoint{scheduleContactName ? ` — ${scheduleContactName}` : ""}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Select value={scheduleType} onValueChange={setScheduleType}>
                <SelectTrigger>
                  <SelectValue placeholder="Touchpoint Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="call">Phone Call</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="text">Text Message</SelectItem>
                  <SelectItem value="meeting">In-Person Meeting</SelectItem>
                  <SelectItem value="market_update">Market Update</SelectItem>
                  <SelectItem value="check_in">Check In</SelectItem>
                  <SelectItem value="anniversary">Anniversary</SelectItem>
                </SelectContent>
              </Select>
              <div className="space-y-1">
                <label className="text-sm font-medium">Scheduled Date</label>
                <input
                  type="date"
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={scheduleDate}
                  min={new Date().toISOString().split("T")[0]}
                  onChange={(e) => setScheduleDate(e.target.value)}
                />
              </div>
              <Textarea
                placeholder="Notes (optional)"
                value={scheduleNotes}
                onChange={(e) => setScheduleNotes(e.target.value)}
                rows={2}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setScheduleDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleScheduleTouchpoint} disabled={!scheduleDate}>
                <CalendarPlus className="w-4 h-4 mr-2" />
                Schedule Touchpoint
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Referral Script Channel Selector Dialog */}
        <Dialog open={referralScriptOpen} onOpenChange={setReferralScriptOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Generate Referral Ask Script</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <p className="text-sm text-muted-foreground">
                AI will write a personalized script for asking this contact for a referral.
              </p>
              <div className="space-y-1">
                <label className="text-sm font-medium">Channel</label>
                <Select
                  value={referralScriptChannel}
                  onValueChange={(v) => setReferralScriptChannel(v as "email" | "text" | "call_script")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="text">Text Message</SelectItem>
                    <SelectItem value="call_script">Call Script</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setReferralScriptOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleGenerateReferralScript} disabled={isPending}>
                {isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Sparkles className="w-4 h-4 mr-2" />}
                Generate Script
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Log Touchpoint Dialog */}
        <Dialog open={showLogTouchpoint} onOpenChange={setShowLogTouchpoint}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Log Touchpoint</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Select value={touchpointType} onValueChange={setTouchpointType}>
                <SelectTrigger>
                  <SelectValue placeholder="Touchpoint Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="call">Phone Call</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="text">Text Message</SelectItem>
                  <SelectItem value="meeting">In-Person Meeting</SelectItem>
                  <SelectItem value="market_update">Market Update</SelectItem>
                  <SelectItem value="check_in">Check In</SelectItem>
                </SelectContent>
              </Select>
              <Textarea
                placeholder="Notes (optional)"
                value={touchpointNotes}
                onChange={(e) => setTouchpointNotes(e.target.value)}
                rows={3}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowLogTouchpoint(false)}>
                Cancel
              </Button>
              <Button onClick={handleLogTouchpoint} disabled={isPending}>
                {isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Log Touchpoint
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
