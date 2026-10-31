// lib/communications/inbound-responder.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ARBITER'S INBOUND SIDE (wave 146, lane 146B — owner rulings 2 + 3).
//
// OWNER (2026-10-29): 2 — "Arbiter needs to consider and send social responses back and also should do 1:1 ad follow up with
// audiences"; 3 — every inbound lands in ONE history (contract C1, ./inbound-record.ts) and feeds the arbiter.
//
// Same split as lib/ai-isa/followup-arbiter.ts (LAW 4): deterministic locks first (opt-out, do-not-contact, risk → a person),
// then the model chooses among a CLOSED menu (that file's arbitrateFollowUp — the ONE decision function, never a second
// copy), then a governed executor acts within authority, and every decision is ONE agent_action_ledger row (LAW 5).
//
// Why a module of its own: the executors this responder can call (the social composer / DM sender, the reply coach, the
// content-safety screen, the autonomy gate, Customer 360 — contract C6, the ad re-engagement door — contract C2) are only
// needed when an inbound arrives. Living in followup-arbiter.ts put all of them inside every dashboard page that reaches the
// arbiter (app/crm/page.tsx went 1297 → 1335 first-party modules, over test:proxy-graph-budget's 1300). Only
// ./inbound-record.ts processInboundCommunication calls this (lazily), so the pages never compile it.

import {
  ARBITER_INBOUND_SYSTEM,
  ARBITER_MEMORY_KEYS,
  arbitrateFollowUp,
  arbitrationLedgerDetail,
  routeToAgent,
  type ArbiterChannel,
  type ArbiterDecide,
  type ArbiterDecision,
  type ArbiterFacts,
  type ArbiterMenu,
  type ArbiterOption,
} from "@/lib/ai-isa/followup-arbiter"
import type { FollowupPolicy } from "@/lib/ai-isa/followup-policy"
import type { InboundRespondRequest } from "./inbound-record"

/** The governed outcome of one inbound (what actually happened, never what was hoped). */
export type InboundResponseAction =
  | "reply_sent"            // a reply DM went out through the tenant's account, within explicit autonomy
  | "reply_proposed"        // a reply waits for a PERSON (reply-coach draft / suggestion card)
  | "human_task"            // the arbiter (or a lock) handed it to a person
  | "audience_reengagement" // a 1:1 ad follow-up was requested through contract C2
  | "no_response"           // nothing should answer (empty, an opt-out, a lead's door owns it)
  | "replayed"              // this inbound was already answered — never twice
  | "refused"               // could not be evaluated (stated)

export interface InboundResponse {
  action: InboundResponseAction
  reason: string
  decision: ArbiterDecision | null
  proposedText?: string | null
  safety?: string[]
  autonomy?: { allowed: boolean; reason: string | null }
  /** Wave 147 (C13/C14): what the completion is closed by — the provider's reference for a sent text (the status callback
   *  reconciles it), the outbound messages row, the reply-coach draft a person acts on, and the person it waits for. */
  providerRef?: string | null
  outboundMessageId?: string | null
  draftId?: string | null
  agentUserId?: string | null
}

/** The ledger cycle of the ONE decision per inbound record (the completion's decision evidence names it). */
export const inboundDecisionCycle = (recordId: string) => `inbound:${recordId}`

/** Words that mean a PERSON must answer, whatever the model would choose (complaint, legal, fair housing, distress). */
const INBOUND_RISK_RE = /\b(attorney|lawyer|lawsuit|sue|suing|legal action|discriminat\w*|fair housing|harass\w*|scam|fraud|complain\w*|report (you|this)|cease and desist)\b/i
/** Classifier intents that are a person's job (lib/intelligence/intent-classifier.ts IntentCategory). */
const HUMAN_INTENTS: ReadonlySet<string> = new Set(["complaint", "cancel_transaction"])
/** The surfaces a reply DM can leave on through the tenant's account (lib/social/dm-support.ts — Meta + WhatsApp). */
const DM_SEND_SURFACES: ReadonlySet<string> = new Set(["facebook", "instagram", "whatsapp"])

