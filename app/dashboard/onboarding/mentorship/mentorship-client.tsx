"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, Users, Sparkles, Calendar, CheckCircle2, ArrowLeft, Mail, Phone } from "lucide-react"
import { toast } from "sonner"
import Link from "next/link"
import { matchMentor } from "@/app/actions/onboarding/mentorship"
import { logMentorSession, type MentorSessionEntry } from "@/app/actions/onboarding/mentor-session"
import { MIN_COHORT, type MentorLift } from "@/lib/recruiting/mentor-lift"

interface MentorData {
  mentorId: string
  mentorName: string
  mentorEmail: string | null
  mentorPhone: string | null
  suggestedTopics: string[]
  matchScore: number | null
  matchReason: string | null
}

interface Props {
  agentId: string
  brokerageId: string
  initialMentor: MentorData | null
  /** The mentee's most recent COMPLETED pairing (agent_mentor_relationships.end_date,
   *  stamped by lib/recruiting/mentorship-lifecycle.ts on certification). Only set when
   *  there is no active mentor — it is the difference between "you graduated" and "you
   *  have never been paired". `endedAt` is null when the ledger holds no date; the card
   *  says so rather than inventing one. */
  graduation: { mentorName: string | null; endedAt: string | null } | null
  /** Logged coaching sessions, both sides of the pairing — the reader half of
   *  logMentorSession (mentor_sessions had no reader at all until now). */
  sessions: MentorSessionEntry[]
  /** Set when the history read was REFUSED. Shown instead of an empty list, so
   *  an outage never renders as "you have never had a session". */
  sessionsError: string | null
  /** The broker KPI (getMentorLift) — present only when the viewer administers
   *  the tenant; null for an agent (the action refuses them, by design). */
  mentorLift?: MentorLift | null
}

