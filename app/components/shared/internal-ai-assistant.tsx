"use client"

import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { useEffect, useRef, useState, useCallback } from "react"
import { X, Send, Minimize2, Sparkles, ChevronDown, FileText, StickyNote, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react"

// ─── Suggested questions by role ─────────────────────────────────────────────

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
    "note: loan conditions received, CTC expected this week",
  ],
  vendor: [
    "What jobs do I have scheduled this week?",
    "Show me upcoming bookings",
    "Which jobs are still pending completion?",
    "note: job completed at 123 Main St, all items resolved",
  ],
  title: [
    "What transactions am I working on?",
    "Which deals have title issues noted?",
    "Which closings are scheduled this week?",
    "Flag any transactions missing title commitment dates",
  ],
}

const NOTE_TYPE_LABELS: Record<string, string> = {
  general: "Note",
  call_outcome: "Call Outcome",
  meeting_outcome: "Meeting Outcome",
  follow_up: "Follow-Up Note",
  decision: "Decision Recorded",
  action_item: "Action Item",
  loan_update: "Loan Update",
  vendor_update: "Vendor Update",
  observation: "Observation",
}

const ROLE_LABEL: Record<string, string> = {
  agent: "Agent Assistant",
  broker: "Broker Assistant",
  admin: "Admin Assistant",
  transaction_coordinator: "TC Assistant",
  lender: "Lender Assistant",
  vendor: "Vendor Assistant",
  title: "Title Assistant",
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface NoteDraft {
  cardId: string
  afterMessageId: string | null // null = show after all messages
  noteText: string
  noteType: string
  entityType: string
  entityId: string | null
  entityLabel: string | null
  confidence: string
  hasActionItem: boolean
  suggestedTaskTitle: string | null
  // mutable UI state
  editedText: string
  editedTaskTitle: string
  showTaskInput: boolean
  saving: boolean
  saved: boolean
  dismissed: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** Deterministic DJB2 hash for dedupe content_hash */
function hashStr(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i)
  }
  return Math.abs(h >>> 0).toString(36)
}

function getUIMessageText(msg: { parts?: Array<{ type: string; text?: string }>; content?: string }): string {
  if (msg.parts && Array.isArray(msg.parts)) {
    return msg.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("")
  }
  return typeof msg.content === "string" ? msg.content : ""
}

/** Strip [NOTE_DRAFT:{...}] marker from display text */
function stripNoteDraftSignal(text: string): string {
  return text.replace(/\[NOTE_DRAFT:\{[^[\]]*\}\]/s, "").trim()
}

/** Parse [NOTE_DRAFT:{...}] from text, return null if not found/invalid */
function parseNoteDraftSignal(text: string): Omit<NoteDraft, "cardId" | "afterMessageId" | "editedText" | "editedTaskTitle" | "showTaskInput" | "saving" | "saved" | "dismissed"> | null {
  const match = text.match(/\[NOTE_DRAFT:(\{[^[\]]*\})\]/s)
  if (!match) return null
  try {
    const d = JSON.parse(match[1])
    return {
      noteText: d.noteText ?? "",
      noteType: d.noteType ?? "general",
      entityType: d.entityType ?? "general",
      entityId: d.entityId ?? null,
      entityLabel: d.entityLabel ?? null,
      confidence: d.confidence ?? "low",
      hasActionItem: d.hasActionItem ?? false,
      suggestedTaskTitle: d.suggestedTaskTitle ?? null,
    }
  } catch {
    return null
  }
}

// ─── NoteDraftCard ────────────────────────────────────────────────────────────

