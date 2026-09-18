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
import {
  buildReceptionPrompt, parseTurnPlan, transcriptToMessages, TURN_INSTRUCTIONS, TOOL_TURN_GUIDANCE,
  VOICE_TOOL_ALLOWLIST, type VoiceToolName, type VoiceTurnPlan,
} from "./reception-brain"
import type { ToolPersona } from "@/lib/ai-isa/persona-tool-policy"
import type { InboundIdentity } from "./inbound-number-binding"

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
  const { data: num } = await svc.from("tenant_phone_numbers")
    .select("id, brokerage_id, agent_user_id")
    .eq("phone_digits", digits).eq("is_active", true).maybeSingle()
  if (!num) return null
  const n = num as any

  // The scope's AI identity profile — the FULL settings cascade (owner rule:
  // nothing hardcoded, brand flows platform → brokerage → team → agent):
  // most-specific wins — agent profile, else the agent's TEAM profile, else
  // the brokerage profile.
  let profile: any = null
  let teamId: string | null = null
  if (n.agent_user_id) {
    const { data: agent } = await svc.from("agents").select("id, team_id").eq("user_id", n.agent_user_id).maybeSingle()
    if (agent) {
      teamId = (agent as any).team_id ?? null
      const { data: p } = await svc.from("ai_identity_profiles").select("*")
        .eq("scope_type", "agent").eq("scope_id", (agent as any).id).maybeSingle()
      profile = p
    }
  }
  if (!profile && teamId) {
    const { data: p } = await svc.from("ai_identity_profiles").select("*")
      .eq("scope_type", "team").eq("scope_id", teamId).maybeSingle()
    profile = p
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
  const { data: row } = await svc.from("tenant_phone_numbers")
    .select("id, brokerage_id, phone_number, twilio_number_sid, is_active")
    .eq("id", numberRowId).maybeSingle()
  if (!row) return { ok: false, error: "Number row not found" }
  const n = row as any
  if (!n.is_active) return { ok: false, error: "Number is inactive" }
  if (!n.twilio_number_sid) return { ok: false, error: "Number has no Twilio SID on file — re-provision it first" }

  const { resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
  const creds = await resolveTenantTwilioCreds(svc, n.brokerage_id)
  if (!creds) return { ok: false, error: "Twilio not configured — nothing was changed.", notConfigured: true }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return { ok: false, error: "NEXT_PUBLIC_APP_URL not set — can't register the webhook URL" }
  const base = appUrl.replace(/\/$/, "")

  // Official Twilio SDK adapter (lib/providers/twilio/client.ts) — same
  // POST /IncomingPhoneNumbers/{sid}.json endpoint, same price.
  const { updateIncomingPhoneNumber } = await import("@/lib/providers/twilio/client")
  const res = await updateIncomingPhoneNumber(creds, n.twilio_number_sid, {
    voiceUrl: `${base}/api/voice/twilio/inbound`, voiceMethod: "POST",
    // Texts to the tenant's line ride the EXISTING provider-inbound ingress
    // (opt-out detection + unified inbox); the status callback closes any
    // ledger row a mid-call hangup left open.
    smsUrl: `${base}/api/providers/inbound`, smsMethod: "POST",
    statusCallback: `${base}/api/voice/twilio/status`, statusCallbackMethod: "POST",
  })
  if (!res.ok) return { ok: false, error: `Twilio VoiceUrl update failed (${res.status ?? "—"}): ${res.error ?? "unknown"}` }

  await svc.from("phone_number_events").insert({
    brokerage_id: n.brokerage_id, phone_number: n.phone_number,
    event_type: "webhooks_bound", source: "inbound_binding",
    notes: "Number bound to the Twilio-native AI lane (VoiceUrl → /api/voice/twilio/inbound; SmsUrl → /api/providers/inbound; StatusCallback → /api/voice/twilio/status)",
  }).then(undefined, () => {})
  return { ok: true }
}

/** RSVP the caller to a matching listing's next open house — live on the
 *  call, both transports. Honest: no matching listing or no upcoming event →
 *  false (the spoken reply still stands; the agent sees the transcript). */
export async function rsvpOpenHouseFromCall(
  svc: any,
  ctx: InboundCallContext,
  call: { id: string; contact_id: string | null },
  address: string,
): Promise<boolean> {
  if (!call.contact_id) return false
  try {
    const hint = address.replace(/[%,]/g, "").slice(0, 80)
    const { data: listing } = await svc.from("listings").select("id, address")
      .eq("brokerage_id", ctx.brokerageId).is("deleted_at", null)
      .ilike("address", `%${hint}%`).limit(1).maybeSingle()
    if (!listing) return false
    const { data: event } = await svc.from("open_house_events").select("id, event_date, start_time")
      .eq("brokerage_id", ctx.brokerageId).eq("listing_id", (listing as any).id)
      .in("status", ["scheduled", "marketing", "active"])
      .gte("event_date", new Date().toISOString().slice(0, 10))
      .order("event_date", { ascending: true }).limit(1).maybeSingle()
    if (!event) return false

    // Idempotent per (event, contact): a repeat "yes" updates, never duplicates.
    const { data: existing } = await svc.from("open_house_rsvp_tracking").select("id")
      .eq("event_id", (event as any).id).eq("contact_id", call.contact_id).maybeSingle()
    if (existing) {
      await svc.from("open_house_rsvp_tracking").update({ rsvp_status: "yes", rsvp_updated_at: new Date().toISOString() })
        .eq("id", (existing as any).id).then(undefined, () => {})
    } else {
      const { error } = await svc.from("open_house_rsvp_tracking").insert({
        brokerage_id: ctx.brokerageId, contact_id: call.contact_id,
        event_id: (event as any).id, rsvp_status: "yes", source: "ai_reception",
      })
      if (error) return false
    }
    if (ctx.agentUserId) {
      await svc.from("notifications").insert({
        user_id: ctx.agentUserId, brokerage_id: ctx.brokerageId, type: "open_house_rsvp",
        title: "The AI receptionist RSVP'd a caller to your open house",
        body: `${(listing as any).address} on ${(event as any).event_date} — RSVP'd live on an inbound call. Transcript on the call record.`,
        entity_type: "voice_call", entity_id: call.id, priority: "medium", channel: "in_app", is_read: false,
      }).then(undefined, () => {})
    }
    // Written confirmation card — same transactional rail as the booking text.
    await textCallConfirmation(svc, ctx, call.contact_id,
      `You're on the list for the open house at ${(listing as any).address}, ${(event as any).event_date}${(event as any).start_time ? ` at ${String((event as any).start_time).slice(0, 5)}` : ""}. See you there! Reply STOP to opt out.`)
    return true
  } catch { return false }
}

/** "What's my home worth?" on a live call → ONE gated CMA proposal on the
 *  canonical rail (deduped per call) — the AI never quotes a value itself. */
export async function proposeSellerLeadFromCall(
  svc: any,
  ctx: InboundCallContext,
  call: { id: string; contact_id: string | null },
  address: string | null,
): Promise<boolean> {
  if (!call.contact_id) return false
  try {
    const tag = `[SELLER_LEAD] [${call.id}]`
    const { data: dup } = await svc.from("agent_client_messages").select("id")
      .ilike("rationale", `${tag}%`).limit(1).maybeSingle()
    if (dup) return false
    const { data: contact } = await svc.from("contacts").select("first_name, last_name").eq("id", call.contact_id).maybeSingle()
    const who = [((contact as any)?.first_name ?? "").trim(), ((contact as any)?.last_name ?? "").trim()].filter(Boolean).join(" ") || "A caller"
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const p = await proposeClientMessage({
      brokerageId: ctx.brokerageId,
      agentKind: "listing_concierge",
      entityType: "contact",
      entityId: call.contact_id,
      audience: "agent",
      subject: `Seller hand-raise — ${who} asked what their home is worth`,
      body: `${who} asked about their home's value on a live call${address ? ` (${address})` : ""}. Approve and the team preps a real CMA and follow-up — the AI promised a professional valuation, not a guess.`,
      rationale: `${tag} — valuation ask on a live reception call${address ? `; property: ${address.slice(0, 120)}` : ""}. Transcript on the call record.`,
    }, svc)
    return (p as any)?.ok !== false
  } catch { return false }
}

/** Callback task from a live call — the WRITER half of the owner's ruling
 *  (wave 55: "make a task to call a person back"). Both transports call this
 *  with whatever the caller's OWN number is (voice_calls.phone_from) as the
 *  fallback when they didn't give a different one. Best-effort by design, same
 *  as bookShowingFromCall/rsvpOpenHouseFromCall above: the spoken confirmation
 *  already stands; a write failure is reported to the console, not the caller. */
export async function createCallbackTaskFromCall(
  svc: any,
  ctx: InboundCallContext,
  call: { id: string; contact_id: string | null; lead_id?: string | null; phone_from?: string | null },
  phone: string | null,
  whenPhrase: string,
  reason: string | null,
): Promise<{ ok: boolean; taskId?: string; dueIso?: string; error?: string }> {
  try {
    // The caller's own ANI when they didn't name a different number — read off
    // the ledger row when the caller passed a bare row (turn route always has
    // it; the relay route's `call` select below is extended to carry it too).
    let callerAni = call.phone_from ?? null
    if (!callerAni) {
      const { data: row } = await svc.from("voice_calls").select("phone_from").eq("id", call.id).maybeSingle()
      callerAni = (row as any)?.phone_from ?? null
    }
    const { createCallbackTask } = await import("@/lib/ai-isa/callback-task")
    const result = await createCallbackTask(svc, {
      brokerageId: ctx.brokerageId,
      contactId: call.contact_id,
      leadId: call.lead_id ?? null,
      phone: (phone ?? callerAni ?? "").trim(),
      whenPhrase,
      reason,
      voiceCallId: call.id,
      assigneeType: "ai_isa",
    })
    if (!result.ok) {
      console.error("[twilio-voice] callback task NOT created — the spoken promise stands with nothing behind it:", result.error)
      return result
    }
    if (ctx.agentUserId) {
      await svc.from("notifications").insert({
        user_id: ctx.agentUserId, brokerage_id: ctx.brokerageId, type: "callback_requested",
        title: "The AI receptionist booked a callback",
        body: `A caller asked to be called back${reason ? ` about: ${reason}` : ""} — the ISA will place the call around ${new Date(result.dueIso!).toLocaleString()}. Transcript on the call record.`,
        entity_type: "voice_call", entity_id: call.id, priority: "medium", channel: "in_app", is_read: false,
      }).then(undefined, () => {})
    }
    return result
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "createCallbackTaskFromCall threw" }
  }
}

