import { NextRequest, NextResponse } from "next/server"

/**
 * TwiML Whisper Bridge Endpoint
 * Handles Twilio call flow: Whisper context to agent, then connect to contact
 */

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const contactPhone = searchParams.get("contactPhone")
  const whisper = searchParams.get("whisper")

  if (!contactPhone || !whisper) {
    return new NextResponse("Missing required parameters", { status: 400 })
  }

  // Generate TwiML to whisper context to agent, then dial contact
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${escapeXml(whisper)}</Say>
  <Dial>
    ${contactPhone}
  </Dial>
</Response>`

  return new NextResponse(twiml, {
    headers: {
      "Content-Type": "text/xml",
    },
  })
}

export async function POST(req: NextRequest) {
  // Handle Twilio status callbacks
  const formData = await req.formData()
  const callSid = formData.get("CallSid") as string
  const callStatus = formData.get("CallStatus") as string
  const callDuration = formData.get("CallDuration") as string

  // Update call status in database
  if (callSid && callStatus) {
    const { updateWhisperBridgeStatus } = await import("@/app/actions/voice-call-bridge")
    await updateWhisperBridgeStatus({
      callSid,
      status: callStatus,
      duration: callDuration ? parseInt(callDuration) : undefined,
      outcome: callStatus,
    })
  }

  return new NextResponse("<Response></Response>", {
    headers: { "Content-Type": "text/xml" },
  })
}

// Helper to escape XML special characters
function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}
