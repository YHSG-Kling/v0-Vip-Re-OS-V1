"use client"

// app/dashboard/campaigns/ads/ads-dashboard-client.tsx
// Layer 9.3 — Ads Dashboard with Content Performance Predictor Widget

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
} from "lucide-react"
import { predictPerformanceAction } from "@/app/actions/content-prediction"
import { PredictionWidget, type PredictionData } from "@/components/prediction-widget"

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
  targeting_config: any
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

interface AdsDashboardClientProps {
  userId: string
  brokerageId: string
  userRole: string
  campaigns: AdCampaign[]
  performanceData: AdPerformance[]
}

// ─── STATUS CONFIG ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; color: string; bgColor: string }> = {
  draft: { icon: <Clock className="h-3 w-3" />, color: "text-gray-600", bgColor: "bg-gray-100" },
  active: { icon: <Play className="h-3 w-3" />, color: "text-green-600", bgColor: "bg-green-100" },
  paused: { icon: <Pause className="h-3 w-3" />, color: "text-yellow-600", bgColor: "bg-yellow-100" },
  completed: { icon: <CheckCircle className="h-3 w-3" />, color: "text-blue-600", bgColor: "bg-blue-100" },
  error: { icon: <AlertCircle className="h-3 w-3" />, color: "text-red-600", bgColor: "bg-red-100" },
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
  campaigns,
  performanceData,
}: AdsDashboardClientProps) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState("all")
  const [platformFilter, setPlatformFilter] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")

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
  const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0

  // Filter campaigns
  const filteredCampaigns = campaigns.filter((c) => {
    if (activeTab !== "all" && c.status !== activeTab) return false
    if (platformFilter && c.platform !== platformFilter) return false
    if (searchQuery && !c.campaign_name.toLowerCase().includes(searchQuery.toLowerCase())) return false
    return true
  })

  // Get performance for a campaign
  const getCampaignPerformance = (campaignId: string) => {
    return performanceData.filter((p) => p.ad_campaign_id === campaignId)
  }

  // Handle predict performance
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
    active: campaigns.filter((c) => c.status === "active").length,
    paused: campaigns.filter((c) => c.status === "paused").length,
    completed: campaigns.filter((c) => c.status === "completed").length,
  }

  return (
    <div className="container mx-auto py-6 px-4 max-w-7xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Ad Campaigns</h1>
          <p className="text-muted-foreground">Manage your advertising campaigns and creative variations</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => router.refresh()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            New Campaign
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
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
              <span className="text-sm text-muted-foreground">Conversions</span>
            </div>
            <div className="text-2xl font-bold">{totalConversions.toLocaleString()}</div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
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

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="all">All ({statusCounts.all})</TabsTrigger>
          <TabsTrigger value="draft">Draft ({statusCounts.draft})</TabsTrigger>
          <TabsTrigger value="active">Active ({statusCounts.active})</TabsTrigger>
          <TabsTrigger value="paused">Paused ({statusCounts.paused})</TabsTrigger>
          <TabsTrigger value="completed">Completed ({statusCounts.completed})</TabsTrigger>
        </TabsList>

        <TabsContent value={activeTab} className="space-y-4">
          {filteredCampaigns.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No campaigns found
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

              return (
                <Card key={campaign.id}>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <CardTitle className="text-lg">{campaign.campaign_name}</CardTitle>
                          <Badge className={`${statusConfig.bgColor} ${statusConfig.color}`}>
                            {statusConfig.icon}
                            <span className="ml-1 capitalize">{campaign.status}</span>
                          </Badge>
                          <Badge className={PLATFORM_COLORS[campaign.platform] || "bg-gray-100 text-gray-700"}>
                            {campaign.platform}
                          </Badge>
                        </div>
                        <CardDescription>
                          {campaign.objective} &middot; Budget: ${(campaign.daily_budget || campaign.lifetime_budget || 0).toLocaleString()}
                          {campaign.marketing_campaigns?.campaign_name && (
                            <span className="ml-2">
                              &middot; Campaign: {campaign.marketing_campaigns.campaign_name}
                            </span>
                          )}
                        </CardDescription>
                      </div>
                      <div className="text-right text-sm">
                        <div className="font-medium">${campaignSpend.toLocaleString()} spent</div>
                        <div className="text-muted-foreground">
                          {campaignClicks} clicks &middot; {campaignCtr.toFixed(2)}% CTR
                        </div>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {/* Creative Variations */}
                    {campaign.ad_creative_variations && campaign.ad_creative_variations.length > 0 && (
                      <div className="space-y-3">
                        <h4 className="text-sm font-medium text-muted-foreground">Creative Variations</h4>
                        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
                          {campaign.ad_creative_variations.map((creative) => (
                            <Card key={creative.id} className="bg-muted/30">
                              <CardContent className="p-3">
                                <div className="flex items-start justify-between mb-2">
                                  <span className="text-sm font-medium line-clamp-1">
                                    {creative.variation_name || creative.headline}
                                  </span>
                                  <Badge
                                    variant="outline"
                                    className={
                                      creative.approval_status === "approved"
                                        ? "text-green-600 border-green-300"
                                        : creative.approval_status === "rejected"
                                        ? "text-red-600 border-red-300"
                                        : "text-yellow-600 border-yellow-300"
                                    }
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
                                <div className="flex items-center gap-2">
                                  {creative.media_asset_url && (
                                    <div className="h-8 w-8 rounded bg-muted flex items-center justify-center">
                                      <Image className="h-4 w-4 text-muted-foreground" />
                                    </div>
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
                          ))}
                        </div>
                      </div>
                    )}

                    {(!campaign.ad_creative_variations || campaign.ad_creative_variations.length === 0) && (
                      <div className="text-center py-4 text-muted-foreground">
                        <Megaphone className="h-8 w-8 mx-auto mb-2 opacity-50" />
                        <p className="text-sm">No creative variations yet</p>
                        <Button variant="outline" size="sm" className="mt-2">
                          <Plus className="h-4 w-4 mr-1" />
                          Add Creative
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

      {/* Performance Prediction Dialog */}
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
  )
}
