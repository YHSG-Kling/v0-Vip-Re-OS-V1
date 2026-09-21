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
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import * as didSdk from "@d-id/client-sdk"
import { Loader2, Send, Video, MessageSquare, X, Mic, MicOff } from "lucide-react"
import {
  usableModes, initialMode, MODE_COPY, type EmbedMode, type UsableMode,
} from "@/lib/embed/widget-modes"
import type { DidPresenterType } from "@/lib/did/agent-presenter"
import { SimliFaceSession } from "@/app/components/features/ai-avatar-chat/SimliFaceSession"
import { ProspectChat } from "@/app/get-started/prospect-chat"
import { splitDemoClipToken } from "@/lib/platform/product-demo"

/** The brokerage-slug/agent handle app/api/embed/session returns on every
 *  response (success AND failure) — everything /api/widget/session needs to
 *  mint the EXISTING text-chat door (§3.3 fail-over). Null brokerageSlug
 *  means no fallback could be resolved (brokerage row unreadable) — see
 *  EmbedTextFallback's own guard. */
interface FailoverHandle {
  brokerageSlug: string | null
  agentId: string | null
}

/**
 * WHICH DEPLOYMENT this widget serves (lane 77B — "the platform should also
 * offer the same ai agents like the live agent using d-id"). ONE component,
 * ONE D-ID SDK plumbing (createAgentManager / mic / mode switch / metering
 * beacons), two doors:
 *   tenant   — /embed/[publicId] in an iframe: mints through /api/embed/session,
 *              prefixes the embedSessionId + contactId markers, runs the
 *              broker's lead-capture form, fails over to the tenant text widget.
 *   platform — mounted INLINE on /get-started and /demo: mints through
 *              /api/platform/live-agent/session, prefixes the
 *              platformLiveSessionId marker, has NO capture form (the agent's
 *              own save_prospect tool captures), and fails over to the platform
 *              text prospect chat (the same brain in text). The heartbeat/end
 *              beacons are the SAME id-keyed routes for both.
 */
export type EmbedDeployment = "tenant" | "platform"

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
  /** Defaults to "tenant". */
  deployment?: EmbedDeployment
  /** Inline (platform) mount: called on the close button instead of postMessage. */
  onClose?: () => void
}

interface DisplayMessage {
  role: "user" | "agent"
  text: string
}

const CTX_PREFIX_RE = /\[\[CTX:(contactId|embedSessionId|platformLiveSessionId)=[0-9a-f-]{36}\]\]\s*/gi

