// app/components/features/financial/CommissionApprovalCard.tsx
"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, Clock, DollarSign } from "lucide-react"
import { markCommissionApprovedAction } from "@/app/actions/financial-kernel"
import type { CommissionRecord } from "@/lib/kernel"

interface CommissionApprovalCardProps {
  commission: CommissionRecord
  approvedBy: string
  onApproved?: () => void
}

export function CommissionApprovalCard({ commission, approvedBy, onApproved }: CommissionApprovalCardProps) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState("")

  const handleApprove = () => {
    setError("")
    startTransition(async () => {
      const result = await markCommissionApprovedAction({
        commissionId: commission.id,
        brokerageId: "", // Will be resolved by server action
        approvedBy,
      })
      if (!result.success) {
        setError(result.error ?? "Failed to approve commission")
        return
      }
      onApproved?.()
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">Commission for Approval</CardTitle>
            <CardDescription>Transaction {commission.transactionId}</CardDescription>
          </div>
          <Badge variant={commission.status === "calculated" ? "secondary" : "default"}>
            {commission.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Gross Commission</p>
            <p className="text-lg font-bold">${commission.grossCommission.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Agent Share</p>
            <p className="text-lg font-bold">${commission.agentCommission.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Brokerage Share</p>
            <p className="text-lg font-bold">${commission.brokerageCommission.toLocaleString()}</p>
          </div>
        </div>

        <div>
          <p className="text-sm text-muted-foreground">Close Date</p>
          <p>{new Date(commission.closeDate).toLocaleDateString()}</p>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {commission.status === "calculated" && (
          <Button onClick={handleApprove} disabled={isPending} className="w-full">
            <CheckCircle2 className="h-4 w-4 mr-2" />
            {isPending ? "Approving..." : "Approve Commission"}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
