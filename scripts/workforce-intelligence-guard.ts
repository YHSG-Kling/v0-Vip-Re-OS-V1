#!/usr/bin/env tsx
/**
 * scripts/workforce-intelligence-guard.ts   (npm run test:workforce-intelligence) — in-memory client,
 * no network, no DB. WAVE 106 (lane 106E) — BROKERAGE WORKFORCE INTELLIGENCE + NEED-DRIVEN RECRUITING.
 *
 *   A  classifications — each with its evidence READER and its POLICY THRESHOLD; positive controls
 *      (a tighter policy un-classifies; a missing competency read never says "in development")
 *   B  the twin section builds through the real loader + composer; totals; policy vs default thresholds;
 *      snapshot-persisted; an OLDER snapshot without the section diffs as a change against 0
 *   C  territory demand → recruiting need (pure) — the owner's example, and the "no need" controls
 *   D  need → RECRUITING MISSION through the REAL mission service: mission_type recruiting, owner
 *      recruiting_manager, APPROVAL_REQUIRED, ledger + evidence rows, targeting attached; idempotent
 *      re-run; NO targeting reaches the sourcer until a human approves (recruitingTargetingFor)
 *   E  tenant isolation — every new read pinned; B's rows never in A's twin; a team twin sees its own
 *      board and recruits nothing for the brokerage; platform scope = every tenant's own twin
 *   F  wiring (stripped source) with a tombstone control; registration + ownership
 *   G  THE DEDICATED THRESHOLDS EDITOR (wave 107G): validation against the resolver's ONE bounds table
 *      (refusals + positive controls, round trip); propose → EVALUATED writes no policy; "apply now" →
 *      APPROVED → PROMOTED through the real promotion (policy version + ledger row); a non-admin is held;
 *      the editor reaches the setting ONLY through the proposal path (stripped source, with controls)
 *
 * Owner: recruiting_manager. Co-owners named in prose: data_steward (the twin section + snapshot),
 * campaign_orchestrator (the mission runtime the need is written onto).
 */
import { readFileSync } from "node:fs"
import { stripComments, blankStrings } from "./strip-comments"
import {
  buildBrokerageTwin, composeBrokerageTwin, loadBrokerageTwinFacts, classifyWorkforceAgent, composeTerritoryDemand,
  recruitingNeeds, recruitingNeedObjective, resolveWorkforceThresholds, DEFAULT_WORKFORCE_THRESHOLDS, WORKFORCE_THRESHOLDS_KEY,
  WORKFORCE_CLASSIFICATIONS, twinMeasures, detectTwinChanges, workforceLine, readBrokerageTwin, TWIN_SNAPSHOT_TABLE,
  WORKFORCE_THRESHOLD_FIELDS, WORKFORCE_OVERWHELMED_BANDS, validateWorkforceThresholdsEdit,
  type BrokerageTwin, type WorkforceAgentFacts, type TwinAgentCapacity,
} from "../lib/kernel/brokerage-twin"
import { proposeEvaluatePromote } from "../lib/kernel/improvement-proposals"
import { memSupabase } from "./in-memory-supabase"
import {
  ensureRecruitingMissionsFromTwin, recruitingTargetingFor, recruitingNeedSubjectId, recruitingTargetingOf,
  transitionMission, RECRUITING_NEED_SUBJECT_TYPE, RECRUITING_TARGETING_EVIDENCE_KIND, MISSION_APPROVAL_REQUIRED_SIGNAL, type MissionDeps,
} from "../lib/kernel/missions"
import { targetingSearchTerms } from "../lib/recruit-pipeline/recruit-sourcer"
import { TENANT_POLICY_SETTINGS_KEYS } from "../lib/kernel/tenant-policy"
import { MAINTENANCE_DOMAINS, MANAGERS, TABLE_MANAGER } from "../lib/kernel/manager-registry"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => stripComments(readFileSync(p, "utf8"))
const code = (p: string) => blankStrings(src(p))

// ─── In-memory supabase-shaped client (select + insert + update, counted, tenant-logged) ───────
type Row = Record<string, any>
const NOW = new Date("2026-10-06T12:00:00.000Z")
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString()
let seq = 0
const uuid = () => { const h = (++seq).toString(16).padStart(12, "0"); return `00000000-0000-4000-8000-${h}` }

function makeClient(tables: Record<string, Row[]>, opts: { refuse?: Set<string> } = {}) {
  const log: Array<{ table: string; op: string; filters: string[] }> = []
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = []
    const names: string[] = []
    let op = "select", head = false, limitN = Infinity, order: { col: string; asc: boolean } | null = null, single = false
    let payload: Row | Row[] | null = null
    const run = () => {
      log.push({ table, op, filters: names })
      if (opts.refuse?.has(table)) return { data: null, error: { message: `relation "${table}" does not exist` }, count: null }
      if (op === "insert") {
        const rowsIn = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: uuid(), created_at: NOW.toISOString(), updated_at: NOW.toISOString(), ...r }))
        for (const r of rowsIn) if (table === "missions") Object.assign(r, { spent_usd: r.spent_usd ?? 0, spent_tokens: r.spent_tokens ?? 0, blockers: r.blockers ?? [], evidence: r.evidence ?? [], progress: r.progress ?? {}, actions: r.actions ?? [], outcomes: r.outcomes ?? [], state_changed_at: r.state_changed_at ?? r.created_at })
        ;(tables[table] ??= []).push(...rowsIn)
        return { data: single ? rowsIn[0] : rowsIn, error: null, count: rowsIn.length }
      }
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      if (op === "update") { for (const r of rows) Object.assign(r, payload); return { data: rows.map((r) => ({ ...r })), error: null, count: rows.length } }
      if (order) rows = [...rows].sort((a, c) => (a[order!.col] < c[order!.col] ? -1 : a[order!.col] > c[order!.col] ? 1 : 0) * (order!.asc ? 1 : -1))
      const count = rows.length
      rows = rows.slice(0, limitN).map((r) => ({ ...r }))
      return { data: head ? null : single ? (rows[0] ?? null) : rows, error: null, count }
    }
    const b: any = {
      select(_c?: string, o?: { count?: string; head?: boolean }) { if (o?.head) head = true; return b },
      insert(p: Row | Row[]) { op = "insert"; payload = p; return b },
      update(p: Row) { op = "update"; payload = p; return b },
      eq(c: string, v: any) { names.push(`eq:${c}`); filters.push((r) => r[c] === v); return b },
      neq(c: string, v: any) { names.push(`neq:${c}`); filters.push((r) => r[c] !== v); return b },
      is(c: string, v: any) { names.push(`is:${c}`); filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b },
      in(c: string, vs: any[]) { names.push(`in:${c}`); filters.push((r) => vs.includes(r[c])); return b },
      not(c: string, opn: string, v: string) { names.push(`not:${c}`); if (opn === "in") { const vs = v.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "")); filters.push((r) => !vs.includes(r[c])) } else if (opn === "is") filters.push((r) => r[c] != null); return b },
      gte(c: string, v: any) { names.push(`gte:${c}`); filters.push((r) => r[c] != null && r[c] >= v); return b },
      lt(c: string, v: any) { names.push(`lt:${c}`); filters.push((r) => r[c] != null && r[c] < v); return b },
      lte(c: string, v: any) { names.push(`lte:${c}`); filters.push((r) => r[c] != null && r[c] <= v); return b },
      order(c: string, o?: { ascending?: boolean }) { order = { col: c, asc: o?.ascending !== false }; return b },
      limit(n: number) { limitN = n; return b },
      maybeSingle() { single = true; return b },
      single() { single = true; return b },
      then(res: (v: any) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej) },
    }
    return b
  }
  return { from, log, tables }
}

