#!/usr/bin/env tsx
/**
 * scripts/brokerage-twin-guard.ts   (npm run test:brokerage-twin) — in-memory client, no network, no DB.
 *
 * WAVE 104 (lane 104B) — THE BROKERAGE DIGITAL TWIN. Owner: "Brokerage Digital Twin (derived
 * operating representation: now / changed / at risk / capacity / objectives / economic state /
 * evidence; scenario foundation, no unsupported predictions)". OWNER LAWS bind.
 *
 *   A  the twin builds through the loader + composer with an EVIDENCE REF on every conclusion
 *   B  change detection — against a prior snapshot, and the honest BASELINE when the table refuses
 *   C  the risk list reads the predictors' OUTPUT tables (never predicts)
 *   D  scenario recompute (capacity through the capacityFor math; pipeline value; AI cost) + the
 *      "unsupported" controls (unknown delta, missing forecast)
 *   E  tenant isolation — a foreign tenant's rows are never counted; every read carries brokerage_id;
 *      a team scope narrows through agents.team_id; the snapshot insert is tenant-stamped
 *   F  objective decomposition — measurable sub-targets name twin fields; honest "unsupported"
 *   G  seams degrade (missions "none", contribution margin "unavailable") and register
 *   H  wiring (stripped source) — Command Center builds the twin once and hands it to the exec plan;
 *      the exec plan reads inputs.twin; the stand-up reads twinCapacityForAgent; with a positive
 *      control that a tombstone mentioning the builder is NOT read as a call site
 *   I  registration + ownership (package.json, guard chain, MAINTENANCE_DOMAINS, TABLE_MANAGER, m708)
 *
 * Owner: data_steward (the derived representation and its snapshot chain). Co-owners named in prose:
 * deal_coordinator (the deal / listing / stall risk slice), recruiting_manager (capacity + the churn
 * radar), finance_manager (closed GCI, the forecaster, the AI cost ledger, the 104A seam).
 */
import { readFileSync } from "node:fs"
import { stripComments, blankStrings } from "./strip-comments"
import {
  composeBrokerageTwin, loadBrokerageTwinFacts, buildBrokerageTwin, scenario, decomposeObjective,
  detectTwinChanges, twinMeasures, twinDigest, registerTwinSeam, twinSeams, twinCapacityForAgent,
  TWIN_SNAPSHOT_TABLE, SCENARIO_DELTA_KEYS, OBJECTIVE_MEASURES,
  type BrokerageTwin, type TwinFacts,
} from "../lib/kernel/brokerage-twin"
import { AGENT_GOAL_TYPES } from "../lib/goals/goal-types"
import { MAINTENANCE_DOMAINS, TABLE_MANAGER, MANAGERS } from "../lib/kernel/manager-registry"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => stripComments(readFileSync(p, "utf8"))
const code = (p: string) => blankStrings(src(p))

// ─── In-memory supabase-shaped client ──────────────────────────────────────────────────────────
type Row = Record<string, any>
type Filter = (r: Row) => boolean
const NOW = new Date("2026-10-05T12:00:00.000Z")
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString()

function makeClient(tables: Record<string, Row[]>, opts: { refuse?: Set<string>; refuseInsert?: Set<string> } = {}) {
  const log: Array<{ table: string; op: string; filters: string[] }> = []
  const inserted: Record<string, Row[]> = {}
  function from(table: string) {
    const filters: Filter[] = []
    const names: string[] = []
    let op = "select", head = false, limitN = Infinity, order: { col: string; asc: boolean } | null = null, single = false
    let payload: Row | Row[] | null = null
    const b: any = {
      select(_cols?: string, o?: { count?: string; head?: boolean }) { if (o?.head) head = true; return b },
      insert(p: Row | Row[]) { op = "insert"; payload = p; return b },
      eq(c: string, v: any) { names.push(`eq:${c}`); filters.push((r) => r[c] === v); return b },
      neq(c: string, v: any) { names.push(`neq:${c}`); filters.push((r) => r[c] !== v); return b },
      is(c: string, v: any) { names.push(`is:${c}`); filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b },
      in(c: string, vs: any[]) { names.push(`in:${c}`); filters.push((r) => vs.includes(r[c])); return b },
      not(c: string, opn: string, v: string) {
        names.push(`not:${c}`)
        if (opn === "in") { const vs = v.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "")); filters.push((r) => !vs.includes(r[c])) }
        else if (opn === "is") filters.push((r) => r[c] != null)
        return b
      },
      gte(c: string, v: any) { names.push(`gte:${c}`); filters.push((r) => r[c] != null && r[c] >= v); return b },
      lt(c: string, v: any) { names.push(`lt:${c}`); filters.push((r) => r[c] != null && r[c] < v); return b },
      lte(c: string, v: any) { names.push(`lte:${c}`); filters.push((r) => r[c] != null && r[c] <= v); return b },
      order(c: string, o?: { ascending?: boolean }) { order = { col: c, asc: o?.ascending !== false }; return b },
      limit(n: number) { limitN = n; return b },
      maybeSingle() { single = true; return b },
      then(resolve: (v: any) => void) {
        log.push({ table, op, filters: names })
        if (op === "insert") {
          if (opts.refuseInsert?.has(table)) return resolve({ data: null, error: { message: `relation "${table}" does not exist` } })
          const rowsIn = (Array.isArray(payload) ? payload : [payload!]).map((r, i) => ({ id: `${table}-ins-${i}`, ...r }))
          ;(inserted[table] ??= []).push(...rowsIn); (tables[table] ??= []).push(...rowsIn)
          return resolve({ data: single ? rowsIn[0] : rowsIn, error: null })
        }
        if (opts.refuse?.has(table)) return resolve({ data: null, error: { message: `relation "${table}" does not exist` }, count: null })
        let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
        if (order) rows = [...rows].sort((a, c) => (a[order!.col] < c[order!.col] ? -1 : a[order!.col] > c[order!.col] ? 1 : 0) * (order!.asc ? 1 : -1))
        const count = rows.length
        rows = rows.slice(0, limitN)
        return resolve({ data: head ? null : single ? (rows[0] ?? null) : rows, error: null, count })
      },
    }
    return b
  }
  return { from, log, inserted }
}

