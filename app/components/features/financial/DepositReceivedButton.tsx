// app/components/features/financial/DepositReceivedButton.tsx
"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Landmark } from "lucide-react"
import { recordCommissionDepositReceivedAction } from "@/app/actions/financial-kernel"

interface DepositReceivedButtonProps {
  transactionId: string
  onRecorded?: () => void
}

/**
 * The post-close, pre-disbursement money step: the brokerage RECEIVED the commission deposit at
 * closing. Close froze the amount; this stamps the deposit on the ledger; the payout button then
 * disburses the agent's split (the one lock to 'paid'). Broker-gated by the server action.
 */
export function DepositReceivedButton({ transactionId, onRecorded }: DepositReceivedButtonProps) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  const handleRecord = () => {
    startTransition(async () => {
      const result = await recordCommissionDepositReceivedAction({ transactionId })
      if (result.success) {
        onRecorded?.()
        router.refresh()
      }
    })
  }

  return (
    <Button onClick={handleRecord} disabled={isPending} variant="outline" size="sm" className="bg-transparent">
      <Landmark className="h-4 w-4 mr-2" />
      {isPending ? "Recording..." : "Deposit received"}
    </Button>
  )
}
