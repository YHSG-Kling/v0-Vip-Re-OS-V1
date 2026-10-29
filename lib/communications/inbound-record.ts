// lib/communications/inbound-record.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE INBOUND COMMUNICATION RECORD (wave 146, lane 146B — cross-lane contract C1; owner ruling 3, 2026-10-29:
// "communication should be able to track both incoming and outgoing no matter which channel is used").
//
// WHAT THIS IS. Every inbound event a provider pushes at us — an emailed reply, a DM, a comment, a mention, an ad
// interaction — lands HERE after the door has authenticated it (signature / secret) and resolved the tenant from the
// RECEIVING account (never a body field). This module matches it to a person and a conversation, deduplicates it on
// (provider, provider reference), and writes ONE canonical record on the EXISTING history survivor. No new table:
//
//   contact           → `messages` on the contact's conversation (lib/kernel/conversation-thread.ts — THE one
//                       conversation resolver: keep-one, conversations UNIQUE (contact_id, agent_id) live), or on the
//                       thread the door already resolved (a social thread keyed by page + sender). The universal inbox
//                       (lib/kernel/communications.ts loadUniversalInbox) reads it; status 'unread' until someone opens it.
//   lead              → `lead_conversation_history` (the lead-keyed inbound table; m488's partial unique index on
//                       (lead_id, metadata->>'provider_ref') refuses a retry). A lead that already converted (contact_id
//                       set) is recorded on its CONTACT — conversion is final (contract C2, canonicalPartyFor).
//   platform_prospect → `platform_prospects.details.inbound` (the prospect's own record — lib/platform/prospect-capture.ts
//                       keeps every prospect fact in `details`; platform scope, NO tenant memory, ruling 7).
//   nobody yet        → a public commenter who is not in the graph is recorded on the door's thread with no person; it
//                       is NEVER fabricated into a contact or a lead here (leads belong to the brokerage and enter through
//                       the lead gate; a public comment is not consent).
//
// IDEMPOTENT. A provider retry (Meta, X, LinkedIn and Twilio all deliver at least once) produces ONE record: the read
// before the write finds the earlier (provider, provider_ref), and m876's partial unique index on messages refuses a race
// (23505 → duplicate). A provider that sends no reference gets a DERIVED one — sha256(provider | party | received_at |
// body) — so an exact replay still dedupes; the record says so (provider_ref_derived).
//
// THEN processInboundCommunication runs the rest of the ruling's chain ONCE per new record (never for a duplicate):
// opt-out (a high-confidence "stop" is honoured at once — lib/ai-isa/opt-out-utils.ts + app/actions/ai-isa/process-opt-out.ts,
// the survivor the SMS / email door already runs) → the response-driven sequence stop (lib/campaign-sequences/
// enrollment-engine.ts stopSequencesOnResponse) → the kernel event a bell and the managers read (MESSAGE_FROM_CONTACT)
// → intent interpretation (lib/intelligence/intent-classifier.ts classifyIntent — the one per-message classifier) → the
// arbiter's inbound responder (lib/communications/inbound-responder.ts respondToInboundCommunication) → a governed action
// with evidence. A LEAD's email / text / call / mail reply goes to THE lead door (lib/lead-intent/inbound-lead-intent.ts
// evaluateInboundLeadSignal), which records on the same table under the same key and interprets it — never twice.
//
// TENANCY. `brokerageId` is the tenant the DOOR verified (the receiving page / number / mailbox). Every read and write here
// is pinned to it; a party or a thread from another tenant is refused, never re-homed. Every `{ error }` is read.
//
// Not server-only and no "use server": the doors and the proofs (scripts/inbound-communication-guard.ts) call it with
// an injected client; the reactions are lazy imports with injectable seams.

import { createHash } from "node:crypto"

// ── the contract (C1) ──────────────────────────────────────────────────────────────────────────

export type InboundPartyKind = "lead" | "contact" | "platform_prospect"

export interface InboundParty {
  kind: InboundPartyKind
  id: string
}

/** How the inbound arrived. A comment / mention / ad interaction is PUBLIC; the rest are private to the thread. */
export type InboundChannel =
  | "email" | "sms" | "whatsapp" | "voice" | "portal"
  | "social_dm" | "social_comment" | "social_mention" | "ad_interaction"

/** The channels whose message is a public publication by the sender (a reply to it would be public too). */
export const PUBLIC_INBOUND_CHANNELS: ReadonlySet<InboundChannel> = new Set<InboundChannel>(["social_comment", "social_mention", "ad_interaction"])

export interface InboundMedia {
  url: string
  type?: string | null
}

