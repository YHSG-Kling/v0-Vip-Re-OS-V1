"use client"

// app/dashboard/campaigns/ads/ads-dashboard-client.tsx
// Layer 9.5 — Full Ads Dashboard with Campaigns, Audiences, and Performance Tabs

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Plus,
  RefreshCw,
  TrendingUp,
  DollarSign,
  MousePointer,
  Eye,
  Target,
  BarChart3,
  Megaphone,
  Image,
  Play,
  Pause,
  CheckCircle,
  Clock,
  AlertCircle,
  Users,
  Sparkles,
  Check,
  X,
  Info,
  Loader2,
  Rocket,
} from "lucide-react"
import { predictPerformanceAction } from "@/app/actions/content-prediction"
import { PredictionWidget, type PredictionData } from "@/app/components/prediction-widget"
import { toast } from "sonner"
import {
  createAdCampaign,
  generateAdCreative,
  approveCreativeVariation,
  rejectCreativeVariation,
  launchAdCampaign,
  updateCampaignStatus,
  type TargetingConfig,
} from "@/lib/ads/ad-creator"
import {
  createAudience,
  syncAudience,
  approveAudience,
  deleteAudience,
  type AudienceType,
  type SourceRule,
} from "@/lib/ads/facebook-audience-sync"

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface AdCampaign {
  id: string
  campaign_name: string
  platform: string
  objective: string
  status: string
  daily_budget: number | null
  lifetime_budget: number | null
  start_date: string | null
  end_date: string | null
  targeting_config: TargetingConfig | null
  created_at: string
  marketing_campaigns?: { campaign_name: string }
  ad_creative_variations?: AdCreative[]
}

interface AdCreative {
  id: string
  variation_name: string
  headline: string
  primary_text: string
  description: string | null
  call_to_action: string | null
  media_asset_url: string | null
  destination_url: string | null
  approval_status: string
}

interface AdPerformance {
  id: string
  ad_campaign_id: string
  creative_variation_id: string | null
  impressions: number
  clicks: number
  ctr: number
  spend: number
  conversions: number
  leads: number
  cost_per_lead: number | null
  revenue_attributed: number | null
  captured_at: string
}

interface Audience {
  id: string
  audience_name: string
  audience_type: AudienceType
  status: string
  source_rule: SourceRule | null
  consent_basis: string | null
  last_synced_at: string | null
  created_at: string
  audience_sync_runs?: Array<{
    id: string
    run_status: string
    records_synced: number
    records_rejected: number
    completed_at: string | null
  }>
}

interface AdsDashboardClientProps {
  userId: string
  brokerageId: string
  userRole: string
  agentName: string
  campaigns: AdCampaign[]
  performanceData: AdPerformance[]
  audiences: Audience[]
}

// ─── STATUS CONFIG ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; color: string; bgColor: string }> = {
  draft: { icon: <Clock className="h-3 w-3" />, color: "text-gray-600", bgColor: "bg-gray-100" },
  pending_review: { icon: <Clock className="h-3 w-3" />, color: "text-yellow-600", bgColor: "bg-yellow-100" },
  approved: { icon: <CheckCircle className="h-3 w-3" />, color: "text-green-600", bgColor: "bg-green-100" },
  launching: { icon: <Rocket className="h-3 w-3" />, color: "text-blue-600", bgColor: "bg-blue-100" },
  active: { icon: <Play className="h-3 w-3" />, color: "text-green-600", bgColor: "bg-green-100" },
  paused: { icon: <Pause className="h-3 w-3" />, color: "text-yellow-600", bgColor: "bg-yellow-100" },
  completed: { icon: <CheckCircle className="h-3 w-3" />, color: "text-blue-600", bgColor: "bg-blue-100" },
  error: { icon: <AlertCircle className="h-3 w-3" />, color: "text-red-600", bgColor: "bg-red-100" },
  synced: { icon: <CheckCircle className="h-3 w-3" />, color: "text-green-600", bgColor: "bg-green-100" },
  running: { icon: <Loader2 className="h-3 w-3 animate-spin" />, color: "text-blue-600", bgColor: "bg-blue-100" },
}

const PLATFORM_COLORS: Record<string, string> = {
  facebook: "bg-blue-100 text-blue-700",
  instagram: "bg-pink-100 text-pink-700",
  google: "bg-green-100 text-green-700",
  linkedin: "bg-blue-100 text-blue-800",
  tiktok: "bg-gray-100 text-gray-800",
}

// ─── MAIN COMPONENT ───────────────────────────────────────────────────────────

