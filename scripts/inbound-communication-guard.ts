/**
 * scripts/inbound-communication-guard.ts — test:inbound-communication (wave 146, lane 146B).
 *
 * THE RULINGS (owner, 2026-10-29), proved end to end on an in-memory database (no network, no keys):
 *   3  — "communication should be able to track both incoming and outgoing no matter which channel is used": every
 *        inbound → ONE canonical record (contract C1, lib/communications/inbound-record.ts recordInboundCommunication),
 *        matched to tenant + person + conversation, deduplicated on (provider, provider reference) → interpretation →
 *        the arbiter → a governed action → evidence. A retry does NOTHING twice.
 *   2  — "Arbiter needs to consider and send social responses back and also should do 1:1 ad follow up with audiences":
 *        comments / DMs / mentions reach the arbiter (lib/social/inbound-social.ts → lib/ai-isa/followup-arbiter.ts
 *        respondToInboundCommunication); a reply goes out ONLY within explicit autonomy on a private DM with a clean screen,
 *        otherwise a PERSON approves (a public reply always); an ad interaction may ask contract C2 for a 1:1 follow-up.
 *   7  — "platforms prospect funnel should be arbitrated": arbitrateProspectFollowup inside the deterministic ladder.
 *   10 — "deliverables that were promised from the lead magnet are delivered": respondToPromisedDeliverable — a
 *        high-priority moment (never a wait), delivered only through contract C4's deliverer, idempotent per day.
 *
 *   A · the record (C1)      B · the chain           C · the arbiter's inbound responder
 *   D · promised deliverable  E · platform prospects  F · social normalizers   G · social ingestion   H · wiring
 *
 * Every refusal has a POSITIVE CONTROL (CLAUDE.md §2); wiring is read from STRIPPED source. Blind spots are printed.
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
const C2 = "c2c2c2c2-0000-4000-8000-000000000002"
const CB2 = "cb2cb2cb-0000-4000-8000-000000000003"
const A1 = "a1a1a1a1-0000-4000-8000-000000000001"
const U1 = "u1u1u1u1-0000-4000-8000-000000000001"
const L1 = "l1l1l1l1-0000-4000-8000-000000000001"
const L2 = "l2l2l2l2-0000-4000-8000-000000000002"
const P1 = "p1p1p1p1-0000-4000-8000-000000000001"
const NOW = new Date("2026-10-29T15:00:00.000Z")

const MSG_UNIQUE = { messages: [["brokerage_id", "metadata->>provider", "metadata->>provider_ref"]], lead_conversation_history: [["lead_id", "metadata->>provider_ref"]], agent_action_ledger: [["idempotency_key"]] }

function world(extra: Record<string, Row[]> = {}, opts: Parameters<typeof memSupabase>[1] = {}) {
  return memSupabase({
    contacts: [
      { id: C1, brokerage_id: B1, agent_id: A1, first_name: "Dana", metadata: { facebook_psid: "psid-1" }, has_login: true, dnc_status: false, ai_outreach_paused: false },
      { id: C2, brokerage_id: B1, agent_id: A1, first_name: "Sam", metadata: {}, has_login: false, dnc_status: true },
      { id: CB2, brokerage_id: B2, agent_id: null, first_name: "Other", metadata: {} },
    ],
    agents: [{ id: A1, brokerage_id: B1, user_id: U1, is_active: true, created_at: "2026-01-01T00:00:00Z" }],
    leads: [{ id: L1, brokerage_id: B1, contact_id: null, email: "lead@example.com" }, { id: L2, brokerage_id: B1, contact_id: C1, email: "dana@example.com" }],
    conversations: [], messages: [], lead_conversation_history: [], agent_action_ledger: [],
    platform_prospects: [{ id: P1, status: "contacted", details: { qualification: { seats: 4 } } }],
    social_media_accounts: [],
    ...extra,
  }, { uuidIds: true, stampCreatedAt: true, unique: MSG_UNIQUE, ...opts })
}

/** A client whose FIRST duplicate read is blind (returns nothing) — the concurrent-delivery race the m876 index answers. */
function blindFirstDedup(db: ReturnType<typeof memSupabase>) {
  let blinded = false
  return {
    from(t: string) {
      const b: any = db.from(t)
      if (t !== "messages" || blinded) return b
      const sel = b.select.bind(b)
      b.select = (c?: string) => { const q = sel(c); if (c === "id, conversation_id") { blinded = true; q.maybeSingle = async () => ({ data: null, error: null }) } return q }
      return b
    },
  }
}

