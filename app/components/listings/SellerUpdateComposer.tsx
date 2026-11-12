"use client"

import { useEffect, useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, Sparkles, Send, Save, Trash2, Eye, AlertTriangle } from "lucide-react"
import {
  generateSellerUpdateDraft,
  sendSellerUpdate,
  saveSellerUpdateDraft,
  loadSellerUpdateDraft,
} from "@/app/actions/seller-updates"
import { ContextualAiAssistBar } from "@/app/components/ai-copilot"

interface SellerUpdateComposerProps {
  listingId: string
  agentId: string
  listingAddress: string
  sellerName: string
}

export function SellerUpdateComposer({
  listingId,
  agentId,
  listingAddress,
  sellerName,
}: SellerUpdateComposerProps) {
  const [draft, setDraft] = useState("")
  const [isDraft, setIsDraft] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [context, setContext] = useState<{
    showingCount: number
    dom: number
    avgRating: number | null
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const [isGenerating, startGenerating] = useTransition()
  const [isSending, startSending] = useTransition()
  const [isSaving, startSaving] = useTransition()
  // The pending draft saved on an earlier visit (ai_message_drafts, trigger seller_update) — wave 142.
  const [savedDraftId, setSavedDraftId] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    loadSellerUpdateDraft(listingId)
      .then((r) => {
        if (!live || !r.body) return
        setDraft(r.body)
        setSavedDraftId(r.draftId)
        setSavedAt(r.savedAt)
      })
      .catch(() => {})
    return () => { live = false }
  }, [listingId])

  const handleGenerateDraft = () => {
    setError(null)
    setSuccess(false)

    startGenerating(async () => {
      try {
        const result = await generateSellerUpdateDraft({ listingId, agentId })
        setDraft(result.draft)
        setContext(result.context)
        setIsDraft(true)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to generate draft")
      }
    })
  }

  const handleSend = () => {
    if (!draft.trim()) {
      setError("Message body is required")
      return
    }

    setError(null)

    startSending(async () => {
      try {
        await sendSellerUpdate({
          listingId,
          agentId,
          messageBody: draft,
          approvedByAgentId: agentId,
        })
        setSuccess(true)
        setDraft("")
        setIsDraft(false)
        setContext(null)
        // sendSellerUpdate stamps the saved draft `sent` — nothing pending remains for this listing
        setSavedDraftId(null)
        setSavedAt(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to send update")
      }
    })
  }

  // Wave 142 (lane 142H): this used to clear two flags and save nothing ("the draft stays in component
  // state"). It now persists through the drafts survivor (ai_message_drafts) and reports the refusal.
  const handleSaveAsDraft = () => {
    if (!draft.trim()) {
      setError("Nothing to save yet — write or generate the update first")
      return
    }
    setError(null)
    setSuccess(false)
    startSaving(async () => {
      const r = await saveSellerUpdateDraft({ listingId, body: draft, draftId: savedDraftId })
      if (!r.success) {
        setError(r.error ?? "The draft could not be saved")
        return
      }
      setSavedDraftId(r.draftId ?? null)
      setSavedAt(new Date().toISOString())
    })
  }

  const handleDiscard = () => {
    setDraft("")
    setIsDraft(false)
    setContext(null)
    setError(null)
    setSuccess(false)
    setShowPreview(false)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Weekly Update Composer</span>
          {isDraft && (
            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
              <AlertTriangle className="mr-1 h-3 w-3" />
              AI Draft — Review Before Sending
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Generate and send weekly updates to {sellerName} for {listingAddress}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {success && (
          <Alert className="bg-green-50 border-green-200">
            <AlertDescription className="text-green-700">
              Update sent successfully to seller portal.
            </AlertDescription>
          </Alert>
        )}

        {!draft && !isGenerating && (
          <div className="flex flex-col items-center justify-center py-8 border-2 border-dashed rounded-lg">
            <Sparkles className="h-8 w-8 text-muted-foreground mb-3" />
            <p className="text-muted-foreground mb-4">
              Generate an AI-powered weekly update based on recent activity
            </p>
            <Button onClick={handleGenerateDraft} disabled={isGenerating}>
              {isGenerating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 h-4 w-4" />
                  Generate AI Draft
                </>
              )}
            </Button>
          </div>
        )}

        {isGenerating && (
          <div className="flex flex-col items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-3" />
            <p className="text-muted-foreground">
              Analyzing activity and generating update...
            </p>
          </div>
        )}

        {draft && !isGenerating && (
          <>
            {context && (
              <div className="flex gap-4 text-sm text-muted-foreground">
                <span>Showings this week: {context.showingCount}</span>
                <span>Days on market: {context.dom}</span>
                {context.avgRating && (
                  <span>Avg feedback: {context.avgRating.toFixed(1)}/5</span>
                )}
              </div>
            )}

            {showPreview ? (
              <div className="rounded-lg border bg-muted/50 p-4">
                <p className="text-sm text-muted-foreground mb-2">
                  Preview (as it will appear in seller portal):
                </p>
                <div className="bg-background rounded p-4 whitespace-pre-wrap">
                  {draft}
                </div>
              </div>
            ) : (
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Write your update message..."
                className="min-h-[200px]"
              />
            )}

            <ContextualAiAssistBar
              agentId={agentId}
              context={{
                type: 'seller_update',
                propertyAddress: listingAddress,
                contactName: sellerName,
                currentContent: draft,
              }}
              onAcceptDraft={(newDraft) => setDraft(newDraft)}
            />

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={handleSend}
                disabled={isSending || !draft.trim()}
                className="bg-green-600 hover:bg-green-700"
              >
                {isSending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="mr-2 h-4 w-4" />
                    Approve & Send
                  </>
                )}
              </Button>

              <Button
                variant="outline"
                onClick={() => setShowPreview(!showPreview)}
              >
                <Eye className="mr-2 h-4 w-4" />
                {showPreview ? "Edit" : "Preview"}
              </Button>

              <Button variant="outline" onClick={handleSaveAsDraft} disabled={isSaving || !draft.trim()}>
                {isSaving ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                {isSaving ? "Saving…" : savedDraftId ? "Update Draft" : "Save as Draft"}
              </Button>
              {savedAt && !isSaving && (
                <span className="self-center text-xs text-muted-foreground">
                  Draft saved {new Date(savedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                </span>
              )}

              <Button
                variant="ghost"
                onClick={handleDiscard}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Discard
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
