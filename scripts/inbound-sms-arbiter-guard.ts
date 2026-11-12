/**
 * scripts/inbound-sms-arbiter-guard.ts — test:inbound-sms-arbiter (wave 147, lane 147G; run with --conditions=react-server).
 *
 * OWNER RULING 12 (2026-10-31): "sms needs to reach the arbiter's responder" — end to end: verified webhook → durable inbound
 * record (C1) → identity / tenant match → intent analysis → arbiter decision → authorized response or human escalation →
 * delivery outcome → action evidence; no duplicate reply on webhook retry. CONTRACT C13: each of the eight stages evidenced;
 * idempotency key = the provider MessageSid (m876) — a retry re-reads the same inbound row and never re-sends.
 *
 * Driven end to end on an in-memory database through the REAL door module (lib/voice/sms-inbound.ts recordInboundMessage →
 * lib/communications/inbound-record.ts processInboundCommunication → lib/communications/inbound-responder.ts
 * respondToInboundCommunication → lib/ai-isa/followup-arbiter.ts arbitrateFollowUp → the completion ledger (C14)). The model,
 * classifier, composer, autonomy grant and the SMS chokepoint are injected seams (no network, no key, no spend).
 *
 *   A · stage 1 (verified webhook — stripped route source)   B · stages 2–8 within authority (an unattended text, delivered)
 *   C · retry idempotency (a replayed SID)                    D · authority escalation (a person with the draft)
 *   E · a stranded decision re-driven by the retry, once      F · unknown / first-time texter, opt-out, tenancy
 *   G · delivery contradicted → the agent told, never a re-send   H · the expert decision prompt   I · wiring (stripped)
 *
 * Every refusal has a POSITIVE CONTROL (CLAUDE.md §2). Blind spots are printed at the end.
 */
import { readFileSync } from "node:fs"
import { memSupabase, type Row } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const raw = (p: string) => { try { return readFileSync(p, "utf8") } catch { return "" } }
const code = (p: string) => stripComments(raw(p))

const B1 = "11111111-1111-4111-8111-111111111111"
const B2 = "22222222-2222-4222-8222-222222222222"
const C1 = "c1c1c1c1-0000-4000-8000-000000000001"
const CNEW = "c3c3c3c3-0000-4000-8000-000000000003"
const CB2 = "cb2cb2cb-0000-4000-8000-000000000004"
const A1 = "a1a1a1a1-0000-4000-8000-000000000001"
const U1 = "a2a2a2a2-0000-4000-8000-000000000002"
const NOW = new Date()
const UNIQUE = { messages: [["brokerage_id", "metadata->>provider", "metadata->>provider_ref"]], agent_action_ledger: [["idempotency_key"]], manager_completions: [["idempotency_key"]] }

function world(extra: Record<string, Row[]> = {}) {
  return memSupabase({
    brokerages: [{ id: B1, ai_isa_system_user_id: null }, { id: B2, ai_isa_system_user_id: null }],
    contacts: [
      { id: C1, brokerage_id: B1, agent_id: A1, first_name: "Dana", phone: "+15551230001", phone_digits: "15551230001", tcpa_consent: true, dnc_status: false, ai_outreach_paused: false, source: "website", created_at: "2026-01-01T00:00:00Z" },
      { id: CNEW, brokerage_id: B1, agent_id: A1, first_name: "Texter", phone: "+15551230009", tcpa_consent: true, dnc_status: false, ai_outreach_paused: false, source: "inbound_sms", created_at: new Date(NOW.getTime() - 60_000).toISOString() },
      { id: CB2, brokerage_id: B2, agent_id: null, first_name: "Other", phone: "+15551230002" },
    ],
    agents: [{ id: A1, brokerage_id: B1, user_id: U1, is_active: true, created_at: "2026-01-01T00:00:00Z" }],
    conversations: [], messages: [], agent_action_ledger: [], manager_completions: [], activities: [], ai_message_drafts: [], notifications: [],
    outcome_reconciliations: [], self_heal_events: [], brokerage_settings: [], platform_settings: [], connector_healing_proposals: [],
    ...extra,
  }, { uuidIds: true, stampCreatedAt: true, unique: UNIQUE })
}

