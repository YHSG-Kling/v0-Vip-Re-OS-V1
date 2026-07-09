"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Video,
  Plus,
  Play,
  Eye,
  Clock,
  TrendingUp,
  Loader2,
  CheckCircle,
  AlertCircle,
  AlertTriangle,
  Sparkles,
  ArrowRight,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth/client"
import { createClient } from "@/lib/supabase/client"

interface VideoProject {
  id: string
  project_name: string
  video_type: string
  status: string
  provider_status?: string
  video_url?: string
  thumbnail_url?: string
  created_at: string
}

interface VideoRecommendation {
  type: string
  title: string
  description: string
  priority: "high" | "medium" | "low"
}

export function VideosDashboard() {
  const router = useRouter()
  const { user } = useAuth()
  const [inProgressVideos, setInProgressVideos] = useState<VideoProject[]>([])
  const [recentVideos, setRecentVideos] = useState<VideoProject[]>([])
  const [recommendations, setRecommendations] = useState<VideoRecommendation[]>([])
  const [weeklyViews, setWeeklyViews] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    loadDashboardData()

    // Real-time subscription for video updates
    const supabase = createClient()
    const channel = supabase
      .channel("video-dashboard-updates")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ai_video_projects" },
        () => {
          loadDashboardData()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [user?.id])

  async function loadDashboardData() {
    setLoading(true)
    try {
      const supabase = createClient()

      // Get videos in progress
      const { data: inProgress } = await supabase
        .from("ai_video_projects")
        .select("*")
        .in("status", ["script_generating", "script_ready", "generating"])
        .order("created_at", { ascending: false })
        .limit(5)

      // Get recently completed videos
      const { data: recent } = await supabase
        .from("ai_video_projects")
        .select("*")
        .eq("status", "video_ready")
        .order("created_at", { ascending: false })
        .limit(5)

      if (inProgress) setInProgressVideos(inProgress)
      if (recent) setRecentVideos(recent)

      // Real views from video_performance_tracking — no synthetic data
      const { data: perf } = await supabase
        .from("video_performance_tracking")
        .select("total_views")
        .eq("brokerage_id", user?.id ?? "")
      const totalViews = (perf ?? []).reduce((s: number, p: { total_views?: number }) => s + (p.total_views ?? 0), 0)
      setWeeklyViews(totalViews > 0 ? Math.round(totalViews / 4) : 0)
      setLoadError(false)
    } catch (error) {
      console.error("Error loading video dashboard:", error)
      setInProgressVideos([])
      setRecentVideos([])
      setRecommendations([])
      setWeeklyViews(0)
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }

  function getStatusIcon(status: string) {
    switch (status) {
      case "video_ready":
        return <CheckCircle className="h-4 w-4 text-green-500" />
      case "failed":
        return <AlertCircle className="h-4 w-4 text-red-500" />
      case "generating":
        return <Loader2 className="h-4 w-4 text-amber-500 animate-spin" />
      default:
        return <Clock className="h-4 w-4 text-blue-500" />
    }
  }

  function getStatusText(status: string) {
    switch (status) {
      case "script_generating":
        return "Writing script..."
      case "script_ready":
        return "Script ready"
      case "generating":
        return "Generating video..."
      case "video_ready":
        return "Ready"
      case "failed":
        return "Failed"
      default:
        return status
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center h-48">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg font-medium flex items-center gap-2">
          <Video className="h-5 w-5" />
          AI Videos
        </CardTitle>
        <Button size="sm" onClick={() => router.push("/dashboard/videos/create")}>
          <Plus className="mr-2 h-4 w-4" />
          Create
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Error state */}
        {loadError && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
              <p className="text-sm text-amber-800">Could not load video data. Check your connection.</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setLoadError(false)
                loadDashboardData()
              }}
            >
              Retry
            </Button>
          </div>
        )}

        {/* Performance Snapshot */}
        <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">Views this week</span>
          </div>
          <div className="flex items-center gap-2">
            {weeklyViews > 0 ? (
              <>
                <span className="text-lg font-semibold">{weeklyViews}</span>
                <TrendingUp className="h-4 w-4 text-green-500" />
              </>
            ) : (
              <span className="text-xs text-muted-foreground">No performance data yet</span>
            )}
          </div>
        </div>

        {/* Videos in Progress */}
        {inProgressVideos.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">In Progress</h4>
            <div className="space-y-2">
              {inProgressVideos.slice(0, 3).map((video) => (
                <div
                  key={video.id}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50 cursor-pointer"
                  onClick={() => router.push(`/dashboard/videos/board`)}
                >
                  <div className="h-10 w-10 rounded bg-muted flex items-center justify-center">
                    {video.status === "generating" ? (
                      <Loader2 className="h-5 w-5 animate-spin text-amber-500" />
                    ) : (
                      <Video className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{video.project_name}</p>
                    <p className="text-xs text-muted-foreground">{getStatusText(video.status)}</p>
                  </div>
                  {getStatusIcon(video.status)}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent Videos */}
        {recentVideos.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">Recently Completed</h4>
            <div className="space-y-2">
              {recentVideos.slice(0, 3).map((video) => (
                <div
                  key={video.id}
                  className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50 cursor-pointer"
                  onClick={() => router.push(`/dashboard/videos/library`)}
                >
                  <div className="h-10 w-10 rounded bg-muted flex items-center justify-center overflow-hidden">
                    {video.thumbnail_url ? (
                      <img
                        src={video.thumbnail_url || "/placeholder.svg"}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Video className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{video.project_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(video.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <Play className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AI Recommendations */}
        {recommendations.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-amber-500" />
              Recommended
            </h4>
            <div className="space-y-2">
              {recommendations.slice(0, 2).map((rec, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-3 p-2 rounded-lg border border-dashed hover:bg-muted/50 cursor-pointer"
                  onClick={() => router.push(`/dashboard/videos/create?type=${rec.type}`)}
                >
                  <div
                    className={cn(
                      "h-2 w-2 rounded-full",
                      rec.priority === "high" ? "bg-red-500" : "bg-amber-500"
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{rec.title}</p>
                    <p className="text-xs text-muted-foreground">{rec.description}</p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Quick Links */}
        <div className="flex gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 bg-transparent"
            onClick={() => router.push("/dashboard/videos/library")}
          >
            Library
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1 bg-transparent"
            onClick={() => router.push("/dashboard/videos/board")}
          >
            Pipeline
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1 bg-transparent"
            onClick={() => router.push("/dashboard/videos/analytics")}
          >
            Analytics
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export default VideosDashboard
