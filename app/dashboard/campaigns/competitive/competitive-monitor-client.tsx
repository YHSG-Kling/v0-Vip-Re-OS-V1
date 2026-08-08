"use client"

// app/dashboard/campaigns/competitive/competitive-monitor-client.tsx
// Layer 9.4 — Competitive Ad + Post Monitor Dashboard

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Megaphone,
  FileText,
  Lightbulb,
  AlertTriangle,
  ExternalLink,
  Image as ImageIcon,
  Calendar,
  RefreshCw,
  Eye,
  Sparkles,
  TrendingUp,
  MessageSquare,
  Target,
  Zap,
  CheckCircle,
  Clock,
  Loader2,
  Plus,
} from "lucide-react"
import { TrackCompetitorDialog } from "./track-competitor-dialog"
import {
  generateInsights,
  resolveAlert,
  type CompetitorAd,
  type CompetitorPost,
  type AdInsight,
  type TrendAlert,
} from "@/lib/ads/ad-monitor"

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface CompetitiveMonitorClientProps {
  brokerageId: string
  initialAds: CompetitorAd[]
  initialPosts: CompetitorPost[]
  initialInsights: AdInsight[]
  initialAlerts: TrendAlert[]
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function formatDate(dateString: string | null): string {
  if (!dateString) return "N/A"
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })
}

function formatDateWithTime(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function getPlatformBadgeColor(platform: string): string {
  const colors: Record<string, string> = {
    facebook: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    instagram: "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300",
    google: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    linkedin: "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",
    tiktok: "bg-neutral-100 text-neutral-800 dark:bg-neutral-900/30 dark:text-neutral-300",
    twitter: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
  }
  return colors[platform.toLowerCase()] || "bg-muted text-muted-foreground"
}

function getSeverityBadgeColor(severity: string): string {
  const colors: Record<string, string> = {
    low: "bg-muted text-muted-foreground",
    medium: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    high: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
    critical: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  }
  return colors[severity.toLowerCase()] || "bg-muted text-muted-foreground"
}

function getInsightTypeIcon(type: string) {
  const icons: Record<string, React.ReactNode> = {
    copy_trend: <MessageSquare className="h-4 w-4" />,
    creative_trend: <ImageIcon className="h-4 w-4" />,
    cadence_pattern: <Calendar className="h-4 w-4" />,
    cta_style: <Target className="h-4 w-4" />,
    top_angle: <TrendingUp className="h-4 w-4" />,
    recommendation: <Lightbulb className="h-4 w-4" />,
    competitor_launch: <Zap className="h-4 w-4" />,
  }
  return icons[type] || <Sparkles className="h-4 w-4" />
}

function getInsightTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    copy_trend: "Copy Trend",
    creative_trend: "Creative Trend",
    cadence_pattern: "Cadence Pattern",
    cta_style: "CTA Style",
    top_angle: "Top Angle",
    recommendation: "Recommendation",
    competitor_launch: "Competitor Launch",
  }
  return labels[type] || type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase())
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength) + "..."
}

// ─── COMPONENT ────────────────────────────────────────────────────────────────