export interface InboundCommunicationInput {
  /** The tenant the door VERIFIED. Exactly one of brokerageId / platform. */
  brokerageId?: string | null
  /** True only for a platform prospect (the platform's own B2B funnel — no tenant). */
  platform?: boolean
  channel: InboundChannel
  /** The provider that delivered it ("sendgrid", "twilio", "meta", "linkedin", "twitter", "whatsapp", …). */
  provider: string
  /** The provider's own id for this event (message id, comment id, notification id). null → derived. */
  providerRef: string | null
  /** Who sent it. null ONLY for an unidentified sender on a thread the door resolved (conversationId required). */
  party?: InboundParty | null
  /** The thread the door already resolved (a social thread keyed by page + sender). Verified, never trusted. */
  conversationId?: string | null
  /** agents.id the thread belongs to, when the door knows (else the contact's agent — the resolver's cascade). */
  agentId?: string | null
  subject?: string | null
  body: string
  media?: ReadonlyArray<InboundMedia> | null
  receivedAt?: string | Date | null
  /** The provider payload (kept only when small; never required). */
  raw?: Record<string, unknown> | null
  /** The provider surface ("facebook" | "instagram" | "whatsapp" | "linkedin" | "twitter" | …). */
  surface?: string | null
  /** The door's thread keys (page_id / sender_id / post_id / comment_id / ad_id …) — what a reply needs to find its way back. */
  threadRef?: Record<string, string | null | undefined> | null
}

export type InboundRecordStore = "messages" | "lead_conversation_history" | "platform_prospects"

export interface InboundCommunicationResult {
  recorded: boolean
  /** True when this (provider, provider_ref) was already recorded — a retry; nothing downstream may run again. */
  duplicate: boolean
  store: InboundRecordStore | null
  /** messages.id / lead_conversation_history.id / the prospect id. */
  recordId: string | null
  conversationId: string | null
  /** The CANONICAL party (a converted lead resolves to its contact); null for an unidentified sender. */
  party: InboundParty | null
  /** The reference the record is keyed on (derived when the provider gave none). */
  providerRef: string | null
  providerRefDerived: boolean
  error: string | null
  /** What could not be read and how the record proceeded anyway (published, never silent). */
  warnings: string[]
}

type Client = { from: (t: string) => any }

export interface InboundRecordDeps {
  /** The service client the door already holds (the proof passes an in-memory one). */
  client?: Client
}

const MAX_BODY = 8000
const MAX_RAW_JSON = 2000
const MAX_PROSPECT_INBOUND = 50

/** The messages.type the inbox reads for each inbound channel (meta-dm's 'social_dm' is the existing spelling). */
const MESSAGE_TYPE: Readonly<Record<InboundChannel, string>> = Object.freeze({
  email: "email", sms: "sms", whatsapp: "social_dm", voice: "voice", portal: "chat",
  social_dm: "social_dm", social_comment: "social_comment", social_mention: "social_mention", ad_interaction: "social_comment",
})

/** The lead door's transports (lib/lead-intent/inbound-lead-intent.ts InboundLeadChannel). */
const LEAD_DOOR_CHANNELS: ReadonlySet<InboundChannel> = new Set<InboundChannel>(["email", "sms", "voice"])

function iso(v: string | Date | null | undefined): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString()
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString()
  return new Date().toISOString()
}

/** PURE. The reference a record is keyed on: the provider's own, or a stable digest of what an exact replay repeats. */
function inboundProviderRef(input: Pick<InboundCommunicationInput, "provider" | "providerRef" | "party" | "conversationId" | "receivedAt" | "body">): { ref: string; derived: boolean } {
  const given = typeof input.providerRef === "string" ? input.providerRef.trim() : ""
  if (given) return { ref: given.slice(0, 300), derived: false }
  const who = input.party ? `${input.party.kind}:${input.party.id}` : `thread:${input.conversationId ?? ""}`
  const when = input.receivedAt ? iso(input.receivedAt) : ""
  const digest = createHash("sha256").update(`${input.provider}|${who}|${when}|${(input.body ?? "").trim()}`).digest("hex").slice(0, 40)
  return { ref: `derived:${digest}`, derived: true }
}

function smallRaw(raw: Record<string, unknown> | null | undefined): { raw?: Record<string, unknown>; raw_omitted?: true } {
  if (!raw) return {}
  try {
    const s = JSON.stringify(raw)
    return s.length <= MAX_RAW_JSON ? { raw } : { raw_omitted: true }
  } catch {
    return { raw_omitted: true }
  }
}

function emptyResult(over: Partial<InboundCommunicationResult>): InboundCommunicationResult {
  return { recorded: false, duplicate: false, store: null, recordId: null, conversationId: null, party: null, providerRef: null, providerRefDerived: false, error: null, warnings: [], ...over }
}

async function defaultClient(): Promise<Client> {
  const { createServiceClient } = await import("@/lib/supabase/service")
  return createServiceClient() as unknown as Client
}

