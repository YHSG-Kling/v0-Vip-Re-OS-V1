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
  RefreshCw,
  AlertCircle,
  CheckCircle,
  Clock,
  FileText,
  Loader2,
  MoreVertical,
  Eye,
  Share2,
  Trash2,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth/client"
import { createClient } from "@/lib/supabase/client"

interface VideoProject {
  id: string
  project_name: string
  video_type: string
  status: string
  heygen_status?: string
  client_name?: string
  property_address?: string
  created_at: string
  video_url?: string
  thumbnail_url?: string
  retry_count?: number
  error_message?: string
}

const COLUMNS = [
  { id: "script_generating", title: "Script Generating", icon: FileText, color: "bg-blue-500" },
  { id: "script_ready", title: "Script Ready", icon: CheckCircle, color: "bg-purple-500" },
  { id: "video_generating", title: "Video Generating", icon: Loader2, color: "bg-amber-500" },
  { id: "video_ready", title: "Video Ready", icon: Video, color: "bg-green-500" },
  { id: "failed", title: "Failed", icon: AlertCircle, color: "bg-red-500" },
]

function mapStatusToColumn(status: string, heygenStatus?: string): string {
  if (status === "failed") return "failed"
  if (status === "video_ready" || heygenStatus === "completed") return "video_ready"
  if (status === "generating" || heygenStatus === "generating") return "video_generating"
  if (status === "script_ready" || status === "script_approved") return "script_ready"
  return "script_generating"
}

