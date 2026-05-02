"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Loader2, Scissors, Wand2, Calendar, ChevronRight, ChevronLeft } from "lucide-react"
import { toast } from "sonner"
import {
  generateSnippetSuggestions,
  batchCreateSnippets,
  type PlatformTarget,
} from "@/app/actions/video-repurposing"
import { getVideoProjects, getPodcastEpisodes } from "@/app/actions/podcast-generation"

interface Props {
  brokerageId: string
  userId: string
}

const PLATFORMS: { value: PlatformTarget; label: string }[] = [
  { value: "instagram_reels", label: "Instagram Reels" },
  { value: "instagram_story", label: "Instagram Story" },
  { value: "instagram_post",  label: "Instagram Post" },
  { value: "tiktok",          label: "TikTok" },
  { value: "youtube_shorts",  label: "YouTube Shorts" },
  { value: "facebook_reels",  label: "Facebook Reels" },
  { value: "linkedin",        label: "LinkedIn Video" },
  { value: "twitter",         label: "Twitter / X" },
]

type Step = 1 | 2 | 3 | 4
type SourceType = "video_project" | "podcast_episode"

interface Suggestion {
  title: string
  startSeconds: number
  endSeconds: number
  captionText: string
  hashtags: string[]
  platform: PlatformTarget
}

