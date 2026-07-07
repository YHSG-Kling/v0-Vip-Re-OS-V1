// lib/voice/twilio-voice.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE TWILIO-NATIVE VOICE LANE (owner decision: Twilio-first, no new Vapi) —
// fully serverless: the number's VoiceUrl points at our inbound webhook, each
// caller utterance arrives as an HTTP turn (<Gather input="speech">), the
// reception brain (shared with the legacy Vapi lane — one brain, two engines)
// plans the reply + action, and TwiML speaks it. No WebSocket dependency, no
// third-party voice-AI vendor: Twilio carries the call, our AI gateway thinks.
//
// State: the voice_calls row IS the session (transcript rebuilt per turn) —
// the same ledger both engines share, so call intelligence, metering, and the
// command center see one world. Security: every webhook validates
// X-Twilio-Signature against the TENANT's own auth token (subaccount creds).

import { createHmac, timingSafeEqual } from "node:crypto"
import { buildReceptionPrompt, parseTurnPlan, transcriptToMessages, TURN_INSTRUCTIONS, type VoiceTurnPlan } from "./reception-brain"
import type { InboundIdentity } from "./vapi-numbers"

/** Twilio request signature: HMAC-SHA1(url + sorted concatenated POST params, authToken), base64. */
export function computeTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("")
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64")
}

export function validateTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | null): boolean {
  if (!signature) return false
  const expected = computeTwilioSignature(authToken, url, params)
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface InboundCallContext {
  brokerageId: string
  agentUserId: string | null
  numberRowId: string
  identity: InboundIdentity
  forwardNumber: string | null
  authToken: string
}

/** Resolve the tenant + reception identity from the CALLED number (To). */
export async function resolveInboundContext(svc: any, toNumber: string): Promise<InboundCallContext | null> {
  const digits = toNumber.replace(/\D/g, "")
  const { data: num } = await svc.from("vapi_phone_numbers")
    .select("id, brokerage_id, agent_user_id")
    .eq("phone_digits", digits).eq("is_active", true).maybeSingle()
  if (!num) return null
  const n = num as any

  // The scope's AI identity profile (agent scope wins over brokerage).
  let profile: any = null
  if (n.agent_user_id) {
    const { data: agent } = await svc.from("agents").select("id").eq("user_id", n.agent_user_id).maybeSingle()
    if (agent) {
      const { data: p } = await svc.from("ai_identity_profiles").select("*")
        .eq("scope_type", "agent").eq("scope_id", (agent as any).id).maybeSingle()
      profile = p
    }
  }
  if (!profile) {
    const { data: p } = await svc.from("ai_identity_profiles").select("*")
      .eq("scope_type", "brokerage").eq("scope_id", n.brokerage_id).maybeSingle()
    profile = p
  }

  const [{ data: brk }, creds] = await Promise.all([
    svc.from("brokerages").select("name").eq("id", n.brokerage_id).maybeSingle(),
    (async () => {
      const { resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
      return resolveTenantTwilioCreds(svc, n.brokerage_id)
    })(),
  ])
  if (!creds) return null

  let agentName: string | null = null
  if (n.agent_user_id) {
    const { data: u } = await svc.from("users").select("first_name, last_name").eq("id", n.agent_user_id).maybeSingle()
    agentName = u ? [(u as any).first_name, (u as any).last_name].filter(Boolean).join(" ") || null : null
  }

  return {
    brokerageId: n.brokerage_id,
    agentUserId: n.agent_user_id,
    numberRowId: n.id,
    forwardNumber: profile?.ai_call_forward_number ?? null,
    authToken: creds.authToken,
    identity: {
      assistantName: profile?.assistant_name ?? null,
      welcomeMessage: profile?.welcome_message ?? null,
      tone: profile?.tone ?? null,
      brokerageName: (brk as any)?.name ?? null,
      agentName,
      prohibitedLanguage: profile?.prohibited_language ?? null,
      elevenlabsVoiceId: profile?.elevenlabs_voice_id ?? null,
      forwardNumber: profile?.ai_call_forward_number ?? null,
      answerMode: profile?.ai_answer_mode ?? null,
      businessHours: profile?.business_hours ?? null,
    },
  }
}

/**
 * Bind a tenant's number to the Twilio-native lane: set the number's VoiceUrl
 * to our inbound webhook via the TENANT's own creds (subaccount/BYO). No Vapi
 * import, no assistant object — the reception brain builds the prompt live per
 * call from the AI identity profile, so editing the profile IS re-provisioning.
 */
export async function bindNumberToTwilioLane(
  svc: any,
  numberRowId: string,
): Promise<{ ok: true } | { ok: false; error: string; notConfigured?: boolean }> {
  const { data: row } = await svc.from("vapi_phone_numbers")
    .select("id, brokerage_id, phone_number, byoc_credential_id, is_active")
    .eq("id", numberRowId).maybeSingle()
  if (!row) return { ok: false, error: "Number row not found" }
  const n = row as any
  if (!n.is_active) return { ok: false, error: "Number is inactive" }
  if (!n.byoc_credential_id) return { ok: false, error: "Number has no Twilio SID on file — re-provision it first" }

  const { resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
  const creds = await resolveTenantTwilioCreds(svc, n.brokerage_id)
  if (!creds) return { ok: false, error: "Twilio not configured — nothing was changed.", notConfigured: true }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return { ok: false, error: "NEXT_PUBLIC_APP_URL not set — can't register the webhook URL" }
  const voiceUrl = `${appUrl.replace(/\/$/, "")}/api/voice/twilio/inbound`

  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector({
    connector: "twilio",
    baseUrl: "https://api.twilio.com",
    path: `/2010-04-01/Accounts/${creds.accountSid}/IncomingPhoneNumbers/${n.byoc_credential_id}.json`,
    method: "POST",
    bodyType: "form",
    body: { VoiceUrl: voiceUrl, VoiceMethod: "POST" },
    auth: { style: "basic", username: creds.accountSid, password: creds.authToken },
  })
  if (!res.ok) return { ok: false, error: `Twilio VoiceUrl update failed (${res.status ?? "—"}): ${res.error ?? "unknown"}` }

  await svc.from("phone_number_events").insert({
    brokerage_id: n.brokerage_id, phone_number: n.phone_number,
    event_type: "vapi_registered", source: "inbound_binding",
    notes: "Number bound to the Twilio-native AI reception lane (VoiceUrl → /api/voice/twilio/inbound)",
  }).then(undefined, () => {})
  return { ok: true }
}

/** One reception turn: transcript + new utterance → the brain → plan. */
export async function planReceptionTurn(
  ctx: InboundCallContext,
  transcript: string | null,
  callerUtterance: string,
): Promise<VoiceTurnPlan> {
  const { systemPrompt } = buildReceptionPrompt(ctx.identity)
  const history = transcriptToMessages(transcript)
  const convo = history.map((m) => `${m.role === "assistant" ? "AI" : "Caller"}: ${m.content}`).join("\n")
  const { generateTextRouted } = await import("@/lib/ai/models")
  const { text } = await generateTextRouted({
    feature: "voice_reception_turn",
    prompt: `${systemPrompt}\n\n${TURN_INSTRUCTIONS}\n\nConversation so far:\n${convo || "(call just connected)"}\nCaller: ${callerUtterance}\n\nYour JSON:`,
    temperature: 0.4,
    maxTokens: 300,
  })
  return parseTurnPlan(text)
}