type Calls = { decide: Array<{ system: string; prompt: string }>; classify: string[]; sent: Array<{ text: string; recordId: string }>; coach: number; notify: string[]; optOut: Array<{ source: string }>; respond: number; schedule: Array<{ completionId: string; checkAt: string }> }

async function main() {
  const sms = await import("../lib/voice/sms-inbound")
  const responder = await import("../lib/communications/inbound-responder")
  const arb = await import("../lib/ai-isa/followup-arbiter")
  const ct = await import("../lib/kernel/completion-tracking")
  const { DEFAULT_FOLLOWUP_POLICY } = await import("../lib/ai-isa/followup-policy")

  /** The whole door with seams: the arbiter model chooses `reply` (or what `choice` says), the grant is `autonomous`. */
  function seams(db: ReturnType<typeof world>, o: { autonomous?: boolean; choice?: string; safety?: string[]; sendOk?: boolean; respondThrowsOnce?: { n: number }; now?: Date } = {}) {
    const calls: Calls = { decide: [], classify: [], sent: [], coach: 0, notify: [], optOut: [], respond: 0, schedule: [] }
    const responderDeps: Parameters<typeof responder.respondToInboundCommunication>[2] = {
      policy: { ...DEFAULT_FOLLOWUP_POLICY, arbiter: { ...DEFAULT_FOLLOWUP_POLICY.arbiter, enabled: true, minConfidence: 0.3 } },
      decide: async (a) => { calls.decide.push({ system: a.system, prompt: a.prompt }); return { optionId: o.choice ?? "reply", channel: null, format: null, waitHours: null, rationale: "They asked a routine question in a live thread; the team can answer it now.", evidence: ["intent", "moment"], confidence: 0.82 } },
      autonomy: async () => (o.autonomous ? { allowed: true, reason: null } : { allowed: false, reason: "the tenant has not granted the AI ISA autonomous replies — a person approves (managed_agents ai_isa autonomy_tier)" }),
      customer360For: async () => ({ ok: true, view: { fields: {} } }),
      compose: async (p) => ({ text: `Hi! Thanks for the text about "${p.inboundBody.slice(0, 20)}" — I'll get you the details shortly.` }),
      safety: () => o.safety ?? [],
      sendSms: async (p) => {
        calls.sent.push({ text: p.text, recordId: p.recordId })
        if (o.sendOk === false) return { sent: false, error: "Outbound blocked: quiet_hours" }
        const sid = `SM-out-${calls.sent.length}`
        await db.from("messages").insert({ conversation_id: p.conversationId, brokerage_id: p.brokerageId, contact_id: p.contactId, type: "sms", direction: "outbound", sender_type: "ai", body: p.text, status: "sent", metadata: { provider: "twilio", twilio_sid: sid, in_reply_to: p.recordId, autonomous: true } })
        await db.from("outcome_reconciliations").insert({ brokerage_id: p.brokerageId, channel: "sms", provider_ref: sid, claimed_status: "queued", verdict: "pending", contact_id: p.contactId })
        return { sent: true, providerRef: sid, messageId: `out-${calls.sent.length}` }
      },
      replyCoach: async (p) => { calls.coach++; await db.from("ai_message_drafts").insert({ brokerage_id: p.brokerageId, agent_user_id: p.agentUserId, source_message_id: p.inboundMessageId, conversation_id: p.conversationId, contact_id: p.contactId, channel: p.channel, draft_body: "draft", status: "pending" }); return { success: true, draftId: `draft-${calls.coach}` } },
    }
    const chain = {
      classify: async (p: { body: string }) => { calls.classify.push(p.body); return { primary: "question", confidence: 78, urgency: "normal" } },
      emit: async () => ({}),
      stopSequences: async () => ({ unenrolled: 0 }),
      promise: async () => ({ action: "nothing_owed", reason: "nothing promised" }),
      optOut: async (p: { source: string }) => { calls.optOut.push({ source: p.source }); return { success: true } },
      respond: async (p: Parameters<typeof responder.respondToInboundCommunication>[1]) => {
        calls.respond++
        if (o.respondThrowsOnce && o.respondThrowsOnce.n-- > 0) throw new Error("function timed out mid-decision")
        return responder.respondToInboundCommunication(db as never, p, responderDeps)
      },
      completions: { schedule: async (c: { completionId: string; checkAt: string }) => { calls.schedule.push(c); return { scheduled: true } }, ...(o.now ? { now: () => o.now! } : {}) },
    }
    return { calls, chain, responderDeps }
  }
  const text = (db: ReturnType<typeof world>, chain: ReturnType<typeof seams>["chain"], body: string, sid: string | null, contactId = C1, brokerageId = B1) =>
    sms.recordInboundMessage(db as never, { brokerageId, contactId, agentUserId: U1, channel: "sms", body, messageSid: sid, fromPhone: "+15551230001", toPhone: "+15559990000" }, chain as never)
  const ledger = (db: ReturnType<typeof world>, action: string) => db.tables.agent_action_ledger.filter((r) => r.action === action)
  const completionOf = (db: ReturnType<typeof world>) => db.tables.manager_completions[0]

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("A · stage 1 — the VERIFIED webhook (app/api/providers/inbound/route.ts, stripped source)")
  {
    const route = code("app/api/providers/inbound/route.ts")
    const verify = route.indexOf("normalizeInbound(req")
    const firstWrite = Math.min(...["recordInboundMessage(", "captureTextingContact(", ".insert(", "processOptOutFromVerifiedInbound("].map((t) => route.indexOf(t)).filter((i) => i > 0))
    check("the Twilio signature is verified FIRST (normalizeInbound with the per-tenant token resolver) and a refusal returns before any write",
      verify > 0 && verify < firstWrite && /twilioTokenResolver/.test(route) && /if \(!result\.ok\)\s*\{\s*return NextResponse\.json/.test(route))
    check("the tenant is the CALLED number's (resolveTenantByOwnNumber) — an unregistered number is a 404, never a guess", /resolveTenantByOwnNumber\(supabase, inbound\.toPhone\)/.test(route) && /isn't registered to a tenant/.test(route))
    check("POSITIVE CONTROL: the write finder sees the SMS door's record call", route.indexOf("recordInboundMessage(") > verify)
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("B · stages 2–8 — a known person texts; the tenant granted autonomy; the reply goes and is delivered")
  {
    const db = world()
    const { calls, chain } = seams(db, { autonomous: true })
    const r = await text(db, chain, "Is the house on Elm still available this weekend?", "SM-in-1")
    const inbound = db.tables.messages.find((m) => m.direction === "inbound")
    check("STAGE 2 durable record: ONE messages row (inbound, unread) keyed on (twilio, MessageSid) — m876's key", r.recorded && db.tables.messages.filter((m) => m.direction === "inbound").length === 1 && inbound?.metadata?.provider === "twilio" && inbound?.metadata?.provider_ref === "SM-in-1" && inbound?.status === "unread")
    check("STAGE 3 identity / tenant: the text is recorded on THIS tenant's contact and the contact's ONE thread", inbound?.contact_id === C1 && inbound?.brokerage_id === B1 && db.tables.conversations.length === 1 && db.tables.conversations[0].contact_id === C1)
    check("STAGE 4 intent: the per-message classifier read the body and its reading reached the arbiter", calls.classify.length === 1 && calls.classify[0].includes("Elm") && /question/.test(calls.decide[0]?.prompt ?? ""))
    const led = ledger(db, "inbound.message.respond")
    check("STAGE 5 arbiter decision: decided under the EXPERT inbound brief and ledgered once (inbound.message.respond, the arbitration on the row)",
      calls.decide.length === 1 && calls.decide[0].system === arb.ARBITER_INBOUND_SYSTEM && led.length === 1 && led[0].status === "executed" && led[0].outcome === "reply_sent" && !!led[0].detail?.arbitration && led[0].detail.arbitration.option === "reply")
    check("STAGE 6 authorized response: ONE text sent through the SMS chokepoint seam with the composed reply, the response says reply_sent",
      calls.sent.length === 1 && calls.sent[0].recordId === inbound?.id && r.chain?.response?.action === "reply_sent" && calls.coach === 0)
    const c = completionOf(db)
    check("STAGE 7 (C14) the completion moved from awaiting its decision to awaiting the PROVIDER's delivery report, keyed on the sent sid",
      !!c && c.kind === "inbound_response" && c.owner_manager === "ai_isa" && c.stage === "awaiting_delivery" && c.provider_ref === "SM-out-1" && c.status === "open" && c.evidence.some((e: Row) => e.kind === "decision" && e.outcome === "reply_sent") && calls.schedule.length === 2)
    // the Twilio status callback's event
    db.tables.outcome_reconciliations[0].verdict = "confirmed"; db.tables.outcome_reconciliations[0].provider_status = "delivered"
    const sup = await ct.onProviderTruth(db as never, { brokerageId: B1, providerRef: "SM-out-1", verdict: "confirmed" })
    const closed = completionOf(db)
    check("STAGE 7 delivery outcome: the status callback's event closes the completion on the provider's own 'delivered' (no clock involved)",
      sup?.verdict === "closed" && closed.status === "closed" && closed.closed_by === "delivery_outcome" && !closed.recovered_by && closed.evidence.some((e: Row) => e.kind === "delivery_outcome" && e.outcome === "delivered"),
      JSON.stringify({ v: sup?.verdict, r: sup?.reason, s: closed.status, by: closed.closed_by, rb: closed.recovered_by }))
    const outbound = db.tables.messages.find((m) => m.direction === "outbound")
    check("STAGE 8 action evidence: the decision ledger row + the outbound thread row (twilio_sid, in_reply_to the inbound) + the completion's evidence trail",
      led.length === 1 && outbound?.metadata?.twilio_sid === "SM-out-1" && outbound?.metadata?.in_reply_to === inbound?.id && closed.evidence.length >= 2)
    check("POSITIVE CONTROL: a 'pending' report closes nothing", (await ct.onProviderTruth(db as never, { brokerageId: B1, providerRef: "SM-out-1", verdict: "pending" })) === null)
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("C · retry idempotency — Twilio re-delivers the SAME MessageSid")
  {
    const db = world()
    const { calls, chain } = seams(db, { autonomous: true })
    await text(db, chain, "Can I see it Saturday?", "SM-in-2")
    const again = await text(db, chain, "Can I see it Saturday?", "SM-in-2")
    const third = await text(db, chain, "Can I see it Saturday?", "SM-in-2")
    check("the retry re-reads the SAME inbound row: no second messages row, reported a duplicate", !again.recorded && again.chain?.record.duplicate === true && db.tables.messages.filter((m) => m.direction === "inbound").length === 1 && again.chain?.record.recordId === db.tables.messages.find((m) => m.direction === "inbound")?.id)
    check("NO DUPLICATE REPLY: one text sent, one decision, one classification, one ledger decision — across three deliveries",
      calls.sent.length === 1 && calls.decide.length === 1 && calls.classify.length === 1 && ledger(db, "inbound.message.respond").length === 1 && !third.recorded)
    check("…and no second completion (one obligation per inbound row)", db.tables.manager_completions.length === 1)
    const fresh = await text(db, chain, "Also, is parking included?", "SM-in-3")
    check("POSITIVE CONTROL: a NEW MessageSid is a new record, a new decision and a new reply", fresh.recorded && calls.sent.length === 2 && calls.decide.length === 2 && db.tables.manager_completions.length === 2)
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("D · authority escalation — no autonomy grant / a refused gate / a safety finding → a PERSON with the draft")
  {
    const db = world()
    const { calls, chain } = seams(db, { autonomous: false })
    const r = await text(db, chain, "What are the HOA dues on Elm?", "SM-in-4")
    const c = completionOf(db)
    check("outside authority (no explicit grant): nothing is sent; the reply-coach DRAFT waits for the agent (reply_proposed) with the reason",
      calls.sent.length === 0 && calls.coach === 1 && r.chain?.response?.action === "reply_proposed" && /not granted the AI ISA autonomous replies/.test(r.chain?.response?.reason ?? "") && db.tables.ai_message_drafts.length === 1)
    check("(C14) the completion now waits for the PERSON's action, and names who it waits for (the thread's agent, by id)", c.stage === "awaiting_human" && c.expected_evidence.includes("human_action") && c.context.agent_user_id === U1)
    db.tables.ai_message_drafts[0].status = "sent"
    const sup = await ct.superviseCompletion(db as never, { brokerageId: B1, completionId: c.id, trigger: "event" })
    check("the agent sending the draft is the evidence that closes it", sup.verdict === "closed" && completionOf(db).closed_by === "human_action")

    const dbG = world()
    const g = seams(dbG, { autonomous: true, sendOk: false })
    const rg = await text(dbG, g.chain, "Can you text me the address?", "SM-in-5")
    check("granted, but the SMS chokepoint REFUSED (quiet hours): a person gets the draft, the refusal is the reason", g.calls.sent.length === 1 && g.calls.coach === 1 && rg.chain?.response?.action === "reply_proposed" && /quiet_hours/.test(rg.chain?.response?.reason ?? ""))
    const dbS = world()
    const s = seams(dbS, { autonomous: true, safety: ["guarantee: guaranteed"] })
    const rs = await text(dbS, s.chain, "Will it appraise?", "SM-in-6")
    check("granted, but the draft failed the content-safety screen: never sent, a person decides", s.calls.sent.length === 0 && rs.chain?.response?.action === "reply_proposed" && /content-safety/.test(rs.chain?.response?.reason ?? ""))
    const dbH = world()
    const h = seams(dbH, { autonomous: true, choice: "notify_human" })
    const rh = await text(dbH, h.chain, "We need to talk about the counter-offer deadline", "SM-in-7")
    check("the arbiter chose a PERSON (escalation rule): the agent's task is written, nothing is sent", h.calls.sent.length === 0 && rh.chain?.response?.action === "human_task" && dbH.tables.activities.length === 1)
    const dbL = world()
    const l = seams(dbL, { autonomous: true })
    const rl = await text(dbL, l.chain, "My attorney will be in touch about this", "SM-in-8")
    check("a legal / complaint message is LOCKED to a person before the model is asked (no decide call, nothing sent)", l.calls.decide.length === 0 && l.calls.sent.length === 0 && rl.chain?.response?.action === "human_task")
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("E · a stranded decision — the first delivery died mid-decision; the provider's retry re-drives it ONCE")
  {
    const past = new Date(Date.now() - 10 * 60_000)
    const db = world()
    const { calls, chain } = seams(db, { autonomous: true, respondThrowsOnce: { n: 1 }, now: past })
    const first = await text(db, chain, "Is the open house still on Sunday?", "SM-in-9")
    const c0 = completionOf(db)
    check("the first delivery recorded the text, opened the completion, and the decision died (nothing sent, still awaiting its decision)",
      first.recorded && calls.sent.length === 0 && c0.stage === "awaiting_decision" && c0.status === "open" && first.chain?.blindSpots.some((b) => /arbiter responder threw/.test(b)) === true)
    const retry = await text(db, chain, "Is the open house still on Sunday?", "SM-in-9")
    const c1 = completionOf(db)
    check("the RETRY (same SID) re-drives the response stage once: one reply, the decision recorded as evidence stamped recovered_by 'retry'",
      !retry.recorded && retry.chain?.completion?.redriven === true && calls.sent.length === 1 && c1.stage === "awaiting_delivery" && c1.recovered_by === "retry" && db.tables.messages.filter((m) => m.direction === "inbound").length === 1)
    const again = await text(db, chain, "Is the open house still on Sunday?", "SM-in-9")
    check("a further retry re-drives nothing (the decision exists) — still ONE reply", !again.recorded && again.chain?.completion?.redriven === false && calls.sent.length === 1)

    // the same delivery still running (inside the quiet window) is never re-driven
    const dbQ = world()
    const q = seams(dbQ, { autonomous: true, respondThrowsOnce: { n: 1 } })
    await text(dbQ, q.chain, "Hello?", "SM-in-10")
    const qr = await text(dbQ, q.chain, "Hello?", "SM-in-10")
    check("POSITIVE CONTROL: a retry inside the quiet window (the first delivery may still be running) does NOT re-drive", !qr.recorded && qr.chain?.completion?.redriven === false && q.calls.respond === 1)
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("F · an unknown / first-time texter, an opt-out, and tenancy")
  {
    const db = world()
    const { calls, chain } = seams(db, { autonomous: true })
    const r = await text(db, chain, "Hi, who is this? Saw your sign on Maple.", "SM-in-11", CNEW)
    check("a texter the door captured in THIS message is a stranger: even WITH the autonomy grant nothing is sent unattended — a person gets the draft",
      calls.sent.length === 0 && r.chain?.response?.action === "reply_proposed" && /texter we just met/.test(r.chain?.response?.reason ?? "") && /first_time_texter_just_met/.test(calls.decide[0]?.prompt ?? ""))
    const route = code("app/api/providers/inbound/route.ts")
    check("an UNKNOWN number texting the tenant's line is captured first (captureTextingContact — the wave 49/50 consent ruling) and only then recorded",
      route.indexOf("captureTextingContact(") > 0 && route.indexOf("captureTextingContact(") < route.indexOf("recordInboundMessage(") && /source: "inbound_sms"/.test(code("lib/voice/sms-inbound.ts")))

    const dbO = world()
    const o = seams(dbO, { autonomous: true })
    const ro = await text(dbO, o.chain, "STOP", "SM-in-12")
    const co = completionOf(dbO)
    check("STOP: the verified-inbound opt-out writer runs with inbound_sms provenance; the responder never runs; nothing is sent",
      o.calls.optOut.length === 1 && o.calls.optOut[0].source === "inbound_sms" && o.calls.respond === 0 && o.calls.sent.length === 0 && ro.chain?.response?.action === "no_response")
    check("(C14) the opt-out IS the response: the completion closes on the no-response decision", co.status === "closed" && co.closed_by === "decision" && co.evidence[0]?.outcome === "no_response")
    check("the route no longer writes the same suppression twice (Step 7b skips a STOP the chain applied) and labels a Twilio STOP inbound_sms (defect fixed: it read inbound_email)",
      /!smsChainOptOut/.test(route) && /inbound\.providerType === "twilio" \? "inbound_sms" : "inbound_email"/.test(route) && !/inbound\.providerType === "sms" \? "inbound_sms"/.test(route))

    const dbT = world()
    const t = seams(dbT, { autonomous: true })
    const rt = await text(dbT, t.chain, "hello", "SM-in-13", CB2, B1)
    check("TENANCY: a contact of ANOTHER brokerage is refused at the record — nothing written, nobody answered", !rt.recorded && dbT.tables.messages.length === 0 && t.calls.sent.length === 0 && dbT.tables.manager_completions.length === 0)
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("G · delivery CONTRADICTED — the agent hears at once; never a re-send")
  {
    const db = world()
    const { calls, chain } = seams(db, { autonomous: true })
    await text(db, chain, "Thanks — what time works?", "SM-in-14")
    db.tables.outcome_reconciliations[0].verdict = "contradicted"; db.tables.outcome_reconciliations[0].provider_status = "undelivered"
    const notified: string[] = []
    const sup = await ct.onProviderTruth(db as never, { brokerageId: B1, providerRef: "SM-out-1", verdict: "contradicted" }, {
      notify: async (_s, _c, sentence) => { notified.push(sentence); return { notified: 1 } },
      engine: { emit: async () => ({ error: null }), propose: async () => ({ id: null, error: null }) },
    })
    const c = completionOf(db)
    check("a contradiction is a stall NOW (before its due time): failed_delivery → the thread's people told in one sentence with the provider's words",
      !!sup && sup.detection === "failed_delivery" && notified.length === 1 && /did not reach them/.test(notified[0]) && /undelivered/.test(notified[0]) && c.status === "escalated")
    check("NEVER a re-send: still exactly one text", calls.sent.length === 1)
    check("the Exception Center holds it (an escalated self_heal_events row, flow os_health_stalled_completions)", db.tables.self_heal_events.some((e) => e.outcome === "escalated" && e.detail?.flow === "os_health_stalled_completions"))
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("H · the responder's decision prompt is expert and structured (preamble rule; ruling 18)")
  {
    const p = arb.ARBITER_INBOUND_SYSTEM
    const parts = ["ROLE.", "BUSINESS CONTEXT.", "FACTS YOU MAY RELY ON", "WHAT YOU MUST NOT INVENT.", "THE DECISION YOU OWN.", "ESCALATION RULE", "COMPLIANCE BOUNDARY.", "OUTPUT CONTRACT."]
    check(`the inbound brief carries every section (${parts.length}): role, business context, the facts it may rely on, what it must not invent, the decision it owns, the escalation rule, the compliance boundary, the typed output contract`, parts.every((s) => p.includes(s)) && p.length > 2500)
    check("its output contract is the JSON the validator consumes (optionId / channel / format / waitHours / rationale / evidence / confidence)", ["optionId", "channel", "format", "waitHours", "rationale", "evidence", "confidence"].every((k) => p.includes(`\\"${k}\\"`) || p.includes(`"${k}"`)))
    check("it escalates money / offers / legal / fair housing / a first-time texter / low confidence to a person", /offer, a counter, a negotiation/.test(p) && /legal/.test(p) && /fair-housing/.test(p) && /texter we have never met/.test(p) && /confidence under 60/.test(p))
    check("POSITIVE CONTROL: the general follow-up brief does NOT carry these sections (the finder is not vacuous)", !parts.every((s) => arb.ARBITER_SYSTEM.includes(s)))
    check("the responder passes the inbound brief to the ONE decision function (stripped source)", /system:\s*ARBITER_INBOUND_SYSTEM/.test(code("lib/communications/inbound-responder.ts")))
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("I · wiring — stripped source")
  {
    const smsCode = code("lib/voice/sms-inbound.ts")
    const route = code("app/api/providers/inbound/route.ts")
    const resp = code("lib/communications/inbound-responder.ts")
    const exec = code("lib/communications/inbound-reply-executors.ts")
    const status = code("app/api/webhooks/twilio-sms-status/route.ts")
    check("the SMS door rides the WHOLE C1 chain (processInboundCommunication) — not the record alone", /processInboundCommunication\(/.test(smsCode) && !/recordInboundCommunication\(/.test(smsCode))
    check("draftProactiveReply MOVED into the responder (its default replyCoach) — the door no longer fires it on every text; one draft per text, after the decision",
      !/export async function draftProactiveReply/.test(smsCode) && !/draftProactiveReply\(/.test(route) && /export async function draftProactiveReply/.test(exec) && /replyCoach \?\? \(async \(p\) => \(await import\("\.\/inbound-reply-executors"\)\)\.draftProactiveReply\(/.test(resp) && /TOMBSTONE[\s\S]{0,200}draftProactiveReply now lives at/.test(raw("lib/voice/sms-inbound.ts")))
    check("the unattended text goes ONLY through dispatchSms, armed with the ai_isa autonomy gate and at-most-once per inbound (cycle inbound-reply:<record>)",
      /dispatchSms\(\{/.test(exec) && /managerKey: "ai_isa"/.test(exec) && /cycle: `inbound-reply:\$\{p\.recordId\}`/.test(exec) && !/sendSMS\(|messagingSendSMS\(/.test(exec + resp) && /\.sendInboundSmsReply\(svc, p\)/.test(resp))
    check("the Twilio status callback hands the provider's verdict to the completion (onProviderTruth) after reconciling it", status.indexOf("ingestProviderTruth(") > 0 && status.indexOf("onProviderTruth(") > status.indexOf("ingestProviderTruth("))
    check("POSITIVE CONTROL: the stripped readers see code tokens (the route's own verifier call)", /normalizeInbound\(/.test(route))
  }

  console.log("\n  BLIND SPOTS (published, not hidden):")
  console.log("  · the HTTP layer (Twilio's signature over the real request, the 15-second webhook budget) is proven from stripped source, not executed;")
  console.log("  · the model, classifier, composer, content screen, autonomy grant and the SMS chokepoint are injected seams — dispatchSms's own gates are proven by test:egress-send-guard / test:outbound-call-gates, the grant by test:autonomy-gate;")
  console.log("  · the concurrent race (two deliveries inside the same milliseconds) rests on m876's unique index (applied live) and the ledger's idempotency_key, both modelled here;")
  console.log("  · the durable timer (Vercel Workflow) is a seam here; test:completion-tracking proves the supervisor it runs;")
  console.log("  · a LEAD's text rides the lead door (evaluateInboundLeadSignal) — leads get no SMS reply by rule (CLAUDE.md §5) and no completion in this wave.")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(`\n ❌ INBOUND_SMS_ARBITER_FAIL — ${failures.join(" | ")}`); process.exit(1) }
  console.log("\n ✅ INBOUND_SMS_ARBITER_PASS — a text reaches the arbiter's responder; the answer is authorized or a person's, delivered or escalated, evidenced, and never sent twice")
}

main().catch((e) => { console.error(e); process.exit(1) })
