import { NextRequest, NextResponse } from "next/server"
import { captureFormSubmission, trackMagnetEvent, type CaptureFormSubmissionInput } from "@/lib/kernel/lead-magnets"

// POST /api/lead-magnets/submissions
// Input contract: CaptureFormSubmissionInput
// Output contract: CaptureFormSubmissionOutput
// Auth: NOT required — public-facing endpoint for form submitters (embeds
// OUTSIDE this app). The in-app twin for /lm/[slug] is
// app/actions/lead-magnet-capture.ts:captureFormSubmissionAction; both doors
// call the SAME two kernel commands with the same consent record and the same
// provenance (IP + UA), so a submission means the same thing whichever door it
// came through.
export async function POST(req: NextRequest) {
  try {
    const body: CaptureFormSubmissionInput = await req.json()

    if (!body.formId) {
      return NextResponse.json({ success: false, error: "formId is required" }, { status: 400 })
    }
    if (!body.brokerageId) {
      return NextResponse.json({ success: false, error: "brokerageId is required" }, { status: 400 })
    }
    if (!body.submissionData || typeof body.submissionData !== "object") {
      return NextResponse.json({ success: false, error: "submissionData is required" }, { status: 400 })
    }

    // TOMBSTONE (§1.1, 2026-09-03): the inline "TCPA consent required on a
    // valuation form" check that stood here MOVED INTO THE KERNEL —
    // lib/kernel/lead-magnets.ts:captureFormSubmission, right after the form's
    // is_active check — so the in-app door enforces it too. It was a rule only
    // this route knew, which meant the door the product actually uses recorded
    // consent-less valuation requests this one refused. The kernel's refusal
    // surfaces below as a 422 with the same error text.

    // Extract real IP + UA from request headers
    const ipAddress =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      undefined
    const userAgent = req.headers.get("user-agent") ?? undefined

    const result = await captureFormSubmission({
      ...body,
      ipAddress,
      userAgent,
    })

    if (!result.success) {
      return NextResponse.json(result, { status: 422 })
    }

    // Fire tracking event — non-blocking. brokerageId is asserted, not trusted:
    // trackMagnetEvent derives the tenant from the form row and refuses a
    // mismatch (captureFormSubmission already validated the pair above).
    trackMagnetEvent({
      magnetId: body.formId,
      brokerageId: body.brokerageId,
      eventType: "form_submit",
      contactId: result.contactId,
      ipAddress,
      userAgent,
      metadata: { source: body.source ?? "direct" },
    }).catch(() => {})

    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    console.error("[API] /api/lead-magnets/submissions:", err)
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    )
  }
}
