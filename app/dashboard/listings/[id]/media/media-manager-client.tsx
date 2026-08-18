"use client"

import { useState, useEffect, useTransition } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MediaGrid } from "./components/media-grid"
import { PhotoOrderingRulesCard } from "./components/photo-ordering-rules-card"
import { VideoPanel } from "./components/video-panel"
import { SocialPanel } from "./components/social-panel"
import { ImageIcon, VideoIcon, Share2Icon, Sparkles, Loader2, Sofa, Sunset, Wand2, ListOrdered, Download, ShieldCheck, AlertTriangle } from "lucide-react"
import {
  analyzePhoto,
  stageListingPhoto,
  twilightListingPhoto,
  enhancePhoto,
  getListingPhotoSet,
  processVendorPhotos,
  optimizePhotoOrder,
  batchEnhancePhotos,
  validatePhotoQuality,
  getPhotoPerformanceStats,
} from "@/app/actions/photo-management"
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

  /**
   * THE MLS PHOTO SET — `listing_media` rows with media_type='photo'
   * (m368/m369 consolidation).
   *
   * There used to be a second table, `listing_photos`, holding the same photos
   * under different column names (photo_url/file_url, order_index/sort_order,
   * is_hero/is_primary). The grid held listing_media ids while every photo tool
   * resolved listing_photos ids, so each tool answered "photo not found"
   * against a row that was never the one on screen. One table now, so the ids
   * on this screen and the ids the tools resolve are the SAME ids.
   *
   * What survives from the old two-table split is `usage_intent`
   * (mls|public_marketing|both) — that is what now distinguishes a photo that
   * is in the MLS set from one that is marketing-only, and the Import button
   * below is what promotes the latter into the former.
   */
  const [photoSet, setPhotoSet] = useState<any[]>([])
  const [photoSetLoading, setPhotoSetLoading] = useState(true)
  const [photoStats, setPhotoStats] = useState<any>(null)
  const [photoQuality, setPhotoQuality] = useState<any>(null)

  const refreshPhotoSet = async () => {
    const [setResult, stats, quality] = await Promise.all([
      getListingPhotoSet(listingId),
      getPhotoPerformanceStats(listingId),
      validatePhotoQuality(listingId),
    ])
    setPhotoSet(setResult.success ? setResult.photos : [])
    setPhotoStats(stats)
    setPhotoQuality(quality)
    setPhotoSetLoading(false)
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const [setResult, stats, quality] = await Promise.all([
        getListingPhotoSet(listingId),
        getPhotoPerformanceStats(listingId),
        validatePhotoQuality(listingId),
      ])
      if (cancelled) return
      setPhotoSet(setResult.success ? setResult.photos : [])
      setPhotoStats(stats)
      setPhotoQuality(quality)
      setPhotoSetLoading(false)
    })()
    return () => { cancelled = true }
  }, [listingId])

  /** listing_media.media_type is CHECK-constrained to photo|video|reel|story|
   *  graphic|floorplan|virtual_tour|document. "image" is not a value that column
   *  can ever hold, so the old filter matched nothing at all. */
  const photoMedia = media.filter((m: any) => m.media_type === "photo" && (m.file_url || m.url))
  /** Photos already carrying MLS usage_intent — the MLS set proper. */
  const inMlsSetUrls = new Set(
    photoSet
      .filter((p: any) => p.usage_intent === "mls" || p.usage_intent === "both")
      .map((p: any) => p.file_url),
  )
  const notYetImported = photoMedia.filter((m: any) => !inMlsSetUrls.has(m.file_url ?? m.url))

  const runPhotoTool = (photoId: string, tool: "stage" | "twilight" | "enhance") => {
    setBusyPhotoId(photoId)
    startTransition(async () => {
      try {
        const result =
          tool === "stage" ? await stageListingPhoto({ photoId })
          : tool === "twilight" ? await twilightListingPhoto({ photoId })
          : await enhancePhoto({ photoId, enhancements: ["auto"] })
        if (result.success) {
          toast.success(
            tool === "stage" ? "Virtually staged — saved to your marketing assets with the required disclosure"
            : tool === "twilight" ? "Twilight version saved to your marketing assets"
            : "Photo enhanced",
          )
          await refreshPhotoSet()
        } else {
          toast.error(result.error ?? "Photo tool failed")
        }
      } finally {
        setBusyPhotoId(null)
      }
    })
  }

  const canApprove = userRole === "admin" || userRole === "broker"

  /** Bring marketing photo media into the MLS photo set — promotes
   *  usage_intent to 'both' and runs photo intelligence over the promoted rows.
   *  It still INGESTS URLs that have no row yet, which is how a photographer's
   *  delivery becomes photos in the first place. Idempotent: photos already
   *  carrying MLS intent are skipped. */
  const handleImportToPhotoSet = () => {
    if (notYetImported.length === 0) { toast.error("Every photo is already in the MLS set"); return }
    startTransition(async () => {
      const result = await processVendorPhotos({
        listingId,
        photoUrls: notYetImported.map((m: any) => m.file_url ?? m.url),
      })
      if (!result.success) { toast.error(result.error ?? "Import failed"); return }
      const addedToSet = (result.processed ?? 0) + (result.adopted ?? 0)
      toast.success(
        `${addedToSet} photo${addedToSet === 1 ? "" : "s"} added to the MLS set` +
        (result.analyzed ? ` · ${result.analyzed} analyzed` : "") +
        (result.skipped ? ` · ${result.skipped} already present` : ""),
      )
      await refreshPhotoSet()
    })
  }

  const handleOptimizeOrder = () => {
    startTransition(async () => {
      const result = await optimizePhotoOrder(listingId)
      if (!result.success) { toast.error(result.error ?? "Could not reorder"); return }
      toast.success(
        `Reordered ${result.reordered} photo${result.reordered === 1 ? "" : "s"}` +
        (result.ruleApplied ? ` using your "${result.ruleApplied}" rule` : " using the MLS default sequence"),
      )
      await refreshPhotoSet()
    })
  }

  const handleBatchEnhance = () => {
    startTransition(async () => {
      const result = await batchEnhancePhotos({ listingId })
      if (!result.success) { toast.error(result.error ?? "Batch enhance failed"); return }
      if ((result.candidates ?? 0) === 0) {
        toast.success("No photo scored below 80 — nothing needed enhancing")
      } else {
        toast.success(`Enhanced ${result.enhanced} of ${result.candidates} low-scoring photo${result.candidates === 1 ? "" : "s"}`)
      }
      await refreshPhotoSet()
    })
  }

  const handleAnalyzePhotos = () => {
    const pending = photoSet.filter((p: any) => !p.ai_analysis_completed)
    if (photoSet.length === 0) {
      toast.error("The MLS photo set is empty — import your photos first")
      return
    }
    const targets = pending.length > 0 ? pending : photoSet
    startTransition(async () => {
      const results = await Promise.allSettled(
        targets.map((p: any) => analyzePhoto({ photoId: p.id, photoUrl: p.file_url }))
      )
      const scores: Record<string, any> = {}
      results.forEach((r, i) => {
        if (r.status === "fulfilled" && r.value.success) {
          scores[targets[i].id] = r.value.data
        }
      })
      setPhotoScores(scores)
      toast.success(`Analyzed ${Object.keys(scores).length} photo${Object.keys(scores).length !== 1 ? "s" : ""}`)
      await refreshPhotoSet()
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
          {/* MLS PHOTO SET — the listing_media photo rows the MLS / hero picker /
              readiness checks / direct mail all read. The grid below shows the
              same table; this panel is the photo-intelligence view of it. */}
          <div className="mb-4 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium flex items-center gap-1.5">
                  <ListOrdered className="h-4 w-4 text-primary" />
                  MLS Photo Set
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {photoSetLoading
                    ? "Loading…"
                    : photoSet.length === 0
                      ? "Empty — import your delivered photos to start MLS ordering, hero selection and quality checks."
                      : `${photoSet.length} photo${photoSet.length === 1 ? "" : "s"} in MLS order` +
                        (photoStats?.avgQuality != null ? ` · avg quality ${Math.round(photoStats.avgQuality)}/100` : " · not analyzed yet") +
                        (photoStats?.enhancedCount ? ` · ${photoStats.enhancedCount} enhanced` : "")}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={handleImportToPhotoSet}
                  disabled={isPending || photoSetLoading || notYetImported.length === 0}>
                  <Download className="h-4 w-4 mr-1.5" />
                  Import {notYetImported.length > 0 ? `${notYetImported.length} ` : ""}photo{notYetImported.length === 1 ? "" : "s"}
                </Button>
                <Button size="sm" variant="outline" onClick={handleOptimizeOrder}
                  disabled={isPending || photoSet.length === 0}>
                  <ListOrdered className="h-4 w-4 mr-1.5" /> Optimize order
                </Button>
                <Button size="sm" variant="outline" onClick={handleBatchEnhance}
                  disabled={isPending || photoSet.length === 0}>
                  <Wand2 className="h-4 w-4 mr-1.5" /> Enhance low scores
                </Button>
              </div>
            </div>

            {/* The rule "Optimize order" applies — savable at last (see card). */}
            <PhotoOrderingRulesCard />

            {photoQuality && photoSet.length > 0 && (
              <div className="mt-3 rounded border bg-muted/40 p-3 text-xs">
                <p className="font-medium flex items-center gap-1.5">
                  {photoQuality.passed
                    ? <><ShieldCheck className="h-3.5 w-3.5 text-emerald-600" /> Photo set passes MLS quality checks</>
                    : <><AlertTriangle className="h-3.5 w-3.5 text-amber-600" /> {photoQuality.issues?.length ?? 0} issue{(photoQuality.issues?.length ?? 0) === 1 ? "" : "s"} to fix before this goes live</>}
                </p>
                {!photoQuality.passed && Array.isArray(photoQuality.issues) && (
                  <ul className="mt-1.5 space-y-0.5 text-muted-foreground list-disc list-inside">
                    {photoQuality.issues.map((issue: string) => <li key={issue}>{issue}</li>)}
                  </ul>
                )}
                {photoStats?.roomCoverage != null && (
                  <p className="mt-1.5 text-muted-foreground">
                    Room coverage {Math.round(photoStats.roomCoverage)}%
                    {photoStats.heroImageQuality != null && ` · hero quality ${Math.round(photoStats.heroImageQuality)}/100`}
                  </p>
                )}
              </div>
            )}
          </div>

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
