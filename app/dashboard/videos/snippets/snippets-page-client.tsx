"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import {
  Scissors,
  Library,
  Plus,
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  Trash2,
  Info,
  Wand2,
} from "lucide-react"
import {
  createVideoSnippet,
  updateSnippetApprovalStatus,
  scheduleSnippetToSocial,
  deleteSnippet,
  getSnippetDetail,
  generateCaptionVariations,
  type VideoSnippet,
  type PlatformTarget,
  type SnippetDetail,
  type CaptionVariation,
} from "@/app/actions/video-repurposing"
import { getSocialAccountsForDistribution } from "@/app/actions/video/create-video-project"
import Link from "next/link"
import { Calendar } from "lucide-react"

const PLATFORM_OPTIONS: { value: PlatformTarget; label: string; maxSeconds: number }[] = [
  { value: "instagram_reels", label: "Instagram Reels", maxSeconds: 90 },
  { value: "instagram_story", label: "Instagram Story", maxSeconds: 60 },
  { value: "instagram_post",  label: "Instagram Post",  maxSeconds: 60 },
  { value: "tiktok",          label: "TikTok",          maxSeconds: 180 },
  { value: "youtube_shorts",  label: "YouTube Shorts",  maxSeconds: 60 },
  { value: "facebook_reels",  label: "Facebook Reels",  maxSeconds: 90 },
  { value: "linkedin",        label: "LinkedIn Video",  maxSeconds: 600 },
  { value: "twitter",         label: "Twitter / X",     maxSeconds: 140 },
]

const STATUS_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  draft:          { label: "Draft",    variant: "outline" },
  pending_review: { label: "Pending",  variant: "secondary" },
  approved:       { label: "Approved", variant: "default" },
  rejected:       { label: "Rejected", variant: "destructive" },
}

interface Props {
  snippets: VideoSnippet[]
  brokerageId: string
  userId: string
}