// ── the record (C1) ────────────────────────────────────────────────────────────────────────────

/**
 * Record ONE inbound communication on the canonical history. Never throws; a refusal is returned with its reason.
 * Idempotent on (provider, providerRef): a retry returns `{ recorded: false, duplicate: true }` with the first record's id.
 */
export async function recordInboundCommunication(
  input: InboundCommunicationInput,
  deps: InboundRecordDeps = {},
): Promise<InboundCommunicationResult> {
  try {
    const body = (input.body ?? "").trim()
    const provider = (input.provider ?? "").trim().toLowerCase()
    if (!provider) return emptyResult({ error: "no provider — an inbound record names who delivered it" })
    if (!body && !(input.media && input.media.length > 0)) return emptyResult({ error: "empty inbound (no body, no media) — nothing to record" })

    // ── scope: a tenant the door verified, or the platform — never both, never neither ──
    const brokerageId = (input.brokerageId ?? "").trim() || null
    if (input.platform && brokerageId) return emptyResult({ error: "scope is the platform OR a tenant, never both" })
    if (!input.platform && !brokerageId) return emptyResult({ error: "no verified tenant — an inbound is never recorded untenanted" })
    const party = input.party ?? null
    if (input.platform && party?.kind !== "platform_prospect") return emptyResult({ error: "platform scope records only a platform prospect (no tenant data on the platform funnel)" })
    if (!input.platform && party?.kind === "platform_prospect") return emptyResult({ error: "a platform prospect is never recorded inside a tenant (no cross-tenant memory)" })
    if (!party && !input.conversationId) return emptyResult({ error: "an unidentified sender needs the door's thread (conversationId) — no person is fabricated" })

    const svc = deps.client ?? await defaultClient()
    const { ref, derived } = inboundProviderRef({ ...input, provider })
    const receivedAt = iso(input.receivedAt)
    const warnings: string[] = []

    if (input.platform && party) return await recordOnPlatformProspect(svc, { ...input, provider, body, receivedAt }, party.id, ref, derived)

    // ── party resolution, tenant-pinned ──
    let canonical: InboundParty | null = party
    if (party?.kind === "lead") {
      const { data: lead, error } = await svc.from("leads").select("id, brokerage_id, contact_id").eq("id", party.id).eq("brokerage_id", brokerageId).maybeSingle()
      if (error) return emptyResult({ error: `lead read refused: ${error.message}` })
      if (!lead) return emptyResult({ error: "lead not in this brokerage — refused, never re-homed" })
      const { canonicalPartyFor } = await import("@/lib/contact-promotion/lead-domain-boundary")
      const p = canonicalPartyFor(lead as { id?: string | null; contact_id?: string | null })
      if (p.type === "unresolved") return emptyResult({ error: p.reason })
      canonical = p.type === "contact" ? { kind: "contact", id: p.id } : { kind: "lead", id: p.id }
    }

    if (canonical?.kind === "lead") {
      return await recordOnLeadHistory(svc, { ...input, provider, body, receivedAt }, brokerageId!, canonical.id, ref, derived)
    }

    let contactAgentId: string | null = null
    if (canonical?.kind === "contact") {
      const { data: contact, error } = await svc.from("contacts").select("id, brokerage_id, agent_id").eq("id", canonical.id).eq("brokerage_id", brokerageId).maybeSingle()
      if (error) return emptyResult({ error: `contact read refused: ${error.message}` })
      if (!contact) return emptyResult({ error: "contact not in this brokerage — refused, never re-homed" })
      contactAgentId = (contact as { agent_id?: string | null }).agent_id ?? null
    }

    // ── dedup BEFORE the thread: a retry must not even touch the conversation counters ──
    const { data: dup, error: dupErr } = await svc.from("messages").select("id, conversation_id")
      .eq("brokerage_id", brokerageId).eq("direction", "inbound")
      .contains("metadata", { provider, provider_ref: ref })
      .limit(1).maybeSingle()
    if (dupErr) warnings.push(`duplicate check refused (${dupErr.message}) — m876's unique index is the backstop`)
    else if (dup) {
      return emptyResult({ duplicate: true, store: "messages", recordId: (dup as { id: string }).id, conversationId: (dup as { conversation_id?: string | null }).conversation_id ?? null, party: canonical, providerRef: ref, providerRefDerived: derived, warnings })
    }

    // ── the conversation: the door's thread (verified) or THE one resolver ──
    let conversationId: string | null = null
    let threadAgentId: string | null = input.agentId ?? null
    if (input.conversationId) {
      const { data: conv, error } = await svc.from("conversations").select("id, brokerage_id, contact_id, agent_id").eq("id", input.conversationId).eq("brokerage_id", brokerageId).maybeSingle()
      if (error) return emptyResult({ error: `conversation read refused: ${error.message}`, party: canonical, providerRef: ref, providerRefDerived: derived })
      if (!conv) return emptyResult({ error: "conversation not in this brokerage — refused", party: canonical, providerRef: ref, providerRefDerived: derived })
      const convContact = (conv as { contact_id?: string | null }).contact_id ?? null
      if (canonical?.kind === "contact" && convContact && convContact !== canonical.id) {
        return emptyResult({ error: "the thread belongs to another person — refused (one person per thread)", party: canonical, providerRef: ref, providerRefDerived: derived })
      }
      conversationId = (conv as { id: string }).id
      threadAgentId = threadAgentId ?? (conv as { agent_id?: string | null }).agent_id ?? null
    } else if (canonical?.kind === "contact") {
      const { ensureConversationForContact } = await import("@/lib/kernel/conversation-thread")
      conversationId = await ensureConversationForContact(svc, { contactId: canonical.id, brokerageId: brokerageId!, agentId: input.agentId ?? contactAgentId })
      if (!conversationId) return emptyResult({ error: "no conversation could be resolved (the brokerage has no agent to own the thread)", party: canonical, providerRef: ref, providerRefDerived: derived })
    }

    const surface = (input.surface ?? "").trim().toLowerCase() || null
    const metadata: Record<string, unknown> = {
      provider,
      provider_ref: ref,
      ...(derived ? { provider_ref_derived: true } : {}),
      channel: input.channel,
      ...(surface ? { surface } : {}),
      ...(input.subject ? { subject: String(input.subject).slice(0, 300) } : {}),
      ...(input.media && input.media.length > 0 ? { media: input.media.slice(0, 10).map((m) => ({ url: m.url, type: m.type ?? null })) } : {}),
      ...(input.threadRef ? { thread: Object.fromEntries(Object.entries(input.threadRef).filter(([, v]) => typeof v === "string" && v)) } : {}),
      public: PUBLIC_INBOUND_CHANNELS.has(input.channel),
      party_kind: canonical?.kind ?? "unidentified",
      received_at: receivedAt,
      // Back-compat with the SMS recorder (lib/voice/sms-inbound.ts dedupes on message_sid) — one key, two spellings read.
      ...(provider === "twilio" && !derived ? { message_sid: ref } : {}),
      ...smallRaw(input.raw),
    }
    const { data: inserted, error: insErr } = await svc.from("messages").insert({
      conversation_id: conversationId,
      brokerage_id: brokerageId,
      contact_id: canonical?.kind === "contact" ? canonical.id : null,
      agent_id: threadAgentId,
      type: MESSAGE_TYPE[input.channel] ?? input.channel,
      direction: "inbound",
      sender_type: canonical?.kind === "contact" ? "contact" : "external",
      subject: input.subject ? String(input.subject).slice(0, 300) : null,
      body: (body || "(media)").slice(0, MAX_BODY),
      status: "unread",
      metadata,
      created_at: receivedAt,
      updated_at: receivedAt,
    }).select("id").single()
    if (insErr) {
      if ((insErr as { code?: string }).code === "23505") {
        // m876: a concurrent delivery of the same (provider, provider_ref) won the race — this one is the retry.
        const { data: winner } = await svc.from("messages").select("id").eq("brokerage_id", brokerageId).contains("metadata", { provider, provider_ref: ref }).limit(1).maybeSingle()
        return emptyResult({ duplicate: true, store: "messages", recordId: (winner as { id?: string } | null)?.id ?? null, conversationId, party: canonical, providerRef: ref, providerRefDerived: derived, warnings })
      }
      return emptyResult({ error: `inbound record refused: ${insErr.message}`, store: "messages", conversationId, party: canonical, providerRef: ref, providerRefDerived: derived, warnings })
    }

    if (conversationId) {
      const { touchConversation } = await import("@/lib/kernel/conversation-thread")
      await touchConversation(svc, conversationId, { inbound: true })
    }
    return { recorded: true, duplicate: false, store: "messages", recordId: (inserted as { id: string }).id, conversationId, party: canonical, providerRef: ref, providerRefDerived: derived, error: null, warnings }
  } catch (e) {
    return emptyResult({ error: `threw: ${e instanceof Error ? e.message : String(e)}` })
  }
}

