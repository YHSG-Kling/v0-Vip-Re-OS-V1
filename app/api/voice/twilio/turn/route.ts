import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveInboundContext, validateTwilioSignature, planReceptionTurn } from "@/lib/voice/twilio-voice"
import { twimlGatherTurn, twimlTransfer, twimlHangup, appendTranscript } from "@/lib/voice/reception-brain"
import { isPlatformNumber, resolvePlatformReceptionContext, planPlatformReceptionTurn, capturePhoneProspect } from "@/lib/voice/platform-reception"

export const dynamic = "force-dynamic"

const xml = (body: string, status = 200) => new NextResponse(body, { status, headers: { "Content-Type": "text/xml" } })

/**
 * TWILIO VOICE — TURN. Each caller utterance arrives here (SpeechResult).
 * The scope's ledger row (by CallSid) is the session: transcript in, plan out.
 * Platform scope: prospect capture into the growth funnel + support routing.
 * Tenant scopes: booking creates the scheduled showing, transfer dials the
 * human, hangup closes + completes the ledger (call intelligence + the
 * showing lifecycle take it from there).
 */
export async function POST(request: NextRequest) {
  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [k, v] of form.entries()) params[k] = String(v)

  const svc = createServiceClient()
  const to = params.To ?? ""
  const callSid = params.CallSid ?? ""
  const speech = (params.SpeechResult ?? "").trim()
  const url = `${(process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")}/api/voice/twilio/turn`

  // ── PLATFORM SCOPE: the app's own line ──────────────────────────────────────
  if (isPlatformNumber(to, process.env.TWILIO_PHONE_NUMBER)) {
    const pctx = await resolvePlatformReceptionContext(svc)
    if (!pctx) return xml(twimlHangup("Sorry, something went wrong. Goodbye."))
    if (!validateTwilioSignature(pctx.authToken, url, params, request.headers.get("x-twilio-signature"))) {
      return new NextResponse("invalid signature", { status: 403 })
    }

    const { data: call } = await svc.from("platform_reception_calls")
      .select("id, transcript, prospect_id").eq("call_sid", callSid).maybeSingle()
    const transcript = (call as any)?.transcript ?? null

    if (!speech) {
      const closer = "No problem — call back any time. Goodbye!"
      if (call) await finishPlatformCall(svc, (call as any).id, appendTranscript(transcript, null, closer), "completed", "silence")
      return xml(twimlHangup(closer))
    }

    const plan = await planPlatformReceptionTurn(pctx, transcript, speech)
    const newTranscript = appendTranscript(transcript, speech, plan.say)
    if (call) await svc.from("platform_reception_calls").update({ transcript: newTranscript }).eq("id", (call as any).id).then(undefined, () => {})

    if (plan.action.kind === "prospect") {
      const prospect = await capturePhoneProspect(svc, {
        phone: params.From ?? "",
        name: plan.action.name, email: plan.action.email,
        company: plan.action.company, roleInterest: plan.action.roleInterest, note: plan.action.note,
      })
      if (call && prospect) {
        await svc.from("platform_reception_calls").update({ prospect_id: prospect.id, outcome: "prospect_captured" })
          .eq("id", (call as any).id).then(undefined, () => {})
      }
      return xml(twimlGatherTurn(plan.say, url))
    }
    if (plan.action.kind === "transfer" && pctx.forwardNumber) {
      if (call) await finishPlatformCall(svc, (call as any).id, newTranscript, "transferred", "support_transfer")
      return xml(twimlTransfer(plan.say, pctx.forwardNumber))
    }
    if (plan.action.kind === "hangup") {
      if (call) await finishPlatformCall(svc, (call as any).id, newTranscript, "completed", (call as any)?.prospect_id ? "prospect_captured" : "completed")
      return xml(twimlHangup(plan.say))
    }
    return xml(twimlGatherTurn(plan.say, url))
  }

  // ── TENANT SCOPES: brokerage/agent lines. INBOUND legs resolve the tenant by
  // the CALLED number (To = ours); OUTBOUND legs by the CALLING number (From =
  // ours) — one turn loop serves both directions. ─────────────────────────────
  let ctx = await resolveInboundContext(svc, to)
  let outboundLeg = false
  if (!ctx) {
    ctx = await resolveInboundContext(svc, params.From ?? "")
    outboundLeg = !!ctx
  }
  if (!ctx) return xml(twimlHangup("Sorry, something went wrong. Goodbye."))

  if (!validateTwilioSignature(ctx.authToken, url, params, request.headers.get("x-twilio-signature"))) {
    return new NextResponse("invalid signature", { status: 403 })
  }

  const { data: call } = await svc.from("voice_calls").select("id, contact_id, agent_id, transcription, ai_notes, direction")
    .eq("vapi_call_id", callSid).maybeSingle()
  const transcript = (call as any)?.transcription ?? null

  // Silence (Gather timed out with nothing) → one gentle retry then goodbye.
  if (!speech) {
    const closer = "No problem — call back any time. Goodbye!"
    if (call) await finishCall(svc, (call as any).id, appendTranscript(transcript, null, closer))
    return new NextResponse(twimlHangup(closer), { headers: { "Content-Type": "text/xml" } })
  }

  // OUTBOUND: deterministic opt-out honor BEFORE any model turn — "stop
  // calling" suppresses the channel via the canonical opt-out writer and ends
  // the call. Not left to the prompt: the law isn't a suggestion.
  const brief = outboundLeg || (call as any)?.direction === "outbound"
    ? (await import("@/lib/voice/twilio-outbound")).decodeOutboundBrief((call as any)?.ai_notes)
    : null
  if (brief && call) {
    const { detectOptOutIntent } = await import("@/lib/ai-isa/opt-out-utils")
    const opt = detectOptOutIntent(speech)
    if (opt.isOptOut && opt.confidence === "high" && (call as any).contact_id) {
      const ack = "Understood — I've recorded that, and we won't call again. Sorry to have bothered you. Goodbye."
      try {
        const { processOptOut } = await import("@/app/actions/ai-isa/process-opt-out")
        await processOptOut({
          entityType: "contact", entityId: (call as any).contact_id,
          channel: opt.channel === "all" ? "all" : "phone",
          source: "inbound_call", rawMessage: speech.slice(0, 300), brokerageId: ctx.brokerageId,
        })
      } catch { /* the hangup still honors the request; the flag write is retried by the sweep */ }
      await finishCall(svc, (call as any).id, appendTranscript(appendTranscript(transcript, speech, ack), null, ""), "opt_out")
      return xml(twimlHangup(ack))
    }
  }

  const plan = brief
    ? await (async () => {
        const { buildOutboundPrompt } = await import("@/lib/voice/reception-brain")
        const { planTurnWithPrompt } = await import("@/lib/voice/twilio-voice")
        const { systemPrompt } = buildOutboundPrompt(ctx!.identity, {
          objective: brief.objective, contactName: brief.contactName, extraSystemPrompt: brief.systemPrompt,
        })
        return planTurnWithPrompt(systemPrompt, transcript, speech)
      })()
    : await planReceptionTurn(ctx, transcript, speech, svc)
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
    const { bookShowingFromCall } = await import("@/lib/voice/twilio-voice")
    await bookShowingFromCall(svc, ctx, call as any, plan.action.dateTime)
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

async function finishPlatformCall(svc: any, callId: string, transcript: string, status: string, outcome: string): Promise<void> {
  await svc.from("platform_reception_calls").update({
    status, outcome, ended_at: new Date().toISOString(), transcript,
  }).eq("id", callId).then(undefined, () => {})
}
