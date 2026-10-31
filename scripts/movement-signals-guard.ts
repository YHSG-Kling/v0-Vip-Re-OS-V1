#!/usr/bin/env tsx
/**
 * scripts/movement-signals-guard.ts  (npm run test:movement-signals)
 * ────────────────────────────────────────────────────────────────────────
 * WAVE 147, LANE 147B — owner rulings 3 + 4, contract C9 (Real Estate Life & Movement Signals), DRIVEN through the real modules on
 * an in-memory database (no network, no model, no vendor; the model seams are injected), each refusal beside its positive control:
 *
 *   A. REGISTRY COMPLETENESS — derived from the survivors, never a hardcoded count: every INTENT_SIGNAL_SOURCES key and every
 *      acquisition SourceKey is a movement row or an exclusion with its reason; every row carries kind / licence / consent /
 *      delivery / freshness / cost class / how-obtained; the brief's C9 families are each represented; WAITING_EXTERNAL rows cannot record.
 *   B. C9 SHAPE + THE EPISTEMIC RULE — the persisted row matches m892's columns; an inference cannot carry a reference (type AND
 *      runtime AND m892 CHECK); a source's ceiling is never exceeded; an inferred label never reads as verified.
 *   C. PRIVACY REFUSALS — no intimate inference, no third-party gossip, no automated capture of a manual-only source, no record from a
 *      source not permitted on standard terms, no anonymous first-party record; protected proxies stored and targeting-prohibited;
 *      raw signals are a lead-desk read; an agent never reads an intimate event's name.
 *   D. COMBINATION — scored combinations, never a single keyword; repeats never stack; context never scores alone; the score explains
 *      itself line by line; outcomes re-weight the sources (with a minimum sample).
 *   E. THE DECISION — the manager / arbiter chooses (not the source) inside a closed menu; a refused model answer falls to the policy;
 *      offer_help rides the existing bus line / the ONE responder; the same evidence is never decided twice; expert prompts.
 *   F. POLL-AND-DIFF — a no-push source raises exactly ONCE per material transition, baseline-silent for history, survives lost item
 *      state, fails closed on an unread state, and publishes the freshness it can promise (or none).
 *   G. OUTCOMES — the loop closes (listed / opted_out / no_change), once; an UPDATE that matches nothing is a refusal.
 *   H. THE ARBITER HOOK — one LifeChangeSignal in the arbiter's own spelling, tenant-pinned, never throws.
 *
 * Scans read STRIPPED source (scripts/strip-comments.ts) — a tombstone is not a call site. BLIND SPOTS, published: the in-memory
 * client's grammar is the subset the kernel uses; the cron wiring and the arbiter wiring are Outside-lane (reported, not executed);
 * the AI seams are injected (the prompts are checked structurally, the model's real behaviour is not); m892–m894 CHECKs are checked
 * as TEXT (the database refusal itself is the integrator's VERIFY block).
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { memSupabase } from "./in-memory-supabase"
import { stripComments, blankStrings } from "./strip-comments"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import type { MovementEvidence } from "../lib/intent/movement-signals"

let passed = 0, failed = 0
const failures: string[] = []
function ok(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => { const w = console.warn, e = console.error; console.warn = () => {}; console.error = () => {}; try { return await f() } finally { console.warn = w; console.error = e } }
const raw = (p: string) => (existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), "utf8") : "")
const src = (p: string) => stripComments(raw(p))

// THE TYPE-LEVEL HALF OF THE EPISTEMIC RULE (proved by the lane's scoped `tsc --noEmit`, which includes this file): if the type ever
// admitted an inference carrying a verification reference, this directive would itself be the compile error.
// @ts-expect-error — an inferred MovementEvidence may not carry a reference
const _INFERRED_WITH_REFERENCE: MovementEvidence = { confidence: "inferred", basis: ["x"], method: "m", summary: "an inference", reference: { kind: "first_party_row", id: "x", retrievedAt: "2026-10-01T00:00:00.000Z" } }
// @ts-expect-error — a verified MovementEvidence must name its reference
const _VERIFIED_WITHOUT_REFERENCE: MovementEvidence = { confidence: "verified", summary: "a verification with nothing behind it" }
void _INFERRED_WITH_REFERENCE; void _VERIFIED_WITHOUT_REFERENCE

const B = "11111111-1111-4111-8111-111111111111", B2 = "22222222-2222-4222-8222-222222222222"
const AG = "44444444-4444-4444-8444-444444444444"
const NOW = new Date("2026-10-30T15:00:00.000Z")
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const UNIQUE = { agent_action_ledger: [["idempotency_key"]], movement_signals: [["brokerage_id", "idempotency_key"]] }
const SIG = "lib/intent/movement-signals.ts", REG = "lib/intent/movement-source-registry.ts", WATCH = "lib/intent/movement-source-watcher.ts"
const M892 = "supabase/migrations/m892-movement-signals-c9-record.sql", M893 = "supabase/migrations/m893-movement-source-polls-freshness.sql", M894 = "supabase/migrations/m894-movement-source-items-diff-state.sql"

function seed() {
  return {
    contacts: [
      { id: "c1", brokerage_id: B, contact_type: "buyer", agent_id: AG, zip_code: "78701", deleted_at: null, opted_out_at: null, life_events: [], last_life_event_detected: null },
      { id: "c2", brokerage_id: B, contact_type: "seller", agent_id: AG, zip_code: "78702", deleted_at: null, opted_out_at: null },
      { id: "c3", brokerage_id: B, contact_type: "seller", agent_id: null, zip_code: "78703", deleted_at: null, opted_out_at: null },
      { id: "c-life", brokerage_id: B, contact_type: "lifetime_customer", agent_id: AG, zip_code: "78704", deleted_at: null, opted_out_at: null },
      { id: "c-foreign", brokerage_id: B2, contact_type: "buyer", agent_id: null, zip_code: "78701", deleted_at: null, opted_out_at: null },
    ],
    leads: [
      { id: "l-open", brokerage_id: B, contact_id: null, is_active: true },
      { id: "l-conv", brokerage_id: B, contact_id: "c2", is_active: true },
    ],
    raw_scraped_leads: [] as any[], agent_action_ledger: [] as any[], movement_signals: [] as any[], movement_source_polls: [] as any[], movement_source_items: [] as any[],
    calculator_history: [] as any[], motivated_seller_signals: [] as any[], listings: [] as any[], transactions: [] as any[],
  }
}
const db = (over: Record<string, any[]> = {}, opts: Record<string, unknown> = {}) => memSupabase({ ...seed(), ...over } as never, { uuidIds: true, stampCreatedAt: true, unique: UNIQUE, ...opts })

/** A recording client: every from(t).select(cols) is logged (the column check reads it). */
function recording(inner: any) {
  const log: Array<{ table: string; cols: string | null }> = []
  const proxy = { from(t: string) { const b = inner.from(t); const sel = b.select.bind(b); b.select = (c?: string) => { log.push({ table: t, cols: c ?? "*" }); return sel(c) }; return b }, tables: inner.tables }
  return { proxy, log }
}

type Captured = { publishes: any[]; responds: any[]; agentTasks: any[]; admins: any[] }
function seams(decide?: (a: { prompt: string }) => Promise<Record<string, unknown>>) {
  const cap: Captured = { publishes: [], responds: [], agentTasks: [], admins: [] }
  const deps = {
    now: NOW, windowDays: 180,
    publish: (async (s: any) => { cap.publishes.push(s); return { ok: true, signalId: "sig" } }) as never,
    respond: (async (_svc: any, i: any) => { cap.responds.push(i); return { action: "lead_signal_recorded", subjectClass: "lead", kind: "moving", reason: "recorded" } }) as never,
    routeToAgent: (async (_svc: any, a: any) => { cap.agentTasks.push(a); return true }) as never,
    notifyAdmins: async (p: any) => { cap.admins.push(p); return 1 },
    decide: (decide ?? (async () => { throw new Error("no model in the proof") })) as never,
  }
  return { cap, deps }
}

