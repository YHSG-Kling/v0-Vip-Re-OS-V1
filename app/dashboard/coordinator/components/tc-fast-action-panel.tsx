"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ActionConfirmSheet, TaskNoteCreator } from "@/app/components/action-framework"
import { batchPassComplianceChecks, getTransactionComplianceChecks } from "@/app/actions/transaction-compliance"
import { exportAuditTrail } from "@/app/actions/compliance-monitoring"
import {
  Zap,
  FileText,
  CheckSquare,
  ShieldCheck,
  Download,
  Loader2,
} from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

interface TcFastActionPanelProps {
  transactions: Array<{ id: string; property_address: string; stage?: string }>
  agentId: string
  brokerageId: string
  userRole: string
}

export function TcFastActionPanel({
  transactions,
  agentId,
  brokerageId,
  userRole,
}: TcFastActionPanelProps) {
  const router = useRouter()
  const [selectedTxnId, setSelectedTxnId] = useState<string>(transactions[0]?.id ?? "")
  const [showBatchConfirm, setShowBatchConfirm] = useState(false)
  const [batchPending, startBatchTransition] = useTransition()
  const [exportPending, startExportTransition] = useTransition()

  const selectedTxn = transactions.find((t) => t.id === selectedTxnId)
  const isAdminOrTc = userRole === "admin" || userRole === "tc"

  async function handleBatchPass() {
    if (!selectedTxnId) return
    const checksResult = await getTransactionComplianceChecks({
      transactionId: selectedTxnId,
      brokerageId,
    })
    const openChecks = (checksResult.checks ?? [])
      .filter((c: any) => c.status === "pending" || c.status === "needs_review")
      .map((c: any) => c.id)

    if (openChecks.length === 0) {
      toast.info("No open checks to pass on this transaction")
      setShowBatchConfirm(false)
      return
    }

      const result = await batchPassComplianceChecks({
        transactionId: selectedTxnId,
        checkIds: openChecks,
        brokerageId,
      })

    if (result.success) {
      toast.success(`Passed ${openChecks.length} compliance check${openChecks.length !== 1 ? "s" : ""}`)
      router.refresh()
    } else {
      toast.error(result.error ?? "Batch pass failed")
    }
  }

  function handleExport() {
    if (!selectedTxnId) return
    startExportTransition(async () => {
      const endDate = new Date().toISOString()
      const startDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
      const result = await exportAuditTrail({
        transactionId: selectedTxnId,
        startDate,
        endDate,
      })
      if (result.count === 0) {
        toast.info("No audit records found for this transaction")
        return
      }
      const text = JSON.stringify(result.logs, null, 2)
      await navigator.clipboard.writeText(text)
      toast.success(`${result.count} audit record${result.count !== 1 ? "s" : ""} copied to clipboard`)
    })
  }

  if (transactions.length === 0) return null

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="h-4 w-4 text-primary" />
              TC Fast Actions
            </CardTitle>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">File:</span>
              <Select value={selectedTxnId} onValueChange={setSelectedTxnId}>
                <SelectTrigger className="h-8 text-xs w-[220px]">
                  <SelectValue placeholder="Select transaction" />
                </SelectTrigger>
                <SelectContent>
                  {transactions.map((t) => (
                    <SelectItem key={t.id} value={t.id} className="text-xs">
                      {t.property_address?.substring(0, 35) ?? t.id.slice(0, 8)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {/* Log Activity — TaskNoteCreator manages its own sheet */}
            <TaskNoteCreator
              agentId={agentId}
              transactionId={selectedTxnId}
              defaultType="note"
              onCreated={() => router.refresh()}
            />

            {/* Create Task — separate TaskNoteCreator instance */}
            <TaskNoteCreator
              agentId={agentId}
              transactionId={selectedTxnId}
              defaultType="task"
              onCreated={() => router.refresh()}
            />

            {/* Batch Pass — admin/tc only */}
            {isAdminOrTc && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowBatchConfirm(true)}
                disabled={batchPending || !selectedTxnId}
              >
                {batchPending ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5 mr-1.5" />
                )}
                Batch Pass Compliance
              </Button>
            )}

            {/* Export File Packet */}
            <Button
              size="sm"
              variant="outline"
              onClick={handleExport}
              disabled={exportPending || !selectedTxnId}
            >
              {exportPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5 mr-1.5" />
              )}
              Export File Packet
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Batch pass confirm sheet */}
      <ActionConfirmSheet
        open={showBatchConfirm}
        onOpenChange={setShowBatchConfirm}
        title="Batch Pass Compliance Checks"
        description={`Mark all open (pending / needs-review) standard checks as passed for "${selectedTxn?.property_address ?? "this transaction"}"? This cannot be undone without individual re-review.`}
        actionLabel="Confirm — Pass All Open Checks"
        onConfirm={handleBatchPass}
        destructive={false}
      />
    </>
  )
}
