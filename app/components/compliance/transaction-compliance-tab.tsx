"use client"

import { useState, useTransition, useMemo } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  updateComplianceCheck,
  batchPassComplianceChecks,
  type ComplianceCheckStatus,
} from "@/app/actions/transaction-compliance"
import {
  exportAuditTrail,
  monitorTRIDCompliance,
  checkComplianceStatus,
  resolveComplianceAlert,
} from "@/app/actions/compliance-monitoring"
import { ActionConfirmSheet } from "@/app/components/action-framework"
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
  AlertOctagon,
  FileDown,
  ScanSearch,
  ChevronDown,
} from "lucide-react"
import { toast } from "sonner"

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

interface TridViolation {
  type: string
  severity: string
  message?: string
}

interface TridResult {
  compliant: boolean
  violations: TridViolation[]
  checkedAt: string
}

/** One unresolved row from compliance_alerts, as checkComplianceStatus returns it. */
interface ComplianceAlert {
  id: string
  alert_type: string
  severity: string | null
  message: string | null
  created_at: string | null
}

interface ComplianceSummary {
  score: number
  flaggedCount: number
  overallStatus: string
  /**
   * The alerts themselves, not just the COUNT. Until wave 14 this panel showed
   * "3 alerts" and `overallStatus: at_risk` with no way to see or clear any of
   * them — `compliance_alerts.resolved` was read as `false` and written by
   * nobody, so at_risk was permanent and the badge was noise. Listing them is
   * what makes the resolve action reachable.
   */
  alerts: ComplianceAlert[]
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

  // Batch selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBatchConfirm, setShowBatchConfirm] = useState(false)
  const [batchPending, startBatchTransition] = useTransition()

  // Per-row action states
  const [escalateLog, setEscalateLog] = useState<ComplianceLog | null>(null)
  const [exportingId, setExportingId] = useState<string | null>(null)
  const [tridResults, setTridResults] = useState<Record<string, TridResult>>({})
  const [tridPendingId, setTridPendingId] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<Record<string, ComplianceSummary>>({})
  const [summaryPendingId, setSummaryPendingId] = useState<string | null>(null)
  const [resolvingAlertId, setResolvingAlertId] = useState<string | null>(null)
  const [alertMsg, setAlertMsg] = useState<string | null>(null)

  // Review dialog state (preserved from original)
  const [selectedLog, setSelectedLog] = useState<ComplianceLog | null>(null)
  const [showReviewDialog, setShowReviewDialog] = useState(false)
  const [reviewStatus, setReviewStatus] = useState<ComplianceCheckStatus>("pass")
  const [resolutionNotes, setResolutionNotes] = useState("")
  const [failureReason, setFailureReason] = useState("")

  // Filter logs
  const filteredLogs = logs.filter((log) => {
    if (statusFilter !== "all" && log.status !== statusFilter) return false
    if (blockingFilter === "blocking" && !log.is_blocking) return false
    if (blockingFilter === "non-blocking" && log.is_blocking) return false
    return true
  })

  // Actionable logs (pending or needs_review) for batch
  const actionableLogs = filteredLogs.filter(
    (l) => l.status === "pending" || l.status === "needs_review"
  )

  // Stats
  const pendingCount = logs.filter((l) => l.status === "pending" || l.status === "needs_review").length
  const failedCount = logs.filter((l) => l.status === "fail").length
  const blockingFailedCount = logs.filter((l) => l.status === "fail" && l.is_blocking).length

  // Grouped by transaction for summary section
  const byTransaction = useMemo(() => {
    const map = new Map<string, { address: string; logs: ComplianceLog[] }>()
    for (const l of logs) {
      if (!map.has(l.transaction_id)) {
        map.set(l.transaction_id, {
          address: l.transaction?.property_address ?? l.transaction_id.slice(0, 8),
          logs: [],
        })
      }
      map.get(l.transaction_id)!.logs.push(l)
    }
    return map
  }, [logs])

