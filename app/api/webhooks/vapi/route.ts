import { NextRequest, NextResponse } from "next/server"
import { updateVapiCallStatus } from "@/app/actions/voice-call-bridge"
import { handleVapiCallComplete } from "@/app/actions/ai-isa"
import { verifyVapiSignature, dispatchVapiFunctionCall } from "@/lib/voice/vapi-function-tools"

/**
 * Vapi Webhook Handler — DEPRECATED-COMPATIBLE
 *
 * Kept as a thin endpoint so already-registered Vapi dashboard serverUrls
 * keep working during the consolidation window. The authoritative endpoint
 * is /api/voice/vapi-webhook — new dashboard registrations should point
 * there. All in-call function tool logic lives in
 * lib/voice/vapi-function-tools.ts (shared by both endpoints).
 *
 * Receives call status updates and transcripts from Vapi.ai.
 * Handles both voice-call-bridge and AI ISA calls.
 *
 * Signature: Vapi signs each request with HMAC-SHA256 of the raw body using
 * the secret set in the Vapi dashboard. The signature is sent as
 * `x-vapi-signature` (hex digest). If VAPI_WEBHOOK_SECRET is not set, the
 * endpoint REJECTS all requests — without this gate any caller could trigger
 * appointment booking, SMS to arbitrary phone numbers, and fake ISA call
 * completions (which mark contacts as qualified and trigger follow-ups).
 */

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text()
    const signatureHeader = req.headers.get("x-vapi-signature")
    if (!verifyVapiSignature(rawBody, signatureHeader)) {
      return NextResponse.json({ error: "Invalid or missing webhook signature" }, { status: 401 })
    }
    const payload = JSON.parse(rawBody)

    // Vapi webhook events: call.started, call.ended, call.transcribed, function-call, end-of-call-report
    const { type, call, functionCall } = payload

    // Handle function calls from Vapi (AI ISA booking appointments, etc.)
    if (type === "function-call" && functionCall) {
      const r = await dispatchVapiFunctionCall(functionCall, call)
      if (r) return r
    }

    // Handle end-of-call report (AI ISA)
    if (type === "end-of-call-report") {
      await handleVapiCallComplete(payload)
      return NextResponse.json({ success: true })
    }

    // Handle regular call status updates
    if (!call || !call.id) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
    }

    // Update call status in database (voice-call-bridge)
    await updateVapiCallStatus({
      callId: call.id,
      status: call.status || type.replace("call.", ""),
      transcript: call.transcript,
      outcome: call.metadata?.outcome,
      sentiment: call.analysis?.sentiment,
      durationSeconds: call.duration,
      costCents: call.cost ? Math.round(call.cost * 100) : undefined,
    })

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error("[Vapi Webhook] Error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
