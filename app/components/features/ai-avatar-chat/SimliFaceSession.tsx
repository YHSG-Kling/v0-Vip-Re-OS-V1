"use client"

/**
 * SimliFaceSession — the BACKUP face-render leg (wave 62). Mounted by
 * AgentsWidget (portal) and embed-widget (embed/site) when their session
 * door returns `{provider: "simli", sessionToken, faceId}` instead of a D-ID
 * `clientKey` — i.e. ONLY after D-ID's own init already failed server-side
 * (app/api/did/agents/session, app/api/embed/session). Never a competing
 * first choice; D-ID Express v4 stays PRIMARY.
 *
 * PIPELINE (owner ruling 2026-09-14, "building Simli as a backup makes more
 * sense than HeyGen" — docs.simli.com facts fetched the same day):
 *
 *   visitor mic → SpeechRecognition (browser) → text turn
 *     → /api/live-agent/simli-turn (relays to the SAME brain every D-ID
 *       surface uses, /api/did/custom-llm — §6, no second brain)
 *     → /api/internal/voice-tts?format=pcm_16000 (the SAME ElevenLabs voice
 *       clone every other surface speaks in)
 *     → simli-client.sendAudioData(PCM16 mono 16kHz, ≤6000-byte chunks)
 *     → Simli renders the talking face over LiveKit (no LiveKit
 *       infrastructure of our own — Simli's "livekit" mode handles it)
 *
 * simli-client@3.x IS in package.json (integrator, wave 62). It is loaded via
 * a DYNAMIC import so the bundle only pulls it in on this fail-over path;
 * types come from the package's own dist/index.d.ts. TOMBSTONE: the lane's
 * ambient `types/simli-client.d.ts` (written so the lane could type-check
 * without the package) was deleted at integration as a duplicate of the
 * package typings — survivor: node_modules/simli-client/dist/client.d.ts.
 * A failed dynamic import is treated exactly like Simli's own
 * `startup_error` (falls back to text).
 *
 * SPEECH RECOGNITION: the Web Speech API (webkitSpeechRecognition) is used
 * for the visitor's mic-to-text leg — it is what the browser already has, no
 * new provider, and D-ID's own widget also relies on browser-mediated
 * transcription for its "what did the visitor say" leg. Unsupported browsers
 * fall back to the on-screen text composer, which is always available.
 */

import { useEffect, useRef, useState, useCallback } from "react"
// The SDK's own event vocabulary (its dist/Events.d.ts is not re-exported
// from the package index, hence the deep type-only path) — a renamed or
// dropped event is a compile error here, not a silent no-op.
import type { SimliClientEvents } from "simli-client/dist/Events"

