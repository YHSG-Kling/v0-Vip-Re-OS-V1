"use client"

/**
 * VoiceAssistantOverlay
 *
 * Track B's primary surface — a voice-first overlay that mounts when the
 * floating mic FAB is short-tapped. Uses ElevenLabs Conversational AI for
 * real-time turn-taking. Tools registered server-side (lib/elevenlabs/conv-ai)
 * fire back to /api/agent-assistant/tool-call so the assistant can act on
 * the agent's CRM without leaving the conversation.
 *
 * Page-context auto-injection:
 *   - At session start we POST the current URL + extracted ids (contact /
 *     listing / transaction) to /api/agent-assistant/session.
 *   - Once connected, we send a contextual update so the assistant knows
 *     "the user is currently on this contact's page" without the user
 *     having to name them.
 *
 * Lifecycle:
 *   open → POST /session → start Conv-AI session → contextual update
 *        → user talks → conversation messages stream into the transcript
 *   close → endSession() → PATCH /session (stamp ended_at) → component unmounts
 *
 * THE CLOSE HALF USED TO BE MISSING. `agent_assistant_sessions.ended_at` was
 * read by the tool-call webhook and written by nobody, so every session this
 * overlay opened stayed open forever — and the webhook's unattributed-session
 * fallback attributes an incoming ElevenLabs conversation to "the most recent
 * OPEN session", with no user predicate available to it. An ever-growing pile of
 * never-closed sessions is precisely the pile that fallback searches.
 */

import { useEffect, useRef, useState, useCallback } from "react"
import { Conversation } from "@elevenlabs/client"
import type { Status } from "@elevenlabs/client"
import { Mic, MicOff, X, Loader2, AlertCircle } from "lucide-react"
import { usePathname, useSearchParams } from "next/navigation"
import { useShell } from "@/app/components/layout/shell-context"

interface SessionResult {
  signedUrl: string
  sessionId: string | null
  convAiAgentId: string
  softWarning?: string
}

interface TranscriptLine {
  role: "user" | "agent"
  text: string
  ts: number
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** Stamp `ended_at` on the assistant session row. Fire-and-forget on purpose:
 *  the user has already closed the overlay and there is nothing to tell them,
 *  and it runs on unmount, where an unresolved promise would be dropped by the
 *  browser — `keepalive` is what lets it survive the teardown (and a page
 *  navigation) long enough to land. Idempotent server-side, so the two teardown
 *  paths firing together is safe. */
function closeAssistantSession(sessionId: string | null) {
  if (!sessionId) return
  try {
    void fetch("/api/agent-assistant/session", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
      keepalive: true,
    }).catch(() => {})
  } catch {
    // The conversation is already torn down; a failed close is recoverable by
    // the session's own staleness bound in the tool-call webhook.
  }
}