async function recordOnLeadHistory(
  svc: Client,
  input: InboundCommunicationInput & { provider: string; body: string; receivedAt: string },
  brokerageId: string,
  leadId: string,
  ref: string,
  derived: boolean,
): Promise<InboundCommunicationResult> {
  const party: InboundParty = { kind: "lead", id: leadId }
  const { data, error } = await svc.from("lead_conversation_history").insert({
    lead_id: leadId,
    brokerage_id: brokerageId,
    channel: input.channel,
    direction: "inbound",
    message_content: input.body.slice(0, MAX_BODY),
    metadata: { provider: input.provider, provider_ref: ref, ...(derived ? { provider_ref_derived: true } : {}), ...(input.surface ? { surface: input.surface } : {}), ...(input.subject ? { subject: input.subject } : {}), ...smallRaw(input.raw) },
    occurred_at: input.receivedAt,
  }).select("id").single()
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      // m488's partial unique index on (lead_id, metadata->>'provider_ref') — the retried webhook.
      const { data: winner } = await svc.from("lead_conversation_history").select("id").eq("lead_id", leadId).eq("metadata->>provider_ref", ref).limit(1).maybeSingle()
      return emptyResult({ duplicate: true, store: "lead_conversation_history", recordId: (winner as { id?: string } | null)?.id ?? null, party, providerRef: ref, providerRefDerived: derived })
    }
    return emptyResult({ error: `lead inbound record refused: ${error.message}`, store: "lead_conversation_history", party, providerRef: ref, providerRefDerived: derived })
  }
  return { recorded: true, duplicate: false, store: "lead_conversation_history", recordId: (data as { id: string }).id, conversationId: null, party, providerRef: ref, providerRefDerived: derived, error: null, warnings: [] }
}