  // ── Review dialog (preserved) ──────────────────────────────────────────────
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
        setLogs((prev) =>
          prev.map((l) =>
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

  // ── Escalate ───────────────────────────────────────────────────────────────
  async function handleEscalate() {
    if (!escalateLog) return
    const result = await updateComplianceCheck({
      checkId: escalateLog.id,
      transactionId: escalateLog.transaction_id,
      brokerageId: escalateLog.brokerage_id,
      status: "needs_review",
      resolutionNotes: "Escalated for senior review",
    })
    if (result.success) {
      setLogs((prev) =>
        prev.map((l) => (l.id === escalateLog.id ? { ...l, status: "needs_review" } : l))
      )
      toast.success("Check escalated for review")
      router.refresh()
    } else {
      toast.error(result.error ?? "Escalation failed")
    }
  }

  // ── Mark reviewed (quick pass) ─────────────────────────────────────────────
  function handleQuickPass(log: ComplianceLog) {
    startTransition(async () => {
      const result = await updateComplianceCheck({
        checkId: log.id,
        transactionId: log.transaction_id,
        brokerageId: log.brokerage_id,
        status: "pass",
      })
      if (result.success) {
        setLogs((prev) => prev.map((l) => (l.id === log.id ? { ...l, status: "pass" } : l)))
        setSelectedIds((prev) => { const s = new Set(prev); s.delete(log.id); return s })
        toast.success("Check marked as passed")
      } else {
        toast.error(result.error ?? "Update failed")
      }
    })
  }

  // ── Export audit ───────────────────────────────────────────────────────────
  async function handleExportAudit(transactionId: string) {
    setExportingId(transactionId)
    const endDate = new Date().toISOString()
    const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
    const result = await exportAuditTrail({ transactionId, startDate, endDate })
    setExportingId(null)
    if (result.count === 0) {
      toast.info("No audit records found for this transaction")
      return
    }
    const text = JSON.stringify(result.logs, null, 2)
    await navigator.clipboard.writeText(text)
    toast.success(`${result.count} audit record${result.count !== 1 ? "s" : ""} copied to clipboard`)
  }

  // ── Check TRID compliance ──────────────────────────────────────────────────
  async function handleTRID(transactionId: string) {
    setTridPendingId(transactionId)
    const result = await monitorTRIDCompliance(transactionId)
    setTridPendingId(null)
    setTridResults((prev) => ({
      ...prev,
      [transactionId]: {
        compliant: result.compliant ?? true,
        violations: result.violations ?? [],
        checkedAt: new Date().toISOString(),
      },
    }))
  }

  // ── Load compliance summary per transaction ────────────────────────────────
  async function handleLoadSummary(transactionId: string) {
    setSummaryPendingId(transactionId)
    const result = await checkComplianceStatus(transactionId)
    setSummaryPendingId(null)
    if (result) {
      const total = result.checklists?.length ?? 0
      const compliant = result.checklists?.filter((c: any) => c.compliance_status === "compliant").length ?? 0
      setSummaries((prev) => ({
        ...prev,
        [transactionId]: {
          score: total > 0 ? Math.round((compliant / total) * 100) : 100,
          flaggedCount: result.alerts?.length ?? 0,
          overallStatus: result.overallStatus ?? "pending",
          alerts: (result.alerts ?? []).map((a: any) => ({
            id: String(a.id),
            alert_type: String(a.alert_type ?? "alert"),
            severity: (a.severity as string | null) ?? null,
            message: (a.message as string | null) ?? null,
            created_at: (a.created_at as string | null) ?? null,
          })),
        },
      }))
    }
  }

  // ── Clear one compliance alert ─────────────────────────────────────────────
  //
  // The writer `compliance_alerts.resolved` never had. It stamps who and when
  // server-side (identity from the session, never from here). A refusal is shown,
  // not swallowed — an alert that vanishes from the panel while still standing in
  // the record is the failure this whole path exists to prevent.
  async function handleResolveAlert(transactionId: string, alertId: string) {
    setResolvingAlertId(alertId)
    setAlertMsg(null)
    const res = await resolveComplianceAlert({ alertId })
    setResolvingAlertId(null)
    if (!res.success) {
      setAlertMsg(res.error ?? "Could not clear that alert.")
      return
    }
    setSummaries((prev) => {
      const s = prev[transactionId]
      if (!s) return prev
      const alerts = s.alerts.filter((a) => a.id !== alertId)
      return {
        ...prev,
        [transactionId]: {
          ...s,
          alerts,
          flaggedCount: alerts.length,
          // The status is RE-DERIVED from the same rule the service uses: any
          // unresolved alert means at_risk. Clearing the last one is what finally
          // lets this leave at_risk — which it previously never could.
          overallStatus: alerts.length > 0 ? "at_risk" : s.score === 100 ? "compliant" : "pending",
        },
      }
    })
    toast.success("Alert cleared")
    router.refresh()
  }

  // ── Batch approve selected ─────────────────────────────────────────────────
  async function handleBatchApprove() {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return

    // Group by transaction
    const byTxn = new Map<string, { brokerageId: string; checkIds: string[] }>()
    for (const id of ids) {
      const log = logs.find((l) => l.id === id)
      if (!log) continue
      if (!byTxn.has(log.transaction_id)) {
        byTxn.set(log.transaction_id, { brokerageId: log.brokerage_id, checkIds: [] })
      }
      byTxn.get(log.transaction_id)!.checkIds.push(id)
    }

    let totalPassed = 0
    for (const [transactionId, { brokerageId, checkIds }] of byTxn.entries()) {
      const result = await batchPassComplianceChecks({
        transactionId,
        checkIds,
        brokerageId,
      })
      if (result.success) totalPassed += result.updated
    }

    setLogs((prev) =>
      prev.map((l) => (selectedIds.has(l.id) ? { ...l, status: "pass" } : l))
    )
    setSelectedIds(new Set())
    toast.success(`${totalPassed} check${totalPassed !== 1 ? "s" : ""} approved`)
    router.refresh()
  }

  // ── Select all / toggle ────────────────────────────────────────────────────
  function toggleSelectAll() {
    if (selectedIds.size === actionableLogs.length && actionableLogs.length > 0) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(actionableLogs.map((l) => l.id)))
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const s = new Set(prev)
      s.has(id) ? s.delete(id) : s.add(id)
      return s
    })
  }

  function getStatusBadge(status: string) {
    switch (status) {
      case "pass":
        return (
          <Badge variant="default" className="bg-green-500">
            <CheckCircle2 className="h-3 w-3 mr-1" />Passed
          </Badge>
        )
      case "fail":
        return (
          <Badge variant="destructive">
            <XCircle className="h-3 w-3 mr-1" />Failed
          </Badge>
        )
      case "waived":
        return (
          <Badge variant="secondary">
            <ShieldCheck className="h-3 w-3 mr-1" />Waived
          </Badge>
        )
      case "needs_review":
        return (
          <Badge variant="outline" className="border-amber-500 text-amber-700">
            <AlertTriangle className="h-3 w-3 mr-1" />Needs Review
          </Badge>
        )
      default:
        return (
          <Badge variant="outline">
            <Clock className="h-3 w-3 mr-1" />Pending
          </Badge>
        )
    }
  }

  return (
    <div className="space-y-6">

      {/* ── Compliance Summary by Transaction ─────────────────────────────── */}
      {byTransaction.size > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Compliance Summary by Transaction
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {Array.from(byTransaction.entries()).map(([txnId, { address, logs: txnLogs }]) => {
              const failed = txnLogs.filter((l) => l.status === "fail").length
              const blocking = txnLogs.filter((l) => l.is_blocking && l.status === "fail").length
              const passed = txnLogs.filter((l) => l.status === "pass").length
              const total = txnLogs.length
              const localScore = total > 0 ? Math.round((passed / total) * 100) : 100
              const summary = summaries[txnId]
              const score = summary?.score ?? localScore

              return (
                <Card key={txnId} className="border-none bg-muted/40">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium leading-snug line-clamp-1">{address}</p>
                      <Link href={`/dashboard/transactions/${txnId}`}>
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
                          View <ExternalLink className="h-3 w-3 ml-1" />
                        </Button>
                      </Link>
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>Compliance Score</span>
                        <span className="font-semibold text-foreground">{score}%</span>
                      </div>
                      <Progress
                        value={score}
                        className={score < 60 ? "h-1.5 [&>div]:bg-red-500" : score < 80 ? "h-1.5 [&>div]:bg-amber-500" : "h-1.5 [&>div]:bg-emerald-500"}
                      />
                    </div>

                    <div className="flex gap-2 flex-wrap text-xs">
                      {failed > 0 && (
                        <span className="text-red-600 font-medium">{failed} failed</span>
                      )}
                      {blocking > 0 && (
                        <span className="text-red-700 font-semibold">{blocking} blocking</span>
                      )}
                      <span className="text-muted-foreground">{total} total checks</span>
                      {summary && (
                        <Badge variant="outline" className="text-xs h-4">
                          {summary.flaggedCount} alert{summary.flaggedCount !== 1 ? "s" : ""}
                        </Badge>
                      )}
                      {summary && (
                        <Badge
                          variant="outline"
                          className={`text-xs h-4 ${
                            summary.overallStatus === "at_risk"
                              ? "border-red-300 text-red-700"
                              : summary.overallStatus === "compliant"
                                ? "border-emerald-300 text-emerald-700"
                                : "text-muted-foreground"
                          }`}
                        >
                          {summary.overallStatus}
                        </Badge>
                      )}
                    </div>

                    {/* The unresolved alerts themselves, each with the clear action
                        that `compliance_alerts.resolved` never had a writer for. */}
                    {summary && summary.alerts.length > 0 && (
                      <div className="rounded border border-red-200 bg-red-50 p-2 space-y-1.5">
                        {summary.alerts.map((a) => (
                          <div key={a.id} className="flex items-start gap-2 text-xs">
                            <AlertOctagon className="h-3 w-3 mt-0.5 text-red-600 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-red-800">
                                {a.alert_type}
                                {a.severity ? ` · ${a.severity}` : ""}
                              </p>
                              {a.message && <p className="text-red-700 leading-snug">{a.message}</p>}
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-xs shrink-0"
                              disabled={resolvingAlertId === a.id}
                              onClick={() => handleResolveAlert(txnId, a.id)}
                            >
                              {resolvingAlertId === a.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                "Resolve"
                              )}
                            </Button>
                          </div>
                        ))}
                        {alertMsg && <p className="text-xs text-red-800">{alertMsg}</p>}
                      </div>
                    )}

                    {/* Per-transaction actions */}
                    <div className="flex gap-1.5 flex-wrap">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => handleExportAudit(txnId)}
                        disabled={exportingId === txnId}
                      >
                        {exportingId === txnId ? (
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        ) : (
                          <FileDown className="h-3 w-3 mr-1" />
                        )}
                        Audit Report
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => handleTRID(txnId)}
                        disabled={tridPendingId === txnId}
                      >
                        {tridPendingId === txnId ? (
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                        ) : (
                          <ScanSearch className="h-3 w-3 mr-1" />
                        )}
                        Check TRID
                      </Button>
                      {!summary && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => handleLoadSummary(txnId)}
                          disabled={summaryPendingId === txnId}
                        >
                          {summaryPendingId === txnId ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            "Load Live Score"
                          )}
                        </Button>
                      )}
                    </div>

                    {/* TRID result inline */}
                    {tridResults[txnId] && (
                      <div
                        className={`rounded p-2 text-xs ${
                          tridResults[txnId].compliant
                            ? "bg-emerald-50 border border-emerald-200 text-emerald-800"
                            : "bg-red-50 border border-red-200 text-red-800"
                        }`}
                      >
                        <p className="font-semibold mb-1">
                          TRID: {tridResults[txnId].compliant ? "Compliant" : "Non-Compliant"}
                        </p>
                        {tridResults[txnId].violations.length > 0 && (
                          <ul className="list-disc list-inside space-y-0.5">
                            {tridResults[txnId].violations.map((v, i) => (
                              <li key={i}>
                                [{v.severity}] {v.message ?? v.type}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Stats ─────────────────────────────────────────────────────────── */}
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

      {/* ── Filter + Table ─────────────────────────────────────────────────── */}
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
          {/* Filters */}
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

          {/* ── Batch Review Bar ───────────────────────────────────────────── */}
          {actionableLogs.length > 0 && (
            <div className="flex items-center gap-3 mb-3 p-3 rounded-lg bg-muted/60 border">
              <Checkbox
                id="select-all"
                checked={
                  selectedIds.size === actionableLogs.length && actionableLogs.length > 0
                }
                onCheckedChange={toggleSelectAll}
              />
              <label htmlFor="select-all" className="text-sm cursor-pointer">
                {selectedIds.size > 0
                  ? `${selectedIds.size} of ${actionableLogs.length} selected`
                  : `Select all ${actionableLogs.length} actionable checks`}
              </label>
              {selectedIds.size > 0 && (
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => setShowBatchConfirm(true)}
                  disabled={batchPending}
                  className="ml-auto"
                >
                  {batchPending ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Batch Approve {selectedIds.size} Item{selectedIds.size !== 1 ? "s" : ""}
                </Button>
              )}
            </div>
          )}

          {/* Table */}
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead className="w-[220px]">Check</TableHead>
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
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      No compliance checks match your filters
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredLogs.map((log) => {
                    const isActionable = log.status === "pending" || log.status === "needs_review"
                    const isSelectable = isActionable
                    return (
                      <TableRow key={log.id}>
                        {/* Select checkbox */}
                        <TableCell>
                          {isSelectable && (
                            <Checkbox
                              checked={selectedIds.has(log.id)}
                              onCheckedChange={() => toggleSelect(log.id)}
                            />
                          )}
                        </TableCell>

                        {/* Check label */}
                        <TableCell>
                          <div className="font-medium text-sm">{log.check_label}</div>
                          <div className="text-xs text-muted-foreground">{log.check_type}</div>
                          {log.failure_reason && (
                            <div className="text-xs text-red-600 mt-0.5">{log.failure_reason}</div>
                          )}
                        </TableCell>

                        {/* Transaction */}
                        <TableCell>
                          {log.transaction?.property_address ? (
                            <Link
                              href={`/dashboard/transactions/${log.transaction_id}`}
                              className="text-sm hover:underline flex items-center gap-1"
                            >
                              {log.transaction.property_address.substring(0, 28)}
                              {log.transaction.property_address.length > 28 && "..."}
                              <ExternalLink className="h-3 w-3" />
                            </Link>
                          ) : (
                            <span className="text-muted-foreground text-sm">N/A</span>
                          )}
                        </TableCell>

                        {/* Stage */}
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {log.transaction?.stage?.replace(/_/g, " ") ?? "Unknown"}
                          </Badge>
                        </TableCell>

                        {/* Blocking */}
                        <TableCell>
                          {log.is_blocking ? (
                            <ShieldX className="h-4 w-4 text-red-500" />
                          ) : (
                            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>

                        {/* Status */}
                        <TableCell>{getStatusBadge(log.status)}</TableCell>

                        {/* Actions */}
                        <TableCell>
                          <div className="flex items-center gap-1 justify-end flex-wrap">
                            {/* Mark Reviewed (quick pass) */}
                            {isActionable && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                onClick={() => handleQuickPass(log)}
                                disabled={isPending}
                                title="Mark as Passed"
                              >
                                <CheckCircle2 className="h-3 w-3 mr-1 text-emerald-600" />
                                Pass
                              </Button>
                            )}

                            {/* Full Review (opens dialog) */}
                            {(isActionable || log.status === "fail") && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs"
                                onClick={() => openReviewDialog(log)}
                              >
                                Review
                              </Button>
                            )}

                            {/* Escalate */}
                            {isActionable && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs text-amber-700 border-amber-300 hover:bg-amber-50"
                                onClick={() => setEscalateLog(log)}
                                title="Escalate for senior review"
                              >
                                <AlertOctagon className="h-3 w-3 mr-1" />
                                Escalate
                              </Button>
                            )}

                            {/* Generate Audit */}
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs"
                              onClick={() => handleExportAudit(log.transaction_id)}
                              disabled={exportingId === log.transaction_id}
                              title="Generate Audit Report"
                            >
                              {exportingId === log.transaction_id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <FileDown className="h-3 w-3" />
                              )}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* ── Batch Approve Confirm ─────────────────────────────────────────── */}
      <ActionConfirmSheet
        open={showBatchConfirm}
        onOpenChange={setShowBatchConfirm}
        title="Batch Approve Compliance Checks"
        description={`Mark ${selectedIds.size} selected item${selectedIds.size !== 1 ? "s" : ""} as reviewed and passed? This will be recorded in the audit trail.`}
        actionLabel={`Approve ${selectedIds.size} Item${selectedIds.size !== 1 ? "s" : ""}`}
        onConfirm={handleBatchApprove}
        destructive={false}
      />

      {/* ── Escalate Confirm ─────────────────────────────────────────────── */}
      <ActionConfirmSheet
        open={!!escalateLog}
        onOpenChange={(open) => { if (!open) setEscalateLog(null) }}
        title="Escalate Compliance Check"
        description={`Escalate "${escalateLog?.check_label}" for senior review? The check will be marked as Needs Review and flagged for follow-up.`}
        actionLabel="Escalate for Review"
        onConfirm={handleEscalate}
        destructive={false}
      />

      {/* ── Review Dialog (preserved) ────────────────────────────────────── */}
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
