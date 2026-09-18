"use client"

/**
 * THE VIDEO STUDIO — the surface for the six kernel video commands.
 *
 * Script generation, generation settings, render submission, state polling,
 * preview and repurposing existed as server actions with no caller and as API
 * routes nothing fetched. This panel is where an agent building a video project
 * actually reaches for them: it opens on a project row from the pipeline board
 * and drives the whole lane through app/actions/video.ts.
 *
 * EVERY call reports the SERVER's verdict. There is no optimistic success path
 * anywhere in this file — a refusal is rendered as a refusal, and a refused
 * render job says so instead of showing a spinner that never resolves.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Play,
  RefreshCw,
  Scissors,
  Send,
  Sparkles,
  Sliders,
} from "lucide-react"
import { useAuth } from "@/lib/auth/client"
import { createClient } from "@/lib/supabase/client"
import {
  generateVideoScriptAction,
  updateVideoGenerationSettingsAction,
  submitVideoGenerationJobAction,
  loadVideoGenerationStateAction,
  previewVideoProjectAction,
  repurposeVideoOutputAction,
} from "@/app/actions/video"

// The kernel's own vocabularies. Declared here rather than imported so this
// client bundle never reaches into a server-only module.
const CONTENT_STRATEGIES = ["luxury_showcase", "walkthrough", "testimonial", "market_update"] as const
const TONES = ["professional", "friendly", "energetic"] as const
const DURATIONS = [30, 60, 90] as const
const AVATAR_STYLES = ["professional", "casual", "luxury"] as const
const REPURPOSE_FORMATS = ["shorts", "clips", "thumbnail", "description"] as const

type ContentStrategy = (typeof CONTENT_STRATEGIES)[number]
type Tone = (typeof TONES)[number]
type Duration = (typeof DURATIONS)[number]
type AvatarStyle = (typeof AVATAR_STYLES)[number]
type RepurposeFormat = (typeof REPURPOSE_FORMATS)[number]

/** What the server said. Never synthesised on the client. */
type Verdict = { ok: boolean; message: string } | null

interface StudioProject {
  id: string
  title?: string | null
  status?: string | null
  script_content?: string | null
}

interface VoiceChoice {
  id: string
  name: string
}

interface AvatarChoice {
  id: string
  label: string
}

