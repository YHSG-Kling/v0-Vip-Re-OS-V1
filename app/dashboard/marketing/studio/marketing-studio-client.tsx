"use client"

import { useState, useEffect, useMemo } from "react"
import { useToast } from "@/hooks/use-toast"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { format } from "date-fns"
import {
  LayoutDashboard,
  Megaphone,
  Image,
  Calendar as CalendarIcon,
  MessageSquare,
  CheckSquare,
  QrCode,
  Plus,
  Search,
  Filter,
  Loader2,
  Play,
  Pause,
  CheckCircle,
  Clock,
  AlertCircle,
  TrendingUp,
  ChevronRight,
  Eye,
  Edit,
  Trash2,
  Link2,
  FileText,
  Video,
  Mail,
  Sparkles,
  Rocket,
  Mic,
  Send,
  ExternalLink,
  Newspaper,
  Truck,
} from "lucide-react"
import {
  getCampaigns,
  createCampaign,
  getCampaignById,
  transitionCampaignStatus,
  getAssets,
  createAsset,
  approveAsset,
  rejectAsset,
  getCalendarEvents,
  createCalendarEvent,
  updateCalendarEventStatus,
  getCampaignComments,
  addCampaignComment,
  getCampaignTasks,
  createCampaignTask,
  updateTaskStatus,
  getMarketingStudioDashboard,
  linkQrToAsset,
  getAssetQrLinks,
  type CampaignStatus,
  type AssetApprovalStatus,
  type VisibilityScope,
} from "@/app/actions/marketing-studio"
import { getMailCampaigns } from "@/app/actions/direct-mail"
import { createCampaignSequence, createSequenceStep, deleteCampaignSequence } from "@/app/actions/campaign-sequences"
import { getCampaignRegistry, registerCampaignSource, type ContentSourceItem } from "@/lib/marketing/campaign-registry"
import { listAvailableQrCodes, type QrLinkInfo } from "@/lib/marketing/qr-asset-linker"
import { predictPerformanceAction, getUserContextForPrediction } from "@/app/actions/content-prediction"
import { PredictionWidget, type PredictionData } from "@/app/components/prediction-widget"
import {
  CampaignLauncherPanel,
  CompetitorWatchPanel,
  RepurposeEnginePanel,
  CreativeVariationsPanel,
  PerformanceIntelligencePanel,
  PrelaunchPredictionPanel,
  SellerSafeMarketingSummary,
} from "./components/ad-os"

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface Campaign {
  id: string
  campaign_name: string
  campaign_type: string
  status: CampaignStatus
  listing_id?: string
  budget_total: number
  budget_spent: number
  scheduled_start_at?: string
  scheduled_end_at?: string
  launched_at?: string
  completed_at?: string
  created_at: string
  listing?: { address?: string; city?: string; list_price?: number }
  assets?: { count: number }[]
  tasks?: { count: number }[]
}

interface Asset {
  id: string
  asset_name: string
  asset_type: string
  approval_status: AssetApprovalStatus
  asset_url?: string
  thumbnail_url?: string
  preview_text?: string
  campaign_id?: string
  source_table?: string
  source_id?: string
  created_at: string
  qr_links?: QrLinkInfo[]
}

interface CalendarEvent {
  id: string
  title: string
  event_type: string
  channel?: string
  scheduled_at: string
  status: string
  notes?: string
  campaign?: { campaign_name: string }
}

interface Task {
  id: string
  title: string
  description?: string
  status: string
  due_at?: string
  assignee?: { first_name: string; last_name: string }
}

interface Comment {
  id: string
  comment_body: string
  created_at: string
  author?: { first_name: string; last_name: string }
}

interface DashboardData {
  campaignsByStatus: Record<string, number>
  totalCampaigns: number
  assetsByApproval: Record<string, number>
  totalAssets: number
  upcomingEvents: CalendarEvent[]
  pendingTasks: Task[]
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

interface MarketingStudioClientProps {
  userId?: string
  brokerageId?: string
  userRole?: string
  initialTab?: string
}

export default function MarketingStudioClient({ userId: userIdProp, brokerageId: brokerageIdProp, userRole, initialTab = "overview" }: MarketingStudioClientProps) {
  const { toast } = useToast()
  const [activeTab, setActiveTab] = useState(initialTab)
  const [isLoading, setIsLoading] = useState(true)
  const [dashboardError, setDashboardError] = useState<string | null>(null)
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([])
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null)
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(undefined)
  const [calendarViewDate, setCalendarViewDate] = useState(new Date())
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")

