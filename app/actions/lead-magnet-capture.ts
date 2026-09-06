"use server"

import { headers } from "next/headers"
import { captureFormSubmission, trackMagnetEvent } from "@/lib/kernel/lead-magnets"

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
 *
 * TWIN OF app/api/lead-magnets/submissions/route.ts (§1.1, 2026-09-03). That
 * route is kept for embeds OUTSIDE the app; this action is the in-app door
 * /lm/[slug] uses. The route had two things this door lacked, and they were
 * merged here rather than the other way round:
 *   · PROVENANCE — IP + user-agent from the request headers, recorded on
 *     form_submissions.ip_address / user_agent. A server action sees the same
 *     headers through next/headers; without them every in-app submission's
 *     provenance was NULL while the API's was real, and a TCPA consent record
 *     with no IP behind it is a weaker record.
 *   · The form_submit tracking event (trackMagnetEvent), which is where
 *     getMagnetPerformance counts submissions from — so in-app submissions were
 *     invisible to the magnet's own performance dashboard.
 * The TCPA-on-valuation-form rule the route also carried moved into the kernel
 * command itself (lib/kernel/lead-magnets.ts:captureFormSubmission), so both
 * doors refuse the same submission with the same words.
 */
export async function captureFormSubmissionAction(input: CaptureFormInput) {
  try {
    // Provenance from the request the browser made to invoke this action.
    let ipAddress: string | undefined
    let userAgent: string | undefined
    try {
      const h = await headers()
      ipAddress =
        h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        h.get("x-real-ip") ??
        undefined
      userAgent = h.get("user-agent") ?? undefined
    } catch {
      // Outside a request scope (a script) there are no headers; the capture
      // still runs, with no provenance rather than a fabricated one.
    }

    const result = await captureFormSubmission({
      formId: input.formId,
      brokerageId: input.brokerageId,
      submissionData: input.submissionData,
      source: input.source ?? "website",
      tcpaConsentGiven: input.tcpaConsentGiven ?? false,
      ipAddress,
      userAgent,
    })
    if (!result.success) return { success: false, error: result.error ?? "Submission failed" }

    // Same tracking event the API door fires — non-blocking. brokerageId is
    // asserted, not trusted: trackMagnetEvent derives the tenant from the form
    // row (captureFormSubmission already validated the pair).
    trackMagnetEvent({
      magnetId: input.formId,
      brokerageId: input.brokerageId,
      eventType: "form_submit",
      contactId: result.contactId,
      ipAddress,
      userAgent,
      metadata: { source: input.source ?? "website" },
    }).catch(() => {})

    return { success: true, submissionId: result.submissionId, contactId: result.contactId }
  } catch (err: any) {
    return { success: false, error: err?.message ?? "Submission failed" }
  }
}
