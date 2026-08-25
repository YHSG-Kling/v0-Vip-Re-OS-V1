"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { 
  Sparkles, 
  Check, 
  Copy, 
  Edit2, 
  RefreshCw,
  ThumbsUp,
  Thermometer,
  AlertTriangle,
  Zap,
  Send
} from "lucide-react"
import {
  getAiSuggestions,
  acceptAiSuggestion,
  getChatTemplates,
  applyChatTemplate,
  searchConversationHistory,
} from "@/app/actions/ai-chat"
import { generateSmartResponse } from "@/app/actions/ai-communication-hub"
import { Input } from "@/components/ui/input"

interface AiSuggestion {
  id: string
  suggestion_type: string
  suggestion_content: {
    template?: string
    content?: string
  }
  confidence_score: number
  was_accepted: boolean
}

interface ChatTemplateRow {
  id: string
  template_name: string
  template_category: string | null
  compliance_approved: boolean
  is_active: boolean
}

interface HistoryRow {
  id: string
  body: string | null
  direction: string | null
  type: string | null
  created_at: string
}

interface AiReplyCoachPanelProps {
  sessionId: string
  contactId: string
  agentId: string
  brokerageId: string
  incomingMessage: string
  channel: "email" | "sms" | "chat"
  contactName: string
  leadTemperature?: "hot" | "warm" | "cold"
  onApplyResponse: (response: string) => void
  onSendResponse?: (response: string) => Promise<void>
}