async function recordOnPlatformProspect(
  svc: Client,
  input: InboundCommunicationInput & { provider: string; body: string; receivedAt: string },
  prospectId: string,
  ref: string,
  derived: boolean,
): Promise<InboundCommunicationResult> {
  const party: InboundParty = { kind: "platform_prospect", id: prospectId }
  const { data: row, error } = await svc.from("platform_prospects").select("id, details").eq("id", prospectId).maybeSingle()
  if (error) return emptyResult({ error: `platform prospect read refused: ${error.message}`, party, providerRef: ref, providerRefDerived: derived })
  if (!row) return emptyResult({ error: "platform prospect not found", party, providerRef: ref, providerRefDerived: derived })
  const details = ((row as { details?: Record<string, unknown> | null }).details ?? {}) as Record<string, unknown>
  const prior = Array.isArray(details.inbound) ? (details.inbound as Array<Record<string, unknown>>) : []
  if (prior.some((m) => m && m.provider === input.provider && m.provider_ref === ref)) {
    return emptyResult({ duplicate: true, store: "platform_prospects", recordId: prospectId, party, providerRef: ref, providerRefDerived: derived })
  }
  const entry = { provider: input.provider, provider_ref: ref, ...(derived ? { provider_ref_derived: true } : {}), channel: input.channel, body: input.body.slice(0, 2000), ...(input.subject ? { subject: input.subject } : {}), received_at: input.receivedAt }
  // Merge, never replace (the prospect's other facts live beside it — lib/platform/prospect-capture.ts's own rule).
  const nextDetails = { ...details, inbound: [...prior, entry].slice(-MAX_PROSPECT_INBOUND), last_inbound_at: input.receivedAt }
  const { data: updated, error: upErr } = await svc.from("platform_prospects").update({ details: nextDetails, updated_at: new Date().toISOString() }).eq("id", prospectId).select("id")
  if (upErr) return emptyResult({ error: `platform prospect inbound refused: ${upErr.message}`, store: "platform_prospects", party, providerRef: ref, providerRefDerived: derived })
  if (!updated || (updated as unknown[]).length === 0) return emptyResult({ error: "platform prospect inbound matched no row", store: "platform_prospects", party, providerRef: ref, providerRefDerived: derived })
  return { recorded: true, duplicate: false, store: "platform_prospects", recordId: prospectId, conversationId: null, party, providerRef: ref, providerRefDerived: derived, error: null, warnings: [] }
}

// ── the chain (ruling 3: record → interpret → arbiter → governed action) ──────────────────────

/** The private channels an opt-out phrase and the response-driven sequence stop apply to (a public comment is neither). */
const PRIVATE_REPLY_CHANNELS: ReadonlySet<InboundChannel> = new Set<InboundChannel>(["email", "sms", "whatsapp", "social_dm", "portal"])

export interface InboundIntent {
  primary: string
  confidence: number
  urgency: string
}

