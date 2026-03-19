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
import { retrySyncError, clearResolvedErrors } from "@/app/actions/accounting-sync"
import { useToast } from "@/hooks/use-toast"
import { RefreshCw, Trash2, Loader2, AlertCircle } from "lucide-react"

interface SyncError {
  id: string
  record_type: string
  record_id: string
  error_code: string
  error_message: string
  created_at: string
}

interface ErrorLogTableProps {
  errors: SyncError[]
  brokerageId: string
}

export function ErrorLogTable({ errors, brokerageId }: ErrorLogTableProps) {
  const [retrying, setRetrying] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const { toast } = useToast()

  const handleRetry = async (errorId: string) => {
    setRetrying(errorId)
    try {
      await retrySyncError({ errorId, brokerageId })
      toast({
        title: "Retry Queued",
        description: "The record has been re-queued for sync",
      })
    } catch (error) {
      toast({
        title: "Retry Failed",
        description: "Failed to retry sync",
        variant: "destructive",
      })
    } finally {
      setRetrying(null)
    }
  }

  const handleClearAll = async () => {
    if (!confirm("Are you sure you want to clear all errors? This cannot be undone.")) return

    setClearing(true)
    try {
      await clearResolvedErrors(brokerageId)
      toast({
        title: "Errors Cleared",
        description: "All sync errors have been cleared",
      })
    } catch (error) {
      toast({
        title: "Failed to Clear",
        description: "Could not clear errors",
        variant: "destructive",
      })
    } finally {
      setClearing(false)
    }
  }

  if (errors.length === 0) {
    return (
      <div className="text-center py-8">
        <AlertCircle className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
        <p className="text-muted-foreground">No sync errors</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={handleClearAll}
          disabled={clearing}
        >
          {clearing ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Clearing...
            </>
          ) : (
            <>
              <Trash2 className="h-4 w-4 mr-2" />
              Clear All Errors
            </>
          )}
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Record Type</TableHead>
            <TableHead>Error</TableHead>
            <TableHead>Date</TableHead>
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {errors.map((error) => (
            <TableRow key={error.id}>
              <TableCell>
                <Badge variant="outline" className="capitalize">
                  {error.record_type}
                </Badge>
              </TableCell>
              <TableCell className="max-w-md">
                <p className="text-sm truncate" title={error.error_message}>
                  {error.error_message}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Code: {error.error_code}
                </p>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {new Date(error.created_at).toLocaleString()}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRetry(error.id)}
                  disabled={retrying === error.id}
                >
                  {retrying === error.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <>
                      <RefreshCw className="h-4 w-4 mr-1" />
                      Retry
                    </>
                  )}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
