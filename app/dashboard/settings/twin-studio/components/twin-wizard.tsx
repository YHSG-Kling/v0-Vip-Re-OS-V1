"use client"

import { useRef, useState, useTransition } from "react"
import { DID_SENTIMENTS } from "@/lib/did/agent-presenter"
import { Camera, Video, Loader2, ChevronRight, ChevronLeft, CheckCircle2, Sparkles } from "lucide-react"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/app/components/ui/dialog"
import { Button } from "@/app/components/ui/button"
import { Input } from "@/app/components/ui/input"
import { Textarea } from "@/app/components/ui/textarea"
import { Label } from "@/app/components/ui/label"
import { toast } from "sonner"
import { createTwinDraft, finalizeTwin } from "@/app/actions/twin-studio"
import { uploadTwinAvatar } from "@/app/actions/twin-studio-upload"
import { TwinVoiceStep } from "./twin-voice-step"
import { ConsentRecorder } from "./consent-recorder"

type Step = "look" | "consent" | "voice" | "personality" | "done"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The greeting tones D-ID actually supports, verbatim from their SDK reference.
 *
 * CLOSED, and sourced from the shared vocabulary rather than retyped: D-ID
 * documents that an unsupported sentiment silently falls back to the default,
 * so an invented tone would look chosen here and do nothing on the wire.
 */
const GREETING_TONES = DID_SENTIMENTS.map((value) => ({
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
}))

const PERSONALITY_PRESETS = [
  { label: "Warm & reassuring", text: "Warm and reassuring. Lead with empathy. Plain English." },
  { label: "Direct & informative", text: "Direct and informative. Get to the point with the facts that matter." },
  { label: "Friendly mentor", text: "Friendly and patient. Explain like you're guiding a first-time buyer." },
  { label: "Professional & brief", text: "Professional and concise. Confident, no filler, respectful of time." },
]