const A = "aaaaaaaa-0000-0000-0000-000000000001", B = "bbbbbbbb-0000-0000-0000-000000000002", TEAM = "tttttttt-0000-0000-0000-000000000001"
const tenant = (brokerage: string, tag: string) => ({
  agents: [
    { id: `${tag}-ag1`, brokerage_id: brokerage, is_active: true, team_id: TEAM },
    { id: `${tag}-ag2`, brokerage_id: brokerage, is_active: true, team_id: null },
    { id: `${tag}-ag3`, brokerage_id: brokerage, is_active: false, team_id: null },
  ],
  leads: [
    { id: `${tag}-l1`, brokerage_id: brokerage, is_active: true, lifecycle_state: "isa_qualifying", agent_id: null, converted_at: null },
    { id: `${tag}-l2`, brokerage_id: brokerage, is_active: true, lifecycle_state: "representation", agent_id: `${tag}-ag1`, converted_at: null },
    { id: `${tag}-l3`, brokerage_id: brokerage, is_active: false, lifecycle_state: "assigned", agent_id: `${tag}-ag2`, converted_at: iso(10) },
  ],
  contacts: [{ id: `${tag}-c1`, brokerage_id: brokerage, deleted_at: null, agent_id: `${tag}-ag1` }, { id: `${tag}-c2`, brokerage_id: brokerage, deleted_at: iso(1), agent_id: `${tag}-ag1` }],
  listings: [
    { id: `${tag}-ls1`, brokerage_id: brokerage, deleted_at: null, status: "active", agent_id: `${tag}-ag1` },
    { id: `${tag}-ls2`, brokerage_id: brokerage, deleted_at: null, status: "coming_soon", agent_id: `${tag}-ag2` },
    { id: `${tag}-ls3`, brokerage_id: brokerage, deleted_at: null, status: "sold", agent_id: `${tag}-ag2` },
  ],
  transactions: [
    { id: `${tag}-tx1`, brokerage_id: brokerage, deleted_at: null, status: "under_contract", estimated_commission: 9000, agent_id: `${tag}-ag1`, commission_amount: null, close_date: null },
    { id: `${tag}-tx2`, brokerage_id: brokerage, deleted_at: null, status: "active", estimated_commission: 4000, agent_id: `${tag}-ag2`, commission_amount: null, close_date: null },
    { id: `${tag}-tx3`, brokerage_id: brokerage, deleted_at: null, status: "closed", estimated_commission: 8000, agent_id: `${tag}-ag2`, commission_amount: 8000, close_date: iso(20).slice(0, 10) },
    { id: `${tag}-tx4`, brokerage_id: brokerage, deleted_at: null, status: "closed", estimated_commission: 6000, agent_id: `${tag}-ag1`, commission_amount: 6000, close_date: iso(200).slice(0, 10) },
  ],
  deal_health_scores: [
    { brokerage_id: brokerage, transaction_id: `${tag}-tx1`, risk_level: "watch", scored_at: iso(3) },
    { brokerage_id: brokerage, transaction_id: `${tag}-tx1`, risk_level: "critical", scored_at: iso(1) },
    { brokerage_id: brokerage, transaction_id: `${tag}-tx3`, risk_level: "critical", scored_at: iso(1) },
  ],
  listing_health_scores: [{ brokerage_id: brokerage, listing_id: `${tag}-ls1`, risk_level: "at_risk", scored_at: iso(1) }, { brokerage_id: brokerage, listing_id: `${tag}-ls3`, risk_level: "critical", scored_at: iso(1) }],
  manager_signals: [{ id: `${tag}-sig1`, brokerage_id: brokerage, signal_type: "listing_stall_predicted", entity_id: `${tag}-ls1`, consumed_at: null, created_at: iso(2) }, { id: `${tag}-sig2`, brokerage_id: brokerage, signal_type: "buyer_stall_predicted", entity_id: null, consumed_at: iso(1), created_at: iso(2) }],
  buyer_fatigue_scores: [{ brokerage_id: brokerage, contact_id: `${tag}-c1`, risk_level: "high" }, { brokerage_id: brokerage, contact_id: `${tag}-c2`, risk_level: "fresh" }],
  agent_retention_scores: [{ brokerage_id: brokerage, agent_id: `${tag}-ag2`, tier: "at_risk", score_date: iso(1).slice(0, 10) }, { brokerage_id: brokerage, agent_id: `${tag}-ag2`, tier: "healthy", score_date: iso(5).slice(0, 10) }],
  compliance_flags: [{ id: `${tag}-cf1`, brokerage_id: brokerage, status: "flagged", severity: "medium" }, { id: `${tag}-cf2`, brokerage_id: brokerage, status: "resolved", severity: "high" }],
  agent_goals: [{ id: `${tag}-g1`, brokerage_id: brokerage, agent_id: `${tag}-ag1`, goal_type: "gross_commission", target_value: 50000, current_value: 14000, year: 2026 }],
  strategy_recommendations: [{ id: `${tag}-sr1`, brokerage_id: brokerage, status: "pending" }, { id: `${tag}-sr2`, brokerage_id: brokerage, status: "accepted" }],
  income_forecast_snapshots: [{ brokerage_id: brokerage, agent_id: `${tag}-ag1`, weighted_90: 12000, computed_at: iso(1) }, { brokerage_id: brokerage, agent_id: `${tag}-ag1`, weighted_90: 99999, computed_at: iso(9) }],
  ai_tool_usage: [{ brokerage_id: brokerage, cost_cents: 250, created_at: iso(2) }, { brokerage_id: brokerage, cost_cents: 900, created_at: iso(60) }],
})
function world(extra: Record<string, Row[]> = {}) {
  const a = tenant(A, "a"), b = tenant(B, "b")
  const tables: Record<string, Row[]> = {}
  for (const k of Object.keys(a)) tables[k] = [...(a as any)[k], ...(b as any)[k]]
  for (const [k, v] of Object.entries(extra)) tables[k] = [...(tables[k] ?? []), ...v]
  return tables
}
const fakeCapacity = async (_svc: any, _b: string, agentId: string, o: { maxLoad: number }) => ({
  band: (agentId.endsWith("ag2") ? "over" : "available") as any, load: agentId.endsWith("ag2") ? o.maxLoad : 5,
  headroom: agentId.endsWith("ag2") ? 0 : 20, reasons: [] as string[], index: { followUpDebt: 0 },
})
// 106E: the competency reader is injected like capacityFor — the real loadAgentCompetency keys its
// reads on the roster's agent id (covered by test:competency); E1's brokerage_id census is the twin's own reads.
const fakeCompetency = async () => ({ gaps: [] as unknown[], refusedRails: [] as string[] })

// ─── A. build with evidence ───────────────────────────────────────────────────────────────────
console.log("\nA. the twin builds — evidence on every conclusion")
let twinA!: BrokerageTwin
{
  const c = makeClient(world())
  const r = await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency })
  twinA = r.twin
  check("A1 now: leads / contacts / listings / open deals read as written", twinA.now.pipeline.leads === 2 && twinA.now.pipeline.converted90d === 1 && twinA.now.contacts.active === 1 && twinA.now.listings.active === 1 && twinA.now.transactions.open === 2 && twinA.now.transactions.inEscrow === 1 && twinA.now.transactions.openCommissionCents === 1_300_000, JSON.stringify(twinA.now))
  const evid = [twinA.now.pipeline.evidence, twinA.now.contacts.evidence, twinA.now.listings.evidence, twinA.now.transactions.evidence, twinA.capacity.evidence, ...twinA.objectives.evidence, ...twinA.economic.evidence, ...twinA.atRisk.map((x) => x.evidence)]
  check("A2 every conclusion carries an evidence ref (table + filter + via)", evid.length >= 12 && evid.every((e) => e.table && e.filter && e.via), `${evid.length} refs`)
  check("A3 every tenant-pinned evidence filter names brokerage_id", evid.filter((e) => !e.table.startsWith("(")).every((e) => e.filter.includes(`brokerage_id=${A}`)))
  check("A4 capacity: capacityFor per ACTIVE agent, bands summed, headroom summed, ceiling from the roster", twinA.capacity.activeAgents === 2 && twinA.capacity.bands.over === 1 && twinA.capacity.bands.available === 1 && twinA.capacity.headroom === 20 && twinA.capacity.maxLoad === 75 && twinA.capacity.perAgent.length === 2, JSON.stringify(twinA.capacity.bands))
  check("A5 objectives: agent_goals with progress + pending strategy recommendations", twinA.objectives.goals.length === 1 && twinA.objectives.goals[0].progressPct === 28 && twinA.objectives.strategyPending === 1)
  check("A6 economic: closed GCI 90d, latest forecast per agent, AI cost 30d", twinA.economic.gciClosed90dCents === 800_000 && twinA.economic.closedCount90d === 1 && twinA.economic.projectedWeighted90Cents === 1_200_000 && twinA.economic.aiCost30dCents === 250, JSON.stringify(twinA.economic))
  check("A7 the snapshot persisted with the tenant stamp and the digest", r.persist.attempted && !!r.persist.snapshotId && c.inserted[TWIN_SNAPSHOT_TABLE]?.[0]?.brokerage_id === A && c.inserted[TWIN_SNAPSHOT_TABLE][0].digest === twinA.digest)
  check("A8 digest is stable for equal measures and moves when a measure moves", twinDigest(twinMeasures(twinA)) === twinA.digest && twinDigest({ ...twinMeasures(twinA), "now.pipeline.leads": 3 }) !== twinA.digest)
}

