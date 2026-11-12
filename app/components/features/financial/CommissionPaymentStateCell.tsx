"use client"

// app/components/features/financial/CommissionPaymentStateCell.tsx — THE DERIVED PAYMENT STATE AND ITS
// TWO HUMAN DOORS (wave 142, lane 142C). Owner: "payment_initiated · payment_recorded ·
// payment_received/verified · reconciled/settled. Manual agent receipt confirmation = attestation
// (amount, date, payer, method, evidence). QuickBooks match only against the ACTUAL connected
// integration." The state is derived server-side (lib/commission/ledger-sync.ts
// deriveCommissionPaymentState, rides on app/actions/agents.ts getAgentCommissions); the doors are
// app/actions/financial-kernel.ts attestCommissionReceivedAction (the agent who owns the row, or a finance
// admin on their behalf) and reconcileCommissionPaymentAction (finance admins). Every refusal is shown.

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { attestCommissionReceivedAction, initiateCommissionPayoutAction, reconcileCommissionPaymentAction } from "@/app/actions/financial-kernel"
import { Button } from "@/components/ui/button"

export function CommissionPaymentStateCell(props: {
  commissionId: string
  state: string
  label: string
  held: boolean
  /** finance admin, status approved, not yet initiated — the brokerage issues the payout instruction (check / direct deposit). */
  canInitiate: boolean
  /** status paid and no attestation yet — the agent (or finance) may attest the receipt. */
  canAttest: boolean
  /** finance admin, status paid, not reconciled yet. */
  canReconcile: boolean
  /** The ledger's net to the agent — the amount the attestation is compared with (shown, never prefilled as "received"). */
  ledgerNet: number | null
  /** The row carries a confirmed QuickBooks export (quickbooks_synced_at) — the integration match is available. */
  quickbooksSynced: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState<"initiate" | "attest" | "reconcile" | null>(null)
  const [payoutMethod, setPayoutMethod] = useState<"check" | "direct_deposit">("direct_deposit")
  const [error, setError] = useState<string | null>(null)
  const [amount, setAmount] = useState("")
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 10))
  const [payer, setPayer] = useState("")
  const [method, setMethod] = useState<"check" | "direct_deposit" | "wire" | "other">("direct_deposit")
  const [reference, setReference] = useState("")
  const [via, setVia] = useState<"quickbooks" | "manual">(props.quickbooksSynced ? "quickbooks" : "manual")

  function submitInitiate() {
    setError(null)
    startTransition(async () => {
      const res = await initiateCommissionPayoutAction({ commissionId: props.commissionId, method: payoutMethod, reference: reference || null })
      if (!res.success) { setError(res.error ?? "The payout initiation was refused."); return }
      setOpen(null)
      router.refresh()
    })
  }

  function submitAttest() {
    setError(null)
    startTransition(async () => {
      const res = await attestCommissionReceivedAction({
        commissionId: props.commissionId,
        attestation: { amount: Number(amount), receivedAt, payer, method, reference: reference || null },
      })
      if (!res.success) { setError(res.error ?? "The attestation was refused."); return }
      setOpen(null)
      router.refresh()
    })
  }

  function submitReconcile() {
    setError(null)
    startTransition(async () => {
      const res = await reconcileCommissionPaymentAction({ commissionId: props.commissionId, via, reference: reference || null })
      if (!res.success) { setError(res.error ?? "The reconciliation was refused."); return }
      setOpen(null)
      router.refresh()
    })
  }

  return (
    <div className="mt-1 text-xs text-muted-foreground space-y-1">
      <div>{props.label}{props.held ? " · held (disputed)" : ""}</div>
      {open === null && (props.canInitiate || props.canAttest || props.canReconcile) && (
        <div className="flex gap-2 justify-center">
          {props.canInitiate && <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => setOpen("initiate")}>Initiate payout</Button>}
          {props.canAttest && <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => setOpen("attest")}>Confirm receipt</Button>}
          {props.canReconcile && <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => setOpen("reconcile")}>Reconcile</Button>}
        </div>
      )}
      {open === "initiate" && (
        <div className="text-left space-y-1 border rounded p-2">
          <div>The brokerage issues the payout instruction:</div>
          <select className="w-full border rounded px-1 py-0.5" value={payoutMethod} onChange={(e) => setPayoutMethod(e.target.value as typeof payoutMethod)}>
            <option value="direct_deposit">Direct deposit</option>
            <option value="check">Check</option>
          </select>
          <input className="w-full border rounded px-1 py-0.5" placeholder="Check # / batch reference (optional)" value={reference} onChange={(e) => setReference(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" className="h-6 px-2 text-xs" disabled={pending} onClick={submitInitiate}>Record initiation</Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={pending} onClick={() => setOpen(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {open === "attest" && (
        <div className="text-left space-y-1 border rounded p-2">
          <div>Attest what arrived{props.ledgerNet != null ? ` (ledger net $${props.ledgerNet.toLocaleString("en-US")})` : ""}:</div>
          <input className="w-full border rounded px-1 py-0.5" placeholder="Amount received" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input className="w-full border rounded px-1 py-0.5" type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
          <input className="w-full border rounded px-1 py-0.5" placeholder="Payer (brokerage / title)" value={payer} onChange={(e) => setPayer(e.target.value)} />
          <select className="w-full border rounded px-1 py-0.5" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
            <option value="direct_deposit">Direct deposit</option>
            <option value="check">Check</option>
            <option value="wire">Wire</option>
            <option value="other">Other</option>
          </select>
          <input className="w-full border rounded px-1 py-0.5" placeholder="Check # / reference (optional)" value={reference} onChange={(e) => setReference(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" className="h-6 px-2 text-xs" disabled={pending} onClick={submitAttest}>Record attestation</Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={pending} onClick={() => setOpen(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {open === "reconcile" && (
        <div className="text-left space-y-1 border rounded p-2">
          <select className="w-full border rounded px-1 py-0.5" value={via} onChange={(e) => setVia(e.target.value as typeof via)}>
            <option value="quickbooks" disabled={!props.quickbooksSynced}>QuickBooks export{props.quickbooksSynced ? "" : " (not synced)"}</option>
            <option value="manual">Bank / statement reference</option>
          </select>
          <input className="w-full border rounded px-1 py-0.5" placeholder={via === "manual" ? "Statement / bank reference" : "Export reference (optional)"} value={reference} onChange={(e) => setReference(e.target.value)} />
          <div className="flex gap-2">
            <Button size="sm" className="h-6 px-2 text-xs" disabled={pending} onClick={submitReconcile}>Mark reconciled</Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={pending} onClick={() => setOpen(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {error && <div className="text-destructive text-left">{error}</div>}
    </div>
  )
}
