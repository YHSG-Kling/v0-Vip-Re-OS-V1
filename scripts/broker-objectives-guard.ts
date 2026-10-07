/**
 * scripts/broker-objectives-guard.ts — test:broker-objectives (wave 108, lane 108E).
 *
 * BROKER OBJECTIVES + OBJECTIVE DELEGATION on the mission runtime (lib/kernel/broker-objectives.ts).
 * Proves, against an in-memory supabase-js-shaped client holding TWO tenants:
 *   A  the parser routes by a deterministic pattern table; a place is matched only against the
 *      tenant's own farm_territories (unknown / ambiguous refused); unrecognised text refused.
 *   B  an INVESTIGATION returns an evidence report: the observed move, ranked causes with numbers and
 *      readers, six 105A delegations (request → accept → work → return) each on a capability its
 *      assignee owns; the mission is the controller's and completes; a refused delegation is a named
 *      blind spot (control: the premise not observed when the measure did not move).
 *   C  a DIRECTIVE with a spend cap returns a PROPOSAL whose cost honours the cap, lands in
 *      APPROVAL_REQUIRED, and executes nothing (no delegation, no activation, no campaign row);
 *      a human approval is what moves it (control: a $1 cap fits no lift).
 *   D  an OBJECTIVE DELEGATION creates a PROPOSED parent + one PROPOSED child per manager, parent link
 *      on each, the owner's chain in order, budget shares summing to the plan, the parent's owner the
 *      registry's answer.
 *   E  no hard-coded location in the module (positive control: the scanner catches a planted one).
 *   F  tenant isolation: every row written is tenant A's; tenant B's facts never count; B cannot read
 *      A's mission; B's own territories route B's objective.
 *   G  wiring: the session door, the card, the capabilities, the CHECK superset, the registry.
 */
import { readFileSync, readdirSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { stripComments } from "./strip-comments"
import {
  parseBrokerObjective, matchTerritory, submitBrokerObjective, rankContributingCauses, fitLiftToCap, planObjectiveDelegation,
  EVIDENCE_CHECKS, INVESTIGATORS, DELEGATION_CHAIN, OBJECTIVE_METRIC_PATTERNS, type BrokerObjectiveDeps, type TerritoryCandidate, type EvidenceFinding,
  GOAL_OF_METRIC, OBSERVED_KEY, type ObjectiveEvidenceFacts,
} from "../lib/kernel/broker-objectives"
import { getMission, transitionMission, type MissionDeps } from "../lib/kernel/missions"
import type { DelegationDeps } from "../lib/kernel/manager-delegation"
import { composeBrokerageTwin, OBJECTIVE_MEASURES, DEFAULT_WORKFORCE_THRESHOLDS, type TwinFacts, type TwinAgentCapacity } from "../lib/kernel/brokerage-twin"
import { simulateScenario, SATURATION_SWEEP_STEP, SATURATION_SWEEP_MAX, type ScenarioFacts } from "../lib/kernel/twin-scenario"
import { CAPABILITY_MANAGER } from "../lib/agentic-os/capability-ownership"
import { APP_CAPABILITY_REGISTRY } from "../lib/agentic-os/app-capability-registry"
import { VOICE_WITHHELD } from "../lib/voice-admin/kernel-command-surface"
import { MAINTENANCE_DOMAINS, MANAGERS } from "../lib/kernel/manager-registry"
import { MEASURE_CAPABILITIES } from "../lib/kernel/mission-controller"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: unknown) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail !== undefined ? `\n      ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`) } }
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

// ─── in-memory supabase-js shaped client (manager-delegation-guard's, with REAL range filters) ──
type Row = Record<string, any>
function memClient(tables: Record<string, Row[]> = {}, opts: { refuseInsert?: (table: string, row: Row) => string | null } = {}) {
  const t = (name: string) => (tables[name] ??= [])
  const writes: Array<{ table: string; op: string }> = []
  return {
    tables, writes,
    from(table: string) {
      const preds: Array<(r: Row) => boolean> = []
      let op: "select" | "insert" | "update" | "delete" = "select"
      let payload: Row | Row[] | null = null
      let limitN: number | null = null
      const run = (): { data: any; error: any } => {
        if (op !== "select") writes.push({ table, op })
        if (op === "insert") {
          const rows = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...r }))
          for (const r of rows) { const why = opts.refuseInsert?.(table, r); if (why) return { data: null, error: { message: why } } }
          for (const r of rows) {
            if (table === "missions") Object.assign(r, { spent_usd: r.spent_usd ?? 0, spent_tokens: r.spent_tokens ?? 0, blockers: r.blockers ?? [], evidence: r.evidence ?? [], progress: r.progress ?? {}, actions: r.actions ?? [], outcomes: r.outcomes ?? [], state_changed_at: r.state_changed_at ?? r.created_at })
            if (table === "manager_delegations") Object.assign(r, { spent_usd: r.spent_usd ?? 0, spent_tokens: r.spent_tokens ?? 0, evidence: r.evidence ?? [], result: r.result ?? null, state_changed_at: r.state_changed_at ?? r.created_at, completed_at: r.completed_at ?? null })
            t(table).push(r)
          }
          return { data: rows, error: null }
        }
        const hits = t(table).filter((r) => preds.every((p) => p(r)))
        if (op === "update") { for (const r of hits) Object.assign(r, payload); return { data: hits.map((r) => structuredClone(r)), error: null } }
        if (op === "delete") { tables[table] = t(table).filter((r) => !hits.includes(r)); return { data: hits, error: null } }
        return { data: (limitN ? hits.slice(0, limitN) : hits).map((r) => structuredClone(r)), error: null }
      }
      const b: any = {
        select: () => b, order: () => b, not: () => b, or: () => b, neq: () => b,
        is: (c: string, v: unknown) => { preds.push((r) => (r[c] ?? null) === v); return b },
        gte: (c: string, v: string) => { preds.push((r) => r[c] != null && String(r[c]) >= v); return b },
        lt: (c: string, v: string) => { preds.push((r) => r[c] != null && String(r[c]) < v); return b },
        lte: (c: string, v: string) => { preds.push((r) => r[c] != null && String(r[c]) <= v); return b },
        limit: (n: number) => { limitN = n; return b },
        insert: (p: Row | Row[]) => { op = "insert"; payload = p; return b },
        update: (p: Row) => { op = "update"; payload = p; return b },
        delete: () => { op = "delete"; return b },
        eq: (c: string, v: unknown) => { preds.push((r) => r[c] === v); return b },
        in: (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return b },
        contains: (c: string, v: Row) => { preds.push((r) => Object.entries(v).every(([k, x]) => r[c]?.[k] === x)); return b },
        single: () => { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }) },
        maybeSingle: () => { const r = run(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }) },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      }
      return b
    },
  }
}

