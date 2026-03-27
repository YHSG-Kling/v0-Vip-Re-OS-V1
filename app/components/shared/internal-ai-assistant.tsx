"use client"

import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { useEffect, useRef, useState, useCallback } from "react"
import { X, Send, Minimize2, Sparkles, ChevronDown, FileText } from "lucide-react"

// Role-specific suggested questions surfaced before first message
const ROLE_SUGGESTIONS: Record<string, string[]> = {
  agent: [
    "What contacts need follow-up this week?",
    "Summarize my active transactions",
    "Which leads have the highest score right now?",
    "Draft a follow-up email for my top buyer lead",
  ],
  broker: [
    "How is the team performing this month?",
    "Which transactions are at risk of not closing?",
    "Summarize active deal pipeline",
    "Which agents are closest to cap?",
  ],
  admin: [
    "Show me today's stuck work",
    "Which transactions have no recent updates?",
    "Summarize brokerage lead activity",
    "Flag any deals missing documents",
  ],
  transaction_coordinator: [
    "What deadlines are coming up this week?",
    "Which transactions have overdue tasks?",
    "Summarize my assigned deals",
    "Draft a status update for my busiest deal",
  ],
  lender: [
    "What is the underwriting status on my deals?",
    "Which deals are closest to clear-to-close?",
    "Summarize my active transaction pipeline",
    "Flag any deals with missing loan conditions",
  ],
  vendor: [
    "What jobs do I have scheduled this week?",
    "Show me upcoming bookings",
    "Which jobs are still pending completion?",
    "Summarize my recent job history",
  ],
  title: [
    "What transactions am I working on?",
    "Which deals have title issues noted?",
    "Which closings are scheduled this week?",
    "Flag any transactions missing title commitment dates",
  ],
}

interface InternalAIAssistantProps {
  role: string
}

function getUIMessageText(msg: { parts?: Array<{ type: string; text?: string }>; content?: string }): string {
  if (msg.parts && Array.isArray(msg.parts)) {
    return msg.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
      .map(p => p.text)
      .join("")
  }
  return typeof msg.content === "string" ? msg.content : ""
}

