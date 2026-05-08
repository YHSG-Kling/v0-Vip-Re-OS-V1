"use client"

import { useState, useRef, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Sparkles, MessageSquare, Loader2, Trophy, CheckCircle2, AlertCircle,
  ArrowRight, Volume2, RotateCcw, Mic,
} from "lucide-react"
import {
  startObjectionPracticeSession,
  submitPracticeTurn,
  endPracticeSession,
  type ObjectionScenario,
  type PracticeSession,
} from "@/app/actions/objection-training"
import { VoicePracticeOverlay } from "./voice-practice-overlay"

interface Props {
  scenarios: ObjectionScenario[]
  pastSessions: PracticeSession[]
}

interface ChatTurn {
  speaker: "prospect" | "agent"
  text: string
  score?: number
  feedback?: string
}

const DIFFICULTY_COLOR: Record<string, string> = {
  easy: "bg-green-100 text-green-800 border-green-200",
  medium: "bg-amber-100 text-amber-800 border-amber-200",
  hard: "bg-red-100 text-red-800 border-red-200",
}

export function PracticeClient({ scenarios, pastSessions }: Props) {
  const [stage, setStage] = useState<"select" | "active" | "finished">("select")
  const [activeScenario, setActiveScenario] = useState<ObjectionScenario | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [agentInput, setAgentInput] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [starting, setStarting] = useState(false)
  // Track C — live voice practice (separate from typed flow)
  const [voiceScenario, setVoiceScenario] = useState<ObjectionScenario | null>(null)
  const [finishedSummary, setFinishedSummary] = useState<{
    totalScore: number
    summary: string
    strengths: string[]
    improvements: string[]
  } | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)

  // Auto-scroll on new turn
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
    }
  }, [turns])

  // Speak the prospect's last line via the cloned-voice TTS endpoint
  async function speakProspect(text: string) {
    try {
      const res = await fetch("/api/internal/voice-tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })
      if (res.ok) {
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        new Audio(url).play().finally(() => setTimeout(() => URL.revokeObjectURL(url), 5000))
      }
    } catch {}
  }

  async function startSession(scenario: ObjectionScenario) {
    setStarting(true)
    const result = await startObjectionPracticeSession({ scenarioKey: scenario.key })
    setStarting(false)
    if (result.success && result.sessionId) {
      setActiveScenario(scenario)
      setSessionId(result.sessionId)
      const opening: ChatTurn = { speaker: "prospect", text: result.openingLine ?? scenario.openingLine }
      setTurns([opening])
      setStage("active")
      // Voice the opening
      speakProspect(opening.text)
    }
  }

  async function handleSubmitTurn() {
    if (!sessionId || !agentInput.trim() || submitting) return
    const myTurn: ChatTurn = { speaker: "agent", text: agentInput.trim() }
    setTurns((t) => [...t, myTurn])
    setAgentInput("")
    setSubmitting(true)
    const result = await submitPracticeTurn({ sessionId, agentResponse: myTurn.text })
    setSubmitting(false)
    if (result.success) {
      setTurns((t) => {
        const updated = [...t]
        const last = updated[updated.length - 1]
        if (last && last.speaker === "agent") {
          last.score = result.agentTurnScore
          last.feedback = result.agentTurnFeedback
        }
        if (result.prospectReply) {
          updated.push({ speaker: "prospect", text: result.prospectReply })
        }
        return updated
      })
      if (result.prospectReply) {
        speakProspect(result.prospectReply)
      }
      if (result.shouldEnd) {
        setTimeout(() => handleFinish(), 1000)
      }
    }
  }

  async function handleFinish() {
    if (!sessionId) return
    setSubmitting(true)
    const result = await endPracticeSession({ sessionId })
    setSubmitting(false)
    if (result.success) {
      setFinishedSummary({
        totalScore: result.totalScore ?? 0,
        summary: result.summary ?? "",
        strengths: result.strengths ?? [],
        improvements: result.improvements ?? [],
      })
      setStage("finished")
    }
  }

  function reset() {
    setActiveScenario(null)
    setSessionId(null)
    setTurns([])
    setAgentInput("")
    setFinishedSummary(null)
    setStage("select")
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-purple-600" />
            Objection Training
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Practice handling difficult prospect conversations. AI plays the prospect; you respond;
            you get scored on each turn and a summary at the end.
          </p>
        </div>
      </div>

      {stage === "select" && (
        <SelectStage
          scenarios={scenarios}
          onStart={startSession}
          onStartVoice={(s) => setVoiceScenario(s)}
          starting={starting}
          pastSessions={pastSessions}
        />
      )}

      {/* Track C — live voice practice overlay */}
      <VoicePracticeOverlay
        open={!!voiceScenario}
        scenarioKey={voiceScenario?.key ?? ""}
        scenarioLabel={voiceScenario?.label ?? ""}
        onClose={() => setVoiceScenario(null)}
      />

      {stage === "active" && activeScenario && (
        <ActiveStage
          scenario={activeScenario}
          turns={turns}
          agentInput={agentInput}
          setAgentInput={setAgentInput}
          submitting={submitting}
          onSubmit={handleSubmitTurn}
          onFinish={handleFinish}
          onSpeak={speakProspect}
          transcriptRef={transcriptRef}
        />
      )}

      {stage === "finished" && finishedSummary && activeScenario && (
        <FinishedStage
          scenario={activeScenario}
          summary={finishedSummary}
          onAgain={reset}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stage: Scenario picker
// ---------------------------------------------------------------------------

function SelectStage({
  scenarios, onStart, onStartVoice, starting, pastSessions,
}: {
  scenarios: ObjectionScenario[]
  onStart: (s: ObjectionScenario) => void
  onStartVoice: (s: ObjectionScenario) => void
  starting: boolean
  pastSessions: PracticeSession[]
}) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold mb-3">Pick a scenario</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {scenarios.map((s) => (
            <Card key={s.key} className="hover:border-purple-300 transition-colors">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{s.label}</CardTitle>
                  <Badge variant="outline" className={`text-xs capitalize ${DIFFICULTY_COLOR[s.difficulty]}`}>
                    {s.difficulty}
                  </Badge>
                </div>
                <CardDescription className="text-xs">{s.persona}</CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="text-xs text-muted-foreground italic mb-3 line-clamp-2">
                  "{s.openingLine}"
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 gap-1"
                    onClick={() => onStart(s)}
                    disabled={starting}
                  >
                    {starting ? <Loader2 className="h-3 w-3 animate-spin" /> : <MessageSquare className="h-3 w-3" />}
                    Type
                  </Button>
                  <Button
                    size="sm"
                    className="flex-1 gap-1 bg-purple-600 hover:bg-purple-700"
                    onClick={() => onStartVoice(s)}
                  >
                    <Mic className="h-3 w-3" />
                    Live Voice
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {pastSessions.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold mb-3">Recent Sessions</h2>
          <Card>
            <CardContent className="p-0">
              <div className="divide-y">
                {pastSessions.slice(0, 8).map((s) => (
                  <div key={s.id} className="px-4 py-2 flex items-center justify-between gap-3 text-sm">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{s.scenarioLabel}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(s.startedAt).toLocaleDateString()} · {s.status}
                      </p>
                    </div>
                    {s.totalScore != null && (
                      <Badge variant="outline" className="text-xs">
                        <Trophy className="h-3 w-3 mr-1" />
                        {Math.round(Number(s.totalScore))}/100
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stage: Live practice
// ---------------------------------------------------------------------------

function ActiveStage({
  scenario, turns, agentInput, setAgentInput, submitting,
  onSubmit, onFinish, onSpeak, transcriptRef,
}: {
  scenario: ObjectionScenario
  turns: ChatTurn[]
  agentInput: string
  setAgentInput: (v: string) => void
  submitting: boolean
  onSubmit: () => void
  onFinish: () => void
  onSpeak: (text: string) => void
  transcriptRef: React.MutableRefObject<HTMLDivElement | null>
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">{scenario.label}</CardTitle>
              <CardDescription className="text-xs">{scenario.persona}</CardDescription>
            </div>
            <Badge variant="outline" className={`text-xs capitalize ${DIFFICULTY_COLOR[scenario.difficulty]}`}>
              {scenario.difficulty}
            </Badge>
          </div>
        </CardHeader>
      </Card>

      {/* Transcript */}
      <Card>
        <CardContent className="p-0">
          <div ref={transcriptRef} className="max-h-[400px] overflow-y-auto p-4 space-y-3">
            {turns.map((t, i) => (
              <div
                key={i}
                className={`flex flex-col ${t.speaker === "agent" ? "items-end" : "items-start"}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 ${
                    t.speaker === "prospect"
                      ? "bg-gray-100 text-gray-900"
                      : "bg-purple-50 text-purple-900 border border-purple-200"
                  }`}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-semibold uppercase text-muted-foreground">
                      {t.speaker === "prospect" ? "Prospect" : "You"}
                    </span>
                    {t.speaker === "prospect" && (
                      <button
                        onClick={() => onSpeak(t.text)}
                        className="text-muted-foreground hover:text-foreground"
                        title="Replay audio"
                      >
                        <Volume2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  <p className="text-sm">{t.text}</p>
                  {t.score != null && (
                    <div className="mt-2 pt-2 border-t border-purple-200">
                      <div className="flex items-center gap-2 text-xs">
                        <Trophy className="h-3 w-3 text-purple-600" />
                        <span className="font-semibold">{Math.round(t.score)}/100</span>
                      </div>
                      {t.feedback && (
                        <p className="text-xs text-muted-foreground mt-1 italic">{t.feedback}</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {submitting && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Prospect is thinking…
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Input */}
      <Card>
        <CardContent className="p-3 space-y-2">
          <Textarea
            value={agentInput}
            onChange={(e) => setAgentInput(e.target.value)}
            placeholder="Your response…"
            className="min-h-[80px] text-sm"
            disabled={submitting}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                onSubmit()
              }
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              Tip: ⌘+Enter to send · Stay in role · Lead with value
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onFinish} disabled={submitting}>
                End Session
              </Button>
              <Button size="sm" onClick={onSubmit} disabled={submitting || !agentInput.trim()}>
                {submitting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                Send
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stage: Finished
// ---------------------------------------------------------------------------

function FinishedStage({
  scenario, summary, onAgain,
}: {
  scenario: ObjectionScenario
  summary: { totalScore: number; summary: string; strengths: string[]; improvements: string[] }
  onAgain: () => void
}) {
  const score = Math.round(summary.totalScore)
  return (
    <div className="space-y-4">
      <Card className="border-purple-200 bg-purple-50/30">
        <CardContent className="p-6 text-center space-y-3">
          <Trophy className="h-10 w-10 mx-auto text-purple-600" />
          <h2 className="text-xl font-semibold">{scenario.label}</h2>
          <div className="text-4xl font-bold text-purple-600">{score}/100</div>
          <p className="text-sm text-muted-foreground max-w-2xl mx-auto">{summary.summary}</p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              Strengths
            </CardTitle>
          </CardHeader>
          <CardContent>
            {summary.strengths.length === 0 ? (
              <p className="text-xs text-muted-foreground">No specific strengths identified.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {summary.strengths.map((s, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0 mt-0.5" />
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-amber-600" />
              Areas to improve
            </CardTitle>
          </CardHeader>
          <CardContent>
            {summary.improvements.length === 0 ? (
              <p className="text-xs text-muted-foreground">No specific improvements suggested.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {summary.improvements.map((s, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <AlertCircle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex gap-2 justify-center">
        <Button variant="outline" onClick={onAgain} className="gap-2">
          <RotateCcw className="h-4 w-4" />
          Practice Again
        </Button>
      </div>
    </div>
  )
}
