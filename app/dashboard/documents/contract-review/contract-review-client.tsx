"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Progress } from "@/components/ui/progress"
import {
  FileText,
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  ShieldCheck,
  ClipboardList,
} from "lucide-react"
import { reviewTransactionDocuments, generateDocumentChecklist } from "@/app/actions/ai-contract-review"

interface Transaction {
  id: string
  transaction_type: string | null
  status: string | null
  address: string | null
  close_date: string | null
  contact_id: string | null
}

interface Props {
  agentId: string
  agentState: string
  transactions: Transaction[]
}

type IssueLevel = "critical" | "warning" | "info"

interface ReviewIssue {
  type: IssueLevel
  description: string
  clause?: string
  recommendation?: string
}

function IssueBadge({ level }: { level: IssueLevel }) {
  const map: Record<IssueLevel, { label: string; cls: string }> = {
    critical: { label: "Critical", cls: "bg-red-100 text-red-700 border-red-200" },
    warning: { label: "Warning", cls: "bg-amber-100 text-amber-700 border-amber-200" },
    info: { label: "Info", cls: "bg-blue-100 text-blue-700 border-blue-200" },
  }
  const { label, cls } = map[level]
  return (
    <Badge variant="outline" className={`text-xs ${cls}`}>
      {label}
    </Badge>
  )
}

function IssueIcon({ level }: { level: IssueLevel }) {
  if (level === "critical") return <AlertTriangle className="h-4 w-4 text-red-600 shrink-0" />
  if (level === "warning") return <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
  return <Info className="h-4 w-4 text-blue-500 shrink-0" />
}