export function AiReplyCoachPanel({
  sessionId,
  contactId,
  agentId,
  brokerageId,
  incomingMessage,
  channel,
  contactName,
  leadTemperature,
  onApplyResponse,
  onSendResponse,
}: AiReplyCoachPanelProps) {
  const [suggestions, setSuggestions] = useState<AiSuggestion[]>([])
  const [generatedDraft, setGeneratedDraft] = useState<string>("")
  const [editedDraft, setEditedDraft] = useState<string>("")
  const [isEditing, setIsEditing] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [isGenerating, setIsGenerating] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draftSentiment, setDraftSentiment] = useState<any>(null)
  const [templates, setTemplates] = useState<ChatTemplateRow[]>([])
  const [applyingTemplateId, setApplyingTemplateId] = useState<string | null>(null)
  const [historyQuery, setHistoryQuery] = useState("")
  const [history, setHistory] = useState<HistoryRow[] | null>(null)
  const [isSearchingHistory, setIsSearchingHistory] = useState(false)

  // Load existing suggestions from the session
  const loadSuggestions = async () => {
    try {
      const data = await getAiSuggestions(sessionId)
      setSuggestions(data || [])
    } catch (err) {
      console.error("Failed to load suggestions:", err)
    }
  }

  /**
   * COMPLIANCE-APPROVED CHAT TEMPLATES — a table with a usage counter that
   * nothing had ever incremented, because nothing applied a template. The
   * picker below is the first caller: applyChatTemplate personalises the body
   * against THIS conversation's contact ({first_name}/{last_name}/{city}) and
   * bumps chat_templates.usage_count, which is what the "most used first"
   * ordering has always sorted on.
   */
  useEffect(() => {
    let cancelled = false
    const loadTemplates = async () => {
      try {
        const rows = await getChatTemplates({ complianceApproved: true })
        if (!cancelled && Array.isArray(rows)) {
          setTemplates((rows as ChatTemplateRow[]).filter((t) => t.is_active !== false))
        }
      } catch (err) {
        console.error("Failed to load chat templates:", err)
      }
    }
    loadTemplates()
    return () => {
      cancelled = true
    }
  }, [])

  const handleApplyTemplate = async (templateId: string) => {
    setApplyingTemplateId(templateId)
    setError(null)
    try {
      const { personalizedContent: templateBody } = await applyChatTemplate(templateId, sessionId)
      if (!templateBody) {
        setError("That template has no body saved.")
        return
      }
      setGeneratedDraft(templateBody)
      setEditedDraft(templateBody)
      setIsEditing(false)
    } catch (err) {
      setError("Failed to apply template")
    } finally {
      setApplyingTemplateId(null)
    }
  }

  /**
   * "What did we already say about this?" — searchConversationHistory reads the
   * contact's own message history (messages, newest first, optional ILIKE on the
   * body). Drafting a reply without it is how agents repeat a promise they
   * already made.
   */
  const handleSearchHistory = async () => {
    setIsSearchingHistory(true)
    try {
      const rows = await searchConversationHistory(contactId, historyQuery.trim() || undefined)
      setHistory((rows ?? []) as HistoryRow[])
    } catch (err) {
      console.error("History search failed:", err)
      setError("Could not search this contact's history")
    } finally {
      setIsSearchingHistory(false)
    }
  }

  // Generate a new smart response
  const handleGenerateResponse = async () => {
    setIsGenerating(true)
    setError(null)
    
    try {
      const result = await generateSmartResponse({
        incomingMessage,
        contactId,
        agentId,
        brokerageId,
        channel,
        tone: "professional",
        includeNextSteps: true,
      })

      if (result.success && result.draft) {
        setGeneratedDraft(result.draft)
        setEditedDraft(result.draft)
        setDraftSentiment(result.sentiment)
        setIsEditing(false)
      } else {
        setError(result.error || "Failed to generate response")
      }
    } catch (err) {
      setError("Failed to generate response")
    } finally {
      setIsGenerating(false)
    }
  }

  // Accept a suggestion
  const handleAcceptSuggestion = async (suggestion: AiSuggestion) => {
    startTransition(async () => {
      try {
        await acceptAiSuggestion(suggestion.id)
        const content = suggestion.suggestion_content.template || suggestion.suggestion_content.content || ""
        setGeneratedDraft(content)
        setEditedDraft(content)
        onApplyResponse(content)
        // Refresh suggestions
        loadSuggestions()
      } catch (err) {
        console.error("Failed to accept suggestion:", err)
      }
    })
  }

  // Apply the current draft
  const handleApplyDraft = () => {
    const finalText = isEditing ? editedDraft : generatedDraft
    onApplyResponse(finalText)
  }

  // Send the response directly
  const handleSendDraft = async () => {
    if (!onSendResponse) return
    const finalText = isEditing ? editedDraft : generatedDraft
    if (!finalText.trim()) return

    setIsSending(true)
    try {
      await onSendResponse(finalText)
      setGeneratedDraft("")
      setEditedDraft("")
      setIsEditing(false)
    } catch (err) {
      setError("Failed to send message")
    } finally {
      setIsSending(false)
    }
  }

  // Copy to clipboard
  const handleCopy = () => {
    const text = isEditing ? editedDraft : generatedDraft
    navigator.clipboard.writeText(text)
  }

  const getTemperatureColor = (temp?: string) => {
    switch (temp) {
      case "hot": return "text-green-600 bg-green-100"
      case "warm": return "text-amber-600 bg-amber-100"
      case "cold": return "text-blue-600 bg-blue-100"
      default: return "text-muted-foreground bg-muted"
    }
  }

  const getConfidenceLabel = (score: number) => {
    if (score >= 0.8) return "High confidence"
    if (score >= 0.6) return "Medium confidence"
    return "Low confidence"
  }

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              AI Reply Coach
            </CardTitle>
            <CardDescription>
              Smart suggestions for {contactName}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {leadTemperature && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger>
                    <Badge variant="outline" className={`gap-1 ${getTemperatureColor(leadTemperature)}`}>
                      <Thermometer className="h-3 w-3" />
                      {leadTemperature}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Lead temperature: {leadTemperature}</p>
                    {leadTemperature === "cold" && (
                      <p className="text-xs text-muted-foreground">
                        Use email/print only per compliance
                      </p>
                    )}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Incoming Message Context */}
        <div className="p-3 bg-muted/30 rounded-lg">
          <div className="text-xs text-muted-foreground mb-1">Replying to:</div>
          <p className="text-sm">{incomingMessage.slice(0, 200)}{incomingMessage.length > 200 ? "..." : ""}</p>
        </div>

        {/* Cold Lead Warning */}
        {leadTemperature === "cold" && channel !== "email" && (
          <div className="flex items-center gap-2 p-3 bg-amber-500/10 text-amber-700 rounded-lg">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-sm">Cold leads can only be contacted via email or print mail.</span>
          </div>
        )}

        {/* Generate Button */}
        <Button 
          onClick={handleGenerateResponse} 
          disabled={isGenerating}
          className="w-full gap-2"
        >
          {isGenerating ? (
            <>
              <RefreshCw className="h-4 w-4 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Zap className="h-4 w-4" />
              Generate Smart Response
            </>
          )}
        </Button>

        {/* Compliance-approved templates */}
        {templates.length > 0 && (
          <div className="space-y-2">
            <span className="text-sm font-medium">Approved Templates</span>
            <div className="flex flex-wrap gap-1">
              {templates.slice(0, 8).map((t) => (
                <Button
                  key={t.id}
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={applyingTemplateId === t.id}
                  onClick={() => handleApplyTemplate(t.id)}
                >
                  {applyingTemplateId === t.id && (
                    <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                  )}
                  {t.template_name}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
            {error}
          </div>
        )}

        {/* Generated Draft */}
        {generatedDraft && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Generated Response</span>
              <div className="flex items-center gap-1">
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={handleCopy}
                  className="h-7 px-2"
                >
                  <Copy className="h-3 w-3" />
                </Button>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={() => setIsEditing(!isEditing)}
                  className="h-7 px-2"
                >
                  <Edit2 className="h-3 w-3" />
                </Button>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={handleGenerateResponse}
                  className="h-7 px-2"
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
              </div>
            </div>

            {isEditing ? (
              <Textarea
                value={editedDraft}
                onChange={(e) => setEditedDraft(e.target.value)}
                rows={6}
                className="resize-none"
              />
            ) : (
              <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg">
                <p className="text-sm whitespace-pre-wrap">{generatedDraft}</p>
              </div>
            )}

            {/* Sentiment Analysis */}
            {draftSentiment && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Sentiment:</span>
                <Badge variant="outline" className="text-xs">
                  {draftSentiment.sentiment || "neutral"}
                </Badge>
                {draftSentiment.urgency && (
                  <>
                    <span>|</span>
                    <span>Urgency: {draftSentiment.urgency}</span>
                  </>
                )}
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-2">
              <Button 
                variant="outline" 
                onClick={handleApplyDraft}
                className="flex-1"
              >
                <Check className="h-4 w-4 mr-1" />
                Use in Composer
              </Button>
              {onSendResponse && (
                <Button 
                  onClick={handleSendDraft}
                  disabled={isSending}
                  className="flex-1"
                >
                  {isSending ? (
                    <RefreshCw className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4 mr-1" />
                  )}
                  Send Now
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Existing Suggestions */}
        {suggestions.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Previous Suggestions</span>
              <Button 
                variant="ghost" 
                size="sm" 
                onClick={loadSuggestions}
                className="h-7"
              >
                <RefreshCw className="h-3 w-3" />
              </Button>
            </div>
            <ScrollArea className="h-[150px]">
              <div className="space-y-2">
                {suggestions.map((suggestion) => (
                  <div 
                    key={suggestion.id}
                    className={`p-3 rounded-lg border ${
                      suggestion.was_accepted ? "bg-green-50/50 border-green-200" : "bg-muted/30"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <Badge variant="outline" className="text-xs">
                        {suggestion.suggestion_type}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {getConfidenceLabel(suggestion.confidence_score)}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground truncate">
                      {suggestion.suggestion_content.template || suggestion.suggestion_content.content || "No content"}
                    </p>
                    {!suggestion.was_accepted && (
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        onClick={() => handleAcceptSuggestion(suggestion)}
                        disabled={isPending}
                        className="mt-2 h-7"
                      >
                        <ThumbsUp className="h-3 w-3 mr-1" />
                        Use This
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}

        {/* Load Suggestions Button */}
        {suggestions.length === 0 && !generatedDraft && (
          <Button
            variant="outline"
            size="sm"
            onClick={loadSuggestions}
            className="w-full"
          >
            Load Previous Suggestions
          </Button>
        )}

        {/* Conversation history — what has already been said to this contact */}
        <div className="space-y-2 border-t pt-3">
          <span className="text-sm font-medium">Search this contact&apos;s history</span>
          <div className="flex gap-2">
            <Input
              placeholder="e.g. inspection, closing date…"
              value={historyQuery}
              onChange={(e) => setHistoryQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  handleSearchHistory()
                }
              }}
              className="h-8 text-sm"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleSearchHistory}
              disabled={isSearchingHistory}
              className="h-8"
            >
              {isSearchingHistory ? (
                <RefreshCw className="h-3 w-3 animate-spin" />
              ) : (
                "Search"
              )}
            </Button>
          </div>
          {history !== null && (
            history.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No earlier messages match that.
              </p>
            ) : (
              <ScrollArea className="h-[140px]">
                <div className="space-y-2 pr-2">
                  {history.slice(0, 20).map((m) => (
                    <div key={m.id} className="rounded-lg border bg-muted/20 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <Badge variant="outline" className="text-[10px]">
                          {m.direction === "inbound" ? "From client" : "From us"}
                          {m.type ? ` · ${m.type}` : ""}
                        </Badge>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(m.created_at).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-3">
                        {m.body || "(no body)"}
                      </p>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )
          )}
        </div>
      </CardContent>
    </Card>
  )
}