export function SnippetWizardPanel({ brokerageId, userId }: Props) {
  const router = useRouter()
  const [step, setStep] = useState<Step>(1)
  const [isPending, startTransition] = useTransition()

  // Step 1 — source
  const [sourceType, setSourceType] = useState<SourceType>("video_project")
  const [sourceId, setSourceId] = useState<string>("")
  const [videoProjects, setVideoProjects] = useState<{ id: string; title: string }[]>([])
  const [podcastEpisodes, setPodcastEpisodes] = useState<{ id: string; title: string }[]>([])
  const [sourcesLoading, setSourcesLoading] = useState(true)

  // Step 2 — platforms
  const [platforms, setPlatforms] = useState<PlatformTarget[]>(["instagram_reels", "tiktok"])

  // Step 3 — suggestions
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])

  // Step 4 — schedule
  const [createdSnippetIds, setCreatedSnippetIds] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [vp, ep] = await Promise.all([
          getVideoProjects().catch(() => ({ success: false })),
          getPodcastEpisodes().catch(() => ({ success: false })),
        ])
        if (cancelled) return
        if ((vp as any).success) setVideoProjects(((vp as any).projects ?? []) as any)
        if ((ep as any).success) setPodcastEpisodes(((ep as any).episodes ?? []) as any)
      } finally {
        if (!cancelled) setSourcesLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const sources = sourceType === "video_project" ? videoProjects : podcastEpisodes

  const canAdvanceToStep2 = sourceId !== ""
  const canAdvanceToStep3 = platforms.length > 0
  const canAdvanceToStep4 = suggestions.length > 0

  function togglePlatform(p: PlatformTarget) {
    setPlatforms((curr) =>
      curr.includes(p) ? curr.filter((x) => x !== p) : [...curr, p]
    )
  }

  async function generateSuggestions() {
    startTransition(async () => {
      try {
        const result = await generateSnippetSuggestions({
          brokerageId,
          videoProjectId: sourceType === "video_project" ? sourceId : undefined,
          // Podcast as source is not yet supported by the backend; surface gracefully.
          sourceVideoAssetId: undefined,
          platforms,
        })
        if (!(result as any).success) {
          toast.error((result as any).error ?? "Failed to generate suggestions.")
          return
        }
        const sugg = ((result as any).suggestions ?? []) as Suggestion[]
        if (sugg.length === 0) {
          toast.warning("No suggestions returned. Try a longer source clip.")
          return
        }
        setSuggestions(sugg)
        setStep(3)
      } catch (err: any) {
        toast.error(err?.message ?? "Suggestion generation failed.")
      }
    })
  }

  function updateSuggestion(idx: number, patch: Partial<Suggestion>) {
    setSuggestions((curr) => curr.map((s, i) => (i === idx ? { ...s, ...patch } : s)))
  }

  function removeSuggestion(idx: number) {
    setSuggestions((curr) => curr.filter((_, i) => i !== idx))
  }

  async function createAndQueue() {
    if (suggestions.length === 0) return
    startTransition(async () => {
      try {
        const result = await batchCreateSnippets({
          brokerageId,
          videoProjectId: sourceType === "video_project" ? sourceId : undefined,
          snippets: suggestions.map((s) => ({
            platform: s.platform,
            title: s.title,
            startSeconds: s.startSeconds,
            endSeconds: s.endSeconds,
            captionText: s.captionText,
            hashtags: s.hashtags,
          })),
          createdBy: userId,
        })
        if (!(result as any).success) {
          toast.error((result as any).error ?? "Failed to create snippets.")
          return
        }
        setCreatedSnippetIds(((result as any).snippetIds ?? []) as string[])
        toast.success(`Created ${suggestions.length} snippet${suggestions.length === 1 ? "" : "s"}.`)
        setStep(4)
      } catch (err: any) {
        toast.error(err?.message ?? "Failed to create snippets.")
      }
    })
  }

  function reset() {
    setStep(1)
    setSourceId("")
    setPlatforms(["instagram_reels", "tiktok"])
    setSuggestions([])
    setCreatedSnippetIds([])
  }

  const stepLabel = useMemo(
    () => ({ 1: "Source", 2: "Platforms", 3: "AI Suggestions", 4: "Create & Schedule" }[step]),
    [step]
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wand2 className="h-5 w-5 text-primary" />
          Snippet Wizard
        </CardTitle>
        <CardDescription>
          Step {step} of 4 · {stepLabel}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Step 1 — source */}
        {step === 1 && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Source type</Label>
              <Select value={sourceType} onValueChange={(v) => { setSourceType(v as SourceType); setSourceId("") }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="video_project">Video project</SelectItem>
                  <SelectItem value="podcast_episode">Podcast episode (preview only — backend support coming)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>{sourceType === "video_project" ? "Video project" : "Podcast episode"}</Label>
              {sourcesLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading sources…
                </div>
              ) : sources.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No {sourceType === "video_project" ? "video projects" : "podcast episodes"} found.
                </p>
              ) : (
                <Select value={sourceId} onValueChange={setSourceId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a source…" />
                  </SelectTrigger>
                  <SelectContent>
                    {sources.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="flex justify-end">
              <Button disabled={!canAdvanceToStep2} onClick={() => setStep(2)}>
                Next <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 2 — platforms */}
        {step === 2 && (
          <div className="space-y-4">
            <Label>Target platforms</Label>
            <div className="grid grid-cols-2 gap-2">
              {PLATFORMS.map((p) => (
                <label
                  key={p.value}
                  className="flex items-center gap-2 rounded-lg border p-3 cursor-pointer hover:bg-muted/30"
                >
                  <Checkbox
                    checked={platforms.includes(p.value)}
                    onCheckedChange={() => togglePlatform(p.value)}
                  />
                  <span className="text-sm">{p.label}</span>
                </label>
              ))}
            </div>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(1)}>
                <ChevronLeft className="h-4 w-4 mr-1" /> Back
              </Button>
              <Button disabled={!canAdvanceToStep3 || isPending} onClick={generateSuggestions}>
                {isPending ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Generating…</>
                ) : (
                  <>Generate suggestions <ChevronRight className="h-4 w-4 ml-1" /></>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Step 3 — suggestions */}
        {step === 3 && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Edit, remove, or accept these clips. Each one becomes a snippet on the next step.
            </p>
            <div className="space-y-3">
              {suggestions.map((s, idx) => (
                <div key={idx} className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <Input
                      value={s.title}
                      onChange={(e) => updateSuggestion(idx, { title: e.target.value })}
                      className="flex-1 h-8"
                    />
                    <Badge variant="outline" className="text-xs shrink-0">
                      {s.platform.replace(/_/g, " ")}
                    </Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => removeSuggestion(idx)}
                    >
                      Remove
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <Label className="text-xs">Start (s)</Label>
                      <Input
                        type="number"
                        value={s.startSeconds}
                        onChange={(e) => updateSuggestion(idx, { startSeconds: Number(e.target.value) })}
                        className="h-8"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">End (s)</Label>
                      <Input
                        type="number"
                        value={s.endSeconds}
                        onChange={(e) => updateSuggestion(idx, { endSeconds: Number(e.target.value) })}
                        className="h-8"
                      />
                    </div>
                  </div>
                  <Textarea
                    value={s.captionText}
                    onChange={(e) => updateSuggestion(idx, { captionText: e.target.value })}
                    rows={2}
                    placeholder="Caption…"
                  />
                </div>
              ))}
            </div>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep(2)}>
                <ChevronLeft className="h-4 w-4 mr-1" /> Back
              </Button>
              <Button disabled={!canAdvanceToStep4 || isPending} onClick={createAndQueue}>
                {isPending ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating…</>
                ) : (
                  <><Scissors className="h-4 w-4 mr-2" /> Create snippets</>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Step 4 — schedule */}
        {step === 4 && (
          <div className="space-y-4 text-center py-6">
            <Scissors className="h-8 w-8 text-primary mx-auto" />
            <div>
              <h3 className="text-lg font-semibold">
                {createdSnippetIds.length} snippet{createdSnippetIds.length === 1 ? "" : "s"} created
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                Snippets are pending review. Approve and schedule them on the Snippets page.
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2 justify-center">
              <Button onClick={() => router.push("/dashboard/videos/snippets")}>
                <Calendar className="h-4 w-4 mr-2" /> Open Snippets
              </Button>
              <Button variant="outline" onClick={reset}>
                Create more
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
