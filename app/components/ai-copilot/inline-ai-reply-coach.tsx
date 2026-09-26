"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Sparkles, ThumbsDown, Loader2, Copy } from "lucide-react"
import { generateAIReplyDraft, acceptDraft, rejectDraft, loadConversationDrafts } from "@/app/actions/ai-reply-coach"
import { checkThemFirstCompliance } from "@/app/actions/ai-chat"
import { getBrandVoiceProfile } from "@/app/actions/ai-content-generation"
import { toast } from "sonner"

interface InlineAiReplyCoachProps {
  conversationId: string
  agentId: string
  contactName?: string
  onAcceptDraft: (draft: string) => void
}

interface Draft {
  id: string
  content: string
  tone: string
  created_at: string
}

export function InlineAiReplyCoach({
  conversationId,
  agentId,
  contactName,
  onAcceptDraft,
}: InlineAiReplyCoachProps) {
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [complianceResults, setComplianceResults] = useState<
    Record<string, { passes: boolean; message?: string }>
  >({})

  useEffect(() => {
    loadDrafts()
  }, [conversationId])

  const loadDrafts = async () => {
    try {
      const loaded = await loadConversationDrafts(conversationId)
      const rawDrafts = (loaded?.drafts ?? []).map((d: any) => ({
        id: d.id,
        content: d.draft_body,
        tone: d.suggested_tone ?? "professional",
        created_at: d.created_at,
      }))
      setDrafts(rawDrafts)
    } catch (error) {
      console.error("Error loading drafts:", error)
    }
  }

  const handleGenerateNewDraft = async () => {
    setLoading(true)
    try {
      const profile = await getBrandVoiceProfile(agentId)

      const result = await generateAIReplyDraft({
        conversationId,
        agentUserId: agentId,
        brandVoiceProfile: profile,
        contactName,
      } as any)

      const draft: Draft = {
        id: (result as any).draftId ?? String(Date.now()),
        content: (result as any).draftBody ?? "",
        tone: (result as any).suggestedTone ?? "professional",
        created_at: new Date().toISOString(),
      }

      setDrafts((prev) => [draft, ...prev])
      setSelectedDraftId(draft.id)

      // Check compliance
      const compliance = await checkThemFirstCompliance(draft.content)
      setComplianceResults((prev) => ({
        ...prev,
        [draft.id]: compliance,
      }))

      toast.success("Draft generated!")
    } catch (error) {
      console.error("Error generating draft:", error)
      toast.error("Failed to generate draft")
    } finally {
      setLoading(false)
    }
  }

  const handleAcceptDraft = async (draft: Draft) => {
    try {
      await acceptDraft({
        draftId: draft.id,
        agentUserId: agentId,
        finalBody: draft.content,
      } as any)
      onAcceptDraft(draft.content)
      toast.success("Draft accepted!")
    } catch (error) {
      console.error("Error accepting draft:", error)
      toast.error("Failed to accept draft")
    }
  }

  const handleRejectDraft = async (draftId: string) => {
    try {
      await rejectDraft({
        draftId,
        agentUserId: agentId,
        reason: "not_helpful",
      } as any)
      setDrafts((prev) => prev.filter((d) => d.id !== draftId))
      toast.success("Draft rejected")
    } catch (error) {
      console.error("Error rejecting draft:", error)
      toast.error("Failed to reject draft")
    }
  }

  const selectedDraft = drafts.find((d) => d.id === selectedDraftId)
  const compliance = selectedDraftId
    ? complianceResults[selectedDraftId]
    : null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-4 w-4" />
          AI Reply Coach
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Existing Drafts */}
        {drafts.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-semibold">Suggested Replies</p>
            {drafts.slice(0, 3).map((draft) => (
              <div
                key={draft.id}
                onClick={() => setSelectedDraftId(draft.id)}
                className={`p-2 rounded border cursor-pointer transition-colors ${
                  selectedDraftId === draft.id
                    ? "border-primary bg-primary/5"
                    : "border-muted hover:border-muted-foreground/50"
                }`}
              >
                <p className="text-xs text-muted-foreground truncate">
                  {draft.content}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="secondary" className="text-xs">
                    {draft.tone}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Generate New Draft */}
        <Button
          onClick={handleGenerateNewDraft}
          disabled={loading}
          className="w-full"
          size="sm"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Generating...
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4 mr-2" />
              Generate New Draft
            </>
          )}
        </Button>

        {/* Selected Draft Actions */}
        {selectedDraft && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs font-semibold">Preview</p>
            <p className="text-sm p-2 bg-gray-50 rounded">
              {selectedDraft.content}
            </p>

            {compliance && (
              <div
                className={`flex items-start gap-2 text-xs p-2 rounded ${
                  compliance.passes
                    ? "bg-green-50 text-green-700"
                    : "bg-amber-50 text-amber-700"
                }`}
              >
                <span>
                  {compliance.passes
                    ? "✓ Them First Compliant"
                    : "⚠ " + compliance.message}
                </span>
              </div>
            )}

            <div className="flex gap-2">
              <Button
                onClick={() => handleAcceptDraft(selectedDraft)}
                size="sm"
                className="flex-1"
              >
                Use This
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(selectedDraft.content)
                  toast.success("Copied!")
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleRejectDraft(selectedDraft.id)}
              >
                <ThumbsDown className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
