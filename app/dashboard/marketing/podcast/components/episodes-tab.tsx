"use client"

import { useState } from "react"
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/app/components/ui/dialog"
import {
  Play,
  Pause,
  Clock,
  Calendar,
  MoreVertical,
  Upload,
  Trash2,
  RefreshCw,
  Loader2,
  Radio,
  BarChart2,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu"
import {
  generatePodcastAudio,
  publishPodcastEpisode,
  deletePodcastEpisode,
  trackPodcastEvent,
} from "@/app/actions/podcast-generation"

interface Episode {
  id: string
  title: string
  description: string
  status: "draft" | "generating" | "completed" | "published" | "failed"
  duration_seconds: number | null
  publish_channels: string[]
  created_at: string
  audio_url: string | null
  category: string
}

interface DistributionChannel {
  id: string
  channel_name: string
  is_enabled: boolean
}

interface EpisodesTabProps {
  episodes: Episode[]
  loading: boolean
  onRefresh: () => void
  channels: DistributionChannel[]
}

export function EpisodesTab({ episodes, loading, onRefresh, channels }: EpisodesTabProps) {
  const [selectedEpisode, setSelectedEpisode] = useState<Episode | null>(null)
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false)
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [processingId, setProcessingId] = useState<string | null>(null)
  const [selectedChannels, setSelectedChannels] = useState<string[]>([])
  const [playingId, setPlayingId] = useState<string | null>(null)

  async function handleGenerateAudio(episodeId: string) {
    setProcessingId(episodeId)
    try {
      const result = await generatePodcastAudio(episodeId)
      if (result.success) {
        onRefresh()
      } else {
        console.error("[Podcast] Audio generation failed:", result.error)
      }
    } finally {
      setProcessingId(null)
    }
  }

  async function handlePublish() {
    if (!selectedEpisode) return

    setProcessingId(selectedEpisode.id)
    try {
      const result = await publishPodcastEpisode(selectedEpisode.id, selectedChannels)
      if (result.success) {
        onRefresh()
        setIsPublishDialogOpen(false)
        setSelectedEpisode(null)
        setSelectedChannels([])
      } else {
        console.error("Failed to publish:", result.error)
      }
    } finally {
      setProcessingId(null)
    }
  }

  async function handleTrack(episodeId: string) {
    await trackPodcastEvent(episodeId, "performance_view", { platform: "dashboard" })
  }

  async function handleDelete() {
    if (!selectedEpisode) return

    setProcessingId(selectedEpisode.id)
    try {
      const result = await deletePodcastEpisode(selectedEpisode.id)
      if (result.success) {
        onRefresh()
        setIsDeleteDialogOpen(false)
        setSelectedEpisode(null)
      } else {
        console.error("Failed to delete:", result.error)
      }
    } finally {
      setProcessingId(null)
    }
  }

  function openPublishDialog(episode: Episode) {
    setSelectedEpisode(episode)
    setSelectedChannels(episode.publish_channels || [])
    setIsPublishDialogOpen(true)
  }

  function openDeleteDialog(episode: Episode) {
    setSelectedEpisode(episode)
    setIsDeleteDialogOpen(true)
  }

  function formatDuration(seconds: number | null): string {
    if (!seconds) return "--:--"
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, "0")}`
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  }

  function getStatusBadge(status: Episode["status"]) {
    const variants: Record<Episode["status"], { variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
      draft: { variant: "outline", label: "Draft" },
      generating: { variant: "secondary", label: "Generating" },
      completed: { variant: "default", label: "Ready" },
      published: { variant: "default", label: "Published" },
      failed: { variant: "destructive", label: "Failed" },
    }
    const { variant, label } = variants[status]
    return <Badge variant={variant}>{label}</Badge>
  }

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <Card key={i} className="animate-pulse">
            <CardHeader>
              <div className="h-5 bg-gray-200 rounded w-3/4" />
              <div className="h-4 bg-gray-200 rounded w-1/2 mt-2" />
            </CardHeader>
            <CardContent>
              <div className="h-16 bg-gray-200 rounded" />
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  if (episodes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="p-4 bg-gray-100 rounded-full mb-4">
          <Radio className="h-8 w-8 text-gray-400" />
        </div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">No episodes yet</h3>
        <p className="text-sm text-gray-500 max-w-sm">
          Create your first podcast episode to start engaging your audience with AI-generated audio content.
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {episodes.map((episode) => (
          <Card key={episode.id} className="relative group hover:shadow-md transition-shadow">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <CardTitle className="text-base truncate">{episode.title}</CardTitle>
                  <CardDescription className="line-clamp-2 mt-1">
                    {episode.description || "No description"}
                  </CardDescription>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" className="shrink-0">
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {episode.status === "draft" && (
                      <DropdownMenuItem onClick={() => handleGenerateAudio(episode.id)}>
                        <RefreshCw className="h-4 w-4 mr-2" />
                        Generate Audio
                      </DropdownMenuItem>
                    )}
                    {episode.status === "completed" && (
                      <DropdownMenuItem onClick={() => openPublishDialog(episode)}>
                        <Upload className="h-4 w-4 mr-2" />
                        Publish
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      onClick={() => openDeleteDialog(episode)}
                      className="text-destructive"
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </CardHeader>

            <CardContent className="pb-2">
              <div className="flex items-center gap-4 text-sm text-gray-500">
                <div className="flex items-center gap-1">
                  <Clock className="h-4 w-4" />
                  <span>{formatDuration(episode.duration_seconds)}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Calendar className="h-4 w-4" />
                  <span>{formatDate(episode.created_at)}</span>
                </div>
              </div>

              {episode.audio_url && (
                <div className="mt-3">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => setPlayingId(playingId === episode.id ? null : episode.id)}
                  >
                    {playingId === episode.id ? (
                      <>
                        <Pause className="h-4 w-4 mr-2" />
                        Pause
                      </>
                    ) : (
                      <>
                        <Play className="h-4 w-4 mr-2" />
                        Play Preview
                      </>
                    )}
                  </Button>
                  {playingId === episode.id && (
                    <audio
                      src={episode.audio_url}
                      autoPlay
                      onEnded={() => setPlayingId(null)}
                      className="hidden"
                    />
                  )}
                </div>
              )}

              {/* Inline primary CTAs based on status */}
              <div className="mt-3 flex flex-col gap-2">
                {episode.status === "draft" && (
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => handleGenerateAudio(episode.id)}
                    disabled={processingId === episode.id}
                  >
                    {processingId === episode.id ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-4 w-4 mr-2" />
                        Generate Audio
                      </>
                    )}
                  </Button>
                )}
                {episode.status === "completed" && (
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => openPublishDialog(episode)}
                    disabled={processingId === episode.id}
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    Publish
                  </Button>
                )}
                {episode.status === "generating" && (
                  <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-1">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Audio generating...
                  </div>
                )}
                {(episode.status === "completed" || episode.status === "published") && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full text-muted-foreground"
                    onClick={() => handleTrack(episode.id)}
                  >
                    <BarChart2 className="h-4 w-4 mr-2" />
                    Track Performance
                  </Button>
                )}
              </div>
            </CardContent>

            <CardFooter className="pt-2 flex items-center justify-between">
              {getStatusBadge(episode.status)}
              {episode.publish_channels && episode.publish_channels.length > 0 && (
                <div className="flex gap-1">
                  {episode.publish_channels.slice(0, 2).map((ch) => (
                    <Badge key={ch} variant="outline" className="text-xs">
                      {ch}
                    </Badge>
                  ))}
                  {episode.publish_channels.length > 2 && (
                    <Badge variant="outline" className="text-xs">
                      +{episode.publish_channels.length - 2}
                    </Badge>
                  )}
                </div>
              )}
              {processingId === episode.id && (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              )}
            </CardFooter>
          </Card>
        ))}
      </div>

      {/* Publish Dialog */}
      <Dialog open={isPublishDialogOpen} onOpenChange={setIsPublishDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish Episode</DialogTitle>
            <DialogDescription>
              Select the distribution channels for this episode.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm font-medium mb-3">Distribution Channels</p>
            <div className="flex flex-col gap-2">
              {channels.filter(ch => ch.is_enabled).map((channel) => (
                <label
                  key={channel.id}
                  className="flex items-center gap-3 p-3 border rounded-lg cursor-pointer hover:bg-gray-50"
                >
                  <input
                    type="checkbox"
                    checked={selectedChannels.includes(channel.channel_name)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedChannels([...selectedChannels, channel.channel_name])
                      } else {
                        setSelectedChannels(selectedChannels.filter(c => c !== channel.channel_name))
                      }
                    }}
                    className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                  />
                  <span className="text-sm font-medium">{channel.channel_name}</span>
                </label>
              ))}
              {channels.filter(ch => ch.is_enabled).length === 0 && (
                <p className="text-sm text-gray-500 text-center py-4">
                  No distribution channels enabled. Configure channels in the Distribution tab.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsPublishDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handlePublish}
              disabled={selectedChannels.length === 0 || processingId !== null}
            >
              {processingId ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Publishing...
                </>
              ) : (
                "Publish"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Episode</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{selectedEpisode?.title}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={processingId !== null}
            >
              {processingId ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                "Delete"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
