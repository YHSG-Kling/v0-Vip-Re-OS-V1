"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Mic, Loader2, FileText, Home, ExternalLink, ShieldCheck } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import Link from "next/link"
import { voiceDraftOffer, type VoiceDraftOfferResponse } from "@/app/actions/voice-assistant/draft-offer-from-voice"
import { voiceDraftListing, type VoiceDraftListingResponse } from "@/app/actions/voice-assistant/draft-listing-from-voice"

interface VoiceSessionButtonProps {
  agentId: string
  hasActiveSession: boolean
  isConfigured: boolean
}

type DraftMode = "offer" | "listing" | null
type DraftResponse = VoiceDraftOfferResponse | VoiceDraftListingResponse

export function VoiceSessionButton({
  agentId,
  hasActiveSession,
  isConfigured,
}: VoiceSessionButtonProps) {
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [result, setResult] = useState("")
  const [error, setError] = useState("")

  // Draft modes — when set, the recognized transcript is sent to the
  // matching server action instead of just being displayed.
  const [draftMode, setDraftMode] = useState<DraftMode>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [draftResponse, setDraftResponse] = useState<DraftResponse | null>(null)
  const [processingDraft, setProcessingDraft] = useState(false)

  const handleStartVoice = async () => {
    if (!isConfigured) {
      setError("Voice assistant is not configured. Please set up in settings.")
      return
    }

    // Check for browser speech recognition support
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition

    if (!SpeechRecognition) {
      setError("Speech recognition is not supported in this browser.")
      return
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = "en-US"

    recognition.onstart = () => {
      setIsListening(true)
      setTranscript("")
      setResult("")
      setError("")
    }

    recognition.onresult = (event: any) => {
      const current = event.resultIndex
      const transcriptResult = event.results[current][0].transcript
      setTranscript(transcriptResult)

      if (event.results[current].isFinal) {
        // If a draft mode is active, route the transcript to the matching
        // server action. Otherwise just display it (legacy behavior).
        if (draftMode === "offer" || draftMode === "listing") {
          void handleDraftSubmit(transcriptResult, false)
        } else {
          setResult(`Recognized: "${transcriptResult}"`)
        }
      }
    }

    recognition.onerror = (event: any) => {
      setError(`Error: ${event.error}`)
      setIsListening(false)
    }

    recognition.onend = () => {
      setIsListening(false)
    }

    recognition.start()
  }

  const handleStopVoice = () => {
    setIsListening(false)
    // In a real implementation, you would stop the recognition here
  }

  // ── Draft mode handlers ──────────────────────────────────────────────────
  const handleDraftSubmit = async (input: string, force: boolean) => {
    if (!input.trim() && !force) return
    setProcessingDraft(true)
    setError("")
    try {
      const result = draftMode === "listing"
        ? await voiceDraftListing({ voiceInput: input, sessionId: sessionId ?? undefined, forceFinalize: force })
        : await voiceDraftOffer  ({ voiceInput: input, sessionId: sessionId ?? undefined, forceFinalize: force })

      setDraftResponse(result)
      if (result.kind !== "error" && "sessionId" in result) {
        setSessionId(result.sessionId)
      }
    } catch (err) {
      setError(`Draft failed: ${(err as Error).message}`)
    } finally {
      setProcessingDraft(false)
    }
  }

  const enterDraftMode = (mode: "offer" | "listing") => {
    setDraftMode(mode)
    setSessionId(null)
    setDraftResponse(null)
    setResult("")
    setError("")
    setTranscript("")
  }

  const exitDraftMode = () => {
    setDraftMode(null)
    setSessionId(null)
    setDraftResponse(null)
  }

  return (
    <div className="space-y-3">
      {/* Draft mode toggle row — mobile-friendly large tap targets */}
      <div className="grid grid-cols-2 gap-2">
        <Button
          variant={draftMode === "offer" ? "default" : "outline"}
          onClick={() => draftMode === "offer" ? exitDraftMode() : enterDraftMode("offer")}
          className="min-h-[48px] gap-1.5"
          disabled={!isConfigured}
        >
          <FileText className="h-4 w-4" />
          {draftMode === "offer" ? "Exit Offer Mode" : "Draft Offer"}
        </Button>
        <Button
          variant={draftMode === "listing" ? "default" : "outline"}
          onClick={() => draftMode === "listing" ? exitDraftMode() : enterDraftMode("listing")}
          className="min-h-[48px] gap-1.5"
          disabled={!isConfigured}
        >
          <Home className="h-4 w-4" />
          {draftMode === "listing" ? "Exit Listing Mode" : "Draft Listing"}
        </Button>
      </div>

      {draftMode && (
        <p className="text-xs text-center text-muted-foreground">
          Tap the mic, then speak the {draftMode} details. The assistant will ask for anything missing.
        </p>
      )}

      <Button
        onClick={isListening ? handleStopVoice : handleStartVoice}
        disabled={!isConfigured || processingDraft}
        className={`w-full min-h-[64px] text-lg font-medium ${
          isListening
            ? "bg-red-500 hover:bg-red-600"
            : "bg-primary hover:bg-primary/90"
        }`}
      >
        {isListening ? (
          <>
            <Loader2 className="h-6 w-6 mr-2 animate-spin" />
            Listening...
          </>
        ) : processingDraft ? (
          <>
            <Loader2 className="h-6 w-6 mr-2 animate-spin" />
            Processing...
          </>
        ) : (
          <>
            <Mic className="h-6 w-6 mr-2" />
            {draftMode ? `Speak ${draftMode === "offer" ? "Offer" : "Listing"} Details` : "Start Voice Assistant"}
          </>
        )}
      </Button>

      {/* Transcript display */}
      {(transcript || result || error) && (
        <Card>
          <CardContent className="pt-4">
            {transcript && !result && (
              <div className="text-center">
                <p className="text-sm text-muted-foreground mb-1">Hearing:</p>
                <p className="text-lg font-medium">&quot;{transcript}&quot;</p>
              </div>
            )}
            {result && (
              <div className="text-center">
                <p className="text-sm text-emerald-600 font-medium">{result}</p>
              </div>
            )}
            {error && (
              <div className="text-center">
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Draft-mode response panel ─────────────────────────────────────── */}
      {draftMode && draftResponse && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            {draftResponse.kind === "needs_more_info" && (
              <>
                <p className="text-sm text-blue-700 dark:text-blue-400">
                  {draftResponse.spokenResponse}
                </p>
                {draftResponse.questions.length > 0 && (
                  <ul className="text-xs space-y-1 text-muted-foreground">
                    {draftResponse.questions.slice(0, 4).map((q, i) => (
                      <li key={i}>· {q.question}</li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-center text-muted-foreground italic">
                  Tap the mic again to answer.
                </p>
              </>
            )}

            {draftResponse.kind === "ready_to_finalize" && (
              <>
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-emerald-600 shrink-0" />
                  <p className="text-sm text-emerald-700">{draftResponse.spokenResponse}</p>
                </div>
                <Button
                  onClick={() => handleDraftSubmit("", true)}
                  disabled={processingDraft}
                  className="w-full min-h-[48px] bg-emerald-600 hover:bg-emerald-700"
                >
                  Finalize & Stage Packet
                </Button>
              </>
            )}

            {draftResponse.kind === "finalized" && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-emerald-600 shrink-0" />
                  <p className="text-sm text-emerald-700">{draftResponse.spokenResponse}</p>
                </div>
                <Button asChild className="w-full min-h-[48px] gap-1">
                  <Link href={draftResponse.formwizardUrl}>
                    Open in FormWizard <ExternalLink className="h-4 w-4" />
                  </Link>
                </Button>
                <Button variant="outline" onClick={exitDraftMode} className="w-full min-h-[44px]">
                  Start a New Draft
                </Button>
              </div>
            )}

            {draftResponse.kind === "error" && (
              <p className="text-sm text-destructive">{draftResponse.error}</p>
            )}
          </CardContent>
        </Card>
      )}

      {!isConfigured && (
        <p className="text-xs text-center text-muted-foreground">
          Configure your voice assistant in settings to use this feature.
        </p>
      )}
    </div>
  )
}