export function CompetitiveMonitorClient({
  brokerageId,
  initialAds,
  initialPosts,
  initialInsights,
  initialAlerts,
}: CompetitiveMonitorClientProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // State
  const [ads] = useState<CompetitorAd[]>(initialAds)
  const [posts] = useState<CompetitorPost[]>(initialPosts)
  const [insights, setInsights] = useState<AdInsight[]>(initialInsights)
  const [alerts, setAlerts] = useState<TrendAlert[]>(initialAlerts)

  const [generatingInsights, setGeneratingInsights] = useState(false)
  const [selectedAd, setSelectedAd] = useState<CompetitorAd | null>(null)
  const [selectedPost, setSelectedPost] = useState<CompetitorPost | null>(null)
  const [trackOpen, setTrackOpen] = useState(false)

  // Group insights by type
  const groupedInsights = insights.reduce(
    (acc, insight) => {
      const type = insight.insight_type
      if (!acc[type]) acc[type] = []
      acc[type].push(insight)
      return acc
    },
    {} as Record<string, AdInsight[]>
  )

  // Handlers
  async function handleGenerateInsights() {
    setGeneratingInsights(true)
    try {
      const result = await generateInsights(brokerageId)
      if (result.success) {
        startTransition(() => {
          router.refresh()
        })
      } else {
        console.error("Failed to generate insights:", result.error)
      }
    } catch (err) {
      console.error("Error generating insights:", err)
    } finally {
      setGeneratingInsights(false)
    }
  }

  async function handleResolveAlert(alertId: string, currentlyResolved: boolean) {
    if (currentlyResolved) return // Already resolved

    const result = await resolveAlert(alertId)
    if (result.success) {
      setAlerts((prev) =>
        prev.map((a) =>
          a.id === alertId
            ? { ...a, is_resolved: true, resolved_at: new Date().toISOString() }
            : a
        )
      )
    }
  }

  return (
    <Tabs defaultValue="ads" className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
      <TabsList className="grid w-full max-w-2xl grid-cols-4">
        <TabsTrigger value="ads" className="flex items-center gap-2">
          <Megaphone className="h-4 w-4" />
          <span className="hidden sm:inline">Competitor Ads</span>
          <span className="sm:hidden">Ads</span>
          {ads.length > 0 && (
            <Badge variant="secondary" className="ml-1 h-5 min-w-5 px-1.5">
              {ads.length}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="posts" className="flex items-center gap-2">
          <FileText className="h-4 w-4" />
          <span className="hidden sm:inline">Competitor Posts</span>
          <span className="sm:hidden">Posts</span>
          {posts.length > 0 && (
            <Badge variant="secondary" className="ml-1 h-5 min-w-5 px-1.5">
              {posts.length}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="insights" className="flex items-center gap-2">
          <Lightbulb className="h-4 w-4" />
          <span className="hidden sm:inline">AI Insights</span>
          <span className="sm:hidden">Insights</span>
          {insights.length > 0 && (
            <Badge variant="secondary" className="ml-1 h-5 min-w-5 px-1.5">
              {insights.length}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="alerts" className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          <span className="hidden sm:inline">Alerts</span>
          <span className="sm:hidden">Alerts</span>
          {alerts.filter((a) => !a.is_resolved).length > 0 && (
            <Badge variant="destructive" className="ml-1 h-5 min-w-5 px-1.5">
              {alerts.filter((a) => !a.is_resolved).length}
            </Badge>
          )}
        </TabsTrigger>
      </TabsList>
        {/* Manual ingest door. The Exa cron fills competitor_ads on its own, but
            NOTHING wrote competitor_posts — so the Posts tab could only ever be
            empty until an agent had a way to add what they actually see. */}
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setTrackOpen(true)}>
          <Plus className="h-4 w-4" />
          Track a competitor
        </Button>
      </div>

      <TrackCompetitorDialog open={trackOpen} onOpenChange={setTrackOpen} />

      {/* ─── COMPETITOR ADS TAB ──────────────────────────────────────────────── */}
      <TabsContent value="ads" className="space-y-6">
        {ads.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Megaphone className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-semibold">No Competitor Ads Yet</h3>
              <p className="mt-2 text-center text-muted-foreground">
                Competitor ads will appear here once they are ingested from your monitoring sources.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {ads.map((ad) => (
              <Card
                key={ad.id}
                className="group cursor-pointer transition-shadow hover:shadow-md"
                onClick={() => setSelectedAd(ad)}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <Badge className={getPlatformBadgeColor(ad.source_platform)}>
                      {ad.source_platform}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {ad.competitor_name}
                    </span>
                  </div>
                  <CardTitle className="line-clamp-2 text-base group-hover:text-primary">
                    {ad.ad_headline}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {ad.media_url && (
                    <div className="relative aspect-video overflow-hidden rounded-md bg-muted">
                      <img
                        src={ad.media_url}
                        alt="Ad media"
                        className="h-full w-full object-cover"
                      />
                      <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                        <Eye className="h-6 w-6 text-white" />
                      </div>
                    </div>
                  )}
                  <p className="text-sm text-muted-foreground">
                    {truncateText(ad.ad_copy, 100)}
                  </p>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>First seen: {formatDate(ad.first_seen_at)}</span>
                    <span>Last seen: {formatDate(ad.last_seen_at)}</span>
                  </div>
                  {ad.landing_page_url && (
                    <a
                      href={ad.landing_page_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLink className="h-3 w-3" />
                      View Landing Page
                    </a>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </TabsContent>

      {/* ─── COMPETITOR POSTS TAB ────────────────────────────────────────────── */}
      <TabsContent value="posts" className="space-y-6">
        {posts.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <FileText className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-semibold">No Competitor Posts Yet</h3>
              <p className="mt-2 text-center text-muted-foreground">
                Competitor posts will appear here once they are ingested from your monitoring sources.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {posts.map((post) => (
              <Card
                key={post.id}
                className="group cursor-pointer transition-shadow hover:shadow-md"
                onClick={() => setSelectedPost(post)}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <Badge className={getPlatformBadgeColor(post.source_platform)}>
                      {post.source_platform}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {post.competitor_name}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {post.media_url && (
                    <div className="relative aspect-video overflow-hidden rounded-md bg-muted">
                      <img
                        src={post.media_url}
                        alt="Post media"
                        className="h-full w-full object-cover"
                      />
                      <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                        <Eye className="h-6 w-6 text-white" />
                      </div>
                    </div>
                  )}
                  <p className="text-sm text-muted-foreground">
                    {truncateText(post.post_caption, 120)}
                  </p>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Published: {formatDate(post.published_at)}</span>
                    <span>Found: {formatDate(post.first_seen_at)}</span>
                  </div>
                  {post.post_url && (
                    <a
                      href={post.post_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <ExternalLink className="h-3 w-3" />
                      View Original Post
                    </a>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </TabsContent>

      {/* ─── AI INSIGHTS TAB ─────────────────────────────────────────────────── */}
      <TabsContent value="insights" className="space-y-6">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            AI-generated insights based on competitor ads and posts
          </p>
          <Button
            onClick={handleGenerateInsights}
            disabled={generatingInsights || ads.length === 0 && posts.length === 0}
          >
            {generatingInsights ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Generate Insights
              </>
            )}
          </Button>
        </div>

        {insights.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Lightbulb className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-semibold">No Insights Yet</h3>
              <p className="mt-2 text-center text-muted-foreground">
                Click "Generate Insights" to analyze your competitor data with AI.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {Object.entries(groupedInsights).map(([type, typeInsights]) => (
              <Card key={type}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    {getInsightTypeIcon(type)}
                    {getInsightTypeLabel(type)}
                    <Badge variant="secondary" className="ml-2">
                      {typeInsights.length}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {typeInsights.map((insight) => (
                      <div
                        key={insight.id}
                        className="flex items-start gap-3 rounded-lg border p-3"
                      >
                        <div className="flex-1">
                          <p className="text-sm">{insight.insight_summary}</p>
                          <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <TrendingUp className="h-3 w-3" />
                              Confidence: {Math.round((insight.confidence_score || 0) * 100)}%
                            </span>
                            <span className="flex items-center gap-1">
                              <Calendar className="h-3 w-3" />
                              {formatDateWithTime(insight.created_at)}
                            </span>
                          </div>
                        </div>
                        <Badge
                          variant={
                            (insight.confidence_score || 0) >= 0.8
                              ? "default"
                              : (insight.confidence_score || 0) >= 0.6
                                ? "secondary"
                                : "outline"
                          }
                        >
                          {(insight.confidence_score || 0) >= 0.8
                            ? "High"
                            : (insight.confidence_score || 0) >= 0.6
                              ? "Medium"
                              : "Low"}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </TabsContent>

      {/* ─── ALERTS TAB ──────────────────────────────────────────────────────── */}
      <TabsContent value="alerts" className="space-y-6">
        {alerts.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <AlertTriangle className="h-12 w-12 text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-semibold">No Alerts Yet</h3>
              <p className="mt-2 text-center text-muted-foreground">
                Alerts will appear here when significant competitor activity is detected.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {alerts.map((alert) => (
              <Card
                key={alert.id}
                className={alert.is_resolved ? "opacity-60" : ""}
              >
                <CardContent className="flex items-center gap-4 py-4">
                  <div className="flex-shrink-0">
                    {alert.is_resolved ? (
                      <CheckCircle className="h-5 w-5 text-green-500" />
                    ) : alert.severity === "critical" || alert.severity === "high" ? (
                      <AlertTriangle className="h-5 w-5 text-orange-500" />
                    ) : (
                      <Clock className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge className={getSeverityBadgeColor(alert.severity)}>
                        {alert.severity}
                      </Badge>
                      <Badge variant="outline">{alert.alert_type.replace(/_/g, " ")}</Badge>
                    </div>
                    <p className="text-sm">{alert.alert_message}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateWithTime(alert.created_at)}
                      {alert.is_resolved && alert.resolved_at && (
                        <span className="ml-2">
                          • Resolved {formatDateWithTime(alert.resolved_at)}
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Resolved</span>
                    <Switch
                      checked={alert.is_resolved}
                      onCheckedChange={() => handleResolveAlert(alert.id, alert.is_resolved)}
                      disabled={alert.is_resolved}
                    />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </TabsContent>

      {/* ─── AD DETAIL DIALOG ────────────────────────────────────────────────── */}
      <Dialog open={!!selectedAd} onOpenChange={() => setSelectedAd(null)}>
        <DialogContent className="max-w-2xl">
          {selectedAd && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2">
                  <Badge className={getPlatformBadgeColor(selectedAd.source_platform)}>
                    {selectedAd.source_platform}
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    {selectedAd.competitor_name}
                  </span>
                </div>
                <DialogTitle>{selectedAd.ad_headline}</DialogTitle>
                <DialogDescription>
                  First seen: {formatDate(selectedAd.first_seen_at)} • Last seen:{" "}
                  {formatDate(selectedAd.last_seen_at)}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                {selectedAd.media_url && (
                  <div className="overflow-hidden rounded-lg bg-muted">
                    <img
                      src={selectedAd.media_url}
                      alt="Ad media"
                      className="w-full object-contain"
                    />
                  </div>
                )}
                <div>
                  <h4 className="mb-2 text-sm font-medium">Ad Copy</h4>
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {selectedAd.ad_copy}
                  </p>
                </div>
                {selectedAd.landing_page_url && (
                  <div>
                    <h4 className="mb-2 text-sm font-medium">Landing Page</h4>
                    <a
                      href={selectedAd.landing_page_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                    >
                      <ExternalLink className="h-4 w-4" />
                      {selectedAd.landing_page_url}
                    </a>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ─── POST DETAIL DIALOG ──────────────────────────────────────────────── */}
      <Dialog open={!!selectedPost} onOpenChange={() => setSelectedPost(null)}>
        <DialogContent className="max-w-2xl">
          {selectedPost && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2">
                  <Badge className={getPlatformBadgeColor(selectedPost.source_platform)}>
                    {selectedPost.source_platform}
                  </Badge>
                  <span className="text-sm text-muted-foreground">
                    {selectedPost.competitor_name}
                  </span>
                </div>
                <DialogTitle>Post Details</DialogTitle>
                <DialogDescription>
                  Published: {formatDate(selectedPost.published_at)} • Found:{" "}
                  {formatDate(selectedPost.first_seen_at)}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                {selectedPost.media_url && (
                  <div className="overflow-hidden rounded-lg bg-muted">
                    <img
                      src={selectedPost.media_url}
                      alt="Post media"
                      className="w-full object-contain"
                    />
                  </div>
                )}
                <div>
                  <h4 className="mb-2 text-sm font-medium">Caption</h4>
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {selectedPost.post_caption}
                  </p>
                </div>
                {selectedPost.post_url && (
                  <div>
                    <h4 className="mb-2 text-sm font-medium">Original Post</h4>
                    <a
                      href={selectedPost.post_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                    >
                      <ExternalLink className="h-4 w-4" />
                      View on {selectedPost.source_platform}
                    </a>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Tabs>
  )
}
