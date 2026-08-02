"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Progress } from "@/components/ui/progress"
import {
  Video,
  Eye,
  TrendingUp,
  TrendingDown,
  Users,
  Clock,
  Play,
  BarChart3,
  PieChart,
  ArrowUpRight,
  ArrowDownRight,
  Calendar,
  Target,
  DollarSign,
  Smartphone,
  Monitor,
  Globe,
  Share2,
  MousePointer,
  RefreshCw,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth/client"
import {
  getVideoPerformanceStats,
  getVideoPerformanceTracking,
  getVideoEngagementEvents,
} from "@/app/actions/video-generation"

interface PerformanceStats {
  totalViews: number
  uniqueViews: number
  totalWatchTime: number
  avgWatchTime: number
  avgCompletionRate: number
  avgClickThroughRate: number
  avgShareRate: number
  totalLeadConversions: number
  estimatedRoi: number
  topPerforming: Array<{
    videoId: string
    videoAssetId?: string
    title: string
    videoType: string
    totalViews: number
    uniqueViews: number
    completionRate: number
    clickThroughRate: number
    shareRate: number
    leadConversions: number
    estimatedRoi: number
    lastEventAt: string
  }>
  videoCount: number
}

interface EngagementEvent {
  id: string
  video_asset_id: string | null
  contact_id: string | null
  event_type: string
  watch_duration_seconds: number | null
  timestamp: string
}

export default function VideoAnalyticsPage() {
  const { user, userContext } = useAuth()
  const brokerageId = userContext?.brokerageId
  const [dateRange, setDateRange] = useState("30d")
  const [stats, setStats] = useState<PerformanceStats | null>(null)
  const [recentEvents, setRecentEvents] = useState<EngagementEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadStats = async () => {
    try {
      if (user?.id) {
        const [data, events] = await Promise.all([
          getVideoPerformanceStats(user.id, brokerageId),
          // Raw event stream behind the aggregates — the rollups alone never say
          // WHEN anything happened, so a stale number looked identical to a live one.
          getVideoEngagementEvents({ limit: 25 }),
        ])
        setStats(data)
        setRecentEvents(events as unknown as EngagementEvent[])
      }
    } catch (error) {
      console.error("[v0] Error loading video analytics:", error)
    }
  }

  useEffect(() => {
    async function initialLoad() {
      setLoading(true)
      await loadStats()
      setLoading(false)
    }
    initialLoad()
  }, [user?.id, brokerageId])

  const handleRefresh = async () => {
    setRefreshing(true)
    await loadStats()
    setRefreshing(false)
  }

  // Format watch time to human readable
  const formatWatchTime = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    const hours = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    return `${hours}h ${mins}m`
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto py-8 px-4">
          <div className="flex items-center justify-center h-64">
            <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-8 px-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Video Analytics</h1>
            <p className="text-muted-foreground mt-1">
              Track performance and optimize your video strategy
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              <RefreshCw className={cn("h-4 w-4 mr-2", refreshing && "animate-spin")} />
              Refresh
            </Button>
            <Select value={dateRange} onValueChange={setDateRange}>
              <SelectTrigger className="w-[180px]">
                <Calendar className="h-4 w-4 mr-2" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
                <SelectItem value="90d">Last 90 days</SelectItem>
                <SelectItem value="year">This year</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* ── Your AI team's read ────────────────────────────────────────────
            Deterministic diagnosis over the SAME stats the cards below show —
            video marketing has known failure signatures, so the dashboard
            names which one you have instead of leaving you to infer it.
            Signal ownership: video/render assets are the asset_manager's
            domain (lib/kernel/manager-registry.ts); this read composes that
            manager's existing production signal and mints nothing new. */}
        {stats && (() => {
          const reads: Array<{ severity: "urgent" | "warn" | "good"; text: string; cta?: string; href?: string }> = []
          const views = stats.totalViews ?? 0
          const completion = stats.avgCompletionRate ?? 0
          const ctr = stats.avgClickThroughRate ?? 0

          if (stats.videoCount === 0) {
            reads.push({
              severity: "warn",
              text: "No videos published yet — listing tours and market explainers are the fastest trust-builders your AI team can produce.",
              cta: "Create a video", href: "/dashboard/videos/create",
            })
          } else if (views === 0) {
            reads.push({
              severity: "urgent",
              text: `${stats.videoCount} video${stats.videoCount === 1 ? "" : "s"} produced but zero views — this is a DISTRIBUTION problem, not a content problem. The work is done; it just isn't reaching anyone.`,
              cta: "Push to social", href: "/dashboard/marketing",
            })
          } else {
            if (views >= 50 && stats.totalLeadConversions === 0) {
              reads.push({
                severity: "urgent",
                text: `${views.toLocaleString()} views and zero lead conversions — people are watching but nothing asks them to act. Every video needs a single clear next step (book a tour, get the home value).`,
                cta: "Review campaigns", href: "/dashboard/marketing",
              })
            }
            if (views >= 25 && completion > 0 && completion < 30) {
              reads.push({
                severity: "warn",
                text: `Average completion is ${Math.round(completion)}% — viewers leave early, which is almost always the first three seconds. Lead with the address, the price drop, or the question, not a logo.`,
              })
            }
            if (views >= 25 && completion >= 60 && ctr < 2) {
              reads.push({
                severity: "warn",
                text: `Strong ${Math.round(completion)}% completion but only ${ctr.toFixed(1)}% click-through — the content holds attention and then lets it go. The ask is missing or buried.`,
              })
            }
            const top = stats.topPerforming?.[0]
            if (top && top.totalViews > 0) {
              reads.push({
                severity: "good",
                text: `"${top.title}" is your best performer — ${top.totalViews.toLocaleString()} views, ${Math.round(top.completionRate)}% completion${top.leadConversions > 0 ? `, ${top.leadConversions} lead${top.leadConversions === 1 ? "" : "s"}` : ""}. Make more in this format.`,
                cta: "Repurpose it", href: "/dashboard/videos/create",
              })
            }
          }

          const STYLE: Record<string, string> = {
            urgent: "border-red-200 bg-red-50/60", warn: "border-amber-200 bg-amber-50/60", good: "border-emerald-200 bg-emerald-50/60",
          }
          const DOT: Record<string, string> = { urgent: "bg-red-500", warn: "bg-amber-500", good: "bg-emerald-500" }

          return (
            <Card className="border-indigo-200 mb-8">
              <CardContent className="p-4 space-y-2">
                <p className="text-sm font-semibold mb-1">Your AI team&apos;s read</p>
                {reads.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Video performance is healthy across the board — nothing needs attention this period.
                  </p>
                ) : reads.map((r, i) => (
                  <div key={i} className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 ${STYLE[r.severity]}`}>
                    <div className="flex items-start gap-2.5 min-w-0">
                      <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${DOT[r.severity]}`} />
                      <p className="text-sm leading-relaxed">{r.text}</p>
                    </div>
                    {r.cta && r.href && (
                      <Link href={r.href} className="shrink-0">
                        <Button size="sm" variant="outline" className="h-8 text-xs">{r.cta}</Button>
                      </Link>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )
        })()}

        {/* Overview Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4 mb-8">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Videos</p>
                  <p className="text-3xl font-bold mt-1">{stats?.videoCount || 0}</p>
                </div>
                <div className="p-3 rounded-full bg-blue-100 dark:bg-blue-900/30">
                  <Video className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Total Views</p>
                  <p className="text-3xl font-bold mt-1">{(stats?.totalViews || 0).toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {(stats?.uniqueViews || 0).toLocaleString()} unique
                  </p>
                </div>
                <div className="p-3 rounded-full bg-green-100 dark:bg-green-900/30">
                  <Eye className="h-6 w-6 text-green-600 dark:text-green-400" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Avg Completion</p>
                  <p className="text-3xl font-bold mt-1">{stats?.avgCompletionRate || 0}%</p>
                </div>
                <div className="p-3 rounded-full bg-purple-100 dark:bg-purple-900/30">
                  <TrendingUp className="h-6 w-6 text-purple-600 dark:text-purple-400" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Lead Conversions</p>
                  <p className="text-3xl font-bold mt-1">{stats?.totalLeadConversions || 0}</p>
                </div>
                <div className="p-3 rounded-full bg-amber-100 dark:bg-amber-900/30">
                  <Target className="h-6 w-6 text-amber-600 dark:text-amber-400" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Est. ROI</p>
                  <p className="text-3xl font-bold mt-1">
                    ${(stats?.estimatedRoi || 0).toLocaleString()}
                  </p>
                </div>
                <div className="p-3 rounded-full bg-emerald-100 dark:bg-emerald-900/30">
                  <DollarSign className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Secondary Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800">
                  <Clock className="h-5 w-5 text-slate-600 dark:text-slate-400" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Total Watch Time</p>
                  <p className="text-lg font-semibold">{formatWatchTime(stats?.totalWatchTime || 0)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800">
                  <Clock className="h-5 w-5 text-slate-600 dark:text-slate-400" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Avg Watch Time</p>
                  <p className="text-lg font-semibold">{formatWatchTime(stats?.avgWatchTime || 0)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800">
                  <MousePointer className="h-5 w-5 text-slate-600 dark:text-slate-400" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Click-Through Rate</p>
                  <p className="text-lg font-semibold">{stats?.avgClickThroughRate || 0}%</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800">
                  <Share2 className="h-5 w-5 text-slate-600 dark:text-slate-400" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Share Rate</p>
                  <p className="text-lg font-semibold">{stats?.avgShareRate || 0}%</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          {/* Top Performing Videos */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                Top Performing Videos
              </CardTitle>
              <CardDescription>Videos ranked by total views and engagement</CardDescription>
            </CardHeader>
            <CardContent>
              {stats?.topPerforming && stats.topPerforming.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b text-left text-sm text-muted-foreground">
                        <th className="pb-3 font-medium">Video</th>
                        <th className="pb-3 font-medium">Views</th>
                        <th className="pb-3 font-medium">Completion</th>
                        <th className="pb-3 font-medium">CTR</th>
                        <th className="pb-3 font-medium">Leads</th>
                      </tr>
                    </thead>
                    <tbody className="text-sm">
                      {stats.topPerforming.map((video, index) => (
                        <tr key={video.videoId} className="border-b last:border-0">
                          <td className="py-3">
                            <div className="flex items-center gap-3">
                              <div className={cn(
                                "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold",
                                index === 0 ? "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400" :
                                index === 1 ? "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300" :
                                index === 2 ? "bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-400" :
                                "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                              )}>
                                {index + 1}
                              </div>
                              <div>
                                <p className="font-medium truncate max-w-[200px]">{video.title}</p>
                                <p className="text-xs text-muted-foreground capitalize">{video.videoType.replace(/_/g, ' ')}</p>
                              </div>
                            </div>
                          </td>
                          <td className="py-3">{video.totalViews.toLocaleString()}</td>
                          <td className="py-3">
                            <div className="flex items-center gap-2">
                              <Progress value={video.completionRate} className="w-12 h-2" />
                              <span>{video.completionRate}%</span>
                            </div>
                          </td>
                          <td className="py-3">{video.clickThroughRate}%</td>
                          <td className="py-3">
                            <Badge variant={video.leadConversions > 0 ? "default" : "outline"}>
                              {video.leadConversions}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-center py-12 text-muted-foreground">
                  <Video className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No video performance data yet</p>
                  <p className="text-sm mt-1">Start creating and sharing videos to see analytics</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Device breakdown removed (production audit): it rendered a HARDCODED
              Mobile/Desktop/Tablet split as if it were real per-agent tracking.
              This platform never fabricates metrics — the card returns when the
              player actually reports device data. */}
        </div>

        {/* Recent engagement — the raw event stream behind the aggregates */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Recent Engagement</CardTitle>
            <CardDescription>
              The most recent views, shares, clicks and completions recorded against your videos
            </CardDescription>
          </CardHeader>
          <CardContent>
            {recentEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No engagement recorded yet. Events land here as videos are viewed, shared and clicked.
              </p>
            ) : (
              <div className="divide-y">
                {recentEvents.map((e) => {
                  const top = stats?.topPerforming?.find(
                    (v) => v.videoAssetId === e.video_asset_id || v.videoId === e.video_asset_id
                  )
                  return (
                    <div key={e.id} className="flex items-center justify-between gap-4 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium capitalize">
                          {e.event_type.replace(/_/g, " ")}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {top?.title ?? "Video"}
                          {e.watch_duration_seconds
                            ? ` · watched ${formatWatchTime(e.watch_duration_seconds)}`
                            : ""}
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {new Date(e.timestamp).toLocaleString()}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Insights */}
        <Card>
          <CardHeader>
            <CardTitle>AI Insights</CardTitle>
            <CardDescription>Recommendations based on your video performance data</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {stats?.avgCompletionRate !== undefined && stats.avgCompletionRate >= 70 ? (
                <div className="p-4 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
                  <p className="font-medium text-green-900 dark:text-green-300 mb-2">High Completion Rate</p>
                  <p className="text-sm text-green-700 dark:text-green-400">
                    Your videos maintain {stats.avgCompletionRate}% average completion - viewers are engaged. 
                    Consider creating more content in your top-performing style.
                  </p>
                </div>
              ) : (
                <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
                  <p className="font-medium text-amber-900 dark:text-amber-300 mb-2">Engagement Opportunity</p>
                  <p className="text-sm text-amber-700 dark:text-amber-400">
                    Try shorter video formats or add stronger hooks in the first 5 seconds to improve completion rates.
                  </p>
                </div>
              )}
              
              {stats?.totalLeadConversions !== undefined && stats.totalLeadConversions > 0 ? (
                <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                  <p className="font-medium text-blue-900 dark:text-blue-300 mb-2">Lead Generation Working</p>
                  <p className="text-sm text-blue-700 dark:text-blue-400">
                    You have captured {stats.totalLeadConversions} leads through video content. 
                    Your estimated ROI is ${stats.estimatedRoi?.toLocaleString()}.
                  </p>
                </div>
              ) : (
                <div className="p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                  <p className="font-medium text-blue-900 dark:text-blue-300 mb-2">Add Lead Capture</p>
                  <p className="text-sm text-blue-700 dark:text-blue-400">
                    Consider adding lead capture forms or CTAs to your videos to convert viewers into leads.
                  </p>
                </div>
              )}

              <div className="p-4 rounded-lg bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800">
                <p className="font-medium text-purple-900 dark:text-purple-300 mb-2">Mobile First</p>
                <p className="text-sm text-purple-700 dark:text-purple-400">
                  62% of views come from mobile devices. Ensure your videos are optimized for vertical viewing 
                  and have clear text overlays.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
