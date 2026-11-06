#!/usr/bin/env tsx
/**
 * scripts/decision-window-guard.ts  (npm run test:decision-window)
 * ────────────────────────────────────────────────────────────────────────
 * WAVE 150, LANE 150JNAD — directive 150N (desired move × expected move × ability to act, negative evidence, the time-window
 * forecaster, confidence / calibration) and the owner's CANARY 6:
 *   "Desire but no feasible move is not labeled 'ready now'; a documented 60-day lease-end or an explicitly planned MLS date may narrow
 *    the window; an anonymous neighbourhood topic cannot create a person-level prediction; mixed evidence can legitimately output
 *    UNKNOWN." — each half with its positive control.
 * Driven through lib/intent/moving-moments.ts, lib/intent/movement-signals.ts and lib/analytics/ai-prediction-outcomes.ts on an
 * in-memory database (no model, no network).
 *
 *   A. THE INTERVALS — 0–30 / 31–90 / 91–180 / 181–365 / >365 / UNKNOWN at every boundary; every timeline bucket maps to ONE window.
 *   B. CANARY 6.1 — desire without feasibility is never "ready now"; (control) the same desire with financing + a near date is ready.
 *   C. CANARY 6.2 — a documented 60-day lease end → 31–90; a planned MLS go-live date (the listing row) narrows the window; a stated
 *      date beats the stated bucket; a passed date is never a window.
 *   D. CANARY 6.3 — an anonymous topic / territory / property never yields a person-level prediction (nothing frozen end to end).
 *   E. CANARY 6.4 — negative evidence as new as the newest positive → UNKNOWN; (control) older negative evidence does not.
 *   F. CALIBRATION — a placed window is frozen ONCE in ai_predictions (never a second store); an appointment grades nothing; a
 *      confirmed move grades hit / miss; a negative close inside an open window is not validated; a probability is published only
 *      past the validated floor.
 *   G. END TO END — record → the manager's decision stamps decision_window + moment + the holdout arm, freezes the forecast; the
 *      outcome door grades it.
 *
 * BLIND SPOTS, published: memSupabase has no CHECK / RLS (m970 / m971 are compared as text in test:moving-moments); the PRIOR ranges
 * per evidence kind are uncalibrated by design (labelled `evidence_prior`); the live lease-end writer is Outside-lane.
 */
import { memSupabase } from "./in-memory-supabase"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let passed = 0, failed = 0
const failures: string[] = []
function ok(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await f() } finally { console.warn = w; console.error = e } }

const B = "11111111-1111-4111-8111-111111111111"
const NOW = new Date("2026-11-06T15:00:00.000Z")
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString()

type Obs = import("../lib/intent/opportunity-discovery").OpportunityObservation
let seq = 0
const o = (sourceKey: string, relevance: Obs["relevance"], confidence: Obs["confidence"], extra: Partial<Obs> = {}): Obs =>
  ({ id: `o${++seq}`, sourceKey, relevance, confidence, identity: "record_key", observedAt: daysAgo(3), outreach: "consent_gated", rights: "first_party", ...extra })

