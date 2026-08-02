"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sparkles, AlertCircle, CheckCircle, Loader2, ShieldCheck, FileText, Layers, Filter } from "lucide-react"
import {
  evaluateCompliance,
  evaluateCategory,
  batchEvaluate,
  getComplianceReport,
} from "@/app/actions/content-compliance"
import {
  evaluateContentApproval,
  checkApprovalAuthority,
} from "@/app/actions/content-approval-workflow"
import { useAuth } from "@/lib/auth/client"

interface Violation {
  rule_id: string
  rule_name: string
  severity: "critical" | "high" | "medium" | "low"
  message: string
}

interface ComplianceVerdict {
  status: "pass" | "fail" | "review_required"
  overall_score: number
  violations: Violation[]
  recommendations: string[]
}

interface ApprovalRouting {
  approval_status: "approved" | "pending" | "rejected"
  required_approvers: string[]
  blocking_reason?: string
  approval_notes: string[]
  auto_approved: boolean
  /** Whether the signed-in user's own role can clear this content. */
  can_self_approve: boolean | null
}

/** UserRole → the four roles the approval engine understands. */
function toApproverRole(role: string | undefined): "agent" | "team_lead" | "broker" | "compliance_officer" {
  switch (role) {
    case "broker":
    case "broker_owner":
    case "admin":
    case "superadmin":
      return "broker"
    case "team_lead":
      return "team_lead"
    case "compliance_officer":
      return "compliance_officer"
    default:
      return "agent"
  }
}

/** One row of a bulk run — `batchEvaluate` returns a verdict per input. */
interface BatchRow {
  preview: string
  status: ComplianceVerdict["status"]
  score: number
  violationCount: number
}

/** Content pieces in bulk mode are separated by a blank line. */
const BULK_SEPARATOR = /\n\s*\n/
const BULK_MAX = 50

