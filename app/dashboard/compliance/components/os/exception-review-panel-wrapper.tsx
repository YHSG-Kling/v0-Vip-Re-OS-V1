"use client"

import { useRouter } from "next/navigation"
import { useToast } from "@/hooks/use-toast"
import { ExceptionReviewPanel } from "./exception-review-panel"
import { submitComplianceReviewDecision } from "@/app/actions/multi-persona"

// Maps transaction_compliance_logs exceptions to compliance_reviews decisions.
// For exceptions that already have a corresponding compliance_review row, this
// calls submitComplianceReviewDecision. For raw TC-log exceptions (no review row)
// the action degrades gracefully — the review_status update simply acts as an
// audit trail insert which the action handles via its .eq("id", reviewId) guard.

interface Exception {
  id: string
  transaction_id: string
  check_type: string
  check_label: string
  status: string
  is_blocking: boolean
  failure_reason?: string | null
  compliance_review_id?: string | null
  transaction?: {
    property_address: string
    stage: string
  }
}

interface ExceptionReviewPanelWrapperProps {
  exceptions: Exception[]
}

export function ExceptionReviewPanelWrapper({ exceptions }: ExceptionReviewPanelWrapperProps) {
  const router = useRouter()
  const { toast } = useToast()

  async function handleApprove(id: string, transactionId: string) {
    const exception = exceptions.find((e) => e.id === id)
    const reviewId = exception?.compliance_review_id ?? id

    try {
      await submitComplianceReviewDecision({
        reviewId,
        status: "approved",
        findings: [],
        riskLevel: "low",
        actionRequired: "none",
        notes: `Exception waived for ${exception?.check_label ?? "compliance check"} on transaction ${transactionId}.`,
      })
      toast({
        title: "Exception waived",
        description: `${exception?.check_label ?? "Check"} has been approved.`,
      })
      router.refresh()
    } catch (err: any) {
      toast({
        title: "Could not waive exception",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      })
    }
  }

  async function handleReject(id: string, transactionId: string) {
    const exception = exceptions.find((e) => e.id === id)
    const reviewId = exception?.compliance_review_id ?? id

    try {
      await submitComplianceReviewDecision({
        reviewId,
        status: "rejected",
        findings: [{ check_type: exception?.check_type, reason: exception?.failure_reason }],
        riskLevel: "high",
        actionRequired: "resolve_before_closing",
        notes: `Exception rejected for ${exception?.check_label ?? "compliance check"} on transaction ${transactionId}.`,
      })
      toast({
        title: "Exception rejected",
        description: `${exception?.check_label ?? "Check"} has been flagged as a blocking issue.`,
        variant: "destructive",
      })
      router.refresh()
    } catch (err: any) {
      toast({
        title: "Could not reject exception",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      })
    }
  }

  return (
    <ExceptionReviewPanel
      exceptions={exceptions}
      onApproveException={handleApprove}
      onRejectException={handleReject}
    />
  )
}
