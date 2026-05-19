"use client"

import { useState, useTransition } from "react"
import { Badge }                    from "@/components/ui/badge"
import { Button }                   from "@/components/ui/button"
import { Textarea }                 from "@/components/ui/textarea"
import { cn }                       from "@/lib/utils"
import { createClient }             from "@/lib/supabase/client"
import { generateAIReplyDraft }     from "@/app/actions/ai-reply-coach"
import { useToast }                 from "@/hooks/use-toast"

interface Draft {
  id:               string
  draft_body:       string
  draft_subject:    string | null
  suggested_tone:   string | null
  confidence_score: number | null
  channel:          string
  created_at:       string
  status:           string
}

interface ConversationCoachingPanelProps {
  contactId:   string
  brokerageId: string
  agentUserId: string
  initialDrafts: Draft[]
}

const CHANNEL_COLORS: Record<string, string> = {
  email:  "bg-blue-100 text-blue-800 border-blue-200",
  sms:    "bg-green-100 text-green-800 border-green-200",
  in_app: "bg-slate-100 text-slate-800 border-slate-200",
}

export function ConversationCoachingPanel({
  contactId, brokerageId, agentUserId, initialDrafts,
}: ConversationCoachingPanelProps) {
  const { toast }           = useToast()
  const [, startTransition]  = useTransition()
  const [drafts, setDrafts]  = useState<Draft[]>(initialDrafts)
  const [generating, setGenerating] = useState(false)
  const [editingId, setEditingId]   = useState<string | null>(null)
  const [editBody, setEditBody]     = useState("")
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const pending = drafts.filter(d => d.status === "pending")

  async function handleGenerate() {
    setGenerating(true)
    const supabase = createClient()
    // Load or create a stub conversation id for proactive check-in
    const { data: conv } = await supabase
      .from("conversations")
      .select("id")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    const conversationId = conv?.id ?? contactId // fallback to contactId

    const result = await generateAIReplyDraft({
      brokerageId,
      agentUserId,
      conversationId,
      contactId,
      inboundMessageId: null,
      inboundBody:      "",
      channel:          "in_app",
    })
    setGenerating(false)
    if (result.success && result.draftId) {
      const newDraft: Draft = {
        id:               result.draftId,
        draft_body:       result.draftBody ?? "",
        draft_subject:    result.draftSubject ?? null,
        suggested_tone:   result.suggestedTone ?? null,
        confidence_score: result.confidenceScore ?? null,
        channel:          "in_app",
        created_at:       new Date().toISOString(),
        status:           "pending",
      }
      setDrafts(prev => [newDraft, ...prev])
      toast({ title: "Draft generated" })
    } else {
      toast({ title: "Generation failed", description: result.error, variant: "destructive" })
    }
  }

  function handleUseDraft(draft: Draft) {
    startTransition(async () => {
      const supabase = createClient()
      await supabase
        .from("ai_message_drafts")
        .update({ status: "accepted", acted_at: new Date().toISOString(), final_body: draft.draft_body })
        .eq("id", draft.id)
      setDrafts(prev => prev.map(d => d.id === draft.id ? { ...d, status: "accepted" } : d))
      toast({ title: "Draft accepted", description: "Body copied to clipboard" })
      await navigator.clipboard.writeText(draft.draft_body).catch(() => {})
    })
  }

  function startEdit(draft: Draft) {
    setEditingId(draft.id)
    setEditBody(draft.draft_body)
  }

  function handleSaveEdit(draft: Draft) {
    startTransition(async () => {
      const supabase = createClient()
      await supabase
        .from("ai_message_drafts")
        .update({ status: "accepted", final_body: editBody, acted_at: new Date().toISOString() })
        .eq("id", draft.id)
      setDrafts(prev => prev.map(d => d.id === draft.id ? { ...d, draft_body: editBody, status: "accepted" } : d))
      setEditingId(null)
      toast({ title: "Draft edited and accepted" })
    })
  }

  function handleDismiss(id: string) {
    startTransition(async () => {
      const supabase = createClient()
      await supabase
        .from("ai_message_drafts")
        .update({ status: "dismissed", acted_at: new Date().toISOString() })
        .eq("id", id)
      setDrafts(prev => prev.map(d => d.id === id ? { ...d, status: "dismissed" } : d))
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          AI Reply Drafts
          {pending.length > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold w-4 h-4">
              {pending.length}
            </span>
          )}
        </h3>
      </div>

      {/* Draft cards */}
      {pending.length === 0 ? (
        <p className="text-xs text-muted-foreground py-3 text-center">No pending drafts</p>
      ) : (
        <div className="space-y-3">
          {pending.map(draft => (
            <div key={draft.id} className="rounded-md border border-border bg-card overflow-hidden">
              {/* Draft meta row */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-wrap">
                <Badge className={cn("text-[10px] border", CHANNEL_COLORS[draft.channel] ?? CHANNEL_COLORS.in_app)}>
                  {draft.channel.replace("_", " ")}
                </Badge>
                {draft.suggested_tone && (
                  <Badge variant="outline" className="text-[10px]">{draft.suggested_tone}</Badge>
                )}
                {draft.confidence_score != null && (
                  <span className="text-[10px] text-muted-foreground ml-auto">{draft.confidence_score}% confidence</span>
                )}
              </div>

              {/* Draft body */}
              <div className="px-3 py-2">
                {editingId === draft.id ? (
                  <Textarea
                    value={editBody}
                    onChange={e => setEditBody(e.target.value)}
                    className="text-xs min-h-[80px] resize-none"
                    autoFocus
                  />
                ) : (
                  <p className="text-xs text-foreground leading-relaxed">
                    {expandedId === draft.id
                      ? draft.draft_body
                      : draft.draft_body.slice(0, 140) + (draft.draft_body.length > 140 ? "…" : "")}
                  </p>
                )}
                {draft.draft_body.length > 140 && editingId !== draft.id && (
                  <button
                    onClick={() => setExpandedId(expandedId === draft.id ? null : draft.id)}
                    className="text-[10px] text-primary hover:underline mt-1"
                  >
                    {expandedId === draft.id ? "Show less" : "Read more"}
                  </button>
                )}
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 px-3 py-2 border-t border-border">
                {editingId === draft.id ? (
                  <>
                    <Button size="sm" className="h-7 text-xs" onClick={() => handleSaveEdit(draft)}>Save &amp; Accept</Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingId(null)}>Cancel</Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" className="h-7 text-xs" onClick={() => handleUseDraft(draft)}>Use Draft</Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => startEdit(draft)}>Edit</Button>
                    <button
                      onClick={() => handleDismiss(draft.id)}
                      className="ml-auto text-muted-foreground hover:text-destructive transition-colors"
                      aria-label="Dismiss"
                    >
                      <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none">
                        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Generate button */}
      <Button
        variant="outline"
        size="sm"
        className="w-full text-xs"
        disabled={generating}
        onClick={handleGenerate}
      >
        {generating ? "Generating..." : "Generate Draft"}
      </Button>
    </div>
  )
}
