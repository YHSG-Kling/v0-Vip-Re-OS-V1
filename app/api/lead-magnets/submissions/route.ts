import { NextRequest, NextResponse } from "next/server"
import { captureFormSubmission, trackMagnetEvent, type CaptureFormSubmissionInput } from "@/lib/kernel/lead-magnets"
import { LEAD_MAGNET_EMBED_CORS_HEADERS } from "@/lib/lead-magnets/embed-snippet"
import { checkPublicRateLimit } from "@/lib/security/public-rate-limit"

// THE EMBED IS THE OTHER HALF (lane 85E, census 6d): the lead-magnet library's
// "Embed on your site" control (app/components/features/lead-magnets/
// MagnetLibrary.tsx → lib/lead-magnets/embed-snippet.ts) hands a tenant the
// form that POSTs here from THEIR website. A JSON POST from another origin is
// preflighted, and this door answered no OPTIONS — so even a hand-written embed
// could never read its result. The preflight is answered, and every response
// carries the same headers (no credentials are admitted: the door has no
// session to protect; the kernel verifies the form/brokerage pair).
export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: LEAD_MAGNET_EMBED_CORS_HEADERS })
}

function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(LEAD_MAGNET_EMBED_CORS_HEADERS)) res.headers.set(k, v)
  return res
}

// POST /api/lead-magnets/submissions
// DOOR (census 6d, PUBLIC BY DESIGN): anonymous form-submission intake for
// embeds outside this app. AUTH MODEL: none — the submitter IS the lead;
// TCPA consent and real IP/UA provenance are enforced below.
// Input contract: CaptureFormSubmissionInput
// Output contract: CaptureFormSubmissionOutput
// Auth: NOT required — public-facing endpoint for form submitters (embeds
// OUTSIDE this app). The in-app twin for /lm/[slug] is
// app/actions/lead-magnet-capture.ts:captureFormSubmissionAction; both doors
// call the SAME two kernel commands with the same consent record and the same
// provenance (IP + UA), so a submission means the same thing whichever door it
// came through.
export async function POST(req: NextRequest) {
  return withCors(await handleSubmission(req))
}

async function handleSubmission(req: NextRequest): Promise<NextResponse> {
  // PUBLIC-WRITE THROTTLE (lane 138F readiness audit, P1): anonymous intake.
  // Inside handleSubmission so the 429 still carries the CORS headers.
  // Idiom: app/api/track/visitor/route.ts.
  const rateIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown"
  const rateVerdict = checkPublicRateLimit("lead-magnet-submit", rateIp, { limit: 20, windowMs: 10 * 60_000 })
  if (!rateVerdict.allowed) {
    return NextResponse.json({ success: false, error: "Too many submissions from this connection — try again shortly." }, { status: 429, headers: { "Retry-After": String(rateVerdict.retryAfterSeconds) } })
  }
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
