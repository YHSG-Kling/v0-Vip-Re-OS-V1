import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveInboundContext, validateTwilioSignature } from "@/lib/voice/twilio-voice"
import { buildReceptionPrompt, twimlGatherTurn, twimlHangup, appendTranscript } from "@/lib/voice/reception-brain"
import { isPlatformNumber, resolvePlatformReceptionContext, buildPlatformReceptionPrompt } from "@/lib/voice/platform-reception"
import { relayConfigured, twimlConnectRelay } from "@/lib/voice/conversation-relay"

export const dynamic = "force-dynamic"

const xml = (body: string, status = 200) => new NextResponse(body, { status, headers: { "Content-Type": "text/xml" } })

/** TRANSPORT SWITCH: ConversationRelay (streaming, sub-second) when the
 *  companion is configured; the serverless <Gather> lane otherwise. Same
 *  brain, same disclosed greeting — only the transport differs. */
const answerTwiml = (firstMessage: string, turnUrl: string) =>
  relayConfigured()
    ? twimlConnectRelay(process.env.CONVERSATION_RELAY_WSS_URL!, firstMessage, undefined, process.env.TWILIO_INTELLIGENCE_SERVICE_SID)
    : twimlGatherTurn(firstMessage, turnUrl)

/**
 * TWILIO VOICE — INBOUND (the Twilio-native lane; no Vapi). The number's
 * VoiceUrl points here. THREE scopes share this webhook: the PLATFORM's own
 * line (master account — sell the product, capture prospects, route support)
 * and tenant brokerage/agent lines (subaccounts — the reception brain).
 * Every request validates X-Twilio-Signature against the OWNING account's
 * auth token, opens the scope's ledger row (the session state), and answers
 * with the legal preamble + greeting, then listens (<Gather> → /turn).
 */