  const eventsByDate = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {}
    for (const ev of calendarEvents) {
      const key = format(new Date(ev.scheduled_at), "yyyy-MM-dd")
      if (!map[key]) map[key] = []
      map[key].push(ev)
    }
    return map
  }, [calendarEvents])

  // Dialog states
  const [isCreateCampaignOpen, setIsCreateCampaignOpen] = useState(false)
  const [isCreateAssetOpen, setIsCreateAssetOpen] = useState(false)
  const [isCreateEventOpen, setIsCreateEventOpen] = useState(false)
  const [isRegistryOpen, setIsRegistryOpen] = useState(false)
  const [isQrLinkOpen, setIsQrLinkOpen] = useState(false)
  const [selectedAssetForQr, setSelectedAssetForQr] = useState<string | null>(null)

  // Registry data
  const [registryItems, setRegistryItems] = useState<ContentSourceItem[]>([])
  const [availableQrCodes, setAvailableQrCodes] = useState<any[]>([])
  
  // Prediction widget state
  const [isPredictionDialogOpen, setIsPredictionDialogOpen] = useState(false)
  const [selectedAssetForPrediction, setSelectedAssetForPrediction] = useState<Asset | null>(null)
  const [currentPrediction, setCurrentPrediction] = useState<PredictionData | null>(null)
  const [isPredicting, setIsPredicting] = useState(false)

  // Newsletter state
  const [newsletterCampaigns, setNewsletterCampaigns] = useState<any[]>([])
  const [scheduledSends, setScheduledSends] = useState<any[]>([])
  const [subscriberCount, setSubscriberCount] = useState(0)
  const [newsletterTemplates, setNewsletterTemplates] = useState<any[]>([])
  const [localContent, setLocalContent] = useState<any[]>([])
  const [isNewsletterLoading, setIsNewsletterLoading] = useState(false)

  // Blog state
  const [blogPosts, setBlogPosts] = useState<any[]>([])
  const [isBlogLoading, setIsBlogLoading] = useState(false)

  // Video state
  const [videoProjects, setVideoProjects] = useState<any[]>([])
  const [isVideoLoading, setIsVideoLoading] = useState(false)

  // Podcast state
  const [podcastEpisodes, setPodcastEpisodes] = useState<any[]>([])
  const [isPodcastLoading, setIsPodcastLoading] = useState(false)

  // Direct Mail state
  const [mailCampaigns, setMailCampaigns] = useState<any[]>([])
  const [isMailLoading, setIsMailLoading] = useState(false)

  // Omnichannel sequence builder state
  type OmnichannelStepType = "email" | "sms" | "social_post" | "video" | "direct_mail" | "wait"
  interface OmnichannelStep {
    id: string
    type: OmnichannelStepType
    name: string
    delay_days: number
    delay_hours: number
    subject: string
    body: string
  }
  const [omnichannelName, setOmnichannelName] = useState("")
  const [omnichannelDescription, setOmnichannelDescription] = useState("")
  const [omnichannelSteps, setOmnichannelSteps] = useState<OmnichannelStep[]>([])
  const [isCreatingOmnichannel, setIsCreatingOmnichannel] = useState(false)
  const [omnichannelSuccess, setOmnichannelSuccess] = useState<string | null>(null)

  // Create newsletter dialog state (inline in studio)
  const [isCreateNewsletterOpen, setIsCreateNewsletterOpen] = useState(false)
  const [newNewsletter, setNewNewsletter] = useState({ campaignName: "", subjectLine: "", content: "" })
  const [isCreatingNewsletter, setIsCreatingNewsletter] = useState(false)

  // Create QR dialog state (inline in studio)
  const [isCreateQrOpen, setIsCreateQrOpen] = useState(false)
  const [newQr, setNewQr] = useState<{ label: string; targetUrl: string; purpose: "listing" | "open_house" | "general" | "campaign" | "lead_capture" }>({ label: "", targetUrl: "", purpose: "general" })
  const [isCreatingQr, setIsCreatingQr] = useState(false)
  const [qrError, setQrError] = useState<string | null>(null)

  // Ad OS state
  const [listings, setListings] = useState<Array<{ id: string; address: string; city: string; zip?: string; list_price?: number }>>([])
  const [agentId, setAgentId] = useState<string>(userIdProp ?? "")
  const [brokerageId, setBrokerageId] = useState<string>(brokerageIdProp ?? "")

  // Form states
  const [newCampaign, setNewCampaign] = useState({
    campaignName: "",
    campaignType: "brand" as const,
    budgetTotal: 0,
    scheduledStartAt: "",
    scheduledEndAt: "",
    visibilityScope: "agent" as VisibilityScope,
  })
  const [newAsset, setNewAsset] = useState<{
    assetName: string
    assetType: string
    campaignId: string
    previewText: string
    qrTargetUrl: string
  }>({
    assetName: "",
    assetType: "graphic",
    campaignId: "",
    previewText: "",
    qrTargetUrl: "",
  })
  const [newEvent, setNewEvent] = useState({
    title: "",
    eventType: "publish" as const,
    scheduledAt: "",
    campaignId: "",
    notes: "",
  })

  // ─── LOAD DATA ────────────────────────────────────────────────────────────────

  useEffect(() => {
    loadInitialData()
  }, [])

  useEffect(() => {
    if (activeTab === "campaigns")   loadCampaigns()
    if (activeTab === "assets")      loadAssets()
    if (activeTab === "calendar")    loadCalendarEvents()
    if (activeTab === "newsletters") loadNewsletterData()
    if (activeTab === "ad-os")       loadAdOsData()
    if (activeTab === "blog")        loadBlogData()
    if (activeTab === "video")       loadVideoData()
    if (activeTab === "podcast")     loadPodcastData()
    if (activeTab === "mail")        loadMailData()
  }, [activeTab, statusFilter])

  useEffect(() => {
    if (activeTab === "calendar") loadCalendarEvents()
  }, [calendarViewDate])

  async function loadInitialData() {
    setIsLoading(true)
    try {
      const [dashboardResult, campaignsResult] = await Promise.all([
        getMarketingStudioDashboard(),
        getCampaigns({ status: statusFilter !== "all" ? (statusFilter as CampaignStatus) : undefined }),
      ])
      if (dashboardResult.success) {
        setDashboard((dashboardResult as any).dashboard)
        setDashboardError(null)
      } else {
        setDashboardError((dashboardResult as any).error ?? "Failed to load dashboard metrics")
      }
      if (campaignsResult.success) setCampaigns(campaignsResult.campaigns)
    } catch (error) {
      console.error("[v0] Failed to load marketing studio data:", error)
    } finally {
      setIsLoading(false)
    }
  }

  async function loadCampaigns() {
    const result = await getCampaigns({
      status: statusFilter !== "all" ? (statusFilter as CampaignStatus) : undefined,
    })
    if (result.success) setCampaigns(result.campaigns)
  }

  async function loadAssets() {
    const result = await getAssets({
      approvalStatus: statusFilter !== "all" ? (statusFilter as AssetApprovalStatus) : undefined,
    })
    if (result.success) setAssets(result.assets)
  }

  async function loadCalendarEvents() {
    const start = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth(), 1)
    const end = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + 1, 0)
    const result = await getCalendarEvents({
      startDate: format(start, "yyyy-MM-dd"),
      endDate: format(end, "yyyy-MM-dd"),
    })
    if (result.success) setCalendarEvents(result.events)
  }

  async function loadRegistry() {
    const result = await getCampaignRegistry({ limit: 50 })
    if (result.success) setRegistryItems(result.items)
  }

  async function loadQrCodes() {
    const result = await listAvailableQrCodes()
    if (result.success) setAvailableQrCodes(result.qrCodes)
  }

  async function loadNewsletterData() {
    setIsNewsletterLoading(true)
    try {
      // Use server-resolved props first; fall back to action
      let resolvedBrokerageId = brokerageIdProp
      let resolvedUserId = userIdProp
      if (!resolvedBrokerageId || !resolvedUserId) {
        const userContext = await getUserContextForPrediction()
        if (!userContext.success || !userContext.brokerageId || !userContext.userId) {
          setNewsletterCampaigns([])
          setScheduledSends([])
          setSubscriberCount(0)
          setNewsletterTemplates([])
          setLocalContent([])
          return
        }
        resolvedBrokerageId = userContext.brokerageId
        resolvedUserId = userContext.userId
      }
      const { brokerageId, userId } = { brokerageId: resolvedBrokerageId, userId: resolvedUserId }

      const supabase = (await import("@/lib/supabase/client")).createClient()
      
      // Get newsletter campaigns
      const { data: campaigns } = await supabase
        .from("newsletter_campaigns")
        .select("*")
        .eq("brokerage_id", brokerageId)
        .order("created_at", { ascending: false })
        .limit(10)
      setNewsletterCampaigns(campaigns || [])

      // Get scheduled sends
      const { data: sends } = await supabase
        .from("newsletter_scheduled_sends")
        .select("*, newsletter:newsletter_campaigns(campaign_name)")
        .eq("agent_id", userId)
        .order("sent_at", { ascending: false })
        .limit(10)
      setScheduledSends(sends || [])

      // Get subscriber count
      const { count } = await supabase
        .from("newsletter_subscribers")
        .select("*", { count: "exact", head: true })
        .eq("brokerage_id", brokerageId)
        .eq("status", "subscribed")
      setSubscriberCount(count || 0)

      // Get templates
      const { data: templates } = await supabase
        .from("newsletter_brokers_templates")
        .select("*")
        .eq("brokerage_id", brokerageId)
        .limit(5)
      setNewsletterTemplates(templates || [])

      // Get local content
      const { data: content } = await supabase
        .from("newsletter_local_content")
        .select("*")
        .eq("brokerage_id", brokerageId)
        .order("created_at", { ascending: false })
        .limit(5)
      setLocalContent(content || [])
    } catch (error) {
      console.error("[v0] Failed to load newsletter data:", error)
    } finally {
      setIsNewsletterLoading(false)
    }
  }

  async function loadBlogData() {
    setIsBlogLoading(true)
    try {
      const resolvedBrokerageId = brokerageIdProp || brokerageId
      if (!resolvedBrokerageId) return
      const { createClient } = await import("@/lib/supabase/client")
      const supabase = createClient()
      const { data } = await supabase
        .from("blog_posts")
        .select("id, title, publish_status, seo_score, created_at, published_at")
        .eq("brokerage_id", resolvedBrokerageId)
        .order("created_at", { ascending: false })
        .limit(20)
      setBlogPosts(data || [])
    } catch (e) {
      console.error("[v0] loadBlogData error:", e)
    } finally {
      setIsBlogLoading(false)
    }
  }

  async function loadVideoData() {
    setIsVideoLoading(true)
    try {
      const resolvedBrokerageId = brokerageIdProp || brokerageId
      if (!resolvedBrokerageId) return
      const { createClient } = await import("@/lib/supabase/client")
      const supabase = createClient()
      const { data } = await supabase
        .from("ai_video_projects")
        .select("id, title, status, video_type, video_url, thumbnail_url, created_at")
        .eq("brokerage_id", resolvedBrokerageId)
        .order("created_at", { ascending: false })
        .limit(20)
      setVideoProjects(data || [])
    } catch (e) {
      console.error("[v0] loadVideoData error:", e)
    } finally {
      setIsVideoLoading(false)
    }
  }

  async function loadPodcastData() {
    setIsPodcastLoading(true)
    try {
      const resolvedBrokerageId = brokerageIdProp || brokerageId
      if (!resolvedBrokerageId) return
      const { createClient } = await import("@/lib/supabase/client")
      const supabase = createClient()
      const { data } = await supabase
        .from("podcast_episodes")
        .select("id, title, status, category, duration_seconds, published_at, created_at")
        .eq("brokerage_id", resolvedBrokerageId)
        .order("created_at", { ascending: false })
        .limit(20)
      setPodcastEpisodes(data || [])
    } catch (e) {
      console.error("[v0] loadPodcastData error:", e)
    } finally {
      setIsPodcastLoading(false)
    }
  }

  async function loadMailData() {
    setIsMailLoading(true)
    try {
      const resolvedBrokerageId = brokerageIdProp || brokerageId
      if (!resolvedBrokerageId) return
      const result = await getMailCampaigns(resolvedBrokerageId)
      if (result.success) setMailCampaigns(result.campaigns || [])
    } catch (e) {
      console.error("[v0] loadMailData error:", e)
    } finally {
      setIsMailLoading(false)
    }
  }

  async function loadAdOsData() {
    try {
      // Use server-resolved props first; fall back to action
      let resolvedBrokerageId = brokerageIdProp
      let resolvedUserId = userIdProp
      if (!resolvedBrokerageId || !resolvedUserId) {
        const userContext = await getUserContextForPrediction()
        if (userContext.success && userContext.userId && userContext.brokerageId) {
          resolvedBrokerageId = userContext.brokerageId
          resolvedUserId = userContext.userId
        }
      }
      if (resolvedUserId && resolvedBrokerageId) {
        setAgentId(resolvedUserId)
        setBrokerageId(resolvedBrokerageId)

        // Load agent's active listings
        const supabase = (await import("@/lib/supabase/client")).createClient()
        const { data: listingsData } = await supabase
          .from("listings")
          .select("id, address, city, zip, list_price")
          .eq("brokerage_id", resolvedBrokerageId)
          .in("status", ["active", "pending", "coming_soon"])
          .order("created_at", { ascending: false })
          .limit(50)

        setListings(listingsData || [])
      }
    } catch (error) {
      console.error("[v0] Failed to load Ad OS data:", error)
    }
  }

  // ─── HANDLERS ─────────────────────────────────────────────────────────────────

  async function handleCreateCampaign() {
    try {
      const result = await createCampaign(newCampaign)
      if (result.success) {
        setIsCreateCampaignOpen(false)
        setNewCampaign({
          campaignName: "",
          campaignType: "brand",
          budgetTotal: 0,
          scheduledStartAt: "",
          scheduledEndAt: "",
          visibilityScope: "agent",
        })
        loadCampaigns()
        loadInitialData()
      } else {
        toast({ title: "Failed to create campaign", description: (result as any).error ?? "Unknown error", variant: "destructive" })
      }
    } catch (err) {
      toast({ title: "Failed to create campaign", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" })
    }
  }

  async function handleCampaignStatusChange(campaignId: string, status: CampaignStatus) {
    const result = await transitionCampaignStatus(campaignId, status)
    if (result.success) {
      loadCampaigns()
      loadInitialData()
    }
  }

  async function handleCreateAsset() {
    try {
      const qrUrl = newAsset.assetType === "qr" && newAsset.qrTargetUrl.trim()
        ? `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(newAsset.qrTargetUrl.trim())}`
        : undefined
      const result = await createAsset({
        ...newAsset,
        assetType: newAsset.assetType as any,
        campaignId: newAsset.campaignId || undefined,
        assetUrl: qrUrl,
      })
      if (result.success) {
        setIsCreateAssetOpen(false)
        setNewAsset({ assetName: "", assetType: "graphic", campaignId: "", previewText: "", qrTargetUrl: "" })
        loadAssets()
        loadInitialData()
      } else {
        toast({ title: "Failed to create asset", description: (result as any).error ?? "Unknown error", variant: "destructive" })
      }
    } catch (err) {
      toast({ title: "Failed to create asset", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" })
    }
  }

  async function handleApproveAsset(assetId: string) {
    const result = await approveAsset(assetId)
    if (result.success) {
      loadAssets()
      loadInitialData()
    }
  }

  async function handleRejectAsset(assetId: string) {
    const result = await rejectAsset(assetId, "Does not meet brand guidelines")
    if (result.success) {
      loadAssets()
      loadInitialData()
    }
  }

  async function handleCreateCalendarEvent() {
    try {
      const result = await createCalendarEvent({
        ...newEvent,
        campaignId: newEvent.campaignId || undefined,
      })
      if (result.success) {
        setIsCreateEventOpen(false)
        setNewEvent({ title: "", eventType: "publish", scheduledAt: "", campaignId: "", notes: "" })
        loadCalendarEvents()
      } else {
        toast({ title: "Failed to create calendar event", description: (result as any).error ?? "Unknown error", variant: "destructive" })
      }
    } catch (err) {
      toast({ title: "Failed to create calendar event", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" })
    }
  }

  async function handleRegisterSource(item: ContentSourceItem, campaignId: string) {
    const result = await registerCampaignSource({
      campaignId,
      sourceTable: item.sourceTable,
      sourceId: item.id,
      assetName: item.title,
    })
    if (result.success) {
      setIsRegistryOpen(false)
      loadAssets()
    }
  }

  async function handleLinkQr(assetId: string, qrCodeId: string, placementType: string) {
    const result = await linkQrToAsset({
      marketingAssetId: assetId,
      qrCodeId,
      placementType: placementType as any,
    })
    if (result.success) {
      setIsQrLinkOpen(false)
      setSelectedAssetForQr(null)
      loadAssets()
    }
  }

  async function handlePredictPerformance(asset: Asset) {
    setSelectedAssetForPrediction(asset)
    setIsPredictionDialogOpen(true)
    setIsPredicting(true)
    setCurrentPrediction(null)

    let resolvedBrokerageId = brokerageIdProp
    let resolvedUserId = userIdProp
    if (!resolvedBrokerageId || !resolvedUserId) {
      const userContext = await getUserContextForPrediction()
      if (!userContext.success || !userContext.userId || !userContext.brokerageId) {
        setIsPredicting(false)
        return
      }
      resolvedBrokerageId = userContext.brokerageId
      resolvedUserId = userContext.userId
    }

    // Map asset_type to content_type
    const contentTypeMap: Record<string, string> = {
      social_post: "social_post",
      snippet: "social_post",
      script: "social_post",
      newsletter: "newsletter",
      mailer: "newsletter",
      blog: "blog_post",
      video: "ad_creative",
      graphic: "ad_creative",
      template: "ad_creative",
      ad_creative: "ad_creative",
      podcast: "ad_creative",
      qr: "ad_creative",
    }

    const result = await predictPerformanceAction({
      brokerageId: resolvedBrokerageId,
      userId: resolvedUserId,
      contentType: (contentTypeMap[asset.asset_type] || "ad_creative") as any,
      sourceTable: "marketing_assets",
      sourceId: asset.id,
      contentText: asset.preview_text || asset.asset_name,
    })

    if (result.success && result.prediction) {
      setCurrentPrediction(result.prediction)
    }
    setIsPredicting(false)
  }

  // ─── OMNICHANNEL HANDLER ─────────────────────────────────────────────────────

  function addOmnichannelStep() {
    const newStep: OmnichannelStep = {
      id: Math.random().toString(36).slice(2),
      type: "email",
      name: "",
      delay_days: 0,
      delay_hours: 0,
      subject: "",
      body: "",
    }
    setOmnichannelSteps((prev) => [...prev, newStep])
  }

  function updateOmnichannelStep(id: string, patch: Partial<OmnichannelStep>) {
    setOmnichannelSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  function removeOmnichannelStep(id: string) {
    setOmnichannelSteps((prev) => prev.filter((s) => s.id !== id))
  }

  async function handleCreateOmnichannelSequence() {
    if (!omnichannelName.trim()) {
      toast({ title: "Sequence name required", variant: "destructive" })
      return
    }
    setIsCreatingOmnichannel(true)
    setOmnichannelSuccess(null)
    try {
      const resolvedBrokerageId = brokerageIdProp || brokerageId
      if (!resolvedBrokerageId) {
        toast({ title: "Brokerage context missing", variant: "destructive" })
        return
      }
      const { sequence, error: seqError } = await createCampaignSequence({
        brokerageId: resolvedBrokerageId,
        name: omnichannelName.trim(),
        description: omnichannelDescription.trim() || undefined,
        sequence_type: "omnichannel",
      })
      if (!sequence || seqError) {
        toast({ title: "Failed to create sequence", description: seqError, variant: "destructive" })
        return
      }
      const stepErrors: string[] = []
      for (let i = 0; i < omnichannelSteps.length; i++) {
        const step = omnichannelSteps[i]
        const stepResult = await createSequenceStep({
          sequence_id: sequence.id,
          step_number: i + 1,
          step_name: step.name || `Step ${i + 1}`,
          channel: step.type,
          delay_days: step.delay_days,
          delay_hours: step.delay_hours,
          subject: step.type === "email" ? step.subject : undefined,
          body: step.body || undefined,
        })
        if (stepResult.error || !stepResult.step) {
          stepErrors.push(`Step ${i + 1}: ${stepResult?.error ?? "Unknown error"}`)
        }
      }
      if (stepErrors.length > 0) {
        // Roll back the partially-created sequence to avoid orphaned records
        await deleteCampaignSequence(sequence.id).catch(() => {})
        toast({
          title: "Failed to create sequence steps — sequence rolled back",
          description: stepErrors.join("; "),
          variant: "destructive",
        })
        return
      }
      setOmnichannelName("")
      setOmnichannelDescription("")
      setOmnichannelSteps([])
      setOmnichannelSuccess(`Sequence "${sequence.name}" created with ${omnichannelSteps.length} step${omnichannelSteps.length !== 1 ? "s" : ""}.`)
    } catch (err) {
      toast({ title: "Error creating sequence", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" })
    } finally {
      setIsCreatingOmnichannel(false)
    }
  }

  // ─── STATUS HELPERS ───────────────────────────────────────────────────────────

  function getStatusColor(status: string) {
    const colors: Record<string, string> = {
      draft: "bg-gray-100 text-gray-700",
      pending_approval: "bg-yellow-100 text-yellow-700",
      approved: "bg-blue-100 text-blue-700",
      live: "bg-green-100 text-green-700",
      paused: "bg-orange-100 text-orange-700",
      ended: "bg-gray-100 text-gray-600",
      pending: "bg-yellow-100 text-yellow-700",
      rejected: "bg-red-100 text-red-700",
    }
    return colors[status] || "bg-gray-100 text-gray-700"
  }

  function getStatusIcon(status: string) {
    const icons: Record<string, React.ReactNode> = {
      draft: <Edit className="h-3 w-3" />,
      pending_approval: <Clock className="h-3 w-3" />,
      approved: <CheckCircle className="h-3 w-3" />,
      live: <Play className="h-3 w-3" />,
      paused: <Pause className="h-3 w-3" />,
      ended: <CheckCircle className="h-3 w-3" />,
      pending: <Clock className="h-3 w-3" />,
      rejected: <AlertCircle className="h-3 w-3" />,
    }
    return icons[status] || null
  }

  // ─── RENDER ───────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-16 w-16 animate-spin text-primary mx-auto mb-4" />
          <p className="text-muted-foreground text-lg">Loading Marketing Studio...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="p-6 lg:p-8 max-w-[1600px] mx-auto space-y-6">
        {/* Header */}
        <Card className="border-2 shadow-lg bg-gradient-to-r from-violet-50 to-fuchsia-50 dark:from-violet-950/20 dark:to-fuchsia-950/20">
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-4">
                <div className="rounded-2xl bg-violet-600 p-3">
                  <Megaphone className="h-8 w-8 text-white" />
                </div>
                <div>
                  <h1 className="text-3xl lg:text-4xl font-bold text-foreground">Marketing Studio</h1>
                  <p className="text-muted-foreground">
                    Unified command center for campaigns, assets, and content scheduling
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Dialog open={isCreateCampaignOpen} onOpenChange={setIsCreateCampaignOpen}>
                  <DialogTrigger asChild>
                    <Button className="bg-violet-600 hover:bg-violet-700">
                      <Plus className="mr-2 h-4 w-4" />
                      New Campaign
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-[500px]">
                    <DialogHeader>
                      <DialogTitle>Create New Campaign</DialogTitle>
                      <DialogDescription>Set up a new marketing campaign</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label>Campaign Name</Label>
                        <Input
                          value={newCampaign.campaignName}
                          onChange={(e) => setNewCampaign({ ...newCampaign, campaignName: e.target.value })}
                          placeholder="Spring Listing Campaign"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Campaign Type</Label>
                        <Select
                          value={newCampaign.campaignType}
                          onValueChange={(v) => setNewCampaign({ ...newCampaign, campaignType: v as any })}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="listing">Listing</SelectItem>
                            <SelectItem value="brand">Brand</SelectItem>
                            <SelectItem value="recruitment">Recruitment</SelectItem>
                            <SelectItem value="event">Event</SelectItem>
                            <SelectItem value="seasonal">Seasonal</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Budget</Label>
                          <Input
                            type="number"
                            value={newCampaign.budgetTotal}
                            onChange={(e) => setNewCampaign({ ...newCampaign, budgetTotal: Number(e.target.value) })}
                            placeholder="0"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Visibility</Label>
                          <Select
                            value={newCampaign.visibilityScope}
                            onValueChange={(v) => setNewCampaign({ ...newCampaign, visibilityScope: v as VisibilityScope })}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="agent">Just Me</SelectItem>
                              <SelectItem value="team">My Team</SelectItem>
                              <SelectItem value="brokerage">Brokerage</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <Button onClick={handleCreateCampaign} className="w-full bg-violet-600 hover:bg-violet-700">
                        Create Campaign
                      </Button>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </div>
          </CardHeader>
        </Card>

        {/* Quick Stats */}
        {dashboardError && (
          <div className="rounded-lg border border-yellow-200 bg-yellow-50 dark:bg-yellow-950/20 dark:border-yellow-800 px-4 py-3 flex items-center gap-3 text-sm text-yellow-800 dark:text-yellow-200">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>Dashboard metrics could not be loaded: {dashboardError}. Other Studio features are still available.</span>
          </div>
        )}
        {dashboard && (() => {
          const activeCampaigns = dashboard.campaignsByStatus.live ?? 0
          const pendingApproval = dashboard.assetsByApproval.pending ?? 0
          const totalAssets = dashboard.totalAssets
          const upcomingEventsCount = dashboard.upcomingEvents.length
          const isEmpty = dashboard.totalCampaigns === 0 && totalAssets === 0

          return (
            <>
              {isEmpty && (
                <div className="rounded-xl border-2 border-dashed border-violet-200 dark:border-violet-800 bg-violet-50/50 dark:bg-violet-950/10 p-8 text-center space-y-3">
                  <Rocket className="h-10 w-10 text-violet-400 mx-auto" />
                  <h3 className="font-semibold text-lg text-foreground">Your studio is ready for launch</h3>
                  <p className="text-muted-foreground text-sm max-w-sm mx-auto">
                    Create your first campaign and upload assets to start tracking performance here.
                  </p>
                  <Button
                    className="bg-violet-600 hover:bg-violet-700 mt-2"
                    onClick={() => setIsCreateCampaignOpen(true)}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Create First Campaign
                  </Button>
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">Active Campaigns</p>
                        <p className="text-2xl font-bold">{activeCampaigns}</p>
                        {dashboard.totalCampaigns > 0 && activeCampaigns === 0 && (
                          <p className="text-xs text-muted-foreground mt-0.5">{dashboard.totalCampaigns} total</p>
                        )}
                      </div>
                      <div className="h-12 w-12 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                        <Play className="h-6 w-6 text-green-600" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">Pending Approval</p>
                        <p className="text-2xl font-bold">{pendingApproval}</p>
                      </div>
                      <div className="h-12 w-12 rounded-lg bg-yellow-100 dark:bg-yellow-900/30 flex items-center justify-center">
                        <Clock className="h-6 w-6 text-yellow-600" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">Total Assets</p>
                        <p className="text-2xl font-bold">{totalAssets}</p>
                      </div>
                      <div className="h-12 w-12 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                        <Image className="h-6 w-6 text-blue-600" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">Upcoming Events</p>
                        <p className="text-2xl font-bold">{upcomingEventsCount}</p>
                      </div>
                      <div className="h-12 w-12 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                        <CalendarIcon className="h-6 w-6 text-violet-600" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </>
          )
        })()}

        {/* Main Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="grid w-full grid-cols-4 md:grid-cols-7 lg:grid-cols-7 gap-1 h-auto bg-muted p-2 rounded-xl">
            <TabsTrigger
              value="ad-os"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Rocket className="h-4 w-4" />
              <span className="text-xs">Ad OS</span>
            </TabsTrigger>
            <TabsTrigger
              value="overview"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <LayoutDashboard className="h-4 w-4" />
              <span className="text-xs">Overview</span>
            </TabsTrigger>
            <TabsTrigger
              value="campaigns"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Megaphone className="h-4 w-4" />
              <span className="text-xs">Campaigns</span>
            </TabsTrigger>
            <TabsTrigger
              value="assets"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Image className="h-4 w-4" />
              <span className="text-xs">Assets</span>
            </TabsTrigger>
            <TabsTrigger
              value="calendar"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <CalendarIcon className="h-4 w-4" />
              <span className="text-xs">Calendar</span>
            </TabsTrigger>
            <TabsTrigger
              value="newsletters"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Mail className="h-4 w-4" />
              <span className="text-xs">Newsletters</span>
            </TabsTrigger>
            <TabsTrigger
              value="registry"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Link2 className="h-4 w-4" />
              <span className="text-xs">Registry</span>
            </TabsTrigger>
            <TabsTrigger
              value="qr"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <QrCode className="h-4 w-4" />
              <span className="text-xs">QR Links</span>
            </TabsTrigger>
            <TabsTrigger
              value="mail"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Truck className="h-4 w-4" />
              <span className="text-xs">Direct Mail</span>
            </TabsTrigger>
            <TabsTrigger
              value="blog"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Newspaper className="h-4 w-4" />
              <span className="text-xs">Blog</span>
            </TabsTrigger>
            <TabsTrigger
              value="video"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Video className="h-4 w-4" />
              <span className="text-xs">Video</span>
            </TabsTrigger>
            <TabsTrigger
              value="podcast"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Mic className="h-4 w-4" />
              <span className="text-xs">Podcast</span>
            </TabsTrigger>
            <TabsTrigger
              value="omnichannel"
              className="flex-col gap-1 h-auto py-3 data-[state=active]:bg-violet-600 data-[state=active]:text-white"
            >
              <Sparkles className="h-4 w-4" />
              <span className="text-xs">Omnichannel</span>
            </TabsTrigger>
          </TabsList>

          {/* Ad OS Tab */}
          <TabsContent value="ad-os" className="space-y-6">
            {/* Row 1: Campaign Launcher + Competitor Watch */}
            <div className="grid lg:grid-cols-2 gap-6">
              <CampaignLauncherPanel
                listings={listings}
                agentId={agentId}
                brokerageId={brokerageId}
                onCampaignCreated={() => {
                  loadCampaigns()
                  loadInitialData()
                }}
              />
              <CompetitorWatchPanel listings={listings} agentId={agentId} />
            </div>

            {/* Row 2: Repurpose Engine + Creative Variations */}
            <div className="grid lg:grid-cols-2 gap-6">
              <RepurposeEnginePanel agentId={agentId} />
              <CreativeVariationsPanel agentId={agentId} />
            </div>

            {/* Row 3: Prelaunch Prediction + Performance Intelligence */}
            <div className="grid lg:grid-cols-2 gap-6">
              <PrelaunchPredictionPanel agentId={agentId} />
              <PerformanceIntelligencePanel brokerageId={brokerageId} />
            </div>

            {/* Row 4: Seller-Safe Marketing Summary (full width) */}
            <SellerSafeMarketingSummary campaigns={campaigns} />
          </TabsContent>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-6">
            <div className="grid md:grid-cols-2 gap-6">
              {/* Upcoming Events */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CalendarIcon className="h-5 w-5 text-violet-600" />
                    Upcoming Events
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[300px]">
                    {dashboard?.upcomingEvents.length === 0 ? (
                      <p className="text-muted-foreground text-center py-8">No upcoming events</p>
                    ) : (
                      <div className="space-y-3">
                        {dashboard?.upcomingEvents.map((event) => (
                          <div key={event.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                            <div>
                              <p className="font-medium">{event.title}</p>
                              <p className="text-sm text-muted-foreground">
                                {format(new Date(event.scheduled_at), "MMM d, yyyy 'at' h:mm a")}
                              </p>
                            </div>
                            <Badge variant="outline">{event.event_type}</Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>

              {/* Pending Tasks */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CheckSquare className="h-5 w-5 text-violet-600" />
                    Pending Tasks
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[300px]">
                    {dashboard?.pendingTasks.length === 0 ? (
                      <p className="text-muted-foreground text-center py-8">No pending tasks</p>
                    ) : (
                      <div className="space-y-3">
                        {dashboard?.pendingTasks.map((task) => (
                          <div key={task.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                            <div>
                              <p className="font-medium">{task.title}</p>
                              {task.due_at && (
                                <p className="text-sm text-muted-foreground">
                                  Due: {format(new Date(task.due_at), "MMM d, yyyy")}
                                </p>
                              )}
                            </div>
                            <Button size="sm" variant="outline" onClick={() => updateTaskStatus(task.id, "completed")}>
                              <CheckCircle className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>

            {/* Recent Campaigns */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Megaphone className="h-5 w-5 text-violet-600" />
                    Recent Campaigns
                  </CardTitle>
                  <Button variant="ghost" size="sm" onClick={() => setActiveTab("campaigns")}>
                    View All <ChevronRight className="h-4 w-4 ml-1" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid md:grid-cols-3 gap-4">
                  {campaigns.slice(0, 3).map((campaign) => (
                    <Card key={campaign.id} className="bg-muted/30">
                      <CardContent className="pt-4">
                        <div className="flex items-start justify-between mb-2">
                          <Badge className={getStatusColor(campaign.status)}>
                            {getStatusIcon(campaign.status)}
                            <span className="ml-1">{campaign.status}</span>
                          </Badge>
                          <Badge variant="outline">{campaign.campaign_type}</Badge>
                        </div>
                        <h4 className="font-semibold mb-1">{campaign.campaign_name}</h4>
                        {campaign.listing && (
                          <p className="text-sm text-muted-foreground">{campaign.listing.address}</p>
                        )}
                        <div className="flex items-center gap-4 mt-3 text-sm text-muted-foreground">
                          <span>{campaign.assets?.[0]?.count ?? 0} assets</span>
                          <span>{campaign.tasks?.[0]?.count ?? 0} tasks</span>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Campaigns Tab */}
          <TabsContent value="campaigns" className="space-y-4">
            <div className="flex items-center gap-4 flex-wrap">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search campaigns..."
                  className="pl-10"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[180px]">
                  <Filter className="h-4 w-4 mr-2" />
                  <SelectValue placeholder="Filter status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="pending_approval">Pending Approval</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="live">Live</SelectItem>
                  <SelectItem value="paused">Paused</SelectItem>
                  <SelectItem value="ended">Ended</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {campaigns
                .filter((c) => c.campaign_name.toLowerCase().includes(searchQuery.toLowerCase()))
                .map((campaign) => (
                  <Card key={campaign.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="pt-6">
                      <div className="flex items-start justify-between mb-3">
                        <Badge className={getStatusColor(campaign.status)}>
                          {getStatusIcon(campaign.status)}
                          <span className="ml-1 capitalize">{campaign.status.replace("_", " ")}</span>
                        </Badge>
                        <Badge variant="outline" className="capitalize">
                          {campaign.campaign_type}
                        </Badge>
                      </div>
                      <h3 className="font-semibold text-lg mb-1">{campaign.campaign_name}</h3>
                      {campaign.listing && (
                        <p className="text-sm text-muted-foreground mb-3">
                          {campaign.listing.address}, {campaign.listing.city}
                        </p>
                      )}
                      <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
                        <span className="flex items-center gap-1">
                          <Image className="h-3 w-3" />
                          {campaign.assets?.[0]?.count ?? 0}
                        </span>
                        <span className="flex items-center gap-1">
                          <CheckSquare className="h-3 w-3" />
                          {campaign.tasks?.[0]?.count ?? 0}
                        </span>
                        {campaign.budget_total > 0 && (
                          <span className="flex items-center gap-1">
                            <TrendingUp className="h-3 w-3" />
                            ${campaign.budget_spent ?? 0}/${campaign.budget_total}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {campaign.status === "draft" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleCampaignStatusChange(campaign.id, "pending_approval")}
                          >
                            Submit for Approval
                          </Button>
                        )}
                        {campaign.status === "approved" && (
                          <Button
                            size="sm"
                            className="bg-green-600 hover:bg-green-700"
                            onClick={() => handleCampaignStatusChange(campaign.id, "live")}
                          >
                            <Play className="h-3 w-3 mr-1" />
                            Launch
                          </Button>
                        )}
                        {campaign.status === "live" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleCampaignStatusChange(campaign.id, "paused")}
                          >
                            <Pause className="h-3 w-3 mr-1" />
                            Pause
                          </Button>
                        )}
                        {campaign.status === "paused" && (
                          <Button
                            size="sm"
                            className="bg-green-600 hover:bg-green-700"
                            onClick={() => handleCampaignStatusChange(campaign.id, "live")}
                          >
                            <Play className="h-3 w-3 mr-1" />
                            Resume
                          </Button>
                        )}
                        <Button size="sm" variant="ghost">
                          <Eye className="h-4 w-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
            </div>
          </TabsContent>

          {/* Assets Tab */}
          <TabsContent value="assets" className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-4 flex-1">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search assets..."
                    className="pl-10"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-[180px]">
                    <Filter className="h-4 w-4 mr-2" />
                    <SelectValue placeholder="Filter approval" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="rejected">Rejected</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Dialog open={isCreateAssetOpen} onOpenChange={setIsCreateAssetOpen}>
                <DialogTrigger asChild>
                  <Button className="bg-violet-600 hover:bg-violet-700">
                    <Plus className="mr-2 h-4 w-4" />
                    Add Asset
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Add Marketing Asset</DialogTitle>
                    <DialogDescription>Upload or create a new marketing asset</DialogDescription>
                  </DialogHeader>
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label>Asset Name</Label>
                      <Input
                        value={newAsset.assetName}
                        onChange={(e) => setNewAsset({ ...newAsset, assetName: e.target.value })}
                        placeholder="Spring Campaign Banner"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Asset Type</Label>
                      <Select
                        value={newAsset.assetType}
                        onValueChange={(v) => setNewAsset({ ...newAsset, assetType: v as any })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="graphic">Graphic</SelectItem>
                          <SelectItem value="video">Video</SelectItem>
                          <SelectItem value="snippet">Snippet</SelectItem>
                          <SelectItem value="script">Script</SelectItem>
                          <SelectItem value="template">Template</SelectItem>
                          <SelectItem value="social_post">Social Post</SelectItem>
                          <SelectItem value="newsletter">Newsletter</SelectItem>
                          <SelectItem value="blog">Blog</SelectItem>
                          <SelectItem value="podcast">Podcast</SelectItem>
                          <SelectItem value="mailer">Direct Mailer</SelectItem>
                          <SelectItem value="ad_creative">Ad Creative</SelectItem>
                          <SelectItem value="qr">QR Code</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Campaign (Optional)</Label>
                      <Select
                        value={newAsset.campaignId || "none"}
                        onValueChange={(v) => setNewAsset({ ...newAsset, campaignId: v === "none" ? "" : v })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select campaign" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No Campaign</SelectItem>
                          {campaigns.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.campaign_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {newAsset.assetType === "qr" ? (
                      <div className="space-y-2">
                        <Label>Target URL (what the QR code points to)</Label>
                        <Input
                          value={newAsset.qrTargetUrl}
                          onChange={(e) => setNewAsset({ ...newAsset, qrTargetUrl: e.target.value })}
                          placeholder="https://example.com/your-page"
                        />
                        <p className="text-xs text-muted-foreground">A scannable QR image will be auto-generated.</p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Label>Preview Text</Label>
                        <Textarea
                          value={newAsset.previewText}
                          onChange={(e) => setNewAsset({ ...newAsset, previewText: e.target.value })}
                          placeholder="Brief description..."
                          rows={3}
                        />
                      </div>
                    )}
                    <Button onClick={handleCreateAsset} className="w-full bg-violet-600 hover:bg-violet-700">
                      Create Asset
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {assets
                .filter((a) => a.asset_name.toLowerCase().includes(searchQuery.toLowerCase()))
                .map((asset) => (
                  <Card key={asset.id} className="overflow-hidden">
                    <div className="aspect-video bg-muted flex items-center justify-center">
                      {asset.thumbnail_url ? (
                        <img
                          src={asset.thumbnail_url}
                          alt={asset.asset_name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="text-muted-foreground">
                          {asset.asset_type === "video" && <Video className="h-12 w-12" />}
                          {asset.asset_type === "graphic" && <Image className="h-12 w-12" />}
                          {["blog", "snippet", "script", "template"].includes(asset.asset_type) && <FileText className="h-12 w-12" />}
                          {["newsletter", "mailer"].includes(asset.asset_type) && <Newspaper className="h-12 w-12" />}
                          {asset.asset_type === "podcast" && <Mic className="h-12 w-12" />}
                          {asset.asset_type === "qr" && <QrCode className="h-12 w-12" />}
                          {!["video", "graphic", "blog", "snippet", "script", "template", "newsletter", "mailer", "podcast", "qr"].includes(asset.asset_type) && (
                            <Sparkles className="h-12 w-12" />
                          )}
                        </div>
                      )}
                    </div>
                    <CardContent className="pt-4">
                      <div className="flex items-start justify-between mb-2">
                        <Badge className={getStatusColor(asset.approval_status)}>
                          {getStatusIcon(asset.approval_status)}
                          <span className="ml-1 capitalize">{asset.approval_status}</span>
                        </Badge>
                        <Badge variant="outline" className="capitalize">
                          {asset.asset_type.replace("_", " ")}
                        </Badge>
                      </div>
                      <h4 className="font-medium mb-1 line-clamp-1">{asset.asset_name}</h4>
                      {asset.preview_text && (
                        <p className="text-sm text-muted-foreground line-clamp-2 mb-3">{asset.preview_text}</p>
                      )}
                      <div className="flex items-center gap-2">
                        {asset.approval_status === "pending" && (
                          <>
                            <Button
                              size="sm"
                              className="bg-green-600 hover:bg-green-700"
                              onClick={() => handleApproveAsset(asset.id)}
                            >
                              Approve
                            </Button>
                            <Button size="sm" variant="destructive" onClick={() => handleRejectAsset(asset.id)}>
                              Reject
                            </Button>
                          </>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setSelectedAssetForQr(asset.id)
                            loadQrCodes()
                            setIsQrLinkOpen(true)
                          }}
                        >
                          <QrCode className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handlePredictPerformance(asset)}
                          title="Predict Performance"
                        >
                          <TrendingUp className="h-4 w-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
            </div>
          </TabsContent>

          {/* Calendar Tab */}
          <TabsContent value="calendar" className="space-y-6">
            {/* ── Calendar Grid ──────────────────────────────────────────────── */}
            {(() => {
              // Build month grid entirely in-component — no calendar library needed.
              const today = new Date()
              const viewYear = calendarViewDate.getFullYear()
              const viewMonth = calendarViewDate.getMonth()

              // First day of the month (0=Sun … 6=Sat) and total days
              const firstOfMonth = new Date(viewYear, viewMonth, 1)
              const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()
              const startDow = firstOfMonth.getDay() // 0-6

              // Build a Set of "YYYY-MM-DD" strings that have events
              const eventDateSet = new Set<string>()
              for (const key of Object.keys(eventsByDate)) {
                eventDateSet.add(key)
              }

              // Also mark scheduled sends from newsletter state
              for (const s of scheduledSends) {
                const sentAt = s.sent_at || s.scheduled_at
                if (sentAt) {
                  const key = format(new Date(sentAt), "yyyy-MM-dd")
                  eventDateSet.add(key)
                }
              }

              const prevMonth = () => {
                const d = new Date(viewYear, viewMonth - 1, 1)
                setCalendarViewDate(d)
                setSelectedDate(undefined)
              }
              const nextMonth = () => {
                const d = new Date(viewYear, viewMonth + 1, 1)
                setCalendarViewDate(d)
                setSelectedDate(undefined)
              }

              const selectedKey = selectedDate ? format(selectedDate, "yyyy-MM-dd") : null
              const todayKey = format(today, "yyyy-MM-dd")

              // Build cell array: nulls for leading blanks, then 1..daysInMonth
              const cells: (number | null)[] = [
                ...Array(startDow).fill(null),
                ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
              ]
              // Pad to full weeks
              while (cells.length % 7 !== 0) cells.push(null)

              const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

              // Determine which events to show in the list below:
              // If a date is selected, show only events on that date; else all.
              const filteredEvents = selectedKey && eventsByDate[selectedKey]
                ? eventsByDate[selectedKey]
                : calendarEvents

              return (
                <Card className="overflow-hidden shadow-sm">
                  <CardHeader className="pb-3 border-b">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={prevMonth}
                          aria-label="Previous month"
                        >
                          <ChevronRight className="h-4 w-4 rotate-180" />
                        </Button>
                        <h2 className="text-lg font-semibold min-w-[160px] text-center">
                          {format(firstOfMonth, "MMMM yyyy")}
                        </h2>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={nextMonth}
                          aria-label="Next month"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs h-7"
                          onClick={() => { setCalendarViewDate(new Date()); setSelectedDate(undefined) }}
                        >
                          Today
                        </Button>
                      </div>

                      {/* Add Event inline button */}
                      <Dialog open={isCreateEventOpen} onOpenChange={setIsCreateEventOpen}>
                        <DialogTrigger asChild>
                          <Button size="sm" className="bg-violet-600 hover:bg-violet-700">
                            <Plus className="mr-1.5 h-3.5 w-3.5" />
                            Add Event
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Create Calendar Event</DialogTitle>
                            <DialogDescription>Schedule a marketing event</DialogDescription>
                          </DialogHeader>
                          <div className="space-y-4 py-4">
                            <div className="space-y-2">
                              <Label>Event Title</Label>
                              <Input
                                value={newEvent.title}
                                onChange={(e) => setNewEvent({ ...newEvent, title: e.target.value })}
                                placeholder="Social Post Go-Live"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>Event Type</Label>
                              <Select
                                value={newEvent.eventType}
                                onValueChange={(v) => setNewEvent({ ...newEvent, eventType: v as any })}
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="publish">Publish</SelectItem>
                                  <SelectItem value="review">Review</SelectItem>
                                  <SelectItem value="deadline">Deadline</SelectItem>
                                  <SelectItem value="meeting">Meeting</SelectItem>
                                  <SelectItem value="go_live">Go Live</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="space-y-2">
                              <Label>Date & Time</Label>
                              <Input
                                type="datetime-local"
                                value={newEvent.scheduledAt}
                                onChange={(e) => setNewEvent({ ...newEvent, scheduledAt: e.target.value })}
                              />
                            </div>
                            <div className="space-y-2">
                              <Label>Notes</Label>
                              <Textarea
                                value={newEvent.notes}
                                onChange={(e) => setNewEvent({ ...newEvent, notes: e.target.value })}
                                placeholder="Additional details..."
                                rows={3}
                              />
                            </div>
                            <Button onClick={handleCreateCalendarEvent} className="w-full bg-violet-600 hover:bg-violet-700">
                              Create Event
                            </Button>
                          </div>
                        </DialogContent>
                      </Dialog>
                    </div>
                  </CardHeader>

                  <CardContent className="p-0">
                    {/* Day-of-week header */}
                    <div className="grid grid-cols-7 border-b">
                      {DOW_LABELS.map((d) => (
                        <div
                          key={d}
                          className="py-2 text-center text-xs font-semibold text-muted-foreground tracking-wide uppercase"
                        >
                          {d}
                        </div>
                      ))}
                    </div>

                    {/* Date cells grid */}
                    <div className="grid grid-cols-7">
                      {cells.map((day, idx) => {
                        if (day === null) {
                          return (
                            <div
                              key={`blank-${idx}`}
                              className="h-20 border-b border-r last:border-r-0 bg-muted/20"
                            />
                          )
                        }

                        const cellKey = format(new Date(viewYear, viewMonth, day), "yyyy-MM-dd")
                        const isToday = cellKey === todayKey
                        const isSelected = cellKey === selectedKey
                        const hasEvents = eventDateSet.has(cellKey)
                        const cellEvents = eventsByDate[cellKey] ?? []

                        return (
                          <button
                            key={cellKey}
                            type="button"
                            onClick={() => {
                              setSelectedDate(new Date(viewYear, viewMonth, day))
                            }}
                            className={cn(
                              "h-20 border-b border-r last:border-r-0 p-1.5 text-left align-top transition-colors hover:bg-violet-50 dark:hover:bg-violet-950/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
                              isSelected && "bg-violet-100 dark:bg-violet-900/30",
                              idx % 7 === 6 && "border-r-0", // last column no right border
                            )}
                          >
                            {/* Day number */}
                            <span
                              className={cn(
                                "inline-flex h-6 w-6 items-center justify-center rounded-full text-sm font-medium",
                                isToday && "bg-violet-600 text-white font-bold",
                                isSelected && !isToday && "ring-2 ring-violet-500 text-violet-700 dark:text-violet-300",
                                !isToday && !isSelected && "text-foreground",
                              )}
                            >
                              {day}
                            </span>

                            {/* Event dots / pills */}
                            {hasEvents && (
                              <div className="mt-1 flex flex-wrap gap-0.5">
                                {cellEvents.slice(0, 2).map((ev) => {
                                  const dotColor =
                                    ev.event_type === "deadline" ? "bg-red-500" :
                                    ev.event_type === "go_live" ? "bg-green-500" :
                                    ev.event_type === "meeting" ? "bg-blue-500" :
                                    ev.event_type === "review" ? "bg-yellow-500" :
                                    "bg-violet-500"
                                  return (
                                    <span
                                      key={ev.id}
                                      className={cn("block truncate rounded px-1 text-[10px] leading-4 font-medium text-white max-w-full", dotColor)}
                                      title={ev.title}
                                    >
                                      {ev.title.length > 10 ? ev.title.slice(0, 9) + "…" : ev.title}
                                    </span>
                                  )
                                })}
                                {cellEvents.length > 2 && (
                                  <span className="text-[10px] text-muted-foreground leading-4">
                                    +{cellEvents.length - 2} more
                                  </span>
                                )}
                              </div>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  </CardContent>
                </Card>
              )
            })()}

            {/* ── Event cards below the grid ────────────────────────────────── */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-base">
                  {selectedDate
                    ? `Events on ${format(selectedDate, "MMMM d, yyyy")}`
                    : "All Scheduled Events"}
                </h3>
                {selectedDate && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7"
                    onClick={() => setSelectedDate(undefined)}
                  >
                    Clear filter
                  </Button>
                )}
              </div>

              {(() => {
                const selectedKey = selectedDate ? format(selectedDate, "yyyy-MM-dd") : null
                const filtered = selectedKey
                  ? (eventsByDate[selectedKey] ?? [])
                  : calendarEvents

                if (filtered.length === 0) {
                  return (
                    <div className="rounded-xl border-2 border-dashed border-muted py-12 text-center text-muted-foreground">
                      <CalendarIcon className="h-8 w-8 mx-auto mb-3 opacity-40" />
                      <p className="font-medium">
                        {selectedDate ? "No events on this date" : "No scheduled events yet"}
                      </p>
                      <p className="text-sm mt-1">Click Add Event to schedule a marketing activity</p>
                    </div>
                  )
                }

                return (
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {filtered.map((event) => (
                      <Card key={event.id}>
                        <CardContent className="pt-6">
                          <div className="flex items-start justify-between mb-2">
                            <Badge variant="outline" className="capitalize">
                              {event.event_type.replace(/_/g, " ")}
                            </Badge>
                            <Badge className={event.status === "scheduled" ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}>
                              {event.status}
                            </Badge>
                          </div>
                          <h4 className="font-semibold mb-1">{event.title}</h4>
                          <p className="text-sm text-muted-foreground mb-2">
                            {format(new Date(event.scheduled_at), "MMM d, yyyy 'at' h:mm a")}
                          </p>
                          {event.campaign && (
                            <p className="text-sm text-muted-foreground">Campaign: {event.campaign.campaign_name}</p>
                          )}
                          {event.notes && <p className="text-sm text-muted-foreground mt-2">{event.notes}</p>}
                          {event.status === "scheduled" && (
                            <div className="flex gap-2 mt-4">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => updateCalendarEventStatus(event.id, "completed")}
                              >
                                <CheckCircle className="h-4 w-4 mr-1" />
                                Complete
                              </Button>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )
              })()}
            </div>
          </TabsContent>

          {/* Newsletters Tab */}
          <TabsContent value="newsletters" className="space-y-6">
            {isNewsletterLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : newsletterTemplates.length === 0 ? (
              /* Prerequisite gate: no templates → empty state */
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center justify-center py-16 text-center gap-4">
                  <div className="h-14 w-14 rounded-full bg-violet-100 flex items-center justify-center">
                    <Mail className="h-7 w-7 text-violet-600" />
                  </div>
                  <div>
                    <p className="text-lg font-semibold">No newsletter templates yet</p>
                    <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                      Create at least one approved newsletter template before scheduling campaigns.
                      Templates let you define layout, branding, and reusable sections — then the
                      AI fills in dynamic content at send time.
                    </p>
                  </div>
                  <Button asChild>
                    <a href="/newsletters">
                      Create Newsletter Template
                    </a>
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Already have templates? Ask your broker to approve them so they appear here.
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {/* Subscriber Count Card */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-muted-foreground">Total Subscribers</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-2">
                      <span className="text-3xl font-bold">{subscriberCount.toLocaleString()}</span>
                      <Badge variant="outline" className="text-green-600">Active</Badge>
                    </div>
                  </CardContent>
                </Card>

                {/* Recent Campaigns */}
                <Card className="md:col-span-2">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="flex items-center gap-2">
                        <Mail className="h-5 w-5 text-violet-600" />
                        Recent Campaigns
                      </CardTitle>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          className="bg-violet-600 hover:bg-violet-700"
                          onClick={() => setIsCreateNewsletterOpen(true)}
                        >
                          <Plus className="h-3.5 w-3.5 mr-1.5" />
                          New Campaign
                        </Button>
                        <Button variant="outline" size="sm" asChild>
                          <a href="/newsletters">Manage</a>
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {newsletterCampaigns.length === 0 ? (
                      <p className="text-muted-foreground text-center py-8">No newsletter campaigns yet</p>
                    ) : (
                      <div className="space-y-3">
                        {newsletterCampaigns.map((campaign) => (
                          <div key={campaign.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                            <div>
                              <p className="font-medium">{campaign.campaign_name || campaign.subject_line}</p>
                              <p className="text-sm text-muted-foreground">
                                {campaign.send_date
                                  ? format(new Date(campaign.send_date), "MMM d, yyyy")
                                  : "Not scheduled"}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge className={getStatusColor(campaign.status || "draft")}>
                                {campaign.status || "draft"}
                              </Badge>
                              {campaign.open_rate && (
                                <span className="text-xs text-muted-foreground">
                                  {(campaign.open_rate * 100).toFixed(1)}% open
                                </span>
                              )}
                              {campaign.click_rate && (
                                <span className="text-xs text-muted-foreground">
                                  {(campaign.click_rate * 100).toFixed(1)}% CTR
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Scheduled Sends */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Clock className="h-5 w-5 text-violet-600" />
                      Scheduled Sends
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {scheduledSends.length === 0 ? (
                      <p className="text-muted-foreground text-center py-4">No scheduled sends</p>
                    ) : (
                      <ScrollArea className="h-[200px]">
                        <div className="space-y-2">
                          {scheduledSends.map((send) => (
                            <div key={send.id} className="flex items-center justify-between p-2 rounded-lg bg-muted/30 text-sm">
                              <div>
                                <p className="font-medium truncate max-w-[150px]">
                                  {send.newsletter?.campaign_name || "Newsletter"}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {send.sent_at
                                    ? format(new Date(send.sent_at), "MMM d, h:mm a")
                                    : "Pending"}
                                </p>
                              </div>
                              <Badge variant="outline" className="text-xs">
                                {send.recipient_count} recipients
                              </Badge>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    )}
                  </CardContent>
                </Card>

                {/* Templates */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <FileText className="h-5 w-5 text-violet-600" />
                      Templates
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {newsletterTemplates.length === 0 ? (
                      <p className="text-muted-foreground text-center py-4">No templates available</p>
                    ) : (
                      <div className="space-y-2">
                        {newsletterTemplates.map((template) => (
                          <div key={template.id} className="flex items-center justify-between p-2 rounded-lg bg-muted/30">
                            <span className="text-sm font-medium">{template.template_name || template.name}</span>
                            <Button variant="ghost" size="sm">
                              <ChevronRight className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Local Content Blocks */}
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Sparkles className="h-5 w-5 text-violet-600" />
                      Local Content
                    </CardTitle>
                    <CardDescription>Recent local content blocks for newsletters</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {localContent.length === 0 ? (
                      <p className="text-muted-foreground text-center py-4">No local content</p>
                    ) : (
                      <div className="space-y-2">
                        {localContent.map((content) => (
                          <div key={content.id} className="p-2 rounded-lg bg-muted/30">
                            <p className="text-sm font-medium">{content.content_type || "Content"}</p>
                            <p className="text-xs text-muted-foreground line-clamp-2">
                              {content.content_text || content.description}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}
          </TabsContent>

          {/* Registry Tab */}
          <TabsContent value="registry" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Link2 className="h-5 w-5 text-violet-600" />
                  Content Registry
                </CardTitle>
                <CardDescription>
                  Link existing content (newsletters, social posts, videos) to campaigns
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4 mb-6">
                  <Input
                    placeholder="Search registry..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="max-w-xs h-9 text-sm"
                  />
                  <Button onClick={loadRegistry} variant="outline" size="sm">
                    <Search className="mr-2 h-4 w-4" />
                    {registryItems.length === 0 ? "Load Registry" : "Refresh"}
                  </Button>
                </div>
                {registryItems.length > 0 && (
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {registryItems.filter((item) => {
                      if (!searchQuery.trim()) return true
                      const q = searchQuery.toLowerCase()
                      return item.title?.toLowerCase().includes(q) || item.previewText?.toLowerCase().includes(q) || item.sourceTable?.toLowerCase().includes(q)
                    }).map((item) => (
                      <Card key={`${item.sourceTable}-${item.id}`} className="bg-muted/30">
                        <CardContent className="pt-4">
                          <div className="flex items-start justify-between mb-2">
                            <Badge variant="outline" className="capitalize text-xs">
                              {item.sourceTable.replace("_", " ")}
                            </Badge>
                            <Badge className={getStatusColor(item.status)}>{item.status}</Badge>
                          </div>
                          <h4 className="font-medium mb-1 line-clamp-1">{item.title}</h4>
                          {item.previewText && (
                            <p className="text-sm text-muted-foreground line-clamp-2 mb-3">{item.previewText}</p>
                          )}
                          <Select onValueChange={(campaignId) => handleRegisterSource(item, campaignId)}>
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue placeholder="Link to campaign" />
                            </SelectTrigger>
                            <SelectContent>
                              {campaigns.map((c) => (
                                <SelectItem key={c.id} value={c.id}>
                                  {c.campaign_name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* QR Links Tab */}
          <TabsContent value="qr" className="space-y-4">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <QrCode className="h-5 w-5 text-violet-600" />
                      QR Code Management
                    </CardTitle>
                    <CardDescription>Link QR codes to marketing assets for tracking</CardDescription>
                  </div>
                  <Button
                    size="sm"
                    className="bg-violet-600 hover:bg-violet-700"
                    onClick={() => setIsCreateQrOpen(true)}
                  >
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    New QR Code
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-4 mb-6">
                  <Button onClick={loadQrCodes} variant="outline">
                    <Search className="mr-2 h-4 w-4" />
                    Load Available QR Codes
                  </Button>
                </div>
                {availableQrCodes.length > 0 && (
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {availableQrCodes.map((qr) => (
                      <Card key={qr.id} className="bg-muted/30">
                        <CardContent className="pt-4">
                          <div className="flex items-center gap-4">
                            <div className="h-16 w-16 bg-white rounded-lg flex items-center justify-center border">
                              <QrCode className="h-10 w-10 text-gray-700" />
                            </div>
                            <div className="flex-1">
                              <h4 className="font-medium">{qr.label}</h4>
                              <p className="text-sm text-muted-foreground">{qr.purpose}</p>
                              <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                                <span>{qr.scanCount} scans</span>
                                <span>{qr.leadCount} leads</span>
                                <span>{qr.linkedAssetCount} linked</span>
                              </div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
          {/* Direct Mail Tab */}
          <TabsContent value="mail" className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-lg font-semibold">Direct Mail Campaigns</h3>
                <p className="text-sm text-muted-foreground">Create, manage, and track postal mail campaigns</p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href="/dashboard/campaigns/mail" target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                    Full Manager
                  </a>
                </Button>
                <Button size="sm" className="bg-violet-600 hover:bg-violet-700" asChild>
                  <a href="/dashboard/campaigns/mail">
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    New Campaign
                  </a>
                </Button>
              </div>
            </div>

            {isMailLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : mailCampaigns.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="py-12 text-center">
                  <Truck className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                  <p className="font-medium text-muted-foreground">No direct mail campaigns yet</p>
                  <Button size="sm" className="mt-4 bg-violet-600 hover:bg-violet-700" asChild>
                    <a href="/dashboard/campaigns/mail">Create Your First Campaign</a>
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {mailCampaigns.map((campaign: any) => (
                  <Card key={campaign.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="pt-5">
                      <div className="flex items-start justify-between mb-2">
                        <Badge variant="outline" className="capitalize">{campaign.status}</Badge>
                        {campaign.quantity && (
                          <span className="text-xs text-muted-foreground">{campaign.quantity} pieces</span>
                        )}
                      </div>
                      <h4 className="font-semibold mb-1">{campaign.campaign_name}</h4>
                      <p className="text-sm text-muted-foreground mb-3">{campaign.target_audience}</p>
                      {campaign.mailing_date && (
                        <p className="text-xs text-muted-foreground">
                          Mail date: {format(new Date(campaign.mailing_date), "MMM d, yyyy")}
                        </p>
                      )}
                      <div className="flex gap-2 mt-4">
                        <Button size="sm" variant="outline" className="flex-1" asChild>
                          <a href="/dashboard/campaigns/mail">
                            <Eye className="h-3.5 w-3.5 mr-1.5" />
                            Preview
                          </a>
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Blog Tab */}
          <TabsContent value="blog" className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-lg font-semibold">Blog Posts</h3>
                <p className="text-sm text-muted-foreground">Create, edit, and publish SEO-optimized blog content</p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href="/dashboard/marketing/blog">
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                    Blog Manager
                  </a>
                </Button>
                <Button size="sm" className="bg-violet-600 hover:bg-violet-700" asChild>
                  <a href="/dashboard/marketing/blog">
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    New Post
                  </a>
                </Button>
              </div>
            </div>

            {isBlogLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : blogPosts.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="py-12 text-center">
                  <Newspaper className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                  <p className="font-medium text-muted-foreground">No blog posts yet</p>
                  <Button size="sm" className="mt-4 bg-violet-600 hover:bg-violet-700" asChild>
                    <a href="/dashboard/marketing/blog">Create Your First Post</a>
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {blogPosts.map((post: any) => (
                  <Card key={post.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="pt-5">
                      <div className="flex items-start justify-between mb-2">
                        <Badge
                          className={
                            post.publish_status === "published"
                              ? "bg-green-100 text-green-700"
                              : post.publish_status === "pending_review"
                              ? "bg-yellow-100 text-yellow-700"
                              : "bg-gray-100 text-gray-700"
                          }
                        >
                          {post.publish_status}
                        </Badge>
                        {post.seo_score != null && (
                          <span className="text-xs font-medium text-violet-600">SEO {post.seo_score}</span>
                        )}
                      </div>
                      <h4 className="font-semibold line-clamp-2 mb-2">{post.title}</h4>
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(post.created_at), "MMM d, yyyy")}
                      </p>
                      <div className="flex gap-2 mt-4">
                        <Button size="sm" variant="outline" className="flex-1" asChild>
                          <a href={`/dashboard/marketing/blog/${post.id}`}>
                            <Edit className="h-3.5 w-3.5 mr-1.5" />
                            Edit
                          </a>
                        </Button>
                        {post.publish_status !== "published" && (
                          <Button size="sm" className="bg-violet-600 hover:bg-violet-700" asChild>
                            <a href={`/dashboard/marketing/blog/${post.id}`}>
                              Preview &amp; Publish
                            </a>
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Video Tab */}
          <TabsContent value="video" className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-lg font-semibold">Video Projects</h3>
                <p className="text-sm text-muted-foreground">Create and distribute AI-generated video content</p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href="/dashboard/videos/library">
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                    Video Library
                  </a>
                </Button>
                <Button size="sm" className="bg-violet-600 hover:bg-violet-700" asChild>
                  <a href="/dashboard/videos/create">
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    New Video
                  </a>
                </Button>
              </div>
            </div>

            {isVideoLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : videoProjects.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="py-12 text-center">
                  <Video className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                  <p className="font-medium text-muted-foreground">No video projects yet</p>
                  <Button size="sm" className="mt-4 bg-violet-600 hover:bg-violet-700" asChild>
                    <a href="/dashboard/videos/create">Create Your First Video</a>
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {videoProjects.map((project: any) => (
                  <Card key={project.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="pt-5">
                      {project.thumbnail_url ? (
                        <div className="relative mb-3 rounded-md overflow-hidden bg-black aspect-video">
                          <img
                            src={project.thumbnail_url}
                            alt={project.title}
                            className="w-full h-full object-cover opacity-80"
                          />
                          {project.status === "completed" && project.video_url && (
                            <a
                              href={project.video_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="absolute inset-0 flex items-center justify-center"
                            >
                              <div className="h-10 w-10 rounded-full bg-white/90 flex items-center justify-center">
                                <Play className="h-5 w-5 text-violet-600 ml-0.5" />
                              </div>
                            </a>
                          )}
                        </div>
                      ) : null}
                      <div className="flex items-start justify-between mb-2">
                        <Badge
                          className={
                            project.status === "completed"
                              ? "bg-green-100 text-green-700"
                              : project.status === "generating"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-gray-100 text-gray-700"
                          }
                        >
                          {project.status}
                        </Badge>
                        <Badge variant="outline" className="capitalize text-xs">{project.video_type}</Badge>
                      </div>
                      <h4 className="font-semibold line-clamp-1 mb-1">{project.title}</h4>
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(project.created_at), "MMM d, yyyy")}
                      </p>
                      <div className="flex gap-2 mt-4">
                        <Button size="sm" variant="outline" className="flex-1" asChild>
                          <a href="/dashboard/videos/board">
                            <Eye className="h-3.5 w-3.5 mr-1.5" />
                            View
                          </a>
                        </Button>
                        {project.status === "completed" && project.video_url && (
                          <Button size="sm" className="bg-violet-600 hover:bg-violet-700" asChild>
                            <a href={project.video_url} target="_blank" rel="noopener noreferrer">
                              Distribute
                            </a>
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Podcast Tab */}
          <TabsContent value="podcast" className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-lg font-semibold">Podcast Episodes</h3>
                <p className="text-sm text-muted-foreground">Create and distribute AI-powered podcast episodes</p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" asChild>
                  <a href="/dashboard/marketing/podcast">
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                    Podcast Studio
                  </a>
                </Button>
                <Button size="sm" className="bg-violet-600 hover:bg-violet-700" asChild>
                  <a href="/dashboard/marketing/podcast">
                    <Plus className="h-3.5 w-3.5 mr-1.5" />
                    New Episode
                  </a>
                </Button>
              </div>
            </div>

            {isPodcastLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : podcastEpisodes.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="py-12 text-center">
                  <Mic className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                  <p className="font-medium text-muted-foreground">No podcast episodes yet</p>
                  <Button size="sm" className="mt-4 bg-violet-600 hover:bg-violet-700" asChild>
                    <a href="/dashboard/marketing/podcast">Create Your First Episode</a>
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {podcastEpisodes.map((ep: any) => (
                  <Card key={ep.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="pt-5">
                      <div className="flex items-start justify-between mb-2">
                        <Badge
                          className={
                            ep.status === "completed"
                              ? "bg-green-100 text-green-700"
                              : ep.status === "generating"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-gray-100 text-gray-700"
                          }
                        >
                          {ep.status}
                        </Badge>
                        {ep.category && (
                          <Badge variant="outline" className="capitalize text-xs">{ep.category}</Badge>
                        )}
                      </div>
                      <h4 className="font-semibold line-clamp-2 mb-1">{ep.title}</h4>
                      {ep.duration_seconds && (
                        <p className="text-xs text-muted-foreground mb-1">
                          {Math.round(ep.duration_seconds / 60)} min
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {format(new Date(ep.created_at), "MMM d, yyyy")}
                      </p>
                      <div className="flex gap-2 mt-4">
                        <Button size="sm" variant="outline" className="flex-1" asChild>
                          <a href="/dashboard/marketing/podcast">
                            <Eye className="h-3.5 w-3.5 mr-1.5" />
                            View
                          </a>
                        </Button>
                        {ep.status === "draft" && (
                          <Button size="sm" className="bg-violet-600 hover:bg-violet-700" asChild>
                            <a href="/dashboard/marketing/podcast">
                              Publish
                            </a>
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* Omnichannel Tab */}
          <TabsContent value="omnichannel" className="space-y-6">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div>
                <h3 className="text-lg font-semibold">Omnichannel Sequence Builder</h3>
                <p className="text-sm text-muted-foreground">Create multi-step automated sequences combining email, SMS, social, video, direct mail, and wait steps.</p>
              </div>
              <Button variant="outline" size="sm" asChild>
                <a href="/dashboard/campaigns/sequences">
                  <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                  All Sequences
                </a>
              </Button>
            </div>

            {omnichannelSuccess && (
              <div className="rounded-lg border border-green-200 bg-green-50 dark:bg-green-950/20 px-4 py-3 flex items-center gap-3 text-sm text-green-800 dark:text-green-200">
                <CheckCircle className="h-4 w-4 shrink-0" />
                {omnichannelSuccess}
              </div>
            )}

            <div className="grid lg:grid-cols-2 gap-6">
              {/* Sequence config */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Sequence Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>Sequence Name</Label>
                    <Input
                      value={omnichannelName}
                      onChange={(e) => setOmnichannelName(e.target.value)}
                      placeholder="e.g. New Buyer 30-Day Nurture"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Description (optional)</Label>
                    <Textarea
                      value={omnichannelDescription}
                      onChange={(e) => setOmnichannelDescription(e.target.value)}
                      placeholder="What this sequence does…"
                      rows={3}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={addOmnichannelStep}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add Step
                    </Button>
                    <Button
                      className="flex-1 bg-violet-600 hover:bg-violet-700"
                      onClick={handleCreateOmnichannelSequence}
                      disabled={isCreatingOmnichannel || !omnichannelName.trim()}
                    >
                      {isCreatingOmnichannel ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Send className="h-4 w-4 mr-1" />}
                      {isCreatingOmnichannel ? "Creating…" : "Create Sequence"}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Step builder */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center justify-between">
                    Steps
                    <Badge variant="secondary">{omnichannelSteps.length}</Badge>
                  </CardTitle>
                  <CardDescription>
                    Define the order and timing of each touchpoint.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {omnichannelSteps.length === 0 ? (
                    <div className="text-center py-8 text-muted-foreground">
                      <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-40" />
                      <p className="text-sm">No steps yet. Click "Add Step" to begin building.</p>
                    </div>
                  ) : (
                    <ScrollArea className="h-[400px] pr-2">
                      <div className="space-y-4">
                        {omnichannelSteps.map((step, idx) => (
                          <div key={step.id} className="border rounded-lg p-3 space-y-3 bg-muted/30">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold text-muted-foreground">STEP {idx + 1}</span>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                                onClick={() => removeOmnichannelStep(step.id)}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="space-y-1">
                                <Label className="text-xs">Type</Label>
                                <Select
                                  value={step.type}
                                  onValueChange={(v) => updateOmnichannelStep(step.id, { type: v as OmnichannelStep["type"] })}
                                >
                                  <SelectTrigger className="h-8 text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="email">Email</SelectItem>
                                    <SelectItem value="sms">SMS</SelectItem>
                                    <SelectItem value="social_post">Social Post</SelectItem>
                                    <SelectItem value="video">Video</SelectItem>
                                    <SelectItem value="direct_mail">Direct Mail</SelectItem>
                                    <SelectItem value="wait">Wait / Delay</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs">Step Name</Label>
                                <Input
                                  className="h-8 text-xs"
                                  value={step.name}
                                  onChange={(e) => updateOmnichannelStep(step.id, { name: e.target.value })}
                                  placeholder={`Step ${idx + 1}`}
                                />
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div className="space-y-1">
                                <Label className="text-xs">Delay (days)</Label>
                                <Input
                                  className="h-8 text-xs"
                                  type="number"
                                  min={0}
                                  value={step.delay_days}
                                  onChange={(e) => updateOmnichannelStep(step.id, { delay_days: Number(e.target.value) })}
                                />
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs">Delay (hours)</Label>
                                <Input
                                  className="h-8 text-xs"
                                  type="number"
                                  min={0}
                                  max={23}
                                  value={step.delay_hours}
                                  onChange={(e) => updateOmnichannelStep(step.id, { delay_hours: Number(e.target.value) })}
                                />
                              </div>
                            </div>
                            {step.type === "email" && (
                              <div className="space-y-1">
                                <Label className="text-xs">Subject Line</Label>
                                <Input
                                  className="h-8 text-xs"
                                  value={step.subject}
                                  onChange={(e) => updateOmnichannelStep(step.id, { subject: e.target.value })}
                                  placeholder="Email subject…"
                                />
                              </div>
                            )}
                            {step.type !== "wait" && (
                              <div className="space-y-1">
                                <Label className="text-xs">{step.type === "email" ? "Body" : "Message / Content"}</Label>
                                <Textarea
                                  className="text-xs"
                                  rows={2}
                                  value={step.body}
                                  onChange={(e) => updateOmnichannelStep(step.id, { body: e.target.value })}
                                  placeholder="Content for this step…"
                                />
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

        </Tabs>

        {/* Performance Prediction Dialog */}
        <Dialog open={isPredictionDialogOpen} onOpenChange={setIsPredictionDialogOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Performance Prediction</DialogTitle>
              <DialogDescription>
                AI-powered analysis of your content&apos;s potential performance
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              {selectedAssetForPrediction && (
                <div className="mb-4 p-3 bg-muted rounded-lg">
                  <p className="font-medium">{selectedAssetForPrediction.asset_name}</p>
                  {selectedAssetForPrediction.preview_text && (
                    <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                      {selectedAssetForPrediction.preview_text}
                    </p>
                  )}
                  <Badge variant="outline" className="mt-2 text-xs capitalize">
                    {selectedAssetForPrediction.asset_type.replace("_", " ")}
                  </Badge>
                </div>
              )}
              <PredictionWidget
                prediction={currentPrediction}
                isLoading={isPredicting}
                onPredict={() => selectedAssetForPrediction && handlePredictPerformance(selectedAssetForPrediction)}
                showPredictButton={!!currentPrediction}
              />
            </div>
          </DialogContent>
        </Dialog>

        {/* Create Newsletter Campaign Dialog */}
        <Dialog open={isCreateNewsletterOpen} onOpenChange={setIsCreateNewsletterOpen}>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>New Newsletter Campaign</DialogTitle>
              <DialogDescription>
                Create a newsletter campaign. You can compose content and schedule after saving.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label htmlFor="nl-name">Campaign Name</Label>
                <Input
                  id="nl-name"
                  placeholder="e.g. May Market Update"
                  value={newNewsletter.campaignName}
                  onChange={(e) => setNewNewsletter((prev) => ({ ...prev, campaignName: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nl-subject">Subject Line</Label>
                <Input
                  id="nl-subject"
                  placeholder="e.g. What's happening in your neighborhood this month"
                  value={newNewsletter.subjectLine}
                  onChange={(e) => setNewNewsletter((prev) => ({ ...prev, subjectLine: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nl-content">Content (optional — save draft and edit later)</Label>
                <Textarea
                  id="nl-content"
                  rows={5}
                  placeholder="Write your newsletter content here, or leave blank to compose later..."
                  value={newNewsletter.content}
                  onChange={(e) => setNewNewsletter((prev) => ({ ...prev, content: e.target.value }))}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsCreateNewsletterOpen(false)}>
                Cancel
              </Button>
              <Button
                className="bg-violet-600 hover:bg-violet-700"
                disabled={isCreatingNewsletter || !newNewsletter.campaignName.trim()}
                onClick={async () => {
                  setIsCreatingNewsletter(true)
                  try {
                    const { createEmailCampaign } = await import("@/app/actions/email-campaigns")
                    const resolvedBrokerageId = brokerageIdProp || brokerageId
                    const resolvedAgentId = agentId
                    const result = await createEmailCampaign({
                      brokerageId: resolvedBrokerageId,
                      agentId: resolvedAgentId || undefined,
                      campaignName: newNewsletter.campaignName.trim(),
                      subjectLine: newNewsletter.subjectLine.trim() || newNewsletter.campaignName.trim(),
                      content: newNewsletter.content.trim() || "",
                      createdBy: resolvedAgentId,
                    })
                    if (result.success) {
                      setIsCreateNewsletterOpen(false)
                      setNewNewsletter({ campaignName: "", subjectLine: "", content: "" })
                      await loadNewsletterData()
                    } else {
                      toast({ title: "Failed to create newsletter", description: (result as any).error ?? "Unknown error", variant: "destructive" })
                    }
                  } catch (err) {
                    toast({ title: "Failed to create newsletter", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" })
                  } finally {
                    setIsCreatingNewsletter(false)
                  }
                }}
              >
                {isCreatingNewsletter ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Save Draft
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Create QR Code Dialog */}
        <Dialog open={isCreateQrOpen} onOpenChange={(open) => { setIsCreateQrOpen(open); if (!open) setQrError(null) }}>
          <DialogContent className="sm:max-w-[440px]">
            <DialogHeader>
              <DialogTitle>New QR Code</DialogTitle>
              <DialogDescription>
                Create a trackable QR code linked to a URL of your choice.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label htmlFor="qr-label">Label</Label>
                <Input
                  id="qr-label"
                  placeholder="e.g. Open House Flyer — 123 Main St"
                  value={newQr.label}
                  onChange={(e) => setNewQr((prev) => ({ ...prev, label: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qr-url">Target URL</Label>
                <Input
                  id="qr-url"
                  placeholder="https://..."
                  type="url"
                  value={newQr.targetUrl}
                  onChange={(e) => setNewQr((prev) => ({ ...prev, targetUrl: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qr-purpose">Purpose</Label>
                <select
                  id="qr-purpose"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  value={newQr.purpose}
                  onChange={(e) => setNewQr((prev) => ({ ...prev, purpose: e.target.value as "listing" | "open_house" | "general" | "campaign" | "lead_capture" }))}
                >
                  <option value="general">General</option>
                  <option value="open_house">Open House</option>
                  <option value="listing">Listing</option>
                  <option value="lead_capture">Lead Capture</option>
                  <option value="campaign">Campaign</option>
                </select>
              </div>
              {qrError && (
                <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {qrError}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsCreateQrOpen(false)}>
                Cancel
              </Button>
              <Button
                className="bg-violet-600 hover:bg-violet-700"
                disabled={isCreatingQr || !newQr.label.trim() || !newQr.targetUrl.trim()}
                onClick={async () => {
                  setIsCreatingQr(true)
                  setQrError(null)
                  try {
                    const { createQrCodeAction } = await import("@/app/actions/marketing-studio")
                    // Resolve brokerageId and agentId — fall back to user context if props not available
                    let resolvedBrokerageId = brokerageIdProp || brokerageId
                    let resolvedAgentId = agentId
                    if (!resolvedBrokerageId || !resolvedAgentId) {
                      const { getUserContextForPrediction } = await import("@/app/actions/content-prediction")
                      const ctx = await getUserContextForPrediction()
                      if (ctx.success && ctx.brokerageId) resolvedBrokerageId = resolvedBrokerageId || ctx.brokerageId
                      if (ctx.success && ctx.userId) resolvedAgentId = resolvedAgentId || ctx.userId
                    }
                    if (!resolvedBrokerageId || !resolvedAgentId) {
                      setQrError("Could not determine your account context. Please refresh and try again.")
                      return
                    }
                    const result = await createQrCodeAction({
                      brokerageId: resolvedBrokerageId,
                      agentId: resolvedAgentId,
                      label: newQr.label.trim(),
                      targetUrl: newQr.targetUrl.trim(),
                      purpose: newQr.purpose,
                    })
                    if (result.success) {
                      setIsCreateQrOpen(false)
                      setNewQr({ label: "", targetUrl: "", purpose: "general" })
                      setQrError(null)
                      await loadQrCodes()
                    } else {
                      setQrError((result as any).error ?? "Failed to create QR code.")
                    }
                  } catch (err) {
                    setQrError(err instanceof Error ? err.message : "Failed to create QR code.")
                  } finally {
                    setIsCreatingQr(false)
                  }
                }}
              >
                {isCreatingQr ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Create QR Code
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* QR Link Dialog */}
        <Dialog open={isQrLinkOpen} onOpenChange={setIsQrLinkOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Link QR Code to Asset</DialogTitle>
              <DialogDescription>Select a QR code and placement type</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              {availableQrCodes.map((qr) => (
                <div
                  key={qr.id}
                  className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 cursor-pointer"
                  onClick={() => selectedAssetForQr && handleLinkQr(selectedAssetForQr, qr.id, "flyer")}
                >
                  <div className="flex items-center gap-3">
                    <QrCode className="h-8 w-8 text-gray-600" />
                    <div>
                      <p className="font-medium">{qr.label}</p>
                      <p className="text-sm text-muted-foreground">{qr.scanCount} scans</p>
                    </div>
                  </div>
                  <Button size="sm" variant="outline">
                    Link
                  </Button>
                </div>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