// ─── Fixture: tenant A (the owner's shape, scaled down) and tenant B (same shape) ─────────────
const A = "aaaaaaaa-0000-4000-8000-000000000001", B = "bbbbbbbb-0000-4000-8000-000000000002", TEAM = "tttttttt-0000-4000-8000-000000000001"
function tenant(brokerage: string, tag: string) {
  const ag = (n: number) => `${tag}-ag${n}`
  return {
    agents: [
      // ag1: strong listing + luxury (by price) + bilingual; ag2: overwhelmed (band over); ag3: underutilized + in development;
      // ag4: strong buyer + investor; ag5: luxury by specialization tag, inactive agents never profiled
      { id: ag(1), brokerage_id: brokerage, is_active: true, team_id: TEAM, user_id: `${tag}-u1`, languages: ["English", "Spanish"], specializations: ["Condos"] },
      { id: ag(2), brokerage_id: brokerage, is_active: true, team_id: TEAM, user_id: `${tag}-u2`, languages: ["English"], specializations: [] },
      { id: ag(3), brokerage_id: brokerage, is_active: true, team_id: null, user_id: `${tag}-u3`, languages: null, specializations: null },
      { id: ag(4), brokerage_id: brokerage, is_active: true, team_id: null, user_id: `${tag}-u4`, languages: "English", specializations: "Investors, Condos" },
      { id: ag(5), brokerage_id: brokerage, is_active: true, team_id: null, user_id: `${tag}-u5`, languages: ["English"], specializations: ["Luxury Homes"] },
      { id: ag(6), brokerage_id: brokerage, is_active: false, team_id: null, user_id: `${tag}-u6`, languages: ["English", "French", "Arabic"], specializations: ["Luxury"] },
    ],
    listings: [
      { id: `${tag}-ls1`, brokerage_id: brokerage, deleted_at: null, status: "active", agent_id: ag(1), list_price: 1_500_000, listing_date: iso(20).slice(0, 10) },
      { id: `${tag}-ls2`, brokerage_id: brokerage, deleted_at: null, status: "sold", agent_id: ag(1), list_price: 1_200_000, listing_date: iso(90).slice(0, 10) },
      { id: `${tag}-ls3`, brokerage_id: brokerage, deleted_at: null, status: "sold", agent_id: ag(1), list_price: 400_000, listing_date: iso(120).slice(0, 10) },
      { id: `${tag}-ls4`, brokerage_id: brokerage, deleted_at: null, status: "sold", agent_id: ag(1), list_price: 900_000, listing_date: iso(400).slice(0, 10) },
      { id: `${tag}-ls5`, brokerage_id: brokerage, deleted_at: null, status: "active", agent_id: ag(2), list_price: 300_000, listing_date: null },
    ],
    offers: [1, 2, 3].map((i) => ({ id: `${tag}-of${i}`, brokerage_id: brokerage, agent_id: ag(4), created_at: iso(10 * i) })).concat([{ id: `${tag}-of9`, brokerage_id: brokerage, agent_id: ag(4), created_at: iso(300) }]),
    contacts: ([1, 2, 3].map((i) => ({ id: `${tag}-c${i}`, brokerage_id: brokerage, deleted_at: null as string | null, agent_id: ag(4), contact_persona: "investor" })) as Row[]).concat([{ id: `${tag}-c4`, brokerage_id: brokerage, deleted_at: iso(1), agent_id: ag(4), contact_persona: "investor" }]).concat([
      // WAVE 108 owner ruling: territory seller demand is seller CONTACTS (contact_type seller | both)
      // North: 2 seller CONTACTS last month → 8 this month (4 luxury-priced) — demand UP, 50% luxury, nobody luxury serves it
      ...[1, 2].map((i) => ({ id: `${tag}-cnp${i}`, brokerage_id: brokerage, deleted_at: null, agent_id: null, contact_type: "seller", zip_code: "90001", home_value_estimate: 500_000, created_at: iso(45) })),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ id: `${tag}-cnc${i}`, brokerage_id: brokerage, deleted_at: null, agent_id: null, contact_type: i % 2 ? "seller" : "both", zip_code: i <= 4 ? "90002" : "90003", home_value_estimate: i <= 4 ? 1_800_000 : 450_000, created_at: iso(i) })),
      // South: flat (3 → 3), buyer contacts never count as seller demand
      ...[1, 2, 3].map((i) => ({ id: `${tag}-csp${i}`, brokerage_id: brokerage, deleted_at: null, agent_id: null, contact_type: "seller", zip_code: "90010", home_value_estimate: 600_000, created_at: iso(40) })),
      ...[1, 2, 3].map((i) => ({ id: `${tag}-csc${i}`, brokerage_id: brokerage, deleted_at: null, agent_id: null, contact_type: "seller", zip_code: "90010", home_value_estimate: 600_000, created_at: iso(3 + i) })),
      { id: `${tag}-cby1`, brokerage_id: brokerage, deleted_at: null, agent_id: null, contact_type: "buyer", zip_code: "90001", home_value_estimate: null, created_at: iso(2) },
    ] as Row[]),
    farm_territories: [
      { id: `${tag}-f1`, brokerage_id: brokerage, is_active: true, name: "North", zip_codes: ["90001", "90002"], agent_id: ag(2) },
      { id: `${tag}-f2`, brokerage_id: brokerage, is_active: true, name: "North", zip_codes: ["90003"], agent_id: ag(3) },
      { id: `${tag}-f3`, brokerage_id: brokerage, is_active: true, name: "South", zip_codes: ["90010"], agent_id: ag(1) },
      { id: `${tag}-f4`, brokerage_id: brokerage, is_active: false, name: "West", zip_codes: ["90020"], agent_id: ag(5) },
    ],
    leads: [
      // (control, wave 108) these seller LEADS are not seller demand — a lead converts to a contact first
      // North: 2 seller leads last month → 8 this month (4 luxury-priced) — demand UP, 50% luxury, nobody luxury serves it
      ...[1, 2].map((i) => ({ id: `${tag}-np${i}`, brokerage_id: brokerage, is_active: true, lifecycle_state: "isa_qualifying", agent_id: null, converted_at: null, lead_type: "seller", property_zip_code: "90001", estimated_value: 500_000, created_at: iso(45) })),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ id: `${tag}-nc${i}`, brokerage_id: brokerage, is_active: true, lifecycle_state: "isa_qualifying", agent_id: null, converted_at: null, lead_type: i % 2 ? "seller" : "both", property_zip_code: i <= 4 ? "90002" : "90003", estimated_value: i <= 4 ? 1_800_000 : 450_000, created_at: iso(i) })),
      // South: flat (3 → 3), buyer leads never count as seller demand
      ...[1, 2, 3].map((i) => ({ id: `${tag}-sp${i}`, brokerage_id: brokerage, is_active: true, lifecycle_state: "isa_qualifying", agent_id: null, converted_at: null, lead_type: "seller", property_zip_code: "90010", estimated_value: 600_000, created_at: iso(40) })),
      ...[1, 2, 3].map((i) => ({ id: `${tag}-sc${i}`, brokerage_id: brokerage, is_active: true, lifecycle_state: "isa_qualifying", agent_id: null, converted_at: null, lead_type: "seller", property_zip_code: "90010", estimated_value: 600_000, created_at: iso(3 + i) })),
      { id: `${tag}-by1`, brokerage_id: brokerage, is_active: true, lifecycle_state: "isa_qualifying", agent_id: null, converted_at: null, lead_type: "buyer", property_zip_code: "90001", estimated_value: null, created_at: iso(2) },
    ],
    transactions: [] as Row[], deal_health_scores: [] as Row[], listing_health_scores: [] as Row[], manager_signals: [] as Row[], buyer_fatigue_scores: [] as Row[],
    agent_retention_scores: [{ brokerage_id: brokerage, agent_id: ag(2), tier: "at_risk", score_date: iso(1).slice(0, 10) }],
    compliance_flags: [] as Row[], agent_goals: [] as Row[], strategy_recommendations: [] as Row[], income_forecast_snapshots: [] as Row[], ai_tool_usage: [] as Row[],
    brokerage_settings: [] as Row[], missions: [] as Row[], mission_events: [] as Row[], notifications: [] as Row[],
  }
}
function world(extra: Record<string, Row[]> = {}) {
  const a = tenant(A, "a"), b = tenant(B, "b")
  const tables: Record<string, Row[]> = {}
  for (const k of Object.keys(a)) tables[k] = [...(a as any)[k], ...(b as any)[k]]
  for (const [k, v] of Object.entries(extra)) tables[k] = [...(tables[k] ?? []), ...v]
  return tables
}
// capacityFor stand-in — the one answer's SHAPE: ag2 over (fatigued), ag3 available at 5/75, everyone else busy at 40/75.
const fakeCapacity = async (_s: any, _b: string, agentId: string, o: { maxLoad: number }) => {
  const n = Number(agentId.slice(-1))
  const band = n === 2 ? "over" : n === 3 ? "available" : "busy"
  return { band: band as any, load: n === 2 ? o.maxLoad : n === 3 ? 5 : 40, headroom: n === 2 ? 0 : n === 3 ? 58 : 23, reasons: n === 2 ? ["agent fatigue at_risk"] : [], index: { followUpDebt: 0 } }
}
// loadAgentCompetency stand-in — ag3 has two gaps, ag1 none, ag4's read is refused.
const competencyCalls: string[] = []
const fakeCompetency = async (_s: any, agent: { id: string; user_id: string | null; brokerage_id: string }) => {
  competencyCalls.push(`${agent.brokerage_id}:${agent.id}:${agent.user_id}`)
  if (agent.id.endsWith("ag4")) throw new Error("objection_training_sessions refused")
  return { gaps: agent.id.endsWith("ag3") ? [{ skill: "lead_response", score: 40 }, { skill: "closing", score: 55 }] : [], refusedRails: agent.id.endsWith("ag5") ? ["tours: refused"] : [] }
}
const missionDeps = () => {
  const ledger: any[] = [], emits: any[] = [], signals: any[] = []
  const deps: MissionDeps = {
    now: () => NOW,
    afford: async () => ({ allowed: true, reason: "active" }),
    authority: async () => 4 as any,
    ledger: async (ctx) => { ledger.push(ctx); return `ledger-${ledger.length}` },
    emit: async (i) => { emits.push(i) },
    signal: async (s) => { signals.push(s) },
  }
  return { deps, ledger, emits, signals }
}
const T = DEFAULT_WORKFORCE_THRESHOLDS
const facts = (over: Partial<WorkforceAgentFacts> = {}): WorkforceAgentFacts => ({ agentId: "x", userId: null, languages: [], specializations: [], listings180d: 0, luxuryListings180d: 0, offers180d: 0, investorContacts: 0, competencyGaps: null, competencyRefused: null, ...over })
const cap = (band: TwinAgentCapacity["band"], load: number, fatigueTier: TwinAgentCapacity["fatigueTier"] = null): TwinAgentCapacity => ({ agentId: "x", band, load, headroom: 0, followUpDebt: 0, fatigueTier, reasons: [] })
const kinds = (c: ReturnType<typeof classifyWorkforceAgent>) => c.map((x) => x.kind).sort().join(",")

