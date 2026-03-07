"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { CheckCircle2, Clock, XCircle, Phone, Mail, BadgeCheck } from "lucide-react"
import {
  approveShowingRequest,
  suggestAlternativeTime,
  denyShowingRequest,
} from "@/app/actions/seller-showings"

interface Props {
  requests: any[]
  listing: { id: string; address: string }
  brokerageId: string
  agentUserId: string
  onUpdate: (requests: any[]) => void
}

type ModalMode = "approve" | "suggest" | "deny" | null

export default function ShowingRequestsPanel({
  requests,
  listing,
  brokerageId,
  agentUserId,
  onUpdate,
}: Props) {
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null)
  const [modalMode, setModalMode] = useState<ModalMode>(null)
  const [denyReason, setDenyReason] = useState("")
  const [suggestedDate, setSuggestedDate] = useState("")
  const [suggestedStart, setSuggestedStart] = useState("")
  const [suggestedEnd, setSuggestedEnd] = useState("")
  const [isPending, startTransition] = useTransition()

  if (requests.length === 0) {
    return (
      <div className="px-6 py-8 text-center text-sm text-muted-foreground">
        No pending showing requests.
      </div>
    )
  }

  function openModal(requestId: string, mode: ModalMode) {
    setActiveRequestId(requestId)
    setModalMode(mode)
    setDenyReason("")
    setSuggestedDate("")
    setSuggestedStart("")
    setSuggestedEnd("")
  }

  function closeModal() {
    setModalMode(null)
    setActiveRequestId(null)
  }

  function removeRequest(requestId: string) {
    onUpdate(requests.filter((r) => r.id !== requestId))
  }

  function handleApprove() {
    if (!activeRequestId) return
    startTransition(async () => {
      const res = await approveShowingRequest({
        requestId:   activeRequestId,
        listingId:   listing.id,
        brokerageId,
        agentUserId,
      })
      if (res.success) {
        removeRequest(activeRequestId)
        closeModal()
      }
    })
  }

  function handleSuggest() {
    if (!activeRequestId || !suggestedDate || !suggestedStart || !suggestedEnd) return
    startTransition(async () => {
      const res = await suggestAlternativeTime({
        requestId: activeRequestId,
        listingId: listing.id,
        proposedTimes: [{ date: suggestedDate, start_time: suggestedStart, end_time: suggestedEnd }],
      })
      if (res.success) closeModal()
    })
  }

  function handleDeny() {
    if (!activeRequestId) return
    startTransition(async () => {
      const res = await denyShowingRequest({
        requestId: activeRequestId,
        listingId: listing.id,
        reason: denyReason || undefined,
      })
      if (res.success) {
        removeRequest(activeRequestId)
        closeModal()
      }
    })
  }

  return (
    <>
      <ul className="divide-y divide-border">
        {requests.map((req) => (
          <li key={req.id} className="flex flex-col gap-3 px-6 py-4">
            {/* Buyer agent info */}
            <div className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground">{req.buyer_agent_name ?? "Unknown Agent"}</span>
              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                {req.buyer_agent_email && (
                  <span className="flex items-center gap-1">
                    <Mail className="h-3 w-3" />
                    {req.buyer_agent_email}
                  </span>
                )}
                {req.buyer_agent_phone && (
                  <span className="flex items-center gap-1">
                    <Phone className="h-3 w-3" />
                    {req.buyer_agent_phone}
                  </span>
                )}
                {req.buyer_agent_license && (
                  <span className="flex items-center gap-1">
                    <BadgeCheck className="h-3 w-3" />
                    {req.buyer_agent_license}
                  </span>
                )}
              </div>
            </div>

            {/* Requested time */}
            <div className="flex items-center gap-1.5 text-sm text-foreground">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              {req.requested_date} &bull; {req.requested_start_time} &ndash; {req.requested_end_time}
            </div>

            {req.message && (
              <p className="text-xs text-muted-foreground">{req.message}</p>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => openModal(req.id, "approve")} className="gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Approve
              </Button>
              <Button size="sm" variant="outline" onClick={() => openModal(req.id, "suggest")}>
                Suggest Different Time
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:bg-destructive/10"
                onClick={() => openModal(req.id, "deny")}
              >
                <XCircle className="mr-1.5 h-3.5 w-3.5" />
                Deny
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {/* Approve modal */}
      <Dialog open={modalMode === "approve"} onOpenChange={closeModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Approval</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will approve the request and create a confirmed showing. A confirmation email will be sent to the buyer's agent.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={closeModal} disabled={isPending}>Cancel</Button>
            <Button onClick={handleApprove} disabled={isPending}>
              {isPending ? "Approving..." : "Approve Showing"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Suggest time modal */}
      <Dialog open={modalMode === "suggest"} onOpenChange={closeModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Suggest Different Time</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label>Date</Label>
              <Input type="date" value={suggestedDate} onChange={(e) => setSuggestedDate(e.target.value)} />
            </div>
            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1">
                <Label>Start Time</Label>
                <Input type="time" value={suggestedStart} onChange={(e) => setSuggestedStart(e.target.value)} />
              </div>
              <div className="flex flex-1 flex-col gap-1">
                <Label>End Time</Label>
                <Input type="time" value={suggestedEnd} onChange={(e) => setSuggestedEnd(e.target.value)} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeModal} disabled={isPending}>Cancel</Button>
            <Button onClick={handleSuggest} disabled={isPending || !suggestedDate || !suggestedStart}>
              {isPending ? "Sending..." : "Send Suggestion"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deny modal */}
      <Dialog open={modalMode === "deny"} onOpenChange={closeModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deny Request</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Label>Reason (optional)</Label>
            <Textarea
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              placeholder="Provide a reason for the buyer's agent..."
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeModal} disabled={isPending}>Cancel</Button>
            <Button variant="destructive" onClick={handleDeny} disabled={isPending}>
              {isPending ? "Denying..." : "Deny Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
