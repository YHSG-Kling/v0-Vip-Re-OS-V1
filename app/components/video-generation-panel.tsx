"use client"

import { useState, useEffect, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Video,
  Play,
  Download,
  Share2,
  Eye,
  CheckCircle,
  Clock,
  XCircle,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Shield,
  ExternalLink,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { createClient } from "@/lib/supabase/client"
import { useAuth } from "@/lib/auth/client"

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface VideoProject {
  id: string
  title: string
  video_type: string
  status: string
  heygen_status?: string
  script_content?: string
  video_url?: string
  duration_seconds?: number
  created_at: string
  error_message?: string
  video_metadata?: {
    thumbnail_url?: string
    published_at?: string
  }
}

interface VideoGenerationPanelProps {
  transactionId?: string
  listingId?: string
  agentId?: string
  compactMode?: boolean
}

// ─── STATUS CONFIG ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { icon: any; color: string; label: string }> = {
  pending: { icon: Clock, color: "text-gray-600", label: "Pending" },
  generating: { icon: Loader2, color: "text-amber-600", label: "Generating..." },
  preview_ready: { icon: Eye, color: "text-blue-600", label: "Preview Ready" },
  completed: { icon: CheckCircle, color: "text-green-600", label: "Ready" },
  published: { icon: CheckCircle, color: "text-green-600", label: "Published" },
  failed: { icon: XCircle, color: "text-red-600", label: "Failed" },
}

// ─── COMPONENT ────────────────────────────────────────────────────────────────

