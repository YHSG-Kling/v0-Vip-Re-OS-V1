"use client"

// ============================================================
// SYSTEM: L11-S04 — Training Video Player Client Component
// VIP Real Estate AI OS — Layer 11
// ============================================================

import { useState, useRef, useEffect, useCallback } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  ArrowLeft,
  ChevronRight,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Clock,
  CheckCircle2,
  AlertCircle,
  Loader2,
  GraduationCap,
  Settings,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Slider } from "@/components/ui/slider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useToast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"
import type { TrainingVideo, VideoCompletion, TrainingVideoCategory } from "@/app/actions/onboarding/training"
import { markVideoStarted } from "@/app/actions/onboarding/training"

// ─── Types ───────────────────────────────────────────────────────────────────

interface VideoPlayerClientProps {
  video: TrainingVideo
  completion: VideoCompletion | null
  nextVideo: TrainingVideo | null
  prevVideo: TrainingVideo | null
  allRequiredComplete: boolean
}

// ─── Category Labels ─────────────────────────────────────────────────────────

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
  platform_tour: "bg-blue-100 text-blue-800",
  lead_management: "bg-green-100 text-green-800",
  listing_workflow: "bg-purple-100 text-purple-800",
  transaction: "bg-amber-100 text-amber-800",
  portal: "bg-cyan-100 text-cyan-800",
  marketing: "bg-pink-100 text-pink-800",
  isa_engine: "bg-indigo-100 text-indigo-800",
  compliance: "bg-red-100 text-red-800",
  them_first: "bg-emerald-100 text-emerald-800",
  mobile_app: "bg-slate-100 text-slate-800",
  custom: "bg-gray-100 text-gray-800",
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, "0")}`
}

function isEmbeddedVideoUrl(url: string): boolean {
  // Third-party players that must render in an <iframe> rather than <video>.
  // (heygen.com retained for any legacy training URLs; new renders are direct mp4.)
  return url.includes("heygen.com") || url.includes("vimeo.com") || url.includes("youtube.com")
}

// ─── Video Player Component ──────────────────────────────────────────────────

export function VideoPlayerClient({
  video,
  completion,
  nextVideo,
  allRequiredComplete: initialAllRequiredComplete,
}: VideoPlayerClientProps) {
  const router = useRouter()
  const { toast } = useToast()
  const videoRef = useRef<HTMLVideoElement>(null)
  const progressIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const hasStartedRef = useRef(false)

  // State
  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [currentTime, setCurrentTime] = useState(completion?.last_position_seconds || 0)
  const [duration, setDuration] = useState(video.duration_seconds || 0)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [isCompleted, setIsCompleted] = useState(completion?.completed || false)
  const [percentWatched, setPercentWatched] = useState(completion?.percent_watched || 0)
  const [isLoading, setIsLoading] = useState(true)
  const [showCompletionBanner, setShowCompletionBanner] = useState(false)
  const [allRequiredComplete, setAllRequiredComplete] = useState(initialAllRequiredComplete)

  // Determine if this is an embedded video (third-party player: YouTube, Vimeo)
  const isEmbedded = isEmbeddedVideoUrl(video.video_url)

  // Save progress to server
  const saveProgress = useCallback(async () => {
    if (!videoRef.current || isCompleted) return

    const current = videoRef.current.currentTime
    const total = videoRef.current.duration || video.duration_seconds
    const percent = total > 0 ? (current / total) * 100 : 0

    try {
      const response = await fetch("/api/onboarding/training/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId: video.id,
          positionSeconds: Math.floor(current),
          percentWatched: Math.min(100, percent),
        }),
      })

      const result = await response.json()

      if (result.completed && !isCompleted) {
        setIsCompleted(true)
        setShowCompletionBanner(true)
        toast({
          title: "Video Complete!",
          description: "Great work! You've completed this training video.",
          duration: 5000,
        })

        if (result.allRequiredComplete) {
          setAllRequiredComplete(true)
          toast({
            title: "All Required Training Complete!",
            description: "You can now proceed to certification.",
            duration: 7000,
          })
        }
      }

      setPercentWatched(result.percentWatched || percent)
    } catch (error) {
      console.error("[VideoPlayer] Error saving progress:", error)
    }
  }, [video.id, video.duration_seconds, isCompleted, toast])

  // Mark video as started
  const handleVideoStarted = useCallback(async () => {
    if (hasStartedRef.current) return
    hasStartedRef.current = true

    try {
      await markVideoStarted(video.id)
    } catch (error) {
      console.error("[VideoPlayer] Error marking video started:", error)
    }
  }, [video.id])

  // Play/Pause toggle
  const togglePlayPause = useCallback(() => {
    if (!videoRef.current) return

    if (isPlaying) {
      videoRef.current.pause()
    } else {
      videoRef.current.play()
      handleVideoStarted()
    }
  }, [isPlaying, handleVideoStarted])

  // Mute toggle
  const toggleMute = useCallback(() => {
    if (!videoRef.current) return
    videoRef.current.muted = !isMuted
    setIsMuted(!isMuted)
  }, [isMuted])

  // Fullscreen
  const toggleFullscreen = useCallback(() => {
    if (!videoRef.current) return

    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      videoRef.current.requestFullscreen()
    }
  }, [])

  // Seek
  const handleSeek = useCallback((value: number[]) => {
    if (!videoRef.current) return
    videoRef.current.currentTime = value[0]
    setCurrentTime(value[0])
  }, [])

  // Playback rate
  const handlePlaybackRateChange = useCallback((rate: number) => {
    if (!videoRef.current) return
    videoRef.current.playbackRate = rate
    setPlaybackRate(rate)
  }, [])

  // Video event handlers
  useEffect(() => {
    const videoEl = videoRef.current
    if (!videoEl || isEmbedded) return

    const handlePlay = () => {
      setIsPlaying(true)
      handleVideoStarted()
    }
    const handlePause = () => setIsPlaying(false)
    const handleTimeUpdate = () => setCurrentTime(videoEl.currentTime)
    const handleLoadedMetadata = () => {
      setDuration(videoEl.duration)
      setIsLoading(false)

      // Resume from last position
      if (completion?.last_position_seconds && completion.last_position_seconds > 0) {
        videoEl.currentTime = completion.last_position_seconds
      }
    }
    const handleCanPlay = () => setIsLoading(false)
    const handleWaiting = () => setIsLoading(true)

    videoEl.addEventListener("play", handlePlay)
    videoEl.addEventListener("pause", handlePause)
    videoEl.addEventListener("timeupdate", handleTimeUpdate)
    videoEl.addEventListener("loadedmetadata", handleLoadedMetadata)
    videoEl.addEventListener("canplay", handleCanPlay)
    videoEl.addEventListener("waiting", handleWaiting)

    return () => {
      videoEl.removeEventListener("play", handlePlay)
      videoEl.removeEventListener("pause", handlePause)
      videoEl.removeEventListener("timeupdate", handleTimeUpdate)
      videoEl.removeEventListener("loadedmetadata", handleLoadedMetadata)
      videoEl.removeEventListener("canplay", handleCanPlay)
      videoEl.removeEventListener("waiting", handleWaiting)
    }
  }, [isEmbedded, completion?.last_position_seconds, handleVideoStarted])

  // Progress tracking interval
  useEffect(() => {
    if (isPlaying && !isEmbedded) {
      progressIntervalRef.current = setInterval(saveProgress, 10000) // Every 10 seconds
    }

    return () => {
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current)
        progressIntervalRef.current = null
      }
    }
  }, [isPlaying, isEmbedded, saveProgress])

  // Save progress on unmount
  useEffect(() => {
    return () => {
      if (!isEmbedded) {
        saveProgress()
      }
    }
  }, [isEmbedded, saveProgress])

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b px-6 py-4">
          <div className="flex items-center justify-between">
            <Link
              href="/dashboard/onboarding/training"
              className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="text-sm font-medium">Back to Library</span>
            </Link>

            {!isCompleted && video.is_required && (
              <Badge variant="outline" className="bg-orange-100 text-orange-800 border-orange-200">
                Required
              </Badge>
            )}

            {isCompleted && (
              <Badge className="bg-green-100 text-green-800 border-green-200">
                <CheckCircle2 className="h-3 w-3 mr-1" /> Completed
              </Badge>
            )}
          </div>
        </div>

        {/* Completion Banner */}
        {showCompletionBanner && (
          <div className="bg-green-50 border-b border-green-200 px-6 py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                <p className="text-green-800 font-medium">
                  Video Complete! {allRequiredComplete && "All required training complete!"}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setShowCompletionBanner(false)}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {/* Main Content */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 p-6">
          {/* Video Player */}
          <div className="lg:col-span-2 space-y-4">
            <div className="relative bg-black rounded-xl overflow-hidden aspect-video">
              {isEmbedded ? (
                // Embedded video (third-party player: YouTube, Vimeo)
                <iframe
                  src={video.video_url}
                  className="absolute inset-0 w-full h-full"
                  allow="autoplay; fullscreen; picture-in-picture"
                  allowFullScreen
                />
              ) : (
                // Native HTML5 video
                <>
                  <video
                    ref={videoRef}
                    src={video.video_url}
                    className="w-full h-full object-contain"
                    crossOrigin="anonymous"
                    playsInline
                    preload="metadata"
                    onClick={togglePlayPause}
                  />

                  {/* Loading overlay */}
                  {isLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                      <Loader2 className="h-10 w-10 text-white animate-spin" />
                    </div>
                  )}

                  {/* Play button overlay */}
                  {!isPlaying && !isLoading && (
                    <button
                      onClick={togglePlayPause}
                      className="absolute inset-0 flex items-center justify-center bg-black/30 hover:bg-black/40 transition-colors"
                    >
                      <div className="bg-primary text-primary-foreground rounded-full p-4">
                        <Play className="h-8 w-8" fill="currentColor" />
                      </div>
                    </button>
                  )}
                </>
              )}
            </div>

            {/* Video Controls (only for native video) */}
            {!isEmbedded && (
              <div className="bg-card border rounded-lg p-4 space-y-3">
                {/* Progress slider */}
                <div className="space-y-2">
                  <Slider
                    value={[currentTime]}
                    max={duration}
                    step={1}
                    onValueChange={handleSeek}
                    className="cursor-pointer"
                  />
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>{formatDuration(currentTime)}</span>
                    <span>{formatDuration(duration)}</span>
                  </div>
                </div>

                {/* Controls */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={togglePlayPause}
                    >
                      {isPlaying ? (
                        <Pause className="h-5 w-5" />
                      ) : (
                        <Play className="h-5 w-5" />
                      )}
                    </Button>

                    <Button variant="ghost" size="icon" onClick={toggleMute}>
                      {isMuted ? (
                        <VolumeX className="h-5 w-5" />
                      ) : (
                        <Volume2 className="h-5 w-5" />
                      )}
                    </Button>
                  </div>

                  <div className="flex items-center gap-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="gap-1">
                          <Settings className="h-4 w-4" />
                          {playbackRate}x
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        {[0.75, 1, 1.25, 1.5].map((rate) => (
                          <DropdownMenuItem
                            key={rate}
                            onClick={() => handlePlaybackRateChange(rate)}
                            className={cn(playbackRate === rate && "bg-accent")}
                          >
                            {rate}x
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>

                    <Button variant="ghost" size="icon" onClick={toggleFullscreen}>
                      <Maximize className="h-5 w-5" />
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Progress indicator */}
            <div className="bg-card border rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-muted-foreground">Your Progress</span>
                <span className="text-sm font-bold text-foreground">{Math.round(percentWatched)}%</span>
              </div>
              <Progress
                value={percentWatched}
                className={cn(
                  "h-2",
                  isCompleted && "[&>div]:bg-green-500"
                )}
              />
              {percentWatched >= 90 && !isCompleted && (
                <p className="text-xs text-green-600 mt-2 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  Almost there! Complete the video to mark it done.
                </p>
              )}
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Video Info */}
            <div className="bg-card border rounded-xl p-6 space-y-4">
              <div>
                <Badge
                  variant="outline"
                  className={cn("mb-3", CATEGORY_COLORS[video.category as TrainingVideoCategory])}
                >
                  {CATEGORY_LABELS[video.category as TrainingVideoCategory]}
                </Badge>
                <h1 className="text-xl font-bold text-foreground">{video.title}</h1>
              </div>

              {video.description && (
                <p className="text-muted-foreground text-sm leading-relaxed">
                  {video.description}
                </p>
              )}

              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-1">
                  <Clock className="h-4 w-4" />
                  <span>{formatDuration(video.duration_seconds)}</span>
                </div>
                {isCompleted && (
                  <div className="flex items-center gap-1 text-green-600">
                    <CheckCircle2 className="h-4 w-4" />
                    <span>Completed</span>
                  </div>
                )}
              </div>
            </div>

            {/* Next Video */}
            {nextVideo && (
              <div className="bg-card border rounded-xl p-6 space-y-4">
                <h2 className="font-semibold text-foreground">Next Video</h2>
                <div className="space-y-3">
                  <p className="text-sm font-medium text-foreground">{nextVideo.title}</p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    <span>{formatDuration(nextVideo.duration_seconds)}</span>
                    {nextVideo.is_required && (
                      <Badge variant="outline" className="bg-orange-100 text-orange-800 border-orange-200 text-xs">
                        Required
                      </Badge>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    className="w-full gap-2"
                    onClick={() => router.push(`/dashboard/onboarding/training/${nextVideo.id}`)}
                  >
                    <span>Next Video</span>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            {/* All Complete Banner */}
            {allRequiredComplete && (
              <div className="bg-green-50 border border-green-200 rounded-xl p-6 space-y-4">
                <div className="flex items-center gap-3">
                  <GraduationCap className="h-8 w-8 text-green-600" />
                  <div>
                    <h3 className="font-semibold text-green-800">Training Complete!</h3>
                    <p className="text-sm text-green-700">
                      You&apos;ve completed all required training videos.
                    </p>
                  </div>
                </div>
                <Link href="/dashboard/onboarding/progress">
                  <Button className="w-full gap-2">
                    <GraduationCap className="h-4 w-4" />
                    Continue to Certification
                  </Button>
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