function NoteDraftCard({
  draft,
  onUpdate,
  onSave,
  onDiscard,
}: {
  draft: NoteDraft
  onUpdate: (cardId: string, updates: Partial<NoteDraft>) => void
  onSave: (cardId: string, withTask: boolean) => void
  onDiscard: (cardId: string) => void
}) {
  if (draft.dismissed) return null

  const typeLabel = NOTE_TYPE_LABELS[draft.noteType] ?? "Note"

  if (draft.saved) {
    return (
      <div style={{
        margin: "8px 0",
        padding: "10px 14px",
        borderRadius: "10px",
        background: "#f0fdf4",
        border: "1px solid #86efac",
        display: "flex",
        alignItems: "center",
        gap: "8px",
        fontSize: "12px",
        color: "#166534",
      }}>
        <CheckCircle2 style={{ width: "14px", height: "14px", flexShrink: 0 }} />
        <span><strong>{typeLabel}</strong> saved{draft.entityLabel ? ` — ${draft.entityLabel}` : ""}</span>
      </div>
    )
  }

  return (
    <div style={{
      margin: "8px 0",
      borderRadius: "10px",
      background: "#fffbeb",
      border: "1px solid #fde68a",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "8px 12px",
        borderBottom: "1px solid #fde68a",
        background: "#fef3c7",
      }}>
        <StickyNote style={{ width: "13px", height: "13px", color: "#92400e", flexShrink: 0 }} />
        <span style={{ fontSize: "11px", fontWeight: 700, color: "#92400e", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          Note Draft
        </span>
        <span style={{
          marginLeft: "4px",
          fontSize: "10px",
          padding: "1px 6px",
          borderRadius: "4px",
          background: "#fcd34d",
          color: "#78350f",
          fontWeight: 600,
        }}>
          {typeLabel}
        </span>
        {draft.entityLabel && (
          <span style={{ fontSize: "11px", color: "#78350f", marginLeft: "auto" }}>
            {draft.entityLabel}
          </span>
        )}
      </div>

      {/* Low-confidence warning */}
      {draft.confidence === "low" && (
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "6px 12px",
          background: "#fff7ed",
          borderBottom: "1px solid #fed7aa",
          fontSize: "11px",
          color: "#9a3412",
        }}>
          <AlertTriangle style={{ width: "12px", height: "12px", flexShrink: 0 }} />
          General note (could not identify a specific contact/transaction — please review)
        </div>
      )}

      {/* Editable note text */}
      <div style={{ padding: "10px 12px" }}>
        <textarea
          value={draft.editedText}
          onChange={(e) => onUpdate(draft.cardId, { editedText: e.target.value })}
          rows={3}
          style={{
            width: "100%",
            resize: "vertical",
            border: "1px solid #e2e8f0",
            borderRadius: "6px",
            padding: "7px 10px",
            fontSize: "12px",
            lineHeight: "1.5",
            fontFamily: "inherit",
            color: "#1e293b",
            background: "#ffffff",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
      </div>

      {/* Task input (shown after "Save + Task" click) */}
      {draft.showTaskInput && (
        <div style={{ padding: "0 12px 10px" }}>
          <label style={{ fontSize: "11px", color: "#78350f", fontWeight: 600, display: "block", marginBottom: "4px" }}>
            Task title
          </label>
          <input
            type="text"
            value={draft.editedTaskTitle}
            onChange={(e) => onUpdate(draft.cardId, { editedTaskTitle: e.target.value })}
            placeholder="e.g. Follow up with buyer next week"
            style={{
              width: "100%",
              border: "1px solid #e2e8f0",
              borderRadius: "6px",
              padding: "6px 10px",
              fontSize: "12px",
              fontFamily: "inherit",
              color: "#1e293b",
              background: "#ffffff",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
            <button
              onClick={() => onSave(draft.cardId, true)}
              disabled={draft.saving || !draft.editedTaskTitle.trim()}
              style={{
                padding: "5px 10px",
                fontSize: "11px",
                fontWeight: 600,
                borderRadius: "6px",
                border: "none",
                cursor: draft.saving || !draft.editedTaskTitle.trim() ? "not-allowed" : "pointer",
                background: draft.saving || !draft.editedTaskTitle.trim() ? "#e2e8f0" : "#1a1a2e",
                color: draft.saving || !draft.editedTaskTitle.trim() ? "#94a3b8" : "#f1f5f9",
                display: "flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              {draft.saving ? <Loader2 style={{ width: "11px", height: "11px", animation: "spin 1s linear infinite" }} /> : null}
              Save Note + Task
            </button>
            <button
              onClick={() => { onUpdate(draft.cardId, { showTaskInput: false }); onSave(draft.cardId, false) }}
              disabled={draft.saving}
              style={{
                padding: "5px 10px",
                fontSize: "11px",
                fontWeight: 500,
                borderRadius: "6px",
                border: "1px solid #e2e8f0",
                cursor: draft.saving ? "not-allowed" : "pointer",
                background: "#ffffff",
                color: "#475569",
              }}
            >
              Save Note Only
            </button>
          </div>
        </div>
      )}

      {/* Action buttons */}
      {!draft.showTaskInput && (
        <div style={{
          display: "flex",
          gap: "6px",
          padding: "0 12px 10px",
          alignItems: "center",
        }}>
          <button
            onClick={() => onSave(draft.cardId, false)}
            disabled={draft.saving || !draft.editedText.trim()}
            style={{
              padding: "5px 10px",
              fontSize: "11px",
              fontWeight: 600,
              borderRadius: "6px",
              border: "none",
              cursor: draft.saving || !draft.editedText.trim() ? "not-allowed" : "pointer",
              background: draft.saving || !draft.editedText.trim() ? "#e2e8f0" : "#1a1a2e",
              color: draft.saving || !draft.editedText.trim() ? "#94a3b8" : "#f1f5f9",
              display: "flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            {draft.saving ? <Loader2 style={{ width: "11px", height: "11px", animation: "spin 1s linear infinite" }} /> : null}
            Save Note
          </button>
          {draft.hasActionItem && (
            <button
              onClick={() => onUpdate(draft.cardId, { showTaskInput: true, editedTaskTitle: draft.suggestedTaskTitle ?? "" })}
              disabled={draft.saving}
              style={{
                padding: "5px 10px",
                fontSize: "11px",
                fontWeight: 600,
                borderRadius: "6px",
                border: "1px solid #fcd34d",
                cursor: draft.saving ? "not-allowed" : "pointer",
                background: "#fef3c7",
                color: "#78350f",
              }}
            >
              Save Note + Create Task
            </button>
          )}
          <button
            onClick={() => onDiscard(draft.cardId)}
            style={{
              marginLeft: "auto",
              padding: "5px 10px",
              fontSize: "11px",
              borderRadius: "6px",
              border: "1px solid #e2e8f0",
              cursor: "pointer",
              background: "transparent",
              color: "#94a3b8",
            }}
          >
            Discard
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface InternalAIAssistantProps {
  role: string
}

export function InternalAIAssistant({ role }: InternalAIAssistantProps) {
  const [open, setOpen] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const [input, setInput] = useState("")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<NoteDraft[]>([])
  const [processedMsgIds, setProcessedMsgIds] = useState<Set<string>>(new Set())
  const [noteLoading, setNoteLoading] = useState(false)
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

  // Auto-scroll
  useEffect(() => {
    if (open && !minimized) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
    }
  }, [messages, drafts, open, minimized])

  // Focus on open
  useEffect(() => {
    if (open && !minimized) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [open, minimized])

  // Detect [NOTE_DRAFT] signal in completed assistant messages
  useEffect(() => {
    if (status !== "ready") return
    const lastA = [...messages].reverse().find((m) => m.role === "assistant")
    if (!lastA || processedMsgIds.has(lastA.id)) return

    setProcessedMsgIds((prev) => new Set([...prev, lastA.id]))
    const text = getUIMessageText(lastA as Parameters<typeof getUIMessageText>[0])
    const parsed = parseNoteDraftSignal(text)
    if (parsed) {
      setDrafts((prev) => [
        ...prev,
        {
          cardId: genId(),
          afterMessageId: lastA.id,
          ...parsed,
          editedText: parsed.noteText,
          editedTaskTitle: parsed.suggestedTaskTitle ?? "",
          showTaskInput: false,
          saving: false,
          saved: false,
          dismissed: false,
        },
      ])
    }
  }, [status, messages, processedMsgIds])

  // ── Note command handler ────────────────────────────────────────────────────
  const NOTE_PATTERN = /^(note:|add note:|save note:)\s*/i

  const prepareNote = useCallback(
    async (rawText: string) => {
      if (!rawText.trim()) return
      setNoteLoading(true)
      try {
        const ctx = messages
          .slice(-8)
          .map((m) => {
            const t = stripNoteDraftSignal(getUIMessageText(m as Parameters<typeof getUIMessageText>[0]))
            return `${m.role}: ${t.slice(0, 300)}`
          })
          .join("\n")

        const res = await fetch("/api/internal/ai-note", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "prepare_note", rawText, conversationContext: ctx }),
        })
        const data = await res.json()

        setDrafts((prev) => [
          ...prev,
          {
            cardId: genId(),
            afterMessageId: null,
            noteText: data.noteText ?? rawText,
            noteType: data.noteType ?? "general",
            entityType: data.entityType ?? "general",
            entityId: data.entityId ?? null,
            entityLabel: data.entityLabel ?? null,
            confidence: data.confidence ?? "low",
            hasActionItem: data.hasActionItem ?? false,
            suggestedTaskTitle: data.suggestedTaskTitle ?? null,
            editedText: data.noteText ?? rawText,
            editedTaskTitle: data.suggestedTaskTitle ?? "",
            showTaskInput: false,
            saving: false,
            saved: false,
            dismissed: false,
          },
        ])
      } catch {
        // Non-fatal — user can try again
      } finally {
        setNoteLoading(false)
      }
    },
    [messages]
  )

  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || isStreaming) return

    if (NOTE_PATTERN.test(trimmed)) {
      const rawText = trimmed.replace(NOTE_PATTERN, "").trim()
      setInput("")
      prepareNote(rawText)
      return
    }

    sendMessage({ text: trimmed })
    setInput("")
  }, [input, isStreaming, sendMessage, prepareNote])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ── Note draft helpers ──────────────────────────────────────────────────────
  const updateDraft = useCallback((cardId: string, updates: Partial<NoteDraft>) => {
    setDrafts((prev) => prev.map((d) => (d.cardId === cardId ? { ...d, ...updates } : d)))
  }, [])

  const discardDraft = useCallback((cardId: string) => {
    setDrafts((prev) => prev.map((d) => (d.cardId === cardId ? { ...d, dismissed: true } : d)))
  }, [])

  const saveNote = useCallback(
    async (cardId: string, withTask: boolean) => {
      const draft = drafts.find((d) => d.cardId === cardId)
      if (!draft || draft.saved || draft.saving) return

      updateDraft(cardId, { saving: true })
      const contentHash = hashStr(draft.editedText.trim().toLowerCase())

      try {
        const res = await fetch("/api/internal/ai-note", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(sessionId ? { "x-internal-session-id": sessionId } : {}),
          },
          body: JSON.stringify({
            action: "save_note",
            noteText: draft.editedText,
            noteType: draft.noteType,
            entityType: draft.entityType,
            entityId: draft.entityId,
            sessionId,
            contentHash,
            createTask: withTask && !!draft.editedTaskTitle.trim(),
            taskTitle: withTask ? draft.editedTaskTitle.trim() : undefined,
          }),
        })
        const data = await res.json()

        if (data.success) {
          updateDraft(cardId, { saving: false, saved: true })
        } else {
          updateDraft(cardId, { saving: false })
        }
      } catch {
        updateDraft(cardId, { saving: false })
      }
    },
    [drafts, sessionId, updateDraft]
  )

  // ─── Render ─────────────────────────────────────────────────────────────────
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
            width: "400px",
            maxWidth: "calc(100vw - 32px)",
            borderRadius: "14px",
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            boxShadow: "0 8px 32px rgba(0,0,0,0.14)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            maxHeight: minimized ? "56px" : "560px",
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
              {ROLE_LABEL[normalizedRole] ?? "AI Assistant"}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); setMinimized((m) => !m) }}
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
              onClick={(e) => { e.stopPropagation(); setOpen(false) }}
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
                  gap: "8px",
                  minHeight: 0,
                }}
              >
                {/* Empty state */}
                {messages.length === 0 && drafts.filter((d) => !d.dismissed).length === 0 && (
                  <div>
                    <p style={{ fontSize: "13px", color: "#64748b", marginBottom: "12px", lineHeight: "1.5" }}>
                      Ask me anything about your active work. I can summarize data, suggest next steps, and draft messages for your review. Type{" "}
                      <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: "3px", fontSize: "11px" }}>note: your text</code>
                      {" "}to save a note.
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      {suggestions.map((q) => (
                        <button
                          key={q}
                          onClick={() => {
                            if (NOTE_PATTERN.test(q)) {
                              prepareNote(q.replace(NOTE_PATTERN, "").trim())
                            } else {
                              sendMessage({ text: q })
                            }
                          }}
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

                {/* Message + note draft rendering */}
                {messages.map((msg) => {
                  const rawText = getUIMessageText(msg as Parameters<typeof getUIMessageText>[0])
                  const displayText = stripNoteDraftSignal(rawText)
                  if (!displayText) return null
                  const isUser = msg.role === "user"

                  // Auto-drafts that appear after this message
                  const afterDrafts = drafts.filter((d) => d.afterMessageId === msg.id && !d.dismissed)

                  return (
                    <div key={msg.id}>
                      <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
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
                          {displayText}
                        </div>
                      </div>
                      {afterDrafts.map((d) => (
                        <NoteDraftCard
                          key={d.cardId}
                          draft={d}
                          onUpdate={updateDraft}
                          onSave={saveNote}
                          onDiscard={discardDraft}
                        />
                      ))}
                    </div>
                  )
                })}

                {/* Streaming indicator */}
                {isStreaming && messages[messages.length - 1]?.role !== "assistant" && (
                  <div style={{ display: "flex", gap: "4px", padding: "4px 0" }}>
                    {[0, 1, 2].map((i) => (
                      <div
                        key={i}
                        style={{
                          width: "6px",
                          height: "6px",
                          borderRadius: "50%",
                          background: "#94a3b8",
                          animation: `pulse 1s ease-in-out ${i * 0.2}s infinite`,
                        }}
                      />
                    ))}
                  </div>
                )}

                {/* Note prepare loading */}
                {noteLoading && (
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "8px 10px",
                    borderRadius: "10px",
                    background: "#fffbeb",
                    border: "1px solid #fde68a",
                    fontSize: "12px",
                    color: "#92400e",
                  }}>
                    <Loader2 style={{ width: "13px", height: "13px", animation: "spin 1s linear infinite" }} />
                    Preparing note draft...
                  </div>
                )}

                {/* Command-triggered drafts (no afterMessageId) */}
                {drafts
                  .filter((d) => d.afterMessageId === null && !d.dismissed)
                  .map((d) => (
                    <NoteDraftCard
                      key={d.cardId}
                      draft={d}
                      onUpdate={updateDraft}
                      onSave={saveNote}
                      onDiscard={discardDraft}
                    />
                  ))}

                {/* Draft nudge when last assistant message contains "draft" */}
                {(() => {
                  const lastA = [...messages].reverse().find((m) => m.role === "assistant")
                  const lastText = lastA
                    ? stripNoteDraftSignal(getUIMessageText(lastA as Parameters<typeof getUIMessageText>[0]))
                    : ""
                  return lastText.toLowerCase().includes("draft") && messages.length > 0 ? (
                    <div style={{
                      padding: "7px 12px",
                      background: "#fefce8",
                      borderRadius: "8px",
                      border: "1px solid #fde68a",
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "12px",
                      color: "#92400e",
                    }}>
                      <FileText style={{ width: "13px", height: "13px", flexShrink: 0 }} />
                      Draft above — review before saving or sending
                    </div>
                  ) : null
                })()}

                <div ref={messagesEndRef} />
              </div>

              {/* Input */}
              <div
                style={{
                  padding: "12px 14px",
                  borderTop: "1px solid #e2e8f0",
                  display: "flex",
                  gap: "8px",
                  alignItems: "flex-end",
                  flexShrink: 0,
                  background: "#fafafa",
                }}
              >
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={`Ask or type "note: ..." to save a note`}
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
                    background: "#ffffff",
                    maxHeight: "80px",
                    overflow: "auto",
                  }}
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isStreaming || noteLoading}
                  aria-label="Send"
                  style={{
                    width: "36px",
                    height: "36px",
                    borderRadius: "8px",
                    border: "none",
                    cursor: input.trim() && !isStreaming && !noteLoading ? "pointer" : "not-allowed",
                    background: input.trim() && !isStreaming && !noteLoading ? "#1a1a2e" : "#e2e8f0",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    transition: "background 0.15s",
                  }}
                >
                  <Send
                    style={{
                      width: "15px",
                      height: "15px",
                      color: input.trim() && !isStreaming && !noteLoading ? "#a5b4fc" : "#94a3b8",
                    }}
                  />
                </button>
              </div>

              <style>{`
                @keyframes pulse {
                  0%, 100% { opacity: 0.3; transform: scale(0.8); }
                  50% { opacity: 1; transform: scale(1); }
                }
                @keyframes spin {
                  from { transform: rotate(0deg); }
                  to { transform: rotate(360deg); }
                }
              `}</style>
            </>
          )}
        </div>
      )}
    </>
  )
}