export interface InboundProcessDeps extends InboundRecordDeps {
  /** opt-out writer (default: lib/ai-isa/opt-out-writer.ts processOptOutFromVerifiedInbound — the verified doors' sessionless writer; wave 146 moved it out of the "use server" action). */
  optOut?: (p: { entityType: "contact"; entityId: string; channel: "email" | "sms" | "phone" | "direct_mail" | "all"; source: "inbound_sms" | "inbound_email" | "inbound_social"; rawMessage: string; brokerageId: string }) => Promise<{ success: boolean; error?: string }>
  /** response-driven stop (default: lib/campaign-sequences/enrollment-engine.ts stopSequencesOnResponse). */
  stopSequences?: (p: { brokerageId: string; contactId: string }) => Promise<{ unenrolled: number }>
  /** kernel emit (default: lib/kernel/emit.ts emitKernelEvent). */
  emit?: (e: Record<string, unknown>) => Promise<unknown>
  /** intent interpretation (default: lib/intelligence/intent-classifier.ts classifyIntent). null = not classified. */
  classify?: (p: { body: string; contactId: string; conversationId: string; brokerageId: string }) => Promise<InboundIntent | null>
  /** THE lead door (default: lib/lead-intent/inbound-lead-intent.ts evaluateInboundLeadSignal). */
  leadDoor?: (p: { brokerageId: string; leadId: string; channel: "email" | "sms" | "voice"; body: string; providerRef: string; occurredAt: string; context: Record<string, unknown> }) => Promise<{ outcome: string; contactId?: string; reason?: string; error?: string }>
  /** the arbiter's inbound responder (default: lib/communications/inbound-responder.ts respondToInboundCommunication). */
  respond?: (p: InboundRespondRequest) => Promise<{ action: string; reason: string }>
  /** ruling 10 — what this person was promised and has not received (default: lib/ai-isa/followup-arbiter.ts
   *  respondToPromisedDeliverable with contract C4 from lib/lead-magnets/promised-deliverables.ts). */
  promise?: (p: { brokerageId: string; contactId: string; now: Date }) => Promise<{ action: string; reason: string }>
}

/** What the chain hands the arbiter's inbound responder. */
export interface InboundRespondRequest {
  brokerageId: string
  contactId: string | null
  conversationId: string | null
  recordId: string
  channel: InboundChannel
  provider: string
  surface: string | null
  body: string
  isPublic: boolean
  threadRef: Record<string, string> | null
  intent: InboundIntent | null
  receivedAt: string
}

export interface InboundProcessResult {
  record: InboundCommunicationResult
  /** null = not evaluated (duplicate / public / not a person). */
  optOut: { detected: boolean; applied: boolean; error?: string } | null
  sequencesStopped: number | null
  intent: InboundIntent | null
  /** The lead door's verdict, for a lead. */
  lead: { outcome: string; reason?: string } | null
  /** The arbiter's governed action, when it ran. */
  response: { action: string; reason: string } | null
  /** Ruling 10: the owed-promise moment (delivered / a person told / nothing owed), when it ran. */
  promise: { action: string; reason: string } | null
  blindSpots: string[]
}

/**
 * The whole inbound chain for ONE event, run once per NEW record (a duplicate stops after the record — no second opt-out
 * write, no second bell, no second model call, no second reply). Never throws.
 */
