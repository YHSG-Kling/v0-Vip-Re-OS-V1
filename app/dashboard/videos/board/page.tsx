"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
  Send,
  Shield,
  ExternalLink,
  Download,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useAuth } from "@/lib/auth/client"
import { createClient } from "@/lib/supabase/client"
import { toast } from "sonner"
import { distributeVideo } from "@/app/actions/video/distribute-video"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface VideoProject {
  id: string
  title: string
  video_type: string
  status: string
  heygen_status?: string
  script_content?: string
  created_at: string
  video_url?: string
  duration_seconds?: number
  error_message?: string
  retry_count?: number
  provider_metadata?: {
    quality_preset?: string
    output_orientation?: string
    thumbnail_url?: string
  }
  video_metadata?: {
    thumbnail_url?: string
    published_at?: string
    video_asset_id?: string
  }
  brokerage_id: string
  agent_id: string
}

interface StreamingStatus {
  video_project_id: string
  stream_status: string
  preview_url?: string
  stream_url?: string
  error_message?: string
}

// ─── COLUMN CONFIGURATION ─────────────────────────────────────────────────────

const COLUMNS = [
  { id: "pending", title: "Queued", icon: Clock, color: "bg-gray-500" },
  { id: "generating", title: "Generating", icon: Loader2, color: "bg-amber-500" },
  { id: "preview_ready", title: "Preview Ready", icon: Eye, color: "bg-blue-500" },
  { id: "published", title: "Published", icon: CheckCircle, color: "bg-green-500" },
  { id: "failed", title: "Failed", icon: AlertCircle, color: "bg-red-500" },
]

function mapStatusToColumn(status: string, heygenStatus?: string): string {
  if (status === "failed" || heygenStatus === "failed") return "failed"
  if (status === "published") return "published"
  if (status === "preview_ready" || heygenStatus === "completed") return "preview_ready"
  if (status === "generating" || heygenStatus === "generating" || heygenStatus === "processing") return "generating"
  return "pending"
}

// ─── COMPONENT ────────────────────────────────────────────────────────────────

