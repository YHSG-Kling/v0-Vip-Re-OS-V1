"use client"

import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { useEffect, useRef, useState, useCallback } from "react"
import { Send, X, MessageCircle, Loader2, Phone, ArrowLeft } from "lucide-react"
import { getMessageText } from "@/lib/ai/get-message-text"

interface WidgetIdentity {
  assistant_name: string
  persona_label: string
  tone: string
  faq_knowledge: Array<{ question: string; answer: string }>
  followup_style: string
  display_name?: string
  brokerage_name?: string
}

/**
 * The "live_agent" mode is GONE (m336). It drove /api/widget/avatar-session +
 * /api/widget/avatar-talk, a raw-fetch lane against D-ID's deprecated
 * talks/streams + clips/streams that could never have worked: it looked up
 * `agents.user_id = <an agents.id>`, so the session route 404'd on every call,
 * and the picker's gate read agent_voice_profiles with the same wrong id class,
 * so the button never rendered either. The real live/voice/talking agent is the
 * EMBED widget (/embed/[publicId]), which rides the D-ID Agents SDK through
 * Connection OS with usage caps, budget gating and metering.
 */
type WidgetMode = "picker" | "chat" | "callback"

function getFingerprint(): string {
  const nav = navigator.userAgent + screen.width + screen.height + Intl.DateTimeFormat().resolvedOptions().timeZone
  let hash = 0
  for (let i = 0; i < nav.length; i++) {
    hash = (hash << 5) - hash + nav.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash).toString(36)
}

const SESSION_KEY = "vip_widget_session"

/**
 * Both identity values arrive as PROPS, resolved by the server component from
 * the ?brokerage= / ?agent= params. The client no longer reads them itself and
 * no longer POSTs a brokerage uuid: `brokerageSlug` is a public handle and
 * /api/widget/session re-resolves it (and re-checks the agent against it)
 * before it will mint anything. Every downstream widget call — message, intake,
 * capture-lead, callback — carries only the server-issued session token, so the
 * tenant is read off the session row rather than off this form.
 */