/** The arbiter channel a reply on this inbound channel travels (the campaign taxonomy's keys). */
function replyChannelFor(channel: InboundRespondRequest["channel"]): ArbiterChannel {
  if (channel === "email") return "email"
  if (channel === "sms") return "sms"
  if (channel === "portal") return "in_app"
  return "social"
}

export interface InboundResponderDeps {
  decide?: ArbiterDecide
  policy?: FollowupPolicy
  /** The explicit autonomy grant for ai_isa (default: lib/managers/autonomy-gate.ts — posture + authority ladder + halts). */
  autonomy?: (brokerageId: string) => Promise<{ allowed: boolean; reason: string | null }>
  /** Contract C6 — the Customer 360 door (default: lib/enrichment/customer-360.ts customer360For); only the mapped preference keys reach the model. */
  customer360For?: (svc: unknown, brokerageId: string, party: { type: "contact"; id: string }, opts: { slices: string[] }) => Promise<unknown>
  compose?: (p: { brokerageId: string; agentId: string | null; contactId: string | null; conversationId: string | null; surface: string; isPublic: boolean; inboundBody: string }) => Promise<{ text: string } | null>
  send?: (p: { brokerageId: string; conversationId: string | null; contactId: string | null; agentId: string | null; surface: string; accountId: string; recipientId: string; text: string; inReplyTo: string }) => Promise<{ sent: boolean; providerMessageId?: string | null; error?: string }>
  propose?: (p: { brokerageId: string; agentId: string | null; contactId: string | null; conversationId: string | null; recordId: string; surface: string; isPublic: boolean; proposedText: string | null; why: string; safety: string[]; priority: "low" | "medium" | "high" }) => Promise<{ proposed: boolean; reason?: string }>
  /** The existing reply-coach rail for email / text / portal (lib/ai-reply-coach/reply-draft-core.ts — drafts, a person sends). */
  replyCoach?: (p: { brokerageId: string; agentUserId: string; conversationId: string; contactId: string; inboundMessageId: string; inboundBody: string; channel: "email" | "sms" | "in_app" }) => Promise<{ success: boolean; error?: string; draftId?: string }>
  /** Wave 147 — the unattended SMS reply executor (default: ./inbound-reply-executors.ts sendInboundSmsReply → lib/providers/dispatch.ts dispatchSms). */
  sendSms?: (p: { brokerageId: string; contactId: string; conversationId: string; agentId: string | null; recordId: string; text: string }) => Promise<{ sent: boolean; providerRef?: string | null; messageId?: string | null; error?: string }>
  /** Contract C2 — 1:1 ad follow-up (default: lib/ads/audience-reengagement.ts requestAudienceReengagement). */
  reengage?: (p: { brokerageId: string; partyIds: string[]; basis: string; creativeHint?: string }) => Promise<unknown>
  safety?: (text: string) => string[]
  routeToAgent?: typeof routeToAgent
  ledger?: typeof import("@/lib/kernel/action-ledger").withActionLedger
  now?: Date
}

/**
 * ONE inbound → the arbiter's governed response. Called by lib/communications/inbound-record.ts processInboundCommunication
 * after the record (never for a duplicate). The ledger row is idempotent per inbound record — a retried webhook replays,
 * never answers twice. Never throws.
 *
 *   locked → a person: an unsubscribe intent (no answer), do-not-contact / paused (a person decides), risk words or a
 *            complaint / cancellation intent (a person, high priority).
 *   menu   → reply (on the surface it came in) · notify_human · audience_reengagement (only an AD interaction from an
 *            identity-matched contact — contract C2 carries consent, identity, budget and authority inside).
 *   reply  → composed in brand voice with the thread's history (lib/social/inbound-social.ts composeInboundReply) and screened
 *            (lib/compliance/content-safety-checks.ts). It is SENT only when every one holds: a private DM on a surface with a
 *            send path, the person's thread ids known, a clean screen, and ai_isa EXPLICITLY granted autonomy (posture
 *            "autonomous" + authority ≥ COMMUNICATION + no halt). Otherwise a PERSON approves it (a public comment always).
 *   text   → wave 147 (owner ruling 12): a TEXT from a known person may be answered unattended under the SAME explicit grant
 *            and screen, through lib/providers/dispatch.ts dispatchSms (./inbound-reply-executors.ts sendInboundSmsReply); a first-time texter, a refused
 *            gate or no grant → the reply-coach draft for a person, with the reason. The decision runs under the expert
 *            brief ARBITER_INBOUND_SYSTEM (lib/ai-isa/followup-arbiter.ts).
 */
