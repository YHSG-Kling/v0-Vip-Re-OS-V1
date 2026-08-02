"use client"

/**
 * The D-ID consent recorder.
 *
 * A V3 Instant Avatar cannot be built without this: D-ID mints a random
 * three-word passcode, the agent reads it aloud on camera, and D-ID then checks
 * the transcription against the passcode, matches the face to the avatar
 * footage, and verifies the voice.
 *
 * ── WHY THERE IS NO FILE PICKER ─────────────────────────────────────────────
 * D-ID does not accept an uploaded file for consent, by design — an upload
 * proves nothing about who was in front of the camera. The whole point is a
 * live human saying words they could not have known in advance. So this
 * component records and nothing else, and the absence of an upload path is the
 * feature. Please do not "fix" it by adding one.
 *
 * ── WHY VIDEO *AND* AUDIO ───────────────────────────────────────────────────
 * Voice verification is one of the three checks. A muted recording passes the
 * eye test and fails at the provider, so the mic is requested up front and a
 * denial is surfaced immediately rather than after a wasted take.
 *
 * ── WHY THE PREVIEW IS MIRRORED BUT THE REVIEW IS NOT ───────────────────────
 * People frame themselves correctly in a mirror and find an unmirrored live
 * preview disorienting. The REVIEW playback is deliberately unmirrored, because
 * that is what D-ID actually receives.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Video, Square, RotateCcw, Loader2, ShieldCheck, AlertTriangle } from "lucide-react"
import { Button } from "@/app/components/ui/button"
import { toast } from "sonner"
import { uploadTwinAvatar } from "@/app/actions/twin-studio-upload"

interface Props {
  /** Fired once D-ID has VERIFIED the consent. */
  onVerified: () => void
  /** Rendered instead of the recorder when consent is already on file. */
  onSkip?: () => void
  /** Seconds cap. The consent script is three words plus a sentence — short. */
  maxSeconds?: number
}

type Phase = "loading" | "ready" | "recording" | "review" | "submitting" | "verified"