/**
 * Lane 73B (context object) / 73E (native execution) — the CALL-scoped
 * context a voice turn's live property tools execute against. Deliberately a
 * SEPARATE, smaller shape than the AI-SDK chat surfaces' contexts (portal/
 * widget/custom-llm/handle-inbound-email) because a voice turn resolves its
 * own persona from the CALL's linked contact (or has none — an anonymous
 * caller resolves to the 'buyer' default, same posture as every other
 * surface), never from a request body.
 */
export interface VoiceToolExecContext {
  brokerageId: string
  agentId: string | null
  /** contacts.id linked to this call, when known — feeds resolveToolPersona
   *  AND lets verify_address persist its verdict, same as every chat surface. */
  contactId: string | null
  /** Stable per-CALL key (voice_calls.id) — scopes the page-before-preview/
   *  count ordering rule and the persona spend cap to THIS call, never shared
   *  across calls or tenants. */
  conversationKey: string
}

type GenerateTextRoutedFn = (args: {
  feature: string; prompt: string; temperature: number; maxTokens: number
  tools?: Record<string, unknown>; maxSteps?: number; abortSignal?: AbortSignal
}) => Promise<{ text: string }>
type BatchDataIsaToolsFn = (ctx: {
  brokerageId: string; agentId: string | null; persona: ToolPersona; conversationKey: string; contactId: string | null
}) => Promise<Record<string, unknown>>

