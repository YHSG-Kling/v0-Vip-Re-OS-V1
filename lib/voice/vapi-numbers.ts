// lib/voice/vapi-numbers.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE MISSING INBOUND WIRING — the AI receptionist made REAL. The post-answer
// machinery (qualify, book, transfer, log, follow up) has been built for months;
// what never existed was the BINDING: provisioned Twilio numbers were never
// registered with Vapi (vapi_number_id was always null), the "AI answers calls"
// toggles saved to ai_identity_profiles and did NOTHING, and every outbound AI
// call showed one shared platform caller ID instead of the agent's own number.
// This module closes the loop:
//   ensureInboundAssistant  — create/update the Vapi assistant from the tenant's
//                             AI identity profile (name, welcome message, tone,
//                             cloned voice) with a Fair-Housing-safe reception
//                             prompt; id persisted to ai_identity_profiles.
//   registerNumberWithVapi  — import the tenant's Twilio number into Vapi bound
//                             to that assistant + our authoritative webhook, so
//                             a lead calling the agent's number reaches the AI.
// Both creds-gated (VAPI_API_KEY + Twilio creds) with honest not-configured
// errors — nothing is faked. Same connector-gateway egress as vapi-client.

import { callConnector } from "@/lib/agentic-os/connector-gateway"

const VAPI_BASE = "https://api.vapi.ai"

export interface InboundIdentity {
  assistantName: string | null
  welcomeMessage: string | null
  tone: string | null
  brokerageName: string | null
  agentName: string | null
  prohibitedLanguage: string[] | null
  elevenlabsVoiceId: string | null
  forwardNumber: string | null
}

/** PURE: the inbound reception assistant config from the tenant's AI identity.
 *  The prompt is qualification-focused and legally careful: capture who's
 *  calling + what they need, offer booking/transfer, NEVER quote legal or
 *  lending terms, Fair-Housing-safe (no steering, no demographic talk). */
export function buildInboundAssistantConfig(id: InboundIdentity): Record<string, unknown> {
  const office = id.brokerageName ?? "the office"
  const who = id.agentName ? `${id.agentName}'s office at ${office}` : office
  const name = (id.assistantName ?? "Reception Assistant").slice(0, 40)
  const firstMessage = (id.welcomeMessage ?? `Thanks for calling ${who} — I'm ${name}, the AI assistant. How can I help you today?`).slice(0, 300)
  const prohibited = (id.prohibitedLanguage ?? []).filter(Boolean).slice(0, 20)

  const systemPrompt = [
    `You are ${name}, the AI reception assistant answering inbound phone calls for ${who}.`,
    id.tone ? `Tone: ${id.tone}.` : "Tone: warm, professional, concise.",
    "Your job on every call: (1) learn who is calling and get a callback number; (2) find out what they need — buying, selling, a showing, or a question on a specific property; (3) offer to book an appointment or a showing; (4) if they ask for the agent directly or the matter is urgent, offer to transfer.",
    "HARD RULES: Never give legal, lending, or tax advice — offer to have the agent follow up. Never discuss the demographics of any neighborhood or steer callers toward or away from areas (Fair Housing). Never invent property details, prices, or availability — if you don't know, say the agent will confirm. Never promise a commission rate or contract terms.",
    prohibited.length > 0 ? `Never use these phrases: ${prohibited.join("; ")}.` : "",
    "If the caller asks to stop being contacted, acknowledge it clearly and end politely — their request is recorded.",
    "Keep answers short — this is a phone call, not an essay.",
  ].filter(Boolean).join("\n")

  const config: Record<string, unknown> = {
    name,
    firstMessage,
    model: {
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      systemPrompt,
      temperature: 0.4,
    },
  }
  if (id.elevenlabsVoiceId) {
    config.voice = { provider: "11labs", voiceId: id.elevenlabsVoiceId }
  }
  if (id.forwardNumber) {
    config.forwardingPhoneNumber = id.forwardNumber
  }
  return config
}