interface ConsentState {
  status: "none" | "pending" | "verified"
  consentId?: string
  consentText?: string
  instructions: readonly string[]
  lastFailure?: string | null
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  let binary = ""
  const bytes = new Uint8Array(buf)
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function ConsentRecorder({ onVerified, onSkip, maxSeconds = 20 }: Props) {
  const [phase, setPhase] = useState<Phase>("loading")
  const [consent, setConsent] = useState<ConsentState | null>(null)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [reviewUrl, setReviewUrl] = useState<string | null>(null)

  const previewRef = useRef<HTMLVideoElement | null>(null)
  const reviewRef = useRef<HTMLVideoElement | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const blobRef = useRef<Blob | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      stopStream()
      if (reviewUrl) URL.revokeObjectURL(reviewUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Load or mint the consent + passcode ──────────────────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/did/consent")
        const data = await res.json()
        if (cancelled) return

        if (data.status === "verified") {
          setConsent({ status: "verified", instructions: data.instructions ?? [] })
          setPhase("verified")
          return
        }
        // A PENDING attempt keeps its original passcode — the agent may be
        // mid-take, and fresh words would invalidate what they are saying.
        if (data.status === "pending") {
          setConsent({
            status: "pending", consentId: data.consent_id,
            consentText: data.consent_text, instructions: data.instructions ?? [],
          })
          setPhase("ready")
          return
        }

        const mint = await fetch("/api/did/consent", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language: "english" }),
        })
        const minted = await mint.json()
        if (cancelled) return
        if (!mint.ok) {
          setError(minted.error ?? "Couldn't start the consent step.")
          setPhase("ready")
          return
        }
        setConsent({
          status: "pending", consentId: minted.consent_id,
          consentText: minted.consent_text, instructions: minted.instructions ?? [],
          lastFailure: data.last_failure ?? null,
        })
        setPhase("ready")
      } catch {
        if (!cancelled) { setError("Couldn't reach the consent service."); setPhase("ready") }
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function startRecording() {
    setError(null)
    try {
      // Video AND audio: voice verification is one of D-ID's three checks, so a
      // muted take fails at the provider after the agent thinks they are done.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: true,
      })
      streamRef.current = stream
      if (previewRef.current) {
        previewRef.current.srcObject = stream
        await previewRef.current.play().catch(() => {})
      }

      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
        ? "video/webm;codecs=vp8,opus"
        : MediaRecorder.isTypeSupported("video/webm")
          ? "video/webm"
          : MediaRecorder.isTypeSupported("video/mp4")
            ? "video/mp4"
            : ""
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      recorderRef.current = recorder
      chunksRef.current = []

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "video/webm" })
        blobRef.current = blob
        const url = URL.createObjectURL(blob)
        setReviewUrl(url)
        setPhase("review")
        stopStream()
      }

      recorder.start()
      setPhase("recording")
      setSeconds(0)
      timerRef.current = setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= maxSeconds) { stopRecording(); return maxSeconds }
          return s + 1
        })
      }, 1000)
    } catch (e) {
      // Name the missing permission rather than saying "failed" — camera and
      // mic denials are the most common first-run problem and the fix is in
      // the browser, not in this app.
      const name = (e as { name?: string })?.name ?? ""
      setError(
        name === "NotAllowedError"
          ? "We need camera and microphone access to record your consent. Allow both in your browser, then try again."
          : name === "NotFoundError"
            ? "No camera or microphone was found. Connect one and try again."
            : "Couldn't start recording. Check that no other app is using your camera.",
      )
    }
  }

  function stopRecording() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    recorderRef.current?.stop()
    recorderRef.current = null
  }

  function retake() {
    if (reviewUrl) URL.revokeObjectURL(reviewUrl)
    setReviewUrl(null)
    blobRef.current = null
    setSeconds(0)
    setError(null)
    setPhase("ready")
  }

  async function submit() {
    if (!blobRef.current || !consent?.consentId) return
    setPhase("submitting")
    setError(null)
    try {
      const base64 = await blobToBase64(blobRef.current)
      const mimeType = blobRef.current.type || "video/webm"
      const upload = await uploadTwinAvatar({ base64, mimeType, kind: "video" })
      if (!upload.ok || !upload.url) {
        setError(upload.error ?? "Couldn't save the recording.")
        setPhase("review")
        return
      }

      const res = await fetch("/api/did/consent/verify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consent_id: consent.consentId, source_url: upload.url }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "We couldn't verify that recording.")
        setPhase("review")
        return
      }
      setPhase("verified")
      toast.success("Consent verified — your video twin can be built now.")
      onVerified()
    } catch {
      setError("Something interrupted the upload. Try submitting again.")
      setPhase("review")
    }
  }

  // ── Already done ─────────────────────────────────────────────────────────
  if (phase === "verified") {
    return (
      <div className="space-y-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
        <div className="flex items-center gap-2 text-emerald-900">
          <ShieldCheck className="h-5 w-5" />
          <p className="font-medium">Consent verified</p>
        </div>
        <p className="text-sm text-emerald-800">
          You only do this once — it covers every video twin you create from now on.
        </p>
        {onSkip && <Button onClick={onSkip}>Continue</Button>}
      </div>
    )
  }

  if (phase === "loading") {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Preparing your consent step…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/40 p-4">
        <p className="text-sm font-medium">Record a short consent statement</p>
        <p className="mt-1 text-sm text-muted-foreground">
          D-ID requires this before building a twin from your video — it proves the face
          and voice are really yours. You only do it once.
        </p>
        <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
          {(consent?.instructions ?? []).map((line) => (
            <li key={line} className="flex gap-2"><span aria-hidden>·</span><span>{line}</span></li>
          ))}
        </ul>
      </div>

      {/* THE PASSCODE. Large and unmissable — reading it wrong is the single
          most common rejection, and the words are the anti-replay check. */}
      {consent?.consentText && (
        <div className="rounded-lg border-2 border-primary/30 bg-primary/5 p-5 text-center">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Say these three words</p>
          <p className="mt-2 text-3xl font-semibold tracking-wide">{consent.consentText}</p>
        </div>
      )}

      <div className="relative overflow-hidden rounded-lg border bg-black">
        {/* Live preview is MIRRORED so the agent can frame themselves naturally. */}
        <video
          ref={previewRef}
          className={phase === "review" ? "hidden" : "block h-auto w-full -scale-x-100"}
          muted playsInline
        />
        {/* Review is NOT mirrored — this is what D-ID actually receives. */}
        <video
          ref={reviewRef}
          src={reviewUrl ?? undefined}
          className={phase === "review" ? "block h-auto w-full" : "hidden"}
          controls playsInline
        />
        {phase === "recording" && (
          <div className="absolute right-3 top-3 flex items-center gap-2 rounded-full bg-red-600/90 px-3 py-1 text-xs font-medium text-white">
            <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
            {seconds}s / {maxSeconds}s
          </div>
        )}
      </div>

      {error && (
        <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{error}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {phase === "ready" && (
          <Button onClick={startRecording} disabled={!consent?.consentText}>
            <Video className="mr-2 h-4 w-4" /> Start recording
          </Button>
        )}
        {phase === "recording" && (
          <Button variant="destructive" onClick={stopRecording}>
            <Square className="mr-2 h-4 w-4" /> Stop
          </Button>
        )}
        {phase === "review" && (
          <>
            <Button onClick={submit}>Submit for verification</Button>
            <Button variant="outline" onClick={retake}>
              <RotateCcw className="mr-2 h-4 w-4" /> Record again
            </Button>
          </>
        )}
        {/* Busy state, not a control — there is nothing behind it to press.
            Rendered the same way the `loading` phase above is, so the surface
            never shows a button that cannot do anything. */}
        {phase === "submitting" && (
          <div
            role="status"
            aria-live="polite"
            className="inline-flex h-9 items-center rounded-md border px-4 text-sm text-muted-foreground"
          >
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Verifying…
          </div>
        )}
      </div>
    </div>
  )
}
