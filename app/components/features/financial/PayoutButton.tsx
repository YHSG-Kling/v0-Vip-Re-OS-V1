// app/components/features/financial/PayoutButton.tsx
"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Send } from "lucide-react"
import { markCommissionPaidAction } from "@/app/actions/financial-kernel"

interface PayoutButtonProps {
  commissionId: string
  brokerageId: string
  /** optional by design: no current caller needs a non-ACH payout method — the
   *  component's own "ach" default is what markCommissionPaidAction records; a
   *  future wire/check payout surface can override it without a component change. */
  method?: string
  /** optional by design: router.refresh() below is the real UI-update mechanism
   *  for every current caller; this is an extra hook for a future caller that
   *  needs to react to the payout beyond a route refresh. */
  onPaid?: () => void
}

export function PayoutButton({ commissionId, brokerageId, method = "ach", onPaid }: PayoutButtonProps) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  // WAVE 154 (lane 154K, ledger 143C-OL-04): the funds gate refuses `funds_not_received` and asks for a reason to pay
  // ahead of the funds — this button had nowhere to state it. The field appears once that refusal is seen; the server
  // (lib/commission/ledger-sync.ts payoutFundsGate) keeps the minimum and records the reason as evidence.
  const [advanceReason, setAdvanceReason] = useState("")
  const [fundsRefused, setFundsRefused] = useState(false)
  const router = useRouter()

  const handlePayout = () => {
    setError(null)
    startTransition(async () => {
      const result = await markCommissionPaidAction({
        commissionId,
        brokerageId,
        paidAt: new Date().toISOString(),
        method,
        advanceReason: advanceReason.trim() || null,
      })
      if (result.success) {
        onPaid?.()
        router.refresh()
      } else {
        // The kernel refuses pending → paid (a commission must be APPROVED first) and
        // refuses a non-broker actor. Both used to land here and do nothing at all:
        // the broker clicked "Mark as Paid", the button reset, and the agent stayed
        // unpaid with no explanation anywhere.
        const message = ("error" in result && result.error) || "Payout failed"
        if (message.startsWith("funds_not_received")) setFundsRefused(true)
        setError(message)
      }
    })
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <Button onClick={handlePayout} disabled={isPending} variant="outline" size="sm" className="bg-transparent">
        <Send className="h-4 w-4 mr-2" />
        {isPending ? "Processing..." : "Mark as Paid"}
      </Button>
      {fundsRefused && (
        <textarea className="w-full max-w-[180px] border rounded px-1 py-0.5 text-[11px]" rows={2} placeholder="Pay ahead of the funds — reason (kept on the record)" value={advanceReason} onChange={(e) => setAdvanceReason(e.target.value)} />
      )}
      {error && <span className="text-[11px] text-destructive max-w-[180px]">{error}</span>}
    </div>
  )
}
