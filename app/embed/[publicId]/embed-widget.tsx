"use client"

/**
 * Public-facing embed widget. Same D-ID Agents SDK plumbing as AgentsWidget
 * but adapted for anonymous visitors:
 *   - mints a session via the public /api/embed/session route
 *   - has built-in lead capture (immediate / after first message / optional)
 *   - on capture, POSTs to /api/embed/capture which creates a contact
 *   - a close button that postMessages back to the parent script
 *
 * No CRM context is injected on first turn — the visitor doesn't have a
 * contactId yet. After capture, subsequent messages prefix the contactId
 * marker so /api/did/custom-llm can pull contact intel like any other turn.
 */

import { useEffect, useRef, useState, useCallback, FormEvent } from "react"
import * as didSdk from "@d-id/client-sdk"
import { Loader2, Send, Video, MessageSquare, X, Mic, MicOff } from "lucide-react"
import {
  usableModes, initialMode, MODE_COPY, type EmbedMode, type UsableMode,
} from "@/lib/embed/widget-modes"
import type { DidPresenterType } from "@/lib/did/agent-presenter"

interface Props {
  publicId: string
  visitorId: string
  origin: string | null
  referrer: string | null
  pageUrl: string | null
  welcomeMessage: string | null
  enabledModes: EmbedMode[]
  leadCaptureMode: "immediate" | "after_first_message" | "optional"
  leadCaptureFields: string[]
  label: string
  style: Record<string, any>
}

interface DisplayMessage {
  role: "user" | "agent"
  text: string
}

const CTX_PREFIX_RE = /\[\[CTX:contactId=[0-9a-f-]{36}\]\]\s*/i

