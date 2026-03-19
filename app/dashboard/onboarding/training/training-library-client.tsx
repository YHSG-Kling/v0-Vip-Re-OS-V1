"use client"

// ============================================================
// SYSTEM: L11-S04 — Training Video Library Client Component
// VIP Real Estate AI OS — Layer 11
// ============================================================

import { useState, useMemo } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  Play,
  CheckCircle2,
  Clock,
  Filter,
  ChevronRight,
  GraduationCap,
  AlertCircle,
  BookOpen,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type { VideoWithProgress, TrainingVideoCategory } from "@/app/actions/onboarding/training"
import { checkRequiredVideoGating } from "@/app/actions/onboarding/training"

// ─── Types ───────────────────────────────────────────────────────────────────

interface TrainingLibraryClientProps {
  videos: VideoWithProgress[]
  requiredCount: number
  completedRequiredCount: number
  progressPercent: number
  userName: string
}

// ─── Category Config ─────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<TrainingVideoCategory, string> = {
  platform_tour: "Platform Tour",
  lead_management: "Lead Management",
  listing_workflow: "Listing Workflow",
  transaction: "Transaction",
  portal: "Portal",
  marketing: "Marketing",
  isa_engine: "ISA Engine",
  compliance: "Compliance",
  them_first: "Them First",
  mobile_app: "Mobile App",
  custom: "Custom",
}

