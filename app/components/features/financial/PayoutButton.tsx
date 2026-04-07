// app/components/features/financial/PayoutButton.tsx
"use client"

import { useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Send } from "lucide-react"
import { markCommissionPaidAction } from "@/app/actions/financial-kernel"

interface PayoutButtonProps {
  commissionId: string
  method?: string
  onPaid?: () => void
}

export function PayoutButton({ commissionId, method = "ach", onPaid }: PayoutButtonProps) {
  const [isPending, startTransition] = useTransition()

  const handlePayout = () => {
    startTransition(async () => {
      const result = await markCommissionPaidAction({
        commissionId,
        brokerageId: "",
        paidAt: new Date().toISOString(),
        method,
      })
      if (result.success) {
        onPaid?.()
      }
    })
  }

  return (
    <Button onClick={handlePayout} disabled={isPending} variant="outline" className="bg-transparent">
      <Send className="h-4 w-4 mr-2" />
      {isPending ? "Processing..." : "Mark as Paid"}
    </Button>
  )
}