// ─── fixtures — territory names are FIXTURE DATA (tenants are nationwide; the module names none) ──
const A = "aaaaaaaa-0000-0000-0000-0000000000a1", B = "bbbbbbbb-0000-0000-0000-0000000000b2"
const USER_A = "11111111-0000-0000-0000-000000000001", USER_B = "22222222-0000-0000-0000-000000000002"
const NOW = new Date("2026-10-07T12:00:00.000Z")
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString()
const TERR_A = "Cedar Hollow", TERR_A2 = "Juniper Flats", TERR_B = "Desert Ridge"

function twinFacts(brokerageId: string, farms: Array<{ name: string; zip: string }>): TwinFacts {
  const perAgent: TwinAgentCapacity[] = Array.from({ length: 4 }, (_, i) => ({ agentId: `ag-${i}`, band: "available", load: 10, headroom: 10, followUpDebt: 0, fatigueTier: null, reasons: [] }))
  return {
    brokerageId, teamId: null, at: NOW.toISOString(),
    leads: Array.from({ length: 60 }, (_, i) => ({ id: `l-${i}`, lifecycle_state: "isa_qualifying" })), converted90d: 12, contactsActive: 200,
    listings: [{ id: "li-1", status: "active" }], transactions: [{ id: "tx-1", status: "pending", estimated_commission: 9000 }],
    closed90d: [{ id: "c1", commission_amount: 10000 }, { id: "c2", commission_amount: 12000 }, { id: "c3", commission_amount: 8000 }],
    dealHealth: [], listingHealth: [], stallSignals: [], fatigue: [], retention: [], complianceOpen: [], goals: [], strategyPending: 0,
    capacity: { maxLoad: 40, perAgent, unscored: 0, activeAgents: 4 }, forecast: [], aiCost30dCents: 4000,
    contributionMargin: { status: "unavailable", cents: null, source: "x" }, missions: { status: "none", active: 0, source: "x" },
    previous: null, previousReason: "no prior snapshot", blindSpots: [],
    workforce: {
      thresholds: DEFAULT_WORKFORCE_THRESHOLDS, thresholdsSource: "default",
      agents: perAgent.map((a, i) => ({ agentId: a.agentId, userId: null, languages: [], specializations: [], listings180d: i === 0 ? 5 : 0, luxuryListings180d: 0, offers180d: 0, investorContacts: 0, competencyGaps: 0, competencyRefused: null })),
      farms: farms.map((f, i) => ({ name: f.name, zip_codes: [f.zip], agent_id: `ag-${i}` })),
      sellerContacts60d: Array.from({ length: 12 }, (_, i) => ({ id: `s-${i}`, zip_code: farms[i % farms.length].zip, home_value_estimate: 400000, created_at: ago(5) })),
    },
  }
}
const twinA = composeBrokerageTwin(twinFacts(A, [{ name: TERR_A, zip: "10001" }, { name: TERR_A2, zip: "10002" }]))
const twinB = composeBrokerageTwin(twinFacts(B, [{ name: TERR_B, zip: "20001" }]))
const market: ScenarioFacts = { marketing: { leads30d: 50, spendUsd30d: 2500, rows: 30 }, txDeskStaff: 1, mediaCostUsd: { image: 0.04, graphic: 0.04, ad_creative: 0.04, social_post: 0.02, video: 2.5 }, mediaVariants: 4, refused: [] }