export async function processInboundCommunication(
  input: InboundCommunicationInput,
  deps: InboundProcessDeps = {},
): Promise<InboundProcessResult> {
  const blindSpots: string[] = []
  const out = (record: InboundCommunicationResult, over: Partial<InboundProcessResult> = {}): InboundProcessResult =>
    ({ record, optOut: null, sequencesStopped: null, intent: null, lead: null, response: null, promise: null, blindSpots, ...over })

  // ── a LEAD's reply on a lead-door transport: THE lead door records (same table, same key) and interprets it ──
  if (input.party?.kind === "lead" && LEAD_DOOR_CHANNELS.has(input.channel) && input.brokerageId && !input.platform) {
    const { ref, derived } = inboundProviderRef(input)
    try {
      const door = deps.leadDoor ?? (async (p) => (await import("@/lib/lead-intent/inbound-lead-intent")).evaluateInboundLeadSignal(p as never))
      const r = await door({
        brokerageId: input.brokerageId, leadId: input.party.id, channel: input.channel as "email" | "sms" | "voice",
        body: input.body, providerRef: ref, occurredAt: iso(input.receivedAt),
        context: { provider: input.provider, ...(input.surface ? { surface: input.surface } : {}), ...(derived ? { provider_ref_derived: true } : {}) },
      })
      const duplicate = r.outcome === "duplicate"
      const recorded = !duplicate && r.outcome !== "skipped"
      const party: InboundParty = r.contactId && r.outcome !== "duplicate" ? { kind: "contact", id: r.contactId } : { kind: "lead", id: input.party.id }
      return out(emptyResult({ recorded, duplicate, store: "lead_conversation_history", party, providerRef: ref, providerRefDerived: derived, error: r.error ?? (r.outcome === "skipped" ? `lead door skipped (${r.reason ?? "no reason"})` : null) }), { lead: { outcome: r.outcome, reason: r.reason } })
    } catch (e) {
      return out(emptyResult({ error: `lead door threw: ${e instanceof Error ? e.message : String(e)}`, store: "lead_conversation_history", party: input.party, providerRef: ref, providerRefDerived: derived }))
    }
  }

  const record = await recordInboundCommunication(input, deps)
  if (!record.recorded) return out(record)
  const contactId = record.party?.kind === "contact" ? record.party.id : null
  const brokerageId = input.brokerageId ?? null
  if (!brokerageId) return out(record) // the platform funnel: recorded; its own sweep reads details.last_inbound_at
  const isPublic = PUBLIC_INBOUND_CHANNELS.has(input.channel)
  const body = (input.body ?? "").trim()
  const svc = deps.client ?? await defaultClient()

  // ── 1. opt-out — a person who says stop is honoured before anything else, and nothing answers them ──
  let optOut: InboundProcessResult["optOut"] = null
  if (contactId && !isPublic && PRIVATE_REPLY_CHANNELS.has(input.channel) && body) {
    const { detectOptOutIntent } = await import("@/lib/ai-isa/opt-out-utils")
    const d = detectOptOutIntent(body)
    if (d.isOptOut && d.confidence === "high") {
      try {
        const write = deps.optOut ?? (async (p) => (await import("@/lib/ai-isa/opt-out-writer")).processOptOutFromVerifiedInbound(p))
        // Provenance (wave 146): a social / WhatsApp message thread is `inbound_social` — the value the writer's
        // vocabulary lacked when lane 146B landed (its social STOPs were written as inbound_sms). A portal-channel
        // inbound has no door feeding this record; it keeps the SMS label as before.
        const source = input.channel === "email" ? "inbound_email" : input.channel === "social_dm" || input.channel === "whatsapp" ? "inbound_social" : "inbound_sms"
        const r = await write({ entityType: "contact", entityId: contactId, channel: d.channel, source, rawMessage: body.slice(0, 500), brokerageId })
        optOut = { detected: true, applied: !!r.success, ...(r.error ? { error: r.error } : {}) }
      } catch (e) {
        optOut = { detected: true, applied: false, error: e instanceof Error ? e.message : String(e) }
      }
      // FAIL CLOSED: an opt-out that could not be written is not answered either — and it is said.
      if (!optOut.applied) blindSpots.push(`opt-out detected but NOT applied (${optOut.error ?? "refused"}) — no automated response`)
      return out(record, { optOut, response: { action: "no_response", reason: "the person asked to stop — suppression is the response" } })
    }
    optOut = { detected: d.isOptOut, applied: false }
  }

  // ── 2. the response-driven stop: a reply ends every automated sequence for that person ──
  let sequencesStopped: number | null = null
  if (contactId && !isPublic && PRIVATE_REPLY_CHANNELS.has(input.channel)) {
    try {
      const stop = deps.stopSequences ?? (async (p) => (await import("@/lib/campaign-sequences/enrollment-engine")).stopSequencesOnResponse(p, svc as never))
      sequencesStopped = (await stop({ brokerageId, contactId })).unenrolled
    } catch (e) {
      blindSpots.push(`sequence stop failed (${e instanceof Error ? e.message : String(e)})`)
    }
  }

  // ── 3. the kernel event the bell and the managers read (one per record — the dedupe key is the record id) ──
  try {
    const emit = deps.emit ?? (async (e) => (await import("@/lib/kernel/emit")).emitKernelEvent(e as never))
    if (contactId) {
      await emit({
        event: "message_from_contact", brokerageId, entityType: "contact", entityId: contactId, contactId, client: svc,
        dedupeKey: `inbound:${record.recordId}`, dedupeWindowSec: 86_400,
        metadata: { channel: input.channel, provider: input.provider, surface: input.surface ?? null, record_id: record.recordId, conversation_id: record.conversationId, public: isPublic },
      })
      if ((sequencesStopped ?? 0) > 0) {
        await emit({
          event: "sequence_paused_on_reply", brokerageId, entityType: "contact", entityId: contactId, contactId, client: svc, suppressEnrollment: true,
          dedupeKey: `inbound-stop:${record.recordId}`, metadata: { reason: "contact_replied", outcome: "unenrolled", unenrolled: sequencesStopped, channel: input.channel },
        })
      }
    }
  } catch (e) {
    blindSpots.push(`kernel event not emitted (${e instanceof Error ? e.message : String(e)})`)
  }

  // ── 4. interpretation — the one per-message classifier (a known person's private message only) ──
  let intent: InboundIntent | null = null
  if (contactId && record.conversationId && body && !isPublic) {
    try {
      const classify = deps.classify ?? (async (p) => {
        const r = await (await import("@/lib/intelligence/intent-classifier")).classifyIntent(p.body, p.contactId, p.conversationId, p.brokerageId)
        return { primary: r.intent_primary, confidence: r.confidence, urgency: r.urgency }
      })
      intent = await classify({ body: body.slice(0, 2000), contactId, conversationId: record.conversationId, brokerageId })
    } catch (e) {
      blindSpots.push(`intent not classified (${e instanceof Error ? e.message : String(e)}) — the arbiter decides without it`)
    }
  }

  // ── 5. ruling 10 — a person who writes in is first answered on what they were PROMISED and have not received (the
  //       "where is my guide?" reply). The arbiter's high-priority moment decides deliver-now vs a person; contract C4's
  //       deliverer is the only writer of "delivered". One ledger row per (promise set, day) — a retried inbound replays. ──
  let promise: InboundProcessResult["promise"] = null
  if (contactId) {
    try {
      const owed = deps.promise ?? (async (p) => {
        const { respondToPromisedDeliverable } = await import("@/lib/ai-isa/followup-arbiter")
        const r = await respondToPromisedDeliverable(svc, { brokerageId: p.brokerageId, party: { kind: "contact", id: p.contactId }, now: p.now }, await promiseContractFor(svc))
        return { action: r.action, reason: r.reason }
      })
      promise = await owed({ brokerageId, contactId, now: new Date() })
      if (promise.action === "refused") blindSpots.push(`owed-promise check refused (${promise.reason})`)
    } catch (e) {
      blindSpots.push(`owed-promise check threw (${e instanceof Error ? e.message : String(e)})`)
    }
  }

  // ── 6. the arbiter decides the governed response (propose / execute within authority / a person / no response) ──
  let response: InboundProcessResult["response"] = null
  try {
    const respond = deps.respond ?? (async (p) => {
      const { respondToInboundCommunication } = await import("./inbound-responder")
      const r = await respondToInboundCommunication(svc, p)
      return { action: r.action, reason: r.reason }
    })
    response = await respond({
      brokerageId, contactId, conversationId: record.conversationId, recordId: record.recordId!, channel: input.channel, provider: input.provider,
      surface: input.surface ?? null, body, isPublic,
      threadRef: input.threadRef ? Object.fromEntries(Object.entries(input.threadRef).filter((e): e is [string, string] => typeof e[1] === "string" && !!e[1])) : null,
      intent, receivedAt: iso(input.receivedAt),
    })
  } catch (e) {
    blindSpots.push(`arbiter responder threw (${e instanceof Error ? e.message : String(e)}) — the message is recorded and unread for a person`)
  }

  return out(record, { optOut, sequencesStopped, intent, response, promise })
}

