"use client"

/**
 * VoicePracticeOverlay — Track C
 *
 * Real-time, voice-only objection practice via ElevenLabs Conversational AI.
 * The agent picks a scenario; we mint a session against the per-scenario
 * prospect agent; agent talks, prospect pushes back, every turn streams into
 * objection_training_turns. On end, the existing endPracticeSession() action
 * runs to score the full transcript and save strengths / improvements.
 *
 * Distinct from the Track B on-the-go assistant — that one has CRM tools and
 * uses the agent's cloned voice. This overlay has NO tools (pure roleplay)
 * and uses a separate prospect voice so the agent can hear them clearly.
 */

import { useEffect, useRef, useState, useCallback } from "react"
import { Conversation } from "@elevenlabs/client"
import type { Status } from "@elevenlabs/client"
import { Mic, MicOff, X, Loader2, AlertCircle, Trophy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { endPracticeSession } from "@/app/actions/objection-training"

interface Props {
  scenarioKey: string
  scenarioLabel: string
  open: boolean
  onClose: () => void
  /** Called when the session ends and scoring is back. */
  onComplete?: (result: {
    sessionId: string
    totalScore: number
    summary: string
    strengths: string[]
    improvements: string[]
  }) => void
}

interface SessionPayload {
  sessionId: string
  signedUrl: string
  openingLine: string
  scenario: { key: string; label: string; persona: string | null; difficulty: string | null }
  softWarning?: string
}

interface TranscriptLine {
  role: "prospect" | "agent"
  text: string
  ts: number
}

type Phase = "idle" | "connecting" | "live" | "scoring" | "scored" | "error"

export function VoicePracticeOverlay({ scenarioKey, scenarioLabel, open, onClose, onComplete }: Props) {
  const conversationRef = useRef<Awaited<ReturnType<typeof Conversation.startSession>> | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const [phase, setPhase] = useState<Phase>("idle")
  const [error, setError] = useState<string | null>(null)
  const [softWarning, setSoftWarning] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const [transcript, setTranscript] = useState<TranscriptLine[]>([])
  const [agentSpeaking, setAgentSpeaking] = useState(false)
  const [scoreResult, setScoreResult] = useState<null | {
    totalScore: number
    summary: string
    strengths: string[]
    improvements: string[]
  }>(null)

  // ── Open lifecycle: mint session + start SDK ───────────────────────────
  useEffect(() => {
    if (!open) {
      conversationRef.current?.endSession().catch(() => {})
      conversationRef.current = null
      sessionIdRef.current = null
      setPhase("idle")
      setTranscript([])
      setError(null)
      setSoftWarning(null)
      setMuted(false)
      setScoreResult(null)
      return
    }

    let cancelled = false
    setPhase("connecting")
    setError(null)
    setTranscript([])
    setScoreResult(null)
    ;(async () => {
      try {
        const res = await fetch("/api/objection-training/voice-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scenarioKey }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          setError(body.error ?? `Couldn't start practice (${res.status})`)
          setPhase("error")
          return
        }
        const session = (await res.json()) as SessionPayload
        if (cancelled) return
        sessionIdRef.current = session.sessionId
        if (session.softWarning) setSoftWarning(session.softWarning)

        // Seed the transcript with the opening prospect line so the agent
        // can read it while the audio loads.
        setTranscript([{ role: "prospect", text: session.openingLine, ts: Date.now() }])

        const conversation = await Conversation.startSession({
          signedUrl: session.signedUrl,
          onConnect: () => { if (!cancelled) setPhase("live") },
          onDisconnect: () => {
            if (cancelled) return
            // Disconnect without an explicit end means the user closed the
            // overlay or the SDK dropped — treat as a soft end.
            setPhase((prev) => (prev === "live" ? "scoring" : prev))
          },
          onError: (msg: string | Error) => {
            if (cancelled) return
            setError(typeof msg === "string" ? msg : msg.message)
            setPhase("error")
          },
          onMessage: ({ message, source }: { message: string; source: "user" | "ai" }) => {
            if (cancelled || !message) return
            const role: "prospect" | "agent" = source === "user" ? "agent" : "prospect"
            setTranscript((prev) => [...prev, { role, text: message, ts: Date.now() }])
            // Persist to the DB; ignore failures (best-effort).
            if (sessionIdRef.current) {
              fetch("/api/objection-training/voice-turn", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionId: sessionIdRef.current, speaker: role, text: message }),
              }).catch(() => {})
            }
          },
          onModeChange: ({ mode }: { mode: "speaking" | "listening" }) => {
            if (!cancelled) setAgentSpeaking(mode === "speaking")
          },
          onStatusChange: ({ status: s }: { status: Status }) => {
            if (cancelled) return
            if (s === "connected") setPhase("live")
          },
        })
        if (cancelled) {
          await conversation.endSession().catch(() => {})
          return
        }
        conversationRef.current = conversation
      } catch (e: any) {
        console.error(e)
        if (!cancelled) {
          setError(e?.message ?? "Microphone permission required")
          setPhase("error")
        }
      }
    })()

    return () => {
      cancelled = true
      conversationRef.current?.endSession().catch(() => {})
      conversationRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scenarioKey])

  // ── Mic mute ────────────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    const conv = conversationRef.current
    if (!conv) return
    const next = !muted
    setMuted(next)
    try { conv.setMicMuted(next) } catch {}
  }, [muted])

  // ── End the practice → run scoring ──────────────────────────────────────
  const endAndScore = useCallback(async () => {
    if (!sessionIdRef.current) {
      onClose()
      return
    }
    // Tear down the SDK first so audio stops while we score.
    await conversationRef.current?.endSession().catch(() => {})
    conversationRef.current = null
    setPhase("scoring")

    const result = await endPracticeSession({ sessionId: sessionIdRef.current })
    if (!result.success) {
      setError(result.error ?? "Scoring failed")
      setPhase("error")
      return
    }
    const scored = {
      totalScore: result.totalScore ?? 0,
      summary: result.summary ?? "",
      strengths: result.strengths ?? [],
      improvements: result.improvements ?? [],
    }
    setScoreResult(scored)
    setPhase("scored")
    onComplete?.({ sessionId: sessionIdRef.current, ...scored })
  }, [onClose, onComplete])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-label={`Live practice — ${scenarioLabel}`}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4"
    >
      <div className="w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-purple-600 text-white">
          <div className="flex items-center gap-2 min-w-0">
            <div className={`h-2 w-2 rounded-full shrink-0 ${
              phase === "live" && agentSpeaking ? "bg-emerald-300 animate-pulse" :
              phase === "live" ? "bg-emerald-400" :
              phase === "connecting" ? "bg-amber-300 animate-pulse" :
              phase === "scoring" ? "bg-amber-300 animate-pulse" :
              "bg-gray-300"
            }`} />
            <p className="text-sm font-medium truncate">{scenarioLabel}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="opacity-80 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        {softWarning && (
          <div className="px-3 py-2 text-xs bg-amber-50 text-amber-900 border-b border-amber-200 flex items-start gap-1.5">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{softWarning}</span>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto bg-gray-50 p-4">
          {phase === "connecting" && (
            <div className="flex items-center justify-center h-32 text-sm text-gray-500">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Connecting prospect…
            </div>
          )}

          {phase === "error" && (
            <div className="flex flex-col items-center justify-center h-40 text-center px-4">
              <AlertCircle className="h-6 w-6 text-red-500 mb-2" />
              <p className="text-sm text-gray-700">{error ?? "Something went wrong."}</p>
            </div>
          )}

          {(phase === "live" || phase === "scoring") && (
            <div className="space-y-2">
              {transcript.map((line, i) => (
                <div key={i} className={`flex ${line.role === "agent" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`text-sm rounded-lg px-3 py-1.5 max-w-[85%] ${
                      line.role === "agent"
                        ? "bg-purple-100 text-purple-900"
                        : "bg-white border border-gray-200 text-gray-900"
                    }`}
                  >
                    <p className="text-[10px] uppercase tracking-wide opacity-60 mb-0.5">
                      {line.role === "agent" ? "You" : "Prospect"}
                    </p>
                    {line.text}
                  </div>
                </div>
              ))}
              {phase === "scoring" && (
                <div className="text-xs text-center text-muted-foreground py-3 flex items-center justify-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Scoring your performance…
                </div>
              )}
            </div>
          )}

          {phase === "scored" && scoreResult && (
            <div className="space-y-4">
              <div className="text-center">
                <Trophy className="h-7 w-7 text-amber-500 mx-auto mb-1" />
                <p className="text-3xl font-bold">{Math.round(scoreResult.totalScore)}<span className="text-base text-muted-foreground">/100</span></p>
                <p className="text-xs text-muted-foreground mt-0.5">Practice score</p>
              </div>
              {scoreResult.summary && (
                <p className="text-sm text-gray-700 italic">{scoreResult.summary}</p>
              )}
              {scoreResult.strengths.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-1.5">Strengths</p>
                  <ul className="space-y-1">
                    {scoreResult.strengths.map((s, i) => (
                      <li key={i} className="text-sm text-gray-700 flex gap-2">
                        <span className="text-emerald-500 shrink-0">+</span>{s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {scoreResult.improvements.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1.5">Try this next time</p>
                  <ul className="space-y-1">
                    {scoreResult.improvements.map((s, i) => (
                      <li key={i} className="text-sm text-gray-700 flex gap-2">
                        <span className="text-amber-500 shrink-0">→</span>{s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-200 bg-white flex items-center justify-between gap-2">
          {phase === "live" && (
            <>
              <button
                onClick={toggleMute}
                aria-label={muted ? "Unmute" : "Mute"}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md transition-colors ${
                  muted ? "bg-red-50 text-red-700 hover:bg-red-100" : "bg-gray-100 hover:bg-gray-200"
                }`}
              >
                {muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                {muted ? "Muted" : "Mic on"}
              </button>
              <Button variant="destructive" size="sm" onClick={endAndScore}>
                End & Score
              </Button>
            </>
          )}
          {phase === "scored" && (
            <div className="flex w-full justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
            </div>
          )}
          {(phase === "connecting" || phase === "scoring") && (
            <p className="text-xs text-muted-foreground mx-auto">
              {phase === "connecting" ? "Hold tight — calling the prospect…" : "Reviewing the conversation…"}
            </p>
          )}
          {phase === "error" && (
            <div className="flex w-full justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