export function TwinWizard({ open, onOpenChange }: Props) {
  const [step, setStep] = useState<Step>("look")
  const [twinId, setTwinId] = useState<string | null>(null)
  // Which source the agent chose. A VIDEO twin is a V3 Instant Avatar and D-ID
  // requires a recorded consent for those; a PHOTO twin does not, so the step
  // is skipped rather than shown-and-auto-passed.
  const [sourceKind, setSourceKind] = useState<"photo" | "video" | null>(null)
  // The uploaded source, held back for a VIDEO twin so the D-ID submit can
  // happen AFTER consent is verified rather than being refused before it.
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [label, setLabel] = useState("My Twin")
  const [personality, setPersonality] = useState("")
  // The agent's OWN opening line. Optional, and empty is a real answer — an
  // avatar that says nothing until spoken to is better than one that says
  // something its owner never wrote.
  const [greeting, setGreeting] = useState("")
  const [greetingSentiment, setGreetingSentiment] = useState("")
  const [setAsDefault, setSetAsDefault] = useState(true)
  const [pending, startTransition] = useTransition()

  function handleClose() {
    onOpenChange(false)
    // reset for next open after dialog animates closed
    setTimeout(() => {
      setStep("look")
      setTwinId(null)
      setSourceKind(null)
      setSourceUrl(null)
      setLabel("My Twin")
      setPersonality("")
      setSetAsDefault(true)
    }, 300)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create a New Twin</DialogTitle>
          <DialogDescription>
            Three steps. Takes about 5 minutes total.
          </DialogDescription>
        </DialogHeader>

        <Steps current={step} showConsent={sourceKind === "video"} />

        {step === "look" && (
          <LookStep
            label={label}
            onLabelChange={setLabel}
            onComplete={(id, kind, url) => {
              setTwinId(id)
              setSourceKind(kind)
              setSourceUrl(url)
              // Consent only stands between a VIDEO twin and D-ID.
              setStep(kind === "video" ? "consent" : "voice")
            }}
          />
        )}

        {step === "consent" && (
          <ConsentRecorder
            // Consent verified → NOW submit the video to D-ID. This is the
            // deferred hand-off from the look step: a V3 Instant Avatar cannot
            // be created without the consent that just completed.
            onVerified={async () => {
              if (!twinId || !sourceUrl) { setStep("voice"); return }
              try {
                const res = await fetch("/api/did/create-avatar", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    source_url: sourceUrl,
                    source_type: "video",
                    twin_id: twinId,
                    label: label.trim() || "My Twin",
                  }),
                })
                if (!res.ok) {
                  const err = await res.json().catch(() => ({}))
                  toast.error(err.error ?? "Avatar processing failed")
                  return
                }
              } catch {
                toast.error("Couldn't start avatar processing — try again.")
                return
              }
              setStep("voice")
            }}
            onSkip={async () => {
              // Consent was ALREADY on file from a previous twin, so the submit
              // that the look step deferred still has to happen.
              if (!twinId || !sourceUrl) { setStep("voice"); return }
              try {
                const res = await fetch("/api/did/create-avatar", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    source_url: sourceUrl,
                    source_type: "video",
                    twin_id: twinId,
                    label: label.trim() || "My Twin",
                  }),
                })
                if (!res.ok) {
                  const err = await res.json().catch(() => ({}))
                  toast.error(err.error ?? "Avatar processing failed")
                  return
                }
              } catch {
                toast.error("Couldn't start avatar processing — try again.")
                return
              }
              setStep("voice")
            }}
          />
        )}

        {step === "voice" && twinId && (
          // BOTH doors to a voice — clone or stock — live in one shared
          // component, because the same step is offered again from the twin
          // card for a twin that skipped it here.
          <TwinVoiceStep
            twinId={twinId}
            label={label}
            onSkip={() => setStep("personality")}
            onComplete={() => setStep("personality")}
          />
        )}

        {step === "personality" && twinId && (
          <PersonalityStep
            personality={personality}
            onPersonalityChange={setPersonality}
            greeting={greeting}
            onGreetingChange={setGreeting}
            greetingSentiment={greetingSentiment}
            onGreetingSentimentChange={setGreetingSentiment}
            setAsDefault={setAsDefault}
            onSetAsDefaultChange={setSetAsDefault}
            pending={pending}
            onBack={() => setStep("voice")}
            onFinish={() => {
              startTransition(async () => {
                const res = await finalizeTwin({
                  twinId,
                  personality: personality || undefined,
                  greeting,
                  greetingSentiment,
                  setAsDefault,
                })
                if (res.ok) {
                  setStep("done")
                } else {
                  toast.error(res.error ?? "Couldn't finish setup")
                }
              })
            }}
          />
        )}

        {step === "done" && <DoneStep label={label} onClose={handleClose} />}
      </DialogContent>
    </Dialog>
  )
}

// ─── Step 1 — Look ─────────────────────────────────────────────────────────

