"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Download,
  FileText,
  DollarSign,
  TrendingUp,
  Loader2,
  Sparkles,
  CheckCircle2,
} from "lucide-react"
import { exportCommissionsCSV, exportExpensesCSV, generatePLReport } from "@/app/actions/financials"
// BROKERAGE-LEVEL reporting. These two kernel commands were complete — a real CSV/PDF
// serialization of the live brokerage financials with a lifecycle_events audit row, and a
// queued email of the same report — and neither had a caller anywhere. The only export on
// this page was the AGENT's own commissions/expenses (app/actions/financials.ts), so a
// broker or admin had no way to produce or send a brokerage financial report at all.
import { exportFinancialReportAction, emailFinancialReportAction } from "@/app/actions/financial-kernel"
import { Input } from "@/components/ui/input"

interface Commission {
  id: string
  close_date: string | null
  gross_commission: number | null
  agent_commission: number | null
  brokerage_commission: number | null
  status: string | null
  side: string | null
  transaction_id: string | null
}

interface ReportsClientProps {
  agentId: string
  brokerageId: string
  commissions: Commission[]
  currentYear: number
  ytdCommissions: number
  ytdAgentNet: number
  ytdExpenses: number
  /** users.user_type — the brokerage report block is broker/admin only (the kernel enforces it too). */
  userType: string
}