/** Seed one tenant's period rows: `prev` in the window before, `cur` in the latest window. */
function seed(tables: Record<string, Row[]>, b: string, o: { apptsPrev: number; apptsCur: number; sellerPrev: number; sellerCur: number; adLeadsPrev: number; adLeadsCur: number; sellerContacts?: number }) {
  const push = (tb: string, r: Row) => (tables[tb] ??= []).push({ id: randomUUID(), brokerage_id: b, ...r })
  for (let i = 0; i < o.apptsPrev; i++) push("listing_presentations", { appointment_at: ago(45) })
  for (let i = 0; i < o.apptsCur; i++) push("listing_presentations", { appointment_at: ago(10) })
  for (let i = 0; i < o.sellerPrev; i++) push("leads", { source: i % 2 ? "zillow" : "website", lead_type: "seller", contact_id: i % 2 ? randomUUID() : null, created_at: ago(40) })
  for (let i = 0; i < o.sellerCur; i++) push("leads", { source: "website", lead_type: "seller", contact_id: i % 4 === 0 ? randomUUID() : null, created_at: ago(8) })
  for (let i = 0; i < 20; i++) push("raw_scraped_leads", { source: "permits", processing_status: i < 4 ? "rejected_no_contact" : "promoted", lead_id: null, created_at: ago(40) })
  for (let i = 0; i < 20; i++) push("raw_scraped_leads", { source: "permits", processing_status: i < 4 ? "rejected_no_contact" : "promoted", lead_id: null, created_at: ago(9) })
  push("ad_performance", { spend: 1000, leads: o.adLeadsPrev, conversions: 3, captured_at: ago(35) })
  push("ad_performance", { spend: 1000, leads: o.adLeadsCur, conversions: 1, captured_at: ago(5) })
  for (let i = 0; i < 10; i++) push("sequence_step_executions", { created_at: ago(40), replied_at: i < 3 ? ago(39) : null })
  for (let i = 0; i < 10; i++) push("sequence_step_executions", { created_at: ago(9), replied_at: i < 3 ? ago(8) : null })
  push("transactions", { status: "closed", deleted_at: null, close_date: ago(40).slice(0, 10), commission_amount: 9000 })
  push("transactions", { status: "closed", deleted_at: null, close_date: ago(12).slice(0, 10), commission_amount: 9000 })
  // WAVE 137: seller-side CONTACTS (seller | both) — the listing appointment rate's denominator. 25 per window
  // for A (B differs so a leak moves the rate); a buyer contact is outside the population.
  const sc = o.sellerContacts ?? 25
  for (let i = 0; i < sc; i++) push("contacts", { contact_type: i % 3 ? "seller" : "both", deleted_at: null, created_at: ago(40) })
  for (let i = 0; i < sc; i++) push("contacts", { contact_type: i % 3 ? "seller" : "both", deleted_at: null, created_at: ago(8) })
  for (let i = 0; i < 30; i++) push("contacts", { contact_type: "buyer", deleted_at: null, created_at: ago(8) })
}
function world(o: { refuseNewCaps?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    farm_territories: [
      { id: randomUUID(), brokerage_id: A, name: TERR_A, city: "Cedarville", state: "XX", is_active: true },
      { id: randomUUID(), brokerage_id: A, name: TERR_A2, city: null, state: "XX", is_active: true },
      { id: randomUUID(), brokerage_id: B, name: TERR_B, city: "Ridgeton", state: "YY", is_active: true },
    ],
  }
  seed(tables, A, { apptsPrev: 20, apptsCur: 10, sellerPrev: 40, sellerCur: 20, adLeadsPrev: 30, adLeadsCur: 10 })
  // Tenant B's rows sit in the same tables — a leak would change every count A reports.
  seed(tables, B, { apptsPrev: 3, apptsCur: 90, sellerPrev: 5, sellerCur: 80, adLeadsPrev: 1, adLeadsCur: 99, sellerContacts: 7 })
  const NEW_CAPS = ["campaign_performance_report", "ads_performance_report", "listing_demand_report"]
  return memClient(tables, { refuseInsert: o.refuseNewCaps ? (tb, r) => (tb === "manager_delegations" && NEW_CAPS.includes(r.requested_capability) ? "new row violates check constraint \"manager_delegations_requested_capability_check\"" : null) : undefined })
}
function deps(over: Partial<BrokerObjectiveDeps> = {}) {
  const ledger: any[] = [], signals: any[] = []
  const mission: MissionDeps = { now: () => NOW, afford: async () => ({ allowed: true, reason: "active" }), authority: async () => 6 as any, ledger: async (c) => { ledger.push(c); return `ml-${ledger.length}` }, emit: async () => {}, signal: async (s) => { signals.push(s) } }
  const delegation: DelegationDeps = { now: () => NOW, afford: async () => ({ allowed: true, reason: "active" }), authority: async () => 6 as any, ledger: async (c) => { ledger.push(c); return `dl-${ledger.length}` }, emit: async () => {}, signal: async (s) => { signals.push(s) }, mission }
  const d: BrokerObjectiveDeps = {
    now: () => NOW, mission, delegation,
    twin: async (_s, b) => (b === A ? twinA : b === B ? twinB : null),
    scenarioFacts: async () => market,
    strategy: async () => ({ key: "seller_equity", title: "Seller Equity v1", source: "library", why: "fixture", averageCostUsd: 500, activationNeeded: true }),
    ...over,
  }
  return { d, ledger, signals }
}
const candA: TerritoryCandidate[] = [{ name: TERR_A, city: "Cedarville", state: "XX" }, { name: TERR_A2, city: null, state: "XX" }]
const candB: TerritoryCandidate[] = [{ name: TERR_B, city: "Ridgeton", state: "YY" }]

