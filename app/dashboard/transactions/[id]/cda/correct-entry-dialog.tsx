"use client"

// WAVE 98 — the "Correct entry" dialog (owner: "yes build commission correction screen"). A POSTED
// commission entry is append-only (m689); this writes a reversal / adjustment ROW through
// app/actions/financial-kernel.ts correctCommissionDistributionAction (finance-admin gate, session
// tenant). The preview runs the SAME pure planner the server uses
// (lib/commission/distribution-correction.ts), so the figure shown is the figure written.

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { correctCommissionDistributionAction } from "@/app/actions/financial-kernel"
import {
  planDistributionCorrection,
  MIN_CORRECTION_REASON_LENGTH,
  type DistributionCorrectionKind,
} from "@/lib/commission/distribution-correction"

const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)

export function CorrectEntryDialog({
  entry,
  priorCorrections,
  open,
  onOpenChange,
  onCorrected,
}: {
  entry: { id: string; status: string; entry_type?: string | null; calculated_amount: number | null; distribution_type: string }
  priorCorrections: Array<{ calculated_amount: number | null }>
  open: boolean
  onOpenChange: (open: boolean) => void
  onCorrected: () => void
}) {
  const [kind, setKind] = useState<DistributionCorrectionKind>("adjustment")
  const [amount, setAmount] = useState("")
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const corrected = amount.trim() === "" ? null : Number(amount)
  const plan = planDistributionCorrection({ original: entry, priorCorrections, kind, correctedAmount: corrected, reason })

  const submit = () => {
    setError(null)
    startTransition(async () => {
      const res = await correctCommissionDistributionAction({ distributionId: entry.id, kind, correctedAmount: corrected, reason })
      if (!res.success) { setError(res.error ?? "Correction failed"); return }
      setAmount(""); setReason("")
      onOpenChange(false)
      onCorrected()
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Correct entry</DialogTitle>
          <DialogDescription>
            This {entry.distribution_type} entry is posted and cannot be edited. The correction is recorded as a new
            {kind === "reversal" ? " reversal" : " adjustment"} row linked to it, with your reason.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2">
            <Button type="button" size="sm" variant={kind === "adjustment" ? "default" : "outline"} onClick={() => setKind("adjustment")}>Adjust amount</Button>
            <Button type="button" size="sm" variant={kind === "reversal" ? "default" : "outline"} onClick={() => setKind("reversal")}>Reverse entry</Button>
          </div>
          {kind === "adjustment" && (
            <div className="space-y-1">
              <Label htmlFor="corrected-amount">Corrected amount</Label>
              <Input id="corrected-amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="correction-reason">Reason (required)</Label>
            <Textarea id="correction-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={`At least ${MIN_CORRECTION_REASON_LENGTH} characters`} />
          </div>
          {plan.ok ? (
            <p className="text-sm text-muted-foreground">
              Current net {usd(plan.netBefore)} → correction row {usd(plan.amount)} → new net {usd(plan.netAfter)}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{plan.error}</p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button onClick={submit} disabled={!plan.ok || pending}>{pending ? "Recording…" : "Record correction"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