export async function respondToInboundCommunication(svc: { from: (t: string) => any }, req: InboundRespondRequest, deps: InboundResponderDeps = {}): Promise<InboundResponse> {
  const now = deps.now ?? new Date()
  try {
    if (!req.brokerageId || !req.recordId) return { action: "refused", reason: "no tenant / no inbound record", decision: null }
    const body = (req.body ?? "").trim()
    if (!body) return { action: "no_response", reason: "nothing was said (media only / empty) — recorded for a person", decision: null }
    const routeAgent = deps.routeToAgent ?? routeToAgent
    const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger

    // ── who, tenant-pinned ──
    let contactAgentId: string | null = null
    let locked: { action: "human_task" | "no_response"; reason: string } | null = null
    // Wave 147: a texter the SMS door captured in THIS message (source inbound_sms, created within the half hour before it
    // arrived) is a stranger to us — identification first; nothing about the tenant is sent to them unattended.
    let firstTimeTexter = false
    if (req.contactId) {
      const { data: c, error } = await svc.from("contacts").select("id, agent_id, dnc_status, ai_outreach_paused, first_name, source, created_at").eq("id", req.contactId).eq("brokerage_id", req.brokerageId).maybeSingle()
      if (error) return { action: "refused", reason: `contact read refused: ${error.message}`, decision: null }
      if (!c) return { action: "refused", reason: "contact not in this brokerage", decision: null }
      contactAgentId = (c as { agent_id?: string | null }).agent_id ?? null
      const createdAt = Date.parse(String((c as { created_at?: string | null }).created_at ?? ""))
      const receivedAt = Date.parse(req.receivedAt)
      firstTimeTexter = (c as { source?: string | null }).source === "inbound_sms" && Number.isFinite(createdAt) && Number.isFinite(receivedAt) && receivedAt - createdAt <= 30 * 60_000 && receivedAt - createdAt >= -5 * 60_000
      if ((c as { dnc_status?: boolean | null }).dnc_status) locked = { action: "human_task", reason: "the person is on do-not-contact — they wrote in, so a PERSON decides whether and how to answer" }
      else if ((c as { ai_outreach_paused?: boolean | null }).ai_outreach_paused) locked = { action: "human_task", reason: "AI outreach is paused for this person — a person answers" }
    }
    const blindSpots: string[] = []
    let threadAgentId: string | null = contactAgentId
    if (req.conversationId) {
      const { data: conv, error: convErr } = await svc.from("conversations").select("agent_id").eq("id", req.conversationId).eq("brokerage_id", req.brokerageId).maybeSingle()
      if (convErr) blindSpots.push(`thread owner not read (${convErr.message}) — the contact's agent stands in`)
      threadAgentId = (conv as { agent_id?: string | null } | null)?.agent_id ?? threadAgentId
    }
    if (!locked && req.intent?.primary === "unsubscribe" && req.intent.confidence >= 60) locked = { action: "no_response", reason: "the message reads as a request to stop — no automated answer (the opt-out door and the compliance suggestion handle it)" }
    if (!locked && (INBOUND_RISK_RE.test(body) || (req.intent && HUMAN_INTENTS.has(req.intent.primary) && req.intent.confidence >= 55))) {
      locked = { action: "human_task", reason: "a complaint, legal, fair-housing or cancellation message — a person answers it" }
    }

    // ── the closed menu ──
    const replyCh = replyChannelFor(req.channel)
    const replyOpt: ArbiterOption = { id: "reply", kind: "communication", channels: [replyCh], why: [req.isPublic ? "answer the public comment on the same post (a person approves a public reply)" : "answer them in the thread they wrote in"] }
    const humanOpt: ArbiterOption = { id: "notify_human", kind: "agent_intervention", channels: ["human_task"], why: ["the message needs a person's judgment"] }
    const adId = req.threadRef?.ad_id ?? null
    const adOpt: ArbiterOption | null = adId && req.contactId
      ? { id: "audience_reengagement", kind: "communication", channels: ["ads"], why: ["the person interacted with an ad — a 1:1 follow-up to an identity-matched, consented audience (consent, budget and authority are checked inside)"] }
      : null
    const menu: ArbiterMenu = { menu: [replyOpt, humanOpt, ...(adOpt ? [adOpt] : [])], locked: null }

    // ── context (contract C6 — only preference keys ever reach the model) ──
    let preferences: Array<{ key: string; value: string }> = []
    if (req.contactId && !req.isPublic) {
      try {
        preferences = await customer360Preferences(svc, req.brokerageId, req.contactId, deps.customer360For)
      } catch (e) {
        blindSpots.push(`customer 360 not read (${e instanceof Error ? e.message : String(e)})`)
      }
    }
    const facts: ArbiterFacts = {
      subject: "contact",
      relationship: { type: req.contactId ? (firstTimeTexter ? "first_time_texter_just_met" : "contact") : "unidentified_public_sender", persona: null, hasAssignedAgent: !!threadAgentId },
      intent: req.intent ? { score: req.intent.confidence, trend: req.intent.primary } : null,
      history: { hoursSinceAnyTouch: null, hoursSinceAgentTouch: null, campaignTouches7d: null, lastChannel: req.channel, portalEducationViews: null },
      journey: { transactionStage: null, nextMilestone: null, openLessons: null, nextLesson: null },
      preferences: preferences.filter((p) => ARBITER_MEMORY_KEYS.includes(p.key)).map((p) => ({ key: p.key, value: String(p.value).slice(0, 120) })),
      fatigueRisk: null,
      localHour: null,
      moment: { key: `inbound_${req.channel}`, intent: `${req.isPublic ? "A public" : "A private"} ${req.channel.replace(/_/g, " ")} arrived on ${req.surface ?? req.channel}${req.intent ? ` (read as ${req.intent.primary}, urgency ${req.intent.urgency})` : ""}: answer it usefully or hand it to a person.`, daysSinceOpen: 0 },
      blindSpots,
      urgency: req.intent && (req.intent.urgency === "high" || req.intent.urgency === "critical") ? "high" : "normal",
    }

    const policy = deps.policy ?? (await (await import("@/lib/ai-isa/followup-policy")).loadFollowupPolicy(svc, req.brokerageId)).policy
    const decision: ArbiterDecision | null = locked
      ? null
      : await arbitrateFollowUp({ brokerageId: req.brokerageId, facts, menu, planned: replyOpt, policy, system: ARBITER_INBOUND_SYSTEM }, { decide: deps.decide })
    const chosen = locked ? (locked.action === "human_task" ? "notify_human" : "none") : decision!.optionId

    const autonomyPolicyKey = "autonomy_tier:ai_isa"
    let out: InboundResponse = { action: "replayed", reason: "this inbound was already answered — never twice", decision }
    await ledger<InboundResponse>(
      {
        // domain.entity.action (lib/kernel/action-ledger.ts ACTION_NAME_PATTERN — a two-part name is NOT ledgered at all).
        brokerageId: req.brokerageId, action: "inbound.message.respond", actor: { type: "manager", managerKey: "ai_isa" },
        subject: req.contactId ? { type: "contact", id: req.contactId } : { type: "conversation", id: req.conversationId ?? req.recordId },
        reasonCode: "CONVERSATION_RESPONSE", reasonDetail: (locked?.reason ?? decision?.rationale ?? "").slice(0, 500),
        cycle: inboundDecisionCycle(req.recordId), channel: req.channel, riskClass: "COMMUNICATION", systemSource: "inbound_responder",
        policyKey: chosen === "reply" ? autonomyPolicyKey : "followup_policy",
        detail: {
          record_id: req.recordId, conversation_id: req.conversationId, surface: req.surface, public: req.isPublic, provider: req.provider,
          intent: req.intent, locked: locked?.reason ?? null, ...(decision ? { arbitration: arbitrationLedgerDetail(decision, null, { blindSpots }) } : {}),
        },
      },
      async () => {
        // ── a lock: no answer, or a person ──
        if (locked?.action === "no_response") return (out = { action: "no_response", reason: locked.reason, decision: null })
        if (chosen === "notify_human") {
          const why = locked?.reason ?? decision?.rationale ?? "the message needs a person"
          if (req.contactId && threadAgentId) {
            const tasked = await routeAgent(svc, { brokerageId: req.brokerageId, contactId: req.contactId, agentId: threadAgentId, now, title: `Answer ${req.surface ?? req.channel} message personally`, description: `Why: ${why}\n"${body.slice(0, 300)}"` })
            return (out = { action: tasked ? "human_task" : "refused", reason: tasked ? why : `${why} — but the agent task was NOT written`, decision })
          }
          const propose = deps.propose ?? (async (p) => (await import("@/lib/social/inbound-social")).proposeInboundReply(svc, p))
          const card = await propose({ brokerageId: req.brokerageId, agentId: threadAgentId, contactId: req.contactId, conversationId: req.conversationId, recordId: req.recordId, surface: req.surface ?? req.channel, isPublic: req.isPublic, proposedText: null, why, safety: [], priority: "high" })
          return (out = { action: card.proposed ? "human_task" : "refused", reason: card.proposed ? why : `${why} — but nobody could be shown it (${card.reason ?? "no card"})`, decision })
        }
        // ── 1:1 ad follow-up (contract C2 — consent, identity match, budget and authority are checked INSIDE) ──
        if (chosen === "audience_reengagement" && req.contactId && adId) {
          try {
            // Contract C2 by NAME (lane 146E's module, read at its worktree 2026-10-29): input { brokerageId, partyIds, basis ∈
            // REENGAGEMENT_BASES, creativeHint }, result { ok: true, status: "pending_approval", … } | { ok: false, reason }.
            // The basis is the first-party ACTION ("they answered an ad"), never a characteristic of the person.
            const reengage = deps.reengage ?? (async (p) => ((await import("@/lib/ads/audience-reengagement")) as unknown as { requestAudienceReengagement: (x: typeof p) => Promise<unknown> }).requestAudienceReengagement(p))
            const r = (await reengage({ brokerageId: req.brokerageId, partyIds: [req.contactId], basis: "inbound_ad_response", creativeHint: `answered ad ${adId}: ${body.slice(0, 160)}` })) as { ok?: boolean; status?: string; reason?: string; error?: string } | null
            const ok = !!(r && r.ok === true)
            return (out = { action: ok ? "audience_reengagement" : "refused", reason: ok ? `1:1 ad follow-up requested${r?.status ? ` (${r.status})` : ""} — ${decision?.rationale ?? "the person answered an ad"}` : `the re-engagement request was refused (${r?.reason ?? r?.error ?? "no reason given"})`, decision })
          } catch (e) {
            return (out = { action: "refused", reason: `contract C2 unavailable (${e instanceof Error ? e.message : String(e)})`, decision })
          }
        }
        // ── reply: a TEXT may be answered unattended — wave 147 (147G, owner ruling 12: "verified webhook → … → arbiter
        //    decision → AUTHORIZED response or human escalation → delivery outcome → action evidence"). Authorized means the
        //    EXISTING policy, all of it: an EXPLICIT ai_isa autonomy grant (posture autonomous + authority ≥ COMMUNICATION + no
        //    halt), a known person (never a texter we met in this very message — nothing about the tenant is said to a stranger
        //    unattended), a clean content-safety screen, and then the ONE SMS chokepoint (lib/providers/dispatch.ts dispatchSms:
        //    the autonomy gate again, suppression, TCPA consent, de-confliction, quiet hours, content backstop, budget, the
        //    ledger at-most-once per inbound, the delivery claim the status callback reconciles). Anything any of them refuses
        //    falls through to the reply-coach draft below — a PERSON with the draft, and the reason recorded. ──
        let smsWhyNot: string | null = null
        if (replyCh === "sms" && req.contactId && req.conversationId && !req.isPublic) {
          if (firstTimeTexter) smsWhyNot = "a first message from a texter we just met — a person answers (nothing about the tenant is sent to a stranger unattended)"
          else {
            const drafted = await (deps.compose ?? (async (p) => (await import("@/lib/social/inbound-social")).composeInboundReply(svc, p)))({ brokerageId: req.brokerageId, agentId: threadAgentId, contactId: req.contactId, conversationId: req.conversationId, surface: "sms", isPublic: false, inboundBody: body })
            let screen: (t: string) => string[]
            if (deps.safety) screen = deps.safety
            else {
              const { evaluateContentSafety } = await import("@/lib/compliance/content-safety-checks")
              screen = (t: string) => evaluateContentSafety(t).map((v) => `${v.category}: ${v.phrase}`)
            }
            const safety = drafted ? screen(drafted.text) : []
            const autonomy = drafted && safety.length === 0 ? await (deps.autonomy ?? ((b) => inboundReplyAutonomy(svc, b)))(req.brokerageId) : { allowed: false, reason: drafted ? `the draft did not pass the content-safety screen (${safety.join("; ").slice(0, 200)})` : "no reply could be composed" }
            if (drafted && safety.length === 0 && autonomy.allowed) {
              const sendSms = deps.sendSms ?? (async (p) => (await import("./inbound-reply-executors")).sendInboundSmsReply(svc, p))
              const s = await sendSms({ brokerageId: req.brokerageId, contactId: req.contactId, conversationId: req.conversationId, agentId: threadAgentId, recordId: req.recordId, text: drafted.text })
              if (s.sent) return (out = { action: "reply_sent", reason: decision?.rationale ?? "answered in the thread within the tenant's autonomy grant", decision, proposedText: drafted.text, safety, autonomy, providerRef: s.providerRef ?? null, outboundMessageId: s.messageId ?? null })
              smsWhyNot = `the text did not go (${s.error ?? "refused"}) — a person answers with the draft`
            } else smsWhyNot = autonomy.reason ?? "the tenant has not granted autonomous replies — a person approves"
          }
        }
        // ── reply: email / text / portal ride the EXISTING reply-coach rail (a draft a person sends) ──
        if (replyCh !== "social") {
          if (!req.contactId || !req.conversationId) return (out = { action: "refused", reason: "a private reply needs the person and the thread", decision })
          // agents.id → users.id through the ONE resolver (lib/kernel/relationship-graph.ts agentUserIdFor — DISJOINT ids, §3).
          const owner = threadAgentId ? await (await import("@/lib/kernel/relationship-graph")).agentUserIdFor(svc, req.brokerageId, threadAgentId) : { userId: null, error: null }
          const agentUserId = owner.userId
          if (!agentUserId) return (out = { action: "refused", reason: owner.error ? `the thread's agent could not be read (${owner.error})` : "no agent owns this thread — nobody to draft the reply for", decision })
          const coach = deps.replyCoach ?? (async (p) => (await import("./inbound-reply-executors")).draftProactiveReply({ brokerageId: p.brokerageId, agentUserId: p.agentUserId, conversationId: p.conversationId, contactId: p.contactId, messageId: p.inboundMessageId, body: p.inboundBody, channel: p.channel }))
          const coachChannel: "email" | "sms" | "in_app" = replyCh === "email" ? "email" : replyCh === "sms" ? "sms" : "in_app"
          const d = await coach({ brokerageId: req.brokerageId, agentUserId, conversationId: req.conversationId, contactId: req.contactId, inboundMessageId: req.recordId, inboundBody: body, channel: coachChannel })
          if (d.success) return (out = { action: "reply_proposed", reason: smsWhyNot ? `a reply draft waits for the agent — ${smsWhyNot}` : "a reply draft waits in the thread for the agent (the reply-coach rail — nothing auto-sends)", decision, draftId: d.draftId ?? null, agentUserId })
          // The coach refused (e.g. no TCPA consent on file for an SMS draft): the agent is still TOLD, with the reason — a
          // person who wrote in is never left with nobody aware of them.
          const tasked = await routeAgent(svc, { brokerageId: req.brokerageId, contactId: req.contactId, agentId: threadAgentId, now, title: `Answer ${req.channel} message personally`, description: `Why: the reply draft was refused (${d.error ?? "no reason"})${smsWhyNot ? `; ${smsWhyNot}` : ""}\n"${body.slice(0, 300)}"` })
          return (out = { action: tasked ? "human_task" : "refused", reason: tasked ? `the reply draft was refused (${d.error ?? "no reason"}) — the agent was handed it` : `the reply draft was refused (${d.error ?? "no reason"}) and the agent task was NOT written`, decision, agentUserId })
        }
        // ── reply: social ──
        const compose = deps.compose ?? (async (p) => (await import("@/lib/social/inbound-social")).composeInboundReply(svc, p))
        const drafted = await compose({ brokerageId: req.brokerageId, agentId: threadAgentId, contactId: req.contactId, conversationId: req.conversationId, surface: req.surface ?? "facebook", isPublic: req.isPublic, inboundBody: body })
        // The pre-send screen every release-blocking category runs through (fair housing, guarantees, PII, prompt-injection echo).
        let screen: (t: string) => string[]
        if (deps.safety) screen = deps.safety
        else {
          const { evaluateContentSafety } = await import("@/lib/compliance/content-safety-checks")
          screen = (t: string) => evaluateContentSafety(t).map((v) => `${v.category}: ${v.phrase}`)
        }
        const safety = drafted ? screen(drafted.text) : []
        const recipientId = req.threadRef?.author_id ?? req.threadRef?.sender_id ?? null
        const accountId = req.threadRef?.account_id ?? req.threadRef?.page_id ?? null
        const sendable = !req.isPublic && !!drafted && safety.length === 0 && !!recipientId && !!accountId && DM_SEND_SURFACES.has(req.surface ?? "")
        let autonomy: { allowed: boolean; reason: string | null } = { allowed: false, reason: req.isPublic ? "a public reply is an external publication — a person approves it" : "not a sendable private DM" }
        if (sendable) autonomy = await (deps.autonomy ?? ((b) => inboundReplyAutonomy(svc, b)))(req.brokerageId)
        if (sendable && autonomy.allowed) {
          const send = deps.send ?? (async (p) => (await import("@/lib/social/inbound-social")).sendInboundSocialReply(svc, p))
          const s = await send({ brokerageId: req.brokerageId, conversationId: req.conversationId, contactId: req.contactId, agentId: threadAgentId, surface: req.surface!, accountId: accountId!, recipientId: recipientId!, text: drafted!.text, inReplyTo: req.recordId })
          if (s.sent) return (out = { action: "reply_sent", reason: decision?.rationale ?? "answered in the thread", decision, proposedText: drafted!.text, safety, autonomy })
          autonomy = { allowed: false, reason: `the send was refused (${s.error ?? "no reason"}) — proposed to a person instead` }
        }
        const propose = deps.propose ?? (async (p) => (await import("@/lib/social/inbound-social")).proposeInboundReply(svc, p))
        const card = await propose({ brokerageId: req.brokerageId, agentId: threadAgentId, contactId: req.contactId, conversationId: req.conversationId, recordId: req.recordId, surface: req.surface ?? "social", isPublic: req.isPublic, proposedText: drafted?.text ?? null, why: autonomy.reason ?? decision?.rationale ?? "a person approves this reply", safety, priority: safety.length > 0 ? "high" : "medium" })
        return (out = { action: card.proposed ? "reply_proposed" : "refused", reason: card.proposed ? (autonomy.reason ?? "a person approves this reply") : `the proposal could not be shown (${card.reason ?? "no card"})`, decision, proposedText: drafted?.text ?? null, safety, autonomy })
      },
      {
        settle: (r) => ({ status: r.action === "refused" ? "failed" : r.action === "reply_sent" || r.action === "audience_reengagement" ? "executed" : "skipped", outcome: r.action, error: r.action === "refused" ? r.reason : null, ...(r.providerRef ? { providerRef: r.providerRef } : {}) }),
        replay: () => out,
      },
      { client: svc as never },
    )
    return out
  } catch (e) {
    return { action: "refused", reason: `threw: ${e instanceof Error ? e.message : String(e)}`, decision: null }
  }
}

