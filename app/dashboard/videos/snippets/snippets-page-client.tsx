"use client"

import { useState, useTransition } from "react"
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
} from "lucide-react"
import { createVideoSnippet, type VideoSnippet, type PlatformTarget } from "@/app/actions/video-repurposing"

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
  pending:  { label: "Pending",  variant: "secondary" },
  approved: { label: "Approved", variant: "default" },
  rejected: { label: "Rejected", variant: "destructive" },
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
                    const statusMeta = STATUS_BADGE[s.approval_status] ?? STATUS_BADGE.pending
                    return (
                      <div key={s.id} className="flex items-center justify-between py-4">
                        <div>
                          <p className="font-medium text-sm">{s.snippet_title}</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                            <Clock className="h-3 w-3" />
                            {s.end_seconds - s.start_seconds}s &middot; {s.platform_target.replace(/_/g, " ")}
                          </p>
                        </div>
                        <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
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
    </>
  )
}
