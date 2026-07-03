"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, Users, Sparkles, Calendar, CheckCircle2, ArrowLeft, Mail, Phone } from "lucide-react"
import { toast } from "sonner"
import Link from "next/link"
import { matchMentor } from "@/app/actions/onboarding/mentorship"
import { logMentorSession } from "@/app/actions/onboarding/mentor-session"

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
}

export function MentorshipClient({ agentId, brokerageId, initialMentor }: Props) {
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
        /* No mentor yet */
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-primary" />
              Find Your Mentor
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
      )}

      <div className="flex justify-between pt-2">
        <Link href="/dashboard/onboarding">
          <Button variant="outline">Back to Onboarding</Button>
        </Link>
      </div>
    </div>
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