export default function VideoKanbanBoard() {
  const router = useRouter()
  const { user, brokerage } = useAuth()
  const supabase = createClient()

  const [videos, setVideos] = useState<VideoProject[]>([])
  const [streamingStatuses, setStreamingStatuses] = useState<Record<string, StreamingStatus>>({})
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [pollingVideoIds, setPollingVideoIds] = useState<Set<string>>(new Set())

  // Preview/Distribute Dialog
  const [previewDialog, setPreviewDialog] = useState<{ open: boolean; video: VideoProject | null }>({
    open: false,
    video: null,
  })
  const [publishing, setPublishing] = useState(false)

  // Distribution state
  const [distributing, setDistributing] = useState(false)
  const [distPlatform, setDistPlatform] = useState("instagram")
  const [distAccountId, setDistAccountId] = useState("")
  const [distScheduledFor, setDistScheduledFor] = useState("")
  const [socialAccounts, setSocialAccounts] = useState<any[]>([])

  // Load social accounts when dialog opens
  useEffect(() => {
    if (!previewDialog.open || !brokerage?.id) return
    supabase
      .from("social_media_accounts")
      .select("id, platform, account_name, is_active")
      .eq("brokerage_id", brokerage.id)
      .eq("is_active", true)
      .order("platform")
      .then(({ data }) => {
        setSocialAccounts(data ?? [])
        if (data?.[0]) {
          setDistAccountId(data[0].id)
          setDistPlatform(data[0].platform)
        }
      })
  }, [previewDialog.open, brokerage?.id, supabase])

  // ─── LOAD VIDEOS ────────────────────────────────────────────────────────────

  const loadVideos = useCallback(async () => {
    if (!brokerage?.id) return

    try {
      const { data, error } = await supabase
        .from("ai_video_projects")
        .select("*")
        .eq("brokerage_id", brokerage.id)
        .order("created_at", { ascending: false })
        .limit(100)

      if (data && !error) {
        setVideos(data)

        // Load streaming statuses for all videos
        const videoIds = data.map(v => v.id)
        const { data: statusData } = await supabase
          .from("video_streaming_status")
          .select("*")
          .in("video_project_id", videoIds)

        if (statusData) {
          const statusMap: Record<string, StreamingStatus> = {}
          statusData.forEach(s => {
            statusMap[s.video_project_id] = s
          })
          setStreamingStatuses(statusMap)
        }

        // Identify videos that need polling
        const needsPolling = data
          .filter(v => ["generating", "pending"].includes(v.status) || ["generating", "processing", "pending"].includes(v.heygen_status || ""))
          .map(v => v.id)
        setPollingVideoIds(new Set(needsPolling))
      }
    } catch (error) {
      console.error("Error loading videos:", error)
    } finally {
      setLoading(false)
    }
  }, [brokerage?.id, supabase])

  useEffect(() => {
    loadVideos()

    // Set up real-time subscription
    const channel = supabase
      .channel("video-board-updates")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "ai_video_projects" },
        (payload) => {
          setVideos((prev) =>
            prev.map((v) => (v.id === payload.new.id ? { ...v, ...payload.new } : v))
          )
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "ai_video_projects" },
        (payload) => {
          setVideos((prev) => [payload.new as VideoProject, ...prev])
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "video_streaming_status" },
        (payload) => {
          const newStatus = payload.new as StreamingStatus
          setStreamingStatuses((prev) => ({
            ...prev,
            [newStatus.video_project_id]: newStatus,
          }))
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [loadVideos, supabase])

  // ─── STATUS POLLING ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (pollingVideoIds.size === 0) return

    const pollInterval = setInterval(async () => {
      for (const videoId of pollingVideoIds) {
        try {
          const response = await fetch(`/api/heygen/check-status/${videoId}`)
          const data = await response.json()

          if (data.status === "completed" || data.status === "failed") {
            setPollingVideoIds(prev => {
              const next = new Set(prev)
              next.delete(videoId)
              return next
            })
          }
        } catch (error) {
          console.error(`Error polling video ${videoId}:`, error)
        }
      }
    }, 10000) // Poll every 10 seconds

    return () => clearInterval(pollInterval)
  }, [pollingVideoIds])

  // ─── HANDLERS ───────────────────────────────────────────────────────────────

  async function handleRefresh() {
    setRefreshing(true)
    await loadVideos()
    setRefreshing(false)
  }

  async function handleRetry(videoId: string) {
    const video = videos.find(v => v.id === videoId)
    if (!video) return

    try {
      // Reset status
      await supabase
        .from("ai_video_projects")
        .update({
          status: "pending",
          heygen_status: "pending",
          error_message: null,
          retry_count: (video.retry_count || 0) + 1,
        })
        .eq("id", videoId)

      // Re-submit to HeyGen
      const response = await fetch("/api/heygen/generate-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script: video.script_content,
          avatar_id: video.provider_metadata?.quality_preset ? "Angela-inblackskirt-20220820" : "Angela-inblackskirt-20220820",
          voice_id: "en-US-JennyNeural",
          video_project_id: videoId,
          brokerage_id: video.brokerage_id,
          user_id: user?.id,
          quality_preset: video.provider_metadata?.quality_preset || "1080p",
          output_orientation: video.provider_metadata?.output_orientation || "landscape",
        }),
      })

      if (response.ok) {
        setPollingVideoIds(prev => new Set(prev).add(videoId))
        await loadVideos()
      }
    } catch (error) {
      console.error("Error retrying video:", error)
    }
  }

  async function handlePublish(video: VideoProject) {
    setPublishing(true)

    try {
      const response = await fetch(`/api/heygen/check-status/${video.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: user?.id,
          publish_metadata: {
            published_by: user?.id,
            published_at: new Date().toISOString(),
          },
        }),
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.error || "Failed to publish video")
      }

      setPreviewDialog({ open: false, video: null })
      await loadVideos()
    } catch (error: any) {
      console.error("Error publishing video:", error)
      toast.error(error.message || "Failed to publish video")
    } finally {
      setPublishing(false)
    }
  }

  async function handleDistribute(
    video: VideoProject,
    action: "post_now" | "schedule" | "draft" | "copy_link",
    opts?: { scheduledFor?: string }
  ) {
    if (!brokerage?.id || !user?.id) return
    setDistributing(true)
    try {
      const result = await distributeVideo({
        videoProjectId: video.id,
        brokerageId: brokerage.id,
        userId: user.id,
        action,
        platform: distPlatform || "instagram",
        socialAccountId: distAccountId || undefined,
        scheduledFor: opts?.scheduledFor,
      })
      if (!result.success) {
        toast.error(result.error ?? "Distribution failed")
        return
      }
      if (action === "copy_link" && result.shareableLink) {
        await navigator.clipboard.writeText(result.shareableLink)
        toast.success("Link copied to clipboard")
      } else if (action === "post_now") {
        toast.success("Video scheduled for immediate posting")
        setPreviewDialog({ open: false, video: null })
      } else if (action === "schedule") {
        toast.success("Video scheduled")
        setPreviewDialog({ open: false, video: null })
      } else if (action === "draft") {
        toast.success("Saved to drafts")
      }
    } catch (err: any) {
      toast.error(err.message ?? "Distribution failed")
    } finally {
      setDistributing(false)
    }
  }

  async function handleDelete(videoId: string) {
    if (!confirm("Are you sure you want to delete this video?")) return

    try {
      await supabase
        .from("ai_video_projects")
        .delete()
        .eq("id", videoId)

      setVideos(prev => prev.filter(v => v.id !== videoId))
    } catch (error) {
      console.error("Error deleting video:", error)
    }
  }

  const getColumnVideos = (columnId: string) => {
    return videos.filter((v) => mapStatusToColumn(v.status, v.heygen_status) === columnId)
  }

  // ─── RENDER ─────────────────────────────────────────────────────────────────

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
          <p className="text-muted-foreground">Track your video generation progress with kernel governance</p>
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

      {/* Polling indicator */}
      {pollingVideoIds.size > 0 && (
        <Alert>
          <Loader2 className="h-4 w-4 animate-spin" />
          <AlertTitle>Processing Videos</AlertTitle>
          <AlertDescription>
            {pollingVideoIds.size} video(s) are currently being generated. This page will update automatically.
          </AlertDescription>
        </Alert>
      )}

      {/* Kanban Board */}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {COLUMNS.map((column) => {
          const columnVideos = getColumnVideos(column.id)
          const Icon = column.icon

          return (
            <div key={column.id} className="min-w-[320px] flex-shrink-0">
              <div className="mb-3 flex items-center gap-2">
                <div className={cn("h-2 w-2 rounded-full", column.color)} />
                <h3 className="font-medium">{column.title}</h3>
                <Badge variant="secondary" className="ml-auto">
                  {columnVideos.length}
                </Badge>
              </div>

              <div className="space-y-3 rounded-lg bg-muted/30 p-3 min-h-[500px]">
                {columnVideos.map((video) => {
                  const streamStatus = streamingStatuses[video.id]
                  const thumbnailUrl = video.video_metadata?.thumbnail_url || video.provider_metadata?.thumbnail_url

                  return (
                    <Card key={video.id} className="cursor-pointer hover:shadow-md transition-shadow">
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <h4 className="font-medium truncate">{video.title || `Video ${video.id.slice(0, 8)}`}</h4>
                            <p className="text-sm text-muted-foreground truncate">
                              {video.video_type?.replace(/_/g, " ")}
                            </p>
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {(video.status === "preview_ready" || video.heygen_status === "completed") && (
                                <>
                                  <DropdownMenuItem onClick={() => setPreviewDialog({ open: true, video })}>
                                    <Eye className="mr-2 h-4 w-4" />
                                    Preview & Publish
                                  </DropdownMenuItem>
                                  {video.video_url && (
                                    <DropdownMenuItem asChild>
                                      <a href={video.video_url} target="_blank" rel="noopener noreferrer">
                                        <ExternalLink className="mr-2 h-4 w-4" />
                                        Open Video
                                      </a>
                                    </DropdownMenuItem>
                                  )}
                                  <DropdownMenuSeparator />
                                </>
                              )}
                              {(video.status === "published" || video.status === "preview_ready" || video.status === "ready" || video.status === "completed") && video.video_url && (
                                <>
                                  <DropdownMenuItem onClick={() => setPreviewDialog({ open: true, video })}>
                                    <Share2 className="mr-2 h-4 w-4" />
                                    Distribute
                                  </DropdownMenuItem>
                                  <DropdownMenuItem asChild>
                                    <a href={video.video_url} target="_blank" rel="noopener noreferrer">
                                      <Play className="mr-2 h-4 w-4" />
                                      Play
                                    </a>
                                  </DropdownMenuItem>
                                  <DropdownMenuItem asChild>
                                    <a href={video.video_url} download>
                                      <Download className="mr-2 h-4 w-4" />
                                      Download
                                    </a>
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={async () => {
                                      await navigator.clipboard.writeText(video.video_url!)
                                      toast.success("Link copied")
                                    }}
                                  >
                                    <ExternalLink className="mr-2 h-4 w-4" />
                                    Copy Link
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                </>
                              )}
                              {video.status === "failed" && (
                                <DropdownMenuItem onClick={() => handleRetry(video.id)}>
                                  <RefreshCw className="mr-2 h-4 w-4" />
                                  Retry Generation
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                onClick={() => handleDelete(video.id)}
                                className="text-destructive"
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>

                        {/* Status-specific content */}
                        {column.id === "generating" && (
                          <div className="mt-3">
                            <Progress value={pollingVideoIds.has(video.id) ? 50 : 25} className="h-1" />
                            <p className="text-xs text-muted-foreground mt-1">
                              {streamStatus?.stream_status === "processing" ? "Processing video..." : "Queued for generation..."}
                            </p>
                          </div>
                        )}

                        {column.id === "preview_ready" && (
                          <div className="mt-3">
                            <Button
                              size="sm"
                              className="w-full"
                              onClick={() => setPreviewDialog({ open: true, video })}
                            >
                              <Eye className="mr-2 h-4 w-4" />
                              Preview & Approve
                            </Button>
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

                        {/* Thumbnail for completed videos */}
                        {(column.id === "preview_ready" || column.id === "published") && thumbnailUrl && (
                          <div className="mt-3 relative aspect-video rounded overflow-hidden bg-muted">
                            <img
                              src={thumbnailUrl}
                              alt={video.title || "Video thumbnail"}
                              className="object-cover w-full h-full"
                            />
                            <div className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 hover:opacity-100 transition-opacity">
                              <Play className="h-8 w-8 text-white" />
                            </div>
                            {video.duration_seconds && (
                              <Badge className="absolute bottom-2 right-2 text-xs">
                                {Math.floor(video.duration_seconds / 60)}:
                                {(video.duration_seconds % 60).toString().padStart(2, "0")}
                              </Badge>
                            )}
                          </div>
                        )}

                        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {new Date(video.created_at).toLocaleDateString()}
                          {video.provider_metadata?.quality_preset && (
                            <Badge variant="outline" className="ml-auto text-xs">
                              {video.provider_metadata.quality_preset}
                            </Badge>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}

                {columnVideos.length === 0 && (
                  <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
                    <Icon className={cn("h-8 w-8 mb-2 opacity-50", column.id === "generating" && "animate-spin")} />
                    <p className="text-sm">No videos</p>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Preview & Publish Dialog */}
      <Dialog open={previewDialog.open} onOpenChange={(open) => setPreviewDialog({ open, video: previewDialog.video })}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Preview & Publish Video</DialogTitle>
            <DialogDescription>
              Review your video before publishing. Publishing will save it to your video assets.
            </DialogDescription>
          </DialogHeader>

          {previewDialog.video && (
            <div className="space-y-4">
              {/* Video Preview */}
              {previewDialog.video.video_url ? (
                <div className="aspect-video bg-black rounded-lg overflow-hidden">
                  <video
                    src={previewDialog.video.video_url}
                    controls
                    className="w-full h-full"
                  />
                </div>
              ) : (
                <div className="aspect-video bg-muted rounded-lg flex items-center justify-center">
                  <p className="text-muted-foreground">Video preview not available</p>
                </div>
              )}

              {/* Video Details */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="font-medium">Title</p>
                  <p className="text-muted-foreground">{previewDialog.video.title}</p>
                </div>
                <div>
                  <p className="font-medium">Type</p>
                  <p className="text-muted-foreground">{previewDialog.video.video_type?.replace(/_/g, " ")}</p>
                </div>
                <div>
                  <p className="font-medium">Duration</p>
                  <p className="text-muted-foreground">
                    {previewDialog.video.duration_seconds
                      ? `${Math.floor(previewDialog.video.duration_seconds / 60)}:${(previewDialog.video.duration_seconds % 60).toString().padStart(2, "0")}`
                      : "Unknown"}
                  </p>
                </div>
                <div>
                  <p className="font-medium">Quality</p>
                  <p className="text-muted-foreground">{previewDialog.video.provider_metadata?.quality_preset || "1080p"}</p>
                </div>
              </div>

              {/* Distribution Options */}
              <div className="space-y-3 border rounded-lg p-4">
                <p className="text-sm font-medium">Distribute this video</p>

                {socialAccounts.length > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Account</Label>
                      <Select value={distAccountId} onValueChange={(v) => {
                        setDistAccountId(v)
                        const acc = socialAccounts.find(a => a.id === v)
                        if (acc) setDistPlatform(acc.platform)
                      }}>
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Select account" />
                        </SelectTrigger>
                        <SelectContent>
                          {socialAccounts.map(acc => (
                            <SelectItem key={acc.id} value={acc.id} className="text-xs">
                              {acc.account_name} ({acc.platform})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Schedule for</Label>
                      <Input
                        type="datetime-local"
                        value={distScheduledFor}
                        onChange={(e) => setDistScheduledFor(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    disabled={distributing || !previewDialog.video?.video_url}
                    onClick={() => previewDialog.video && handleDistribute(previewDialog.video, "post_now")}
                  >
                    {distributing ? <Loader2 className="mr-2 h-3 w-3 animate-spin" /> : <Send className="mr-2 h-3 w-3" />}
                    Post Now
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={distributing || !distScheduledFor || !previewDialog.video?.video_url}
                    onClick={() => previewDialog.video && handleDistribute(previewDialog.video, "schedule", { scheduledFor: distScheduledFor })}
                  >
                    Schedule
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={distributing || !previewDialog.video?.video_url}
                    onClick={() => previewDialog.video && handleDistribute(previewDialog.video, "draft")}
                  >
                    Add to Drafts
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!previewDialog.video?.video_url}
                    onClick={() => previewDialog.video && handleDistribute(previewDialog.video, "copy_link")}
                  >
                    <ExternalLink className="mr-2 h-3 w-3" />
                    Copy Link
                  </Button>
                </div>

                {previewDialog.video?.video_url && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" className="flex-1" asChild>
                      <a href={previewDialog.video.video_url} download>
                        <Download className="mr-2 h-3 w-3" />
                        Download
                      </a>
                    </Button>
                  </div>
                )}
              </div>

              {/* Kernel Governance Notice */}
              <Alert>
                <Shield className="h-4 w-4" />
                <AlertTitle>Kernel Governance</AlertTitle>
                <AlertDescription>
                  Distribution is subject to compliance review. Ensure your video meets Fair Housing and brand guidelines before posting.
                </AlertDescription>
              </Alert>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewDialog({ open: false, video: null })}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
