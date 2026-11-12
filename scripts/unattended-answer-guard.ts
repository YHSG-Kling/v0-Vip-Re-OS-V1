/**
 * scripts/unattended-answer-guard.ts — test:unattended-answer (wave 148, lane 148I; run with --conditions=react-server).
 *
 * OWNER RULING 16 (2026-11-01): "if the human hasn't responded and too much time has elapsed, then AI can answer for them.
 * Remember, the OS is supposed to be autonomous as much as the OS can." CONTRACT C24 — respondWhenHumanSilent: after the
 * human window the AI answers within delegated authority (status, verified info, common questions, next steps), NEVER
 * approval / signature / money / legal; completion evidence recorded; managers supervise; the cron only recovers.
 *
 *   A · the scope locks (deterministic, before any model) — each with a specimen AND a look-alike
 *   B · the draft screen (money, approval, legal, promises)            C · the human window
 *   (A–D drive the ONE exported product path, unattendedAnswerers(deps).inbound_response — the lock, the screen and the
 *    window are module-private and proven by what the answerer does: answered or not, the topic read, the model called or not)
 *   D · the answerer end to end (in memory): answered from verified facts through the SMS chokepoint, ledgered,
 *       the agent told, the draft superseded; every refusal sends NOTHING and calls no model where a lock decides
 *   E · through the MANAGER SUPERVISOR (C14): the first stall of a reply handed to a person is answered → awaiting the
 *       provider's delivery report; a declined answer reminds the person with the reason; the second stall never answers;
 *       the cron net uses the same answerer, stamped
 *   F · wiring (stripped source): the composition roots hand the answerer in; the brief is expert; the authority is the gate
 *
 * In-memory database, no network, the model stubbed. POSITIVE CONTROLS throughout (CLAUDE.md §2). Blind spots printed.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { memSupabase, type Row } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const failures: string[] = []
function check(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) } else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n═══ ${s} ═══`)
const raw = (p: string) => { try { return readFileSync(join(process.cwd(), p), "utf8") } catch { return "" } }
const code = (p: string) => stripComments(raw(p))

const B1 = "11111111-1111-4111-8111-111111111111"
const C1 = "c1c1c1c1-0000-4000-8000-000000000001"
const U1 = "a2a2a2a2-0000-4000-8000-000000000002"
const T1 = "71717171-0000-4000-8000-000000000001"
const NOW = new Date()
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString()

function world(body: string, contact: Partial<Row> = {}, extra: Record<string, Row[]> = {}) {
  return memSupabase({
    brokerages: [{ id: B1, ai_isa_system_user_id: null }], manager_completions: [], agent_action_ledger: [], self_heal_events: [], notifications: [],
    outcome_reconciliations: [], ai_message_drafts: [{ id: "d-1", brokerage_id: B1, source_message_id: "m-1", status: "pending", acted_at: null }],
    messages: [{ id: "m-1", brokerage_id: B1, direction: "inbound", conversation_id: "conv-1", contact_id: C1, body, metadata: { channel: "sms", provider: "twilio" }, created_at: ago(300) }],
    contacts: [{ id: C1, brokerage_id: B1, first_name: "Dana", agent_id: "ag-1", dnc_status: false, ai_outreach_paused: false, source: "website", created_at: ago(60 * 24 * 30), ...contact }],
    activities: [], smart_assistant_suggestions: [], brokerage_settings: [], platform_settings: [], connector_healing_proposals: [],
    ...extra,
  }, { uuidIds: true, stampCreatedAt: true, unique: { manager_completions: [["idempotency_key"]], agent_action_ledger: [["idempotency_key"]] } })
}

async function main() {
  const ua = await import("../lib/communications/unattended-answer")
  const ct = await import("../lib/kernel/completion-tracking")

  // Every check below drives the ONE exported product path — the answerer the composition roots hand the supervisor
  // (unattendedAnswerers(deps).inbound_response). The scope lock, the screen and the window are private to the module, so
  // they are proven by what the answerer DOES (answered or not, the topic it read, whether the model was ever called).
  type AnswererDeps = NonNullable<Parameters<typeof ua.unattendedAnswerers>[0]>
  const comp = (over: Partial<Row> = {}) => ({ id: "c-x", brokerage_id: B1, kind: "inbound_response", stage: "awaiting_human", status: "open", due_at: ago(5), context: { record_id: "m-1", channel: "sms", agent_user_id: U1, draft_id: "d-1" }, updated_at: ago(245), ...over }) as never
  const facts = async () => ({ facts: [{ fact: "Their transaction for 12 Elm St is Pending (stage: financing pending).", source: `transactions:${T1}` }, { fact: "The expected closing day is 2026-12-15 (the contract says on or before 2026-12-15).", source: `transactions:${T1}.closing_dates` }], blindSpots: [] })
  const CLEAN_ANSWER = "Hi Dana — thanks for checking in! Your purchase of 12 Elm St is pending and on track for an expected closing on or before December 15. Your agent will follow up with anything new."
  const composeSaying = (answer: string) => async () => ({ object: { topic: "status" as const, answer, facts_used: [1, 2], hands_back_to_agent: true, refuse: false, refuse_reason: null }, costUsd: 0.0004 })
  const okCompose = composeSaying(CLEAN_ANSWER)
  // Wave 149 (lane 149C, ruling 8): the answerer now asks the ARBITER how to answer — a stubbed model that picks the written answer
  // (the C24 behaviour this proof was written for). scripts/arbiter-timing-guard.ts §D drives the other choices.
  const ARB_WRITTEN = async () => ({ optionId: "answer_written", channel: null, format: null, waitHours: null, rationale: "A short written answer from verified facts fits this status question.", evidence: ["moment"], confidence: 0.9 })
  const harness = (body: string, contact: Partial<Row> = {}, over: Partial<AnswererDeps> = {}) => {
    const db = world(body, contact)
    const sent: Array<Record<string, unknown>> = [], composed: string[] = [], told: Array<Record<string, unknown>> = []
    const compose = over.compose ?? okCompose
    const deps: AnswererDeps = {
      now: NOW, facts, authority: async () => ({ allowed: true, reason: null }), safety: () => [], decide: ARB_WRITTEN,
      sendSms: async (p) => { sent.push(p); return { sent: true, providerRef: "SM-unattended-1", messageId: "out-1" } },
      notify: async (_s, p) => { told.push(p) },
      ...over,
      compose: async (p) => { composed.push(p.prompt); return compose(p) },
    }
    const answer = ua.unattendedAnswerers(deps).inbound_response!
    return { db, sent, composed, told, run: (c: unknown = comp()) => answer(db as never, c as never, "workflow") }
  }
  const ask = async (body: string, over: Partial<AnswererDeps> = {}, c?: unknown) => { const h = harness(body, {}, over); const r = await h.run(c); return { h, r } }

  // ── A ────────────────────────────────────────────────────────────────────────────────────────
  section("A · the scope — what the AI may answer in a person's place (deterministic, before any model)")
  const allowed: Array<[string, string]> = [
    ["Any update on where we are with the house?", "status"], ["When do we close?", "status"], ["What's next for us?", "next_steps"],
    ["What time is the inspection on Thursday?", "verified_information"], ["Thanks so much for your help!", "common_question"],
  ]
  for (const [q, t] of allowed) { const { h, r } = await ask(q); check(`answerable: "${q}" → ${t} (answered, the model called once)`, r.answered && r.topic === t && h.composed.length === 1 && h.sent.length === 1, JSON.stringify({ answered: r.answered, topic: r.topic, reason: r.reason })) }
  const refused: Array<[string, string]> = [
    ["Can you approve the counter offer?", "approval"], ["Should we accept the seller's terms?", "approval"], ["Where do I sign the addendum?", "signature"],
    ["Did the DocuSign go out?", "signature"], ["Can we offer $425k?", "money"], ["How much are closing costs?", "money"], ["When is the earnest deposit due?", "money"],
    // A bare dollar amount with no money WORD and no "k"/"dollars" — only the lock's `$` arm sees it (mutation M8's shape).
    ["Would $380,000 work for them?", "money"],
    ["Can I back out of the contract?", "legal"], ["Do I need a lawyer for this?", "legal"], ["I want to file a complaint", "risk"], ["", "empty"],
  ]
  for (const [q, t] of refused) { const { h, r } = await ask(q); check(`never answered unattended: "${q || "(empty)"}" → ${t} (no model call, nothing sent)`, !r.answered && r.topic === t && h.composed.length === 0 && h.sent.length === 0, JSON.stringify({ answered: r.answered, topic: r.topic, reason: r.reason })) }
  {
    const design = await ask("Love the design of the kitchen!"), resigned = await ask("We are resigned to waiting a bit")
    check("POSITIVE CONTROL (look-alikes): 'design', 'resigned to waiting' — a word inside another is not a lock (answered)", design.r.answered && resigned.r.answered, `${design.r.reason} / ${resigned.r.reason}`)
  }
  check("every never-topic has a lock and the scope lists exactly status / verified information / common questions / next steps", ua.NEVER_UNATTENDED_TOPICS.every((t) => ua.NEVER_UNATTENDED_LOCKS[t] instanceof RegExp) && ua.UNATTENDED_ANSWER_TOPICS.join(",") === "status,verified_information,common_question,next_steps")

  // ── B ────────────────────────────────────────────────────────────────────────────────────────
  section("B · the composed answer is screened before it can be sent")
  for (const [label, text, kind] of [
    ["money in the answer is refused", "Your earnest money of $5,000 is due Friday.", "money:"],
    ["a bare amount in the answer is refused (no money word — only the screen's `$` arm sees it)", "The number we talked about is $5,000.", "money:"],
    ["an approval in the answer is refused", "Good news — we have approved the counter.", "approval:"],
    ["a legal opinion in the answer is refused", "Legally you can back out by Monday.", "legal:"],
    ["a guarantee is refused", "We guarantee you'll close on time.", "promise:"],
  ] as Array<[string, string, string]>) {
    const { h, r } = await ask("Any update?", { compose: composeSaying(text) })
    check(`${label} — nothing sent, the screen names it`, !r.answered && h.sent.length === 0 && /refused by the screen/.test(r.reason) && r.reason.includes(kind), r.reason)
  }
  {
    const { h, r } = await ask("Any update?", { compose: composeSaying("Hi Dana — your home is in the appraisal stage and the expected closing day is December 15. Your agent will follow up with details.") })
    check("POSITIVE CONTROL: a clean status answer passes the screen and is sent", r.answered && h.sent.length === 1, r.reason)
  }

  // ── C ────────────────────────────────────────────────────────────────────────────────────────
  section("C · the human window")
  {
    const before = await ask("Any update?", {}, comp({ due_at: new Date(NOW.getTime() + 60_000).toISOString() }))
    check("before the person's window passes → no unattended answer (no model call)", !before.r.answered && /window has not passed/.test(before.r.reason) && before.h.composed.length === 0, before.r.reason)
    const after = await ask("Any update?")
    check("after it → the AI answers", after.r.answered, after.r.reason)
    const tenant = await ask("Any update?", { windowMinutes: 120 }, comp({ updated_at: ago(30) }))
    check("a tenant window longer than the due time wins (the person keeps their full window)", !tenant.r.answered && /window has not passed/.test(tenant.r.reason), tenant.r.reason)
    const tenantPassed = await ask("Any update?", { windowMinutes: 120 }, comp({ updated_at: ago(180) }))
    check("POSITIVE CONTROL: once that tenant window has passed too, the AI answers", tenantPassed.r.answered, tenantPassed.r.reason)
    const delivery = await ask("Any update?", {}, comp({ stage: "awaiting_delivery" }))
    check("not waiting on a person (awaiting_delivery) → no", !delivery.r.answered && /not waiting on a person/.test(delivery.r.reason), delivery.r.reason)
    const ticket = await ask("Any update?", {}, comp({ kind: "support_ticket" }))
    check("a support-ticket completion has no inbound message to answer → no", !ticket.r.answered && /no inbound message to answer/.test(ticket.r.reason), ticket.r.reason)
  }

  // ── D ────────────────────────────────────────────────────────────────────────────────────────
  section("D · the answerer end to end (in memory)")
  {
    const h = harness("Any update on where we are with the house?")
    const r = await h.run()
    check("answered after the window, from verified facts, through the SMS executor", r.answered && h.sent.length === 1 && /pending/i.test(String(h.sent[0].text)) && h.sent[0].recordId === "m-1")
    check("the brief received the person's words and the NUMBERED verified facts with their sources", /THEIR MESSAGE \(verbatim\)/.test(h.composed[0]) && /1\. Their transaction/.test(h.composed[0]) && /\[transactions:/.test(h.composed[0]))
    const led = (h.db.tables.agent_action_ledger ?? []).find((x) => x.action === "inbound.unattended.answer")
    check("ONE ledger row: inbound.unattended.answer — ai_isa, policy autonomy_tier:ai_isa, the facts used, executed, the provider ref", !!led && led.actor_manager_key === "ai_isa" && String(led.policy_ref ?? "").startsWith("autonomy_tier:ai_isa") && Array.isArray(led.detail?.facts_used) && led.detail.facts_used.length === 2 && led.status === "executed" && led.provider_ref === "SM-unattended-1", JSON.stringify(led ?? {}).slice(0, 300))
    check("the person it was handed to is told exactly what was said for them", h.told.length === 1 && h.told[0].userId === U1 && /We answered for you|answered/i.test(String(h.told[0].title)) && String(h.told[0].body).includes("on track"))
    check("their pending draft is superseded (never a second answer from the draft)", h.db.tables.ai_message_drafts[0].status === "dismissed")
    check("the result carries the provider ref and a delivery window for the completion", r.providerRef === "SM-unattended-1" && !!r.deliveryDueAt && Date.parse(r.deliveryDueAt!) > NOW.getTime())
    const again = await h.run()
    check("a second call for the same completion REPLAYS — nothing sent twice", !again.answered && h.sent.length === 1)
  }
  for (const [label, body, contact] of [
    ["an APPROVAL question", "Can you approve the counter offer?", {}],
    ["a MONEY question", "How much are the closing costs going to be?", {}],
    ["a SIGNATURE question", "Where do I sign?", {}],
    ["a LEGAL question", "Can I back out of the contract?", {}],
  ] as Array<[string, string, Partial<Row>]>) {
    const h = harness(body, contact)
    const r = await h.run()
    check(`${label} is never answered unattended — no model call, nothing sent`, !r.answered && h.composed.length === 0 && h.sent.length === 0, r.reason)
  }
  {
    const held = harness("Any update?", {}, { authority: async () => ({ allowed: false, reason: "ai_isa is approval_required — held" }) })
    const r = await held.run()
    check("outside delegated authority (approval_required / a halt / the ladder) → not answered, nothing sent", !r.answered && held.sent.length === 0 && /approval_required/.test(r.reason))
    const dnc = harness("Any update?", { dnc_status: true }); const rd = await dnc.run()
    check("a do-not-contact person → not answered", !rd.answered && dnc.sent.length === 0)
    const fresh = harness("Any update?", { source: "inbound_sms", created_at: ago(301) }); const rf = await fresh.run()
    check("a texter met in that very message → not answered (identification first)", !rf.answered && fresh.sent.length === 0, rf.reason)
    const decline = harness("Any update?", {}, { compose: async () => ({ object: { topic: "status", answer: "", facts_used: [], hands_back_to_agent: true, refuse: true, refuse_reason: "the facts do not answer it" } }) })
    const rx = await decline.run()
    check("the assistant may decline (refuse=true) → nothing sent", !rx.answered && decline.sent.length === 0 && /declined/.test(rx.reason))
    const dirty = harness("Any update?", {}, { compose: async () => ({ object: { topic: "status", answer: "Your earnest money of $5,000 cleared!", facts_used: [], hands_back_to_agent: false, refuse: false, refuse_reason: null } }) })
    const rz = await dirty.run()
    check("a composed answer naming money is refused by the screen → nothing sent", !rz.answered && dirty.sent.length === 0 && /screen/.test(rz.reason))
    const early = harness("Any update?"); const re = await early.run(comp({ due_at: new Date(NOW.getTime() + 600_000).toISOString() }))
    check("POSITIVE CONTROL: inside the person's window nothing happens", !re.answered && early.sent.length === 0)
    // RE-ASSERTED (wave 149, lane 149C — owner ruling 8: "the AI may answer when a human doesn't, through the arbiter", C24 on every
    // channel the arbiter may use). The 148I waypoint was "email → reminded"; the RULE is "a channel with no unattended send path →
    // the person is reminded". Email and the portal now HAVE a path (the email chokepoint / the portal thread), so email is answered
    // on its own channel, and the rule is proven on a channel that still has none (a social DM).
    const emailed: Array<Record<string, unknown>> = []
    const email = harness("Any update?", {}, { sendEmail: async (p) => { emailed.push(p); return { sent: true, providerRef: "EM-u-1", messageId: "out-e" } } }); email.db.tables.messages[0].metadata = { channel: "email" }; const rm = await email.run(comp({ context: { record_id: "m-1", channel: "email", agent_user_id: U1 } }))
    check("RULING 8: an EMAIL is answered unattended on the email path (never as a text)", rm.answered && emailed.length === 1 && email.sent.length === 0 && rm.channel === "email", rm.reason)
    const dm = harness("Any update?"); dm.db.tables.messages[0].metadata = { channel: "facebook_dm" }; const rdm = await dm.run(comp({ context: { record_id: "m-1", channel: "facebook_dm", agent_user_id: U1 } }))
    check("a channel with no unattended send path (a social DM) → the person is reminded instead (said)", !rdm.answered && dm.sent.length === 0 && /no unattended send path/.test(rdm.reason))
    const posted: Array<Record<string, unknown>> = []
    const portal = harness("Any update?", {}, { postPortal: async (p) => { posted.push(p); return { sent: true, providerRef: null, messageId: "pm-1" } } }); portal.db.tables.messages[0].metadata = { channel: "in_app" }; const rp = await portal.run(comp({ context: { record_id: "m-1", channel: "in_app", agent_user_id: U1 } }))
    check("RULING 8: a PORTAL message is answered in the portal thread (no provider → the row is the evidence, no delivery window)", rp.answered && posted.length === 1 && rp.channel === "in_app" && !rp.providerRef && !rp.deliveryDueAt, rp.reason)
    const keep = harness("Any update?", {}, { decide: async () => ({ optionId: "hold_for_person", channel: null, format: null, waitHours: null, rationale: "This relationship needs the agent's own voice right now.", evidence: ["relationship"], confidence: 0.8 }) }); const rk = await keep.run()
    check("RULING 8: the ARBITER may keep it for a person — nothing composed, nothing sent, the reason said", !rk.answered && keep.composed.length === 0 && keep.sent.length === 0 && /kept this for a person/.test(rk.reason), rk.reason)
    const down = harness("Any update?", {}, { decide: async () => { throw new Error("gateway down") } }); const rdn = await down.run()
    check("POSITIVE CONTROL: with the arbiter's model down the written answer is the fallback (C24 behaviour preserved)", rdn.answered && down.sent.length === 1, rdn.reason)
    const failSend = harness("Any update?", {}, { sendSms: async () => ({ sent: false, error: "TCPA consent missing" }) }); const rs = await failSend.run()
    check("the SMS chokepoint's refusal (consent, quiet hours, suppression) is honoured and named", !rs.answered && /TCPA/.test(rs.reason))
  }

  // ── E ────────────────────────────────────────────────────────────────────────────────────────
  section("E · through the manager supervisor (C14) — event / timer first, cron only recovers")
  const schedule = async () => ({ scheduled: true })
  const engine = { emit: async () => ({ error: null }), propose: async () => ({ id: "proposal-1", error: null }) }
  const openHuman = async (db: ReturnType<typeof world>) => {
    const o = await ct.openCompletion(db as never, { brokerageId: B1, kind: "inbound_response", ownerManager: "ai_isa", subject: { type: "contact", id: C1 }, sourceRef: "inbound:m-1", what: "Answer the sms that arrived", stage: "awaiting_human", expectedEvidence: ["human_action"], dueAt: ago(5), context: { record_id: "m-1", channel: "sms", conversation_id: "conv-x", agent_user_id: U1, draft_id: "d-1", contact_id: C1 } }, { schedule })
    return o.ok ? o.completion.id : ""
  }
  {
    const db = world("Any update on where we are with the house?")
    const id = await openHuman(db)
    const sent: unknown[] = [], told: string[] = []
    const answerers = ua.unattendedAnswerers({ now: NOW, decide: ARB_WRITTEN, facts, authority: async () => ({ allowed: true, reason: null }), safety: () => [], compose: okCompose, sendSms: async (p) => { sent.push(p); return { sent: true, providerRef: "SM-sup-1", messageId: "out-2" } }, notify: async () => {} })
    const sup = await ct.superviseCompletion(db as never, { brokerageId: B1, completionId: id, trigger: "workflow" }, { schedule, engine, notify: async (_s, _c, x) => { told.push(x); return { notified: 1 } }, silentAnswerers: answerers })
    const row = db.tables.manager_completions[0]
    check("the FIRST stall of a reply handed to a person is ANSWERED (verdict remediated, C24)", sup.verdict === "remediated" && sent.length === 1, sup.reason)
    check("…the answer is evidence: the completion now awaits the provider's delivery report on the answer's reference", row.stage === "awaiting_delivery" && row.provider_ref === "SM-sup-1" && row.evidence.some((e: Row) => e.source === "agent_action_ledger:inbound.unattended.answer"))
    check("…stamped as recovered by the durable timer (workflow), and nobody was reminded", row.recovered_by === "workflow" && told.length === 0)
    const pendingTruth = await ct.onProviderTruth(db as never, { brokerageId: B1, providerRef: "SM-sup-1", verdict: "confirmed" }, { schedule })
    check("POSITIVE CONTROL: with no provider truth on file yet, the delivery is still awaited (no clock closes it)", pendingTruth?.verdict !== "closed" && db.tables.manager_completions[0].status !== "closed")
    db.tables.outcome_reconciliations.push({ id: "or-1", brokerage_id: B1, channel: "sms", provider_ref: "SM-sup-1", verdict: "confirmed", provider_status: "delivered", provider_detail: null })
    const delivered = await ct.onProviderTruth(db as never, { brokerageId: B1, providerRef: "SM-sup-1", verdict: "confirmed" }, { schedule })
    check("the provider's delivery report CLOSES the obligation on evidence (the unattended answer reached them)", delivered?.verdict === "closed" && db.tables.manager_completions[0].status === "closed" && db.tables.manager_completions[0].closed_by === "delivery_outcome", `${delivered?.verdict} / ${db.tables.manager_completions[0].status}`)
  }
  {
    const db = world("Can you approve the counter offer?")
    const id = await openHuman(db)
    const told: string[] = [], sent: unknown[] = []
    const sup = await ct.superviseCompletion(db as never, { brokerageId: B1, completionId: id, trigger: "workflow" }, { schedule, engine, notify: async (_s, _c, x) => { told.push(x); return { notified: 1 } }, silentAnswerers: ua.unattendedAnswerers({ now: NOW, decide: ARB_WRITTEN, facts, authority: async () => ({ allowed: true, reason: null }), compose: okCompose, sendSms: async (p) => { sent.push(p); return { sent: true, providerRef: "x" } } }) })
    check("a forbidden topic is NOT answered: the person is reminded, with why the AI did not answer", sent.length === 0 && told.length >= 1 && /did not answer for them/.test(told[0]) && /approval/.test(told[0]), told[0])
    check("…the obligation stays a person's (escalated / stalled), never closed", ["escalated", "stalled"].includes(db.tables.manager_completions[0].status), `${sup.verdict} / ${db.tables.manager_completions[0].status}`)
  }
  {
    const db = world("Any update?")
    const id = await openHuman(db)
    db.tables.manager_completions[0].attempts = 1
    const sent: unknown[] = []
    await ct.superviseCompletion(db as never, { brokerageId: B1, completionId: id, trigger: "cron" }, { schedule, engine, notify: async () => ({ notified: 1 }), silentAnswerers: ua.unattendedAnswerers({ now: NOW, decide: ARB_WRITTEN, facts, authority: async () => ({ allowed: true, reason: null }), compose: okCompose, sendSms: async (p) => { sent.push(p); return { sent: true, providerRef: "x" } } }) })
    check("a SECOND stall never answers (the first stall is the AI's one turn; then the admins)", sent.length === 0)
  }
  {
    const db = world("Any update?")
    const id = await openHuman(db)
    const told: string[] = []
    const sup = await ct.superviseCompletion(db as never, { brokerageId: B1, completionId: id, trigger: "workflow" }, { schedule, engine, notify: async (_s, _c, x) => { told.push(x); return { notified: 1 } } })
    check("POSITIVE CONTROL: with NO answerer handed in, the 147G behaviour stands (a person is reminded)", told.length >= 1 && sup.verdict !== "remediated")
  }
  {
    const db = world("When do we close?")
    const id = await openHuman(db)
    const sent: unknown[] = []
    const r = await ct.reconcileOpenCompletions(db as never, B1, { now: NOW }, { schedule, engine, notify: async () => ({ notified: 1 }), silentAnswerers: ua.unattendedAnswerers({ now: NOW, decide: ARB_WRITTEN, facts, authority: async () => ({ allowed: true, reason: null }), safety: () => [], compose: okCompose, sendSms: async (p) => { sent.push(p); return { sent: true, providerRef: "SM-cron-1" } }, notify: async () => {} }) })
    const row = db.tables.manager_completions.find((x) => x.id === id)
    check("the cron NET recovers what the timer missed with the SAME answerer — stamped recovered_by = cron", r.recovered === 1 && sent.length === 1 && row?.recovered_by === "cron", JSON.stringify(r))
  }

  // ── F ────────────────────────────────────────────────────────────────────────────────────────
  section("F · wiring (stripped source)")
  const wf = code("workflows/completion-watch-workflow.ts"), cron = code("app/api/cron/manager-signals/route.ts")
  check("the durable timer hands the answerer in (silentAnswerers: unattendedAnswerers())", /silentAnswerers:\s*unattendedAnswerers\(\)/.test(wf))
  check("the cron net hands the SAME answerer in", /silentAnswerers:\s*unattendedAnswerers\(\)/.test(cron))
  {
    const IMPORTS_ANSWERER = /import\(\s*["'][^"']*unattended-answer["']|from\s+["'][^"']*unattended-answer["']/
    check("POSITIVE CONTROL: the import finder sees a dynamic and a static import of the answerer", IMPORTS_ANSWERER.test(`await import("@/lib/communications/unattended-answer")`) && IMPORTS_ANSWERER.test(`import { x } from "./unattended-answer"`))
    check("the supervisor never imports the answerer (the chain knows the supervisor, never the reverse)", !IMPORTS_ANSWERER.test(code("lib/kernel/completion-tracking.ts")))
  }
  const SECTIONS = ["ROLE —", "BUSINESS CONTEXT —", "FACTS YOU MAY RELY ON —", "WHAT YOU MUST NOT INVENT —", "THE DECISION YOU OWN —", "OUTPUT CONTRACT —", "COMPLIANCE BOUNDARY —", "ESCALATION RULE —", "VOICE —"]
  check("the brief is an expert, structured prompt (every section, a typed JSON contract, money / approval / legal excluded)", SECTIONS.every((s) => ua.UNATTENDED_ANSWER_SYSTEM.includes(s)) && /JSON/.test(ua.UNATTENDED_ANSWER_SYSTEM) && /money/.test(ua.UNATTENDED_ANSWER_SYSTEM) && /approve/.test(ua.UNATTENDED_ANSWER_SYSTEM))
  const src = code("lib/communications/unattended-answer.ts")
  check("the delegated authority is the gate's own verdict (autonomyDecision over posture + ladder + halts)", /autonomyDecision\(\{\s*managerKey:\s*"ai_isa"/.test(src) && /resolveAgentAuthorityLevel\(/.test(src))
  {
    // 149Z (lane 149G Outside-lane 1, C33): the facts read the CONTRACTUAL closing (m927) — not the legacy close_date alone.
    const sel = /from\("transactions"\)\s*\.select\("([^"]+)"\)/.exec(src)?.[1] ?? ""
    check("the verified facts read the m927 contractual closing columns (contract_closing_date / _terms / actual_close_date) and no money column",
      ["contract_closing_date", "contract_closing_terms", "actual_close_date"].every((c) => sel.split(/\s*,\s*/).includes(c)) && !/price|commission|amount/.test(sel), sel)
    check("an 'on or before' contract is a PERMISSION fact (earlierClosing.allowed), never a promised earlier day",
      /dates\.earlierClosing\?\.allowed === true/.test(src) && /no earlier day has been set/.test(raw("lib/communications/unattended-answer.ts")))
  }
  check("the send goes through the ONE SMS chokepoint (inbound-reply-executors sendInboundSmsReply → dispatchSms)", /sendInboundSmsReply\(/.test(src) && /dispatchSms\(/.test(code("lib/communications/inbound-reply-executors.ts")))
  check("the 147G boundary is re-stated as ruling 16's (answers within authority; never approval / signature / money / legal)", /never approval, a signature, money or a legal question/.test(ct.COMPLETION_DETECTIONS.incomplete_follow_up.humanBoundary) && /C24/.test(ct.COMPLETION_DETECTIONS.incomplete_follow_up.withinAuthority))
  {
    const walk = (d: string, out: string[] = []): string[] => { for (const e of readdirSync(join(process.cwd(), d))) { const rel = `${d}/${e}`; if (statSync(join(process.cwd(), rel)).isDirectory()) walk(rel, out); else if (/\.tsx$/.test(e)) out.push(rel) } return out }
    const pages = walk("app").filter((f) => /unattended-answer/.test(code(f)))
    check("no page / client component imports the answerer (route + workflow only)", pages.length === 0, pages.join(", "))
  }

  console.log("\n BLIND SPOTS: the model is stubbed (the live brief's quality is the prompt's own text, asserted by section; ai_tool_usage booking is generateObjectRouted's); dispatchSms's gates (TCPA, suppression, quiet hours, budget) are a seam here — their own proofs (test:egress-send-guard, test:autonomy-gate) prove them; the verified-facts loader is injected in D/E (its query is read from source, and it never selects a money column); the Vercel Workflow runtime is not executed (the timer step is read from source); a live soak (one stalled text → one unattended answer) is still owed.")
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(`\n ❌ UNATTENDED_ANSWER_FAIL — ${failures.join(" | ")}`); process.exit(1) }
  console.log("\n ✅ UNATTENDED_ANSWER_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