// ─── B. change detection ──────────────────────────────────────────────────────────────────────
console.log("\nB. what changed — prior snapshot vs honest baseline")
{
  const prior = { ...twinA, now: { ...twinA.now, pipeline: { ...twinA.now.pipeline, leads: 5 } }, atRisk: twinA.atRisk.filter((r) => r.kind !== "compliance") }
  const c = makeClient(world({ [TWIN_SNAPSHOT_TABLE]: [
    { id: "snap-old", brokerage_id: A, team_id: null, at: iso(2), twin: prior },
    { id: "snap-b", brokerage_id: B, team_id: null, at: iso(1), twin: { ...prior, now: { ...prior.now, pipeline: { ...prior.now.pipeline, leads: 77 } } } },
  ] }))
  const { twin } = await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false })
  const leads = twin.changed.changes.find((x) => x.field === "now.pipeline.leads")
  const appeared = twin.changed.changes.find((x) => x.field === "atRisk.compliance.at_risk")
  check("B1 diffs against THIS tenant's latest prior snapshot (not the foreign one)", !twin.changed.baseline && twin.changed.previousSnapshotId === "snap-old" && leads?.previous === 5 && leads.current === 2 && leads.delta === -3, JSON.stringify(twin.changed))
  check("B2 a risk that APPEARED is a change against 0", appeared?.previous === 0 && appeared.current === 1)
  check("B3 the new snapshot chains previous_snapshot_id", (await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency })).twin.changed.previousSnapshotId === "snap-old" && c.inserted[TWIN_SNAPSHOT_TABLE][0].previous_snapshot_id === "snap-old")
  const refused = makeClient(world(), { refuse: new Set([TWIN_SNAPSHOT_TABLE]), refuseInsert: new Set([TWIN_SNAPSHOT_TABLE]) })
  const r2 = await buildBrokerageTwin(A, NOW, { svc: refused as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency })
  check("B4 an unapplied m708 → BASELINE with the refusal named, the insert error read, the twin still built", r2.twin.changed.baseline && /refused/.test(r2.twin.changed.reason ?? "") && r2.twin.blindSpots.some((s) => s.includes(TWIN_SNAPSHOT_TABLE)) && /does not exist/.test(r2.persist.error ?? "") && r2.twin.now.pipeline.leads === 2)
  check("B5 pure detectTwinChanges: equal → none; a cleared measure → change to 0", detectTwinChanges({ a: 1 }, { a: 1 }).length === 0 && detectTwinChanges({ a: 1 }, {})[0]?.current === 0)
}

// ─── C. the risk list reads predictor outputs ─────────────────────────────────────────────────
console.log("\nC. at risk — the predictors' outputs, never a prediction")
{
  const k = (kind: string, sev?: string) => twinA.atRisk.find((r) => r.kind === kind && (!sev || r.severity === sev))
  check("C1 deal health: LATEST score per OPEN transaction (tx1 critical, not its older watch; closed tx3 excluded), exposure = open commission", k("deal_health", "critical")?.count === 1 && k("deal_health", "critical")!.exposureCents === 900_000 && !k("deal_health", "watch") && k("deal_health", "critical")!.evidence.via.includes("health-scorer"))
  check("C2 listing health: only ACTIVE listings (sold ls3's critical excluded)", k("listing_health", "at_risk")?.count === 1 && !k("listing_health", "critical"))
  check("C3 stall: unconsumed *_stall_predicted signals only (consumed one excluded), via the predictor runners", k("stall")?.count === 1 && /stall-predictor-runner/.test(k("stall")!.evidence.via))
  check("C4 fatigue high/critical, compliance flagged/reviewed (resolved excluded), retention latest tier at_risk", k("fatigue")?.count === 1 && k("compliance")?.count === 1 && k("retention")?.count === 1 && k("retention")!.severity === "at_risk")
  const twinSrc = code("lib/kernel/brokerage-twin.ts")
  check("C5 (control) the twin module imports NO predictor — it reads output tables (deal_health_scores / listing_health_scores / manager_signals)", !/predictListingStall|predictBuyerStall|calculateDealHealth|calculateListingHealth|calculateFatigue/.test(twinSrc) && /deal_health_scores/.test(src("lib/kernel/brokerage-twin.ts")))
}

// ─── D. scenario foundation ───────────────────────────────────────────────────────────────────
console.log("\nD. scenario — derived fields recomputed, unsupported stays unsupported")
{
  const more = scenario(twinA, { activeAgentsDelta: 2 })
  const cap = more.outputs.find((o) => o.field === "capacity")
  check("D1 +2 agents: capacity recomputed through the capacityFor math (ceiling, headroom up, inputs + predictor named)", cap?.status === "ok" && (cap.value as any).activeAgents === 4 && (cap.value as any).headroom > twinA.capacity.headroom && cap.inputs.includes("deltas.activeAgentsDelta") && /computeCapacity/.test(cap.predictor), JSON.stringify(cap))
  const fewer = scenario(twinA, { activeAgentsDelta: -1 })
  check("D2 −1 agent: the least-loaded leaves, its load redistributes (fewer agents, no fabricated headroom)", (fewer.outputs[0].value as any).activeAgents === 1 && (fewer.outputs[0].value as any).headroom <= twinA.capacity.headroom)
  const load = scenario(twinA, { loadPerAgentPct: 2000 })
  check("D3 +2000% load per agent (5 → 105 against a 75 ceiling): every agent lands over (the band math, not a guess)", (load.outputs[0].value as any).over === 2 && (load.outputs[0].value as any).available === 0, JSON.stringify(load.outputs[0].value))
  const pipe = scenario(twinA, { pipelineValuePct: 10, aiVolumePct: -50 })
  check("D4 pipeline value scales the forecaster's output; AI cost scales the meter — each names its predictor", pipe.outputs.find((o) => o.field === "economic.projectedWeighted90Cents")?.value === 1_320_000 && /forecaster/.test(pipe.outputs[0].predictor) && pipe.outputs.find((o) => o.field === "economic.aiCost30dCents")?.value === 125 && /ai_tool_usage/.test(pipe.outputs[1].predictor))
  const unk = scenario(twinA, { marketAppreciationPct: 5 } as any)
  check("D5 (control) an unknown delta → 'unsupported', never a number", unk.unsupported.includes("marketAppreciationPct") && unk.outputs[0].status === "unsupported" && unk.outputs[0].value === null)
  const noForecast = scenario({ ...twinA, economic: { ...twinA.economic, projectedWeighted90Cents: null } }, { pipelineValuePct: 10 })
  check("D6 (control) no forecast snapshot → pipeline value 'unsupported' with the reason", noForecast.outputs[0].status === "unsupported" && /no income forecast/.test(noForecast.outputs[0].reason ?? ""))
  check("D7 (control) removing every agent → capacity 'unsupported'", scenario(twinA, { activeAgentsDelta: -2 }).outputs[0].status === "unsupported")
  check("D8 the supported delta vocabulary is published", SCENARIO_DELTA_KEYS.length === 4)
}

// ─── E. tenant isolation ──────────────────────────────────────────────────────────────────────
console.log("\nE. tenant isolation")
{
  const c = makeClient(world())
  await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false })
  const reads = c.log.filter((l) => l.op === "select")
  check("E1 every read is pinned to brokerage_id", reads.length >= 15 && reads.every((l) => l.filters.includes("eq:brokerage_id")), reads.filter((l) => !l.filters.includes("eq:brokerage_id")).map((l) => l.table).join(","))
  check("E2 tenant B's rows never reach A's twin (B has the same shape — the counts are A's alone)", twinA.now.pipeline.evidence.ids!.every((id) => id.startsWith("a-")) && twinA.capacity.perAgent.every((a) => a.agentId.startsWith("a-")) && twinA.atRisk.every((r) => (r.evidence.ids ?? []).every((id) => id.startsWith("a-"))))
  const team = (await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false, teamId: TEAM })).twin
  check("E3 a team scope narrows through agents.team_id — the team sees only its board (1 agent, its lead / listing / deal)", team.teamId === TEAM && team.capacity.activeAgents === 1 && team.now.pipeline.leads === 1 && team.now.listings.active === 1 && team.now.transactions.open === 1 && team.now.transactions.openCommissionCents === 900_000, JSON.stringify(team.now))
  const r = await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, teamId: TEAM })
  check("E4 a team twin's snapshot is stamped with brokerage_id AND team_id", c.inserted[TWIN_SNAPSHOT_TABLE][0].brokerage_id === A && c.inserted[TWIN_SNAPSHOT_TABLE][0].team_id === TEAM && !!r.persist.snapshotId)
  let threw = false
  try { await buildBrokerageTwin("", NOW, { svc: c as any }) } catch { threw = true }
  check("E5 (fail closed) no brokerage id → refused, never every tenant", threw)
  check("E6 (control) the scan recognises an unpinned read", makeClient(world()).log.length === 0 && (() => { const c2 = makeClient(world()); const q: any = c2.from("leads").select("id"); return q.then(() => {}), c2.log[0]?.filters.includes("eq:brokerage_id") === false })())
}

