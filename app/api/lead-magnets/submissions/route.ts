import { NextRequest, NextResponse } from "next/server"
import { captureFormSubmission, trackMagnetEvent, type CaptureFormSubmissionInput } from "@/lib/kernel/lead-magnets"

// POST /api/lead-magnets/submissions
// Input contract: CaptureFormSubmissionInput
// Output contract: CaptureFormSubmissionOutput
// Auth: NOT required — public-facing endpoint for form submitters
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

    // Enforce TCPA consent on valuation/home-value forms
    const hasAddress = "property_address" in body.submissionData
    if (hasAddress && !body.tcpaConsentGiven) {
      return NextResponse.json(
        { success: false, error: "TCPA consent required for this form" },
        { status: 400 }
      )
    }

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

    // Fire tracking event — non-blocking
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