export function EmbedWidget(props: Props) {
  const {
    publicId, visitorId, origin, referrer, pageUrl, welcomeMessage,
    enabledModes, leadCaptureMode, leadCaptureFields, label,
  } = props
  const deployment: EmbedDeployment = props.deployment ?? "tenant"
  const isPlatform = deployment === "platform"
  // A pre-rendered sample clip the PLATFORM agent asked to play (the
  // [[CLIP:url]] token from show_product_demo — lib/platform/product-demo.ts).
  // Never rendered per conversation; a URL the platform already paid for once.
  const [demoClipUrl, setDemoClipUrl] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const managerRef = useRef<didSdk.AgentManager | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  // TWO markers, sent independently the first time each becomes true — see
  // /api/did/custom-llm's header. Before this, NOTHING was sent until after
  // lead capture, and /api/did/custom-llm REQUIRED a contactId marker on every
  // turn: an anonymous visitor's very first message always 400'd, so
  // "after_first_message" capture mode could never even reach the point where
  // it opens the capture form (chat() threw first). The embedSessionId marker
  // gives the brain a tenant to answer from — brokerage FAQ/knowledge base,
  // never contact-specific data — for every visitor from message one.
  const sessionMarkerSentRef = useRef(false)
  const ctxMarkerSentRef = useRef(false)

  type Phase = "boot" | "ready" | "capturing" | "closed"
  const [phase, setPhase] = useState<Phase>("boot")
  const [bootError, setBootError] = useState<string | null>(null)
  // wave 60 §3.3 — the text-chat door to fall back to when D-ID never comes
  // up at all. Set from EVERY /api/embed/session response (success or
  // failure) so a MID-session drop (onConnectionStateChange/onError, after a
  // successful mint) still has a fallback ready.
  const [failoverHandle, setFailoverHandle] = useState<FailoverHandle | null>(null)
  // wave 60 §3.1 — this session's live_agent_sessions row id (m624), for the
  // heartbeat/end beacons below. Embed had NO minute-level metering at all
  // before this pass.
  const liveSessionIdRef = useRef<string | null>(null)
  const liveSinceRef = useRef<number | null>(null)
  const liveSecondsRef = useRef(0)
  const usageReportedRef = useRef(false)
  const [mode, setMode] = useState<EmbedMode>("text")
  // The presenter FAMILY the session actually minted. Voice is Expressive (V4)
  // only, so this decides what the visitor may be offered — the server already
  // returns it and the widget used to drop it on the floor.
  const [modes, setModes] = useState<UsableMode[]>([])
  type MicState = "off" | "starting" | "on" | "denied" | "no-device" | "unsupported"
  const [micState, setMicState] = useState<MicState>("off")
  const micStreamRef = useRef<MediaStream | null>(null)
  const [contactId, setContactId] = useState<string | null>(null)
  // wave 62 — the BACKUP face-render leg (lib/live-agent/face-render.ts). Set
  // only when D-ID's own init already failed server-side and Simli minted a
  // session token instead; the D-ID SDK path below is never reached for this
  // boot when this is set.
  const [simliSession, setSimliSession] = useState<{ sessionToken: string; faceId: string; liveSessionId: string | null; embedSessionId: string | null } | null>(null)
  // Mirrors simliSession for the heartbeat interval below (mounted once with
  // `[]` deps, before boot() resolves — a ref reads fresh, state in that
  // closure would not).
  const simliSessionRef = useRef(false)
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
        const res = await fetch(isPlatform ? "/api/platform/live-agent/session" : "/api/embed/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(isPlatform ? { visitorId, origin, pageUrl } : { publicId, visitorId, origin, referrer, pageUrl }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { error?: string; fallback?: FailoverHandle }
          if (!cancelled) setFailoverHandle(err.fallback ?? null)
          setBootError(err.error ?? "Couldn't start the chat")
          return
        }
        const data = await res.json() as {
          provider?: "simli"
          sessionToken?: string
          faceId?: string
          didAgentId: string; clientKey: string; sessionId: string
          presenterType?: DidPresenterType
          liveSessionId?: string | null
          fallback?: FailoverHandle
        }
        if (!cancelled) setFailoverHandle(data.fallback ?? null)

        // ── FACE-RENDER FAIL-OVER (wave 62): D-ID already failed server-side
        // and the session door minted a Simli session instead. Mount
        // SimliFaceSession and STOP — the D-ID SDK path below
        // (createAgentManager onward) is never reached for this boot. ──────
        if (data.provider === "simli" && data.sessionToken && data.faceId) {
          if (cancelled) return
          sessionIdRef.current = data.sessionId ?? null
          liveSessionIdRef.current = data.liveSessionId ?? null
          simliSessionRef.current = true
          setSimliSession({
            sessionToken: data.sessionToken, faceId: data.faceId,
            liveSessionId: data.liveSessionId ?? null, embedSessionId: data.sessionId ?? null,
          })
          setPhase("ready")
          return
        }

        const { didAgentId, clientKey, sessionId, presenterType, liveSessionId } = data
        sessionIdRef.current = sessionId
        liveSessionIdRef.current = liveSessionId ?? null

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
          const startMode = initialMode(resolved)
          setMode(startMode)
          if (startMode !== "text") liveSinceRef.current = Date.now()
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
                .map((m): DisplayMessage => {
                  const raw = stripContext(extractText(m))
                  if (!isPlatform || m.role !== "assistant") return { role: m.role === "user" ? "user" : "agent", text: raw }
                  const { text, clipUrl } = splitDemoClipToken(raw)
                  if (clipUrl) setDemoClipUrl(clipUrl)
                  return { role: "agent", text }
                })
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

        // Immediate-capture mode opens the form right after connect. The
        // PLATFORM deployment never runs the capture form — the agent's own
        // save_prospect tool captures, in conversation.
        if (leadCaptureMode === "immediate" && !isPlatform) setPhase("capturing")
      } catch (e) {
        console.error(e)
        setBootError("Couldn't start the chat")
      }
    })()
    return () => {
      cancelled = true
      reportLiveUsage()
      micStreamRef.current?.getTracks().forEach((t) => t.stop())
      micStreamRef.current = null
      managerRef.current?.disconnect().catch(() => {})
      managerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicId, visitorId, origin, referrer, pageUrl, welcomeMessage, leadCaptureMode, deployment])

  // Flush the live-minute report if the tab/iframe closes mid-session — the
  // SAME pattern AgentsWidget.tsx uses for the portal door.
  useEffect(() => {
    const flush = () => reportLiveUsage()
    window.addEventListener("pagehide", flush)
    return () => window.removeEventListener("pagehide", flush)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Accumulate any open voice/live window and beacon total seconds once. */
  function reportLiveUsage() {
    if (liveSinceRef.current !== null) {
      liveSecondsRef.current += (Date.now() - liveSinceRef.current) / 1000
      liveSinceRef.current = null
    }
    const seconds = Math.round(liveSecondsRef.current)
    const sid = liveSessionIdRef.current
    if (seconds <= 0 || usageReportedRef.current || !sid) return
    usageReportedRef.current = true
    const payload = new Blob([JSON.stringify({ liveSessionId: sid, seconds })], { type: "application/json" })
    try {
      if (!navigator.sendBeacon("/api/embed/session/end", payload)) {
        void fetch("/api/embed/session/end", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ liveSessionId: sid, seconds }), keepalive: true,
        }).catch(() => {})
      }
    } catch { /* metering must never break the widget */ }
  }

  // Heartbeat — proof of life for the cron sweeper (lib/did/live-session-
  // metering.ts sweepStaleLiveAgentSessions). Same 2min cadence as the portal
  // door.
  useEffect(() => {
    const id = setInterval(() => {
      const sid = liveSessionIdRef.current
      // Simli path heartbeats itself (SimliFaceSession, same url/shape) —
      // skip here so one boot never double-beacons the same liveSessionId.
      if (!sid || simliSessionRef.current) return
      void fetch("/api/embed/session/heartbeat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liveSessionId: sid }),
      }).catch(() => {})
    }, 2 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

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
      // Leaving the burning window — the SAME accumulate-on-exit shape
      // AgentsWidget.tsx uses for the portal's live/text toggle.
      if (liveSinceRef.current !== null) {
        liveSecondsRef.current += (Date.now() - liveSinceRef.current) / 1000
        liveSinceRef.current = null
      }
    } else {
      m.changeMode(didSdk.ChatMode.Functional)
      if (liveSinceRef.current === null) liveSinceRef.current = Date.now()
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
      leadCaptureMode === "after_first_message" && !contactId && !isPlatform
    // Markers are sent ONCE each, then ride along in D-ID's own message
    // history — never resent, never dropped. The PLATFORM deployment sends
    // ONLY its own marker (the platform metering row id) — never a contact
    // or embed marker, which /api/did/custom-llm would refuse as conflicting.
    const markers: string[] = []
    if (!sessionMarkerSentRef.current && sessionIdRef.current) {
      markers.push(isPlatform
        ? `[[CTX:platformLiveSessionId=${sessionIdRef.current}]]`
        : `[[CTX:embedSessionId=${sessionIdRef.current}]]`)
      sessionMarkerSentRef.current = true
    }
    if (contactId && !ctxMarkerSentRef.current && !isPlatform) {
      markers.push(`[[CTX:contactId=${contactId}]]`)
      ctxMarkerSentRef.current = true
    }
    const payload = markers.length ? `${markers.join(" ")} ${t}` : t
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
    // Inline (platform) mount: the parent component owns the open/closed
    // state; the tenant iframe tells its loader script instead.
    if (props.onClose) { props.onClose(); return }
    window.parent.postMessage({ type: "vipagent.close" }, "*")
  }

  // ── UI ───────────────────────────────────────────────────────────────────
  const colorBg = props.style?.bubble_color ?? "#0066ff"
  const colorFg = props.style?.text_color ?? "#ffffff"
  // The tenant widget fills its iframe; the platform mount is an inline card.
  const frameClass = isPlatform ? "flex flex-col h-[560px] rounded-lg border overflow-hidden bg-white" : "flex flex-col h-screen bg-white"

  // ── PLATFORM FAILOVER — the SAME brain in text (never a dead button) ─────
  // The D-ID leg never came up (or dropped): mount the EXISTING platform text
  // prospect chat (app/get-started/prospect-chat.tsx → /api/platform/prospect-
  // chat) in place of the avatar, with a one-line notice. The tenant fail-over
  // (EmbedTextFallback below) needs a brokerage slug; the platform has none —
  // its text door is the prospect chat itself.
  if (bootError && isPlatform) {
    return (
      <div className={frameClass}>
        <div className="flex items-center justify-between px-4 py-3" style={{ background: colorBg, color: colorFg }}>
          <div className="font-semibold text-sm truncate">{label}</div>
          <button onClick={close} aria-label="Close" className="hover:opacity-80"><X className="h-4 w-4" /></button>
        </div>
        <div className="px-3 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-800">{bootError} — you can still chat with the assistant here.</div>
        <div className="p-3 overflow-y-auto"><ProspectChat brandName={label} /></div>
      </div>
    )
  }

  // The mic status, in the visitor's words. Each state has a DIFFERENT fix and
  // one shared "microphone problem" message would send them to the wrong place.
  const micHint =
    micState === "on" ? "Listening — just talk."
    : micState === "starting" ? "Starting your microphone…"
    : micState === "denied" ? "Microphone blocked. Allow it in your browser, or switch to Type."
    : micState === "no-device" ? "No microphone found. Switch to Type and we'll answer there."
    : micState === "unsupported" ? "This agent can't take voice yet — switch to Type."
    : "Tap Talk to start speaking."

  // ── D-ID FAILOVER (wave 60 §3.3) — never a dead button ──────────────────
  // The D-ID leg never came up (or dropped) AND we have a real text-chat
  // handle to fall back to: mount the EXISTING widget text-chat surface
  // (/api/widget/message, the same one app/widget/[brokerageSlug] uses) in
  // place of the broken avatar UI, with a one-line notice. When brokerageSlug
  // could not be resolved either (brokerage row unreadable), there is
  // nothing to fall back to — the composer stays disabled with bootError's
  // message, an honest "unresolved" rather than a fabricated door.
  if (bootError && failoverHandle?.brokerageSlug) {
    return (
      <EmbedTextFallback
        brokerageSlug={failoverHandle.brokerageSlug}
        agentId={failoverHandle.agentId}
        label={label}
        colorBg={colorBg}
        colorFg={colorFg}
        notice={`${bootError} — you can still chat with us here.`}
        onClose={close}
      />
    )
  }

  // wave 62 face-render fail-over — D-ID already failed server-side and this
  // boot is running the BACKUP leg entirely; none of the D-ID SDK state/UI
  // below this point (manager, mode switcher, lead capture) is relevant to
  // it this wave — the visitor still gets a working live face, just via
  // Simli instead of D-ID.
  if (simliSession) {
    return (
      <div className="flex flex-col h-screen bg-white">
        <div className="flex items-center justify-between px-4 py-3" style={{ background: colorBg, color: colorFg }}>
          <div className="font-semibold text-sm truncate">{label}</div>
          <button onClick={close} aria-label="Close" className="hover:opacity-80">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 p-2 min-h-0">
          <SimliFaceSession
            sessionToken={simliSession.sessionToken}
            faceId={simliSession.faceId}
            liveSessionId={simliSession.liveSessionId}
            contactId={contactId}
            embedSessionId={simliSession.embedSessionId}
            heartbeatUrl="/api/embed/session/heartbeat"
            endUrl="/api/embed/session/end"
            onFallbackToText={() => {
              if (failoverHandle?.brokerageSlug) setBootError("Live Agent unavailable")
              else close()
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className={frameClass}>
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

      {/* Sample clip the PLATFORM agent asked to play (show_product_demo) */}
      {isPlatform && demoClipUrl && (
        <div className="border-t bg-black">
          <video src={demoClipUrl} controls autoPlay playsInline className="w-full max-h-48 object-contain" />
          <button type="button" onClick={() => setDemoClipUrl(null)} className="w-full text-[11px] text-white/80 py-1 hover:text-white">hide sample</button>
        </div>
      )}

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

// ─── D-ID failover: the SAME text-chat door as /widget/[brokerageSlug] ─────

/**
 * EmbedTextFallback — wave 60 §3.3 ("the UI must open the existing text chat
 * for the same brain … automatically … never a dead button"). Mounted ONLY
 * when the D-ID leg never came up. Mints its own widget_session_token via
 * /api/widget/session (the SAME public-tenant resolver
 * lib/widget/resolve-widget-tenant.ts every /widget/[brokerageSlug] visitor
 * goes through) and streams through /api/widget/message — not a second,
 * hand-rolled brain: the identical text surface a visitor would get by
 * loading the plain-text widget directly, just mounted inline here instead
 * of making them notice anything broke.
 */
function EmbedTextFallback(props: {
  brokerageSlug: string
  agentId: string | null
  label: string
  colorBg: string
  colorFg: string
  notice: string
  onClose: () => void
}) {
  const { brokerageSlug, agentId, label, colorBg, colorFg, notice, onClose } = props
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [input, setInput] = useState("")
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/widget/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brokerage_slug: brokerageSlug, agent_id: agentId, source: "embed_did_failover" }),
        })
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) {
          // Both the D-ID leg AND its text fallback failed — the visitor must
          // see SOMETHING rather than a chat box that silently never sends.
          setSessionError(data.error ?? "Chat is unavailable right now.")
          return
        }
        setSessionToken(data.session_token)
      } catch {
        if (!cancelled) setSessionError("Chat is unavailable right now.")
      }
    })()
    return () => { cancelled = true }
  }, [brokerageSlug, agentId])

  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/widget/message",
      prepareSendMessagesRequest: ({ messages: msgs }) => ({
        body: { messages: msgs, session_token: sessionToken },
      }),
    }),
  })

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }) }, [messages])

  const send = useCallback(() => {
    const t = input.trim()
    if (!t || !sessionToken || status === "streaming" || status === "submitted") return
    sendMessage({ text: t })
    setInput("")
  }, [input, sessionToken, status, sendMessage])

  return (
    <div className="flex flex-col h-screen bg-white">
      <div className="flex items-center justify-between px-4 py-3" style={{ background: colorBg, color: colorFg }}>
        <div className="font-semibold text-sm truncate">{label}</div>
        <button onClick={onClose} aria-label="Close" className="hover:opacity-80">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="px-3 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-800">{notice}</div>
      {sessionError && (
        <div className="px-3 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700">{sessionError}</div>
      )}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {messages.map((m) => {
          const text = m.parts?.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("") ?? ""
          if (!text) return null
          return (
            <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <p
                className={`text-sm rounded-lg px-3 py-2 max-w-[80%] ${m.role === "user" ? "text-white" : "bg-gray-100 text-gray-900"}`}
                style={m.role === "user" ? { background: colorBg } : undefined}
              >
                {text}
              </p>
            </div>
          )
        })}
        <div ref={messagesEndRef} />
      </div>
      <form onSubmit={(e) => { e.preventDefault(); send() }} className="border-t flex items-center gap-2 p-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          className="flex-1 px-3 py-2 rounded-md border border-gray-200 text-sm focus:outline-none focus:border-gray-400"
          disabled={!sessionToken}
        />
        <button
          type="submit"
          disabled={!input.trim() || !sessionToken}
          className="rounded-md p-2 disabled:opacity-50"
          style={{ background: colorBg, color: colorFg }}
          aria-label="Send"
        >
          <Send className="h-4 w-4" />
        </button>
      </form>
    </div>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────────

function extractText(m: { content?: unknown }): string {
  return typeof m.content === "string" ? m.content : ""
}
function stripContext(t: string): string {
  return t.replace(CTX_PREFIX_RE, "").trim()
}