// ─── F. objective decomposition ───────────────────────────────────────────────────────────────
console.log("\nF. objective decomposition")
{
  const d = decomposeObjective({ goalType: "gross_commission", targetValue: 5_000_000, currentValue: 1_400_000 }, twinA)
  const closings = d.subTargets.find((s) => s.key === "closings_needed")
  check("F1 gross_commission → closings needed from the twin's own average close (3.6M¢ ÷ 800k¢ = 4.5 → 5), measured by economic.closedCount90d", d.status === "ok" && d.remaining === 3_600_000 && closings?.target === 5 && closings.measuredBy === "economic.closedCount90d" && closings.status === "ok", JSON.stringify(d))
  check("F2 every sub-target names the twin field that measures it", d.subTargets.every((s) => s.measuredBy !== null && s.measuredBy.includes(".")))
  const noClose = decomposeObjective({ goalType: "gross_commission", targetValue: 100 }, { ...twinA, economic: { ...twinA.economic, closedCount90d: 0, gciClosed90dCents: 0 } })
  check("F3 (control) no closes to average → closings_needed 'unsupported' with a reason, never a number", noClose.subTargets.find((s) => s.key === "closings_needed")?.status === "unsupported" && noClose.subTargets.find((s) => s.key === "closings_needed")?.target === null)
  check("F4 avg_days_to_close / referrals / reviews → honestly unsupported (no twin measure)", decomposeObjective({ goalType: "avg_days_to_close", targetValue: 30 }, twinA).status === "unsupported" && decomposeObjective({ goalType: "referrals_generated", targetValue: 3 }).status === "unsupported")
  check("F5 an unknown goal type → unsupported naming the vocabulary", decomposeObjective({ goalType: "moonshots", targetValue: 1 }).reason?.includes("AGENT_GOAL_TYPES") === true)
  check("F6 OBJECTIVE_MEASURES covers the whole agent_goals vocabulary (one entry per type)", AGENT_GOAL_TYPES.every((t) => t in OBJECTIVE_MEASURES) && Object.keys(OBJECTIVE_MEASURES).length === AGENT_GOAL_TYPES.length)
  const conv = decomposeObjective({ goalType: "conversion_rate", targetValue: 50 }, twinA)
  check("F7 conversion_rate → conversions needed on the current lead base (50% of 2 = 1)", conv.subTargets.find((s) => s.key === "conversions_needed")?.target === 1)
}

// ─── G. seams ─────────────────────────────────────────────────────────────────────────────────
console.log("\nG. seams — 104A economic graph, 104D missions")
{
  check("G1 unregistered seams degrade: missions 'none', contribution margin 'unavailable' (named)", twinA.objectives.missions.status === "none" && twinA.objectives.missions.active === 0 && twinA.economic.contributionMargin.status === "unavailable" && /economic-graph/.test(twinA.economic.contributionMargin.source))
  const c = makeClient(world())
  const { twin } = await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false, seams: {
    missions: async () => ({ active: 3, source: "missions (104D)" }),
    contributionMargin: async () => ({ cents: 123_456, source: "lib/kernel/economic-graph.ts (104A)" }),
  } })
  check("G2 registered seams are read and cited as evidence", twin.objectives.missions.status === "present" && twin.objectives.missions.active === 3 && twin.economic.contributionMargin.cents === 123_456 && twin.objectives.evidence.some((e) => e.table === "missions (104D)"))
  const t2 = (await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false, seams: { missions: async () => { throw new Error("boom") } } })).twin
  check("G3 a seam that throws degrades to 'none' and is named in blindSpots", t2.objectives.missions.status === "none" && t2.blindSpots.some((s) => /missions seam threw: boom/.test(s)))
  registerTwinSeam("missions", async () => ({ active: 1, source: "registry" }))
  check("G4 registerTwinSeam lands in the registry", typeof twinSeams().missions === "function")
  check("G5 twinCapacityForAgent: the stand-up's one read (present / absent → null)", twinCapacityForAgent(twinA, "a-ag2")?.band === "over" && twinCapacityForAgent(twinA, "nobody") === null && twinCapacityForAgent(null, "a-ag1") === null)
}

