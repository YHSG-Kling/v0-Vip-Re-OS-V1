"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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
  Scan,
  Save,
  ChevronDown,
  ChevronUp,
} from "lucide-react"
import {
  reviewTransactionDocuments,
  generateDocumentChecklist,
  extractContractTerms,
  applyContractExtraction,
} from "@/app/actions/ai-contract-review"

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

  // Contract extraction state
  const [extractOpen, setExtractOpen] = useState(false)
  const [contractText, setContractText] = useState("")
  const [extracting, setExtracting] = useState(false)
  const [extractResult, setExtractResult] = useState<any>(null)
  const [savingExtract, setSavingExtract] = useState(false)
  // Editable fields from extraction
  const [exPurchasePrice, setExPurchasePrice] = useState("")
  const [exEarnestMoney, setExEarnestMoney] = useState("")
  const [exInspectionDate, setExInspectionDate] = useState("")
  const [exAppraisalDate, setExAppraisalDate] = useState("")
  const [exFinancingDate, setExFinancingDate] = useState("")
  const [exClosingDate, setExClosingDate] = useState("")
  const [exBuyerName, setExBuyerName] = useState("")
  const [exSellerName, setExSellerName] = useState("")
  const [exPropertyAddress, setExPropertyAddress] = useState("")

  const selectedTx = transactions.find((t) => t.id === selectedTxId)

  async function handleExtract() {
    if (!selectedTxId || !contractText.trim()) return
    setExtracting(true)
    setExtractResult(null)
    try {
      const res = await extractContractTerms({
        contractText,
        transactionId: selectedTxId,
        agentId,
      })
      if (res.success && res.extracted) {
        setExtractResult(res.extracted)
        setExPurchasePrice(res.extracted.purchasePrice != null ? String(res.extracted.purchasePrice) : "")
        setExEarnestMoney(res.extracted.earnestMoneyAmount != null ? String(res.extracted.earnestMoneyAmount) : "")
        setExInspectionDate(res.extracted.inspectionDeadline ?? "")
        setExAppraisalDate(res.extracted.appraisalDeadline ?? "")
        setExFinancingDate(res.extracted.financingDeadline ?? "")
        setExClosingDate(res.extracted.closingDate ?? "")
        setExBuyerName(res.extracted.buyerName ?? "")
        setExSellerName(res.extracted.sellerName ?? "")
        setExPropertyAddress(res.extracted.propertyAddress ?? "")
      }
    } finally {
      setExtracting(false)
    }
  }

  async function handleSaveExtract() {
    if (!selectedTxId || !extractResult) return
    setSavingExtract(true)
    try {
      const res = await applyContractExtraction({
        transactionId: selectedTxId,
        agentId,
        extracted: {
          purchasePrice: exPurchasePrice ? Number(exPurchasePrice) : null,
          earnestMoneyAmount: exEarnestMoney ? Number(exEarnestMoney) : null,
          inspectionDeadline: exInspectionDate || null,
          appraisalDeadline: exAppraisalDate || null,
          financingDeadline: exFinancingDate || null,
          closingDate: exClosingDate || null,
          buyerName: exBuyerName || null,
          sellerName: exSellerName || null,
          propertyAddress: exPropertyAddress || null,
        },
      })
      if (res.success) {
        setExtractResult(null)
        setContractText("")
      }
    } finally {
      setSavingExtract(false)
    }
  }

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

      {/* ─── CONTRACT DATA EXTRACTION ─────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <button
            className="flex items-center justify-between w-full text-left"
            onClick={() => setExtractOpen((o) => !o)}
          >
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Scan className="h-4 w-4 text-primary" />
                Extract Contract Terms
              </CardTitle>
              <CardDescription className="mt-0.5 text-xs">
                Paste contract text → AI extracts purchase price, deadlines, and parties → auto-populates transaction record
              </CardDescription>
            </div>
            {extractOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </button>
        </CardHeader>
        {extractOpen && (
          <CardContent className="space-y-4">
            {!selectedTxId && (
              <p className="text-xs text-amber-600">Select a transaction above before extracting contract terms.</p>
            )}
            <div>
              <Label className="text-xs">Paste contract text below</Label>
              <Textarea
                value={contractText}
                onChange={(e) => setContractText(e.target.value)}
                placeholder="Paste the full text of the purchase agreement here…"
                rows={6}
                className="mt-1 text-xs font-mono resize-y"
              />
            </div>
            <Button
              onClick={handleExtract}
              disabled={!selectedTxId || !contractText.trim() || extracting}
              className="gap-1.5"
            >
              {extracting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scan className="h-4 w-4" />}
              Extract Terms
            </Button>

            {extractResult && (
              <div className="space-y-3 pt-2 border-t">
                <p className="text-sm font-medium">Extracted terms — review and edit before saving</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Purchase price</Label>
                    <Input value={exPurchasePrice} onChange={(e) => setExPurchasePrice(e.target.value)} placeholder="0" type="number" className="h-8 mt-1" />
                  </div>
                  <div>
                    <Label className="text-xs">Earnest money</Label>
                    <Input value={exEarnestMoney} onChange={(e) => setExEarnestMoney(e.target.value)} placeholder="0" type="number" className="h-8 mt-1" />
                  </div>
                  <div>
                    <Label className="text-xs">Inspection deadline</Label>
                    <Input value={exInspectionDate} onChange={(e) => setExInspectionDate(e.target.value)} type="date" className="h-8 mt-1" />
                  </div>
                  <div>
                    <Label className="text-xs">Appraisal deadline</Label>
                    <Input value={exAppraisalDate} onChange={(e) => setExAppraisalDate(e.target.value)} type="date" className="h-8 mt-1" />
                  </div>
                  <div>
                    <Label className="text-xs">Financing deadline</Label>
                    <Input value={exFinancingDate} onChange={(e) => setExFinancingDate(e.target.value)} type="date" className="h-8 mt-1" />
                  </div>
                  <div>
                    <Label className="text-xs">Closing date</Label>
                    <Input value={exClosingDate} onChange={(e) => setExClosingDate(e.target.value)} type="date" className="h-8 mt-1" />
                  </div>
                  <div>
                    <Label className="text-xs">Buyer name</Label>
                    <Input value={exBuyerName} onChange={(e) => setExBuyerName(e.target.value)} className="h-8 mt-1" />
                  </div>
                  <div>
                    <Label className="text-xs">Seller name</Label>
                    <Input value={exSellerName} onChange={(e) => setExSellerName(e.target.value)} className="h-8 mt-1" />
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-xs">Property address</Label>
                    <Input value={exPropertyAddress} onChange={(e) => setExPropertyAddress(e.target.value)} className="h-8 mt-1" />
                  </div>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <Button onClick={handleSaveExtract} disabled={savingExtract} className="gap-1.5">
                    {savingExtract ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save to Transaction + Create Milestones
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setExtractResult(null)}>Clear</Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Saving will update the transaction record and create milestone entries for each deadline.
                </p>
              </div>
            )}
          </CardContent>
        )}
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
