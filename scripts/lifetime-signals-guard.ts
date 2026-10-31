#!/usr/bin/env tsx
/**
 * scripts/lifetime-signals-guard.ts  (npm run test:lifetime-signals)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 145, LANE 145F — the three owner rulings this lane closes, each DRIVEN through the real modules on an in-memory database
 * (no network, no model, no vendor), each refusal beside its positive control:
 *
 *   A. RULING 14 — THE LIFETIME CHANGE ACTION (lib/ai-isa/lifetime-change-action.ts): a recorded lifetime signal whose kind puts the
 *      home's value in play gets the in-app equity check (an ESTIMATE from verified inputs only, labelled, no rate) + the homeowner
 *      playbook; equity / refinance open ONE governed moment and consume the reactivation row; ledgered once per signal; tenant-pinned.
 *   B. RULING 11 — THE WATCHER (lib/enrichment/intent-signal-sources.ts): a NEW fact (provider + key + value — never the capture time)
 *      → one durable, consumed-once ledger event with source / field / provenance / freshness → its canonical party (C2) → the ONE
 *      responder; the sweep and the writers' push share the key; stale / age / property facts never route; no provider is called.
 *   C. RULING 12 — PROTECTED ATTRIBUTES NEVER BLOCK SYNCING, NEVER EXPOSED: the Versium adapter returns a paid row's protected fields
 *      ONLY in its segregated `protectedResearch` field; the research store keeps them with provenance (vendor-modeled, research-only)
 *      in m864's RLS table; nothing else in lib/ or app/ imports the store or names the table (positive control included).
 *
 * Scans read STRIPPED source (scripts/strip-comments.ts) — a tombstone is not a call site. BLIND SPOTS, published: the in-memory
 * client's jsonb @> is shallow (the open-moment lookup was written against a top-level key for that reason, and real PostgREST is a
 * superset); the cron routes are asserted by their stripped call sites, not executed; RLS is asserted on the migration TEXT (the
 * MCP applies it — the live policy is the integrator's verification query in the migration footer).
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments, stringLiterals } from "./strip-comments"
import { runtimeFiles } from "./runtime-roots"

let passed = 0, failed = 0
const failures: string[] = []
function ok(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await f() } finally { console.warn = w; console.error = e } }
const src = (p: string) => (existsSync(join(process.cwd(), p)) ? stripComments(readFileSync(join(process.cwd(), p), "utf8")) : "")

const B = "11111111-1111-4111-8111-111111111111", B2 = "22222222-2222-4222-8222-222222222222"
const LIFE = "33333333-3333-4333-8333-333333333333", AG = "44444444-4444-4444-8444-444444444444", TX = "55555555-5555-4555-8555-555555555555"
const NOW = new Date("2026-10-27T15:00:00.000Z")
const WINDOWS = { lifeEventWindowDays: 14, valueCheckWindowDays: 14 }
const LEDGER_UNIQUE = { agent_action_ledger: [["idempotency_key"]] }

async function main() {
  const lca = await import("../lib/ai-isa/lifetime-change-action")
  const iss = await import("../lib/enrichment/intent-signal-sources")
  const vc = await import("../lib/external/versium-client")

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n━━━ A · RULING 14 — the lifetime change action: in-app equity check + homeowner playbook, on the survivors ━━━")
  {
    // ── DRIVEN: a refinance signal on a lifetime client ──
    const seed = () => ({
      contacts: [
        { id: LIFE, brokerage_id: B, first_name: "Lee", last_name: "Past", contact_type: "lifetime_customer", lifecycle_state: "lifetime_customer", nurture_status: null, buyer_stage: null, agent_id: AG },
        { id: "c-buyer", brokerage_id: B, first_name: "Bo", contact_type: "buyer", lifecycle_state: "active", nurture_status: null, buyer_stage: "BUYER_SEARCHING", agent_id: AG },
        { id: "c-noagent", brokerage_id: B, first_name: "No", contact_type: "lifetime_customer", lifecycle_state: "lifetime_customer", agent_id: null },
        { id: "c-other", brokerage_id: B2, first_name: "Other", contact_type: "lifetime_customer", lifecycle_state: "lifetime_customer", agent_id: AG },
      ],
      transactions: [
        { id: TX, brokerage_id: B, status: "closed", deleted_at: null, close_date: "2021-06-01", buyer_contact_id: LIFE, contact_id: LIFE, deal_type: "buyer", property_address: "1 Main St, Austin, TX", purchase_price: 400000, loan_amount: null },
        { id: "tx-noagent", brokerage_id: B, status: "closed", deleted_at: null, close_date: "2020-01-01", buyer_contact_id: "c-noagent", contact_id: "c-noagent", deal_type: "buyer", property_address: "2 Oak St", purchase_price: 300000, loan_amount: 240000 },
      ],
      transaction_lenders: [{ id: "tl1", transaction_id: TX, loan_amount: 320000, interest_rate: 6.75, created_at: "2021-05-01T00:00:00Z" }],
      signal_reactivations: [
        { id: "sig-refi", brokerage_id: B, contact_id: LIFE, lead_id: null, signal_type: "refinance_opportunity", signal_strength: null, signal_data: { source: "equity_trigger", kind: "refinance" }, triggered_at: "2026-10-27T10:00:00.000Z", isa_reactivated: false },
        { id: "sig-other-tenant", brokerage_id: B2, contact_id: "c-other", lead_id: null, signal_type: "equity_milestone", signal_data: { kind: "equity" }, triggered_at: "2026-10-27T10:00:00.000Z", isa_reactivated: false },
      ],
      transparency_updates: [], lifetime_customer_touchpoints: [], agent_action_ledger: [],
    })
    const db = memSupabase(seed(), { uuidIds: true, stampCreatedAt: true, unique: LEDGER_UNIQUE })
    let valuationCalls = 0
    const valuation = async () => { valuationCalls++; return { value: 520000, rangeLow: 495000, rangeHigh: 545000, source: "rentcast", confidence: 0.8, fetchedAt: NOW.toISOString() } }
    const run1 = await quiet(() => lca.runLifetimeChangeActions(db as never, B, { now: NOW }, { valuation, windows: WINDOWS }))
    const card = db.tables.transparency_updates.find((r) => r.contact_id === LIFE && r.update_type === "equity_check")
    const moment = db.tables.lifetime_customer_touchpoints.find((r) => r.contact_id === LIFE)
    const sigRow = db.tables.signal_reactivations.find((r) => r.id === "sig-refi")
    const led = db.tables.agent_action_ledger.filter((r) => r.action === "sphere.lifetime_change.playbook")
    ok(run1.acted === 1 && run1.cards === 1 && run1.moments === 1 && run1.consumed === 1 && valuationCalls === 1, `one refinance signal → one card, one moment, consumed, ONE valuation (${JSON.stringify(run1)})`)
    ok(!!card && card.is_visible_to_client === true && card.metadata?.not_an_appraisal === true && card.metadata?.rate_quoted === false && card.metadata?.estimated_equity !== null && card.metadata?.valuation_source === "rentcast" && card.metadata?.loan_amount_source === "transaction_lenders.loan_amount",
      "the in-app card carries the verified inputs' provenance (valuation source, the recorded loan amount's column), labelled not-an-appraisal, rate_quoted false")
    ok(!!moment && moment.touchpoint_type === "custom" && moment.status === "scheduled" && moment.agent_id === AG && moment.engagement_data?.opened_by === "lifetime_change_action" && moment.engagement_data?.followup?.kind === "refinance" && moment.related_transaction_id === TX,
      "ONE governed post-close moment is opened for the conductor (planner + arbiter + this signal as evidence) — not a send, not a timetable")
    ok(sigRow?.isa_reactivated === true && sigRow?.signal_data?.lifetime_action?.moment_id === moment?.id && sigRow?.signal_data?.source === "equity_trigger", "the reactivation row is CONSUMED (the returning-customer loop will not answer a refinance with 'ready to look again?') and keeps its provenance")
    ok(led.length === 1 && led[0].actor_manager_key === "sphere_of_influence" && led[0].status === "executed", "ledgered once, by the Sphere of Influence, settled executed (LAW 5)")
    ok(db.tables.signal_reactivations.find((r) => r.id === "sig-other-tenant")?.isa_reactivated === false && !db.tables.transparency_updates.some((r) => r.contact_id === "c-other"), "another tenant's signal is never read by this tenant's run (tenant-pinned)")

    // ── the module's pure rules, driven through its ONE public door (the helpers are module-private by design) ──
    const opts = { uuidIds: true, stampCreatedAt: true, unique: LEDGER_UNIQUE }
    const sig = (id: string, type: string, data: Record<string, unknown> | null) => ({ id, brokerage_id: B, contact_id: LIFE, lead_id: null, signal_type: type, signal_data: data, triggered_at: "2026-10-27T10:00:00.000Z", isa_reactivated: false })
    const runWith = async (over: Record<string, unknown>) => {
      const d = memSupabase({ ...seed(), ...over } as never, opts)
      const r = await quiet(() => lca.runLifetimeChangeActions(d as never, B, { now: NOW }, { valuation, windows: WINDOWS }))
      return { d, r, moment: d.tables.lifetime_customer_touchpoints.find((x) => x.contact_id === LIFE), card: d.tables.transparency_updates.find((x) => x.contact_id === LIFE && x.update_type === "equity_check") }
    }
    const steps = (m: { engagement_data?: { followup?: { playbook?: Array<{ step: string; available: boolean }> } } } | undefined) => (m?.engagement_data?.followup?.playbook ?? []).map((p) => p.step)
    const kStamp = await runWith({ signal_reactivations: [sig("s1", "anything_custom", { kind: "refinance" })] })
    const kVocab = await runWith({ signal_reactivations: [sig("s2", "equity_milestone", null)] })
    const kUnknown = await runWith({ signal_reactivations: [sig("s3", "totally_unknown", null)] })
    ok(kStamp.moment?.engagement_data?.followup?.kind === "refinance" && kVocab.moment?.engagement_data?.followup?.kind === "equity" && kUnknown.r.scanned === 0 && kUnknown.d.tables.transparency_updates.length === 0,
      "the kind is the responder's own stamp first, else the ONE vocabulary (LIFE_CHANGE_SIGNAL_KINDS); an unknown type is not guessed (nothing happens)")
    const refiSteps = steps(moment)
    ok(["equity_estimate", "refinance_education", "professional_referral", "market_review"].every((x) => refiSteps.includes(x)) && !refiSteps.includes("listing_appointment"),
      `refinance playbook = estimate · refinance education · licensed-professional referral · market review (${refiSteps.join(", ")})`)
    const sale = await runWith({ signal_reactivations: [sig("s4", "home_value_seller_intent", { kind: "home_sale" })] })
    const saleSteps = ((sale.card?.metadata?.playbook ?? []) as Array<{ step: string }>).map((p) => p.step)
    ok(steps(kVocab.moment).length === 5 && saleSteps.includes("listing_appointment") && !saleSteps.includes("refinance_education"), "equity carries all five steps; a home-sale signal carries the listing consultation, not refinance steps")
    const lifeEv = await runWith({ signal_reactivations: [sig("s5", "divorce_filing", null), sig("s6", "buying_intent", null)] })
    ok(lifeEv.r.scanned === 0 && lifeEv.d.tables.transparency_updates.length === 0 && lifeEv.d.tables.lifetime_customer_touchpoints.length === 0,
      "a life event / a buying signal is NOT an equity question — nothing runs (a service topic stays a person's; the returning-customer loop keeps it)")
    const msg = String(card?.message ?? "")
    ok(/not an appraisal/i.test(msg) && /payoff statement/i.test(msg) && /Estimated equity: about \$/.test(msg),
      "the card labels the estimate (not an appraisal, not an offer) and the equity (an ESTIMATED balance — the payoff statement is the only exact one)")
    const noLoan = await runWith({ transaction_lenders: [] })
    const noLoanMsg = String(noLoan.card?.message ?? "")
    ok(!!noLoan.card && !/Estimated equity/.test(noLoanMsg) && /don't have your loan details/.test(noLoanMsg) && noLoan.card?.metadata?.estimated_equity === null,
      "no recorded loan → NO equity figure, said plainly (positive control: the loan card above carries one)")
    ok(![msg, noLoanMsg].some((x) => /\d+(\.\d+)?\s?%|\bAPR\b|save \$|per month|\/mo\b/i.test(x)) && /only a lender can quote a rate/i.test(msg),
      "the card never quotes or models a rate, a payment or a saving — a rate is a licensed lender's quote (mortgage skill)")
    const sellerOnly = await runWith({ transactions: [{ id: "tx-sold", brokerage_id: B, status: "closed", deleted_at: null, close_date: "2022-01-01", buyer_contact_id: "someone-else", contact_id: LIFE, seller_contact_id: LIFE, deal_type: "listing", property_address: "9 Elm St", purchase_price: 350000, loan_amount: null }], transaction_lenders: [] })
    const soStep = (sellerOnly.moment?.engagement_data?.followup?.playbook ?? []).find((p: { step: string }) => p.step === "equity_estimate")
    ok(!sellerOnly.card && soStep?.available === false && !!card, "only the home the client BOUGHT with us is estimated — a seller-only client gets no number (positive control: the buyer above got one)")

    // idempotency — the same signal again replays
    const callsAfterRun1 = valuationCalls
    const rerun = await quiet(() => lca.runLifetimeChangeActions(db as never, B, { now: NOW }, { valuation, windows: WINDOWS }))
    // A retry of the SAME row (as if the consume / stamp had been lost): the ledger's unique key replays it.
    const row = db.tables.signal_reactivations.find((r) => r.id === "sig-refi")!
    row.isa_reactivated = false
    row.signal_data = { source: "equity_trigger", kind: "refinance" }
    const again = await quiet(() => lca.runLifetimeChangeActions(db as never, B, { now: NOW }, { valuation, windows: WINDOWS }))
    ok(rerun.scanned === 0 && again.replayed === 1 && again.acted === 0 && valuationCalls === callsAfterRun1 && db.tables.transparency_updates.length === 1 && db.tables.lifetime_customer_touchpoints.length === 1,
      "the sweep skips the consumed row, and a retry of the same row REPLAYS (the ledger's unique key) — no second card, moment or valuation")

    // reuse — a value card already inside the window → no purchase
    const db2 = memSupabase({ ...seed(), transparency_updates: [{ id: "tu-eq", brokerage_id: B, contact_id: LIFE, update_type: "equity_trigger", is_visible_to_client: true, created_at: "2026-10-25T00:00:00.000Z", title: "x" }] }, { uuidIds: true, stampCreatedAt: true, unique: LEDGER_UNIQUE })
    let calls2 = 0
    const r2 = await quiet(() => lca.runLifetimeChangeActions(db2 as never, B, { now: NOW }, { valuation: async () => { calls2++; return null }, windows: WINDOWS }))
    const m2 = db2.tables.lifetime_customer_touchpoints.find((r) => r.contact_id === LIFE)
    ok(calls2 === 0 && r2.acted === 1 && r2.cards === 0 && !!m2 && db2.tables.transparency_updates.length === 1, "a value card already on the portal inside the tenant's value-check window is REUSED — no second valuation spend, no duplicate card")

    // valuation unavailable — nothing is fabricated, the playbook still runs
    const db3 = memSupabase(seed(), { uuidIds: true, stampCreatedAt: true, unique: LEDGER_UNIQUE })
    const r3 = await quiet(() => lca.runLifetimeChangeActions(db3 as never, B, { now: NOW }, { valuation: async () => null, windows: WINDOWS }))
    const m3 = db3.tables.lifetime_customer_touchpoints.find((r) => r.contact_id === LIFE)
    const eqStep = (m3?.engagement_data?.followup?.playbook ?? []).find((p: { step: string }) => p.step === "equity_estimate")
    ok(r3.acted === 1 && db3.tables.transparency_updates.length === 0 && !!m3 && eqStep?.available === false, "no valuation answer → NO card and no number anywhere; the moment still opens with the equity step marked unavailable (and why)")

    // home_sale — check + stamp, NOT consumed, no moment (the Listing Concierge re-engagement keeps the consultation)
    const db4 = memSupabase({ ...seed(), signal_reactivations: [{ id: "sig-sale", brokerage_id: B, contact_id: LIFE, signal_type: "home_value_seller_intent", signal_data: { kind: "home_sale" }, triggered_at: "2026-10-27T10:00:00.000Z", isa_reactivated: false }] }, { uuidIds: true, stampCreatedAt: true, unique: LEDGER_UNIQUE })
    const r4 = await quiet(() => lca.runLifetimeChangeActions(db4 as never, B, { now: NOW }, { valuation, windows: WINDOWS }))
    const s4 = db4.tables.signal_reactivations[0]
    ok(r4.acted === 1 && r4.cards === 1 && r4.moments === 0 && s4.isa_reactivated === false && !!s4.signal_data?.lifetime_action, "a home-sale signal gets the equity check and a stamp; the row is LEFT for the returning-customer loop (control: refinance above was consumed)")

    // not a lifetime client / no agent / other tenant subject
    const db5 = memSupabase({ ...seed(), signal_reactivations: [
      { id: "sig-buyer", brokerage_id: B, contact_id: "c-buyer", signal_type: "refinance_opportunity", signal_data: { kind: "refinance" }, triggered_at: "2026-10-27T10:00:00.000Z", isa_reactivated: false },
      { id: "sig-noagent", brokerage_id: B, contact_id: "c-noagent", signal_type: "refinance_opportunity", signal_data: { kind: "refinance" }, triggered_at: "2026-10-27T10:00:00.000Z", isa_reactivated: false },
      { id: "sig-foreign", brokerage_id: B, contact_id: "c-other", signal_type: "equity_milestone", signal_data: { kind: "equity" }, triggered_at: "2026-10-27T10:00:00.000Z", isa_reactivated: false },
    ] }, { uuidIds: true, stampCreatedAt: true, unique: LEDGER_UNIQUE })
    const r5 = await quiet(() => lca.runLifetimeChangeActions(db5 as never, B, { now: NOW }, { valuation, windows: WINDOWS }))
    const byId = (id: string) => db5.tables.signal_reactivations.find((r) => r.id === id)
    ok(r5.skipped >= 1 && byId("sig-buyer")?.isa_reactivated === false && !db5.tables.transparency_updates.some((r) => r.contact_id === "c-buyer"), "a contact who is not a lifetime client is skipped untouched (the responder engaged them already)")
    ok(byId("sig-noagent")?.isa_reactivated === false && !db5.tables.lifetime_customer_touchpoints.some((r) => r.contact_id === "c-noagent") && db5.tables.transparency_updates.some((r) => r.contact_id === "c-noagent"),
      "no agent of record → the estimate card still lands, but no moment (agent_id NOT NULL) and the row is left for the returning-customer loop")
    const naCard = db5.tables.transparency_updates.find((r) => r.contact_id === "c-noagent")
    ok(((naCard?.metadata?.playbook ?? []) as Array<{ step: string; available: boolean }>).find((p) => p.step === "professional_referral")?.available === false && ((naCard?.metadata?.playbook ?? []) as Array<{ step: string; available: boolean }>).find((p) => p.step === "refinance_education")?.available === true,
      "without an agent of record the introduction is marked unavailable (a referral is a person's, never automated) while the education stays offered")
    ok(r5.refused >= 1 && !db5.tables.transparency_updates.some((r) => r.contact_id === "c-other"), "a signal naming another tenant's contact is REFUSED (contact read is tenant-pinned) — nothing written")

    // wiring — the manager-signals tick calls it after the inbox drains (stripped source; positive control on the regex)
    const ms = src("app/api/cron/manager-signals/route.ts")
    const re = /runLifetimeChangeActions\s*\(\s*supabase\s*,\s*brokerageId\s*\)/
    ok(re.test(ms) && ms.indexOf("consumeManagerSignals(") < ms.search(re) && re.test("await runLifetimeChangeActions(supabase, brokerageId)") && !re.test(stripComments("// runLifetimeChangeActions(supabase, brokerageId)\n")),
      "WIRED: app/api/cron/manager-signals runs it per tenant right after the inboxes drain (positive + negative control on the finder)")
    const actionSrc = src("lib/ai-isa/lifetime-change-action.ts")
    ok(/requestPropertyValuation\(/.test(actionSrc) && !/getRentcastAVM|getBatchData|batchDataPropertyFallback/.test(actionSrc) && /computeEquityLine\(/.test(actionSrc) && /pushPortalValueCard/.test(actionSrc),
      "LAW 3: the value comes from the property_valuation CAPABILITY (never a vendor call); the equity from the ONE calculator; the card through the ONE portal primitive")
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n━━━ B · RULING 11 — the watcher: one durable, consumed-once event per changed fact → canonical party → the ONE responder ━━━")
  {
    const ind = (on: boolean | null, at: string, extra: Record<string, unknown> = {}) => ({ enrichment_profile: { real_estate_indicators: { provider: "versium", captured_at: at, ...(on === null ? {} : { onlinePresenceRealEstate: on }), ...extra }, field_provenance: { real_estate_indicators: { source: "versium", capability: "person.enrich_online_presence", retrievedAt: at, matchConfidence: "individual", purpose: "enrichment" } } } })
    const recapture = iss.newIntentFacts(ind(true, "2026-04-01T00:00:00.000Z"), ind(true, "2026-10-27T00:00:00.000Z"), NOW)
    const changed = iss.newIntentFacts(ind(false, "2026-04-01T00:00:00.000Z"), ind(true, "2026-10-27T00:00:00.000Z"), NOW)
    ok(recapture.length === 0 && changed.length === 1, "a stale re-buy that re-stamps captured_at with the SAME value is NOT a change (it was, keyed on the observation time); a changed value is (positive control)")
    ok(iss.newIntentFacts(null, { enrichment_profile: { birth_date: "1980-05-01", captured_at: NOW.toISOString(), real_estate_indicators: { captured_at: NOW.toISOString(), refinanceDate: "2026-09-01" } } }, NOW).length === 0,
      "an age fact and a stored property fact are never a change (only behaviour / life_event)")

    // writers' push → one bus line per fact, each behind a ledger event; replays never re-route
    const C = "66666666-6666-4666-8666-666666666666"
    const db = memSupabase({ contacts: [{ id: C, brokerage_id: B, contact_type: "buyer" }], manager_signals: [], agent_action_ledger: [], signal_reactivations: [] }, { uuidIds: true, stampCreatedAt: true, unique: LEDGER_UNIQUE })
    const after = ind(true, NOW.toISOString(), { investingRealEstate: true })
    const t1 = await quiet(() => iss.publishNewIntentFacts(db, { brokerageId: B, contactId: C }, ind(false, "2026-04-01T00:00:00.000Z"), after, NOW, { lifeEventWindowDays: 14 }))
    const lines = db.tables.manager_signals.filter((r) => r.signal_type === "online_intent_detected" && r.entity_id === C)
    const events = db.tables.agent_action_ledger.filter((r) => r.action === "enrichment.intent_fact.observed")
    ok(t1.published === 2 && lines.length === 2 && events.length === 2, `two new facts → TWO bus lines (no open-line absorption) and two durable ledger events (${JSON.stringify(t1)})`)
    const p0 = lines[0]?.payload ?? {}
    ok(typeof p0.fact_key === "string" && typeof p0.idempotency_key === "string" && p0.provenance?.stamp?.source === "versium" && p0.provenance?.capability === "online_presence" && p0.freshness?.fresh === true && p0.door === "writer_push",
      "each line carries source, field, provenance (the stored field_provenance stamp) and freshness — the handler's keys (key / provider / intents / sensitivity) kept")
    const t2 = await quiet(() => iss.publishNewIntentFacts(db, { brokerageId: B, contactId: C }, ind(false, "2026-04-01T00:00:00.000Z"), after, NOW, { lifeEventWindowDays: 14 }))
    ok(t2.published === 0 && t2.replayed === 2 && db.tables.manager_signals.length === 2, "the same facts again REPLAY — consumed once by the ledger's unique key, never a second line")

    // the fact key: provider + key + value as a DIGEST — a life-event type never rides the key in clear; same fact → same key
    const LE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    const dbL = memSupabase({ manager_signals: [], agent_action_ledger: [] }, { uuidIds: true, stampCreatedAt: true, unique: LEDGER_UNIQUE })
    await quiet(() => iss.publishNewIntentFacts(dbL, { brokerageId: B, contactId: LE }, { life_events: [], last_life_event_detected: null }, { life_events: [{ type: "divorce" }], last_life_event_detected: NOW.toISOString() }, NOW, { lifeEventWindowDays: 14 }))
    const leLine = dbL.tables.manager_signals.find((r) => r.entity_id === LE)
    const keys = lines.map((r) => String(r.payload?.fact_key))
    ok(!!leLine && leLine.payload?.sensitivity === "life_event" && !/divorce/.test(JSON.stringify([leLine.payload?.fact_key, leLine.payload?.idempotency_key, leLine.message])) && new Set(keys).size === 2 && keys.every((k) => /^versium:[a-z_]+:[0-9a-f]{8}$/.test(k)),
      "the fact key is provider + key + a value DIGEST (a life-event type never rides the key or the message in clear; two facts → two keys)")
    // freshness — outside the window is history, inside is routed (positive control)
    const old = ind(true, "2026-01-02T00:00:00.000Z")
    const dbF = memSupabase({ manager_signals: [], agent_action_ledger: [] }, { uuidIds: true, stampCreatedAt: true, unique: LEDGER_UNIQUE })
    const tStale = await quiet(() => iss.publishNewIntentFacts(dbF, { brokerageId: B, contactId: C }, ind(false, "2025-01-01T00:00:00.000Z"), old, NOW, { lifeEventWindowDays: 14 }))
    ok(tStale.stale === 1 && tStale.published === 0 && dbF.tables.manager_signals.length === 0, "a fact observed outside the tenant's life-event window is STALE — counted, never routed (control: the fresh push above routed)")

    // sweep — contacts + leads, C2, old carried facts not new, no double route after a push
    const L1 = "77777777-7777-4777-8777-777777777777", L2 = "88888888-8888-4888-8888-888888888888", L3 = "99999999-9999-4999-8999-999999999999"
    const freshAt = "2026-10-27T13:00:00.000Z"
    const respondCalls: Array<{ subject: { type: string; id: string }; signalType: string }> = []
    const respond = (async (_svc: unknown, inp: { subject: { type: string; id: string }; signalType: string }) => { respondCalls.push(inp); return { action: "lead_signal_recorded", subjectClass: "lead", kind: "moving", reason: "ok" } }) as never
    const dbS = memSupabase({
      contacts: [
        { id: C, brokerage_id: B, deleted_at: null, last_enriched_at: freshAt, enriched_at: null, last_life_event_detected: null, ...ind(true, NOW.toISOString(), { investingRealEstate: true }) },
        { id: "c-carried", brokerage_id: B, deleted_at: null, last_enriched_at: freshAt, enriched_at: null, last_life_event_detected: null, ...ind(true, "2026-10-01T00:00:00.000Z") },
        { id: "c-tenant2", brokerage_id: B2, deleted_at: null, last_enriched_at: freshAt, enriched_at: null, last_life_event_detected: null, ...ind(true, NOW.toISOString()) },
      ],
      leads: [
        { id: L1, brokerage_id: B, contact_id: C, is_active: false, last_enriched_at: freshAt, life_events: null, ...ind(true, freshAt, { homeImprovementInterest: true }) },
        { id: L2, brokerage_id: B, contact_id: null, is_active: true, last_enriched_at: freshAt, life_events: null, ...ind(true, freshAt) },
        { id: L3, brokerage_id: B, contact_id: null, is_active: false, last_enriched_at: freshAt, life_events: null, ...ind(true, freshAt) },
      ],
      manager_signals: db.tables.manager_signals.map((r) => ({ ...r })), agent_action_ledger: db.tables.agent_action_ledger.map((r) => ({ ...r })),
    }, { uuidIds: true, stampCreatedAt: true, unique: LEDGER_UNIQUE })
    const w = await quiet(() => iss.watchEnrichmentFactChanges(dbS, B, { now: NOW, windowMinutes: 360 }, { lifeEventWindowDays: 14, respond }))
    const sweptForC = dbS.tables.manager_signals.filter((r) => r.entity_id === C)
    ok(w.contactsScanned === 2 && w.leadsScanned === 3 && w.errors.length === 0, `the sweep reads this tenant's contacts / leads stamped since the cursor, tenant-pinned (${JSON.stringify({ c: w.contactsScanned, l: w.leadsScanned, e: w.errors })})`)
    ok(!dbS.tables.manager_signals.some((r) => r.entity_id === "c-carried") && !dbS.tables.manager_signals.some((r) => r.entity_id === "c-tenant2"),
      "a carried fact observed BEFORE the cursor is not new (re-enrichment ≠ change); another tenant's row is never swept")
    ok(sweptForC.filter((r) => r.payload?.door === "writer_push").length === 2 && sweptForC.some((r) => r.payload?.key === "home_improvement_interest" && r.payload?.door === "sweep"),
      "the sweep never re-routes what the push routed (same key → replay); the lead's NEW fact is routed AS ITS CONTACT (contract C2: contact_id set → out of the lead domain)")
    ok(w.leadsAsContact === 1 && w.leadsOutOfDomain === 1 && respondCalls.length === 1 && respondCalls[0].subject.type === "lead" && respondCalls[0].subject.id === L2 && respondCalls[0].signalType === "moving_intent" && !dbS.tables.manager_signals.some((r) => r.entity_id === L2),
      "a lead WITHOUT a contact is answered by the ONE responder with subject lead (no bus line); an inactive lead without a contact is out of every domain")

    // wiring + no provider call
    const ep = src("app/api/cron/enrichment-processor/route.ts")
    ok(/watchEnrichmentFactChanges\s*\(\s*supabase\s*,\s*brokerage\.id\s*\)/.test(ep) && ep.indexOf("processEnrichmentQueue(") < ep.indexOf("watchEnrichmentFactChanges("), "WIRED: the 15-minute enrichment-processor tick runs the sweep right after the drain writes")
    const issSrc = src("lib/enrichment/intent-signal-sources.ts")
    // An IMPORT of a provider adapter / the connector gateway, or a gateway call — a census docs string naming a file is not a call.
    const providerCall = /(?:from\s+|import\s*\(\s*)["'][^"']*(?:versium-client|peopledata-client|connector-gateway|osint-client)["']|callConnector\s*\(/
    ok(!providerCall.test(issSrc) && providerCall.test('import { callConnector } from "@/lib/agentic-os/connector-gateway"') && providerCall.test('await import("@/lib/external/versium-client")') && !providerCall.test('docs: "lib/osint-client.ts (public-web search)"'),
      "the watcher calls NO provider (it reads what our enrichment stored) — positive control: the finder sees a static and a dynamic provider import; a docs string is not one")
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\n━━━ C · RULING 12 — protected attributes never block syncing, are stored for research, never exposed ━━━")
  {
    const row = { "Online Presence Indicator - Real Estate": "Yes", "Home Own or Rent": "Own", Ethnicity: "Ex", Religion: "Rx", "Presence of Children": "Yes", "Veteran In Household": "Yes", Language: "Lx", "Party Affiliation": "" }
    const r = await vc.appendVersiumRealEstateIndicators({ email: "pat@example.test" }, { call: async () => ({ ok: true, status: 200, data: { versium: { match_counts: { full_demographic: 1 }, num_results: 1, results: [row] } } }) })
    const exposed = JSON.stringify({ indicators: r.indicators, provenance: r.provenance })
    ok(!!r.indicators?.onlinePresenceRealEstate && !/Ethnicity|Religion|Children|Veteran|Language|"Ex"|"Rx"|"Lx"/.test(exposed), "the allow-listed indicators and the provenance carry NO protected field (the sync proceeds unchanged)")
    const cls = Object.fromEntries(r.protectedResearch.map((f) => [f.sourceField, f.protectedClass]))
    ok(r.protectedResearch.length === 5 && cls.Ethnicity === "race_color_national_origin" && cls.Religion === "religion" && cls["Presence of Children"] === "familial_status" && cls["Veteran In Household"] === "military_status" && cls.Language === "language" && r.protectedResearch.every((f) => f.basis === "vendor_modeled"),
      "the SAME paid row's protected fields are no longer thrown away: they leave ONLY in the segregated `protectedResearch` field, classed, vendor-modeled (an empty value is not a field)")
    const none = await vc.appendVersiumRealEstateIndicators({ email: "pat@example.test" }, { call: async () => ({ ok: true, status: 200, data: { versium: { match_counts: { full_demographic: 0 }, results: [] } } }) })
    ok(none.protectedResearch.length === 0, "a no-match carries none")

    const ops = await import("../lib/enrichment/online-presence-store")
    const C = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const db = memSupabase({ contacts: [{ id: C, brokerage_id: B, enrichment_profile: {} }], protected_research_attributes: [], manager_signals: [], agent_action_ledger: [] }, { uuidIds: true, stampCreatedAt: true, unique: LEDGER_UNIQUE })
    const wrote = await quiet(() => ops.persistRealEstateIndicators(db, { contactId: C, brokerageId: B }, r.indicators!, r.provenance, { protectedResearch: r.protectedResearch, now: NOW }))
    const held = db.tables.protected_research_attributes
    ok(wrote.ok && wrote.research?.stored === 5 && held.length === 5 && held.every((h) => h.brokerage_id === B && h.contact_id === C && h.purpose === "research" && h.basis === "vendor_modeled" && h.provider === "versium" && !!h.retrieved_at && h.capability === "person.enrich_online_presence"),
      "the research store keeps each field with its provenance (provider, capability, retrieved_at), vendor-modeled, purpose research")
    ok(!/Ethnicity|Religion|Children|Veteran|"Ex"|"Rx"|"Lx"/.test(JSON.stringify(db.tables.contacts)), "NOTHING protected lands on the contact row or its enrichment_profile (segregated)")
    const stamp0 = held.find((h) => h.source_field === "Religion")?.value_changed_at
    const again = await quiet(() => ops.persistRealEstateIndicators(db, { contactId: C, brokerageId: B }, r.indicators!, r.provenance, { refresh: true, protectedResearch: r.protectedResearch.map((f) => (f.sourceField === "Religion" ? { ...f, value: "Rz" } : f)), now: new Date(NOW.getTime() + 3_600_000) }))
    const rel = db.tables.protected_research_attributes.find((h) => h.source_field === "Religion")
    ok(again.ok && db.tables.protected_research_attributes.length === 5 && rel?.attribute_value === "Rz" && rel?.value_changed_at !== stamp0 && db.tables.protected_research_attributes.find((h) => h.source_field === "Language")?.value_changed_at === held.find((h) => h.source_field === "Language")?.value_changed_at,
      "idempotent per (contact, provider, field): a CHANGED value is re-dated (value_changed_at), an unchanged one is not")
    const foreign = await quiet(() => ops.persistRealEstateIndicators(db, { contactId: C, brokerageId: B2 }, r.indicators!, r.provenance, { protectedResearch: r.protectedResearch, now: NOW }))
    ok(!foreign.ok && db.tables.protected_research_attributes.every((h) => h.brokerage_id === B), "another tenant cannot write research onto this contact (tenant-anchored read first)")

    // the firewall — only the store and its one caller may name it (stripped source + real string literals)
    const allowed = new Set(["lib/enrichment/protected-research-store.ts", "lib/enrichment/online-presence-store.ts"])
    // Wave 147 (lane 147A, owner ruling 2): the subject's RIGHT-TO-KNOW export is the one PURPOSE-GATED reader outside the store.
    // It may import the store ONLY to call readProtectedAttributes (purpose data_subject_request — ledgered both ways) and may
    // NEVER name the table: the reader is its only path. Every other lib/ or app/ module stays behind the firewall.
    const gatedReaders = new Set(["app/actions/privacy/data-subject-requests.ts"])
    for (const g of gatedReaders) {
      const gText = readFileSync(join(process.cwd(), g), "utf8")
      const lits = stringLiterals(gText)
      ok(!lits.some((l) => l.text === "protected_research_attributes") && /readProtectedAttributes\(/.test(stripComments(gText)) && /purpose:\s*"data_subject_request"/.test(stripComments(gText)),
        `${g} reaches the research store ONLY through the purpose-gated reader (readProtectedAttributes, purpose data_subject_request) and never names the table`)
      allowed.add(g)
    }
    const hits: string[] = []
    const namesIt = (text: string) => stringLiterals(text).some((l) => l.text === "protected_research_attributes" || /protected-research-store$/.test(l.text))
    for (const f of runtimeFiles(process.cwd())) {
      const rel = f.replace(/^\.\//, "").replace(process.cwd() + "/", "")
      if (!/^(lib|app)\//.test(rel) || allowed.has(rel)) continue
      const text = readFileSync(join(process.cwd(), rel), "utf8")
      if (!/protected_research_attributes|protected-research-store/.test(text)) continue
      if (namesIt(text)) hits.push(rel)
    }
    ok(hits.length === 0 && namesIt('await svc.from("protected_research_attributes").select("*")') && namesIt('await import("@/lib/enrichment/protected-research-store")') && !namesIt("// protected_research_attributes is research-only"),
      `no other lib/ or app/ module (ads, targeting, dispatch, eligibility, prompts) imports the store or names the table — ${hits.length} found (positive control: the finder sees a read and an import; a comment is not one)`)

    // the migration — assert the RULE on its text (either line-1 stamp)
    const migPath = "supabase/migrations/m864-protected-research-attributes-segregated-store.sql"
    const mig = existsSync(migPath) ? readFileSync(migPath, "utf8") : ""
    const line1 = mig.split("\n")[0] ?? ""
    const sql = mig.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    ok(/^-- WRITTEN, NOT APPLIED \(wave 145, lane 145F\)/.test(line1) || /^-- ── APPLIED LIVE /.test(line1), "m864 carries a valid line-1 stamp (the lane stamp, or APPLIED LIVE once the integrator applies it)")
    ok(/ENABLE ROW LEVEL SECURITY/.test(sql) && /REVOKE ALL ON public\.protected_research_attributes FROM anon/.test(sql) && !/FOR\s+(INSERT|UPDATE|DELETE|ALL)\b/i.test(sql) && /FOR SELECT TO authenticated[\s\S]*is_platform_staff\(\)[\s\S]*current_user_type\(\) = 'compliance_officer'/.test(sql),
      "RLS on, anon revoked, NO client write policy (service-role writes only), SELECT only for platform staff or a same-tenant compliance_officer")
    ok(/CHECK \(purpose = 'research'\)/.test(sql) && /basis IN \('vendor_modeled', 'self_identified', 'public_record'\)/.test(sql) && /retain_until\s+timestamptz,/.test(sql) && !/retain_until\s+timestamptz\s+(NOT NULL|DEFAULT)/i.test(sql),
      "purpose is fixed to research, the basis is recorded, and retention is NOT invented (retain_until NULL until the owner decides)")
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ LIFETIME_SIGNALS_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
