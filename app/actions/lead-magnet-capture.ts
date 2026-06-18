"use server"

import { createServiceClient } from "@/lib/supabase/service"

interface CaptureFormInput {
  formId: string
  brokerageId: string
  source?: string
  tcpaConsentGiven?: boolean
  submissionData: Record<string, unknown>
}

export async function captureFormSubmissionAction(input: CaptureFormInput) {
  try {
    const supabase = createServiceClient()

    // Validate the form exists and belongs to the claimed brokerage before accepting submission.
    // Query lead_capture_forms — the canonical table written by the kernel publishLeadMagnet
    // command. Checking is_active=true ensures only published/activated forms accept submissions.
    // This prevents a client-supplied brokerageId from routing leads to the wrong tenant.
    const { data: form } = await supabase
      .from("lead_capture_forms")
      .select("id, is_active")
      .eq("id", input.formId)
      .eq("brokerage_id", input.brokerageId)
      .eq("is_active", true)
      .maybeSingle()

    if (!form) {
      return { success: false, error: "Form not found or not active" }
    }

    const { data, error } = await supabase
      .from("form_submissions")
      .insert({
        form_id: input.formId,
        brokerage_id: input.brokerageId,
        source: input.source ?? "website",
        tcpa_consent_given: input.tcpaConsentGiven ?? false,
        submission_data: input.submissionData,
        submitted_at: new Date().toISOString(),
      })
      .select("id")
      .single()

    if (error) {
      console.error("[captureFormSubmission] insert error:", error)
      return { success: false, error: error.message }
    }

    return { success: true, submissionId: data?.id }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "Submission failed" }
  }
}
