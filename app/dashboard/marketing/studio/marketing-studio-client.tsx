"use client"

import { useState, useEffect } from "react"
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
import { getCampaignRegistry, registerCampaignSource, type ContentSourceItem } from "@/lib/marketing/campaign-registry"
import { listAvailableQrCodes, type QrLinkInfo } from "@/lib/marketing/qr-asset-linker"
import { predictPerformanceAction, getUserContextForPrediction } from "@/app/actions/content-prediction"
import { PredictionWidget, type PredictionData } from "@/components/prediction-widget"
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

export default function MarketingStudioClient() {
  const [activeTab, setActiveTab] = useState("overview")
  const [isLoading, setIsLoading] = useState(true)
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([])
  const [selectedCampaign, setSelectedCampaign] = useState<Campaign | null>(null)
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date())
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")

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

  // Ad OS state
  const [listings, setListings] = useState<Array<{ id: string; address: string; city: string; zip?: string; list_price?: number }>>([])
  const [agentId, setAgentId] = useState<string>("")
  const [brokerageId, setBrokerageId] = useState<string>("")

  // Form states
  const [newCampaign, setNewCampaign] = useState({
    campaignName: "",
    campaignType: "brand" as const,
    budgetTotal: 0,
    scheduledStartAt: "",
    scheduledEndAt: "",
    visibilityScope: "agent" as VisibilityScope,
  })
  const [newAsset, setNewAsset] = useState({
    assetName: "",
    assetType: "image" as const,
    campaignId: "",
    previewText: "",
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
    if (activeTab === "campaigns") loadCampaigns()
    if (activeTab === "assets") loadAssets()
    if (activeTab === "calendar") loadCalendarEvents()
    if (activeTab === "newsletters") loadNewsletterData()
    if (activeTab === "ad-os") loadAdOsData()
  }, [activeTab, statusFilter])

  async function loadInitialData() {
    setIsLoading(true)
    try {
      const [dashboardResult, campaignsResult] = await Promise.all([
        getMarketingStudioDashboard(),
        getCampaigns({ status: statusFilter !== "all" ? (statusFilter as CampaignStatus) : undefined }),
      ])
      if (dashboardResult.success) setDashboard(dashboardResult.dashboard)
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
    const result = await getCalendarEvents({
      startDate: selectedDate ? format(selectedDate, "yyyy-MM-dd") : undefined,
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
      // Get user context first - if unavailable, just show empty data (not an error)
      const userContext = await getUserContextForPrediction()
      if (!userContext.success || !userContext.brokerageId || !userContext.userId) {
        // No brokerage context - show empty newsletter data without error
        setNewsletterCampaigns([])
        setScheduledSends([])
        setSubscriberCount(0)
        setNewsletterTemplates([])
        setLocalContent([])
        return
      }
      const { brokerageId, userId } = userContext

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

  async function loadAdOsData() {
    try {
      const userContext = await getUserContextForPrediction()
      if (userContext.success && userContext.userId && userContext.brokerageId) {
        setAgentId(userContext.userId)
        setBrokerageId(userContext.brokerageId)

        // Load agent's active listings
        const supabase = (await import("@/lib/supabase/client")).createClient()
        const { data: listingsData } = await supabase
          .from("listings")
          .select("id, address, city, zip, list_price")
          .eq("brokerage_id", userContext.brokerageId)
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
    const result = await createAsset({
      ...newAsset,
      campaignId: newAsset.campaignId || undefined,
    })
    if (result.success) {
      setIsCreateAssetOpen(false)
      setNewAsset({ assetName: "", assetType: "image", campaignId: "", previewText: "" })
      loadAssets()
      loadInitialData()
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
    const result = await createCalendarEvent({
      ...newEvent,
      campaignId: newEvent.campaignId || undefined,
    })
    if (result.success) {
      setIsCreateEventOpen(false)
      setNewEvent({ title: "", eventType: "publish", scheduledAt: "", campaignId: "", notes: "" })
      loadCalendarEvents()
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

    const userContext = await getUserContextForPrediction()
    if (!userContext.success || !userContext.userId || !userContext.brokerageId) {
      setIsPredicting(false)
      return
    }

    // Map asset_type to content_type
    const contentTypeMap: Record<string, string> = {
      social_post: "social_post",
      email: "newsletter",
      document: "blog_post",
      image: "ad_creative",
      video: "ad_creative",
    }

    const result = await predictPerformanceAction({
      brokerageId: userContext.brokerageId,
      userId: userContext.userId,
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
        {dashboard && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground">Active Campaigns</p>
                    <p className="text-2xl font-bold">{dashboard.campaignsByStatus.live ?? 0}</p>
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
                    <p className="text-2xl font-bold">{dashboard.assetsByApproval.pending ?? 0}</p>
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
                    <p className="text-2xl font-bold">{dashboard.totalAssets}</p>
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
                    <p className="text-2xl font-bold">{dashboard.upcomingEvents.length}</p>
                  </div>
                  <div className="h-12 w-12 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                    <CalendarIcon className="h-6 w-6 text-violet-600" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Main Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="grid w-full grid-cols-4 md:grid-cols-8 gap-2 h-auto bg-muted p-2 rounded-xl">
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
          </TabsList>

          {/* Ad OS Tab */}
          <TabsContent value="ad-os" className="space-y-6">
            {/* Row 1: Campaign Launcher + Competitor Watch */}
            <div className="grid lg:grid-cols-2 gap-6">
              <CampaignLauncherPanel
                listings={listings}
                agentId={agentId}
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
            <SellerSafeMarketingSummary listings={listings} />
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
                          <SelectItem value="image">Image</SelectItem>
                          <SelectItem value="video">Video</SelectItem>
                          <SelectItem value="document">Document</SelectItem>
                          <SelectItem value="social_post">Social Post</SelectItem>
                          <SelectItem value="email">Email</SelectItem>
                          <SelectItem value="direct_mail">Direct Mail</SelectItem>
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
                    <div className="space-y-2">
                      <Label>Preview Text</Label>
                      <Textarea
                        value={newAsset.previewText}
                        onChange={(e) => setNewAsset({ ...newAsset, previewText: e.target.value })}
                        placeholder="Brief description..."
                        rows={3}
                      />
                    </div>
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
                          {asset.asset_type === "image" && <Image className="h-12 w-12" />}
                          {asset.asset_type === "document" && <FileText className="h-12 w-12" />}
                          {asset.asset_type === "email" && <Mail className="h-12 w-12" />}
                          {!["video", "image", "document", "email"].includes(asset.asset_type) && (
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
          <TabsContent value="calendar" className="space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-[280px] justify-start text-left font-normal">
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {selectedDate ? format(selectedDate, "PPP") : <span>Pick a date</span>}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar mode="single" selected={selectedDate} onSelect={setSelectedDate} initialFocus />
                </PopoverContent>
              </Popover>
              <Dialog open={isCreateEventOpen} onOpenChange={setIsCreateEventOpen}>
                <DialogTrigger asChild>
                  <Button className="bg-violet-600 hover:bg-violet-700">
                    <Plus className="mr-2 h-4 w-4" />
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

            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {calendarEvents.map((event) => (
                <Card key={event.id}>
                  <CardContent className="pt-6">
                    <div className="flex items-start justify-between mb-2">
                      <Badge variant="outline" className="capitalize">
                        {event.event_type.replace("_", " ")}
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
          </TabsContent>

          {/* Newsletters Tab */}
          <TabsContent value="newsletters" className="space-y-6">
            {isNewsletterLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
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
                      <Button variant="outline" size="sm" asChild>
                        <a href="/newsletters">Manage Newsletters</a>
                      </Button>
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
                  <Button onClick={loadRegistry} variant="outline">
                    <Search className="mr-2 h-4 w-4" />
                    Search Content Registry
                  </Button>
                </div>
                {registryItems.length > 0 && (
                  <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {registryItems.map((item) => (
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
                <CardTitle className="flex items-center gap-2">
                  <QrCode className="h-5 w-5 text-violet-600" />
                  QR Code Management
                </CardTitle>
                <CardDescription>Link QR codes to marketing assets for tracking</CardDescription>
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