export async function POST(request: NextRequest) {
  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [k, v] of form.entries()) params[k] = String(v)

  const svc = createServiceClient()
  const to = params.To ?? ""
  const from = params.From ?? ""
  const callSid = params.CallSid ?? ""
  const url = `${(process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")}/api/voice/twilio/inbound`

  // ── PLATFORM SCOPE: the app's own line ──────────────────────────────────────
  if (isPlatformNumber(to, process.env.TWILIO_PHONE_NUMBER)) {
    const pctx = await resolvePlatformReceptionContext(svc)
    if (!pctx) return xml(twimlHangup("This line isn't configured yet. Goodbye."))
    if (!validateTwilioSignature(pctx.authToken, url, params, request.headers.get("x-twilio-signature"))) {
      return new NextResponse("invalid signature", { status: 403 })
    }
    const { firstMessage } = buildPlatformReceptionPrompt({
      brandName: pctx.brandName, tagline: pctx.tagline, tierLines: pctx.tierLines, hasTransfer: !!pctx.forwardNumber,
      voicePitch: pctx.voicePitch, receptionGreeting: pctx.receptionGreeting,
    })
    await svc.from("platform_reception_calls").insert({
      call_sid: callSid, phone_from: from, phone_to: to,
      transcript: appendTranscript(null, null, firstMessage),
    }).then(undefined, () => {})
    return xml(answerTwiml(firstMessage, url.replace(/\/inbound$/, "/turn")))
  }

  // ── TENANT SCOPES: brokerage/agent lines ────────────────────────────────────
  const ctx = await resolveInboundContext(svc, to)
  if (!ctx) return xml(twimlHangup("This number isn't configured yet. Goodbye."))

  // Signature: the request must be signed with THIS tenant's auth token.
  if (!validateTwilioSignature(ctx.authToken, url, params, request.headers.get("x-twilio-signature"))) {
    return new NextResponse("invalid signature", { status: 403 })
  }

  const { firstMessage } = buildReceptionPrompt(ctx.identity)

  // voice_calls contact_id + agent_id are nullable (live-verified): resolve the
  // caller in precedence order — CONTACT match, then LEAD match (a lead the AI
  // ISA is nurturing can CALL IN; the call rides voice_calls.lead_id and its
  // transcript is intent-classified on completion — positive direction converts
  // the lead via the canonical handoff, never a duplicate "Caller ####" contact),
  // then capture a NEW contact (calling in IS consent — the established rule).
  let contactId: string | null = null
  let leadId: string | null = null
  let agentRowId: string | null = null
  let callerDigits = ""
  let classification = "unknown"
  try {
    const digits = from.replace(/\D/g, "")
    callerDigits = digits
    const { data: existing } = await svc.from("contacts").select("id")
      .eq("brokerage_id", ctx.brokerageId).eq("phone_digits", digits).maybeSingle()
    if (existing) { contactId = (existing as any).id; classification = "existing_contact" }
    else {
      // Known LEAD calling in? Unconverted leads only (converted leads matched above).
      const { data: lead } = await svc.from("leads").select("id, agent_id")
        .eq("brokerage_id", ctx.brokerageId)
        .or(`phone_digits.eq.${digits},phone.eq.${from}`)
        .is("contact_id", null)
        .limit(1).maybeSingle()
      if (lead) {
        leadId = (lead as any).id
        agentRowId = (lead as any).agent_id ?? null // leads.agent_id FKs agents(id)
      } else {
        const { captureContact } = await import("@/lib/contact-pipeline/contact-capture")
        const r = await captureContact({
          brokerageId: ctx.brokerageId,
          agentUserId: ctx.agentUserId,
          source: "inbound_call",
          first_name: "Caller", last_name: digits.slice(-4),
          phone: from,
          tcpa_consent: true,
          tcpa_consent_date: new Date().toISOString(),
          tcpa_consent_source: "inbound_call",
          tcpa_consent_text: "Caller dialed the office line and spoke with the AI reception assistant.",
        })
        contactId = r.contactId
        classification = "unknown" // a first-time caller — intent is learned in-conversation
      }
    }
    if (!agentRowId && ctx.agentUserId) {
      const { data: agent } = await svc.from("agents").select("id").eq("user_id", ctx.agentUserId).maybeSingle()
      agentRowId = (agent as any)?.id ?? null
    }
  } catch { /* ledger is best-effort */ }

  // INBOUND CALL CLASSIFICATION — the caller-routing decision, keyed to the
  // resolved contact so it merges into the contact-timeline (seller-lifetime
  // overview reads resulting_contact_id). The AI answered (ai_handled=true);
  // transfer_reason is enriched later if the turn route hands off to a human.
  // Best-effort — never blocks the answer. (This write moved from the retired
  // Vapi function-tools onto the Twilio-native lane.)
  if (contactId) {
    try {
      await svc.from("inbound_call_classifications").insert({
        brokerage_id: ctx.brokerageId,
        caller_phone: from,
        caller_phone_digits: callerDigits,
        classification,
        ai_handled: true,
        resulting_contact_id: contactId,
        classified_at: new Date().toISOString(),
      })
    } catch { /* best-effort — never block the answer */ }
  }

  if (contactId || leadId) {
    // Sentinel-tracked (pass 4): a lost call-ledger row used to vanish
    // silently — now it lands on the self-heal ledger for the repair digest.
    const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
    await sentinelWrite(svc, svc.from("voice_calls").insert({
      brokerage_id: ctx.brokerageId,
      contact_id: contactId,
      lead_id: leadId,
      agent_id: agentRowId,
      direction: "inbound",
      call_type: "ai_inbound", // CHECK value for AI inbound; ai_notes carries the real engine
      status: "in_progress",
      phone_from: from, phone_to: to,
      started_at: new Date().toISOString(),
      vendor_call_id: callSid, // vendor call id (Twilio CallSid here)
      transcription: appendTranscript(null, null, firstMessage),
      ai_notes: "engine:twilio",
    }), { table: "voice_calls", flow: "voice_call_ledger", brokerageId: ctx.brokerageId })

    // ai_isa_calls lifecycle: an INBOUND AI call gets its scoring row now
    // (outbound calls get theirs at placement) so the post-call brain can persist
    // appointment_set + lead_quality_score against it. Best-effort.
    const { data: vc } = await svc.from("voice_calls").select("id").eq("vendor_call_id", callSid).maybeSingle()
    if ((vc as any)?.id) {
      try {
        await svc.from("ai_isa_calls").insert({
          brokerage_id: ctx.brokerageId,
          contact_id: contactId,
          lead_id: leadId,
          voice_call_id: (vc as any).id,
          script_used: "inbound",
          appointment_set: false,
        })
      } catch { /* best-effort — never block the answer */ }
    }
  }

  // ── RECORDING (opt-in per brokerage, DEFAULT OFF) ───────────────────────────
  // The greeting we are about to speak already announces recording
  // (buildReceptionPrompt passes `recorded: true` — the uniform national
  // posture), so ANNOUNCED ⊇ RECORDED holds either way and arming this can never
  // record a caller who was not told. <Gather> has no record attribute and
  // <Record> is a blocking single-shot verb that would replace the conversation,
  // so an inbound call is recorded by creating a Recording against the LIVE call
  // — one Twilio round trip, and only for a tenant that opted in. A failure
  // means the call is simply not recorded; it is logged, never assumed away.
  if (callSid) {
    const { resolveCallRecordingPolicy, startCallRecording } = await import("@/lib/voice/call-recording")
    const recordingPolicy = await resolveCallRecordingPolicy(svc, ctx.brokerageId)
    if (recordingPolicy.enabled) {
      const started = await startCallRecording(svc, ctx.brokerageId, callSid, url.replace(/\/api\/voice\/twilio\/inbound$/, ""))
      if (!started.ok) {
        console.error(`[voice/inbound] recording NOT armed for CallSid ${callSid}: ${started.error}`)
      }
    }
  }

  const turnUrl = `${url.replace(/\/inbound$/, "/turn")}`
  return xml(answerTwiml(firstMessage, turnUrl))
}
