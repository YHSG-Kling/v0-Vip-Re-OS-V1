"use client"

/**
 * AgentsWidget — the real-time conversational avatar the contact talks to in
 * their portal, using:
 *
 *   • the agent's trained presenter (did_avatar_id) as the visual
 *   • the agent's ElevenLabs voice clone as the voice
 *   • our /api/did/custom-llm as the brain (so brand voice + persona +
 *     contact context + compliance all stay in our code)
 *
 * ── WHAT THIS USED TO BE, AND WHY THAT MATTERED ─────────────────────────────
 * A text chat with a face on it — and, worse, a text chat with a face that
 * CLAIMED to be more. The mic button was permanently `disabled` with the
 * tooltip "Voice in: built into Talk live mode", and the empty state told the
 * contact to "Tap the mic or type". Neither was true: nothing in this component
 * ever opened a microphone. A seller tapping that mic got silence and concluded
 * the product was broken, which is the same defect this OS keeps producing —
 * an affordance that describes a capability the code does not have.
 *
 * The SDK does have it. @d-id/client-sdk v2 exposes publishMicrophoneStream,
 * unpublishMicrophoneStream, interrupt() and onAgentActivityStateChange, and
 * none of them were called. So the widget now actually:
 *
 *   1. PUBLISHES THE MICROPHONE. Real getUserMedia audio goes to D-ID, which
 *      transcribes it and answers — the contact talks, the avatar talks back.
 *   2. LETS THE CONTACT INTERRUPT. A person who has heard enough talks over
 *      you; an avatar that keeps going for another twenty seconds reads as a
 *      recording, not a conversation. interrupt() needs a FLUENT stream, so
 *      streamOptions.fluent is now requested — without it the SDK's
 *      getIsInterruptAvailable() is false and the button would be another lie.
 *   3. REPORTS ITS STATE FROM THE SDK, not from a guess. Status used to be
 *      inferred from whether a message arrived as "partial"; the SDK publishes
 *      AgentActivityState (IDLE / LOADING / TALKING / TOOL_ACTIVE) directly.
 *
 * ── EVERY AFFORDANCE IS FEATURE-DETECTED ────────────────────────────────────
 * publishMicrophoneStream and unpublishMicrophoneStream are OPTIONAL on the
 * AgentManager interface — the SDK documents them as "supported only for
 * livekit manager" — and interrupt only works on a fluent stream with an active
 * video. So both are probed at runtime, and when a capability is absent the UI
 * SAYS SO instead of showing a dead control. That is the rule the old mic
 * button broke.
 *
 * Per-session contact context is injected by prefixing the first user message
 * with `[[CTX:contactId=<uuid>]]`. The custom-LLM route extracts and strips it.
 * D-ID Agents does not expose per-session metadata of its own.
 */

import { useEffect, useRef, useState, useCallback } from "react"
import { Loader2, Mic, MicOff, Send, Video, MessageSquare, Square } from "lucide-react"
import * as didSdk from "@d-id/client-sdk"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"

interface AgentsWidgetProps {
  contactId: string
  agentFirstName: string
  onFallbackToText: () => void
}

type Status = "connecting" | "ready" | "thinking" | "speaking" | "error"
type Mode = "text" | "live"
/** Why the mic is in the state it is in — the contact is told which. */
type MicState = "off" | "starting" | "on" | "unsupported" | "denied" | "no-device"

interface DisplayMessage {
  role: "user" | "agent"
  text: string
}

const CTX_PREFIX_RE = /\[\[CTX:contactId=[0-9a-f-]{36}\]\]\s*/i