/**
 * May ai_isa SEND a reply unattended for this tenant? Only on an EXPLICIT grant: the tenant's posture for ai_isa is
 * "autonomous" (managed_agents.config — set by a person or earned by the eval loop), the authority ladder is at or above
 * COMMUNICATION, and neither the platform nor the tenant is halted (lib/managers/autonomy-gate.ts — one decision, never a
 * second copy). Absence of a grant is "a person approves" — a new autonomous behaviour never defaults on. Fails closed.
 */
async function inboundReplyAutonomy(svc: { from: (t: string) => any }, brokerageId: string): Promise<{ allowed: boolean; reason: string | null }> {
  try {
    const g = await import("@/lib/managers/autonomy-gate")
    const posture = await g.resolveManagerAutonomy(brokerageId, "ai_isa", svc as never)
    const authority = await g.resolveAgentAuthorityLevel(brokerageId, "ai_isa", svc as never)
    const d = g.autonomyDecision({ managerKey: "ai_isa", effective: posture, authorityLevel: authority })
    if (!d.allow) return { allowed: false, reason: d.reason }
    if (posture !== "autonomous") return { allowed: false, reason: "the tenant has not granted the AI ISA autonomous replies — a person approves (managed_agents ai_isa autonomy_tier)" }
    return { allowed: true, reason: null }
  } catch (e) {
    return { allowed: false, reason: `autonomy could not be read (${e instanceof Error ? e.message : String(e)}) — a person approves` }
  }
}