export function AdsDashboardClient({
  userId,
  brokerageId,
  userRole,
  agentName,
  campaigns: initialCampaigns,
  performanceData,
  audiences: initialAudiences,
}: AdsDashboardClientProps) {
  const router = useRouter()
  const [mainTab, setMainTab] = useState("campaigns")
  const [statusFilter, setStatusFilter] = useState("all")
  const [platformFilter, setPlatformFilter] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")

  // Campaign state
  const [campaigns, setCampaigns] = useState(initialCampaigns)
  const [isCreateCampaignOpen, setIsCreateCampaignOpen] = useState(false)
  const [isGeneratingCreatives, setIsGeneratingCreatives] = useState(false)
  const [selectedCampaignForCreatives, setSelectedCampaignForCreatives] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  // Wizard state
  const [wizardStep, setWizardStep] = useState(1)
  const [newCampaign, setNewCampaign] = useState({
    campaignName: "",
    platform: "facebook" as "facebook" | "instagram" | "google" | "linkedin" | "tiktok",
    objective: "leads" as "awareness" | "traffic" | "leads" | "conversions",
    dailyBudget: "",
    lifetimeBudget: "",
    startDate: "",
    endDate: "",
    ageMin: 25,
    ageMax: 65,
    locations: [{ city: "", state: "", radius_miles: 25 }],
    interests: ["real estate", "home buying"],
    incomePercentile: "any" as "top_25" | "top_50" | "any",
    homeownerStatus: "any" as "renter" | "owner" | "any",
    listingAddress: "",
    listingPrice: "",
  })

  // Audience state
  const [audiences, setAudiences] = useState(initialAudiences)
  const [isCreateAudienceOpen, setIsCreateAudienceOpen] = useState(false)
  const [newAudience, setNewAudience] = useState({
    audienceName: "",
    audienceType: "contact_list" as AudienceType,
    sourceRuleType: "contact_list" as "website_visitors" | "contact_list" | "engagement",
    daysLookback: 30,
    contactTags: "",
    consentBasis: "",
  })
  const [isSyncing, setIsSyncing] = useState<string | null>(null)

  // Prediction state
  const [predictionDialogOpen, setPredictionDialogOpen] = useState(false)
  const [selectedCreative, setSelectedCreative] = useState<AdCreative | null>(null)
  const [selectedCampaign, setSelectedCampaign] = useState<AdCampaign | null>(null)
  const [currentPrediction, setCurrentPrediction] = useState<PredictionData | null>(null)
  const [isPredicting, setIsPredicting] = useState(false)

  // Calculate aggregate metrics
  const totalSpend = performanceData.reduce((sum, p) => sum + (p.spend || 0), 0)
  const totalImpressions = performanceData.reduce((sum, p) => sum + (p.impressions || 0), 0)
  const totalClicks = performanceData.reduce((sum, p) => sum + (p.clicks || 0), 0)
  const totalConversions = performanceData.reduce((sum, p) => sum + (p.conversions || 0), 0)
  const totalLeads = performanceData.reduce((sum, p) => sum + (p.leads || 0), 0)
  const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0
  const avgCpl = totalLeads > 0 ? totalSpend / totalLeads : 0

  // Filter campaigns
  const filteredCampaigns = campaigns.filter((c) => {
    if (statusFilter !== "all" && c.status !== statusFilter) return false
    if (platformFilter && c.platform !== platformFilter) return false
    if (searchQuery && !c.campaign_name.toLowerCase().includes(searchQuery.toLowerCase())) return false
    return true
  })

  // Get performance for a campaign
  const getCampaignPerformance = (campaignId: string) => {
    return performanceData.filter((p) => p.ad_campaign_id === campaignId)
  }

  // ─── HANDLERS ───────────────────────────────────────────────────────────────

  const handleCreateCampaign = async () => {
    setIsLoading(true)

    const targetingConfig: TargetingConfig = {
      age_min: newCampaign.ageMin,
      age_max: newCampaign.ageMax,
      locations: newCampaign.locations.filter((l) => l.city || l.state),
      interests: newCampaign.interests,
      custom_audience_ids: [],
      lookalike_source_audience_id: null,
      income_percentile: newCampaign.incomePercentile,
      homeowner_status: newCampaign.homeownerStatus,
    }

    const result = await createAdCampaign(userId, {
      brokerageId,
      agentUserId: userId,
      campaignName: newCampaign.campaignName,
      platform: newCampaign.platform,
      objective: newCampaign.objective,
      dailyBudget: newCampaign.dailyBudget ? parseFloat(newCampaign.dailyBudget) : undefined,
      lifetimeBudget: newCampaign.lifetimeBudget ? parseFloat(newCampaign.lifetimeBudget) : undefined,
      startDate: newCampaign.startDate || undefined,
      endDate: newCampaign.endDate || undefined,
      targetingConfig,
    })

    if (result.success) {
      setIsCreateCampaignOpen(false)
      setWizardStep(1)
      setNewCampaign({
        campaignName: "",
        platform: "facebook",
        objective: "leads",
        dailyBudget: "",
        lifetimeBudget: "",
        startDate: "",
        endDate: "",
        ageMin: 25,
        ageMax: 65,
        locations: [{ city: "", state: "", radius_miles: 25 }],
        interests: ["real estate", "home buying"],
        incomePercentile: "any",
        homeownerStatus: "any",
        listingAddress: "",
        listingPrice: "",
      })
      router.refresh()
    } else {
      toast.error(result.error || "Operation failed")
    }

    setIsLoading(false)
  }

  const handleGenerateCreatives = async (campaignId: string) => {
    setIsGeneratingCreatives(true)
    setSelectedCampaignForCreatives(campaignId)

    const result = await generateAdCreative(userId, {
      adCampaignId: campaignId,
      context: {
        brokerageId,
        agentName,
        listingAddress: newCampaign.listingAddress || undefined,
        listingPrice: newCampaign.listingPrice ? parseFloat(newCampaign.listingPrice) : undefined,
      },
    })

    if (result.success) {
      router.refresh()
    } else {
      toast.error(result.error || "Operation failed")
    }

    setIsGeneratingCreatives(false)
    setSelectedCampaignForCreatives(null)
  }

  const handleApproveCreative = async (variationId: string) => {
    setIsLoading(true)
    const result = await approveCreativeVariation(userId, variationId, brokerageId)
    if (result.success) {
      router.refresh()
    } else {
      toast.error(result.error || "Operation failed")
    }
    setIsLoading(false)
  }

  const handleRejectCreative = async (variationId: string) => {
    setIsLoading(true)
    const result = await rejectCreativeVariation(userId, variationId, brokerageId)
    if (result.success) {
      router.refresh()
    } else {
      toast.error(result.error || "Operation failed")
    }
    setIsLoading(false)
  }

  const handleLaunchCampaign = async (campaignId: string) => {
    setIsLoading(true)
    const result = await launchAdCampaign(userId, campaignId, brokerageId)
    if (result.success) {
      router.refresh()
    } else {
      toast.error(result.error || "Operation failed")
    }
    setIsLoading(false)
  }

  const handleApproveCampaign = async (campaignId: string) => {
    setIsLoading(true)
    const result = await updateCampaignStatus(userId, campaignId, brokerageId, "approved")
    if (result.success) {
      router.refresh()
    } else {
      toast.error(result.error || "Operation failed")
    }
    setIsLoading(false)
  }

  // Audience handlers
  const handleCreateAudience = async () => {
    if (!newAudience.consentBasis.trim()) {
      toast.error("Consent basis required for legal compliance")
      return
    }

    setIsLoading(true)

    const sourceRule: SourceRule = {
      type: newAudience.sourceRuleType,
      filters: {
        days_lookback: newAudience.daysLookback,
        contact_tags: newAudience.contactTags ? newAudience.contactTags.split(",").map((t) => t.trim()) : [],
      },
    }

    const result = await createAudience(userId, {
      brokerageId,
      audienceName: newAudience.audienceName,
      audienceType: newAudience.audienceType,
      sourceRule,
      consentBasis: newAudience.consentBasis,
    })

    if (result.success) {
      setIsCreateAudienceOpen(false)
      setNewAudience({
        audienceName: "",
        audienceType: "contact_list",
        sourceRuleType: "contact_list",
        daysLookback: 30,
        contactTags: "",
        consentBasis: "",
      })
      router.refresh()
    } else {
      toast.error(result.error || "Operation failed")
    }

    setIsLoading(false)
  }

  const handleSyncAudience = async (audienceId: string) => {
    setIsSyncing(audienceId)
    const result = await syncAudience(userId, { brokerageId, agentId: userId, audienceId })
    if (result.success) {
      router.refresh()
    } else {
      toast.error(result.error || "Operation failed")
    }
    setIsSyncing(null)
  }

  const handleApproveAudience = async (audienceId: string) => {
    setIsLoading(true)
    const result = await approveAudience(userId, audienceId, brokerageId)
    if (result.success) {
      router.refresh()
    } else {
      toast.error(result.error || "Operation failed")
    }
    setIsLoading(false)
  }

  // Prediction handler
  const handlePredictCreative = async (campaign: AdCampaign, creative: AdCreative) => {
    setSelectedCampaign(campaign)
    setSelectedCreative(creative)
    setPredictionDialogOpen(true)
    setIsPredicting(true)
    setCurrentPrediction(null)

    const contentText = `${creative.headline || ""}\n${creative.primary_text || ""}\n${creative.description || ""}`

    const result = await predictPerformanceAction({
      brokerageId,
      userId,
      contentType: "ad_creative",
      sourceTable: "ad_creative_variations",
      sourceId: creative.id,
      contentText,
      platform: campaign.platform,
    })

    if (result.success && result.prediction) {
      setCurrentPrediction(result.prediction)
    }
    setIsPredicting(false)
  }

  // Status counts
  const statusCounts = {
    all: campaigns.length,
    draft: campaigns.filter((c) => c.status === "draft").length,
    approved: campaigns.filter((c) => c.status === "approved").length,
    active: campaigns.filter((c) => c.status === "active").length,
    paused: campaigns.filter((c) => c.status === "paused").length,
  }

  return (
    <TooltipProvider>
      <div className="container mx-auto py-6 px-4 max-w-7xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Ad Campaigns</h1>
            <p className="text-muted-foreground">Manage your advertising campaigns, audiences, and performance</p>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => router.refresh()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-6">
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Total Spend</span>
              </div>
              <div className="text-2xl font-bold">${totalSpend.toLocaleString()}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Impressions</span>
              </div>
              <div className="text-2xl font-bold">{totalImpressions.toLocaleString()}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <MousePointer className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Clicks</span>
              </div>
              <div className="text-2xl font-bold">{totalClicks.toLocaleString()}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Avg CTR</span>
              </div>
              <div className="text-2xl font-bold">{avgCtr.toFixed(2)}%</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <Target className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Leads</span>
              </div>
              <div className="text-2xl font-bold">{totalLeads.toLocaleString()}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">CPL</span>
              </div>
              <div className="text-2xl font-bold">${avgCpl.toFixed(2)}</div>
            </CardContent>
          </Card>
        </div>

        {/* Main Tabs */}
        <Tabs value={mainTab} onValueChange={setMainTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="campaigns">
              <Megaphone className="h-4 w-4 mr-2" />
              Ad Campaigns ({campaigns.length})
            </TabsTrigger>
            <TabsTrigger value="audiences">
              <Users className="h-4 w-4 mr-2" />
              Audiences ({audiences.length})
            </TabsTrigger>
            <TabsTrigger value="performance">
              <BarChart3 className="h-4 w-4 mr-2" />
              Performance
            </TabsTrigger>
          </TabsList>

          {/* ═══════════════════════════════════════════════════════════════════ */}
          {/* CAMPAIGNS TAB */}
          {/* ═══════════════════════════════════════════════════════════════════ */}
          <TabsContent value="campaigns" className="space-y-4">
            {/* Campaign Actions */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Input
                  placeholder="Search campaigns..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-64"
                />
                <Select value={platformFilter || "all"} onValueChange={(v) => setPlatformFilter(v === "all" ? null : v)}>
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="All Platforms" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Platforms</SelectItem>
                    <SelectItem value="facebook">Facebook</SelectItem>
                    <SelectItem value="instagram">Instagram</SelectItem>
                    <SelectItem value="google">Google</SelectItem>
                    <SelectItem value="linkedin">LinkedIn</SelectItem>
                    <SelectItem value="tiktok">TikTok</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={() => setIsCreateCampaignOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                New Campaign
              </Button>
            </div>

            {/* Status Tabs */}
            <Tabs value={statusFilter} onValueChange={setStatusFilter}>
              <TabsList>
                <TabsTrigger value="all">All ({statusCounts.all})</TabsTrigger>
                <TabsTrigger value="draft">Draft ({statusCounts.draft})</TabsTrigger>
                <TabsTrigger value="approved">Approved ({statusCounts.approved})</TabsTrigger>
                <TabsTrigger value="active">Active ({statusCounts.active})</TabsTrigger>
                <TabsTrigger value="paused">Paused ({statusCounts.paused})</TabsTrigger>
              </TabsList>

              <TabsContent value={statusFilter} className="mt-4 space-y-4">
                {filteredCampaigns.length === 0 ? (
                  <Card>
                    <CardContent className="py-8 text-center text-muted-foreground">
                      <Megaphone className="h-12 w-12 mx-auto mb-4 opacity-30" />
                      <p>No campaigns found</p>
                      <Button variant="outline" className="mt-4" onClick={() => setIsCreateCampaignOpen(true)}>
                        <Plus className="h-4 w-4 mr-2" />
                        Create Your First Campaign
                      </Button>
                    </CardContent>
                  </Card>
                ) : (
                  filteredCampaigns.map((campaign) => {
                    const perf = getCampaignPerformance(campaign.id)
                    const campaignSpend = perf.reduce((sum, p) => sum + (p.spend || 0), 0)
                    const campaignClicks = perf.reduce((sum, p) => sum + (p.clicks || 0), 0)
                    const campaignImpressions = perf.reduce((sum, p) => sum + (p.impressions || 0), 0)
                    const campaignCtr = campaignImpressions > 0 ? (campaignClicks / campaignImpressions) * 100 : 0
                    const statusConfig = STATUS_CONFIG[campaign.status] || STATUS_CONFIG.draft
                    const hasApprovedCreatives = campaign.ad_creative_variations?.some(
                      (c) => c.approval_status === "approved"
                    )

                    return (
                      <Card key={campaign.id}>
                        <CardHeader className="pb-2">
                          <div className="flex items-start justify-between">
                            <div>
                              <div className="flex items-center gap-2 mb-1">
                                <CardTitle className="text-lg">{campaign.campaign_name}</CardTitle>
                                <Badge className={`${statusConfig.bgColor} ${statusConfig.color}`}>
                                  {statusConfig.icon}
                                  <span className="ml-1 capitalize">{campaign.status.replace("_", " ")}</span>
                                </Badge>
                                <Badge className={PLATFORM_COLORS[campaign.platform] || "bg-gray-100 text-gray-700"}>
                                  {campaign.platform}
                                </Badge>
                              </div>
                              <CardDescription>
                                {campaign.objective} &middot; Budget: $
                                {(campaign.daily_budget || campaign.lifetime_budget || 0).toLocaleString()}
                                {campaign.daily_budget ? "/day" : " lifetime"}
                              </CardDescription>
                            </div>
                            <div className="flex items-center gap-2">
                              {campaign.status === "draft" && (
                                <>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleGenerateCreatives(campaign.id)}
                                    disabled={isGeneratingCreatives && selectedCampaignForCreatives === campaign.id}
                                  >
                                    {isGeneratingCreatives && selectedCampaignForCreatives === campaign.id ? (
                                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                    ) : (
                                      <Sparkles className="h-4 w-4 mr-1" />
                                    )}
                                    Generate AI Creatives
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="default"
                                    onClick={() => handleApproveCampaign(campaign.id)}
                                    disabled={isLoading || !hasApprovedCreatives}
                                    title={!hasApprovedCreatives ? "Approve at least one creative first" : ""}
                                  >
                                    <Check className="h-4 w-4 mr-1" />
                                    Approve
                                  </Button>
                                </>
                              )}
                              {campaign.status === "approved" && (
                                <Button
                                  size="sm"
                                  variant="default"
                                  onClick={() => handleLaunchCampaign(campaign.id)}
                                  disabled={isLoading}
                                >
                                  <Rocket className="h-4 w-4 mr-1" />
                                  Launch Campaign
                                </Button>
                              )}
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent>
                          {/* Performance Summary */}
                          {perf.length > 0 && (
                            <div className="flex items-center gap-4 text-sm text-muted-foreground mb-4">
                              <span>${campaignSpend.toLocaleString()} spent</span>
                              <span>{campaignImpressions.toLocaleString()} impressions</span>
                              <span>{campaignClicks.toLocaleString()} clicks</span>
                              <span>{campaignCtr.toFixed(2)}% CTR</span>
                            </div>
                          )}

                          {/* Creative Variations */}
                          {campaign.ad_creative_variations && campaign.ad_creative_variations.length > 0 ? (
                            <div className="space-y-3">
                              <h4 className="text-sm font-medium text-muted-foreground">Creative Variations (A/B/C)</h4>
                              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
                                {campaign.ad_creative_variations.map((creative) => {
                                  const creativeStatusConfig =
                                    STATUS_CONFIG[creative.approval_status] || STATUS_CONFIG.draft

                                  return (
                                    <Card key={creative.id} className="bg-muted/30">
                                      <CardContent className="p-3">
                                        <div className="flex items-start justify-between mb-2">
                                          <span className="text-sm font-medium line-clamp-1">
                                            {creative.variation_name || "Variation"}
                                          </span>
                                          <Badge
                                            className={`${creativeStatusConfig.bgColor} ${creativeStatusConfig.color}`}
                                          >
                                            {creative.approval_status}
                                          </Badge>
                                        </div>
                                        {creative.headline && (
                                          <p className="text-sm font-medium mb-1">{creative.headline}</p>
                                        )}
                                        {creative.primary_text && (
                                          <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                                            {creative.primary_text}
                                          </p>
                                        )}
                                        {creative.call_to_action && (
                                          <Badge variant="outline" className="text-xs mb-2">
                                            {creative.call_to_action}
                                          </Badge>
                                        )}
                                        <div className="flex items-center gap-2 mt-2">
                                          {creative.approval_status === "draft" && (
                                            <>
                                              <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => handleApproveCreative(creative.id)}
                                                disabled={isLoading}
                                              >
                                                <Check className="h-4 w-4" />
                                              </Button>
                                              <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => handleRejectCreative(creative.id)}
                                                disabled={isLoading}
                                              >
                                                <X className="h-4 w-4" />
                                              </Button>
                                            </>
                                          )}
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => handlePredictCreative(campaign, creative)}
                                            className="ml-auto"
                                          >
                                            <TrendingUp className="h-4 w-4 mr-1" />
                                            Predict
                                          </Button>
                                        </div>
                                      </CardContent>
                                    </Card>
                                  )
                                })}
                              </div>
                            </div>
                          ) : (
                            <div className="text-center py-4 text-muted-foreground">
                              <Image className="h-8 w-8 mx-auto mb-2 opacity-50" />
                              <p className="text-sm">No creative variations yet</p>
                              <Button
                                variant="outline"
                                size="sm"
                                className="mt-2"
                                onClick={() => handleGenerateCreatives(campaign.id)}
                                disabled={isGeneratingCreatives}
                              >
                                <Sparkles className="h-4 w-4 mr-1" />
                                Generate AI Creatives
                              </Button>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    )
                  })
                )}
              </TabsContent>
            </Tabs>
          </TabsContent>

          {/* ═══════════════════════════════════════════════════════════════════ */}
          {/* AUDIENCES TAB */}
          {/* ═══════════════════════════════════════════════════════════════════ */}
          <TabsContent value="audiences" className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-muted-foreground">
                Custom audiences for Facebook ad targeting and retargeting
              </p>
              <Button onClick={() => setIsCreateAudienceOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create Audience
              </Button>
            </div>

            {audiences.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  <Users className="h-12 w-12 mx-auto mb-4 opacity-30" />
                  <p>No audiences created yet</p>
                  <Button variant="outline" className="mt-4" onClick={() => setIsCreateAudienceOpen(true)}>
                    <Plus className="h-4 w-4 mr-2" />
                    Create Your First Audience
                  </Button>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {audiences.map((audience) => {
                  const statusConfig = STATUS_CONFIG[audience.status] || STATUS_CONFIG.pending_review
                  const latestRun = audience.audience_sync_runs?.[0]

                  return (
                    <Card key={audience.id}>
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="font-medium">{audience.audience_name}</h3>
                              <Badge className={`${statusConfig.bgColor} ${statusConfig.color}`}>
                                {statusConfig.icon}
                                <span className="ml-1 capitalize">{audience.status.replace("_", " ")}</span>
                              </Badge>
                              <Badge variant="outline" className="capitalize">
                                {audience.audience_type.replace("_", " ")}
                              </Badge>
                            </div>
                            <p className="text-sm text-muted-foreground">
                              {audience.last_synced_at
                                ? `Last synced: ${new Date(audience.last_synced_at).toLocaleDateString()}`
                                : "Never synced"}
                              {latestRun && latestRun.run_status === "completed" && (
                                <span className="ml-2">
                                  ({latestRun.records_synced} records synced)
                                </span>
                              )}
                            </p>
                            {audience.consent_basis && (
                              <p className="text-xs text-muted-foreground mt-1">
                                Consent basis: {audience.consent_basis}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            {audience.status === "pending_review" && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleApproveAudience(audience.id)}
                                disabled={isLoading}
                              >
                                <Check className="h-4 w-4 mr-1" />
                                Approve
                              </Button>
                            )}
                            {audience.status === "approved" && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleSyncAudience(audience.id)}
                                disabled={isSyncing === audience.id}
                              >
                                {isSyncing === audience.id ? (
                                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                ) : (
                                  <RefreshCw className="h-4 w-4 mr-1" />
                                )}
                                Sync Now
                              </Button>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            )}
          </TabsContent>

          {/* ═══════════════════════════════════════════════════════════════════ */}
          {/* PERFORMANCE TAB */}
          {/* ═══════════════════════════════════════════════════════════════════ */}
          <TabsContent value="performance" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Campaign Performance</CardTitle>
                <CardDescription>
                  Detailed performance metrics grouped by campaign
                </CardDescription>
              </CardHeader>
              <CardContent>
                {performanceData.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <BarChart3 className="h-12 w-12 mx-auto mb-4 opacity-30" />
                    <p>No performance data available yet</p>
                    <p className="text-sm mt-2">
                      Launch a campaign to start tracking performance
                    </p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Campaign</TableHead>
                        <TableHead className="text-right">Spend</TableHead>
                        <TableHead className="text-right">Impressions</TableHead>
                        <TableHead className="text-right">Clicks</TableHead>
                        <TableHead className="text-right">CTR</TableHead>
                        <TableHead className="text-right">Leads</TableHead>
                        <TableHead className="text-right">Conversions</TableHead>
                        <TableHead className="text-right">CPL</TableHead>
                        <TableHead className="text-right">Revenue</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {campaigns.map((campaign) => {
                        const perf = getCampaignPerformance(campaign.id)
                        if (perf.length === 0) return null

                        const spend = perf.reduce((sum, p) => sum + (p.spend || 0), 0)
                        const impressions = perf.reduce((sum, p) => sum + (p.impressions || 0), 0)
                        const clicks = perf.reduce((sum, p) => sum + (p.clicks || 0), 0)
                        const leads = perf.reduce((sum, p) => sum + (p.leads || 0), 0)
                        const conversions = perf.reduce((sum, p) => sum + (p.conversions || 0), 0)
                        const revenue = perf.reduce((sum, p) => sum + (p.revenue_attributed || 0), 0)
                        const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0
                        const cpl = leads > 0 ? spend / leads : 0

                        return (
                          <TableRow key={campaign.id}>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                {campaign.campaign_name}
                                <Badge
                                  className={
                                    PLATFORM_COLORS[campaign.platform] || "bg-gray-100 text-gray-700"
                                  }
                                >
                                  {campaign.platform}
                                </Badge>
                              </div>
                            </TableCell>
                            <TableCell className="text-right">${spend.toLocaleString()}</TableCell>
                            <TableCell className="text-right">{impressions.toLocaleString()}</TableCell>
                            <TableCell className="text-right">{clicks.toLocaleString()}</TableCell>
                            <TableCell className="text-right">{ctr.toFixed(2)}%</TableCell>
                            <TableCell className="text-right">{leads.toLocaleString()}</TableCell>
                            <TableCell className="text-right">{conversions.toLocaleString()}</TableCell>
                            <TableCell className="text-right">${cpl.toFixed(2)}</TableCell>
                            <TableCell className="text-right">${revenue.toLocaleString()}</TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* CREATE CAMPAIGN WIZARD DIALOG */}
        {/* ═══════════════════════════════════════════════════════════════════ */}
        <Dialog open={isCreateCampaignOpen} onOpenChange={setIsCreateCampaignOpen}>
          <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create New Ad Campaign</DialogTitle>
              <DialogDescription>
                Step {wizardStep} of 5 - {["Platform & Objective", "Budget & Schedule", "Targeting", "Creative Context", "Review"][wizardStep - 1]}
              </DialogDescription>
            </DialogHeader>

            {/* Step Indicators */}
            <div className="flex items-center justify-between mb-6">
              {[1, 2, 3, 4, 5].map((step) => (
                <div key={step} className="flex items-center">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                      step === wizardStep
                        ? "bg-primary text-primary-foreground"
                        : step < wizardStep
                        ? "bg-green-500 text-white"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {step < wizardStep ? <Check className="h-4 w-4" /> : step}
                  </div>
                  {step < 5 && <div className="w-12 h-1 bg-muted mx-2" />}
                </div>
              ))}
            </div>

            {/* Step 1: Platform & Objective */}
            {wizardStep === 1 && (
              <div className="space-y-4">
                <div>
                  <Label>Campaign Name</Label>
                  <Input
                    value={newCampaign.campaignName}
                    onChange={(e) => setNewCampaign({ ...newCampaign, campaignName: e.target.value })}
                    placeholder="Spring Listings Campaign"
                  />
                </div>
                <div>
                  <Label>Platform</Label>
                  <Select
                    value={newCampaign.platform}
                    onValueChange={(v) => setNewCampaign({ ...newCampaign, platform: v as any })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="facebook">Facebook</SelectItem>
                      <SelectItem value="instagram">Instagram</SelectItem>
                      <SelectItem value="google">Google Ads</SelectItem>
                      <SelectItem value="linkedin">LinkedIn</SelectItem>
                      <SelectItem value="tiktok">TikTok</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Objective</Label>
                  <Select
                    value={newCampaign.objective}
                    onValueChange={(v) => setNewCampaign({ ...newCampaign, objective: v as any })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="awareness">Brand Awareness</SelectItem>
                      <SelectItem value="traffic">Website Traffic</SelectItem>
                      <SelectItem value="leads">Lead Generation</SelectItem>
                      <SelectItem value="conversions">Conversions</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* Step 2: Budget & Schedule */}
            {wizardStep === 2 && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Daily Budget ($)</Label>
                    <Input
                      type="number"
                      value={newCampaign.dailyBudget}
                      onChange={(e) => setNewCampaign({ ...newCampaign, dailyBudget: e.target.value })}
                      placeholder="50"
                    />
                  </div>
                  <div>
                    <Label>Lifetime Budget ($)</Label>
                    <Input
                      type="number"
                      value={newCampaign.lifetimeBudget}
                      onChange={(e) => setNewCampaign({ ...newCampaign, lifetimeBudget: e.target.value })}
                      placeholder="1000"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Start Date</Label>
                    <Input
                      type="date"
                      value={newCampaign.startDate}
                      onChange={(e) => setNewCampaign({ ...newCampaign, startDate: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>End Date</Label>
                    <Input
                      type="date"
                      value={newCampaign.endDate}
                      onChange={(e) => setNewCampaign({ ...newCampaign, endDate: e.target.value })}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Step 3: Targeting */}
            {wizardStep === 3 && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Age Range (Min)</Label>
                    <Input
                      type="number"
                      value={newCampaign.ageMin}
                      onChange={(e) => setNewCampaign({ ...newCampaign, ageMin: parseInt(e.target.value) || 25 })}
                      min={18}
                      max={65}
                    />
                  </div>
                  <div>
                    <Label>Age Range (Max)</Label>
                    <Input
                      type="number"
                      value={newCampaign.ageMax}
                      onChange={(e) => setNewCampaign({ ...newCampaign, ageMax: parseInt(e.target.value) || 65 })}
                      min={18}
                      max={65}
                    />
                  </div>
                </div>
                <div>
                  <Label>Homeowner Status</Label>
                  <Select
                    value={newCampaign.homeownerStatus}
                    onValueChange={(v) => setNewCampaign({ ...newCampaign, homeownerStatus: v as any })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Any</SelectItem>
                      <SelectItem value="owner">Homeowner</SelectItem>
                      <SelectItem value="renter">Renter</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Income Percentile</Label>
                  <Select
                    value={newCampaign.incomePercentile}
                    onValueChange={(v) => setNewCampaign({ ...newCampaign, incomePercentile: v as any })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Any Income</SelectItem>
                      <SelectItem value="top_50">Top 50%</SelectItem>
                      <SelectItem value="top_25">Top 25%</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Location (City, State)</Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="City"
                      value={newCampaign.locations[0]?.city || ""}
                      onChange={(e) =>
                        setNewCampaign({
                          ...newCampaign,
                          locations: [{ ...newCampaign.locations[0], city: e.target.value }],
                        })
                      }
                    />
                    <Input
                      placeholder="State"
                      value={newCampaign.locations[0]?.state || ""}
                      onChange={(e) =>
                        setNewCampaign({
                          ...newCampaign,
                          locations: [{ ...newCampaign.locations[0], state: e.target.value }],
                        })
                      }
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Step 4: Creative Context */}
            {wizardStep === 4 && (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Provide context for AI to generate personalized ad creatives
                </p>
                <div>
                  <Label>Listing Address (optional)</Label>
                  <Input
                    value={newCampaign.listingAddress}
                    onChange={(e) => setNewCampaign({ ...newCampaign, listingAddress: e.target.value })}
                    placeholder="123 Main St, Austin, TX 78701"
                  />
                </div>
                <div>
                  <Label>Listing Price (optional)</Label>
                  <Input
                    type="number"
                    value={newCampaign.listingPrice}
                    onChange={(e) => setNewCampaign({ ...newCampaign, listingPrice: e.target.value })}
                    placeholder="450000"
                  />
                </div>
              </div>
            )}

            {/* Step 5: Review */}
            {wizardStep === 5 && (
              <div className="space-y-4">
                <div className="bg-muted p-4 rounded-lg space-y-2">
                  <p><strong>Campaign Name:</strong> {newCampaign.campaignName}</p>
                  <p><strong>Platform:</strong> {newCampaign.platform}</p>
                  <p><strong>Objective:</strong> {newCampaign.objective}</p>
                  <p>
                    <strong>Budget:</strong>{" "}
                    {newCampaign.dailyBudget ? `$${newCampaign.dailyBudget}/day` : ""}
                    {newCampaign.lifetimeBudget ? ` $${newCampaign.lifetimeBudget} lifetime` : ""}
                  </p>
                  <p><strong>Age Range:</strong> {newCampaign.ageMin} - {newCampaign.ageMax}</p>
                  <p><strong>Homeowner Status:</strong> {newCampaign.homeownerStatus}</p>
                </div>
              </div>
            )}

            <DialogFooter className="flex justify-between">
              <Button
                variant="outline"
                onClick={() => setWizardStep((s) => Math.max(1, s - 1))}
                disabled={wizardStep === 1}
              >
                Back
              </Button>
              {wizardStep < 5 ? (
                <Button
                  onClick={() => setWizardStep((s) => s + 1)}
                  disabled={wizardStep === 1 && !newCampaign.campaignName}
                >
                  Next
                </Button>
              ) : (
                <Button onClick={handleCreateCampaign} disabled={isLoading}>
                  {isLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Create Campaign
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* CREATE AUDIENCE DIALOG */}
        {/* ═══════════════════════════════════════════════════════════════════ */}
        <Dialog open={isCreateAudienceOpen} onOpenChange={setIsCreateAudienceOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Custom Audience</DialogTitle>
              <DialogDescription>
                Create a Facebook custom audience for ad targeting
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div>
                <Label>Audience Name</Label>
                <Input
                  value={newAudience.audienceName}
                  onChange={(e) => setNewAudience({ ...newAudience, audienceName: e.target.value })}
                  placeholder="High-Intent Buyers"
                />
              </div>

              <div>
                <Label>Audience Type</Label>
                <Select
                  value={newAudience.audienceType}
                  onValueChange={(v) =>
                    setNewAudience({ ...newAudience, audienceType: v as AudienceType, sourceRuleType: v as any })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="contact_list">Contact List</SelectItem>
                    <SelectItem value="website_visitors">Website Visitors</SelectItem>
                    <SelectItem value="engagement">Engaged Contacts</SelectItem>
                    <SelectItem value="lookalike">Lookalike Audience</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {newAudience.sourceRuleType === "website_visitors" && (
                <div>
                  <Label>Days Lookback</Label>
                  <Input
                    type="number"
                    value={newAudience.daysLookback}
                    onChange={(e) => setNewAudience({ ...newAudience, daysLookback: parseInt(e.target.value) || 30 })}
                    min={1}
                    max={180}
                  />
                </div>
              )}

              {newAudience.sourceRuleType === "contact_list" && (
                <div>
                  <Label>Contact Tags (comma-separated, optional)</Label>
                  <Input
                    value={newAudience.contactTags}
                    onChange={(e) => setNewAudience({ ...newAudience, contactTags: e.target.value })}
                    placeholder="buyer, hot-lead"
                  />
                </div>
              )}

              <div>
                <div className="flex items-center gap-2">
                  <Label>Consent Basis (REQUIRED)</Label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-4 w-4 text-muted-foreground cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p>
                        Required for legal compliance. Example: GDPR Article 6(a) — explicit consent,
                        or CCPA — opt-in consent collected at signup
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <Textarea
                  value={newAudience.consentBasis}
                  onChange={(e) => setNewAudience({ ...newAudience, consentBasis: e.target.value })}
                  placeholder="GDPR Article 6(a) — explicit consent collected at property inquiry form submission"
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  This field is legally required. Audiences cannot be created without a valid consent basis.
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setIsCreateAudienceOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleCreateAudience}
                disabled={isLoading || !newAudience.audienceName || !newAudience.consentBasis}
              >
                {isLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                Create Audience
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* PREDICTION DIALOG */}
        {/* ═══════════════════════════════════════════════════════════════════ */}
        <Dialog open={predictionDialogOpen} onOpenChange={setPredictionDialogOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Ad Creative Performance Prediction</DialogTitle>
              <DialogDescription>
                AI-powered analysis of your ad creative&apos;s potential performance
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              {selectedCreative && selectedCampaign && (
                <div className="mb-4 p-3 bg-muted rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Badge className={PLATFORM_COLORS[selectedCampaign.platform] || "bg-gray-100"}>
                      {selectedCampaign.platform}
                    </Badge>
                    <Badge variant="outline" className="text-xs">
                      {selectedCreative.approval_status}
                    </Badge>
                  </div>
                  {selectedCreative.headline && (
                    <p className="font-medium text-sm">{selectedCreative.headline}</p>
                  )}
                  {selectedCreative.primary_text && (
                    <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                      {selectedCreative.primary_text}
                    </p>
                  )}
                </div>
              )}
              <PredictionWidget
                prediction={currentPrediction}
                isLoading={isPredicting}
                onPredict={() =>
                  selectedCampaign &&
                  selectedCreative &&
                  handlePredictCreative(selectedCampaign, selectedCreative)
                }
                showPredictButton={!!currentPrediction}
              />
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  )
}
