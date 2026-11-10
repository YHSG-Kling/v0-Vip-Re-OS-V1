#!/usr/bin/env tsx
/**
 * scripts/readiness-dimensions-guard.ts  (npm run test:readiness-dimensions)
 * ────────────────────────────────────────────────────────────────────────
 * WAVE 151, LANE 151E — DIFFERENTIATED BUYER / SELLER READINESS, DECISION-WINDOW INTELLIGENCE, NEXT-BEST-HELPFUL-ACTION,
 * EXISTING-CONTACT CHANGE DETECTION (directive §151E; convergence rows 28 / 29 / 38; owner: "if the person's preferences are not set,
 * then the arbiter decides"). Driven through the REAL survivors — lib/intent/moving-moments.ts, lib/intent/movement-signals.ts,
 * lib/ai-isa/followup-arbiter.ts, lib/analytics/ai-prediction-outcomes.ts, lib/intelligence/strategy-learning.ts,
 * lib/enrichment/customer-360.ts — on an in-memory database. No model (the decide seams are injected), no network, no vendor.
 * Every absence assertion sits beside its positive control.
 *
 *   A. STORED SEPARATELY — five dimensions, five evidence classes (one vocabulary), each dimension with its own class, basis and
 *      source timestamps; no "seller percentage" (a probability only from calibration).
 *   B. contact_type NEVER INTENT — stripped-source scans of every new surface (positive control planted) and a dynamic twin.
 *   C. THE PERSON'S OWN WORDS OUTRANK ENRICHMENT — a stated "staying put" contradicts provider / inferred positives whatever their
 *      age; a NEWER statement by the person wins back; their own bucket places the window over a vendor score; end to end through
 *      the remembered-statement ledger.
 *   D. VENDOR SCORE SEMANTICS — a score moves no dimension and is never a probability; the frozen forecast carries classes, no score.
 *   E. THE FORECASTER CONTRACT — explicit no-window state, verdict (research ≠ ready), classes counted, opposing, timestamps,
 *      cohort calibration published only past the floor (no model-quality claim before it), staleness judged only with a window.
 *   F. STALE / CONTRADICTED SUPPRESSES the outward plays (watch / quiet stay).
 *   G. PREFERENCES UNSET → THE ARBITER DECIDES — the helpful-action frame reaches the model and the ledger; no default cadence.
 *   H. NO SENSITIVE EVENT IN OUTREACH — the frame carries the never-mention words when a life event is decisive.
 *   I. EXISTING CONTACT CHANGE → REASSESSMENT on the SAME contact — never a Lead, never a raw lead, never a provider call; dedup.
 *   J. STATED DATE → knownDeadline WITH ITS QUOTE — the lead-desk door (rows 28 / 29) and the public-post half.
 *   K. NO LAWFUL CHANNEL → the planner HALTS at the arbiter (row 38), with its controls.
 *   L. CUSTOMER 360 reads the stamped dimensions as stored, validated — never computed, never trusted as text.
 *
 * BLIND SPOTS, published: memSupabase has no RLS / CHECK / trigger; the model is never called (prompts are read structurally); the
 * sequence step executor's consumption of `halt` is an Outside-lane diff (the arbiter half is proven here); the crm page graph
 * budget is measured by the lane, not here.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments, blankStrings } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function ok(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await f() } finally { console.warn = w; console.error = e } }
const raw = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")
const src = (p: string) => stripComments(raw(p))
const slice = (s: string, from: string, to: string) => { const i = s.indexOf(from); const j = i >= 0 ? s.indexOf(to, i + from.length) : -1; return i >= 0 && j > i ? s.slice(i, j) : "" }

const B = "11111111-1111-4111-8111-111111111111", B2 = "22222222-2222-4222-8222-222222222222"
const NOW = new Date("2026-11-09T15:00:00.000Z")
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString()

type Obs = import("../lib/intent/opportunity-discovery").OpportunityObservation
let seq = 0
const o = (sourceKey: string, relevance: Obs["relevance"], confidence: Obs["confidence"], extra: Partial<Obs> = {}): Obs =>
  ({ id: `o${++seq}`, sourceKey, relevance, confidence, identity: "record_key", observedAt: daysAgo(3), outreach: "consent_gated", rights: "first_party", ...extra })
const CT = /contact_type|contactType/

async function main() {
  const mm = await import("../lib/intent/moving-moments")
  const od = await import("../lib/intent/opportunity-discovery")
  const mv = await import("../lib/intent/movement-signals")
  const apo = await import("../lib/analytics/ai-prediction-outcomes")
  const sl = await import("../lib/intelligence/strategy-learning")
  const arb = await import("../lib/ai-isa/followup-arbiter")
  const lap = await import("../lib/ai-isa/lead-action-plan")
  const policyMod = await import("../lib/ai-isa/followup-policy")
  const c360 = await import("../lib/enrichment/customer-360")
  const moment = (obs: Obs[], facts: Partial<import("../lib/intent/moving-moments").MovingMomentFacts> = {}) => mm.buildMovingMoment(od.readOpportunities(obs, { now: NOW }), obs, { subjectIsPerson: true, ...facts }, { now: NOW })
  const buyerObs = () => [o("fp_inbound_stated", "relocation", "reported", { intents: ["home_purchase"], side: "buyer" }), o("fp_saved_homes", "property_event", "verified")]
  const enrichmentObs = () => [o("po_online_real_estate_activity", "property_event", "inferred", { identity: "verified_match", observedAt: daysAgo(2) }), o("pr_batchdata_quicklist", "property_event", "reported", { identity: "verified_match", observedAt: daysAgo(1) })]
  const noDims = (m: import("../lib/intent/moving-moments").MovingMoment) => JSON.stringify({ ...m, vendor_scores: undefined, unread: undefined, explanation: undefined })

  console.log("\nA. stored separately — five dimensions × five evidence classes, each with its own class and timestamps")
  {
    ok(JSON.stringify([...mm.EVIDENCE_CLASSES]) === JSON.stringify(["verified_intent", "expressed_interest", "inferred_possibility", "market_level_opportunity", "stale_contradicted"]), "the five evidence classes, one spelling each")
    ok(JSON.stringify([...mm.READINESS_DIMENSIONS]) === JSON.stringify(["desire", "expectation", "feasibility", "timing", "confidence"]), "the five dimensions, one spelling each")
    const m = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", inventory: "available", statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) } })
    const keys = Object.keys(m.dimensions).sort()
    ok(JSON.stringify(keys) === JSON.stringify([...mm.READINESS_DIMENSIONS].sort()) && mm.READINESS_DIMENSIONS.every((k) => m.dimensions[k].dimension === k), "every dimension is on the moment under its own key")
    ok(mm.READINESS_DIMENSIONS.every((k) => (mm.EVIDENCE_CLASSES as readonly string[]).includes(m.dimensions[k].evidenceClass) || m.dimensions[k].evidenceClass === "none") && mm.READINESS_DIMENSIONS.every((k) => Array.isArray(m.dimensions[k].sourceTimestamps) && typeof m.dimensions[k].basis === "string" && typeof m.dimensions[k].why === "string"), "each dimension carries an evidence class from the vocabulary (or none), a basis, a why and source timestamps")
    ok(m.dimensions.desire.evidenceClass === "verified_intent" && m.dimensions.expectation.evidenceClass === "verified_intent" && m.dimensions.feasibility.evidenceClass === "expressed_interest" && m.dimensions.timing.evidenceClass === "verified_intent" && m.dimensions.confidence.level === "high", `a stated buyer with pre-approval and their own 1-3 month timeline: desire / expectation / timing VERIFIED INTENT, feasibility from our records, confidence high (${Object.values(m.dimensions).map((d) => `${d.dimension}:${d.evidenceClass}`).join(", ")})`)
    ok(m.dimensions.desire.evidenceClass !== m.dimensions.feasibility.evidenceClass && m.dimensions.timing.sourceTimestamps.length > 0 && m.dimensions.desire.sourceTimestamps.includes(daysAgo(1)), "the dimensions are DIFFERENTIATED (desire ≠ feasibility class) and the timestamps name when the person spoke")
    ok(m.probability === null && typeof (m as unknown as Record<string, unknown>).readiness_score === "undefined" && !/\d{1,3}\s*%/.test(m.explanation), "no seller percentage anywhere: probability null without calibration, no score field, no % in the explanation")
    const behaviour = moment([o("fp_saved_homes", "property_event", "verified"), o("fp_calc_mortgage_comparison", "property_event", "verified", { observedAt: daysAgo(1) })])
    ok(behaviour.dimensions.desire.evidenceClass === "expressed_interest" && behaviour.dimensions.expectation.evidenceClass === "none" && behaviour.dimensions.expectation.level === "unknown", "the person's own ACTIONS are EXPRESSED INTEREST; with nothing stated the expectation is class `none` (an absence is never inferred)")
    const inferredOnly = moment([o("fp_content_engagement", "property_event", "inferred"), o("po_online_real_estate_activity", "property_event", "inferred", { identity: "verified_match" })])
    ok(inferredOnly.dimensions.desire.evidenceClass === "inferred_possibility" && inferredOnly.dimensions.timing.evidenceClass === "inferred_possibility" && inferredOnly.decision_window.window === "unknown", "inferences alone: INFERRED POSSIBILITY, window unknown")
    const ctx = moment([o("cm_employer_expansion", "community_change", "reported")])
    ok(ctx.dimensions.desire.evidenceClass === "market_level_opportunity" && ctx.forecast.evidenceClasses.market_level_opportunity === 1 && ctx.forecast.verdict === "nothing_to_forecast" && ctx.decision_window.window === "unknown" && /never a person-level forecast/.test(ctx.forecast.why), "market context alone: MARKET-LEVEL OPPORTUNITY — a category for local research / education, never a person-level forecast")
  }

  console.log("\nB. contact_type is never an intent input (scans + a dynamic twin)")
  {
    ok(!CT.test(blankStrings(src("lib/intent/moving-moments.ts"))), "lib/intent/moving-moments.ts (dimensions, forecast, plays): no contact_type")
    const sig = src("lib/intent/movement-signals.ts")
    const door = slice(sig, "export const EXISTING_CONTACT_CHANGE_KINDS", "export const MOVEMENT_RAW_SIGNAL_VIEWERS")
    ok(door.length > 500 && !CT.test(blankStrings(door)), "the existing-contact door (reassessExistingContact and its input builder) never reads contact_type")
    const loader = slice(sig, "async function loadMomentFacts", "const stampedHoldout")
    ok(loader.length > 200 && !CT.test(loader), "loadMomentFacts (now also the remembered-statement reader) never selects contact_type")
    const arbS = src("lib/ai-isa/followup-arbiter.ts")
    const frame = slice(arbS, "function helpfulActionFrame", "export interface ArbiterDecision")
    ok(frame.length > 500 && !CT.test(blankStrings(frame)), "the helpful-action frame reads no contact_type (relationship.type is a label, never a readiness input)")
    const c3 = src("lib/enrichment/customer-360.ts")
    const readiness = slice(c3, "let readiness: C360Readiness | null = null", "intent = { observations, confirmed, observedNotConfirmed, playbooks, readiness }")
    ok(readiness.length > 200 && !CT.test(blankStrings(readiness)), "Customer 360's readiness read never touches contact_type")
    ok(CT.test(blankStrings(stripComments('const x = row.contact_type === "buyer"'))), "(positive control) the finder sees a planted contact_type read")
    const seed = (ct: string) => ({
      contacts: [{ id: "c1", brokerage_id: B, contact_type: ct, zip_code: "78701", deleted_at: null, timeline: "3-6_months", home_owner_status: null, equity_estimate: null, metadata: null, enrichment_profile: { field_provenance: { timeline: { source: "contact", retrievedAt: daysAgo(2) } } } }],
      movement_signals: [
        { id: "m1", brokerage_id: B, subject_type: "contact", contact_id: "c1", source_key: "fp_saved_homes", source_kind: "first_party_behaviour", confidence: "verified", identity_match: "record_key", event_relevance: "property_event", intents: ["home_purchase"], side: "buyer", evidence: { confidence: "verified", summary: "saved", reference: { kind: "first_party_row", id: "s1", retrievedAt: daysAgo(2) } }, observed_at: daysAgo(2), outreach: "consent_gated", protected_proxy: false, outcome: null, data_rights: { collection: "first_party" } },
        { id: "m2", brokerage_id: B, subject_type: "contact", contact_id: "c1", source_key: "pp_reddit_relocation", source_kind: "public_post", confidence: "reported", identity_match: "verified_match", event_relevance: "relocation", intents: ["home_purchase"], side: "buyer", evidence: { confidence: "reported", reportedBy: "self", summary: "asked", reference: { kind: "public_post", id: "r1", retrievedAt: daysAgo(1) } }, observed_at: daysAgo(1), outreach: "consent_gated", protected_proxy: false, outcome: null, data_rights: { collection: "public_web_search" } },
      ],
    })
    const runFor = async (ct: string) => quiet(() => mv.movementSignalsForArbiter(memSupabase(seed(ct) as never, { uuidIds: true }) as never, { brokerageId: B, contactId: "c1", now: NOW, windowDays: 180 }))
    const [buyer, seller, sphere] = await Promise.all([runFor("buyer"), runFor("seller"), runFor("sphere")])
    const dims = (r: typeof buyer) => JSON.stringify(r.opportunity?.moment?.dimensions) + JSON.stringify(r.opportunity?.moment?.forecast)
    ok(!!buyer.opportunity?.moment?.dimensions && dims(buyer) === dims(seller) && dims(seller) === dims(sphere), "the SAME evidence under contact_type buyer / seller / sphere yields IDENTICAL dimensions and forecast")
  }

  console.log("\nC. the person's own words outrank enrichment")
  {
    const stayPut = { key: "stated_staying_put", why: "they told us they are staying put", at: daysAgo(20), source: "conversation_memory:person_words:sms", basis: "person_stated" as const }
    const contradicted = moment(enrichmentObs(), { negative: [stayPut] })
    ok(contradicted.decision_window.window === "unknown" && /own words outrank enrichment/.test(contradicted.decision_window.why) && contradicted.forecast.verdict === "nothing_to_forecast" && contradicted.forecast.opposing[0]?.basis === "person_stated" && contradicted.dimensions.timing.evidenceClass === "stale_contradicted" && contradicted.dimensions.confidence.evidenceClass === "stale_contradicted",
      `a person-stated "staying put" OLDER than the provider positives still contradicts them (${contradicted.decision_window.why})`)
    const recordNeg = moment(enrichmentObs(), { negative: [{ ...stayPut, key: "no_change", basis: "observed" }] })
    ok(recordNeg.decision_window.window !== "unknown" || !/own words/.test(recordNeg.decision_window.why), "(control) the same-aged negative from a RECORD is history under the C37 ordering rule, not the words rule")
    const newerWords = moment(enrichmentObs(), { negative: [stayPut], statedSide: "buyer", statedTimeline: { value: "3-6_months", basis: "person_stated", at: daysAgo(2) } })
    ok(newerWords.decision_window.window === "91_180" && newerWords.decision_window.basis === "stated_bucket" && newerWords.forecast.verdict !== "nothing_to_forecast", "(control) a NEWER statement by the person themselves outranks their earlier 'staying put' — the window is theirs again")
    const theirs = moment(enrichmentObs(), { statedTimeline: { value: "12+_months", basis: "person_stated", at: daysAgo(5) }, vendorScores: [{ provider: "PropertyRadar", field: "LikelyListingScore", value: 95 }] })
    ok(theirs.decision_window.window === "over_365" && theirs.dimensions.timing.evidenceClass === "verified_intent" && theirs.vendor_scores[0].probability === null && theirs.probability === null, "their own '12+ months' places the window over a vendor's 95 LikelyListingScore — the score stays a labelled signal")
    // end to end: the remembered statement on the ONE memory ledger (contacts.metadata.context_spine.facts) reaches the moment
    const spineWith = (facts: unknown[]) => ({ facts })
    const stayFact = { key: "scenario_choice", value: "stay_put", observedAt: daysAgo(10), confidence: 0.9, reviewBy: inDays(100), source: "person_words:sms:m1" }
    const seedE2E = (facts: unknown[]) => ({
      contacts: [{ id: "c1", brokerage_id: B, contact_type: "seller", zip_code: "78701", deleted_at: null, timeline: null, home_owner_status: "owner", equity_estimate: 90000, metadata: { context_spine: spineWith(facts) }, enrichment_profile: null }],
      movement_signals: [
        { id: "m1", brokerage_id: B, subject_type: "contact", contact_id: "c1", source_key: "pr_permit_activity", source_kind: "property_public_record", confidence: "verified", identity_match: "verified_match", event_relevance: "property_event", intents: ["home_sale"], side: "seller", evidence: { confidence: "verified", summary: "permit", reference: { kind: "permit_record", id: "p1", retrievedAt: daysAgo(3) } }, observed_at: daysAgo(3), outreach: "consent_gated", protected_proxy: false, outcome: null, data_rights: { collection: "open_data" } },
        { id: "m2", brokerage_id: B, subject_type: "contact", contact_id: "c1", source_key: "pr_batchdata_quicklist", source_kind: "property_public_record", confidence: "reported", identity_match: "verified_match", event_relevance: "property_event", intents: ["home_sale"], side: "seller", evidence: { confidence: "reported", reportedBy: "provider", summary: "high equity list", reference: { kind: "vendor_compiled_record", id: "q1", retrievedAt: daysAgo(2) } }, observed_at: daysAgo(2), outreach: "consent_gated", protected_proxy: false, outcome: null, data_rights: { collection: "licensed_api" } },
      ],
    })
    const withWords = await quiet(() => mv.movementSignalsForArbiter(memSupabase(seedE2E([stayFact]) as never, { uuidIds: true }) as never, { brokerageId: B, contactId: "c1", now: NOW, windowDays: 180 }))
    const without = await quiet(() => mv.movementSignalsForArbiter(memSupabase(seedE2E([]) as never, { uuidIds: true }) as never, { brokerageId: B, contactId: "c1", now: NOW, windowDays: 180 }))
    ok(withWords.opportunity?.moment?.negative_evidence.some((n) => n.key === "stated_staying_put" && n.basis === "person_stated") === true && withWords.opportunity?.moment?.decision_window.window === "unknown", "END TO END: a remembered 'staying put' (the ONE memory ledger) reaches the moment as a person-stated negative → UNKNOWN")
    ok(!!without.opportunity?.moment && without.opportunity.moment.negative_evidence.length === 0 && without.opportunity.moment.decision_window.window !== withWords.opportunity?.moment?.decision_window.window, `(control) without the statement the same records place a window (${without.opportunity?.moment?.decision_window.window})`)
    const barrierFact = { key: "barrier", value: "must_sell_first", observedAt: daysAgo(4), confidence: 0.9, reviewBy: inDays(100), source: "person_words:email:e1" }
    const withBarrier = await quiet(() => mv.movementSignalsForArbiter(memSupabase(seedE2E([barrierFact]) as never, { uuidIds: true }) as never, { brokerageId: B, contactId: "c1", now: NOW, windowDays: 180 }))
    ok(withBarrier.opportunity?.moment?.barrier.some((b) => b.key === "must_sell_first" && b.basis === "person_stated") === true && withBarrier.opportunity?.moment?.dimensions.feasibility.evidenceClass === "verified_intent", "a remembered barrier ('we have to sell first') becomes a person-stated feasibility CONDITION (verified intent on feasibility)")
    const expired = { ...stayFact, reviewBy: daysAgo(1) }
    const stale = await quiet(() => mv.movementSignalsForArbiter(memSupabase(seedE2E([expired]) as never, { uuidIds: true }) as never, { brokerageId: B, contactId: "c1", now: NOW, windowDays: 180 }))
    ok(stale.opportunity?.moment?.negative_evidence.length === 0, "(control) an EXPIRED memory fact (past review_by) is not read — the ledger's own currency rule holds")
  }

  console.log("\nD. a vendor score keeps its vendor semantics")
  {
    const bare = moment([], {})
    const scored = moment([], { vendorScores: [{ provider: "PropertyRadar", field: "DistressScore", value: 99 }, { provider: "Tracerfy", field: "seller_score", value: 9 }] })
    ok(noDims(bare) === noDims(scored) && scored.dimensions.desire.evidenceClass === "none" && scored.decision_window.window === "unknown", "a DistressScore 99 and a Tracerfy 9 move NO dimension (identical moment but for the labelled scores)")
    ok(scored.vendor_scores.every((v) => v.probability === null && /never a probability of a move/.test(v.label)) && /Tracerfy/.test(scored.vendor_scores[1].label), "every score: probability null, label says it is never a probability of a move")
    const d = memSupabase({ ai_predictions: [] } as never, { uuidIds: true, stampCreatedAt: true }) as never
    const m = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) }, vendorScores: [{ provider: "PropertyRadar", field: "LikelyPurchaseScore", value: 88 }], cohort: { side: "buyer", territory: "78701" } })
    const f = await apo.freezeDecisionWindowForecast(d, { brokerageId: B, entityType: "contact", entityId: "c1", moment: m, holdoutArm: "treated", evidenceIds: ["e1"], now: NOW, cohort: { side: "buyer", territory: "78701" } })
    const row = ((await (d as any).from("ai_predictions").select("*")).data ?? [])[0] as Record<string, any>
    ok(f.captured && row.prediction_factors?.evidence_classes?.timing === "verified_intent" && row.prediction_value?.cohort === "buyer|78701" && !/(?:^|[^\d.])88(?!\d)/.test(JSON.stringify({ factors: row.prediction_factors, value: row.prediction_value, reasoning: row.reasoning ?? null, explanation: row.explanation ?? null })) && !/LikelyPurchaseScore/.test(JSON.stringify(row)), "the frozen forecast carries the dimensions' evidence classes and its cohort — never a vendor score or its value")
  }

  console.log("\nE. the forecaster contract — honest unknown, research ≠ ready, cohort calibration past the floor only")
  {
    const nothing = moment([], {})
    ok(nothing.forecast.state === "no_window" && nothing.forecast.verdict === "nothing_to_forecast" && nothing.forecast.window === "unknown" && nothing.forecast.opposing.length === 0 && nothing.forecast.calibration.published === false, "no evidence: an EXPLICIT no-window state, nothing to forecast, nothing published")
    const research = moment([o("fp_calc_seller_net", "property_event", "verified", { intents: ["home_sale"] }), o("pr_permit_activity", "property_event", "verified", { identity: "verified_match", intents: ["home_sale"] })])
    ok(research.forecast.verdict === "research_opportunity" && research.forecast.state === "window" && research.decision_window.basis === "evidence_prior" && research.forecast.evidenceClasses.expressed_interest === 1 && research.forecast.evidenceClasses.inferred_possibility === 1, `two independent signs with no statement: a PRIOR window, verdict research_opportunity — an opportunity worth research, not a ready customer (${research.forecast.verdict})`)
    const ready = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", inventory: "available", statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) } })
    ok(ready.forecast.verdict === "ready_to_transact" && ready.forecast.state === "window" && ready.forecast.sourceTimestamps.statedAt === daysAgo(1) && ready.forecast.sourceTimestamps.newestNegative === null, "a stated, financed buyer inside 1-3 months: ready_to_transact, with the timestamp of their statement")
    const blocked = moment(buyerObs(), { statedSide: "buyer", financing: "none", statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) } })
    ok(blocked.forecast.verdict === "research_opportunity" && blocked.forecast.state === "window", "(control) the same buyer with NO financing is never 'ready' — desire without feasibility is research, the window stays theirs")
    const samples = (n: number, cohort: string | null) => Array.from({ length: n }, (_, i) => ({ forecast: "31_90", validated: true, hit: i % 2 === 0, kind: "confirmed_move", cohort }))
    const cal = sl.calibrateDecisionWindows([...samples(50, "buyer|78701"), ...samples(49, "seller|78701")])
    ok(cal.byCohort["buyer|78701"]?.["31_90"]?.published === true && cal.byCohort["seller|78701"]?.["31_90"]?.published === false && cal.byWindow["31_90"]?.published === true && cal.byWindow["31_90"]?.validated === 99, "cohort calibration: 50 validated in one cohort publishes, 49 in another does not; the tenant-wide tally still counts both")
    const inCohort = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) }, calibration: cal, cohort: { side: "buyer", territory: "78701" } })
    const otherCohort = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) }, calibration: cal, cohort: { side: "buyer", territory: "73301" } })
    ok(inCohort.probability?.cohort === "buyer|78701" && inCohort.forecast.calibration.cohort === "buyer|78701" && otherCohort.probability?.cohort === null && otherCohort.probability?.validated === 99, "the moment prefers its own published cohort; another cohort falls back to the tenant-wide window and says so")
    const few = sl.calibrateDecisionWindows(samples(49, "buyer|78701"))
    const unpublished = moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) }, calibration: few, cohort: { side: "buyer", territory: "78701" } })
    ok(unpublished.probability === null && /fewer than 50/.test(unpublished.probabilityWhy) && unpublished.forecast.calibration.published === false && unpublished.forecast.calibration.validated === 49, "below the floor NO probability is claimed — the contract says how many validated outcomes exist and the floor")
    ok(mm.decisionWindowCohortKey({ side: "buyer", territory: "787019999" }) === "buyer|78701" && mm.decisionWindowCohortKey({ side: "unknown", territory: null }) === "any|-" && mm.decisionWindowCohortKey(null) === null, "ONE cohort key spelling (side | zip5), shared by the freezer, the calibrator and the moment")
    const old = moment([o("fp_saved_homes", "property_event", "verified", { observedAt: daysAgo(60) }), o("fp_calc_seller_net", "property_event", "verified", { observedAt: daysAgo(70) })], { staleAfterDays: 30 })
    const fresh = moment([o("fp_saved_homes", "property_event", "verified", { observedAt: daysAgo(60) }), o("fp_calc_seller_net", "property_event", "verified", { observedAt: daysAgo(70) })], { staleAfterDays: 90 })
    ok(old.dimensions.confidence.evidenceClass === "stale_contradicted" && old.forecast.verdict === "nothing_to_forecast" && /STALE/.test(old.dimensions.confidence.why) && fresh.dimensions.confidence.evidenceClass !== "stale_contradicted", "evidence older than the tenant's window is STALE (nothing to forecast); (control) inside the window it is not")
    ok(moment([o("fp_saved_homes", "property_event", "verified")]).unread.some((u) => /no staleness window/.test(u)), "with no window given, staleness is NOT judged and the blind spot is published")
  }

  console.log("\nF. stale / contradicted evidence suppresses the outward plays")
  {
    const obs = [o("fp_calc_seller_net", "property_event", "verified", { intents: ["home_sale"] }), o("pr_permit_activity", "property_event", "verified", { identity: "verified_match", intents: ["home_sale"] })]
    const r = od.readOpportunities(obs, { now: NOW })
    const menu = od.opportunityMenu(r, { personIdentified: true, outreachPermitted: true, autonomy: "autonomous", paidResearchAffordable: null })
    const good = mm.buildMovingMoment(r, obs, { subjectIsPerson: true, equity: "positive", knownDeadlines: [{ kind: "planned_list_date", at: inDays(20), source: "first_party_row" }] }, { now: NOW })
    const bad = mm.buildMovingMoment(r, obs, { subjectIsPerson: true, equity: "positive", knownDeadlines: [{ kind: "planned_list_date", at: inDays(20), source: "first_party_row" }], negative: [{ key: "stated_staying_put", why: "they told us they are staying put", at: daysAgo(1), source: "conversation_memory:x", basis: "person_stated" }] }, { now: NOW })
    const pg = mm.readinessPlays(good, menu, r), pb = mm.readinessPlays(bad, menu, r)
    ok(pg.options.find((p) => p.play === "invite")?.status === "eligible", "(control) a seller with a planned list date in 20 days: INVITE eligible")
    ok(pb.options.filter((p) => p.status !== "not_eligible").every((p) => p.play === "watch" || p.play === "stay_quiet") && pb.options.find((p) => p.play === "invite")?.why.includes("stale or contradicted") === true, "the SAME seller who then said 'staying put': every outward play suppressed, watch / quiet remain")
  }

  console.log("\nG. preferences unset → the arbiter decides (the helpful-action frame reaches the model and the ledger)")
  const intent = (score: number) => ({ score, trend: "rising", velocityPerDay: 2, accelerationPerDay2: 0, confidence: "high", independentSources: 3, momentumRank: score, evidence: [] }) as never
  const base = (over: Partial<import("../lib/ai-isa/lead-action-plan").NextBestExperienceInput> = {}): import("../lib/ai-isa/lead-action-plan").NextBestExperienceInput => ({
    now: NOW, subject: "contact", nba: { intent: intent(80), memoryFacts: [] },
    person: { contactType: "buyer", persona: "first_time", hasAssignedAgent: true },
    behavior: { touchpoints7d: 0, lastTouchpointChannel: null, portalEducationViews: 0 },
    transaction: null, education: null, fatigue: { riskLevel: null },
    policy: { complianceHardFlag: false, allowedChannels: ["email", "sms"], autoSendAllowed: true, videoAllowed: true },
    ...over,
  })
  const policy = policyMod.platformFollowupPolicy()
  const contactRow = { id: "C", brokerage_id: B, email: "p@example.test", email_opt_out: false, email_unsubscribed: false, phone: null, tcpa_consent: false, sms_opt_out: false, phone_opt_out: false, call_stop_flag: false, dnc_status: false, direct_mail_opt_out: false, mailing_address: null, mailing_address_verified: false, opt_out_channels: [], has_login: false }
  const readiness = { providers: async () => ({ rows: [{ provider: "sendgrid", category: "email", ready: true }] }), budget: async () => ({ allowed: true, remainingBudget: 100 }), prices: async () => ({ email: 0.001 }) }
  const run = async (input: import("../lib/ai-isa/lead-action-plan").NextBestExperienceInput, deps: { movement?: null | ((...a: never[]) => Promise<unknown>); lifeEventAuthority?: (b: string) => Promise<{ allowed: boolean; reason: string | null }>; reply?: Record<string, unknown> } = {}) => {
    const prompts: Array<Record<string, any>> = []
    const recorded: Array<Record<string, any>> = []
    const db = memSupabase({ contacts: [contactRow], agent_action_ledger: [], signal_reactivations: [], outcome_reconciliations: [] } as never, { uuidIds: true, stampCreatedAt: true }) as never
    const r = await quiet(() => arb.arbitrateAndRecordExperience(db, { brokerageId: B, contactId: "C", input, plan: lap.planNextBestExperience(input), now: NOW, systemSource: "t", policy }, {
      decide: async (a) => { prompts.push(JSON.parse(a.prompt)); return { optionId: "wait", channel: null, waitHours: 24, rationale: "Nothing new since their last visit — a short hold serves them.", evidence: ["helpfulActions", "history"], confidence: 0.8, ...(deps.reply ?? {}) } },
      record: { ledger: async (ctx: Record<string, unknown>, fn: () => Promise<unknown>) => { recorded.push(ctx); return fn() }, emit: async () => ({ inserted: true }), delegate: async () => ({ ok: true, delegation: { id: "d1" } }) } as never,
      readiness, movement: deps.movement === undefined ? null : (deps.movement as never), lifeEventAuthority: deps.lifeEventAuthority,
    }))
    return { r, prompt: prompts[0], recorded }
  }
  {
    const unset = await run(base())
    const frame = unset.prompt?.evidence?.helpfulActions
    ok(!!frame && frame.preferencesStated === false && frame.cadence === "arbiter_decides" && /the arbiter decides/.test(frame.weighed.statedPreference), "preferences UNSET → the frame says the arbiter decides the timing; no default cadence")
    ok(!!frame && JSON.stringify(Object.keys(frame.options).sort()) === JSON.stringify([...arb.HELPFUL_ACTIONS].sort()) && Object.keys(frame.weighed).sort().join() === "channelConsent,humanApproval,messageSuitability,relationshipFatigue,statedPreference,timeSinceLastResponse", "the six helpful actions and the six things they are weighed against are all named")
    ok(!!frame && frame.options.authorized_channel.eligible === true && /email/.test(frame.options.authorized_channel.why) && frame.options.wait.eligible === true && frame.options.agent_coordination.eligible === true, `with a permitted email and an assigned agent: an authorized channel, a person and WAIT are eligible (${Object.entries(frame?.options ?? {}).filter(([, v]) => (v as { eligible: boolean }).eligible).map(([k]) => k).join(", ")})`)
    ok(unset.r.decision?.source === "ai" && unset.r.decision.evidence.includes("helpfulActions"), "the model may cite the frame as evidence and its wait is honoured")
    const arbitration = unset.recorded.find((c) => c.detail && (c.detail as Record<string, any>).arbitration)?.detail as Record<string, any> | undefined
    ok(!!arbitration?.arbitration?.helpful_actions && arbitration.arbitration.helpful_actions.cadence === "arbiter_decides" && arbitration.arbitration.helpful_actions.preferences_stated === false && Array.isArray(arbitration.arbitration.helpful_actions.eligible), "LAW 5: the ledger row carries which helpful actions were eligible, what they were weighed against, and that no cadence applied")
    ok(!/every \d+ days|day \d+ of|drip/.test(JSON.stringify(unset.prompt)), "the prompt carries no drip or day-N schedule")
    const fewer = await run(base({ nba: { intent: intent(80), memoryFacts: [{ key: "contact_frequency", value: "fewer", confidence: 0.9, observedAt: daysAgo(2) }, { key: "channel_preference", value: "email", confidence: 0.9, observedAt: daysAgo(2) }] } }))
    const f2 = fewer.prompt?.evidence?.helpfulActions
    ok(!!f2 && f2.preferencesStated === true && f2.cadence === "person_stated" && f2.options.authorized_channel.eligible === false && /fewer/.test(f2.options.authorized_channel.why) && f2.options.education.eligible === false, "(control) 'fewer messages please' is honoured: cadence person_stated, outbound and even a lesson held back")
    const moderate = await run(base({ fatigue: { riskLevel: "moderate" } }))
    const high = await run(base({ fatigue: { riskLevel: "high" } }))
    ok(moderate.prompt?.evidence?.helpfulActions?.weighed.relationshipFatigue === "moderate" && high.r.plan.chosen.kind === "wait", "relationship fatigue is weighed: moderate fatigue is named in the frame; high fatigue is the planner's own hold (lead-action-plan FATIGUE_WAIT_LEVELS) before the arbiter is asked")
    ok(/NO default cadence or drip/.test(arb.ARBITER_SYSTEM) && /Never name a sensitive inferred life event/.test(arb.ARBITER_SYSTEM) && /trusted relationship before anyone else is called/.test(arb.ARBITER_SYSTEM), "the arbiter's brief says it in words: no default cadence, no sensitive event named, trust before a competitor")
  }

  console.log("\nH. a sensitive inferred life event is never named in unsolicited outreach")
  {
    const lifeEvent = async () => ({ signals: [{ type: "life_event", kind: "life_event", strength: 60, daysAgo: 3, evidence: { grounded: true, identityConfirmed: true, lifeEvent: "divorce", source: "movement_signals" } }], helpers: [], blindSpot: null, opportunity: null })
    const le = await run(base(), { movement: lifeEvent as never, lifeEventAuthority: async () => ({ allowed: false, reason: "no explicit grant" }) })
    const frame = le.prompt?.evidence?.helpfulActions
    ok(!!frame && frame.neverMention.length > 0 && /never name it/.test(frame.weighed.messageSuitability) && /a person approves/.test(frame.weighed.humanApproval), `a decisive life event: the frame names the words no message may carry (${frame?.neverMention.length}) and that a person approves`)
    ok((le.r.decision?.lifeEvent?.neverMention.length ?? 0) > 0 && le.r.decision?.kind === "wait" && frame?.options.authorized_channel.eligible === false, "the decision keeps the life-event guard (never-mention words), no automated outbound is eligible without the tenant's grant, and quiet monitoring is the answer")
    const plain = await run(base())
    ok(plain.prompt?.evidence?.helpfulActions?.neverMention.length === 0, "(control) with no sensitive evidence the never-mention list is empty")
    const briefs = mm.readinessPlays(moment(buyerObs(), { statedSide: "buyer", financing: "pre_approved", statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) } }), od.opportunityMenu(od.readOpportunities(buyerObs(), { now: NOW }), { personIdentified: true, outreachPermitted: true, autonomy: "autonomous", paidResearchAffordable: null }), od.readOpportunities(buyerObs(), { now: NOW })).options.map((p) => p.brief ?? "").join(" ")
    ok(/Never mention what was observed, where it came from, any life event, a score or a probability/.test(briefs), "every outward play brief carries the never-mention rule for the writer")
  }

  console.log("\nI. an existing contact's change → reassessment on the SAME contact (never a Lead, never a provider bill)")
  const deps = { now: NOW, windowDays: 180, decide: (async () => { throw new Error("no model in the proof") }) as never, publish: (async () => ({ ok: true })) as never, respond: (async () => ({ action: "recorded" })) as never, routeToAgent: (async () => true) as never, notifyAdmins: async () => 1 }
  const world = () => memSupabase({
    contacts: [{ id: "c1", brokerage_id: B, contact_type: "seller", agent_id: null, zip_code: "78701", deleted_at: null, opted_out_at: null, timeline: null, equity_estimate: 150000, home_owner_status: "owner", metadata: null, enrichment_profile: null }],
    movement_signals: [], agent_action_ledger: [], ai_predictions: [], listings: [], transactions: [], leads: [], raw_scraped_leads: [], buyer_financial_profiles: [], ai_tool_usage: [], vendor_spend: [],
  } as never, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], movement_signals: [["brokerage_id", "idempotency_key"]] } }) as never
  {
    ok(Object.keys(mv.EXISTING_CONTACT_CHANGE_DOORS).length === mv.EXISTING_CONTACT_CHANGE_KINDS.length && mv.EXISTING_CONTACT_CHANGE_KINDS.every((k) => k in mv.EXISTING_CONTACT_CHANGE_DOORS) && Object.values(mv.EXISTING_CONTACT_CHANGE_DOORS).every((d) => /arbitrate|same path/.test(d.via) && d.sourceKey.startsWith("fp_")), "one documented door per change kind (derived from EXISTING_CONTACT_CHANGE_KINDS, never a hand count), every one a FIRST-PARTY source ending in the arbiter")
    const d = world()
    const r1 = await quiet(() => mv.reassessExistingContact(d, { brokerageId: B, contactId: "c1", change: { kind: "valuation_request", referenceId: "v1", summary: "asked what their home is worth", at: daysAgo(1) } }, deps))
    const rows = ((await (d as any).from("movement_signals").select("*")).data ?? []) as Array<Record<string, any>>
    ok(r1.status === "reassessed" && r1.sameContact === true && r1.newLeadCreated === false && r1.providerCalls === 0 && rows.length === 1 && rows[0].subject_type === "contact" && rows[0].contact_id === "c1" && rows[0].source_key === "fp_valuation_request", `a valuation request on an existing contact → ONE C9 record on that contact, reassessed (${r1.status}: ${r1.reason})`)
    ok(((await (d as any).from("leads").select("*")).data ?? []).length === 0 && ((await (d as any).from("raw_scraped_leads").select("*")).data ?? []).length === 0 && ((await (d as any).from("ai_tool_usage").select("*")).data ?? []).length === 0, "no Lead, no raw lead, no provider spend row was written")
    const ledger = ((await (d as any).from("agent_action_ledger").select("*")).data ?? []) as Array<Record<string, any>>
    ok(ledger.some((l) => l.action === "intent.movement_signal.record") && ledger.some((l) => l.action === "intent.movement_signal.decide" && l.detail?.moment?.dimensions), "LAW 5: the record and the decision are ledgered, the decision with the dimensions")
    ok(!!rows[0].moment?.dimensions && !!rows[0].moment?.forecast && typeof rows[0].decision_window === "string", "the stamped snapshot (m970 moment) carries the five dimensions and the forecast — no second store")
    const again = await quiet(() => mv.reassessExistingContact(d, { brokerageId: B, contactId: "c1", change: { kind: "valuation_request", referenceId: "v1", summary: "asked what their home is worth", at: daysAgo(1) } }, deps))
    ok(again.status === "replayed" && ((await (d as any).from("movement_signals").select("*")).data ?? []).length === 1, "DEDUP: the same change observed twice is one record (replayed)")
    const foreign = await quiet(() => mv.reassessExistingContact(d, { brokerageId: B2, contactId: "c1", change: { kind: "saved_home_shift", referenceId: "s9", summary: "saved a home in a new area", at: daysAgo(1) } }, deps))
    ok(foreign.status !== "reassessed" && (foreign.evaluation?.status === "refused" || foreign.status === "refused" || foreign.status === "recorded_no_decision") && !((await (d as any).from("movement_signals").select("*")).data ?? []).some((r: Record<string, any>) => r.brokerage_id === B2 && r.decision_window), "(tenancy) another tenant cannot have this contact reassessed")
    const one = await quiet(() => mv.reassessExistingContact(world(), { brokerageId: B, contactId: "c1", change: { kind: "criteria_change", referenceIds: ["k1"], fields: ["price"], at: daysAgo(1) } }, deps))
    ok(one.status === "refused" && /never a pattern/.test(one.reason), "one criteria change is never a pattern (refused with the reason)")
    const oneRead = await quiet(() => mv.reassessExistingContact(world(), { brokerageId: B, contactId: "c1", change: { kind: "education_engagement", referenceIds: ["b1"], topic: "selling your home", at: daysAgo(1) } }, deps))
    ok(oneRead.status === "refused" && /repeated/.test(oneRead.reason), "one read of a lesson is not repeated engagement (refused)")
    const badKind = await quiet(() => mv.reassessExistingContact(world(), { brokerageId: B, contactId: "c1", change: { kind: "won_the_lottery" } as never }, deps))
    ok(badKind.status === "refused", "(control) an unknown change kind is refused")
  }

  console.log("\nJ. a stated date → knownDeadline with its quote (rows 28 / 29)")
  {
    const d = world()
    const r = await quiet(() => mv.reassessExistingContact(d, { brokerageId: B, contactId: "c1", capturedBy: "staff", change: { kind: "stated_date", deadline: { kind: "lease_end", at: inDays(60) }, quote: "our lease is up at the end of June", referenceId: "lead_desk:u1:now", at: daysAgo(0) } }, deps))
    const row = (((await (d as any).from("movement_signals").select("*")).data ?? []) as Array<Record<string, any>>)[0]
    ok(r.status === "reassessed" && row?.known_deadline_kind === "lease_end" && typeof row?.known_deadline_at === "string" && row?.confidence === "reported" && row?.evidence?.reportedBy === "self" && row?.evidence?.reference?.quote === "our lease is up at the end of June", "a date the person told us: m970 known_deadline_kind / _at on the row, reported by self, the QUOTE on the reference")
    ok(row?.decision_window === "31_90" && row?.moment?.known_deadline?.kind === "lease_end" && row?.moment?.dimensions?.timing?.evidence_class === "verified_intent" && row?.moment?.window_basis === "stated_date", `the forecaster places the window on the stated date (${row?.decision_window}, ${row?.moment?.window_basis}) — timing is VERIFIED INTENT`)
    const noQuote = await quiet(() => mv.reassessExistingContact(world(), { brokerageId: B, contactId: "c1", change: { kind: "stated_date", deadline: { kind: "lease_end", at: inDays(60) }, quote: "", referenceId: "x", at: daysAgo(0) } }, deps))
    ok(noQuote.status === "refused" && /quote/.test(noQuote.reason), "a date WITHOUT the person's words is refused — never a date without its source")
    const bucket = await quiet(() => mv.reassessExistingContact(world(), { brokerageId: B, contactId: "c1", change: { kind: "stated_timeline", bucket: "3-6", quote: "probably in the fall", referenceId: "y", at: daysAgo(0), side: "seller" } }, deps))
    const brow = (((await (d as any).from("movement_signals").select("*")).data ?? []) as Array<Record<string, any>>)[0]
    ok(bucket.status === "reassessed" && !!brow, "a stated timeline bucket with its quote is recorded the same way")
    const bad = await quiet(() => mv.reassessExistingContact(world(), { brokerageId: B, contactId: "c1", change: { kind: "stated_timeline", bucket: "30-60-90", quote: "in 30 to 60 days", referenceId: "z", at: daysAgo(0) } }, deps))
    ok(bad.status === "refused" && /not a timeline bucket/.test(bad.reason), "(control) a 30/60/90 spelling is no timeline bucket (CLAUDE.md §5)")
    // the public-post half (row 28): the author's own date in their own words → a known deadline; third party / past / far-out → none
    const reading = (over: Partial<import("../lib/intent/movement-signals").MovementTextClassification> = {}): import("../lib/intent/movement-signals").MovementTextClassification =>
      ({ relevant: true, eventRelevance: "relocation", about: "author", side: "buyer", timelineBucket: "unknown", statedDate: inDays(45).slice(0, 10), quote: "we move to Austin on the first", needsPerson: false, note: "", source: "ai", ...over })
    const post = (rd: import("../lib/intent/movement-signals").MovementTextClassification) => mv.movementSignalFromPublicPost({ brokerageId: B, subject: { type: "contact", id: "c1" }, sourceKey: "pp_reddit_relocation", postId: "p1", postedAt: daysAgo(2), retrievedAt: daysAgo(1), reading: rd })
    const own = post(reading())
    ok(own.ok && own.record.knownDeadline?.kind === "relocation_start" && !!own.record.knownDeadline?.at && own.record.evidence.confidence === "reported", "a public post in the author's OWN voice naming a date → knownDeadline relocation_start (reported by self, quote on the reference)")
    const third = post(reading({ about: "third_party" }))
    ok(third.ok && third.record.knownDeadline === null && third.record.confidence === "inferred", "(control) a third party's post carries no date and is only an inference")
    const past = post(reading({ statedDate: daysAgo(30).slice(0, 10) }))
    const far = post(reading({ statedDate: inDays(900).slice(0, 10) }))
    ok(past.ok && past.record.knownDeadline === null && far.ok && far.record.knownDeadline === null, "(controls) a date before the post, or more than two years out, is no deadline")
    const seller = mv.movementSignalFromPublicPost({ brokerageId: B, subject: { type: "contact", id: "c1" }, sourceKey: "pp_agent_seeking_phrase", postId: "p2", postedAt: daysAgo(2), retrievedAt: daysAgo(1), reading: reading({ eventRelevance: "seeking_agent", side: "seller", statedDate: inDays(30).slice(0, 10), quote: "we list the house March 1, need a realtor" }) })
    ok(seller.ok && seller.record.knownDeadline?.kind === "planned_list_date", `a seller asking for an agent and naming a date → planned_list_date (${seller.ok ? seller.record.knownDeadline?.kind : (seller as { reason: string }).reason})`)
    const classified = await mv.classifyPublicMovementText({ brokerageId: B, text: "We are moving to Denver, lease is up 2027-01-31, any neighborhood tips?", sourceKey: "pp_reddit_relocation" }, { classify: async () => ({ relevant: true, event_relevance: "relocation", about: "author", side: "buyer", timeline_bucket: "unknown", stated_date: "2027-01-31", quote: "lease is up 2027-01-31", needs_person: false, note: "x" }) })
    ok(classified.statedDate === "2027-01-31" && /stated_date/.test(mv.MOVEMENT_CLASSIFIER_SYSTEM) && /never a guess from a season/.test(mv.MOVEMENT_CLASSIFIER_SYSTEM), "the classifier reads a stated_date only beside an author-voiced verbatim quote, and its brief forbids guessing one")
    const guessed = await mv.classifyPublicMovementText({ brokerageId: B, text: "Thinking about Denver sometime", sourceKey: "pp_reddit_relocation" }, { classify: async () => ({ relevant: true, event_relevance: "relocation", about: "third_party", side: "buyer", timeline_bucket: "unknown", stated_date: "2027-01-31", quote: "Thinking about Denver", needs_person: false, note: "x" }) })
    ok(guessed.statedDate === null, "(control) a date on a third-party reading is dropped")
    // the PRODUCER half of row 28 (lane 151E's hint, built by lane 151L): an ingress that states the author's date on the C35 envelope
    // → verbatim at evidence.stated_date → the watcher hands it to the public-post builder → a known deadline under the author rule.
    {
      const rt = await import("../lib/lead-pipeline/raw-record-types")
      const envCtx = { brokerageId: B, rights: { rights: "licensed_vendor", licence: "x" }, entityKindOf: () => null, actorType: "cron" as const, costUsd: null }
      const rec = (statedDate: unknown) => ({ source: "reddit_relocation", sourceRecordId: "t3_abc", fullName: "A Poster", city: "Austin", state: "TX", rawPayload: {}, envelope: { statedDate } }) as never
      const hint = { kind: "lease_end", at: inDays(60).slice(0, 10), quote: "our lease is up June 30 and we're moving to Austin" }
      const stored = rt.buildRawDataEnvelope(rec(hint), envCtx as never)
      ok(JSON.stringify(stored.evidence.stated_date) === JSON.stringify(hint), "the producer stores the ingress's stated-date hint VERBATIM at evidence.stated_date (kind, date, the author's quote)")
      const dropped = [rt.buildRawDataEnvelope(rec({ ...hint, quote: "" }), envCtx as never), rt.buildRawDataEnvelope(rec({ ...hint, at: "soon" }), envCtx as never), rt.buildRawDataEnvelope(rec(null), envCtx as never)]
      ok(dropped.every((e) => !("stated_date" in e.evidence)), "(controls) no quote, no date, or no hint → nothing is stored (a date is never invented from a season or 'soon')")
      const viaHint = mv.movementSignalFromPublicPost({ brokerageId: B, subject: { type: "raw_lead", id: "r1" }, sourceKey: "pp_reddit_relocation", postId: "p3", postedAt: daysAgo(2), retrievedAt: daysAgo(1), reading: reading({ statedDate: null }), statedDate: hint })
      ok(viaHint.ok && viaHint.record.knownDeadline?.kind === "lease_end" && typeof viaHint.record.knownDeadline?.at === "string", "the watcher's path: a classifier reading with NO date of its own + the envelope hint → knownDeadline lease_end from the hint")
      const classifierWins = mv.movementSignalFromPublicPost({ brokerageId: B, subject: { type: "raw_lead", id: "r1" }, sourceKey: "pp_reddit_relocation", postId: "p3", postedAt: daysAgo(2), retrievedAt: daysAgo(1), reading: reading(), statedDate: hint })
      ok(classifierWins.ok && classifierWins.record.knownDeadline?.kind === "relocation_start", "the classifier's own date wins over the hint when both exist (it read the text the row carries)")
      const hintThird = mv.movementSignalFromPublicPost({ brokerageId: B, subject: { type: "raw_lead", id: "r1" }, sourceKey: "pp_reddit_relocation", postId: "p3", postedAt: daysAgo(2), retrievedAt: daysAgo(1), reading: reading({ about: "third_party", statedDate: null }), statedDate: hint })
      const hintBadKind = mv.movementSignalFromPublicPost({ brokerageId: B, subject: { type: "raw_lead", id: "r1" }, sourceKey: "pp_reddit_relocation", postId: "p3", postedAt: daysAgo(2), retrievedAt: daysAgo(1), reading: reading({ statedDate: null }), statedDate: { ...hint, kind: "move_in_soon" } })
      const hintPast = mv.movementSignalFromPublicPost({ brokerageId: B, subject: { type: "raw_lead", id: "r1" }, sourceKey: "pp_reddit_relocation", postId: "p3", postedAt: daysAgo(2), retrievedAt: daysAgo(1), reading: reading({ statedDate: null }), statedDate: { ...hint, at: daysAgo(30).slice(0, 10) } })
      ok(hintThird.ok && hintThird.record.knownDeadline === null && hintBadKind.ok && hintBadKind.record.knownDeadline === null && hintPast.ok && hintPast.record.knownDeadline === null, "(controls) the hint is refused when the post is about a third party, when its kind is not a KNOWN_DEADLINE_KINDS word, or when the date precedes the post")
      const watcher = src("lib/intent/movement-source-watcher.ts")
      ok(/rawdata\?\.evidence\?\.stated_date/.test(watcher) && /statedDate,?\s*\n?\s*\}\)/.test(slice(watcher, "function acquisitionPostsSource", "\n}\n")), "the watcher reads normalized_preview.rawdata.evidence.stated_date and hands it to movementSignalFromPublicPost")
    }
    // the lead-desk door (row 29): a real product consumer OFF the crm page graph
    const act = src("app/actions/movement-signals.ts")
    ok(/export async function recordStatedDateAction\(/.test(act) && /reassessExistingContact\(/.test(act) && /await leadDeskSeat\(\)/.test(slice(act, "export async function recordStatedDateAction", "\n}\n")) && /quote\.length < 5/.test(act), "the lead-desk action records the date through reassessExistingContact, behind the lead-desk seat gate, with the quote required")
    const client = src("app/dashboard/intelligence/movement-signals/movement-signals-client.tsx")
    ok(/recordStatedDateAction\(/.test(client) && /They told us a date/.test(raw("app/dashboard/intelligence/movement-signals/movement-signals-client.tsx")) && /required/.test(client), "the lead-desk screen has the 'They told us a date' door with the words required")
    ok(!/MOVEMENT_RAW_SIGNAL_VIEWERS\.has\(/.test("const ok = true"), "(positive control) the gate finder sees nothing in a line without the gate")
  }

  console.log("\nK. no lawful channel left → the planner halts at the arbiter (row 38)")
  {
    const smsOnly = { id: "p1", brokerage_id: B, email: null, email_opt_out: false, email_unsubscribed: false, phone: "+15125550100", tcpa_consent: true, sms_opt_out: true, phone_opt_out: true, call_stop_flag: false, dnc_status: false, direct_mail_opt_out: false, mailing_address: null, mailing_address_verified: false, opt_out_channels: [], has_login: false }
    const emailToo = { ...smsOnly, id: "p2", email: "p@example.test" }
    const db = memSupabase({ contacts: [smsOnly, emailToo], agent_action_ledger: [] } as never, { uuidIds: true, stampCreatedAt: true }) as never
    const option = { id: "send_now", kind: "communication" as const, channels: [], why: ["step 2 of the tenant's sequence (sms) is due"] }
    const halted = await quiet(() => arb.arbitratePlannedTouch(db, { brokerageId: B, planner: "sequence_step", subject: { type: "contact", id: "p1" }, now: NOW, options: [option], planned: "send_now", moment: { key: "sequence_step_due", intent: "x" }, requiredChannels: ["sms"], policy }, { decide: async () => { throw new Error("never asked") } }))
    ok(halted.halt?.reason === "no_lawful_channel" && halted.halt.required.includes("sms") && halted.halt.suggestedEnrollmentStatus === "unenrolled" && halted.decision.fallbackReason === "no_lawful_channel" && /opted out of texts/.test(JSON.stringify(halted.halt.refusals)), `a text-only step for a person who opted out of texts HALTS at the arbiter (${halted.decision.rationale.slice(0, 90)}…)`)
    const ledger = ((await (db as any).from("agent_action_ledger").select("*")).data ?? []) as Array<Record<string, any>>
    ok(halted.recorded && ledger.some((l) => l.action === "followup.decision.do_nothing" && l.detail?.halt?.reason === "no_lawful_channel" && l.subject_id === "p1"), "LAW 5: the halt is one ledgered non-action naming the refused channels")
    const lawful = await quiet(() => arb.arbitratePlannedTouch(db, { brokerageId: B, planner: "sequence_step", subject: { type: "contact", id: "p2" }, now: NOW, options: [option], planned: "send_now", moment: { key: "sequence_step_due", intent: "x" }, requiredChannels: ["email", "sms"], policy }, { decide: async () => ({ optionId: "send_now", channel: null, waitHours: null, rationale: "Email is lawful and the step is due.", evidence: ["moment"], confidence: 0.9 }) }))
    ok(lawful.halt === null && lawful.choice === "send_now", "(control) when one required channel is still lawful (email) nothing halts")
    const unknownChannels = await quiet(() => arb.arbitratePlannedTouch(db, { brokerageId: B, planner: "sequence_step", subject: { type: "contact", id: "p1" }, now: NOW, options: [option], planned: "send_now", moment: { key: "sequence_step_due", intent: "x" }, policy }, { decide: async () => ({ optionId: "send_now", channel: null, waitHours: null, rationale: "Due now.", evidence: ["moment"], confidence: 0.9 }) }))
    ok(unknownChannels.halt === null, "(control) with no channel named by the planner or its options, no halt is judged (the dispatcher's gates still refuse)")
    const lead = await quiet(() => arb.arbitratePlannedTouch(db, { brokerageId: B, planner: "sequence_step", subject: { type: "lead", id: "L1" }, now: NOW, options: [option], planned: "send_now", moment: { key: "sequence_step_due", intent: "x" }, requiredChannels: ["sms"], policy }, { decide: async () => ({ optionId: "send_now", channel: null, waitHours: null, rationale: "Due now.", evidence: ["moment"], confidence: 0.9 }) }))
    ok(lead.halt === null, "(control) a lead subject is not judged here (the lead roster's policy decides)")
    const reply = await quiet(() => arb.arbitratePlannedTouch(db, { brokerageId: B, planner: "unattended_answer", subject: { type: "contact", id: "p1" }, now: NOW, options: [{ id: "answer", kind: "communication" as const, channels: ["sms"], why: ["the client wrote to us by text"] }], planned: "answer", moment: { key: "unattended_answer", intent: "x" }, policy }, { decide: async () => ({ optionId: "answer", channel: "sms", waitHours: null, rationale: "They asked by text; answer them there.", evidence: ["moment"], confidence: 0.9 }), record: false }))
    ok(reply.halt === null && reply.choice === "answer", "(control) a REPLY the person asked for (the unattended answer) is never halted — answering someone who wrote to us is not a sequence send")
    const unreadable = await quiet(() => arb.arbitratePlannedTouch(memSupabase({ contacts: [smsOnly], agent_action_ledger: [] } as never, { refuse: { contacts: "RLS" } }) as never, { brokerageId: B, planner: "sequence_step", subject: { type: "contact", id: "p1" }, now: NOW, options: [option], planned: "send_now", moment: { key: "sequence_step_due", intent: "x" }, requiredChannels: ["sms"], policy }, { decide: async () => ({ optionId: "send_now", channel: null, waitHours: null, rationale: "Due now.", evidence: ["moment"], confidence: 0.9 }), record: false }))
    ok(unreadable.halt === null, "(fail closed to no judgment) an unreadable contact never decides a halt")
    const foreign = await quiet(() => arb.arbitratePlannedTouch(db, { brokerageId: B2, planner: "sequence_step", subject: { type: "contact", id: "p1" }, now: NOW, options: [option], planned: "send_now", moment: { key: "sequence_step_due", intent: "x" }, requiredChannels: ["sms"], policy }, { decide: async () => ({ optionId: "send_now", channel: null, waitHours: null, rationale: "Due now.", evidence: ["moment"], confidence: 0.9 }), record: false }))
    ok(foreign.halt === null, "(tenancy) another tenant's read of this contact decides nothing")
    ok(/requiredChannels/.test(src("lib/ai-isa/followup-arbiter.ts")) && /requiredChannels: \[step\.channel\]/.test(src("lib/campaign-sequences/step-executor.ts")) && /if \(arb\.halt\)/.test(src("lib/campaign-sequences/step-executor.ts")) && /suggestedEnrollmentStatus/.test(src("lib/campaign-sequences/step-executor.ts")), "the sequence step executor passes its step channel (requiredChannels) and CONSUMES `halt` — the enrollment is ended once and the step is skipped with the arbiter's rationale (150Z row 38 closed; wave 151 integrator)")
  }

  console.log("\nL. Customer 360 reads the stamped dimensions as stored, validated")
  {
    const dims = { desire: { level: "strong", evidence_class: "verified_intent", basis: "person_stated", why: "they said", source_timestamps: [daysAgo(1)] }, expectation: { level: "expects", evidence_class: "verified_intent", basis: "person_stated", why: "their timeline", source_timestamps: [] }, feasibility: { level: "able", evidence_class: "expressed_interest", basis: "verified_record", why: "financing ok", source_timestamps: [] }, timing: { level: "31_90", evidence_class: "made_up_class", basis: "person_stated", why: "x", source_timestamps: [] }, confidence: { level: "high", evidence_class: "verified_intent", basis: "person_stated", why: "x", source_timestamps: [] } }
    const db = memSupabase({
      contacts: [{ id: "c1", brokerage_id: B, contact_type: "buyer", email: "a@b.test", phone: null, deleted_at: null, timeline: null, enrichment_profile: null, metadata: null, agent_id: null, team_id: null }],
      movement_signals: [{ id: "m1", brokerage_id: B, subject_type: "contact", contact_id: "c1", decision_window: "31_90", decided_at: daysAgo(1), moment: { window: "31_90", dimensions: dims, forecast: { state: "window", verdict: "ready_to_transact", opposing: [], calibration: { published: false } } } }],
      signal_reactivations: [],
    } as never, { uuidIds: true }) as never
    const v = await quiet(() => c360.customer360For(db, B, { type: "contact", id: "c1" }, { now: NOW, slices: ["intent"] }))
    const rd = v.ok ? v.view.intent?.readiness : null
    ok(!!rd && rd.source === "movement_signals.moment" && rd.window === "31_90" && rd.dimensions.desire.evidenceClass === "verified_intent" && rd.dimensions.desire.sourceTimestamps.length === 1 && rd.forecast?.verdict === "ready_to_transact", "the readiness slice is the stamped snapshot: five dimensions with their classes and timestamps, the verdict")
    ok(!!rd && rd.dimensions.timing.evidenceClass === "none", "a stored class outside the vocabulary reads as `none` — never trusted as text")
    const none = await quiet(() => c360.customer360For(memSupabase({ contacts: [{ id: "c2", brokerage_id: B, contact_type: "buyer", email: "a@b.test", deleted_at: null, metadata: null, enrichment_profile: null }], movement_signals: [], signal_reactivations: [] } as never, { uuidIds: true }) as never, B, { type: "contact", id: "c2" }, { now: NOW, slices: ["intent"] }))
    ok(none.ok && none.view.intent?.readiness === null, "(control) no stamped moment → readiness null (never 'not ready')")
    const refused = await quiet(() => c360.customer360For(memSupabase({ contacts: [{ id: "c1", brokerage_id: B, contact_type: "buyer", email: "a@b.test", deleted_at: null, metadata: null, enrichment_profile: null }], movement_signals: [], signal_reactivations: [] } as never, { uuidIds: true, refuse: { movement_signals: "RLS" } }) as never, B, { type: "contact", id: "c1" }, { now: NOW, slices: ["intent"] }))
    ok(refused.ok && refused.view.intent?.readiness === null && refused.view.warnings.some((w) => /readiness snapshot unread/.test(w)), "a refused read is a warning and null, never 'fine'")
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); console.log("❌ READINESS_DIMENSIONS_FAIL"); process.exit(1) }
  console.log("✅ READINESS_DIMENSIONS_PASS")
}

main().catch((e) => { console.error(e); console.log("❌ READINESS_DIMENSIONS_FAIL (threw)"); process.exit(1) })