async function main() {
  const mm = await import("../lib/intent/moving-moments")
  const od = await import("../lib/intent/opportunity-discovery")
  const mv = await import("../lib/intent/movement-signals")
  const apo = await import("../lib/analytics/ai-prediction-outcomes")
  const sl = await import("../lib/intelligence/strategy-learning")
  const moment = (obs: Obs[], facts: Partial<import("../lib/intent/moving-moments").MovingMomentFacts> = {}) => mm.buildMovingMoment(od.readOpportunities(obs, { now: NOW }), obs, { subjectIsPerson: true, ...facts }, { now: NOW })
  const buyerObs = () => [o("fp_inbound_stated", "relocation", "reported", { intents: ["home_purchase"], side: "buyer" }), o("fp_saved_homes", "property_event", "verified")]

  console.log("\nA. the reporting intervals")
  {
    const cases: Array<[number, string]> = [[0, "0_30"], [30, "0_30"], [31, "31_90"], [90, "31_90"], [91, "91_180"], [180, "91_180"], [181, "181_365"], [365, "181_365"], [366, "over_365"], [-1, "unknown"], [Number.NaN, "unknown"]]
    const bad = cases.filter(([d, w]) => mm.decisionWindowForDays(d) !== w)
    ok(bad.length === 0, `every boundary lands in its interval (${cases.length} cases)`, JSON.stringify(bad))
    const tl = (CHECK_VOCABULARIES as Record<string, Record<string, string[]>>).contacts?.timeline ?? []
    const mapped = tl.map((t) => [t, mm.statedTimelineWindow(t)] as const)
    ok(tl.length >= 6 && mapped.every(([, w]) => w !== null) && mm.statedTimelineWindow("researching") === "unknown" && mm.statedTimelineWindow("1-3_months") === "31_90", `every contacts.timeline bucket maps to ONE window; 'researching' is desire, not a window (${mapped.map(([t, w]) => `${t}→${w}`).join(", ")})`)
  }

  console.log("\nB. canary 6.1 — desire without feasibility is not 'ready now'")
  {
    const blocked = moment(buyerObs(), { statedSide: "buyer", financing: "none" })
    ok(blocked.desire_to_move.level === "strong" && blocked.ability_to_act.level === "blocked" && blocked.buyer_readiness.level === "considering" && blocked.decision_window.window === "unknown",
      `strong stated desire + no financing → considering, window UNKNOWN (${blocked.buyer_readiness.level}, ${blocked.decision_window.window}: ${blocked.decision_window.why})`)
    const blockedBucket = moment(buyerObs(), { statedSide: "buyer", financing: "none", statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) } })
    ok(blockedBucket.buyer_readiness.level === "considering" && blockedBucket.decision_window.window === "31_90", "even with their own 1-3 month timeline, a blocked buyer is considering — never ready now (the window is theirs, the readiness is not)")
    const barrier = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", inventory: "available", barriers: [{ key: "must_sell_first", basis: "person_stated" }], statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) } })
    ok(barrier.buyer_readiness.level === "preparing" && barrier.barrier[0]?.key === "must_sell_first", "a stated sell-first barrier keeps a financed buyer at preparing, the barrier named (a condition to help with)")
    const ready = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", inventory: "available", statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) } })
    ok(ready.buyer_readiness.level === "ready" && ready.ability_to_act.level === "able", `(control) the same desire with pre-approval, fitting inventory and a 1-3 month timeline → ready (${ready.buyer_readiness.level})`)
    const desireOnly = moment([o("fp_content_engagement", "property_event", "inferred"), o("fp_site_sessions", "property_event", "inferred")])
    ok(desireOnly.expects_to_move.level === "unknown" && desireOnly.desire_to_move.level === "low" && desireOnly.decision_window.window === "unknown", "activity alone never becomes an EXPECTATION (expects unknown, window unknown)")
  }

  console.log("\nC. canary 6.2 — a documented lease end / planned MLS date narrows the window")
  {
    const lease = moment(buyerObs(), { statedSide: "buyer", knownDeadlines: [{ kind: "lease_end", at: inDays(60), source: "document" }] })
    ok(lease.decision_window.window === "31_90" && lease.decision_window.basis === "stated_date" && lease.decision_window.uncertainty === "low" && lease.segments.includes("renter"), `a documented 60-day lease end → 31_90, stated_date, renter segment (${lease.decision_window.window})`)
    const beats = moment(buyerObs(), { statedSide: "buyer", statedTimeline: { value: "6-12_months", basis: "person_stated", at: daysAgo(5) }, knownDeadlines: [{ kind: "lease_end", at: inDays(60), source: "person_stated" }] })
    ok(beats.decision_window.window === "31_90" && beats.decision_window.basis === "stated_date", "a stated DATE beats the stated bucket (6-12 months → the 60-day lease end wins)")
    const past = moment(buyerObs(), { statedSide: "buyer", knownDeadlines: [{ kind: "lease_end", at: daysAgo(10), source: "document" }] })
    ok(past.known_deadline === null && past.decision_window.basis !== "stated_date" && past.unread.some((u) => /already passed/.test(u)), "(control) a passed date is never a window — said in unread")
    const d = memSupabase({
      contacts: [{ id: "s1", brokerage_id: B, contact_type: "seller", zip_code: "78701", deleted_at: null, equity_estimate: 120000, enrichment_profile: null }],
      listings: [{ id: "L1", brokerage_id: B, seller_contact_id: "s1", status: "listing_signed", go_live_date: inDays(25).slice(0, 10), deleted_at: null, stage_updated_at: daysAgo(2) }],
      movement_signals: [
        { id: "m1", brokerage_id: B, subject_type: "contact", contact_id: "s1", source_key: "fp_calc_seller_net", source_kind: "first_party_behaviour", confidence: "verified", identity_match: "record_key", event_relevance: "property_event", intents: ["home_sale"], side: "seller", evidence: { confidence: "verified", summary: "ran net sheet", reference: { kind: "first_party_row", id: "c1", retrievedAt: daysAgo(3) } }, observed_at: daysAgo(3), outreach: "consent_gated", protected_proxy: false, outcome: null, data_rights: { collection: "first_party" } },
        { id: "m2", brokerage_id: B, subject_type: "contact", contact_id: "s1", source_key: "pr_permit_activity", source_kind: "property_public_record", confidence: "verified", identity_match: "verified_match", event_relevance: "property_event", intents: ["home_sale"], side: "seller", evidence: { confidence: "verified", summary: "permit", reference: { kind: "permit_record", id: "p1", retrievedAt: daysAgo(2) } }, observed_at: daysAgo(2), outreach: "consent_gated", protected_proxy: false, outcome: null, data_rights: { collection: "open_data" } },
      ],
    } as never, { uuidIds: true }) as any
    const hook = await quiet(() => mv.movementSignalsForArbiter(d, { brokerageId: B, contactId: "s1", now: NOW, windowDays: 180 }))
    const m = hook.opportunity?.moment
    ok(m?.decision_window.window === "0_30" && m.known_deadline?.kind === "planned_list_date" && m.known_deadline.source === "first_party_row" && m.seller_readiness.level === "ready", `the listing row's planned MLS go-live date (25 days) → 0_30, seller ready (${m?.decision_window.window}, ${m?.seller_readiness.level})`)
  }

  console.log("\nD. canary 6.3 — an anonymous topic never predicts a person")
  {
    const anon = mm.buildMovingMoment(od.readOpportunities([o("cm_employer_expansion", "community_change", "reported")], { now: NOW }), [], { subjectIsPerson: false }, { now: NOW })
    ok(!anon.personLevel && anon.decision_window.window === "unknown" && anon.buyer_readiness.level === "not_indicated" && /never yields a person-level prediction/.test(anon.decision_window.why), "a non-person subject: no person-level moment, window UNKNOWN, the reason said")
    const ctxOnly = moment([o("cm_employer_expansion", "community_change", "reported")])
    ok(ctxOnly.decision_window.window === "unknown" && ctxOnly.desire_to_move.level === "unknown", "(control) market context on a REAL person still predicts nothing — context never scores")
    const d = memSupabase({ movement_signals: [], agent_action_ledger: [], ai_predictions: [] } as never, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], movement_signals: [["brokerage_id", "idempotency_key"]] } }) as any
    const rec = await quiet(() => mv.recordMovementSignal(d, { brokerageId: B, subject: { type: "territory", territoryKey: "zip:78701" }, sourceKey: "cm_employer_expansion", eventRelevance: "community_change", identity: "none", capturedBy: "staff", observedAt: daysAgo(1), evidence: { confidence: "reported", reportedBy: "third_party", reference: { kind: "news", id: "n1", retrievedAt: daysAgo(1) }, summary: "a public employer announced an expansion nearby" } }, { now: NOW, windowDays: 180 }))
    const preds = ((await d.from("ai_predictions").select("*")).data ?? []) as unknown[]
    ok(rec.status === "recorded" && preds.length === 0, `an anonymous neighbourhood topic recorded end to end → ZERO person-level forecasts (${preds.length})`)
  }

  console.log("\nE. canary 6.4 — mixed evidence is UNKNOWN")
  {
    const mixed = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(4) }, negative: [{ key: "declined", why: "an earlier sign closed as declined", at: daysAgo(1), source: "movement_signals:x" }] })
    ok(mixed.decision_window.window === "unknown" && mixed.buyer_readiness.level === "unknown" && /mixed evidence/.test(mixed.decision_window.why) && mixed.negative_evidence.length === 1, `a decline NEWER than every positive → UNKNOWN (${mixed.decision_window.why})`)
    const older = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) }, negative: [{ key: "declined", why: "old decline", at: daysAgo(40), source: "movement_signals:y" }] })
    ok(older.decision_window.window === "31_90" && older.negative_evidence.length === 1, "(control) an OLDER decline is history: listed as negative evidence, window still placed")
    const justBought = moment(buyerObs(), { statedSide: "buyer", negative: [{ key: "just_purchased", why: "they just closed on a purchase", at: daysAgo(0), source: "transactions:t" }] })
    ok(justBought.decision_window.window === "unknown", "a purchase that just closed contradicts buying signs → UNKNOWN")
  }

  console.log("\nF. calibration — frozen once, graded honestly, published only past the floor")
  {
    const d = memSupabase({ ai_predictions: [] } as never, { uuidIds: true, stampCreatedAt: true }) as any
    const m = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) } })
    const f1 = await apo.freezeDecisionWindowForecast(d, { brokerageId: B, entityType: "contact", entityId: "c1", moment: m, holdoutArm: "treated", evidenceIds: ["e1"], now: NOW })
    const f2 = await apo.freezeDecisionWindowForecast(d, { brokerageId: B, entityType: "contact", entityId: "c1", moment: m, holdoutArm: "treated", evidenceIds: ["e1"], now: NOW })
    const unk = await apo.freezeDecisionWindowForecast(d, { brokerageId: B, entityType: "contact", entityId: "c2", moment: moment([]), holdoutArm: null, evidenceIds: [], now: NOW })
    const rows = ((await d.from("ai_predictions").select("*")).data ?? []) as Array<Record<string, any>>
    ok(f1.captured && !f2.captured && /unchanged/.test(f2.reason) && rows.length === 1 && rows[0].prediction_type === "decision_window" && rows[0].brokerage_id === B && rows[0].confidence_score === null, "a placed window is frozen ONCE in ai_predictions (tenant set, no minted confidence); a re-evaluation does not pad")
    ok(!unk.captured && rows.every((r) => r.entity_id !== "c2"), "an UNKNOWN window is never frozen")
    const appt = await apo.gradeDecisionWindowForecasts(d, { brokerageId: B, entityType: "contact", entityId: "c1", outcome: "appointment", outcomeAt: inDays(10), signalId: "s" })
    ok(appt.graded === 0, "an APPOINTMENT grades nothing — an appointment is not a closing")
    const early = await apo.gradeDecisionWindowForecasts(d, { brokerageId: B, entityType: "contact", entityId: "c1", outcome: "no_change", outcomeAt: inDays(20), signalId: "s" })
    const after = ((await d.from("ai_predictions").select("*")).data ?? []) as Array<Record<string, any>>
    ok(early.graded === 1 && after[0].actual_outcome.kind === "no_move_early" && after[0].actual_outcome.validated === false, "a negative close INSIDE the open window is recorded, never validated")
    await apo.freezeDecisionWindowForecast(d, { brokerageId: B, entityType: "contact", entityId: "c3", moment: m, holdoutArm: "treated", evidenceIds: ["e3"], now: NOW })
    const hit = await apo.gradeDecisionWindowForecasts(d, { brokerageId: B, entityType: "contact", entityId: "c3", outcome: "listed", outcomeAt: inDays(45), signalId: "s3" })
    const g3 = (((await d.from("ai_predictions").select("*").eq("entity_id", "c3")).data ?? []) as Array<Record<string, any>>)[0]
    ok(hit.graded === 1 && g3.actual_outcome.kind === "confirmed_move" && g3.actual_outcome.actual_window === "31_90" && g3.actual_outcome.hit === true && g3.actual_outcome.validated === true, "a confirmed move 45 days later grades the 31_90 forecast as a validated HIT")
    const foreign = await apo.gradeDecisionWindowForecasts(d, { brokerageId: "99999999-9999-4999-8999-999999999999", entityType: "contact", entityId: "c3", outcome: "listed", outcomeAt: inDays(45), signalId: "s3" })
    ok(foreign.graded === 0, "(tenancy) another tenant's outcome grades nothing here")
    const few = sl.calibrateDecisionWindows(Array.from({ length: 49 }, (_, i) => ({ forecast: "31_90", validated: true, hit: i % 2 === 0, kind: "confirmed_move" })))
    const enough = sl.calibrateDecisionWindows(Array.from({ length: 50 }, (_, i) => ({ forecast: "31_90", validated: true, hit: i < 30, kind: "confirmed_move" })))
    ok(few.byWindow["31_90"]?.published === false && few.byWindow["31_90"]?.rate === null && enough.byWindow["31_90"]?.published === true && enough.byWindow["31_90"]?.rate === 0.6 && !!enough.byWindow["31_90"]?.interval, "49 validated → NO probability; 50 → published (0.6, Wilson interval)")
    const withAppts = sl.calibrateDecisionWindows([...Array.from({ length: 50 }, () => ({ forecast: "0_30", validated: false, hit: false, kind: "no_move_early" }))])
    ok(withAppts.byWindow["0_30"] === undefined && withAppts.earlyNegatives === 50, "unvalidated grades never count toward the floor")
    const pub = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) }, calibration: enough })
    const unpub = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) }, calibration: few })
    ok(pub.probability?.rate === 0.6 && pub.probability.validated === 50 && unpub.probability === null && /fewer than 50/.test(unpub.probabilityWhy), "the moment publishes a probability ONLY from a calibrated window; below the floor it says why")
  }

  console.log("\nG. end to end — decision stamps the moment, freezes the forecast; the outcome grades it")
  {
    const d = memSupabase({
      contacts: [{ id: "c1", brokerage_id: B, contact_type: "buyer", agent_id: null, zip_code: "78701", deleted_at: null, opted_out_at: null, timeline: "1-3_months", enrichment_profile: { field_provenance: { timeline: { source: "staff", retrievedAt: daysAgo(5) } } } }],
      buyer_financial_profiles: [{ id: "f1", brokerage_id: B, contact_id: "c1", is_cash_buyer: false, pre_approval_issued_date: daysAgo(20).slice(0, 10), pre_approval_expires_at: inDays(70) }],
      movement_signals: [], agent_action_ledger: [], ai_predictions: [], listings: [], transactions: [], leads: [],
    } as never, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], movement_signals: [["brokerage_id", "idempotency_key"]] } }) as any
    const deps = { now: NOW, windowDays: 180, decide: (async () => { throw new Error("no model in the proof") }) as never, publish: (async () => ({ ok: true })) as never, respond: (async () => ({ action: "recorded" })) as never, routeToAgent: (async () => true) as never, notifyAdmins: async () => 1 }
    await quiet(() => mv.recordMovementSignal(d, { brokerageId: B, subject: { type: "contact", id: "c1" }, sourceKey: "fp_saved_homes", eventRelevance: "property_event", identity: "record_key", capturedBy: "automation", observedAt: daysAgo(2), evidence: { confidence: "verified", reference: { kind: "first_party_row", id: "s1", retrievedAt: daysAgo(2) }, summary: "saved a home in the portal" } }, { ...deps, route: false }))
    const r2 = await quiet(() => mv.recordMovementSignal(d, { brokerageId: B, subject: { type: "contact", id: "c1" }, sourceKey: "pp_reddit_relocation", eventRelevance: "relocation", intents: ["home_purchase"], identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(1), evidence: { confidence: "reported", reportedBy: "self", reference: { kind: "public_post", id: "rd1", retrievedAt: daysAgo(1) }, summary: "asked which neighbourhoods to buy in" } }, deps))
    const rows = ((await d.from("movement_signals").select("*").eq("brokerage_id", B)).data ?? []) as Array<Record<string, any>>
    ok(r2.status === "recorded" && rows.length === 2 && rows.every((r) => r.decision_window === "31_90" && r.moment?.window === "31_90" && (r.decision?.holdout?.arm === "treated" || r.decision?.holdout?.arm === "holdout")), `the decision stamps decision_window, the moment snapshot and the holdout arm on every row (${rows.map((r) => r.decision_window).join(",")})`, JSON.stringify(rows.map((r) => ({ w: r.decision_window, h: r.decision?.holdout }))))
    const preds = ((await d.from("ai_predictions").select("*").eq("brokerage_id", B)).data ?? []) as Array<Record<string, any>>
    ok(preds.length === 1 && preds[0].prediction_value.window === "31_90" && preds[0].prediction_value.basis === "stated_bucket", "the placed window is frozen once in ai_predictions (the staff-recorded 1-3 month timeline)")
    const ledger = ((await d.from("agent_action_ledger").select("*")).data ?? []) as Array<Record<string, any>>
    const dec = ledger.find((l) => l.action === "intent.movement_signal.decide")
    ok(!!dec?.detail?.moment && dec.detail.moment.window === "31_90" && !!dec.detail.experiment?.arm, "the decision's ledger row carries the moment summary and the experiment arm (evidence for every consequential decision)")
    const out = await quiet(() => mv.recordMovementOutcome(d, { brokerageId: B, signalId: rows[0].id, outcome: "purchased", evidence: { t: "x" }, actor: { type: "manager", managerKey: "data_steward" }, now: new Date(NOW.getTime() + 40 * 86_400_000) }))
    const graded = ((await d.from("ai_predictions").select("*").eq("brokerage_id", B)).data ?? []) as Array<Record<string, any>>
    ok(out.status === "recorded" && /1 forecast\(s\) graded/.test(out.reason) && graded[0].actual_outcome?.hit === true, `the outcome door grades the frozen forecast (${out.reason})`)
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); console.log("❌ DECISION_WINDOW_FAIL"); process.exit(1) }
  console.log("✅ DECISION_WINDOW_PASS")
}

main().catch((e) => { console.error(e); console.log("❌ DECISION_WINDOW_FAIL (threw)"); process.exit(1) })
