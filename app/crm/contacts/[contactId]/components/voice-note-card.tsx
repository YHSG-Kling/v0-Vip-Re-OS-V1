"use client"

/**
 * app/crm/contacts/[contactId]/components/voice-note-card.tsx
 *
 * The door for POST /api/contacts/[contactId]/voice-note — the sole caller of
 * lib/contacts/voice-note-parser.ts and the only writer of
 * activities.activity_type='voice_note'.
 *
 * ── §6 CHECK RUN FIRST: IS THIS A SECOND SPELLING OF AN EXISTING VOICE LANE? ──
 * No. Two voice affordances already exist and neither performs this process:
 *
 *   · app/actions/voice-assistant.ts:processVoiceCommand — the hands-free
 *     COMMAND lane (its own header: "Like Alexa/Siri for real estate - voice
 *     commands while driving"). Its `add_note` intent resolves a contact by
 *     SPOKEN NAME via lookupContact, then delegates to
 *     app/actions/contacts.ts:addContactNote, which inserts a plain body into
 *     `contact_notes`. No parsing, no sentiment, no next step, no tasks, and a
 *     different table.
 *   · app/mobile/voice/voice-session-button.tsx — the mobile assistant surface,
 *     which routes its transcript into that same command lane (or into the
 *     offer/listing draft intakes). It is a transport, not a note.
 *
 * This route is the third, distinct process: an agent standing on the record of
 * the contact they just met dictates what happened; the transcript is parsed
 * into a structured note body + sentiment + next step + explicit follow-up
 * TASKS, appended to contacts.notes, recorded as a `voice_note` activity and
 * turned into `tasks` rows. Same input medium, different business process — so
 * this is a BUILD, not a merge.
 *
 * ── TYPING IS A FIRST-CLASS PATH ──
 * The route takes a transcript string; where it came from is not its business.
 * Browser SpeechRecognition is offered when the browser has it (the same
 * feature-detect idiom as app/mobile/voice/voice-session-button.tsx:71) and its
 * absence is stated rather than disabling the card — a desktop Firefox agent can
 * still paste or type the note and get the identical parse.
 *
 * ── NOTHING IS CLAIMED THAT THE RESPONSE DID NOT SAY ──
 * The route returns `noteRecorded` (false when the `voice_note` activities row
 * — the only row that carries the agent's words — was refused) and
 * `tasksRequested` beside the created `tasks`. Both are read here, so a partial
 * save reads as a partial save and a dropped follow-up is named instead of
 * silently vanishing into an empty list.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, Mic, MicOff, NotebookPen } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

interface VoiceNoteResult {
  note: string
  sentiment: "positive" | "neutral" | "negative" | string
  nextStep: string | null
  tasks: Array<{ id: string; title: string; due_date: string | null }>
  noteRecorded: boolean
  tasksRequested: number
}

const SENTIMENT_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  positive: "default",
  neutral: "secondary",
  negative: "destructive",
}

export function VoiceNoteCard({ contactId }: { contactId: string }) {
  const [transcript, setTranscript] = useState("")
  const [listening, setListening] = useState(false)
  const [dictationSupported, setDictationSupported] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<VoiceNoteResult | null>(null)
  // A ref, not state: the recogniser is read inside its own callbacks, where a
  // state value is the stale one captured when the handler was created.
  const recognitionRef = useRef<any>(null)

  useEffect(() => {
    if (typeof window === "undefined") return
    setDictationSupported(
      Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition),
    )
    return () => {
      try {
        recognitionRef.current?.stop()
      } catch {
        /* the recogniser is already gone */
      }
      recognitionRef.current = null
    }
  }, [])

  const startDictation = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) {
      setError("This browser has no speech recognition — type or paste the note instead.")
      return
    }
    setError(null)
    const recognition = new SR()
    recognition.continuous = true
    recognition.interimResults = false
    recognition.lang = "en-US"
    recognition.onstart = () => setListening(true)
    recognition.onresult = (event: any) => {
      let chunk = ""
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) chunk += event.results[i][0].transcript
      }
      if (chunk) setTranscript((prev) => (prev ? `${prev} ${chunk.trim()}` : chunk.trim()))
    }
    recognition.onerror = (event: any) => {
      setError(`Dictation stopped: ${event?.error ?? "unknown error"}. What was captured is kept below.`)
      setListening(false)
    }
    recognition.onend = () => {
      setListening(false)
      recognitionRef.current = null
    }
    recognitionRef.current = recognition
    recognition.start()
  }, [])

  const stopDictation = useCallback(() => {
    try {
      recognitionRef.current?.stop()
    } catch {
      /* already stopped */
    }
    setListening(false)
  }, [])

  async function save() {
    const text = transcript.trim()
    if (!text) {
      setError("Nothing to save yet — dictate or type the note first.")
      return
    }
    stopDictation()
    setSaving(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch(`/api/contacts/${contactId}/voice-note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: text }),
      })
      const payload = await res.json().catch(() => null)
      // READ THE RESPONSE. 400 (empty transcript), 404 (contact outside the
      // caller's brokerage) and the auth refusals all carry `error`; only a
      // body that actually says success is treated as one.
      if (!res.ok || !payload?.success) {
        setError(
          (payload && typeof payload.error === "string" && payload.error) ||
            `The note was not saved (HTTP ${res.status}).`,
        )
        return
      }
      setResult({
        note: String(payload.note ?? ""),
        sentiment: String(payload.sentiment ?? "neutral"),
        nextStep: typeof payload.nextStep === "string" ? payload.nextStep : null,
        tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
        noteRecorded: payload.noteRecorded !== false,
        tasksRequested:
          typeof payload.tasksRequested === "number"
            ? payload.tasksRequested
            : Array.isArray(payload.tasks)
              ? payload.tasks.length
              : 0,
      })
      setTranscript("")
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "The note was not saved.")
    } finally {
      setSaving(false)
    }
  }

  const droppedTasks = result ? Math.max(0, result.tasksRequested - result.tasks.length) : 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <NotebookPen className="h-4 w-4" />
          Voice note
        </CardTitle>
        <CardDescription className="text-xs">
          Dictate what happened on the showing or the call. It is parsed into a written note on
          this contact, a sentiment read, and any follow-up you actually said you would do —
          nothing is invented.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          rows={4}
          placeholder="Met at the Oak St property. She loved the kitchen, wants comps for the block. I'll send them tomorrow."
          disabled={saving}
        />
        <div className="flex flex-wrap items-center gap-2">
          {dictationSupported ? (
            listening ? (
              <Button size="sm" variant="destructive" onClick={stopDictation}>
                <MicOff className="h-3.5 w-3.5 mr-2" />
                Stop dictation
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={startDictation} disabled={saving}>
                <Mic className="h-3.5 w-3.5 mr-2" />
                Dictate
              </Button>
            )
          ) : (
            <span className="text-xs text-muted-foreground">
              This browser has no speech recognition — type or paste the note.
            </span>
          )}
          <Button size="sm" onClick={save} disabled={saving || !transcript.trim()}>
            {saving ? <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> : null}
            Save note
          </Button>
          {listening && (
            <span className="text-xs text-muted-foreground">Listening — speak normally.</span>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {result && (
          <div className="rounded-lg border px-3 py-2 space-y-2">
            {!result.noteRecorded && (
              <p className="text-sm text-destructive">
                Only partly saved: the timeline entry that carries your words was refused, so the
                note survives only as the one-line stamp on this contact. Copy it somewhere safe
                and tell an admin.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Captured</span>
              <Badge
                variant={SENTIMENT_VARIANT[result.sentiment] ?? "secondary"}
                className="text-[11px] capitalize"
              >
                {result.sentiment}
              </Badge>
            </div>
            <p className="text-sm">{result.note}</p>
            {result.nextStep && (
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Next step: </span>
                {result.nextStep}
              </p>
            )}
            {result.tasks.length > 0 && (
              <ul className="space-y-1">
                {result.tasks.map((t) => (
                  <li key={t.id} className="text-sm text-muted-foreground">
                    Task created: {t.title}
                    {t.due_date ? ` — due ${new Date(t.due_date).toLocaleDateString()}` : ""}
                  </li>
                ))}
              </ul>
            )}
            {droppedTasks > 0 && (
              <p className="text-sm text-destructive">
                {droppedTasks} follow-up{droppedTasks === 1 ? "" : "s"} you mentioned could not be
                created as a task. Add {droppedTasks === 1 ? "it" : "them"} by hand.
              </p>
            )}
            {result.tasks.length === 0 && droppedTasks === 0 && (
              <p className="text-xs text-muted-foreground">
                No follow-up task — you did not name an action to take.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
