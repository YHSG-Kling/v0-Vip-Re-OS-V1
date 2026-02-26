"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth/client"
import { getVideoPerformanceStats } from "@/app/actions/video-generation"

export default function VideoAnalyticsPage() {
  const { user } = useAuth()
  const [dateRange, setDateRange] = useState("30d")
  const [stats, setStats] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadStats() {
      setLoading(true)
      try {
        if (user?.id) {
          const data = await getVideoPerformanceStats(user.id)
          setStats(data)
        }
      } catch (error) {
        console.error("Error loading stats:", error)
      } finally {
        setLoading(false)
      }
    }
    loadStats()
  }, [user?.id, dateRange])

  // Demo data for analytics
  const overview = {
    totalVideos: 67,
    totalViews: 4523,
    avgCompletionRate: 68,
    conversions: 34,
    viewsChange: 12.5,
    completionChange: 3.2,
    conversionChange: -2.1,
  }

  const videoTypePerformance = [
    { type: "Listing Tour", videos: 28, avgViews: 127, avgCompletion: 68, conversionRate: 12 },
    { type: "Personalized", videos: 19, avgViews: 34, avgCompletion: 82, conversionRate: 24 },
    { type: "Market Update", videos: 8, avgViews: 203, avgCompletion: 45, conversionRate: 3 },
    { type: "Agent Intro", videos: 5, avgViews: 89, avgCompletion: 71, conversionRate: 8 },
    { type: "Open House", videos: 4, avgViews: 156, avgCompletion: 52, conversionRate: 15 },
    { type: "Testimonial", videos: 3, avgViews: 78, avgCompletion: 76, conversionRate: 18 },
  ]

  const personaAnalysis = [
    { persona: "Military Buyers", completionRate: 87, avgViews: 45, engagementScore: 92 },
    { persona: "First-Time Buyers", completionRate: 78, avgViews: 145, engagementScore: 85 },
    { persona: "Luxury Buyers", completionRate: 72, avgViews: 67, engagementScore: 78 },
    { persona: "Investors", completionRate: 65, avgViews: 89, engagementScore: 70 },
    { persona: "Downsizers", completionRate: 81, avgViews: 56, engagementScore: 83 },
  ]

  const topVideos = [
    { title: "123 Main St Listing Tour", views: 456, completion: 78, conversions: 5 },
    { title: "Miami Beach Market Update", views: 389, completion: 52, conversions: 2 },
    { title: "Welcome - John Smith", views: 1, completion: 100, conversions: 1 },
    { title: "Agent Introduction 2024", views: 234, completion: 71, conversions: 3 },
    { title: "456 Ocean Dr Virtual Tour", views: 198, completion: 65, conversions: 4 },
  ]

  const deviceBreakdown = [
    { device: "Mobile", percentage: 62, icon: Smartphone },
    { device: "Desktop", percentage: 31, icon: Monitor },
    { device: "Tablet", percentage: 7, icon: Globe },
  ]

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="container mx-auto py-8 px-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Video Analytics</h1>
            <p className="text-slate-600 mt-1">Track performance and optimize your video strategy</p>
          </div>
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

        {/* Overview Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-500">Total Videos</p>
                  <p className="text-3xl font-bold mt-1">{overview.totalVideos}</p>
                </div>
                <div className="p-3 rounded-full bg-blue-100">
                  <Video className="h-6 w-6 text-blue-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-500">Total Views</p>
                  <p className="text-3xl font-bold mt-1">{overview.totalViews.toLocaleString()}</p>
                  <div className={cn("flex items-center text-sm mt-1", overview.viewsChange >= 0 ? "text-green-600" : "text-red-600")}>
                    {overview.viewsChange >= 0 ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                    {Math.abs(overview.viewsChange)}%
                  </div>
                </div>
                <div className="p-3 rounded-full bg-green-100">
                  <Eye className="h-6 w-6 text-green-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-500">Avg Completion</p>
                  <p className="text-3xl font-bold mt-1">{overview.avgCompletionRate}%</p>
                  <div className={cn("flex items-center text-sm mt-1", overview.completionChange >= 0 ? "text-green-600" : "text-red-600")}>
                    {overview.completionChange >= 0 ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                    {Math.abs(overview.completionChange)}%
                  </div>
                </div>
                <div className="p-3 rounded-full bg-purple-100">
                  <TrendingUp className="h-6 w-6 text-purple-600" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-500">Conversions</p>
                  <p className="text-3xl font-bold mt-1">{overview.conversions}</p>
                  <div className={cn("flex items-center text-sm mt-1", overview.conversionChange >= 0 ? "text-green-600" : "text-red-600")}>
                    {overview.conversionChange >= 0 ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                    {Math.abs(overview.conversionChange)}%
                  </div>
                </div>
                <div className="p-3 rounded-full bg-amber-100">
                  <Target className="h-6 w-6 text-amber-600" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          {/* Video Type Performance */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5" />
                Performance by Video Type
              </CardTitle>
              <CardDescription>Compare metrics across different video categories</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b text-left text-sm text-slate-500">
                      <th className="pb-3 font-medium">Type</th>
                      <th className="pb-3 font-medium">Videos</th>
                      <th className="pb-3 font-medium">Avg Views</th>
                      <th className="pb-3 font-medium">Completion</th>
                      <th className="pb-3 font-medium">Conversion</th>
                    </tr>
                  </thead>
                  <tbody className="text-sm">
                    {videoTypePerformance.map((row) => (
                      <tr key={row.type} className="border-b last:border-0">
                        <td className="py-3 font-medium">{row.type}</td>
                        <td className="py-3">{row.videos}</td>
                        <td className="py-3">{row.avgViews}</td>
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <Progress value={row.avgCompletion} className="w-16 h-2" />
                            <span>{row.avgCompletion}%</span>
                          </div>
                        </td>
                        <td className="py-3">
                          <Badge variant={row.conversionRate >= 15 ? "default" : row.conversionRate >= 10 ? "secondary" : "outline"}>
                            {row.conversionRate}%
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
                    <div className="p-2 rounded-lg bg-slate-100">
                      <device.icon className="h-5 w-5 text-slate-600" />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium">{device.device}</span>
                        <span className="text-sm text-slate-500">{device.percentage}%</span>
                      </div>
                      <Progress value={device.percentage} className="h-2" />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          {/* Persona Analysis */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Persona Engagement
              </CardTitle>
              <CardDescription>Which client personas engage most with videos</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {personaAnalysis.map((persona) => (
                  <div key={persona.persona} className="p-4 rounded-lg bg-slate-50 border">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-medium">{persona.persona}</span>
                      <Badge
                        variant={persona.engagementScore >= 85 ? "default" : persona.engagementScore >= 75 ? "secondary" : "outline"}
                      >
                        Score: {persona.engagementScore}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <span className="text-slate-500">Completion Rate</span>
                        <div className="flex items-center gap-2 mt-1">
                          <Progress value={persona.completionRate} className="flex-1 h-2" />
                          <span className="font-medium">{persona.completionRate}%</span>
                        </div>
                      </div>
                      <div>
                        <span className="text-slate-500">Avg Views</span>
                        <p className="font-medium mt-1">{persona.avgViews}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Top Performing Videos */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                Top Performing Videos
              </CardTitle>
              <CardDescription>Your best performing content</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {topVideos.map((video, index) => (
                  <div key={video.title} className="flex items-center gap-4 p-3 rounded-lg hover:bg-slate-50 transition-colors">
                    <div className={cn(
                      "w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold",
                      index === 0 ? "bg-amber-100 text-amber-700" :
                      index === 1 ? "bg-slate-200 text-slate-700" :
                      index === 2 ? "bg-orange-100 text-orange-700" :
                      "bg-slate-100 text-slate-500"
                    )}>
                      {index + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-slate-900 truncate">{video.title}</p>
                      <div className="flex items-center gap-4 text-sm text-slate-500 mt-1">
                        <span className="flex items-center gap-1">
                          <Eye className="h-3 w-3" />
                          {video.views}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {video.completion}%
                        </span>
                        <span className="flex items-center gap-1">
                          <Target className="h-3 w-3" />
                          {video.conversions}
                        </span>
                      </div>
                    </div>
                    <Button variant="ghost" size="sm">
                      <Play className="h-4 w-4" />
                    </Button>
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
              <div className="p-4 rounded-lg bg-blue-50 border border-blue-200">
                <p className="font-medium text-blue-900 mb-2">High Engagement Opportunity</p>
                <p className="text-sm text-blue-700">
                  Personalized buyer videos convert 2x better than listing tours for first-time buyers. Consider creating more targeted content.
                </p>
              </div>
              <div className="p-4 rounded-lg bg-green-50 border border-green-200">
                <p className="font-medium text-green-900 mb-2">Best Performing Segment</p>
                <p className="text-sm text-green-700">
                  Military buyers have 87% completion rate - your highest. They respond well to professional, straightforward messaging.
                </p>
              </div>
              <div className="p-4 rounded-lg bg-amber-50 border border-amber-200">
                <p className="font-medium text-amber-900 mb-2">Room for Improvement</p>
                <p className="text-sm text-amber-700">
                  Market update videos have only 45% completion. Try shorter formats or add more visual data to keep viewers engaged.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
