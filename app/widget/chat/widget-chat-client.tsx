"use client"

import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { useSearchParams } from "next/navigation"
import { useEffect, useRef, useState, useCallback } from "react"
import { Send, X, MessageCircle, Loader2 } from "lucide-react"

interface WidgetIdentity {
  assistant_name: string
  persona_label: string
  tone: string
  faq_knowledge: Array<{ question: string; answer: string }>
  followup_style: string
}

// ── Simple fingerprint for session resume ─────────────────────────────────────
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

export default function WidgetChatClient() {
  const params = useSearchParams()
  const agentId = params.get("agent") ?? undefined
  const brokerageId = params.get("brokerage") ?? ""
  const position = (params.get("position") ?? "right") as "right" | "left"

  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [identity, setIdentity] = useState<WidgetIdentity | null>(null)
  const [sessionReady, setSessionReady] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)

  // Intake capture state
  const [capturedName, setCapturedName] = useState("")
  const [capturedEmail, setCapturedEmail] = useState("")
  const [capturedPhone, setCapturedPhone] = useState("")
  const [showIntakeForm, setShowIntakeForm] = useState(false)
  const [intakeSubmitted, setIntakeSubmitted] = useState(false)
  const [intakeSubmitting, setIntakeSubmitting] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)

  // ── Initialize session ────────────────────────────────────────────────────
  useEffect(() => {
    if (!brokerageId) {
      setSessionError("Widget misconfigured: brokerage ID missing.")
      return
    }

    const initSession = async () => {
      const stored = typeof window !== "undefined" ? sessionStorage.getItem(SESSION_KEY) : null

      try {
        const res = await fetch("/api/widget/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brokerage_id: brokerageId,
            agent_id: agentId ?? null,
            source: "website_widget",
            visitor_fingerprint: getFingerprint(),
            resume_token: stored ?? null,
          }),
        })

        if (!res.ok) throw new Error("Session init failed")

        const data = await res.json()
        setSessionToken(data.session_token)
        setIdentity(data.identity)
        sessionStorage.setItem(SESSION_KEY, data.session_token)
        setSessionReady(true)
      } catch (err) {
        setSessionError("Could not connect. Please try again later.")
      }
    }

    initSession()
  }, [brokerageId, agentId])

  // ── useChat — streams from /api/widget/message ────────────────────────────
  const { messages, input, handleInputChange, handleSubmit, isLoading, append } = useChat({
    transport: new DefaultChatTransport({
      url: "/api/widget/message",
      prepareFetchOptions: () => ({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
      // Send session_token alongside messages
      prepareRequestBody: ({ messages }) => ({
        session_token: sessionToken,
        messages,
      }),
    }),
    initialMessages: [],
  })

  // Auto-scroll to newest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // ── Intake detection: show form if AI asks for contact info ──────────────
  useEffect(() => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
    if (!lastAssistant || intakeSubmitted) return
    const text = lastAssistant.content ?? ""
    const INTAKE_SIGNALS = /your name|your email|contact info|get in touch|reach you|follow.?up|phone number/i
    if (INTAKE_SIGNALS.test(text) && !showIntakeForm) {
      setShowIntakeForm(true)
    }
  }, [messages, showIntakeForm, intakeSubmitted])

  // ── Submit intake (contact-first per spec) ────────────────────────────────
  const handleIntakeSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!capturedEmail && !capturedPhone) return
    setIntakeSubmitting(true)

    try {
      const lastMsg = [...messages].filter((m) => m.role === "user").slice(-3).map((m) => m.content).join(" | ")

      await fetch("/api/widget/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: capturedName.split(" ")[0] || null,
          last_name: capturedName.split(" ").slice(1).join(" ") || null,
          email: capturedEmail || null,
          phone: capturedPhone || null,
          message: lastMsg || null,
          agent_id: agentId ?? null,
          brokerage_id: brokerageId,
          session_token: sessionToken,
          source: "website_widget",
          tcpa_consent: true,
          tcpa_consent_text: "I agree to be contacted by a real estate professional via phone, email, or text.",
        }),
      })

      setIntakeSubmitted(true)
      setShowIntakeForm(false)
      await append({ role: "user", content: `My name is ${capturedName}, email: ${capturedEmail || "(not provided)"}, phone: ${capturedPhone || "(not provided)"}` })
    } catch {
      // Silently continue — don't block UX
    } finally {
      setIntakeSubmitting(false)
    }
  }, [capturedName, capturedEmail, capturedPhone, messages, agentId, brokerageId, sessionToken, append])

  // ── Render ────────────────────────────────────────────────────────────────
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

  const assistantName = identity.assistant_name
  const hasMessages = messages.length > 0

  return (
    <div className="flex flex-col h-screen bg-white font-sans text-sm">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 bg-blue-700 text-white flex-shrink-0">
        <div className="h-7 w-7 rounded-full bg-white/20 flex items-center justify-center">
          <MessageCircle className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm leading-none truncate">{assistantName}</p>
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

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {!hasMessages && (
          <div className="flex justify-start">
            <div className="bg-gray-100 text-gray-800 rounded-2xl rounded-tl-md px-3 py-2 max-w-[85%] text-sm leading-relaxed">
              Hi! I&apos;m {assistantName}. How can I help you today?
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
              {m.content}
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

      {/* Inline intake form (shown when AI signals readiness) */}
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

      {/* Input bar */}
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 px-3 py-2 border-t border-gray-100 flex-shrink-0"
      >
        <input
          className="flex-1 bg-gray-100 rounded-full px-4 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-gray-400"
          placeholder="Type a message..."
          value={input}
          onChange={handleInputChange}
          disabled={!sessionReady || isLoading}
        />
        <button
          type="submit"
          disabled={!input.trim() || !sessionReady || isLoading}
          className="h-8 w-8 flex items-center justify-center bg-blue-700 text-white rounded-full disabled:opacity-40 flex-shrink-0"
          aria-label="Send"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </form>
    </div>
  )
}
