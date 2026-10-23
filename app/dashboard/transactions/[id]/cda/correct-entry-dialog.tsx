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
import { correctCommissionDistributionAction, voidCommissionDistributionAction, approveResidualEntryAction } from "@/app/actions/financial-kernel"
import {
  isResidualAwaitingReview,
  planDistributionCorrection,
  planDistributionVoid,
  MIN_CORRECTION_REASON_LENGTH,
  MAX_VOID_REASON_LENGTH,
  VOID_REFUSED_PAID,
  type DistributionCorrectionKind,
  type VoidableEntry,
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

// ─── VOID (wave 105, lane 105E — owner ruling 1) ─────────────────────────────────────────────────
// The "Void entry" dialog for an UNPAID entry (pending | approved, never posted, not already voided,
// no posted correction). Writes through app/actions/financial-kernel.ts voidCommissionDistributionAction
// (finance-admin gate, session tenant). The eligibility shown is the SAME pure rule the server applies
// (lib/commission/distribution-correction.ts planDistributionVoid): a paid row never reaches this
// dialog — the breakdown shows "Correct via reversal/adjustment" on it instead (VOID_REFUSED_PAID).

/** The breakdown's own gate for showing the Void control: the pure planner with a placeholder reason,
 *  so a row is eligible here exactly when the server would admit it (reason aside). */
export function isVoidEligibleEntry(entry: VoidableEntry, corrections: ReadonlyArray<{ status?: string | null; paid_at?: string | null }>): boolean {
  return planDistributionVoid({ entry, corrections, reason: "eligibility probe" }).ok
}

/**
 * WAVE 107 (lane 107A) — the Finance Manager's review of a RESIDUAL ledger entry: "Approve residual" on a
 * residual still pending review (the SAME pure predicate the server applies — isResidualAwaitingReview). Only an
 * approved residual is paid by the deal's disbursement; rejecting it is the Void beside it.
 */
export function ApproveResidualButton({ entry, onApproved }: { entry: { id: string; distribution_type: string; status: string | null; entry_type?: string | null; paid_at?: string | null }; onApproved: () => void }) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  if (!isResidualAwaitingReview(entry)) return null
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="text-xs h-7"
        disabled={pending}
        onClick={() => startTransition(async () => {
          setError(null)
          const r = await approveResidualEntryAction({ distributionId: entry.id })
          if (r.success) onApproved()
          else setError(r.error ?? "Approval failed")
        })}
      >
        {pending ? "Approving…" : "Approve residual"}
      </Button>
      <span className="block text-[11px] text-muted-foreground">Held for finance review until approved</span>
      {error && <span className="block text-[11px] text-destructive">{error}</span>}
    </>
  )
}

export function VoidEntryDialog({
  entry,
  corrections,
  amount,
  open,
  onOpenChange,
  onVoided,
}: {
  entry: VoidableEntry & { distribution_type: string }
  corrections: ReadonlyArray<{ status?: string | null; paid_at?: string | null }>
  amount: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onVoided: () => void
}) {
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const plan = planDistributionVoid({ entry, corrections, reason })

  const submit = () => {
    setError(null)
    startTransition(async () => {
      const res = await voidCommissionDistributionAction({ distributionId: entry.id, reason })
      if (!res.success) { setError(res.error ?? "Void failed"); return }
      setReason("")
      onOpenChange(false)
      onVoided()
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Void entry</DialogTitle>
          <DialogDescription>
            This {entry.distribution_type} entry ({amount == null ? "—" : usd(amount)}, {entry.status ?? "unknown"}) has not been paid.
            Voiding keeps the row and its amount for the audit trail, stamps when and why it was voided, and drops it
            from every total. A paid entry is never voided — {VOID_REFUSED_PAID}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="void-reason">Reason (required)</Label>
            <Textarea
              id="void-reason"
              value={reason}
              maxLength={MAX_VOID_REASON_LENGTH}
              onChange={(e) => setReason(e.target.value)}
              placeholder={`Why this entry is void (up to ${MAX_VOID_REASON_LENGTH} characters)`}
            />
            <p className="text-xs text-muted-foreground">{reason.trim().length}/{MAX_VOID_REASON_LENGTH}</p>
          </div>
          {!plan.ok && <p className="text-sm text-muted-foreground">{plan.error}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={!plan.ok || pending}>{pending ? "Voiding…" : "Void entry"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