export default function SnippetsPageClient({ snippets, brokerageId, userId }: Props) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Sheet state
  const [open, setOpen] = useState(false)
  const [snippetTitle, setSnippetTitle]     = useState("")
  const [captionText, setCaptionText]       = useState("")
  const [platform, setPlatform]             = useState<PlatformTarget>("instagram_reels")
  const [startSeconds, setStartSeconds]     = useState(0)
  const [endSeconds, setEndSeconds]         = useState(30)
  const [hashtags, setHashtags]             = useState("")

  // Caption variations (AI) — generated for the caption being written above,
  // picked by the agent, and persisted by createVideoSnippet as caption_text.
  const [variations, setVariations]         = useState<CaptionVariation[]>([])
  const [isVarying, setIsVarying]           = useState(false)
  const [variationError, setVariationError] = useState<string | null>(null)

  // Detail sheet state
  const [detailOpen, setDetailOpen]         = useState(false)
  const [detail, setDetail]                 = useState<SnippetDetail | null>(null)
  const [detailError, setDetailError]       = useState<string | null>(null)
  const [detailLoading, setDetailLoading]   = useState(false)

  // Schedule sheet state
  const [scheduleOpen, setScheduleOpen]     = useState(false)
  const [scheduleSnippet, setScheduleSnippet] = useState<VideoSnippet | null>(null)
  const [scheduleDate, setScheduleDate]     = useState<string>(() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setMinutes(0, 0, 0)
    return d.toISOString().slice(0, 16)
  })

  // Connected destinations for the schedule sheet. scheduleSnippetToSocial has
  // always accepted (and tenant-checked) a socialAccountId; nothing on this page
  // ever supplied one, so every queued post landed with social_account_id null
  // and no channel behind it.
  const [accounts, setAccounts] = useState<
    Array<{ id: string; platform: string; account_name: string; is_active: boolean; scope: string | null }>
  >([])
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  const [selectedAccountId, setSelectedAccountId] = useState<string>("")

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const rows = await getSocialAccountsForDistribution()
        if (!cancelled) setAccounts(rows)
      } catch {
        if (!cancelled) setAccounts([])
      } finally {
        if (!cancelled) setAccountsLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Only accounts on the platform this snippet targets can receive it.
  const PLATFORM_OF: Record<string, string> = {
    instagram_reels: "instagram",
    instagram_story: "instagram",
    instagram_post: "instagram",
    tiktok: "tiktok",
    youtube_shorts: "youtube",
    facebook_reels: "facebook",
    linkedin: "linkedin",
    twitter: "twitter",
  }
  const eligibleAccounts = scheduleSnippet
    ? accounts.filter(a => a.platform === PLATFORM_OF[scheduleSnippet.platform_target])
    : []

  async function handleApprove(snippetId: string) {
    startTransition(async () => {
      try {
        await updateSnippetApprovalStatus(snippetId, brokerageId, "approved", userId)
        toast.success("Snippet approved.")
        router.refresh()
      } catch (err: any) {
        toast.error(err?.message ?? "Failed to approve snippet.")
      }
    })
  }

  async function handleReject(snippetId: string) {
    startTransition(async () => {
      try {
        await updateSnippetApprovalStatus(snippetId, brokerageId, "rejected", userId)
        toast.success("Snippet rejected.")
        router.refresh()
      } catch (err: any) {
        toast.error(err?.message ?? "Failed to reject snippet.")
      }
    })
  }

  // DELETE — the server decides. deleteSnippet scopes the delete to the
  // caller's brokerage and reports the affected-row count, so a snippet that is
  // not ours comes back "not found" instead of a cheerful optimistic removal.
  async function handleDelete(snippetId: string, title: string) {
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return
    startTransition(async () => {
      try {
        const result = await deleteSnippet(snippetId)
        if (!result.success) {
          toast.error(result.error ?? "Failed to delete snippet.")
          return
        }
        toast.success("Snippet deleted.")
        router.refresh()
      } catch (err: any) {
        toast.error(err?.message ?? "Failed to delete snippet.")
      }
    })
  }

  // DETAILS — full caption, hashtags and the source project this clip came from.
  async function openDetail(snippetId: string) {
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)
    setDetailOpen(true)
    try {
      const result = await getSnippetDetail(snippetId)
      if (!result.success || !result.snippet) {
        setDetailError(result.error ?? "Snippet not found.")
        return
      }
      setDetail(result.snippet)
    } catch (err: any) {
      setDetailError(err?.message ?? "Could not load this snippet.")
    } finally {
      setDetailLoading(false)
    }
  }

  // CAPTION VARIATIONS — AI rewrites of the caption currently in the form.
  async function handleGenerateVariations() {
    setVariationError(null)
    setIsVarying(true)
    try {
      const result = await generateCaptionVariations({
        originalCaption: captionText,
        platform,
        variationCount: 3,
      })
      if (!result.success) {
        // The server's verdict, not a fabricated success: the old action echoed
        // the input back on failure, which read as "here are your variations".
        setVariationError(result.error ?? "Could not generate variations.")
        setVariations([])
        return
      }
      setVariations(result.variations)
    } catch (err: any) {
      setVariationError(err?.message ?? "Could not generate variations.")
    } finally {
      setIsVarying(false)
    }
  }

  function applyVariation(v: CaptionVariation) {
    setCaptionText(v.caption)
    if (v.hashtags.length > 0) setHashtags(v.hashtags.join(", "))
    setVariations([])
    toast.success("Caption applied — it will be saved with the snippet.")
  }

  function openSchedule(snippet: VideoSnippet) {
    setScheduleSnippet(snippet)
    setSelectedAccountId("")
    setScheduleOpen(true)
  }

  async function handleSchedule() {
    if (!scheduleSnippet) return
    startTransition(async () => {
      try {
        await scheduleSnippetToSocial({
          snippetId: scheduleSnippet.id,
          brokerageId,
          scheduledFor: new Date(scheduleDate).toISOString(),
          socialAccountId: selectedAccountId || undefined,
          userId,
        })
        toast.success("Snippet queued to omnipresence.", {
          action: {
            label: "View queue",
            onClick: () => router.push("/dashboard/campaigns/repurpose"),
          },
        })
        setScheduleOpen(false)
        setScheduleSnippet(null)
        router.refresh()
      } catch (err: any) {
        toast.error(err?.message ?? "Failed to schedule snippet.")
      }
    })
  }

  const selectedPlatform = PLATFORM_OPTIONS.find(p => p.value === platform)!
  const duration = endSeconds - startSeconds
  const durationValid = duration > 0 && duration <= selectedPlatform.maxSeconds

  function resetForm() {
    setSnippetTitle("")
    setCaptionText("")
    setPlatform("instagram_reels")
    setStartSeconds(0)
    setEndSeconds(30)
    setHashtags("")
    setVariations([])
    setVariationError(null)
  }

  async function handleCreate() {
    if (!snippetTitle || !durationValid) return

    startTransition(async () => {
      try {
        await createVideoSnippet({
          brokerageId,
          snippetTitle,
          startSeconds,
          endSeconds,
          platformTarget: platform,
          captionText: captionText || undefined,
          hashtags: hashtags
            ? hashtags.split(",").map(h => h.trim().replace(/^#/, "")).filter(Boolean)
            : undefined,
          createdBy: userId,
        })
        toast.success("Snippet created and pending review.")
        setOpen(false)
        resetForm()
        router.refresh()
      } catch (err: any) {
        toast.error(err?.message ?? "Failed to create snippet.")
      }
    })
  }

  return (
    <>
      <Tabs defaultValue="library" className="space-y-6">
        <div className="flex items-center justify-between">
          <TabsList className="grid grid-cols-2 bg-muted/50 p-1 rounded-xl w-fit">
            <TabsTrigger value="library" className="flex items-center gap-2 data-[state=active]:bg-background px-4">
              <Library className="h-4 w-4" />
              Snippet Library
            </TabsTrigger>
            <TabsTrigger value="create" className="flex items-center gap-2 data-[state=active]:bg-background px-4">
              <Scissors className="h-4 w-4" />
              Create Snippet
            </TabsTrigger>
          </TabsList>

          <Button onClick={() => setOpen(true)} size="sm" className="gap-2">
            <Plus className="h-4 w-4" />
            New Snippet
          </Button>
        </div>

        {/* Library tab */}
        <TabsContent value="library">
          <Card>
            <CardHeader className="bg-muted/30">
              <CardTitle className="flex items-center gap-2">
                <Library className="h-5 w-5" />
                Your Snippets
              </CardTitle>
              <CardDescription>Approved video clips ready to publish</CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              {snippets.length === 0 ? (
                <div className="text-center py-16 border-2 border-dashed rounded-xl">
                  <div className="bg-muted rounded-full p-6 w-fit mx-auto mb-4">
                    <Library className="h-12 w-12 text-muted-foreground" />
                  </div>
                  <h3 className="text-xl font-semibold mb-2">No snippets yet</h3>
                  <p className="text-muted-foreground max-w-md mx-auto leading-relaxed mb-4">
                    Create your first snippet to see it here
                  </p>
                  <Button variant="outline" onClick={() => setOpen(true)} className="gap-2">
                    <Plus className="h-4 w-4" />
                    Create Snippet
                  </Button>
                </div>
              ) : (
                <div className="divide-y">
                  {snippets.map((s) => {
                    const statusMeta = STATUS_BADGE[s.approval_status] ?? STATUS_BADGE.pending_review
                    const isPendingStatus = s.approval_status === "pending_review" || s.approval_status === "draft" || !s.approval_status
                    const isApproved = s.approval_status === "approved"
                    return (
                      <div key={s.id} className="flex items-center justify-between gap-4 py-4">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-sm truncate">{s.snippet_title}</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                            <Clock className="h-3 w-3" />
                            {s.end_seconds - s.start_seconds}s &middot; {s.platform_target.replace(/_/g, " ")}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 gap-1.5"
                            onClick={() => openDetail(s.id)}
                            aria-label="Snippet details"
                          >
                            <Info className="h-3.5 w-3.5" />
                            Details
                          </Button>
                          {isPendingStatus && (
                            <>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 gap-1.5 text-emerald-700 hover:text-emerald-800"
                                onClick={() => handleApprove(s.id)}
                                disabled={isPending}
                              >
                                <CheckCircle className="h-3.5 w-3.5" />
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 gap-1.5 text-red-700 hover:text-red-800"
                                onClick={() => handleReject(s.id)}
                                disabled={isPending}
                              >
                                <XCircle className="h-3.5 w-3.5" />
                                Reject
                              </Button>
                            </>
                          )}
                          {isApproved && (
                            <Button
                              size="sm"
                              className="h-8 gap-1.5"
                              onClick={() => openSchedule(s)}
                              disabled={isPending}
                            >
                              <Calendar className="h-3.5 w-3.5" />
                              Schedule
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0"
                            onClick={() => handleDelete(s.id, s.snippet_title)}
                            disabled={isPending}
                            aria-label="Delete snippet"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-red-500" />
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Create tab — opens sheet */}
        <TabsContent value="create">
          <Card>
            <CardHeader className="bg-muted/30">
              <CardTitle className="flex items-center gap-2">
                <Scissors className="h-5 w-5" />
                Create New Snippet
              </CardTitle>
              <CardDescription>Extract and optimize a clip for social media</CardDescription>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="text-center py-16 border-2 border-dashed rounded-xl">
                <div className="bg-muted rounded-full p-6 w-fit mx-auto mb-4">
                  <Scissors className="h-12 w-12 text-muted-foreground" />
                </div>
                <h3 className="text-xl font-semibold mb-2">Create Video Snippet</h3>
                <p className="text-muted-foreground max-w-md mx-auto leading-relaxed mb-4">
                  Define a clip window, target platform, and caption — the snippet will be queued for processing.
                </p>
                <Button onClick={() => setOpen(true)} className="gap-2">
                  <Plus className="h-4 w-4" />
                  Create Video Snippet
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Snippet creator sheet */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Create Video Snippet</SheetTitle>
            <SheetDescription>Short-form clips optimized for social media platforms</SheetDescription>
          </SheetHeader>

          <div className="space-y-5 mt-6">
            {/* Platform */}
            <div className="space-y-1.5">
              <Label>Platform</Label>
              <Select value={platform} onValueChange={(v) => setPlatform(v as PlatformTarget)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORM_OPTIONS.map(p => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label} (max {p.maxSeconds}s)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Title */}
            <div className="space-y-1.5">
              <Label>Snippet Title</Label>
              <Input
                value={snippetTitle}
                onChange={e => setSnippetTitle(e.target.value)}
                placeholder="30-second property highlight"
              />
            </div>

            {/* Clip window */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Start (seconds)</Label>
                <Input
                  type="number"
                  min={0}
                  value={startSeconds}
                  onChange={e => setStartSeconds(Number(e.target.value))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>End (seconds)</Label>
                <Input
                  type="number"
                  min={1}
                  value={endSeconds}
                  onChange={e => setEndSeconds(Number(e.target.value))}
                />
              </div>
            </div>

            {/* Duration validation feedback */}
            {duration > 0 && (
              <p className={`text-xs flex items-center gap-1.5 ${durationValid ? "text-green-600" : "text-destructive"}`}>
                {durationValid
                  ? <><CheckCircle className="h-3.5 w-3.5" />{duration}s — within {selectedPlatform.label} limit</>
                  : <><XCircle className="h-3.5 w-3.5" />{duration}s exceeds {selectedPlatform.label} max of {selectedPlatform.maxSeconds}s</>
                }
              </p>
            )}

            {/* Caption */}
            <div className="space-y-1.5">
              <Label>Caption <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Textarea
                rows={3}
                value={captionText}
                onChange={e => setCaptionText(e.target.value)}
                placeholder="Caption text for the post..."
              />

              {/* AI caption variations — rewrite the caption above for this
                  platform, pick one, and it is saved with the snippet. */}
              <div className="flex items-center justify-between pt-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  disabled={isVarying || !captionText.trim()}
                  onClick={handleGenerateVariations}
                >
                  {isVarying
                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Rewriting…</>
                    : <><Wand2 className="h-3.5 w-3.5" />Caption variations</>
                  }
                </Button>
                {!captionText.trim() && (
                  <span className="text-xs text-muted-foreground">Write a caption first</span>
                )}
              </div>

              {variationError && (
                <p className="text-xs text-destructive">{variationError}</p>
              )}

              {variations.length > 0 && (
                <div className="space-y-2 pt-1">
                  {variations.map((v, i) => (
                    <div key={i} className="rounded-lg border p-2.5 space-y-1.5">
                      <p className="text-xs whitespace-pre-wrap">{v.caption}</p>
                      {v.hashtags.length > 0 && (
                        <p className="text-[11px] text-muted-foreground">
                          {v.hashtags.map(h => `#${h}`).join(" ")}
                        </p>
                      )}
                      <div className="flex items-center justify-between">
                        <Badge variant="outline" className="text-[10px]">{v.tone}</Badge>
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => applyVariation(v)}>
                          Use this
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Hashtags */}
            <div className="space-y-1.5">
              <Label>Hashtags <span className="text-muted-foreground font-normal">(comma-separated, optional)</span></Label>
              <Input
                value={hashtags}
                onChange={e => setHashtags(e.target.value)}
                placeholder="realestate, homebuying, justsold"
              />
            </div>

            <Button
              className="w-full"
              disabled={!snippetTitle || !durationValid || isPending}
              onClick={handleCreate}
            >
              {isPending
                ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Creating...</>
                : "Create Snippet"
              }
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Schedule sheet */}
      <Sheet open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <SheetContent className="overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Schedule snippet</SheetTitle>
            <SheetDescription>
              Queue this clip for publishing on {scheduleSnippet?.platform_target.replace(/_/g, " ")}.
              It will appear in the omnipresence queue once scheduled.
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-4 mt-6">
            <div className="rounded-lg border p-3 bg-muted/30">
              <p className="font-medium text-sm">{scheduleSnippet?.snippet_title}</p>
              {scheduleSnippet && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {scheduleSnippet.end_seconds - scheduleSnippet.start_seconds}s ·{" "}
                  {scheduleSnippet.platform_target.replace(/_/g, " ")}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="schedule-when">Publish at</Label>
              <Input
                id="schedule-when"
                type="datetime-local"
                value={scheduleDate}
                onChange={(e) => setScheduleDate(e.target.value)}
              />
            </div>

            {/* Destination account — the connected channels for this snippet's
                platform. Queuing without one is still allowed (the post lands
                unassigned for the omnipresence queue to route), but the choice
                is now the agent's rather than a silent null. */}
            <div className="space-y-1.5">
              <Label>Publish to</Label>
              {!accountsLoaded ? (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading connected accounts…
                </p>
              ) : eligibleAccounts.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No connected{" "}
                  {scheduleSnippet ? (PLATFORM_OF[scheduleSnippet.platform_target] ?? "social") : "social"}{" "}
                  account. The clip will queue unassigned until one is connected.
                </p>
              ) : (
                <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a connected account…" />
                  </SelectTrigger>
                  <SelectContent>
                    {eligibleAccounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.account_name}
                        {a.scope === "brokerage" ? " (brokerage)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <p className="text-[11px] text-muted-foreground">
              Queuing does not publish. The clip enters the omnipresence queue and goes out through
              the existing consent and brand-compliance checks.
            </p>

            <Button className="w-full" disabled={isPending} onClick={handleSchedule}>
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Queuing…
                </>
              ) : (
                <>
                  <Calendar className="h-4 w-4 mr-2" />
                  Queue to omnipresence
                </>
              )}
            </Button>
            <Button asChild variant="outline" className="w-full">
              <Link href="/dashboard/campaigns/repurpose">View omnipresence queue</Link>
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Snippet detail sheet — getSnippetDetail resolves the clip and the
          source it was cut from, gated to the caller's brokerage. */}
      <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Snippet details</SheetTitle>
            <SheetDescription>The clip, its caption, and the video it came from.</SheetDescription>
          </SheetHeader>

          <div className="space-y-4 mt-6">
            {detailLoading && (
              <p className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </p>
            )}

            {detailError && !detailLoading && (
              <p className="text-sm text-destructive">{detailError}</p>
            )}

            {detail && !detailLoading && (
              <>
                <div>
                  <p className="font-medium">{detail.snippetTitle}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {detail.startSeconds}s – {detail.endSeconds}s ·{" "}
                    {detail.endSeconds - detail.startSeconds}s ·{" "}
                    {detail.platformTarget.replace(/_/g, " ")}
                    {detail.aspectRatio ? ` · ${detail.aspectRatio}` : ""}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <Badge variant={(STATUS_BADGE[detail.approvalStatus] ?? STATUS_BADGE.pending_review).variant}>
                    {(STATUS_BADGE[detail.approvalStatus] ?? STATUS_BADGE.pending_review).label}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    created {new Date(detail.createdAt).toLocaleString()}
                  </span>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">Caption</Label>
                  <p className="text-sm whitespace-pre-wrap rounded-lg border p-3 bg-muted/30">
                    {detail.captionText || <span className="text-muted-foreground">No caption yet.</span>}
                  </p>
                </div>

                {detail.hashtags.length > 0 && (
                  <div className="space-y-1">
                    <Label className="text-xs">Hashtags</Label>
                    <p className="text-sm text-muted-foreground">
                      {detail.hashtags.map(h => `#${h}`).join(" ")}
                    </p>
                  </div>
                )}

                <div className="space-y-1">
                  <Label className="text-xs">Source</Label>
                  {detail.sourceTitle ? (
                    <div className="rounded-lg border p-3 bg-muted/30 space-y-1">
                      <p className="text-sm font-medium">{detail.sourceTitle}</p>
                      {detail.sourceStatus && (
                        <p className="text-xs text-muted-foreground">status: {detail.sourceStatus}</p>
                      )}
                      {detail.sourceVideoUrl && (
                        <a
                          href={detail.sourceVideoUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs underline text-muted-foreground hover:text-foreground"
                        >
                          Open source video
                        </a>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Standalone clip — no video project or asset behind it.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