export function ContractReviewClient({ agentId, agentState, transactions }: Props) {
  const [selectedTxId, setSelectedTxId] = useState<string>("")
  const [reviewing, setReviewing] = useState(false)
  const [checklistLoading, setChecklistLoading] = useState(false)
  const [reviewResult, setReviewResult] = useState<any>(null)
  const [checklist, setChecklist] = useState<any>(null)
  const [activeTab, setActiveTab] = useState<"review" | "checklist">("review")

  const selectedTx = transactions.find((t) => t.id === selectedTxId)

  async function handleReview() {
    if (!selectedTxId) return
    setReviewing(true)
    setReviewResult(null)
    try {
      const res = await reviewTransactionDocuments({
        transactionId: selectedTxId,
        agentId,
        state: agentState,
      })
      setReviewResult(res)
    } finally {
      setReviewing(false)
    }
  }

  async function handleChecklist() {
    if (!selectedTxId || !selectedTx) return
    setChecklistLoading(true)
    setChecklist(null)
    try {
      const res = await generateDocumentChecklist({
        transactionId: selectedTxId,
        transactionType:
          selectedTx.transaction_type?.toLowerCase() === "sale" ? "sale" : "purchase",
        state: agentState,
        agentId,
      })
      if (res.success) setChecklist(res.checklist)
    } finally {
      setChecklistLoading(false)
    }
  }

  const allIssues: ReviewIssue[] = []
  if (reviewResult?.reviews) {
    for (const r of reviewResult.reviews) {
      const issues = r.issues ?? r.review?.issues ?? []
      for (const issue of issues) {
        allIssues.push({
          type: issue.severity ?? issue.type ?? "info",
          description: issue.description ?? issue.issue ?? "",
          clause: issue.clause,
          recommendation: issue.recommendation,
        })
      }
    }
  }

  const criticals = allIssues.filter((i) => i.type === "critical")
  const warnings = allIssues.filter((i) => i.type === "warning")
  const infos = allIssues.filter((i) => i.type === "info")

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Contract Review</h1>
        <p className="text-muted-foreground text-sm mt-1">
          AI-powered signature completeness check and compliance analysis
        </p>
      </div>

      {/* Transaction picker */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Select Transaction</CardTitle>
          <CardDescription>Choose an active transaction to review its documents</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Select value={selectedTxId} onValueChange={setSelectedTxId}>
            <SelectTrigger>
              <SelectValue placeholder="Pick a transaction…" />
            </SelectTrigger>
            <SelectContent>
              {transactions.length === 0 ? (
                <SelectItem value="__none" disabled>
                  No active transactions
                </SelectItem>
              ) : (
                transactions.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.address ?? t.id.slice(0, 8)} — {t.status ?? "active"}{" "}
                    {t.close_date
                      ? `(closes ${new Date(t.close_date).toLocaleDateString()})`
                      : ""}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>

          <div className="flex gap-2">
            <Button
              onClick={handleReview}
              disabled={!selectedTxId || reviewing}
              className="gap-1.5"
            >
              {reviewing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              Review Documents
            </Button>
            <Button
              variant="outline"
              onClick={handleChecklist}
              disabled={!selectedTxId || checklistLoading}
              className="gap-1.5"
            >
              {checklistLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ClipboardList className="h-4 w-4" />
              )}
              Required Docs Checklist
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Tab selector when both are loaded */}
      {(reviewResult || checklist) && (
        <div className="flex gap-2 border-b">
          <button
            onClick={() => setActiveTab("review")}
            className={`pb-2 px-1 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "review"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground"
            }`}
          >
            Review Results
          </button>
          <button
            onClick={() => setActiveTab("checklist")}
            className={`pb-2 px-1 text-sm font-medium border-b-2 transition-colors ${
              activeTab === "checklist"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground"
            }`}
          >
            Required Documents
          </button>
        </div>
      )}

      {/* Review results */}
      {activeTab === "review" && reviewResult && (
        <div className="space-y-4">
          {/* Summary strip */}
          {reviewResult.transactionSummary && (
            <div className="grid grid-cols-3 gap-4">
              <Card>
                <CardContent className="pt-4 pb-4">
                  <p className="text-xs text-muted-foreground">Docs Reviewed</p>
                  <p className="text-2xl font-bold tabular-nums">
                    {reviewResult.transactionSummary.documentsReviewed}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-4">
                  <p className="text-xs text-muted-foreground">Avg Score</p>
                  <p className="text-2xl font-bold tabular-nums">
                    {reviewResult.transactionSummary.averageScore}
                    <span className="text-sm font-normal text-muted-foreground">/100</span>
                  </p>
                  <Progress
                    value={reviewResult.transactionSummary.averageScore}
                    className="h-1 mt-1"
                  />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-4">
                  <p className="text-xs text-muted-foreground">Critical Issues</p>
                  <p
                    className={`text-2xl font-bold tabular-nums ${
                      reviewResult.transactionSummary.totalCriticalIssues > 0
                        ? "text-red-600"
                        : "text-emerald-600"
                    }`}
                  >
                    {reviewResult.transactionSummary.totalCriticalIssues}
                  </p>
                </CardContent>
              </Card>
            </div>
          )}

          {/* No issues */}
          {allIssues.length === 0 && (
            <Card>
              <CardContent className="pt-6 pb-6 text-center">
                <CheckCircle2 className="h-8 w-8 text-emerald-600 mx-auto mb-2" />
                <p className="font-medium">No issues found</p>
                <p className="text-sm text-muted-foreground">
                  {reviewResult.message ?? "All documents reviewed and appear complete."}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Issues grouped by severity */}
          {[
            { list: criticals, title: `Critical Issues (${criticals.length})` },
            { list: warnings, title: `Warnings (${warnings.length})` },
            { list: infos, title: `Notes (${infos.length})` },
          ]
            .filter((g) => g.list.length > 0)
            .map((group) => (
              <Card key={group.title}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">{group.title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {group.list.map((issue, i) => (
                    <div key={i} className="flex gap-3 p-3 rounded-lg border bg-muted/30">
                      <IssueIcon level={issue.type} />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium">{issue.description}</p>
                          {issue.clause && (
                            <span className="text-xs text-muted-foreground">§ {issue.clause}</span>
                          )}
                        </div>
                        {issue.recommendation && (
                          <p className="text-xs text-muted-foreground">{issue.recommendation}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
        </div>
      )}

      {/* Checklist */}
      {activeTab === "checklist" && checklist && (
        <div className="space-y-4">
          {checklist.upcomingDeadlines && checklist.upcomingDeadlines.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Upcoming Deadlines</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {checklist.upcomingDeadlines.map((d: any, i: number) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <span>{d.document}</span>
                    <Badge
                      variant="outline"
                      className={
                        d.daysRemaining <= 3
                          ? "text-red-700 border-red-200"
                          : d.daysRemaining <= 10
                          ? "text-amber-700 border-amber-200"
                          : "text-muted-foreground"
                      }
                    >
                      {d.daysRemaining}d
                    </Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {checklist.requiredDocuments && checklist.requiredDocuments.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Required Documents</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {checklist.requiredDocuments.map((doc: any, i: number) => {
                  const statusColor =
                    doc.status === "received"
                      ? "text-emerald-700 border-emerald-200"
                      : doc.status === "missing"
                      ? "text-red-700 border-red-200"
                      : "text-amber-700 border-amber-200"
                  return (
                    <div key={i} className="flex items-center justify-between gap-2 text-sm">
                      <div className="min-w-0">
                        <p className="font-medium truncate">{doc.name}</p>
                        {doc.notes && (
                          <p className="text-xs text-muted-foreground truncate">{doc.notes}</p>
                        )}
                      </div>
                      <Badge variant="outline" className={`text-xs whitespace-nowrap ${statusColor}`}>
                        {doc.status}
                      </Badge>
                    </div>
                  )
                })}
              </CardContent>
            </Card>
          )}

          {checklist.optionalDocuments && checklist.optionalDocuments.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Recommended (Optional)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {checklist.optionalDocuments.map((doc: any, i: number) => (
                  <div key={i} className="flex gap-2 text-sm">
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                    <div>
                      <p className="font-medium">{doc.name}</p>
                      {doc.reason && <p className="text-xs text-muted-foreground">{doc.reason}</p>}
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}
