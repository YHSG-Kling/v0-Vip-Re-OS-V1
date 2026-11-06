#!/usr/bin/env tsx
/**
 * scripts/opportunity-discovery-guard.ts  (npm run test:opportunity-discovery)
 * ────────────────────────────────────────────────────────────────────────
 * WAVE 149, LANE 149H — owner ruling 18 ("find the needle in the haystack": permitted indicators that someone may be starting to
 * consider moving, selling, buying, investing or refinancing, before they search for an agent; combine signals; verified vs
 * inferred; the arbiter decides research / education / monitoring / outreach / human; kind and never exploitative).
 * DRIVEN through the real modules (lib/intent/opportunity-discovery.ts, lib/intent/movement-signals.ts, the movement watcher) on an
 * in-memory database — no network, no model, no vendor. Each refusal sits beside its positive control.
 *
 *   A. THE WIDENED INDICATORS — every permitted indicator family of the brief maps to a registry row that carries source, freshness,
 *      confidence ceiling (verified vs inferred), cost class; the three new first-party readers' survivor tables exist live.
 *   B. COMBINATION — a single observation never raises an opportunity (however often it repeats); inferences alone stay `watch`;
 *      independent kinds + one verified + confirmed identity = `likely`; the person's own words = `stated`; context never scores;
 *      stale never counts; investing / refinancing read as themselves.
 *   C. THE ARBITER'S MENU — one vocabulary (LIFE_EVENT_ENGAGEMENT_MODES); quiet monitoring always; education / outreach / a person
 *      refused for a single observation; outreach needs authority (unknown → needs_authority, supervised → approval); research is
 *      cheapest first, REUSED on unchanged evidence, paid steps behind mayUseAndAfford (fail closed).
 *   D. NEVER INTRUSIVE — a sensitive reading's briefs never name or allude to any life event, a source or a surveillance tell
 *      (screenLifeEventOutreach + every LIFE_EVENT_VOCAB never-mention pattern); positive control: a planted brief is caught.
 *   E. END TO END — stored first-party rows → the watcher → C9 records (foreign contact ids dropped, one criteria change refused) →
 *      the arbiter hook: one observation reaches the arbiter as NO life change (blind spot says why); a second independent source does.
 *   F. SOURCE — the expert brief rides the movement manager's prompt; the hook returns the menu; no fixed timetable in the module.
 *
 * Scans read STRIPPED source (scripts/strip-comments.ts). BLIND SPOTS, published: memSupabase has no RLS / CHECK; the model is not
 * called (the brief is checked structurally); topic tagging is lexical over the tenant's own post category + title; the arbiter's
 * USE of the menu is lane 149C's (Outside-lane) — this proof stops at the input shape.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments, blankStrings } from "./strip-comments"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

let passed = 0, failed = 0
const failures: string[] = []
function ok(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await f() } finally { console.warn = w; console.error = e } }
const raw = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")
const src = (p: string) => stripComments(raw(p))

const B = "11111111-1111-4111-8111-111111111111", B2 = "22222222-2222-4222-8222-222222222222"
const NOW = new Date("2026-10-30T15:00:00.000Z")
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()

type Obs = import("../lib/intent/opportunity-discovery").OpportunityObservation
let seq = 0
const o = (sourceKey: string, relevance: Obs["relevance"], confidence: Obs["confidence"], extra: Partial<Obs> = {}): Obs =>
  ({ id: `o${++seq}`, sourceKey, relevance, confidence, identity: "record_key", observedAt: daysAgo(3), ...extra })

async function main() {
  const od = await import("../lib/intent/opportunity-discovery")
  const mv = await import("../lib/intent/movement-signals")
  const watcher = await import("../lib/intent/movement-source-watcher")
  const lev = await import("../lib/enrichment/life-event-vocabulary")

  // ── A ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nA. the widened permitted indicators (source · freshness · confidence · cost · verified vs inferred)")
  {
    const has = (k: string) => mv.movementSource(k)
    const families: Array<[string, string[]]> = [
      ["consented browsing", ["fp_site_sessions", "fp_repeat_property_views", "fp_saved_homes"]],
      ["content engagement", ["fp_content_engagement"]],
      ["home-value / equity research", ["fp_valuation_request", "fp_home_dashboard_view", "fp_calc_seller_net"]],
      ["relocation information", ["fp_relocation_guide", "fp_calc_moving_cost"]],
      ["public moving plans", ["pp_reddit_relocation", "pp_linkedin_relocation"]],
      ["ownership / public-record changes", ["pr_property_transfer_open_data", "pr_mls_status_change"]],
      ["local employment / economic developments", ["cm_warn_notice", "cm_employer_expansion"]],
      ["permits", ["pr_permit_activity", "pr_street_use_permit"]],
      ["verified estate / property events", ["pr_probate_open_data", "pr_batchdata_quicklist"]],
      ["repeated criteria changes", ["fp_criteria_revisions"]],
      ["investing", ["fp_calc_investment", "po_investor_activity"]],
      ["refinancing", ["fp_calc_mortgage_comparison", "cm_rate_move"]],
    ]
    const missing = families.filter(([, ks]) => !ks.every((k) => !!has(k))).map(([f]) => f)
    ok(missing.length === 0, `every indicator family of the brief has registry rows (${families.length} families)`, missing.join(", "))
    const rows = families.flatMap(([, ks]) => ks).map((k) => has(k)!).filter(Boolean)
    const incomplete = rows.filter((r) => r.freshness.length < 10 || !r.costClass || !r.maxConfidence || r.howObtained.length < 30 || r.consent.length < 10)
    ok(incomplete.length === 0, `each carries source, freshness, cost class, confidence ceiling and how it is obtained (${rows.length} rows)`, incomplete.map((r) => r.key).join(", "))
    ok(has("fp_content_engagement")?.maxConfidence === "inferred" && has("fp_criteria_revisions")?.maxConfidence === "verified" && has("fp_home_dashboard_view")?.maxConfidence === "verified", "verified vs inferred is honest: an unauthenticated article view is at most `inferred`; the person's own portal / stated rows are `verified`")
    const NEW = ["fp_content_engagement", "fp_home_dashboard_view", "fp_criteria_revisions"]
    const tables = NEW.map((k) => has(k)!.survivor).map((s) => (s.kind === "first_party_table" ? s.table : "∅"))
    ok(tables.every((t) => !!SCHEMA_SNAPSHOT[t]) && !SCHEMA_SNAPSHOT["blog_post_reads_invented"], `the new readers' survivor tables exist in the live-schema cache (${tables.join(", ")}); control: an invented table is refused`)
    ok(NEW.every((k) => has(k)!.status === "live" && has(k)!.costClass === "free_first_party"), "the new indicators are free first-party reads (cost: no vendor call, no new egress)")
  }

  // ── B ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nB. combination — no single observation is intent")
  {
    const permit = o("pr_permit_activity", "property_event", "verified")
    const single = od.readOpportunities([permit], { now: NOW })
    ok(single.primary?.kind === "sell" && single.primary.stage === "single_observation", `ONE verified permit is a single observation, never an opportunity (${single.primary?.kind}: ${single.primary?.stage})`)
    const repeated = od.readOpportunities([o("fp_saved_homes", "property_event", "verified"), o("fp_saved_homes", "property_event", "verified"), o("fp_saved_homes", "property_event", "verified", { observedAt: daysAgo(1) })], { now: NOW })
    ok(repeated.primary?.stage === "single_observation" && repeated.primary.independentSources === 1, "the SAME source three times is still one observation (repeats never stack)")
    const combined = od.readOpportunities([permit, o("fp_calc_seller_net", "property_event", "verified")], { now: NOW })
    ok(combined.primary?.kind === "sell" && combined.primary.stage === "likely" && combined.primary.sourceKinds.length === 2, `(positive control) the permit + the owner's own seller-net calculation = independent kinds → likely sell (${combined.primary?.reason})`)
    const inferred = od.readOpportunities([o("po_online_real_estate_activity", "property_event", "inferred", { identity: "verified_match" }), o("pr_owner_rental_listing", "property_event", "inferred", { identity: "verified_match", intents: ["home_sale"] })], { now: NOW })
    ok(inferred.assessments.every((a) => !od.stageAtLeast(a.stage, "emerging")) && inferred.assessments.some((a) => a.stage === "watch"), `inferences alone never read as facts — "watch" at most (${inferred.assessments.map((a) => `${a.kind}:${a.stage}`).join(", ")})`)
    const sameKind = od.readOpportunities([o("fp_saved_homes", "property_event", "verified"), o("fp_criteria_revisions", "property_event", "verified")], { now: NOW })
    ok(sameKind.primary?.kind === "buy" && sameKind.primary.stage === "emerging", `two first-party sources of ONE kind = emerging buy, not likely (${sameKind.primary?.stage})`)
    const stated = od.readOpportunities([o("fp_inbound_stated", "relocation", "reported", { intents: ["moving"] })], { now: NOW })
    ok(stated.primary?.kind === "move" && stated.primary.stage === "stated", "the person's OWN words are `stated` — the one single source that counts, and never labelled an inference")
    const ctx = od.readOpportunities([o("cm_rate_move", "market_event", "verified", { identity: "none" })], { now: NOW })
    ok(ctx.primary === null && ctx.contextObservations === 1, "market / community context alone never scores (counted beside the reading)")
    const ctxPlus = od.readOpportunities([o("cm_rate_move", "market_event", "verified"), o("fp_calc_mortgage_comparison", "property_event", "verified", { intents: ["refinance"] })], { now: NOW })
    ok(ctxPlus.primary?.stage === "single_observation", "context + one observation is still a single observation (context explains timing, never intent)")
    const stale = od.readOpportunities([permit, o("fp_calc_seller_net", "property_event", "verified", { observedAt: daysAgo(400) })], { now: NOW })
    ok(stale.staleObservations === 1 && stale.primary?.stage === "single_observation", "a stale observation (older than three half-lives) no longer corroborates")
    const invest = od.readOpportunities([o("fp_calc_investment", "property_event", "verified"), o("po_investor_activity", "property_event", "inferred", { identity: "verified_match" })], { now: NOW })
    ok(invest.primary?.kind === "invest" && !invest.assessments.some((a) => a.kind === "buy"), `investing reads as investing, never as a home purchase (${invest.primary?.kind}: ${invest.primary?.stage})`)
    const refi = od.readOpportunities([o("fp_home_dashboard_view", "property_event", "verified"), o("fp_calc_mortgage_comparison", "property_event", "verified", { intents: ["refinance"] })], { now: NOW })
    ok(refi.assessments.find((a) => a.kind === "refinance")?.stage === "emerging", "home-dashboard equity research + a mortgage comparison = emerging refinance")
    ok(od.opportunityKindsForTopic("Selling your home this spring").join() === "sell" && od.opportunityKindsForTopic("Our team picnic").length === 0, "topic tagging reads the tenant's post (selling → sell); a non-decision topic is nothing")
    const tagged = od.readOpportunities([o("fp_content_engagement", "property_event", "inferred", { intents: ["home_sale", "home_purchase"], fields: ["opportunity:invest"] })], { now: NOW })
    ok(tagged.assessments.map((a) => a.kind).join() === "invest", "an `opportunity:<kind>` evidence tag is authoritative over the record's intents")
  }

  // ── C ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nC. the arbiter's menu (the input shape lane 149C consumes)")
  {
    const base = { personIdentified: true, outreachPermitted: true, autonomy: "autonomous" as const, paidResearchAffordable: null }
    const single = od.opportunityMenu(od.readOpportunities([o("pr_permit_activity", "property_event", "verified")], { now: NOW }), base)
    const st = (m: typeof single, mode: string) => m.options.find((x) => x.mode === mode)
    ok(single.options.map((x) => x.mode).join() === lev.LIFE_EVENT_ENGAGEMENT_MODES.join(), `one vocabulary: the menu IS LIFE_EVENT_ENGAGEMENT_MODES (${single.options.map((x) => x.mode).join(", ")})`)
    ok(st(single, "quiet_monitoring")?.status === "eligible" && single.floor === "quiet_monitoring", "quiet monitoring is always available and is the floor (never a person by reflex, never a timer)")
    ok(st(single, "helpful_education")?.status === "not_eligible" && st(single, "appropriate_outreach")?.status === "not_eligible" && st(single, "human")?.status === "not_eligible" && /single observation/.test(st(single, "helpful_education")!.why),
      "a single observation offers NO education, NO outreach and NO agent alert — only monitoring / research")
    ok(st(single, "research")?.status === "eligible", "… research is offered for a single observation (free first-party reads first)")
    const likely = od.readOpportunities([o("pr_permit_activity", "property_event", "verified"), o("fp_calc_seller_net", "property_event", "verified")], { now: NOW })
    const unknownAuth = od.opportunityMenu(likely, { ...base, autonomy: "unknown" })
    ok(st(unknownAuth, "appropriate_outreach")?.status === "needs_authority", "outreach on a likely reading with UNREAD authority is `needs_authority` (fail closed)")
    const auto = od.opportunityMenu(likely, base), sup = od.opportunityMenu(likely, { ...base, autonomy: "supervised" })
    ok(st(auto, "appropriate_outreach")?.status === "eligible" && !st(auto, "appropriate_outreach")?.requiresApproval && st(sup, "appropriate_outreach")?.requiresApproval === true, "(positive control) autonomous → outreach eligible; supervised → eligible with a person approving the draft")
    ok(st(auto, "helpful_education")?.status === "eligible" && st(auto, "human")?.status === "eligible", "a likely reading offers education and a person as choices")
    const noReach = od.opportunityMenu(likely, { ...base, outreachPermitted: false })
    ok(st(noReach, "appropriate_outreach")?.status === "not_eligible" && st(noReach, "helpful_education")?.status === "not_eligible", "no decisive record permitting outreach → no education, no outreach (the record's own terms win)")
    const r1 = st(auto, "research")?.research ?? []
    ok(r1.length > 0 && r1.every((s, i) => i === 0 || od.OPPORTUNITY_KINDS.length > 0 && ["free_first_party", "free_public", "platform_paid", "paid_enrichment"].indexOf(s.costClass) >= ["free_first_party", "free_public", "platform_paid", "paid_enrichment"].indexOf(r1[i - 1].costClass)), `research is planned cheapest first (${r1.map((s) => `${s.key}:${s.status}`).join(", ")})`)
    const paid = r1.filter((s) => s.costClass === "platform_paid" || s.costClass === "paid_enrichment")
    ok(paid.length > 0 && paid.every((s) => s.status === "needs_budget"), "paid research waits for mayUseAndAfford when it was not asked (fail closed)")
    const afford = (od.opportunityMenu(likely, { ...base, paidResearchAffordable: true }).options.find((x) => x.mode === "research")?.research ?? []).filter((s) => s.costClass === "platform_paid" || s.costClass === "paid_enrichment")
    ok(afford.length > 0 && afford.every((s) => s.status === "run"), "(positive control) inside the budget the paid step runs")
    const prior = r1.map((s) => ({ key: s.key, at: daysAgo(1) }))
    const reused = od.opportunityMenu(likely, { ...base, paidResearchAffordable: true, priorResearch: prior })
    ok(st(reused, "research")?.status === "not_eligible" && (st(reused, "research")?.research ?? []).every((s) => s.status === "reuse"), "research already run on the SAME evidence is reused — nothing is re-bought until new evidence arrives")
    const fresh = od.readOpportunities([o("pr_permit_activity", "property_event", "verified"), o("fp_calc_seller_net", "property_event", "verified", { observedAt: daysAgo(0) })], { now: NOW })
    const rerun = od.opportunityMenu(fresh, { ...base, paidResearchAffordable: true, priorResearch: prior })
    ok((st(rerun, "research")?.research ?? []).some((s) => s.status === "run"), "(positive control) NEW evidence after the last run re-opens research")
  }

  // ── D ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nD. never intrusive — sensitive events are never named")
  {
    const sens = od.readOpportunities([
      o("pp_web_mention_life_event", "probate_estate", "reported", { identity: "verified_match", lifeEvent: "death_in_household", protectedProxy: false }),
      o("pr_permit_activity", "property_event", "verified"),
      o("fp_calc_seller_net", "property_event", "verified"),
    ], { now: NOW })
    const menu = od.opportunityMenu(sens, { personIdentified: true, outreachPermitted: true, autonomy: "autonomous", paidResearchAffordable: null })
    const briefs = menu.options.map((x) => x.brief).filter((b): b is string => !!b)
    ok(sens.sensitive && !!sens.toneBrief && briefs.length >= 2, `a reading touched by a life event is SENSITIVE and carries a tone brief (${briefs.length} outward briefs)`)
    const outward = [...briefs, sens.explanation, ...sens.assessments.map((a) => a.reason)].join("\n")
    const screen = lev.screenLifeEventOutreach(briefs.join("\n"), { events: sens.screenEvents.map((type) => ({ type })) })
    ok(screen.ok && menu.screenFallbacks === 0, "every outward brief passes screenLifeEventOutreach (no event, no surveillance tell)", JSON.stringify(screen.hits))
    const allNever = lev.LIFE_EVENT_TYPES.flatMap((t) => lev.LIFE_EVENT_VOCAB[t].allowedOutreach.neverMention.map((re) => [t, re] as const))
    const hits = allNever.filter(([, re]) => new RegExp(re, "i").test(outward)).map(([t]) => t)
    ok(hits.length === 0, `no never-mention pattern of ANY of the ${lev.LIFE_EVENT_TYPES.length} life events appears in the briefs, the explanation or the reasons (${allNever.length} patterns)`, hits.join(", "))
    const keys = mv.MOVEMENT_SIGNAL_SOURCES.map((s) => s.key).filter((k) => outward.includes(k))
    ok(keys.length === 0 && !/death|probate|estate|divorce/i.test(outward), "no source name and no event word reaches the outward text", keys.join(", "))
    const edu = menu.options.find((x) => x.mode === "helpful_education")
    const plain = od.opportunityMenu(od.readOpportunities([o("pr_permit_activity", "property_event", "verified"), o("fp_calc_seller_net", "property_event", "verified")], { now: NOW }), { personIdentified: true, outreachPermitted: true, autonomy: "autonomous", paidResearchAffordable: null })
    ok(edu?.tone === sens.toneBrief && !String(edu?.brief).includes(String(sens.toneBrief)) && plain.options.every((x) => !x.tone), "the tone rides BESIDE the brief as the writer's instruction (sensitive only), never inside the copy brief")
    const planted = lev.screenLifeEventOutreach("So sorry for your loss — we noticed the estate filing.", { events: [{ type: "death_in_household" }] })
    ok(!planted.ok, "(positive control) the same screen CATCHES a planted brief that names the loss / a surveillance tell")
  }

  // ── E ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nE. end to end — stored first-party rows → watcher → C9 → the arbiter's hook")
  {
    const tables = {
      contacts: [
        { id: "c1", brokerage_id: B, contact_type: "seller", agent_id: null, zip_code: "78701", deleted_at: null, opted_out_at: null },
        { id: "c2", brokerage_id: B, contact_type: "buyer", agent_id: null, zip_code: "78702", deleted_at: null, opted_out_at: null },
        { id: "cx", brokerage_id: B2, contact_type: "buyer", agent_id: null, zip_code: "78701", deleted_at: null, opted_out_at: null },
      ],
      blog_posts: [{ id: "p1", brokerage_id: B, category: "Selling", title: "What to fix before selling your home" }, { id: "p2", brokerage_id: B, category: "Community", title: "Our team picnic" }],
      blog_post_views: [
        { id: "v1", brokerage_id: B, blog_post_id: "p1", viewer_contact_id: "c1", viewed_at: daysAgo(2) },
        { id: "v2", brokerage_id: B, blog_post_id: "p1", viewer_contact_id: "cx", viewed_at: daysAgo(2) },
        { id: "v3", brokerage_id: B, blog_post_id: "p2", viewer_contact_id: "c1", viewed_at: daysAgo(2) },
      ],
      client_portal_activity: [{ id: "a1", brokerage_id: B, contact_id: "c1", activity_type: "portal_module_viewed", metadata: { module: "seller_home" }, created_at: daysAgo(1) }],
      buyer_criteria_changes: [{ id: "k1", brokerage_id: B, contact_id: "c2", field: "maxPrice", provenance: "said", status: "applied", created_at: daysAgo(3) }],
      raw_scraped_leads: [], agent_action_ledger: [], movement_signals: [], movement_source_polls: [], movement_source_items: [], calculator_history: [], motivated_seller_signals: [], listings: [], transactions: [], leads: [],
    }
    const d = memSupabase(tables as never, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]], movement_signals: [["brokerage_id", "idempotency_key"]] } }) as any
    const deps = { now: NOW, windowDays: 180, decide: (async () => { throw new Error("no model in the proof") }) as never, publish: (async () => ({ ok: true })) as never, respond: (async () => ({ action: "recorded" })) as never, routeToAgent: (async () => true) as never, notifyAdmins: async () => 1 }
    const tick = await quiet(() => watcher.runMovementTick(d, B, { now: NOW, force: true, reconcile: false }, { movement: deps }))
    const rows = ((await d.from("movement_signals").select("*").eq("brokerage_id", B)).data ?? []) as Array<Record<string, any>>
    const bySrc = (k: string) => rows.filter((r) => r.source_key === k)
    ok(bySrc("fp_content_engagement").length === 1 && bySrc("fp_content_engagement")[0].contact_id === "c1" && bySrc("fp_content_engagement")[0].confidence === "inferred",
      `the tenant's selling article read by its own contact → ONE inferred C9 record; the FOREIGN contact id (cx) and the non-decision post are dropped (${bySrc("fp_content_engagement").length} record)`)
    ok(bySrc("fp_home_dashboard_view").length === 1 && bySrc("fp_home_dashboard_view")[0].confidence === "verified", "the signed-in home-dashboard visit → ONE verified C9 record (home-value / equity research)")
    ok(bySrc("fp_criteria_revisions").length === 0 && tick.watch.errors.some((e) => /one change is never a pattern/.test(e)), "ONE stated criteria change is refused — it is never a pattern")
    const hook1 = await quiet(() => mv.movementSignalsForArbiter(d, { brokerageId: B, contactId: "c1", now: NOW, windowDays: 180 }))
    const p1 = hook1.opportunity?.reading.primary
    ok(p1?.kind === "sell" && p1.stage === "emerging" && p1.inferred === 1 && hook1.opportunity?.menu.options.find((x) => x.mode === "helpful_education")?.status === "eligible",
      `c1: home dashboard (verified) + a selling article (inferred) = two independent first-party sources → emerging sell; helpful education offered (${p1?.reason}; signals ${hook1.signals.length})`)
    await d.from("buyer_criteria_changes").insert({ id: "k2", brokerage_id: B, contact_id: "c2", field: "zipCodes", provenance: "said", status: "applied", created_at: daysAgo(1) })
    await quiet(() => watcher.runMovementTick(d, B, { now: NOW, force: true, reconcile: false }, { movement: deps }))
    const rows2 = ((await d.from("movement_signals").select("*").eq("brokerage_id", B)).data ?? []) as Array<Record<string, any>>
    ok(rows2.filter((r) => r.source_key === "fp_criteria_revisions" && r.contact_id === "c2").length === 1, "(positive control) the SECOND stated change makes it repeated → ONE verified C9 record")
    const hookSingle = await quiet(() => mv.movementSignalsForArbiter(d, { brokerageId: B, contactId: "c2", now: NOW, windowDays: 180 }))
    ok(hookSingle.signals.length === 0 && hookSingle.opportunity?.reading.primary?.stage === "single_observation" && /single observation never raises intent/.test(hookSingle.blindSpot ?? ""),
      `c2 has ONE source (repeated criteria changes) → NO life change reaches the arbiter, the blind spot says why (${hookSingle.blindSpot})`)
    ok(hookSingle.opportunity?.menu.options.find((x) => x.mode === "appropriate_outreach")?.status === "not_eligible" && hookSingle.opportunity?.menu.options.find((x) => x.mode === "quiet_monitoring")?.status === "eligible", "… and its menu offers quiet monitoring, not outreach")
    await quiet(() => mv.recordMovementSignal(d, { brokerageId: B, subject: { type: "contact", id: "c2" }, sourceKey: "fp_saved_homes", eventRelevance: "property_event", identity: "record_key", capturedBy: "automation", observedAt: daysAgo(1), evidence: { confidence: "verified", reference: { kind: "first_party_row", id: "saved_properties:s1", retrievedAt: daysAgo(1) }, summary: "saved a home in their portal" } }, { ...deps, route: false }))
    await quiet(() => mv.recordMovementSignal(d, { brokerageId: B, subject: { type: "contact", id: "c2" }, sourceKey: "pp_reddit_relocation", eventRelevance: "relocation", intents: ["home_purchase"], identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(1), evidence: { confidence: "reported", reportedBy: "self", reference: { kind: "public_post", id: "rd:2", retrievedAt: daysAgo(1) }, summary: "asked which neighbourhoods to buy in" } }, { ...deps, route: false }))
    const hook2 = await quiet(() => mv.movementSignalsForArbiter(d, { brokerageId: B, contactId: "c2", now: NOW, windowDays: 180 }))
    ok(hook2.signals.length === 1 && !!hook2.opportunity?.reading.primary && od.stageAtLeast(hook2.opportunity.reading.primary.stage, "emerging"), `(positive control) independent sources → the life change DOES reach the arbiter (${hook2.signals[0]?.type}; ${hook2.opportunity?.reading.primary?.kind}:${hook2.opportunity?.reading.primary?.stage})`)
    ok(hook2.opportunity?.menu.options.find((x) => x.mode === "appropriate_outreach")?.status === "needs_authority" || hook2.opportunity?.menu.options.find((x) => x.mode === "appropriate_outreach")?.status === "not_eligible", "the hook never asserts authority it did not read (outreach is needs_authority / not_eligible, never eligible by default)")
    const foreign = await quiet(() => mv.movementSignalsForArbiter(d, { brokerageId: B2, contactId: "c2", now: NOW, windowDays: 180 }))
    ok(foreign.signals.length === 0 && !foreign.opportunity, "tenant-pinned: another tenant gets no reading and no menu")
    // 149Z (lane 149H Outside-lane 1 → the arbiter READS the reading): the facts the model sees carry only the eligible modes.
    const arb = { opportunityFactsFrom: od.opportunityFactsFrom }
    const f1 = arb.opportunityFactsFrom(hookSingle.opportunity as never)
    const f2 = arb.opportunityFactsFrom(hook2.opportunity as never)
    ok(!!f1 && f1.stage === "single_observation" && !f1.modes.some((m) => m.mode === "appropriate_outreach") && f1.modes.some((m) => m.mode === "quiet_monitoring"),
      `the arbiter's evidence for a single observation never lists outreach (not_eligible is dropped): ${JSON.stringify(f1?.modes.map((m) => m.mode))}`)
    ok(!!f2 && ["emerging", "likely", "stated"].includes(f2.stage) && f2.modes.every((m) => m.status !== "not_eligible"), "(positive control) a combined reading reaches the arbiter's evidence with its stage, no not_eligible mode")
    ok(arb.opportunityFactsFrom(null) === undefined && arb.opportunityFactsFrom(foreign.opportunity as never) === undefined, "no reading → no opportunity evidence (another tenant's empty hook adds nothing)")
    const arbSrc = blankStrings(src("lib/ai-isa/followup-arbiter.ts"))
    ok(/opportunity:\s*sig\.opportunity/.test(arbSrc) && /facts\.opportunity\s*=\s*opp/.test(arbSrc) && /opportunityFactsFrom\(a\.opportunity\)/.test(arbSrc) && /OPPORTUNITY_COMBINATION_BRIEF/.test(arbSrc) && /opportunity:\s*moved\.opportunity/.test(arbSrc),
      "stripped source: the arbiter carries the hook's opportunity through loadLifeChangeSignals into its facts and appends the combination brief to its system prompt")
  }

  // ── F ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nF. source — the expert brief, the hook's shape, no fixed timetable")
  {
    ok(mv.MOVEMENT_DECISION_SYSTEM.includes(od.OPPORTUNITY_COMBINATION_BRIEF), "the movement manager's decision prompt carries the combination brief (one model call, no second)")
    const brief = od.OPPORTUNITY_COMBINATION_BRIEF
    ok(/behavioural researcher with a conscience/.test(brief) && /NONE of them alone/.test(brief) && /never raise/.test(brief) && /never exploit hardship/.test(brief) && /Paid research is a cost/.test(brief), "the brief names the role, the single-observation rule, the policy ceiling, the never-exploit rule and the cost rule")
    const sig = blankStrings(src("lib/intent/movement-signals.ts"))
    // WAVE 150 (150JNAD): re-asserted to the RULE — the hook returns the reading and the menu (now beside the C37 moment and the
    // C38 plays); the pinned literal `{ reading, menu }` was a waypoint.
    ok(/opportunity:\s*\{\s*reading,\s*menu\b/.test(sig) && /stageAtLeast\(reading\.primary\.stage,/.test(sig), "stripped source: the arbiter hook returns { reading, menu, … } and gates the life change on the reading's stage")
    {
      // 149Z (this lane's Outside-lane 2): the public view endpoint stores a viewer contact only when it is the POST's tenant's.
      const tv = blankStrings(src("app/api/blog/track-view/route.ts"))
      const tvRaw = src("app/api/blog/track-view/route.ts")
      ok(!/viewer_contact_id:\s*body\.contact_id/.test(tvRaw) && /\.eq\("brokerage_id", p\.brokerage_id\)/.test(tvRaw) && /viewer_contact_id:\s*viewerContactId/.test(tv),
        "the public blog view endpoint never stores a body-supplied contact id unverified — only a contact of the post's own tenant (else null)")
      ok(/viewer_contact_id:\s*body\.contact_id/.test("viewer_contact_id: body.contact_id ?? null"), "(positive control) the finder sees the old unverified write")
    }
    const TIMETABLE = /\b\d+\s*\*?\s*(?:DAY_MS|days?\b|hours?\b|weeks?\b)|reminderDaysBefore|cadence\s*[:=]\s*\d/
    const mod = blankStrings(src("lib/intent/opportunity-discovery.ts"))
    ok(!TIMETABLE.test(mod) && TIMETABLE.test("const reminderDaysBefore = 7"), "no fixed timetable in the opportunity module (control: a planted `reminderDaysBefore = 7` is caught)")
  }

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); console.log("❌ OPPORTUNITY_DISCOVERY_FAIL"); process.exit(1) }
  console.log("✅ OPPORTUNITY_DISCOVERY_PASS")
}

main().catch((e) => { console.error(e); console.log("❌ OPPORTUNITY_DISCOVERY_FAIL (threw)"); process.exit(1) })
