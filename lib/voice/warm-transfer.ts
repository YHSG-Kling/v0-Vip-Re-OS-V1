// lib/voice/warm-transfer.ts
// ─────────────────────────────────────────────────────────────────────────────
// WARM-TRANSFER BRIDGING — the brief-then-bridge mechanic (the one Felix edge):
// instead of a blind <Dial>, the caller HOLDS in a conference while the agent's
// phone rings with a WHISPER BRIEFING — "{assistant name}, the assistant for
// {agent/brokerage}: I have {caller} on the line about {topic}. Press 1 to
// take the call." — and the agent's keypress bridges both legs. Every spoken
// word composes from the tenant's AI identity SETTINGS (assistant_name /
// agent / brokerage — user-adjustable in the AI identity editor; owner rule:
// it says "assistant for", never impersonates). No-answer or no-keypress →
// the caller gets an honest "they'll call you right back" + the agent a
// missed-bridge notification — never dead air. voice_calls.call_type flips to
// 'warm_transfer' (the CHECK anticipated this). All call-control REST rides
// the tenant's own creds; the whisper endpoints are gated by a shared token
// (we set these URLs ourselves at dial time — nothing else may drive them).

import type { InboundCallContext } from "./twilio-voice"

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** PURE: the whisper — settings-driven, says "the assistant for", short. */
export function composeWhisperBriefing(identity: { assistantName?: string | null; agentName?: string | null; brokerageName?: string | null }, callerLabel: string, topic: string | null): string {
  const name = (identity.assistantName ?? "Your assistant").slice(0, 40)
  const forWhom = identity.agentName ?? identity.brokerageName ?? "your office"
  const about = (topic ?? "").trim() ? ` about ${topic!.trim().slice(0, 90)}` : ""
  return `This is ${name}, the assistant for ${forWhom}. I have ${callerLabel} on the line${about}. Press 1 to take the call, or hang up and I'll take a message.`
}

/** PURE: caller holds in the named conference (joins muted-start; the bridge
 *  opens when the agent enters). */
export function twimlHoldInConference(say: string, conferenceName: string, voice = "Polly.Joanna-Neural"): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${voice}">${xmlEscape(say)}</Say><Dial><Conference startConferenceOnEnter="false" endConferenceOnExit="false" beep="false">${xmlEscape(conferenceName)}</Conference></Dial></Response>`
}

/** PURE: the agent-leg whisper — gather ONE digit to accept. */
export function twimlWhisperGather(briefing: string, joinUrl: string, voice = "Polly.Joanna-Neural"): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" timeout="8" action="${xmlEscape(joinUrl)}" method="POST"><Say voice="${voice}">${xmlEscape(briefing)}</Say></Gather><Say voice="${voice}">No problem — I'll take a message.</Say><Hangup/></Response>`
}

/** PURE: the agent joins → conference starts → both legs bridged. */
export function twimlJoinConference(conferenceName: string, voice = "Polly.Joanna-Neural"): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${voice}">Connecting you now.</Say><Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false">${xmlEscape(conferenceName)}</Conference></Dial></Response>`
}

/** The shared token gating the whisper endpoints (we author these URLs). */
export function whisperToken(): string | null {
  return process.env.RELAY_SHARED_SECRET ?? process.env.CRON_SECRET ?? null
}

export function conferenceNameFor(callSid: string): string {
  return `warm_${callSid}`
}

/**
 * Ring the agent with the whisper while the caller holds. Returns false when
 * the bridge can't start (no creds/agent number/app URL) — the caller then
 * gets the classic blind transfer, an honest degradation.
 */
export async function startWarmBridge(svc: any, ctx: InboundCallContext, input: {
  callerCallSid: string
  callerLabel: string
  topic: string | null
  voiceCallId: string | null
}): Promise<boolean> {
  try {
    const token = whisperToken()
    const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "")
    if (!token || !base || !ctx.forwardNumber) return false
    const { resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
    const creds = await resolveTenantTwilioCreds(svc, ctx.brokerageId)
    if (!creds) return false

    const conf = conferenceNameFor(input.callerCallSid)
    const q = `token=${encodeURIComponent(token)}&conf=${encodeURIComponent(conf)}&caller=${encodeURIComponent(input.callerCallSid)}&vc=${encodeURIComponent(input.voiceCallId ?? "")}&label=${encodeURIComponent(input.callerLabel.slice(0, 60))}&topic=${encodeURIComponent((input.topic ?? "").slice(0, 90))}&b=${encodeURIComponent(ctx.brokerageId)}`

    // Our number rings the agent — recognizable caller ID, tenant creds.
    const from = ctx.identity.forwardNumber === ctx.forwardNumber ? undefined : undefined
    const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
    const { data: numRow } = await svc.from("tenant_phone_numbers").select("phone_number")
      .eq("id", ctx.numberRowId).maybeSingle()
    const res = await callConnector<{ sid?: string }>({
      connector: "twilio",
      baseUrl: "https://api.twilio.com",
      path: `/2010-04-01/Accounts/${creds.accountSid}/Calls.json`,
      method: "POST",
      bodyType: "form",
      body: {
        To: ctx.forwardNumber,
        From: (numRow as any)?.phone_number ?? ctx.forwardNumber,
        Url: `${base}/api/voice/twilio/whisper?step=whisper&${q}`,
        Method: "POST",
        Timeout: 20,
        StatusCallback: `${base}/api/voice/twilio/whisper?step=fallback&${q}`,
        StatusCallbackMethod: "POST",
      },
      auth: { style: "basic", username: creds.accountSid, password: creds.authToken },
    })
    if (!res.ok || !res.data?.sid) return false

    if (input.voiceCallId) {
      await svc.from("voice_calls").update({ call_type: "warm_transfer", outcome: "warm_bridge_ringing" })
        .eq("id", input.voiceCallId).then(undefined, () => {})
    }
    return true
  } catch { return false }
}