export function InternalAIAssistant({ role }: InternalAIAssistantProps) {
  const [open, setOpen] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const [input, setInput] = useState("")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [draftNote, setDraftNote] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const normalizedRole = role?.toLowerCase() ?? "agent"
  const suggestions = ROLE_SUGGESTIONS[normalizedRole] ?? ROLE_SUGGESTIONS.agent

  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/internal/ai-chat",
      headers: sessionId ? { "x-internal-session-id": sessionId } : {},
    }),
  })

  const isStreaming = status === "streaming" || status === "submitted"

  // Scroll to bottom on new messages
  useEffect(() => {
    if (open && !minimized) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
    }
  }, [messages, open, minimized])

  // Focus input when opened
  useEffect(() => {
    if (open && !minimized) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open, minimized])

  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || isStreaming) return
    sendMessage({ text: trimmed })
    setInput("")
  }, [input, isStreaming, sendMessage])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleSuggestion = (q: string) => {
    sendMessage({ text: q })
  }

  // Detect draft note content in the last assistant message
  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant")
  const lastAssistantText = lastAssistant ? getUIMessageText(lastAssistant as Parameters<typeof getUIMessageText>[0]) : ""
  const hasDraft = lastAssistantText.toLowerCase().includes("draft")

  const roleLabel: Record<string, string> = {
    agent: "Agent Assistant",
    broker: "Broker Assistant",
    admin: "Admin Assistant",
    transaction_coordinator: "TC Assistant",
    lender: "Lender Assistant",
    vendor: "Vendor Assistant",
    title: "Title Assistant",
  }

  return (
    <>
      {/* FAB */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Open AI Assistant"
          style={{
            position: "fixed",
            bottom: "24px",
            right: "24px",
            zIndex: 9999,
            width: "52px",
            height: "52px",
            borderRadius: "50%",
            background: "#1a1a2e",
            border: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 4px 16px rgba(0,0,0,0.22)",
          }}
        >
          <Sparkles style={{ width: "22px", height: "22px", color: "#a5b4fc" }} />
        </button>
      )}

      {/* Chat Panel */}
      {open && (
        <div
          style={{
            position: "fixed",
            bottom: "24px",
            right: "24px",
            zIndex: 9999,
            width: "380px",
            maxWidth: "calc(100vw - 32px)",
            borderRadius: "14px",
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            boxShadow: "0 8px 32px rgba(0,0,0,0.14)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            maxHeight: minimized ? "56px" : "520px",
            transition: "max-height 0.25s ease",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "14px 16px",
              background: "#1a1a2e",
              cursor: "pointer",
              flexShrink: 0,
            }}
            onClick={() => minimized && setMinimized(false)}
          >
            <Sparkles style={{ width: "18px", height: "18px", color: "#a5b4fc", flexShrink: 0 }} />
            <span style={{ fontWeight: 600, fontSize: "14px", color: "#f1f5f9", flex: 1 }}>
              {roleLabel[normalizedRole] ?? "AI Assistant"}
            </span>
            <button
              onClick={e => { e.stopPropagation(); setMinimized(m => !m) }}
              aria-label={minimized ? "Expand" : "Minimize"}
              style={{ background: "none", border: "none", cursor: "pointer", padding: "2px", color: "#94a3b8" }}
            >
              {minimized ? (
                <ChevronDown style={{ width: "16px", height: "16px" }} />
              ) : (
                <Minimize2 style={{ width: "16px", height: "16px" }} />
              )}
            </button>
            <button
              onClick={e => { e.stopPropagation(); setOpen(false) }}
              aria-label="Close"
              style={{ background: "none", border: "none", cursor: "pointer", padding: "2px", color: "#94a3b8" }}
            >
              <X style={{ width: "16px", height: "16px" }} />
            </button>
          </div>

          {!minimized && (
            <>
              {/* Messages */}
              <div
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: "16px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                  minHeight: 0,
                }}
              >
                {messages.length === 0 && (
                  <div>
                    <p style={{ fontSize: "13px", color: "#64748b", marginBottom: "12px", lineHeight: "1.5" }}>
                      Ask me anything about your active work. I can summarize data, suggest next steps, and draft messages for your review — I never send or update anything automatically.
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      {suggestions.map(q => (
                        <button
                          key={q}
                          onClick={() => handleSuggestion(q)}
                          style={{
                            textAlign: "left",
                            padding: "8px 12px",
                            fontSize: "12px",
                            color: "#3730a3",
                            background: "#eef2ff",
                            border: "1px solid #c7d2fe",
                            borderRadius: "8px",
                            cursor: "pointer",
                            lineHeight: "1.4",
                          }}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {messages.map(msg => {
                  const text = getUIMessageText(msg as Parameters<typeof getUIMessageText>[0])
                  if (!text) return null
                  const isUser = msg.role === "user"
                  return (
                    <div
                      key={msg.id}
                      style={{
                        display: "flex",
                        justifyContent: isUser ? "flex-end" : "flex-start",
                      }}
                    >
                      <div
                        style={{
                          maxWidth: "84%",
                          padding: "9px 13px",
                          borderRadius: isUser ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                          background: isUser ? "#1a1a2e" : "#f8fafc",
                          border: isUser ? "none" : "1px solid #e2e8f0",
                          fontSize: "13px",
                          lineHeight: "1.55",
                          color: isUser ? "#f1f5f9" : "#1e293b",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {text}
                      </div>
                    </div>
                  )
                })}

                {isStreaming && messages[messages.length - 1]?.role !== "assistant" && (
                  <div style={{ display: "flex", gap: "4px", padding: "4px 0" }}>
                    {[0, 1, 2].map(i => (
                      <div key={i} style={{
                        width: "6px", height: "6px", borderRadius: "50%",
                        background: "#94a3b8",
                        animation: `pulse 1s ease-in-out ${i * 0.2}s infinite`,
                      }} />
                    ))}
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>

              {/* Draft note save nudge */}
              {hasDraft && messages.length > 0 && (
                <div style={{
                  padding: "8px 14px",
                  background: "#fefce8",
                  borderTop: "1px solid #fde68a",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  fontSize: "12px",
                  color: "#92400e",
                }}>
                  <FileText style={{ width: "14px", height: "14px", flexShrink: 0 }} />
                  <span>Draft above — review before saving or sending</span>
                </div>
              )}

              {/* Input */}
              <div
                style={{
                  padding: "12px 14px",
                  borderTop: "1px solid #e2e8f0",
                  display: "flex",
                  gap: "8px",
                  alignItems: "flex-end",
                  flexShrink: 0,
                }}
              >
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask AI-ISA..."
                  rows={1}
                  style={{
                    flex: 1,
                    resize: "none",
                    border: "1px solid #e2e8f0",
                    borderRadius: "8px",
                    padding: "8px 12px",
                    fontSize: "13px",
                    lineHeight: "1.5",
                    outline: "none",
                    fontFamily: "inherit",
                    color: "#1e293b",
                    background: "#f8fafc",
                    maxHeight: "80px",
                    overflow: "auto",
                  }}
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isStreaming}
                  aria-label="Send"
                  style={{
                    width: "36px",
                    height: "36px",
                    borderRadius: "8px",
                    border: "none",
                    cursor: input.trim() && !isStreaming ? "pointer" : "not-allowed",
                    background: input.trim() && !isStreaming ? "#1a1a2e" : "#e2e8f0",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    transition: "background 0.15s",
                  }}
                >
                  <Send style={{ width: "15px", height: "15px", color: input.trim() && !isStreaming ? "#a5b4fc" : "#94a3b8" }} />
                </button>
              </div>

              <style>{`
                @keyframes pulse {
                  0%, 100% { opacity: 0.3; transform: scale(0.8); }
                  50% { opacity: 1; transform: scale(1); }
                }
              `}</style>
            </>
          )}
        </div>
      )}
    </>
  )
}
