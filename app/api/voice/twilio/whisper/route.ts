import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "node:crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveInboundContext } from "@/lib/voice/twilio-voice"
import { composeWhisperBriefing, twimlWhisperGather, twimlJoinConference, whisperToken } from "@/lib/voice/warm-transfer"

export const dynamic = "force-dynamic"

const xml = (b: string) => new NextResponse(b, { headers: { "Content-Type": "text/xml" } })

/**
 * WARM-TRANSFER — the agent leg's three steps (one route, ?step=):
 *   whisper  → the settings-driven briefing + press-1 gather
 *   join     → keypress 1 bridges the agent into the caller's conference;
 *              the ledger flips to warm_transferred
 *   fallback → agent-leg StatusCallback: ended WITHOUT joining → the caller
 *              gets an honest "they'll call you right back" (REST redirect)
 *              and the agent a missed-bridge notification — never dead air.
 * Token-gated (timing-safe): these URLs are authored by OUR dial at bridge
 * start; nothing else may drive them.
 */
export async function POST(request: NextRequest) {
  const url = new URL(request.url)
  const token = whisperToken()
  const given = url.searchParams.get("token") ?? ""
  if (!token || !given || Buffer.from(token).length !== Buffer.from(given).length
    || !timingSafeEqual(Buffer.from(token), Buffer.from(given))) {
    return new NextResponse("not found", { status: 404 })
  }

  const step = url.searchParams.get("step") ?? ""
  const conf = url.searchParams.get("conf") ?? ""
  const callerSid = url.searchParams.get("caller") ?? ""
  const voiceCallId = url.searchParams.get("vc") || null
  const label = url.searchParams.get("label") || "a caller"
  const topic = url.searchParams.get("topic") || null
  const brokerageId = url.searchParams.get("b") ?? ""
  if (!conf || !callerSid) return xml('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>')

  const svc = createServiceClient()

  if (step === "whisper") {
    // Rebuild the settings-driven identity from the caller's OWN call (the To
    // number the caller dialed) — assistant name/agent/brokerage all live in
    // the tenant-editable AI identity profile.
    const { data: call } = await svc.from("voice_calls").select("phone_to").eq("vapi_call_id", callerSid).maybeSingle()
    const ctx = (call as any)?.phone_to ? await resolveInboundContext(svc, (call as any).phone_to) : null
    const briefing = composeWhisperBriefing(ctx?.identity ?? {}, label, topic)
    const joinUrl = `${url.origin}${url.pathname}?${new URLSearchParams({ token: given, step: "join", conf, caller: callerSid, vc: voiceCallId ?? "", b: brokerageId }).toString()}`
    return xml(twimlWhisperGather(briefing, joinUrl))
  }

  if (step === "join") {
    const form = await request.formData().catch(() => null)
    const digit = String(form?.get("Digits") ?? "")
    if (digit !== "1") return xml('<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">No problem — I\'ll take a message.</Say><Hangup/></Response>')
    if (voiceCallId) {
      await svc.from("voice_calls").update({ outcome: "warm_transferred", status: "completed", ended_at: new Date().toISOString() })
        .eq("id", voiceCallId).then(undefined, () => {})
    }
    return xml(twimlJoinConference(conf))
  }

  if (step === "fallback") {
    const form = await request.formData().catch(() => null)
    const status = String(form?.get("CallStatus") ?? "").toLowerCase()
    if (!["completed", "busy", "no-answer", "failed", "canceled"].includes(status)) return NextResponse.json({ ok: true })
    // Joined bridges already marked warm_transferred — only a MISS falls through.
    const { data: vc } = voiceCallId
      ? await svc.from("voice_calls").select("id, outcome, brokerage_id").eq("id", voiceCallId).maybeSingle()
      : { data: null }
    if ((vc as any)?.outcome === "warm_transferred") return NextResponse.json({ ok: true })

    // Honest exit for the waiting caller: REST-redirect their live call.
    const bId = (vc as any)?.brokerage_id ?? brokerageId
    try {
      const { resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
      const creds = bId ? await resolveTenantTwilioCreds(svc, bId) : null
      if (creds) {
        const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
        await callConnector({
          connector: "twilio", baseUrl: "https://api.twilio.com",
          path: `/2010-04-01/Accounts/${creds.accountSid}/Calls/${callerSid}.json`, method: "POST", bodyType: "form",
          body: { Twiml: '<Response><Say voice="Polly.Joanna-Neural">They stepped away for a moment — I\'ve let them know, and they\'ll call you right back. Thanks for your patience!</Say><Hangup/></Response>' },
          auth: { style: "basic", username: creds.accountSid, password: creds.authToken },
        })
      }
    } catch { /* the caller's own hangup remains the worst case */ }
    if ((vc as any)?.id) {
      await svc.from("voice_calls").update({ outcome: "warm_bridge_missed", status: "completed", ended_at: new Date().toISOString() })
        .eq("id", (vc as any).id).then(undefined, () => {})
    }
    // The agent hears about the miss immediately.
    if (bId) {
      const { data: call } = voiceCallId ? await svc.from("voice_calls").select("agent_id").eq("id", voiceCallId).maybeSingle() : { data: null }
      if ((call as any)?.agent_id) {
        const { data: a } = await svc.from("agents").select("user_id").eq("id", (call as any).agent_id).maybeSingle()
        if ((a as any)?.user_id) {
          await svc.from("notifications").insert({
            user_id: (a as any).user_id, brokerage_id: bId, type: "warm_bridge_missed",
            title: "You missed a live warm transfer",
            body: `${label} was holding for you${topic ? ` about ${topic}` : ""} — they were told you'll call right back. Transcript on the call record.`,
            entity_type: "voice_call", entity_id: voiceCallId, priority: "high", channel: "in_app", is_read: false,
          }).then(undefined, () => {})
        }
      }
    }
    return NextResponse.json({ ok: true })
  }

  return xml('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>')
}
