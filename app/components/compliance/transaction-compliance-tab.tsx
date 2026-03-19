"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { 
  updateComplianceCheck,
  type ComplianceCheckStatus 
} from "@/app/actions/transaction-compliance"
import {
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  Filter,
  ExternalLink,
  ShieldCheck,
  ShieldX,
  Loader2,
} from "lucide-react"

interface ComplianceLog {
  id: string
  transaction_id: string
  brokerage_id: string
  check_type: string
  check_label: string
  status: string
  is_blocking: boolean
  checked_at: string | null
  checked_by: string | null
  resolved_at: string | null
  failure_reason: string | null
  created_at: string
  transaction?: {
    property_address: string
    stage: string
    agent_id: string
  }
}

interface TransactionComplianceTabProps {
  initialLogs: ComplianceLog[]
}

export function TransactionComplianceTab({ initialLogs }: TransactionComplianceTabProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [logs, setLogs] = useState(initialLogs)
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [blockingFilter, setBlockingFilter] = useState<string>("all")
  
  // Review dialog state
  const [selectedLog, setSelectedLog] = useState<ComplianceLog | null>(null)
  const [showReviewDialog, setShowReviewDialog] = useState(false)
  const [reviewStatus, setReviewStatus] = useState<ComplianceCheckStatus>("pass")
  const [resolutionNotes, setResolutionNotes] = useState("")
  const [failureReason, setFailureReason] = useState("")

  // Filter logs
  const filteredLogs = logs.filter(log => {
    if (statusFilter !== "all" && log.status !== statusFilter) return false
    if (blockingFilter === "blocking" && !log.is_blocking) return false
    if (blockingFilter === "non-blocking" && log.is_blocking) return false
    return true
  })

  // Stats
  const pendingCount = logs.filter(l => l.status === "pending" || l.status === "needs_review").length
  const failedCount = logs.filter(l => l.status === "fail").length
  const blockingFailedCount = logs.filter(l => l.status === "fail" && l.is_blocking).length

  function openReviewDialog(log: ComplianceLog) {
    setSelectedLog(log)
    setReviewStatus("pass")
    setResolutionNotes("")
    setFailureReason("")
    setShowReviewDialog(true)
  }

  function handleReviewSubmit() {
    if (!selectedLog) return

    startTransition(async () => {
      const result = await updateComplianceCheck({
        checkId: selectedLog.id,
        transactionId: selectedLog.transaction_id,
        brokerageId: selectedLog.brokerage_id,
        status: reviewStatus,
        resolutionNotes: resolutionNotes || undefined,
        failureReason: failureReason || undefined,
      })

      if (result.success) {
        // Update local state
        setLogs(prev =>
          prev.map(l =>
            l.id === selectedLog.id
              ? { ...l, status: reviewStatus, failure_reason: failureReason || null }
              : l
          )
        )
        setShowReviewDialog(false)
        router.refresh()
      }
    })
  }

  function getStatusBadge(status: string, isBlocking: boolean) {
    switch (status) {
      case "pass":
        return <Badge variant="default" className="bg-green-500"><CheckCircle2 className="h-3 w-3 mr-1" />Passed</Badge>
      case "fail":
        return <Badge variant="destructive"><XCircle className="h-3 w-3 mr-1" />Failed</Badge>
      case "waived":
        return <Badge variant="secondary"><ShieldCheck className="h-3 w-3 mr-1" />Waived</Badge>
      case "needs_review":
        return <Badge variant="outline" className="border-amber-500 text-amber-700"><AlertTriangle className="h-3 w-3 mr-1" />Needs Review</Badge>
      default:
        return <Badge variant="outline"><Clock className="h-3 w-3 mr-1" />Pending</Badge>
    }
  }

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pending Reviews</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{pendingCount}</div>
            <p className="text-xs text-muted-foreground mt-1">Awaiting compliance review</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Failed Checks</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${failedCount > 0 ? "text-red-600" : "text-green-600"}`}>
              {failedCount}
            </div>
            <p className="text-xs text-muted-foreground mt-1">{blockingFailedCount} blocking</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Checks</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{logs.length}</div>
            <p className="text-xs text-muted-foreground mt-1">Across all transactions</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Filter className="h-5 w-5" />
            Transaction Compliance Checks
          </CardTitle>
          <CardDescription>
            Review and manage compliance checks for active transactions
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4 mb-4">
            <div className="flex items-center gap-2">
              <Label htmlFor="status-filter" className="text-sm">Status:</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger id="status-filter" className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="pass">Passed</SelectItem>
                  <SelectItem value="fail">Failed</SelectItem>
                  <SelectItem value="waived">Waived</SelectItem>
                  <SelectItem value="needs_review">Needs Review</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <Label htmlFor="blocking-filter" className="text-sm">Type:</Label>
              <Select value={blockingFilter} onValueChange={setBlockingFilter}>
                <SelectTrigger id="blocking-filter" className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Checks</SelectItem>
                  <SelectItem value="blocking">Blocking Only</SelectItem>
                  <SelectItem value="non-blocking">Non-Blocking</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Table */}
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[250px]">Check</TableHead>
                  <TableHead>Transaction</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Blocking</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredLogs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                      No compliance checks match your filters
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredLogs.map(log => (
                    <TableRow key={log.id}>
                      <TableCell>
                        <div className="font-medium">{log.check_label}</div>
                        <div className="text-xs text-muted-foreground">{log.check_type}</div>
                      </TableCell>
                      <TableCell>
                        {log.transaction?.property_address ? (
                          <Link
                            href={`/dashboard/transactions/${log.transaction_id}`}
                            className="text-sm hover:underline flex items-center gap-1"
                          >
                            {log.transaction.property_address.substring(0, 30)}
                            {log.transaction.property_address.length > 30 && "..."}
                            <ExternalLink className="h-3 w-3" />
                          </Link>
                        ) : (
                          <span className="text-muted-foreground text-sm">N/A</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {log.transaction?.stage?.replace(/_/g, " ") ?? "Unknown"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {log.is_blocking ? (
                          <ShieldX className="h-4 w-4 text-red-500" title="Blocking" />
                        ) : (
                          <ShieldCheck className="h-4 w-4 text-muted-foreground" title="Non-blocking" />
                        )}
                      </TableCell>
                      <TableCell>{getStatusBadge(log.status, log.is_blocking)}</TableCell>
                      <TableCell className="text-right">
                        {log.status === "pending" || log.status === "needs_review" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openReviewDialog(log)}
                          >
                            Review
                          </Button>
                        ) : log.status === "fail" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openReviewDialog(log)}
                          >
                            Re-Review
                          </Button>
                        ) : (
                          <span className="text-sm text-muted-foreground">Completed</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Review Dialog */}
      <Dialog open={showReviewDialog} onOpenChange={setShowReviewDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review Compliance Check</DialogTitle>
            <DialogDescription>
              {selectedLog?.check_label}
              {selectedLog?.is_blocking && (
                <Badge variant="destructive" className="ml-2">Blocking</Badge>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Transaction</Label>
              <p className="text-sm text-muted-foreground">
                {selectedLog?.transaction?.property_address ?? "Unknown"}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="review-status">Status</Label>
              <Select value={reviewStatus} onValueChange={(v) => setReviewStatus(v as ComplianceCheckStatus)}>
                <SelectTrigger id="review-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pass">Passed</SelectItem>
                  <SelectItem value="fail">Failed</SelectItem>
                  <SelectItem value="waived">Waived</SelectItem>
                  <SelectItem value="needs_review">Needs Review</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {reviewStatus === "fail" && (
              <div className="space-y-2">
                <Label htmlFor="failure-reason">Failure Reason</Label>
                <Textarea
                  id="failure-reason"
                  placeholder="Explain why this check failed..."
                  value={failureReason}
                  onChange={(e) => setFailureReason(e.target.value)}
                />
              </div>
            )}

            {(reviewStatus === "pass" || reviewStatus === "waived") && (
              <div className="space-y-2">
                <Label htmlFor="resolution-notes">Notes (optional)</Label>
                <Textarea
                  id="resolution-notes"
                  placeholder="Add any resolution notes..."
                  value={resolutionNotes}
                  onChange={(e) => setResolutionNotes(e.target.value)}
                />
              </div>
            )}

            {selectedLog?.is_blocking && (reviewStatus === "fail" || reviewStatus === "needs_review") && (
              <div className="bg-red-50 border border-red-200 rounded-md p-3">
                <p className="text-sm text-red-800 flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  This is a blocking check. Failing it will prevent the transaction from advancing to Closing Prep.
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowReviewDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleReviewSubmit} disabled={isPending}>
              {isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Submit Review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