export function AIComplianceReviewPanel() {
  const { role } = useAuth()
  const [content, setContent] = useState("")
  const [contentType, setContentType] = useState("email")
  const [channelIntent, setChannelIntent] = useState("marketing")
  const [verdict, setVerdict] = useState<ComplianceVerdict | null>(null)
  const [routing, setRouting] = useState<ApprovalRouting | null>(null)
  const [routingError, setRoutingError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  // Category deep-dive — evaluateCategory runs ONE rule family against the same
  // content, so an author who already knows the verdict can see exactly which
  // regulatory / brokerage / brand / AI-safety rules fired without re-reading
  // the whole list.
  const [category, setCategory] = useState<"regulatory" | "brokerage" | "brand" | "ai_safety">("regulatory")
  const [categoryViolations, setCategoryViolations] = useState<Violation[] | null>(null)
  const [categoryError, setCategoryError] = useState<string | null>(null)
  const [categoryPending, startCategory] = useTransition()

  // Text report — getComplianceReport re-evaluates and returns the formatted,
  // human-readable verdict a compliance officer can paste into a file note.
  const [report, setReport] = useState<string | null>(null)
  const [reportError, setReportError] = useState<string | null>(null)
  const [reportPending, startReport] = useTransition()

  // Bulk mode — a batch of drafts (captions, blurbs, a drip sequence) checked in
  // one pass via batchEvaluate.
  const [bulkMode, setBulkMode] = useState(false)
  const [batchRows, setBatchRows] = useState<BatchRow[] | null>(null)
  const [batchError, setBatchError] = useState<string | null>(null)
  const [batchPending, startBatch] = useTransition()

  const bulkPieces = content
    .split(BULK_SEPARATOR)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)

  const handleEvaluate = () => {
    if (!content.trim()) return

    startTransition(async () => {
      setRouting(null)
      setRoutingError(null)
      setCategoryViolations(null)
      setCategoryError(null)
      setReport(null)
      setReportError(null)

      const result = await evaluateCompliance({
        raw_content: content,
        content_type: contentType,
        channel_intent: channelIntent,
      })

      if (!result.success || !result.verdict) {
        setVerdict(null)
        setRoutingError(result.error ?? "Compliance evaluation failed")
        return
      }

      const complianceVerdict = result.verdict as unknown as ComplianceVerdict
      setVerdict(complianceVerdict)

      // Compliance is only half the gate — the OS still has to decide WHO can
      // release this content. Routing the verdict through the approval engine with
      // log_signal is what puts an `approval_required` row in front of the
      // approver on /dashboard/content/approvals; without it that queue is fed by
      // nothing and reads empty forever.
      const draft = {
        content_type: contentType,
        channel_intent: channelIntent,
        raw_content: content,
        source_inputs: { origin: "compliance_review_panel" },
        generated_at: new Date().toISOString(),
      }
      const approvalContext = {
        requester_role: toApproverRole(role),
        // Pasted into the review box by a human, and reviewed here because it is
        // going out to an audience — not a private template render.
        content_origin: "human_custom" as const,
        audience_scope: "public" as const,
      }

      const [decisionRes, authorityRes] = await Promise.all([
        evaluateContentApproval({
          draft,
          complianceVerdict: result.verdict as any,
          context: approvalContext,
          log_signal: true,
        }),
        checkApprovalAuthority({
          user_role: toApproverRole(role),
          draft,
          complianceVerdict: result.verdict as any,
          context: approvalContext,
        }),
      ])

      if (!decisionRes.success || !decisionRes.decision) {
        setRoutingError(decisionRes.error ?? "Approval routing failed")
        return
      }

      setRouting({
        approval_status: decisionRes.decision.approval_status,
        required_approvers: decisionRes.decision.required_approvers ?? [],
        blocking_reason: decisionRes.decision.blocking_reason,
        approval_notes: decisionRes.decision.approval_notes ?? [],
        auto_approved: decisionRes.decision.metadata.auto_approved,
        can_self_approve: authorityRes.success ? (authorityRes.has_authority ?? null) : null,
      })
      if (!authorityRes.success) {
        setRoutingError(authorityRes.error ?? "Could not check your approval authority")
      }
    })
  }

  /** Run ONE rule family against the content currently in the box. */
  const handleCategory = () => {
    if (!content.trim()) return
    startCategory(async () => {
      setCategoryError(null)
      const categoryResult = await evaluateCategory(
        { raw_content: content, content_type: contentType, channel_intent: channelIntent },
        category,
      )
      if (!categoryResult.success) {
        setCategoryViolations(null)
        setCategoryError(categoryResult.error ?? "Category evaluation failed")
        return
      }
      setCategoryViolations((categoryResult.violations ?? []) as Violation[])
    })
  }

  /** Produce the formatted, human-readable verdict for the file note. */
  const handleReport = () => {
    if (!content.trim()) return
    startReport(async () => {
      setReportError(null)
      const reportResult = await getComplianceReport({
        raw_content: content,
        content_type: contentType,
        channel_intent: channelIntent,
      })
      if (!reportResult.success || !reportResult.report) {
        setReport(null)
        setReportError(reportResult.error ?? "Report generation failed")
        return
      }
      setReport(reportResult.report)
    })
  }

  /** Check every blank-line-separated draft in the box in a single pass. */
  const handleBatch = () => {
    if (bulkPieces.length === 0) return
    startBatch(async () => {
      setBatchError(null)
      const batchResult = await batchEvaluate(
        bulkPieces.map((piece) => ({
          raw_content: piece,
          content_type: contentType,
          channel_intent: channelIntent,
        })),
        // Persist the batch — a bulk sweep is exactly the evidence a broker
        // wants in the evaluation history, not a throwaway.
        { log_to_activities: true },
      )
      if (!batchResult.success || !batchResult.results) {
        setBatchRows(null)
        setBatchError(batchResult.error ?? "Bulk evaluation failed")
        return
      }
      setBatchRows(
        batchResult.results.map((row) => {
          const rowVerdict = row.verdict as unknown as ComplianceVerdict
          return {
            preview: row.input.raw_content.slice(0, 80),
            status: rowVerdict.status,
            score: rowVerdict.overall_score,
            violationCount: rowVerdict.violations?.length ?? 0,
          }
        }),
      )
    })
  }

  const severityColors = {
    critical: "bg-destructive text-destructive-foreground",
    high: "bg-orange-500 text-white",
    medium: "bg-yellow-500 text-yellow-950",
    low: "bg-blue-500 text-white",
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="h-5 w-5 text-muted-foreground" />
          AI Compliance Review
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Select value={contentType} onValueChange={setContentType}>
            <SelectTrigger>
              <SelectValue placeholder="Content Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="email">Email</SelectItem>
              <SelectItem value="sms">SMS</SelectItem>
              <SelectItem value="social_post">Social Post</SelectItem>
              <SelectItem value="listing_description">Listing Description</SelectItem>
              <SelectItem value="marketing_flyer">Marketing Flyer</SelectItem>
            </SelectContent>
          </Select>
          <Select value={channelIntent} onValueChange={setChannelIntent}>
            <SelectTrigger>
              <SelectValue placeholder="Channel Intent" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="marketing">Marketing</SelectItem>
              <SelectItem value="transactional">Transactional</SelectItem>
              <SelectItem value="follow_up">Follow Up</SelectItem>
              <SelectItem value="cold_outreach">Cold Outreach</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Textarea
          placeholder={
            bulkMode
              ? "Paste several drafts, separated by a blank line — each one is checked on its own..."
              : "Paste content to check for compliance issues..."
          }
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="min-h-[100px]"
        />

        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-xs h-7 px-2"
            onClick={() => {
              setBulkMode(!bulkMode)
              setBatchRows(null)
              setBatchError(null)
            }}
          >
            <Layers className="mr-1.5 h-3.5 w-3.5" />
            {bulkMode ? "Single draft" : "Bulk check"}
          </Button>
          {bulkMode && (
            <span className="text-xs text-muted-foreground">
              {bulkPieces.length} draft{bulkPieces.length === 1 ? "" : "s"}
              {bulkPieces.length > BULK_MAX ? ` — max ${BULK_MAX} per batch` : ""}
            </span>
          )}
        </div>

        {bulkMode ? (
          <Button
            onClick={handleBatch}
            disabled={batchPending || bulkPieces.length === 0 || bulkPieces.length > BULK_MAX}
            className="w-full"
          >
            {batchPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Checking {bulkPieces.length} drafts...
              </>
            ) : (
              <>
                <Layers className="mr-2 h-4 w-4" />
                Check {bulkPieces.length || ""} Drafts
              </>
            )}
          </Button>
        ) : (
          <Button onClick={handleEvaluate} disabled={isPending || !content.trim()} className="w-full">
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Check Compliance
              </>
            )}
          </Button>
        )}

        {/* Bulk results — one row per draft. */}
        {bulkMode && batchRows && (
          <div className="space-y-2 pt-2 border-t">
            <p className="text-xs font-medium text-muted-foreground">
              {batchRows.filter((r) => r.status === "pass").length} of {batchRows.length} passed
            </p>
            {batchRows.map((row, i) => (
              <div key={i} className="flex items-start justify-between gap-2 text-xs">
                <span className="text-muted-foreground truncate">{row.preview}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  {row.violationCount > 0 && (
                    <Badge variant="outline" className="text-[10px]">
                      {row.violationCount}
                    </Badge>
                  )}
                  <Badge
                    className={
                      row.status === "pass"
                        ? "bg-green-500 text-white text-[10px]"
                        : row.status === "fail"
                        ? "bg-destructive text-destructive-foreground text-[10px]"
                        : "bg-orange-500 text-white text-[10px]"
                    }
                  >
                    {row.score}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        )}

        {bulkMode && batchError && <p className="text-xs text-destructive">{batchError}</p>}

        {!bulkMode && verdict && (
          <div className="space-y-3 pt-2 border-t">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {verdict.status === "pass" ? (
                  <CheckCircle className="h-5 w-5 text-green-600" />
                ) : (
                  <AlertCircle className="h-5 w-5 text-destructive" />
                )}
                <span className="font-medium">
                  {verdict.status === "pass" ? "Content Approved" : verdict.status === "fail" ? "Issues Found" : "Review Required"}
                </span>
              </div>
              <Badge className={verdict.status === "pass" ? "bg-green-500 text-white" : "bg-destructive text-destructive-foreground"}>
                Score: {verdict.overall_score}/100
              </Badge>
            </div>

            {verdict.violations.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Issues Detected:</p>
                {verdict.violations.slice(0, 3).map((v, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <Badge className={`${severityColors[v.severity]} text-[10px] shrink-0`}>
                      {v.severity}
                    </Badge>
                    <span className="text-muted-foreground">{v.message}</span>
                  </div>
                ))}
              </div>
            )}

            {verdict.recommendations.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Recommendations:</p>
                <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
                  {verdict.recommendations.slice(0, 3).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Approval routing — who has to clear this before it can go out */}
            {routing && (
              <div className="space-y-2 pt-2 border-t">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">
                    {routing.approval_status === "approved"
                      ? routing.auto_approved
                        ? "Auto-approved"
                        : "Approved"
                      : routing.approval_status === "rejected"
                      ? "Rejected — cannot be sent"
                      : "Approval required"}
                  </span>
                </div>

                {routing.blocking_reason && (
                  <p className="text-xs text-destructive">{routing.blocking_reason}</p>
                )}

                {routing.required_approvers.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Needs sign-off from:{" "}
                    {routing.required_approvers.map((a) => a.replace(/_/g, " ")).join(", ")}
                  </p>
                )}

                {routing.can_self_approve !== null && routing.approval_status === "pending" && (
                  <p className="text-xs text-muted-foreground">
                    {routing.can_self_approve
                      ? "Your role can approve this yourself."
                      : "Your role cannot approve this — it is queued in Content Approvals."}
                  </p>
                )}

                {routing.approval_notes.length > 0 && (
                  <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
                    {routing.approval_notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}

        {routingError && (
          <p className="text-xs text-destructive">{routingError}</p>
        )}

        {/* Category deep-dive + text report — only meaningful once there is a
            verdict on screen to drill into. */}
        {!bulkMode && verdict && (
          <div className="space-y-3 pt-2 border-t">
            <div className="flex items-center gap-2">
              <Select value={category} onValueChange={(v) => setCategory(v as typeof category)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Rule family" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="regulatory">Regulatory (fair housing, RESPA)</SelectItem>
                  <SelectItem value="brokerage">Brokerage policy</SelectItem>
                  <SelectItem value="brand">Brand voice</SelectItem>
                  <SelectItem value="ai_safety">AI safety</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0"
                onClick={handleCategory}
                disabled={categoryPending}
              >
                {categoryPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Filter className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0"
                onClick={handleReport}
                disabled={reportPending}
              >
                {reportPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileText className="mr-1.5 h-3.5 w-3.5" />
                )}
                Report
              </Button>
            </div>

            {categoryError && <p className="text-xs text-destructive">{categoryError}</p>}

            {categoryViolations && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {category.replace(/_/g, " ")} rules —{" "}
                  {categoryViolations.length === 0
                    ? "no violations"
                    : `${categoryViolations.length} violation${categoryViolations.length === 1 ? "" : "s"}`}
                </p>
                {categoryViolations.map((v, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <Badge className={`${severityColors[v.severity]} text-[10px] shrink-0`}>
                      {v.severity}
                    </Badge>
                    <span className="text-muted-foreground">{v.message}</span>
                  </div>
                ))}
              </div>
            )}

            {reportError && <p className="text-xs text-destructive">{reportError}</p>}

            {report && (
              <pre className="text-[11px] leading-relaxed whitespace-pre-wrap rounded-md bg-muted/50 p-3 max-h-60 overflow-auto">
                {report}
              </pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
