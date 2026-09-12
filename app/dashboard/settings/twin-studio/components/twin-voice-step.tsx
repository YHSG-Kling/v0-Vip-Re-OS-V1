"use client"

/**
 * THE TWIN'S VOICE — the one component that offers BOTH ways to have one.
 *
 * The owner's rule: "if they dont have a voice to use with video and other
 * features that use audio, then they need to create their cloned voice… voice
 * will give them a voiceid… elevenlabs has stock voices they can choose from."
 * So there are exactly two doors and this renders both:
 *
 *   · RECORD  — a real ElevenLabs Instant Voice Clone through
 *     POST /api/elevenlabs/voice-clone. That route is the ONLY path to a clone
 *     anywhere in the product because the usage cap and the
 *     `voice_clones_created` meter live on it. Nothing here goes around it.
 *   · CHOOSE  — an ElevenLabs STOCK voice, through setTwinStockVoice, which
 *     allowlists the id against the stock catalogue. A stock voice creates
 *     nothing at the vendor, so it costs nothing and is metered as nothing.
 *
 * Shared on purpose: the creation wizard shows this as its voice step, and a
 * finished twin that has no voice shows the SAME component from its card. One
 * implementation, so "add a voice later" can never drift from "add a voice now"
 * — which is exactly how a second, unmetered clone path gets born.
 */

import { useEffect, useState, useTransition } from "react"
import { Loader2, Mic, Library, Volume2, CheckCircle2 } from "lucide-react"
import { Button } from "@/app/components/ui/button"
import { toast } from "sonner"
import { uploadTwinVoiceSample } from "@/app/actions/twin-studio-upload"
import { listTwinVoiceOptions, setTwinStockVoice, type TwinVoiceOption } from "@/app/actions/twin-studio"
import { previewAssistantVoiceAction } from "@/app/actions/ai-identity"
import { VoiceRecorder } from "./voice-recorder"

type Mode = "choose" | "record" | "stock"

interface Props {
  twinId: string
  /** The twin's name — becomes the clone's name in the vendor account. */
  label: string
  /** Called once the twin has a voiceId. */
  onComplete: () => void
  /** Rendered as "Skip — I'll do this later" when provided. */
  onSkip?: () => void
}

