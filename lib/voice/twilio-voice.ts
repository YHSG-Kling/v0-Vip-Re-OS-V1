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
  PLATFORM_TURN_INSTRUCTIONS, PLATFORM_TOOL_TURN_GUIDANCE,
  VOICE_TOOL_ALLOWLIST, type VoiceTurnPlan,
} from "./reception-brain"
import type { ToolPersona } from "@/lib/ai-isa/persona-tool-policy"
import type { InboundIdentity } from "./inbound-number-binding"
import type { PlatformReceptionContext } from "./platform-reception"

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
  let agentsId: string | null = null
  if (n.agent_user_id) {
    const { data: agent } = await svc.from("agents").select("id, team_id").eq("user_id", n.agent_user_id).maybeSingle()
    if (agent) {
      agentsId = (agent as any).id ?? null
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

  // Wave 75 — brand voice + KB + business processes + office hours + service
  // areas, resolved ONCE per call and threaded into every voice prompt via
  // buildQualificationPrompt's `brand` input (lib/voice/reception-brain.ts).
  // Best-effort: a resolution failure degrades to no brand block, never a
  // dropped call.
  let brand: unknown = null
  try {
    const { loadBrandPlaybookContext } = await import("@/lib/ai-isa/brand-playbook-context")
    brand = await loadBrandPlaybookContext({ brokerageId: n.brokerage_id, agentId: agentsId, teamId })
  } catch { /* brand context unavailable — the call still connects */ }

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
      brand,
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
      // Blind-spot burn-down (lane 75D, notification fan-out census): a
      // service-role write must sentinelWrite, not `.then(undefined,()=>{})`
      // (CLAUDE.md §3 write-sentinel ruling) — a lost heads-up now ledgers
      // to self_heal_events instead of vanishing.
      const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
      await sentinelWrite(svc, svc.from("notifications").insert({
        user_id: ctx.agentUserId, brokerage_id: ctx.brokerageId, type: "open_house_rsvp",
        title: "The AI receptionist RSVP'd a caller to your open house",
        body: `${(listing as any).address} on ${(event as any).event_date} — RSVP'd live on an inbound call. Transcript on the call record.`,
        entity_type: "voice_call", entity_id: call.id, priority: "medium", channel: "in_app", is_read: false,
      }), { table: "notifications", flow: "voice_open_house_rsvp_notify", brokerageId: ctx.brokerageId, reason: "the RSVP itself already succeeded; this is only the agent heads-up" })
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
      const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
      await sentinelWrite(svc, svc.from("notifications").insert({
        user_id: ctx.agentUserId, brokerage_id: ctx.brokerageId, type: "callback_requested",
        title: "The AI receptionist booked a callback",
        body: `A caller asked to be called back${reason ? ` about: ${reason}` : ""} — the ISA will place the call around ${new Date(result.dueIso!).toLocaleString()}. Transcript on the call record.`,
        entity_type: "voice_call", entity_id: call.id, priority: "medium", channel: "in_app", is_read: false,
      }), { table: "notifications", flow: "voice_callback_requested_notify", brokerageId: ctx.brokerageId, reason: "the callback task itself already exists; this is only the agent heads-up" })
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
  /** agents.id (voice_calls.agent_id — NEVER InboundCallContext.agentUserId,
   *  which is a users.id; the two are disjoint, CLAUDE.md §3). Lane 76A
   *  identity fix: this was hardcoded `null` by planReceptionTurn, so on every
   *  live call find_listing_appointment_slots/book_listing_appointment refused
   *  ("No agent is assigned yet") and notifyAssignedAgent no-op'd. */
  agentId: string | null
  /** contacts.id linked to this call, when known — feeds resolveToolPersona
   *  AND lets verify_address persist its verdict, same as every chat surface. */
  contactId: string | null
  /** leads.id linked to this call, when known and no contact exists yet —
   *  lane 75D: the SAME identity fallback lib/ai-isa/customer-context-tools.ts
   *  already uses for every chat surface, so record_qualification/
   *  schedule_callback/etc. register on a live call exactly as they do on an
   *  email/widget/portal thread (never a model-suppliable id). */
  leadId: string | null
  /** Stable per-CALL key (voice_calls.id) — scopes the page-before-preview/
   *  count ordering rule and the persona spend cap to THIS call, never shared
   *  across calls or tenants. */
  conversationKey: string
}

type GenerateTextRoutedFn = (args: {
  feature: string; prompt: string; temperature: number; maxTokens: number
  tools?: Record<string, unknown>; maxSteps?: number; abortSignal?: AbortSignal
  /** Usage-logging only, never routing — see lib/ai/models.ts RoutedTextRequest. */
  brokerageId?: string | null; agentId?: string | null; manager?: string | null
  contextExtra?: Record<string, unknown> | null
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
 *  persona from its linked contact — or, lane 76A, from its linked LEAD when
 *  no contact exists yet (leads.lead_type / persona / home_owner_status, the
 *  SAME fallback app/actions/ai-isa/handle-inbound-email.ts already uses) —
 *  the same derivation every chat surface uses. A leads.id is read from the
 *  `leads` table only; it is never used to query `contacts`. */
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
  } else if (toolCtx.leadId) {
    try {
      const { createServiceClient } = await import("@/lib/supabase/service")
      const svc = createServiceClient()
      const { data: lead } = await svc
        .from("leads")
        .select("lead_type, persona, home_owner_status")
        .eq("id", toolCtx.leadId)
        .maybeSingle()
      const leadType = (lead as any)?.lead_type ?? null
      contactType = leadType === "seller" ? "seller" : leadType ? "buyer" : null
      contactPersona = (lead as any)?.persona ?? null
      homeOwnerStatus = (lead as any)?.home_owner_status ?? null
    } catch { /* an unreadable lead row just resolves the default persona below */ }
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
/**
 * THE shared tool-round engine (lane 75D extraction) — bound/deadline/
 * telemetry/fallback logic that BOTH deployments ride, unchanged in
 * behavior from what `planTurnWithPrompt` (tenant) always did; the platform
 * deployment's branch of `planReceptionTurn` below now goes through this
 * SAME function instead of a second hand-copied try/catch (TOMBSTONE:
 * lib/voice/platform-reception.ts's former `planPlatformReceptionTurn`
 * body). `tools: {}` skips the tool-enabled call entirely — no paid call
 * with an empty `tools:` map, exactly as before.
 */
async function runVoiceTurnRound(params: {
  systemPrompt: string
  turnInstructions: string
  toolGuidance: string
  transcript: string | null
  callerUtterance: string
  tools: Record<string, unknown>
  /** null → no ai_tool_usage failure telemetry (the platform line has no
   *  brokerage dimension to attribute it to; console.error still fires). */
  telemetry: { brokerageId: string; agentId: string | null } | null
  generateFn: GenerateTextRoutedFn
}): Promise<VoiceTurnPlan> {
  const history = transcriptToMessages(params.transcript)
  const convo = history.map((m) => `${m.role === "assistant" ? "AI" : "Caller"}: ${m.content}`).join("\n")

  const plainCall = async (): Promise<VoiceTurnPlan> => {
    const { text } = await params.generateFn({
      feature: "voice_reception_turn",
      prompt: `${params.systemPrompt}\n\n${params.turnInstructions}\n\nConversation so far:\n${convo || "(call just connected)"}\nCaller: ${params.callerUtterance}\n\nYour JSON:`,
      temperature: 0.4,
      maxTokens: 300,
    })
    return parseTurnPlan(text)
  }

  if (Object.keys(params.tools).length === 0) return plainCall()

  // DEADLINE TELEMETRY (blind-spot burn-down, lane 74C, 2026-09-18) — the
  // deadline above was DERIVED, not measured (see its own header), with the
  // real production-call measurement UNRESOLVED. This closes that: every
  // tool-round attempt lands on ai_tool_usage (the EXISTING cost/latency
  // ledger, manager_ops.ts's own per-manager p95 reader) tagged
  // `context_json.toolRound: true`, so the deadline can be retuned from real
  // call data instead of the policy-ceiling reasoning alone.
  const toolRoundStartedAt = Date.now()
  try {
    const { text } = await params.generateFn({
      feature: "voice_reception_turn",
      prompt: `${params.systemPrompt}\n\n${params.turnInstructions}\n\n${params.toolGuidance}\n\nConversation so far:\n${convo || "(call just connected)"}\nCaller: ${params.callerUtterance}\n\nYour JSON:`,
      temperature: 0.4,
      maxTokens: 400,
      tools: params.tools,
      maxSteps: VOICE_TOOL_ROUND_MAX_STEPS,
      abortSignal: AbortSignal.timeout(VOICE_TOOL_ROUND_DEADLINE_MS),
      brokerageId: params.telemetry?.brokerageId ?? null,
      agentId: params.telemetry?.agentId ?? null,
      manager: "ai_isa",
      contextExtra: { toolRound: true, deadlineMs: VOICE_TOOL_ROUND_DEADLINE_MS, deadlineHit: false },
    })
    return parseTurnPlan(text)
  } catch (e: any) {
    const elapsedMs = Date.now() - toolRoundStartedAt
    // A hit is inferred from elapsed time, not from the error shape: the AI
    // SDK's own abort surfaces as an ordinary thrown error (this file's own
    // header says so), so there is no reliable "TimeoutError" to match on —
    // >=90% of the deadline window covers both a clean AbortSignal fire and
    // the fallback-model retry the primary catch inside generateTextRouted
    // itself can trigger before this catch ever sees it.
    const deadlineHit = elapsedMs >= VOICE_TOOL_ROUND_DEADLINE_MS * 0.9
    console.error("[voice-turn-engine] native tool round failed or hit its deadline — falling back to the plan-only path (fail safe, never silence on a live call):", e?.message ?? e)
    // generateTextRouted's OWN ai_tool_usage write only runs on its success
    // path — when it throws (this catch), NOTHING lands on the ledger, so a
    // timed-out or erroring tool round was previously INVISIBLE to the very
    // data this deadline needs to be tuned from. Logged directly, best-effort
    // (a lost telemetry row must never turn a fail-safe fallback into a
    // dropped call).
    try {
      if (params.telemetry?.brokerageId) {
        const { logAIUsage } = await import("@/lib/ai/cost-tracking")
        const { selectModelForTask } = await import("@/lib/ai/models")
        await logAIUsage({
          userId: null,
          brokerageId: params.telemetry.brokerageId,
          agentId: params.telemetry.agentId,
          model: selectModelForTask("voice_reception_turn").model,
          inputTokens: 0,
          outputTokens: 0,
          feature: "voice_reception_turn",
          manager: "ai_isa",
          executionTimeMs: elapsedMs,
          success: false,
          contextExtra: {
            toolRound: true,
            deadlineMs: VOICE_TOOL_ROUND_DEADLINE_MS,
            deadlineHit,
            errorMessage: String(e?.message ?? e).slice(0, 300),
          },
        })
      }
    } catch { /* telemetry is best-effort — the fallback below still runs */ }
    return plainCall()
  }
}

export async function planTurnWithPrompt(
  systemPrompt: string,
  transcript: string | null,
  callerUtterance: string,
  toolCtx?: VoiceToolExecContext,
  deps: VoiceToolRoundDeps = {},
): Promise<VoiceTurnPlan> {
  const generateFn: GenerateTextRoutedFn = deps.generateTextRouted ?? (await import("@/lib/ai/models")).generateTextRouted

  if (!toolCtx) {
    return runVoiceTurnRound({
      systemPrompt, turnInstructions: TURN_INSTRUCTIONS, toolGuidance: "",
      transcript, callerUtterance, tools: {}, telemetry: null, generateFn,
    })
  }

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
  const allowlisted: Record<string, unknown> = {}
  for (const name of VOICE_TOOL_ALLOWLIST) {
    if ((registry as Record<string, unknown>)[name]) allowlisted[name] = (registry as Record<string, unknown>)[name]
  }
  // Lane 75D — the SAME free capture/follow-up bundle every chat surface
  // offers (get_my_context, search_our_listings always; once a contact/lead
  // is linked: request_showing, schedule_callback, schedule_home_value_review,
  // find/book_listing_appointment, send_matching_listings, record_qualification).
  // Zero vendor spend — merged in BEFORE the cost-ranked selection below so
  // it always sorts first (rank 0), never displacing the property tools.
  const { buildCustomerFreeTools } = await import("@/lib/ai-isa/customer-context-tools")
  // (wave 75 integration) buildCustomerFreeTools is async since lane 75B —
  // it reads the brand's capability toggles — so it MUST be awaited; a bare
  // spread of the promise silently emptied the capture bundle on every call.
  // Lane 76A — the resolved persona now reaches the bundle (the identity-gated
  // set, persona-steered by the catalogue's allowlist), and agentId is the
  // call row's agents.id (see VoiceToolExecContext). Lane 77A: a vendor is a
  // SEAT, not a persona — a contact typed 'vendor' resolves to sphere here and
  // the vendor seat's own tools never ride the customer voice line
  // (lib/ai-isa/user-type-tool-policy.ts).
  const freeTools = await buildCustomerFreeTools({
    brokerageId: toolCtx.brokerageId, contactId: toolCtx.contactId, leadId: toolCtx.leadId, agentId: toolCtx.agentId,
    persona,
  })
  // Lane 74B — cost-ranked order applies to voice too (owner: "tools for the
  // ai agents should not be using batchdata tools if there are less
  // expensive tools"). VOICE_TOOL_ALLOWLIST narrows the BatchData side to
  // the property-only subset FIRST (unchanged); selectToolsForPersona then
  // drops any BatchData tool a cheaper same-registry tool already covers and
  // sorts EVERYTHING (free bundle included, always rank 0) cheapest-first.
  const { selectToolsForPersona } = await import("@/lib/ai-isa/persona-tool-policy")
  const merged: Record<string, unknown> = { ...freeTools, ...allowlisted }
  const voiceTools = selectToolsForPersona(merged)

  return runVoiceTurnRound({
    systemPrompt, turnInstructions: TURN_INSTRUCTIONS, toolGuidance: TOOL_TURN_GUIDANCE,
    transcript, callerUtterance, tools: voiceTools,
    telemetry: { brokerageId: toolCtx.brokerageId, agentId: toolCtx.agentId }, generateFn,
  })
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
      const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
      await sentinelWrite(svc, svc.from("notifications").insert({
        user_id: ctx.agentUserId, brokerage_id: ctx.brokerageId, type: "showing_self_booked",
        title: "The AI receptionist booked an appointment on a live call",
        body: `${when.toLocaleString()} — booked during an inbound call. Transcript is on the call record.`,
        entity_type: "voice_call", entity_id: call.id, priority: "high", channel: "in_app", is_read: false,
      }), { table: "notifications", flow: "voice_showing_self_booked_notify", brokerageId: ctx.brokerageId, reason: "the showing itself already exists; this is only the agent heads-up" })
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

/**
 * ── THE ONE VOICE RECEPTIONIST ENGINE (lane 75D) ────────────────────────────
 * Owner ruling (wave 75, verbatim): "make sure that there aren't 2 different
 * ai agents that handle ai voice receptionists. we don't want to create
 * different paths unless it is warranted. what really matters whether it is
 * a tenant and their users or the platform and their users, we need to be
 * sure that the ai agent will sustain a useful conversation and help the
 * person with the reason for the call while capturing as much useful
 * information about that person for the os."
 *
 * `deployment` is the ONLY branch. Both deployments share: the SAME
 * VoiceTurnPlan/VoiceTurnAction contract and parseTurnPlan (reception-brain.ts),
 * the SAME tool-round engine — bound (VOICE_TOOL_ROUND_MAX_STEPS), deadline
 * (VOICE_TOOL_ROUND_DEADLINE_MS), telemetry, and timeout→plan-only fallback
 * (runVoiceTurnRound above), and the SAME qualification playbook
 * (buildQualificationPrompt — conversational-rules-only for platform, since a
 * prospect is not discussing a property). They differ ONLY in what a
 * deployment IS: a tenant call is answering for a brokerage/agent (live
 * inventory, property tools, the customer-care capture bundle onto a
 * contact/lead); a platform call is answering for the product itself (brand/
 * pricing from platform settings, a tenant-free FAQ tool, prospect capture).
 *
 * TOMBSTONE (lane 75D): lib/voice/platform-reception.ts's standalone
 * `planPlatformReceptionTurn` (a second hand-built copy of this exact
 * tool-round/deadline/fallback shape against a SEPARATE PlatformTurnPlan
 * contract) is RETIRED — its logic is the "platform" branch below, riding
 * the SAME runVoiceTurnRound the tenant branch always used. Nothing it did
 * is lost: platformFaqTools (FAQ lookup) and the platform turn contract
 * (PLATFORM_TURN_INSTRUCTIONS/PLATFORM_TOOL_TURN_GUIDANCE, now living beside
 * TURN_INSTRUCTIONS in reception-brain.ts) are unchanged, only merged onto
 * this ONE entrypoint.
 *
 * CAPTURE (owner: "capturing as much useful information about that person
 * for the os") — tenant: the property tool round now ALSO carries the SAME
 * free capture/follow-up bundle every chat surface offers (get_my_context,
 * search_our_listings, and once a contact/lead is linked: request_showing,
 * schedule_callback, schedule_home_value_review, book_agent_appointment,
 * send_matching_listings, record_qualification — see planTurnWithPrompt
 * above), so a live call writes name/intent/persona/seller-address/buyer-
 * criteria/timeline/financing onto the SAME contacts/leads columns an email
 * or portal thread would. Platform: `capturePhoneProspect` writes the SAME
 * information (name/email/company/role/note = "reason for call") onto
 * `platform_prospects` — the existing table the platform reception line has
 * always written, driven by the SAME "prospect" VoiceTurnAction both
 * transports (app/api/voice/twilio/turn, app/api/voice/relay/plan) already
 * handle identically for either deployment.
 */
export type ReceptionTurnInput =
  | {
      deployment: "tenant"
      ctx: InboundCallContext
      transcript: string | null
      utterance: string
      svc?: any
      extraRules?: string
      /** Lane 73B (hook) / 73E (native execution) — when the CALLER passes
       *  the call row's own id + linked contact/lead (voice_calls.id /
       *  .contact_id / .lead_id), this turn's persona-scoped property AND
       *  free capture tools become available to the model for real (native
       *  AI-SDK tool-calling). Omitted → a plain no-tools call, exactly as
       *  before lane 73B ever existed — additive, never a silent behavior
       *  change for a caller that has not threaded a call id through yet. */
      voiceToolCtx?: {
        callId: string
        contactId: string | null
        leadId?: string | null
        /** voice_calls.agent_id — an agents.id (lane 76A). NOT ctx.agentUserId
         *  (users.id): the free bundle's find/book_listing_appointment and
         *  notifyAssignedAgent all take agents.id and cross to users via
         *  agents.user_id themselves. */
        agentId?: string | null
      }
    }
  | {
      deployment: "platform"
      ctx: PlatformReceptionContext
      transcript: string | null
      utterance: string
      extraRules?: string
      /** Lane 76B — the prospect funnel bundle's server-resolved identity:
       *  the caller-ID phone (Twilio's From, never a body value) and the call
       *  ledger row (platform_reception_calls.id / .prospect_id) so
       *  save_prospect can link the prospect onto the call. Omitted → the
       *  FAQ-only round, exactly as before this lane. */
      prospect?: { phone: string | null; prospectId: string | null; callId: string | null }
    }

export async function planReceptionTurn(input: ReceptionTurnInput, deps: VoiceToolRoundDeps = {}): Promise<VoiceTurnPlan> {
  if (input.deployment === "platform") {
    const { buildPlatformReceptionPrompt, platformFaqTools, platformReceptionTools } = await import("@/lib/voice/platform-reception")
    let systemPrompt = buildPlatformReceptionPrompt({
      brandName: input.ctx.brandName, tagline: input.ctx.tagline, tierLines: input.ctx.tierLines,
      hasTransfer: !!input.ctx.forwardNumber, voicePitch: input.ctx.voicePitch, receptionGreeting: input.ctx.receptionGreeting,
      brand: input.ctx.brand, channel: "voice",
    }).systemPrompt
    if (input.extraRules) systemPrompt = `${systemPrompt}\n\n${input.extraRules}`
    const generateFn: GenerateTextRoutedFn = deps.generateTextRouted ?? (await import("@/lib/ai/models")).generateTextRouted
    // Lane 76B — with a prospect context the round carries the FAQ lookup
    // PLUS the funnel bundle (save / demo slots / book demo / signup link /
    // human handoff); without one it is the FAQ-only round it always was.
    const tools = input.prospect
      ? await platformReceptionTools({
          source: "phone:reception", phone: input.prospect.phone, prospectId: input.prospect.prospectId,
          callId: input.prospect.callId, brand: input.ctx.productBrand, hasLiveTransfer: !!input.ctx.forwardNumber,
        })
      : await platformFaqTools()
    return runVoiceTurnRound({
      systemPrompt, turnInstructions: PLATFORM_TURN_INSTRUCTIONS, toolGuidance: PLATFORM_TOOL_TURN_GUIDANCE,
      transcript: input.transcript, callerUtterance: input.utterance,
      tools, telemetry: null, generateFn,
    })
  }

  // deployment === "tenant" — pass ctx and the reception AI answers from the
  // tenant's LIVE INVENTORY (facts from listings rows injected per turn; the
  // no-invention rule scopes to the list — see lib/voice/reception-inventory).
  const { systemPrompt: base } = buildReceptionPrompt(input.ctx.identity)
  let prompt = base
  if (input.svc) {
    const { loadInventoryContext } = await import("@/lib/voice/reception-inventory")
    const inventory = await loadInventoryContext(input.svc, input.ctx.brokerageId, input.utterance)
    if (inventory) prompt = `${prompt}\n\n${inventory}`
  }
  if (input.extraRules) prompt = `${prompt}\n\n${input.extraRules}`
  // IDENTITY CLASS (lane 76A fix): agentId is the call row's agents.id passed
  // by the route (voice_calls.agent_id). It was hardcoded `null` here — the
  // only id in reach was ctx.agentUserId, a users.id, which does NOT belong in
  // an agents.id slot (CLAUDE.md §3) — so the listing-appointment and
  // agent-notify tools never had an agent on any live call.
  const toolCtx: VoiceToolExecContext | undefined = input.voiceToolCtx
    ? {
        brokerageId: input.ctx.brokerageId, agentId: input.voiceToolCtx.agentId ?? null,
        contactId: input.voiceToolCtx.contactId, leadId: input.voiceToolCtx.leadId ?? null,
        conversationKey: input.voiceToolCtx.callId,
      }
    : undefined
  return planTurnWithPrompt(prompt, input.transcript, input.utterance, toolCtx, deps)
}