const CATEGORY_COLORS: Record<TrainingVideoCategory, string> = {
  platform_tour: "bg-blue-100 text-blue-800 border-blue-200",
  lead_management: "bg-green-100 text-green-800 border-green-200",
  listing_workflow: "bg-purple-100 text-purple-800 border-purple-200",
  transaction: "bg-amber-100 text-amber-800 border-amber-200",
  portal: "bg-cyan-100 text-cyan-800 border-cyan-200",
  marketing: "bg-pink-100 text-pink-800 border-pink-200",
  isa_engine: "bg-indigo-100 text-indigo-800 border-indigo-200",
  compliance: "bg-red-100 text-red-800 border-red-200",
  them_first: "bg-emerald-100 text-emerald-800 border-emerald-200",
  mobile_app: "bg-slate-100 text-slate-800 border-slate-200",
  custom: "bg-gray-100 text-gray-800 border-gray-200",
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, "0")}`
}

function getVideoStatus(video: VideoWithProgress): "not_started" | "in_progress" | "completed" {
  if (video.completion?.completed) return "completed"
  if (video.completion && video.completion.percent_watched > 0) return "in_progress"
  return "not_started"
}

// ─── Video Card Component ────────────────────────────────────────────────────

function VideoCard({
  video,
  onGatingCheck,
}: {
  video: VideoWithProgress
  onGatingCheck: (video: VideoWithProgress) => void
}) {
  const router = useRouter()
  const status = getVideoStatus(video)
  const percentWatched = video.completion?.percent_watched || 0

  const handleClick = async () => {
    if (video.is_required && status !== "completed") {
      onGatingCheck(video)
    } else {
      router.push(`/dashboard/onboarding/training/${video.id}`)
    }
  }

  return (
    <div
      onClick={handleClick}
      className={cn(
        "group relative bg-card border rounded-xl overflow-hidden cursor-pointer transition-all hover:shadow-md hover:border-primary/30",
        status === "completed" && "border-green-200 bg-green-50/30"
      )}
    >
      {/* Thumbnail */}
      <div className="relative aspect-video bg-muted">
        {video.thumbnail_url ? (
          <img
            src={video.thumbnail_url}
            alt={video.title}
            className="w-full h-full object-cover"
          />
        ) : (
          <div
            className={cn(
              "w-full h-full flex items-center justify-center",
              CATEGORY_COLORS[video.category].replace("text-", "bg-").replace("-800", "-100")
            )}
          >
            <Play className="h-12 w-12 text-muted-foreground/50" />
          </div>
        )}

        {/* Duration badge */}
        <div className="absolute top-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
          {formatDuration(video.duration_seconds)}
        </div>

        {/* Play overlay */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
          <div className="opacity-0 group-hover:opacity-100 transition-opacity bg-primary text-primary-foreground rounded-full p-3">
            <Play className="h-6 w-6" fill="currentColor" />
          </div>
        </div>

        {/* Status indicator */}
        {status === "completed" && (
          <div className="absolute top-2 left-2 bg-green-500 text-white rounded-full p-1">
            <CheckCircle2 className="h-4 w-4" />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-foreground line-clamp-2 text-sm">
            {video.title}
          </h3>
          {video.is_required && status !== "completed" && (
            <Badge variant="outline" className="bg-orange-100 text-orange-800 border-orange-200 shrink-0 text-xs">
              Required
            </Badge>
          )}
        </div>

        {/* Category badge */}
        <Badge
          variant="outline"
          className={cn("text-xs", CATEGORY_COLORS[video.category])}
        >
          {CATEGORY_LABELS[video.category]}
        </Badge>

        {/* Progress bar */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            {status === "completed" ? (
              <span className="text-green-600 font-medium flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Complete
              </span>
            ) : status === "in_progress" ? (
              <span className="text-blue-600 font-medium">
                {Math.round(percentWatched)}% watched
              </span>
            ) : (
              <span className="text-muted-foreground">Not started</span>
            )}
          </div>
          <Progress
            value={status === "completed" ? 100 : percentWatched}
            className={cn(
              "h-1.5",
              status === "completed" && "[&>div]:bg-green-500",
              status === "in_progress" && "[&>div]:bg-blue-500"
            )}
          />
        </div>

        {/* Custom label for brokerage-specific content */}
        {video.brokerage_id && !video.is_platform_default && (
          <span className="text-xs text-muted-foreground">Custom Training</span>
        )}
      </div>
    </div>
  )
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function TrainingLibraryClient({
  videos,
  requiredCount,
  completedRequiredCount,
  progressPercent,
  userName,
}: TrainingLibraryClientProps) {
  const router = useRouter()
  const [selectedCategory, setSelectedCategory] = useState<string>("all")
  const [gatingModal, setGatingModal] = useState<{
    open: boolean
    blockedVideo?: VideoWithProgress
    blockingVideo?: { videoId: string; title: string }
  }>({ open: false })

  // Get unique categories from videos
  const categories = useMemo(() => {
    const cats = new Set(videos.map((v) => v.category))
    return Array.from(cats).sort()
  }, [videos])

  // Filter videos by category
  const filteredVideos = useMemo(() => {
    if (selectedCategory === "all") return videos
    return videos.filter((v) => v.category === selectedCategory)
  }, [videos, selectedCategory])

  // Check gating when clicking required videos
  const handleGatingCheck = async (video: VideoWithProgress) => {
    const result = await checkRequiredVideoGating(video.id)
    if (result.allowed) {
      router.push(`/dashboard/onboarding/training/${video.id}`)
    } else {
      setGatingModal({
        open: true,
        blockedVideo: video,
        blockingVideo: result.blockedBy,
      })
    }
  }

  const allRequiredComplete = completedRequiredCount >= requiredCount

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <GraduationCap className="h-7 w-7 text-primary" />
              Training Library
            </h1>
            <p className="text-muted-foreground mt-1">
              {userName && `Welcome, ${userName}! `}Complete your required training to unlock full platform access.
            </p>
          </div>
          <Link href="/dashboard/onboarding">
            <Button variant="outline" size="sm">
              <ChevronRight className="h-4 w-4 mr-1 rotate-180" />
              Back to Onboarding
            </Button>
          </Link>
        </div>

        {/* Progress Card */}
        <div className="bg-card border rounded-xl p-6">
          <div className="flex flex-col md:flex-row md:items-center gap-6">
            <div className="flex-1 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-foreground">Your Training Progress</h2>
                <span className="text-2xl font-bold text-primary">{progressPercent}%</span>
              </div>
              <Progress value={progressPercent} className="h-3" />
              <p className="text-sm text-muted-foreground">
                {completedRequiredCount} of {requiredCount} required videos completed
              </p>
            </div>

            {allRequiredComplete && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4 flex items-start gap-3">
                <CheckCircle2 className="h-6 w-6 text-green-600 shrink-0" />
                <div>
                  <p className="font-semibold text-green-800">All Required Training Complete!</p>
                  <p className="text-sm text-green-700 mt-1">
                    You can now proceed to certification.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Category Tabs */}
        <div className="flex items-center gap-4 overflow-x-auto pb-2">
          <Filter className="h-4 w-4 text-muted-foreground shrink-0" />
          <Tabs value={selectedCategory} onValueChange={setSelectedCategory}>
            <TabsList className="h-auto flex-wrap">
              <TabsTrigger value="all" className="text-sm">
                All ({videos.length})
              </TabsTrigger>
              {categories.map((cat) => (
                <TabsTrigger key={cat} value={cat} className="text-sm">
                  {CATEGORY_LABELS[cat as TrainingVideoCategory]} (
                  {videos.filter((v) => v.category === cat).length})
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {/* Video Grid */}
        {filteredVideos.length === 0 ? (
          <div className="text-center py-12">
            <BookOpen className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground">No videos found in this category.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredVideos.map((video) => (
              <VideoCard
                key={video.id}
                video={video}
                onGatingCheck={handleGatingCheck}
              />
            ))}
          </div>
        )}

        {/* Continue to Certification Button */}
        <div className="flex justify-center pt-6">
          <Link href="/dashboard/onboarding/progress">
            <Button
              size="lg"
              disabled={!allRequiredComplete}
              className={cn(
                "gap-2",
                !allRequiredComplete && "cursor-not-allowed opacity-50"
              )}
            >
              <GraduationCap className="h-5 w-5" />
              Continue to Certification
            </Button>
          </Link>
        </div>

        {/* Gating Modal */}
        <Dialog open={gatingModal.open} onOpenChange={(open) => setGatingModal({ open })}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-amber-600">
                <AlertCircle className="h-5 w-5" />
                Complete Previous Training First
              </DialogTitle>
              <DialogDescription className="pt-2">
                You need to complete{" "}
                <strong>&quot;{gatingModal.blockingVideo?.title}&quot;</strong> before unlocking{" "}
                <strong>&quot;{gatingModal.blockedVideo?.title}&quot;</strong>.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setGatingModal({ open: false })}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  if (gatingModal.blockingVideo?.videoId) {
                    router.push(`/dashboard/onboarding/training/${gatingModal.blockingVideo.videoId}`)
                    setGatingModal({ open: false })
                  }
                }}
              >
                <Play className="h-4 w-4 mr-2" />
                Go Watch It
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