type SimliEvent = keyof SimliClientEvents
import { Loader2, Mic, MicOff, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"

export interface SimliFaceSessionProps {
  sessionToken: string
  faceId: string
  liveSessionId: string | null
  /** Portal: the contact talking. Embed/site pre-capture: null — pass
   *  embedSessionId instead so /api/live-agent/simli-turn can still resolve
   *  brokerage/FAQ context for an anonymous visitor. */
  contactId?: string | null
  embedSessionId?: string | null
  agentFirstName?: string
  /** URLs the metering beacons post to — provider-agnostic
   *  (lib/did/live-session-metering.ts operates purely on liveSessionId), so
   *  the host passes its own surface's existing routes rather than this
   *  component hardcoding one surface. */
  heartbeatUrl: string
  endUrl: string
  onFallbackToText: () => void
}

type Status = "connecting" | "ready" | "thinking" | "speaking" | "error"

interface DisplayMessage {
  role: "user" | "agent"
  text: string
}

const PCM_CHUNK_BYTES = 6000 // documented sweet spot (max 65,536)

export function SimliFaceSession({
  sessionToken, faceId, liveSessionId, contactId, embedSessionId, agentFirstName,
  heartbeatUrl, endUrl, onFallbackToText,
}: SimliFaceSessionProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const clientRef = useRef<InstanceType<typeof import("simli-client/dist/client").SimliClient> | null>(null)
  const recognitionRef = useRef<any>(null)
  const startedAtRef = useRef<number>(Date.now())
  const usageReportedRef = useRef(false)

  const [status, setStatus] = useState<Status>("connecting")
  const [micOn, setMicOn] = useState(false)
  const [inputText, setInputText] = useState("")
  const [messages, setMessages] = useState<DisplayMessage[]>([])

  const fail = useCallback((msg: string) => {
    setStatus("error")
    toast.error(msg)
    setTimeout(onFallbackToText, 1200)
  }, [onFallbackToText])

  // ── Boot the Simli client (dynamic import — see file header) ────────────
  useEffect(() => {
    let cancelled = false

    const boot = async () => {
      try {
        // DEEP PATH, NOT THE PACKAGE INDEX: simli-client@3.0.2's dist/index.js
        // requires "./Client" while the shipped file is dist/client.js — a
        // case mismatch that resolves on macOS and fails on Linux (CI build
        // 2026-09-14: "Module not found: Can't resolve './Client'"). The
        // class module itself has case-correct requires, so it is imported
        // directly; revisit when a simli-client release fixes the index.
        const mod = await import("simli-client/dist/client")
        if (cancelled) return
        if (!videoRef.current || !audioRef.current) return

        const client = new mod.SimliClient(
          sessionToken,
          videoRef.current,
          audioRef.current,
          null, // no ICE list — LiveKit mode needs none
          mod.LogLevel.INFO,
          "livekit",
        )

        client.on("startup_error", (message: string) => {
          console.error("Simli startup_error", message)
          // Documented as TERMINAL (invalid faceId or depleted minutes, no
          // retry) — never retried, straight to the text fail-over.
          fail("Live Agent unavailable — switching to chat")
        })
        // One typed table of the zero-argument events we react to (the
        // SDK's diagnostic events — connection_info, video_info, destination,
        // unknown — carry a payload and are deliberately not surfaced).
        const handlers: Partial<Record<Exclude<SimliEvent, "startup_error">, () => void>> = {
          error: () => fail("Live Agent error — switching to chat"),
          speaking: () => setStatus("speaking"),
          silent: () => setStatus("ready"),
          start: () => setStatus("ready"),
          stop: () => { /* teardown handled by unmount */ },
          ack: () => { /* audio chunk acknowledged — nothing to surface */ },
        }
        for (const [event, cb] of Object.entries(handlers) as Array<[Exclude<SimliEvent, "startup_error">, () => void]>) {
          client.on(event, cb)
        }

        clientRef.current = client
        await client.start()
        if (cancelled) { client.stop(); return }
        setStatus("ready")
      } catch (e) {
        console.error("Simli boot failed (SDK import or session start threw)", e)
        fail("Live Agent unavailable — switching to chat")
      }
    }

    boot()

    return () => {
      cancelled = true
      reportUsage()
      recognitionRef.current?.stop?.()
      clientRef.current?.stop()
      clientRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionToken, faceId])

  useEffect(() => {
    const flush = () => reportUsage()
    window.addEventListener("pagehide", flush)
    return () => window.removeEventListener("pagehide", flush)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function reportUsage() {
    if (usageReportedRef.current || !liveSessionId) return
    usageReportedRef.current = true
    const seconds = Math.round((Date.now() - startedAtRef.current) / 1000)
    if (seconds <= 0) return
    // Portal's /session/end requires contactId (its own access-gate re-check);
    // embed's requires only liveSessionId. Sending both unconditionally is
    // harmless to the embed route (an unused field) and required by the
    // portal one — one body shape for both hosts, no per-surface branch here.
    const body = { liveSessionId, seconds, contactId: contactId ?? undefined }
    const payload = new Blob([JSON.stringify(body)], { type: "application/json" })
    try {
      if (!navigator.sendBeacon(endUrl, payload)) {
        void fetch(endUrl, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body), keepalive: true,
        }).catch(() => {})
      }
    } catch { /* metering must never break the widget */ }
  }

  // ── Heartbeat — same cadence/shape as AgentsWidget/EmbedWidget ──────────
  useEffect(() => {
    if (!liveSessionId) return
    const HEARTBEAT_MS = 2 * 60 * 1000
    const id = setInterval(() => {
      void fetch(heartbeatUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liveSessionId, contactId: contactId ?? undefined }),
      }).catch(() => {})
    }, HEARTBEAT_MS)
    return () => clearInterval(id)
  }, [liveSessionId, heartbeatUrl, contactId])

  // ── One turn: text → brain relay → PCM TTS → sendAudioData ──────────────
  const sendTurn = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || !liveSessionId) return
    setMessages((m) => [...m, { role: "user", text: trimmed }])
    setStatus("thinking")

    try {
      const turnRes = await fetch("/api/live-agent/simli-turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liveSessionId, text: trimmed, embedSessionId: embedSessionId ?? undefined }),
      })
      if (!turnRes.ok) throw new Error(`brain relay failed (${turnRes.status})`)
      const { reply } = (await turnRes.json()) as { reply?: string }
      const replyText = (reply ?? "").trim()
      if (!replyText) { setStatus("ready"); return }
      setMessages((m) => [...m, { role: "agent", text: replyText }])

      // PCM16 mono 16kHz — the SAME ElevenLabs voice clone every other
      // surface speaks in. liveSessionId (lane 63B) lets the route resolve
      // the assigned agent's voice OFF the live_agent_sessions row instead
      // of requiring a Supabase session — the anonymous embed/site visitor
      // leg has none; the portal contact leg is covered by the same branch
      // rather than a second one.
      const ttsRes = await fetch("/api/internal/voice-tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: replyText, format: "pcm_16000", liveSessionId }),
      })
      if (!ttsRes.ok || !ttsRes.body) {
        // Read the refusal reason by name (never silent) — census: route-response-field.
        const { error, code } = await ttsRes.json().catch(() => ({}))
        throw new Error(`voice-tts failed (${ttsRes.status})${error ? `: ${error}` : ""}${code ? ` [${code}]` : ""}`)
      }

      setStatus("speaking")
      const reader = ttsRes.body.getReader()
      let leftover = new Uint8Array(0)
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value) continue
        let buf = new Uint8Array(leftover.length + value.length)
        buf.set(leftover, 0)
        buf.set(value, leftover.length)
        // Chunk to the documented ≤6000-byte sweet spot.
        let offset = 0
        while (buf.length - offset >= PCM_CHUNK_BYTES) {
          clientRef.current?.sendAudioData(buf.slice(offset, offset + PCM_CHUNK_BYTES))
          offset += PCM_CHUNK_BYTES
        }
        leftover = buf.slice(offset)
      }
      if (leftover.length > 0) clientRef.current?.sendAudioData(leftover)
      setStatus("ready")
    } catch (e) {
      console.error("Simli turn failed", e)
      toast.error("Live Agent hiccup — try again or switch to chat")
      setStatus("ready")
    }
  }, [liveSessionId, embedSessionId])

  // ── Mic → browser SpeechRecognition → sendTurn (no new provider) ────────
  function toggleMic() {
    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition
    if (!SpeechRecognitionCtor) {
      toast.error("Voice input isn't supported in this browser — type instead")
      return
    }
    if (micOn) {
      recognitionRef.current?.stop?.()
      setMicOn(false)
      return
    }
    const recognition = new SpeechRecognitionCtor()
    recognition.continuous = false
    recognition.interimResults = false
    recognition.onresult = (e: any) => {
      const said = e.results?.[0]?.[0]?.transcript
      if (said) void sendTurn(said)
    }
    recognition.onerror = () => setMicOn(false)
    recognition.onend = () => setMicOn(false)
    recognitionRef.current = recognition
    recognition.start()
    setMicOn(true)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="relative flex-1 bg-black rounded-lg overflow-hidden min-h-[240px]">
        <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
        <audio ref={audioRef} autoPlay />
        {status === "connecting" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <Loader2 className="h-8 w-8 animate-spin text-white" />
          </div>
        )}
        {status === "thinking" && (
          <div className="absolute bottom-2 left-2 text-xs text-white/80 bg-black/40 rounded px-2 py-1">
            {agentFirstName ?? "Agent"} is thinking…
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 py-2 min-h-[80px]">
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
            <span className="inline-block rounded-lg px-3 py-1.5 text-sm bg-muted">{m.text}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 pt-2 border-t">
        <Button type="button" variant={micOn ? "default" : "outline"} size="icon" onClick={toggleMic} aria-label={micOn ? "Stop microphone" : "Start microphone"}>
          {micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
        </Button>
        <Input
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && inputText.trim()) {
              void sendTurn(inputText)
              setInputText("")
            }
          }}
          placeholder="Type a message…"
          disabled={status === "connecting"}
        />
        <Button
          type="button" size="icon"
          disabled={!inputText.trim() || status === "connecting"}
          onClick={() => { void sendTurn(inputText); setInputText("") }}
          aria-label="Send"
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