function LookStep({
  label, onLabelChange, onComplete,
}: { label: string; onLabelChange: (v: string) => void; onComplete: (twinId: string, kind: "photo" | "video", sourceUrl: string) => void }) {
  const [kind, setKind] = useState<"photo" | "video" | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    if (kind === "photo" && file.size > 10 * 1024 * 1024) {
      toast.error("Photo must be under 10 MB")
      return
    }
    if (kind === "video" && file.size > 50 * 1024 * 1024) {
      toast.error("Video must be under 50 MB")
      return
    }

    setUploading(true)
    try {
      const base64 = await fileToBase64(file)
      const upload = await uploadTwinAvatar({
        base64,
        mimeType: file.type,
        kind: kind!,
      })
      if (!upload.ok || !upload.url) {
        toast.error(upload.error ?? "Upload failed")
        return
      }

      // Create the twin draft row (defaults brokerage approval based on policy)
      const draft = await createTwinDraft({
        label: label.trim() || "My Twin",
        sourceType: kind!,
        sourceUrl: upload.url,
      })
      if (!draft.ok || !draft.twinId) {
        toast.error(draft.error ?? "Couldn't create twin")
        return
      }

      // ORDER MATTERS. A VIDEO twin is a V3 Instant Avatar and D-ID refuses one
      // without a verified consent, so submitting here would 428 before the
      // agent has had any chance to record it — they would see a failure for
      // something they were never offered. Video therefore defers the D-ID
      // hand-off until AFTER the consent step; photo submits immediately,
      // because a photo twin needs no consent at all.
      if (kind === "video") {
        onComplete(draft.twinId, "video", upload.url)
        return
      }

      const didRes = await fetch("/api/did/create-avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_url: upload.url,
          source_type: kind,
          twin_id: draft.twinId,
          label: label.trim() || "My Twin",
        }),
      })
      if (!didRes.ok) {
        const err = await didRes.json().catch(() => ({}))
        toast.error(err.error ?? "Avatar processing failed")
        return
      }

      onComplete(draft.twinId, kind!, upload.url)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-4 pt-2">
      <div>
        <Label htmlFor="twin-label">Twin name</Label>
        <Input
          id="twin-label"
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
          placeholder="e.g. Professional, Casual, Listing tour"
          className="mt-1.5"
          maxLength={64}
        />
      </div>

      {!kind && (
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setKind("photo")}
            className="rounded-lg border-2 border-dashed p-6 hover:border-primary hover:bg-muted/30 transition-colors text-center"
          >
            <Camera className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
            <p className="font-medium text-sm">Photo</p>
            <p className="text-xs text-muted-foreground mt-1">A clear headshot, ≥ 512 px</p>
          </button>
          <button
            onClick={() => setKind("video")}
            className="rounded-lg border-2 border-dashed p-6 hover:border-primary hover:bg-muted/30 transition-colors text-center"
          >
            <Video className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
            <p className="font-medium text-sm">Short video</p>
            <p className="text-xs text-muted-foreground mt-1">15–30 seconds, looking at the camera</p>
          </button>
        </div>
      )}

      {kind && (
        <div>
          <input
            type="file"
            ref={fileRef}
            accept={kind === "photo" ? "image/*" : "video/mp4,video/webm,video/quicktime"}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) handleFile(f)
            }}
          />
          <div className="rounded-lg border-2 border-dashed p-8 text-center">
            {uploading ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="h-6 w-6 animate-spin" />
                <p className="text-sm">Uploading and submitting for processing…</p>
              </div>
            ) : (
              <>
                <p className="text-sm mb-3">
                  Choose a {kind === "photo" ? "photo" : "video"} file
                </p>
                <Button onClick={() => fileRef.current?.click()}>Choose file</Button>
                <button
                  onClick={() => setKind(null)}
                  className="block mx-auto text-xs text-muted-foreground hover:text-foreground mt-3"
                >
                  ← Pick a different type
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Step 2 (Voice) is ./twin-voice-step.tsx — SHARED with the twin card's
// "Add a voice" affordance, so the clone route and the stock-voice allowlist
// have exactly one implementation between the two entry points.

// ─── Step 3 — Personality ──────────────────────────────────────────────────

function PersonalityStep({
  personality, onPersonalityChange,
  greeting, onGreetingChange, greetingSentiment, onGreetingSentimentChange,
  setAsDefault, onSetAsDefaultChange,
  pending, onBack, onFinish,
}: {
  personality: string
  onPersonalityChange: (v: string) => void
  greeting: string
  onGreetingChange: (v: string) => void
  greetingSentiment: string
  onGreetingSentimentChange: (v: string) => void
  setAsDefault: boolean
  onSetAsDefaultChange: (v: boolean) => void
  pending: boolean
  onBack: () => void
  onFinish: () => void
}) {
  return (
    <div className="space-y-4 pt-2">
      <div>
        <Label>How should this twin sound? (optional)</Label>
        <div className="grid grid-cols-2 gap-2 mt-2">
          {PERSONALITY_PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => onPersonalityChange(p.text)}
              className={`text-left rounded-md border p-2.5 text-xs hover:bg-muted/50 transition-colors ${
                personality === p.text ? "border-primary bg-primary/5" : ""
              }`}
            >
              <div className="font-medium text-foreground mb-0.5 flex items-center gap-1">
                <Sparkles className="h-3 w-3" /> {p.label}
              </div>
              <div className="text-muted-foreground line-clamp-2">{p.text}</div>
            </button>
          ))}
        </div>
        <Textarea
          value={personality}
          onChange={(e) => onPersonalityChange(e.target.value)}
          placeholder="Or describe in your own words…"
          className="mt-3 text-sm"
          rows={3}
          maxLength={500}
        />
      </div>

      {/* THE ONLY WORDS THE AVATAR SPEAKS THAT THE BRAIN DID NOT WRITE.
          Everything else the twin says comes from chat() through our custom-LLM.
          A greeting is spoken verbatim, in this agent's cloned voice, to their
          own client — so it is authored here or it does not exist. There is
          deliberately no default: a friendly-sounding placeholder would be a
          sentence the agent never approved. */}
      <div>
        <Label htmlFor="twin-greeting">Opening line (optional)</Label>
        <p className="text-xs text-muted-foreground mt-1">
          Spoken in your voice when a client starts a live conversation. Leave it
          blank and your twin simply waits for them to speak first.
        </p>
        <Textarea
          id="twin-greeting"
          value={greeting}
          onChange={(e) => onGreetingChange(e.target.value)}
          placeholder="Hi — good to see you. What can I help you with today?"
          className="mt-2 text-sm"
          rows={2}
          maxLength={300}
        />
        <div className="flex items-center justify-between mt-1">
          <span className="text-[11px] text-muted-foreground">
            {greeting.length}/300 — it is read aloud, so keep it short
          </span>
        </div>
        {greeting.trim().length > 0 && (
          <div className="mt-2">
            <Label className="text-xs">Tone</Label>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {GREETING_TONES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => onGreetingSentimentChange(greetingSentiment === t.value ? "" : t.value)}
                  className={`rounded-full border px-2.5 py-1 text-xs hover:bg-muted/50 transition-colors ${
                    greetingSentiment === t.value ? "border-primary bg-primary/5 text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-3">
        <input
          id="set-default"
          type="checkbox"
          checked={setAsDefault}
          onChange={(e) => onSetAsDefaultChange(e.target.checked)}
          className="h-4 w-4"
        />
        <label htmlFor="set-default" className="text-sm cursor-pointer">
          Make this my default twin
        </label>
      </div>

      <div className="flex justify-between pt-2">
        <Button variant="ghost" onClick={onBack} disabled={pending}>
          <ChevronLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <Button onClick={onFinish} disabled={pending}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
          Finish
        </Button>
      </div>
    </div>
  )
}

// ─── Done ─────────────────────────────────────────────────────────────────

function DoneStep({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <div className="text-center py-8 space-y-4">
      <div className="mx-auto h-14 w-14 rounded-full bg-emerald-100 flex items-center justify-center">
        <CheckCircle2 className="h-8 w-8 text-emerald-600" />
      </div>
      <div>
        <p className="font-semibold text-lg">"{label}" is on its way</p>
        <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
          Avatar processing usually takes 1-3 minutes. You'll see the twin status update on this page.
        </p>
      </div>
      <Button onClick={onClose}>Close</Button>
    </div>
  )
}

// ─── Steps indicator ──────────────────────────────────────────────────────

function Steps({ current, showConsent }: { current: Step; showConsent: boolean }) {
  const steps: { key: Step; label: string }[] = [
    { key: "look", label: "Look" },
    // Shown only once the agent has chosen video — a photo twin never sees it.
    ...(showConsent ? [{ key: "consent" as Step, label: "Consent" }] : []),
    { key: "voice", label: "Voice" },
    { key: "personality", label: "Personality" },
  ]
  const idx = steps.findIndex((s) => s.key === current)
  const doneIdx = current === "done" ? steps.length : idx

  return (
    <div className="flex items-center gap-1 text-xs">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-1">
          <span
            className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-medium ${
              i < doneIdx
                ? "bg-emerald-500 text-white"
                : i === idx
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            {i < doneIdx ? <CheckCircle2 className="h-3 w-3" /> : i + 1}
          </span>
          <span className={i === idx ? "font-medium" : "text-muted-foreground"}>{s.label}</span>
          {i < steps.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground mx-1" />}
        </div>
      ))}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.split(",")[1] ?? "")
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