async function main() {
  const rec = await import("../lib/communications/inbound-record")
  const arb = await import("../lib/ai-isa/followup-arbiter")
  const responder = await import("../lib/communications/inbound-responder")
  const social = await import("../lib/social/inbound-social")
  const { DEFAULT_FOLLOWUP_POLICY } = await import("../lib/ai-isa/followup-policy")

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("A · the record (contract C1) — one row per (provider, provider ref), tenant-pinned, never a fabricated person")
  {
    const db = world()
    const base = { brokerageId: B1, channel: "email" as const, provider: "sendgrid", providerRef: "<msg-1@mail>", party: { kind: "contact" as const, id: C1 }, body: "Is the house on Elm still available?", subject: "Re: Elm", receivedAt: NOW }
    const r1 = await rec.recordInboundCommunication(base, { client: db as never })
    const m = db.tables.messages[0]
    check("a contact's email lands as ONE messages row on the contact's conversation (direction inbound, status unread, provider + provider_ref on the metadata)",
      r1.recorded && !r1.duplicate && r1.store === "messages" && db.tables.messages.length === 1 && m.direction === "inbound" && m.status === "unread" && m.contact_id === C1 && m.brokerage_id === B1 && m.metadata.provider === "sendgrid" && m.metadata.provider_ref === "<msg-1@mail>" && m.conversation_id === r1.conversationId, JSON.stringify(r1))
    check("the conversation is THE one resolver's (keep-one) — created for the contact's agent, its unread counter moved once",
      db.tables.conversations.length === 1 && db.tables.conversations[0].contact_id === C1 && db.tables.conversations[0].agent_id === A1 && db.tables.conversations[0].unread_count === 1)
    const r2 = await rec.recordInboundCommunication(base, { client: db as never })
    check("a provider RETRY is a duplicate: no second row, the first record's id returned, the counters untouched",
      !r2.recorded && r2.duplicate && r2.recordId === r1.recordId && db.tables.messages.length === 1 && db.tables.conversations[0].unread_count === 1)
    const r3 = await rec.recordInboundCommunication({ ...base, providerRef: "<msg-2@mail>", body: "Also — can we see it Saturday?" }, { client: db as never })
    check("POSITIVE CONTROL: a NEW provider ref is a new record on the SAME thread", r3.recorded && db.tables.messages.length === 2 && r3.conversationId === r1.conversationId)

    // the race m876 answers
    const dbr = world()
    await rec.recordInboundCommunication(base, { client: dbr as never })
    const race = await rec.recordInboundCommunication(base, { client: blindFirstDedup(dbr) as never })
    check("RACE: two concurrent deliveries (the duplicate read missed) — the unique index (m876, modelled) refuses the second; it is reported a duplicate, never a second row",
      race.duplicate && !race.recorded && dbr.tables.messages.length === 1, JSON.stringify(race))

    // derived refs
    const dbd = world()
    const d1 = await rec.recordInboundCommunication({ ...base, providerRef: null }, { client: dbd as never })
    const d2 = await rec.recordInboundCommunication({ ...base, providerRef: null }, { client: dbd as never })
    const d3 = await rec.recordInboundCommunication({ ...base, providerRef: null, body: "a different sentence" }, { client: dbd as never })
    check("no provider ref → a DERIVED, stable one (said on the record); an exact replay dedupes; a different body is a new record",
      d1.recorded && d1.providerRefDerived && /^derived:/.test(d1.providerRef ?? "") && dbd.tables.messages[0].metadata.provider_ref_derived === true && d2.duplicate && d3.recorded && dbd.tables.messages.length === 2)

    // tenancy
    const dbt = world()
    const foreign = await rec.recordInboundCommunication({ ...base, brokerageId: B2 }, { client: dbt as never })
    check("TENANCY: a contact of another brokerage is REFUSED (never re-homed) — nothing written", !foreign.recorded && /not in this brokerage/.test(foreign.error ?? "") && dbt.tables.messages.length === 0)
    const conv2 = { id: "conv-b2", brokerage_id: B2, contact_id: CB2, agent_id: A1 }
    const dbc = world({ conversations: [conv2, { id: "conv-c2", brokerage_id: B1, contact_id: C2, agent_id: A1 }, { id: "conv-pub", brokerage_id: B1, contact_id: null, agent_id: A1, type: "social_comment" }] })
    const wrongThread = await rec.recordInboundCommunication({ ...base, conversationId: "conv-b2" }, { client: dbc as never })
    check("a thread from ANOTHER tenant is refused", !wrongThread.recorded && /conversation not in this brokerage/.test(wrongThread.error ?? ""))
    const otherPerson = await rec.recordInboundCommunication({ ...base, conversationId: "conv-c2" }, { client: dbc as never })
    check("a thread that belongs to ANOTHER person is refused (one person per thread)", !otherPerson.recorded && /another person/.test(otherPerson.error ?? ""))
    const anon = await rec.recordInboundCommunication({ brokerageId: B1, channel: "social_comment", provider: "meta", providerRef: "cmt-9", party: null, conversationId: "conv-pub", body: "Love this kitchen!", surface: "facebook" }, { client: dbc as never })
    const anonRow = dbc.tables.messages.find((x) => x.id === anon.recordId)
    check("an UNIDENTIFIED public commenter is recorded on the door's thread with no person (sender external) — never fabricated into a contact or a lead",
      anon.recorded && anonRow?.contact_id === null && anonRow?.sender_type === "external" && anonRow?.metadata.public === true && dbc.tables.contacts.length === 3 && dbc.tables.leads.length === 2)
    const noThread = await rec.recordInboundCommunication({ brokerageId: B1, channel: "social_comment", provider: "meta", providerRef: "cmt-10", party: null, body: "hi" }, { client: dbc as never })
    check("…and with no thread to land on, it is refused (no person is invented to hold it)", !noThread.recorded && /unidentified sender needs the door's thread/.test(noThread.error ?? "") && dbc.tables.contacts.length === 3)
    const untenanted = await rec.recordInboundCommunication({ ...base, brokerageId: null }, { client: dbc as never })
    const both = await rec.recordInboundCommunication({ ...base, platform: true }, { client: dbc as never })
    const prospectInTenant = await rec.recordInboundCommunication({ ...base, party: { kind: "platform_prospect", id: P1 } }, { client: dbc as never })
    check("SCOPE: no verified tenant / tenant AND platform / a platform prospect inside a tenant — each refused", /untenanted/.test(untenanted.error ?? "") && /never both/.test(both.error ?? "") && /never recorded inside a tenant/.test(prospectInTenant.error ?? ""))
    const dbx = world({}, { refuse: { contacts: "permission denied for table contacts" }, uuidIds: true, stampCreatedAt: true, unique: MSG_UNIQUE })
    const refused = await rec.recordInboundCommunication(base, { client: dbx as never })
    check("FAIL CLOSED: a refused person read is a refusal with its reason — nothing written", !refused.recorded && /contact read refused/.test(refused.error ?? "") && dbx.tables.messages.length === 0)

    // leads + conversion + platform
    const dbl = world()
    const lr = await rec.recordInboundCommunication({ brokerageId: B1, channel: "social_dm", provider: "linkedin", providerRef: "li-1", party: { kind: "lead", id: L1 }, body: "Interested in selling" }, { client: dbl as never })
    const lr2 = await rec.recordInboundCommunication({ brokerageId: B1, channel: "social_dm", provider: "linkedin", providerRef: "li-1", party: { kind: "lead", id: L1 }, body: "Interested in selling" }, { client: dbl as never })
    check("a LEAD lands on lead_conversation_history (provider_ref keyed — m488's unique index, modelled) and a retry is a duplicate",
      lr.recorded && lr.store === "lead_conversation_history" && dbl.tables.lead_conversation_history.length === 1 && dbl.tables.lead_conversation_history[0].metadata.provider_ref === "li-1" && lr2.duplicate && dbl.tables.lead_conversation_history.length === 1)
    const conv = await rec.recordInboundCommunication({ brokerageId: B1, channel: "email", provider: "sendgrid", providerRef: "m-conv", party: { kind: "lead", id: L2 }, body: "Thanks!" }, { client: dbl as never })
    check("CONVERSION IS FINAL (C2): a converted lead's inbound is recorded on its CONTACT", conv.recorded && conv.party?.kind === "contact" && conv.party.id === C1 && conv.store === "messages")
    const pr = await rec.recordInboundCommunication({ platform: true, channel: "email", provider: "sendgrid", providerRef: "pp-1", party: { kind: "platform_prospect", id: P1 }, body: "Can we do a demo next week?", receivedAt: NOW }, { client: dbl as never })
    const pr2 = await rec.recordInboundCommunication({ platform: true, channel: "email", provider: "sendgrid", providerRef: "pp-1", party: { kind: "platform_prospect", id: P1 }, body: "Can we do a demo next week?", receivedAt: NOW }, { client: dbl as never })
    const details = dbl.tables.platform_prospects[0].details
    check("a PLATFORM PROSPECT's reply lands on its own record (details.inbound + last_inbound_at), other facts kept; a retry is a duplicate",
      pr.recorded && pr.store === "platform_prospects" && Array.isArray(details.inbound) && details.inbound.length === 1 && details.last_inbound_at === NOW.toISOString() && details.qualification?.seats === 4 && pr2.duplicate)
    const dbtw = world()
    const tw = await rec.recordInboundCommunication({ ...base, provider: "twilio", channel: "sms", providerRef: "SM123" }, { client: dbtw as never })
    const twRow = dbtw.tables.messages[0]
    check("a Twilio inbound carries message_sid beside provider_ref (the SMS recorder's own key — one key, two spellings read), type sms",
      tw.recorded && twRow?.metadata.message_sid === "SM123" && twRow?.metadata.provider_ref === "SM123" && twRow?.type === "sms")
    check("POSITIVE CONTROL: a non-Twilio inbound carries no message_sid", db.tables.messages[0].metadata.message_sid === undefined)
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("B · the chain — record → opt-out → sequence stop → event → intent → arbiter, ONCE per new record")
  {
    const calls = { optOut: 0, optOutSources: [] as string[], stop: 0, emit: [] as string[], classify: 0, respond: [] as Array<Record<string, unknown>>, lead: 0, promise: [] as Array<Record<string, unknown>>, order: [] as string[] }
    const deps = (db: unknown) => ({
      client: db as never,
      optOut: async (p: { source: string }) => { calls.optOut++; calls.optOutSources.push(p.source); return { success: true } },
      stopSequences: async () => { calls.stop++; return { unenrolled: 2 } },
      emit: async (e: Record<string, unknown>) => { calls.emit.push(String(e.event)) },
      classify: async () => { calls.classify++; return { primary: "schedule_showing", confidence: 88, urgency: "medium" } },
      // seams typed `any` on the parameter: the chain hands the responder / promise seam its own request interfaces (no index
      // signature), which a Record<string, unknown> parameter refuses at the type level (wave 146, 146Z — tsc only).
      respond: async (p: any) => { calls.order.push("respond"); calls.respond.push(p as Record<string, unknown>); return { action: "reply_proposed", reason: "ok" } },
      leadDoor: async () => { calls.lead++; return { outcome: "nurtured" } },
      promise: async (p: any) => { calls.order.push("promise"); calls.promise.push(p as Record<string, unknown>); return { action: "delivered", reason: "the guide went out" } },
    })
    const reset = () => { calls.optOut = 0; calls.optOutSources.length = 0; calls.stop = 0; calls.emit.length = 0; calls.classify = 0; calls.respond.length = 0; calls.lead = 0; calls.promise.length = 0; calls.order.length = 0 }
    const db = world()
    const dm = { brokerageId: B1, channel: "social_dm" as const, provider: "meta", providerRef: "mid.1", party: { kind: "contact" as const, id: C1 }, body: "Can I see it Saturday?", surface: "facebook", threadRef: { page_id: "page-1", sender_id: "psid-1" } }
    const p1 = await rec.processInboundCommunication(dm, deps(db))
    check("a NEW private DM: sequence stop once, MESSAGE_FROM_CONTACT + the stop event, intent classified, the arbiter asked once WITH the intent",
      p1.record.recorded && calls.stop === 1 && calls.emit.join(",") === "message_from_contact,sequence_paused_on_reply" && calls.classify === 1 && calls.respond.length === 1 && (calls.respond[0].intent as { primary: string }).primary === "schedule_showing" && calls.optOut === 0, JSON.stringify(calls))
    check("RULING 10 in the chain: a person who writes in is FIRST answered on what they are owed (the promise moment for THIS contact of THIS tenant), then the responder",
      calls.promise.length === 1 && calls.promise[0].contactId === C1 && calls.promise[0].brokerageId === B1 && calls.order.join(",") === "promise,respond" && p1.promise?.action === "delivered", calls.order.join(","))
    reset()
    const p2 = await rec.processInboundCommunication(dm, deps(db))
    check("the RETRY does nothing downstream — no opt-out write, no stop, no event, no model call, no promise moment, no response", p2.record.duplicate && calls.stop === 0 && calls.emit.length === 0 && calls.classify === 0 && calls.respond.length === 0 && calls.promise.length === 0)
    reset()
    const stop = await rec.processInboundCommunication({ ...dm, providerRef: "mid.stop", body: "STOP" }, deps(db))
    check("a high-confidence STOP is honoured first (processOptOut's webhook provenance) and NOTHING answers it — not even an owed delivery", calls.optOut === 1 && calls.respond.length === 0 && calls.promise.length === 0 && stop.response?.action === "no_response")
    // Wave 146 (146Z): a social DM's STOP carries its own provenance, never an SMS label.
    check("a social DM's STOP is written with 'inbound_social' provenance (lib/ai-isa/opt-out-writer.ts — not 'inbound_sms')", calls.optOutSources.join(",") === "inbound_social", calls.optOutSources.join(","))
    reset()
    const refusedOpt = await rec.processInboundCommunication({ ...dm, providerRef: "mid.stop2", body: "STOP" }, { ...deps(db), optOut: async () => ({ success: false, error: "refused" }) })
    check("FAIL CLOSED: an opt-out that could not be written is still not answered — and the blind spot says so", refusedOpt.response?.action === "no_response" && refusedOpt.blindSpots.some((b) => /NOT applied/.test(b)) && calls.respond.length === 0)
    reset()
    const pub = await rec.processInboundCommunication({ brokerageId: B1, channel: "social_comment", provider: "meta", providerRef: "cmt-1", party: { kind: "contact", id: C1 }, body: "STOP posting this", surface: "facebook" }, deps(db))
    check("a PUBLIC comment: no opt-out write and no sequence stop (a comment is not a private reply), no private-intent model call — the arbiter still hears it (isPublic)",
      pub.record.recorded && calls.optOut === 0 && calls.stop === 0 && calls.classify === 0 && calls.respond.length === 1 && calls.respond[0].isPublic === true)
    reset()
    const lead = await rec.processInboundCommunication({ brokerageId: B1, channel: "email", provider: "sendgrid", providerRef: "lead-m-1", party: { kind: "lead", id: L1 }, body: "yes please send it" }, deps(db))
    check("a LEAD's email goes to THE lead door (it records on the same table + key and interprets) — never recorded twice, never the contact arbiter", calls.lead === 1 && calls.respond.length === 0 && lead.record.store === "lead_conversation_history" && lead.lead?.outcome === "nurtured" && db.tables.lead_conversation_history.length === 0 && calls.promise.length === 0)
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("C · the arbiter's inbound responder — locks, a closed menu, autonomy only when explicit, evidence once")
  {
    const policy = DEFAULT_FOLLOWUP_POLICY
    const req = (over: Record<string, unknown> = {}) => ({ brokerageId: B1, contactId: C1, conversationId: "conv-1", recordId: "rec-1", channel: "social_dm", provider: "meta", surface: "facebook", body: "Can I see it Saturday?", isPublic: false, threadRef: { page_id: "page-1", sender_id: "psid-1", account_id: "page-1", author_id: "psid-1" }, intent: { primary: "schedule_showing", confidence: 85, urgency: "medium" }, receivedAt: NOW.toISOString(), ...over }) as never
    const mk = () => {
      const c = { decide: 0, prompts: [] as string[], send: [] as Array<Record<string, unknown>>, propose: [] as Array<Record<string, unknown>>, route: 0, reengage: [] as Array<Record<string, unknown>>, coach: [] as Array<Record<string, unknown>>, c360: [] as unknown[][] }
      const deps = (o: Record<string, unknown> = {}) => ({
        policy, now: NOW,
        // contract C6's door, in lane 146D's documented shape: customer360For(svc, brokerageId, { type, id }, { slices }) → { ok, view: { fields } }
        customer360For: async (...a: unknown[]) => { c.c360.push(a.slice(1)); if (o.c360Refused) return { ok: false, reason: "contact read refused" }; return { ok: true, view: { fields: (o.c360Fields as Record<string, unknown>) ?? {} } } },
        decide: async (a: { prompt: string }) => { c.decide++; c.prompts.push(a.prompt); return (o.reply as Record<string, unknown>) ?? { optionId: "reply", channel: "social", format: null, waitHours: null, rationale: "They asked a direct question about a showing.", evidence: ["moment", "intent"], confidence: 0.9 } },
        autonomy: async () => (o.autonomy as { allowed: boolean; reason: string | null }) ?? { allowed: true, reason: null },
        compose: async () => ({ text: (o.text as string) ?? "Saturday works — what time suits you?" }),
        send: async (p: Record<string, unknown>) => { c.send.push(p); return { sent: true, providerMessageId: "m-out" } },
        propose: async (p: Record<string, unknown>) => { c.propose.push(p); return { proposed: true } },
        routeToAgent: (async () => { c.route++; return true }) as never,
        reengage: async (p: Record<string, unknown>) => { c.reengage.push(p); return { ok: true } },
        replyCoach: async (p: Record<string, unknown>) => { c.coach.push(p); return { success: true } },
      })
      return { c, deps }
    }
    const conv = { id: "conv-1", brokerage_id: B1, contact_id: C1, agent_id: A1 }

    { const { c, deps } = mk(); const db = world({ conversations: [conv] })
      const r = await responder.respondToInboundCommunication(db, req(), deps())
      check("a private DM + an EXPLICIT autonomy grant + a clean screen → the reply is SENT through the tenant's account (page / sender ids from the thread)", r.action === "reply_sent" && c.send.length === 1 && c.send[0].accountId === "page-1" && c.send[0].recipientId === "psid-1" && c.propose.length === 0, JSON.stringify(r))
      check("the model was asked ONCE over a CLOSED menu (reply / notify_human — no wait) at the inbound moment", c.decide === 1 && /"id":"reply"/.test(c.prompts[0]) && /"id":"notify_human"/.test(c.prompts[0]) && !/"id":"wait"/.test(c.prompts[0]) && /inbound_social_dm/.test(c.prompts[0]))
      check("EVIDENCE: one agent_action_ledger row (inbound.message.respond, CONVERSATION_RESPONSE, the autonomy policy key) — executed", db.tables.agent_action_ledger.length === 1 && db.tables.agent_action_ledger[0].action === "inbound.message.respond" && db.tables.agent_action_ledger[0].reason_code === "CONVERSATION_RESPONSE" && db.tables.agent_action_ledger[0].status === "executed", JSON.stringify(db.tables.agent_action_ledger[0] ?? {}))
      const again = await responder.respondToInboundCommunication(db, req(), deps())
      check("IDEMPOTENT: the same inbound again REPLAYS — no second send", again.action === "replayed" && c.send.length === 1)
    }
    { const { c, deps } = mk(); const r = await responder.respondToInboundCommunication(world({ conversations: [conv] }), req(), deps({ autonomy: { allowed: false, reason: "the tenant has not granted the AI ISA autonomous replies" } }))
      check("NO explicit grant → the reply is PROPOSED to a person (the drafted text rides the card), never sent", r.action === "reply_proposed" && c.send.length === 0 && c.propose.length === 1 && c.propose[0].proposedText === "Saturday works — what time suits you?") }
    { const { c, deps } = mk(); const r = await responder.respondToInboundCommunication(world({ conversations: [conv] }), req({ channel: "social_comment", isPublic: true }), deps())
      check("a PUBLIC comment is never auto-posted, even with autonomy granted — a person approves (isPublic on the card)", r.action === "reply_proposed" && c.send.length === 0 && c.propose[0]?.isPublic === true) }
    { const { c, deps } = mk(); const r = await responder.respondToInboundCommunication(world({ conversations: [conv] }), req(), deps({ text: "This neighborhood is perfect for families with no kids around." }))
      check("a drafted reply that FAILS the content-safety screen is not sent — proposed at high priority with the findings", r.action === "reply_proposed" && c.send.length === 0 && c.propose[0]?.priority === "high" && (c.propose[0]?.safety as string[]).length > 0, JSON.stringify(c.propose[0]?.safety)) }
    { const { c, deps } = mk(); const r = await responder.respondToInboundCommunication(world({ conversations: [conv] }), req({ body: "I am calling my attorney about this listing." }), deps())
      check("LOCK: legal / complaint words → a PERSON (the agent's task), the model never asked, nothing sent", r.action === "human_task" && c.route === 1 && c.decide === 0 && c.send.length === 0) }
    { const { c, deps } = mk(); const r = await responder.respondToInboundCommunication(world({ conversations: [conv] }), req({ intent: { primary: "unsubscribe", confidence: 80, urgency: "high" } }), deps())
      check("LOCK: an unsubscribe intent → NO automated answer (nothing proposed, nothing sent, the model never asked)", r.action === "no_response" && c.decide === 0 && c.send.length === 0 && c.propose.length === 0) }
    { const { c, deps } = mk(); const r = await responder.respondToInboundCommunication(world({ conversations: [{ ...conv, contact_id: C2 }] }), req({ contactId: C2 }), deps())
      check("LOCK: a do-not-contact person who wrote in → a person decides (task), never an automated reply", r.action === "human_task" && c.decide === 0 && c.send.length === 0) }
    { const { c, deps } = mk(); const r = await responder.respondToInboundCommunication(world({ conversations: [conv] }), req({ channel: "ad_interaction", isPublic: true, threadRef: { account_id: "ig-1", author_id: "igu-1", ad_id: "AD-77" } }), deps({ reply: { optionId: "audience_reengagement", channel: "ads", format: null, waitHours: null, rationale: "They engaged with the open-house ad; a 1:1 follow-up fits.", evidence: ["moment"], confidence: 0.8 } }))
      check("an AD interaction from an identity-matched contact may ask contract C2 for a 1:1 follow-up (partyIds = the contact, basis = the first-party ACTION inbound_ad_response — a REENGAGEMENT_BASES value — the ad named in the hint)", r.action === "audience_reengagement" && c.reengage.length === 1 && (c.reengage[0].partyIds as string[])[0] === C1 && c.reengage[0].basis === "inbound_ad_response" && /AD-77/.test(String(c.reengage[0].creativeHint)) && /"id":"audience_reengagement"/.test(c.prompts[0]), JSON.stringify(c.reengage[0] ?? {})) }
    { const { c, deps } = mk(); await responder.respondToInboundCommunication(world({ conversations: [{ ...conv, contact_id: null }] }), req({ contactId: null, channel: "ad_interaction", isPublic: true, threadRef: { ad_id: "AD-77" } }), deps())
      check("POSITIVE CONTROL: with no identity match the re-engagement option is NOT on the menu (no audience is built from an unknown commenter)", !/"id":"audience_reengagement"/.test(c.prompts[0] ?? "") && c.reengage.length === 0) }
    { const { c, deps } = mk()
      const fields = { "preferences.preferred_channel": { value: "sms" }, "preferences.preferred_language": { value: "Spanish" }, "preferences.time_zone": { value: "America/Chicago" }, "identity.date_of_birth": { value: "1970-01-01" }, "enrichment.estimated_income": { value: 185000 } }
      await responder.respondToInboundCommunication(world({ conversations: [conv] }), req(), deps({ c360Fields: fields }))
      const asked = c.c360[0] as [string, { type: string; id: string }, { slices: string[] }] | undefined
      check("CONTRACT C6: Customer 360 is asked for ONE contact's preferences slice (brokerage, { type: contact, id }, slices = [preferences])", !!asked && asked[0] === B1 && asked[1].type === "contact" && asked[1].id === C1 && JSON.stringify(asked[2].slices) === '["preferences"]', JSON.stringify(asked ?? null))
      check("CONTRACT C6: only the mapped preference facts reach the model (channel_preference sms, language Spanish)", /"key":"channel_preference","value":"sms"/.test(c.prompts[0] ?? "") && /"key":"language","value":"Spanish"/.test(c.prompts[0] ?? ""), (c.prompts[0] ?? "").slice(0, 400))
      check("CONTRACT C6 (positive control): a date of birth, an income and an unmapped field present on the view NEVER reach the prompt", !/1970-01-01|185000|America\/Chicago|estimated_income|date_of_birth/.test(c.prompts[0] ?? "")) }
    { const { c, deps } = mk(); await responder.respondToInboundCommunication(world({ conversations: [conv] }), req(), deps({ c360Refused: true }))
      check("CONTRACT C6 refused → named as a BLIND SPOT to the model, never read as \"no preferences\"", /customer 360 not read \(Customer 360 refused \(contact read refused\)\)/.test(c.prompts[0] ?? ""), (c.prompts[0] ?? "").slice(0, 300)) }
    { const { c, deps } = mk(); await responder.respondToInboundCommunication(world({ conversations: [conv] }), req({ channel: "social_comment", isPublic: true }), deps())
      check("a PUBLIC comment never pulls the person's Customer 360 into the drafting context", c.c360.length === 0) }
    { const { c, deps } = mk(); const r = await responder.respondToInboundCommunication(world({ conversations: [conv] }), req({ channel: "email", surface: "sendgrid", body: "What are next steps?" }), deps())
      check("an EMAIL reply rides the existing reply-coach rail (a draft the agent sends) for the thread's agent USER (agents.id → users.id)", r.action === "reply_proposed" && c.coach.length === 1 && c.coach[0].agentUserId === U1 && c.coach[0].channel === "email" && c.send.length === 0) }
    { const { c, deps } = mk(); const r = await responder.respondToInboundCommunication(world({ conversations: [conv] }), req(), deps({ reply: { optionId: "wait", channel: null, format: null, waitHours: 5, rationale: "Let them come back later.", evidence: ["moment"], confidence: 0.9 } }))
      check("a model reply OFF the menu (wait) is refused → the planned default (propose / send within authority) stands — never silence", r.action === "reply_sent" && r.decision?.source === "deterministic" && c.send.length === 1) }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("D · ruling 10 — a promised deliverable is a high-priority moment (contract C4), never a wait, never twice")
  {
    const policy = DEFAULT_FOLLOWUP_POLICY
    const mk = (o: Record<string, unknown> = {}) => {
      const c = { decide: 0, prompts: [] as string[], deliver: [] as Array<Record<string, unknown>>, route: 0, admins: 0, undelivered: [] as Array<Record<string, unknown>> }
      const deps = {
        policy,
        // contract C4 (lane 146F, documented shapes): undeliveredPromisesFor is ALWAYS asked about one contact; deliverPromised takes { brokerageId, promiseId }
        undelivered: async (p: Record<string, unknown>) => { c.undelivered.push(p); return (o.owed as Array<{ id: string }>) ?? [{ id: "promise-1", status: "failed", fulfilment: "system" }] },
        deliver: async (p: Record<string, unknown>) => { c.deliver.push(p); return o.delivered === false ? { delivered: false, status: "asset_missing", reason: "asset not approved" } : { delivered: true, status: "delivered" } },
        decide: async (a: { prompt: string }) => { c.decide++; c.prompts.push(a.prompt); return (o.reply as Record<string, unknown>) ?? { optionId: "deliver", channel: "in_app", format: null, waitHours: null, rationale: "They have a portal login — the guide lands there now.", evidence: ["moment"], confidence: 0.9 } },
        routeToAgent: (async () => { c.route++; return true }) as never,
        notifyAdmins: async () => { c.admins++; return 2 },
      }
      return { c, deps }
    }
    { const { c, deps } = mk(); const db = world()
      const r = await arb.respondToPromisedDeliverable(db, { brokerageId: B1, party: { kind: "contact", id: C1 }, now: NOW }, deps)
      check("an undelivered promise → the arbiter decides deliver-now on a permitted channel (the contact's portal) and the C4 deliverer delivers it ({ brokerageId, promiseId } — C4 takes no channel)", r.action === "delivered" && r.channel === "in_app" && c.deliver.length === 1 && JSON.stringify(c.deliver[0]) === JSON.stringify({ brokerageId: B1, promiseId: "promise-1" }), JSON.stringify(r))
      check("the C4 read is narrowed to ONE contact of THIS tenant (never the tenant-wide promise list)", c.undelivered.length === 1 && c.undelivered[0].contactId === C1 && c.undelivered[0].brokerageId === B1)
      check("the moment is promised_deliverable, the menu offers delivery or a person — NEVER a wait", /promised_deliverable/.test(c.prompts[0]) && /"id":"deliver"/.test(c.prompts[0]) && !/"id":"wait"/.test(c.prompts[0]))
      const again = await arb.respondToPromisedDeliverable(db, { brokerageId: B1, party: { kind: "contact", id: C1 }, now: NOW }, deps)
      check("IDEMPOTENT per (promise, day): the same moment again REPLAYS — delivered once", again.action === "replayed" && c.deliver.length === 1)
      check("EVIDENCE: one lead_magnet.promise.deliver ledger row, executed", db.tables.agent_action_ledger.filter((x) => x.action === "lead_magnet.promise.deliver").length === 1 && db.tables.agent_action_ledger[0].status === "executed") }
    { const { c, deps } = mk({ delivered: false }); const r = await arb.respondToPromisedDeliverable(world(), { brokerageId: B1, party: { kind: "contact", id: C1 }, now: NOW }, deps)
      check("NEVER a false 'delivered': the deliverer said asset_missing (not approved) → delivery_failed with its reason, AND the contact's agent is told in the same step", r.action === "delivery_failed" && /asset_missing — asset not approved/.test(r.reason) && /a person was told/.test(r.reason) && c.deliver.length === 1 && c.route === 1, r.reason) }
    { const { c, deps } = mk({ delivered: false }); const db = world({ contacts: [{ id: C1, brokerage_id: B1, agent_id: null, has_login: false }] })
      const r = await arb.respondToPromisedDeliverable(db, { brokerageId: B1, party: { kind: "contact", id: C1 }, now: NOW }, deps)
      check("a contact with NO agent: a failed delivery goes to the brokerage's admins, never a missing agent", r.action === "delivery_failed" && c.admins === 1 && c.route === 0) }
    { const { c, deps } = mk({ owed: [] }); const r = await arb.respondToPromisedDeliverable(world(), { brokerageId: B1, party: { kind: "contact", id: C1 }, now: NOW }, deps)
      check("nothing owed → nothing_owed, the model never asked", r.action === "nothing_owed" && c.decide === 0) }
    { const { c, deps } = mk({ reply: { optionId: "deliver", channel: "in_app", format: null, waitHours: null, rationale: "Portal.", evidence: ["moment"], confidence: 0.9 } })
      const db = world({ contacts: [{ id: C1, brokerage_id: B1, agent_id: A1, has_login: false }] })
      const r = await arb.respondToPromisedDeliverable(db, { brokerageId: B1, party: { kind: "contact", id: C1 }, now: NOW }, deps)
      check("no portal sign-in → the permitted delivery is the governed EMAIL only (the portal is not offered; a model pick of it falls back)", r.action === "delivered" && r.channel === "email" && /"channels":\["email"\]/.test(c.prompts[0]) && !/"in_app"/.test(c.prompts[0].split('"options"')[1] ?? "") && !/"sms"/.test(c.prompts[0].split('"options"')[1] ?? ""), r.channel ?? "") }
    { const { c, deps } = mk(); const r = await arb.respondToPromisedDeliverable(world(), { brokerageId: B1, party: { kind: "lead", id: L1 }, now: NOW }, deps)
      check("an UNCONVERTED lead: C4 records promises only for a contact → nothing_owed, C4 never asked, nothing delivered", r.action === "nothing_owed" && c.undelivered.length === 0 && c.deliver.length === 0 && c.decide === 0) }
    { const { c, deps } = mk(); const r = await arb.respondToPromisedDeliverable(world(), { brokerageId: B1, party: { kind: "lead", id: L2 }, now: NOW }, deps)
      check("CONVERSION IS FINAL (C2): a converted lead's promise is read and delivered on its CONTACT", r.action === "delivered" && c.deliver.length === 1 && c.undelivered[0]?.contactId === C1) }
    { const { deps } = mk(); const r = await arb.respondToPromisedDeliverable(world(), { brokerageId: B2, party: { kind: "contact", id: C1 }, now: NOW }, deps)
      check("TENANCY: another brokerage's person is refused", r.action === "refused" && /not in this brokerage/.test(r.reason)) }
    { const { deps } = mk(); const r = await arb.respondToPromisedDeliverable(world(), { brokerageId: B1, party: { kind: "contact", id: C1 }, now: NOW }, { ...deps, undelivered: async () => { throw new Error("contract C4 read refused (lead_magnet_promises read refused: permission denied)") } })
      check("contract C4 refused / absent → REFUSED with the reason (the engagement continues; nothing is marked delivered)", r.action === "refused" && /contract C4/.test(r.reason)) }
    { const { c, deps } = mk({ reply: { optionId: "wait", channel: null, format: null, waitHours: 24, rationale: "Hold it until tomorrow morning.", evidence: ["moment"], confidence: 0.9 } })
      const r = await arb.respondToPromisedDeliverable(world(), { brokerageId: B1, party: { kind: "contact", id: C1 }, now: NOW }, deps)
      check("a model WAIT is refused (not on the menu) → delivered now on the planner's channel, UNDER the promised_deliverable priority (the high-priority path decided, stated in the fallback)",
        r.action === "delivered" && r.decision?.source === "deterministic" && c.deliver.length === 1 && /^promised_deliverable — /.test(r.decision?.fallbackReason ?? ""), r.decision?.fallbackReason ?? "") }
    { const { c, deps } = mk(); const { undelivered: _u, deliver: _d, ...noC4 } = deps
      const r = await arb.respondToPromisedDeliverable(world(), { brokerageId: B1, party: { kind: "contact", id: C1 }, now: NOW }, noC4)
      check("FAIL CLOSED: contract C4 not passed by the caller → refused, nothing read, nothing delivered, the model never asked", r.action === "refused" && /contract C4/.test(r.reason) && c.deliver.length === 0 && c.decide === 0) }
    { const arbSrc = code("lib/ai-isa/followup-arbiter.ts")
      const importsC4 = (src: string) => /import\(\s*["']@\/lib\/lead-magnets\/promised-deliverables["']\s*\)|from\s+["']@\/lib\/lead-magnets\/promised-deliverables["']/.test(src)
      check("GRAPH BUDGET: the arbiter (reached by every dashboard page) never imports C4's delivery stack — the caller passes it (stripped source)", !importsC4(arbSrc))
      check("POSITIVE CONTROL: the same finder sees a dynamic C4 import when one is written", importsC4('const m = await import("@/lib/lead-magnets/promised-deliverables")'))
      const irSrc = code("lib/communications/inbound-record.ts")
      const adapter = irSrc.slice(irSrc.indexOf("async function promiseContractFor"))
      const finder = /\bread\(svc, \{([^}]*)\}\)/
      const call = adapter.match(finder)
      check("the C4 adapter (inbound-record promiseContractFor) reads ONE contact (brokerageId + contactId — the tenant-wide form is never called)", adapter.length > 0 && !!call && /contactId: p\.contactId/.test(call[1]) && /brokerageId: p\.brokerageId/.test(call[1]), call?.[0] ?? "no call found")
      const specimen = "read(svc, { brokerageId: p.brokerageId })".match(finder)
      check("POSITIVE CONTROL: the same finder sees a tenant-wide call when one is written (and it carries no contactId)", !!specimen && !/contactId/.test(specimen[1]))
      check("the C4 adapter counts ONLY status \"delivered\" as delivered (ok: true with another status is not)", /r\.ok === true && r\.status === "delivered"/.test(adapter)) }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("E · ruling 7 — the platform prospect ladder is arbitrated (platform scope, no tenant data)")
  {
    const facts = (o: Record<string, unknown> = {}) => ({ roleInterest: "brokerage", source: "site_form", hoursSinceCreated: 30, hoursSinceLastFollowup: 80, followupCount: 1, repliedSinceLastTouch: false, daysDeferred: 0, ...o })
    let asked = 0; const prompts: string[] = []
    const decide = (reply: Record<string, unknown>) => async (a: { prompt: string }) => { asked++; prompts.push(a.prompt); return reply }
    const replied = await arb.arbitrateProspectFollowup({ rung: "nudge", facts: facts({ repliedSinceLastTouch: true }) }, { decide: decide({}) })
    check("a prospect who WROTE BACK → platform staff (never the automated nudge), the model never asked", replied.action === "notify_staff" && asked === 0)
    const waited = await arb.arbitrateProspectFollowup({ rung: "nudge", facts: facts() }, { decide: decide({ optionId: "wait", channel: null, format: null, waitHours: 20, rationale: "It is late Friday — the nudge lands better Monday.", evidence: ["moment"], confidence: 0.8 }) })
    check("the model may hold the released touch for a BOUNDED time (send / wait / staff on the menu)", waited.action === "wait" && waited.waitHours === 20 && /"id":"wait"/.test(prompts[0]) && /"id":"notify_staff"/.test(prompts[0]) && /platform_prospect_nudge/.test(prompts[0]))
    prompts.length = 0
    await arb.arbitrateProspectFollowup({ rung: "intro", facts: facts({ followupCount: 0, daysDeferred: DEFAULT_FOLLOWUP_POLICY.arbiter.maxDeferDays }) }, { decide: decide({ optionId: "send_now", channel: "email", format: null, waitHours: null, rationale: "Overdue intro goes now.", evidence: ["moment"], confidence: 0.8 }) })
    check("BOUNDED: once held maxDeferDays, WAIT leaves the menu (a prospect is never deferred forever)", !/"id":"wait"/.test(prompts[0]) && /"id":"send_now"/.test(prompts[0]))
    const outage = await arb.arbitrateProspectFollowup({ rung: "intro", facts: facts({ followupCount: 0 }) }, { decide: async () => { throw new Error("gateway down") } })
    check("an outage keeps the ladder's send (the deterministic verdict, stated)", outage.action === "send_now" && outage.decision?.source === "deterministic")
    check("NO TENANT DATA: the prospect's facts are platform facts only (no brokerage id, no contact) in the prompt", !new RegExp(B1).test(prompts.join("")) && /platform scope/.test(prompts[0]))
    const pf = code("lib/platform/prospect-followup.ts")
    const introAt = pf.indexOf("arbitrated(p, \"intro\")"), introSend = pf.indexOf("composeProspectOutreach({")
    const nudgeAt = pf.indexOf("arbitrated(p, \"nudge\")"), nudgeSend = pf.indexOf("composeProspectNudge({")
    check("WIRED: both rungs ask the arbiter AFTER the suppression check and BEFORE composing / sending (stripped source)", introAt > 0 && introAt < introSend && nudgeAt > 0 && nudgeAt < nudgeSend && pf.indexOf("isEmailOnSuppressionList(p.email)") < introAt)
    check("the ENVELOPE is unchanged: two status filters (new / contacted), two open-handoff and two callback exclusions, exactly one nudge",
      (pf.match(/\.eq\("status",/g) ?? []).length === 2 && (pf.match(/\.is\("details->human_handoff",\s*null\)/g) ?? []).length === 2 && (pf.match(/\.is\("details->callback",\s*null\)/g) ?? []).length === 2 && pf.includes('.eq("followup_count", 1)'))
    check("a wait and a handoff are AUDITED (superadmin_audit_log) and a handoff stands the ladder down (markProspectHandoff)", /platform_prospect\.followup_wait/.test(pf) && /platform_prospect\.followup_handoff/.test(pf) && /markProspectHandoff\(/.test(pf))
    // "they came back" has WRITERS (CLAUDE.md §1 — a read with no writer is a dead feature wearing a working query):
    const im = code("app/api/webhooks/inbound-mail/route.ts")
    const ir0 = code("lib/communications/inbound-record.ts")
    const door =im.slice(im.indexOf("if (!resolvedCredential && !brokerageId && email.fromEmail"), im.indexOf("if (!contactId || !brokerageId) {"))
    check("WRITER 1 (email): the mail door records an UNTENANTED reply from exactly one platform prospect on the PLATFORM path (platform: true, party platform_prospect) — before the tenant-only skip",
      door.length > 0 && /recordInboundCommunication\(\{/.test(door) && /platform: true/.test(door) && /kind: "platform_prospect"/.test(door) && /from\("platform_prospects"\)\.select\("id"\)\.eq\("email", from\)\.limit\(2\)/.test(door) && /\.length === 1\)/.test(door), door.slice(0, 160))
    check("WRITER 1 lands the fact the sweep reads (inbound-record's platform path writes details.last_inbound_at)", /last_inbound_at: input\.receivedAt/.test(ir0) && /details\.last_inbound_at/.test(pf))
    check("WRITER 2 (voice): the sweep also reads a CALL to the platform reception line since the last touch (platform_reception_calls.prospect_id, written by the Twilio reception routes)",
      /from\("platform_reception_calls"\)\.select\("id"\)\s*\.eq\("prospect_id", p\.id\)\.gt\("started_at", lastTouch\)/.test(pf) && /from\("platform_reception_calls"\)\.insert\(/.test(code("app/api/voice/twilio/inbound/route.ts")))
    check("FORGED FROM: a sender the provider FAILED to authenticate is never recorded as the person's words (both mail-door records)",
      /email\.senderAuth !== "fail"/.test(door) && /contactIsSender && email\.senderAuth === "fail"/.test(im))
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("F · social normalizers — what the providers push (primary sources read 2026-10-29), our own echoes dropped")
  {
    const fb = social.normalizeMetaChanges({ object: "page", entry: [{ id: "page-1", changes: [
      { field: "feed", value: { item: "comment", verb: "add", comment_id: "c-1", post_id: "page-1_post-9", from: { id: "u-7", name: "Riley" }, message: "Is it pet friendly?", created_time: 1761750000 } },
      { field: "feed", value: { item: "comment", verb: "edited", comment_id: "c-2", post_id: "p", from: { id: "u-7" }, message: "x" } },
      { field: "feed", value: { item: "post", verb: "add", post_id: "p2", from: { id: "u-7" }, message: "a post" } },
      { field: "feed", value: { item: "comment", verb: "add", comment_id: "c-3", post_id: "p", from: { id: "page-1" }, message: "Thanks!" } },
      { field: "mention", value: { item: "post", verb: "add", post_id: "p4", message: "Shout out to @Agency" } },
      { field: "mention", value: { item: "post", verb: "add", post_id: "p5" } },
    ] }] })
    check("Page feed: a NEW comment is one event (comment id, post id, author); edits / posts / the Page's own comment are dropped; a mention with text is kept, one without text is not invented",
      fb.length === 2 && fb[0].kind === "comment" && fb[0].providerRef === "c-1" && fb[0].postRef === "page-1_post-9" && fb[0].authorId === "u-7" && fb[1].kind === "mention" && fb[1].providerRef === "p4", JSON.stringify(fb))
    const ig = social.normalizeMetaChanges({ object: "instagram", entry: [
      { id: "ig-1", time: 1761750000, changes: [{ field: "comments", value: { comment_id: "igc-1", text: "Price?", from: { id: "igu-1", username: "riley" }, media: { id: "med-1", ad_id: "AD-77" } } }, { field: "mentions", value: { media_id: "med-2", comment_id: "igc-2" } }] },
      { id: "ig-1", time: 1761750001, field: "comments", value: { id: "igc-3", text: "Lovely!", from: { id: "igu-2", username: "sam" }, media: { id: "med-3" } } },
      { id: "ig-1", changes: [{ field: "comments", value: { comment_id: "igc-4", text: "our own", from: { id: "ig-1" } } }] },
    ] })
    check("Instagram: both login shapes (changes[].comment_id and entry.field/value.id), media.ad_id kept (the AD interaction), a text-less mention not invented, our own comment dropped",
      ig.length === 2 && ig[0].providerRef === "igc-1" && ig[0].adId === "AD-77" && ig[1].providerRef === "igc-3" && ig[1].adId === null, JSON.stringify(ig))
    const li = social.normalizeLinkedInNotifications({ type: "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS", notifications: [
      { action: "COMMENT", notificationId: 4406004, organizationalEntity: "urn:li:organization:12345", sourcePost: "urn:li:activity:29", decoratedGeneratedActivity: { comment: { entity: "urn:li:comment:(urn:li:activity:6,1)", owner: "urn:li:person:abc", object: "urn:li:activity:6", text: "Great market update" } }, lastModifiedAt: 1535741251282 },
      { action: "ADMIN_COMMENT", notificationId: 4406005, organizationalEntity: "urn:li:organization:12345", decoratedGeneratedActivity: { comment: { owner: "urn:li:organization:12345", text: "thanks" } } },
      { action: "COMMENT", notificationId: 4406006, organizationalEntity: "urn:li:organization:12345", decoratedGeneratedActivity: { comment: { owner: "urn:li:organization:12345", text: "our own" } } },
      { action: "LIKE", notificationId: 4406007, organizationalEntity: "urn:li:organization:12345" },
      { action: "SHARE_MENTION", notificationId: 4406008, organizationalEntity: "urn:li:organization:12345", decoratedGeneratedActivity: { share: { owner: "urn:li:person:def", text: "Thanks @Agency for the help" } } },
    ] })
    check("LinkedIn: COMMENT and SHARE_MENTION become events keyed on notificationId (author = the person URN's id); an admin's / the organization's own comment and a LIKE are not inbound",
      li.length === 2 && li[0].providerRef === "4406004" && li[0].authorId === "abc" && li[0].accountId === "12345" && li[1].kind === "mention" && li[1].authorId === "def", JSON.stringify(li))
    const x = social.normalizeXTweetEvents({ for_user_id: "999", tweet_create_events: [
      { id_str: "t1", text: "@agency is this still available?", user: { id_str: "42", screen_name: "riley" }, in_reply_to_user_id_str: "999", in_reply_to_status_id_str: "t0" },
      { id_str: "t2", text: "shout out @agency", user: { id_str: "43" }, entities: { user_mentions: [{ id_str: "999" }] } },
      { id_str: "t3", text: "our own post", user: { id_str: "999" } },
      { id_str: "t4", text: "RT", user: { id_str: "44" }, retweeted_status: {}, entities: { user_mentions: [{ id_str: "999" }] } },
      { id_str: "t5", text: "unrelated", user: { id_str: "45" } },
    ] })
    check("X: a reply to the account (comment) and an @mention are events keyed on the tweet id; our own post, a repost and an unrelated tweet are not",
      x.length === 2 && x[0].kind === "comment" && x[0].providerRef === "t1" && x[1].kind === "mention" && x[1].providerRef === "t2", JSON.stringify(x))
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("G · social ingestion — the receiving account's ONE tenant, an EXISTING identity, the thread, the chain")
  {
    const seen: Array<Record<string, unknown>> = []
    const process = async (input: Record<string, unknown>) => { seen.push(input); return { record: { recorded: true, duplicate: false } } as never }
    const ev = (o: Record<string, unknown> = {}) => ({ provider: "meta" as const, surface: "facebook" as const, kind: "comment" as const, accountId: "page-1", authorId: "psid-1", authorName: "Dana", text: "Is it pet friendly?", providerRef: "c-1", postRef: "post-1", parentRef: null, adId: null, createdAt: NOW.toISOString(), ...o })
    const accounts = [{ id: "sma-1", brokerage_id: B1, agent_id: A1, platform: "facebook", account_id: "page-1", is_active: true }]
    {
      const db = world({ social_media_accounts: accounts })
      const r = await social.ingestInboundSocialEvents(db, [ev(), ev({ authorId: "stranger-1", providerRef: "c-2" }), ev({ authorId: "stranger-1", providerRef: "c-3" }), ev({ providerRef: "c-4", adId: "AD-9" })], { process: process as never })
      check("a known author (the DM door's facebook_psid already on the contact) is the CONTACT, riding their one thread (no door thread)", !!seen[0]?.party && (seen[0].party as { id: string }).id === C1 && seen[0].conversationId === null && seen[0].brokerageId === B1 && seen[0].channel === "social_comment")
      check("an UNKNOWN commenter gets the account's public thread (created ONCE per post + author) — and no contact or lead is created",
        seen[1]?.party === null && !!seen[1]?.conversationId && seen[2]?.conversationId === seen[1]?.conversationId && db.tables.conversations.filter((c) => c.type === "social_comment").length === 1 && db.tables.contacts.length === 3 && db.tables.leads.length === 2)
      check("a comment on an AD is the campaign interaction (channel ad_interaction, the ad id on the thread ref)", seen[3]?.channel === "ad_interaction" && (seen[3]?.threadRef as Record<string, unknown>)?.ad_id === "AD-9")
      check("counters: 4 received, 4 recorded, none unowned", r.received === 4 && r.recorded === 4 && r.unowned === 0)
    }
    seen.length = 0
    {
      const db = world({ social_media_accounts: [...accounts, { id: "sma-2", brokerage_id: B2, agent_id: null, platform: "facebook", account_id: "page-1", is_active: true }] })
      const r = await social.ingestInboundSocialEvents(db, [ev()], { process: process as never })
      check("AMBIGUITY IS NOT A MATCH: an account two tenants connected is unowned — nothing recorded anywhere", r.unowned === 1 && seen.length === 0)
      const none = await social.ingestInboundSocialEvents(world(), [ev()], { process: process as never })
      check("an account no tenant connected is acknowledged and skipped (never fabricated into a tenant)", none.unowned === 1 && seen.length === 0)
      const refused = await social.ingestInboundSocialEvents(world({ social_media_accounts: accounts }, { refuse: { social_media_accounts: "permission denied" } }), [ev()], { process: process as never })
      check("FAIL CLOSED: a refused account read is a refusal with its reason", refused.refused.length === 1 && /account read refused/.test(refused.refused[0].reason) && seen.length === 0)
    }
    {
      // END TO END through the real record + chain (in memory): an unknown commenter on the tenant's page.
      const db = world({ social_media_accounts: accounts })
      let responded = 0
      const r = await social.ingestInboundSocialEvents(db, [ev({ authorId: "stranger-9", providerRef: "c-e2e" }), ev({ authorId: "stranger-9", providerRef: "c-e2e" })], {
        processDeps: { client: db as never, emit: async () => undefined, respond: async () => { responded++; return { action: "reply_proposed", reason: "ok" } } },
      })
      check("END TO END: a public comment is recorded once on the public thread (a redelivery is a duplicate) and the arbiter is asked once",
        r.recorded === 1 && r.duplicates === 1 && db.tables.messages.length === 1 && db.tables.messages[0].type === "social_comment" && db.tables.messages[0].metadata.provider_ref === "c-e2e" && responded === 1, JSON.stringify(r))
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("H · wiring — stripped source, positive controls")
  {
    const ir = code("lib/communications/inbound-record.ts")
    check("the record never INSERTS a contact or a lead (no person is fabricated from an inbound)", !/from\("contacts"\)\s*\.insert/.test(ir) && !/from\("leads"\)\s*\.insert/.test(ir))
    check("POSITIVE CONTROL: the insert finder sees the record's messages insert", /from\("messages"\)\.insert/.test(ir.replace(/\s+/g, "")))
    const chain = ir.slice(ir.indexOf("export async function processInboundCommunication"))
    check("ORDER: the chain returns on a non-recorded (duplicate / refused) record BEFORE any reaction", chain.indexOf("if (!record.recorded) return") > 0 && chain.indexOf("if (!record.recorded) return") < chain.indexOf("detectOptOutIntent"))
    check("ORDER: the chain answers an owed promise (respondToPromisedDeliverable) BEFORE the inbound responder (respondToInboundCommunication)", chain.indexOf("respondToPromisedDeliverable(") > 0 && chain.indexOf("respondToPromisedDeliverable(") < chain.indexOf("respondToInboundCommunication("))
    const fa = code("lib/ai-isa/followup-arbiter.ts") + "\n" + code("lib/communications/inbound-responder.ts")
    check("the arbiter's ledger actions are domain.entity.action (a two-part name is never ledgered — lib/kernel/action-ledger.ts ACTION_NAME_PATTERN)",
      /action: "inbound\.message\.respond"/.test(fa) && /action: "lead_magnet\.promise\.deliver"/.test(fa) && /action: "life_change\.signal\.respond"/.test(fa) && !/action: "life_change\.respond"/.test(fa))
    check("POSITIVE CONTROL: the pattern the ledger enforces refuses a two-part name and admits a three-part one", !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test("life_change.respond") && /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test("life_change.signal.respond"))
    check("autonomy is EXPLICIT: a reply is sent only when the posture is 'autonomous' (absence of a grant = a person approves)", /posture !== "autonomous"/.test(fa) && /resolveManagerAutonomy\(/.test(fa) && /autonomyDecision\(/.test(fa))
    const mig = raw("supabase/migrations/m876-one-inbound-record-per-provider-ref.sql")
    check("m876 line 1 states its status (the lane stamp until applied; APPLIED LIVE once the integrator applied it)", /^-- (WRITTEN, NOT APPLIED \(wave 146, lane 146B\)|── APPLIED LIVE )/.test(mig.split("\n")[0]))
    check("m876 is the partial unique index on (brokerage_id, provider, provider_ref) for INBOUND rows", /CREATE UNIQUE INDEX IF NOT EXISTS messages_inbound_provider_ref_uniq/.test(mig) && /\(brokerage_id, \(metadata->>'provider'\), \(metadata->>'provider_ref'\)\)/.test(mig) && /WHERE direction = 'inbound'/.test(mig))
    const newFiles = ["lib/communications/inbound-record.ts", "lib/social/inbound-social.ts"]
    check("no CONDITIONAL tenant predicate in the new modules (`if (x) q = q.eq(\"brokerage_id\", …)`)", newFiles.every((f) => !/if\s*\([^)]*\)\s*\w+\s*=\s*\w+\.eq\("brokerage_id"/.test(code(f))))
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════
  section("I · the opt-out door — no sessionless suppression through a public endpoint (wave 146, 146Z; ruling 20 priority 1)")
  {
    const { hasUseServerDirective } = await import("./session-tokens")
    const action = code("app/actions/ai-isa/process-opt-out.ts")
    check("the sessionless writer lib/ai-isa/opt-out-writer.ts carries NO \"use server\" directive (it is not an HTTP endpoint)", raw("lib/ai-isa/opt-out-writer.ts").length > 0 && !hasUseServerDirective(code("lib/ai-isa/opt-out-writer.ts")))
    check("POSITIVE CONTROL: the directive finder sees the action's own \"use server\"", hasUseServerDirective(action))
    const iRefuse = action.indexOf("VERIFIED_INBOUND_OPT_OUT_SOURCES.has("), iSession = action.indexOf("getAgentContext()"), iWrite = action.indexOf("writeOptOut(")
    check("the \"use server\" action refuses inbound provenance FIRST, then requires the session, and only then writes", iRefuse > 0 && iRefuse < iSession && iSession < iWrite && !/WEBHOOK_SOURCES|isWebhookSource/.test(action))
    const doors = ["app/api/providers/inbound/route.ts", "app/api/voice/twilio/turn/route.ts", "app/api/voice/relay/plan/route.ts", "lib/communications/inbound-record.ts"]
    check("every verified inbound door calls the lib writer, none imports the \"use server\" action", doors.every((f) => /processOptOutFromVerifiedInbound\(/.test(code(f)) && !/app\/actions\/ai-isa\/process-opt-out/.test(code(f))), doors.filter((f) => !/processOptOutFromVerifiedInbound\(/.test(code(f))).join(","))
    const { processOptOut } = await import("../app/actions/ai-isa/process-opt-out")
    const forgedAction = await processOptOut({ entityType: "contact", entityId: C1, channel: "all", source: "inbound_sms" as never, rawMessage: "STOP" })
    check("BEHAVIOUR: posting the action with source 'inbound_sms' and no session is REFUSED (the pre-146 hole)", forgedAction.success === false && /inbound provenance/.test(forgedAction.error ?? ""), JSON.stringify(forgedAction))
    const w = await import("../lib/ai-isa/opt-out-writer")
    const emitted: string[] = []
    const emit = (async (p: { event: string }) => { emitted.push(String(p.event)) }) as never
    const db = world()
    const forged = await w.processOptOutFromVerifiedInbound({ entityType: "contact", entityId: C1, channel: "sms", source: "inbound_sms", rawMessage: "STOP", brokerageId: B2 }, { client: db as never, emit })
    check("a caller brokerage that disagrees with the entity's row is REFUSED and nothing is written", forged.success === false && forged.error === "Forbidden" && !db.tables.contacts.find((r) => r.id === C1)?.sms_opt_out && emitted.length === 0, JSON.stringify(forged))
    const ok = await w.processOptOutFromVerifiedInbound({ entityType: "contact", entityId: C1, channel: "sms", source: "inbound_social", rawMessage: "stop texting", brokerageId: B1 }, { client: db as never, emit })
    const c1 = db.tables.contacts.find((r) => r.id === C1)
    check("POSITIVE CONTROL: the verified door with the entity's own tenant writes the suppression with its provenance and emits once", ok.success === true && c1?.sms_opt_out === true && c1?.opt_out_source === "inbound_social" && emitted.length === 1, JSON.stringify({ ok, emitted, src: c1?.opt_out_source }))
    const ghost = await w.processOptOutFromVerifiedInbound({ entityType: "contact", entityId: "00000000-0000-4000-8000-00000000dead", channel: "sms", source: "inbound_sms" }, { client: db as never, emit })
    check("an unknown entity is refused (a suppression is never reported for a row that was not written)", ghost.success === false && emitted.length === 1, JSON.stringify(ghost))
  }

  console.log(`\n${"═".repeat(72)}`)
  console.log(`BLIND SPOTS (published beside the number):
  · in-memory database: the m876 / m488 unique indexes are MODELLED (scripts/in-memory-supabase.ts unique keys); the live index is m876's (its line 1 says whether it ran) — this run does not read the live database.
  · the model, the composer, the deliverer (contract C4), the re-engagement door (contract C2), Customer 360 (contract C6) and the DM sender are injected seams here; their own lanes prove their insides.
  · provider consoles (Meta page subscriptions to feed / mention / comments, the LinkedIn organization subscription, the X Account Activity subscription) are not provable from code — WAITING_EXTERNAL.
  · a LEAD's social DM or comment cannot reach the lead door (the social doors match CONTACT identities only); a lead's email / text reply does, through app/api/providers/inbound.
  · the opt-out writer is a seam here: lib/ai-isa/opt-out-writer.ts (the sessionless door the verified routes call; wave 146 moved it out of the "use server" action) is proven by its own provenance and tenant checks, not by this chain.`)
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log("\nFAILURES:"); for (const f of failures) console.log(`  · ${f}`); console.log(" ❌ INBOUND_COMMUNICATION_FAIL"); process.exit(1) }
  console.log(" ✅ INBOUND_COMMUNICATION_PASS — every inbound lands once on the one history, the arbiter answers within authority, promises are delivered, the platform funnel is arbitrated")
}

main().catch((e) => { console.error(e); process.exit(1) })
