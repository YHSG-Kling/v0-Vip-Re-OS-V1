"use client"

import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport } from "ai"
import { useEffect, useRef, useState, useCallback } from "react"
import { X, Send, Minimize2, Sparkles, ChevronDown, FileText, StickyNote, CheckCircle2, AlertTriangle, Loader2, Zap, Mic, MicOff, Phone, Volume2 } from "lucide-react"

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
  tc: [
    "What deadlines are coming up this week?",
    "Which transactions have overdue tasks?",
    "Summarize my assigned deals",
    "Draft a status update for my busiest deal",
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
  title_agent: [
    "What transactions am I working on?",
    "Which deals have title issues noted?",
    "Which closings are scheduled this week?",
    "Flag any transactions missing title commitment dates",
  ],
  title: [
    "What transactions am I working on?",
    "Which deals have title issues noted?",
    "Which closings are scheduled this week?",
    "Flag any transactions missing title commitment dates",
  ],
  compliance_officer: [
    "How many active violations are open right now?",
    "Summarize pending content approvals",
    "Which agents have the most compliance flags this month?",
    "Generate a summary of recent audit log activity",
  ],
  superadmin: [
    "How many active brokerages are on the platform?",
    "Are there any open system errors or automation failures?",
    "Summarize recent AI feedback ratings",
    "Which brokerages were added in the last 30 days?",
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
  tc: "TC Assistant",
  transaction_coordinator: "TC Assistant",
  lender: "Lender Assistant",
  vendor: "Vendor Assistant",
  title_agent: "Title Assistant",
  title: "Title Assistant",
  compliance_officer: "Compliance Assistant",
  compliance_manager: "Compliance Assistant",
  superadmin: "Platform Assistant",
  platform_admin: "Platform Assistant",
  isa: "ISA Assistant",
  team_lead: "Team Lead Assistant",
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

      {/* Entity-type selector — lets user override AI guess or pin general note */}
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "7px 12px",
        borderBottom: "1px solid #fde68a",
        background: "#fffdf0",
        flexWrap: "wrap",
      }}>
        <span style={{ fontSize: "10px", color: "#92400e", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginRight: "2px" }}>
          Save to
        </span>
        {(["contact", "lead", "transaction", "general"] as const).map((et) => (
          <button
            key={et}
            onClick={() => onUpdate(draft.cardId, { entityType: et, entityId: et === "general" ? null : draft.entityId })}
            style={{
              padding: "3px 8px",
              fontSize: "10px",
              fontWeight: draft.entityType === et ? 700 : 500,
              borderRadius: "4px",
              border: draft.entityType === et ? "1.5px solid #92400e" : "1px solid #e2e8f0",
              cursor: "pointer",
              background: draft.entityType === et ? "#fcd34d" : "#ffffff",
              color: draft.entityType === et ? "#78350f" : "#64748b",
              textTransform: "capitalize",
            }}
          >
            {et === "general" ? "General" : et.charAt(0).toUpperCase() + et.slice(1)}
          </button>
        ))}
        {draft.entityLabel && draft.entityType !== "general" && (
          <span style={{ fontSize: "10px", color: "#78350f", marginLeft: "auto", fontStyle: "italic" }}>
            {draft.entityLabel}
          </span>
        )}
      </div>

      {/* Low-confidence warning */}
      {draft.confidence === "low" && draft.entityType === "general" && (
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

interface CallQueueItem {
  contactId: string
  name: string
  phone: string
  score: number
  reason: string
}

interface InternalAIAssistantProps {
  role: string
  wakeWord?: string     // from users.assistant_wake_name — e.g. "hey nova"
  userId?: string
}

export function InternalAIAssistant({ role, wakeWord, userId }: InternalAIAssistantProps) {
  const [open, setOpen] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const [input, setInput] = useState("")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<NoteDraft[]>([])
  const [processedMsgIds, setProcessedMsgIds] = useState<Set<string>>(new Set())
  const [noteLoading, setNoteLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // ── Voice mode state ────────────────────────────────────────────────────────
  const [voiceListening, setVoiceListening] = useState(false)   // actively capturing command
  const [wakeListening, setWakeListening] = useState(false)     // background wake word detection
  const [voiceProcessing, setVoiceProcessing] = useState(false)
  const [voiceTranscript, setVoiceTranscript] = useState("")
  const [callQueue, setCallQueue] = useState<CallQueueItem[]>([])
  const [voiceResponse, setVoiceResponse] = useState<string | null>(null)
  const [fetchedWakeWord, setFetchedWakeWord] = useState<string | null>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const wakeRecognitionRef = useRef<SpeechRecognition | null>(null)
  const synthRef = useRef<SpeechSynthesis | null>(null)

  // Fetch user's configured wake word on mount
  useEffect(() => {
    fetch("/api/internal/user-wake-word")
      .then((r) => r.json())
      .then((d) => { if (d.wakeWord) setFetchedWakeWord(d.wakeWord.toLowerCase().trim()) })
      .catch(() => {})
  }, [])

  const resolvedWakeWord = (fetchedWakeWord ?? wakeWord ?? "").toLowerCase().trim()

  // ── useChat — must be declared BEFORE any callback that references sendMessage ──
  const normalizedRole = role?.toLowerCase() ?? "agent"
  const suggestions = ROLE_SUGGESTIONS[normalizedRole] ?? ROLE_SUGGESTIONS.agent

  const [sessionIdForTransport, setSessionIdForTransport] = useState<string | null>(null)
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: "/api/internal/ai-chat",
      headers: sessionIdForTransport ? { "x-internal-session-id": sessionIdForTransport } : {},
    }),
  })

  // Keep a stable ref to sendMessage so voice callbacks never go stale
  const sendMessageRef = useRef(sendMessage)
  useEffect(() => { sendMessageRef.current = sendMessage }, [sendMessage])

  // Keep transport headers in sync with sessionId
  useEffect(() => { setSessionIdForTransport(sessionId) }, [sessionId])

  // Speak text via SpeechSynthesis
  const speakText = useCallback((text: string) => {
    if (typeof window === "undefined") return
    const synth = window.speechSynthesis
    if (!synth) return
    synthRef.current = synth
    synth.cancel() // stop any current speech
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 1.05
    utterance.pitch = 1.0
    utterance.volume = 1.0
    // Prefer a natural-sounding voice
    const voices = synth.getVoices()
    const preferred = voices.find((v) => /samantha|google us|zira|natural/i.test(v.name))
    if (preferred) utterance.voice = preferred
    synth.speak(utterance)
  }, [])

  // Process a voice command transcript
  const processVoiceCommand = useCallback(async (transcript: string) => {
    if (!transcript.trim()) return
    setVoiceProcessing(true)
    setVoiceTranscript(transcript)
    setVoiceResponse(null)
    setCallQueue([])

    try {
      const res = await fetch("/api/internal/voice-command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript, sessionId }),
      })
      const data = await res.json()

      if (data.spokenResponse) {
        setVoiceResponse(data.spokenResponse)
        speakText(data.spokenResponse)
      }
      if (data.callQueue && data.callQueue.length > 0) {
        setCallQueue(data.callQueue)
      }
      // If the intent is general, also forward to text chat
      if (data.action === "forward_to_chat") {
        sendMessageRef.current({ text: transcript })
      }
    } catch {
      const errMsg = "Sorry, I couldn't process that command. Please try again."
      setVoiceResponse(errMsg)
      speakText(errMsg)
    } finally {
      setVoiceProcessing(false)
    }
  }, [sessionId, speakText])

  // Start single-command voice capture
  const startVoiceCapture = useCallback(() => {
    if (typeof window === "undefined") return
    const SR = (window as Window & { webkitSpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition
      ?? (window as Window & { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition
    if (!SR) { alert("Voice recognition not supported in this browser."); return }

    if (recognitionRef.current) {
      try { recognitionRef.current.stop() } catch { /* ignore */ }
    }

    const recognition = new SR()
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = "en-US"
    recognitionRef.current = recognition

    setVoiceListening(true)
    setVoiceTranscript("")
    if (!open) { setOpen(true); setMinimized(false) }

    recognition.onresult = (e: SpeechRecognitionEvent) => {
      const transcript = Array.from(e.results).map((r) => r[0].transcript).join(" ")
      setVoiceListening(false)
      processVoiceCommand(transcript)
    }
    recognition.onerror = () => { setVoiceListening(false) }
    recognition.onend = () => { setVoiceListening(false) }
    recognition.start()
  }, [open, processVoiceCommand])

  // Background wake-word detection — runs whenever component is mounted
  useEffect(() => {
    if (typeof window === "undefined") return
    const SR = (window as Window & { webkitSpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition
      ?? (window as Window & { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition
    if (!SR) return

    let active = true

    const startWakeDetection = () => {
      if (!active) return
      const wr = new SR()
      wr.continuous = false
      wr.interimResults = false
      wr.lang = "en-US"
      wakeRecognitionRef.current = wr
      setWakeListening(true)

      wr.onresult = (e: SpeechRecognitionEvent) => {
        const heard = Array.from(e.results).map((r) => r[0].transcript).join(" ").toLowerCase()
        if (heard.includes(resolvedWakeWord)) {
          // Wake word detected — start command capture immediately
          setTimeout(() => { if (active) startVoiceCapture() }, 300)
        } else {
          // Restart wake detection
          setTimeout(() => { if (active) startWakeDetection() }, 500)
        }
      }
      wr.onerror = () => { setTimeout(() => { if (active) startWakeDetection() }, 1500) }
      wr.onend = () => {
        setWakeListening(false)
        setTimeout(() => { if (active) startWakeDetection() }, 500)
      }

      try { wr.start() } catch { /* already running */ }
    }

    // Only auto-start wake detection when wake word is configured
    if (resolvedWakeWord && resolvedWakeWord !== "hey nova") {
      startWakeDetection()
    }

    return () => {
      active = false
      setWakeListening(false)
      try { wakeRecognitionRef.current?.stop() } catch { /* ignore */ }
    }
  }, [resolvedWakeWord, startVoiceCapture])

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
                      Ask me anything or tell me to take action. I can summarize data, create tasks, schedule follow-ups, send portal messages, and log activities. Type{" "}
                      <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: "3px", fontSize: "11px" }}>note: your text</code>
                      {" "}to save a note.
                    </p>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" }}>
                      <Zap style={{ width: "12px", height: "12px", color: "#7c3aed" }} />
                      <span style={{ fontSize: "11px", fontWeight: 600, color: "#7c3aed", textTransform: "uppercase", letterSpacing: "0.05em" }}>Actions</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "12px" }}>
                      {[
                        "Create a task to follow up with my top lead tomorrow",
                        "Schedule a follow-up call with my most engaged contact",
                        "Log a completed showing for my active buyer",
                        "Send a portal message to a client with a status update",
                      ].map((q) => (
                        <button
                          key={q}
                          onClick={() => sendMessage({ text: q })}
                          style={{
                            textAlign: "left",
                            padding: "8px 12px",
                            fontSize: "12px",
                            color: "#6d28d9",
                            background: "#f5f3ff",
                            border: "1px solid #ddd6fe",
                            borderRadius: "8px",
                            cursor: "pointer",
                            lineHeight: "1.4",
                          }}
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" }}>
                      <FileText style={{ width: "12px", height: "12px", color: "#0284c7" }} />
                      <span style={{ fontSize: "11px", fontWeight: 600, color: "#0284c7", textTransform: "uppercase", letterSpacing: "0.05em" }}>Insights</span>
                    </div>
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

                {/* Message + tool result + note draft rendering */}
                {messages.map((msg) => {
                  const rawText = getUIMessageText(msg as Parameters<typeof getUIMessageText>[0])
                  const displayText = stripNoteDraftSignal(rawText)
                  const isUser = msg.role === "user"

                  // Tool invocation parts from this message
                  const toolParts = (msg.parts ?? []).filter(
                    (p: { type: string }) => p.type === "tool-invocation"
                  ) as Array<{
                    type: "tool-invocation"
                    toolInvocation: {
                      toolCallId: string
                      toolName: string
                      state: string
                      input?: Record<string, unknown>
                      output?: unknown
                    }
                  }>

                  // Auto-drafts that appear after this message
                  const afterDrafts = drafts.filter((d) => d.afterMessageId === msg.id && !d.dismissed)

                  const hasContent = displayText || toolParts.length > 0
                  if (!hasContent) return null

                  return (
                    <div key={msg.id} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      {displayText && (
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
                      )}

                      {/* Tool invocation result cards */}
                      {toolParts.map((p) => {
                        const inv = p.toolInvocation
                        const isPending = inv.state === "input-available" || inv.state === "input-streaming"
                        const isError = inv.state === "output-error"
                        const output = inv.output as Record<string, unknown> | undefined
                        const succeeded = output?.success === true

                        const TOOL_LABELS: Record<string, string> = {
                          create_task: "Task Created",
                          schedule_follow_up: "Follow-Up Scheduled",
                          send_portal_message: "Message Sent",
                          update_contact_status: "Contact Updated",
                          log_activity: "Activity Logged",
                        }
                        const label = TOOL_LABELS[inv.toolName] ?? inv.toolName.replace(/_/g, " ")

                        return (
                          <div
                            key={inv.toolCallId}
                            style={{
                              display: "flex",
                              alignItems: "flex-start",
                              gap: "8px",
                              padding: "10px 12px",
                              borderRadius: "10px",
                              background: isPending ? "#f8fafc" : succeeded ? "#f0fdf4" : isError ? "#fef2f2" : "#fef9c3",
                              border: `1px solid ${isPending ? "#e2e8f0" : succeeded ? "#86efac" : isError ? "#fca5a5" : "#fde68a"}`,
                              fontSize: "12px",
                              color: isPending ? "#64748b" : succeeded ? "#166534" : "#991b1b",
                            }}
                          >
                            {isPending ? (
                              <Loader2 style={{ width: "14px", height: "14px", flexShrink: 0, animation: "spin 1s linear infinite" }} />
                            ) : succeeded ? (
                              <CheckCircle2 style={{ width: "14px", height: "14px", flexShrink: 0 }} />
                            ) : (
                              <AlertTriangle style={{ width: "14px", height: "14px", flexShrink: 0 }} />
                            )}
                            <div>
                              <div style={{ fontWeight: 600, marginBottom: "2px" }}>
                                {isPending ? `Running: ${label}...` : succeeded ? label : `Failed: ${label}`}
                              </div>
                              {!isPending && output && (
                                <div style={{ opacity: 0.8 }}>
                                  {succeeded
                                    ? (output.title as string ?? output.name as string ?? output.preview as string ?? "Done")
                                    : (output.error as string ?? "Something went wrong")}
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })}

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

                {/* Voice listening indicator */}
                {voiceListening && (
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "12px 14px",
                    borderRadius: "12px",
                    background: "#fef2f2",
                    border: "2px solid #ef4444",
                    fontSize: "13px",
                    color: "#b91c1c",
                    fontWeight: 600,
                  }}>
                    <div style={{ display: "flex", gap: "3px" }}>
                      {[0, 1, 2, 3].map((i) => (
                        <div key={i} style={{
                          width: "4px",
                          borderRadius: "2px",
                          background: "#ef4444",
                          animation: `voiceBar 0.6s ease-in-out ${i * 0.1}s infinite alternate`,
                          height: `${8 + i * 4}px`,
                        }} />
                      ))}
                    </div>
                    Listening... speak your command
                  </div>
                )}

                {/* Voice processing indicator */}
                {voiceProcessing && !voiceListening && (
                  <div style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    padding: "10px 14px",
                    borderRadius: "12px",
                    background: "#f0f9ff",
                    border: "1px solid #bae6fd",
                    fontSize: "13px",
                    color: "#0369a1",
                  }}>
                    <Loader2 style={{ width: "14px", height: "14px", animation: "spin 1s linear infinite" }} />
                    <span>Processing: <em>{voiceTranscript}</em></span>
                  </div>
                )}

                {/* Voice response card */}
                {voiceResponse && !voiceProcessing && (
                  <div style={{
                    padding: "12px 14px",
                    borderRadius: "12px",
                    background: "#f0f9ff",
                    border: "1px solid #7dd3fc",
                    fontSize: "13px",
                    color: "#0c4a6e",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px", fontWeight: 600, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", color: "#0284c7" }}>
                      <Volume2 style={{ width: "12px", height: "12px" }} />
                      Voice Response
                    </div>
                    <div style={{ lineHeight: "1.55" }}>{voiceResponse}</div>
                    {voiceTranscript && (
                      <div style={{ marginTop: "6px", fontSize: "11px", color: "#64748b", fontStyle: "italic" }}>
                        You said: &ldquo;{voiceTranscript}&rdquo;
                      </div>
                    )}
                    <button
                      onClick={() => speakText(voiceResponse)}
                      style={{ marginTop: "8px", fontSize: "11px", color: "#0284c7", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                    >
                      Replay
                    </button>
                  </div>
                )}

                {/* Call queue — shown after hot contacts query */}
                {callQueue.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <div style={{ fontSize: "11px", fontWeight: 600, color: "#7c3aed", textTransform: "uppercase", letterSpacing: "0.05em", display: "flex", alignItems: "center", gap: "6px" }}>
                      <Phone style={{ width: "12px", height: "12px" }} />
                      Call Queue — {callQueue.length} contact{callQueue.length > 1 ? "s" : ""}
                    </div>
                    {callQueue.map((contact, idx) => (
                      <div key={contact.contactId} style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "10px 12px",
                        borderRadius: "10px",
                        background: "#faf5ff",
                        border: "1px solid #ddd6fe",
                        gap: "10px",
                      }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: "13px", color: "#1e293b" }}>
                            {idx + 1}. {contact.name}
                          </div>
                          <div style={{ fontSize: "11px", color: "#64748b" }}>{contact.reason}</div>
                          <div style={{ fontSize: "12px", color: "#7c3aed", marginTop: "2px" }}>{contact.phone}</div>
                        </div>
                        <a
                          href={`tel:${contact.phone.replace(/\D/g, "")}`}
                          style={{
                            padding: "6px 12px",
                            borderRadius: "8px",
                            background: "#7c3aed",
                            color: "#fff",
                            fontSize: "12px",
                            fontWeight: 600,
                            textDecoration: "none",
                            flexShrink: 0,
                            display: "flex",
                            alignItems: "center",
                            gap: "4px",
                          }}
                          onClick={() => speakText(`Calling ${contact.name}`)}
                        >
                          <Phone style={{ width: "11px", height: "11px" }} />
                          Call
                        </a>
                      </div>
                    ))}
                    <button
                      onClick={() => setCallQueue([])}
                      style={{ fontSize: "11px", color: "#94a3b8", background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: 0 }}
                    >
                      Clear queue
                    </button>
                  </div>
                )}

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
                {/* Mic button */}
                <button
                  onClick={startVoiceCapture}
                  disabled={voiceListening || voiceProcessing}
                  aria-label={voiceListening ? "Listening..." : "Voice command"}
                  title={`Voice command (wake word: "${resolvedWakeWord}")`}
                  style={{
                    width: "36px",
                    height: "36px",
                    borderRadius: "8px",
                    border: "none",
                    cursor: voiceListening || voiceProcessing ? "not-allowed" : "pointer",
                    background: voiceListening ? "#fef2f2" : wakeListening ? "#f0fdf4" : "#f8fafc",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    transition: "background 0.15s",
                    outline: voiceListening ? "2px solid #ef4444" : wakeListening ? "2px solid #22c55e" : "none",
                  }}
                >
                  {voiceListening
                    ? <MicOff style={{ width: "15px", height: "15px", color: "#ef4444" }} />
                    : <Mic style={{ width: "15px", height: "15px", color: wakeListening ? "#22c55e" : "#64748b" }} />
                  }
                </button>

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
                @keyframes voiceBar {
                  from { transform: scaleY(0.4); opacity: 0.6; }
                  to   { transform: scaleY(1.6); opacity: 1; }
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
