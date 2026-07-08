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
    ? twimlConnectRelay(process.env.CONVERSATION_RELAY_WSS_URL!, firstMessage)
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

  // voice_calls carries NOT NULL contact_id + agent_id (live-proven schema):
  // resolve the caller to a contact (calling in IS consent — the Vapi lane's
  // established rule) and the number's agent. Either missing → the call still
  // proceeds, just without the ledger row (honest degradation, never a 500).
  let contactId: string | null = null
  let agentRowId: string | null = null
  try {
    const digits = from.replace(/\D/g, "")
    const { data: existing } = await svc.from("contacts").select("id")
      .eq("brokerage_id", ctx.brokerageId).eq("phone_digits", digits).maybeSingle()
    if (existing) contactId = (existing as any).id
    else {
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
    }
    if (ctx.agentUserId) {
      const { data: agent } = await svc.from("agents").select("id").eq("user_id", ctx.agentUserId).maybeSingle()
      agentRowId = (agent as any)?.id ?? null
    }
  } catch { /* ledger is best-effort */ }

  if (contactId && agentRowId) {
    await svc.from("voice_calls").insert({
      brokerage_id: ctx.brokerageId,
      contact_id: contactId,
      agent_id: agentRowId,
      direction: "inbound",
      call_type: "vapi_inbound", // CHECK value for AI inbound; ai_notes carries the real engine
      status: "in_progress",
      phone_from: from, phone_to: to,
      started_at: new Date().toISOString(),
      vapi_call_id: callSid, // vendor call id (Twilio CallSid here)
      transcription: appendTranscript(null, null, firstMessage),
      ai_notes: "engine:twilio",
    }).then(undefined, () => {})
  }

  const turnUrl = `${url.replace(/\/inbound$/, "/turn")}`
  return xml(answerTwiml(firstMessage, turnUrl))
}
