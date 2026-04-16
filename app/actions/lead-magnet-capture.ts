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
    // This prevents a client-supplied brokerageId from routing leads to the wrong tenant.
    const { data: form } = await supabase
      .from("lead_magnets")
      .select("id")
      .eq("id", input.formId)
      .eq("brokerage_id", input.brokerageId)
      .eq("status", "published")
      .maybeSingle()

    if (!form) {
      return { success: false, error: "Form not found or not published" }
    }

    const { data, error } = await supabase
      .from("lead_magnet_submissions")
      .insert({
        form_id: input.formId,
        brokerage_id: input.brokerageId,
        source: input.source ?? "website",
        tcpa_consent: input.tcpaConsentGiven ?? false,
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
