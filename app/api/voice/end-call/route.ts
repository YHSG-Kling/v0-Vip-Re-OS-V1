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
  // supplying its CallSid (vendor_call_id holds the Twilio CallSid on this lane).
  const { data: call } = await service
    .from("voice_calls")
    .select("id, brokerage_id")
    .eq("vendor_call_id", callId)
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
  //
  // outcome was 'ended_by_agent', which voice_calls.outcome does not admit. It
  // is set in the SAME update as status and ended_at, so the whole update was
  // rejected: the agent hung up, Twilio ended the call, this route returned
  // success — and the ledger row stayed open with no ended_at, forever.
  //
  // 'completed' is the admitted disposition for a call that ran and ended
  // normally, and it matches the Twilio status callback, which closes every
  // terminated leg as completed and puts the real disposition in outcome. That
  // an agent ended it is implicit in this route being the agent's action.
  const { error: closeErr } = await service
    .from("voice_calls")
    .update({
      status: "completed",
      outcome: "completed",
      ended_at: new Date().toISOString(),
    })
    .eq("vendor_call_id", callId)
    .eq("brokerage_id", brokerageId)

  if (closeErr) {
    // Twilio has already hung up; the ledger is what failed. Say so rather than
    // reporting a success that leaves the row open.
    console.error("[end-call] ledger close failed:", closeErr.message)
    return NextResponse.json(
      { success: false, error: "Call ended, but the record could not be closed." },
      { status: 500 },
    )
  }

  return NextResponse.json({ success: true })
}
