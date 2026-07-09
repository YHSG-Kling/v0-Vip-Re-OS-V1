"use client"

import { useState, useTransition } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MediaGrid } from "./components/media-grid"
import { VideoPanel } from "./components/video-panel"
import { SocialPanel } from "./components/social-panel"
import { ImageIcon, VideoIcon, Share2Icon, Sparkles, Loader2, Sofa, Sunset, Wand2 } from "lucide-react"
import { analyzePhoto, stageListingPhoto, twilightListingPhoto, enhancePhoto } from "@/app/actions/photo-management"
import { toast } from "sonner"

interface Listing {
  id: string
  address: string
  lifecycle_stage: string | null
  status: string | null
}

interface MediaManagerClientProps {
  listingId: string
  listing: Listing
  brokerageId: string
  agentId: string
  userRole: string | null
  sellerContactId?: string | null
  initialMedia: any[]
  initialVideos: any[]
  initialPosts: any[]
  videoTemplates: any[]
  socialAccounts: any[]
}

export function MediaManagerClient({
  listingId,
  listing,
  brokerageId,
  agentId,
  userRole,
  sellerContactId,
  initialMedia,
  initialVideos,
  initialPosts,
  videoTemplates,
  socialAccounts,
}: MediaManagerClientProps) {
  const [media, setMedia] = useState(initialMedia)
  const [videos, setVideos] = useState(initialVideos)
  const [posts, setPosts] = useState(initialPosts)
  const [photoScores, setPhotoScores] = useState<Record<string, any>>({})
  const [isPending, startTransition] = useTransition()
  const [busyPhotoId, setBusyPhotoId] = useState<string | null>(null)

  const runPhotoTool = (photoId: string, tool: "stage" | "twilight" | "enhance") => {
    setBusyPhotoId(photoId)
    startTransition(async () => {
      try {
        const result =
          tool === "stage" ? await stageListingPhoto({ photoId })
          : tool === "twilight" ? await twilightListingPhoto({ photoId })
          : await enhancePhoto({ photoId, enhancements: ["auto"], agentId })
        if (result.success) {
          toast.success(
            tool === "stage" ? "Virtually staged — saved to your marketing assets with the required disclosure"
            : tool === "twilight" ? "Twilight version saved to your marketing assets"
            : "Photo enhanced",
          )
        } else {
          toast.error(result.error ?? "Photo tool failed")
        }
      } finally {
        setBusyPhotoId(null)
      }
    })
  }

  const canApprove = userRole === "admin" || userRole === "broker"

  const handleAnalyzePhotos = () => {
    const photos = media.filter((m: any) => m.media_type === "image" && (m.file_url || m.url))
    if (photos.length === 0) { toast.error("No photos to analyze"); return }
    startTransition(async () => {
      const results = await Promise.allSettled(
        photos.map((m: any) => analyzePhoto({ photoId: m.id, photoUrl: m.file_url ?? m.url ?? "" }))
      )
      const scores: Record<string, any> = {}
      results.forEach((r, i) => {
        if (r.status === "fulfilled" && r.value.success) {
          scores[photos[i].id] = r.value.data
        }
      })
      setPhotoScores(scores)
      toast.success(`Analyzed ${Object.keys(scores).length} photo${Object.keys(scores).length !== 1 ? "s" : ""}`)
    })
  }

  const pendingMedia  = media.filter(m => m.approval_required && !m.is_approved).length
  const pendingPosts  = posts.filter(p => p.approval_status === "pending").length
  const failedCompliance = media.filter(m => !m.kernel_compliance_passed).length

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto font-sans">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-foreground text-balance">
            Media Manager
          </h1>
          <Button size="sm" variant="outline" onClick={handleAnalyzePhotos} disabled={isPending}>
            {isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1.5" />}
            Analyze Photos
          </Button>
          {failedCompliance > 0 && (
            <Badge variant="destructive" className="text-xs">
              {failedCompliance} compliance issue{failedCompliance > 1 ? "s" : ""}
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground text-pretty">{listing.address}</p>
        <div className="flex items-center gap-2 mt-1">
          {listing.lifecycle_stage && (
            <Badge variant="secondary" className="text-xs capitalize">
              {listing.lifecycle_stage.replace(/_/g, " ")}
            </Badge>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="media" className="w-full">
        <TabsList className="w-full max-w-md">
          <TabsTrigger value="media" className="flex items-center gap-2 flex-1">
            <ImageIcon className="w-4 h-4" />
            <span>Photos & Docs</span>
            {pendingMedia > 0 && (
              <Badge variant="destructive" className="text-xs ml-1 px-1.5 py-0">
                {pendingMedia}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="video" className="flex items-center gap-2 flex-1">
            <VideoIcon className="w-4 h-4" />
            <span>AI Video</span>
          </TabsTrigger>
          <TabsTrigger value="social" className="flex items-center gap-2 flex-1">
            <Share2Icon className="w-4 h-4" />
            <span>Social</span>
            {pendingPosts > 0 && (
              <Badge variant="destructive" className="text-xs ml-1 px-1.5 py-0">
                {pendingPosts}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="media" className="mt-6">
          {Object.keys(photoScores).length > 0 && (
            <div className="mb-4 p-3 rounded-lg border bg-muted/40 text-sm">
              <p className="font-medium mb-2 flex items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-primary" />
                AI Photo Analysis Results
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {Object.entries(photoScores).map(([photoId, score]: [string, any]) => (
                  <div key={photoId} className="text-xs rounded border bg-background p-2">
                    <p className="font-medium capitalize">{score.room_type?.replace(/_/g, " ") ?? "Unknown"}</p>
                    <p className="text-muted-foreground">Quality: {score.quality_score ?? "—"}/100</p>
                    {score.is_hero_worthy && <p className="text-amber-600 font-medium">★ Hero Shot</p>}
                    {Array.isArray(score.suggestions) && score.suggestions.length > 0 && (
                      <p className="text-muted-foreground mt-1">{score.suggestions.join(" · ")}</p>
                    )}
                    <div className="flex flex-wrap gap-1 mt-2">
                      {score.vacant && (
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]"
                          disabled={busyPhotoId === photoId}
                          onClick={() => runPhotoTool(photoId, "stage")}>
                          <Sofa className="h-3 w-3 mr-1" /> Stage
                        </Button>
                      )}
                      {(score.room_type === "exterior_front" || score.room_type === "exterior_back") && (
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]"
                          disabled={busyPhotoId === photoId}
                          onClick={() => runPhotoTool(photoId, "twilight")}>
                          <Sunset className="h-3 w-3 mr-1" /> Twilight
                        </Button>
                      )}
                      {(score.quality_score ?? 100) < 80 && (
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]"
                          disabled={busyPhotoId === photoId}
                          onClick={() => runPhotoTool(photoId, "enhance")}>
                          <Wand2 className="h-3 w-3 mr-1" /> Enhance
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <MediaGrid
            listingId={listingId}
            brokerageId={brokerageId}
            media={media}
            canApprove={canApprove}
            onMediaChange={setMedia}
          />
        </TabsContent>

        <TabsContent value="video" className="mt-6">
          <VideoPanel
            listingId={listingId}
            brokerageId={brokerageId}
            videos={videos}
            templates={videoTemplates}
            onVideosChange={setVideos}
          />
        </TabsContent>

        <TabsContent value="social" className="mt-6">
          <SocialPanel
            listingId={listingId}
            brokerageId={brokerageId}
            agentId={agentId}
            sellerContactId={sellerContactId}
            posts={posts}
            accounts={socialAccounts}
            canApprove={canApprove}
            onPostsChange={setPosts}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
