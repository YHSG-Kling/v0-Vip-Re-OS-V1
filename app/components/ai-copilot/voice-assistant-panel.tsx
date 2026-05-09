"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Mic, Loader2, Volume2, Copy, FileText, ExternalLink, ShieldCheck } from "lucide-react"
import { handleVoiceCommand } from "@/app/actions/voice-assistant/handle-voice-command"
import { voiceDraftOffer, type VoiceDraftOfferResponse } from "@/app/actions/voice-assistant/draft-offer-from-voice"
import { searchPropertiesWithNaturalLanguage, previewSearchIntent } from "@/app/actions/buyer-property-search"
import { toast } from "sonner"

interface VoiceAssistantPanelProps {
  userId: string
  userRole: 'agent' | 'team_lead' | 'admin' | 'broker' | 'tc' | 'compliance_officer' | 'vendor'
  brokerageId: string
  currentListingId?: string
  currentBuyerId?: string
}

interface CommandHistory {
  transcript: string
  actionTaken?: string
  timestamp: Date
}

export function VoiceAssistantPanel({
  userId,
  userRole,
  brokerageId,
  currentListingId,
  currentBuyerId,
}: VoiceAssistantPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [response, setResponse] = useState<{
    spoken_response: string
    text_response: string
    action_taken?: string
    requires_clarification?: boolean
    clarification_options?: string[]
  } | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [commandHistory, setCommandHistory] = useState<CommandHistory[]>([])
  const [clarificationOptions, setClarificationOptions] = useState<string[]>([])

  // ── Draft-offer mode (additive — parallel flow to handleVoiceCommand) ──
  // When draftOfferMode is true, transcripts are routed to voiceDraftOffer
  // instead of handleVoiceCommand. Allows multi-turn conversational packet
  // staging without changing the existing voice command flow.
  const [draftOfferMode, setDraftOfferMode] = useState(false)
  const [intakeSessionId, setIntakeSessionId] = useState<string | null>(null)
  const [draftResponse, setDraftResponse] = useState<VoiceDraftOfferResponse | null>(null)

  const VOICE_SHORTCUTS = [
    "Get Today's Briefing",
    currentBuyerId ? `Find Homes for Buyer` : "Find Homes",
    "Schedule Showing",
    "Log Activity",
    "Draft Message",
  ]

  const handleVoiceSubmit = async () => {
    if (!transcript.trim()) return

    setIsProcessing(true)
    try {
      const result = await handleVoiceCommand({
        voice_input: transcript,
        user_id: userId,
        user_role: userRole,
        brokerage_id: brokerageId,
        context: {
          current_listing_id: currentListingId,
          current_buyer_id: currentBuyerId,
        },
      })

      setResponse(result)
      setCommandHistory((prev) => [
        { transcript, actionTaken: result.action_taken, timestamp: new Date() },
        ...prev.slice(0, 2),
      ])

      if (result.requires_clarification && result.clarification_options) {
        setClarificationOptions(result.clarification_options)
      }

      if (result.action_taken?.includes("schedule_showing")) {
        toast.success("Showing scheduled")
      }
    } catch (error) {
      console.error("Voice command error:", error)
      toast.error("Failed to process voice command")
    } finally {
      setIsProcessing(false)
    }
  }

  // ── Draft-offer mode handler ──────────────────────────────────────────
  const handleDraftOfferSubmit = async (force = false) => {
    if (!transcript.trim() && !force) return
    setIsProcessing(true)
    try {
      const result = await voiceDraftOffer({
        voiceInput:    transcript,
        sessionId:     intakeSessionId ?? undefined,
        contactId:     currentBuyerId,
        forceFinalize: force,
      })
      setDraftResponse(result)
      if (result.kind !== "error" && "sessionId" in result) {
        setIntakeSessionId(result.sessionId)
      }
      if (result.kind === "finalized") {
        toast.success("Offer packet staged — opening FormWizard")
      }
      // Clear transcript box for the next utterance, keep the response visible
      setTranscript("")
    } catch (err) {
      console.error("Draft offer error:", err)
      toast.error("Could not process voice draft")
    } finally {
      setIsProcessing(false)
    }
  }

  const exitDraftOfferMode = () => {
    setDraftOfferMode(false)
    setIntakeSessionId(null)
    setDraftResponse(null)
    setTranscript("")
  }

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="fixed bottom-6 right-6 rounded-full bg-blue-500 text-white p-4 shadow-lg hover:bg-blue-600 transition-colors"
      >
        <Mic className={`h-6 w-6 ${isListening ? "animate-pulse" : ""}`} />
      </button>
    )
  }

  return (
    <Card className="fixed bottom-6 right-6 w-96 shadow-xl">
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base flex items-center gap-2">
          <Mic className="h-4 w-4" />
          Voice Assistant
        </CardTitle>
        <button
          onClick={() => {
            setExpanded(false)
            setTranscript("")
            setResponse(null)
          }}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ×
        </button>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Transcript Display */}
        <div className="bg-gray-100 rounded p-3 font-mono text-sm min-h-12">
          {isListening ? (
            <span className="text-muted-foreground">Listening...</span>
          ) : (
            transcript || <span className="text-muted-foreground">Say something...</span>
          )}
        </div>

        {/* Mode toggle — Draft Offer vs Standard voice commands */}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={draftOfferMode ? "default" : "outline"}
            onClick={() => draftOfferMode ? exitDraftOfferMode() : setDraftOfferMode(true)}
            className="gap-1.5"
          >
            <FileText className="h-3.5 w-3.5" />
            {draftOfferMode ? "Exit Draft Offer" : "Draft Offer"}
          </Button>
          {draftOfferMode && intakeSessionId && (
            <Badge variant="outline" className="text-[10px]">Session active</Badge>
          )}
        </div>

        {/* Voice Shortcuts — hide while in Draft Offer mode */}
        {!draftOfferMode && (
          <div className="flex flex-wrap gap-2">
            {VOICE_SHORTCUTS.map((shortcut) => (
              <button
                key={shortcut}
                onClick={() => setTranscript(shortcut)}
                className="text-xs px-2 py-1 bg-accent rounded hover:bg-accent/80 transition-colors"
              >
                {shortcut}
              </button>
            ))}
          </div>
        )}

        {/* Submit Button — routes to draft-offer flow when in that mode */}
        <Button
          onClick={() => draftOfferMode ? handleDraftOfferSubmit(false) : handleVoiceSubmit()}
          disabled={isProcessing || !transcript.trim()}
          className="w-full"
        >
          {isProcessing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Processing
            </>
          ) : draftOfferMode ? (
            "Send to Drafter"
          ) : (
            "Submit"
          )}
        </Button>

        {/* Draft-offer response panel ──────────────────────────────── */}
        {draftOfferMode && draftResponse && (
          <div className="space-y-3 border-t pt-4">
            {draftResponse.kind === "needs_more_info" && (
              <>
                <div className="flex items-start gap-2">
                  <Volume2 className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
                  <p className="text-sm text-blue-700">{draftResponse.spokenResponse}</p>
                </div>
                {draftResponse.questions.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-muted-foreground">Still need:</p>
                    <ul className="text-xs space-y-0.5 text-muted-foreground">
                      {draftResponse.questions.slice(0, 5).map((q, i) => (
                        <li key={i}>· {q.question}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}

            {draftResponse.kind === "ready_to_finalize" && (
              <>
                <div className="flex items-start gap-2">
                  <ShieldCheck className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                  <p className="text-sm text-emerald-700">{draftResponse.spokenResponse}</p>
                </div>
                <Button
                  onClick={() => handleDraftOfferSubmit(true)}
                  disabled={isProcessing}
                  className="w-full bg-emerald-600 hover:bg-emerald-700"
                >
                  Finalize & Stage Packet
                </Button>
              </>
            )}

            {draftResponse.kind === "finalized" && (
              <div className="space-y-2">
                <div className="flex items-start gap-2">
                  <ShieldCheck className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
                  <p className="text-sm text-emerald-700">{draftResponse.spokenResponse}</p>
                </div>
                <Button asChild className="w-full gap-1">
                  <a href={draftResponse.formwizardUrl}>
                    Open Packet in FormWizard <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </Button>
                <Button variant="outline" size="sm" onClick={exitDraftOfferMode} className="w-full">
                  Start a New Draft
                </Button>
              </div>
            )}

            {draftResponse.kind === "error" && (
              <p className="text-sm text-destructive">{draftResponse.error}</p>
            )}
          </div>
        )}

        {/* Response Display — hidden in draft-offer mode (its own panel above) */}
        {response && !draftOfferMode && (
          <div className="space-y-3 border-t pt-4">
            <div>
              <p className="text-sm font-semibold text-blue-600">
                <Volume2 className="h-4 w-4 inline mr-1" />
                {response.spoken_response}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {response.text_response}
              </p>
            </div>

            {response.action_taken && (
              <Badge className="bg-green-100 text-green-800">
                {response.action_taken}
              </Badge>
            )}

            {response.requires_clarification && clarificationOptions.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold">Did you mean?</p>
                {clarificationOptions.map((option) => (
                  <Button
                    key={option}
                    variant="outline"
                    size="sm"
                    className="w-full text-xs"
                    onClick={() => setTranscript(option)}
                  >
                    {option}
                  </Button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Command History */}
        {commandHistory.length > 0 && (
          <div className="text-xs space-y-2 border-t pt-2">
            <p className="font-semibold">Recent</p>
            {commandHistory.map((cmd, i) => (
              <div key={i} className="flex justify-between items-start">
                <span className="truncate">{cmd.transcript.substring(0, 30)}</span>
                {cmd.actionTaken && (
                  <Badge variant="secondary" className="text-xs">
                    {cmd.actionTaken}
                  </Badge>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