/** Injectable dependencies for `planTurnWithPrompt` — @proofSeam so a proof
 *  can exercise the WHOLE native tool-calling turn (persona resolution →
 *  tools map → bounded `generateTextRouted({tools, maxSteps, abortSignal})`
 *  → JSON parse, plus the timeout→plan-only fallback) with zero network calls
 *  and zero real AI-gateway/BatchData spend. Production callers omit `deps`
 *  entirely; the real `generateTextRouted`/`batchDataIsaTools` are imported
 *  lazily exactly as before this lane. */
export interface VoiceToolRoundDeps {
  generateTextRouted?: GenerateTextRoutedFn
  batchDataIsaTools?: BatchDataIsaToolsFn
}

/**
 * Lane 73E — hard per-turn deadline for the native tool-calling attempt.
 * `AbortSignal.timeout(VOICE_TOOL_ROUND_DEADLINE_MS)` bounds the WHOLE
 * `generateTextRouted({tools, maxSteps: VOICE_TOOL_ROUND_MAX_STEPS})` call —
 * every step the SDK's own multi-step loop runs (each a real model round
 * trip, some interleaved with a live BatchData MCP call) has to fit inside
 * this window or the turn aborts and falls back to the plan-only path below.
 *
 * DERIVED, not measured (CLAUDE.md §2 — this is a policy ceiling, published
 * with its reasoning, not a claimed measurement): this repo's own latency
 * research (docs/twilio-vs-elevenlabs-voice-2026-09.md) records ConversationRelay's
 * transport itself at ~491ms median (versusref.com, Jul 2026) and this
 * engine's turn-based `<Gather>` round trip — ONE no-tool model call, same as
 * today's plan-only fallback — at "~1-2s" (that doc's own comparison table).
 * A bounded native round can run up to VOICE_TOOL_ROUND_MAX_STEPS sequential
 * model calls, each potentially interleaved with a live vendor call, so this
 * budgets roughly 2-3x the single-call baseline — inside the ~3-5s window
 * voice-UX practice treats as "still feels live" before dead air reads as a
 * dropped call — rather than letting an unbounded tool loop run past it.
 * Env-tunable (`VOICE_TOOL_ROUND_DEADLINE_MS`) so ops can retune against real
 * production call audio once it exists; that measurement is UNRESOLVED here.
 */