export function AgentsWidget({ contactId, agentFirstName, onFallbackToText }: AgentsWidgetProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const managerRef = useRef<didSdk.AgentManager | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const ctxMarkerSentRef = useRef(false)
  // Minute metering: avatar minutes only burn in LIVE mode. Track when live
  // mode started + accumulate elapsed seconds; report once on teardown via
  // sendBeacon so the server can log live_avatar_minutes (the session-start
  // route's per-session counter stays the abuse hard-cap).
  const liveSinceRef = useRef<number | null>(null)
  const liveSecondsRef = useRef(0)
  const didAgentIdRef = useRef<string | null>(null)
  const usageReportedRef = useRef(false)

  const [status, setStatus] = useState<Status>("connecting")
  const [mode, setMode] = useState<Mode>("text")
  const [micState, setMicState] = useState<MicState>("off")
  const [canInterrupt, setCanInterrupt] = useState(false)
  const [inputText, setInputText] = useState("")
  const [messages, setMessages] = useState<DisplayMessage[]>([])

  // ── Boot D-ID Agents session ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    const boot = async () => {
      try {
        // 1. Mint a session — server returns { didAgentId, clientKey }
        const res = await fetch("/api/did/agents/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactId }),
        })

        if (!res.ok) {
          fail("Live Agent unavailable — switching to chat")
          return
        }

        const { didAgentId, clientKey } = (await res.json()) as {
          didAgentId: string
          clientKey: string
        }

        if (cancelled) return
        didAgentIdRef.current = didAgentId

        // 2. Build the manager with our callbacks
        const manager = await didSdk.createAgentManager(didAgentId, {
          auth: { type: "key", clientKey },
          // Default to TextOnly so we don't burn avatar minutes until the
          // contact taps "Talk live". changeMode() can flip it any time.
          mode: didSdk.ChatMode.TextOnly,
          // Tag the session with contactId for D-ID-side analytics
          externalId: contactId,
          streamOptions: {
            // FLUENT IS THE PRECONDITION FOR BARGE-IN. The SDK documents
            // interrupt() as "only available for Fluent streams", so without
            // this the interrupt control could never appear and a contact who
            // has heard enough would have to sit through the rest.
            fluent: true,
          },
          callbacks: {
            onSrcObjectReady: (srcObject) => {
              if (videoRef.current) videoRef.current.srcObject = srcObject
            },
            onConnectionStateChange: (state) => {
              if (
                state === didSdk.ConnectionState.Disconnected ||
                state === didSdk.ConnectionState.Fail ||
                state === didSdk.ConnectionState.Closed
              ) {
                fail("Connection lost — switching to chat")
              } else if (state === didSdk.ConnectionState.Connected) {
                setStatus("ready")
              }
            },
            // THE SDK'S OWN STATE, not our inference from message types. IDLE /
            // LOADING / TALKING is exactly the three-way distinction the UI
            // needs, and reading it directly means "thinking" and "speaking"
            // stop being guesses that drift out of sync with the avatar.
            onAgentActivityStateChange: (state) => {
              if (state === didSdk.AgentActivityState.Talking) setStatus("speaking")
              else if (
                state === didSdk.AgentActivityState.Loading ||
                state === didSdk.AgentActivityState.ToolActive
              ) setStatus("thinking")
              else setStatus("ready")
            },
            // Whether a barge-in is possible RIGHT NOW. Driving the button off
            // this rather than off our own idea of "is it talking" is what
            // keeps the control from being pressable when it would do nothing.
            onInterruptibleChange: (interruptible: boolean) => setCanInterrupt(!!interruptible),
            onNewMessage: (msgs, type) => {
              // Map D-ID's message stream into our display state. Strip the
              // hidden context marker so it never reaches the user. This
              // includes messages D-ID TRANSCRIBED from the microphone, which
              // is how spoken turns appear in the transcript at all.
              const display: DisplayMessage[] = msgs
                .filter((m) => m.role === "user" || m.role === "assistant")
                .map((m): DisplayMessage => ({
                  role: m.role === "user" ? "user" : "agent",
                  text: stripContextMarker(extractText(m)),
                }))
                .filter((m) => m.text.length > 0)
              setMessages(display)
              if (type === "answer") setStatus("ready")
            },
            onError: (err) => {
              console.error("D-ID Agents error", err)
              fail("Live Agent error — switching to chat")
            },
          },
        })

        if (cancelled) {
          await manager.disconnect().catch(() => {})
          return
        }

        managerRef.current = manager
        await manager.connect()
        // Probe once connected — before connect, the stream type is unknown.
        setCanInterrupt(safeIsInterruptAvailable(manager))
        setMicState(typeof manager.publishMicrophoneStream === "function" ? "off" : "unsupported")
        setStatus("ready")
      } catch (e) {
        console.error("D-ID Agents boot failed", e)
        fail("Live Agent unavailable — switching to chat")
      }
    }

    boot()

    return () => {
      cancelled = true
      reportLiveUsage()
      stopMicTracks()
      managerRef.current?.unpublishMicrophoneStream?.().catch(() => {})
      managerRef.current?.disconnect().catch(() => {})
      managerRef.current = null
      ctxMarkerSentRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId])

  // Flush the live-minute report if the tab closes mid-session.
  useEffect(() => {
    const flush = () => reportLiveUsage()
    window.addEventListener("pagehide", flush)
    return () => window.removeEventListener("pagehide", flush)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Accumulate any open live window and beacon total live seconds once. */
  function reportLiveUsage() {
    if (liveSinceRef.current !== null) {
      liveSecondsRef.current += (Date.now() - liveSinceRef.current) / 1000
      liveSinceRef.current = null
    }
    const seconds = Math.round(liveSecondsRef.current)
    if (seconds <= 0 || usageReportedRef.current) return
    usageReportedRef.current = true
    const payload = new Blob(
      [JSON.stringify({ contactId, didAgentId: didAgentIdRef.current, seconds })],
      { type: "application/json" },
    )
    try {
      if (!navigator.sendBeacon("/api/did/agents/session/end", payload)) {
        void fetch("/api/did/agents/session/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactId, didAgentId: didAgentIdRef.current, seconds }),
          keepalive: true,
        }).catch(() => {})
      }
    } catch {
      /* metering must never break the widget */
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function fail(msg: string) {
    setStatus("error")
    toast.error(msg)
    setTimeout(onFallbackToText, 1200)
  }

  /** Release the OS-level capture so the browser's recording indicator clears. */
  function stopMicTracks() {
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current = null
  }

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || !managerRef.current) return

    // Prefix the very first user turn with the context marker so the
    // custom-LLM endpoint can resolve contact context. D-ID forwards the
    // full message history each turn so once the marker is in the chat
    // history it stays.
    const payload = ctxMarkerSentRef.current
      ? trimmed
      : `[[CTX:contactId=${contactId}]] ${trimmed}`
    ctxMarkerSentRef.current = true

    setInputText("")
    setStatus("thinking")
    try {
      await managerRef.current.chat(payload)
    } catch (e) {
      console.error("chat() failed", e)
      toast.error("Couldn't reach the agent")
      setStatus("ready")
    }
  }, [contactId])

  /** Enter live mode — the avatar speaks, and the meter starts. */
  const enterLive = useCallback(() => {
    const m = managerRef.current
    if (!m || mode === "live") return
    m.changeMode(didSdk.ChatMode.Functional)
    liveSinceRef.current = Date.now()
    setMode("live")
  }, [mode])

  const toggleMode = useCallback(async () => {
    const m = managerRef.current
    if (!m) return
    try {
      if (mode === "text") {
        enterLive()
        return
      }
      // Leaving live: the microphone has no meaning in text mode, and leaving
      // a hot mic open after the avatar has stopped speaking is the kind of
      // thing a contact never forgives.
      await stopMic()
      m.changeMode(didSdk.ChatMode.TextOnly)
      if (liveSinceRef.current !== null) {
        liveSecondsRef.current += (Date.now() - liveSinceRef.current) / 1000
        liveSinceRef.current = null
      }
      setMode("text")
    } catch (e) {
      console.error("changeMode failed", e)
      toast.error("Couldn't switch modes")
    }
  }, [mode, enterLive])

  /**
   * Open the microphone and hand the track to D-ID.
   *
   * Two failures get their own message because they have different fixes and
   * both are common on a first run: a permission denial is fixed in the browser,
   * and no-device-found is fixed by plugging something in. "Microphone failed"
   * would send the contact hunting in the wrong place.
   */
  const startMic = useCallback(async () => {
    const m = managerRef.current
    if (!m) return
    if (typeof m.publishMicrophoneStream !== "function") {
      setMicState("unsupported")
      toast.error("Voice input isn't available on this connection — type instead")
      return
    }
    // Speaking implies live: publishing audio to an avatar that is muted would
    // transcribe the contact into a void.
    enterLive()
    setMicState("starting")
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      micStreamRef.current = stream
      await m.publishMicrophoneStream(stream)
      setMicState("on")
    } catch (e: any) {
      stopMicTracks()
      const name = String(e?.name ?? "")
      if (name === "NotAllowedError" || name === "SecurityError") {
        setMicState("denied")
        toast.error("Microphone permission was blocked — allow it in your browser to talk")
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setMicState("no-device")
        toast.error("No microphone found — type your message instead")
      } else {
        console.error("publishMicrophoneStream failed", e)
        setMicState("off")
        toast.error("Couldn't start the microphone")
      }
    }
  }, [enterLive])

  const stopMic = useCallback(async () => {
    const m = managerRef.current
    try { await m?.unpublishMicrophoneStream?.() } catch { /* releasing must not throw */ }
    stopMicTracks()
    setMicState((s) => (s === "on" || s === "starting" ? "off" : s))
  }, [])

  /**
   * Barge-in. A real conversation lets the other person cut you off; without
   * this the avatar reads as a recording that happens to be listening.
   */
  const interrupt = useCallback(() => {
    const m = managerRef.current
    if (!m || !canInterrupt) return
    try {
      m.interrupt({ type: "click" })
      setStatus("ready")
    } catch (e) {
      console.error("interrupt failed", e)
    }
  }, [canInterrupt])

  // ── UI ───────────────────────────────────────────────────────────────────

  const micUnavailable = micState === "unsupported" || micState === "no-device"
  const micLabel =
    micState === "on" ? "Stop talking"
      : micState === "starting" ? "Starting microphone…"
      : micState === "unsupported" ? "Voice input isn't available on this connection"
      : micState === "denied" ? "Microphone blocked — allow it in your browser"
      : micState === "no-device" ? "No microphone found"
      : "Talk to " + agentFirstName

  return (
    <div className="flex flex-col" style={{ height: 420 }}>
      {/* Video pane */}
      <div className="relative bg-black flex items-center justify-center" style={{ height: 220 }}>
        {status === "connecting" && (
          <div className="flex flex-col items-center gap-2 text-white">
            <Loader2 className="h-8 w-8 animate-spin" />
            <span className="text-xs">Connecting to {agentFirstName}…</span>
          </div>
        )}
        {status === "error" && <p className="text-white text-xs">Redirecting to chat…</p>}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className={`absolute inset-0 w-full h-full object-cover ${
            status === "connecting" ? "opacity-0" : "opacity-100"
          }`}
        />
        {mode === "live" && (status === "speaking" || status === "thinking") && (
          <div className="absolute bottom-2 left-2 bg-black/60 text-white text-xs rounded px-2 py-1">
            {status === "speaking" ? `${agentFirstName} is responding…` : `${agentFirstName} is thinking…`}
          </div>
        )}
        {/* Barge-in — shown only while the stream actually accepts one. */}
        {mode === "live" && status === "speaking" && canInterrupt && (
          <button
            onClick={interrupt}
            className="absolute bottom-2 right-2 bg-white/90 text-black text-xs rounded-full px-3 py-1 flex items-center gap-1.5 hover:bg-white"
          >
            <Square className="h-3 w-3" /> Stop
          </button>
        )}
        {micState === "on" && (
          <span className="absolute top-2 left-2 flex items-center gap-1.5 bg-red-600/90 text-white text-xs rounded-full px-2.5 py-1">
            <span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" /> Listening
          </span>
        )}
        {/* Mode toggle — only enabled once connected */}
        {status !== "connecting" && status !== "error" && (
          <button
            onClick={toggleMode}
            className="absolute top-2 right-2 bg-black/60 text-white text-xs rounded-full px-3 py-1 flex items-center gap-1.5 hover:bg-black/80"
          >
            {mode === "text" ? (
              <>
                <Video className="h-3.5 w-3.5" /> Talk live
              </>
            ) : (
              <>
                <MessageSquare className="h-3.5 w-3.5" /> Text mode
              </>
            )}
          </button>
        )}
      </div>

      {/* Transcript */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
        {messages.length === 0 && status !== "connecting" && status !== "error" && (
          <p className="text-xs text-muted-foreground text-center py-2">
            {micUnavailable
              ? `Type to chat with ${agentFirstName}`
              : mode === "live"
                ? `Tap the mic to talk, or type — ${agentFirstName} answers out loud`
                : `Type to chat, or tap the mic to talk with ${agentFirstName}`}
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <p
              className={`text-xs rounded-lg px-3 py-1.5 max-w-[80%] ${
                m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
              }`}
            >
              {m.text}
            </p>
          </div>
        ))}
      </div>

      {/* Composer */}
      <div className="border-t px-3 py-2 flex gap-2">
        <Input
          className="h-8 text-sm"
          placeholder="Type a message…"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage(inputText)}
          disabled={status === "connecting" || status === "error"}
        />
        {/* THE MIC IS REAL NOW. It was disabled with a tooltip claiming voice
            input was "built into Talk live mode" while nothing here ever opened
            a microphone. It is disabled ONLY when the capability genuinely is
            absent, and the tooltip then says which reason. */}
        <Button
          size="sm"
          variant={micState === "on" ? "default" : "ghost"}
          onClick={() => (micState === "on" ? stopMic() : startMic())}
          disabled={status === "connecting" || status === "error" || micUnavailable || micState === "starting"}
          title={micLabel}
          aria-label={micLabel}
          aria-pressed={micState === "on"}
        >
          {micState === "starting" ? <Loader2 className="h-4 w-4 animate-spin" />
            : micUnavailable || micState === "denied" ? <MicOff className="h-4 w-4" />
            : <Mic className="h-4 w-4" />}
        </Button>
        <Button
          size="sm"
          onClick={() => sendMessage(inputText)}
          disabled={status === "connecting" || status === "error" || !inputText.trim()}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function extractText(message: { content?: string | unknown }): string {
  if (typeof message.content === "string") return message.content
  return ""
}

function stripContextMarker(text: string): string {
  return text.replace(CTX_PREFIX_RE, "").trim()
}

/** getIsInterruptAvailable() is documented but stream-type dependent; a throw
 *  or an absent method must read as "no", never as an enabled dead button. */
function safeIsInterruptAvailable(manager: didSdk.AgentManager): boolean {
  try {
    return typeof manager.getIsInterruptAvailable === "function"
      ? !!manager.getIsInterruptAvailable()
      : false
  } catch {
    return false
  }
}
