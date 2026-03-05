/**
 * app/api/voice/end-call/route.ts
 * POST /api/voice/end-call?callId=<vapiCallId>
 * Terminates an active VAPI call and updates voice_calls status.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { endCall } from "@/lib/voice/vapi-client"

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

  // End via VAPI REST API
  try {
    await endCall(callId)
  } catch (err) {
    // Not a hard failure — VAPI may already have ended the call
    console.error("[end-call] VAPI endCall error (non-fatal):", err)
  }

  // Update our DB record
  const service = createServiceClient()
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