export function VideoStudioDialog({
  open,
  onOpenChange,
  project,
  onProjectChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project: StudioProject | null
  onProjectChanged?: () => void
}) {
  const { user } = useAuth()
  const supabase = createClient()

  // ─── Generation state (loadVideoGenerationStateAction) ────────────────────
  const [state, setState] = useState<{
    status: string
    scriptText?: string
    providerStatus?: string
    videoUrl?: string
    settings?: Record<string, unknown>
    updatedAt: string
  } | null>(null)
  const [stateVerdict, setStateVerdict] = useState<Verdict>(null)
  const [loadingState, setLoadingState] = useState(false)

  // ─── Script (generateVideoScriptAction) ───────────────────────────────────
  const [strategy, setStrategy] = useState<ContentStrategy>("walkthrough")
  const [tone, setTone] = useState<Tone>("professional")
  const [duration, setDuration] = useState<Duration>(60)
  const [scriptText, setScriptText] = useState("")
  const [scriptMeta, setScriptMeta] = useState<{ wordCount: number; scenes: number; confidence: number } | null>(null)
  const [scriptVerdict, setScriptVerdict] = useState<Verdict>(null)
  const [generatingScript, setGeneratingScript] = useState(false)

  // ─── Settings (updateVideoGenerationSettingsAction) ───────────────────────
  const [voiceId, setVoiceId] = useState("")
  const [avatarStyle, setAvatarStyle] = useState<AvatarStyle>("professional")
  const [musicTrack, setMusicTrack] = useState("")
  const [subtitles, setSubtitles] = useState(true)
  const [watermark, setWatermark] = useState(true)
  const [settingsVerdict, setSettingsVerdict] = useState<Verdict>(null)
  const [savingSettings, setSavingSettings] = useState(false)

  // ─── Submit (submitVideoGenerationJobAction) ──────────────────────────────
  const [avatarId, setAvatarId] = useState("")
  const [submitVerdict, setSubmitVerdict] = useState<Verdict>(null)
  const [submitting, setSubmitting] = useState(false)
  const [job, setJob] = useState<{ jobId: string; status: string; etaMinutes: number } | null>(null)

  // ─── Preview (previewVideoProjectAction) ──────────────────────────────────
  const [preview, setPreview] = useState<{ streamUrl: string; duration: number; thumbnail?: string } | null>(null)
  const [previewVerdict, setPreviewVerdict] = useState<Verdict>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)

  // ─── Repurpose (repurposeVideoOutputAction) ───────────────────────────────
  const [formats, setFormats] = useState<RepurposeFormat[]>(["shorts"])
  const [artifacts, setArtifacts] = useState<Array<{ format: string; url: string }>>([])
  const [repurposeVerdict, setRepurposeVerdict] = useState<Verdict>(null)
  const [repurposing, setRepurposing] = useState(false)

  // ─── Choices for the settings / submit forms ──────────────────────────────
  const [voices, setVoices] = useState<VoiceChoice[]>([])
  const [avatars, setAvatars] = useState<AvatarChoice[]>([])
  const [choicesNote, setChoicesNote] = useState<string | null>(null)

  const projectId = project?.id ?? null

  // ── 4. LOAD GENERATION STATE ───────────────────────────────────────────────
  const refreshState = useCallback(async () => {
    if (!projectId) return
    setLoadingState(true)
    const result = await loadVideoGenerationStateAction({ projectId })
    setLoadingState(false)
    if (!result.success) {
      setState(null)
      setStateVerdict({ ok: false, message: result.error })
      return
    }
    setStateVerdict(null)
    setState({
      status: result.data.status,
      scriptText: result.data.scriptText,
      providerStatus: result.data.providerStatus,
      videoUrl: result.data.videoUrl,
      settings: result.data.settings,
      updatedAt: result.data.updatedAt,
    })
    if (result.data.scriptText) setScriptText((current) => current || result.data!.scriptText!)
    const s = result.data.settings as Record<string, unknown> | undefined
    if (s) {
      if (typeof s.voice_profile_id === "string") setVoiceId((v) => v || (s.voice_profile_id as string))
      if (typeof s.avatar_style === "string" && (AVATAR_STYLES as readonly string[]).includes(s.avatar_style)) {
        setAvatarStyle(s.avatar_style as AvatarStyle)
      }
      if (typeof s.music_track === "string") setMusicTrack((m) => m || (s.music_track as string))
      if (typeof s.subtitles === "boolean") setSubtitles(s.subtitles)
      if (typeof s.watermark === "boolean") setWatermark(s.watermark)
    }
  }, [projectId])

  useEffect(() => {
    if (!open || !projectId) return
    setJob(null)
    setSubmitVerdict(null)
    setPreview(null)
    setPreviewVerdict(null)
    setArtifacts([])
    setRepurposeVerdict(null)
    void refreshState()
  }, [open, projectId, refreshState])

  // Poll while the render is in flight. The server's state is the only source —
  // this never assumes progress it has not been told about.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    if (!open || !projectId) return
    const inFlight =
      state?.status === "generating" ||
      ["submitting", "queued", "processing", "generating"].includes(state?.providerStatus ?? "")
    if (!inFlight) return
    pollRef.current = setInterval(() => {
      void refreshState()
    }, 8000)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [open, projectId, state?.status, state?.providerStatus, refreshState])

  // ── Voice + avatar choices, so submit sends real provider ids ─────────────
  useEffect(() => {
    if (!open || !user?.id) return
    let cancelled = false

    async function loadChoices() {
      const { data: agent, error: agentError } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", user!.id)
        .maybeSingle()
      if (cancelled) return
      if (agentError) {
        setChoicesNote(`Could not load your voices and avatars: ${agentError.message}`)
        return
      }
      if (!agent?.id) {
        setChoicesNote("Your user is not linked to an agent record, so no voice or avatar can be selected.")
        return
      }

      const { data: profiles, error: voiceError } = await supabase
        .from("agent_voice_profiles")
        .select("profile_name, elevenlabs_voice_id, is_default")
        .eq("agent_id", agent.id)
        .eq("training_status", "ready")
        .not("elevenlabs_voice_id", "is", null)
        .order("is_default", { ascending: false })
      if (cancelled) return
      if (voiceError) setChoicesNote(`Could not load voices: ${voiceError.message}`)
      const voiceChoices = (profiles ?? [])
        .filter((p: any) => p.elevenlabs_voice_id)
        .map((p: any) => ({ id: p.elevenlabs_voice_id as string, name: p.profile_name as string }))
      setVoices(voiceChoices)
      if (voiceChoices[0]) setVoiceId((v) => v || voiceChoices[0].id)

      const { data: assets, error: avatarError } = await supabase
        .from("agent_avatar_assets")
        .select("label, did_avatar_id, status, is_default")
        .eq("agent_id", agent.id)
        .eq("status", "ready")
        .order("is_default", { ascending: false })
      if (cancelled) return
      if (avatarError) setChoicesNote(`Could not load avatars: ${avatarError.message}`)
      const avatarChoices = (assets ?? [])
        .filter((a: any) => a.did_avatar_id)
        .map((a: any) => ({ id: a.did_avatar_id as string, label: (a.label as string) ?? "Avatar" }))
      setAvatars(avatarChoices)
      if (avatarChoices[0]) setAvatarId((a) => a || avatarChoices[0].id)
    }

    void loadChoices()
    return () => {
      cancelled = true
    }
  }, [open, user?.id, supabase])

  // ── 1. GENERATE SCRIPT ─────────────────────────────────────────────────────
  async function handleGenerateScript() {
    if (!projectId) return
    setGeneratingScript(true)
    setScriptVerdict(null)
    const result = await generateVideoScriptAction({
      projectId,
      contentStrategy: strategy,
      tone,
      duration,
    })
    setGeneratingScript(false)
    if (!result.success) {
      setScriptVerdict({ ok: false, message: result.error })
      return
    }
    setScriptText(result.data.scriptText)
    setScriptMeta({
      wordCount: result.data.wordCount,
      scenes: result.data.scenes.length,
      confidence: result.data.aiConfidence,
    })
    setScriptVerdict({ ok: true, message: "Script written to the project." })
    await refreshState()
    onProjectChanged?.()
  }

  // ── 2. SAVE SETTINGS ───────────────────────────────────────────────────────
  async function handleSaveSettings() {
    if (!projectId) return
    setSavingSettings(true)
    setSettingsVerdict(null)
    const result = await updateVideoGenerationSettingsAction({
      projectId,
      voiceProfileId: voiceId,
      avatarStyle,
      musicTrack: musicTrack || undefined,
      subtitles,
      watermark,
    })
    setSavingSettings(false)
    if (!result.success) {
      setSettingsVerdict({ ok: false, message: result.error })
      return
    }
    setSettingsVerdict({ ok: true, message: `Settings applied ${new Date(result.data.updatedAt).toLocaleTimeString()}.` })
    await refreshState()
  }

  // ── 3. SUBMIT THE RENDER ───────────────────────────────────────────────────
  async function handleSubmitJob() {
    if (!projectId) return
    setSubmitting(true)
    setSubmitVerdict(null)
    setJob(null)
    const words = scriptText.split(/\s+/).filter(Boolean).length
    const result = await submitVideoGenerationJobAction({
      projectId,
      scriptText,
      voiceProfileId: voiceId,
      avatarStyle,
      avatarId,
      estimatedDurationSeconds: Math.max(15, Math.ceil(words / 2.5)),
    })
    setSubmitting(false)
    if (!result.success) {
      // A refused job is a refusal, not a pending render. Nothing here pretends
      // the project started generating.
      setSubmitVerdict({ ok: false, message: result.error })
      await refreshState()
      return
    }
    setJob({
      jobId: result.data.jobId,
      status: result.data.status,
      etaMinutes: result.data.estimatedCompletionMinutes,
    })
    setSubmitVerdict({ ok: true, message: `Render accepted by the provider (job ${result.data.jobId}).` })
    await refreshState()
    onProjectChanged?.()
  }

  // ── 5. PREVIEW ─────────────────────────────────────────────────────────────
  async function handlePreview() {
    if (!projectId) return
    setLoadingPreview(true)
    setPreviewVerdict(null)
    const result = await previewVideoProjectAction({ projectId })
    setLoadingPreview(false)
    if (!result.success) {
      setPreview(null)
      setPreviewVerdict({ ok: false, message: result.error })
      return
    }
    setPreview({
      streamUrl: result.data.streamUrl,
      duration: result.data.duration,
      thumbnail: result.data.thumbnail,
    })
  }

  // ── 6. REPURPOSE ───────────────────────────────────────────────────────────
  async function handleRepurpose() {
    if (!projectId) return
    setRepurposing(true)
    setRepurposeVerdict(null)
    const result = await repurposeVideoOutputAction({ projectId, formats })
    setRepurposing(false)
    if (!result.success) {
      setArtifacts([])
      setRepurposeVerdict({ ok: false, message: result.error })
      return
    }
    setArtifacts(result.data.artifacts.map((a) => ({ format: a.format, url: a.url })))
    setRepurposeVerdict({ ok: true, message: `${result.data.artifacts.length} artifact(s) produced.` })
  }

  function toggleFormat(f: RepurposeFormat) {
    setFormats((prev) => (prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]))
  }

  const gateRefused = stateVerdict !== null && !stateVerdict.ok

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Video Studio</DialogTitle>
          <DialogDescription>
            {project?.title || "Video project"} — script, settings, render, preview and repurposing,
            all through the video kernel.
          </DialogDescription>
        </DialogHeader>

        {/* The server's verdict on whether this project is even ours. */}
        {gateRefused && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>This project is not available</AlertTitle>
            <AlertDescription>{stateVerdict?.message}</AlertDescription>
          </Alert>
        )}

        {choicesNote && (
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{choicesNote}</AlertDescription>
          </Alert>
        )}

        {/* Live state */}
        <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
          <span className="font-medium">Status</span>
          <Badge variant="outline">{state?.status ?? "—"}</Badge>
          {state?.providerStatus && <Badge variant="secondary">provider: {state.providerStatus}</Badge>}
          {state?.videoUrl && <Badge className="bg-green-600">rendered</Badge>}
          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            {state?.updatedAt && `updated ${new Date(state.updatedAt).toLocaleTimeString()}`}
            <Button variant="ghost" size="sm" onClick={() => void refreshState()} disabled={loadingState}>
              <RefreshCw className={loadingState ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
            </Button>
          </span>
        </div>

        <Tabs defaultValue="script">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="script">Script</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="render">Render</TabsTrigger>
            <TabsTrigger value="output">Output</TabsTrigger>
          </TabsList>

          {/* ── SCRIPT ─────────────────────────────────────────────────────── */}
          <TabsContent value="script" className="space-y-3 pt-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Strategy</Label>
                <Select value={strategy} onValueChange={(v) => setStrategy(v as ContentStrategy)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CONTENT_STRATEGIES.map((s) => (
                      <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Tone</Label>
                <Select value={tone} onValueChange={(v) => setTone(v as Tone)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TONES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Length</Label>
                <Select value={String(duration)} onValueChange={(v) => setDuration(Number(v) as Duration)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DURATIONS.map((d) => <SelectItem key={d} value={String(d)}>{d}s</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button onClick={handleGenerateScript} disabled={generatingScript || gateRefused}>
              {generatingScript ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
              Generate script
            </Button>

            <VerdictLine verdict={scriptVerdict} />

            {scriptMeta && (
              <p className="text-xs text-muted-foreground">
                {scriptMeta.wordCount} words · {scriptMeta.scenes} scenes · confidence {Math.round(scriptMeta.confidence * 100)}%
              </p>
            )}

            <Textarea
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
              placeholder="Generate a script, or paste one to render."
              className="min-h-[180px] font-mono text-xs"
            />
          </TabsContent>

          {/* ── SETTINGS ───────────────────────────────────────────────────── */}
          <TabsContent value="settings" className="space-y-3 pt-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Voice</Label>
                <Select value={voiceId} onValueChange={setVoiceId}>
                  <SelectTrigger><SelectValue placeholder={voices.length ? "Select a voice" : "No ready voice clone"} /></SelectTrigger>
                  <SelectContent>
                    {voices.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Avatar style</Label>
                <Select value={avatarStyle} onValueChange={(v) => setAvatarStyle(v as AvatarStyle)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {AVATAR_STYLES.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Music track (optional)</Label>
              <Input value={musicTrack} onChange={(e) => setMusicTrack(e.target.value)} placeholder="Track name or url" />
            </div>

            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={subtitles} onCheckedChange={setSubtitles} />
                Subtitles
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={watermark} onCheckedChange={setWatermark} />
                Watermark
              </label>
            </div>

            <Button onClick={handleSaveSettings} disabled={savingSettings || gateRefused}>
              {savingSettings ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sliders className="mr-2 h-4 w-4" />}
              Save generation settings
            </Button>
            <VerdictLine verdict={settingsVerdict} />
          </TabsContent>

          {/* ── RENDER ─────────────────────────────────────────────────────── */}
          <TabsContent value="render" className="space-y-3 pt-3">
            <div className="space-y-1">
              <Label className="text-xs">Avatar</Label>
              <Select value={avatarId} onValueChange={setAvatarId}>
                <SelectTrigger><SelectValue placeholder={avatars.length ? "Select an avatar" : "No ready avatar"} /></SelectTrigger>
                <SelectContent>
                  {avatars.map((a) => <SelectItem key={a.id} value={a.id}>{a.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <Button
              onClick={handleSubmitJob}
              disabled={submitting || gateRefused || !scriptText.trim() || !avatarId || !voiceId}
            >
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              Submit render job
            </Button>

            {/* A REFUSED JOB SAYS SO. */}
            {submitVerdict && !submitVerdict.ok && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Generation refused — nothing was submitted</AlertTitle>
                <AlertDescription>{submitVerdict.message}</AlertDescription>
              </Alert>
            )}
            {submitVerdict?.ok && job && (
              <Alert>
                <CheckCircle2 className="h-4 w-4" />
                <AlertTitle>Queued with the provider</AlertTitle>
                <AlertDescription>
                  Job {job.jobId} · {job.status} · about {job.etaMinutes} minute(s). This panel polls the
                  server for the real status.
                </AlertDescription>
              </Alert>
            )}
          </TabsContent>

          {/* ── OUTPUT: preview + repurpose ────────────────────────────────── */}
          <TabsContent value="output" className="space-y-4 pt-3">
            <div className="space-y-2">
              <Button variant="outline" onClick={handlePreview} disabled={loadingPreview || gateRefused}>
                {loadingPreview ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                Load preview
              </Button>
              <VerdictLine verdict={previewVerdict} />
              {preview && (
                <div className="space-y-1">
                  <div className="aspect-video overflow-hidden rounded-lg bg-black">
                    <video src={preview.streamUrl} controls poster={preview.thumbnail} className="h-full w-full" />
                  </div>
                  <p className="text-xs text-muted-foreground">{preview.duration}s</p>
                </div>
              )}
            </div>

            <div className="space-y-2 border-t pt-4">
              <Label className="text-xs">Repurpose into</Label>
              <div className="flex flex-wrap gap-2">
                {REPURPOSE_FORMATS.map((f) => (
                  <Button
                    key={f}
                    type="button"
                    size="sm"
                    variant={formats.includes(f) ? "default" : "outline"}
                    onClick={() => toggleFormat(f)}
                  >
                    {f}
                  </Button>
                ))}
              </div>
              <Button
                variant="outline"
                onClick={handleRepurpose}
                disabled={repurposing || gateRefused || formats.length === 0}
              >
                {repurposing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Scissors className="mr-2 h-4 w-4" />}
                Repurpose
              </Button>
              <VerdictLine verdict={repurposeVerdict} />
              {artifacts.length > 0 && (
                <ul className="space-y-1 text-sm">
                  {artifacts.map((a) => (
                    <li key={`${a.format}-${a.url}`}>
                      <a href={a.url} target="_blank" rel="noopener noreferrer" className="underline">
                        {a.format}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Renders exactly what the server said — success or refusal, never invented. */
function VerdictLine({ verdict }: { verdict: Verdict }) {
  if (!verdict) return null
  return (
    <p className={verdict.ok ? "flex items-center gap-2 text-sm text-green-600" : "flex items-center gap-2 text-sm text-destructive"}>
      {verdict.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
      {verdict.message}
    </p>
  )
}

export default VideoStudioDialog
