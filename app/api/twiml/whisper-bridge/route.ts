import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"

/**
 * TwiML Whisper Bridge Endpoint
 * Handles Twilio call flow: Whisper context to agent, then connect to contact.
 * Both GET (TwiML generation) and POST (status callback) are Twilio-signed requests.
 */

function verifyTwilioSignature(
  req: NextRequest,
  params: Record<string, string>
): boolean {
  const secret = process.env.TWILIO_AUTH_TOKEN
  if (!secret) {
    console.error("[whisper-bridge] TWILIO_AUTH_TOKEN not set — rejecting")
    return false
  }
  const sig = req.headers.get("x-twilio-signature") ?? ""
  if (!sig) return false

  const url = req.url
  const sortedKeys = Object.keys(params).sort()
  let str = url
  for (const key of sortedKeys) {
    str += key + (params[key] ?? "")
  }
  const expected = crypto
    .createHmac("sha1", secret)
    .update(Buffer.from(str, "utf-8"))
    .digest("base64")
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const params: Record<string, string> = {}
  searchParams.forEach((v, k) => { params[k] = v })

  if (!verifyTwilioSignature(req, params)) {
    return new NextResponse("Unauthorized", { status: 401 })
  }

  const contactPhone = searchParams.get("contactPhone")
  const whisper = searchParams.get("whisper")

  if (!contactPhone || !whisper) {
    return new NextResponse("Missing required parameters", { status: 400 })
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${escapeXml(whisper)}</Say>
  <Dial>
    ${contactPhone}
  </Dial>
</Response>`

  return new NextResponse(twiml, {
    headers: { "Content-Type": "text/xml" },
  })
}

export async function POST(req: NextRequest) {
  const formData = await req.formData()
  const params: Record<string, string> = {}
  formData.forEach((v, k) => { params[k] = String(v) })

  if (!verifyTwilioSignature(req, params)) {
    return new NextResponse("<Response></Response>", {
      headers: { "Content-Type": "text/xml" },
      status: 401,
    })
  }

  const callSid = params["CallSid"]
  const callStatus = params["CallStatus"]
  const callDuration = params["CallDuration"]

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

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}
