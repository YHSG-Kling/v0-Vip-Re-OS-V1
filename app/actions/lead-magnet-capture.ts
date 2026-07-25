"use server"

import { captureFormSubmission } from "@/lib/kernel/lead-magnets"

interface CaptureFormInput {
  formId: string
  brokerageId: string
  source?: string
  tcpaConsentGiven?: boolean
  submissionData: Record<string, unknown>
}

/**
 * Public lead-magnet capture. Delegates to the ONE kernel command
 * (captureFormSubmission) so a submission from /lm/[slug] runs the FULL flow —
 * contact match/create, magnet delivery, agent notification (in-app + email),
 * manager handoff, and follow-up sequence enrollment — instead of the bare
 * form_submissions insert this action used to do (which left the whole flow
 * dark: "nothing works together"). The kernel validates the form + brokerage
 * scope itself.
 */
export async function captureFormSubmissionAction(input: CaptureFormInput) {
  try {
    const result = await captureFormSubmission({
      formId: input.formId,
      brokerageId: input.brokerageId,
      submissionData: input.submissionData,
      source: input.source ?? "website",
      tcpaConsentGiven: input.tcpaConsentGiven ?? false,
    })
    if (!result.success) return { success: false, error: result.error ?? "Submission failed" }
    return { success: true, submissionId: result.submissionId, contactId: result.contactId }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "Submission failed" }
  }
}
