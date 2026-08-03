"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Mic,
  Camera,
  Video,
  CheckCircle2,
  ArrowRight,
  Loader2,
  LayoutGrid,
  Shield,
  Star,
  AlertTriangle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { VoiceRecorder } from "@/app/dashboard/settings/twin-studio/components/voice-recorder"
import { uploadTwinVoiceSample } from "@/app/actions/twin-studio-upload"
import {
  createVoiceProfile,
  updateVoiceProfileSamples,
  startVoiceCloneTraining,
  setDefaultVoiceProfile,
  getVoiceProfiles,
} from "@/app/actions/video-voice"
import { VOICE_CLONE_SAMPLE_PHRASES } from "@/app/actions/video-voice.constants"
import type { SamplePhrase, SampleManifest } from "@/app/actions/video-voice.types"

// ─── PROPS ───────────────────────────────────────────────────────────────────

interface VoiceCloneClientProps {
  agentId: string
  brokerageId: string
  userId: string
  initialProfiles: any[]
  videoConfigured: boolean
}

// ─── STEP INDICATOR ──────────────────────────────────────────────────────────

type WizardStep = "intro" | "voice" | "avatar" | "done"

const STEPS: { id: WizardStep; label: string }[] = [
  { id: "intro", label: "Welcome" },
  { id: "voice", label: "Record Voice" },
  { id: "avatar", label: "Upload Avatar" },
  { id: "done", label: "Done" },
]

function StepIndicator({ current }: { current: WizardStep }) {
  const currentIndex = STEPS.findIndex((s) => s.id === current)
  return (
    <div className="flex items-center mb-8">
      {STEPS.map((step, i) => (
        <div key={step.id} className="flex items-center">
          <div className={cn(
            "flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium border-2 transition-colors",
            i < currentIndex ? "bg-primary border-primary text-primary-foreground" :
            i === currentIndex ? "border-primary text-primary" :
            "border-muted text-muted-foreground"
          )}>
            {i < currentIndex ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
          </div>
          <span className={cn(
            "ml-2 text-sm hidden sm:block",
            i === currentIndex ? "font-medium" : "text-muted-foreground"
          )}>
            {step.label}
          </span>
          {i < STEPS.length - 1 && (
            <div className={cn(
              "w-8 h-0.5 mx-3",
              i < currentIndex ? "bg-primary" : "bg-muted"
            )} />
          )}
        </div>
      ))}
    </div>
  )
}

// ─── PROFILE STATUS ──────────────────────────────────────────────────────────

const PROFILE_STATUS_COPY: Record<string, { label: string; tone: "ready" | "busy" | "idle" | "bad" }> = {
  not_started:       { label: "Not started",        tone: "idle" },
  collecting_samples:{ label: "Recording in progress", tone: "busy" },
  training:          { label: "Cloning…",           tone: "busy" },
  ready:             { label: "Ready",              tone: "ready" },
  failed:            { label: "Failed",             tone: "bad" },
}

/** The recorded phrases of an in-flight capture, read back off the draft job.
 *  Keyed off the DRAFT, not off the profile's status: a re-record deliberately
 *  leaves the profile at 'ready' so the agent's existing voice keeps working
 *  until the replacement lands. */
function resumePhrases(profile: any): SamplePhrase[] | null {
  const jobs: any[] = Array.isArray(profile?.voice_clone_training)
    ? profile.voice_clone_training
    : profile?.voice_clone_training
      ? [profile.voice_clone_training]
      : []
  const draft = jobs.find((j) => j?.status === "queued")
  const phrases: SamplePhrase[] | undefined = draft?.sample_manifest?.phrases
  if (!Array.isArray(phrases)) return null
  const recorded = phrases.filter((p) => p?.status === "recorded" || p?.status === "validated")
  return recorded.length > 0 ? phrases : null
}

/** The most recent finished job, for reporting why a clone failed. */
function lastJobError(profile: any): string | null {
  const jobs: any[] = Array.isArray(profile?.voice_clone_training) ? profile.voice_clone_training : []
  const failed = jobs.filter((j) => j?.status === "failed" && j?.error_message)
  if (failed.length === 0) return null
  return failed.sort((a, b) => String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? "")))[0].error_message
}