export function ReportsClient({
  agentId,
  brokerageId,
  commissions,
  currentYear,
  ytdCommissions,
  ytdAgentNet,
  ytdExpenses,
  userType,
}: ReportsClientProps) {
  const [isPLPending, startPL] = useTransition()
  const [isCommCSVPending, startCommCSV] = useTransition()
  const [isExpCSVPending, startExpCSV] = useTransition()
  const [plSummary, setPLSummary] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isBrokerAdmin = ["broker", "broker_admin", "admin", "superadmin"].includes(userType)
  const [isBrokerageExportPending, startBrokerageExport] = useTransition()
  const [isBrokerageEmailPending, startBrokerageEmail] = useTransition()
  const [brokerageError, setBrokerageError] = useState<string | null>(null)
  const [brokerageNotice, setBrokerageNotice] = useState<string | null>(null)
  const [reportRecipients, setReportRecipients] = useState("")

  function handleBrokerageExport(format: "csv" | "pdf") {
    startBrokerageExport(async () => {
      setBrokerageError(null)
      setBrokerageNotice(null)
      const res = await exportFinancialReportAction({
        brokerageId,
        format,
        reportType: "brokerage_financial_summary",
      })
      if (!res.success || !("data" in res) || !res.data) {
        setBrokerageError(("error" in res && res.error) || "Export failed")
        return
      }
      // The kernel returns a self-contained data: URI (no storage dependency).
      const a = document.createElement("a")
      a.href = res.data.fileUrl
      a.download = `brokerage-financial-report-${new Date().toISOString().slice(0, 10)}.${format}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setBrokerageNotice(`Brokerage ${format.toUpperCase()} generated`)
    })
  }

  function handleBrokerageEmail() {
    const recipients = reportRecipients
      .split(/[,;\s]+/)
      .map((r) => r.trim())
      .filter(Boolean)
    const invalid = recipients.filter((r) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r))
    if (recipients.length === 0 || invalid.length > 0) {
      setBrokerageError(invalid.length > 0 ? `Not a valid email: ${invalid[0]}` : "Enter at least one recipient")
      return
    }
    startBrokerageEmail(async () => {
      setBrokerageError(null)
      setBrokerageNotice(null)
      const res = await emailFinancialReportAction({
        brokerageId,
        recipients,
        reportType: "brokerage_financial_summary",
      })
      if (!res.success) {
        setBrokerageError(("error" in res && res.error) || "Send failed")
        return
      }
      setBrokerageNotice(`Report queued to ${recipients.length} recipient${recipients.length === 1 ? "" : "s"}`)
      setReportRecipients("")
    })
  }

  function downloadCSV(csv: string, filename: string) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleCommissionsCSV() {
    startCommCSV(async () => {
      setError(null)
      const result = await exportCommissionsCSV(agentId)
      if (result.success && result.csv) {
        downloadCSV(result.csv, result.filename ?? `commissions-${currentYear}.csv`)
      } else {
        setError(result.error ?? "Export failed")
      }
    })
  }

  function handleExpensesCSV() {
    startExpCSV(async () => {
      setError(null)
      const result = await exportExpensesCSV(agentId)
      if (result.success && result.csv) {
        downloadCSV(result.csv, result.filename ?? `expenses-${currentYear}.csv`)
      } else {
        setError(result.error ?? "Export failed")
      }
    })
  }

  function handleGeneratePL() {
    startPL(async () => {
      setError(null)
      setPLSummary(null)
      const result = await generatePLReport({ agentId, brokerageId, isBrokerage: false })
      if (result.success && result.summary) {
        setPLSummary(result.summary)
      } else {
        setError(result.error ?? "Report generation failed")
      }
    })
  }

  const fmt = (n: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

  const reports = [
    {
      title: "Commission History (CSV)",
      description: `${commissions.length} records for ${currentYear} — close date, GCI, agent commission, status`,
      icon: DollarSign,
      colorClass: "bg-green-500/10 text-green-500",
      action: handleCommissionsCSV,
      loading: isCommCSVPending,
      buttonLabel: "Download CSV",
    },
    {
      title: "Expense Report (CSV)",
      description: `All categorized business expenses for ${currentYear}`,
      icon: TrendingUp,
      colorClass: "bg-orange-500/10 text-orange-500",
      action: handleExpensesCSV,
      loading: isExpCSVPending,
      buttonLabel: "Download CSV",
    },
    {
      title: "AI P&L Summary",
      description: "AI-generated profit & loss analysis with recommendations",
      icon: Sparkles,
      colorClass: "bg-purple-500/10 text-purple-500",
      action: handleGeneratePL,
      loading: isPLPending,
      buttonLabel: "Generate Report",
    },
  ]

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Available Reports */}
      <Card>
        <CardHeader>
          <CardTitle>Available Reports</CardTitle>
          <CardDescription>Download or generate your financial documents</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {reports.map((report) => {
              const Icon = report.icon
              return (
                <div
                  key={report.title}
                  className="flex items-center justify-between p-4 border rounded-lg hover:border-primary/50 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <div className={`p-3 rounded-lg ${report.colorClass}`}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <div>
                      <p className="font-semibold">{report.title}</p>
                      <p className="text-sm text-muted-foreground">{report.description}</p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2 shrink-0"
                    onClick={report.action}
                    disabled={report.loading}
                  >
                    {report.loading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4" />
                    )}
                    {report.loading ? "Working..." : report.buttonLabel}
                  </Button>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* BROKERAGE FINANCIAL REPORT — broker/admin only. Serialized live from
          loadBrokerageFinancialSummary, with a lifecycle_events audit row per export
          and per send. Distinct from the agent CSVs above, which cover only the
          signed-in agent's own commissions and expenses. */}
      {isBrokerAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>Brokerage Financial Report</CardTitle>
            <CardDescription>
              Whole-brokerage financials — download as CSV or PDF, or email it to your
              accountant or bookkeeper. Every export and send is recorded on the audit trail.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => handleBrokerageExport("csv")}
                disabled={isBrokerageExportPending}
              >
                {isBrokerageExportPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                Download CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => handleBrokerageExport("pdf")}
                disabled={isBrokerageExportPending}
              >
                {isBrokerageExportPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                Download PDF
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="max-w-sm"
                value={reportRecipients}
                onChange={(e) => setReportRecipients(e.target.value)}
                placeholder="accountant@firm.com, bookkeeper@firm.com"
              />
              <Button size="sm" onClick={handleBrokerageEmail} disabled={isBrokerageEmailPending}>
                {isBrokerageEmailPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Email report
              </Button>
            </div>
            {brokerageNotice && <p className="text-xs text-green-700">{brokerageNotice}</p>}
            {brokerageError && <p className="text-xs text-destructive">{brokerageError}</p>}
          </CardContent>
        </Card>
      )}

      {/* P&L AI Summary Result */}
      {plSummary && (
        <Card className="border-purple-200 bg-purple-50/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-purple-800">
              <CheckCircle2 className="h-5 w-5 text-purple-600" />
              AI P&L Summary — {currentYear}
            </CardTitle>
            <CardDescription>
              GCI: {fmt(ytdCommissions)} &bull; Net: {fmt(ytdAgentNet)} &bull; Expenses: {fmt(ytdExpenses)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed text-foreground whitespace-pre-line">{plSummary}</p>
          </CardContent>
        </Card>
      )}

      {/* Recent Commission Records */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Recent Commission Records — {currentYear}
          </CardTitle>
          <CardDescription>Included in your downloadable report</CardDescription>
        </CardHeader>
        <CardContent>
          {commissions.length > 0 ? (
            <div className="space-y-2">
              {commissions.slice(0, 8).map((c) => (
                <div key={c.id} className="flex items-center justify-between p-3 border rounded-lg text-sm">
                  <div>
                    <p className="font-medium">
                      {c.close_date ? new Date(c.close_date).toLocaleDateString() : "—"}
                      {c.side ? ` (${c.side})` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      GCI: {fmt(c.gross_commission ?? 0)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-green-600">+{fmt(c.agent_commission ?? 0)}</p>
                    <p className="text-xs text-muted-foreground capitalize">{c.status ?? "—"}</p>
                  </div>
                </div>
              ))}
              {commissions.length > 8 && (
                <p className="text-xs text-center text-muted-foreground pt-2">
                  +{commissions.length - 8} more records in the CSV export
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-6">
              No commission records for {currentYear}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
