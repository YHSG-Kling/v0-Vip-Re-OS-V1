"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { FileSearch, User, Clock, ExternalLink, Shield } from "lucide-react"

interface AuditEntry {
  id: string
  action: string
  entityType: string
  entityId: string
  userId: string
  userName?: string
  createdAt: string
}

interface AuditOperationsPanelProps {
  recentAudits: AuditEntry[]
  totalToday: number
  sensitiveActions: number
}

export function AuditOperationsPanel({ recentAudits, totalToday, sensitiveActions }: AuditOperationsPanelProps) {
  const getActionColor = (action: string) => {
    if (action.includes("delete") || action.includes("remove")) return "text-red-600"
    if (action.includes("create") || action.includes("add")) return "text-green-600"
    if (action.includes("update") || action.includes("modify")) return "text-blue-600"
    return "text-muted-foreground"
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <FileSearch className="h-5 w-5" />
            Audit Operations
          </CardTitle>
          <Link href="/admin/audit-trail">
            <Button variant="ghost" size="sm" className="gap-1">
              <ExternalLink className="h-3 w-3" />
              Full Trail
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary */}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 bg-muted/50 rounded-lg">
            <p className="text-2xl font-bold">{totalToday}</p>
            <p className="text-xs text-muted-foreground">Actions Today</p>
          </div>
          <div className="p-3 bg-yellow-500/10 rounded-lg">
            <div className="flex items-center gap-1">
              <Shield className="h-4 w-4 text-yellow-600" />
              <p className="text-2xl font-bold text-yellow-600">{sensitiveActions}</p>
            </div>
            <p className="text-xs text-muted-foreground">Sensitive Actions</p>
          </div>
        </div>

        {/* Recent Audit Entries */}
        <div className="space-y-2">
          <p className="text-sm font-medium">Recent Activity</p>
          {recentAudits.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No recent audit entries</p>
          ) : (
            recentAudits.slice(0, 5).map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between p-2 bg-muted/50 rounded-lg text-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <User className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <div className="min-w-0">
                    <span className={`font-medium ${getActionColor(entry.action)}`}>{entry.action}</span>
                    <span className="text-muted-foreground"> on </span>
                    <span className="font-medium">{entry.entityType}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Clock className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">
                    {new Date(entry.createdAt).toLocaleTimeString()}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Quick Actions */}
        <div className="flex gap-2">
          <Link href="/admin/audit-trail?filter=sensitive" className="flex-1">
            <Button variant="outline" size="sm" className="w-full">
              View Sensitive
            </Button>
          </Link>
          <Link href="/admin/audit-trail?filter=today" className="flex-1">
            <Button variant="outline" size="sm" className="w-full">
              Today&apos;s Log
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
