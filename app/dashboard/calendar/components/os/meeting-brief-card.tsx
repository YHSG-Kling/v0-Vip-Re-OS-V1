"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { X, FileText, User, Target, MessageSquare, AlertCircle, CheckCircle2, Sparkles, CalendarClock, XCircle } from "lucide-react"
// Lane E2 2026-08-28: updateAppointment + cancelAppointment WIRED — the
// calendar could create appointments (quick-create panel) but nothing could
// move or cancel one. Both actions are session-gated and tenant-pinned.
import { prepareMeetingBrief, updateAppointment, cancelAppointment } from "@/app/actions/ai-calendar-management"
import type { UnifiedCalendarEvent } from "./calendar-shell"

interface MeetingBriefCardProps {
  event: UnifiedCalendarEvent
  agentId: string
  onClose: () => void
}

type MeetingBrief = {
  executiveSummary: string
  clientProfile: {
    name: string
    relationship: string
    keyFacts: string[]
    communicationStyle: string
    hotButtons: string[]
  }
  meetingObjectives: Array<{
    objective: string
    importance: "primary" | "secondary" | "tertiary"
  }>
  talkingPoints: Array<{
    topic: string
    keyPoints: string[]
    questions: string[]
  }>
  potentialObjections: Array<{
    objection: string
    response: string
  }>
  materialsNeeded: string[]
}

