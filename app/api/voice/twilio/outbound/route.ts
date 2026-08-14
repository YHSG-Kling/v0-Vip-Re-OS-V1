import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveInboundContext, validateTwilioSignature } from "@/lib/voice/twilio-voice"
import { buildOutboundPrompt, twimlGatherTurn, twimlHangup, appendTranscript } from "@/lib/voice/reception-brain"
import { decodeOutboundBrief, composeVoicemailMessage } from "@/lib/voice/twilio-outbound"

export const dynamic = "force-dynamic"

const xml = (body: string, status = 200) => new NextResponse(body, { status, headers: { "Content-Type": "text/xml" } })

/**
 * TWILIO VOICE — OUTBOUND ANSWER. Fires when an outbound AI call connects.
 * The tenant is resolved by the FROM number (ours); the session is the
 * voice_calls row placed at dial time (by CallSid), whose ai_notes carries the
 * call brief. A machine answer gets an HONEST voicemail (identifies the AI +
 * office, no fake human); a human gets the opener + the same turn loop as
 * every other scope (<Gather> → /turn).
 */
export async function POST(request: NextRequest) {
  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [k, v] of form.entries()) params[k] = String(v)

  const svc = createServiceClient()
  const from = params.From ?? "" // OUR number on an outbound leg
  const callSid = params.CallSid ?? ""
  const answeredBy = (params.AnsweredBy ?? "").toLowerCase()

  const ctx = await resolveInboundContext(svc, from)
  if (!ctx) return xml(twimlHangup("Sorry, something went wrong. Goodbye."))

  const url = `${(process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")}/api/voice/twilio/outbound`
  if (!validateTwilioSignature(ctx.authToken, url, params, request.headers.get("x-twilio-signature"))) {
    return new NextResponse("invalid signature", { status: 403 })
  }

  const { data: call } = await svc.from("voice_calls").select("id, ai_notes, transcription")
    .eq("vendor_call_id", callSid).maybeSingle()
  const brief = decodeOutboundBrief((call as any)?.ai_notes)
  if (!call || !brief) {
    // No session row / foreign call — never improvise an unscripted AI call.
    return xml(twimlHangup("Sorry, this call can't continue. Goodbye."))
  }

  // Machine answered → honest voicemail, ledger closed as voicemail.
  // The recording announcement in that voicemail is DERIVED from the brokerage's
  // actual recording posture, never hardcoded: Twilio's Record parameter (armed
  // at dial time in lib/voice/twilio-outbound.ts) captures this AMD leg too, so
  // a fixed `recorded: false` here would be the one spoken line in the system
  // that contradicts what is actually happening. See lib/voice/call-recording.ts.
  if (answeredBy.startsWith("machine")) {
    const { resolveCallRecordingPolicy } = await import("@/lib/voice/call-recording")
    const recordingPolicy = await resolveCallRecordingPolicy(svc, ctx.brokerageId)
    const vm = composeVoicemailMessage(brief, ctx.identity.brokerageName, { recorded: recordingPolicy.enabled })
    await svc.from("voice_calls").update({
      status: "completed", outcome: "voicemail", ended_at: new Date().toISOString(),
      transcription: appendTranscript(null, null, vm),
    }).eq("id", (call as any).id).then(undefined, () => {})
    return xml(twimlHangup(vm))
  }

  const { firstMessage } = buildOutboundPrompt(ctx.identity, {
    objective: brief.objective, contactName: brief.contactName, extraSystemPrompt: brief.systemPrompt,
  })
  const opener = brief.firstMessage ? appendDisclosedOpener(brief.firstMessage, firstMessage) : firstMessage
  await svc.from("voice_calls").update({
    status: "in_progress",
    transcription: appendTranscript((call as any).transcription, null, opener),
  }).eq("id", (call as any).id).then(undefined, () => {})

  return xml(twimlGatherTurn(opener, url.replace(/\/outbound$/, "/turn")))
}

/** A custom opener still leads with the legally-disclosed line — the brief's
 *  text follows it, never replaces it. */
function appendDisclosedOpener(custom: string, disclosed: string): string {
  return `${disclosed} ${custom}`.slice(0, 550)
}
