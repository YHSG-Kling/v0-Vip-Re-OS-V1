"use client"

import { AlertCircle } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"

interface PendingApprovalsProps {
  approvals: Array<{
    id: string
    title: string
    description: string
    dueDate?: string
    actionUrl?: string
  }>
}

export function PendingApprovals({ approvals }: PendingApprovalsProps) {
  if (approvals.length === 0) {
    return (
      <Card className="p-6">
        <h2 className="text-lg font-semibold mb-4">Pending Approvals</h2>
        <p className="text-sm text-muted-foreground">No pending approvals at this time.</p>
      </Card>
    )
  }

  return (
    <Card className="p-6">
      <h2 className="text-lg font-semibold mb-4">Pending Approvals</h2>
      <div className="space-y-4">
        {approvals.map((approval) => (
          <div key={approval.id} className="border rounded-lg p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5" />
              <div className="flex-1">
                <h3 className="font-medium">{approval.title}</h3>
                <p className="text-sm text-muted-foreground mt-1">{approval.description}</p>
                {approval.dueDate && (
                  <p className="text-sm text-muted-foreground mt-2">
                    Due: {new Date(approval.dueDate).toLocaleDateString()}
                  </p>
                )}
                {approval.actionUrl && (
                  <Button size="sm" className="mt-3" asChild>
                    <a href={approval.actionUrl}>Review & Approve</a>
                  </Button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}