const notConfigured = (what: string) => ({ ok: false as const, error: `${what} not configured — the AI receptionist needs VAPI_API_KEY (and Twilio creds for number import). Nothing was changed.`, notConfigured: true as const })

/** Create or update the scope's inbound Vapi assistant from its AI identity
 *  profile; persists vapi_assistant_id back onto ai_identity_profiles. */
export async function ensureInboundAssistant(
  svc: any,
  params: { profileId: string },
): Promise<{ ok: true; assistantId: string; created: boolean } | { ok: false; error: string; notConfigured?: boolean }> {
  const key = process.env.VAPI_API_KEY
  if (!key) return notConfigured("Vapi")

  const { data: profile } = await svc.from("ai_identity_profiles")
    .select("id, brokerage_id, scope_type, scope_id, assistant_name, welcome_message, tone, prohibited_language, elevenlabs_voice_id, ai_call_forward_number, vapi_assistant_id")
    .eq("id", params.profileId).maybeSingle()
  if (!profile) return { ok: false, error: "AI identity profile not found" }
  const p = profile as any

  const [{ data: brk }, agentName] = await Promise.all([
    svc.from("brokerages").select("name").eq("id", p.brokerage_id).maybeSingle(),
    p.scope_type === "agent"
      ? svc.from("agents").select("users(first_name, last_name)").eq("id", p.scope_id).maybeSingle()
        .then((r: any) => {
          const u = Array.isArray(r.data?.users) ? r.data?.users[0] : r.data?.users
          return u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || null : null
        })
      : Promise.resolve(null),
  ])

  const config = buildInboundAssistantConfig({
    assistantName: p.assistant_name,
    welcomeMessage: p.welcome_message,
    tone: p.tone,
    brokerageName: (brk as any)?.name ?? null,
    agentName,
    prohibitedLanguage: p.prohibited_language,
    elevenlabsVoiceId: p.elevenlabs_voice_id,
    forwardNumber: p.ai_call_forward_number,
  })

  const existing = p.vapi_assistant_id as string | null
  const res = await callConnector<{ id: string }>({
    connector: "vapi",
    baseUrl: VAPI_BASE,
    path: existing ? `assistant/${existing}` : "assistant",
    method: existing ? "PATCH" : "POST",
    auth: { style: "bearer", token: key },
    body: config,
  })
  if (!res.ok || !res.data?.id) {
    return { ok: false, error: `Vapi assistant ${existing ? "update" : "create"} failed (${res.status ?? "—"}): ${res.error ?? "unknown"}` }
  }
  const assistantId = res.data.id
  if (assistantId !== existing) {
    await svc.from("ai_identity_profiles").update({ vapi_assistant_id: assistantId }).eq("id", p.id)
  }
  return { ok: true, assistantId, created: !existing }
}

/** Import a provisioned Twilio number into Vapi, bound to the assistant + the
 *  authoritative webhook — after this, a call TO the number reaches the AI.
 *  Persists vapi_phone_number_id + a phone_number_events audit row. */