async function main() {
  console.log("A — the deterministic parser")
  {
    const i = parseBrokerObjective("Find out why listing appointments dropped last month", candA)
    check("A1 investigation: kind, metric, direction down, 30-day window", i.ok && i.objective.kind === "investigation" && i.objective.metric === "listing_appointments" && i.objective.direction === "down" && i.objective.windowDays === 30, i)
    const s = parseBrokerObjective("why seller conversion dropped last week", candA)
    check("A2 'why seller conversion dropped last week' → seller_conversion over 7 days", s.ok && s.objective.metric === "seller_conversion" && s.objective.windowDays === 7, s)
    const dir = parseBrokerObjective(`Increase seller business in ${TERR_A} but don't increase spend more than $3,000/month`, candA)
    check("A3 directive: the territory is the tenant's farm name, the cap is $3,000/month", dir.ok && dir.objective.kind === "directive" && dir.objective.territory === TERR_A && dir.objective.spendCapUsdMonthly === 3000, dir)
    const k = parseBrokerObjective("Increase seller leads around Cedarville, no more than $3k a month", candA)
    check("A4 a territory's CITY matches its farm; '$3k a month' reads 3000", k.ok && k.objective.territory === TERR_A && k.objective.spendCapUsdMonthly === 3000, k)
    const del = parseBrokerObjective("Increase listing GCI 15%", candA)
    check("A5 delegation: listing GCI + 15% → gross_commission, target 15", del.ok && del.objective.kind === "delegation" && del.objective.goalType === "gross_commission" && del.objective.targetPct === 15, del)
    const unk = parseBrokerObjective("Increase seller business in Atlantis but keep spend under $2,000/month", candA)
    check("A6 a place that is not one of the tenant's territories is REFUSED, naming the tenant's own", !unk.ok && /Atlantis/.test(unk.reason) && unk.reason.includes(TERR_A), unk)
    const amb = parseBrokerObjective(`Increase seller business in ${TERR_A} and ${TERR_A2}`, candA)
    check("A7 two territories named → refused as ambiguous", !amb.ok && /more than one/.test(amb.reason), amb)
    const junk = parseBrokerObjective("make it better", candA)
    check("A8 unrecognised text is refused with examples — never guessed", !junk.ok && junk.examples.length === 3, junk)
    check("A9 the metric table puts the specific phrase above the general one (listing appointments before listings / leads)", OBJECTIVE_METRIC_PATTERNS.findIndex((p) => p.metric === "listing_appointments") < OBJECTIVE_METRIC_PATTERNS.findIndex((p) => p.metric === "listings") && OBJECTIVE_METRIC_PATTERNS.findIndex((p) => p.metric === "seller_leads") < OBJECTIVE_METRIC_PATTERNS.findIndex((p) => p.metric === "leads"))
    check("A10 no place phrase → brokerage-wide (territory null), never a default market", (() => { const r = parseBrokerObjective("Increase seller business without spending more than $500/month", candA); return r.ok && r.objective.territory === null })())
  }

  console.log("B — investigation → evidence report through 105A delegations")
  {
    const c = world(); const { d } = deps()
    const r = await submitBrokerObjective({ brokerageId: A, text: "Find out why listing appointments dropped last month", actorUserId: USER_A }, c, d)
    check("B1 the objective routes to an investigation", r.ok && r.outcome.kind === "investigation", r.ok ? r.outcome.kind : r)
    if (r.ok && r.outcome.kind === "investigation") {
      const { report, mission } = r.outcome
      check("B2 observed: listing appointments 20 → 10 (−50%), premise confirmed", report.observed?.previous === 20 && report.observed?.current === 10 && report.observed?.deltaPct === -50 && report.premise === "confirmed", report.observed)
      check("B3 causes are ranked by score, each with numbers, a delta and a READER", report.causes.length >= 2 && report.causes.every((x, i) => x.rank === i + 1 && x.reader.length > 0 && typeof x.previous === "number" && typeof x.current === "number" && x.deltaPct !== null) && report.causes.every((x, i, a) => i === 0 || a[i - 1].score >= x.score), report.causes.map((x) => [x.key, x.score]))
      check("B4 the seller-lead fall (40 → 20) and the paid-lead fall (30 → 10) are named causes", report.causes.some((x) => x.key === "seller_leads" && x.previous === 40 && x.current === 20) && report.causes.some((x) => x.key === "ad_leads" && x.previous === 30 && x.current === 10))
      check("B5 the observed measure is not listed as its own cause", !report.causes.some((x) => x.key === "listing_appointments"))
      check("B6 six delegations, one per participating manager, every one RETURNED", report.delegations.length === INVESTIGATORS.length && report.delegations.every((x) => x.status === "RETURNED" && x.delegationId), report.delegations)
      const rows = c.tables.manager_delegations ?? []
      check("B7 each delegation: requested by the controller (cron_manager), on a capability the ASSIGNEE owns, linked to the mission, result carries its findings", rows.length === 6 && rows.every((x) => x.requesting_manager === "cron_manager" && CAPABILITY_MANAGER[x.requested_capability as keyof typeof CAPABILITY_MANAGER] === x.assigned_manager && x.mission_id === mission.id && Array.isArray(x.result?.findings)), rows.map((x) => [x.assigned_manager, x.requested_capability, x.status]))
      const m = await getMission(A, mission.id, c as any)
      check("B8 the mission is the controller's, a brokerage_objective, COMPLETED, with the evidence_report attached", m?.owner_manager === "cron_manager" && m?.mission_type === "brokerage_objective" && m?.state === "COMPLETED" && (m?.evidence ?? []).some((e: any) => e.kind === "evidence_report" && e.report?.headline === report.headline), m?.state)
      check("B9 the headline is deterministic and names the move and the top causes", /listing appointments: 20 → 10/.test(report.headline) && /Likely causes/.test(report.headline), report.headline)
      check("B10 blind spots are published beside the numbers (capacity is present-state)", report.blindSpots.some((b) => /PRESENT state/.test(b)))
      // WAVE 137 owner ruling: "listing appointments per seller lead" → per seller CONTACT (reader string too).
      const lc = rows.find((x) => x.assigned_manager === "listing_concierge")?.result?.findings as EvidenceFinding[] | undefined
      const ar = lc?.find((x) => x.key === "appointment_rate")
      check("B11 the listing-appointment rate is per seller CONTACT: 20/25 = 0.8 → 10/25 = 0.4 (tenant A's seller | both contacts; buyers and tenant B excluded)", !!ar && ar.previous === 0.8 && ar.current === 0.4 && /seller contact/.test(ar.label) && /seller contacts/.test(ar.reader) && !/seller lead/.test(ar.label + ar.reader), ar)
      check("B12 POSITIVE CONTROL: the seller-LEAD ratio over the same windows would read 20/40 = 0.5 → 10/20 = 0.5 — the finding is NOT it", !!ar && !(ar.previous === 0.5 && ar.current === 0.5))

    }
    // CONTROL: the measure did not move → the readers do not confirm the premise.
    const c2 = memClient({}); seed(c2.tables, A, { apptsPrev: 10, apptsCur: 12, sellerPrev: 20, sellerCur: 20, adLeadsPrev: 10, adLeadsCur: 10 }); c2.tables.farm_territories = []
    const r2 = await submitBrokerObjective({ brokerageId: A, text: "Find out why listing appointments dropped last month", actorUserId: USER_A }, c2, deps().d)
    check("B11 (control) appointments rose 10 → 12 → premise not_observed, said in the headline", r2.ok && r2.outcome.kind === "investigation" && r2.outcome.report.premise === "not_observed" && /do NOT show/.test(r2.outcome.report.headline), r2.ok && r2.outcome.kind === "investigation" ? r2.outcome.report.headline : r2)
    // The CHECK not yet applied: the three new capabilities are refused — named, never reported as delegated.
    const c3 = world({ refuseNewCaps: true })
    const r3 = await submitBrokerObjective({ brokerageId: A, text: "why did listing appointments drop last month", actorUserId: USER_A }, c3, deps().d)
    const refused = r3.ok && r3.outcome.kind === "investigation" ? r3.outcome.report.delegations.filter((x) => x.status === "REFUSED") : []
    check("B12 a refused delegation (capability CHECK unapplied) is REFUSED in the report and a named blind spot — the other three still RETURN", refused.length === 3 && r3.ok && r3.outcome.kind === "investigation" && r3.outcome.report.delegations.filter((x) => x.status === "RETURNED").length === 3 && r3.outcome.report.blindSpots.filter((b) => /delegation refused/.test(b)).length === 3, refused)
    // PURE ranking rule
    const f = (key: string, deltaPct: number, adverse = true, lowSample = false): EvidenceFinding => ({ manager: "ai_isa", key, label: key, previous: 100, current: 100 + deltaPct, deltaPct, adverse, unit: "count", reader: "r", lowSample })
    const ranked = rankContributingCauses([f("seller_leads", -40), f("campaign_touches", -40), f("ad_spend", 50, false), f("leads", -5), f("source_mix:zillow", -60, true, true)], "listing_appointments")
    check("B13 ranking: relevance orders equal moves; a non-adverse or <10% move is not a cause; a low sample is halved", ranked[0].key === "seller_leads" && !ranked.some((x) => x.key === "ad_spend" || x.key === "leads") && ranked.find((x) => x.key === "source_mix:zillow")!.score === 21, ranked.map((x) => [x.key, x.score]))
  }

  console.log("C — directive with a constraint → a PROPOSAL, APPROVAL_REQUIRED, nothing executed")
  {
    const c = world(); const { d } = deps()
    const r = await submitBrokerObjective({ brokerageId: A, text: `Increase seller business in ${TERR_A} but don't increase spend more than $3,000/month`, actorUserId: USER_A }, c, d)
    check("C1 routes to a directive", r.ok && r.outcome.kind === "directive", r.ok ? r.outcome.kind : r)
    if (r.ok && r.outcome.kind === "directive") {
      const { proposal, mission } = r.outcome
      check("C2 the CAP is honoured: projected monthly cost ≤ $3,000 and the mission budget ≤ the cap", !!proposal.projection && proposal.projection.costCents <= 300_000 && proposal.budgetUsdMonthly <= 3000 && (mission.budget?.usd ?? Infinity) <= 3000, proposal.projection)
      check("C3 the lift is aimed at the tenant's territory (territory_activation = the farm name)", JSON.stringify(proposal.levers?.territory_activation) === JSON.stringify([TERR_A]) && (proposal.levers?.seller_lead_acquisition_pct ?? 0) > 0, proposal.levers)
      // the choice is the best margin among every swept lift that fits the cap without saturating
      let bestMargin = -Infinity
      for (let p = SATURATION_SWEEP_STEP; p <= SATURATION_SWEEP_MAX; p += SATURATION_SWEEP_STEP) {
        const pr = simulateScenario({ brokerageId: A, levers: { seller_lead_acquisition_pct: p, territory_activation: [TERR_A] } }, twinA, market)
        if (pr.marketingCost.totalCents > 300_000 || pr.staffingConstraint.saturatedNow.length) break
        bestMargin = Math.max(bestMargin, pr.expectedMarginCents)
      }
      check("C4 the proposed lift has the best projected margin of every lift that fits the cap", proposal.projection?.marginCents === bestMargin, { got: proposal.projection?.marginCents, best: bestMargin })
      check("C5 a recommended strategy rides the proposal (activation is its own approval)", proposal.strategy?.key === "seller_equity" && proposal.strategy.activationNeeded === true)
      const m = await getMission(A, mission.id, c as any)
      check("C6 the mission waits in APPROVAL_REQUIRED with the proposal as evidence", m?.state === "APPROVAL_REQUIRED" && (m?.evidence ?? []).some((e: any) => e.kind === "objective_proposal"), m?.state)
      const touched = new Set(c.writes.map((w) => w.table))
      check("C7 NOTHING executes: no delegation, no strategy activation, no campaign / ad / send row, no action on the mission", !(c.tables.manager_delegations?.length) && ![...touched].some((tb) => /strategy_activations|ad_campaigns|marketing_campaigns|sequence_enrollments|email_queue|sms/.test(tb)) && (m?.actions ?? []).length === 0, [...touched])
      const approved = await transitionMission({ brokerageId: A, missionId: mission.id, to: "ACTIVE", reason: "approved by the broker", actor: { type: "user", id: USER_A } }, c as any, d.mission)
      check("C8 a HUMAN approval is what moves it (APPROVAL_REQUIRED → ACTIVE)", approved.ok && approved.mission.state === "ACTIVE")
    }
    const tight = fitLiftToCap(twinA, market, { territories: [TERR_A], capCents: 100 })
    check("C9 (control) a $1/month cap fits no lift — null, never an over-cap proposal", tight === null)
    const loose = fitLiftToCap(twinA, market, { territories: [TERR_A], capCents: 10_000_000 })
    const mid = fitLiftToCap(twinA, market, { territories: [TERR_A], capCents: 300_000 })
    check("C10 (control) a looser cap never proposes a worse margin", !!loose && !!mid && loose.projection.expectedMarginCents >= mid.projection.expectedMarginCents)
  }

  console.log("D — objective delegation → parent + PROPOSED child missions per manager")
  {
    const c = world(); const { d } = deps()
    const r = await submitBrokerObjective({ brokerageId: A, text: "Increase listing GCI 15%", actorUserId: USER_A }, c, d)
    check("D1 routes to a delegation", r.ok && r.outcome.kind === "delegation", r.ok ? r.outcome.kind : r)
    if (r.ok && r.outcome.kind === "delegation") {
      const { mission: parent, children, plan } = r.outcome
      check("D2 parent PROPOSED, a brokerage_objective whose owner is the registry's answer for GCI (deal_coordinator via transaction_advance)", parent.state === "PROPOSED" && parent.mission_type === "brokerage_objective" && parent.owner_manager === "deal_coordinator", parent.owner_manager)
      check("D3 the parent is judged on the ABSOLUTE target of its measure (GCI 90d ≥ current × 1.15), the twin decomposition rides as evidence", JSON.stringify(parent.success_criteria) === JSON.stringify([{ metric: "economic.gciClosed90dCents", op: ">=", target: Math.ceil(twinA.economic.gciClosed90dCents * 1.15) }]) && (c.tables.missions!.find((m) => m.id === parent.id)?.evidence ?? []).some((e: any) => e.kind === "objective_delegation" && e.decomposition?.sub_targets?.length > 0), parent.success_criteria)
      check("D4 one CHILD per manager, every one PROPOSED with parent_mission = the parent", children.length === plan.children.length && children.length === 7 && children.every((m) => m.state === "PROPOSED" && m.parent_mission === parent.id), children.map((m) => [m.owner_manager, m.state]))
      const steps = plan.children.flatMap((x) => x.steps)
      check("D5 the owner's chain, in order: territory → marketing → ISA → capacity → recruiting → education → media → budget", JSON.stringify([...new Set(steps)]) === JSON.stringify(DELEGATION_CHAIN), steps)
      check("D6 each child carries its sub-target and its budget share; shares sum to the plan's budget (≤ 1¢ rounding per child)", children.every((m) => typeof m.budget?.usd === "number") && Math.abs(plan.children.reduce((s, x) => s + x.budgetUsd, 0) - plan.totalBudgetUsd) <= 0.07 && plan.children.every((x) => x.subTarget.length > 0), plan.children.map((x) => [x.manager, x.budgetUsd]))
      check("D7 children are owned by registry managers and the recruiting child is a recruiting mission", children.every((m) => m.owner_manager in MANAGERS) && children.find((m) => m.owner_manager === "recruiting_manager")?.mission_type === "recruiting")
      check("D8 the opportunity territories come from the tenant's twin (its farms), not from code", plan.territories.length > 0 && plan.territories.every((t) => [TERR_A, TERR_A2].includes(t)), plan.territories)
      check("D9 nothing executes: no delegation requested, children wait PROPOSED for a human", !(c.tables.manager_delegations?.length))
      check("D10 each child metric the controller judges resolves to its OWNER (slice measures registered)", ["slices.ads_manager.measures.leads30d", "slices.campaign_orchestrator.measures.converted30d", "slices.asset_manager.measures.approved30d"].every((k) => k in MEASURE_CAPABILITIES))
    }
    const pure = planObjectiveDelegation(twinA, market, { goalType: "gross_commission", targetPct: 15, capUsd: 1, territory: null })
    check("D11 (control) a cap below the first step is reported as the shortfall, never exceeded", pure.totalBudgetUsd <= 1 && /cap/.test(pure.shortfall ?? ""), pure.shortfall)
  }

  console.log("H — BREADTH objective verbs (wave 137E): buyer clients, lead conversion, contacts — only where a twin measure exists")
  {
    const bc = parseBrokerObjective("Increase buyer clients 20%", candA), lc = parseBrokerObjective("Increase lead conversion 10%", candA), ct = parseBrokerObjective("Grow our sphere contacts 15%", candA)
    check("H1 each new verb routes to an OBJECTIVE DELEGATION on its agent_goals measure (buyer_clients / conversion_rate / new_contacts)",
      bc.ok && bc.objective.kind === "delegation" && bc.objective.goalType === "buyer_clients" && lc.ok && lc.objective.goalType === "conversion_rate" && ct.ok && ct.objective.goalType === "new_contacts", JSON.stringify([bc, lc, ct]))
    check("H2 every new goal measure is one the TWIN carries (OBJECTIVE_MEASURES non-null) — no verb was added without a twin measure", ["buyer_clients", "pipeline_conversion", "contacts"].every((m) => { const g = GOAL_OF_METRIC[m as keyof typeof GOAL_OF_METRIC]; return !!g && OBJECTIVE_MEASURES[g] !== null }))
    check("H3 (control) the specific phrase still wins: 'seller conversion' stays seller_conversion, 'seller leads' stays seller_leads, the seed examples route as before", (() => { const a = parseBrokerObjective("why seller conversion dropped last week", candA), b = parseBrokerObjective("Increase listing GCI 15%", candA); return a.ok && a.objective.metric === "seller_conversion" && b.ok && b.objective.goalType === "gross_commission" })())
    const inv = parseBrokerObjective("Find out why lead conversion dropped last month", candA)
    check("H4 an investigation on the new verb reads a REAL finding (lead → contact conversion, the ai_isa check)", inv.ok && inv.objective.kind === "investigation" && OBSERVED_KEY[inv.objective.metric] === "lead_conversion_rate" && (() => {
      const w = (current: number, previous: number) => ({ current, previous })
      const f = { leads: w(40, 50), sellerLeads: w(10, 10), sellerLeadsConverted: w(4, 5), leadsConverted: w(8, 20) } as unknown as ObjectiveEvidenceFacts
      const hit = EVIDENCE_CHECKS.ai_isa.check(f).find((x) => x.key === "lead_conversion_rate")
      return !!hit && hit.current === 0.2 && hit.previous === 0.4 && hit.adverse
    })())
    const pb = planObjectiveDelegation(twinA, market, { goalType: "buyer_clients", targetPct: 20, capUsd: null, territory: null })
    check("H5 buyer representation has NO scenario lever: no sweep, no spend, one Shopping Agent child, the shortfall says why (never a seller-acquisition budget for a buyer goal)", pb.totalBudgetUsd === 0 && pb.levers === null && pb.children.length === 1 && pb.children[0].manager === "shopping_agent" && /no scenario lever/.test(pb.shortfall ?? ""), JSON.stringify({ s: pb.shortfall, c: pb.children.map((c) => c.manager) }))
    const pc = planObjectiveDelegation(twinA, market, { goalType: "conversion_rate", targetPct: 10, capUsd: null, territory: null })
    check("H6 a conversion goal is planned on the scenario's conversions (not listings) with the full manager chain", pc.children.length === 7 && (pc.projection === null || typeof pc.projection === "object") && pc.current !== null, JSON.stringify({ cur: pc.current, tgt: pc.target, s: pc.shortfall }))
  }

  console.log("E — no hard-coded location")
  {
    const STATES = ["Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia","Wisconsin","Wyoming"]
    const PLACES = [...STATES, "Gulf Coast", "Gulf Breeze", "Pensacola", "Miami", "Houston", TERR_A, TERR_A2, TERR_B]
    const literals = (code: string) => [...code.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2])
    const placesIn = (code: string) => literals(code).filter((s) => PLACES.some((p) => new RegExp(`\\b${p}\\b`, "i").test(s)))
    const hits = placesIn(src("lib/kernel/broker-objectives.ts"))
    check("E1 broker-objectives.ts carries no state, city, market or territory literal", hits.length === 0, hits)
    check("E2 (positive control) the scanner catches a planted territory literal", placesIn(`const t = "Increase seller business in Texas"`).length === 1 && placesIn(`const x = "${TERR_A}"`).length === 1)
    const crossed = parseBrokerObjective(`Increase seller business in ${TERR_A} under $3,000/month`, candB)
    check("E3 tenant A's territory is NOT a place for tenant B — refused, naming B's own", !crossed.ok && crossed.reason.includes(TERR_B) && !crossed.reason.includes(TERR_A2), crossed)
    check("E4 the territory matcher reads only the candidates it is handed", matchTerritory(`grow listings in ${TERR_B}`, candB).territory === TERR_B && matchTerritory(`grow listings in ${TERR_B}`, []).territory === null)
  }

  console.log("F — tenant isolation")
  {
    const c = world(); const { d } = deps()
    const rA = await submitBrokerObjective({ brokerageId: A, text: "Find out why listing appointments dropped last month", actorUserId: USER_A }, c, d)
    check("F1 tenant B's rows never count toward A's evidence (A: 20 → 10; B alone would read 3 → 90)", rA.ok && rA.outcome.kind === "investigation" && rA.outcome.report.observed?.current === 10 && rA.outcome.report.observed?.previous === 20)
    const writtenTenants = new Set([...(c.tables.missions ?? []), ...(c.tables.manager_delegations ?? []), ...(c.tables.mission_events ?? []), ...(c.tables.manager_delegation_events ?? [])].map((x) => x.brokerage_id))
    check("F2 every mission / delegation / event row written is tenant A's", writtenTenants.size === 1 && writtenTenants.has(A), [...writtenTenants])
    if (rA.ok) check("F3 tenant B cannot read A's mission (tenant-pinned read → null)", (await getMission(B, rA.outcome.mission.id, c as any)) === null)
    const rB = await submitBrokerObjective({ brokerageId: B, text: `Increase seller business in ${TERR_B} but don't increase spend more than $3,000/month`, actorUserId: USER_B }, c, d)
    check("F4 tenant B's objective routes on B's territory and lands on B's mission", rB.ok && rB.outcome.kind === "directive" && rB.outcome.mission.brokerage_id === B && rB.outcome.proposal.territory === TERR_B, rB.ok ? rB.outcome.kind : rB)
    const rX = await submitBrokerObjective({ brokerageId: B, text: `Increase seller business in ${TERR_A} but don't increase spend more than $3,000/month`, actorUserId: USER_B }, c, d)
    check("F5 tenant B naming A's territory is refused (no mission written)", !rX.ok && (c.tables.missions ?? []).filter((m) => m.brokerage_id === B).length === 1)
    const refusedTerr = memClient({}); const realFrom = refusedTerr.from.bind(refusedTerr)
    ;(refusedTerr as any).from = (tb: string) => (tb === "farm_territories" ? { select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: null, error: { message: "permission denied" } }) }) }) } : realFrom(tb))
    const rR = await submitBrokerObjective({ brokerageId: A, text: "Increase listing GCI 15%", actorUserId: USER_A }, refusedTerr, d)
    check("F6 a refused territory read refuses the objective (fail closed), never routes as 'no territories'", !rR.ok && /could not be read/.test(rR.reason) && !(refusedTerr.tables.missions?.length), rR)
  }

  console.log("G — wiring, capabilities, CHECK, registry")
  {
    const action = src("app/actions/missions.ts")
    check("G1 the session door exists, gates first (requireCallerTenant via gate) and on the admin roster, and calls the kernel", /export async function submitBrokerObjectiveAction\(/.test(action) && /submitBrokerObjectiveAction[\s\S]{0,400}await gate\(\)[\s\S]{0,200}g\.admin/.test(action) && /submitBrokerObjective\(\{ brokerageId: g\.brokerageId/.test(action))
    const card = src("app/dashboard/admin/command-center/missions-card.tsx")
    check("G2 the Missions card has the objective input and calls the door", card.includes("submitBrokerObjectiveAction(") && /Give objective/.test(card))
    const NEW = ["campaign_performance_report", "ads_performance_report", "listing_demand_report"] as const
    check("G3 the three evidence capabilities are read-only catalogue keys owned by their manager", NEW.every((k) => k in APP_CAPABILITY_REGISTRY && APP_CAPABILITY_REGISTRY[k].mutates === false) && CAPABILITY_MANAGER.campaign_performance_report === "campaign_orchestrator" && CAPABILITY_MANAGER.ads_performance_report === "ads_manager" && CAPABILITY_MANAGER.listing_demand_report === "listing_concierge")
    check("G4 every investigator's capability is one it owns", INVESTIGATORS.every((m) => CAPABILITY_MANAGER[EVIDENCE_CHECKS[m].capability] === m))
    check("G5 the evidence capabilities are withheld from voice (manager-to-manager only)", NEW.every((k) => (VOICE_WITHHELD as readonly string[]).includes(k)))
    const re = /manager_delegations_requested_capability_check\s*CHECK\s*\(requested_capability IN \(([^)]*)\)/
    const latest = readdirSync("supabase/migrations").filter((f) => /^m\d+.*\.sql$/.test(f)).map((f) => ({ f, n: Number(/^m(\d+)/.exec(f)![1]), body: stripComments(readFileSync(`supabase/migrations/${f}`, "utf8")) })).filter((x) => re.test(x.body)).sort((a, b) => b.n - a.n)[0]
    const caps = latest ? [...re.exec(latest.body)![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort() : []
    check("G6 the LATEST defining migration's capability CHECK equals the catalogue (superset holds the three)", caps.join(",") === Object.keys(APP_CAPABILITY_REGISTRY).sort().join(","), latest?.f)
    const head = latest ? readFileSync(`supabase/migrations/${latest.f}`, "utf8").split("\n")[0] : ""
    check("G7 the migration states whether it is applied (the lane stamp | APPLIED LIVE <date>)", /WRITTEN, NOT APPLIED|APPLIED LIVE \d{4}-\d{2}-\d{2}/.test(head), head)
    const dom = (MAINTENANCE_DOMAINS as Record<string, { manager: string; proof: string; coOwners?: string[] }>).broker_objectives
    check("G8 MAINTENANCE_DOMAINS.broker_objectives names this proof with an owner and co-owners", dom?.proof === "test:broker-objectives" && dom.manager in MANAGERS && (dom.coOwners ?? []).length > 0)
    const pkg = readFileSync("package.json", "utf8")
    check("G9 registered as test:broker-objectives and a MEMBER of the guard chain", /"test:broker-objectives":\s*"tsx scripts\/broker-objectives-guard\.ts"/.test(pkg) && new RegExp("npm run test:broker-objectives(\\s|&|\")").test(JSON.parse(pkg).scripts.guard ?? ""))
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail) { console.log(`FAILED: ${fails.join(" | ")}`); process.exit(1) }
}
main().catch((e) => { console.error(e); process.exit(1) })
