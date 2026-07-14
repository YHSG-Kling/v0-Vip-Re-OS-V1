"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Users, ExternalLink } from "lucide-react"
import Link from "next/link"

interface Props {
  unassignedLeadsCount: number
  brokerageId: string
}

export function BrokerTeamAssignmentBar({ unassignedLeadsCount }: Props) {
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
            // Honest label (production audit): the real trigger lives on the
            // Assignment Rules page — this navigates, it does not execute.
            <Button variant="default" size="sm" className="w-full justify-start" asChild>
              <Link href="/dashboard/admin/assignment-rules">
                <Users className="h-4 w-4 mr-2" />
                Assign these leads →
              </Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </>
  )
}
