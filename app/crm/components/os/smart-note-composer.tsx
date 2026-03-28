"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { FileText, Sparkles, Loader2, Save, MessageSquare, Wand2 } from "lucide-react"
import { generateSmartResponse, generateCommunicationSummary } from "@/app/actions/ai-communication-hub"
import { getBrandVoiceProfile } from "@/app/actions/ai-content-generation"

interface SmartNoteComposerProps {
  contactId: string
  agentId: string
  contactName: string
  onSaveNote: (note: string) => Promise<void>
  saving: boolean
}

export function SmartNoteComposer({
  contactId,
  agentId,
  contactName,
  onSaveNote,
  saving,
}: SmartNoteComposerProps) {
  const [note, setNote] = useState("")
  const [loading, setLoading] = useState(false)
  const [action, setAction] = useState<"draft" | "summarize" | "improve" | null>(null)
  const [brandVoice, setBrandVoice] = useState<any>(null)

  useEffect(() => {
    const loadBrandVoice = async () => {
      try {
        const result = await getBrandVoiceProfile(agentId)
        if (result.success) setBrandVoice(result.profile)
      } catch (err) {
        console.error("Failed to load brand voice:", err)
      }
    }
    loadBrandVoice()
  }, [agentId])

  const handleDraftFromContext = async () => {
    setLoading(true)
    setAction("draft")
    try {
      const result = await generateSmartResponse({
        contactId,
        agentId,
        messageType: "activity_note",
        context: `Draft an activity note for contact ${contactName}. Include relevant context about recent interactions.`,
        brandVoice: brandVoice?.tone || "professional",
      })
      if (result.success && result.message) {
        setNote(result.message)
      }
    } catch (err) {
      console.error("Draft generation failed:", err)
    } finally {
      setLoading(false)
      setAction(null)
    }
  }

  const handleSummarize = async () => {
    setLoading(true)
    setAction("summarize")
    try {
      const result = await generateCommunicationSummary(contactId, agentId)
      if (result.success && result.summary) {
        setNote(result.summary)
      }
    } catch (err) {
      console.error("Summarization failed:", err)
    } finally {
      setLoading(false)
      setAction(null)
    }
  }

  const handleImprove = async () => {
    if (!note.trim()) return
    setLoading(true)
    setAction("improve")
    try {
      const result = await generateSmartResponse({
        contactId,
        agentId,
        messageType: "activity_note",
        context: `Improve and polish this note while keeping the same meaning: "${note}"`,
        brandVoice: brandVoice?.tone || "professional",
      })
      if (result.success && result.message) {
        setNote(result.message)
      }
    } catch (err) {
      console.error("Note improvement failed:", err)
    } finally {
      setLoading(false)
      setAction(null)
    }
  }

  const handleSave = async () => {
    if (!note.trim()) return
    await onSaveNote(note)
    setNote("")
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4 text-gray-600" />
          Smart Note
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Textarea
          placeholder="Type a note or use 'Draft from Context' to let AI fill it in..."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          className="mb-3"
        />

        {/* AI action bar */}
        <div className="flex flex-wrap gap-2 mb-3">
          <Button
            variant="outline"
            size="sm"
            onClick={handleDraftFromContext}
            disabled={loading}
          >
            {loading && action === "draft" ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4 mr-1" />
            )}
            Draft from Context
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSummarize}
            disabled={loading}
          >
            {loading && action === "summarize" ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <MessageSquare className="h-4 w-4 mr-1" />
            )}
            Summarize Conversation
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleImprove}
            disabled={loading || !note.trim()}
          >
            {loading && action === "improve" ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Wand2 className="h-4 w-4 mr-1" />
            )}
            Improve
          </Button>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{note.length} characters</span>
          <Button onClick={handleSave} disabled={saving || !note.trim()}>
            {saving ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-1" />
            )}
            Save Note
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
