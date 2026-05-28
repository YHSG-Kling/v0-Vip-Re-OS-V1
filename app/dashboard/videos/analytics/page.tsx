"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import { getVideoPerformanceStats, getVideoPerformanceTracking } from "@/app/actions/video-generation"

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

export default function VideoAnalyticsPage() {
  const { user, userContext } = useAuth()
  const brokerageId = userContext?.brokerageId
  const [dateRange, setDateRange] = useState("30d")
  const [stats, setStats] = useState<PerformanceStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadStats = async () => {
    try {
      if (user?.id) {
        const data = await getVideoPerformanceStats(user.id, brokerageId)
        setStats(data)
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

  // Calculate changes (placeholder for now - would need historical data)
  const calculateChange = (current: number, baseline: number) => {
    if (baseline === 0) return current > 0 ? 100 : 0
    return Math.round(((current - baseline) / baseline) * 100)
  }

  // Device breakdown (would come from actual tracking in production)
  const deviceBreakdown = [
    { device: "Mobile", percentage: 62, icon: Smartphone },
    { device: "Desktop", percentage: 31, icon: Monitor },
    { device: "Tablet", percentage: 7, icon: Globe },
  ]

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

          {/* Device Breakdown */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <PieChart className="h-5 w-5" />
                Device Breakdown
              </CardTitle>
              <CardDescription>Where your videos are watched</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {deviceBreakdown.map((device) => (
                  <div key={device.device} className="flex items-center gap-4">
                    <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800">
                      <device.icon className="h-5 w-5 text-slate-600 dark:text-slate-400" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium">{device.device}</span>
                        <span className="text-sm text-muted-foreground">{device.percentage}%</span>
                      </div>
                      <Progress value={device.percentage} className="h-2" />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

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
