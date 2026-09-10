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
  const router = useRouter()

  const handlePayout = () => {
    setError(null)
    startTransition(async () => {
      const result = await markCommissionPaidAction({
        commissionId,
        brokerageId,
        paidAt: new Date().toISOString(),
        method,
      })
      if (result.success) {
        onPaid?.()
        router.refresh()
      } else {
        // The kernel refuses pending → paid (a commission must be APPROVED first) and
        // refuses a non-broker actor. Both used to land here and do nothing at all:
        // the broker clicked "Mark as Paid", the button reset, and the agent stayed
        // unpaid with no explanation anywhere.
        setError(("error" in result && result.error) || "Payout failed")
      }
    })
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <Button onClick={handlePayout} disabled={isPending} variant="outline" size="sm" className="bg-transparent">
        <Send className="h-4 w-4 mr-2" />
        {isPending ? "Processing..." : "Mark as Paid"}
      </Button>
      {error && <span className="text-[11px] text-destructive max-w-[180px]">{error}</span>}
    </div>
  )
}
