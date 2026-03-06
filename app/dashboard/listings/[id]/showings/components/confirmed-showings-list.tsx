"use client"

import { useState, useTransition } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { CheckCheck, RotateCcw, XCircle, Mail, Phone, Clock } from "lucide-react"
import {
  markShowingCompleted,
  showingTimeConfirm,
  showingTimeReschedule,
  showingTimeDecline,
} from "@/app/actions/seller-showings"

const STATUS_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  scheduled:   { label: "Scheduled",  variant: "secondary" },
  confirmed:   { label: "Confirmed",  variant: "default" },
  completed:   { label: "Completed",  variant: "outline" },
  cancelled:   { label: "Cancelled",  variant: "destructive" },
  rescheduled: { label: "Rescheduled",variant: "secondary" },
  "no-show":   { label: "No Show",    variant: "destructive" },
}

interface Props {
  showings: any[]
  listing: { id: string; address: string }
  brokerageId: string
  agentUserId: string
  mode: { mode: "showingtime" | "manual"; credentialId?: string }
  onUpdate: (showings: any[]) => void
}

export default function ConfirmedShowingsList({ showings, listing, brokerageId, agentUserId, mode, onUpdate }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<"complete" | "reschedule" | "decline" | null>(null)
  const [declineReason, setDeclineReason] = useState("")
  const [proposedTime, setProposedTime] = useState("")
  const [rescheduleReason, setRescheduleReason] = useState("")
  const [isPending, startTransition] = useTransition()

  function open(id: string, d: "complete" | "reschedule" | "decline") {
    setActiveId(id)
    setDialog(d)
    setDeclineReason("")
    setProposedTime("")
    setRescheduleReason("")
  }

  function close() { setDialog(null); setActiveId(null) }

  function updateShowing(id: string, patch: any) {
    onUpdate(showings.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  function handleComplete() {
    if (!activeId) return
    startTransition(async () => {
      const res = await markShowingCompleted({
        showingId:   activeId,
        listingId:   listing.id,
        brokerageId,
        agentUserId,
      })
      if (res.success) { updateShowing(activeId, { status: "completed" }); close() }
    })
  }

  function handleSTConfirm(showingId: string) {
    if (!mode.credentialId) return
    startTransition(async () => {
      await showingTimeConfirm({ showingId, credentialId: mode.credentialId! })
      updateShowing(showingId, { status: "confirmed" })
    })
  }

  function handleReschedule() {
    if (!activeId || !proposedTime || !mode.credentialId) return
    startTransition(async () => {
      await showingTimeReschedule({
        showingId:     activeId,
        credentialId:  mode.credentialId!,
        proposedTimes: [proposedTime],
        reason:        rescheduleReason,
      })
      updateShowing(activeId, { status: "rescheduled" })
      close()
    })
  }

  function handleDecline() {
    if (!activeId || !declineReason.trim() || !mode.credentialId) return
    startTransition(async () => {
      await showingTimeDecline({
        showingId:    activeId,
        credentialId: mode.credentialId!,
        reason:       declineReason,
      })
      updateShowing(activeId, { status: "cancelled" })
      close()
    })
  }

  if (showings.length === 0) {
    return (
      <div className="px-6 py-8 text-center text-sm text-muted-foreground">
        No showings recorded yet.
      </div>
    )
  }

  return (
    <>
      <ul className="divide-y divide-border">
        {showings.map((s) => {
          const badge = STATUS_BADGE[s.status] ?? { label: s.status, variant: "secondary" as const }
          const displayTime = s.scheduled_at
            ? new Date(s.scheduled_at).toLocaleString("en-US", {
                month: "short", day: "numeric", year: "numeric",
                hour: "numeric", minute: "2-digit",
              })
            : s.scheduled_date
              ? `${s.scheduled_date}${s.scheduled_time ? ` ${s.scheduled_time}` : ""}`
              : "—"

          return (
            <li key={s.id} className="flex flex-col gap-2 px-6 py-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-col gap-0.5">
                  <span className="font-medium text-foreground">
                    {s.buyer_agent_name ?? "Unknown Agent"}
                  </span>
                  <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                    {s.buyer_agent_email && (
                      <span className="flex items-center gap-1">
                        <Mail className="h-3 w-3" />{s.buyer_agent_email}
                      </span>
                    )}
                    {s.buyer_agent_phone && (
                      <span className="flex items-center gap-1">
                        <Phone className="h-3 w-3" />{s.buyer_agent_phone}
                      </span>
                    )}
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />{displayTime}
                    </span>
                  </div>
                </div>
                <Badge variant={badge.variant}>{badge.label}</Badge>
              </div>

              {/* Feedback snippet if present */}
              {s.showing_feedback?.[0]?.ai_summary && (
                <p className="rounded bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {s.showing_feedback[0].ai_summary}
                </p>
              )}

              {/* Actions */}
              <div className="flex flex-wrap gap-2">
                {/* Manual mode */}
                {mode.mode === "manual" && s.status !== "completed" && s.status !== "cancelled" && (
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => open(s.id, "complete")}>
                    <CheckCheck className="h-3.5 w-3.5" />
                    Mark Completed
                  </Button>
                )}

                {/* ShowingTime mode */}
                {mode.mode === "showingtime" && (
                  <>
                    {s.status === "scheduled" && (
                      <Button size="sm" onClick={() => handleSTConfirm(s.id)} disabled={isPending}>
                        Confirm
                      </Button>
                    )}
                    {s.status !== "completed" && s.status !== "cancelled" && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => open(s.id, "reschedule")}>
                          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                          Reschedule
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:bg-destructive/10"
                          onClick={() => open(s.id, "decline")}
                        >
                          <XCircle className="mr-1.5 h-3.5 w-3.5" />
                          Decline
                        </Button>
                      </>
                    )}
                  </>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {/* Mark Complete modal */}
      <Dialog open={dialog === "complete"} onOpenChange={close}>
        <DialogContent>
          <DialogHeader><DialogTitle>Mark Showing Completed</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will mark the showing as completed and send a tokenized feedback link to the buyer's agent.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={isPending}>Cancel</Button>
            <Button onClick={handleComplete} disabled={isPending}>
              {isPending ? "Saving..." : "Confirm Completion"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reschedule modal (ST) */}
      <Dialog open={dialog === "reschedule"} onOpenChange={close}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reschedule Showing</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label>Proposed Time</Label>
              <Input type="datetime-local" value={proposedTime} onChange={(e) => setProposedTime(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label>Reason (optional)</Label>
              <Textarea value={rescheduleReason} onChange={(e) => setRescheduleReason(e.target.value)} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={isPending}>Cancel</Button>
            <Button onClick={handleReschedule} disabled={isPending || !proposedTime}>
              {isPending ? "Sending..." : "Send Reschedule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Decline modal (ST) */}
      <Dialog open={dialog === "decline"} onOpenChange={close}>
        <DialogContent>
          <DialogHeader><DialogTitle>Decline Showing</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-1">
            <Label>Reason (required)</Label>
            <Textarea value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} rows={3} placeholder="Reason is required by ShowingTime." />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={isPending}>Cancel</Button>
            <Button variant="destructive" onClick={handleDecline} disabled={isPending || !declineReason.trim()}>
              {isPending ? "Declining..." : "Decline Showing"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