export function EmbedWidget(props: Props) {
  const {
    publicId, visitorId, origin, referrer, pageUrl, welcomeMessage,
    enabledModes, leadCaptureMode, leadCaptureFields, label,
  } = props

  const videoRef = useRef<HTMLVideoElement>(null)
  const managerRef = useRef<didSdk.AgentManager | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const ctxMarkerSentRef = useRef(false)

  type Phase = "boot" | "ready" | "capturing" | "closed"
  const [phase, setPhase] = useState<Phase>("boot")
  const [bootError, setBootError] = useState<string | null>(null)
  const [mode, setMode] = useState<EmbedMode>("text")
  // The presenter FAMILY the session actually minted. Voice is Expressive (V4)
  // only, so this decides what the visitor may be offered — the server already
  // returns it and the widget used to drop it on the floor.
  const [modes, setModes] = useState<UsableMode[]>([])
  type MicState = "off" | "starting" | "on" | "denied" | "no-device" | "unsupported"
  const [micState, setMicState] = useState<MicState>("off")
  const micStreamRef = useRef<MediaStream | null>(null)
  const [contactId, setContactId] = useState<string | null>(null)
  const [messages, setMessages] = useState<DisplayMessage[]>(
    welcomeMessage ? [{ role: "agent", text: welcomeMessage }] : [],
  )
  const [input, setInput] = useState("")

  const modeFor = useCallback(
    (m: EmbedMode) => modes.find((x) => x.mode === m),
    [modes],
  )

  // ── Boot the session ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/embed/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publicId, visitorId, origin, referrer, pageUrl }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          setBootError(err.error ?? "Couldn't start the chat")
          return
        }
        const { didAgentId, clientKey, sessionId, presenterType } = await res.json() as {
          didAgentId: string; clientKey: string; sessionId: string
          presenterType?: DidPresenterType
        }
        sessionIdRef.current = sessionId

        // WHAT THIS VISITOR CAN ACTUALLY DO. The broker's enabled_modes says what
        // was turned on; the minted presenter family says what can run. A mode
        // that is on but cannot run comes back with a REASON and renders
        // disabled — hiding it would make the broker think the setting never
        // saved, and showing it live would be a button that does nothing.
        const resolved = usableModes({
          enabled: enabledModes,
          presenterType: presenterType ?? null,
          browserHasMic:
            typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia,
        })
        if (!cancelled) {
          setModes(resolved)
          setMode(initialMode(resolved))
        }

        if (cancelled) return

        const manager = await didSdk.createAgentManager(didAgentId, {
          auth: { type: "key", clientKey },
          // Functional carries the avatar's audio+video; TextOnly is silent. The
          // widget hard-coded TextOnly, so even a broker who enabled the live
          // avatar got a muted video pane until they found the toggle.
          mode: didSdk.ChatMode.TextOnly,
          externalId: visitorId,
          callbacks: {
            onSrcObjectReady: (src) => { if (videoRef.current) videoRef.current.srcObject = src },
            onConnectionStateChange: (state) => {
              if (
                state === didSdk.ConnectionState.Disconnected ||
                state === didSdk.ConnectionState.Fail ||
                state === didSdk.ConnectionState.Closed
              ) {
                setBootError("Connection lost")
              }
            },
            onNewMessage: (msgs) => {
              const display: DisplayMessage[] = msgs
                .filter((m) => m.role === "user" || m.role === "assistant")
                .map((m): DisplayMessage => ({
                  role: m.role === "user" ? "user" : "agent",
                  text: stripContext(extractText(m)),
                }))
                .filter((m) => m.text.length > 0)
              if (welcomeMessage && display.length === 0) {
                setMessages([{ role: "agent", text: welcomeMessage }])
              } else if (display.length > 0) {
                setMessages(welcomeMessage
                  ? [{ role: "agent", text: welcomeMessage }, ...display]
                  : display)
              }
            },
            onError: () => setBootError("Connection error"),
          },
        })

        if (cancelled) { await manager.disconnect().catch(() => {}); return }
        managerRef.current = manager
        await manager.connect()
        setPhase("ready")

        // Immediate-capture mode opens the form right after connect.
        if (leadCaptureMode === "immediate") setPhase("capturing")
      } catch (e) {
        console.error(e)
        setBootError("Couldn't start the chat")
      }
    })()
    return () => {
      cancelled = true
      micStreamRef.current?.getTracks().forEach((t) => t.stop())
      micStreamRef.current = null
      managerRef.current?.disconnect().catch(() => {})
      managerRef.current = null
    }
  }, [publicId, visitorId, origin, referrer, pageUrl, welcomeMessage, leadCaptureMode])

  // ── Microphone ───────────────────────────────────────────────────────────
  // Released explicitly. A public widget that keeps a visitor's mic open after
  // they switch back to typing is the kind of thing that ends up in a
  // screenshot, so every exit path stops the tracks.
  const stopMicTracks = useCallback(() => {
    micStreamRef.current?.getTracks().forEach((t) => t.stop())
    micStreamRef.current = null
  }, [])

  const stopMic = useCallback(async () => {
    const m = managerRef.current
    try { await m?.unpublishMicrophoneStream?.() } catch { /* releasing must not throw */ }
    stopMicTracks()
    setMicState((st) => (st === "on" || st === "starting" ? "off" : st))
  }, [stopMicTracks])

  /**
   * The failure modes are NAMED, because they have different fixes and a
   * visitor gets one chance to care. A blocked permission is fixed in the
   * browser; no-device is fixed by plugging something in; an avatar family that
   * cannot take audio is not the visitor's problem at all and should send them
   * to the keyboard rather than to their settings.
   */
  const startMic = useCallback(async () => {
    const m = managerRef.current
    if (!m) return
    if (typeof m.publishMicrophoneStream !== "function") {
      setMicState("unsupported")
      return
    }
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
      if (name === "NotAllowedError" || name === "SecurityError") setMicState("denied")
      else if (name === "NotFoundError" || name === "OverconstrainedError") setMicState("no-device")
      else setMicState("off")
    }
  }, [stopMicTracks])

  // ── Switch modes ─────────────────────────────────────────────────────────
  // THREE modes now, not a two-way toggle. text = type; voice = speak and the
  // agent answers aloud in the agent's cloned voice; live = the same, with the
  // twin on camera. voice and live are the SAME SDK mode (Functional — the
  // stream carries audio either way); what differs is whether the visitor's
  // microphone is published and whether the video pane is shown. That is why
  // this is one function and not two lanes: a second lane is how the two public
  // widgets drifted apart in the first place.
  const selectMode = useCallback(async (next: EmbedMode) => {
    const m = managerRef.current
    if (!m) return
    const target = modes.find((x) => x.mode === next)
    if (!target || target.unavailableReason) return
    if (next === "text") {
      await stopMic()
      m.changeMode(didSdk.ChatMode.TextOnly)
    } else {
      m.changeMode(didSdk.ChatMode.Functional)
      if (next === "voice") await startMic()
      else await stopMic()
    }
    setMode(next)
  }, [modes, startMic, stopMic])

  // ── Send message ─────────────────────────────────────────────────────────
  const send = useCallback(async (text: string) => {
    const t = text.trim()
    if (!t || !managerRef.current) return
    setInput("")
    // After-first-message capture mode triggers on the visitor's first message.
    const willCaptureAfterFirst =
      leadCaptureMode === "after_first_message" && !contactId
    // Once we have a contactId, prefix the context marker so the brain has CRM context.
    const payload = contactId && !ctxMarkerSentRef.current
      ? `[[CTX:contactId=${contactId}]] ${t}`
      : t
    if (contactId) ctxMarkerSentRef.current = true
    try {
      await managerRef.current.chat(payload)
    } catch (e) {
      console.error(e)
    }
    if (willCaptureAfterFirst) {
      // Brief delay so the visitor can see the AI start replying before the
      // capture form pops up.
      setTimeout(() => setPhase("capturing"), 1200)
    }
  }, [contactId, leadCaptureMode])

  // ── Lead capture submit ──────────────────────────────────────────────────
  async function submitCapture(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const payload: Record<string, string> = {}
    for (const f of leadCaptureFields) {
      const v = String(formData.get(f) ?? "").trim()
      if (v) payload[f] = v
    }
    if (!sessionIdRef.current) return

    const res = await fetch("/api/embed/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicId,
        sessionId: sessionIdRef.current,
        visitorId,
        ...payload,
      }),
    })
    if (res.ok) {
      const { contactId: newContactId } = await res.json() as { contactId: string }
      setContactId(newContactId)
      setPhase("ready")
    } else {
      // Fail silently — visitor can keep chatting; capture is opportunistic.
      setPhase("ready")
    }
  }

  // ── Close the iframe ─────────────────────────────────────────────────────
  function close() {
    setPhase("closed")
    window.parent.postMessage({ type: "vipagent.close" }, "*")
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  const colorBg = props.style?.bubble_color ?? "#0066ff"
  const colorFg = props.style?.text_color ?? "#ffffff"

  // The mic status, in the visitor's words. Each state has a DIFFERENT fix and
  // one shared "microphone problem" message would send them to the wrong place.
  const micHint =
    micState === "on" ? "Listening — just talk."
    : micState === "starting" ? "Starting your microphone…"
    : micState === "denied" ? "Microphone blocked. Allow it in your browser, or switch to Type."
    : micState === "no-device" ? "No microphone found. Switch to Type and we'll answer there."
    : micState === "unsupported" ? "This agent can't take voice yet — switch to Type."
    : "Tap Talk to start speaking."

  return (
    <div className="flex flex-col h-screen bg-white">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ background: colorBg, color: colorFg }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="font-semibold text-sm truncate">{label}</div>
          {/* MODE SWITCHER. Only rendered when there is a real choice; a mode the
              broker enabled but the runtime cannot deliver renders DISABLED with
              its reason as the tooltip, rather than silently vanishing (which
              reads as a setting that did not save) or appearing live (which is a
              button that does nothing). */}
          {modes.length > 1 && (
            <div className="flex items-center gap-0.5 rounded-full bg-black/15 p-0.5">
              {modes.map((m) => {
                const active = mode === m.mode
                const blocked = !!m.unavailableReason
                const Icon = m.mode === "text" ? MessageSquare : m.mode === "voice" ? Mic : Video
                return (
                  <button
                    key={m.mode}
                    type="button"
                    onClick={() => selectMode(m.mode)}
                    disabled={blocked}
                    title={m.unavailableReason ?? MODE_COPY[m.mode].label}
                    aria-pressed={active}
                    className={`text-xs rounded-full px-2 py-0.5 flex items-center gap-1 transition-colors ${
                      blocked
                        ? "opacity-40 cursor-not-allowed"
                        : active
                          ? "bg-white/90 text-gray-900"
                          : "hover:bg-black/20"
                    }`}
                  >
                    <Icon className="h-3 w-3" />
                    {m.label}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <button onClick={close} aria-label="Close" className="hover:opacity-80">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Video pane */}
      <div className="relative bg-black" style={{ height: 200 }}>
        {phase === "boot" && (
          <div className="absolute inset-0 flex items-center justify-center text-white">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}
        {bootError && (
          <div className="absolute inset-0 flex items-center justify-center text-white text-xs px-4 text-center">
            {bootError}. You can still leave a message and we'll get back to you.
          </div>
        )}
        {/* VOICE keeps the audio and drops the picture. The stream is the same
            Functional stream as live — muting it in voice mode would leave a
            visitor talking to silence, which is what "text-only" already is. */}
        <video ref={videoRef} autoPlay playsInline muted={mode === "text"}
          className={`absolute inset-0 w-full h-full object-cover transition-opacity ${
            mode === "voice" ? "opacity-0" : "opacity-100"
          }`} />
        {mode === "voice" && phase !== "boot" && !bootError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white">
            <div className={`rounded-full p-4 ${micState === "on" ? "bg-white/20 animate-pulse" : "bg-white/10"}`}>
              {micState === "on" ? <Mic className="h-6 w-6" /> : <MicOff className="h-6 w-6" />}
            </div>
            <p className="text-xs px-6 text-center">{micHint}</p>
          </div>
        )}
      </div>

      {/* Transcript */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <p className={`text-sm rounded-lg px-3 py-2 max-w-[80%] ${
              m.role === "user"
                ? "text-white"
                : "bg-gray-100 text-gray-900"
            }`}
              style={m.role === "user" ? { background: colorBg } : undefined}
            >
              {m.text}
            </p>
          </div>
        ))}
      </div>

      {/* Capture form */}
      {phase === "capturing" && (
        <CaptureForm
          fields={leadCaptureFields}
          colorBg={colorBg}
          colorFg={colorFg}
          onSubmit={submitCapture}
          onSkip={leadCaptureMode === "optional" ? () => setPhase("ready") : undefined}
        />
      )}

      {/* Composer */}
      {phase !== "capturing" && (
        <form
          onSubmit={(e) => { e.preventDefault(); send(input) }}
          className="border-t flex items-center gap-2 p-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message…"
            className="flex-1 px-3 py-2 rounded-md border border-gray-200 text-sm focus:outline-none focus:border-gray-400"
            disabled={phase !== "ready"}
          />
          <button
            type="submit"
            disabled={!input.trim() || phase !== "ready"}
            className="rounded-md p-2 disabled:opacity-50"
            style={{ background: colorBg, color: colorFg }}
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>
      )}
    </div>
  )
}

// ─── Lead-capture form ───────────────────────────────────────────────────

const FIELD_META: Record<string, { label: string; type: string; placeholder: string }> = {
  first_name: { label: "Name", type: "text", placeholder: "Your name" },
  last_name:  { label: "Last name", type: "text", placeholder: "Last name" },
  email:      { label: "Email", type: "email", placeholder: "you@example.com" },
  phone:      { label: "Phone", type: "tel", placeholder: "(555) 123-4567" },
}

function CaptureForm({
  fields, colorBg, colorFg, onSubmit, onSkip,
}: {
  fields: string[]
  colorBg: string
  colorFg: string
  onSubmit: (e: FormEvent<HTMLFormElement>) => void
  onSkip?: () => void
}) {
  return (
    <form onSubmit={onSubmit} className="border-t bg-gray-50 px-4 py-3 space-y-2">
      <p className="text-sm font-medium">Quick info so I can follow up</p>
      <p className="text-xs text-gray-500">
        We'll only use this to get back to you about your real estate questions.
      </p>
      {fields.map((f) => {
        const meta = FIELD_META[f] ?? { label: f, type: "text", placeholder: "" }
        return (
          <input
            key={f} name={f} type={meta.type} required={f === "email" || f === "first_name"}
            placeholder={meta.placeholder}
            className="w-full px-3 py-2 rounded-md border border-gray-200 text-sm focus:outline-none focus:border-gray-400"
          />
        )
      })}
      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          className="flex-1 rounded-md py-2 text-sm font-medium"
          style={{ background: colorBg, color: colorFg }}
        >
          Continue
        </button>
        {onSkip && (
          <button type="button" onClick={onSkip} className="text-xs text-gray-500 px-3">
            Skip
          </button>
        )}
      </div>
    </form>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────

function extractText(m: { content?: unknown }): string {
  return typeof m.content === "string" ? m.content : ""
}
function stripContext(t: string): string {
  return t.replace(CTX_PREFIX_RE, "").trim()
}