/**
 * Contract C4 (lane 146F, lib/lead-magnets/promised-deliverables.ts — shapes read at that lane's worktree 2026-10-29):
 * undeliveredPromisesFor(svc, { brokerageId, contactId, now }) → { promises: [{ promiseId, status, fulfilment, … }], error } and
 * deliverPromised(svc, { brokerageId, promiseId }) → { ok: true, status: "delivered" | <not delivered>, … } | { ok: false, error }.
 * Passed to the arbiter from HERE (an inbound door, never a dashboard page) so the delivery stack stays out of the page graph.
 */
async function promiseContractFor(svc: Client): Promise<import("@/lib/ai-isa/followup-arbiter").PromiseContract> {
  const mod = (await import("@/lib/lead-magnets/promised-deliverables")) as unknown as { undeliveredPromisesFor?: (...a: unknown[]) => Promise<unknown>; deliverPromised?: (...a: unknown[]) => Promise<unknown> }
  const read = mod.undeliveredPromisesFor
  const send = mod.deliverPromised
  if (typeof read !== "function" || typeof send !== "function") throw new Error("contract C4 is not exported (undeliveredPromisesFor / deliverPromised)")
  return {
    undelivered: async (p) => {
      if (!p.contactId) throw new Error("contract C4 is asked about one contact only")
      const r = (await read(svc, { brokerageId: p.brokerageId, contactId: p.contactId, now: p.now })) as { promises?: unknown[]; error?: string | null } | null
      if (!r || r.error) throw new Error(`contract C4 read refused (${r?.error ?? "no result"})`)
      return (Array.isArray(r.promises) ? r.promises : []).map((x) => {
        const row = (x ?? {}) as { promiseId?: unknown; status?: unknown; fulfilment?: unknown }
        return { id: typeof row.promiseId === "string" ? row.promiseId : "", status: typeof row.status === "string" ? row.status : null, fulfilment: typeof row.fulfilment === "string" ? row.fulfilment : null }
      }).filter((x) => !!x.id)
    },
    deliver: async (p) => {
      const r = (await send(svc, { brokerageId: p.brokerageId, promiseId: p.promiseId })) as { ok?: boolean; status?: string; reason?: string; error?: string } | null
      return { delivered: !!(r && r.ok === true && r.status === "delivered"), status: r?.status ?? null, reason: r?.reason ?? r?.error ?? null }
    },
  }
}