export function TwinVoiceStep({ twinId, label, onComplete, onSkip }: Props) {
  const [mode, setMode] = useState<Mode>("choose")
  const [cloning, setCloning] = useState(false)

  if (cloning) {
    return (
      <div className="text-center py-12">
        <Loader2 className="h-8 w-8 animate-spin mx-auto mb-3" />
        <p className="text-sm font-medium">Cloning your voice…</p>
        <p className="text-xs text-muted-foreground mt-1">Usually about 30 seconds.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4 pt-2">
      {mode === "choose" && (
        <>
          <p className="text-sm text-muted-foreground">
            Your twin needs a voice before it can speak in a video, on a call, or in your
            client&apos;s portal. Two ways to get one.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setMode("record")}
              className="rounded-lg border-2 border-dashed p-5 hover:border-primary hover:bg-muted/30 transition-colors text-center"
            >
              <Mic className="h-7 w-7 mx-auto mb-2 text-muted-foreground" />
              <p className="font-medium text-sm">Clone my voice</p>
              <p className="text-xs text-muted-foreground mt-1">
                Read one paragraph aloud. Your twin then sounds like you.
              </p>
            </button>
            <button
              onClick={() => setMode("stock")}
              className="rounded-lg border-2 border-dashed p-5 hover:border-primary hover:bg-muted/30 transition-colors text-center"
            >
              <Library className="h-7 w-7 mx-auto mb-2 text-muted-foreground" />
              <p className="font-medium text-sm">Choose a stock voice</p>
              <p className="text-xs text-muted-foreground mt-1">
                Pick a professional voice from the library. Nothing to record.
              </p>
            </button>
          </div>
        </>
      )}

      {mode === "record" && (
        <RecordVoice
          twinId={twinId}
          label={label}
          onWorkingChange={setCloning}
          onComplete={onComplete}
          onBack={() => setMode("choose")}
        />
      )}

      {mode === "stock" && (
        <StockVoicePicker
          twinId={twinId}
          onComplete={onComplete}
          onBack={() => setMode("choose")}
        />
      )}

      {onSkip && (
        <div className="text-center">
          <button onClick={onSkip} className="text-xs text-muted-foreground hover:text-foreground">
            Skip — I&apos;ll do this later
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Record → real ElevenLabs clone ───────────────────────────────────────

function RecordVoice({
  twinId, label, onWorkingChange, onComplete, onBack,
}: {
  twinId: string
  label: string
  onWorkingChange: (working: boolean) => void
  onComplete: () => void
  onBack: () => void
}) {
  async function handleSample(blob: Blob, mimeType: string) {
    onWorkingChange(true)
    try {
      const base64 = await blobToBase64(blob)
      const upload = await uploadTwinVoiceSample({ base64, mimeType })
      if (!upload.ok || !upload.url) {
        toast.error(upload.error ?? "Upload failed")
        return
      }

      // THE ONE CLONE PATH. Cap + `voice_clones_created` metering live on this
      // route; there is deliberately no server action that writes a clone id.
      const cloneRes = await fetch("/api/elevenlabs/voice-clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Twin: ${label}`,
          sample_audio_urls: [upload.url],
          twin_id: twinId,
        }),
      })
      if (!cloneRes.ok) {
        const err = await cloneRes.json().catch(() => ({}))
        toast.error(err.error ?? "Voice clone failed")
        return
      }
      toast.success("Your voice clone is ready")
      onComplete()
    } finally {
      onWorkingChange(false)
    }
  }

  return (
    <div className="space-y-3">
      <VoiceRecorder onSampleReady={handleSample} maxSeconds={60} />
      <button onClick={onBack} className="block mx-auto text-xs text-muted-foreground hover:text-foreground">
        ← Use a stock voice instead
      </button>
    </div>
  )
}

// ─── Choose → ElevenLabs stock voice ──────────────────────────────────────

function StockVoicePicker({
  twinId, onComplete, onBack,
}: { twinId: string; onComplete: () => void; onBack: () => void }) {
  const [voices, setVoices] = useState<TwinVoiceOption[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [saving, startSaving] = useTransition()

  useEffect(() => {
    let live = true
    listTwinVoiceOptions()
      .then((res) => { if (live) setVoices(res.voices) })
      // The curated floor is returned even on a vendor outage, so an empty list
      // here means the action itself failed — say so rather than rendering an
      // empty grid that looks like "no voices exist".
      .catch(() => { if (live) setVoices([]) })
    return () => { live = false }
  }, [])

  async function preview(voiceId: string) {
    setPreviewing(voiceId)
    try {
      const res = await previewAssistantVoiceAction(voiceId)
      if (res.success) await new Audio(res.audioDataUrl).play().catch(() => {})
      else toast.error(res.error ?? "Preview failed")
    } catch {
      toast.error("Preview failed")
    } finally {
      setPreviewing(null)
    }
  }

  function save() {
    if (!selected) return
    startSaving(async () => {
      const res = await setTwinStockVoice({ twinId, voiceId: selected })
      if (res.ok) {
        toast.success("Voice set")
        onComplete()
      } else {
        toast.error(res.error ?? "Couldn't set that voice")
      }
    })
  }

  if (voices === null) {
    return (
      <div className="py-10 text-center">
        <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">Loading the voice library…</p>
      </div>
    )
  }

  if (voices.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground text-center py-6">
          The voice library couldn&apos;t be loaded right now. Record your own voice instead, or try
          again in a moment.
        </p>
        <button onClick={onBack} className="block mx-auto text-xs text-muted-foreground hover:text-foreground">
          ← Back
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1">
        {voices.map((v) => {
          const isSelected = selected === v.voiceId
          return (
            <div
              key={v.voiceId}
              className={`rounded-md border p-2.5 text-xs transition-colors ${
                isSelected ? "border-primary bg-primary/5" : "hover:bg-muted/40"
              }`}
            >
              <button
                type="button"
                onClick={() => setSelected(v.voiceId)}
                className="w-full text-left"
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="font-medium text-foreground flex items-center gap-1">
                    {isSelected && <CheckCircle2 className="h-3 w-3 text-primary" />}
                    {v.label}
                  </span>
                  {v.gender && (
                    <span className="text-[10px] text-muted-foreground capitalize">{v.gender}</span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{v.style}</p>
              </button>
              <button
                type="button"
                onClick={() => preview(v.voiceId)}
                disabled={previewing !== null}
                className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {previewing === v.voiceId
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <Volume2 className="h-3 w-3" />}
                Hear it
              </button>
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-xs text-muted-foreground hover:text-foreground">
          ← Record my own voice instead
        </button>
        <Button size="sm" onClick={save} disabled={!selected || saving}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
          Use this voice
        </Button>
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.split(",")[1] ?? "")
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
