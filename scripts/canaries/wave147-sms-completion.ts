/**
 * scripts/canaries/wave147-sms-completion.ts — SMS → ARBITER → COMPLETION canary (wave 147, lane 147J; owner rulings 12, 13, 14,
 * contracts C13 + C14 — lane 147G):
 *   "SMS must reach the arbiter's responder end to end … no duplicate reply on webhook retry." · "Managers make sure the arbiter
 *    completes — not cron." · "cron only reconciles what events missed, and says so in the ledger (recovered_by: 'cron')."
 *   → a Twilio text (verified webhook — stripped route) → ONE C1 record keyed on the MessageSid (m876) on THIS tenant's contact
 *     → intent read → the arbiter decides under the expert inbound brief, ledgered → an AUTHORIZED reply → a C14 completion
 *     opened with the record and moved to "awaiting the provider's delivery report" → the Twilio status callback's evidence
 *     CLOSES it (no clock) → a retried SID re-reads the same row and sends nothing → a stall (nobody acted by due) raises an
 *     exception the Exception Center reads and the person's evidence closes both → the cron net recovers only what events
 *     missed and stamps recovered_by 'cron' on the row and the ledger.
 *
 * Driven through the REAL modules: lib/voice/sms-inbound.ts recordInboundMessage → lib/communications/inbound-record.ts
 * processInboundCommunication → lib/communications/inbound-responder.ts respondToInboundCommunication → lib/ai-isa/
 * followup-arbiter.ts (ARBITER_INBOUND_SYSTEM) → lib/kernel/completion-tracking.ts (openCompletion, onProviderTruth,
 * superviseCompletion, reconcileOpenCompletions) → lib/kernel/exception-center.ts composeExceptionCenter. Seamed exactly as lane
 * 147G's proofs seam them: the arbiter's model, the per-message classifier, the composer, the autonomy grant, the content screen,
 * the SMS chokepoint (dispatchSms), the reply coach, the durable-timer start and the healing engine's emit / proposal writer.
 */
import { strippedRepo } from "./_registry"
import { stripComments } from "../strip-comments"
import { memSupabase, type Row } from "../in-memory-supabase"
import { quiet } from "./wave145-harness"
import { canary147, jsonOf, tbl } from "./wave147-harness"

const B1 = "91470000-0000-4000-8000-0000000000b1"
const C1 = "91470000-0000-4000-8000-0000000000c1"
const A1 = "91470000-0000-4000-8000-0000000000a1"
const U1 = "91470000-0000-4000-8000-0000000000e1"
const UNIQUE = { messages: [["brokerage_id", "metadata->>provider", "metadata->>provider_ref"]], agent_action_ledger: [["idempotency_key"]], manager_completions: [["idempotency_key"]] }
const NOW = new Date()
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString()
const ahead = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString()

function world(extra: Record<string, Row[]> = {}) {
  return memSupabase({
    brokerages: [{ id: B1, ai_isa_system_user_id: null }],
    contacts: [{ id: C1, brokerage_id: B1, agent_id: A1, first_name: "Dana", phone: "+15551470001", phone_digits: "15551470001", tcpa_consent: true, dnc_status: false, ai_outreach_paused: false, source: "website", created_at: "2026-01-01T00:00:00Z" }],
    agents: [{ id: A1, brokerage_id: B1, user_id: U1, is_active: true, created_at: "2026-01-01T00:00:00Z" }],
    conversations: [], messages: [], agent_action_ledger: [], manager_completions: [], activities: [], ai_message_drafts: [], notifications: [],
    outcome_reconciliations: [], self_heal_events: [], brokerage_settings: [], platform_settings: [], connector_healing_proposals: [], support_tickets: [],
    ...extra,
  }, { uuidIds: true, stampCreatedAt: true, unique: UNIQUE })
}

