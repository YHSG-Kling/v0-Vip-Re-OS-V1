/**
 * app/api/voice/end-call/route.ts
 * POST /api/voice/end-call?callId=<twilioCallSid>
 * Terminates an active Twilio AI call and closes the voice_calls ledger row.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { requireAuth } from "@/lib/kernel/api-auth"
import { endOutboundAiCall } from "@/lib/voice/twilio-outbound"

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Auth guard — session + resolved brokerage from the session (never the body).
  const authSupabase = await createClient()
  const auth = await requireAuth(authSupabase)
  if (!auth.ok) return auth.response
  const brokerageId = auth.brokerageId
  if (!brokerageId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const callId = searchParams.get("callId")

  if (!callId) {
    return NextResponse.json({ error: "callId query param is required" }, { status: 400 })
  }

  const service = createServiceClient()

  // TENANT SCOPE — the call must belong to the caller's brokerage. Without this
  // an authenticated user of tenant A could terminate tenant B's live call by
  // supplying its CallSid (vapi_call_id holds the Twilio CallSid on this lane).
  const { data: call } = await service
    .from("voice_calls")
    .select("id, brokerage_id")
    .eq("vapi_call_id", callId)
    .maybeSingle()

  if (!call) {
    return NextResponse.json({ error: "Call not found" }, { status: 404 })
  }
  if (call.brokerage_id !== brokerageId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  // End via Twilio REST on the OWNING tenant's subaccount. Non-fatal — Twilio
  // may already have ended the call.
  const ended = await endOutboundAiCall(service, brokerageId, callId)
  if (!ended.ok) console.error("[end-call] Twilio hangup (non-fatal):", ended.error)

  // Close our DB record — scoped to the owning brokerage.
  await service
    .from("voice_calls")
    .update({
      status: "completed",
      outcome: "ended_by_agent",
      ended_at: new Date().toISOString(),
    })
    .eq("vapi_call_id", callId)
    .eq("brokerage_id", brokerageId)

  return NextResponse.json({ success: true })
}