export const VOICE_TOOL_ROUND_DEADLINE_MS = Number(process.env.VOICE_TOOL_ROUND_DEADLINE_MS) || 4000
/** ≤ 3 per the turn-engine design ceiling — up to two tool-call steps plus
 *  the final JSON-only step, the SDK's own loop deciding how many it needs. */
export const VOICE_TOOL_ROUND_MAX_STEPS = 3

/** PURE-ish (one DB read, no AI/network call): resolve this call's tool
 *  persona from its linked contact, same derivation every chat surface uses. */
async function resolveVoiceToolPersona(toolCtx: VoiceToolExecContext): Promise<ToolPersona> {
  const { resolveToolPersona } = await import("@/lib/ai-isa/persona-tool-policy")
  let contactType: string | null = null
  let contactPersona: string | null = null
  let homeOwnerStatus: string | null = null
  if (toolCtx.contactId) {
    try {
      const { createServiceClient } = await import("@/lib/supabase/service")
      const svc = createServiceClient()
      const { data: contact } = await svc
        .from("contacts")
        .select("contact_type, contact_persona, home_owner_status")
        .eq("id", toolCtx.contactId)
        .maybeSingle()
      contactType = (contact as any)?.contact_type ?? null
      contactPersona = (contact as any)?.contact_persona ?? null
      homeOwnerStatus = (contact as any)?.home_owner_status ?? null
    } catch { /* an unreadable contact row just resolves the default persona below */ }
  }
  return resolveToolPersona({ contactType, contactPersona, homeOwnerStatus })
}