export async function run() {
  const c = canary147("SMS → arbiter → completion (C13, C14): a verified text is recorded once on its SID, decided under the expert brief, answered within authority, its completion closed by the provider's delivery evidence; a retry never re-sends; a stall becomes an exception; cron recovers only what events missed and says so")
  const sms = await quiet(async () => import("../../lib/voice/sms-inbound")) as unknown as Record<string, any>
  const responder = await quiet(async () => import("../../lib/communications/inbound-responder")) as unknown as Record<string, any>
  const arb = await quiet(async () => import("../../lib/ai-isa/followup-arbiter")) as unknown as Record<string, any>
  const ct = await quiet(async () => import("../../lib/kernel/completion-tracking")) as unknown as Record<string, any>
  const { DEFAULT_FOLLOWUP_POLICY } = await quiet(async () => import("../../lib/ai-isa/followup-policy")) as unknown as { DEFAULT_FOLLOWUP_POLICY: Record<string, any> }
  const { composeExceptionCenter } = await quiet(async () => import("../../lib/kernel/exception-center")) as unknown as { composeExceptionCenter: (rows: unknown[]) => { open: Array<{ subject: string }> } }

  /** Lane 147G's seams: the model chooses `reply`, the tenant granted autonomy, the chokepoint "sends" and writes its evidence. */
  function seams(db: ReturnType<typeof world>) {
    const calls = { decide: [] as Array<{ system: string; prompt: string }>, classify: [] as string[], sent: [] as Array<{ text: string; recordId: string }>, coach: 0, schedule: 0 }
    const responderDeps = {
      policy: { ...DEFAULT_FOLLOWUP_POLICY, arbiter: { ...DEFAULT_FOLLOWUP_POLICY.arbiter, enabled: true, minConfidence: 0.3 } },
      decide: async (a: { system: string; prompt: string }) => { calls.decide.push(a); return { optionId: "reply", channel: null, format: null, waitHours: null, rationale: "They asked a routine question in a live thread; the team can answer it now.", evidence: ["intent", "moment"], confidence: 0.82 } },
      autonomy: async () => ({ allowed: true, reason: null }),
      customer360For: async () => ({ ok: true, view: { fields: {} } }),
      compose: async (p: { inboundBody: string }) => ({ text: `Hi! Thanks for the text about "${p.inboundBody.slice(0, 20)}" — I'll get you the details shortly.` }),
      safety: () => [],
      sendSms: async (p: Record<string, any>) => {
        calls.sent.push({ text: p.text, recordId: p.recordId })
        const sid = `SM-147J-out-${calls.sent.length}`
        await db.from("messages").insert({ conversation_id: p.conversationId, brokerage_id: p.brokerageId, contact_id: p.contactId, type: "sms", direction: "outbound", sender_type: "ai", body: p.text, status: "sent", metadata: { provider: "twilio", twilio_sid: sid, in_reply_to: p.recordId, autonomous: true } })
        await db.from("outcome_reconciliations").insert({ brokerage_id: p.brokerageId, channel: "sms", provider_ref: sid, claimed_status: "queued", verdict: "pending", contact_id: p.contactId })
        return { sent: true, providerRef: sid, messageId: `out-${calls.sent.length}` }
      },
      replyCoach: async () => { calls.coach++; return { success: true, draftId: `draft-${calls.coach}` } },
    }
    const chain = {
      classify: async (p: { body: string }) => { calls.classify.push(p.body); return { primary: "question", confidence: 78, urgency: "normal" } },
      emit: async () => ({}),
      stopSequences: async () => ({ unenrolled: 0 }),
      promise: async () => ({ action: "nothing_owed", reason: "nothing promised" }),
      optOut: async () => ({ success: true }),
      respond: async (p: unknown) => responder.respondToInboundCommunication(db, p, responderDeps),
      completions: { schedule: async () => { calls.schedule++; return { scheduled: true } } },
    }
    return { calls, chain }
  }
  const text = (db: ReturnType<typeof world>, chain: unknown, body: string, sid: string) =>
    quiet(async () => sms.recordInboundMessage(db, { brokerageId: B1, contactId: C1, agentUserId: U1, channel: "sms", body, messageSid: sid, fromPhone: "+15551470001", toPhone: "+15559990147" }, chain)) as Promise<Record<string, any>>

  // ── 1 · stage 1: the verified webhook (stripped route source) ──
  const route = strippedRepo("app/api/providers/inbound/route.ts") ?? ""
  const verify = route.indexOf("normalizeInbound(req")
  const firstWrite = Math.min(...["recordInboundMessage(", "captureTextingContact(", ".insert(", "processOptOutFromVerifiedInbound("].map((t) => route.indexOf(t)).filter((i) => i > 0))
  const routeControl = stripComments("// normalizeInbound(req) — commented out").indexOf("normalizeInbound(req") < 0 && stripComments("const r = await normalizeInbound(req, x)").indexOf("normalizeInbound(req") > 0
  c.rule("147G", "STAGE 1 — THE WEBHOOK IS VERIFIED BEFORE ANY WRITE (ruling 12: 'verified webhook → durable inbound record'): the Twilio signature check (normalizeInbound with the per-tenant token resolver) precedes every write in app/api/providers/inbound/route.ts, and the tenant is the CALLED number's (stripped source; POSITIVE CONTROL: a commented-out verifier is not one)",
    verify > 0 && verify < firstWrite && /twilioTokenResolver/.test(route) && /resolveTenantByOwnNumber\(supabase, inbound\.toPhone\)/.test(route) && routeControl,
    `verify at ${verify}, first write at ${firstWrite}; per-tenant resolver ${/twilioTokenResolver/.test(route)}; tenant by called number ${/resolveTenantByOwnNumber\(supabase, inbound\.toPhone\)/.test(route)}; control ${routeControl}`)

  // ── 2 · the text → C1 record → decision → authorized reply → completion → delivery evidence closes it ──
  const db = c.track(world(), B1)
  const { calls, chain } = seams(db)
  const r = await text(db, chain, "Is the house on Elm still available this weekend?", "SM-147J-in-1")
  const inbound = tbl(db, "messages").find((m) => m.direction === "inbound") ?? {}
  c.rule("147G", "STAGES 2–3 — ONE DURABLE C1 RECORD KEYED ON THE MESSAGE SID, ON THIS TENANT'S CONTACT (C13 'idempotency key = provider message SID (m876's unique index)'): one inbound messages row (twilio, provider_ref = the SID, unread) on the contact's ONE thread in its brokerage",
    r.recorded === true && tbl(db, "messages").filter((m) => m.direction === "inbound").length === 1 && inbound.metadata?.provider === "twilio" && inbound.metadata?.provider_ref === "SM-147J-in-1" && inbound.contact_id === C1 && inbound.brokerage_id === B1 && tbl(db, "conversations").length === 1,
    `recorded ${r.recorded}; inbound rows ${tbl(db, "messages").filter((m) => m.direction === "inbound").length}; key ${inbound.metadata?.provider}/${inbound.metadata?.provider_ref}; contact ${inbound.contact_id === C1}; threads ${tbl(db, "conversations").length}`)
  const led = tbl(db, "agent_action_ledger").filter((l) => l.action === "inbound.message.respond")
  c.rule("147G", "STAGES 4–6 — INTENT READ → THE ARBITER DECIDES UNDER THE EXPERT INBOUND BRIEF → AN AUTHORIZED REPLY (ruling 12; lane 147G R2): the classifier's reading reached the arbiter, the decision ran under ARBITER_INBOUND_SYSTEM and is ledgered once (inbound.message.respond, reply_sent), and ONE reply went through the SMS chokepoint for THIS inbound row",
    calls.classify.length === 1 && calls.decide.length === 1 && calls.decide[0].system === arb.ARBITER_INBOUND_SYSTEM && /question/.test(calls.decide[0].prompt) && led.length === 1 && led[0].status === "executed" && led[0].outcome === "reply_sent" && calls.sent.length === 1 && calls.sent[0].recordId === inbound.id && r.chain?.response?.action === "reply_sent",
    `classified ${calls.classify.length}; decided ${calls.decide.length} under ${calls.decide[0]?.system === arb.ARBITER_INBOUND_SYSTEM ? "ARBITER_INBOUND_SYSTEM" : "another brief"}; ledger ${led.length} ${led[0]?.outcome}; sent ${calls.sent.length}`)
  const comp = () => tbl(db, "manager_completions")[0] ?? {}
  c.rule("147G", "STAGE 7a — THE DECISION OPENS A COMPLETION (C14 'Every arbiter/manager decision opens a completion (what, owner manager, due, evidence expected)'): one inbound_response completion owned by ai_isa, opened with the record, now waiting for the PROVIDER's delivery report keyed on the sent SID, with the decision as evidence and a durable check scheduled",
    tbl(db, "manager_completions").length === 1 && comp().kind === "inbound_response" && comp().owner_manager === "ai_isa" && comp().stage === "awaiting_delivery" && comp().provider_ref === "SM-147J-out-1" && comp().status === "open" && (comp().evidence ?? []).some((e: Row) => e.kind === "decision" && e.outcome === "reply_sent") && calls.schedule >= 1,
    `completions ${tbl(db, "manager_completions").length}: ${comp().kind}/${comp().owner_manager} stage ${comp().stage} on ${comp().provider_ref} (${comp().status}); evidence ${jsonOf((comp().evidence ?? []).map((e: Row) => e.kind))}; scheduled ${calls.schedule}`)
  const pending = await quiet(async () => ct.onProviderTruth(db, { brokerageId: B1, providerRef: "SM-147J-out-1", verdict: "pending" }))
  const rec = tbl(db, "outcome_reconciliations")[0]; rec.verdict = "confirmed"; rec.provider_status = "delivered"
  const sup = await quiet(async () => ct.onProviderTruth(db, { brokerageId: B1, providerRef: "SM-147J-out-1", verdict: "confirmed" })) as Record<string, any>
  const outbound = tbl(db, "messages").find((m) => m.direction === "outbound") ?? {}
  c.rule("147G", "STAGES 7b–8 — THE PROVIDER'S DELIVERY EVIDENCE CLOSES IT, NOT A CLOCK (C14 'closed by evidence (delivery outcome …)'): the Twilio status callback's event closes the completion on 'delivered' (closed_by delivery_outcome, no recovered_by — an event, not the cron), and the trail is evidence: the outbound row carries the twilio_sid and in_reply_to the inbound — POSITIVE CONTROL: a 'pending' report closed nothing",
    pending === null && sup?.verdict === "closed" && comp().status === "closed" && comp().closed_by === "delivery_outcome" && !comp().recovered_by && (comp().evidence ?? []).some((e: Row) => e.kind === "delivery_outcome" && e.outcome === "delivered") && outbound.metadata?.twilio_sid === "SM-147J-out-1" && outbound.metadata?.in_reply_to === inbound.id,
    `pending report → ${pending === null ? "nothing closed" : "CLOSED"}; confirmed → ${sup?.verdict} (${comp().status}, by ${comp().closed_by}, recovered_by ${comp().recovered_by ?? "∅"}); outbound sid ${outbound.metadata?.twilio_sid} in reply to the inbound ${outbound.metadata?.in_reply_to === inbound.id}`)

  // ── 3 · a retried SID never re-sends ──
  const again = await text(db, chain, "Is the house on Elm still available this weekend?", "SM-147J-in-1")
  const third = await text(db, chain, "Is the house on Elm still available this weekend?", "SM-147J-in-1")
  const sentAfterRetries = calls.sent.length, decidedAfterRetries = calls.decide.length, completionsAfterRetries = tbl(db, "manager_completions").length
  const fresh = await text(db, chain, "Also, is parking included?", "SM-147J-in-2")
  c.rule("147G", "A RETRIED SID RE-READS THE SAME ROW AND NEVER RE-SENDS (C13 'a retry re-reads the same inbound row and never re-sends'): two re-deliveries of SM-147J-in-1 are duplicates of the same record — still one inbound row, one reply, one decision, one completion — POSITIVE CONTROL: a NEW SID is a new record, a new decision and a new reply",
    again.recorded === false && again.chain?.record?.duplicate === true && third.recorded === false && tbl(db, "messages").filter((m) => m.direction === "inbound" && m.metadata?.provider_ref === "SM-147J-in-1").length === 1 && sentAfterRetries === 1 && decidedAfterRetries === 1 && completionsAfterRetries === 1
      && fresh.recorded === true && calls.sent.length === 2 && calls.decide.length === 2 && tbl(db, "manager_completions").length === 2,
    `retries → duplicate ${again.chain?.record?.duplicate}/${third.recorded === false}; after retries sent ${sentAfterRetries}, decided ${decidedAfterRetries}, completions ${completionsAfterRetries}; new SID → sent ${calls.sent.length}, completions ${tbl(db, "manager_completions").length}`)

  // ── 4 · a stall → an exception (exceptions-first os_health) → the person's evidence closes both ──
  const engine = { emit: async () => ({ error: null }), propose: async () => ({ id: "proposal-147j", error: null }) }
  const schedule = async () => ({ scheduled: true })
  const st = c.track(world(), B1)
  const opened = await quiet(async () => ct.openCompletion(st, { brokerageId: B1, kind: "inbound_response", ownerManager: "ai_isa", subject: { type: "contact", id: C1 }, sourceRef: "inbound:m-147j-stall", what: "Answer the sms that arrived", stage: "awaiting_human", expectedEvidence: ["human_action"], dueAt: ago(30), context: { record_id: "m-147j-stall", channel: "sms", conversation_id: "conv-147j", agent_user_id: U1 } }, { schedule })) as Record<string, any>
  const told: string[] = []
  const notify = async (_s: unknown, _c: unknown, sentence: string) => { told.push(sentence); return { notified: 1 } }
  const stalled = await quiet(async () => ct.superviseCompletion(st, { brokerageId: B1, completionId: opened.completion?.id, trigger: "event" }, { schedule, engine, notify })) as Record<string, any>
  const openEx = () => composeExceptionCenter(tbl(st, "self_heal_events").map((x) => ({ id: x.id, subject: x.subject, action: x.action ?? null, outcome: x.outcome, detail: x.detail ?? null, createdAt: x.created_at ?? new Date().toISOString() }))).open
  const exNow = openEx()
  c.rule("147G", "A STALL BECOMES AN EXCEPTION, DETECTED BY THE MANAGER'S SUPERVISION — NOT A CRON (ruling 13; C14 'Stalls are detected by the manager supervision loop driven by events'): nobody acted by due → incomplete_follow_up → the person is told ONCE in one neighbourly sentence and the stall is an OPEN exception the Exception Center (exceptions-first's os_health) reads; the completion reads escalated",
    opened.ok === true && stalled.verdict === "escalated" && stalled.detection === "incomplete_follow_up" && told.length === 1 && /past due/.test(told[0]) && exNow.length === 1 && tbl(st, "manager_completions")[0]?.status === "escalated",
    `supervise → ${stalled.verdict} (${stalled.detection}); told ${told.length}: "${String(told[0] ?? "").slice(0, 90)}"; open exceptions ${exNow.length}; completion ${tbl(st, "manager_completions")[0]?.status}`)
  st.tables.ai_message_drafts!.push({ id: "d-147j", brokerage_id: B1, source_message_id: "m-147j-stall", status: "edited", acted_at: new Date().toISOString() })
  const later = await quiet(async () => ct.superviseCompletion(st, { brokerageId: B1, completionId: opened.completion?.id, trigger: "event" }, { schedule, engine, notify })) as Record<string, any>
  c.rule("147G", "…AND THE PERSON'S EVIDENCE CLOSES BOTH (C14 'closed by evidence (… human action)'): the agent acting on the draft closes the completion (closed_by human_action) and the exception with it (an append-only 'resolved' row) — POSITIVE CONTROL for the zero: the same finder read ONE open exception before the evidence",
    later.verdict === "closed" && tbl(st, "manager_completions")[0]?.closed_by === "human_action" && openEx().length === 0 && exNow.length === 1 && tbl(st, "self_heal_events").some((e) => e.outcome === "resolved"),
    `supervise → ${later.verdict} (by ${tbl(st, "manager_completions")[0]?.closed_by}); open exceptions ${exNow.length} → ${openEx().length}`)

  // ── 5 · cron is recovery only, and says so ──
  const cr = c.track(world({ outcome_reconciliations: [{ id: "R-147j", brokerage_id: B1, channel: "sms", provider_ref: "SM-147J-9", verdict: "confirmed", provider_status: "delivered" }] }), B1)
  const missed = await quiet(async () => ct.openCompletion(cr, { brokerageId: B1, kind: "inbound_response", ownerManager: "ai_isa", subject: { type: "contact", id: C1 }, sourceRef: "inbound:m-147j-9", what: "Answer the sms that arrived", stage: "awaiting_delivery", expectedEvidence: ["delivery_outcome"], dueAt: ago(60), providerRef: "SM-147J-9", context: { record_id: "m-147j-9", channel: "sms" } }, { schedule })) as Record<string, any>
  const notDue = await quiet(async () => ct.openCompletion(cr, { brokerageId: B1, kind: "inbound_response", ownerManager: "ai_isa", subject: { type: "contact", id: C1 }, sourceRef: "inbound:m-147j-10", what: "Answer the sms that arrived", stage: "awaiting_delivery", expectedEvidence: ["delivery_outcome"], dueAt: ahead(60), providerRef: "SM-147J-10", context: { record_id: "m-147j-10", channel: "sms" } }, { schedule })) as Record<string, any>
  const rep = await quiet(async () => ct.reconcileOpenCompletions(cr, B1, { now: NOW }, { schedule, engine })) as Record<string, any>
  const m = tbl(cr, "manager_completions").find((x) => x.id === missed.completion?.id) ?? {}
  const n = tbl(cr, "manager_completions").find((x) => x.id === notDue.completion?.id) ?? {}
  const recon = tbl(cr, "agent_action_ledger").filter((l) => l.action === "completion.evidence.reconcile")
  c.rule("147G", "CRON RECOVERS ONLY WHAT EVENTS MISSED AND SAYS SO (C14 'cron only reconciles what events missed, and says so in the ledger (recovered_by: \"cron\")'): the net closes the past-due completion whose delivered report the event missed — stamped recovered_by 'cron' on the row AND in the ledger (completion.evidence.reconcile) — and leaves the not-yet-due one open; POSITIVE CONTROL: the event-path close above carried no recovered_by",
    rep.recovered === 1 && m.status === "closed" && m.recovered_by === "cron" && n.status === "open" && recon.length === 1 && recon[0].detail?.recovered_by === "cron" && recon[0].status === "executed" && !tbl(db, "manager_completions").some((x) => x.recovered_by === "cron"),
    `net → scanned ${rep.scanned}, recovered ${rep.recovered}; past-due ${m.status} (recovered_by ${m.recovered_by}); not-due ${n.status}; ledger ${recon.length} (recovered_by ${recon[0]?.detail?.recovered_by})`)
  const cron = strippedRepo("app/api/cron/manager-signals/route.ts") ?? ""
  c.rule("147G", "…ON THE EXISTING MANAGER-SIGNALS TICK, NO NEW CRON (lane 147G R4; stripped source): app/api/cron/manager-signals/route.ts calls reconcileOpenCompletions (POSITIVE CONTROL: a commented call is not a call)",
    /\breconcileOpenCompletions\s*\(/.test(cron) && !/\breconcileOpenCompletions\s*\(/.test(stripComments("// reconcileOpenCompletions(svc, b)")), `reconcile call on the tick ${/\breconcileOpenCompletions\s*\(/.test(cron)}`)

  c.blind("The HTTP layer (Twilio's signature over a real request, the webhook's time budget) is judged on stripped source, not executed. The arbiter's model, classifier, composer, autonomy grant, content screen, the SMS chokepoint (dispatchSms), the reply coach, the durable-timer start (a Vercel Workflow, real only on Vercel) and the healing engine's emit / proposal writer are injected (lane 147G's proofs seam the same ones; their own proofs are test:egress-send-guard, test:autonomy-gate, test:self-healing, test:healing-policy). memSupabase models m876's and the ledger's UNIQUEs but no CHECK / RLS / trigger; m904 is modelled in memory. No live soak (one SMS → one workflow run) was run.")
  return c.report()
}