export function MeetingBriefCard({ event, agentId, onClose }: MeetingBriefCardProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [brief, setBrief] = useState<MeetingBrief | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Reschedule / cancel (calendar_events-source appointments only — showings,
  // tours, open houses etc. have their own lifecycle actions).
  const isAppointment = event.source === "calendar_events"
  const [showReschedule, setShowReschedule] = useState(false)
  const [newStart, setNewStart] = useState("")
  const [mutating, setMutating] = useState(false)
  const [mutateMsg, setMutateMsg] = useState<string | null>(null)

  const handleReschedule = async () => {
    if (!newStart) return
    setMutating(true)
    setMutateMsg(null)
    const startIso = new Date(newStart).toISOString()
    const durationMs = new Date(event.endAt).getTime() - new Date(event.startAt).getTime()
    const endIso = new Date(new Date(newStart).getTime() + Math.max(durationMs, 15 * 60 * 1000)).toISOString()
    const res = await updateAppointment(event.id, { start_time: startIso, end_time: endIso })
    setMutating(false)
    if ((res as any).success) {
      setMutateMsg("Rescheduled")
      setShowReschedule(false)
      router.refresh()
    } else {
      setMutateMsg((res as any).error?.message ?? (res as any).error ?? "Reschedule failed")
    }
  }

  const handleCancel = async () => {
    if (!window.confirm("Cancel this appointment?")) return
    setMutating(true)
    setMutateMsg(null)
    const res = await cancelAppointment(event.id)
    setMutating(false)
    if ((res as any).success) {
      onClose()
      router.refresh()
    } else {
      setMutateMsg((res as any).error?.message ?? (res as any).error ?? "Cancel failed")
    }
  }

  const handleGenerateBrief = (forceRegenerate = false) => {
    if (event.source !== "showings" && event.source !== "calendar_events") {
      setError("Meeting briefs available for appointments and showings only")
      return
    }

    setError(null)
    startTransition(async () => {
      const res = await prepareMeetingBrief({ appointmentId: event.id, agentId, forceRegenerate })
      if (res.success && res.meetingBrief) {
        setBrief(res.meetingBrief as MeetingBrief)
      } else {
        setError(res.error || "Failed to generate brief")
      }
    })
  }

  const startTime = new Date(event.startAt).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Meeting Details
          </CardTitle>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[400px] pr-2">
          <div className="space-y-4">
            {/* Event Info */}
            <div className="space-y-2">
              <h4 className="font-medium text-sm text-foreground">{event.title}</h4>
              <p className="text-xs text-muted-foreground">{startTime}</p>
              {event.location && (
                <p className="text-xs text-muted-foreground">{event.location}</p>
              )}
              {event.contactName && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <User className="h-3 w-3" />
                  {event.contactName}
                </div>
              )}
            </div>

            {/* Appointment management — calendar_events only */}
            {isAppointment && (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 text-xs"
                    onClick={() => { setShowReschedule((v) => !v); setMutateMsg(null) }}
                    disabled={mutating}
                  >
                    <CalendarClock className="h-3.5 w-3.5 mr-1" />
                    Reschedule
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="flex-1 text-xs text-destructive hover:bg-destructive/10"
                    onClick={handleCancel}
                    disabled={mutating}
                  >
                    <XCircle className="h-3.5 w-3.5 mr-1" />
                    Cancel
                  </Button>
                </div>
                {showReschedule && (
                  <div className="space-y-2 p-2 border rounded-md">
                    <Label htmlFor="new-start" className="text-xs">New start time</Label>
                    <Input
                      id="new-start"
                      type="datetime-local"
                      value={newStart}
                      onChange={(e) => setNewStart(e.target.value)}
                      className="h-8 text-xs"
                    />
                    <Button
                      size="sm"
                      className="w-full text-xs"
                      onClick={handleReschedule}
                      disabled={mutating || !newStart}
                    >
                      {mutating ? "Saving..." : "Save New Time"}
                    </Button>
                  </div>
                )}
                {mutateMsg && <p className="text-xs text-muted-foreground">{mutateMsg}</p>}
              </div>
            )}

            {!brief ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => handleGenerateBrief()}
                  disabled={isPending}
                >
                  <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                  {isPending ? "Generating Brief..." : "Generate AI Brief"}
                </Button>
                {error && <p className="text-xs text-destructive">{error}</p>}
              </>
            ) : (
              <>
                {/* Executive Summary */}
                <div className="p-3 bg-primary/5 rounded-lg">
                  <h5 className="text-xs font-medium text-foreground mb-1">Executive Summary</h5>
                  <p className="text-xs text-muted-foreground">{brief.executiveSummary}</p>
                </div>

                {/* Client Profile */}
                {brief.clientProfile && (
                  <div className="space-y-2">
                    <h5 className="text-xs font-medium text-foreground flex items-center gap-1">
                      <User className="h-3 w-3" />
                      Client Profile
                    </h5>
                    <div className="pl-4 space-y-1 text-xs text-muted-foreground">
                      <p><strong>Name:</strong> {brief.clientProfile.name}</p>
                      <p><strong>Relationship:</strong> {brief.clientProfile.relationship}</p>
                      <p><strong>Style:</strong> {brief.clientProfile.communicationStyle}</p>
                      {brief.clientProfile.hotButtons.length > 0 && (
                        <div>
                          <strong>Hot Buttons:</strong>
                          <ul className="list-disc pl-4 mt-0.5">
                            {brief.clientProfile.hotButtons.map((h, i) => (
                              <li key={i}>{h}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Objectives */}
                {brief.meetingObjectives.length > 0 && (
                  <div className="space-y-2">
                    <h5 className="text-xs font-medium text-foreground flex items-center gap-1">
                      <Target className="h-3 w-3" />
                      Objectives
                    </h5>
                    <div className="space-y-1">
                      {brief.meetingObjectives.map((obj, i) => (
                        <div key={i} className="flex items-start gap-2">
                          <Badge
                            variant={obj.importance === "primary" ? "default" : "secondary"}
                            className="text-[10px] px-1 py-0"
                          >
                            {obj.importance}
                          </Badge>
                          <span className="text-xs text-muted-foreground">{obj.objective}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Talking Points */}
                {brief.talkingPoints.length > 0 && (
                  <div className="space-y-2">
                    <h5 className="text-xs font-medium text-foreground flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" />
                      Talking Points
                    </h5>
                    {brief.talkingPoints.slice(0, 2).map((tp, i) => (
                      <div key={i} className="pl-4 space-y-1">
                        <p className="text-xs font-medium text-foreground">{tp.topic}</p>
                        <ul className="list-disc pl-4 text-xs text-muted-foreground">
                          {tp.keyPoints.slice(0, 2).map((p, j) => (
                            <li key={j}>{p}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                )}

                {/* Potential Objections */}
                {brief.potentialObjections.length > 0 && (
                  <div className="space-y-2">
                    <h5 className="text-xs font-medium text-foreground flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      Potential Objections
                    </h5>
                    {brief.potentialObjections.slice(0, 2).map((obj, i) => (
                      <div key={i} className="p-2 bg-muted/50 rounded text-xs">
                        <p className="text-destructive font-medium">{obj.objection}</p>
                        <p className="text-muted-foreground mt-0.5">{obj.response}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Materials */}
                {brief.materialsNeeded.length > 0 && (
                  <div className="space-y-2">
                    <h5 className="text-xs font-medium text-foreground flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" />
                      Materials Needed
                    </h5>
                    <ul className="pl-4 list-disc text-xs text-muted-foreground">
                      {brief.materialsNeeded.map((m, i) => (
                        <li key={i}>{m}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full text-xs"
                  onClick={() => handleGenerateBrief(true)}
                  disabled={isPending}
                >
                  {isPending ? "Regenerating..." : "Regenerate Brief"}
                </Button>
              </>
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
