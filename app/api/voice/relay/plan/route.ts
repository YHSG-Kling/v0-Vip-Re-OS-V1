import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveInboundContext, planReceptionTurn, planTurnWithPrompt, bookShowingFromCall } from "@/lib/voice/twilio-voice"
import { appendTranscript, buildOutboundPrompt } from "@/lib/voice/reception-brain"
import { parseRelayPlanRequest, composePacingRule, type RelayPlanResponse } from "@/lib/voice/conversation-relay"
import { isPlatformNumber, resolvePlatformReceptionContext, planPlatformReceptionTurn, capturePhoneProspect } from "@/lib/voice/platform-reception"
import { decodeOutboundBrief } from "@/lib/voice/twilio-outbound"

export const dynamic = "force-dynamic"

/**
 * CONVERSATIONRELAY — PLAN. The streaming companion holds the socket; the
 * BRAIN LIVES HERE. Each caller utterance arrives as one authenticated POST
 * (shared secret, timing-safe) and gets the SAME scope resolution, prompts,
 * side-effects, and legal posture as the <Gather> turn webhook: platform
 * prospects, tenant bookings, deterministic opt-out honor, human transfer
 * (executed server-side via a live-call REST redirect — the companion never
 * touches Twilio credentials). Two transports, one brain — zero drift by
 * construction: this route calls the exact planners/actors the turn route calls.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.RELAY_SHARED_SECRET
  const given = request.headers.get("x-relay-secret") ?? ""
  if (!secret || !given || Buffer.from(secret).length !== Buffer.from(given).length
    || !timingSafeEqual(Buffer.from(secret), Buffer.from(given))) {
    return new NextResponse("unauthorized", { status: 401 })
  }

  const req = parseRelayPlanRequest(await request.json().catch(() => null))
  if (!req) return NextResponse.json({ error: "bad request" }, { status: 400 })

  const svc = createServiceClient()
  const json = (r: RelayPlanResponse) => NextResponse.json(r)

  // ── PLATFORM SCOPE ──────────────────────────────────────────────────────────
  if (isPlatformNumber(req.to, process.env.TWILIO_PHONE_NUMBER)) {
    const pctx = await resolvePlatformReceptionContext(svc)
    if (!pctx) return json({ say: "Sorry, something went wrong. Goodbye.", endSession: true })
    const { data: call } = await svc.from("platform_reception_calls")
      .select("id, transcript").eq("call_sid", req.callSid).maybeSingle()
    const transcript = (call as any)?.transcript ?? null
    const plan = await planPlatformReceptionTurn(pctx, transcript, req.utterance, composePacingRule(req.interrupts))
    const newTranscript = appendTranscript(transcript, req.utterance, plan.say)
    if (call) await svc.from("platform_reception_calls").update({ transcript: newTranscript }).eq("id", (call as any).id).then(undefined, () => {})

    if (plan.action.kind === "prospect") {
      const prospect = await capturePhoneProspect(svc, {
        phone: req.from, name: plan.action.name, email: plan.action.email,
        company: plan.action.company, roleInterest: plan.action.roleInterest, note: plan.action.note,
      })
      if (call && prospect) {
        await svc.from("platform_reception_calls").update({ prospect_id: prospect.id, outcome: "prospect_captured" })
          .eq("id", (call as any).id).then(undefined, () => {})
      }
      return json({ say: plan.say, endSession: false })
    }
    if (plan.action.kind === "transfer" && pctx.forwardNumber) {
      const transferred = await redirectLiveCallToDial(req.callSid, plan.say, pctx.forwardNumber, {
        accountSid: process.env.TWILIO_ACCOUNT_SID ?? "", authToken: pctx.authToken,
      })
      if (call) await svc.from("platform_reception_calls").update({ status: "transferred", outcome: "support_transfer", ended_at: new Date().toISOString() }).eq("id", (call as any).id).then(undefined, () => {})
      return json({ say: transferred ? "" : plan.say, endSession: true, transferred })
    }
    return json({ say: plan.say, endSession: plan.action.kind === "hangup" })
  }

  // ── TENANT SCOPES (inbound by To; outbound by From) ─────────────────────────
  let ctx = await resolveInboundContext(svc, req.to)
  if (!ctx) ctx = await resolveInboundContext(svc, req.from)
  if (!ctx) return json({ say: "Sorry, something went wrong. Goodbye.", endSession: true })

  const { data: call } = await svc.from("voice_calls").select("id, contact_id, agent_id, transcription, ai_notes, direction")
    .eq("vapi_call_id", req.callSid).maybeSingle()
  const transcript = (call as any)?.transcription ?? null
  const brief = (call as any)?.direction === "outbound" ? decodeOutboundBrief((call as any)?.ai_notes) : null

  // Deterministic opt-out on outbound — same law, same writer as the turn route.
  if (brief && call && (call as any).contact_id) {
    const { detectOptOutIntent } = await import("@/lib/ai-isa/opt-out-utils")
    const opt = detectOptOutIntent(req.utterance)
    if (opt.isOptOut && opt.confidence === "high") {
      const ack = "Understood — I've recorded that, and we won't call again. Sorry to have bothered you. Goodbye."
      try {
        const { processOptOut } = await import("@/app/actions/ai-isa/process-opt-out")
        await processOptOut({
          entityType: "contact", entityId: (call as any).contact_id,
          channel: opt.channel === "all" ? "all" : "phone",
          source: "inbound_call", rawMessage: req.utterance.slice(0, 300), brokerageId: ctx.brokerageId,
        })
      } catch { /* the hangup still honors the request */ }
      await svc.from("voice_calls").update({ status: "completed", outcome: "opt_out", ended_at: new Date().toISOString(), transcription: appendTranscript(transcript, req.utterance, ack) }).eq("id", (call as any).id).then(undefined, () => {})
      return json({ say: ack, endSession: true })
    }
  }

  const pacing = composePacingRule(req.interrupts)
  const plan = brief
    ? await planTurnWithPrompt(
        `${buildOutboundPrompt(ctx.identity, { objective: brief.objective, contactName: brief.contactName, extraSystemPrompt: brief.systemPrompt }).systemPrompt}${pacing ? `\n\n${pacing}` : ""}`,
        transcript, req.utterance)
    : await planReceptionTurn(ctx, transcript, req.utterance, svc, pacing)
  const newTranscript = appendTranscript(transcript, req.utterance, plan.say)
  if (call) await svc.from("voice_calls").update({ transcription: newTranscript }).eq("id", (call as any).id).then(undefined, () => {})

  if (plan.action.kind === "transfer" && ctx.forwardNumber) {
    const { resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
    const creds = await resolveTenantTwilioCreds(svc, ctx.brokerageId)
    const transferred = creds ? await redirectLiveCallToDial(req.callSid, plan.say, ctx.forwardNumber, creds) : false
    if (call) await svc.from("voice_calls").update({ status: "completed", outcome: "transferred", ended_at: new Date().toISOString(), transcription: newTranscript }).eq("id", (call as any).id).then(undefined, () => {})
    return json({ say: transferred ? "" : plan.say, endSession: true, transferred })
  }
  if (plan.action.kind === "book" && call && (call as any).contact_id && (call as any).agent_id) {
    await bookShowingFromCall(svc, ctx, call as any, plan.action.dateTime)
  }
  if (plan.action.kind === "hangup" && call) {
    await svc.from("voice_calls").update({ status: "completed", outcome: "completed", ended_at: new Date().toISOString(), transcription: newTranscript }).eq("id", (call as any).id).then(undefined, () => {})
  }
  return json({ say: plan.say, endSession: plan.action.kind === "hangup" })
}

/** Re-point the LIVE call at a human via Twilio's call-update REST API — the
 *  server does the transfer so the companion never holds credentials. */
async function redirectLiveCallToDial(
  callSid: string, say: string, forwardNumber: string,
  creds: { accountSid: string; authToken: string },
): Promise<boolean> {
  if (!creds.accountSid || !creds.authToken) return false
  const { twimlTransfer } = await import("@/lib/voice/reception-brain")
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector({
    connector: "twilio",
    baseUrl: "https://api.twilio.com",
    path: `/2010-04-01/Accounts/${creds.accountSid}/Calls/${callSid}.json`,
    method: "POST",
    bodyType: "form",
    body: { Twiml: twimlTransfer(say, forwardNumber) },
    auth: { style: "basic", username: creds.accountSid, password: creds.authToken },
  })
  return res.ok
}
