"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ChevronDown, ChevronUp } from "lucide-react"
import { type CronExecutionLog } from "@/app/actions/system-health"

interface CronHistoryTableProps {
  logs: CronExecutionLog[]
}

export function CronHistoryTable({ logs }: CronHistoryTableProps) {
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const filteredLogs = logs.filter((log) =>
    statusFilter === "all" ? true : log.status === statusFilter
  )

  const getStatusBadge = (status: CronExecutionLog["status"]) => {
    switch (status) {
      case "completed":
        return <Badge className="bg-green-500/10 text-green-600">Completed</Badge>
      case "failed":
        return <Badge variant="destructive">Failed</Badge>
      case "timeout":
        return <Badge variant="secondary" className="bg-amber-500/10 text-amber-600">Timeout</Badge>
      case "started":
        return <Badge variant="outline" className="bg-blue-500/10 text-blue-600">In Progress</Badge>
      default:
        return <Badge variant="outline">{status}</Badge>
    }
  }

  const formatDuration = (ms: number | null) => {
    if (!ms) return "-"
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(2)}s`
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleString()
  }

  if (logs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-8">
        No cron executions recorded yet
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Filter status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="timeout">Timeout</SelectItem>
            <SelectItem value="started">In Progress</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">
          {filteredLogs.length} execution{filteredLogs.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b">
              <th className="text-left py-3 px-4 font-medium text-sm">Cron Name</th>
              <th className="text-left py-3 px-4 font-medium text-sm">Status</th>
              <th className="text-right py-3 px-4 font-medium text-sm">Duration</th>
              <th className="text-right py-3 px-4 font-medium text-sm">Records</th>
              <th className="text-right py-3 px-4 font-medium text-sm">Last Run</th>
              <th className="text-center py-3 px-4 font-medium text-sm w-10"></th>
            </tr>
          </thead>
          <tbody>
            {filteredLogs.map((log) => (
              <>
                <tr key={log.id} className="border-b last:border-0 hover:bg-muted/50">
                  <td className="py-3 px-4">
                    <div>
                      <p className="font-medium text-sm">{log.cron_name}</p>
                      <p className="text-xs text-muted-foreground">{log.cron_path}</p>
                    </div>
                  </td>
                  <td className="py-3 px-4">{getStatusBadge(log.status)}</td>
                  <td className="py-3 px-4 text-right text-sm">
                    {formatDuration(log.duration_ms)}
                  </td>
                  <td className="py-3 px-4 text-right text-sm">
                    {log.records_processed ?? "-"}
                  </td>
                  <td className="py-3 px-4 text-right text-sm text-muted-foreground">
                    {formatDate(log.started_at)}
                  </td>
                  <td className="py-3 px-4 text-center">
                    {(log.error_message || log.metadata) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setExpandedId(expandedId === log.id ? null : log.id)
                        }
                      >
                        {expandedId === log.id ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </Button>
                    )}
                  </td>
                </tr>
                {expandedId === log.id && (
                  <tr key={`${log.id}-expanded`}>
                    <td colSpan={6} className="px-4 pb-4">
                      <div className="rounded bg-muted p-4 space-y-2">
                        {log.error_message && (
                          <div>
                            <p className="text-xs font-medium text-destructive">Error Message:</p>
                            <p className="text-xs text-destructive/80 mt-1">
                              {log.error_message}
                            </p>
                          </div>
                        )}
                        {log.metadata && (
                          <div>
                            <p className="text-xs font-medium text-muted-foreground">Metadata:</p>
                            <pre className="text-xs mt-1 overflow-x-auto">
                              {JSON.stringify(log.metadata, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