/** Customer 360's preference fields (`fields["preferences.<column>"]`) → the arbiter's memory keys. Nothing else is read. */
const C360_PREFERENCE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "preferences.preferred_channel": "channel_preference",
  "preferences.preferred_contact_time": "preferred_contact_time",
  "preferences.preferred_language": "language",
})

/**
 * Contract C6 — the preference facts Customer 360 holds for a contact (lib/enrichment/customer-360.ts customer360For(svc,
 * brokerageId, { type, id }, { slices }) → { ok: true, view: { fields } } | { ok: false, reason } — lane 146D, read at its
 * worktree 2026-10-29). Only the `preferences` slice is asked for, and only the three fields mapped in C360_PREFERENCE_KEYS
 * (each an ARBITER_MEMORY_KEYS key) leave this function — no sensitive, protected or financial field can reach the model
 * whatever the view carries. A refused view throws (the caller records it as a blind spot, never as "no preferences").
 */
async function customer360Preferences(
  svc: { from: (t: string) => any },
  brokerageId: string,
  contactId: string,
  door?: InboundResponderDeps["customer360For"],
): Promise<Array<{ key: string; value: string }>> {
  let view360 = door
  if (!view360) {
    const mod = (await import("@/lib/enrichment/customer-360")) as unknown as { customer360For?: InboundResponderDeps["customer360For"] }
    if (typeof mod.customer360For !== "function") throw new Error("customer360For is not exported (contract C6)")
    view360 = mod.customer360For
  }
  const r = (await view360(svc, brokerageId, { type: "contact", id: contactId }, { slices: ["preferences"] })) as { ok?: boolean; reason?: string; view?: { fields?: Record<string, { value?: unknown } | null> } } | null
  if (!r || r.ok !== true) throw new Error(`Customer 360 refused (${r?.reason ?? "no result"})`)
  const fields = r.view?.fields ?? {}
  const out: Array<{ key: string; value: string }> = []
  for (const [field, key] of Object.entries(C360_PREFERENCE_KEYS)) {
    const v = fields[field]?.value
    if (!ARBITER_MEMORY_KEYS.includes(key)) continue
    if (typeof v === "string" ? v.trim() !== "" : typeof v === "number") out.push({ key, value: String(v).slice(0, 120) })
  }
  return out
}
