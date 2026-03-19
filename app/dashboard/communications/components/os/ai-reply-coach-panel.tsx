"use client"

import { useState, useTransition } from "react"
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
  ThumbsDown,
  Thermometer,
  AlertTriangle,
  Zap,
  Send
} from "lucide-react"
import { getAiSuggestions, acceptAiSuggestion } from "@/app/actions/ai-chat"
import { generateSmartResponse } from "@/app/actions/ai-communication-hub"

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

interface AiReplyCoachPanelProps {
  sessionId: string
  contactId: string
  agentId: string
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

  // Load existing suggestions from the session
  const loadSuggestions = async () => {
    try {
      const data = await getAiSuggestions(sessionId)
      setSuggestions(data || [])
    } catch (err) {
      console.error("Failed to load suggestions:", err)
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
      </CardContent>
    </Card>
  )
}