function MentorLiftCard({ lift }: { lift: MentorLift }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Mentor lift — brokerage KPI</CardTitle>
        <CardDescription>
          Newer agents (&lt;2 years) with an active mentor vs. without, on YTD transactions and the latest
          retention score. Visible to brokerage admins.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Mentored ({lift.mentored.count})</p>
            <p className="font-medium">{lift.mentored.avgTransactions} avg transactions</p>
            <p className="text-xs text-muted-foreground">retention {lift.mentored.avgRetention}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs text-muted-foreground">Unmentored ({lift.unmentored.count})</p>
            <p className="font-medium">{lift.unmentored.avgTransactions} avg transactions</p>
            <p className="text-xs text-muted-foreground">retention {lift.unmentored.avgRetention}</p>
          </div>
        </div>
        {lift.hasVerdict ? (
          <p className="text-sm">
            Mentored agents average{" "}
            <span className="font-semibold">
              {lift.liftTransactionsPct == null ? "—" : `${lift.liftTransactionsPct > 0 ? "+" : ""}${lift.liftTransactionsPct}%`}
            </span>{" "}
            transactions and{" "}
            <span className="font-semibold">
              {lift.liftRetentionPts == null ? "—" : `${lift.liftRetentionPts > 0 ? "+" : ""}${lift.liftRetentionPts} pts`}
            </span>{" "}
            retention vs. unmentored peers.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No verdict yet — each cohort needs at least {MIN_COHORT} newer agents before the comparison means
            anything. Thin data is never reported as a lift.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export function MentorshipClient({ agentId, brokerageId, initialMentor, graduation, sessions, sessionsError, mentorLift = null }: Props) {
  const [mentor, setMentor] = useState<MentorData | null>(initialMentor)
  const [matching, setMatching] = useState(false)

  async function handleFindMentor() {
    setMatching(true)
    try {
      const result = await matchMentor(agentId)
      if (result.success) {
        toast.success("Mentor matched! Refresh to see your mentor's details.")
        // Reload to get full mentor profile
        window.location.reload()
      } else {
        toast.error(result.error ?? "Could not find a mentor match right now.")
      }
    } finally {
      setMatching(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/onboarding">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Mentorship</h1>
          <p className="text-sm text-muted-foreground">
            Get paired with an experienced agent to guide your first 90 days
          </p>
        </div>
      </div>

      {mentorLift && <MentorLiftCard lift={mentorLift} />}

      {mentor ? (
        /* Mentor assigned */
        <div className="space-y-4">
          <Card className="border-emerald-200 bg-emerald-50/40">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                <CardTitle className="text-base">Your mentor is assigned</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-start gap-3">
                <div className="h-12 w-12 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                  <Users className="h-6 w-6 text-emerald-700" />
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-lg">{mentor.mentorName}</p>
                  {mentor.matchScore && (
                    <Badge variant="secondary" className="text-xs mt-0.5">
                      {Math.round(mentor.matchScore * 100)}% match
                    </Badge>
                  )}
                  {mentor.matchReason && (
                    <p className="text-sm text-muted-foreground mt-1">{mentor.matchReason}</p>
                  )}
                </div>
              </div>

              {(mentor.mentorEmail || mentor.mentorPhone) && (
                <div className="space-y-1.5 pt-1 border-t">
                  {mentor.mentorEmail && (
                    <a
                      href={`mailto:${mentor.mentorEmail}`}
                      className="flex items-center gap-2 text-sm text-primary hover:underline"
                    >
                      <Mail className="h-3.5 w-3.5" />
                      {mentor.mentorEmail}
                    </a>
                  )}
                  {mentor.mentorPhone && (
                    <a
                      href={`tel:${mentor.mentorPhone}`}
                      className="flex items-center gap-2 text-sm text-primary hover:underline"
                    >
                      <Phone className="h-3.5 w-3.5" />
                      {mentor.mentorPhone}
                    </a>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {mentor.suggestedTopics.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  Suggested first meeting topics
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5">
                  {mentor.suggestedTopics.map((topic, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <span className="text-muted-foreground mt-0.5">•</span>
                      {topic}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-muted-foreground mb-3">
                Schedule your first 1-on-1 meeting with {mentor.mentorName} to kick off your mentorship.
              </p>
              <Button asChild className="gap-1.5">
                <Link href="/dashboard/calendar">
                  <Calendar className="h-4 w-4" />
                  Open Calendar to Schedule
                </Link>
              </Button>
            </CardContent>
          </Card>

          <LogSessionCard mentorId={mentor.mentorId} agentId={agentId} />
        </div>
      ) : (
        /* No ACTIVE mentor. A mentee who GRADUATED is told so first — the pairing ended
           because they certified, which is the opposite of never having been paired. */
        <div className="space-y-4">
        {graduation && (
          <Card className="border-emerald-200 bg-emerald-50/40">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                <CardTitle className="text-base">Mentorship complete</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm">
                You finished your mentorship
                {graduation.mentorName ? ` with ${graduation.mentorName}` : ""}
                {graduation.endedAt
                  ? ` on ${new Date(graduation.endedAt).toLocaleDateString()}`
                  : ""}
                . Your coaching history below stays with you.
              </p>
              {!graduation.endedAt && (
                <p className="text-xs text-muted-foreground mt-1">
                  The completion date was not recorded for this pairing.
                </p>
              )}
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              {graduation ? "Find a New Mentor" : "Find Your Mentor"}
            </CardTitle>
            <CardDescription>
              Our AI will analyze your background, market, and specialties to pair you with the most compatible
              experienced agent in your brokerage.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
              <p className="text-sm font-medium">What to expect from mentorship:</p>
              <ul className="text-sm text-muted-foreground space-y-1">
                <li className="flex items-start gap-2">
                  <span className="mt-0.5">•</span>
                  Weekly check-ins for the first 90 days
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5">•</span>
                  Deal review and strategy sessions
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5">•</span>
                  Local market knowledge transfer
                </li>
                <li className="flex items-start gap-2">
                  <span className="mt-0.5">•</span>
                  Access to your mentor's scripts, templates, and processes
                </li>
              </ul>
            </div>
            <Button
              onClick={handleFindMentor}
              disabled={matching}
              className="gap-1.5"
            >
              {matching ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Finding your best match…
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" />
                  Find My Mentor
                </>
              )}
            </Button>
          </CardContent>
        </Card>
        </div>
      )}

      <SessionHistoryCard sessions={sessions} error={sessionsError} />

      <div className="flex justify-between pt-2">
        <Link href="/dashboard/onboarding">
          <Button variant="outline">Back to Onboarding</Button>
        </Link>
      </div>
    </div>
  )
}

const SESSION_TYPE_LABEL: Record<string, string> = {
  check_in: "Check-in",
  deal_review: "Deal review",
  skill_building: "Skill building",
  crisis_support: "Crisis support",
}

/**
 * WHAT WAS ACTUALLY COACHED — the reader for mentor_sessions.
 *
 * Every field here was written by logMentorSession and read by nothing: the
 * rating, the agreed ACTION ITEM, the mentor's notes, the duration, the topics
 * and who logged the session. A coaching record neither party can read is a
 * record nobody can act on, which is the whole point of keeping one.
 */
function SessionHistoryCard({ sessions, error }: { sessions: MentorSessionEntry[]; error: string | null }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <Calendar className="h-4 w-4 text-primary" />
          Session history{sessions.length > 0 ? ` (${sessions.length})` : ""}
        </CardTitle>
        <CardDescription>
          Every session logged on this pairing — what you covered, what you agreed to do next.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p className="text-sm text-red-600">Could not load your session history: {error}</p>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sessions logged yet. Log one above after your next conversation — it is what both of you look
            back on.
          </p>
        ) : (
          sessions.map((s) => (
            <div key={s.id} className="rounded-md border p-3 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="text-[11px]">
                  {SESSION_TYPE_LABEL[s.sessionType ?? ""] ?? s.sessionType ?? "Session"}
                </Badge>
                <span className="text-sm font-medium">
                  {s.viewerWasMentor ? "You mentored" : "Mentored by"} {s.counterpartName ?? "your pairing"}
                </span>
                {!s.onCurrentRelationship && (
                  <Badge variant="secondary" className="text-[10px]">earlier pairing</Badge>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                  {s.loggedAt ? new Date(s.loggedAt).toLocaleDateString() : ""}
                  {s.durationMinutes ? ` · ${s.durationMinutes} min` : ""}
                  {s.menteeRating != null ? ` · ${s.menteeRating}★` : ""}
                </span>
              </div>
              {s.topics.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {s.topics.map((t) => (
                    <Badge key={t} variant="secondary" className="text-[10px] font-normal">{t}</Badge>
                  ))}
                </div>
              )}
              {s.actionItem && (
                <p className="text-sm flex items-start gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 text-emerald-600 shrink-0" />
                  <span><span className="font-medium">Agreed next step: </span>{s.actionItem}</span>
                </p>
              )}
              {s.mentorNotes && (
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{s.mentorNotes}</p>
              )}
              {s.loggedByName && (
                <p className="text-[11px] text-muted-foreground">Logged by {s.loggedByName}</p>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

/** Compact "log a session" form — records a mentor session (canonical mentor_sessions + ledger points). */
function LogSessionCard({ mentorId, agentId }: { mentorId: string; agentId: string }) {
  const [type, setType] = useState("check_in")
  const [rating, setRating] = useState(5)
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)

  async function log() {
    setSaving(true)
    try {
      const res = await logMentorSession({ mentorAgentId: mentorId, menteeAgentId: agentId, sessionType: type, menteeRating: rating })
      if (res.ok) { setDone(true); toast.success("Session logged — points awarded to you and your mentor.") }
      else toast.error(res.error ?? "Could not log the session.")
    } finally { setSaving(false) }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Log a session you had</CardTitle>
        <CardDescription>Track your mentorship — both of you earn points.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <select value={type} onChange={(e) => setType(e.target.value)} disabled={saving || done} className="border rounded px-2 py-1 text-sm">
          <option value="check_in">Check-in</option>
          <option value="deal_review">Deal review</option>
          <option value="skill_building">Skill building</option>
          <option value="crisis_support">Crisis support</option>
        </select>
        <label className="text-sm text-muted-foreground">Rating</label>
        <select value={rating} onChange={(e) => setRating(Number(e.target.value))} disabled={saving || done} className="border rounded px-2 py-1 text-sm">
          {[5, 4, 3, 2, 1].map((r) => <option key={r} value={r}>{r}★</option>)}
        </select>
        <Button size="sm" disabled={saving || done} onClick={log}>{done ? "Logged ✓" : saving ? "Saving…" : "Log session"}</Button>
      </CardContent>
    </Card>
  )
}
