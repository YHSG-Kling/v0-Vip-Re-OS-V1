// app/components/features/financial/ApproveCommissionButton.tsx
"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { CheckCircle2 } from "lucide-react"
import { markCommissionApprovedAction } from "@/app/actions/financial-kernel"

interface ApproveCommissionButtonProps {
  commissionId: string
  brokerageId: string
  onApproved?: () => void
}

/**
 * THE MISSING MIDDLE OF THE PAYOUT LADDER.
 *
 * lib/kernel/financial.ts enforces one lifecycle: pending → approved → paid
 * (COMMISSION_STATUS_TRANSITIONS). markCommissionPaid VALIDATES that transition, so a
 * commission sitting at 'pending' can never be paid — the kernel returns
 * "Invalid status transition: pending → paid".
 *
 * markCommissionApprovedAction — the only step that moves pending → approved by hand —
 * had no caller anywhere in the app. The one code path that reached the underlying
 * kernel command was brokerSignCdaAction, i.e. a commission could only be approved as a
 * side effect of a broker signing a CDA. Every commission on a deal without a CDA
 * (and every one whose CDA auto-approval was best-effort and failed) had no route to
 * approved, and therefore no route to paid, from any surface.
 *
 * Broker/admin/superadmin gated inside the kernel command; it also mirrors onto
 * commission_splits and the transaction_commissions deal stamp and emits
 * COMMISSION_APPROVED.
 */
export function ApproveCommissionButton({ commissionId, brokerageId, onApproved }: ApproveCommissionButtonProps) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  const handleApprove = () => {
    setError(null)
    startTransition(async () => {
      const result = await markCommissionApprovedAction({ commissionId, brokerageId })
      if (result.success) {
        onApproved?.()
        router.refresh()
      } else {
        // Never swallow the failure: on this rail a silent no-op looks identical to
        // an approved commission that simply hasn't refreshed.
        setError(("error" in result && result.error) || "Approval failed")
      }
    })
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <Button onClick={handleApprove} disabled={isPending} variant="outline" size="sm" className="bg-transparent">
        <CheckCircle2 className="h-4 w-4 mr-2" />
        {isPending ? "Approving..." : "Approve"}
      </Button>
      {error && <span className="text-[11px] text-destructive max-w-[180px]">{error}</span>}
    </div>
  )
}
