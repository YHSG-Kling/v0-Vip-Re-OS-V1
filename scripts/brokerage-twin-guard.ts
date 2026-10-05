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

// ─── A. build with evidence ───────────────────────────────────────────────────────────────────
console.log("\nA. the twin builds — evidence on every conclusion")
let twinA!: BrokerageTwin
{
  const c = makeClient(world())
  const r = await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity })
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
  const { twin } = await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, persist: false })
  const leads = twin.changed.changes.find((x) => x.field === "now.pipeline.leads")
  const appeared = twin.changed.changes.find((x) => x.field === "atRisk.compliance.at_risk")
  check("B1 diffs against THIS tenant's latest prior snapshot (not the foreign one)", !twin.changed.baseline && twin.changed.previousSnapshotId === "snap-old" && leads?.previous === 5 && leads.current === 2 && leads.delta === -3, JSON.stringify(twin.changed))
  check("B2 a risk that APPEARED is a change against 0", appeared?.previous === 0 && appeared.current === 1)
  check("B3 the new snapshot chains previous_snapshot_id", (await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity })).twin.changed.previousSnapshotId === "snap-old" && c.inserted[TWIN_SNAPSHOT_TABLE][0].previous_snapshot_id === "snap-old")
  const refused = makeClient(world(), { refuse: new Set([TWIN_SNAPSHOT_TABLE]), refuseInsert: new Set([TWIN_SNAPSHOT_TABLE]) })
  const r2 = await buildBrokerageTwin(A, NOW, { svc: refused as any, capacityFor: fakeCapacity })
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
  await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, persist: false })
  const reads = c.log.filter((l) => l.op === "select")
  check("E1 every read is pinned to brokerage_id", reads.length >= 15 && reads.every((l) => l.filters.includes("eq:brokerage_id")), reads.filter((l) => !l.filters.includes("eq:brokerage_id")).map((l) => l.table).join(","))
  check("E2 tenant B's rows never reach A's twin (B has the same shape — the counts are A's alone)", twinA.now.pipeline.evidence.ids!.every((id) => id.startsWith("a-")) && twinA.capacity.perAgent.every((a) => a.agentId.startsWith("a-")) && twinA.atRisk.every((r) => (r.evidence.ids ?? []).every((id) => id.startsWith("a-"))))
  const team = (await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, persist: false, teamId: TEAM })).twin
  check("E3 a team scope narrows through agents.team_id — the team sees only its board (1 agent, its lead / listing / deal)", team.teamId === TEAM && team.capacity.activeAgents === 1 && team.now.pipeline.leads === 1 && team.now.listings.active === 1 && team.now.transactions.open === 1 && team.now.transactions.openCommissionCents === 900_000, JSON.stringify(team.now))
  const r = await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, teamId: TEAM })
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
  const { twin } = await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, persist: false, seams: {
    missions: async () => ({ active: 3, source: "missions (104D)" }),
    contributionMargin: async () => ({ cents: 123_456, source: "lib/kernel/economic-graph.ts (104A)" }),
  } })
  check("G2 registered seams are read and cited as evidence", twin.objectives.missions.status === "present" && twin.objectives.missions.active === 3 && twin.economic.contributionMargin.cents === 123_456 && twin.objectives.evidence.some((e) => e.table === "missions (104D)"))
  const t2 = (await buildBrokerageTwin(A, NOW, { svc: c as any, capacityFor: fakeCapacity, persist: false, seams: { missions: async () => { throw new Error("boom") } } })).twin
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
  check("H5 the morning stand-up takes the agent's capacity line from the twin when handed one, else capacityFor", /twinCapacityForAgent\(opts\.twin, standupAgentId\)/.test(standup) && /capacityFor\(supabase, brokerageId, standupAgentId/.test(standup))
  const fixture = stripComments(`// TOMBSTONE: buildBrokerageTwin(brokerageId) used to live here\nconst x = 1\n/* buildBrokerageTwin(brokerageId, at) */`)
  check("H6 (control) a tombstone naming the builder is NOT read as a call site", !/buildBrokerageTwin\(brokerageId/.test(fixture) && /const x = 1/.test(fixture))
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