export function VoiceAssistantOverlay() {
  const { voiceOverlayOpen, setVoiceOverlayOpen } = useShell()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const conversationRef = useRef<Awaited<ReturnType<typeof Conversation.startSession>> | null>(null)
  /** The agent_assistant_sessions row this overlay opened, so teardown can close
   *  it. A ref, not state: the cleanup function must see the id without the
   *  effect re-running (which would restart the voice session). */
  const sessionIdRef = useRef<string | null>(null)
  const [status, setStatus] = useState<"idle" | "connecting" | "connected" | "ended" | "error">("idle")
  const [error, setError] = useState<string | null>(null)
  const [softWarning, setSoftWarning] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const [transcript, setTranscript] = useState<TranscriptLine[]>([])
  const [agentSpeaking, setAgentSpeaking] = useState(false)

  // ── Open / close lifecycle ───────────────────────────────────────────────
  useEffect(() => {
    if (!voiceOverlayOpen) {
      // Closing: tear down any active conversation AND close the ledger row.
      conversationRef.current?.endSession().catch(() => {})
      conversationRef.current = null
      closeAssistantSession(sessionIdRef.current)
      sessionIdRef.current = null
      setStatus("idle")
      setTranscript([])
      setError(null)
      setSoftWarning(null)
      return
    }

    // Opening: mint a session and start the SDK.
    let cancelled = false
    setStatus("connecting")
    setError(null)
    setTranscript([])
    ;(async () => {
      try {
        // Extract page-context from URL.
        const ctx = extractPageContext(pathname, searchParams)
        const res = await fetch("/api/agent-assistant/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ctx),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          setError(body.error ?? `Couldn't start the assistant (${res.status})`)
          setStatus("error")
          return
        }
        const session = (await res.json()) as SessionResult
        if (cancelled) {
          // The overlay closed while the session was minting. The row exists on
          // the server whether or not this component still wants it, so it is
          // closed here rather than left open for the webhook's recency-based
          // attribution fallback to find.
          closeAssistantSession(session.sessionId)
          return
        }
        sessionIdRef.current = session.sessionId
        if (session.softWarning) setSoftWarning(session.softWarning)

        const conversation = await Conversation.startSession({
          signedUrl: session.signedUrl,
          onConnect: () => {
            if (cancelled) return
            setStatus("connected")

            // Inject page-context as a system message so the assistant knows
            // what the user is currently looking at — no need to name "Sarah"
            // when the agent is already on Sarah's contact page.
            const contextSummary = describeContext(pathname, ctx)
            if (contextSummary) {
              try {
                conversation.sendContextualUpdate(contextSummary)
              } catch {
                // non-fatal — the assistant still works without context.
              }
            }
          },
          onDisconnect: () => {
            if (cancelled) return
            setStatus("ended")
          },
          onError: (msg: string | Error) => {
            if (cancelled) return
            setError(typeof msg === "string" ? msg : msg.message)
            setStatus("error")
          },
          onMessage: ({ message, source }: { message: string; source: "user" | "ai" }) => {
            if (cancelled || !message) return
            setTranscript((prev) => [
              ...prev,
              { role: source === "user" ? "user" : "agent", text: message, ts: Date.now() },
            ])
          },
          onModeChange: ({ mode }: { mode: "speaking" | "listening" }) => {
            if (cancelled) return
            setAgentSpeaking(mode === "speaking")
          },
          onStatusChange: ({ status: s }: { status: Status }) => {
            if (cancelled) return
            // SDK emits 'connected' / 'connecting' / 'disconnecting' / 'disconnected'
            if (s === "connected") setStatus("connected")
            else if (s === "disconnected") setStatus((prev) => (prev === "error" ? prev : "ended"))
          },
        })
        if (cancelled) {
          await conversation.endSession().catch(() => {})
          return
        }
        conversationRef.current = conversation
      } catch (e: any) {
        console.error(e)
        if (!cancelled) {
          setError(e?.message ?? "Microphone permission required")
          setStatus("error")
        }
      }
    })()

    return () => {
      cancelled = true
      conversationRef.current?.endSession().catch(() => {})
      conversationRef.current = null
      closeAssistantSession(sessionIdRef.current)
      sessionIdRef.current = null
    }
    // We intentionally don't depend on pathname/searchParams here — the user
    // opened the overlay on a specific page; navigation while the overlay is
    // open shouldn't restart the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceOverlayOpen])

  // ── Mic mute toggle ──────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    const conv = conversationRef.current
    if (!conv) return
    const next = !muted
    setMuted(next)
    try {
      conv.setMicMuted(next)
    } catch {
      // SDK throws if not yet connected; treat as no-op.
    }
  }, [muted])

  if (!voiceOverlayOpen) return null

  // ── UI ───────────────────────────────────────────────────────────────────
  return (
    <div
      role="dialog"
      aria-label="On-the-go voice assistant"
      className="fixed bottom-4 right-4 z-50 w-[380px] max-w-[calc(100vw-2rem)] rounded-2xl bg-white shadow-2xl border border-gray-200 overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-purple-600 text-white">
        <div className="flex items-center gap-2">
          <div
            className={`h-2 w-2 rounded-full ${
              status === "connected" && agentSpeaking
                ? "bg-emerald-300 animate-pulse"
                : status === "connected"
                ? "bg-emerald-400"
                : status === "connecting"
                ? "bg-amber-300 animate-pulse"
                : "bg-gray-300"
            }`}
          />
          <p className="text-sm font-medium">
            {status === "connecting" && "Starting…"}
            {status === "connected" && (agentSpeaking ? "Speaking" : "Listening")}
            {status === "ended" && "Call ended"}
            {status === "error" && "Couldn't connect"}
            {status === "idle" && "Idle"}
          </p>
        </div>
        <button
          onClick={() => setVoiceOverlayOpen(false)}
          aria-label="Close assistant"
          className="opacity-80 hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Soft warning banner */}
      {softWarning && (
        <div className="px-3 py-2 text-xs bg-amber-50 text-amber-900 border-b border-amber-200 flex items-start gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{softWarning}</span>
        </div>
      )}

      {/* Body */}
      <div className="p-4 min-h-[180px] max-h-[360px] overflow-y-auto bg-gray-50">
        {status === "connecting" && (
          <div className="flex items-center justify-center h-32 text-sm text-gray-500">
            <Loader2 className="h-5 w-5 animate-spin mr-2" /> Connecting your voice line…
          </div>
        )}

        {status === "error" && (
          <div className="flex flex-col items-center justify-center h-32 text-center px-4">
            <AlertCircle className="h-6 w-6 text-red-500 mb-2" />
            <p className="text-sm text-gray-700">{error ?? "Something went wrong."}</p>
            <button
              onClick={() => {
                setVoiceOverlayOpen(false)
                setTimeout(() => setVoiceOverlayOpen(true), 200)
              }}
              className="mt-3 text-xs text-purple-600 hover:underline"
            >
              Try again
            </button>
          </div>
        )}

        {(status === "connected" || status === "ended") && (
          <div className="space-y-2">
            {transcript.length === 0 ? (
              <p className="text-xs text-gray-500 italic text-center pt-8">
                Just start talking — I&apos;m listening.
              </p>
            ) : (
              transcript.map((line, i) => (
                <div
                  key={i}
                  className={`flex ${line.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <p
                    className={`text-sm rounded-lg px-3 py-1.5 max-w-[85%] ${
                      line.role === "user"
                        ? "bg-purple-100 text-purple-900"
                        : "bg-white border border-gray-200 text-gray-900"
                    }`}
                  >
                    {line.text}
                  </p>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Footer controls */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 bg-white">
        <button
          onClick={toggleMute}
          disabled={status !== "connected"}
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md transition-colors disabled:opacity-50 ${
            muted ? "bg-red-50 text-red-700 hover:bg-red-100" : "bg-gray-100 hover:bg-gray-200"
          }`}
        >
          {muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
          {muted ? "Muted" : "Mic on"}
        </button>

        <button
          onClick={() => setVoiceOverlayOpen(false)}
          className="text-xs px-3 py-1.5 rounded-md bg-red-600 text-white hover:bg-red-700"
        >
          End call
        </button>
      </div>
    </div>
  )
}

// ─── URL → context helpers ───────────────────────────────────────────────────

interface PageContext {
  contextUrl: string | null
  contextContactId: string | null
  contextListingId: string | null
  contextTransactionId: string | null
}

function extractPageContext(
  pathname: string | null,
  searchParams: URLSearchParams | null,
): PageContext {
  if (!pathname) {
    return { contextUrl: null, contextContactId: null, contextListingId: null, contextTransactionId: null }
  }

  // /crm?contact=<uuid>  → contact
  // /dashboard/listings/<uuid>/...  → listing
  // /dashboard/transactions/<uuid>/...  → transaction
  // /portal/<uuid>/...   → contact (portal staff view)
  let contactId: string | null = null
  let listingId: string | null = null
  let transactionId: string | null = null

  // crm contact query param
  const sp = searchParams
  if (sp) {
    const c = sp.get("contact") || sp.get("contactId")
    if (c && UUID_RE.test(c)) contactId = c
  }

  // path segments
  const segments = pathname.split("/").filter(Boolean)
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const next = segments[i + 1] ?? ""
    if (!UUID_RE.test(next)) continue
    if (seg === "listings") listingId = next
    else if (seg === "transactions") transactionId = next
    else if (seg === "portal" && !contactId) contactId = next
    else if ((seg === "contacts" || seg === "lifetime-customers") && !contactId) contactId = next
  }

  const contextUrl = typeof window !== "undefined" ? window.location.href : pathname
  return {
    contextUrl,
    contextContactId: contactId,
    contextListingId: listingId,
    contextTransactionId: transactionId,
  }
}

function describeContext(pathname: string | null, ctx: PageContext): string | null {
  const parts: string[] = []
  if (ctx.contextContactId) {
    parts.push(`The user is currently looking at a contact (contact_id: ${ctx.contextContactId}). When they say "this contact" or "them", use this id with get_contact_details / log_activity / send_portal_message.`)
  }
  if (ctx.contextListingId) {
    parts.push(`The user is on a listing detail page (listing_id: ${ctx.contextListingId}).`)
  }
  if (ctx.contextTransactionId) {
    parts.push(`The user is viewing a transaction (transaction_id: ${ctx.contextTransactionId}).`)
  }
  if (pathname?.includes("/calendar")) {
    parts.push("The user is on the calendar — they may ask about today's schedule.")
  }
  if (parts.length === 0) return null
  return parts.join(" ")
}
