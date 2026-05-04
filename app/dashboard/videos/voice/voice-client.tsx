"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
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
} from "lucide-react"
import { cn } from "@/lib/utils"

// ─── PROPS ───────────────────────────────────────────────────────────────────

interface VoiceCloneClientProps {
  agentId: string
  brokerageId: string
  userId: string
  initialProfiles: any[]
  heygenConfigured: boolean
}

// ─── EXAMPLE VOICE PROMPTS ───────────────────────────────────────────────────

const VOICE_PROMPTS = [
  `"Hi, I'm [your name] with [brokerage name]. Whether you're buying or selling, I'm here to make the process smooth and stress-free."`,
  `"The market is moving fast. Let me help you find the right home before it's gone — or get top dollar for yours."`,
  `"Real estate is one of the biggest decisions you'll make. I'll be with you every step of the way, from first showing to closing day."`,
]

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

// ─── MAIN COMPONENT ──────────────────────────────────────────────────────────

export function VoiceCloneClient({
  agentId: _agentId,
  brokerageId: _brokerageId,
  userId: _userId,
  initialProfiles: _initialProfiles,
  heygenConfigured: _heygenConfigured,
}: VoiceCloneClientProps) {
  const router = useRouter()
  const [step, setStep] = useState<WizardStep>("intro")

  // Voice upload state
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [isUploadingVoice, setIsUploadingVoice] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "success" | "error">("idle")
  const [voiceMessage, setVoiceMessage] = useState<string | null>(null)
  const [voiceDone, setVoiceDone] = useState(false)

  // Avatar upload state
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [avatarType, setAvatarType] = useState<"photo" | "video">("photo")
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false)
  const [avatarStatus, setAvatarStatus] = useState<"idle" | "success" | "error">("idle")
  const [avatarMessage, setAvatarMessage] = useState<string | null>(null)
  const [avatarDone, setAvatarDone] = useState(false)

  // ─── Voice Upload ──────────────────────────────────────────────────────────

  async function handleVoiceUpload() {
    if (!audioFile) return
    setIsUploadingVoice(true)
    setVoiceStatus("idle")
    setVoiceMessage(null)

    try {
      const form = new FormData()
      form.append("file", audioFile)
      const uploadRes = await fetch("/api/storage/upload-temp", { method: "POST", body: form })
      const uploadData = uploadRes.ok ? await uploadRes.json() : null
      const audioUrl = uploadData?.url

      if (!audioUrl) {
        setVoiceStatus("error")
        setVoiceMessage("Upload failed — please try again.")
        return
      }

      const voiceName = `Agent Voice — ${new Date().toLocaleDateString()}`
      const res = await fetch("/api/elevenlabs/voice-clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: voiceName, sample_audio_urls: [audioUrl] }),
      })
      const data = await res.json()

      if (res.ok) {
        setVoiceStatus("success")
        setVoiceMessage("Your voice has been cloned and is ready to use in videos.")
        setVoiceDone(true)
      } else {
        setVoiceStatus("error")
        setVoiceMessage(data.error ?? "Voice cloning failed — please try again.")
      }
    } catch (err: any) {
      setVoiceStatus("error")
      setVoiceMessage(err.message ?? "An error occurred.")
    } finally {
      setIsUploadingVoice(false)
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

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto py-8 px-4 max-w-2xl">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground">Avatar & Voice Setup</h1>
          <p className="text-muted-foreground mt-1">
            Personalize your AI videos and Live Agent sessions with your own face and voice.
          </p>
        </div>

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
              <div className="space-y-3">
                <div className="flex items-start gap-3 p-3 bg-muted rounded-lg">
                  <div className="p-2 bg-background rounded-md">
                    <Mic className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="font-medium text-sm">Step 2 — Record your voice</p>
                    <p className="text-sm text-muted-foreground">Upload a 30–90 second audio recording. We'll clone your voice automatically.</p>
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
              <Button className="w-full" onClick={() => setStep("voice")}>
                Get Started
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
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
                Upload a short, clear audio recording (30–90 seconds). Read naturally — this powers your voice in videos.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Example prompts */}
              <div className="space-y-2">
                <p className="text-sm font-medium">Example prompts to read aloud (pick 1–2):</p>
                <div className="space-y-2">
                  {VOICE_PROMPTS.map((prompt, i) => (
                    <div key={i} className="p-3 bg-muted rounded-lg text-sm italic text-muted-foreground">
                      {prompt}
                    </div>
                  ))}
                </div>
              </div>

              {/* File upload */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Upload Audio File</label>
                <div className="border-2 border-dashed rounded-lg p-6 text-center">
                  <Mic className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                  <input
                    type="file"
                    accept="audio/mp3,audio/wav,audio/m4a,audio/*"
                    onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)}
                    className="block mx-auto text-sm"
                  />
                  <p className="text-xs text-muted-foreground mt-2">MP3, WAV, or M4A — 30 to 90 seconds</p>
                </div>
              </div>

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
                    disabled={!audioFile || isUploadingVoice}
                    onClick={handleVoiceUpload}
                  >
                    {isUploadingVoice ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                    {isUploadingVoice ? "Cloning your voice…" : "Upload & Clone Voice"}
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
