"use client"

import { useEffect, useRef, useState } from "react"
import { Mic, Square, Play, Pause, RotateCcw } from "lucide-react"
import { Button } from "@/app/components/ui/button"

interface Props {
  /** Triggered when the user is happy with the recording. The recorder hands
   *  back the raw audio Blob; the parent uploads + clones. */
  onSampleReady: (blob: Blob, mimeType: string) => void
  /** Recommended duration — recorder caps at this many seconds. */
  maxSeconds?: number
}

const SCRIPT = `Hi, I'm a real estate agent and I love helping families find their next home. Buying or selling is one of the biggest decisions you'll make — I'm here to make it feel simple, clear, and even a little fun. Let me know what you're working on and we'll figure it out together.`

export function VoiceRecorder({ onSampleReady, maxSeconds = 60 }: Props) {
  const [phase, setPhase] = useState<"idle" | "recording" | "review">("idle")
  const [seconds, setSeconds] = useState(0)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [audioMime, setAudioMime] = useState<string>("audio/webm")
  const [playing, setPlaying] = useState(false)

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const audioElRef = useRef<HTMLAudioElement | null>(null)
  const blobRef = useRef<Blob | null>(null)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop())
      if (audioUrl) URL.revokeObjectURL(audioUrl)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // Prefer audio/webm with opus — supported in Chrome/Edge/Firefox; Safari falls back to audio/mp4
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : ""
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      mediaRecorderRef.current = recorder
      chunksRef.current = []
      setAudioMime(recorder.mimeType || "audio/webm")

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" })
        blobRef.current = blob
        const url = URL.createObjectURL(blob)
        setAudioUrl(url)
        setPhase("review")
        stream.getTracks().forEach((t) => t.stop())
      }
      recorder.start()
      setPhase("recording")
      setSeconds(0)
      timerRef.current = setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= maxSeconds) {
            stopRecording()
            return maxSeconds
          }
          return s + 1
        })
      }, 1000)
    } catch (e) {
      console.error("Mic access denied", e)
      alert("Couldn't access your microphone. Please check browser permissions and try again.")
    }
  }

  function stopRecording() {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    mediaRecorderRef.current?.stop()
  }

  function reset() {
    if (audioUrl) URL.revokeObjectURL(audioUrl)
    setAudioUrl(null)
    blobRef.current = null
    setPhase("idle")
    setSeconds(0)
    setPlaying(false)
  }

  function togglePlay() {
    const el = audioElRef.current
    if (!el) return
    if (playing) {
      el.pause()
      setPlaying(false)
    } else {
      el.play()
      setPlaying(true)
    }
  }

  function useThis() {
    if (!blobRef.current) return
    onSampleReady(blobRef.current, audioMime)
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/30 p-4">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
          Read this aloud
        </p>
        <p className="text-sm leading-relaxed">{SCRIPT}</p>
      </div>

      {phase === "idle" && (
        <div className="text-center py-6">
          <Button onClick={startRecording} size="lg" className="gap-2">
            <Mic className="h-5 w-5" /> Start Recording
          </Button>
          <p className="text-xs text-muted-foreground mt-3">
            Up to {maxSeconds} seconds. We'll use this to make your AI twin sound just like you.
          </p>
        </div>
      )}

      {phase === "recording" && (
        <div className="text-center py-6 space-y-4">
          <div className="flex items-center justify-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-sm font-medium">Recording…</span>
            <span className="text-sm text-muted-foreground tabular-nums">
              {formatTime(seconds)} / {formatTime(maxSeconds)}
            </span>
          </div>
          <div className="h-1.5 bg-muted rounded-full overflow-hidden mx-auto max-w-xs">
            <div
              className="h-full bg-red-500 transition-all"
              style={{ width: `${(seconds / maxSeconds) * 100}%` }}
            />
          </div>
          <Button onClick={stopRecording} variant="outline" size="lg" className="gap-2">
            <Square className="h-4 w-4 fill-current" /> Stop
          </Button>
        </div>
      )}

      {phase === "review" && audioUrl && (
        <div className="space-y-3">
          <audio
            ref={audioElRef}
            src={audioUrl}
            onEnded={() => setPlaying(false)}
            className="hidden"
          />
          <div className="rounded-lg border bg-card p-4 flex items-center gap-3">
            <Button onClick={togglePlay} size="icon" variant="outline" className="rounded-full h-10 w-10">
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
            </Button>
            <div className="flex-1">
              <p className="text-sm font-medium">Your sample ({formatTime(seconds)})</p>
              <p className="text-xs text-muted-foreground">Listen back, then continue or re-record</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={reset} variant="outline" className="flex-1 gap-2">
              <RotateCcw className="h-4 w-4" /> Re-record
            </Button>
            <Button onClick={useThis} className="flex-1">
              Use this voice
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function formatTime(s: number): string {
  const mm = Math.floor(s / 60).toString().padStart(2, "0")
  const ss = (s % 60).toString().padStart(2, "0")
  return `${mm}:${ss}`
}
