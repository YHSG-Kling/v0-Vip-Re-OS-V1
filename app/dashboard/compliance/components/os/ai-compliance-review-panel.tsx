"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sparkles, AlertCircle, CheckCircle, Loader2, ShieldCheck } from "lucide-react"
import { evaluateCompliance } from "@/app/actions/content-compliance"
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

export function AIComplianceReviewPanel() {
  const { role } = useAuth()
  const [content, setContent] = useState("")
  const [contentType, setContentType] = useState("email")
  const [channelIntent, setChannelIntent] = useState("marketing")
  const [verdict, setVerdict] = useState<ComplianceVerdict | null>(null)
  const [routing, setRouting] = useState<ApprovalRouting | null>(null)
  const [routingError, setRoutingError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const handleEvaluate = () => {
    if (!content.trim()) return

    startTransition(async () => {
      setRouting(null)
      setRoutingError(null)

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
          placeholder="Paste content to check for compliance issues..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="min-h-[100px]"
        />

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

        {verdict && (
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
      </CardContent>
    </Card>
  )
}
