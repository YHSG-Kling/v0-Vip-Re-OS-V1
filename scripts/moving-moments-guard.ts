#!/usr/bin/env tsx
/**
 * scripts/moving-moments-guard.ts  (npm run test:moving-moments)
 * ────────────────────────────────────────────────────────────────────────
 * WAVE 150, LANE 150JNAD — directive 150J (the Moving-Moments taxonomy) + contract C37 (the evidence model) + C38 (needs × expectation
 * × feasibility → the arbiter's plays) + owner ruling R2 (contact_type is never a readiness signal). Driven through the real modules
 * (lib/intent/moving-moments.ts, opportunity-discovery.ts, movement-signals.ts) on an in-memory database — no network, no model,
 * no vendor, never the live PropertyRadar API. Each refusal sits beside its positive control.
 *
 *   A. ONE VOCABULARY — the windows, deadline kinds and timeline spellings in code equal m970's CHECKs (derived, not pinned); every
 *      C38 play rides a mode of LIFE_EVENT_ENGAGEMENT_MODES.
 *   B. C37 — every one of the fifteen named fields is on the moment.
 *   C. TAXONOMY — seller / buyer / renter / investor from evidence, the person's words or a recorded tenure; the investor exit in the
 *      REI Playbook vocabulary, only from the person's words.
 *   D. R2 — contact_type is never read: stripped-source scans (positive control: a planted read is caught) AND a dynamic proof — the
 *      same evidence with a different contact_type yields the identical moment; Customer 360's stated timeline names no side.
 *   E. VENDOR SCORES — labelled signals in their own units (DistressScore ≠ LikelyListingScore ≠ LikelyPurchaseScore), probability null.
 *   F. RECORD PROVENANCE + DEDUP — m970 columns ride a row only when the evidence documents them; an inference never carries a date;
 *      a public post's stated bucket rides only in the author's own voice; one source repeated is one observation.
 *   G. C38 PLAYS — gated by the existing menu, holdout watched only, a stated person never held out, briefs screened, the arbiter's
 *      facts carry the moment + only the open plays; the expert brief rides the system prompt; the hook returns moment + plays.
 *
 * BLIND SPOTS, published: memSupabase has no RLS / CHECK / trigger (m970's CHECKs are read as text and compared); the model is not
 * called (the C38 brief is checked structurally); the lease-end writer is the lead desk's stated-date capture (Outside-lane) — this
 * proof drives the record path directly.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments, blankStrings } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let passed = 0, failed = 0
const failures: string[] = []
function ok(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await f() } finally { console.warn = w; console.error = e } }
const raw = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")
const src = (p: string) => stripComments(raw(p))
const checkList = (sql: string, name: string): string[] => {
  const m = new RegExp(`${name}[\\s\\S]*?IN \\(([^)]*)\\)`).exec(sql)
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort() : []
}

const B = "11111111-1111-4111-8111-111111111111", B2 = "22222222-2222-4222-8222-222222222222"
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
  const lev = await import("../lib/enrichment/life-event-vocabulary")
  const read = (obs: Obs[]) => od.readOpportunities(obs, { now: NOW })
  const moment = (obs: Obs[], facts: Partial<import("../lib/intent/moving-moments").MovingMomentFacts> = {}) => mm.buildMovingMoment(read(obs), obs, { subjectIsPerson: true, ...facts }, { now: NOW })

  console.log("\nA. one vocabulary — code and m970 agree (derived)")
  {
    const m970 = raw("supabase/migrations/m970-movement-signals-c37-moving-moment.sql")
    const first = m970.split("\n")[0]
    ok(/^-- WRITTEN, NOT APPLIED \(wave 150, lane 150JNAD\)/.test(first) || /^-- ── APPLIED LIVE /.test(first), "m970 line 1 carries the lane stamp (or the APPLIED LIVE stamp)", first)
    ok(JSON.stringify(checkList(m970, "movement_signals_decision_window_check")) === JSON.stringify([...mm.DECISION_WINDOWS].sort()), "decision_window CHECK = DECISION_WINDOWS", checkList(m970, "movement_signals_decision_window_check").join(","))
    ok(JSON.stringify(checkList(m970, "movement_signals_known_deadline_kind_check")) === JSON.stringify([...mm.KNOWN_DEADLINE_KINDS].sort()), "known_deadline_kind CHECK = KNOWN_DEADLINE_KINDS")
    const tl = checkList(m970, "movement_signals_stated_timeline_check")
    const contactsTimeline = ((CHECK_VOCABULARIES as Record<string, Record<string, string[]>>).contacts?.timeline ?? [])
    ok(contactsTimeline.length >= 6 && contactsTimeline.every((t) => tl.includes(t) && mm.statedTimelineWindow(t) !== null), `every contacts.timeline spelling (${contactsTimeline.length}, from the generated vocabulary cache) is admitted by m970 AND maps to a window`)
    ok(tl.every((t) => mm.statedTimelineWindow(t) !== null) && mm.statedTimelineWindow("30-60-90") === null, "every m970 timeline spelling maps to a window; (control) a 30/60/90 spelling is no timeline at all")
    const reading = read([o("fp_inbound_stated", "relocation", "reported", { identity: "record_key" })])
    const menu = od.opportunityMenu(reading, { personIdentified: true, outreachPermitted: true, autonomy: "autonomous", paidResearchAffordable: null })
    const plays = mm.readinessPlays(moment([o("fp_inbound_stated", "relocation", "reported")]), menu, reading)
    ok(plays.options.length === 6 && new Set(plays.options.map((p) => p.play)).size === 6 && plays.options.every((p) => (lev.LIFE_EVENT_ENGAGEMENT_MODES as readonly string[]).includes(p.mode)), `every C38 play (${plays.options.map((p) => `${p.play}→${p.mode}`).join(", ")}) rides ONE engagement mode — no second posture vocabulary`)
  }

  console.log("\nB. C37 — the fifteen named fields")
  {
    const m = moment([o("fp_calc_seller_net", "property_event", "verified"), o("pr_permit_activity", "property_event", "verified", { identity: "verified_match" })])
    const named = ["buyer_readiness", "seller_readiness", "investor_strategy", "desire_to_move", "expects_to_move", "ability_to_act", "barrier", "known_deadline", "identity_confidence", "source_confidence", "rights", "last_observed", "negative_evidence", "outreach_permission", "decision_window"]
    const missing = named.filter((k) => !(k in m))
    ok(missing.length === 0, `all 15 C37 fields present${missing.length ? ` (missing ${missing.join(", ")})` : ""}`)
    ok(m.outreach_permission === "consent_required" && moment([o("fp_calc_seller_net", "property_event", "verified")], { consent: { checked: true, allowed: true } }).outreach_permission === "permitted", "outreach permission: consent-gated evidence with consent unread is consent_required; (control) read and allowed → permitted")
    ok(m.rights.collections.includes("first_party") && m.rights.restricted === false && moment([o("pp_reddit_relocation", "relocation", "reported", { rights: "platform_scrape_contested" })]).rights.restricted === true, "rights are the records' own collection bases; a contested scrape is flagged restricted")
  }

  console.log("\nC. taxonomy — seller / buyer / renter / investor from evidence")
  {
    ok(JSON.stringify(moment([o("fp_calc_seller_net", "property_event", "verified", { intents: ["home_sale"] }), o("pr_permit_activity", "property_event", "verified", { intents: ["home_sale"] })]).segments) === JSON.stringify(["seller"]), "seller evidence → seller segment only")
    ok(moment([o("fp_saved_homes", "property_event", "verified")], { tenure: "renter" }).segments.includes("renter"), "a recorded renter tenure (home_owner_status) → renter (+ buyer)")
    const inv = moment([o("fp_calc_investment", "property_event", "verified")], { investorExit: "fix_and_flip" })
    ok(inv.investor_strategy.stage === "active" && inv.investor_strategy.exit === "fix_and_flip" && ["wholesale", "fix_and_flip", "buy_and_hold"].includes(inv.investor_strategy.exit), "a stated fix-and-flip exit → investor active, exit in the REI Playbook vocabulary")
    const invQuiet = moment([o("fp_calc_investment", "property_event", "verified")])
    ok(invQuiet.investor_strategy.exit === "unknown" && invQuiet.investor_strategy.stage === "exploring", "(control) an investment calculator alone → exploring, exit UNKNOWN (an exit is never inferred)")
  }

  console.log("\nD. R2 — contact_type is never read as a signal")
  {
    const CT = /contact_type|contactType/
    for (const f of ["lib/intent/moving-moments.ts", "lib/intent/opportunity-discovery.ts"]) ok(!CT.test(blankStrings(src(f))) && !CT.test(src(f)), `${f}: no contact_type in stripped source`)
    const sig = src("lib/intent/movement-signals.ts")
    const loader = sig.slice(sig.indexOf("async function loadMomentFacts"), sig.indexOf("const stampedHoldout"))
    ok(loader.length > 200 && !CT.test(loader), "loadMomentFacts (the moment's only DB reader) never selects contact_type")
    ok(CT.test("select(\"id, contact_type\")"), "(positive control) the finder sees a planted contact_type read")
    const c360 = src("lib/enrichment/customer-360.ts")
    const tlBlock = c360.slice(c360.indexOf("if (row.timeline) {"), c360.indexOf("// (2) first-party actions"))
    ok(tlBlock.length > 100 && !CT.test(tlBlock) && /playbook: null/.test(tlBlock), "Customer 360: the stated timeline names NO side and never reads contact_type (R2)")
    // dynamic: identical evidence, different contact_type → identical moment
    const seed = (ct: string) => ({
      contacts: [{ id: "c1", brokerage_id: B, contact_type: ct, zip_code: "78701", deleted_at: null, timeline: "3-6_months", home_owner_status: null, equity_estimate: null, enrichment_profile: { field_provenance: { timeline: { source: "contact", retrievedAt: daysAgo(2) } } } }],
      movement_signals: [
        { id: "m1", brokerage_id: B, subject_type: "contact", contact_id: "c1", source_key: "fp_saved_homes", source_kind: "first_party_behaviour", confidence: "verified", identity_match: "record_key", event_relevance: "property_event", intents: ["home_purchase"], side: "buyer", evidence: { confidence: "verified", summary: "saved", reference: { kind: "first_party_row", id: "s1", retrievedAt: daysAgo(2) } }, observed_at: daysAgo(2), outreach: "consent_gated", protected_proxy: false, outcome: null, data_rights: { collection: "first_party" } },
        { id: "m2", brokerage_id: B, subject_type: "contact", contact_id: "c1", source_key: "pp_reddit_relocation", source_kind: "public_post", confidence: "reported", identity_match: "verified_match", event_relevance: "relocation", intents: ["home_purchase"], side: "buyer", evidence: { confidence: "reported", reportedBy: "self", summary: "asked", reference: { kind: "public_post", id: "r1", retrievedAt: daysAgo(1) } }, observed_at: daysAgo(1), outreach: "consent_gated", protected_proxy: false, outcome: null, data_rights: { collection: "public_web_search" } },
      ],
    })
    const runFor = async (ct: string) => { const d = memSupabase(seed(ct) as never, { uuidIds: true }) as any; return quiet(() => mv.movementSignalsForArbiter(d, { brokerageId: B, contactId: "c1", now: NOW, windowDays: 180 })) }
    const asBuyer = await runFor("buyer"), asSeller = await runFor("seller"), asSphere = await runFor("sphere")
    const sig1 = JSON.stringify(asBuyer.opportunity?.moment), sig2 = JSON.stringify(asSeller.opportunity?.moment), sig3 = JSON.stringify(asSphere.opportunity?.moment)
    ok(!!asBuyer.opportunity?.moment && sig1 === sig2 && sig2 === sig3, "the SAME evidence under contact_type buyer / seller / sphere yields the IDENTICAL moment (contact_type is not an input)")
    ok(asBuyer.opportunity?.moment?.decision_window.window === "91_180" && asBuyer.opportunity?.moment?.desire_to_move.basis === "person_stated", `the person's own stamped timeline places the window (${asBuyer.opportunity?.moment?.decision_window.window}, ${asBuyer.opportunity?.moment?.decision_window.basis})`)
    const foreign = await quiet(() => mv.movementSignalsForArbiter(memSupabase(seed("buyer") as never, { uuidIds: true }) as any, { brokerageId: B2, contactId: "c1", now: NOW, windowDays: 180 }))
    ok(!foreign.opportunity, "(tenancy) another tenant asking about the same contact gets no moment")
  }

  console.log("\nE. vendor scores — labelled signals in their own units, never a probability")
  {
    const m = moment([o("fp_calc_seller_net", "property_event", "verified")], { statedTimeline: { value: "1-3_months", basis: "person_stated", at: daysAgo(1) }, vendorScores: [{ provider: "PropertyRadar", field: "DistressScore", value: 85 }, { provider: "PropertyRadar", field: "LikelyListingScore", value: 85 }, { provider: "PropertyRadar", field: "LikelyPurchaseScore", value: 85 }, { provider: "acme", field: "magic", value: 0.9 }] })
    const [ds, ll, lp, unk] = m.vendor_scores
    ok(m.vendor_scores.every((v) => v.probability === null && /never a probability/.test(v.label)), "every vendor score: probability null, label says it is never a probability of a move")
    ok(/0–100 rollup of distress/.test(ds.unit) && ds.unit !== ll.unit && ll.unit !== lp.unit, "DistressScore, LikelyListingScore and LikelyPurchaseScore stay DISTINCT units")
    ok(/unverified units/.test(unk.unit), "(control) an unknown vendor field is labelled 'unverified units', never guessed")
    ok(m.probability === null && /calibration not read/.test(m.probabilityWhy), "no calibration → no probability, with the reason")
  }

  console.log("\nF. record provenance + event dedup (m970 columns only when documented)")
  {
    const d = memSupabase({ movement_signals: [], agent_action_ledger: [], contacts: [{ id: "c9", brokerage_id: B, deleted_at: null }] } as never, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], movement_signals: [["brokerage_id", "idempotency_key"]] } }) as any
    const base = { brokerageId: B, subject: { type: "contact" as const, id: "c9" }, identity: "record_key" as const, capturedBy: "staff" as const, observedAt: daysAgo(1) }
    const plain = await quiet(() => mv.recordMovementSignal(d, { ...base, sourceKey: "fp_saved_homes", eventRelevance: "property_event", evidence: { confidence: "verified", reference: { kind: "first_party_row", id: "s9", retrievedAt: daysAgo(1) }, summary: "saved a home in the portal" } }, { route: false }))
    const dated = await quiet(() => mv.recordMovementSignal(d, { ...base, sourceKey: "fp_inbound_stated", eventRelevance: "relocation", knownDeadline: { kind: "lease_end", at: inDays(60) }, evidence: { confidence: "reported", reportedBy: "self", reference: { kind: "person_message", id: "msg1", retrievedAt: daysAgo(1), quote: "our lease ends in two months" }, summary: "told us their lease ends in two months" } }, { route: false }))
    const rows = ((await d.from("movement_signals").select("*").eq("brokerage_id", B)).data ?? []) as Array<Record<string, unknown>>
    const pr = rows.find((r) => r.source_key === "fp_saved_homes"), dr = rows.find((r) => r.source_key === "fp_inbound_stated")
    ok(plain.status === "recorded" && !!pr && !("known_deadline_kind" in pr) && !("stated_timeline" in pr) && !("decision_window" in pr), "an ordinary C9 row names NO m970 column (a deploy ahead of m970 breaks only documented-date writes)")
    ok(dated.status === "recorded" && dr?.known_deadline_kind === "lease_end" && typeof dr?.known_deadline_at === "string", "the person's own words with a documented lease end → known_deadline_kind / _at on the row")
    const inferredDate = await quiet(() => mv.recordMovementSignal(d, { ...base, sourceKey: "fp_content_engagement", eventRelevance: "property_event", knownDeadline: { kind: "lease_end", at: inDays(60) }, evidence: { confidence: "inferred", basis: ["v1"], method: "read an article", summary: "read the tenant's article" } }, { route: false }))
    ok(inferredDate.status === "refused" && /never an inference/.test((inferredDate as { reason: string }).reason), "an INFERENCE never carries a known date (refused)")
    const badKind = await quiet(() => mv.recordMovementSignal(d, { ...base, sourceKey: "fp_inbound_stated", eventRelevance: "relocation", knownDeadline: { kind: "move_by_90_days" as never, at: inDays(60) }, evidence: { confidence: "reported", reportedBy: "self", reference: { kind: "person_message", id: "msg2", retrievedAt: daysAgo(1) }, summary: "told us a date" } }, { route: false }))
    ok(badKind.status === "refused", "(control) a deadline kind outside KNOWN_DEADLINE_KINDS is refused")
    const reading = (about: "author" | "third_party") => ({ relevant: true, eventRelevance: "relocation" as const, about, side: "buyer" as const, timelineBucket: "3-6" as const, quote: "we move in spring", needsPerson: false, note: "", source: "ai" as const })
    const own = mv.movementSignalFromPublicPost({ brokerageId: B, subject: { type: "contact", id: "c9" }, sourceKey: "pp_reddit_relocation", postId: "p1", postedAt: daysAgo(2), retrievedAt: daysAgo(1), reading: reading("author") })
    const third = mv.movementSignalFromPublicPost({ brokerageId: B, subject: { type: "contact", id: "c9" }, sourceKey: "pp_reddit_relocation", postId: "p2", postedAt: daysAgo(2), retrievedAt: daysAgo(1), reading: reading("third_party") })
    ok(own.ok && own.record.statedTimeline === "3-6", "a public post in the author's OWN voice carries their stated bucket (the classifier's timeline was dropped before)")
    ok(third.ok && third.record.statedTimeline === null, "(control) a third party's post carries no stated timeline")
    const rep = read([o("fp_saved_homes", "property_event", "verified", { id: "x1" }), o("fp_saved_homes", "property_event", "verified", { id: "x2", observedAt: daysAgo(1) }), o("fp_saved_homes", "property_event", "verified", { id: "x3" })])
    ok(rep.primary?.independentSources === 1 && rep.primary.stage === "single_observation", "event dedup: one source repeated three times is ONE observation")
  }

  console.log("\nG. C38 plays — gated, screened, holdout, arbiter facts")
  {
    const obs = [o("fp_calc_seller_net", "property_event", "verified", { intents: ["home_sale"] }), o("pr_permit_activity", "property_event", "verified", { identity: "verified_match", intents: ["home_sale"] })]
    const r = read(obs)
    const menu = od.opportunityMenu(r, { personIdentified: true, outreachPermitted: true, autonomy: "autonomous", paidResearchAffordable: null })
    const m = mm.buildMovingMoment(r, obs, { subjectIsPerson: true, equity: "positive", knownDeadlines: [{ kind: "planned_list_date", at: inDays(20), source: "first_party_row" }] }, { now: NOW })
    const plays = mm.readinessPlays(m, menu, r)
    const by = (p: string) => plays.options.find((x) => x.play === p)!
    ok(m.seller_readiness.level === "ready" && by("invite").status === "eligible", `a seller with a planned list date in 20 days and equity → ready, INVITE eligible (${m.seller_readiness.level})`)
    const held = mm.readinessPlays(m, menu, r, { holdout: true })
    ok(held.holdout && held.options.filter((x) => x.status !== "not_eligible").every((x) => x.play === "watch" || x.play === "stay_quiet"), "an independent HOLDOUT subject is only watched / left quiet")
    const statedR = read([o("fp_inbound_stated", "relocation", "reported")])
    ok(mm.readinessPlays(moment([o("fp_inbound_stated", "relocation", "reported")]), od.opportunityMenu(statedR, { personIdentified: true, outreachPermitted: true, autonomy: "autonomous", paidResearchAffordable: null }), statedR, { holdout: true }).holdout === false, "(control) a person who TOLD us is never held out")
    const noMenu = mm.readinessPlays(m, od.opportunityMenu(r, { personIdentified: true, outreachPermitted: false, autonomy: "autonomous", paidResearchAffordable: null }), r)
    ok(noMenu.options.find((x) => x.play === "invite")!.status === "not_eligible", "a play is never MORE eligible than its mode: no permitted outreach → INVITE not eligible")
    const words = plays.options.map((x) => x.brief ?? "").join(" ")
    ok(lev.screenLifeEventOutreach(words, { events: lev.LIFE_EVENT_TYPES.map((type) => ({ type })) }).ok && !/\b\d{1,3}\s*%|probabilit(y|ies) of|score of/i.test(words.replace(/never .*?probability/gi, "")), "every outward brief passes the life-event screen and states no score or chance")
    const a1 = mm.movementHoldoutArm(B, "c-1", { readable: true, killSwitch: false, disabled: [] }), a2 = mm.movementHoldoutArm(B, "c-1", { readable: true, killSwitch: false, disabled: [] })
    const killed = mm.movementHoldoutArm(B, "c-1", { readable: false, killSwitch: true, disabled: [] })
    const arms = Array.from({ length: 400 }, (_, i) => mm.movementHoldoutArm(B, `s-${i}`, { readable: true, killSwitch: false, disabled: [] })?.arm)
    ok(a1?.arm === a2?.arm && killed?.arm === "treated" && arms.includes("holdout") && arms.filter((x) => x === "holdout").length < 60, `holdout arm is deterministic, an unreadable policy holds nobody out, ~5 % held (${arms.filter((x) => x === "holdout").length}/400)`)
    const facts = od.opportunityFactsFrom({ reading: r, menu, moment: m, plays })
    ok(!!facts?.moment && facts.moment.window === "0_30" && facts.moment.seller === "ready" && !!facts.plays && facts.plays.options.every((p) => p.status !== "not_eligible"), "the arbiter's facts carry the moment (levels only) and ONLY the open plays")
    ok(!JSON.stringify(facts).includes("pr_permit_activity") && !JSON.stringify(facts).includes("DistressScore"), "the arbiter's facts name no source key and no vendor score")
    ok(/NEED × EXPECTATION × FEASIBILITY/.test(od.OPPORTUNITY_COMBINATION_BRIEF) && /REPORTING INTERVAL/.test(od.OPPORTUNITY_COMBINATION_BRIEF) && /never treat an appointment as a closing/.test(od.OPPORTUNITY_COMBINATION_BRIEF) && mv.MOVEMENT_DECISION_SYSTEM.includes(od.OPPORTUNITY_COMBINATION_BRIEF), "the C38 expert brief (need → feasibility → window → plays; vendor units; calibration) rides the movement manager's and the arbiter's system prompt")
    const arb = blankStrings(src("lib/ai-isa/followup-arbiter.ts"))
    ok(/opportunityFactsFrom\(a\.opportunity\)/.test(arb), "the arbiter already passes the hook's opportunity object through opportunityFactsFrom (the moment reaches it with no arbiter edit)")
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); console.log("❌ MOVING_MOMENTS_FAIL"); process.exit(1) }
  console.log("✅ MOVING_MOMENTS_PASS")
}

main().catch((e) => { console.error(e); console.log("❌ MOVING_MOMENTS_FAIL (threw)"); process.exit(1) })
