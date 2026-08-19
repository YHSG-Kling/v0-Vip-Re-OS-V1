"use client"

/**
 * The two verbs the coaching surface never had.
 *
 *   · ACCEPT a pending suggestion  → app/actions/copilot.ts:handleSuggestionAccepted
 *   · BOOK a coaching session      → app/actions/copilot.ts:handleCoachingSessionBooked
 *
 * Both are `"use server"` actions, i.e. their own public HTTP endpoints, and both
 * re-establish the caller server-side (resolveWriteContext / authorizeForUser). This
 * component therefore carries NO authority: the ids it sends are the ids the server
 * already scoped its own reads to, and a tampered payload is refused by the action,
 * not by this file.
 *
 * Every outcome is reported EXACTLY as the action returns it. Both handlers were
 * repaired in a previous wave specifically because they used to discard their write
 * errors and return success anyway — "a coaching session that was never booked looked
 * booked". A surface that renders an optimistic checkmark would put that bug back on
 * the screen after it was removed from the server, so nothing here assumes success,
 * and the partial outcome (session booked, prep reminder refused) has its own line.
 */

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CalendarPlus, Check, Loader2, AlertTriangle } from "lucide-react"
import {
  handleCoachingSessionBooked,
  handleSuggestionAccepted,
} from "@/app/actions/copilot"

interface Coach {
  id: string
  label: string
  role: string
}

type Row = Record<string, unknown>

const str = (r: Row, k: string) => (typeof r[k] === "string" ? (r[k] as string) : "")

