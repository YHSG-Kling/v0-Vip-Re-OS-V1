#!/usr/bin/env tsx
/**
 * scripts/economic-graph-guard.ts (npm run test:economic-graph)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ECONOMIC GRAPH — ledger-derived financial truth (wave 104, lane 104A).
 *
 * A. PURE FIXTURES (in-memory ledger rows, no database): ONE closing with a
 *    team split + a referral fee + a residual (recruiting revenue share) + a fee
 *    + a m690 adjustment + a m690 reversal + three cost ledgers + a company-books
 *    obligation → ONE contribution margin; every share sums to gross (step 11's
 *    identity re-checked from the rows); every number cites its ledger rows.
 * B. ROLL-UPS: per transaction → agent / team / brokerage / period agree.
 * C. RESIDUAL TREE: the sponsor edges in force ON THE EVENT DATE (not today)
 *    resolve into named shares; an expired edge and another agent's edge do not.
 * D. DRIFT DETECTION with a POSITIVE CONTROL: an agreeing summary reports no
 *    drift; a summary off by $5.50 is found with its delta and refs.
 * E. TENANT ISOLATION: rows stamped with another brokerage are DROPPED and
 *    COUNTED by the pure core; every loader read pins a tenant predicate
 *    (stripped-source scan with a positive control that a predicate-less read
 *    is caught).
 * F. WIRING: the reconciler never writes; the reaper is registered under
 *    finance_manager; the three surfaces read the graph; the agent brief does not.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  deriveTransactionEconomics, rollupEconomics, resolveResidualTree, assembleEconomicGraph, projectResidualShares,
  type DistributionRow, type CostRow, type RelationshipRow,
} from "../lib/kernel/economic-graph"
import { detectSummaryAmountDrift, compareProjection } from "../lib/commission/reconcile-tracking"
import { REAPER_NET } from "../lib/intelligence/reaper-net"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = process.cwd()
const src = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))

const T = "txn-1", B = "brk-A", OTHER = "brk-B", AGENT = "agent-1", SPONSOR = "agent-sponsor", SPONSOR2 = "agent-sponsor-2", TEAM = "team-1"
const d = (over: Partial<DistributionRow> & { id: string; distribution_type: string; calculated_amount: number }): DistributionRow => ({
  brokerage_id: B, transaction_id: T, entry_type: "entry", adjusts_distribution_id: null, agent_id: null, team_id: null,
  source_of_funds: "brokerage", status: "pending", cap_status: "n/a", paid_at: null, voided_at: null, ...over,
})
// Gross $10,000 → referral 500 + team 1,000 + residual 300 + fee 150 + agent 5,550 + brokerage 2,500 = 10,000.
const distributions: DistributionRow[] = [
  d({ id: "d-ref", distribution_type: "referral", calculated_amount: 500, source_of_funds: "agent" }),
  d({ id: "d-team", distribution_type: "team_member", calculated_amount: 1000, team_id: TEAM, agent_id: "agent-lead", source_of_funds: "agent" }),
  d({ id: "d-res", distribution_type: "residual", calculated_amount: 300, agent_id: SPONSOR, source_of_funds: "brokerage" }),
  d({ id: "d-fee", distribution_type: "fee", calculated_amount: 150, source_of_funds: "agent" }),
  d({ id: "d-agent", distribution_type: "agent", calculated_amount: 5550, agent_id: AGENT, status: "paid", cap_status: "pre_cap" }),
  d({ id: "d-brk", distribution_type: "brokerage", calculated_amount: 2500, status: "paid" }),
  // m690 corrections: the fee adjusted down by $50; the referral reversed in full.
  d({ id: "c-fee", distribution_type: "fee", calculated_amount: -50, entry_type: "adjustment", adjusts_distribution_id: "d-fee" }),
  d({ id: "c-ref", distribution_type: "referral", calculated_amount: -500, entry_type: "reversal", adjusts_distribution_id: "d-ref" }),
  // a voided entry and a FOREIGN-TENANT row — neither may count
  d({ id: "d-void", distribution_type: "fee", calculated_amount: 999, status: "voided", voided_at: "2026-09-01" }),
  d({ id: "d-foreign", distribution_type: "brokerage", calculated_amount: 77777, brokerage_id: OTHER }),
]
const costs: CostRow[] = [
  { table: "ai_tool_usage", id: "ai-1", brokerage_id: B, agent_id: AGENT, transaction_id: T, cents: 1200, platform_paid: true },
  { table: "agent_action_ledger", id: "act-1", brokerage_id: B, agent_id: AGENT, transaction_id: T, cents: 350, platform_paid: false },
  { table: "vendor_usage_tracking", id: "vu-1", brokerage_id: B, agent_id: AGENT, transaction_id: T, cents: 225, platform_paid: false },
  { table: "vendor_usage_tracking", id: "vu-foreign", brokerage_id: OTHER, agent_id: AGENT, transaction_id: T, cents: 99999, platform_paid: false },
  { table: "ai_tool_usage", id: "ai-unattributed", brokerage_id: B, agent_id: AGENT, transaction_id: null, cents: 400, platform_paid: false },
]
const edges: RelationshipRow[] = [
  { id: "e-1", brokerage_id: B, agent_id: AGENT, sponsor_agent_id: SPONSOR, depth_level: 1, revenue_share_percent: 5, source_of_funds: "brokerage", effective_from: "2025-01-01", effective_to: null, is_active: true },
  { id: "e-expired", brokerage_id: B, agent_id: AGENT, sponsor_agent_id: SPONSOR2, depth_level: 2, revenue_share_percent: 2, source_of_funds: "brokerage", effective_from: "2024-01-01", effective_to: "2026-05-31", is_active: true },
  { id: "e-other-agent", brokerage_id: B, agent_id: "agent-9", sponsor_agent_id: SPONSOR, depth_level: 1, revenue_share_percent: 5, source_of_funds: "brokerage", effective_from: "2025-01-01", effective_to: null, is_active: true },
  { id: "e-foreign", brokerage_id: OTHER, agent_id: AGENT, sponsor_agent_id: "agent-x", depth_level: 1, revenue_share_percent: 50, source_of_funds: "brokerage", effective_from: "2025-01-01", effective_to: null, is_active: true },
]
const CLOSE = "2026-08-15"

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Economic graph — ledger-derived financial truth")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[A · one closing, one trace, one margin]")
  const t = deriveTransactionEconomics({
    transactionId: T, brokerageId: B, agentId: AGENT, closeDate: CLOSE,
    calculation: { id: "calc-1", brokerage_id: B, transaction_id: T, total_commission: 10000 },
    distributions, obligations: [{ id: "ob-1", brokerage_id: B, transaction_id: T, calculated_amount: 100, status: "pending" }],
    costs, relationships: edges,
  })
  check("gross comes from commission_calculations ($10,000)", t.grossCents === 1_000_000 && t.grossSource === "commission_calculations")
  check("conservation: Σ posted entries == gross (voided + foreign excluded)", t.conservation.ok && t.conservation.deltaCents === 0, `delta=${t.conservation.deltaCents}`)
  check("every share kind present and summing to gross", ["agent", "brokerage", "team_member", "referral", "residual", "royalty", "fee"].every((k) => k in t.byKind) && (t.shares.filter((s) => s.entryCents > 0).reduce((s, x) => s + x.entryCents, 0) === 1_000_000))
  check("corrections: adjustment −$50 on the fee, reversal −$500 on the referral", t.adjustmentCents === -5000 && t.reversalCents === -50000 && t.byKind.fee === 10000 && t.byKind.referral === 0)
  check("corrections ride the entry they adjust (fee share nets 100 with 2 refs)", (() => { const f = t.shares.find((s) => s.kind === "fee"); return !!f && f.netCents === 10000 && f.refs.length === 2 })())
  check("payouts: agent + brokerage paid ($8,050), rest unpaid ($1,400 after corrections)", t.paidCents === 805000 && t.unpaidCents === 140000, `paid=${t.paidCents} unpaid=${t.unpaidCents}`)
  check("costs: tenant-borne $5.75, platform-covered $12.00; foreign row dropped", t.tenantCostCents === 575 && t.platformCoveredCostCents === 1200)
  check("contribution margin = brokerage 2,500 − costs 5.75 − obligation 100 = $2,394.25", t.contributionMarginCents === 239425, `got ${t.contributionMarginCents}`)
  check("every number cites ledger rows (≥ 12 refs incl. calc, obligation, costs, edge)", t.evidence.length >= 12 && t.evidence.every((r) => r.table && r.id))
  check("every share carries ≥ 1 ref", t.shares.every((s) => s.refs.length >= 1))
  check("voided entry excluded from shares, counted in voidedCents", t.voidedCents === 99900 && !t.shares.some((s) => s.refs.some((r) => r.id === "d-void")))

  console.log("\n[B · roll-ups agree with the trace]")
  const byAgent = rollupEconomics([t], (x) => x.agentId)
  const byTeam = rollupEconomics([t], (x) => x.shares.find((s) => s.kind === "team_member" && s.teamId)?.teamId ?? null)
  const byPeriod = rollupEconomics([t], (x) => x.closeDate?.slice(0, 7) ?? null)
  check("agent roll-up: gross + margin equal the trace", byAgent[0]?.key === AGENT && byAgent[0].grossCents === t.grossCents && byAgent[0].contributionMarginCents === t.contributionMarginCents)
  check("team roll-up keyed on the team_member share's team", byTeam[0]?.key === TEAM && byTeam[0].teamShareCents === 100000)
  check("period roll-up keyed on close month", byPeriod[0]?.key === "2026-08")
  const graph = assembleEconomicGraph({
    brokerageId: B, since: "2026-01-01T00:00:00.000Z", until: "2026-12-31T00:00:00.000Z",
    txns: [{ id: T, agent_id: AGENT, close_date: CLOSE }],
    calcs: [{ id: "calc-1", brokerage_id: B, transaction_id: T, total_commission: 10000 }],
    dists: distributions, obligations: [{ id: "ob-1", brokerage_id: B, transaction_id: T, calculated_amount: 100, status: "pending" }],
    relationships: edges, costs,
    marketplace: { referralPayoutsReceivedCents: 2500, vendorInvoicesPaidCents: 0, vendorPayoutsCompletedCents: 0, refs: [] },
    measured: true, warnings: [],
  })
  check("graph: unattributed tenant cost $4.00 lands on the agent node and the brokerage margin", graph.unattributedCosts.tenantCostCents === 400 && graph.byAgent[0].tenantCostCents === 975 && graph.contributionMarginCents === 239425 - 400 + 2500)
  check("graph: brokerage roll-up = one closing, evidence rows counted", graph.brokerage.transactions === 1 && graph.brokerage.evidenceRows === t.evidence.length)

  console.log("\n[C · residual tree resolves on the EVENT date]")
  const tree = resolveResidualTree(edges, AGENT, CLOSE, B)
  check("one edge in force on 2026-08-15 (the expired depth-2 edge and other agents' edges excluded)", tree.length === 1 && tree[0].sponsorAgentId === SPONSOR && tree[0].rateType === "percent" && tree[0].value === 5)
  check("the same edge was in force on 2026-05-01 → two edges then; without the tenant pin the foreign edge leaks (control)", resolveResidualTree(edges, AGENT, "2026-05-01", B).length === 2 && resolveResidualTree(edges, AGENT, CLOSE).length === 2)
  check("recorded residual matches the expected sponsor — no missing / unexpected", t.residuals.missing.length === 0 && t.residuals.unexpected.length === 0 && t.residuals.recorded.length === 1)
  const t2 = deriveTransactionEconomics({ transactionId: T, brokerageId: B, agentId: AGENT, closeDate: CLOSE, calculation: null, distributions: distributions.filter((x) => x.id !== "d-res"), obligations: [], costs: [], relationships: edges })
  check("positive control: a closing with no residual row reports the sponsor as MISSING", t2.residuals.missing.length === 1 && t2.residuals.missing[0].sponsorAgentId === SPONSOR)
  check("no calculation row → gross falls back to Σ entries, source named", t2.grossSource === "distribution_entries" && t2.grossCents === 970000)
  const projected = projectResidualShares({
    brokerageId: B, agentId: AGENT, agentFinalNetCents: 555000, brokerageFinalCents: 250000, edges, eventDate: CLOSE,
    state: { enabled: true, configured: true, missing: [], model: { sourceOfFunds: "brokerage", rateType: "percent", defaultPercent: 5, flatCents: null, durationMonths: 0 } },
  })
  check("projection through the ONE money step: 5% of the agent's net to the sponsor ($277.50), the expired edge pays nothing", !!projected && projected.length === 1 && projected[0].sponsorAgentId === SPONSOR && projected[0].cents === 27750, JSON.stringify(projected))
  check("projection is null when the model is disabled (fail-closed, stage 09's own skip)", projectResidualShares({ brokerageId: B, agentId: AGENT, agentFinalNetCents: 1, brokerageFinalCents: 1, edges, eventDate: CLOSE, state: { enabled: false, configured: false, missing: ["x"], model: null } }) === null)

  console.log("\n[D · drift detection, with a positive control]")
  const live = distributions.filter((x) => x.brokerage_id === B && x.id !== "d-foreign")
  const agree = detectSummaryAmountDrift({ summary: { id: "sum-1", transaction_id: T, net_to_agent: 5550, net_to_brokerage: 2500 }, distributions: live })
  check("an agreeing summary reports no drift", agree.length === 0, JSON.stringify(agree))
  const off = detectSummaryAmountDrift({ summary: { id: "sum-1", transaction_id: T, net_to_agent: 5544.5, net_to_brokerage: 2500 }, distributions: live })
  check("POSITIVE CONTROL: net_to_agent off by $5.50 is found with delta −550¢ and ledger refs", off.length === 1 && off[0].projection === "agent_commissions.net_to_agent" && off[0].deltaCents === -550 && off[0].refs.length >= 6)
  check("compareProjection tolerates 1¢ rounding and nothing more", compareProjection({ projection: "agents.ytd_gci", subjectId: "a", projectedCents: 1000001, ledgerCents: 1000000, refs: [] }) === null && compareProjection({ projection: "agents.ytd_gci", subjectId: "a", projectedCents: 1000002, ledgerCents: 1000000, refs: [] })?.deltaCents === 2)

  console.log("\n[E · tenant isolation]")
  check("pure core drops + counts foreign rows (distribution, cost, edge)", t.foreignRowsDropped === 3, `dropped=${t.foreignRowsDropped}`)
  const tOther = deriveTransactionEconomics({ transactionId: T, brokerageId: OTHER, agentId: AGENT, closeDate: CLOSE, calculation: { id: "calc-1", brokerage_id: B, transaction_id: T, total_commission: 10000 }, distributions, obligations: [], costs, relationships: edges })
  check("the other tenant sees only its own row ($777.77) and never brokerage A's gross", tOther.grossCents === 7777700 && tOther.grossSource === "distribution_entries" && tOther.byKind.brokerage === 7777700 && tOther.tenantCostCents === 99999)
  const graphSrc = src("lib/kernel/economic-graph.ts")
  const reads = [...graphSrc.matchAll(/\.from\("([a-z_]+)"\)[\s\S]*?(?=\n\s*(?:if|const|let|for|return|\]|\)|svc\.))/g)]
  const tenantPinned = (chunk: string) => /\.eq\("brokerage_id", brokerageId\)|\.eq\("recipient_brokerage_id", brokerageId\)/.test(chunk)
  const unpinned = reads.filter((m) => !tenantPinned(m[0])).map((m) => m[1])
  check(`every loader read pins the tenant (${reads.length} reads scanned, 0 unpinned)`, reads.length >= 10 && unpinned.length === 0, unpinned.join(","))
  check("POSITIVE CONTROL: a predicate-less read is caught by the scan", !tenantPinned('svc.from("transactions").select("id").limit(5)'))

  console.log("\n[F · wiring]")
  const recSrc = src("lib/commission/reconcile-tracking.ts")
  const body = recSrc.slice(recSrc.indexOf("export async function reconcileSummariesAgainstLedger"))
  check("the reconciler is read-only (no insert/update/upsert/delete after its declaration)", !/\.(insert|update|upsert|delete)\(/.test(body))
  const reaperSrc = src("lib/finance/commission-tracking-reaper.ts")
  const reaperBody = reaperSrc.slice(reaperSrc.indexOf("export async function reapCommissionAmountDrift"))
  check("the amount-drift reaper escalates (notifications) and never writes a money table", /from\("notifications"\)/.test(reaperBody) && !/from\("(agent_commissions|commission_distributions|transaction_commissions|agents|brokerage_earnings)"\)/.test(reaperBody) && /reaped: 0/.test(reaperBody))
  const entry = REAPER_NET.find((e) => e.domain === "commission_amount_drift")
  check("reaper-net registers commission_amount_drift under finance_manager (proactive lane)", !!entry && entry.manager === "finance_manager" && entry.lane === "proactive")
  check("finance page reads the graph through LedgerTruthSection", /loadEconomicGraph/.test(src("app/dashboard/financials/brokerage/page.tsx")) && /LedgerTruthSection/.test(src("app/dashboard/financials/brokerage/page.tsx")))
  check("broker brief reads the graph + reconciler", /loadEconomicGraph[\s\S]*reconcileSummariesAgainstLedger/.test(src("lib/intelligence/user-type-briefs/broker.ts")))
  check("command center loads + renders the graph summary", /economicGraph/.test(src("lib/kernel/command-center.ts")) && /data\.economicGraph/.test(src("app/dashboard/admin/command-center/command-center-client.tsx")))
  const agentBrief = readFileSync(join(ROOT, "lib/intelligence/user-type-briefs/index.ts"), "utf8")
  check("agent-facing brief never imports the graph (§5: commission off agent display)", !/economic-graph/.test(agentBrief))
  const dom = MAINTENANCE_DOMAINS.economic_graph
  check("MAINTENANCE_DOMAINS.economic_graph: finance_manager accountable, co-owners named", !!dom && dom.manager === "finance_manager" && dom.proof === "test:economic-graph" && (dom.coOwners ?? []).length >= 2 && (dom.coOwners ?? []).every((c) => dom.what.includes(c)))
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }
  check("registered in package.json and in the guard chain", pkg.scripts["test:economic-graph"] === "tsx scripts/economic-graph-guard.ts" && /npm run test:economic-graph(\s|&|$)/.test(pkg.scripts.guard))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(` Blind spots: pure fixtures only — no live ledger read; the loader's SQL predicates are scanned, not executed;`)
  console.log(` v_platform_margin (platform VIEW) and revenue_protection_snapshots (model-derived) are not reconciled here — see lane notes.`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ ECONOMIC_GRAPH_PASS")
}
main().catch((e) => { console.error(e); process.exit(1) })
