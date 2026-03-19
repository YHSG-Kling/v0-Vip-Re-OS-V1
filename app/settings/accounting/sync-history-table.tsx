"use client"

import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { getSyncErrors } from "@/app/actions/accounting-sync"
import { ChevronDown, ChevronRight, AlertCircle, CheckCircle2, Loader2, XCircle } from "lucide-react"

interface SyncLog {
  id: string
  provider: string
  sync_type: string
  status: string
  records_synced: number
  records_failed: number
  started_at: string
  completed_at: string | null
  error_summary: string | null
}

interface SyncHistoryTableProps {
  logs: SyncLog[]
  brokerageId: string
}

export function SyncHistoryTable({ logs, brokerageId }: SyncHistoryTableProps) {
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, any[]>>({})
  const [loadingErrors, setLoadingErrors] = useState<string | null>(null)

  const loadErrors = async (syncLogId: string) => {
    if (rowErrors[syncLogId]) {
      setExpandedRow(expandedRow === syncLogId ? null : syncLogId)
      return
    }

    setLoadingErrors(syncLogId)
    try {
      const result = await getSyncErrors({ brokerageId, syncLogId })
      setRowErrors((prev) => ({ ...prev, [syncLogId]: result.errors }))
      setExpandedRow(syncLogId)
    } catch (error) {
      console.error("Failed to load errors:", error)
    } finally {
      setLoadingErrors(null)
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return (
          <Badge className="bg-green-100 text-green-800 hover:bg-green-100">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Completed
          </Badge>
        )
      case "completed_with_errors":
        return (
          <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">
            <AlertCircle className="h-3 w-3 mr-1" />
            With Errors
          </Badge>
        )
      case "in_progress":
        return (
          <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            In Progress
          </Badge>
        )
      case "failed":
        return (
          <Badge variant="destructive">
            <XCircle className="h-3 w-3 mr-1" />
            Failed
          </Badge>
        )
      default:
        return <Badge variant="secondary">{status}</Badge>
    }
  }

  const getDuration = (startedAt: string, completedAt: string | null) => {
    if (!completedAt) return "—"
    const start = new Date(startedAt).getTime()
    const end = new Date(completedAt).getTime()
    const seconds = Math.round((end - start) / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    return `${minutes}m ${remainingSeconds}s`
  }

  if (logs.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">No sync history yet</p>
      </div>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8"></TableHead>
          <TableHead>Date</TableHead>
          <TableHead>Provider</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Synced</TableHead>
          <TableHead className="text-right">Failed</TableHead>
          <TableHead className="text-right">Duration</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {logs.map((log) => (
          <Collapsible key={log.id} asChild open={expandedRow === log.id}>
            <>
              <TableRow className="cursor-pointer hover:bg-muted/50">
                <TableCell>
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => loadErrors(log.id)}
                      disabled={loadingErrors === log.id}
                    >
                      {loadingErrors === log.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : expandedRow === log.id ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </Button>
                  </CollapsibleTrigger>
                </TableCell>
                <TableCell>
                  {new Date(log.started_at).toLocaleDateString()}{" "}
                  <span className="text-muted-foreground text-xs">
                    {new Date(log.started_at).toLocaleTimeString()}
                  </span>
                </TableCell>
                <TableCell className="capitalize">{log.provider}</TableCell>
                <TableCell className="capitalize">{log.sync_type}</TableCell>
                <TableCell>{getStatusBadge(log.status)}</TableCell>
                <TableCell className="text-right">{log.records_synced}</TableCell>
                <TableCell className="text-right">
                  {log.records_failed > 0 ? (
                    <span className="text-red-600 font-medium">{log.records_failed}</span>
                  ) : (
                    "0"
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {getDuration(log.started_at, log.completed_at)}
                </TableCell>
              </TableRow>
              <CollapsibleContent asChild>
                <TableRow className="bg-muted/30">
                  <TableCell colSpan={8} className="p-4">
                    {rowErrors[log.id]?.length > 0 ? (
                      <div className="space-y-2">
                        <p className="text-sm font-medium">Error Details:</p>
                        <ul className="text-sm space-y-1">
                          {rowErrors[log.id].map((error: any, i: number) => (
                            <li key={i} className="flex items-start gap-2">
                              <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
                              <span>
                                <span className="font-medium capitalize">{error.record_type}:</span>{" "}
                                {error.error_message}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {log.error_summary || "No errors recorded for this sync"}
                      </p>
                    )}
                  </TableCell>
                </TableRow>
              </CollapsibleContent>
            </>
          </Collapsible>
        ))}
      </TableBody>
    </Table>
  )
}