export async function registerNumberWithVapi(
  svc: any,
  params: { numberRowId: string; assistantId: string },
): Promise<{ ok: true; vapiPhoneNumberId: string } | { ok: false; error: string; notConfigured?: boolean }> {
  const key = process.env.VAPI_API_KEY
  const twilioSid = process.env.TWILIO_ACCOUNT_SID
  const twilioToken = process.env.TWILIO_AUTH_TOKEN
  if (!key || !twilioSid || !twilioToken) return notConfigured("Vapi/Twilio")

  const { data: row } = await svc.from("vapi_phone_numbers")
    .select("id, brokerage_id, agent_user_id, phone_number, vapi_phone_number_id, is_active")
    .eq("id", params.numberRowId).maybeSingle()
  if (!row) return { ok: false, error: "Phone number row not found" }
  const n = row as any
  if (!n.is_active) return { ok: false, error: "Number is inactive" }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return { ok: false, error: "NEXT_PUBLIC_APP_URL not set — can't register the webhook URL" }
  const serverUrl = `${appUrl.replace(/\/$/, "")}/api/voice/vapi-webhook?brokerage_id=${n.brokerage_id}`

  const existing = n.vapi_phone_number_id as string | null
  const body: Record<string, unknown> = existing
    ? { assistantId: params.assistantId, server: { url: serverUrl, secret: process.env.VAPI_WEBHOOK_SECRET } }
    : {
        provider: "twilio",
        number: n.phone_number,
        twilioAccountSid: twilioSid,
        twilioAuthToken: twilioToken,
        assistantId: params.assistantId,
        server: { url: serverUrl, secret: process.env.VAPI_WEBHOOK_SECRET },
      }
  const res = await callConnector<{ id: string }>({
    connector: "vapi",
    baseUrl: VAPI_BASE,
    path: existing ? `phone-number/${existing}` : "phone-number",
    method: existing ? "PATCH" : "POST",
    auth: { style: "bearer", token: key },
    body,
  })
  if (!res.ok || !res.data?.id) {
    return { ok: false, error: `Vapi number ${existing ? "update" : "import"} failed (${res.status ?? "—"}): ${res.error ?? "unknown"}` }
  }
  const vapiPhoneNumberId = res.data.id

  if (vapiPhoneNumberId !== existing) {
    await svc.from("vapi_phone_numbers").update({ vapi_phone_number_id: vapiPhoneNumberId }).eq("id", n.id)
    await svc.from("phone_number_events").insert({
      brokerage_id: n.brokerage_id,
      agent_id: null,
      phone_number: n.phone_number,
      event_type: "vapi_registered",
      source: "inbound_binding",
      vapi_number_id: vapiPhoneNumberId,
      notes: "Number imported into Vapi and bound to the inbound reception assistant",
    }).then(undefined, () => {})
  }
  return { ok: true, vapiPhoneNumberId }
}

export interface ApplyBindingResult {
  ok: boolean
  applied: boolean
  assistantId?: string
  numbersBound?: number
  error?: string
  notConfigured?: boolean
}

/** The toggle made real: when ai_answer_calls is ON for a profile, ensure the
 *  assistant exists and bind every active number in the profile's scope. When
 *  OFF, nothing is changed (numbers keep working as plain lines). */
export async function applyInboundCallBinding(svc: any, profileId: string): Promise<ApplyBindingResult> {
  const { data: profile } = await svc.from("ai_identity_profiles")
    .select("id, brokerage_id, scope_type, scope_id, ai_answer_calls")
    .eq("id", profileId).maybeSingle()
  if (!profile) return { ok: false, applied: false, error: "Profile not found" }
  const p = profile as any
  if (!p.ai_answer_calls) return { ok: true, applied: false }

  const asst = await ensureInboundAssistant(svc, { profileId })
  if (!asst.ok) return { ok: false, applied: false, error: asst.error, notConfigured: asst.notConfigured }

  // Bind the scope's active numbers: agent scope → the agent's numbers;
  // brokerage scope → brokerage-scoped numbers.
  let q = svc.from("vapi_phone_numbers").select("id").eq("brokerage_id", p.brokerage_id).eq("is_active", true)
  if (p.scope_type === "agent") {
    const { data: agent } = await svc.from("agents").select("user_id").eq("id", p.scope_id).maybeSingle()
    const userId = (agent as any)?.user_id
    if (!userId) return { ok: false, applied: false, error: "Agent has no user account" }
    q = q.eq("agent_user_id", userId)
  } else {
    q = q.eq("scope_type", "brokerage")
  }
  const { data: numbers } = await q.limit(10)

  let bound = 0
  for (const num of (numbers ?? []) as any[]) {
    const r = await registerNumberWithVapi(svc, { numberRowId: num.id, assistantId: asst.assistantId })
    if (r.ok) bound += 1
  }
  return { ok: true, applied: true, assistantId: asst.assistantId, numbersBound: bound }
}