export default function WidgetChatClient({
  brokerageSlug,
  agentId,
}: {
  brokerageSlug: string | null
  agentId: string | null
}) {
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [identity, setIdentity] = useState<WidgetIdentity | null>(null)
  const [sessionReady, setSessionReady] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [mode, setMode] = useState<WidgetMode>("picker")

  // Intake capture
  const [capturedName, setCapturedName] = useState("")
  const [capturedEmail, setCapturedEmail] = useState("")
  const [capturedPhone, setCapturedPhone] = useState("")
  const [showIntakeForm, setShowIntakeForm] = useState(false)
  const [intakeSubmitted, setIntakeSubmitted] = useState(false)
  const [intakeSubmitting, setIntakeSubmitting] = useState(false)

  // Callback request form
  const [cbFirstName, setCbFirstName] = useState("")
  const [cbLastName, setCbLastName] = useState("")
  const [cbPhone, setCbPhone] = useState("")
  const [cbBestTime, setCbBestTime] = useState("")
  const [cbConsent, setCbConsent] = useState(false)
  const [cbSubmitting, setCbSubmitting] = useState(false)
  const [cbSubmitted, setCbSubmitted] = useState(false)
  const [cbError, setCbError] = useState("")

  const messagesEndRef = useRef<HTMLDivElement>(null)

  // ── Session init ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!brokerageSlug) {
      setSessionError("This chat isn't available.")
      return
    }
    const stored = typeof window !== "undefined" ? sessionStorage.getItem(SESSION_KEY) : null
    fetch("/api/widget/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brokerage_slug: brokerageSlug,
        agent_id: agentId ?? null,
        source: "website_widget",
        visitor_fingerprint: getFingerprint(),
        resume_token: stored ?? null,
      }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        setSessionToken(data.session_token)
        setIdentity(data.identity)
        sessionStorage.setItem(SESSION_KEY, data.session_token)
        setSessionReady(true)
      })
      .catch(() => setSessionError("Could not connect. Please try again later."))
  }, [brokerageSlug, agentId])

  const [inputValue, setInputValue] = useState("")
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/widget/message",
      body: { session_token: sessionToken },
    }),
  })
  const isLoading = status === "streaming" || status === "submitted"

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!inputValue.trim() || !sessionReady || isLoading) return
    sendMessage({ role: "user", parts: [{ type: "text", text: inputValue.trim() }] })
    setInputValue("")
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // ── Intake detection ──────────────────────────────────────────────────────
  useEffect(() => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
    if (!lastAssistant || intakeSubmitted) return
    const text = getMessageText(lastAssistant)
    const INTAKE_SIGNALS = /your name|your email|contact info|get in touch|reach you|follow.?up|phone number/i
    if (INTAKE_SIGNALS.test(text) && !showIntakeForm) setShowIntakeForm(true)
  }, [messages, showIntakeForm, intakeSubmitted])

  // ── Intake submit ─────────────────────────────────────────────────────────
  const handleIntakeSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!capturedEmail && !capturedPhone) return
      setIntakeSubmitting(true)
      try {
        const lastMsg = [...messages].filter((m) => m.role === "user").slice(-3).map((m) => getMessageText(m)).join(" | ")
        await fetch("/api/widget/intake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            first_name: capturedName.split(" ")[0] || null,
            last_name: capturedName.split(" ").slice(1).join(" ") || null,
            email: capturedEmail || null,
            phone: capturedPhone || null,
            message: lastMsg || null,
            // No agent_id / brokerage_id: the intake route reads both off the
            // session row this token identifies.
            session_token: sessionToken,
            source: "website_widget",
            tcpa_consent: true,
            tcpa_consent_text: "I agree to be contacted by a real estate professional via phone, email, or text.",
          }),
        })
        setIntakeSubmitted(true)
        setShowIntakeForm(false)
        await sendMessage({ role: "user", parts: [{ type: "text", text: `My name is ${capturedName}, email: ${capturedEmail || "(not provided)"}, phone: ${capturedPhone || "(not provided)"}` }] })
      } catch {
        // Silently continue
      } finally {
        setIntakeSubmitting(false)
      }
    },
    [capturedName, capturedEmail, capturedPhone, messages, sessionToken, sendMessage]
  )

  // ── Callback submit ───────────────────────────────────────────────────────
  const handleCallbackSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!cbConsent || !cbPhone) return
      setCbSubmitting(true)
      setCbError("")
      try {
        const res = await fetch("/api/widget/live-agent-request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            firstName: cbFirstName || undefined,
            lastName: cbLastName || undefined,
            phone: cbPhone,
            bestTime: cbBestTime || undefined,
            tcpaConsent: true,
            // The callback route resolves brokerage AND recipient from the
            // session row — it used to take both off this body.
            session_token: sessionToken,
          }),
        })
        if (!res.ok) throw new Error("Request failed")
        setCbSubmitted(true)
      } catch {
        setCbError("Something went wrong. Please try again.")
      } finally {
        setCbSubmitting(false)
      }
    },
    [cbFirstName, cbLastName, cbPhone, cbBestTime, cbConsent, sessionToken]
  )

  // ── Render guards ─────────────────────────────────────────────────────────
  if (sessionError) {
    return (
      <div className="flex flex-col h-screen bg-white items-center justify-center p-4 text-center">
        <p className="text-sm text-gray-500">{sessionError}</p>
      </div>
    )
  }

  if (!sessionReady || !identity) {
    return (
      <div className="flex h-screen items-center justify-center bg-white">
        <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
      </div>
    )
  }

  const displayName = identity.display_name ?? identity.assistant_name
  const brokerageName = identity.brokerage_name ?? ""

  // ── Header ────────────────────────────────────────────────────────────────
  const header = (
    <div className="flex items-center gap-2 px-4 py-3 bg-blue-700 text-white flex-shrink-0">
      {mode !== "picker" && (
        <button
          className="text-white/70 hover:text-white mr-1"
          onClick={() => setMode("picker")}
          aria-label="Back to menu"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      )}
      <div className="h-7 w-7 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
        <MessageCircle className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm leading-none truncate">{identity.assistant_name}</p>
        <p className="text-xs text-blue-200 mt-0.5 leading-none">{identity.persona_label}</p>
      </div>
      <button
        className="text-white/70 hover:text-white"
        onClick={() => window.parent.postMessage({ type: "VIP_WIDGET_CLOSE" }, "*")}
        aria-label="Close chat"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )

  // ── Mode picker ───────────────────────────────────────────────────────────
  if (mode === "picker") {
    return (
      <div className="flex flex-col h-screen bg-white font-sans text-sm">
        {header}
        <div className="flex-1 flex flex-col items-center justify-center px-5 py-6 gap-3">
          <p className="text-base font-semibold text-gray-800 mb-1">How can we help you?</p>

          <button
            onClick={() => setMode("chat")}
            className="w-full flex items-start gap-3 border border-gray-200 rounded-xl px-4 py-3 hover:border-blue-400 hover:bg-blue-50 transition-colors text-left"
          >
            <MessageCircle className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium text-gray-800 text-sm">Ask a question</p>
              <p className="text-xs text-gray-500">Get instant answers</p>
            </div>
          </button>

          <button
            onClick={() => setMode("callback")}
            className="w-full flex items-start gap-3 border border-gray-200 rounded-xl px-4 py-3 hover:border-blue-400 hover:bg-blue-50 transition-colors text-left"
          >
            <Phone className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium text-gray-800 text-sm">Request {displayName} to call you back</p>
              <p className="text-xs text-gray-500">We&apos;ll reach out shortly</p>
            </div>
          </button>

        </div>
      </div>
    )
  }

  // ── Callback form ─────────────────────────────────────────────────────────
  if (mode === "callback") {
    return (
      <div className="flex flex-col h-screen bg-white font-sans text-sm">
        {header}
        <div className="flex-1 overflow-y-auto px-4 py-5">
          {cbSubmitted ? (
            <div className="flex flex-col items-center justify-center h-full text-center gap-3">
              <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center">
                <Phone className="h-6 w-6 text-green-600" />
              </div>
              <p className="font-semibold text-gray-800">Request sent!</p>
              <p className="text-xs text-gray-500">
                {displayName} will give you a call at {cbPhone}.
              </p>
            </div>
          ) : (
            <form onSubmit={handleCallbackSubmit} className="space-y-3">
              <p className="text-xs text-gray-500 leading-relaxed">
                By submitting, you consent to being contacted by{" "}
                <span className="font-medium">{displayName}</span>
                {brokerageName ? ` at ${brokerageName}` : ""} via phone, email, or text. Standard rates may apply.
              </p>
              <input
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="First name"
                value={cbFirstName}
                onChange={(e) => setCbFirstName(e.target.value)}
              />
              <input
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Last name"
                value={cbLastName}
                onChange={(e) => setCbLastName(e.target.value)}
              />
              <input
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                type="tel"
                placeholder="Best number *"
                required
                value={cbPhone}
                onChange={(e) => setCbPhone(e.target.value)}
              />
              <input
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="When's a good time? (optional)"
                value={cbBestTime}
                onChange={(e) => setCbBestTime(e.target.value)}
              />
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={cbConsent}
                  onChange={(e) => setCbConsent(e.target.checked)}
                  className="mt-0.5 w-4 h-4 flex-shrink-0"
                  required
                />
                <span className="text-[11px] text-gray-500 leading-tight">
                  I agree to be contacted by a real estate professional via phone, email, or text.
                </span>
              </label>
              {cbError && <p className="text-xs text-red-500">{cbError}</p>}
              <button
                type="submit"
                disabled={cbSubmitting || !cbConsent || !cbPhone}
                className="w-full bg-blue-700 text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50"
              >
                {cbSubmitting ? "Sending…" : "Request Callback"}
              </button>
            </form>
          )}
        </div>
      </div>
    )
  }

  // ── Chat mode (default) ───────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-white font-sans text-sm">
      {header}

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {messages.length === 0 && (
          <div className="flex justify-start">
            <div className="bg-gray-100 text-gray-800 rounded-2xl rounded-tl-md px-3 py-2 max-w-[85%] text-sm leading-relaxed">
              Hi! I&apos;m {identity.assistant_name}. How can I help you today?
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`rounded-2xl px-3 py-2 max-w-[85%] text-sm leading-relaxed whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-blue-700 text-white rounded-br-md"
                  : "bg-gray-100 text-gray-800 rounded-tl-md"
              }`}
            >
              {getMessageText(m)}
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-2xl rounded-tl-md px-3 py-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {showIntakeForm && !intakeSubmitted && (
        <form
          onSubmit={handleIntakeSubmit}
          className="border-t border-gray-100 bg-gray-50 px-3 py-3 space-y-2 flex-shrink-0"
        >
          <p className="text-xs text-gray-500 font-medium">Share your contact info to get connected:</p>
          <input
            className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Your name"
            value={capturedName}
            onChange={(e) => setCapturedName(e.target.value)}
          />
          <input
            className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            type="email"
            placeholder="Email address"
            value={capturedEmail}
            onChange={(e) => setCapturedEmail(e.target.value)}
          />
          <input
            className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            type="tel"
            placeholder="Phone (optional)"
            value={capturedPhone}
            onChange={(e) => setCapturedPhone(e.target.value)}
          />
          <p className="text-[10px] text-gray-400 leading-tight">
            By submitting, you agree to be contacted by a real estate professional via phone, email, or text. Standard messaging rates may apply.
          </p>
          <button
            type="submit"
            disabled={intakeSubmitting || (!capturedEmail && !capturedPhone)}
            className="w-full bg-blue-700 text-white rounded-lg py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {intakeSubmitting ? "Connecting..." : "Send my info"}
          </button>
        </form>
      )}

      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 px-3 py-2 border-t border-gray-100 flex-shrink-0"
      >
        <input
          className="flex-1 bg-gray-100 rounded-full px-4 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-gray-400"
          placeholder="Type a message..."
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          disabled={!sessionReady || isLoading}
        />
        <button
          type="submit"
          disabled={!inputValue.trim() || !sessionReady || isLoading}
          className="h-8 w-8 flex items-center justify-center bg-blue-700 text-white rounded-full disabled:opacity-40 flex-shrink-0"
          aria-label="Send"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </form>
    </div>
  )
}