/** One turn against ANY system prompt (reception or outbound brief) — the
 *  shared engine both directions ride.
 *
 * `toolCtx` is OPTIONAL: when omitted (the outbound ISA lane today), this is
 * a single plain `generateTextRouted` call with no tools — unchanged from
 * before lane 73B ever existed.
 *
 * Lane 73E — when `toolCtx` IS passed, this resolves the call's persona,
 * narrows lib/ai-isa/batchdata-isa-tools.ts's registry to
 * `VOICE_TOOL_ALLOWLIST` (property lookup/comps/address verification only —
 * never skip-trace/dnc/tcpa on a phone call), and — ONLY if that narrowed set
 * is non-empty — makes ONE `generateTextRouted` call with REAL AI-SDK
 * `tools:` + `maxSteps: VOICE_TOOL_ROUND_MAX_STEPS` + a hard
 * `abortSignal: AbortSignal.timeout(VOICE_TOOL_ROUND_DEADLINE_MS)`. The SDK's
 * own multi-step loop decides whether/how many times to call a tool (bounded
 * by the step cap) and folds each tool's result into its own context exactly
 * once — no manual re-prompt. If that call throws (including a timeout —
 * AI SDK abort errors surface as a thrown error, so ANY throw here is treated
 * the same way) it FALLS BACK to the plain no-tools call below: fail safe,
 * the caller always gets a spoken reply, never silence on a live call.
 * `deps` is a @proofSeam (see VoiceToolRoundDeps) — production callers never
 * pass it. */
export async function planTurnWithPrompt(
  systemPrompt: string,
  transcript: string | null,
  callerUtterance: string,
  toolCtx?: VoiceToolExecContext,
  deps: VoiceToolRoundDeps = {},
): Promise<VoiceTurnPlan> {
  const history = transcriptToMessages(transcript)
  const convo = history.map((m) => `${m.role === "assistant" ? "AI" : "Caller"}: ${m.content}`).join("\n")
  const generateFn: GenerateTextRoutedFn = deps.generateTextRouted ?? (await import("@/lib/ai/models")).generateTextRouted

  const plainCall = async (): Promise<VoiceTurnPlan> => {
    const { text } = await generateFn({
      feature: "voice_reception_turn",
      prompt: `${systemPrompt}\n\n${TURN_INSTRUCTIONS}\n\nConversation so far:\n${convo || "(call just connected)"}\nCaller: ${callerUtterance}\n\nYour JSON:`,
      temperature: 0.4,
      maxTokens: 300,
    })
    return parseTurnPlan(text)
  }

  if (!toolCtx) return plainCall()

  const batchDataIsaToolsFn: BatchDataIsaToolsFn =
    deps.batchDataIsaTools ?? (await import("@/lib/ai-isa/batchdata-isa-tools")).batchDataIsaTools
  const persona = await resolveVoiceToolPersona(toolCtx)
  const registry = await batchDataIsaToolsFn({
    brokerageId: toolCtx.brokerageId,
    agentId: toolCtx.agentId,
    persona,
    conversationKey: toolCtx.conversationKey,
    contactId: toolCtx.contactId,
  })
  const voiceTools: Partial<Record<VoiceToolName, unknown>> = {}
  for (const name of VOICE_TOOL_ALLOWLIST) {
    if ((registry as Record<string, unknown>)[name]) voiceTools[name] = (registry as Record<string, unknown>)[name]
  }
  // No token configured, or this persona's allowlist grants none of the four
  // voice-line tools — nothing to offer the model, so skip the tool-enabled
  // call entirely rather than paying for one with an empty `tools:` map.
  if (Object.keys(voiceTools).length === 0) return plainCall()

  try {
    const { text } = await generateFn({
      feature: "voice_reception_turn",
      prompt: `${systemPrompt}\n\n${TURN_INSTRUCTIONS}\n\n${TOOL_TURN_GUIDANCE}\n\nConversation so far:\n${convo || "(call just connected)"}\nCaller: ${callerUtterance}\n\nYour JSON:`,
      temperature: 0.4,
      maxTokens: 400,
      tools: voiceTools,
      maxSteps: VOICE_TOOL_ROUND_MAX_STEPS,
      abortSignal: AbortSignal.timeout(VOICE_TOOL_ROUND_DEADLINE_MS),
    })
    return parseTurnPlan(text)
  } catch (e: any) {
    console.error("[twilio-voice] native tool round failed or hit its deadline — falling back to the plan-only path (fail safe, never silence on a live call):", e?.message ?? e)
    return plainCall()
  }
}