export default function VideoKanbanBoard() {
  const router = useRouter()
  const { user } = useAuth()
  const [videos, setVideos] = useState<VideoProject[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    loadVideos()
    
    // Set up real-time subscription
    const supabase = createClient()
    const channel = supabase
      .channel("video-updates")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "ai_video_projects" },
        (payload) => {
          setVideos((prev) =>
            prev.map((v) => (v.id === payload.new.id ? { ...v, ...payload.new } : v))
          )
          if (payload.new.status === "video_ready") {
            // Could show toast notification here
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "ai_video_projects" },
        (payload) => {
          setVideos((prev) => [payload.new as VideoProject, ...prev])
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [user?.id])

  async function loadVideos() {
    setLoading(true)
    try {
      const supabase = createClient()
      const { data, error } = await supabase
        .from("ai_video_projects")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100)

      if (data && !error) {
        setVideos(data)
      } else {
        // Demo data
        setVideos([
          {
            id: "demo-1",
            project_name: "Listing Tour - 123 Main St",
            video_type: "listing_tour",
            status: "video_ready",
            client_name: "John Smith",
            property_address: "123 Main Street",
            created_at: new Date().toISOString(),
            video_url: "#",
          },
          {
            id: "demo-2",
            project_name: "Market Update - January 2026",
            video_type: "market_update",
            status: "generating",
            heygen_status: "generating",
            created_at: new Date().toISOString(),
          },
          {
            id: "demo-3",
            project_name: "Personalized Video - Sarah Johnson",
            video_type: "personalized",
            status: "script_ready",
            client_name: "Sarah Johnson",
            created_at: new Date().toISOString(),
          },
          {
            id: "demo-4",
            project_name: "Agent Introduction",
            video_type: "agent_intro",
            status: "script_generating",
            created_at: new Date().toISOString(),
          },
          {
            id: "demo-5",
            project_name: "Buyer Video - Michael Brown",
            video_type: "buyer_followup",
            status: "failed",
            error_message: "HeyGen API timeout",
            retry_count: 2,
            client_name: "Michael Brown",
            created_at: new Date().toISOString(),
          },
        ])
      }
    } catch (error) {
      console.error("Error loading videos:", error)
    } finally {
      setLoading(false)
    }
  }

  async function handleRefresh() {
    setRefreshing(true)
    await loadVideos()
    setRefreshing(false)
  }

  async function handleRetry(videoId: string) {
    try {
      const response = await fetch(`/api/heygen/generate-video`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoProjectId: videoId, retry: true }),
      })
      if (response.ok) {
        await loadVideos()
      }
    } catch (error) {
      console.error("Error retrying video:", error)
    }
  }

  const getColumnVideos = (columnId: string) => {
    return videos.filter((v) => mapStatusToColumn(v.status, v.heygen_status) === columnId)
  }

  if (loading) {
    return (
      <div className="flex h-[calc(100vh-200px)] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Video Pipeline</h1>
          <p className="text-muted-foreground">Track your video generation progress</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw className={cn("mr-2 h-4 w-4", refreshing && "animate-spin")} />
            Refresh
          </Button>
          <Button onClick={() => router.push("/dashboard/videos/create")}>
            <Plus className="mr-2 h-4 w-4" />
            Create Video
          </Button>
        </div>
      </div>

      {/* Kanban Board */}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {COLUMNS.map((column) => {
          const columnVideos = getColumnVideos(column.id)
          const Icon = column.icon

          return (
            <div key={column.id} className="min-w-[300px] flex-shrink-0">
              <div className="mb-3 flex items-center gap-2">
                <div className={cn("h-2 w-2 rounded-full", column.color)} />
                <h3 className="font-medium">{column.title}</h3>
                <Badge variant="secondary" className="ml-auto">
                  {columnVideos.length}
                </Badge>
              </div>

              <div className="space-y-3 rounded-lg bg-muted/30 p-3 min-h-[400px]">
                {columnVideos.map((video) => (
                  <Card key={video.id} className="cursor-pointer hover:shadow-md transition-shadow">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium truncate">{video.project_name}</h4>
                          <p className="text-sm text-muted-foreground truncate">
                            {video.client_name || video.property_address || video.video_type}
                          </p>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {video.video_url && (
                              <>
                                <DropdownMenuItem>
                                  <Play className="mr-2 h-4 w-4" />
                                  Preview
                                </DropdownMenuItem>
                                <DropdownMenuItem>
                                  <Share2 className="mr-2 h-4 w-4" />
                                  Share
                                </DropdownMenuItem>
                              </>
                            )}
                            <DropdownMenuItem>
                              <Eye className="mr-2 h-4 w-4" />
                              View Details
                            </DropdownMenuItem>
                            {video.status === "failed" && (
                              <DropdownMenuItem onClick={() => handleRetry(video.id)}>
                                <RefreshCw className="mr-2 h-4 w-4" />
                                Retry
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem className="text-destructive">
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>

                      {/* Status-specific content */}
                      {column.id === "video_generating" && (
                        <div className="mt-3">
                          <Progress value={65} className="h-1" />
                          <p className="text-xs text-muted-foreground mt-1">Processing...</p>
                        </div>
                      )}

                      {column.id === "failed" && video.error_message && (
                        <div className="mt-3 p-2 bg-destructive/10 rounded text-xs text-destructive">
                          {video.error_message}
                          {video.retry_count && video.retry_count > 0 && (
                            <span className="block mt-1">Retries: {video.retry_count}/3</span>
                          )}
                        </div>
                      )}

                      {video.thumbnail_url && column.id === "video_ready" && (
                        <div className="mt-3 relative aspect-video rounded overflow-hidden bg-muted">
                          <img
                            src={video.thumbnail_url || "/placeholder.svg"}
                            alt={video.project_name}
                            className="object-cover w-full h-full"
                          />
                          <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 hover:opacity-100 transition-opacity">
                            <Play className="h-8 w-8 text-white" />
                          </div>
                        </div>
                      )}

                      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {new Date(video.created_at).toLocaleDateString()}
                        <Badge variant="outline" className="ml-auto text-xs">
                          {video.video_type.replace(/_/g, " ")}
                        </Badge>
                      </div>
                    </CardContent>
                  </Card>
                ))}

                {columnVideos.length === 0 && (
                  <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
                    <Icon className="h-8 w-8 mb-2 opacity-50" />
                    <p className="text-sm">No videos</p>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
