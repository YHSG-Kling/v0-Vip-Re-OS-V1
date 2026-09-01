"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Mic, Loader2, FileText, Home, ExternalLink, ShieldCheck } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import Link from "next/link"
import { voiceDraftOffer, type VoiceDraftOfferResponse } from "@/app/actions/voice-assistant/draft-offer-from-voice"
import { voiceDraftListing, type VoiceDraftListingResponse } from "@/app/actions/voice-assistant/draft-listing-from-voice"
// Lane E2 2026-08-28: startVoiceSession/endVoiceSession WIRED. The page above
// this button reads voice_assistant_sessions to say "Active session", but
// nothing ever WROTE a session row — the banner could never be true. A
// session now opens when the mic starts and closes when recognition ends.
// Lane G5 2026-08-28: processVoiceCommand WIRED. This button transcribed the
// agent's speech and, outside draft mode, printed it back as
// `Recognized: "…"` — the hands-free CRM assistant's SHELL was live (mic,
// session ledger, and a "Recent Commands" list on the page above that reads
// voice_commands) while its BRAIN had no caller anywhere in the tree, so a
// spoken command reached no decision and the recents list could only ever show
// rows written by the desktop always-on assistant's route.
// NOT the same brain as /api/internal/voice-command (the always-on assistant's
// briefing/management intents) and not the same as
// app/actions/voice-assistant/handle-voice-command.ts (the governed dashboard
// command layer with authority + readiness validation). This one is the
// contact-centric field lane — look up a contact, add a note, request a
// document, assign a vendor, log an upgrade — and it speaks a LEDGER RECEIPT
// back for every write.
import { startVoiceSession, endVoiceSession, processVoiceCommand } from "@/app/actions/voice-assistant"

interface VoiceSessionButtonProps {
  agentId: string
  hasActiveSession: boolean
  isConfigured: boolean
  /** A resumable workflow_intake_sessions id — OWNERSHIP ALREADY RE-VERIFIED
   *  server-side by the page (agent_user_id = session user) before it reaches
   *  this prop. Seeds the draft session so the next utterance continues the
   *  prior conversation instead of starting over. */
  resumeSessionId?: string | null
  resumeMode?: "offer" | "listing" | null
}

type DraftMode = "offer" | "listing" | null
type DraftResponse = VoiceDraftOfferResponse | VoiceDraftListingResponse

export function VoiceSessionButton({
  agentId,
  hasActiveSession,
  isConfigured,
  resumeSessionId = null,
  resumeMode = null,
}: VoiceSessionButtonProps) {
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [result, setResult] = useState("")
  const [error, setError] = useState("")

  // Draft modes — when set, the recognized transcript is sent to the
  // matching server action instead of just being displayed. Seeded from the
  // resume deep link when the page verified one.
  const [draftMode, setDraftMode] = useState<DraftMode>(resumeMode ?? null)
  const [sessionId, setSessionId] = useState<string | null>(resumeSessionId ?? null)
  const [draftResponse, setDraftResponse] = useState<DraftResponse | null>(null)
  const [processingDraft, setProcessingDraft] = useState(false)

  const router = useRouter()
  // Refs, not state: both are read inside SpeechRecognition callbacks, where a
  // state value would be the stale one captured at handler-creation time.
  const recognitionRef = useRef<any>(null)
  const assistantSessionRef = useRef<string | null>(null)
  const [processingCommand, setProcessingCommand] = useState(false)

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
        // draft intake. Otherwise it is a CRM command — send it to the
        // assistant brain rather than echoing it back.
        if (draftMode === "offer" || draftMode === "listing") {
          void handleDraftSubmit(transcriptResult, false)
        } else {
          void handleCommandSubmit(transcriptResult)
        }
      }
    }

    recognitionRef.current = recognition
    assistantSessionRef.current = null

    recognition.onerror = (event: any) => {
      setError(`Error: ${event.error}`)
      setIsListening(false)
    }

    recognition.onend = () => {
      setIsListening(false)
      recognitionRef.current = null
      // Close the assistant session ledger row. Best-effort: the recognition
      // itself is already over either way.
      const openSession = assistantSessionRef.current
      if (openSession) {
        assistantSessionRef.current = null
        void endVoiceSession(openSession).catch(() => {})
      }
    }

    recognition.start()

    // Open the session row (best-effort — voice keeps working if the ledger
    // write is refused, and the refusal is logged inside the action).
    try {
      const sess = await startVoiceSession(undefined, { surface: "mobile_voice", draft_mode: draftMode })
      if ((sess as any).success && (sess as any).sessionId) {
        assistantSessionRef.current = (sess as any).sessionId
      }
    } catch {
      /* session ledger only */
    }
  }

  const handleStopVoice = () => {
    // This was a no-op that only flipped the label back to "Start" while the
    // browser kept listening — the mic stayed hot and the session ledger row
    // stayed open until recognition timed out on its own. Stopping the
    // recognition fires onend, which is what closes both.
    try { recognitionRef.current?.stop() } catch { /* already stopped */ }
    setIsListening(false)
  }

  // ── CRM command handler ───────────────────────────────────────────────────
  // The non-draft branch of the mic. processVoiceCommand parses the intent,
  // executes it against this agent's own contacts/schedule/documents (identity
  // is session-derived inside the action, never from this client), writes the
  // voice_commands ledger row the page's "Recent Commands" list reads, and
  // increments this session's command_count via the sessionId below.
  const handleCommandSubmit = async (input: string) => {
    if (!input.trim()) return
    setProcessingCommand(true)
    setError("")
    setResult("")
    try {
      const res = await processVoiceCommand({
        commandText: input,
        sessionId: assistantSessionRef.current ?? undefined,
      })
      const spoken = (res as { response?: string }).response
      if (res.success) {
        setResult(spoken ?? "Done.")
      } else {
        setError(spoken ?? (res as { error?: string }).error ?? "I couldn't complete that.")
      }
      // The page above renders the last five voice_commands rows server-side;
      // this command just added one.
      router.refresh()
    } catch (err) {
      setError(`Command failed: ${(err as Error).message}`)
    } finally {
      setProcessingCommand(false)
    }
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
          {sessionId && sessionId === resumeSessionId
            ? `Resuming your ${draftMode} intake — tap the mic to continue where you left off.`
            : `Tap the mic, then speak the ${draftMode} details. The assistant will ask for anything missing.`}
        </p>
      )}

      <Button
        onClick={isListening ? handleStopVoice : handleStartVoice}
        disabled={!isConfigured || processingDraft || processingCommand}
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
        ) : processingDraft || processingCommand ? (
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

            {/* PRE-FLIGHT BLOCKER. The intake was complete; a proactive check refused
                the draft, so nothing was staged. Rendering it is the point — a kind
                with no branch would show a blank card and read as "nothing happened". */}
            {draftResponse.kind === "blocked" && (
              <div className="space-y-2">
                <p className="text-sm text-amber-800">{draftResponse.spokenResponse}</p>
                <ul className="space-y-1.5">
                  {draftResponse.blockers.map((b, i) => (
                    <li key={`${b.title}-${i}`} className="rounded-md border border-amber-300 bg-amber-50 p-2">
                      <p className="text-sm font-medium text-amber-900">{b.title}</p>
                      <p className="text-xs text-amber-800">{b.recommendation ?? b.detail}</p>
                      {b.action && (
                        <Link href={b.action.href} className="text-xs underline text-amber-900">
                          {b.action.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
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