export function VideoGenerationPanel({
  transactionId,
  listingId,
  agentId,
  compactMode = false,
}: VideoGenerationPanelProps) {
  const router = useRouter()
  const { user, userContext } = useAuth()
  const brokerage = userContext?.brokerageId ? { id: userContext.brokerageId } : null
  const supabase = createClient()

  const [projects, setProjects] = useState<VideoProject[]>([])
  const [loading, setLoading] = useState(true)
  const [pollingIds, setPollingIds] = useState<Set<string>>(new Set())

  // ─── LOAD PROJECTS ──────────────────────────────────────────────────────────

  const loadProjects = useCallback(async () => {
    const effectiveAgentId = agentId || user?.id
    if (!effectiveAgentId && !brokerage?.id) return

    try {
      let query = supabase
        .from("ai_video_projects")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(10)

      if (listingId) {
        query = query.eq("listing_id", listingId)
      } else if (transactionId) {
        // Get listing from transaction first
        const { data: txn } = await supabase
          .from("transactions")
          .select("listing_id")
          .eq("id", transactionId)
          .single()

        if (txn?.listing_id) {
          query = query.eq("listing_id", txn.listing_id)
        }
      } else if (effectiveAgentId) {
        query = query.eq("agent_id", effectiveAgentId)
      }

      if (brokerage?.id) {
        query = query.eq("brokerage_id", brokerage.id)
      }

      const { data, error } = await query

      if (data && !error) {
        setProjects(data)

        // Track which videos need polling
        const needsPolling = data
          .filter(
            (v: any) =>
              ["pending", "generating"].includes(v.status) ||
              ["pending", "generating", "processing"].includes(v.heygen_status || "")
          )
          .map((v: any) => v.id)
        setPollingIds(new Set(needsPolling))
      }
    } catch (error) {
      console.error("Error loading video projects:", error)
    } finally {
      setLoading(false)
    }
  }, [agentId, user?.id, brokerage?.id, listingId, transactionId, supabase])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  // ─── STATUS POLLING ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (pollingIds.size === 0) return

    const pollInterval = setInterval(async () => {
      for (const videoId of pollingIds) {
        try {
          const response = await fetch(`/api/heygen/check-status/${videoId}`)
          const data = await response.json()

          if (data.status === "completed" || data.status === "failed" || data.preview_ready) {
            setPollingIds((prev) => {
              const next = new Set(prev)
              next.delete(videoId)
              return next
            })
            // Reload projects to get updated data
            loadProjects()
          }
        } catch (error) {
          console.error(`Error polling video ${videoId}:`, error)
        }
      }
    }, 10000) // Poll every 10 seconds

    return () => clearInterval(pollInterval)
  }, [pollingIds, loadProjects])

  // ─── REAL-TIME UPDATES ──────────────────────────────────────────────────────

  useEffect(() => {
    const channel = supabase
      .channel("video-panel-updates")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "ai_video_projects" },
        (payload: any) => {
          setProjects((prev) =>
            prev.map((p) => (p.id === payload.new.id ? { ...p, ...payload.new } : p))
          )
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "ai_video_projects" },
        (payload: any) => {
          setProjects((prev) => [payload.new as VideoProject, ...prev].slice(0, 10))
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [supabase])

  // ─── HANDLERS ───────────────────────────────────────────────────────────────

  async function handlePublish(project: VideoProject) {
    try {
      const response = await fetch(`/api/heygen/check-status/${project.id}`, {
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

      if (response.ok) {
        loadProjects()
      }
    } catch (error) {
      console.error("Error publishing video:", error)
    }
  }

  // ─── RENDER ───���─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Video className="h-5 w-5" />
              AI Video Generation
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Create professional avatar videos with HeyGen AI
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => loadProjects()}
              disabled={loading}
            >
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
            <Button
              size="sm"
              onClick={() => router.push("/dashboard/videos/create")}
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Video
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Polling Indicator */}
        {pollingIds.size > 0 && (
          <Alert>
            <Loader2 className="h-4 w-4 animate-spin" />
            <AlertDescription>
              {pollingIds.size} video(s) generating. Updates will appear automatically.
            </AlertDescription>
          </Alert>
        )}

        {/* Empty State */}
        {projects.length === 0 && (
          <div className="text-center py-8">
            <Video className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground mb-4">
              No videos generated yet. Create your first AI video.
            </p>
            <Button onClick={() => router.push("/dashboard/videos/create")}>
              <Plus className="h-4 w-4 mr-2" />
              Create Video
            </Button>
          </div>
        )}

        {/* Video Projects List */}
        {projects.map((project) => (
          <VideoProjectCard
            key={project.id}
            project={project}
            isPolling={pollingIds.has(project.id)}
            onPublish={() => handlePublish(project)}
            compactMode={compactMode}
          />
        ))}

        {/* View All Link */}
        {projects.length > 0 && (
          <div className="text-center pt-2">
            <Button variant="link" onClick={() => router.push("/dashboard/videos/board")}>
              View All Videos
              <ExternalLink className="h-4 w-4 ml-2" />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── VIDEO PROJECT CARD ───────────────────────────────────────────────────────

function VideoProjectCard({
  project,
  isPolling,
  onPublish,
  compactMode,
}: {
  project: VideoProject
  isPolling: boolean
  onPublish: () => void
  compactMode: boolean
}) {
  const effectiveStatus = project.status === "preview_ready" || project.heygen_status === "completed"
    ? "preview_ready"
    : project.status || project.heygen_status || "pending"

  const config = STATUS_CONFIG[effectiveStatus] || STATUS_CONFIG.pending
  const Icon = config.icon
  const thumbnailUrl = project.video_metadata?.thumbnail_url

  return (
    <div className={cn(
      "flex items-center gap-4 p-4 border rounded-lg",
      compactMode && "p-3"
    )}>
      {/* Thumbnail */}
      <div className={cn(
        "bg-muted rounded-lg flex items-center justify-center flex-shrink-0 relative overflow-hidden",
        compactMode ? "w-24 h-16" : "w-32 h-20"
      )}>
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={project.title || "Video thumbnail"}
            className="w-full h-full object-cover"
          />
        ) : (
          <Video className="h-8 w-8 text-muted-foreground" />
        )}
        {project.duration_seconds && (
          <Badge className="absolute bottom-1 right-1 text-xs">
            {Math.floor(project.duration_seconds / 60)}:
            {(project.duration_seconds % 60).toString().padStart(2, "0")}
          </Badge>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <p className="font-medium truncate">{project.title || `Video ${project.id.slice(0, 8)}`}</p>
          <Icon className={cn("h-4 w-4 flex-shrink-0", config.color, isPolling && "animate-spin")} />
          <Badge variant="outline" className="text-xs flex-shrink-0">
            {config.label}
          </Badge>
        </div>

        <p className="text-sm text-muted-foreground">
          {project.video_type?.replace(/_/g, " ")} - {new Date(project.created_at).toLocaleDateString()}
        </p>

        {/* Progress for generating videos */}
        {(effectiveStatus === "generating" || effectiveStatus === "pending") && isPolling && (
          <div className="mt-2">
            <Progress value={effectiveStatus === "generating" ? 50 : 15} className="h-1" />
          </div>
        )}

        {/* Error message */}
        {effectiveStatus === "failed" && project.error_message && (
          <p className="text-xs text-destructive mt-1 truncate">{project.error_message}</p>
        )}

        {/* Script preview */}
        {!compactMode && project.script_content && (
          <div className="mt-2 p-2 bg-muted rounded text-xs">
            <p className="line-clamp-2">{project.script_content}</p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2 flex-shrink-0">
        {effectiveStatus === "preview_ready" && (
          <Button size="sm" onClick={onPublish}>
            <Send className="h-4 w-4 mr-1" />
            Publish
          </Button>
        )}

        {effectiveStatus === "published" && project.video_url && (
          <>
            <Button size="sm" variant="outline" asChild>
              <a href={project.video_url} target="_blank" rel="noopener noreferrer">
                <Play className="h-4 w-4 mr-1" />
                Play
              </a>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href={project.video_url} download>
                <Download className="h-4 w-4 mr-1" />
                Download
              </a>
            </Button>
          </>
        )}

        {(effectiveStatus === "completed" || effectiveStatus === "preview_ready") && project.video_url && (
          <Button size="sm" variant="outline" asChild>
            <a href={project.video_url} target="_blank" rel="noopener noreferrer">
              <Eye className="h-4 w-4 mr-1" />
              Preview
            </a>
          </Button>
        )}
      </div>
    </div>
  )
}

export default VideoGenerationPanel
