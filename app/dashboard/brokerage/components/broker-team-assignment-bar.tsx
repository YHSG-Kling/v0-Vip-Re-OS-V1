"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ActionConfirmSheet } from "@/app/components/action-framework/action-confirm-sheet"
import { Users, ExternalLink } from "lucide-react"
import Link from "next/link"

interface Props {
  unassignedLeadsCount: number
  brokerageId: string
}

export function BrokerTeamAssignmentBar({ unassignedLeadsCount, brokerageId }: Props) {
  const [autoAssignOpen, setAutoAssignOpen] = useState(false)
  const [running, setRunning] = useState(false)

  // Auto-assignment is not yet implemented as a server action — the confirm
  // sheet navigates the broker to the assignment rules page where they can
  // configure and trigger it. This avoids a fake/mock action.
  async function handleAutoAssign() {
    setRunning(true)
    // Navigate to assignment-rules page where real trigger lives
    window.location.href = "/dashboard/admin/assignment-rules"
  }

  return (
    <>
      <Card className="border-border">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <Users className="h-4 w-4 text-blue-600" />
              Team Assignment
            </CardTitle>
            {unassignedLeadsCount > 0 ? (
              <Badge variant="destructive" className="text-xs">
                {unassignedLeadsCount} Unassigned
              </Badge>
            ) : (
              <Badge variant="outline" className="text-xs text-emerald-700 border-emerald-300">
                All Assigned
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-2">
          {unassignedLeadsCount > 0 && (
            <div className="p-2 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
              {unassignedLeadsCount} active lead{unassignedLeadsCount !== 1 ? "s" : ""} have no assigned agent.
            </div>
          )}

          <Link href="/dashboard/admin/assignment-rules">
            <Button variant="outline" size="sm" className="w-full justify-start">
              <ExternalLink className="h-4 w-4 mr-2" />
              Review Assignment Rules
            </Button>
          </Link>

          {unassignedLeadsCount > 0 && (
            <Button
              variant="default"
              size="sm"
              className="w-full justify-start"
              onClick={() => setAutoAssignOpen(true)}
            >
              <Users className="h-4 w-4 mr-2" />
              Run Auto-Assignment
            </Button>
          )}
        </CardContent>
      </Card>

      <ActionConfirmSheet
        open={autoAssignOpen}
        onOpenChange={setAutoAssignOpen}
        title="Run AI Auto-Assignment"
        description={`Run AI auto-assignment for ${unassignedLeadsCount} unassigned lead${unassignedLeadsCount !== 1 ? "s" : ""}? You will be taken to Assignment Rules to confirm and trigger the run.`}
        actionLabel="Go to Assignment Rules"
        confirmingLabel="Opening..."
        onConfirm={handleAutoAssign}
      />
    </>
  )
}
