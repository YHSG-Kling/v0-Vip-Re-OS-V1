/**
 * app/api/voice/end-call/route.ts
 * POST /api/voice/end-call?callId=<twilioCallSid>
 * Terminates an active Twilio AI call and closes the voice_calls ledger row.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { endOutboundAiCall } from "@/lib/voice/twilio-outbound"

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Auth guard — user must be logged in
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const callId = searchParams.get("callId")

  if (!callId) {
    return NextResponse.json({ error: "callId query param is required" }, { status: 400 })
  }

  const service = createServiceClient()

  // Resolve the tenant that owns this call (vapi_call_id holds the Twilio CallSid
  // on this lane) so we hang up on the correct subaccount.
  const { data: call } = await service
    .from("voice_calls")
    .select("brokerage_id")
    .eq("vapi_call_id", callId)
    .maybeSingle()

  // End via Twilio REST. Non-fatal — Twilio may already have ended the call.
  if (call?.brokerage_id) {
    const ended = await endOutboundAiCall(service, call.brokerage_id, callId)
    if (!ended.ok) console.error("[end-call] Twilio hangup (non-fatal):", ended.error)
  }

  // Close our DB record
  await service
    .from("voice_calls")
    .update({
      status: "completed",
      outcome: "ended_by_agent",
      ended_at: new Date().toISOString(),
    })
    .eq("vapi_call_id", callId)

  return NextResponse.json({ success: true })
}