async function main() {
  // ─── A. classifications ─────────────────────────────────────────────────────────────────────
  console.log("\nA. classifications — evidence reader + policy threshold on each, with controls")
  check("A1 the owner's eight classifications, one vocabulary", WORKFORCE_CLASSIFICATIONS.join(",") === "strong_listing,strong_buyer,investor,bilingual,luxury_specialist,overwhelmed,underutilized,in_development")
  const c1 = classifyWorkforceAgent(facts({ listings180d: 3, luxuryListings180d: 2, languages: ["English", "Spanish"] }), cap("busy", 40), 75, T)
  check("A2 strong listing (3 ≥ 3) + luxury by price (2 ≥ 2) + bilingual (2 languages) — each names its reader and threshold", kinds(c1) === "bilingual,luxury_specialist,strong_listing" && c1.every((c) => c.evidence.reader.length > 0 && c.evidence.threshold !== undefined) && c1.find((c) => c.kind === "strong_listing")!.evidence.threshold === 3 && /listings\.listing_date/.test(c1.find((c) => c.kind === "strong_listing")!.evidence.reader), kinds(c1))
  check("A3 (control) a tighter TENANT POLICY un-classifies the same facts (listings ≥ 4, languages ≥ 3)", kinds(classifyWorkforceAgent(facts({ listings180d: 3, languages: ["English", "Spanish"] }), null, 75, { ...T, strong_listing_listings_180d: 4, bilingual_languages: 3 })) === "")
  check("A4 strong buyer (offers) + investor (contact_persona) with their readers", kinds(classifyWorkforceAgent(facts({ offers180d: 3, investorContacts: 3 }), null, 75, T)) === "investor,strong_buyer" && /offers\.agent_id/.test(classifyWorkforceAgent(facts({ offers180d: 3 }), null, 75, T)[0].evidence.reader) && /contact_persona/.test(classifyWorkforceAgent(facts({ investorContacts: 3 }), null, 75, T)[0].evidence.reader))
  check("A5 luxury by the profile's specialization tag (agents.specializations) even with no luxury listing", classifyWorkforceAgent(facts({ specializations: ["Luxury Homes"] }), null, 75, T).some((c) => c.kind === "luxury_specialist" && /specializations/.test(c.evidence.reader)))
  check("A6 overwhelmed reads the ONE capacity answer: band over (fatigue folded in by capacityFor) → overwhelmed; at_capacity only when policy says so", kinds(classifyWorkforceAgent(facts(), cap("over", 75, "critical"), 75, T)) === "overwhelmed" && kinds(classifyWorkforceAgent(facts(), cap("at_capacity", 64), 75, T)) === "" && kinds(classifyWorkforceAgent(facts(), cap("at_capacity", 64), 75, { ...T, overwhelmed_band: "at_capacity" })) === "overwhelmed")
  check("A7 underutilized: available AND load ≤ 25% of the tier ceiling (5/75 = 7% yes; 30/75 = 40% no; policy 50% yes)", kinds(classifyWorkforceAgent(facts(), cap("available", 5), 75, T)) === "underutilized" && kinds(classifyWorkforceAgent(facts(), cap("available", 30), 75, T)) === "" && kinds(classifyWorkforceAgent(facts(), cap("available", 30), 75, { ...T, underutilized_load_pct: 50 })) === "underutilized")
  check("A8 in development reads loadAgentCompetency gaps (≥ 1); a NULL read (refused / not run) never says 'in development'", kinds(classifyWorkforceAgent(facts({ competencyGaps: 2 }), null, 75, T)) === "in_development" && /loadAgentCompetency/.test(classifyWorkforceAgent(facts({ competencyGaps: 2 }), null, 75, T)[0].evidence.reader) && kinds(classifyWorkforceAgent(facts({ competencyGaps: null }), null, 75, T)) === "" && kinds(classifyWorkforceAgent(facts({ competencyGaps: 0 }), null, 75, T)) === "")
  check("A9 resolveWorkforceThresholds: absent → defaults; a policy value is honoured; an out-of-range / NaN value falls back per key", resolveWorkforceThresholds(undefined).strong_listing_listings_180d === 3 && resolveWorkforceThresholds({ [WORKFORCE_THRESHOLDS_KEY]: { strong_listing_listings_180d: 5, overwhelmed_band: "at_capacity" } }).strong_listing_listings_180d === 5 && resolveWorkforceThresholds({ [WORKFORCE_THRESHOLDS_KEY]: { overwhelmed_band: "at_capacity" } }).overwhelmed_band === "at_capacity" && resolveWorkforceThresholds({ [WORKFORCE_THRESHOLDS_KEY]: { luxury_list_price_usd: "nope", underutilized_load_pct: 500 } }).luxury_list_price_usd === 1_000_000 && resolveWorkforceThresholds({ [WORKFORCE_THRESHOLDS_KEY]: { underutilized_load_pct: 500 } }).underutilized_load_pct === 25)
  check("A10 the thresholds key is TENANT POLICY (TENANT_POLICY_SETTINGS_KEYS.workforce_thresholds, brokerage_settings.settings)", TENANT_POLICY_SETTINGS_KEYS[WORKFORCE_THRESHOLDS_KEY]?.store === "brokerage_settings.settings")

  // ─── B. the twin section builds through the real loader + composer ─────────────────────────
  console.log("\nB. the twin's workforce section — loader + composer, totals, policy, snapshot")
  let twinA!: BrokerageTwin
  {
    const c = makeClient(world())
    competencyCalls.length = 0
    const r = await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency })
    twinA = r.twin
    const w = twinA.workforce
    const of = (id: string) => w.agents.find((a) => a.agentId === id)!.facts
    const cls = (id: string) => w.agents.find((a) => a.agentId === id)!.classifications
    check("B1 five ACTIVE agents profiled (the inactive one never), the facts read from the real tables", w.agents.length === 5 && !w.agents.some((a) => a.agentId === "a-ag6") && of("a-ag1").listings180d === 3 && of("a-ag1").luxuryListings180d === 2 && of("a-ag4").offers180d === 3 && of("a-ag4").investorContacts === 3 && of("a-ag1").languages.join(",") === "English,Spanish" && of("a-ag4").specializations.join(",") === "Investors,Condos", JSON.stringify(w.agents.map((a) => a.facts)))
    check("B2 listings taken = listing_date in 180d ∪ active now (ag2's active listing with a NULL listing_date counts; ag1's 400-day-old sale does not)", of("a-ag2").listings180d === 1 && of("a-ag1").listings180d === 3)
    check("B3 the owner's totals line: 1 strong listing · 1 strong buyer · 1 investor · 1 bilingual · 2 luxury · 1 overwhelmed · 1 underutilized · 1 in development", w.totals.strong_listing === 1 && w.totals.strong_buyer === 1 && w.totals.investor === 1 && w.totals.bilingual === 1 && w.totals.luxury_specialist === 2 && w.totals.overwhelmed === 1 && w.totals.underutilized === 1 && w.totals.in_development === 1 && workforceLine(w) === "5 agents profiled — 1 strong listing · 1 strong buyer · 1 investor · 1 bilingual · 2 luxury · 1 overwhelmed · 1 underutilized · 1 in development", `${workforceLine(w)} ${JSON.stringify(w.totals)}`)
    check("B4 the competency reader ran per agent with agents.user_id + the tenant; a refused read is on the agent's facts (never 'in development'), rails refused are published", competencyCalls.filter((x) => x.startsWith(A)).length === 5 && competencyCalls.includes(`${A}:a-ag1:a-u1`) && of("a-ag4").competencyGaps === null && /refused/.test(of("a-ag4").competencyRefused ?? "") && of("a-ag5").competencyRefused === "tours: refused" && !cls("a-ag4").some((x) => x.kind === "in_development"))
    check("B5 thresholds read as DEFAULT when brokerage_settings carries no key; the evidence names tenant-policy + every reader", w.thresholdsSource === "default" && w.evidence.length === 8 && w.evidence.every((e) => e.table && e.filter && e.via) && w.evidence.some((e) => /tenant-policy/.test(e.via)))
    check("B6 the snapshot persisted carries the workforce section; twinMeasures carries the totals (change detection)", c.tables[TWIN_SNAPSHOT_TABLE][0].twin.workforce.totals.strong_listing === 1 && twinMeasures(twinA)["workforce.strong_listing"] === 1 && twinMeasures(twinA)["workforce.territory.North.sellerContacts30d"] === 8)
    const policy = makeClient(world({ brokerage_settings: [{ brokerage_id: A, settings: { [WORKFORCE_THRESHOLDS_KEY]: { strong_listing_listings_180d: 4, in_development_gaps: 3 } } }, { brokerage_id: B, settings: { [WORKFORCE_THRESHOLDS_KEY]: { strong_listing_listings_180d: 1 } } }] }))
    const tp = (await buildBrokerageTwin(A, NOW, { svc: policy as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false })).twin.workforce
    check("B7 TENANT POLICY changes the verdicts: A's policy (listings ≥ 4, gaps ≥ 3) → 0 strong listing, 0 in development; B's policy never leaks into A", tp.thresholdsSource === "policy" && tp.thresholds.strong_listing_listings_180d === 4 && tp.totals.strong_listing === 0 && tp.totals.in_development === 0 && tp.totals.strong_buyer === 1)
    // An OLDER snapshot without the section: the diff is a baseline of 0 for every workforce measure, never a crash.
    const { workforce: _drop, ...older } = twinA
    const old = makeClient(world({ [TWIN_SNAPSHOT_TABLE]: [{ id: "snap-old", brokerage_id: A, team_id: null, at: iso(2), twin: older }] }))
    const t2 = (await buildBrokerageTwin(A, NOW, { svc: old as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false })).twin
    const ch = t2.changed.changes.find((x) => x.field === "workforce.strong_listing")
    check("B8 a snapshot that predates the section diffs as a change against 0 (the workforce APPEARED); detectTwinChanges is pure", !t2.changed.baseline && ch?.previous === 0 && ch.current === 1 && detectTwinChanges(twinMeasures(older as any), twinMeasures(twinA)).some((x) => x.field === "workforce.underutilized"))
    const snap = makeClient(world({ [TWIN_SNAPSHOT_TABLE]: [{ id: "snap-fresh", brokerage_id: A, team_id: null, at: iso(0.2), twin: twinA }] }))
    const wp = (await readBrokerageTwin(A, { svc: snap as any, snapshot: { now: NOW } }))?.workforce ?? null
    check("B9 readBrokerageTwin (snapshot mode) serves the persisted twin's workforce section (one read, no rebuild); an empty tenant id reads nothing", wp?.totals.luxury_specialist === 2 && snap.log.filter((l) => l.op === "select").length === 1 && (await readBrokerageTwin("", { svc: snap as any, snapshot: { now: NOW } }).catch(() => null)) === null)
  }

  // ─── C. territory demand → recruiting need (pure) ───────────────────────────────────────────
  console.log("\nC. territory demand → recruiting need")
  {
    const north = twinA.workforce.territories.find((t) => t.territory === "North")!
    const south = twinA.workforce.territories.find((t) => t.territory === "South")!
    check("C1 North: seller leads 2 → 8 (buyer leads excluded), trend UP, 50% luxury-priced, serving agents ag2 (over) + ag3 (available) → 1 with headroom, 0 luxury specialists", north.sellerContactsPrev30d === 2 && north.sellerContacts30d === 8 && north.trend === "up" && north.luxuryShare30d === 0.5 && north.servingAgentIds.length === 2 && north.agentsWithHeadroom === 1 && north.luxurySpecialists === 0 && north.zips.join(",") === "90001,90002,90003", JSON.stringify(north))
    check("C2 South: 3 → 3 is flat (served by ag1, a strong listing + luxury agent); the inactive farm (West) is not a territory", south.trend === "flat" && south.listingSpecialists === 1 && south.luxurySpecialists === 1 && !twinA.workforce.territories.some((t) => t.territory === "West"))
    const needs = recruitingNeeds(twinA)
    check("C3 THE OWNER'S EXAMPLE: North demand ↑, capacity insufficient (1 agent with headroom for 8 leads), luxury coverage weak → ONE need, luxury specialization, with evidence reasons", needs.length === 1 && needs[0].territory === "North" && needs[0].specialization === "luxury" && needs[0].count === 1 && needs[0].reasons.length === 3 && /2 → 8/.test(needs[0].reasons[0]) && /50% of the seller leads/.test(needs[0].reasons[2]) && needs[0].zips.length === 3, JSON.stringify(needs))
    check("C4 the objective is the owner's wording", recruitingNeedObjective(needs[0]) === "find 1 experienced listing agent in North with luxury specialization")
    const covered = { workforce: { ...twinA.workforce, territories: twinA.workforce.territories.map((t) => (t.territory === "North" ? { ...t, agentsWithHeadroom: 2, luxurySpecialists: 1 } : t)) } }
    check("C5 (control) enough covered headroom + a luxury specialist → NO need; a rise under the policy minimum → no need; demand nobody serves → a need of the whole demand", recruitingNeeds(covered).length === 0 && recruitingNeeds({ workforce: { ...twinA.workforce, thresholds: { ...T, demand_min_leads_30d: 9 }, territories: composeTerritoryDemand({ thresholds: { ...T, demand_min_leads_30d: 9 }, thresholdsSource: "policy", agents: twinA.workforce.agents.map((a) => a.facts), farms: twinA.workforce.territories.flatMap((t) => t.servingAgentIds.map((agent_id) => ({ name: t.territory, zip_codes: t.zips, agent_id }))), sellerContacts60d: (tenant(A, "a").contacts as Row[]).filter((c) => c.contact_type === "seller" || c.contact_type === "both") as any }, NOW.toISOString(), twinA.capacity.perAgent, twinA.workforce.agents) } }).length === 0 && (() => { const d = composeTerritoryDemand({ ...twinA.workforce as any, thresholds: T, agents: [], farms: [], sellerContacts60d: [{ id: "x", zip_code: "99999", home_value_estimate: 100, created_at: iso(1) }, { id: "y", zip_code: "99999", home_value_estimate: 100, created_at: iso(2) }, { id: "z", zip_code: "99999", home_value_estimate: 100, created_at: iso(3) }, { id: "w", zip_code: "99999", home_value_estimate: 100, created_at: iso(4) }, { id: "v", zip_code: "99999", home_value_estimate: 100, created_at: iso(5) }] }, NOW.toISOString(), [], []); const n = recruitingNeeds({ workforce: { ...twinA.workforce, territories: d } }); return d[0]?.territory === "unassigned" && n[0]?.specialization === "listing" && n[0].count === 1 })())
    check("C6 a larger shortfall sizes the need: 40 seller leads at 8 per agent with 1 agent with headroom → 4 listing agents", recruitingNeeds({ workforce: { ...twinA.workforce, territories: [{ ...north, sellerContacts30d: 40, luxuryShare30d: 0 }] } })[0]?.count === 4)
  }

  // ─── D. need → RECRUITING MISSION through the real service ─────────────────────────────────
  console.log("\nD. need → recruiting mission, APPROVAL_REQUIRED, idempotent, no targeting until approved")
  {
    const c = makeClient(world()); const s = missionDeps()
    const r1 = await ensureRecruitingMissionsFromTwin(twinA, c as any, s.deps)
    const m = c.tables.missions[0]
    check("D1 one need → one mission: mission_type recruiting, owner recruiting_manager (a registry key), data_steward participating, the owner's objective, criterion recruits_joined ≥ 1, subject recruiting_need", r1.created.length === 1 && r1.refused.length === 0 && c.tables.missions.length === 1 && m.mission_type === "recruiting" && m.owner_manager === "recruiting_manager" && m.owner_manager in MANAGERS && m.participating_managers.includes("data_steward") && m.objective === "find 1 experienced listing agent in North with luxury specialization" && m.success_criteria[0].metric === "recruits_joined" && m.subject_type === RECRUITING_NEED_SUBJECT_TYPE && m.brokerage_id === A, JSON.stringify({ r1, m: { ...m, evidence: undefined } }))
    check("D2 RECOMMENDATION FIRST: the mission is held APPROVAL_REQUIRED, the owner manager signalled (mission_escalated_for_approval), the ledger + mission_events rows written (LAW 5)", m.state === "APPROVAL_REQUIRED" && s.signals.some((x) => x.signalType === MISSION_APPROVAL_REQUIRED_SIGNAL && x.toManager === "recruiting_manager") && s.ledger.some((l) => l.action === "mission.objective.create") && s.ledger.some((l) => l.to === "APPROVAL_REQUIRED") && c.tables.mission_events.some((e) => e.mission_id === m.id && e.event_kind === "transition" && e.to_state === "APPROVAL_REQUIRED") && c.tables.mission_events.some((e) => e.mission_id === m.id && e.event_kind === "created"))
    const tg = recruitingTargetingOf(m as any)
    check("D3 the targeting (territory + specialization + zips + reasons + twin digest) is attached as recruiting_targeting evidence", tg?.territory === "North" && tg.specialization === "luxury" && tg.zips.length === 3 && m.evidence.some((e: Row) => e.kind === RECRUITING_TARGETING_EVIDENCE_KIND && e.twin_digest === twinA.digest && Array.isArray(e.reasons)))
    const sid = recruitingNeedSubjectId(A, "North", "luxury")
    check("D4 the subject id is a deterministic uuid of (tenant, territory, specialization) — case/space-insensitive, tenant-distinct", m.subject_id === sid && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(sid) && recruitingNeedSubjectId(A, " north ", "LUXURY") === sid && recruitingNeedSubjectId(B, "North", "luxury") !== sid && recruitingNeedSubjectId(A, "North", "listing") !== sid)
    const r2 = await ensureRecruitingMissionsFromTwin(twinA, c as any, s.deps)
    check("D5 IDEMPOTENT: a re-run on the same twin creates nothing (the open mission covers the need), no second ledger row", r2.created.length === 0 && r2.existing.length === 1 && c.tables.missions.length === 1 && s.ledger.filter((l) => l.action === "mission.objective.create").length === 1)
    const before = await recruitingTargetingFor(A, c as any)
    check("D6 NO OUTREACH WITHOUT APPROVAL: the sourcer's targeting is EMPTY while the mission awaits its human; the mission's own objective never reaches a prospect", before.targeting.length === 0 && before.readRefused === null)
    const ok = await transitionMission({ brokerageId: A, missionId: m.id, to: "ACTIVE", reason: "approved by the broker", actor: { type: "user", id: "broker-1" } }, c as any, s.deps)
    const after = await recruitingTargetingFor(A, c as any)
    check("D7 a HUMAN approval (APPROVAL_REQUIRED → ACTIVE, the decideMissionAction edge) is what hands the pipeline its criteria: territory North, specialization luxury", ok.ok && after.targeting.length === 1 && after.targeting[0].territory === "North" && after.targeting[0].specialization === "luxury" && after.targeting[0].missionId === m.id)
    check("D8 targetingSearchTerms turns the approved targeting into search criteria (no term for an unassigned territory's name)", targetingSearchTerms(after.targeting).join("|") === "luxury listing agent north|listing agent north" && targetingSearchTerms([{ missionId: "x", territory: "unassigned", specialization: "listing" }]).join("|") === "listing listing agent" && targetingSearchTerms(undefined).length === 0)
    const r3 = await ensureRecruitingMissionsFromTwin(twinA, c as any, s.deps)
    check("D9 an ACTIVE (approved) mission still covers the need — the re-run after approval creates nothing", r3.created.length === 0 && r3.existing.length === 1)
    const refused = makeClient(world(), { refuse: new Set(["missions"]) })
    const r4 = await ensureRecruitingMissionsFromTwin(twinA, refused as any, s.deps)
    check("D10 (fail closed) a refused missions read is PUBLISHED and creates nothing; a twin without the section creates nothing", r4.readRefused !== null && r4.created.length === 0 && (await ensureRecruitingMissionsFromTwin({ ...twinA, workforce: undefined as any }, c as any, s.deps)).needs.length === 0)
    const noNeed = makeClient(world()); const s2 = missionDeps()
    const r5 = await ensureRecruitingMissionsFromTwin({ ...twinA, workforce: { ...twinA.workforce, territories: twinA.workforce.territories.map((t) => ({ ...t, trend: "flat" as const })) } }, noNeed as any, s2.deps)
    check("D11 (control) no need → no mission, no ledger row, no signal", r5.needs.length === 0 && noNeed.tables.missions.length === 0 && s2.ledger.length === 0 && s2.signals.length === 0)
  }

  // ─── E. tenant isolation ────────────────────────────────────────────────────────────────────
  console.log("\nE. tenant isolation — every read pinned; teams see their board; platform sees each tenant's own twin")
  {
    const c = makeClient(world())
    await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false })
    const reads = c.log.filter((l) => l.op === "select")
    const newTables = ["brokerage_settings", "offers", "farm_territories"]
    check("E1 every read is pinned to brokerage_id, the six new reads included", reads.length >= 20 && reads.every((l) => l.filters.includes("eq:brokerage_id")) && newTables.every((t) => reads.some((l) => l.table === t)), reads.filter((l) => !l.filters.includes("eq:brokerage_id")).map((l) => l.table).join(","))
    const w = twinA.workforce
    check("E2 tenant B's rows never reach A's profile (same shape, both tenants loaded): every agent / farm / lead id is A's", w.agents.every((a) => a.agentId.startsWith("a-")) && w.territories.every((t) => t.servingAgentIds.every((id) => id.startsWith("a-"))) && w.territories.find((t) => t.territory === "North")!.sellerContacts30d === 8)
    const tb = (await buildBrokerageTwin(B, NOW, { svc: c as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false })).twin
    check("E3 platform sees ALL tenants — each tenant's OWN twin (B's profile is B's agents, same totals, no bleed)", tb.workforce.agents.every((a) => a.agentId.startsWith("b-")) && tb.workforce.totals.strong_listing === 1 && recruitingNeeds(tb)[0]?.territory === "North")
    const team = (await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false, teamId: TEAM })).twin
    check("E4 a TEAM scope profiles only the team's members (ag1, ag2 — through agents.team_id); the team's listings / offers / contacts are its own", team.teamId === TEAM && team.workforce.agents.length === 2 && team.workforce.agents.every((a) => ["a-ag1", "a-ag2"].includes(a.agentId)) && team.workforce.totals.strong_buyer === 0 && team.workforce.totals.strong_listing === 1)
    const cc = src("lib/kernel/command-center.ts")
    check("E5 a team's twin never recruits for the brokerage: the Command Center calls ensureRecruitingMissionsFromTwin only under brokerageWide (source)", /if \(brokerageTwin && brokerageWide\) \{[\s\S]*?ensureRecruitingMissionsFromTwin\(brokerageTwin/.test(cc))
    let threw = false
    try { await buildBrokerageTwin("", NOW, { svc: c as any }) } catch { threw = true }
    check("E6 (fail closed) no brokerage id → refused, never every tenant; the twin refuses an empty tenant id", threw)
  }

  // ─── F. wiring + registration ──────────────────────────────────────────────────────────────
  console.log("\nF. wiring (stripped source) + registration")
  {
    const twin = code("lib/kernel/brokerage-twin.ts"), twinS = src("lib/kernel/brokerage-twin.ts")
    check("F1 the twin composes the workforce section AFTER capacity and persists it with the twin (composeWorkforce inside composeBrokerageTwin; TwinFacts.workforce)", twinS.indexOf("const workforce = composeWorkforce(f, scope)") > twinS.indexOf("const capacity: TwinCapacity = {") && /workforce: \{ thresholds, thresholdsSource/.test(twinS))
    check("F2 the loader reads the policy through resolveWorkforceThresholds and the competency through loadAgentCompetency (the one reader), never a second competency gatherer", /resolveWorkforceThresholds\(settingsRow\?\.settings\)/.test(twinS) && /loadAgentCompetency\(/.test(twinS) && !/scoreCompetency\(/.test(twin) && !/objection_training_sessions/.test(twin))
    const ms = src("lib/kernel/missions.ts")
    check("F3 missions.ts creates the recruiting mission PLANNING → escalateMission(needsHuman) and reads targeting from ACTIVE missions only", /missionType: "recruiting"/.test(ms) && /initialState: "PLANNING"/.test(ms) && /needsHuman: true/.test(ms) && /m\.state === "ACTIVE"\)\.map\(recruitingTargetingOf\)/.test(ms))
    check("F4 the Command Center hands the built twin to ensureRecruitingMissionsFromTwin right after syncMissionProgressFromTwin", src("lib/kernel/command-center.ts").indexOf("ensureRecruitingMissionsFromTwin(brokerageTwin") > src("lib/kernel/command-center.ts").indexOf("syncMissionProgressFromTwin(brokerageTwin"))
    const cron = src("app/api/cron/lead-scraping/route.ts")
    check("F5 the recruiting pipeline consumes the targeting: the lead-scraping cron reads recruitingTargetingFor(market.brokerage_id) and passes `targeting` to sourceRecruitProspects; the sourcer widens its terms", /recruitingTargetingFor\(market\.brokerage_id/.test(cron) && /sourceRecruitProspects\(\{[\s\S]*?targeting,/.test(cron) && /targetingSearchTerms\(params\.targeting\)/.test(src("lib/recruit-pipeline/recruit-sourcer.ts")))
    check("F6 surfaces: the Command Center twin card (workforce line), the recruiting dashboard Needs block (getRecruitingNeeds), the team-lead brief (team-workforce)", /brokerageTwin\?\.workforce/.test(src("app/dashboard/admin/command-center/command-center-client.tsx")) && /getRecruitingNeeds\(\)/.test(src("app/dashboard/recruiting-roi/page.tsx")) && /recruitingNeeds\(twin\)/.test(src("app/actions/recruiting-roi.ts")) && /id: "team-workforce"/.test(src("lib/intelligence/user-type-briefs/team-lead.ts")) && /teamTwin\?\.workforce/.test(src("lib/intelligence/user-type-briefs/team-lead.ts")))
    const editorAct = code("app/actions/admin/improvement-proposals.ts"), editorActS = src("app/actions/admin/improvement-proposals.ts")
    check("F7 ONE policy writer: neither recruiting-roi.ts nor the dedicated editor's actions write the thresholds themselves — the editor submits a `policy` proposal (proposer human) through proposeEvaluatePromote; the key's registration names the proposal promotion path",
      !/mergeBrokerageSettings\(/.test(code("app/actions/recruiting-roi.ts")) && !/mergeBrokerageSettings\(/.test(editorAct) && !/appendTenantPolicyVersion\(/.test(editorAct) && !/from\("brokerage_settings"\)/.test(editorActS)
      && /proposeEvaluatePromote\(svc, \{[\s\S]{0,200}subjectKind: "policy",\s*subjectKey: WORKFORCE_THRESHOLDS_KEY,\s*proposer: "human",/.test(editorActS)
      && /policy-proposal promotion path/.test(readFileSync("lib/kernel/tenant-policy.ts", "utf8")) && /workforce_thresholds:/.test(src("lib/kernel/tenant-policy.ts")))
    const fixture = stripComments(`// TOMBSTONE: ensureRecruitingMissionsFromTwin(brokerageTwin) used to live here\nconst x = 1\n/* recruitingTargetingFor(market.brokerage_id) */`)
    check("F8 (control) a tombstone naming the wires is NOT read as a call site", !/ensureRecruitingMissionsFromTwin\(brokerageTwin/.test(fixture) && !/recruitingTargetingFor\(market/.test(fixture) && /const x = 1/.test(fixture))
    const pkg = JSON.parse(readFileSync("package.json", "utf8"))
    check("F9 package.json: test:workforce-intelligence → this guard, a member of the guard chain (position is not pinned — CLAUDE.md §2)", pkg.scripts["test:workforce-intelligence"] === "tsx scripts/workforce-intelligence-guard.ts" && new RegExp("npm run test:workforce-intelligence(\\s|&|$)").test(pkg.scripts.guard))
    const dom = MAINTENANCE_DOMAINS.brokerage_workforce_intelligence
    check("F10 MAINTENANCE_DOMAINS.brokerage_workforce_intelligence: recruiting_manager owns it, proof named, co-owners named in the prose", dom?.manager === "recruiting_manager" && dom.proof === "test:workforce-intelligence" && (dom.coOwners ?? []).length === 2 && (dom.coOwners ?? []).every((k) => k in MANAGERS && dom.what.includes(k)) && TABLE_MANAGER[TWIN_SNAPSHOT_TABLE] === "data_steward" && TABLE_MANAGER.missions === "campaign_orchestrator")
  }

  // ─── G. the dedicated thresholds editor (wave 107G) ──────────────────────────────────────────
  console.log("\nG. the dedicated workforce-thresholds editor")
  {
    const D = DEFAULT_WORKFORCE_THRESHOLDS
    const asForm = (t: Record<string, unknown>) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, String(v)]))
    const same = validateWorkforceThresholdsEdit(asForm(D as any))
    check("G1 the defaults submitted back store NOTHING (value null → the key is removed; the tenant keeps following the defaults)", same.ok && same.value === null && same.changedKeys.length === 0 && JSON.stringify(resolveWorkforceThresholds({ [WORKFORCE_THRESHOLDS_KEY]: same.ok ? same.value : 1 })) === JSON.stringify(D))
    const edited = { ...D, strong_listing_listings_180d: 5, luxury_list_price_usd: 1_500_000, overwhelmed_band: "at_capacity" as const, seller_leads_per_agent_30d: 12 }
    const e = validateWorkforceThresholdsEdit(asForm(edited))
    check("G2 an edit stores ONLY the changed keys, and the resolver reads the stored value back to exactly the edited thresholds (round trip)", e.ok && JSON.stringify(Object.keys(e.value ?? {}).sort()) === JSON.stringify(["luxury_list_price_usd", "overwhelmed_band", "seller_leads_per_agent_30d", "strong_listing_listings_180d"]) && JSON.stringify(resolveWorkforceThresholds({ [WORKFORCE_THRESHOLDS_KEY]: e.ok ? e.value : null })) === JSON.stringify(edited))
    // One bounds table: derived per field from WORKFORCE_THRESHOLD_FIELDS (never a pinned number).
    const boundsAgree = WORKFORCE_THRESHOLD_FIELDS.every((f) => {
      const over = validateWorkforceThresholdsEdit(asForm({ ...D, [f.key]: f.max + 1 }))
      const atMax = validateWorkforceThresholdsEdit(asForm({ ...D, [f.key]: f.max }))
      const under = validateWorkforceThresholdsEdit(asForm({ ...D, [f.key]: f.min - 1 }))
      const resolvedOver = resolveWorkforceThresholds({ [WORKFORCE_THRESHOLDS_KEY]: { [f.key]: f.max + 1 } })[f.key]
      const resolvedMax = resolveWorkforceThresholds({ [WORKFORCE_THRESHOLDS_KEY]: { [f.key]: f.max } })[f.key]
      return !over.ok && over.errors.some((x) => x.startsWith(f.label)) && atMax.ok && !under.ok && resolvedOver === D[f.key] && resolvedMax === f.max
    })
    check(`G3 the editor and the resolver share ONE bounds table — for all ${WORKFORCE_THRESHOLD_FIELDS.length} numeric fields: max+1 and min-1 are refused by the editor (naming the field), max is accepted (positive control), and the resolver drops max+1 to the default`, boundsAgree && WORKFORCE_THRESHOLD_FIELDS.length === Object.keys(D).length - 1)
    const missing = { ...asForm(D as any) }; delete (missing as any).demand_rise_pct
    const mv = validateWorkforceThresholdsEdit(missing)
    const badBand = validateWorkforceThresholdsEdit({ ...asForm(D as any), overwhelmed_band: "melting" })
    const nan = validateWorkforceThresholdsEdit({ ...asForm(D as any), investor_contacts: "lots" })
    check("G4 fail closed: a MISSING field, a non-number and an unknown band are refusals (never a silent default); every band in WORKFORCE_OVERWHELMED_BANDS is accepted (control)", !mv.ok && mv.errors.length === 1 && /required/.test(mv.errors[0]) && !badBand.ok && !nan.ok && WORKFORCE_OVERWHELMED_BANDS.every((b) => validateWorkforceThresholdsEdit({ ...asForm(D as any), overwhelmed_band: b }).ok))

    // The real proposal path, in memory: propose (no policy write) → apply now (approve + promote).
    const BRK = "11111111-1111-4111-8111-11111111aaaa", ADMIN = "aaaaaaaa-0000-4000-8000-0000000000a1"
    const seed = () => memSupabase({ improvement_proposals: [], brokerage_settings: [{ id: "bs-1", brokerage_id: BRK, settings: {}, updated_at: "2026-10-01T00:00:00.000Z" }], tenant_policy_versions: [], agent_action_ledger: [] }, { stampCreatedAt: true })
    const mem = seed()
    const value = e.ok ? e.value : null
    const input = { brokerageId: BRK, subjectKind: "policy" as const, subjectKey: WORKFORCE_THRESHOLDS_KEY, proposer: "human" as const, proposedChange: { value, changed_keys: e.ok ? e.changedKeys : [] }, evidenceRefs: [{ kind: "human_edit", surface: "manager_trust.workforce_thresholds" }] }
    const proposed = await proposeEvaluatePromote(mem as any, { ...input, actor: null })
    const settingsAfterPropose = (mem.tables.brokerage_settings[0] as any).settings
    check("G5 PROPOSE records one `policy` proposal (proposer human) that evaluates to EVALUATED (no deterministic replay for a settings key → a human decides) and writes NO policy and NO version", proposed.proposal.ok && proposed.status === "EVALUATED" && !proposed.promoted && mem.tables.improvement_proposals.length === 1 && (mem.tables.improvement_proposals[0] as any).proposer === "human" && settingsAfterPropose[WORKFORCE_THRESHOLDS_KEY] === undefined && mem.tables.tenant_policy_versions.length === 0, JSON.stringify(proposed))
    const applied = await proposeEvaluatePromote(mem as any, { ...input, actor: { type: "user", userId: ADMIN, isTenantAdmin: true, reason: "workforce thresholds applied from the dedicated editor" } })
    const st = (mem.tables.brokerage_settings[0] as any).settings
    const ledger = mem.tables.agent_action_ledger.filter((r: any) => r.action === "learning.proposal.promote")
    check("G6 APPLY NOW rides the SAME open proposal (no second row) → APPROVED → PROMOTED through the promotion function: the setting lands via mergeBrokerageSettings, a tenant_policy_versions row is appended, a learning.proposal.promote ledger row exists, and the twin's resolver reads the new thresholds", applied.promoted && applied.status === "PROMOTED" && mem.tables.improvement_proposals.length === 1 && JSON.stringify(st[WORKFORCE_THRESHOLDS_KEY]) === JSON.stringify(value) && mem.tables.tenant_policy_versions.length >= 1 && ledger.length === 1 && /^workforce_thresholds@\d+$/.test(applied.policyVersionRef ?? "") && resolveWorkforceThresholds(st).strong_listing_listings_180d === 5, JSON.stringify({ applied, versions: mem.tables.tenant_policy_versions.length, ledger: ledger.length }))
    const mem2 = seed()
    const held = await proposeEvaluatePromote(mem2 as any, { ...input, actor: { type: "user", userId: ADMIN, isTenantAdmin: false } })
    check("G7 authority honoured: a user OFF the admin roster cannot apply — held, the proposal stays EVALUATED, nothing written (positive control: G6)", !held.promoted && held.status === "EVALUATED" && !!held.held && (mem2.tables.brokerage_settings[0] as any).settings[WORKFORCE_THRESHOLDS_KEY] === undefined && mem2.tables.tenant_policy_versions.length === 0)

    // Wiring (stripped source).
    const actS = src("app/actions/admin/improvement-proposals.ts")
    check("G8 the submit validates through validateWorkforceThresholdsEdit, gates on the admin roster from the SESSION (requireLearningAdmin → requireCallerTenant), refuses a DIFFERENT open proposal, and passes the human actor only on mode=apply", /export async function submitWorkforceThresholdsAction\(/.test(actS) && /validateWorkforceThresholdsEdit\(input\)/.test(actS) && /const gate = await requireLearningAdmin\(mode === "apply"/.test(actS) && /requireCallerTenant\(\)/.test(actS) && /A different workforce-thresholds proposal is already/.test(readFileSync("app/actions/admin/improvement-proposals.ts", "utf8")) && /actor: mode === "apply" \? gate\.actor : null/.test(actS))
    const formS = src("app/dashboard/admin/manager-trust/workforce-thresholds-form.tsx"), edS = src("app/dashboard/admin/manager-trust/workforce-thresholds-editor.tsx")
    check("G9 surfaces: Manager Trust renders <WorkforceThresholdsEditor /> (read: getWorkforceThresholdsEditor — current vs default + bounds); the client form posts submitWorkforceThresholdsAction with both doors (propose / apply); the recruiting Needs block links to it; none of them writes a setting", /<WorkforceThresholdsEditor \/>/.test(src("app/dashboard/admin/manager-trust/page.tsx")) && /getWorkforceThresholdsEditor\(\)/.test(edS) && /useActionState<[^>]*>\(submitWorkforceThresholdsAction, null\)/.test(formS) && /value="propose"/.test(formS) && /value="apply"/.test(formS) && /manager-trust#workforce-thresholds/.test(src("app/dashboard/recruiting-roi/page.tsx")) && ![formS, edS].some((t) => /mergeBrokerageSettings|brokerage_settings/.test(t)))
    const tomb = stripComments("// TOMBSTONE: setWorkforceThresholds used mergeBrokerageSettings(svc, id, …) here\nconst ok = 1")
    check("G10 (controls) a tombstone naming mergeBrokerageSettings( is NOT a writer; a live call IS matched", !/mergeBrokerageSettings\(/.test(tomb) && /mergeBrokerageSettings\(/.test(blankStrings(stripComments("await mergeBrokerageSettings(svc, b, f)"))))
  }

  // ─── H. THE SNAPSHOT SEAM (wave 107, lane 107C) — competency from the development cycle's ledgered snapshot ─
  console.log("\nH. the competency snapshot seam — one read for the roster, stale → recompute (published), tenant-pinned")
  {
    const { readCompetencySnapshots, competencyGapCount, COMPETENCY_SNAPSHOT_MAX_AGE_HOURS, DEVELOPMENT_ACTION } = await import("../lib/education/skill-freshness-radar")
    const { COMPETENCY_GAP_SCORE, COMPETENCY_SKILLS } = await import("../lib/education/skill-freshness")
    // Scores built from the eleven keys (never restated): ag3 has two at/below the gap score, everyone else none.
    const scores = (gaps: number) => Object.fromEntries(COMPETENCY_SKILLS.map((k, i) => [k, i < gaps ? COMPETENCY_GAP_SCORE - i : i % 3 === 0 ? null : COMPETENCY_GAP_SCORE + 10]))
    const snapRow = (brokerage: string, agentId: string, hoursAgo: number, gaps: number) => ({ id: `led-${brokerage.slice(0, 1)}-${agentId}-${hoursAgo}`, brokerage_id: brokerage, action: DEVELOPMENT_ACTION.update, subject_type: "agent", subject_id: agentId, status: "executed", created_at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(), detail: { scores: scores(gaps) } })
    const fresh = (brokerage: string, tag: string) => [1, 2, 3, 4, 5].map((n) => snapRow(brokerage, `${tag}-ag${n}`, 6, n === 3 ? 2 : 0))
    check("H1 competencyGapCount applies scoreCompetency's rule: a score ≤ COMPETENCY_GAP_SCORE is a gap, one above is not, an unproven (null) skill never is", competencyGapCount({ negotiation: COMPETENCY_GAP_SCORE, pricing: COMPETENCY_GAP_SCORE + 1, marketing: null } as any) === 1 && competencyGapCount(scores(2) as any) === 2 && competencyGapCount(null) === 0)

    // Fresh snapshots for every A agent: the live reader is NEVER called, one ledger read serves the roster.
    competencyCalls.length = 0
    const c1 = makeClient(world({ agent_action_ledger: [...fresh(A, "a"), ...fresh(B, "a").map((r) => ({ ...r, id: r.id + "-foreign", detail: { scores: scores(9) } }))] }))
    const t1 = (await buildBrokerageTwin(A, NOW, { svc: c1 as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false })).twin
    const ledgerReads = c1.log.filter((l) => l.table === "agent_action_ledger" && l.op === "select" && l.filters.includes("in:subject_id"))
    const facts1 = (id: string) => t1.workforce.agents.find((a) => a.agentId === id)!.facts
    check("H2 fresh snapshots → the live competency reader runs 0 times; ONE tenant-pinned ledger read serves all 5 agents", competencyCalls.length === 0 && ledgerReads.length === 1 && ledgerReads[0].filters.includes("eq:brokerage_id") && t1.workforce.agents.every((a) => a.facts.competencySource === "snapshot"), `calls=${competencyCalls.length} ledgerReads=${ledgerReads.length}`)
    check("H3 the snapshot's gap count drives the SAME classification (ag3 in development with 2 gaps; ag1 none) — and tenant B's ledger rows (9 gaps under A's agent ids) are never read into A", facts1("a-ag3").competencyGaps === 2 && facts1("a-ag1").competencyGaps === 0 && t1.workforce.totals.in_development === 1 && !t1.workforce.agents.some((a) => a.facts.competencyGaps === 9))
    check("H4 no snapshot fallback blind spot when every agent was served from the snapshot", !t1.blindSpots.some((s) => /recomputed live/.test(s)))

    // ag2's snapshot is STALE (older than the window) → only ag2 is recomputed live, and that is published.
    competencyCalls.length = 0
    const stale = fresh(A, "a").map((r) => (r.subject_id === "a-ag2" ? { ...r, created_at: new Date(NOW.getTime() - (COMPETENCY_SNAPSHOT_MAX_AGE_HOURS + 2) * 3_600_000).toISOString() } : r))
    const t2 = (await buildBrokerageTwin(A, NOW, { svc: makeClient(world({ agent_action_ledger: stale })) as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false })).twin
    check("H5 a STALE snapshot → that agent alone recomputed through the live reader (source 'live'); the fallback is a published blind spot", competencyCalls.length === 1 && competencyCalls[0].includes(":a-ag2:") && t2.workforce.agents.find((a) => a.agentId === "a-ag2")!.facts.competencySource === "live" && t2.blindSpots.some((s) => /1 of 5 agent\(s\) had no development-cycle snapshot/.test(s)), competencyCalls.join(","))

    // The ledger read REFUSED → every agent recomputed live; the refusal named (never a fake score).
    competencyCalls.length = 0
    const t3 = (await buildBrokerageTwin(A, NOW, { svc: makeClient(world({ agent_action_ledger: fresh(A, "a") }), { refuse: new Set(["agent_action_ledger"]) }) as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false })).twin
    check("H6 a refused snapshot read → every agent recomputed live, the refusal named in blindSpots", competencyCalls.length === 5 && t3.blindSpots.some((s) => /agent_action_ledger\(competency snapshots\): refused/.test(s)) && t3.blindSpots.some((s) => /5 of 5 agent/.test(s)))

    // READ COUNT — the REAL loadAgentCompetency against the same in-memory client: the reads the seam removes.
    const railReads = (log: Array<{ table: string; op: string }>) => log.filter((l) => l.op === "select").length
    const before = makeClient(world())
    await buildBrokerageTwin(A, NOW, { svc: before as any, capacityFor: fakeCapacity, persist: false })
    const after = makeClient(world({ agent_action_ledger: fresh(A, "a") }))
    await buildBrokerageTwin(A, NOW, { svc: after as any, capacityFor: fakeCapacity, persist: false })
    const nBefore = railReads(before.log), nAfter = railReads(after.log)
    console.log(`    read count per build (5 scored agents, real loadAgentCompetency): ${nBefore} without snapshots → ${nAfter} with snapshots (−${nBefore - nAfter}, ~${Math.round((nBefore - nAfter) / 5)} per agent)`)
    check("H7 the snapshot seam DROPS the read count: the real per-agent reader's rails (≥ 10 reads per agent) collapse into one ledger read", nBefore - nAfter >= 5 * 10 - 1, `${nBefore} → ${nAfter}`)
    const rs = await readCompetencySnapshots(makeClient(world({ agent_action_ledger: [...fresh(A, "a"), ...fresh(B, "b")] })) as any, A, ["a-ag1", "b-ag1"], NOW)
    check("H8 readCompetencySnapshots is tenant-pinned: B's agent id asked under A's tenant returns nothing", rs.byAgent.has("a-ag1") && !rs.byAgent.has("b-ag1") && rs.refused === null)
    const tw = src("lib/kernel/brokerage-twin.ts"), rad = src("lib/education/skill-freshness-radar.ts")
    check("H9 wiring: the twin reads readCompetencySnapshots BEFORE the per-agent loop and calls the live reader only for an agent without one; the writer is the development cycle's ledgered update (competencyScoreMap)", tw.indexOf("readCompetencySnapshots(") > 0 && tw.indexOf("readCompetencySnapshots(") < tw.indexOf("await competencyReader(") && /if \(snap\) \{[^}]*continue \}/.test(tw) && /ledger\("update", \{ scores: competencyScoreMap\(profile\)/.test(rad))
  }

  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} workforce-intelligence: ${passed} passed, ${failed} failed`)
  if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
  console.log("\nBLIND SPOTS (published, not asserted): leads.lead_type is free text — seller demand reads 'seller' / 'both' only; listings.listing_date may be null (active listings count regardless, a sold listing with no date does not); the competency reader is bounded by the twin's agent-scoring cap (60) and runs the radar's ~12 reads per agent; a farm with no name is 'unnamed'; the proof's capacity and competency readers are stand-ins with the real readers' SHAPE (capacityFor and loadAgentCompetency have their own proofs: test:capacity, test:competency).")
}

main().catch((e) => { console.error(e); process.exit(1) })
