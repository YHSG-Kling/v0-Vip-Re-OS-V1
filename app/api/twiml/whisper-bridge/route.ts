import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import { updateWhisperBridgeStatus } from "@/lib/voice/whisper-bridge-status"

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
    // ── voice_calls STATUS WRITEBACK ────────────────────────────────────────
    //
    // This used to call app/actions/voice-call-bridge.ts:updateWhisperBridgeStatus,
    // a "use server" export that gated on getAgentContext() — and a provider
    // webhook carries no user session, so that gate refused EVERY invocation
    // with { success: false, error: "Unauthorized" }. The refusal RESOLVED
    // (the §3 shape), the result was never read, and voice_calls.status stayed
    // "initiated" forever on every whispered call. The write now lives at
    // lib/voice/whisper-bridge-status.ts on this route's own authorization —
    // the Twilio signature verified above, service client, tenant resolved
    // from the call record — exactly the pattern the agent_heard stamp below
    // was built around the dead gate to use.
    const writeback = await updateWhisperBridgeStatus({
      callSid,
      status: callStatus,
      duration: callDuration ? parseInt(callDuration) : undefined,
      outcome: callStatus,
    })
    if (!writeback.success) {
      console.error("[whisper-bridge] status writeback refused — voice_calls keeps its last status:", writeback.error)
    }

    // ── DID THE AGENT ACTUALLY HEAR THE WHISPER? ────────────────────────────
    //
    // `call_whisper_logs.agent_heard` was READ BY CODE AND WRITTEN BY NOBODY
    // (census 1b) — app/dashboard/voice/review/[callId]/page.tsx:152 renders it
    // on the call review page. Unlike most of that census this one does not
    // render blank: the column carries a DDL DEFAULT of `true`, so the review
    // page asserted "the agent heard the briefing" on EVERY whispered call,
    // including calls the agent never picked up. A false claim on a review
    // surface is worse than an empty one.
    //
    // This is where the fact becomes known, and it is knowable exactly. The
    // TwiML above plays `<Say>{whisper}</Say>` on the AGENT'S leg BEFORE it
    // `<Dial>`s the contact, so the briefing is heard if and only if the agent
    // leg was ANSWERED. Twilio reports that in the terminal call status.
    //
    // AUTHORIZATION: the Twilio signature verified above is this request's
    // credential — stronger than a session for a caller that is not a browser.
    // This stamp was originally built AROUND the session-gated action this
    // route once called for the status writeback (that gate refused every
    // webhook invocation); both writes now ride the same
    // signature-then-service-client lane, the status half via
    // lib/voice/whisper-bridge-status.ts.
    const heard = agentAnsweredWhisper(callStatus, callDuration)
    if (heard !== null) {
      try {
        const { createServiceClient } = await import("@/lib/supabase/service")
        const svc = createServiceClient()
        // The whisper row hangs off voice_calls, which is keyed by the provider
        // call sid — the same pointer app/actions/voice-call-bridge.ts:114
        // stores when it places the bridge.
        const { data: call } = await svc
          .from("voice_calls")
          .select("id")
          .eq("vendor_call_id", callSid)
          .maybeSingle()
        if (call?.id) {
          const { error } = await svc
            .from("call_whisper_logs")
            .update({ agent_heard: heard })
            .eq("voice_call_id", (call as { id: string }).id)
          if (error) {
            console.error("[whisper-bridge] agent_heard NOT stamped — the review page keeps the DDL default 'true':", error.message)
          }
        }
      } catch (e: any) {
        console.error("[whisper-bridge] agent_heard stamp threw:", e?.message ?? e)
      }
    }
  }

  return new NextResponse("<Response></Response>", {
    headers: { "Content-Type": "text/xml" },
  })
}

/**
 * PURE: Twilio's terminal call status for the AGENT leg → did the agent hear
 * the whispered briefing?
 *
 * The whisper is the first verb in the TwiML, so an ANSWERED leg heard it and an
 * unanswered one did not. Twilio spells its statuses with hyphens
 * ("no-answer"); the rest of this codebase spells the same ladder with
 * underscores, so both are accepted rather than one silently falling through.
 *
 * Returns null for a NON-TERMINAL status (queued / initiated / ringing). Those
 * arrive before the outcome is decided, and writing `false` on a ringing
 * callback would then be overwritten — or worse, not overwritten — by the
 * terminal one. Undecided stays unwritten.
 */
// NOT exported: a Next.js route module may only export the HTTP verbs and the
// route config keys — anything else fails the generated route type check.
function agentAnsweredWhisper(status: string, durationRaw?: string | null): boolean | null {
  const s = (status ?? "").trim().toLowerCase().replace(/-/g, "_")
  if (["busy", "no_answer", "failed", "canceled", "cancelled"].includes(s)) return false
  if (s === "in_progress" || s === "answered") return true
  if (s === "completed") {
    // A "completed" leg with zero billed seconds never carried audio — Twilio
    // reports a hang-up-during-ring this way on some carriers.
    const seconds = durationRaw != null ? Number.parseInt(durationRaw, 10) : NaN
    if (Number.isFinite(seconds) && seconds <= 0) return false
    return true
  }
  return null // queued / initiated / ringing — not decided yet
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}
