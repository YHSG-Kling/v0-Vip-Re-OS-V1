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
import {
  getVideoProjectSnippetSource,
  type VideoProjectSnippetSource,
} from "@/app/actions/video/create-video-project"
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
type SourceType = "video_project" | "podcast_episode" | "external_url"

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
  const [externalUrl, setExternalUrl] = useState<string>("")
  const [externalScript, setExternalScript] = useState<string>("")
  const [videoProjects, setVideoProjects] = useState<{ id: string; title: string }[]>([])
  const [podcastEpisodes, setPodcastEpisodes] = useState<{ id: string; title: string }[]>([])
  const [sourcesLoading, setSourcesLoading] = useState(true)

  // Step 2 — platforms
  const [platforms, setPlatforms] = useState<PlatformTarget[]>(["instagram_reels", "tiktok"])

  // Step 3 — suggestions
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])

  // Step 4 — schedule
  const [createdSnippetIds, setCreatedSnippetIds] = useState<string[]>([])

  // The selected video project, loaded through the tenant-gated reader so the
  // agent can see its render state — and, crucially, whether it carries a
  // script — BEFORE spending AI inference. generateSnippetSuggestions reads
  // ai_video_projects.script_content and quietly falls back to a generic clip
  // when it is empty; that is now said out loud instead.
  const [projectSource, setProjectSource] = useState<VideoProjectSnippetSource | null>(null)
  const [projectSourceError, setProjectSourceError] = useState<string | null>(null)
  const [projectSourceLoading, setProjectSourceLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (sourceType !== "video_project" || !sourceId) {
      setProjectSource(null)
      setProjectSourceError(null)
      return
    }
    setProjectSourceLoading(true)
    setProjectSourceError(null)
    ;(async () => {
      try {
        const result = await getVideoProjectSnippetSource(sourceId)
        if (cancelled) return
        if (!result.success || !result.source) {
          setProjectSource(null)
          setProjectSourceError(result.error ?? "Could not load that project.")
          return
        }
        setProjectSource(result.source)
      } catch (err: any) {
        if (!cancelled) setProjectSourceError(err?.message ?? "Could not load that project.")
      } finally {
        if (!cancelled) setProjectSourceLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [sourceType, sourceId])

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

  const canAdvanceToStep2 =
    sourceType === "external_url"
      ? externalScript.trim().length > 20
      : sourceId !== ""
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
          sourceVideoAssetId: undefined,
          sourceScript: sourceType === "external_url" ? externalScript : undefined,
          sourceTitle: sourceType === "external_url" ? (externalUrl || "External content") : undefined,
          platforms,
        })
        // generateSnippetSuggestions returns a discriminated result. It used to
        // return a bare ARRAY while this read `result.success` — always
        // undefined — so a successful generation was reported to the agent as
        // "Failed to generate suggestions." every single time and the wizard
        // could never reach step 3.
        if (!result.success) {
          toast.error(result.error ?? "Failed to generate suggestions.")
          return
        }
        const sugg = result.suggestions as Suggestion[]
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
        // Same inverted-verdict bug as above, plus: the count reported was
        // `suggestions.length` (what we ASKED for) rather than what the server
        // actually created, so a batch in which every insert was refused still
        // announced "Created 4 snippets."
        if (!result.success) {
          toast.error(result.error ?? "Failed to create snippets.")
          return
        }
        setCreatedSnippetIds(result.snippetIds)
        const n = result.snippetIds.length
        if (result.failed.length > 0) {
          toast.warning(
            `Created ${n} snippet${n === 1 ? "" : "s"}; ${result.failed.length} refused — ${result.failed[0].error}`
          )
        } else {
          toast.success(`Created ${n} snippet${n === 1 ? "" : "s"}.`)
        }
        setStep(4)
      } catch (err: any) {
        toast.error(err?.message ?? "Failed to create snippets.")
      }
    })
  }

  function reset() {
    setStep(1)
    setSourceId("")
    setExternalUrl("")
    setExternalScript("")
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
              <Select value={sourceType} onValueChange={(v) => { setSourceType(v as SourceType); setSourceId(""); setExternalUrl(""); setExternalScript("") }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="video_project">Video project</SelectItem>
                  <SelectItem value="podcast_episode">Podcast episode</SelectItem>
                  <SelectItem value="external_url">External URL</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {sourceType === "external_url" && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label>Content URL <span className="text-muted-foreground text-xs">(optional — for your reference)</span></Label>
                  <Input
                    placeholder="https://example.com/video-or-article"
                    value={externalUrl}
                    onChange={(e) => setExternalUrl(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Paste transcript or script <span className="text-xs text-muted-foreground">*required</span></Label>
                  <Textarea
                    placeholder="Paste the transcript or script text from the external content here. The AI will generate snippet suggestions from this text."
                    value={externalScript}
                    onChange={(e) => setExternalScript(e.target.value)}
                    rows={6}
                  />
                  <p className="text-xs text-muted-foreground">Minimum 20 characters required to generate suggestions.</p>
                </div>
              </div>
            )}

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

            {/* Selected project — render state + whether it has a script */}
            {sourceType === "video_project" && sourceId && (
              <div className="rounded-lg border p-3 space-y-1.5">
                {projectSourceLoading && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Checking that project…
                  </p>
                )}
                {projectSourceError && !projectSourceLoading && (
                  <p className="text-xs text-destructive">{projectSourceError}</p>
                )}
                {projectSource && !projectSourceLoading && (
                  <>
                    <p className="text-sm font-medium">{projectSource.title}</p>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className="text-[10px]">
                        status: {projectSource.status}
                      </Badge>
                      {projectSource.durationSeconds != null && (
                        <Badge variant="outline" className="text-[10px]">
                          {projectSource.durationSeconds}s
                        </Badge>
                      )}
                      <Badge
                        variant={projectSource.hasScript ? "secondary" : "destructive"}
                        className="text-[10px]"
                      >
                        {projectSource.hasScript ? "has script" : "no script"}
                      </Badge>
                    </div>
                    {!projectSource.hasScript && (
                      <p className="text-xs text-muted-foreground">
                        This project has no script, so the AI has nothing to read — suggestions will
                        be generic. Add a script to the project for clip picks that match the content.
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

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