async function main() {
  const mv = await import("../lib/intent/movement-signals")
  const watcher = await import("../lib/intent/movement-source-watcher")
  const iss = await import("../lib/enrichment/intent-signal-sources")
  const sim = await import("../lib/lead-pipeline/source-intent-map")
  const arb = await import("../lib/ai-isa/followup-arbiter")

  // ── A. REGISTRY COMPLETENESS ────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nA. registry completeness (derived from the survivors)")
  {
    const uncovered = (keys: readonly string[]) => keys.filter((k) => !mv.movementSourceKeyForIntentSource(k) && !mv.MOVEMENT_EXCLUDED_INTENT_SOURCES[k])
    const intentKeys = iss.INTENT_SIGNAL_SOURCES.map((s) => s.key)
    ok(uncovered(intentKeys).length === 0, `every INTENT_SIGNAL_SOURCES key (${intentKeys.length}) is a movement row or an exclusion with its reason`, uncovered(intentKeys).join(", "))
    ok(uncovered([...intentKeys, "a_new_provider_field"]).join() === "a_new_provider_field", "(positive control) a provider field added to the census without a movement reading is CAUGHT")
    const linked = new Set(mv.MOVEMENT_SIGNAL_SOURCES.flatMap((r) => (r.survivor.kind === "acquisition_source" ? [r.survivor.key] : [])))
    const acqUncovered = (keys: readonly string[]) => keys.filter((k) => !linked.has(k as never) && !(mv.ACQUISITION_NOT_MOVEMENT as Record<string, string>)[k])
    ok(acqUncovered(sim.ALL_SOURCE_KEYS).length === 0, `every acquisition SourceKey (${sim.ALL_SOURCE_KEYS.length}) is a movement row or excluded with its reason`, acqUncovered(sim.ALL_SOURCE_KEYS).join(", "))
    ok(acqUncovered([...sim.ALL_SOURCE_KEYS, "brand_new_scraper"]).join() === "brand_new_scraper", "(positive control) a new scraping lane with no movement reading is CAUGHT")
    ok([...linked].every((k) => (sim.ALL_SOURCE_KEYS as string[]).includes(k)), "every acquisition link names a real SourceKey")
    const kinds = new Set(mv.MOVEMENT_SIGNAL_SOURCES.map((r) => r.kind))
    ok(mv.MOVEMENT_SOURCE_KINDS.every((k) => kinds.has(k)), `all five source kinds are represented (${[...kinds].join(", ")})`)
    const incomplete = mv.MOVEMENT_SIGNAL_SOURCES.filter((r) => !r.licence.collection || !r.licence.terms || r.consent.length < 10 || r.freshness.length < 10 || r.howObtained.length < 30 || !(mv.COST_CLASSES as readonly string[]).includes(r.costClass) || !(mv.EPISTEMIC_CLASSES as readonly string[]).includes(r.maxConfidence) || (r.delivery === "poll" && !r.cadenceMinutes) || r.relevance.length === 0)
    ok(incomplete.length === 0, `every row (${mv.MOVEMENT_SIGNAL_SOURCES.length}) carries kind, licence, consent, push/poll, freshness, cost class, ceiling and how it is obtained`, incomplete.map((r) => r.key).join(", "))
    ok(new Set(mv.MOVEMENT_SIGNAL_SOURCES.map((r) => r.key)).size === mv.MOVEMENT_SIGNAL_SOURCES.length, "one row per source (no duplicate keys)")
    const has = (pred: (r: (typeof mv.MOVEMENT_SIGNAL_SOURCES)[number]) => boolean) => mv.MOVEMENT_SIGNAL_SOURCES.some(pred)
    const families: Array<[string, boolean]> = [
      ["public 'looking for an agent' post", has((r) => r.kind === "public_post" && r.relevance.includes("seeking_agent"))],
      ["consented site behaviour — valuation", has((r) => r.key === "fp_valuation_request")], ["— saved homes", has((r) => r.key === "fp_saved_homes")],
      ["— affordability / equity calculators", has((r) => r.key === "fp_calc_mortgage_comparison") && has((r) => r.key === "fp_calc_seller_net")], ["— relocation guides", has((r) => r.key === "fp_relocation_guide")],
      ["— repeated searches", has((r) => r.key === "fp_repeat_property_views")], ["property events — permits", has((r) => r.key === "pr_permit_activity")], ["— listing activity", has((r) => r.key === "pr_mls_status_change")],
      ["publicly disclosed divorce", has((r) => r.relevance.includes("divorce"))], ["probate / estate", has((r) => r.relevance.includes("probate_estate") && r.kind === "property_public_record")], ["relocation", has((r) => r.relevance.includes("relocation"))],
      ["employer relocation / community change", has((r) => r.key === "cm_warn_notice" || r.key === "cm_employer_expansion")], ["developments", has((r) => r.key === "cm_development_or_rezoning")], ["market events", has((r) => r.relevance.includes("market_event"))],
      ["Versium observations", has((r) => r.survivor.kind === "intent_signal_source" && r.key.startsWith("po_online"))], ["PeopleData observations", has((r) => r.key === "po_job_change")],
    ]
    ok(families.every(([, v]) => v), "every C9 family of requirement 2 has a registry row", families.filter(([, v]) => !v).map(([k]) => k).join(", "))
    const fpTables = mv.MOVEMENT_SIGNAL_SOURCES.flatMap((r) => (r.survivor.kind === "first_party_table" ? [r.survivor.table] : []))
    const missingTables = [...new Set(fpTables)].filter((t) => !SCHEMA_SNAPSHOT[t])
    ok(missingTables.length === 0, `every first-party survivor table exists in the live-schema cache (${new Set(fpTables).size})`, missingTables.join(", "))
    ok(!SCHEMA_SNAPSHOT["definitely_not_a_table"], "(positive control) the cache check refuses an invented table")
    const poll = mv.MOVEMENT_SIGNAL_SOURCES.filter((r) => r.delivery === "poll"), push = mv.MOVEMENT_SIGNAL_SOURCES.filter((r) => r.delivery === "push")
    ok(poll.length > 0 && push.length > 0 && poll.every((r) => r.status !== "live" || r.cadenceMinutes! > 0), `push vs poll declared (${poll.length} poll, ${push.length} push — both pushes WAITING_EXTERNAL: ${push.every((r) => r.status === "waiting_external")})`)
    const dm = mv.MOVEMENT_SIGNAL_SOURCES.find((r) => r.key === "we_dealmachine")
    ok(!!dm && dm.licence.collection === "not_permitted" && /NOT proof a consumer is ready to move/.test(dm.licence.terms), "lane 147D's note is in the registry: a DealMachine prospect lifecycle event is NOT proof a consumer is ready to move")
    ok(mv.NOT_PERMITTED_MOVEMENT_SOURCES.some((s) => /trigger leads/.test(s.what)) && mv.NOT_PERMITTED_MOVEMENT_SOURCES.some((s) => /intimate inference/.test(s.why)), `the NOT-permitted catalogue is published (${mv.NOT_PERMITTED_MOVEMENT_SOURCES.length} entries: trigger leads, utilities, FERPA, health, location, private content …)`)
    const order = mv.RESEARCH_STRATEGIES.map((s) => mv.COST_CLASSES.indexOf(s.costClass))
    ok(order.every((v, i) => i === 0 || v >= order[i - 1]) && mv.RESEARCH_STRATEGIES.filter((s) => s.costClass === "platform_paid" || s.costClass === "paid_enrichment").every((s) => s.gate === "mayUseAndAfford"), "research strategies run cheapest first; every paid one is behind mayUseAndAfford")
    ok(mv.NEIGHBOURLY_HELPERS.length >= 6 && mv.NEIGHBOURLY_HELPERS.every((h) => h.never.length > 0 && h.offer.length > 20), `neighbourly helpers are capability descriptors with the evidence they need and what they must never do (${mv.NEIGHBOURLY_HELPERS.length})`)
  }

  // ── B. C9 SHAPE + THE EPISTEMIC RULE ────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nB. C9 shape + the epistemic rule")
  {
    const m892 = raw(M892)
    const body = /CREATE TABLE IF NOT EXISTS public\.movement_signals \(([\s\S]*?)\n\);/.exec(m892)?.[1] ?? ""
    const cols = new Set([...body.matchAll(/^\s{2}([a-z_]+)\s+(?:uuid|text\[\]|text|jsonb|timestamptz|boolean|integer)\b/gm)].map((m) => m[1]))
    ok(cols.has("evidence") && cols.has("confidence") && !cols.has("CONSTRAINT"), `m892's columns parsed (${cols.size})`)
    const d = db()
    const { deps } = seams()
    const r = await quiet(() => mv.recordMovementSignal(d as never, {
      brokerageId: B, subject: { type: "contact", id: "c1" }, sourceKey: "fp_calc_moving_cost", eventRelevance: "relocation", identity: "record_key", capturedBy: "automation", observedAt: daysAgo(2),
      evidence: { confidence: "verified", reference: { kind: "first_party_row", id: "calculator_history:k1", retrievedAt: daysAgo(2) }, summary: "ran the moving cost calculator" },
    }, { ...deps, route: false }))
    const row = d.tables.movement_signals[0]
    ok(r.status === "recorded" && !!row, `a C9 record lands (status ${r.status})`)
    const extra = row ? Object.keys(row).filter((k) => !cols.has(k) && k !== "id" && k !== "created_at") : ["<no row>"]
    ok(extra.length === 0, "every column the writer sets EXISTS in m892", extra.join(", "))
    ok(row && row.confidence === "verified" && row.source_kind === "first_party_behaviour" && row.event_relevance === "relocation" && row.outreach === "consent_gated" && row.next_action == null && row.outcome == null,
      "the row carries person → source → evidence → observed_at → confidence → relevance; next action and outcome are NOT the source's to set")
    ok(d.tables.agent_action_ledger.some((l: any) => l.action === "intent.movement_signal.record" && l.status === "executed"), "the record is ledgered (intent.movement_signal.record)")
    const again = await quiet(() => mv.recordMovementSignal(d as never, {
      brokerageId: B, subject: { type: "contact", id: "c1" }, sourceKey: "fp_calc_moving_cost", eventRelevance: "relocation", identity: "record_key", capturedBy: "automation", observedAt: daysAgo(2),
      evidence: { confidence: "verified", reference: { kind: "first_party_row", id: "calculator_history:k1", retrievedAt: daysAgo(2) }, summary: "ran the moving cost calculator" },
    }, { ...deps, route: false }))
    ok(again.status === "replayed" && d.tables.movement_signals.length === 1, "the same trace twice is ONE record (consumed once)")
    const inferredWithRef = await quiet(() => mv.recordMovementSignal(db() as never, {
      brokerageId: B, subject: { type: "contact", id: "c1" }, sourceKey: "po_online_real_estate_activity", eventRelevance: "property_event", identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(3),
      evidence: { confidence: "inferred", basis: ["versium:x"], method: "model", summary: "modeled indicator", reference: { kind: "first_party_row", id: "x", retrievedAt: daysAgo(3) } } as never,
    }, { ...deps, route: false }))
    ok(inferredWithRef.status === "refused" && (inferredWithRef as any).code === "bad_evidence", "RUNTIME: an inference carrying a reference is refused (a cast cannot smuggle it past the type)")
    const overCeiling = await quiet(() => mv.recordMovementSignal(db() as never, {
      brokerageId: B, subject: { type: "contact", id: "c1" }, sourceKey: "po_online_real_estate_activity", eventRelevance: "property_event", identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(3),
      evidence: { confidence: "verified", reference: { kind: "first_party_row", id: "x", retrievedAt: daysAgo(3) }, summary: "modeled indicator presented as verified" },
    }, { ...deps, route: false }))
    ok(overCeiling.status === "refused" && (overCeiling as any).code === "above_source_ceiling", "a modeled vendor indicator can never be recorded as verified (source ceiling)")
    const asInferred = await quiet(() => mv.recordMovementSignal(db() as never, {
      brokerageId: B, subject: { type: "contact", id: "c1" }, sourceKey: "po_online_real_estate_activity", eventRelevance: "property_event", identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(3),
      evidence: { confidence: "inferred", basis: ["versium:online_real_estate_activity"], method: "vendor model", summary: "modeled indicator" },
    }, { ...deps, route: false }))
    ok(asInferred.status === "recorded", "(control) the same indicator recorded as inferred is accepted")
    ok(/CONSTRAINT movement_signals_inferred_shape CHECK \(confidence <> 'inferred' OR \(evidence \? 'basis' AND NOT \(evidence \? 'reference'\)\)\)/.test(m892), "DATABASE: m892 refuses an inferred row carrying a reference (inferred never reads as verified, for every writer)")
    const line1 = m892.split("\n")[0]
    ok(line1 === "-- WRITTEN, NOT APPLIED (wave 147, lane 147B) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN are owner SQL-editor" || line1.startsWith("-- ── APPLIED LIVE "), "m892 line 1 is the lane stamp or the APPLIED LIVE stamp (the rule, not the waypoint)")
    ok([M893, M894].every((p) => { const l = raw(p).split("\n")[0]; return l.startsWith("-- WRITTEN, NOT APPLIED (wave 147, lane 147B)") || l.startsWith("-- ── APPLIED LIVE ") }), "m893 / m894 carry the stamp")
  }

  // ── C. PRIVACY REFUSALS ─────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nC. privacy refusals (at the record, not the reader)")
  {
    const { deps } = seams()
    const rec = (input: any, d: any = db()) => quiet(() => mv.recordMovementSignal(d as never, { brokerageId: B, observedAt: daysAgo(5), capturedBy: "automation", ...input }, { ...deps, route: false }))
    const inferredDivorce = await rec({ subject: { type: "contact", id: "c1" }, sourceKey: "pp_web_mention_life_event", eventRelevance: "divorce", identity: "name_only", evidence: { confidence: "inferred", basis: ["behaviour:searched one-bedroom apartments"], method: "behaviour", summary: "searched for smaller homes" } })
    ok(inferredDivorce.status === "refused" && (inferredDivorce as any).code === "intimate_inference", "a divorce is NEVER inferred from behaviour")
    const gossip = await rec({ subject: { type: "contact", id: "c1" }, sourceKey: "pp_web_mention_life_event", eventRelevance: "probate_estate", identity: "name_only", evidence: { confidence: "reported", reportedBy: "third_party", reference: { kind: "public_post", id: "post:9", retrievedAt: daysAgo(5) }, summary: "a neighbour posted that his mother died" } })
    ok(gossip.status === "refused" && (gossip as any).code === "third_party_intimate", "a third party's POST about a named person's death is not evidence")
    const notice = await rec({ subject: { type: "contact", id: "c1" }, sourceKey: "pp_web_mention_life_event", eventRelevance: "probate_estate", identity: "name_only", evidence: { confidence: "reported", reportedBy: "third_party", reference: { kind: "news", id: "https://example.org/notices/estate-of", retrievedAt: daysAgo(5) }, summary: "a published estate notice names this person" } }, db())
    ok(notice.status === "recorded", "(control) a PUBLISHED estate notice is recorded — name-only until a person confirms")
    const d1 = db()
    const verifiedProbate = await rec({ subject: { type: "contact", id: "c2" }, sourceKey: "pr_batchdata_quicklist", eventRelevance: "probate_estate", identity: "verified_match", evidence: { confidence: "reported", reportedBy: "provider", reference: { kind: "vendor_compiled_record", id: "mss:1", retrievedAt: daysAgo(5) }, summary: "vendor lists the property as inherited" } }, d1)
    const vr = d1.tables.movement_signals[0]
    ok(verifiedProbate.status === "recorded" && vr?.targeting_prohibited === true && vr?.sensitivity === "intimate_service_topic", "an estate record is STORED (ruling 2) and targeting-prohibited, as an intimate service topic")
    const nd = await rec({ subject: { type: "contact", id: "c1" }, sourceKey: "pp_nextdoor", eventRelevance: "seeking_agent", identity: "verified_match", evidence: { confidence: "reported", reportedBy: "self", reference: { kind: "public_post", id: "nd:1", retrievedAt: daysAgo(5) }, summary: "asked neighbours for an agent" } })
    ok(nd.status === "refused" && (nd as any).code === "manual_capture_only", "a behind-login source refuses an AUTOMATED capture")
    const d2 = db()
    const ndStaff = await rec({ capturedBy: "staff", subject: { type: "contact", id: "c1" }, sourceKey: "pp_nextdoor", eventRelevance: "seeking_agent", identity: "verified_match", evidence: { confidence: "reported", reportedBy: "self", reference: { kind: "public_post", id: "nd:1", retrievedAt: daysAgo(5) }, summary: "asked neighbours for an agent" } }, d2)
    ok(ndStaff.status === "recorded" && d2.tables.movement_signals[0]?.outreach === "none", "(control) a person recording what they saw is accepted — and carries NO automated outreach")
    const dmRec = await rec({ subject: { type: "contact", id: "c1" }, sourceKey: "we_dealmachine", eventRelevance: "property_event", identity: "verified_match", evidence: { confidence: "reported", reportedBy: "provider", reference: { kind: "provider_field", id: "dm:1", retrievedAt: daysAgo(5) }, summary: "prospect moved stage" } })
    const ncoa = await rec({ subject: { type: "contact", id: "c1" }, sourceKey: "we_usps_ncoa", eventRelevance: "relocation", identity: "verified_match", evidence: { confidence: "verified", reference: { kind: "recorder_record", id: "ncoa:1", retrievedAt: daysAgo(5) }, summary: "a change of address" } })
    ok(dmRec.status === "refused" && (dmRec as any).code === "source_not_permitted" && ncoa.status === "refused" && (ncoa as any).code === "source_waiting_external", "a source not permitted on standard terms (DealMachine) and a WAITING_EXTERNAL one (NCOA) cannot record")
    const anon = await rec({ subject: { type: "contact", id: "c1" }, sourceKey: "fp_saved_homes", eventRelevance: "property_event", identity: "verified_match", evidence: { confidence: "verified", reference: { kind: "first_party_row", id: "sp:1", retrievedAt: daysAgo(5) }, summary: "saved a home" } })
    ok(anon.status === "refused" && (anon as any).code === "anonymous_first_party", "first-party behaviour is recorded only for a person identified by their OWN row")
    const d3 = db()
    const marriage = await quiet(async () => { const b = mv.movementSignalFromLifeEvent({ brokerageId: B, contactId: "c1", event: { event: "marriage", url: "https://example.org/announcements/1", publishedDate: daysAgo(10) }, detectedAt: daysAgo(9) }); return b.ok ? mv.recordMovementSignal(d3 as never, b.record, { ...deps, route: false }) : b })
    const mr = d3.tables.movement_signals[0]
    ok((marriage as any).status === "recorded" && mr?.protected_proxy === true && mr?.targeting_prohibited === true && mr?.identity_match === "name_only", "a marital-status proxy (marriage) is stored, protected-proxy, targeting-prohibited, name-only")
    const d4 = db()
    await rec({ subject: { type: "raw_lead", id: "r-1" }, sourceKey: "pp_agent_seeking_phrase", eventRelevance: "seeking_agent", identity: "record_key", evidence: { confidence: "reported", reportedBy: "self", reference: { kind: "public_post", id: "post:1", retrievedAt: daysAgo(5) }, summary: "asked for a realtor" } }, d4)
    ok(d4.tables.movement_signals[0]?.outreach === "none", "a raw lead consented to nothing: outreach 'none' at the record")
    ok(/CREATE POLICY movement_signals_lead_desk_read[\s\S]*?public\.is_lead_visible_role\(\)/.test(raw(M892)) && /REVOKE INSERT, UPDATE, DELETE ON public\.movement_signals FROM authenticated, anon/.test(raw(M892)), "raw signals are a LEAD-DESK read in the database (is_lead_visible_role) and service-role written")
    const viewers = mv.MOVEMENT_RAW_SIGNAL_VIEWERS
    ok(viewers.has("broker") && viewers.has("isa") && !viewers.has("compliance_officer") && !viewers.has("agent"), "the app-side roster is LEAD_DESK_USER_TYPES: brokers and the ISA yes; compliance officer and agents no")
    // NO BYPASS: a hand-built record handed straight to the recorder is re-validated (the rules hold on every path)
    const smuggled = { brokerageId: B, subject: { type: "contact", id: "c1" }, sourceKey: "pp_web_mention_life_event", sourceKind: "public_post", eventRelevance: "divorce", identity: "name_only", capturedBy: "automation", observedAt: daysAgo(5),
      evidence: { confidence: "inferred", basis: ["behaviour:x"], method: "guess", summary: "searched for one-bedroom apartments" }, intents: [], side: "unknown", confidence: "inferred", protectedProxy: false, targetingProhibited: false,
      sensitivity: "behaviour", dataRights: {}, outreach: "consent_gated", propertyAddress: null, idempotencyKey: "smuggled:1", nextAction: null, outcome: null }
    const sm = await quiet(() => mv.recordMovementSignal(db() as never, smuggled as never, { ...deps, route: false }))
    ok(sm.status === "refused" && (sm as any).code === "intimate_inference", "NO BYPASS: a hand-built record (an inferred divorce, flags forged off) is re-validated and refused")
    ok(/CONSTRAINT movement_signals_no_intimate_inference/.test(raw(M892)) && /CONSTRAINT movement_signals_targeting_prohibited/.test(raw(M892)) && /CONSTRAINT movement_signals_outreach_by_subject/.test(raw(M892)), "m892 re-enforces no-intimate-inference, targeting-prohibited and no-outreach-without-consent as CHECKs")
    // the classifier: a quote or nothing
    const cls = (reply: Record<string, unknown>, text = "Hi all — we're moving to Austin in the spring and I'm looking for a realtor recommendation!") =>
      mv.classifyPublicMovementText({ brokerageId: B, text, sourceKey: "pp_agent_seeking_phrase" }, { classify: async () => reply })
    const invented = await cls({ relevant: true, event_relevance: "seeking_agent", about: "author", side: "buyer", timeline_bucket: "3-6", quote: "we need an agent ASAP", needs_person: false, note: "x" })
    ok(invented.source === "refused" && /verbatim/.test(invented.refusedWhy ?? ""), "the classifier's quote must be VERBATIM — an invented quote is refused")
    const third = await cls({ relevant: true, event_relevance: "divorce", about: "third_party", side: "seller", timeline_bucket: "unknown", quote: "we're moving to Austin", needs_person: false, note: "x" })
    ok(third.source === "refused", "an intimate reading about someone other than the author is refused")
    const good = await cls({ relevant: true, event_relevance: "seeking_agent", about: "author", side: "buyer", timeline_bucket: "3-6", quote: "I'm looking for a realtor recommendation", needs_person: false, note: "asking for an agent" })
    const built = mv.movementSignalFromPublicPost({ brokerageId: B, subject: { type: "raw_lead", id: "r-2" }, sourceKey: "pp_agent_seeking_phrase", postId: "p2", postedAt: daysAgo(1), retrievedAt: daysAgo(1), reading: good })
    ok(good.source === "ai" && built.ok && built.record.confidence === "reported" && (built.record.evidence as any).reportedBy === "self", "(control) an author-voiced verbatim quote becomes `reported` (self) — the PLATFORM assigns the class, not the model")
    const noQuote = mv.movementSignalFromPublicPost({ brokerageId: B, subject: { type: "raw_lead", id: "r-3" }, sourceKey: "pp_agent_seeking_phrase", postId: "p3", postedAt: daysAgo(1), retrievedAt: daysAgo(1), reading: { ...good, about: "unclear" } })
    ok(noQuote.ok && noQuote.record.confidence === "inferred", "a reading without an author-voiced quote is only `inferred`")
  }

  // ── D. COMBINATION ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nD. combination — never a single keyword; the score explains itself")
  {
    const post = (id: string, at = daysAgo(3)) => ({ brokerageId: B, subject: { type: "contact" as const, id: "c1" }, sourceKey: "pp_agent_seeking_phrase", eventRelevance: "seeking_agent" as const, identity: "verified_match" as const, capturedBy: "automation" as const, observedAt: at, side: "buyer" as const,
      evidence: { confidence: "reported" as const, reportedBy: "self" as const, reference: { kind: "public_post" as const, id, retrievedAt: at }, summary: "asked publicly for a realtor" } })
    const d = db()
    const { cap, deps } = seams()
    const one = await quiet(() => mv.recordMovementSignal(d as never, post("post:1"), deps))
    const c1 = one.status === "recorded" ? one.evaluation?.combination : undefined
    ok(!!c1 && c1.score <= mv.SINGLE_KIND_CAP && c1.band !== "warm" && c1.band !== "act", `ONE public post alone stays under the warm line (score ${c1?.score}, ${c1?.band})`, c1?.explanation)
    ok(!!c1 && /prior pts × reported 0\.75 × identity verified_match 1 × recency/.test(c1.explanation) && /= \d/.test(c1.explanation), "the score explains itself: points × class × identity × recency = value, per contribution")
    ok(one.status === "recorded" && !one.evaluation?.decision?.allowed.includes("offer_help") && cap.publishes.length === 0, `a single source never earns an automated offer (allowed: ${one.status === "recorded" ? one.evaluation?.decision?.allowed.join("/") : "?"})`)
    const two = await quiet(() => mv.recordMovementSignal(d as never, post("post:2", daysAgo(2)), deps))
    const c2 = two.status === "recorded" ? two.evaluation?.combination : undefined
    ok(!!c2 && c2.score === c1!.score + 0 || (!!c2 && c2.score <= mv.SINGLE_KIND_CAP && c2.contributions.filter((c) => c.superseded).length === 1), `a SECOND post from the same source never stacks (one superseded; score ${c2?.score})`)
    const fb = await quiet(() => mv.recordMovementSignal(d as never, { ...post("fb:1", daysAgo(1)), sourceKey: "pp_facebook_recommend_realtor" }, deps))
    const cfb = fb.status === "recorded" ? fb.evaluation?.combination : undefined
    ok(!!cfb && cfb.score === mv.SINGLE_KIND_CAP && cfb.caps.some((c) => /single source is never a move/.test(c)) && cfb.independentKinds.length === 1, `two keyword hits from the SAME source kind (two public posts) are still ONE kind — capped at ${mv.SINGLE_KIND_CAP} (raw sum above it)`, cfb?.explanation)
    const calc = await quiet(() => mv.recordMovementSignal(d as never, { brokerageId: B, subject: { type: "contact", id: "c1" }, sourceKey: "fp_calc_neighborhood_compare", eventRelevance: "relocation", identity: "record_key", capturedBy: "automation", observedAt: daysAgo(1),
      evidence: { confidence: "verified", reference: { kind: "first_party_row", id: "calculator_history:n1", retrievedAt: daysAgo(1) }, summary: "compared neighbourhoods" } }, deps))
    const c3 = calc.status === "recorded" ? calc.evaluation?.combination : undefined
    ok(!!c3 && c3.corroborated && c3.independentKinds.length === 2 && c3.caps.some((c) => /corroboration/.test(c)) && c3.score > cfb!.score, `INDEPENDENT corroboration (public post + the person's own calculator) lifts the score (${c1?.score} → ${c3?.score}, ${c3?.independentKinds.join(" + ")})`)
    const inf = db()
    const infRes = await quiet(async () => {
      await mv.recordMovementSignal(inf as never, { brokerageId: B, subject: { type: "contact", id: "c2" }, sourceKey: "po_online_real_estate_activity", eventRelevance: "property_event", identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(1), evidence: { confidence: "inferred", basis: ["versium:a"], method: "vendor model", summary: "modeled online activity" } }, { ...deps, route: false })
      return mv.recordMovementSignal(inf as never, { brokerageId: B, subject: { type: "contact", id: "c2" }, sourceKey: "pr_owner_rental_listing", eventRelevance: "property_event", identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(1), evidence: { confidence: "inferred", basis: ["raw:rent1"], method: "owner listed for rent", summary: "listed their home for rent" } }, deps)
    })
    const ci = infRes.status === "recorded" ? infRes.evaluation?.combination : undefined
    ok(!!ci && ci.score <= mv.INFERRED_ONLY_CAP && /an inference, not a fact/.test(ci.explanation) && ci.contributions.every((c) => c.confidence !== "inferred" || (/^Inferred from .* — an inference, not a fact — /.test(c.reason) && !/^Verified|confirmed/i.test(c.reason))), `inferences only stay "watch" (≤ ${mv.INFERRED_ONLY_CAP}) and every inferred line reads "an inference, not a fact" — never verified / confirmed`)
    // context alone never scores (the arbiter hook over a contact whose only evidence is its ZIP's market context)
    const ctx = db()
    await quiet(() => mv.recordMovementSignal(ctx as never, { brokerageId: B, subject: { type: "territory", territoryKey: "zip:78703" }, sourceKey: "cm_rate_move", eventRelevance: "market_event", identity: "none", capturedBy: "automation", observedAt: daysAgo(2), evidence: { confidence: "verified", reference: { kind: "open_data_record", id: "rate:2026-10-29", retrievedAt: daysAgo(2) }, summary: "the weekly average rate fell" } }, deps))
    const hookCtx = await quiet(() => mv.movementSignalsForArbiter(ctx as never, { brokerageId: B, contactId: "c3", now: NOW, windowDays: 180 }))
    ok(hookCtx.signals.length === 0 && /context alone never scores/.test(hookCtx.explanation ?? ""), "market / community CONTEXT alone never scores a person", hookCtx.explanation ?? "")
    // learning: closed outcomes re-weight a source — only past the minimum sample
    const closed = (key: string, outcome: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${key}-${outcome}-${i}`, brokerage_id: B, subject_type: "contact", contact_id: "c-life", source_key: key, outcome, outcome_at: daysAgo(400), observed_at: daysAgo(500), event_relevance: "seeking_agent", confidence: "reported", identity_match: "verified_match", evidence: {}, outreach: "consent_gated", protected_proxy: false, side: "unknown", intents: [] }))
    const learn = db({ movement_signals: [...closed("pp_agent_seeking_phrase", "false_positive", 25), ...closed("fp_calc_neighborhood_compare", "listed", 25)] })
    await quiet(() => mv.recordMovementSignal(learn as never, post("post:L"), { ...deps, route: false }))
    const lres = await quiet(() => mv.recordMovementSignal(learn as never, { brokerageId: B, subject: { type: "contact", id: "c1" }, sourceKey: "fp_calc_neighborhood_compare", eventRelevance: "relocation", identity: "record_key", capturedBy: "automation", observedAt: daysAgo(1), evidence: { confidence: "verified", reference: { kind: "first_party_row", id: "calculator_history:L", retrievedAt: daysAgo(1) }, summary: "compared neighbourhoods" } }, deps))
    const lc = lres.status === "recorded" ? lres.evaluation?.combination?.contributions ?? [] : []
    const postW = /learned ([0-9.]+)/.exec(lc.find((c) => c.sourceKey === "pp_agent_seeking_phrase")?.reason ?? "")?.[1], calcW = /learned ([0-9.]+)/.exec(lc.find((c) => c.sourceKey === "fp_calc_neighborhood_compare")?.reason ?? "")?.[1]
    ok(!!postW && !!calcW && Number(postW) < 1 && Number(calcW) > 1, `OUTCOMES re-weight the sources: 25 false positives → post × ${postW}; 25 listings → calculator × ${calcW}`)
    const small = db({ movement_signals: closed("pp_agent_seeking_phrase", "false_positive", 5) })
    const sres = await quiet(() => mv.recordMovementSignal(small as never, post("post:S"), deps))
    const sc = sres.status === "recorded" ? sres.evaluation?.combination?.contributions ?? [] : []
    ok(sc.length > 0 && !sc.some((c) => /learned/.test(c.reason)), `(control) below the minimum sample (${mv.LEARNING_MIN_SAMPLE}) the priors stand — five outcomes move nothing`)
  }

  // ── E. THE DECISION ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nE. the decision — the manager / arbiter chooses inside a closed menu")
  {
    const strongPair = async (d: any, deps: any, contactId = "c1") => {
      await mv.recordMovementSignal(d as never, { brokerageId: B, subject: { type: "contact", id: contactId }, sourceKey: "pp_agent_seeking_phrase", eventRelevance: "seeking_agent", identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(2), side: "buyer", evidence: { confidence: "reported", reportedBy: "self", reference: { kind: "public_post", id: `post:${contactId}`, retrievedAt: daysAgo(2) }, summary: "asked publicly for a realtor" } }, { ...deps, route: false })
      return mv.recordMovementSignal(d as never, { brokerageId: B, subject: { type: "contact", id: contactId }, sourceKey: "fp_calc_seller_net", eventRelevance: "property_event", intents: ["home_purchase"], identity: "record_key", capturedBy: "automation", observedAt: daysAgo(1), evidence: { confidence: "verified", reference: { kind: "first_party_row", id: `calculator_history:${contactId}`, retrievedAt: daysAgo(1) }, summary: "ran the seller net calculator" } }, deps)
    }
    const prompts: string[] = []
    const aiOffer = seams(async (a) => { prompts.push(a.prompt); const p = JSON.parse(a.prompt); return { action: "offer_help", rationale: "Two independent signs, one the person's own action — offer something useful, gently.", helper_keys: ["market_update_after_interest"], research_keys: [], evidence: p.contributions.map((c: any) => c.id), confidence: 0.8 } })
    const d = db()
    const res = await quiet(() => strongPair(d, aiOffer.deps))
    const ev = res.status === "recorded" ? res.evaluation : undefined
    ok(ev?.decision?.source === "ai" && ev.decision.action === "offer_help" && ev.decision.allowed.includes("offer_help"), `the AI chose inside the menu (${ev?.decision?.allowed.join("/")}) → ${ev?.decision?.action}`, ev?.reason)
    const pub = aiOffer.cap.publishes[0]
    ok(aiOffer.cap.publishes.length === 1 && pub.signalType === "online_intent_detected" && pub.fromManager === "data_steward" && pub.toManager === "ai_isa", "offer_help rides the EXISTING handled bus line (online_intent_detected, Data Steward → AI ISA) — no new signal type")
    const mapped = pub ? arb.intentFactSignalType({ intents: pub.payload.intents, sensitivity: pub.payload.sensitivity }) : null
    ok(!!mapped && mapped in arb.LIFE_CHANGE_SIGNAL_KINDS, `the bus payload maps back, through the arbiter's OWN intentFactSignalType, to a responder spelling ("${mapped}")`)
    const stamped = d.tables.movement_signals.filter((r: any) => r.next_action === "offer_help" && r.decided_by === "ai_isa")
    ok(stamped.length === d.tables.movement_signals.length && stamped.length === 2, "the decision is stamped on every row it rested on (next_action, decided_by = the manager), never by the source")
    ok(d.tables.agent_action_ledger.some((l: any) => l.action === "intent.movement_signal.decide" && l.status === "executed"), "the decision is ledgered (intent.movement_signal.decide)")
    const again = await quiet(() => mv.recordMovementSignal(d as never, { brokerageId: B, subject: { type: "contact", id: "c1" }, sourceKey: "fp_calc_seller_net", eventRelevance: "property_event", intents: ["home_purchase"], identity: "record_key", capturedBy: "automation", observedAt: daysAgo(1), evidence: { confidence: "verified", reference: { kind: "first_party_row", id: "calculator_history:c1", retrievedAt: daysAgo(1) }, summary: "ran the seller net calculator" } }, aiOffer.deps))
    ok(again.status === "replayed" && aiOffer.cap.publishes.length === 1, "the same evidence is never decided or routed twice")
    const p0 = prompts[0] ? JSON.parse(prompts[0]) : null
    ok(!!p0 && Array.isArray(p0.allowed) && Array.isArray(p0.not_allowed) && Array.isArray(p0.helpers) && Array.isArray(p0.research) && Array.isArray(p0.contributions), "the model is given the closed menu, what is NOT allowed and why, the helpers and the research strategies — and nothing else")
    for (const [name, sys] of [["decision", mv.MOVEMENT_DECISION_SYSTEM], ["classifier", mv.MOVEMENT_CLASSIFIER_SYSTEM]] as const) {
      const parts = ["ROLE:", "BUSINESS CONTEXT:", "FACTS YOU MAY RELY ON:", "THE DECISION YOU OWN:", "OUTPUT CONTRACT", "ESCALATION"]
      ok(parts.every((p) => sys.includes(p)) && /PRIVACY/.test(sys) && /familial status/.test(sys) && sys.length > 1500, `the ${name} prompt is expert and structured (role, context, facts, decision, contract, privacy / compliance boundary, escalation — ${sys.length} chars)`)
    }
    const offMenu = seams(async (a) => { const p = JSON.parse(a.prompt); return { action: "offer_help", rationale: "Reach out now about the move, they need us.", helper_keys: [], research_keys: [], evidence: p.contributions.map((c: any) => c.id), confidence: 0.9 } })
    const d2 = db()
    const single = await quiet(() => mv.recordMovementSignal(d2 as never, { brokerageId: B, subject: { type: "contact", id: "c1" }, sourceKey: "pp_agent_seeking_phrase", eventRelevance: "seeking_agent", identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(2), side: "buyer", evidence: { confidence: "reported", reportedBy: "self", reference: { kind: "public_post", id: "post:x", retrievedAt: daysAgo(2) }, summary: "asked for a realtor" } }, offMenu.deps))
    const sd = single.status === "recorded" ? single.evaluation?.decision : undefined
    ok(sd?.source === "deterministic" && /not permitted/.test(sd.fallbackReason ?? "") && offMenu.cap.publishes.length === 0, `a model answer OFF the menu is refused → the policy's conservative step (${sd?.action}: ${sd?.fallbackReason})`)
    const noEvidence = seams(async () => ({ action: "wait", rationale: "Nothing to do yet, waiting is fine.", helper_keys: [], research_keys: [], evidence: ["made-up-id"], confidence: 0.9 }))
    const d3 = db()
    const ne = await quiet(() => strongPair(d3, noEvidence.deps))
    ok(ne.status === "recorded" && ne.evaluation?.decision?.source === "deterministic" && /cited no evidence/.test(ne.evaluation.decision.fallbackReason ?? ""), "a model answer citing no supplied evidence is refused")
    // a lead → the ONE responder directly (leads are not on the bus)
    const leadSeam = seams(async (a) => { const p = JSON.parse(a.prompt); return { action: "offer_help", rationale: "Corroborated, reachable by email — offer help.", helper_keys: [], research_keys: [], evidence: p.contributions.map((c: any) => c.id), confidence: 0.8 } })
    const d4 = db()
    await quiet(async () => {
      await mv.recordMovementSignal(d4 as never, { brokerageId: B, subject: { type: "lead", id: "l-open" }, sourceKey: "pp_agent_seeking_phrase", eventRelevance: "seeking_agent", identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(2), side: "seller", evidence: { confidence: "reported", reportedBy: "self", reference: { kind: "public_post", id: "post:l", retrievedAt: daysAgo(2) }, summary: "asked who to list with" } }, { ...leadSeam.deps, route: false })
      return mv.recordMovementSignal(d4 as never, { brokerageId: B, subject: { type: "lead", id: "l-open" }, sourceKey: "fp_calc_seller_net", eventRelevance: "property_event", intents: ["home_sale"], identity: "record_key", capturedBy: "automation", observedAt: daysAgo(1), evidence: { confidence: "verified", reference: { kind: "first_party_row", id: "calculator_history:l", retrievedAt: daysAgo(1) }, summary: "ran the seller net calculator" } }, leadSeam.deps)
    })
    const rsp = leadSeam.cap.responds[0]
    ok(leadSeam.cap.publishes.length === 0 && !!rsp && rsp.subject.type === "lead" && rsp.signalType in arb.LIFE_CHANGE_SIGNAL_KINDS && typeof rsp.strength === "number", `a LEAD is answered by the ONE responder with its existing spelling ("${rsp?.signalType}", strength ${rsp?.strength}) — email / mail only downstream`)
    // intimate → a person, redacted
    const humanSeam = seams(async (a) => { const p = JSON.parse(a.prompt); return { action: "human", rationale: "A sensitive public record — a person should decide whether and when to reach out.", helper_keys: ["estate_education_without_assumption"], research_keys: [], evidence: p.contributions.map((c: any) => c.id), confidence: 0.9 } })
    const d5 = db()
    const hr = await quiet(() => mv.recordMovementSignal(d5 as never, { brokerageId: B, subject: { type: "contact", id: "c2" }, sourceKey: "pr_batchdata_quicklist", eventRelevance: "probate_estate", identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(3), evidence: { confidence: "reported", reportedBy: "provider", reference: { kind: "vendor_compiled_record", id: "mss:p1", retrievedAt: daysAgo(3) }, summary: "the property is listed as inherited (probate)" } }, humanSeam.deps))
    const task = humanSeam.cap.agentTasks[0]
    ok(hr.status === "recorded" && !hr.evaluation?.decision?.allowed.includes("offer_help") && hr.evaluation?.decision?.action === "human", "probate is NEVER an automated offer — the manager hands it to a person")
    ok(!!task && /sensitive/i.test(task.description) && !/probate|inherit|died|death/i.test(task.description) && humanSeam.cap.publishes.length === 0, "the agent's task never names the intimate event (redacted) and nothing is sent automatically", task?.description)
    const noAgent = seams(async (a) => { const p = JSON.parse(a.prompt); return { action: "human", rationale: "A person should look at this before anything else happens.", helper_keys: [], research_keys: [], evidence: p.contributions.map((c: any) => c.id), confidence: 0.9 } })
    const d6 = db()
    await quiet(() => mv.recordMovementSignal(d6 as never, { brokerageId: B, subject: { type: "contact", id: "c3" }, sourceKey: "pr_batchdata_quicklist", eventRelevance: "probate_estate", identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(3), evidence: { confidence: "reported", reportedBy: "provider", reference: { kind: "vendor_compiled_record", id: "mss:p2", retrievedAt: daysAgo(3) }, summary: "listed as inherited" } }, noAgent.deps))
    ok(noAgent.cap.admins.length === 1 && noAgent.cap.agentTasks.length === 0, "a contact with no agent: the lead desk's admins are told instead")
    // C2: a CONVERTED lead is answered as its contact (the bus, not the lead door), and its pre-conversion traces still count
    const c2Seam = seams(async (a) => { const p = JSON.parse(a.prompt); return { action: "offer_help", rationale: "Corroborated across two kinds for a reachable contact.", helper_keys: [], research_keys: [], evidence: p.contributions.map((c: any) => c.id), confidence: 0.8 } })
    const d7 = db()
    const c2res = await quiet(async () => {
      await mv.recordMovementSignal(d7 as never, { brokerageId: B, subject: { type: "lead", id: "l-conv" }, sourceKey: "pp_agent_seeking_phrase", eventRelevance: "seeking_agent", identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(2), side: "seller", evidence: { confidence: "reported", reportedBy: "self", reference: { kind: "public_post", id: "post:conv", retrievedAt: daysAgo(2) }, summary: "asked who to list with" } }, { ...c2Seam.deps, route: false })
      return mv.recordMovementSignal(d7 as never, { brokerageId: B, subject: { type: "contact", id: "c2" }, sourceKey: "fp_calc_seller_net", eventRelevance: "property_event", intents: ["home_sale"], identity: "record_key", capturedBy: "automation", observedAt: daysAgo(1), evidence: { confidence: "verified", reference: { kind: "first_party_row", id: "calculator_history:conv", retrievedAt: daysAgo(1) }, summary: "ran the seller net calculator" } }, c2Seam.deps)
    })
    const viaLead = await quiet(() => mv.recordMovementSignal(d7 as never, { brokerageId: B, subject: { type: "lead", id: "l-conv" }, sourceKey: "fp_valuation_request", eventRelevance: "property_event", intents: ["home_sale"], identity: "record_key", capturedBy: "automation", observedAt: daysAgo(1), evidence: { confidence: "verified", reference: { kind: "first_party_row", id: "valuation_requests:conv", retrievedAt: daysAgo(1) }, summary: "requested a home value" } }, c2Seam.deps))
    const vlc = viaLead.status === "recorded" ? viaLead.evaluation?.combination : undefined
    ok(c2res.status === "recorded" && !!vlc && vlc.contributions.some((c) => c.sourceKey === "pp_agent_seeking_phrase") && c2Seam.cap.responds.length === 0 && c2Seam.cap.publishes.every((p) => p.contactId === "c2"),
      "C2: a converted lead's trace is answered as its CONTACT (bus line to c2, never the lead door) and its pre-conversion evidence still counts")
    const foreign = await quiet(() => mv.recordMovementSignal(db() as never, { brokerageId: B, subject: { type: "contact", id: "c-foreign" }, sourceKey: "fp_calc_moving_cost", eventRelevance: "relocation", identity: "record_key", capturedBy: "automation", observedAt: daysAgo(1), evidence: { confidence: "verified", reference: { kind: "first_party_row", id: "calculator_history:f", retrievedAt: daysAgo(1) }, summary: "moving cost" } }, seams().deps))
    ok(foreign.status === "recorded" && foreign.evaluation?.status === "refused" && /not in this brokerage/.test(foreign.evaluation.reason), "TENANT-PINNED: another tenant's contact is never evaluated (refused, said)")
  }

  // ── F. POLL-AND-DIFF ────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nF. poll-and-diff for sources with no push")
  {
    const d = db({ calculator_history: [
      { id: "k1", brokerage_id: B, contact_id: "c1", lead_id: null, calculator_type: "neighborhood_compare", inputs: { city: "Austin" }, created_at: daysAgo(1) },
      { id: "k-old", brokerage_id: B, contact_id: "c2", lead_id: null, calculator_type: "moving_cost", inputs: {}, created_at: daysAgo(400) },
      { id: "k-foreign", brokerage_id: B2, contact_id: "c-foreign", lead_id: null, calculator_type: "moving_cost", inputs: {}, created_at: daysAgo(1) },
    ] }, { unique: { ...UNIQUE, movement_source_polls: [["brokerage_id", "source_key"]], movement_source_items: [["brokerage_id", "source_key", "item_key"]] } })
    const { cap, deps } = seams()
    const run = (now = NOW, force = true) => quiet(() => watcher.runMovementTick(d as never, B, { now, force, reconcile: false, sources: [watcher.STORED_CALCULATOR_SOURCE] }, { movement: deps }))
    const r1 = (await run()).watch.sources[0]
    ok(r1.status === "polled" && r1.raised === 1 && r1.items === 1, `the first poll reads inside its window and raises the recent change (raised ${r1.raised}; the 400-day-old run is outside the read window)`, JSON.stringify(r1))
    ok(!d.tables.movement_signals.some((r: any) => r.contact_id === "c-foreign"), "TENANT-PINNED: another tenant's rows are never read")
    const r2 = (await run()).watch.sources[0]
    ok(r2.raised === 0, `the SAME data again raises nothing (raised ${r2.raised})`)
    d.tables.calculator_history.push({ id: "k2", brokerage_id: B, contact_id: "c1", lead_id: null, calculator_type: "neighborhood_compare", inputs: { city: "Denver" }, created_at: new Date(NOW.getTime() - 3_600_000).toISOString() })
    const r3 = (await run()).watch.sources[0]
    ok(r3.raised === 1, `a MATERIAL change (a new area compared) raises exactly ONE signal (${r3.raised})`)
    const r4 = (await run()).watch.sources[0]
    ok(r4.raised === 0, "…and only once")
    const saved = [...d.tables.movement_source_items]
    d.tables.movement_source_items.splice(0, d.tables.movement_source_items.length)
    const r5 = (await run()).watch.sources[0]
    ok(r5.raised === 0 && r5.replayed >= 1, `LOST item state does not re-raise: the transition key replays (raised ${r5.raised}, replayed ${r5.replayed})`)
    d.tables.movement_source_items.splice(0, d.tables.movement_source_items.length, ...saved)
    const poll = d.tables.movement_source_polls.find((p: any) => p.source_key === "stored:calculator_history")
    ok(!!poll && poll.last_success_at === NOW.toISOString() && poll.promised_freshness_minutes === 15 && poll.cadence_minutes === 15 && poll.last_item_count >= 0, `FRESHNESS published: last success ${poll?.last_success_at}, promised ${poll?.promised_freshness_minutes} min (cadence + upstream lag)`)
    const notDue = (await run(new Date(NOW.getTime() + 5 * 60_000), false)).watch.sources[0]
    ok(notDue.status === "not_due", "per-source cadence: a poll inside the cadence is not due")
    ok(d.tables.movement_signals.length === 2 && d.tables.agent_action_ledger.filter((l: any) => l.action === "intent.movement_signal.decide").length >= 1, "each raised change is a C9 record handed to the manager's decision")
    // BASELINE: a feed that returns standing state (not a dated cursor) — history older than the half-life is recorded silently
    const stateFeed = (items: Array<{ key: string; at: string; v: string }>) => ({
      key: "test:state_feed", registryKeys: ["fp_calc_moving_cost"], cadenceMinutes: 15,
      fetch: async () => ({ ok: true as const, items: items.map((i) => ({ itemKey: i.key, material: { v: i.v }, observedAt: i.at,
        toSignal: () => ({ ok: true as const, record: { brokerageId: B, subject: { type: "contact" as const, id: "c1" }, sourceKey: "fp_calc_moving_cost", sourceKind: "first_party_behaviour" as const, evidence: { confidence: "verified" as const, reference: { kind: "first_party_row" as const, id: i.key, retrievedAt: i.at }, summary: "priced a move" }, observedAt: i.at, eventRelevance: "relocation" as const, identity: "record_key" as const, capturedBy: "automation" as const, intents: ["moving" as const], side: "unknown" as const, confidence: "verified" as const, protectedProxy: false, targetingProhibited: false, sensitivity: "behaviour" as const, dataRights: { collection: "first_party", storage: "first_party", terms: "", costClass: "free_first_party", status: "live" }, outreach: "consent_gated" as const, propertyAddress: null, idempotencyKey: `t:${i.key}`, nextAction: null, outcome: null } }) })) }),
    })
    const sf = db({}, { unique: { ...UNIQUE, movement_source_polls: [["brokerage_id", "source_key"]], movement_source_items: [["brokerage_id", "source_key", "item_key"]] } })
    const feed = [{ key: "recent", at: daysAgo(2), v: "a" }, { key: "history", at: daysAgo(400), v: "b" }]
    const b1 = (await quiet(() => watcher.runMovementTick(sf as never, B, { now: NOW, force: true, reconcile: false, sources: [stateFeed(feed)] }, { movement: { ...seams().deps, route: false } as never }))).watch.sources[0]
    ok(b1.raised === 1 && b1.baselineSilent === 1, `BASELINE: the recent item is raised (${b1.raised}); history older than the half-life is recorded SILENTLY (${b1.baselineSilent}) — a decade of history is not "new"`, JSON.stringify(b1))
    const b2 = (await quiet(() => watcher.runMovementTick(sf as never, B, { now: NOW, force: true, reconcile: false, sources: [stateFeed(feed)] }, { movement: { ...seams().deps, route: false } as never }))).watch.sources[0]
    ok(b2.raised === 0 && b2.unchanged === 2, `the same standing state again: nothing raised, both unchanged (${b2.unchanged})`)
    const b3 = (await quiet(() => watcher.runMovementTick(sf as never, B, { now: NOW, force: true, reconcile: false, sources: [stateFeed([{ key: "recent", at: daysAgo(2), v: "a" }, { key: "history", at: daysAgo(1), v: "c" }])] }, { movement: { ...seams().deps, route: false } as never }))).watch.sources[0]
    ok(b3.raised === 1 && b3.unchanged === 1, "after the baseline, a change to an OLD item is a change like any other — raised once")
    // a source whose upstream lag is unpublished promises nothing
    const sellerDb = db({ motivated_seller_signals: [
      { id: "m1", brokerage_id: B, contact_id: "c2", lead_id: null, signal_type: "permit_activity", signal_strength: "moderate", detected_via: "socrata", detected_at: daysAgo(2), signal_details: { permit_id: "P-1", address: "1 Main St" } },
      { id: "m2", brokerage_id: B, contact_id: null, lead_id: "l-open", signal_type: "preforeclosure", signal_strength: "strong", detected_via: "batchdata", detected_at: daysAgo(2), signal_details: {} },
    ] })
    const sres = (await quiet(() => watcher.runMovementTick(sellerDb as never, B, { now: NOW, force: true, reconcile: false, sources: [watcher.STORED_SELLER_SIGNALS_SOURCE] }, { movement: seams().deps }))).watch.sources[0]
    const permitRow = sellerDb.tables.movement_signals.find((r: any) => r.source_key === "pr_permit_activity")
    const qlRow = sellerDb.tables.movement_signals.find((r: any) => r.source_key === "pr_batchdata_quicklist")
    ok(sres.raised === 2 && permitRow?.confidence === "verified" && qlRow?.confidence === "reported", "the permit sweep's stored row (issuer open data) is VERIFIED; the vendor quickList row is REPORTED")
    ok(sres.freshness.promisedFreshnessMinutes === null && /no freshness is promised/.test(sres.freshness.note), "a source whose upstream lag is unpublished promises NO freshness (honest), rather than a number it cannot keep")
    // fail closed: an unread state is never a baseline; a failed fetch keeps the last success
    const refused = db({ calculator_history: d.tables.calculator_history }, { refuse: { movement_source_polls: "permission denied" } })
    const rr = (await quiet(() => watcher.runMovementTick(refused as never, B, { now: NOW, force: true, reconcile: false, sources: [watcher.STORED_CALCULATOR_SOURCE] }, { movement: seams().deps }))).watch.sources[0]
    ok(rr.status === "state_unread" && rr.raised === 0, "FAIL CLOSED: an unread poll state is never treated as a baseline — nothing raised, the reason named")
    const failing = { ...watcher.STORED_CALCULATOR_SOURCE, fetch: async () => ({ ok: false as const, error: "upstream table read refused" }) }
    const rf = (await quiet(() => watcher.runMovementTick(d as never, B, { now: new Date(NOW.getTime() + 3_600_000), force: true, reconcile: false, sources: [failing] }, { movement: seams().deps }))).watch.sources[0]
    const pollAfter = d.tables.movement_source_polls.find((p: any) => p.source_key === "stored:calculator_history")
    ok(rf.status === "fetch_failed" && pollAfter?.last_success_at === NOW.toISOString() && /refused/.test(pollAfter?.last_error ?? ""), "a failed poll keeps the LAST SUCCESS (staleness shows) and names the error")
    // the doors that already answered → record-only C9 rows (no second route)
    const ledgerDb = db({ agent_action_ledger: [
      { id: "L1", brokerage_id: B, action: "customer360.first_party_action.observed", subject_type: "contact", subject_id: "c1", idempotency_key: "first_party:x", status: "executed", created_at: daysAgo(1), detail: { family: "search", change: "resumed", tables: ["saved_properties"], latest_at: daysAgo(1) } },
      { id: "L2", brokerage_id: B, action: "enrichment.intent_fact.observed", subject_type: "contact", subject_id: "c1", idempotency_key: "intent_fact:y", status: "executed", created_at: daysAgo(1), detail: { key: "online_real_estate_activity", fact_key: "versium:online_real_estate_activity:abc", intents: ["moving"], sensitivity: "behaviour", provenance: { provider: "versium", field: "Online Presence Indicator - Real Estate" }, freshness: { observedAt: daysAgo(1) } } },
      { id: "L3", brokerage_id: B, action: "enrichment.intent_fact.observed", subject_type: "contact", subject_id: "c1", idempotency_key: "intent_fact:z", status: "executed", created_at: daysAgo(1), detail: { key: "public_life_event", fact_key: "osint:public_life_event:def", intents: ["life_event"], sensitivity: "life_event", provenance: { provider: "osint", field: "life_events[].type" }, freshness: { observedAt: daysAgo(1) } } },
      { id: "L4", brokerage_id: B, action: "enrichment.intent_fact.observed", subject_type: "contact", subject_id: "c1", idempotency_key: "intent_fact:w", status: "failed", created_at: daysAgo(1), detail: { key: "job_change", fact_key: "pdl:job:1", intents: ["moving"], sensitivity: "life_event", provenance: { provider: "peopledata", field: "job_start_date" }, freshness: { observedAt: daysAgo(1) } } },
    ], contacts: seed().contacts.map((c) => (c.id === "c1" ? { ...c, life_events: [{ event: "relocation", url: "https://example.org/news/transfer", publishedDate: daysAgo(3) }, { event: "bankruptcy", url: "https://example.org/x" }], last_life_event_detected: daysAgo(1) } : c)) })
    const lseam = seams()
    const tick = await quiet(() => watcher.runMovementTick(ledgerDb as never, B, { now: NOW, force: true, reconcile: false }, { movement: lseam.deps }))
    const lrows = ledgerDb.tables.movement_signals
    ok(lrows.some((r: any) => r.source_key === "fp_saved_homes" && r.confidence === "verified") && lrows.some((r: any) => r.source_key === "po_online_real_estate_activity" && r.confidence === "inferred") && lseam.cap.publishes.length === 0 && lseam.cap.responds.length === 0,
      "the 145F / 146D doors' durable events become C9 rows RECORD-ONLY (a modeled Versium fact stays inferred) — never a second route", JSON.stringify(tick.watch.sources.map((s) => [s.key, s.status, s.raised])))
    const lifeRow = lrows.find((r: any) => r.source_key === "pp_web_mention_life_event")
    ok(!!lifeRow && lifeRow.event_relevance === "relocation" && lifeRow.identity_match === "name_only" && !lrows.some((r: any) => /bankruptcy/.test(JSON.stringify(r.evidence))) && !lrows.some((r: any) => r.source_key === "po_job_change"),
      "a provider life event expands per element (relocation recorded, name-only; bankruptcy is not a movement signal); a FAILED door event is never read as answered")
    // acquisition posts → the classifier → C9 (raw lead: no outreach)
    const postDb = db({ raw_scraped_leads: [{ id: "r1", brokerage_id: B, lead_id: null, source: "agent_seeking_phrase_intent", raw_data: { title: "Realtor recs?", text: "We're relocating to Austin this spring — can anyone recommend a realtor?" }, normalized_preview: { sourceUrl: "https://example.org/p/1" }, city: "Austin", state: "TX", created_at: daysAgo(1) }] })
    const pseam = seams()
    await quiet(() => watcher.runMovementTick(postDb as never, B, { now: NOW, force: true, reconcile: false, classify: async () => ({ relevant: true, event_relevance: "seeking_agent", about: "author", side: "buyer", timeline_bucket: "3-6", quote: "can anyone recommend a realtor?", needs_person: false, note: "asking for an agent" }), sources: undefined }, { movement: pseam.deps }))
    const prow = postDb.tables.movement_signals.find((r: any) => r.source_key === "pp_agent_seeking_phrase")
    ok(!!prow && prow.subject_type === "raw_lead" && prow.confidence === "reported" && prow.outreach === "none" && pseam.cap.publishes.length === 0, "a public 'recommend a realtor?' post → reported (self) on the raw lead, outreach none — the raw-lead gates still decide")
  }

  // ── G. OUTCOMES ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nG. outcomes close the loop")
  {
    const base = (id: string, contact: string, at: string) => ({ id, brokerage_id: B, subject_type: "contact", contact_id: contact, source_key: "fp_calc_seller_net", event_relevance: "property_event", confidence: "verified", identity_match: "record_key", evidence: {}, observed_at: at, outcome: null, outreach: "consent_gated", protected_proxy: false, side: "unknown", intents: [] })
    const d = db({
      movement_signals: [base("o1", "c1", daysAgo(30)), base("o2", "c2", daysAgo(30)), base("o3", "c3", daysAgo(400)), base("o4", "c-life", daysAgo(10))],
      listings: [{ id: "lst1", brokerage_id: B, seller_contact_id: "c1", contact_id: "c1", created_at: daysAgo(5), status: "active" }],
      contacts: seed().contacts.map((c) => (c.id === "c2" ? { ...c, opted_out_at: daysAgo(3) } : c)),
    })
    const res = await quiet(() => watcher.runMovementTick(d as never, B, { now: NOW, force: true, sources: [] }, { movement: { ...seams().deps, windowDays: 180 } }))
    const by = Object.fromEntries(d.tables.movement_signals.map((r: any) => [r.id, r.outcome]))
    ok(by.o1 === "listed" && by.o2 === "opted_out" && by.o3 === "no_change" && by.o4 == null, `outcomes from what actually happened: listed ${by.o1}, opted out ${by.o2}, window lapsed ${by.o3}, still open ${by.o4}`, JSON.stringify(res.outcomes))
    ok(d.tables.agent_action_ledger.filter((l: any) => l.action === "intent.movement_signal.outcome").length === 3, "each outcome is ledgered once (intent.movement_signal.outcome)")
    const res2 = await quiet(() => watcher.runMovementTick(d as never, B, { now: NOW, force: true, sources: [] }, { movement: { ...seams().deps, windowDays: 180 } }))
    ok(Object.keys(res2.outcomes?.closed ?? {}).length === 0, "a second sweep closes nothing twice")
  }

  // ── H. THE ARBITER HOOK ─────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("\nH. the arbiter's hook (lib/ai-isa/followup-arbiter.ts loadLifeChangeSignals → movementSignalsForArbiter)")
  {
    const d = db()
    const { deps } = seams()
    await quiet(async () => {
      await mv.recordMovementSignal(d as never, { brokerageId: B, subject: { type: "contact", id: "c1" }, sourceKey: "pp_reddit_relocation", eventRelevance: "relocation", identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(4), evidence: { confidence: "reported", reportedBy: "self", reference: { kind: "public_post", id: "rd:1", retrievedAt: daysAgo(4) }, summary: "moving to Denver in spring" } }, { ...deps, route: false })
      await mv.recordMovementSignal(d as never, { brokerageId: B, subject: { type: "contact", id: "c1" }, sourceKey: "fp_calc_moving_cost", eventRelevance: "relocation", identity: "record_key", capturedBy: "automation", observedAt: daysAgo(2), evidence: { confidence: "verified", reference: { kind: "first_party_row", id: "calculator_history:h", retrievedAt: daysAgo(2) }, summary: "priced the move" } }, { ...deps, route: false })
    })
    const h = await quiet(() => mv.movementSignalsForArbiter(d as never, { brokerageId: B, contactId: "c1", now: NOW, windowDays: 180 }))
    const s = h.signals[0]
    ok(h.signals.length === 1 && s.type === "moving_intent" && s.kind === "moving" && s.type in arb.LIFE_CHANGE_SIGNAL_KINDS && typeof s.strength === "number" && s.strength > 0, `ONE signal in the arbiter's own spelling (${s?.type} / ${s?.kind}, strength = the combination score ${s?.strength}, ${s?.daysAgo}d ago)`)
    ok(h.helpers.some((x) => x.key === "relocation_checklist_on_disclosed_move") && !!h.explanation && h.blindSpot === null, `the neighbourly helpers the evidence supports ride along (${h.helpers.map((x) => x.key).join(", ")}) with the explanation`)
    const foreign = await quiet(() => mv.movementSignalsForArbiter(d as never, { brokerageId: B2, contactId: "c1", now: NOW, windowDays: 180 }))
    ok(foreign.signals.length === 0 && /not in this brokerage/.test(foreign.blindSpot ?? ""), "TENANT-PINNED: another tenant asking about this contact gets nothing")
    const refusedDb = db({}, { refuse: { movement_signals: "permission denied" } })
    const rh = await quiet(() => mv.movementSignalsForArbiter(refusedDb as never, { brokerageId: B, contactId: "c1", now: NOW, windowDays: 180 }))
    ok(rh.signals.length === 0 && /refused/.test(rh.blindSpot ?? ""), "a refused read is a published BLIND SPOT, never a throw, never 'no signal'")
    // WAVE 147 (147Z, convergence): THE EPISTEMIC GATE at the hook — an inferred-only combination never reaches the arbiter as a
    // life change (lane G's seam contract + C9). Positive control: the reported + verified pair above DID produce one signal.
    const infOnly = db()
    await quiet(async () => {
      await mv.recordMovementSignal(infOnly as never, { brokerageId: B, subject: { type: "contact", id: "c2" }, sourceKey: "po_online_real_estate_activity", eventRelevance: "property_event", identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(1), evidence: { confidence: "inferred", basis: ["versium:a"], method: "vendor model", summary: "modeled online activity" } }, { ...deps, route: false })
      await mv.recordMovementSignal(infOnly as never, { brokerageId: B, subject: { type: "contact", id: "c2" }, sourceKey: "pr_owner_rental_listing", eventRelevance: "property_event", identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(1), evidence: { confidence: "inferred", basis: ["raw:rent1"], method: "owner listed for rent", summary: "listed their home for rent" } }, { ...deps, route: false })
    })
    const ih = await quiet(() => mv.movementSignalsForArbiter(infOnly as never, { brokerageId: B, contactId: "c2", now: NOW, sinceIso: daysAgo(180) }))
    ok(ih.signals.length === 0 && ih.helpers.length === 0 && /inferred only/.test(ih.blindSpot ?? ""), "INFERRED-ONLY evidence never reaches the arbiter as a life change — no signal, no helper, and the blind spot says why (control: the reported + verified pair above produced one)", ih.blindSpot ?? "")
    const sinceForm = await quiet(() => mv.movementSignalsForArbiter(d as never, { brokerageId: B, contactId: "c1", now: NOW, sinceIso: daysAgo(180) }))
    ok(sinceForm.signals.length === 1 && sinceForm.signals[0].type === s?.type, "the arbiter's own window (sinceIso) reads the same evidence as windowDays")
    const noWindow = await quiet(() => mv.movementSignalsForArbiter(d as never, { brokerageId: B, contactId: "c1", now: NOW }))
    ok(noWindow.signals.length === 0 && /no window/.test(noWindow.blindSpot ?? ""), "no window → nothing read, said as a blind spot (never an unbounded read)")
    // THE WIRING, ASSERTED (was a console line whose regex matched the arbiter's OWN local function name — a false WIRED):
    // the consumer constant must lazily import THIS module and must not be null. Stripped source (a tombstone is not a call site).
    const seamWired = (text: string) => /const MOVEMENT_SIGNAL_CONSUMER\b[^=]*=\s*async[^\n]*import\("@\/lib\/intent\/movement-signals"\)\)\.movementSignalsForArbiter\(/.test(text)
    const arbSrc = src("lib/ai-isa/followup-arbiter.ts")
    ok(seamWired(arbSrc), "the arbiter's MOVEMENT_SIGNAL_CONSUMER lazily imports lib/intent/movement-signals and calls movementSignalsForArbiter (WIRED)")
    ok(!seamWired("const MOVEMENT_SIGNAL_CONSUMER: MovementSignalConsumer | null = null\nasync function movementSignalsForArbiter() {}") && !seamWired(stripComments("// const MOVEMENT_SIGNAL_CONSUMER = async (s, a) => (await import(\"@/lib/intent/movement-signals\")).movementSignalsForArbiter(s, a)\nconst MOVEMENT_SIGNAL_CONSUMER = null")), "(positive control) a null seam beside a same-named local function, or the wiring only in a comment, reads UNWIRED")
    // DRIVEN: the arbiter reads the movement evidence through its default (wired) seam and narrows the menu on a life event.
    const arbiter = await import("../lib/ai-isa/followup-arbiter")
    const dec = arbiter.decisiveLifeChangeSignal([{ type: "moving_intent", kind: "moving", strength: 50, daysAgo: 3 }, { type: "divorce_filing", kind: "life_event", strength: 60, daysAgo: 1 }])
    ok(dec?.kind === "life_event", "the DECISIVE signal is the freshest non-engagement one (a divorce filing 1d ago beats a move 3d ago)")
    const dec2 = arbiter.decisiveLifeChangeSignal([{ type: "moving_intent", kind: "moving", strength: 50, daysAgo: 1 }, { type: "divorce_filing", kind: "life_event", strength: 60, daysAgo: 9 }, { type: "property_engagement", kind: "engagement", strength: null, daysAgo: 0 }])
    ok(dec2?.kind === "moving", "(control) a fresher move is decisive over an older life event, and mere engagement is never decisive")
    const cronWired = /runMovementTick/.test(src("app/api/cron/enrichment-processor/route.ts"))
    console.log(`  · tick wiring: ${cronWired ? "WIRED" : "UNWIRED — the one-line call is in lane 147B notes, Outside-lane 2"}`)
  }

  // ── I. NO VENDOR, NO NEW SPELLING, ACTION NAMES, MODEL FEATURES ─────────────────────────────────────────────────────────────
  console.log("\nI. no vendor call, no new spelling, ledger names, routed model features")
  {
    const files = [SIG, REG, WATCH].map((p) => [p, src(p)] as const)
    // a CALL, not a method definition (`async fetch({ … }) {` is a poll source's own method) and not a member call (`ps.fetch(`)
    const EGRESS = /(?<![.\w])(?<!async\s)(?:fetch|callConnector|dispatchWebSearch|socrataQuery|exaSearch)\(/
    ok(files.every(([, s]) => !EGRESS.test(blankStrings(s))), "the movement modules call NO vendor and add no egress (they read stored sweep outputs and door events)")
    ok(EGRESS.test(blankStrings("const r = await fetch(url)")) && !EGRESS.test(blankStrings("await ps.fetch(ctx); const t = \"fetch(x)\"; const o = { async fetch(c) { return c } }")), "(positive control) the egress scan sees a bare fetch call and ignores a method call / a string")
    const actions = [...files.flatMap(([, s]) => [...s.matchAll(/action:\s*"([a-z0-9_.]+)"/g)].map((m) => m[1]))]
    const pattern = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/
    ok(actions.length >= 3 && actions.every((a) => pattern.test(a)), `every ledger action is domain.entity.action (${[...new Set(actions)].join(", ")})`)
    ok(!pattern.test("life_change.respond"), "(positive control) a two-segment name is caught")
    const features = [...src(SIG).matchAll(/feature:\s*"([a-z_]+)"/g)].map((m) => m[1])
    const models = src("lib/ai/models.ts")
    ok(features.length === 2 && features.every((f) => new RegExp(`\\b${f}:\\s*\\{\\s*model:`).test(models)), `every model call names a routing-table feature (${features.join(", ")}) — booked, never 'unspecified'`)
    const published = [...src(SIG).matchAll(/toManager:\s*"[a-z_]+",\s*signalType:\s*"([a-z_]+)"/g)].map((m) => m[1])
    const registry = src("lib/kernel/signal-registry.ts")
    ok(published.length >= 1 && published.every((t) => new RegExp(`\\b${t}:\\s*\\{\\s*consumers:\\s*\\["ai_isa"\\],\\s*disposition:\\s*"handled"`).test(registry)), `every bus signal it publishes is an EXISTING handled registry row (${published.join(", ")}) — no new signal type`)
  }

  // ── J. ONE LIFE-EVENT VOCABULARY (wave 147, lane 147Z — CLAUDE.md §6; lane 147B "Still open" 5) ─────────────────────────────
  console.log("\nJ. one life-event vocabulary — the writers write what the scorers read")
  {
    const voc = await import("../lib/enrichment/life-event-vocabulary")
    const wm = await import("../lib/enrichment/web-mention-search")
    const WRITERS = ["lib/osint-client.ts", "lib/enrichment/web-mention-search.ts", "lib/enrichment/contact-enrichment-core.ts"]
    // A WRITTEN life-event token: `event: "<token>"` in a life-event writer (stripped source — a tombstone naming the retired
    // spelling is not a write).
    const writtenTokens = (text: string) => [...text.matchAll(/\bevent:\s*"([a-z_]+)"/g)].map((m) => m[1])
    const retired = Object.keys(voc.LEGACY_LIFE_EVENT_ALIASES)
    const offenders = WRITERS.flatMap((p) => writtenTokens(src(p)).filter((t) => retired.includes(t)).map((t) => `${p}: ${t}`))
    ok(offenders.length === 0, `no life-event writer writes a RETIRED spelling (${retired.join(", ")}) — scanned ${WRITERS.length} writers, stripped`, offenders.join("; "))
    const specimen = 'life_events.push({ event: "divorce", source: "public_records" })\n// was: life_events.push({ event: "death_in_family" })'
    const specimenHits = writtenTokens(stripComments(specimen)).filter((t) => retired.includes(t))
    ok(specimenHits.length === 1 && specimenHits[0] === "divorce", "(positive control) the scan sees a retired spelling in a live write and ignores it in a comment")
    const lifeWrites = ["lib/osint-client.ts", "lib/enrichment/web-mention-search.ts"].flatMap((p) => writtenTokens(src(p)))
    const outside = lifeWrites.filter((t) => !(voc.LIFE_EVENT_TYPES as readonly string[]).includes(t))
    ok(lifeWrites.length >= 8 && outside.length === 0, `every token the OSINT + web-mention writers write is a LifeEventType (${[...new Set(lifeWrites)].join(", ")})`, outside.join(", "))
    ok(voc.canonicalLifeEventType("divorce") === "divorce_filing" && voc.canonicalLifeEventType("death_in_family") === "death_in_household" && voc.canonicalLifeEventType("Divorce_Filing") === "divorce_filing" && voc.canonicalLifeEventType("bankruptcy_court") === null,
      "stored history under a retired spelling reads as its survivor; an unknown token is null (never guessed)")
    ok(voc.lifeEventTypeOf({ type: "divorce_filing" }) === "divorce_filing" && voc.lifeEventTypeOf({ event: "divorce" }) === "divorce_filing" && voc.lifeEventTypeOf({}) === null,
      "ONE reader rule for both stored element shapes ({ type } from the life-change check, { event } from OSINT)")
    const exa = (title: string, text: string) => ({ id: "x", url: "https://example.org/n", title, text, author: null, publishedDate: "2026-10-20" })
    const hits = wm.classifyMentionEvents([exa("Court notices", "Pat Doe filed for divorce in Travis County."), exa("Pat Doe obituary", "Pat Doe passed away peacefully.")], { firstName: "Pat", lastName: "Doe" }).map((e) => e.event as string)
    ok(hits.includes("divorce_filing") && hits.includes("death_in_household") && !hits.some((h) => retired.includes(h)), `DRIVEN: the web-mention writer emits the survivor spellings (${hits.join(", ")})`)
    const a = mv.movementSignalFromLifeEvent({ brokerageId: B, contactId: "c1", event: { event: "divorce", url: "https://example.org/n" }, detectedAt: daysAgo(1) })
    const b2 = mv.movementSignalFromLifeEvent({ brokerageId: B, contactId: "c1", event: { type: "divorce_filing", url: "https://example.org/n" }, detectedAt: daysAgo(1) })
    ok(a.ok && b2.ok && a.record.eventRelevance === "divorce" && b2.record.eventRelevance === "divorce", "C9 reads a retired stored `divorce` and a survivor `divorce_filing` as the SAME relevance")
    ok(Object.keys(mv.LIFE_EVENT_RELEVANCE).every((k) => (voc.LIFE_EVENT_TYPES as readonly string[]).includes(k)) && (voc.LIFE_EVENT_TYPES as readonly string[]).every((k) => k in mv.LIFE_EVENT_RELEVANCE),
      "LIFE_EVENT_RELEVANCE is keyed on EXACTLY the vocabulary (no restated alias, no missing event)")
    const readers: Record<string, RegExp> = { "lib/predictive-listing/signal-generators.ts": /lifeEventTypeOf\(/, "lib/sphere-resonance/run-resonance-scan.ts": /lifeEventTypeOf\(/, "lib/intent/movement-signals.ts": /canonicalLifeEventType\(/, "lib/enrichment/contact-enrichment-core.ts": /lifeEventTypeOf\(/ }
    const unread = Object.entries(readers).filter(([p, re]) => !re.test(src(p))).map(([p]) => p)
    ok(unread.length === 0, "every scorer / merger reads life events through the vocabulary (predictive listing, sphere resonance, C9, the life-change merge)", unread.join(", "))
    ok(!/LIFE_EVENT_CONFIDENCE\[evt\.event\]/.test(src("lib/predictive-listing/signal-generators.ts")) && /LIFE_EVENT_CONFIDENCE\[evt\.event\]/.test("const cfg = LIFE_EVENT_CONFIDENCE[evt.event]"), "the predictive scorer no longer keys on the raw `evt.event` (positive control: the old line is recognised)")
  }

  // ── K. THE LEAD DESK'S DOOR (wave 147, lane 147Z — lane 147I U1; this lane's "Still open" 4) ────────────────────────────────
  console.log("\nK. the lead desk reads the records and closes one (false_positive / declined) — session-gated, ledgered once")
  {
    const d = db({ movement_source_polls: [{ id: "p1", brokerage_id: B, source_key: "stored:motivated_seller_signals", last_polled_at: daysAgo(0), last_success_at: daysAgo(0), last_error: null, promised_freshness_minutes: 30 }, { id: "p2", brokerage_id: B, source_key: "stored:calculator_history", last_polled_at: daysAgo(0), last_success_at: null, last_error: "refused", promised_freshness_minutes: 30 }, { id: "p3", brokerage_id: B2, source_key: "stored:calculator_history", last_polled_at: daysAgo(0), last_success_at: daysAgo(0), last_error: null, promised_freshness_minutes: 15 }] })
    const { deps } = seams()
    const rec = await quiet(() => mv.recordMovementSignal(d as never, { brokerageId: B, subject: { type: "contact", id: "c1" }, sourceKey: "pp_reddit_relocation", eventRelevance: "relocation", identity: "verified_match", capturedBy: "automation", observedAt: daysAgo(3), evidence: { confidence: "reported", reportedBy: "self", reference: { kind: "public_post", id: "rd:k", retrievedAt: daysAgo(3) }, summary: "moving to Denver in spring" } }, { ...deps, route: false }))
    const list = await mv.listMovementRecordsForLeadDesk(d as never, { brokerageId: B, limit: 10 })
    const r0 = list.records[0]
    ok(!list.error && list.records.length === 1 && r0.relevance === "relocation" && r0.confidence === "reported" && /^moving to Denver in spring — /.test(r0.evidence) && r0.outcome === null, `the lead desk reads the tenant's records with HOW we know each (${r0?.evidence ?? list.error})`)
    const foreignList = await mv.listMovementRecordsForLeadDesk(d as never, { brokerageId: B2, limit: 10 })
    ok(foreignList.records.length === 0, "TENANT-PINNED: another tenant reads none of them")
    const fresh = await mv.movementSourceFreshness(d as never, B)
    ok(!fresh.error && fresh.sources.length === 2 && fresh.sources.find((s) => s.sourceKey === "stored:motivated_seller_signals")?.promisedFreshnessMinutes === 30 && fresh.sources.find((s) => s.sourceKey === "stored:calculator_history")?.promisedFreshnessMinutes === null,
      "the published freshness (m893) — a source that never succeeded promises NO number; the other tenant's poll is not read")
    const id = rec.status === "recorded" ? rec.id : ""
    const closed = await quiet(() => mv.recordMovementOutcome(d as never, { brokerageId: B, signalId: id, outcome: "false_positive", evidence: { by: "lead_desk" }, actor: { type: "user", userId: "u-desk" } }))
    ok(closed.status === "recorded" && d.tables.movement_signals.find((x: any) => x.id === id)?.outcome === "false_positive", "a lead-desk person closes it as a FALSE POSITIVE through the exported outcome writer (ledgered intent.movement_signal.outcome)")
    const again = await quiet(() => mv.recordMovementOutcome(d as never, { brokerageId: B, signalId: id, outcome: "declined", evidence: {}, actor: { type: "user", userId: "u-desk" } }))
    ok(again.status !== "recorded", "…once: the same record cannot be closed a second time")
    const refusedLedger = (async (_ctx: any, _run: any, hooks: any) => hooks.replay({ kind: "refused", error: "ledger down" })) as never
    const viaRefused = await quiet(() => mv.recordMovementOutcome(d as never, { brokerageId: B, signalId: "x", outcome: "declined", evidence: {}, actor: { type: "user", userId: "u" } }, { ledger: refusedLedger }))
    ok(viaRefused.status === "refused" && /ledger refused/.test(viaRefused.reason), "a REFUSED ledger claim records nothing and says so — never 'already recorded' (census II.2)", viaRefused.reason)
    const act = stripComments(raw("app/actions/movement-signals.ts"))
    const exportsAll = [...act.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((m) => m[1])
    const body = (n: string) => act.slice(act.indexOf(`function ${n}(`), act.indexOf("\nexport ", act.indexOf(`function ${n}(`) + 5) > 0 ? act.indexOf("\nexport ", act.indexOf(`function ${n}(`) + 5) : undefined)
    const gatedFirst = exportsAll.every((n) => { const b = body(n); const gate = b.search(/await leadDeskSeat\(\)/); const svc = b.search(/createServiceClient\(\)/); return gate >= 0 && svc > gate })
    ok(/^"use server"/.test(raw("app/actions/movement-signals.ts")) && exportsAll.length === 2 && gatedFirst && /MOVEMENT_RAW_SIGNAL_VIEWERS\.has\(/.test(act), `the door: "use server", ${exportsAll.length} exports, each gates on the SESSION's lead-desk seat (the ONE roster) BEFORE the service client`)
    ok(/const PERSON_OUTCOMES = \["false_positive", "declined"\] as const/.test(act) && /recordMovementOutcome\(/.test(act) && !/brokerageId:\s*(?:input|params|opts)\./.test(act), "a person may record ONLY false_positive / declined, through the one outcome writer, with the tenant from the session (never a parameter)")
    ok(!/MOVEMENT_RAW_SIGNAL_VIEWERS\.has\(/.test("const ok = true") && /MOVEMENT_RAW_SIGNAL_VIEWERS\.has\(/.test("if (!MOVEMENT_RAW_SIGNAL_VIEWERS.has(role)) return"), "(positive control) the roster-gate finder sees the gate and nothing else")
    ok(/listMovementSignalsAction\(/.test(stripComments(raw("app/dashboard/intelligence/movement-signals/page.tsx"))) && /markMovementSignalOutcomeAction\(/.test(stripComments(raw("app/dashboard/intelligence/movement-signals/movement-signals-client.tsx"))), "the screen reads through the door and closes records through it")
  }

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ❌ MOVEMENT_SIGNALS_FAIL"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ MOVEMENT_SIGNALS_PASS — every movement trace says how we know it; a single source is never a move; the manager chooses; the outcome teaches the sources")
}

main().catch((e) => { console.error(e); process.exit(1) })