export function CoachingSessionsClient({
  userId,
  hasAgentProfile,
  coaches,
  suggestions,
  bookedSessions,
  loadErrors,
}: {
  userId: string
  hasAgentProfile: boolean
  coaches: Coach[]
  suggestions: Row[]
  bookedSessions: Row[]
  loadErrors: string[]
}) {
  const router = useRouter()

  // ── Booking form ───────────────────────────────────────────────────────────
  const [topic, setTopic] = useState("")
  const [sessionDate, setSessionDate] = useState("")
  const [coachId, setCoachId] = useState(coaches[0]?.id ?? "")
  const [bookMessage, setBookMessage] = useState<
    { kind: "ok" | "warn" | "error"; text: string } | null
  >(null)
  const [booking, startBooking] = useTransition()

  const book = () => {
    setBookMessage(null)
    if (!topic.trim()) {
      setBookMessage({ kind: "error", text: "Give the session a topic first." })
      return
    }
    if (!sessionDate) {
      setBookMessage({ kind: "error", text: "Pick a date and time for the session." })
      return
    }
    if (!coachId) {
      setBookMessage({ kind: "error", text: "Choose who is coaching." })
      return
    }
    startBooking(async () => {
      const res = await handleCoachingSessionBooked({
        // The action re-derives authority from the session; this id only tells it
        // WHOSE calendar is meant, and it refuses any value that is not the caller
        // (or a caller holding the act-for-others role).
        user_id: userId,
        // `new Date(session_date)` on the server needs a parseable instant — the
        // datetime-local value is local wall time, so it is converted here rather
        // than shipped ambiguous.
        session_date: new Date(sessionDate).toISOString(),
        coach_id: coachId,
        topic: topic.trim(),
      })
      if (!res?.success) {
        setBookMessage({
          kind: "error",
          // Cast, not narrowing: the action's success branches carry no `error`, and
          // its `success` is inferred as `boolean` rather than a literal, so the union
          // is not discriminated.
          text: (res as { error?: string })?.error ?? "The session was not booked.",
        })
        return
      }
      if ((res as { warning?: string }).warning) {
        // Booked, but the prep reminder was refused. The action distinguishes these
        // two outcomes on purpose; so does this line.
        setBookMessage({ kind: "warn", text: (res as { warning: string }).warning })
      } else {
        setBookMessage({ kind: "ok", text: "Session booked, and the prep reminder is on your task list." })
      }
      setTopic("")
      setSessionDate("")
      router.refresh()
    })
  }

  // ── Accept a suggestion ────────────────────────────────────────────────────
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const [acceptError, setAcceptError] = useState<{ id: string; text: string } | null>(null)
  const [accepted, setAccepted] = useState<Set<string>>(new Set())
  const [, startAccept] = useTransition()

  const accept = (suggestionId: string, actionType: string) => {
    setAcceptError(null)
    setAcceptingId(suggestionId)
    startAccept(async () => {
      const res = await handleSuggestionAccepted({
        suggestion_id: suggestionId,
        // What the agent is agreeing TO. The action stores it on the row's metadata
        // as `action_taken`, merged onto whatever the suggestion already carried.
        action_type: actionType || "accepted_from_coaching",
      })
      setAcceptingId(null)
      if (!res?.success) {
        setAcceptError({
          id: suggestionId,
          text: (res as { error?: string })?.error ?? "Could not accept this suggestion.",
        })
        return
      }
      setAccepted((prev) => new Set(prev).add(suggestionId))
      router.refresh()
    })
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Coaching Sessions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Book time with a coach, and accept the coaching suggestions you intend to act on.
        </p>
      </div>

      {loadErrors.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" /> Some of this page could not be loaded
          </p>
          <ul className="ml-6 mt-1 list-disc">
            {loadErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Book ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Book a session</CardTitle>
          <CardDescription>
            Puts the session on your calendar and creates a prep task 24 hours before it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!hasAgentProfile ? (
            <p className="text-sm text-muted-foreground">
              Booking needs an agent profile — the session hangs off it. Finish account setup first.
            </p>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="coaching-topic">Topic</Label>
                  <Input
                    id="coaching-topic"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="Listing presentation practice"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="coaching-when">When</Label>
                  <Input
                    id="coaching-when"
                    type="datetime-local"
                    value={sessionDate}
                    onChange={(e) => setSessionDate(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="coaching-coach">Coach</Label>
                {coaches.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No broker, team lead or admin is on this brokerage yet, so there is nobody to
                    name as the coach.
                  </p>
                ) : (
                  <select
                    id="coaching-coach"
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    value={coachId}
                    onChange={(e) => setCoachId(e.target.value)}
                  >
                    {coaches.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                        {c.role ? ` — ${c.role.replace(/_/g, " ")}` : ""}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <Button onClick={book} disabled={booking || coaches.length === 0}>
                {booking ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CalendarPlus className="mr-2 h-4 w-4" />
                )}
                Book session
              </Button>

              {bookMessage && (
                <p
                  className={
                    bookMessage.kind === "error"
                      ? "text-sm text-destructive"
                      : bookMessage.kind === "warn"
                        ? "text-sm text-amber-600"
                        : "text-sm text-emerald-600"
                  }
                >
                  {bookMessage.text}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Upcoming ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your coaching calendar</CardTitle>
          <CardDescription>Coaching sessions on your calendar from today forward.</CardDescription>
        </CardHeader>
        <CardContent>
          {bookedSessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing booked yet.</p>
          ) : (
            <ul className="space-y-2">
              {bookedSessions.map((s) => (
                <li
                  key={str(s, "id")}
                  className="flex items-center justify-between rounded-md border p-3 text-sm"
                >
                  <span>{str(s, "title") || "Coaching session"}</span>
                  <span className="text-muted-foreground">
                    {str(s, "start_at") ? new Date(str(s, "start_at")).toLocaleString() : "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── Accept suggestions ───────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pending coaching suggestions</CardTitle>
          <CardDescription>
            Accepting records that you agreed to the suggestion. Completing it is a separate step —
            the two are different points of the lifecycle, not synonyms.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {suggestions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {hasAgentProfile
                ? "No pending suggestions right now."
                : "Suggestions are scoped to an agent profile, and this account does not have one yet."}
            </p>
          ) : (
            <ul className="space-y-3">
              {suggestions.map((s) => {
                const id = str(s, "id")
                const isAccepted = accepted.has(id)
                return (
                  <li key={id} className="rounded-md border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{str(s, "title") || "Suggestion"}</p>
                        {str(s, "description") && (
                          <p className="mt-0.5 text-sm text-muted-foreground">
                            {str(s, "description")}
                          </p>
                        )}
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {str(s, "priority") && (
                            <Badge variant="outline" className="text-[11px]">
                              {str(s, "priority")}
                            </Badge>
                          )}
                          {str(s, "suggestion_type") && (
                            <Badge variant="secondary" className="text-[11px]">
                              {str(s, "suggestion_type").replace(/_/g, " ")}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant={isAccepted ? "secondary" : "default"}
                        disabled={isAccepted || acceptingId === id}
                        onClick={() => accept(id, str(s, "action_type") || str(s, "suggestion_type"))}
                      >
                        {acceptingId === id ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Check className="mr-1.5 h-3.5 w-3.5" />
                        )}
                        {isAccepted ? "Accepted" : "Accept"}
                      </Button>
                    </div>
                    {acceptError?.id === id && (
                      <p className="mt-2 text-xs text-destructive">{acceptError.text}</p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
