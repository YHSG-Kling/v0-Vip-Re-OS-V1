"use client"

import { useState, useTransition, useEffect, useCallback } from "react"
import {
  Sparkles, CheckCheck, X, RotateCcw, ChevronDown, ChevronUp,
  Loader2, Info, Edit3, Zap,
} from "lucide-react"
import { Button }   from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge }    from "@/components/ui/badge"
import { cn }       from "@/lib/utils"
import {
  generateAIReplyDraft,
  acceptDraft,
  rejectDraft,
  loadConversationDrafts,
} from "@/app/actions/ai-reply-coach"

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface Draft {
  id:               string
  draft_body:       string
  draft_subject:    string | null
  suggested_tone:   string | null
  confidence_score: number | null
  channel:          string
  created_at:       string
  status:           string
  /** only present on freshly-generated drafts, not from DB load */
  brandVoiceNotes?: string[]
}

interface AIReplyCoachPanelProps {
  brokerageId:      string
  agentUserId:      string
  conversationId:   string | null
  contactId:        string | null
  listingId?:       string
  /** Latest inbound message — triggers auto-draft offer */
  lastInboundId?:   string
  lastInboundBody?: string
  channel:          "email" | "sms" | "in_app"
  /** Called when agent accepts a draft — populates the ComposeBar */
  onAccepted: (body: string, subject?: string) => void
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function confidenceBadge(score: number | null) {
  if (score === null) return null
  if (score >= 80) return (
    <Badge className="bg-green-100 text-green-800 border-green-200 text-[10px] h-4 px-1.5">
      {score}% confidence
    </Badge>
  )
  if (score >= 60) return (
    <Badge className="bg-amber-100 text-amber-800 border-amber-200 text-[10px] h-4 px-1.5">
      {score}% confidence
    </Badge>
  )
  return (
    <Badge className="bg-red-100 text-red-800 border-red-200 text-[10px] h-4 px-1.5">
      {score}% confidence
    </Badge>
  )
}

const TONE_LABELS: Record<string, string> = {
  professional: "Professional",
  friendly:     "Friendly",
  empathetic:   "Empathetic",
  assertive:    "Assertive",
}

// ─── COMPONENT ───────────────────────────────────────────────────────────────

export default function AIReplyCoachPanel({
  brokerageId,
  agentUserId,
  conversationId,
  contactId,
  listingId,
  lastInboundId,
  lastInboundBody,
  channel,
  onAccepted,
}: AIReplyCoachPanelProps) {
  const [drafts, setDrafts]           = useState<Draft[]>([])
  const [expanded, setExpanded]       = useState<string | null>(null)
  const [editingId, setEditingId]     = useState<string | null>(null)
  const [editBody, setEditBody]       = useState("")
  const [notesOpen, setNotesOpen]     = useState<string | null>(null)
  const [isGenerating, startGenerate] = useTransition()
  const [isActing, startAct]          = useTransition()
  const [error, setError]             = useState<string | null>(null)
  const [toneOverride, setToneOverride] = useState<"professional"|"friendly"|"empathetic"|"assertive">("professional")

  // Load persisted pending drafts on conversation change
  useEffect(() => {
    if (!conversationId) { setDrafts([]); return }
    loadConversationDrafts(conversationId).then(r => {
      if (r.success && r.drafts) {
        setDrafts(r.drafts.map(d => ({
          ...d,
          draft_body:       d.draft_body ?? "",
          draft_subject:    d.draft_subject ?? null,
          suggested_tone:   d.suggested_tone ?? null,
          confidence_score: d.confidence_score ?? null,
          channel:          d.channel ?? channel,
          created_at:       d.created_at ?? new Date().toISOString(),
          status:           d.status ?? "pending",
        })))
      }
    })
  }, [conversationId, channel])

  const handleGenerate = useCallback(() => {
    if (!conversationId || !contactId || !lastInboundId || !lastInboundBody) return
    setError(null)
    startGenerate(async () => {
      const result = await generateAIReplyDraft({
        brokerageId,
        agentUserId,
        conversationId,
        contactId,
        listingId,
        inboundMessageId: lastInboundId,
        inboundBody:      lastInboundBody,
        channel,
        toneOverride,
      })
      if (result.success && result.draftId) {
        const newDraft: Draft = {
          id:               result.draftId,
          draft_body:       result.draftBody ?? "",
          draft_subject:    result.draftSubject ?? null,
          suggested_tone:   result.suggestedTone ?? toneOverride,
          confidence_score: result.confidenceScore ?? null,
          channel,
          created_at:       new Date().toISOString(),
          status:           "pending",
          brandVoiceNotes:  result.brandVoiceNotes,
        }
        setDrafts(prev => [newDraft, ...prev])
        setExpanded(newDraft.id)
      } else {
        setError(result.error ?? "Draft generation failed")
      }
    })
  }, [brokerageId, agentUserId, conversationId, contactId, listingId, lastInboundId, lastInboundBody, channel, toneOverride])

  const handleAccept = (draft: Draft) => {
    const body = editingId === draft.id ? editBody : draft.draft_body
    setError(null)
    startAct(async () => {
      const result = await acceptDraft({
        draftId:      draft.id,
        agentUserId,
        finalBody:    body,
        finalSubject: draft.draft_subject ?? undefined,
      })
      if (result.success) {
        setDrafts(prev => prev.filter(d => d.id !== draft.id))
        setEditingId(null)
        onAccepted(body, draft.draft_subject ?? undefined)
      } else {
        setError(result.error ?? "Accept failed")
      }
    })
  }

  const handleReject = (draftId: string) => {
    setError(null)
    startAct(async () => {
      const result = await rejectDraft({ draftId, agentUserId })
      if (result.success) {
        setDrafts(prev => prev.filter(d => d.id !== draftId))
        if (editingId === draftId) setEditingId(null)
        if (expanded   === draftId) setExpanded(null)
      } else {
        setError(result.error ?? "Reject failed")
      }
    })
  }

  const startEdit = (draft: Draft) => {
    setEditingId(draft.id)
    setEditBody(draft.draft_body)
    setExpanded(draft.id)
  }

  const hasInbound = !!(lastInboundId && lastInboundBody && conversationId && contactId)

  return (
    <div className="flex flex-col h-full border-l border-border bg-background w-[280px] shrink-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
        <Sparkles size={14} className="text-primary shrink-0" />
        <span className="text-xs font-semibold text-foreground">AI Reply Coach</span>
        {drafts.length > 0 && (
          <Badge className="ml-auto h-4 px-1.5 text-[10px] bg-primary text-primary-foreground">
            {drafts.length}
          </Badge>
        )}
      </div>

      {/* Generate controls */}
      <div className="px-3 py-2 border-b border-border shrink-0 space-y-2">
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] text-muted-foreground font-medium">Tone</label>
          <select
            value={toneOverride}
            onChange={e => setToneOverride(e.target.value as typeof toneOverride)}
            disabled={isGenerating}
            className="flex-1 text-[11px] border border-border rounded px-1.5 py-0.5 bg-background text-foreground"
          >
            {Object.entries(TONE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
        <Button
          size="sm"
          variant="default"
          className="w-full h-7 text-xs gap-1.5"
          onClick={handleGenerate}
          disabled={isGenerating || !hasInbound}
        >
          {isGenerating
            ? <><Loader2 size={12} className="animate-spin" /> Drafting…</>
            : <><Zap size={12} /> Generate Draft</>
          }
        </Button>
        {!hasInbound && (
          <p className="text-[10px] text-muted-foreground text-center">
            Select a conversation with an inbound message
          </p>
        )}
      </div>

      {error && (
        <div className="px-3 py-2 text-[11px] text-destructive bg-destructive/5 border-b border-destructive/20">
          {error}
        </div>
      )}

      {/* Draft list */}
      <div className="flex-1 overflow-y-auto">
        {drafts.length === 0 && !isGenerating && (
          <div className="flex flex-col items-center justify-center h-full gap-1.5 text-center px-4">
            <Sparkles size={20} className="text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">No pending drafts</p>
            <p className="text-[10px] text-muted-foreground/60">
              Generate a draft from the latest inbound message
            </p>
          </div>
        )}

        {drafts.map(draft => {
          const isOpen    = expanded   === draft.id
          const isEditing = editingId  === draft.id
          const isNotes   = notesOpen  === draft.id

          return (
            <div
              key={draft.id}
              className="border-b border-border last:border-0"
            >
              {/* Draft header row */}
              <button
                className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/40 transition-colors text-left"
                onClick={() => setExpanded(isOpen ? null : draft.id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[11px] font-medium text-foreground capitalize">
                      {TONE_LABELS[draft.suggested_tone ?? ""] ?? draft.suggested_tone ?? "Draft"}
                    </span>
                    {confidenceBadge(draft.confidence_score)}
                  </div>
                  {!isOpen && (
                    <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                      {draft.draft_body.substring(0, 60)}…
                    </p>
                  )}
                </div>
                {isOpen
                  ? <ChevronUp size={13} className="shrink-0 text-muted-foreground" />
                  : <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
                }
              </button>

              {/* Expanded draft body */}
              {isOpen && (
                <div className="px-3 pb-3 space-y-2">
                  {draft.draft_subject && (
                    <p className="text-[10px] text-muted-foreground">
                      <span className="font-medium">Subject:</span> {draft.draft_subject}
                    </p>
                  )}

                  {isEditing ? (
                    <Textarea
                      value={editBody}
                      onChange={e => setEditBody(e.target.value)}
                      className="text-xs min-h-[100px] max-h-[200px] resize-none"
                      autoFocus
                    />
                  ) : (
                    <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap bg-muted/30 rounded-md px-2.5 py-2">
                      {draft.draft_body}
                    </p>
                  )}

                  {/* Brand voice notes toggle */}
                  {draft.brandVoiceNotes && draft.brandVoiceNotes.length > 0 && (
                    <div>
                      <button
                        className="flex items-center gap-1 text-[10px] text-primary"
                        onClick={() => setNotesOpen(isNotes ? null : draft.id)}
                      >
                        <Info size={11} />
                        {isNotes ? "Hide" : "Show"} brand voice notes ({draft.brandVoiceNotes.length})
                      </button>
                      {isNotes && (
                        <ul className="mt-1 space-y-0.5 pl-3">
                          {draft.brandVoiceNotes.map((note, i) => (
                            <li key={i} className="text-[10px] text-muted-foreground list-disc">
                              {note}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex items-center gap-1.5 pt-0.5">
                    <Button
                      size="sm"
                      className="h-6 text-[11px] gap-1 flex-1"
                      onClick={() => handleAccept(draft)}
                      disabled={isActing}
                    >
                      {isActing
                        ? <Loader2 size={11} className="animate-spin" />
                        : <CheckCheck size={11} />
                      }
                      {isEditing ? "Accept Edits" : "Accept"}
                    </Button>

                    {!isEditing ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px] gap-1 px-2"
                        onClick={() => startEdit(draft)}
                        disabled={isActing}
                      >
                        <Edit3 size={11} />
                        Edit
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px] gap-1 px-2"
                        onClick={() => { setEditingId(null); setEditBody("") }}
                        disabled={isActing}
                      >
                        <RotateCcw size={11} />
                      </Button>
                    )}

                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[11px] px-2 text-muted-foreground hover:text-destructive"
                      onClick={() => handleReject(draft.id)}
                      disabled={isActing}
                    >
                      <X size={11} />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
