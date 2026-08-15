"use client"

import { useState, useTransition } from "react"
import { CheckCircle2, XCircle, Clock } from "lucide-react"
import { Button } from "@/app/components/ui/button"
import { Card } from "@/app/components/ui/card"
import { Textarea } from "@/app/components/ui/textarea"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/app/components/ui/dialog"
import { toast } from "sonner"
import { approveTwin, rejectTwin, type Twin } from "@/app/actions/twin-studio"

interface Props {
  twins: Twin[]
}

export function ApprovalQueue({ twins }: Props) {
  if (twins.length === 0) {
    return (
      <div className="rounded-lg border border-dashed py-12 px-6 text-center bg-muted/20">
        <CheckCircle2 className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
        <p className="text-sm font-medium">All caught up</p>
        <p className="text-xs text-muted-foreground mt-1">
          No twins awaiting review. New twins from your agents will appear here.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {twins.map((twin) => (
        <ApprovalRow key={twin.id} twin={twin} />
      ))}
    </div>
  )
}

function ApprovalRow({ twin }: { twin: Twin }) {
  const [pending, startTransition] = useTransition()
  const [rejectOpen, setRejectOpen] = useState(false)
  const [reason, setReason] = useState("")

  function handleApprove() {
    startTransition(async () => {
      const res = await approveTwin(twin.id)
      if (res.ok) toast.success("Twin approved")
      else toast.error(res.error ?? "Couldn't approve")
    })
  }

  function handleReject() {
    if (!reason.trim()) {
      toast.error("Please give a reason")
      return
    }
    startTransition(async () => {
      const res = await rejectTwin({ twinId: twin.id, reason })
      if (res.ok) {
        toast.success("Twin rejected")
        setRejectOpen(false)
      } else {
        toast.error(res.error ?? "Couldn't reject")
      }
    })
  }

  return (
    <Card className="p-3 flex gap-3">
      {/* Preview */}
      <div className="w-20 h-20 rounded bg-muted overflow-hidden shrink-0">
        {twin.sourceType === "video" ? (
          <video src={twin.sourceUrl} muted className="w-full h-full object-cover" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={twin.sourceUrl} alt="" className="w-full h-full object-cover" />
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium text-sm truncate">{twin.label}</p>
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {new Date(twin.createdAt).toLocaleDateString()}
          </span>
        </div>
        {twin.personality && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{twin.personality}</p>
        )}
        <div className="flex items-center gap-1.5 mt-1.5 text-xs">
          <span className="text-muted-foreground">
            {twin.sourceType} • {twin.voiceId ? "Voice cloned" : "No voice yet"} • Status: {twin.status}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-1.5 shrink-0">
        <Button size="sm" onClick={handleApprove} disabled={pending} className="gap-1">
          <CheckCircle2 className="h-4 w-4" /> Approve
        </Button>
        <Button
          size="sm" variant="outline"
          onClick={() => setRejectOpen(true)}
          disabled={pending}
          className="gap-1 text-destructive hover:text-destructive"
        >
          <XCircle className="h-4 w-4" /> Reject
        </Button>
      </div>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject "{twin.label}"</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Tell the agent why so they know what to fix.
            </p>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Photo doesn't match brokerage standards — please use a clearer headshot"
              rows={3}
              maxLength={500}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleReject} disabled={pending}>
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
