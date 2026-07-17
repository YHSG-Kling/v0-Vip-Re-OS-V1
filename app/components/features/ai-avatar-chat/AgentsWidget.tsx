"use client"

/**
 * AgentsWidget — D-ID Agents (real-time conversational avatar) replacement
 * for AvatarChatWidget. Talks to the contact in their portal using:
 *
 *   • the agent's trained presenter (did_avatar_id) as the visual
 *   • the agent's ElevenLabs voice clone as the voice
 *   • our /api/did/custom-llm as the brain (so brand voice + persona +
 *     contact context + compliance all stay in our code)
 *
 * Two modes (toggle without reconnecting):
 *   • Text — cheap, no avatar minutes burned, agent's avatar shows but stays still
 *   • Live — Functional mode: avatar speaks every reply in real time
 *
 * Per-session contact context is injected by prefixing the first user message
 * with `[[CTX:contactId=<uuid>]]`. The custom-LLM route extracts and strips
 * it. D-ID Agents does not expose per-session metadata of its own.
 */

import { useEffect, useRef, useState, useCallback } from "react"
import { Loader2, Mic, Send, Video, MessageSquare } from "lucide-react"
import * as didSdk from "@d-id/client-sdk"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"

interface AgentsWidgetProps {
  contactId: string
  agentFirstName: string
  onFallbackToText: () => void
}

type Status = "connecting" | "ready" | "speaking" | "error"
type Mode = "text" | "live"

interface DisplayMessage {
  role: "user" | "agent"
  text: string
}

const CTX_PREFIX_RE = /\[\[CTX:contactId=[0-9a-f-]{36}\]\]\s*/i

export function AgentsWidget({ contactId, agentFirstName, onFallbackToText }: AgentsWidgetProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const managerRef = useRef<didSdk.AgentManager | null>(null)
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
            onNewMessage: (msgs, type) => {
              // Map D-ID's message stream into our display state. Strip the
              // hidden context marker so it never reaches the user.
              const display: DisplayMessage[] = msgs
                .filter((m) => m.role === "user" || m.role === "assistant")
                .map((m): DisplayMessage => ({
                  role: m.role === "user" ? "user" : "agent",
                  text: stripContextMarker(extractText(m)),
                }))
                .filter((m) => m.text.length > 0)
              setMessages(display)
              if (type === "answer") setStatus("ready")
              if (type === "partial") setStatus("speaking")
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
    setStatus("speaking")
    try {
      await managerRef.current.chat(payload)
    } catch (e) {
      console.error("chat() failed", e)
      toast.error("Couldn't reach the agent")
      setStatus("ready")
    }
  }, [contactId])

  const toggleMode = useCallback(async () => {
    if (!managerRef.current) return
    const next: Mode = mode === "text" ? "live" : "text"
    try {
      managerRef.current.changeMode(
        next === "live" ? didSdk.ChatMode.Functional : didSdk.ChatMode.TextOnly,
      )
      // Meter live-mode time: open the window entering live, close it leaving.
      if (next === "live") {
        liveSinceRef.current = Date.now()
      } else if (liveSinceRef.current !== null) {
        liveSecondsRef.current += (Date.now() - liveSinceRef.current) / 1000
        liveSinceRef.current = null
      }
      setMode(next)
    } catch (e) {
      console.error("changeMode failed", e)
      toast.error("Couldn't switch modes")
    }
  }, [mode])

  // ── UI ───────────────────────────────────────────────────────────────────

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
        {status === "speaking" && mode === "live" && (
          <div className="absolute bottom-2 left-2 bg-black/60 text-white text-xs rounded px-2 py-1">
            {agentFirstName} is responding…
          </div>
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
        {messages.length === 0 && status === "ready" && (
          <p className="text-xs text-muted-foreground text-center py-2">
            {mode === "live"
              ? `Tap the mic or type — ${agentFirstName} will respond live`
              : `Type to chat with ${agentFirstName}`}
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
          disabled={status !== "ready" && status !== "speaking"}
        />
        <Button size="sm" variant="ghost" disabled title="Voice in: built into Talk live mode">
          <Mic className="h-4 w-4" />
        </Button>
        <Button
          size="sm"
          onClick={() => sendMessage(inputText)}
          disabled={(status !== "ready" && status !== "speaking") || !inputText.trim()}
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