function freshPhrases(): SamplePhrase[] {
  return VOICE_CLONE_SAMPLE_PHRASES.map((p) => ({
    phrase_id: p.phrase_id,
    phrase_text: p.phrase_text,
    status: "pending" as const,
  }))
}

/** Browser Blob → base64 for the server-action upload (no extra HTTP hop). */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────

export function VoiceCloneClient({
  agentId,
  brokerageId,
  userId,
  initialProfiles,
  videoConfigured,
}: VoiceCloneClientProps) {
  const router = useRouter()
  const [step, setStep] = useState<WizardStep>("intro")

  // Voice profiles — the agent's real library, not a write-only wizard.
  const [profiles, setProfiles] = useState<any[]>(initialProfiles ?? [])

  // Guided capture state
  const resumable = useMemo(() => (profiles ?? []).find((p) => resumePhrases(p)), [profiles])
  const [captureProfileId, setCaptureProfileId] = useState<string | null>(null)
  const [phrases, setPhrases] = useState<SamplePhrase[]>(freshPhrases())
  const [busyPhrase, setBusyPhrase] = useState(false)
  const [isCloning, setIsCloning] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "success" | "error">("idle")
  const [voiceMessage, setVoiceMessage] = useState<string | null>(null)
  const [voiceDone, setVoiceDone] = useState(false)

  const recordedCount = phrases.filter((p) => p.status === "recorded" || p.status === "validated").length
  const activePhraseIndex = phrases.findIndex((p) => p.status === "pending" || p.status === "rejected")
  const activePhrase = activePhraseIndex >= 0 ? phrases[activePhraseIndex] : null
  const allRecorded = recordedCount >= VOICE_CLONE_SAMPLE_PHRASES.length

  // Avatar upload state
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarType, setAvatarType] = useState<"photo" | "video">("photo")
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false)
  const [avatarStatus, setAvatarStatus] = useState<"idle" | "success" | "error">("idle")
  const [avatarMessage, setAvatarMessage] = useState<string | null>(null)
  const [avatarDone, setAvatarDone] = useState(false)

  async function refreshProfiles() {
    try {
      setProfiles(await getVoiceProfiles(agentId))
    } catch (err) {
      console.error("[voice-client] Could not refresh voice profiles:", err)
    }
  }

  // ─── Guided capture ────────────────────────────────────────────────────────

  /** Ensure there is a profile row to attach samples to, and return its id. */
  async function ensureCaptureProfile(): Promise<string> {
    if (captureProfileId) return captureProfileId

    if (resumable) {
      setCaptureProfileId(resumable.id)
      setPhrases(resumePhrases(resumable) ?? freshPhrases())
      return resumable.id
    }

    const profile = await createVoiceProfile({
      brokerageId,
      agentId,
      profileName: `My Voice — ${new Date().toLocaleDateString()}`,
      actorUserId: userId,
    })
    setCaptureProfileId(profile.id)
    await refreshProfiles()
    return profile.id
  }

  function resumeCapture(profile: any) {
    setCaptureProfileId(profile.id)
    setPhrases(resumePhrases(profile) ?? freshPhrases())
    setVoiceStatus("idle")
    setVoiceMessage(null)
    setStep("voice")
  }

  /** One recorded phrase → storage → persisted manifest. Resumable from here. */
  async function handlePhraseRecorded(blob: Blob, mimeType: string) {
    if (!activePhrase) return
    setBusyPhrase(true)
    setVoiceStatus("idle")
    setVoiceMessage(null)

    try {
      const profileId = await ensureCaptureProfile()

      const base64 = await blobToBase64(blob)
      const upload = await uploadTwinVoiceSample({ base64, mimeType })
      if (!upload.ok || !upload.url) {
        throw new Error(upload.error ?? "Could not save that recording — please try again.")
      }

      const next: SamplePhrase[] = phrases.map((p) =>
        p.phrase_id === activePhrase.phrase_id
          ? { ...p, audio_url: upload.url, recorded_at: new Date().toISOString(), status: "recorded" as const }
          : p,
      )

      // Persist before advancing: the phrase is only really captured once the
      // manifest holding its url is written.
      await updateVoiceProfileSamples(profileId, brokerageId, { phrases: next }, userId)
      setPhrases(next)
      await refreshProfiles()
    } catch (err: any) {
      setVoiceStatus("error")
      setVoiceMessage(err?.message ?? "Could not save that recording.")
    } finally {
      setBusyPhrase(false)
    }
  }

  function rerecordPhrase(phraseId: string) {
    setPhrases((prev) =>
      prev.map((p) => (p.phrase_id === phraseId ? { ...p, status: "pending", audio_url: undefined } : p)),
    )
  }

  /** All phrases captured → open the training job → clone at ElevenLabs. */
  async function handleCreateClone() {
    if (!captureProfileId || !allRecorded) return
    setIsCloning(true)
    setVoiceStatus("idle")
    setVoiceMessage(null)

    try {
      const manifest: SampleManifest = { phrases }

      // Opens (or promotes) the voice_clone_training row and moves the profile
      // to 'training'. The route below reconciles the outcome onto THIS job.
      const job = await startVoiceCloneTraining(captureProfileId, brokerageId, manifest, userId)

      const sampleUrls = phrases.map((p) => p.audio_url).filter((u): u is string => !!u)

      const res = await fetch("/api/elevenlabs/voice-clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Agent Voice — ${new Date().toLocaleDateString()}`,
          sample_audio_urls: sampleUrls,
          profile_id: captureProfileId,
          training_id: job.id,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error ?? "Voice cloning failed — please try again.")
      }

      // First clone becomes the default so video generation can pick it up
      // without another trip through settings.
      const hasExistingDefault = profiles.some((p) => p.is_default && p.id !== captureProfileId)
      if (!hasExistingDefault) {
        await setDefaultVoiceProfile(captureProfileId, agentId, brokerageId, userId).catch((err) =>
          console.error("[voice-client] Could not set the new clone as default:", err),
        )
      }

      setVoiceStatus("success")
      setVoiceMessage("Your voice has been cloned and is ready to use in videos.")
      setVoiceDone(true)
      await refreshProfiles()
    } catch (err: any) {
      setVoiceStatus("error")
      setVoiceMessage(err?.message ?? "An error occurred.")
      await refreshProfiles()
    } finally {
      setIsCloning(false)
    }
  }

  // ─── Avatar Upload ─────────────────────────────────────────────────────────

  async function handleAvatarUpload() {
    if (!avatarFile) return
    setIsUploadingAvatar(true)
    setAvatarStatus("idle")
    setAvatarMessage(null)

    try {
      const form = new FormData()
      form.append("file", avatarFile)
      form.append("bucket", "agent-photos")
      if (avatarType === "photo") form.append("validate_photo", "true")

      const res = await fetch("/api/storage/upload-temp", { method: "POST", body: form })
      const data = res.ok ? await res.json() : null

      if (!data?.url) {
        setAvatarStatus("error")
        setAvatarMessage("Upload failed — please try again.")
        return
      }

      // Save source URL to agent voice profile (backwards-compatible fallback)
      const profileRes = await fetch("/api/agent/update-video-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [avatarType === "photo" ? "did_photo_url" : "did_video_url"]: data.url,
          ...(data.warnings?.length ? { did_photo_warnings: data.warnings } : {}),
        }),
      })

      if (!profileRes.ok) {
        setAvatarStatus("error")
        setAvatarMessage("Saved to storage but profile update failed — please retry.")
        return
      }

      // For video uploads: create a persistent D-ID avatar so renders use avatar_id
      // (faster + more consistent quality). Runs in background — no need to wait.
      if (avatarType === "video") {
        fetch("/api/did/create-avatar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source_url: data.url,
            label: "My Avatar",
            set_as_default: true,
          }),
        }).catch((err) =>
          console.error("[voice-client] D-ID avatar creation failed:", err)
        )
      }

      const warningText = data.warnings?.length ? ` Note: ${data.warnings.join(" ")}` : ""
      const processingNote =
        avatarType === "video"
          ? " D-ID is processing your avatar (1–3 min) — you'll be notified when it's ready."
          : ""
      setAvatarStatus("success")
      setAvatarMessage(
        `Your ${avatarType === "photo" ? "photo" : "video"} has been saved.${warningText}${processingNote}`
      )
      setAvatarDone(true)
    } catch (err: any) {
      setAvatarStatus("error")
      setAvatarMessage(err.message ?? "An error occurred.")
    } finally {
      setIsUploadingAvatar(false)
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  const readyProfiles = profiles.filter((p) => p.training_status === "ready" && p.elevenlabs_voice_id)

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-8 px-4 max-w-2xl">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground">Avatar & Voice Setup</h1>
          <p className="text-muted-foreground mt-1">
            Personalize your AI videos and Live Agent sessions with your own face and voice.
          </p>
        </div>

        {!videoConfigured && (
          <Alert variant="destructive" className="mb-6">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Voice and avatar providers aren't configured</AlertTitle>
            <AlertDescription>
              ElevenLabs and D-ID credentials aren't set up on this deployment, so a recording
              can't be turned into a clone yet. You can still record your phrases — they're saved
              and you can finish once the providers are live.
            </AlertDescription>
          </Alert>
        )}

        <StepIndicator current={step} />

        {/* Step: Intro */}
        {step === "intro" && (
          <Card>
            <CardHeader>
              <CardTitle>Set Up Your Avatar & Voice</CardTitle>
              <CardDescription>
                It only takes a few minutes. Your videos and Live Agent sessions will use your own face and voice automatically.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Existing voice library — a returning agent sees what they have */}
              {profiles.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Your voice</p>
                  {profiles.map((profile) => {
                    const status = PROFILE_STATUS_COPY[profile.training_status] ?? {
                      label: profile.training_status,
                      tone: "idle" as const,
                    }
                    const failure = lastJobError(profile)
                    return (
                      <div key={profile.id} className="flex items-center gap-3 p-3 rounded-lg border">
                        <div className="p-2 bg-muted rounded-md">
                          <Mic className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{profile.profile_name}</p>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <Badge
                              variant={status.tone === "ready" ? "default" : status.tone === "bad" ? "destructive" : "secondary"}
                              className="text-xs"
                            >
                              {status.label}
                            </Badge>
                            {profile.is_default && (
                              <Badge variant="outline" className="text-xs gap-1">
                                <Star className="h-3 w-3" /> In use
                              </Badge>
                            )}
                            {resumePhrases(profile) && (
                              <span className="text-xs text-muted-foreground">
                                {resumePhrases(profile)!.filter((p) => p.status === "recorded" || p.status === "validated").length}
                                {" of "}{VOICE_CLONE_SAMPLE_PHRASES.length} phrases recorded
                              </span>
                            )}
                            {profile.quality_score != null && (
                              <span className="text-xs text-muted-foreground">
                                Quality: {Number(profile.quality_score).toFixed(0)}%
                              </span>
                            )}
                          </div>
                          {failure && (
                            <p className="text-xs text-destructive mt-1">Last attempt failed: {failure}</p>
                          )}
                        </div>
                        {resumePhrases(profile) && (
                          <Button size="sm" variant="outline" onClick={() => resumeCapture(profile)}>
                            Resume
                          </Button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              <div className="space-y-3">
                <div className="flex items-start gap-3 p-3 bg-muted rounded-lg">
                  <div className="p-2 bg-background rounded-md">
                    <Mic className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-medium text-sm">Step 2 — Record your voice</p>
                    <p className="text-sm text-muted-foreground">
                      Read {VOICE_CLONE_SAMPLE_PHRASES.length} short phrases aloud. We'll clone your voice from them.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 bg-muted rounded-lg">
                  <div className="p-2 bg-background rounded-md">
                    <Camera className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-medium text-sm">Step 3 — Upload your photo or video</p>
                    <p className="text-sm text-muted-foreground">A clear headshot or short video clip facing the camera.</p>
                  </div>
                </div>
              </div>
              <Alert>
                <Shield className="h-4 w-4" />
                <AlertTitle>Your data is private</AlertTitle>
                <AlertDescription>
                  Your voice and image are only used to generate your videos. They are never shared.
                </AlertDescription>
              </Alert>
              {/* One profile per agent (agent_voice_profiles is unique on
                  agent_id) — recording again REPLACES the voice, it does not
                  add a second one. Several distinct presenter voices are what
                  the Twin Studio is for. */}
              <Button className="w-full" onClick={() => setStep("voice")}>
                {readyProfiles.length > 0 ? "Re-record my voice" : "Get Started"}
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
              {readyProfiles.length > 0 && (
                <p className="text-xs text-muted-foreground text-center">
                  Re-recording replaces your current voice. It keeps working until the new one is ready.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Step: Voice */}
        {step === "voice" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Mic className="h-5 w-5" />
                Record Your Voice
              </CardTitle>
              <CardDescription>
                Read each phrase aloud in your natural speaking voice. Several short phrases
                give the clone more range than one long take.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Progress across the phrase set */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {recordedCount} of {VOICE_CLONE_SAMPLE_PHRASES.length} phrases recorded
                  </span>
                  {recordedCount > 0 && !allRecorded && (
                    <span className="text-xs text-muted-foreground">Saved — you can finish this later</span>
                  )}
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${(recordedCount / VOICE_CLONE_SAMPLE_PHRASES.length) * 100}%` }}
                  />
                </div>
              </div>

              {/* Recorded phrases — re-record any of them */}
              {phrases.some((p) => p.status === "recorded" || p.status === "validated") && (
                <div className="space-y-2">
                  {phrases
                    .filter((p) => p.status === "recorded" || p.status === "validated")
                    .map((p) => (
                      <div key={p.phrase_id} className="flex items-center gap-3 p-3 rounded-lg border bg-muted/30">
                        <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                        <p className="flex-1 text-xs text-muted-foreground line-clamp-1">{p.phrase_text}</p>
                        {p.audio_url && (
                          <audio src={p.audio_url} controls className="h-8 max-w-[9rem]" />
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busyPhrase || isCloning}
                          onClick={() => rerecordPhrase(p.phrase_id)}
                        >
                          Redo
                        </Button>
                      </div>
                    ))}
                </div>
              )}

              {/* The phrase being recorded now */}
              {activePhrase && (
                <div className="space-y-3">
                  {busyPhrase ? (
                    <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Saving your recording…
                    </div>
                  ) : (
                    <VoiceRecorder
                      key={activePhrase.phrase_id}
                      script={activePhrase.phrase_text}
                      scriptLabel={`Phrase ${activePhraseIndex + 1} of ${VOICE_CLONE_SAMPLE_PHRASES.length}`}
                      maxSeconds={30}
                      confirmLabel="Save this phrase"
                      onSampleReady={handlePhraseRecorded}
                    />
                  )}
                </div>
              )}

              {/* Status */}
              {voiceStatus === "success" && (
                <Alert>
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertTitle>Voice cloned successfully</AlertTitle>
                  <AlertDescription>{voiceMessage}</AlertDescription>
                </Alert>
              )}
              {voiceStatus === "error" && (
                <Alert variant="destructive">
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>{voiceMessage}</AlertDescription>
                </Alert>
              )}

              <div className="flex gap-3">
                <Button variant="outline" onClick={() => setStep("intro")}>Back</Button>
                {!voiceDone ? (
                  <Button
                    className="flex-1"
                    disabled={!allRecorded || isCloning || busyPhrase || !videoConfigured}
                    onClick={handleCreateClone}
                  >
                    {isCloning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                    {isCloning
                      ? "Cloning your voice…"
                      : allRecorded
                        ? "Create My Voice Clone"
                        : `Record all ${VOICE_CLONE_SAMPLE_PHRASES.length} phrases to continue`}
                  </Button>
                ) : (
                  <Button className="flex-1" onClick={() => setStep("avatar")}>
                    Continue
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Button>
                )}
              </div>

              <button
                type="button"
                className="w-full text-sm text-muted-foreground underline hover:text-foreground"
                onClick={() => setStep("avatar")}
              >
                Skip for now — set up avatar first
              </button>
            </CardContent>
          </Card>
        )}

        {/* Step: Avatar */}
        {step === "avatar" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Camera className="h-5 w-5" />
                Upload Your Photo or Video
              </CardTitle>
              <CardDescription>
                A clear headshot or short video clip (5–15 seconds) facing the camera, in good lighting.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Photo vs Video toggle */}
              <div className="flex gap-3">
                <Button
                  variant={avatarType === "photo" ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setAvatarType("photo"); setAvatarFile(null) }}
                >
                  <Camera className="h-4 w-4 mr-1" />
                  Photo
                </Button>
                <Button
                  variant={avatarType === "video" ? "default" : "outline"}
                  size="sm"
                  onClick={() => { setAvatarType("video"); setAvatarFile(null) }}
                >
                  <Video className="h-4 w-4 mr-1" />
                  Video Clip
                </Button>
              </div>

              {/* File upload */}
              <div className="border-2 border-dashed rounded-lg p-6 text-center">
                {avatarType === "photo" ? (
                  <Camera className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                ) : (
                  <Video className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                )}
                <input
                  key={avatarType}
                  type="file"
                  accept={avatarType === "photo"
                    ? "image/jpeg,image/png,image/webp"
                    : "video/mp4,video/webm"}
                  onChange={(e) => setAvatarFile(e.target.files?.[0] ?? null)}
                  className="block mx-auto text-sm"
                />
                <p className="text-xs text-muted-foreground mt-2">
                  {avatarType === "photo"
                    ? "JPG or PNG — head and shoulders, facing forward, neutral background"
                    : "MP4 or WebM — 5 to 15 seconds, face fills the frame, look at the camera"}
                </p>
              </div>

              {/* Status */}
              {avatarStatus === "success" && (
                <Alert>
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertTitle>Avatar saved</AlertTitle>
                  <AlertDescription>{avatarMessage}</AlertDescription>
                </Alert>
              )}
              {avatarStatus === "error" && (
                <Alert variant="destructive">
                  <AlertTitle>Error</AlertTitle>
                  <AlertDescription>{avatarMessage}</AlertDescription>
                </Alert>
              )}

              <div className="flex gap-3">
                <Button variant="outline" onClick={() => setStep("voice")}>Back</Button>
                {!avatarDone ? (
                  <Button
                    className="flex-1"
                    disabled={!avatarFile || isUploadingAvatar}
                    onClick={handleAvatarUpload}
                  >
                    {isUploadingAvatar ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                    {isUploadingAvatar
                      ? `Uploading ${avatarType === "photo" ? "photo" : "video"}…`
                      : `Upload ${avatarType === "photo" ? "Photo" : "Video Clip"}`}
                  </Button>
                ) : (
                  <Button className="flex-1" onClick={() => setStep("done")}>
                    Finish Setup
                    <ArrowRight className="h-4 w-4 ml-2" />
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step: Done */}
        {step === "done" && (
          <Card>
            <CardContent className="p-8 text-center space-y-6">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto">
                <CheckCircle2 className="h-8 w-8 text-green-600" />
              </div>
              <div>
                <h2 className="text-2xl font-bold text-foreground mb-2">You're all set!</h2>
                <p className="text-muted-foreground">
                  Your voice and avatar are ready to use in video creation and Live Agent sessions.
                </p>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">Your setup will be used in:</p>
                <div className="flex flex-col gap-2 text-sm">
                  <div className="flex items-center gap-2 justify-center text-foreground">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    Video creation
                  </div>
                  <div className="flex items-center gap-2 justify-center text-foreground">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    Live Agent sessions on your portal and website
                  </div>
                </div>
              </div>
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => router.push("/dashboard")}
                >
                  <LayoutGrid className="h-4 w-4 mr-2" />
                  Go to Dashboard
                </Button>
                <Button
                  className="flex-1"
                  onClick={() => router.push("/dashboard/videos/create")}
                >
                  Create a Video
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
