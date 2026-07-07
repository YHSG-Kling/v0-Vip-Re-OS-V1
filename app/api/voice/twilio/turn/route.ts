import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveInboundContext, validateTwilioSignature, planReceptionTurn } from "@/lib/voice/twilio-voice"
import { twimlGatherTurn, twimlTransfer, twimlHangup, appendTranscript } from "@/lib/voice/reception-brain"

export const dynamic = "force-dynamic"

/**
 * TWILIO VOICE — TURN. Each caller utterance arrives here (SpeechResult).
 * The voice_calls row (by CallSid) is the session: transcript in, plan out.
 * Actions reuse the SAME rails as every other engine: booking creates the
 * scheduled showing, transfer dials the human, hangup closes + completes the
 * ledger (call intelligence + the showing lifecycle take it from there).
 */
export async function POST(request: NextRequest) {
  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [k, v] of form.entries()) params[k] = String(v)

  const svc = createServiceClient()
  const to = params.To ?? ""
  const callSid = params.CallSid ?? ""
  const speech = (params.SpeechResult ?? "").trim()
  const ctx = await resolveInboundContext(svc, to)
  if (!ctx) return new NextResponse(twimlHangup("Sorry, something went wrong. Goodbye."), { headers: { "Content-Type": "text/xml" } })

  const url = `${(process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")}/api/voice/twilio/turn`
  if (!validateTwilioSignature(ctx.authToken, url, params, request.headers.get("x-twilio-signature"))) {
    return new NextResponse("invalid signature", { status: 403 })
  }

  const { data: call } = await svc.from("voice_calls").select("id, contact_id, agent_id, transcription")
    .eq("vapi_call_id", callSid).maybeSingle()
  const transcript = (call as any)?.transcription ?? null

  // Silence (Gather timed out with nothing) → one gentle retry then goodbye.
  if (!speech) {
    const closer = "No problem — call back any time. Goodbye!"
    if (call) await finishCall(svc, (call as any).id, appendTranscript(transcript, null, closer))
    return new NextResponse(twimlHangup(closer), { headers: { "Content-Type": "text/xml" } })
  }

  const plan = await planReceptionTurn(ctx, transcript, speech)
  const newTranscript = appendTranscript(transcript, speech, plan.say)
  if (call) {
    await svc.from("voice_calls").update({ transcription: newTranscript }).eq("id", (call as any).id).then(undefined, () => {})
  }

  // ── Actions on the SAME rails as every other engine ────────────────────────
  if (plan.action.kind === "transfer" && ctx.forwardNumber) {
    if (call) await finishCall(svc, (call as any).id, newTranscript, "transferred")
    return new NextResponse(twimlTransfer(plan.say, ctx.forwardNumber), { headers: { "Content-Type": "text/xml" } })
  }
  if (plan.action.kind === "book" && call && (call as any).contact_id && (call as any).agent_id) {
    try {
      const when = new Date(plan.action.dateTime)
      await svc.from("showings").insert({
        contact_id: (call as any).contact_id, agent_id: (call as any).agent_id,
        brokerage_id: ctx.brokerageId,
        scheduled_at: when.toISOString(),
        scheduled_date: when.toISOString().slice(0, 10),
        scheduled_time: when.toISOString().slice(11, 19),
        duration_minutes: 30, status: "scheduled", is_confirmed: true,
        confirmed_at: new Date().toISOString(),
        scheduling_method: "self_book", notes: "Booked by the AI receptionist on a live call (Twilio lane).",
        listing_id: null,
      }).then(undefined, () => {})
      if (ctx.agentUserId) {
        await svc.from("notifications").insert({
          user_id: ctx.agentUserId, brokerage_id: ctx.brokerageId, type: "showing_self_booked",
          title: "The AI receptionist booked an appointment on a live call",
          body: `${when.toLocaleString()} — booked during an inbound call. Transcript is on the call record.`,
          entity_type: "voice_call", entity_id: (call as any).id, priority: "high", channel: "in_app", is_read: false,
        }).then(undefined, () => {})
      }
    } catch { /* the spoken confirmation stands; the agent sees the transcript */ }
  }
  if (plan.action.kind === "hangup") {
    if (call) await finishCall(svc, (call as any).id, newTranscript)
    return new NextResponse(twimlHangup(plan.say), { headers: { "Content-Type": "text/xml" } })
  }

  return new NextResponse(twimlGatherTurn(plan.say, url), { headers: { "Content-Type": "text/xml" } })
}

async function finishCall(svc: any, callId: string, transcript: string, outcome = "completed"): Promise<void> {
  await svc.from("voice_calls").update({
    status: "completed", outcome, ended_at: new Date().toISOString(), transcription: transcript,
  }).eq("id", callId).then(undefined, () => {})
}