/** The booking side-effect BOTH transports share (Gather turn + relay plan):
 *  a real scheduled showing + the agent's heads-up. Best-effort by design —
 *  the spoken confirmation stands; the transcript is on the call record. */
export async function bookShowingFromCall(
  svc: any,
  ctx: InboundCallContext,
  call: { id: string; contact_id: string; agent_id: string },
  dateTimeIso: string,
): Promise<void> {
  try {
    const when = new Date(dateTimeIso)
    await svc.from("showings").insert({
      contact_id: call.contact_id, agent_id: call.agent_id,
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
        entity_type: "voice_call", entity_id: call.id, priority: "high", channel: "in_app", is_read: false,
      }).then(undefined, () => {})
    }
    // Written confirmation halves no-shows. TRANSACTIONAL (they called in and
    // booked): EWC skipped per TCPA, DNC/quiet-hours/opt-out still enforced
    // inside sendSMS. Same rail as the showing-lifecycle reminder.
    await textCallConfirmation(svc, ctx, call.contact_id,
      `You're booked for ${when.toLocaleString("en-US", { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${ctx.identity.agentName ? ` with ${ctx.identity.agentName}` : ""}. Reply R to reschedule. Reply STOP to opt out.`)
  } catch { /* the spoken confirmation stands; the agent sees the transcript */ }
}

/** Best-effort transactional confirmation text after a live-call outcome. */
async function textCallConfirmation(svc: any, ctx: InboundCallContext, contactId: string | null, message: string): Promise<void> {
  if (!contactId) return
  try {
    const { data: contact } = await svc.from("contacts").select("phone").eq("id", contactId).maybeSingle()
    const phone = (contact as any)?.phone
    if (!phone) return
    const { sendSMS } = await import("@/lib/providers/messaging")
    await sendSMS({ to: phone, message, contactId, brokerageId: ctx.brokerageId, transactional: true })
  } catch { /* the spoken outcome stands */ }
}

/** One reception turn: transcript + new utterance → the brain → plan. Pass
 *  svc and the reception AI answers from the tenant's LIVE INVENTORY (facts
 *  from listings rows injected per turn; the no-invention rule scopes to the
 *  list — see lib/voice/reception-inventory). */
export async function planReceptionTurn(
  ctx: InboundCallContext,
  transcript: string | null,
  callerUtterance: string,
  svc?: any,
  extraRules?: string,
  /** Lane 73B (hook) / 73E (native execution) — when the CALLER passes the
   *  call row's own id + linked contact (voice_calls.id / .contact_id), this
   *  turn's persona-scoped property tools become available to the model for
   *  real (native AI-SDK tool-calling — see planTurnWithPrompt above).
   *  Omitted → a plain no-tools call, exactly as before lane 73B ever
   *  existed — additive, never a silent behavior change for a caller that
   *  has not threaded a call id through yet. */
  voiceToolCtx?: { callId: string; contactId: string | null },
): Promise<VoiceTurnPlan> {
  const { systemPrompt } = buildReceptionPrompt(ctx.identity)
  let prompt = systemPrompt
  if (svc) {
    const { loadInventoryContext } = await import("@/lib/voice/reception-inventory")
    const inventory = await loadInventoryContext(svc, ctx.brokerageId, callerUtterance)
    if (inventory) prompt = `${prompt}\n\n${inventory}`
  }
  if (extraRules) prompt = `${prompt}\n\n${extraRules}`
  const toolCtx: VoiceToolExecContext | undefined = voiceToolCtx
    ? { brokerageId: ctx.brokerageId, agentId: null, contactId: voiceToolCtx.contactId, conversationKey: voiceToolCtx.callId }
    : undefined
  return planTurnWithPrompt(prompt, transcript, callerUtterance, toolCtx)
}