// ─── H. wiring (stripped source) ──────────────────────────────────────────────────────────────
console.log("\nH. wiring — one read, not six")
{
  const cc = code("lib/kernel/command-center.ts")
  check("H1 Command Center builds the twin ONCE (buildBrokerageTwin) and carries it on CommandCenterData", /buildBrokerageTwin\(brokerageId/.test(cc) && /brokerageTwin:\s*import\(/.test(src("lib/kernel/command-center.ts")))
  check("H2 …and hands THAT twin to the exec plan (twin: brokerageTwin)", /loadWeeklyExecPlan\(brokerageId,[\s\S]{0,600}?twin:\s*brokerageTwin/.test(cc))
  check("H3 a team scope builds the team's own twin (teamId through the scope), platform/brokerage-wide otherwise", /teamId:\s*scope\?\.kind === "team"/.test(src("lib/kernel/command-center.ts")))
  const plan = code("lib/intelligence/manager-weekly-exec-plan.ts")
  check("H4 the exec plan reads inputs.twin's risk list (deal_risk + compliance_exposure) instead of re-querying", /inputs\.twin/.test(plan) && /kind:\s*"deal_risk"/.test(src("lib/intelligence/manager-weekly-exec-plan.ts")) && /twin\.atRisk\.find/.test(plan))
  const standup = code("lib/kernel/morning-standup.ts")
  // 104F: the line comes from the twin HANDED IN, else the last persisted one (J5) — `twin` is that resolution.
  check("H5 the morning stand-up takes the agent's capacity line from the twin when handed one, else capacityFor", /twinCapacityForAgent\((opts\.)?twin, standupAgentId\)/.test(standup) && /opts\.twin \?\?/.test(standup) && /capacityFor\(supabase, brokerageId, standupAgentId/.test(standup))
  const fixture = stripComments(`// TOMBSTONE: buildBrokerageTwin(brokerageId) used to live here\nconst x = 1\n/* buildBrokerageTwin(brokerageId, at) */`)
  check("H6 (control) a tombstone naming the builder is NOT read as a call site", !/buildBrokerageTwin\(brokerageId/.test(fixture) && /const x = 1/.test(fixture))

  // ─── lane 104F: the seams REGISTER at module load; the Command Center loads both modules first ───
  check("H7 (before) the economic-graph seam is absent until its module loads (G1 proved the degrade on that absence)", twinSeams().contributionMargin === undefined)
  await import("../lib/kernel/economic-graph")
  const cm = twinSeams().contributionMargin
  check("H7 lib/kernel/economic-graph.ts registers registerTwinSeam('contributionMargin') AT MODULE LOAD", typeof cm === "function" && src("lib/kernel/economic-graph.ts").includes('registerTwinSeam("contributionMargin"'))
  check("H7 lib/kernel/missions.ts registers registerTwinSeam('missions') (source; the missions proof drives it)", src("lib/kernel/missions.ts").includes('registerTwinSeam("missions"') && src("lib/kernel/missions.ts").includes("activeMissionsFor("))
  {
    // The economic seam over an EMPTY ledger: measured, margin 0 — and over a REFUSING ledger: cents null, refusal named.
    const empty = makeClient({})
    const r0 = await cm!(empty as any, A, null)
    const refusing = makeClient({}, { refuse: new Set(["transactions", "agent_relationships", "ai_tool_usage", "vendor_usage_tracking", "agent_action_ledger", "vendor_invoices", "referral_payouts", "vendor_payouts"]) })
    const r1 = await cm!(refusing as any, A, null)
    check("H7 the economic seam answers 0¢ (measured) on an empty ledger and null (unmeasured, refusal named) on a refused one — never a fake margin", r0.cents === 0 && /economic-graph/.test(r0.source) && r1.cents === null && /unmeasured/.test(r1.source) && /refused/.test(r1.source), JSON.stringify({ r0, r1 }))
    const { twin } = await buildBrokerageTwin(A, NOW, { svc: makeClient(world()) as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false })
    // The fixture's only ledger rows are tenant-borne ai_tool_usage costs (no commission rows) → the
    // YTD margin is MINUS their sum, derived from the fixture rather than pinned.
    const fixtureCost = world().ai_tool_usage.filter((r) => r.brokerage_id === A).reduce((a, r) => a + r.cost_cents, 0)
    check("H7 with the module loaded the twin's economic.contributionMargin reads 'present' through the registered seam (no seams option passed): −Σ tenant-borne cost rows", twin.economic.contributionMargin.status === "present" && twin.economic.contributionMargin.cents === -fixtureCost && fixtureCost > 0, JSON.stringify({ cm: twin.economic.contributionMargin, blind: twin.blindSpots }))
  }
  const ccSrc = src("lib/kernel/command-center.ts")
  check("H8 the Command Center loads economic-graph + missions (lazily, settled, degrading) BEFORE buildBrokerageTwin, and feeds the built twin to syncMissionProgressFromTwin", ccSrc.indexOf("Promise.allSettled([import(") < ccSrc.indexOf("buildBrokerageTwin(brokerageId") && ccSrc.includes('import("@/lib/kernel/economic-graph")') && ccSrc.includes('import("@/lib/kernel/missions")') && ccSrc.includes("syncMissionProgressFromTwin("))
  check("H9 createMission derives a brokerage_objective's criteria through decomposeObjective (lib/kernel/missions.ts)", src("lib/kernel/missions.ts").includes("decomposeObjective(input.objectiveSpec") && src("lib/kernel/missions.ts").includes("criteriaFromDecomposition("))
}

// ─── J. lane 104F — readBrokerageTwin snapshot mode: the per-agent surfaces read the LAST PERSISTED twin ─
console.log("\nJ. the last persisted twin — morning stand-up + team-lead brief read it, never rebuild")
{
  const { readBrokerageTwin, TWIN_SNAPSHOT_MAX_AGE_HOURS } = await import("../lib/kernel/brokerage-twin")
  const teamTwin = { ...twinA, teamId: TEAM, capacity: { ...twinA.capacity, perAgent: [twinA.capacity.perAgent[0]] } }
  const c = makeClient(world({ [TWIN_SNAPSHOT_TABLE]: [
    { id: "snap-fresh", brokerage_id: A, team_id: null, at: iso(0.5), twin: twinA },
    { id: "snap-older", brokerage_id: A, team_id: null, at: iso(0.75), twin: { ...twinA, digest: "older" } },
    { id: "snap-team", brokerage_id: A, team_id: TEAM, at: iso(0.5), twin: teamTwin },
    { id: "snap-b", brokerage_id: B, team_id: null, at: iso(0.1), twin: { ...twinA, brokerageId: B } },
  ] }))
  const got = await readBrokerageTwin(A, { svc: c as any, snapshot: { now: NOW } })
  check("J1 snapshot mode returns THIS tenant's latest persisted twin (not the older one, not tenant B's) without building", got?.digest === twinA.digest && c.log.filter((l) => l.op === "select").length === 1 && c.log[0].table === TWIN_SNAPSHOT_TABLE && c.log[0].filters.includes("eq:brokerage_id"))
  const team = await readBrokerageTwin(A, { svc: c as any, teamId: TEAM, snapshot: { now: NOW } })
  check("J2 a teamId reads the team's own persisted twin (1 scored member), brokerage-wide reads the team_id IS NULL row", team?.teamId === TEAM && team.capacity.perAgent.length === 1 && got?.teamId === null)
  const stale = makeClient(world({ [TWIN_SNAPSHOT_TABLE]: [{ id: "snap-stale", brokerage_id: A, team_id: null, at: iso(TWIN_SNAPSHOT_MAX_AGE_HOURS / 24 + 1), twin: twinA }] }))
  check("J3 a snapshot older than TWIN_SNAPSHOT_MAX_AGE_HOURS → null (the surface falls back to capacityFor, never yesterday's board); a refused read → null", (await readBrokerageTwin(A, { svc: stale as any, snapshot: { now: NOW } })) === null && (await readBrokerageTwin(A, { svc: makeClient(world(), { refuse: new Set([TWIN_SNAPSHOT_TABLE]) }) as any, snapshot: { now: NOW } })) === null)
  const foreign = makeClient(world({ [TWIN_SNAPSHOT_TABLE]: [{ id: "snap-x", brokerage_id: A, team_id: null, at: iso(0.1), twin: { ...twinA, brokerageId: B } }] }))
  check("J4 (fail closed) a persisted twin stamped with another tenant inside is refused even when the row matches", (await readBrokerageTwin(A, { svc: foreign as any, snapshot: { now: NOW } })) === null && (await readBrokerageTwin("", { svc: c as any, snapshot: {} })) === null)
  const standup = code("lib/kernel/morning-standup.ts")
  check("J5 the morning stand-up reads the last persisted twin when none is handed in (readBrokerageTwin snapshot mode), then twinCapacityForAgent", /readBrokerageTwin\(brokerageId,[^)]*snapshot/.test(standup) && /twinCapacityForAgent\(twin, standupAgentId\)/.test(standup))
  const lead = code("lib/intelligence/user-type-briefs/team-lead.ts")
  check("J6 the team-lead brief reads the team's persisted twin for capacity exceptions (twinCapacityForAgent), capacityFor only for members the twin lacks", /readBrokerageTwin\(params\.brokerageId,[^)]*teamId: teamIds\[0\][^)]*snapshot/.test(lead) && /twinCapacityForAgent\(teamTwin, agentId\)/.test(lead) && /line \?\? await capacityFor\(/.test(lead))
}

// ─── K. TWIN 2.0 — manager slices (wave 107, lane 107C) ──────────────────────────────────────────
console.log("\nK. manager slices — one per MANAGERS key, owned, read through a survivor, re-homed not duplicated")
const { TWIN_SLICE_SPECS, TWIN_FLOW_STAGES, detectBottleneck } = await import("../lib/kernel/brokerage-twin")
// Slice fixture rows for BOTH tenants (A small, B large — a bleed would show as B's numbers in A's slices).
const sliceRows = (brokerage: string, tag: string, n: number): Record<string, Row[]> => ({
  // Only a CONTACT tours (wave 108): every counted tour names its contact; the extra contact-less row is the control.
  tours: [...Array.from({ length: n }, (_, i) => ({ id: `${tag}-to${i}`, brokerage_id: brokerage, agent_id: `${tag}-ag${(i % 2) + 1}`, contact_id: `${tag}-cb${i}`, created_at: iso(5) })),
    { id: `${tag}-toX`, brokerage_id: brokerage, agent_id: `${tag}-ag1`, contact_id: null, created_at: iso(5) }],
  // Wave 108 contacts: buyer ×2 + both ×1 (buyer side 3), seller ×1, lifetime_customer ×2 + sphere ×1 (lifetime 3), a
  // deleted buyer (never counted). source_family: 4 arrived DIRECT from an inbound source, 3 via a converted lead.
  contacts: [
    ...["buyer", "buyer", "both", "seller", "lifetime_customer", "lifetime_customer", "sphere"].map((t, i) => ({ id: `${tag}-ct${i}`, brokerage_id: brokerage, deleted_at: null, agent_id: `${tag}-ag${(i % 2) + 1}`, contact_type: t, source_family: i < 4 ? "contact_direct" : "lead", created_at: iso(20) })),
    { id: `${tag}-ctD`, brokerage_id: brokerage, deleted_at: iso(2), agent_id: `${tag}-ag1`, contact_type: "buyer", source_family: "contact_direct", created_at: iso(20) },
  ],
  // The owner's pipeline: scraping lands RAW rows (4), two of them promoted to leads (source_family 'raw'),
  // plus one lead from another source; inactive so the pipeline section's active-lead count is unchanged.
  raw_scraped_leads: Array.from({ length: 4 }, (_, i) => ({ id: `${tag}-rw${i}`, brokerage_id: brokerage, created_at: iso(15) })),
  leads: [
    ...[0, 1].map((i) => ({ id: `${tag}-lr${i}`, brokerage_id: brokerage, is_active: false, lifecycle_state: "assigned", agent_id: `${tag}-ag1`, converted_at: null, lead_type: "buyer", source_family: "raw", created_at: iso(12) })),
    { id: `${tag}-lw`, brokerage_id: brokerage, is_active: false, lifecycle_state: "assigned", agent_id: `${tag}-ag2`, converted_at: null, lead_type: "seller", source_family: "lead", created_at: iso(12) },
  ],
  offers: Array.from({ length: n }, (_, i) => ({ id: `${tag}-of${i}`, brokerage_id: brokerage, agent_id: `${tag}-ag2`, created_at: iso(10) })),
  marketing_assets: Array.from({ length: n }, (_, i) => ({ id: `${tag}-ma${i}`, brokerage_id: brokerage, team_id: i === 0 ? TEAM : null, approval_status: i === 0 ? "approved" : "pending", cost_usd: 2.5, created_at: iso(3), performance: i === 0 ? { ctr: 0.02 } : {} })),
  ai_video_projects: [{ id: `${tag}-v1`, brokerage_id: brokerage, agent_id: `${tag}-ag1`, status: "generating" }, { id: `${tag}-v2`, brokerage_id: brokerage, agent_id: `${tag}-ag1`, status: "completed" }],
  ad_campaigns: [{ id: `${tag}-ac1`, brokerage_id: brokerage, status: "live" }, { id: `${tag}-ac2`, brokerage_id: brokerage, status: "paused" }],
  ad_performance: Array.from({ length: n }, (_, i) => ({ id: `${tag}-ap${i}`, brokerage_id: brokerage, spend: 40, leads: 2, conversions: i === 0 ? 1 : 0, captured_at: iso(2) })),
  agent_action_ledger: [
    ...Array.from({ length: n }, (_, i) => ({ id: `${tag}-je${i}`, brokerage_id: brokerage, action: i === 0 ? "journey.experience.wait" : "journey.experience.education", created_at: iso(4) })),
    { id: `${tag}-jx`, brokerage_id: brokerage, action: "allocation.recommend.lead", created_at: iso(4) },
  ],
  marketing_campaign_touchpoints: Array.from({ length: n }, (_, i) => ({ id: `${tag}-tp${i}`, brokerage_id: brokerage, created_at: iso(6), sent_at: iso(6) })),
  // Engagement where it is WRITTEN (provider event fan-out → sequence_step_executions; sequence-conversion → enrollments).
  sequence_step_executions: Array.from({ length: n }, (_, i) => ({ id: `${tag}-sx${i}`, brokerage_id: brokerage, created_at: iso(6), opened_at: i < 2 ? iso(5) : null, replied_at: i === 0 ? iso(5) : null })),
  sequence_enrollments: [{ id: `${tag}-en0`, brokerage_id: brokerage, converted_at: iso(4) }],
  sphere_engagement_scores: [{ id: `${tag}-se1`, brokerage_id: brokerage, agent_id: `${tag}-ag1`, score: 80, referrals_given: 2, calculated_at: iso(1) }, { id: `${tag}-se2`, brokerage_id: brokerage, agent_id: `${tag}-ag2`, score: 40, referrals_given: 0, calculated_at: iso(1) }],
  cron_execution_logs: [{ id: `${tag}-cl1`, brokerage_id: brokerage, cron_name: "a", status: "completed", started_at: iso(1) }, { id: `${tag}-cl2`, brokerage_id: brokerage, cron_name: "b", status: "failed", started_at: iso(2) }, { id: `${tag}-cl3`, brokerage_id: brokerage, cron_name: "b", status: "started", started_at: iso(1) }],
  listing_presentations: Array.from({ length: n }, (_, i) => ({ id: `${tag}-lp${i}`, brokerage_id: brokerage, agent_id: `${tag}-ag1`, appointment_at: iso(20) })),
})
const merge = (...ws: Array<Record<string, Row[]>>) => { const out: Record<string, Row[]> = {}; for (const w of ws) for (const [k, v] of Object.entries(w)) out[k] = [...(out[k] ?? []), ...v]; return out }
const sliceWorld = (extra: Record<string, Row[]> = {}) => world(merge(sliceRows(A, "a", 3), sliceRows(B, "b", 9), extra))
let twinK!: BrokerageTwin
{
  const c = makeClient(sliceWorld())
  twinK = (await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false })).twin
  const keys = Object.keys(MANAGERS).sort()
  check("K1 one slice per MANAGERS key — the slice table and the built twin both hold exactly the registry's 13 seats, each slice owned by its key", Object.keys(TWIN_SLICE_SPECS).sort().join() === keys.join() && Object.keys(twinK.slices).sort().join() === keys.join() && Object.values(twinK.slices).every((s) => s.manager in MANAGERS && s.reader.length > 0 && s.answers.length > 0))
  const rehomed = Object.values(twinK.slices).filter((s) => s.origin === "rehomed")
  const resolves = (p: string) => p.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), twinK) !== undefined
  check("K2 the sections the twin ALREADY carried are RE-HOMED under their manager (deal_coordinator, recruiting_manager, finance_manager, compliance_officer, ai_isa, listing_concierge): they point at existing sections and copy NO numbers", ["deal_coordinator", "recruiting_manager", "finance_manager", "compliance_officer", "ai_isa", "listing_concierge"].every((k) => twinK.slices[k as keyof typeof twinK.slices].origin === "rehomed") && rehomed.every((s) => Object.keys(s.measures).length === 0 && s.sections.length > 0 && s.sections.every(resolves)), rehomed.map((s) => s.sections.filter((p) => !resolves(p)).join("|")).join(";"))
  check("K3 (control) a section path that does not exist is caught by the resolver K2 uses", !resolves("now.nothingHere"))
  const readers = Object.values(twinK.slices).filter((s) => s.origin === "reader" && s.manager !== "data_steward")
  check("K4 every reader slice reads through a survivor: present, fresh-stamped, evidence pinned to brokerage_id and naming its producer", readers.length === 6 && readers.every((s) => s.status === "present" && s.asOf !== null && s.evidence.length > 0 && s.evidence.every((e) => e.filter.includes(`brokerage_id=${A}`) && e.via.length > 0)), readers.map((s) => `${s.manager}:${s.status}`).join(","))
  const m = (k: string) => twinK.slices[k as keyof typeof twinK.slices].measures
  check("K5 slice numbers are A's rows as written (B's 9-row fixture never bleeds): buyer tours 3, live campaigns 1, ad spend $120, experiences 3 (wait 1 / education 2, the allocation row excluded), touchpoints 3 opened 2, sphere avg 60, cron failed 1",
    m("shopping_agent").tours30d === 3 && m("shopping_agent").buyerContacts === 3 && m("sphere_of_influence").lifetimeContacts === 3 && m("ads_manager").liveCampaigns === 1 && m("ads_manager").spendCents30d === 12_000 && m("ads_manager").costPerLeadCents === 2000 && m("campaign_orchestrator").experiences30d === 3 && m("campaign_orchestrator")["experience.wait"] === 1 && m("campaign_orchestrator")["experience.education"] === 2 && m("campaign_orchestrator").opened30d === 2 && m("sphere_of_influence").avgScore === 60 && m("cron_manager").failed7d === 1 && m("asset_manager").assets30d === 3 && m("asset_manager").videosInFlight === 1, JSON.stringify({ s: m("shopping_agent"), a: m("ads_manager"), c: m("campaign_orchestrator") }))
  check("K6 the data steward's slice is the build's own confidence (refusals, blind spots, snapshot baseline, competency source)", twinK.slices.data_steward.status === "present" && twinK.slices.data_steward.measures.snapshotBaseline === 1 && typeof twinK.slices.data_steward.measures.refusedReads === "number")
  check("K7 reader-slice measures ride the snapshot measures (change detection), re-homed slices add none", twinMeasures(twinK)["slices.ads_manager.liveCampaigns"] === 1 && !Object.keys(twinMeasures(twinK)).some((k) => k.startsWith("slices.deal_coordinator.")))

  // A refused reader → that slice alone is "refused", named; the rest stand.
  const refusing = makeClient(sliceWorld(), { refuse: new Set(["ad_performance"]) })
  const tr = (await buildBrokerageTwin(A, NOW, { svc: refusing as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false })).twin
  check("K8 a refused survivor read → the slice reads 'refused' with the refusal named in blindSpots, no partial numbers; other slices unaffected", tr.slices.ads_manager.status === "refused" && Object.keys(tr.slices.ads_manager.measures).length === 0 && tr.blindSpots.some((s) => /slice ads_manager refused: ad_performance\(30d\): refused/.test(s)) && tr.slices.shopping_agent.status === "present")
  // A registered seam (the ONE registry) replaces the default reader and is cited.
  const ts = (await buildBrokerageTwin(A, NOW, { svc: makeClient(sliceWorld()) as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false, seams: { "slice:ads_manager": async () => ({ measures: { liveCampaigns: 42 }, asOf: NOW.toISOString(), evidence: [{ table: "ad_campaigns", filter: `brokerage_id=${A}`, count: 42, via: "lib/kernel/ads.ts (registered)" }] }) } })).twin
  check("K9 registerTwinSeam('slice:<manager>') — the same registry as contributionMargin / missions — overrides the default reader and is cited as the reader", ts.slices.ads_manager.measures.liveCampaigns === 42 && /registerTwinSeam\('slice:ads_manager'\)/.test(ts.slices.ads_manager.reader))

  // TEAM isolation: slices whose rows carry no agent / team column are WITHHELD from a team board — not even read.
  const tc = makeClient(sliceWorld())
  const team = (await buildBrokerageTwin(A, NOW, { svc: tc as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false, teamId: TEAM })).twin
  const withheld = Object.values(team.slices).filter((s) => s.status === "withheld").map((s) => s.manager).sort()
  const readTables = new Set(tc.log.filter((l) => l.op === "select").map((l) => l.table))
  check("K10 a TEAM twin withholds the brokerage-wide slices (ads, campaign, cron) and never reads their tables; team-narrowable slices narrow through agent_id / team_id", withheld.join() === "ads_manager,campaign_orchestrator,cron_manager" && !readTables.has("ad_performance") && !readTables.has("marketing_campaign_touchpoints") && !readTables.has("cron_execution_logs") && team.slices.shopping_agent.measures.tours30d === 2 && team.slices.asset_manager.measures.assets30d === 1 && tc.log.filter((l) => l.table === "tours").every((l) => l.filters.includes("in:agent_id")), `withheld=${withheld} tours=${team.slices.shopping_agent.measures.tours30d}`)
  const reads = makeClient(sliceWorld()); await buildBrokerageTwin(A, NOW, { svc: reads as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false })
  const pinned = (l: { filters: string[] }) => l.filters.includes("eq:brokerage_id") || l.filters.includes("eq:recipient_brokerage_id") // the economic-graph seam (H7 loaded it) pins referral_payouts by its recipient tenant
  check("K11 every read of the build (slices + flow included) is pinned to the tenant", reads.log.filter((l) => l.op === "select").every(pinned), reads.log.filter((l) => l.op === "select" && !pinned(l)).map((l) => `${l.table}[${l.filters}]`).join(","))
}

// ─── L. the system view — flow, conversion, bottleneck ───────────────────────────────────────────
console.log("\nL. system view — the owner's pipeline: raw lead → lead → contact (← inbound direct) → appointment → agreement → transaction → closed, with the bottleneck named")
{
  const s = twinK.system
  check("L1 the stages in the owner's flow order (raw lead → lead → contact → appointment → agreement → transaction → closed) with an owner and evidence each", TWIN_FLOW_STAGES.join() === "raw_lead,lead,contact,appointment,agreement,transaction,closed" && s.stages.map((x) => x.stage).join() === TWIN_FLOW_STAGES.join() && s.stages.every((x) => x.owners.length > 0 && x.evidence.filter.includes(`brokerage_id=${A}`)))
  const stg = (k: string) => s.stages.find((x) => x.stage === k)!
  const c = (k: string) => stg(k).count
  // A's 90d window: 4 raw rows, 3 leads created (2 promoted from raw), 7 live contacts created (4 direct, the deleted one never),
  // 1 lead converted, appointments 3 presentations + 3 tours BY CONTACTS (the contact-less tour excluded), agreements 3 offers, closed 1.
  check("L2 stage counts are the window's rows (appointments = presentations + tours by contacts; agreements = listings taken + offers written; closed = the economic section's count)", c("raw_lead") === 4 && c("lead") === 3 && c("contact") === 7 && c("appointment") === 6 && c("agreement") === 3 && c("closed") === twinK.economic.closedCount90d, JSON.stringify(s.stages.map((x) => [x.stage, x.count])))
  const trn = (a: string) => s.transitions.find((t) => t.from === a)!
  check("L2b the contact stage has TWO entries (owner ruling): 4 arrived DIRECT from inbound sources, 1 from a converted lead — lead → contact converts on the converted lead (1/3), never contacts ÷ leads (7/3)", stg("contact").sources?.direct === 4 && stg("contact").sources?.fromLead === 1 && stg("contact").entered === 1 && Math.abs((trn("lead").rate ?? 0) - 1 / 3) < 1e-9, JSON.stringify({ c: stg("contact"), t: trn("lead") }))
  check("L2c raw → lead converts on the leads promoted FROM a raw row (source_family 'raw': 2 of 4 = 50%), not on every lead created", stg("lead").entered === 2 && trn("raw_lead").rate === 0.5)
  check("L2d (control) the naive ratio the rule replaced would have read > 100% — the defect L2b catches", (c("contact")! / c("lead")!) > 1)
  const st = (stage: string, count: number | null) => ({ stage: stage as any, count, owners: ["ai_isa" as const], evidence: { table: "t", filter: "f", count: count ?? 0, via: "v" } })
  const stages = [st("lead", 100), st("opportunity", 40), st("appointment", 30), st("agreement", 3), st("transaction", 3), st("closed", 2)]
  const tr = (a: number, b: number) => ({ from: stages[a].stage, to: stages[b].stage, rate: stages[a].count ? stages[b].count! / stages[a].count! : null, status: "measured" as const })
  const bn = detectBottleneck(stages, [tr(0, 1), tr(1, 2), tr(2, 3), tr(3, 4), tr(4, 5)])
  check("L3 (positive control) appointment → agreement at 10% against ≥ 40% elsewhere is NAMED the bottleneck, with the median it was judged against and both stages' evidence", bn?.from === "appointment" && bn.to === "agreement" && Math.abs(bn.rate - 0.1) < 1e-9 && bn.medianOtherRate !== null && bn.medianOtherRate >= 0.4 && bn.evidence.length === 2 && /appointment → agreement converts 10%/.test(bn.headline), bn?.headline)
  check("L4 (control) an UNMEASURED transition is never named even when it would be lowest; nothing measured → null (never a guessed bottleneck)", detectBottleneck(stages, [tr(0, 1), { from: "appointment", to: "agreement", rate: null, status: "unmeasured" }])?.from === "lead" && detectBottleneck(stages, []) === null)
  const refused = (await buildBrokerageTwin(A, NOW, { svc: makeClient(sliceWorld(), { refuse: new Set(["tours"]) }) as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false })).twin.system
  check("L5 a refused stage read → that stage's count is null (not 0) and both its transitions read 'unmeasured'", refused.stages.find((x) => x.stage === "appointment")!.count === null && refused.transitions.filter((t) => t.from === "appointment" || t.to === "appointment").every((t) => t.status === "unmeasured"))
  check("L6 capacity constraint: half the scored roster at capacity or over (capacityFor) → 'agent capacity' named with the capacity evidence", twinK.system.constraints.some((x) => x.what === "agent capacity" && x.evidence.via.includes("capacityFor")))
  check("L7 the flow counts ride the snapshot measures (system.<stage>)", twinMeasures(twinK)["system.appointment"] === 6)
}

// ─── N. WAVE 108 DOMAIN CORRECTIONS — contacts, not leads ───────────────────────────────────────
console.log("\nN. wave 108 domain corrections — the Shopping Agent / Listing Concierge read CONTACTS; only contacts tour; Sphere = LIFETIME contacts")
{
  const reads = makeClient(sliceWorld()); await buildBrokerageTwin(A, NOW, { svc: reads as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false })
  const sel = reads.log.filter((l) => l.op === "select")
  check("N1 the build never reads leads by lead_type (the buyer / seller demand reads are contacts by contact_type)", !sel.some((l) => l.table === "leads" && l.filters.includes("in:lead_type")) && sel.filter((l) => l.table === "contacts" && l.filters.includes("in:contact_type")).length >= 3, sel.filter((l) => l.table === "leads").map((l) => l.filters.join("|")).join(" ; "))
  check("N2 (positive control) the N1 finder recognises the retired shape (a leads read filtered by lead_type)", [{ table: "leads", op: "select", filters: ["eq:brokerage_id", "in:lead_type"] }].some((l) => l.table === "leads" && l.filters.includes("in:lead_type")))
  check("N3 only CONTACTS tour: every tours read requires contact_id (the contact-less tour is never counted — shopping tours30d = 3 of 4 rows)", sel.filter((l) => l.table === "tours").every((l) => l.filters.includes("not:contact_id")) && twinK.slices.shopping_agent.measures.tours30d === 3)
  check("N4 the Shopping Agent's buyer demand = contacts buyer|both (3; the deleted buyer and the seller excluded); the Sphere slice = LIFETIME contacts (lifetime_customer + sphere = 3), each cited", twinK.slices.shopping_agent.measures.buyerContacts === 3 && twinK.slices.sphere_of_influence.measures.lifetimeContacts === 3 && twinK.slices.sphere_of_influence.evidence.some((e) => e.table === "contacts" && /lifetime_customer,sphere/.test(e.filter)))
  // Listing Concierge: territory seller demand is seller CONTACTS. Control: seller LEADS with zips never count.
  const farmW = { farm_territories: [{ id: "f-a", brokerage_id: A, is_active: true, name: "Farm A", zip_codes: ["11111"], agent_id: "a-ag1" }] }
  const sellerLeadsOnly = (await buildBrokerageTwin(A, NOW, { svc: makeClient(sliceWorld({ ...farmW, leads: [{ id: "sl-1", brokerage_id: A, is_active: true, lifecycle_state: "isa_qualifying", agent_id: null, converted_at: null, lead_type: "seller", property_zip_code: "11111", created_at: iso(3) }] })) as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false })).twin
  const sellerContact = (await buildBrokerageTwin(A, NOW, { svc: makeClient(sliceWorld({ ...farmW, contacts: [{ id: "sc-1", brokerage_id: A, deleted_at: null, agent_id: null, contact_type: "seller", zip_code: "11111", home_value_estimate: 300000, created_at: iso(3) }] })) as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false })).twin
  const farmA = (t: BrokerageTwin) => t.workforce.territories.find((x) => x.territory === "Farm A")?.sellerContacts30d ?? -1
  check("N5 the Listing Concierge's territory demand counts a seller CONTACT in the farm (1) and never a seller LEAD (0) — a lead converts to a contact first", farmA(sellerContact) === 1 && farmA(sellerLeadsOnly) === 0, `contact=${farmA(sellerContact)} lead=${farmA(sellerLeadsOnly)}`)
  const team = (await buildBrokerageTwin(A, NOW, { svc: makeClient(sliceWorld()) as any, capacityFor: fakeCapacity, competencyFor: fakeCompetency, persist: false, teamId: TEAM })).twin
  check("N6 a TEAM board withholds the raw-lead stage (raw rows carry no agent) — null, published as a blind spot, never the brokerage's count", team.system.stages.find((x) => x.stage === "raw_lead")!.count === null && team.blindSpots.some((b) => /raw-lead stage is withheld/.test(b)))
  const twinSrc = code("lib/kernel/brokerage-twin.ts")
  const byLeadType = /\.(in|eq)\("lead_type"/
  check("N7 (stripped source) no twin read filters leads by lead_type any more — the demand vocabulary is the contact-type survivor (BUYER_SIDE / SELLER_SIDE / LIFETIME_CONTACT_TYPES); positive control: the finder catches the retired call", !byLeadType.test(src("lib/kernel/brokerage-twin.ts")) && byLeadType.test(stripComments(`svc.from("leads").select("id").in("lead_type", ["buyer"])`)) && /BUYER_SIDE_CONTACT_TYPES/.test(twinSrc) && /SELLER_SIDE_CONTACT_TYPES/.test(twinSrc) && /LIFETIME_CONTACT_TYPES/.test(twinSrc))
}

// ─── M. ONE READER — every consumer reads the twin through readBrokerageTwin ─────────────────────
console.log("\nM. one-reader census (stripped source) — managers read the twin, they do not re-derive it")
{
  const { readdirSync, statSync } = await import("node:fs")
  const walk = (dir: string, out: string[] = []): string[] => { for (const n of readdirSync(dir)) { const p = `${dir}/${n}`; if (n === "node_modules" || n.startsWith(".")) continue; const st = statSync(p); if (st.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(n)) out.push(p) } return out }
  const files = [...walk("lib"), ...walk("app")].filter((p) => p !== "lib/kernel/brokerage-twin.ts")
  const internals = files.filter((p) => /\b(loadBrokerageTwinFacts|composeBrokerageTwin)\b/.test(code(p)))
  const builders = files.filter((p) => /\bbuildBrokerageTwin\(/.test(code(p)))
  const readers = files.filter((p) => /\breadBrokerageTwin\(/.test(code(p)))
  check("M1 no product module reaches the twin's internals (loader / composer) — only the builder and the ONE reader", internals.length === 0, internals.join(","))
  check("M2 exactly one product BUILDER (the Command Center, which persists the snapshot every reader serves)", builders.join() === "lib/kernel/command-center.ts", builders.join(","))
  check("M3 the readers read through readBrokerageTwin — stand-up, team-lead brief, recruiting, allocation, and now the broker brief", ["lib/kernel/morning-standup.ts", "lib/intelligence/user-type-briefs/team-lead.ts", "app/actions/recruiting-roi.ts", "lib/kernel/resource-allocation.ts", "lib/intelligence/user-type-briefs/broker.ts"].every((p) => readers.includes(p)), readers.join(","))
  const brief = code("lib/intelligence/user-type-briefs/broker.ts")
  const dup = /\.from\("agents"\)\s*\.select\("id", \{ count: "exact", head: true \}\)\s*\.eq\("brokerage_id", params\.brokerageId\)\s*\.eq\("is_active", true\)/
  check("M4 the broker brief's active-agent head count (a re-derivation of capacity.activeAgents) is gone; the metric and the bottleneck line read the twin", !dup.test(src("lib/intelligence/user-type-briefs/broker.ts")) && /twin\.capacity\.activeAgents/.test(brief) && /twin\?\.system\?\.bottleneck\?\.headline/.test(brief))
  check("M5 (positive control) the census regex recognises the removed head-count shape (comment-stripped source, strings kept)", dup.test(stripComments(`supabase\n  .from("agents")\n  .select("id", { count: "exact", head: true })\n  .eq("brokerage_id", params.brokerageId)\n  .eq("is_active", true)`)))
  check("M6 (control) a tombstone naming the loader is not read as a reach into the internals", !/\bloadBrokerageTwinFacts\b/.test(code("lib/intelligence/user-type-briefs/broker.ts")) && !/\bloadBrokerageTwinFacts\b/.test(stripComments("// loadBrokerageTwinFacts used to be called here\nconst y = 2")))
}

// ─── I. registration + ownership ──────────────────────────────────────────────────────────────
console.log("\nI. registration + ownership")
{
  const pkg = JSON.parse(readFileSync("package.json", "utf8"))
  check("I1 package.json: test:brokerage-twin → this guard, in the chain after test:scrapers", pkg.scripts["test:brokerage-twin"] === "tsx scripts/brokerage-twin-guard.ts" && pkg.scripts.guard.indexOf("npm run test:brokerage-twin") > pkg.scripts.guard.indexOf("npm run test:scrapers") && pkg.scripts.guard.indexOf("npm run test:scrapers") >= 0)
  const dom = MAINTENANCE_DOMAINS.brokerage_digital_twin
  check("I2 MAINTENANCE_DOMAINS.brokerage_digital_twin: data_steward owns it, proof test:brokerage-twin, co-owners named in the prose", dom?.manager === "data_steward" && dom.proof === "test:brokerage-twin" && (dom.coOwners ?? []).every((k) => k in MANAGERS && dom.what.includes(k)) && (dom.coOwners ?? []).length === 3)
  check("I3 TABLE_MANAGER names the snapshot table's steward", TABLE_MANAGER[TWIN_SNAPSHOT_TABLE] === "data_steward")
  const mig = readFileSync("supabase/migrations/m708-brokerage-twin-snapshots.sql", "utf8")
  check("I4 m708 creates the table the loader reads (brokerage_id, team_id, at, twin, digest, previous_snapshot_id) — RLS on, authenticated SELECT only", /CREATE TABLE IF NOT EXISTS public\.brokerage_twin_snapshots/.test(mig) && /ENABLE ROW LEVEL SECURITY/.test(mig) && /REVOKE INSERT, UPDATE, DELETE/.test(mig) && ["brokerage_id", "team_id", "twin", "digest", "previous_snapshot_id"].every((c) => mig.includes(c)))
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} brokerage-twin: ${passed} passed, ${failed} failed`)
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
console.log("\nBLIND SPOTS (published, not asserted): the loader caps each list read at 5000 rows and scores at most 60 agents per build (both published in twin.blindSpots when hit); ai_tool_usage is summed from rows, not meter_readings (the rollup lags a day); exposureCents exists only for deal health (listings / stall / fatigue carry no dollar); the team scope narrows leads / listings / deals / goals by agent_id — brokerage-owned, unassigned leads are not on a team board by construction.")
