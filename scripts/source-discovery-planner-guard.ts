/**
 * scripts/source-discovery-planner-guard.ts — THE SOURCE DISCOVERY PLANNER (wave 150, lane 150EFG; directive 150E).
 *
 *   A  per territory: estimated reach, preview counts, quotes, budget, expected new leads (observed ratio — never a
 *      probability) → a PROPOSED plan; preview-first (no preview and no history → needs_preview; no price → needs_quote);
 *      budget respected; buyer AND seller balance; the market gap tilts; hunting vs farming; the investor buy-box overlay
 *      on investor lines only (a retail seller needs no 30 % equity floor); every owner-named play is plannable;
 *   B  approval: only a seat that may commit the tenant's money; only proposed lines; an expiry;
 *   C  THE PAID-CALL GATE on the REAL pooled pull (lib/lead-pipeline/pooled-pull.ts runPooledBatchDataLane): an
 *      unapproved tenant's territory issues ZERO paid requests; an approved one is pulled; an unreadable plan store
 *      refuses everyone; production deps read acquisition_plans and fail closed;
 *   D  wiring: the session-gated doors, the ledgered approval, the Settings panel, the m962 table.
 *
 * Positive controls: the all-approved run DOES issue requests (the zero is not a broken counter); paidPullApproval allows
 * the one genuine approval; approvePlanLines approves for a commerce seat.
 *
 * BLIND SPOTS (published): provider preview counts (BatchData count / PropertyRadar purchase=0) are not wired — the door
 * uses the territory's own history as the free preview, so a source never run there plans as needs_preview; the
 * per-territory Apify / Exa / ZenRows / FSBO pulls in the cron are not yet behind the gate (only the record-priced
 * pooled BatchData lanes are); maxSpendUsd is recorded but the pooled lane caps by records, not dollars; months-of-supply
 * is not yet fed (lane 150KLMO's market twin) so plans read "balanced".
 */
import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { createRequire } from "node:module"
import { stripComments } from "./strip-comments"

const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* not installed */ }

const ROOT = process.cwd()
let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const stripped = (p: string) => stripComments(read(p))

async function main() {
  const pl = await import("../lib/lead-pipeline/source-discovery-planner")
  const pp = await import("../lib/lead-pipeline/pooled-pull")
  const T1 = "11111111-1111-4111-8111-111111111111"
  const T2 = "22222222-2222-4222-8222-222222222222"
  const territory = { id: "m1", brokerageId: T1, label: "Pensacola, FL" }
  const history = {
    batchdata_motivated: { rawRows: 400, promoted: 40, duplicates: 30, costUsd: 20 },
    batchdata_cash_buyer: { rawRows: 100, promoted: 5, duplicates: 2, costUsd: 5 },
    reddit_relocation: { rawRows: 60, promoted: 6, duplicates: 1, costUsd: 0.6 },
    site_visitor_intent: { rawRows: 30, promoted: 9, duplicates: 0, costUsd: 0 },
  } as const
  const quotes = { batchdata_motivated: { unitUsd: 0.05, basis: "catalogue" as const }, batchdata_cash_buyer: { unitUsd: 0.05, basis: "catalogue" as const }, reddit_relocation: { unitUsd: 0.01, basis: "history" as const }, expired_listing: { unitUsd: 0.05, basis: "catalogue" as const } }
  const previews = { batchdata_motivated: { count: 400, at: "2026-11-06T00:00:00Z", via: "own history" }, batchdata_cash_buyer: { count: 100, at: "2026-11-06T00:00:00Z", via: "own history" }, reddit_relocation: { count: 60, at: "2026-11-06T00:00:00Z", via: "own history" } }
  const enabled = ["batchdata_motivated", "batchdata_cash_buyer", "reddit_relocation", "site_visitor_intent", "expired_listing"] as any

  console.log("\n[A] the plan")
  const plan = pl.planSourceDiscovery({ territory, budgetUsd: 100, enabledSources: enabled, history: history as any, previews, quotes, marketGap: { monthsOfSupply: 2.1 }, distressPreviewCount: 140 })
  const line = (s: string) => plan.lines.find((l) => l.source === s)!
  check("a first-party line is free and ready (no spend, no approval)", line("site_visitor_intent").status === "free_ready" && !line("site_visitor_intent").paid)
  check("a paid line with preview + quote is PROPOSED with reach, quote and expected new leads", line("batchdata_motivated").status === "proposed" && line("batchdata_motivated").estimatedReach === 400 && line("batchdata_motivated").quoteUsd === 20 && line("batchdata_motivated").expectedNewLeads === 40)
  check("expected new leads are an OBSERVED ratio, labelled so", line("batchdata_motivated").expectedBasis === "territory_history" && line("expired_listing").expectedBasis === "no_history")
  check("preview first: a paid source with no preview and no history cannot be proposed", line("expired_listing").status === "needs_preview", line("expired_listing").status)
  check("the total stays within the budget", plan.totalQuoteUsd <= 100, String(plan.totalQuoteUsd))
  check("buyer AND seller lines are both planned", plan.balance.buyerLines > 0 && plan.balance.sellerLines > 0, JSON.stringify(plan.balance))
  check("a tight market (2.1 months of supply) tilts toward sellers", plan.tilt === "seller")
  check("a healthy distress preview count reads as a HUNTING market", plan.marketMode === "hunting")
  check("the buy-box overlay (equity ≥ 30 %) rides the INVESTOR line only", (line("batchdata_cash_buyer").criteria as any)?.equityPercentMin === 30 && line("batchdata_motivated").criteria === null)
  const tight = pl.planSourceDiscovery({ territory, budgetUsd: 1, enabledSources: enabled, history: history as any, previews, quotes, marketGap: null, distressPreviewCount: 3 })
  check("an over-budget paid line is marked, never silently dropped", tight.lines.some((l) => l.status === "over_budget"))
  check("thin distress counts read as a FARMING market; no months-of-supply is published as a blind spot", tight.marketMode === "farming" && tight.tilt === "balanced" && tight.blindSpots.some((b) => /months-of-supply/.test(b)))
  const all = pl.planSourceDiscovery({ territory, budgetUsd: 0, history: {}, previews: {}, quotes: {} })
  const plays = new Set(all.lines.flatMap((l) => l.plays))
  check("every owner-named play is plannable (renter-to-owner, relocation, owner equity, downsizing, first-party search, supply-demand gap, voluntary guidance)", ["renter_to_owner", "relocation", "owner_equity", "downsizing", "first_party_search", "supply_demand_gap", "voluntary_guidance"].every((p) => plays.has(p as any)), [...plays].join(","))
  check("with no history and no budget nothing paid is proposed", all.lines.every((l) => !l.paid || l.status !== "proposed"))

  console.log("\n[B] approval")
  check("a seat that may not commit spend is refused", !pl.approvePlanLines(plan.lines, ["batchdata_motivated"], { userId: "u", mayCommitSpend: false }).ok)
  check("a needs_preview line cannot be approved", !pl.approvePlanLines(plan.lines, ["expired_listing"], { userId: "u", mayCommitSpend: true }).ok)
  const ok = pl.approvePlanLines(plan.lines, ["batchdata_motivated"], { userId: "u1", mayCommitSpend: true }, new Date("2026-11-06T00:00:00Z"))
  check("POSITIVE CONTROL: a commerce seat approves a proposed line, with who / when / max spend / expiry", ok.ok && ok.lines.find((l) => l.source === "batchdata_motivated")?.maxSpendUsd === 20 && ok.lines.find((l) => l.source === "batchdata_motivated")?.approvedByUserId === "u1" && !!ok.validUntil)
  const approvedRow = { id: "plan-1", brokerage_id: T1, status: "approved", valid_until: ok.ok ? ok.validUntil : null, lines: ok.ok ? ok.lines : [] }
  const now = new Date("2026-11-10T00:00:00Z")
  check("the gate ALLOWS the approved tenant + source", pl.paidPullApproval([approvedRow], { brokerageId: T1, source: "batchdata_motivated" }, now).allowed)
  check("the gate refuses a source the plan did not approve", !pl.paidPullApproval([approvedRow], { brokerageId: T1, source: "batchdata_cash_buyer" }, now).allowed)
  check("the gate refuses another tenant", !pl.paidPullApproval([approvedRow], { brokerageId: T2, source: "batchdata_motivated" }, now).allowed)
  check("the gate refuses a proposal", !pl.paidPullApproval([{ ...approvedRow, status: "proposed" }], { brokerageId: T1, source: "batchdata_motivated" }, now).allowed)
  check("the gate refuses an expired approval", !pl.paidPullApproval([approvedRow], { brokerageId: T1, source: "batchdata_motivated" }, new Date("2027-06-01T00:00:00Z")).allowed)
  check("the gate refuses when the plan store could not be read (fail closed)", !pl.paidPullApproval(null, { brokerageId: T1, source: "batchdata_motivated" }, now).allowed)
  check("the gate refuses a tenant-less platform share", !pl.paidPullApproval([approvedRow], { brokerageId: null, source: "batchdata_motivated" }, now).allowed)

  console.log("\n[C] the real pooled pull asks the gate before it spends")
  const calls: Array<{ zips: string[] }> = []
  const deps = (approval: (b: string | null, lane: string) => any) => ({
    search: async (opts: any) => { calls.push({ zips: opts.searchCriteria?.address?.zip?.inList ?? [] }); return { records: [], cost: 0 } },
    dateWindow: () => ({}), statusWindow: () => true,
    geographyCriteria: (_k: any, v: readonly string[]) => ({ address: { zip: { inList: [...v] } } }),
    maxTake: 500, maxInList: 100, approval,
  }) as any
  const wants = [
    { territory: { id: "terr-A", brokerage_id: T1, state: "FL", zip_codes: ["32501"] }, triggers: ["high_equity"], lookbackDays: null },
    { territory: { id: "terr-B", brokerage_id: T2, state: "FL", zip_codes: ["32502"] }, triggers: ["high_equity"], lookbackDays: null },
  ]
  const gate = (b: string | null, lane: string) => pl.paidPullApproval([approvedRow], { brokerageId: b, source: lane }, now)
  calls.length = 0
  const r = await pp.runPooledBatchDataLane("batchdata_motivated", wants as any, deps(gate))
  check("the unapproved tenant's territory is never requested", calls.length > 0 && calls.every((c) => !c.zips.includes("32502")) && r.ledger.unapprovedTerritories === 1, JSON.stringify(calls))
  check("the approved tenant's territory is pulled", calls.some((c) => c.zips.includes("32501")))
  check("the refusal is said, per territory", r.errors.some((e) => /terr-B not pulled/.test(e)))
  calls.length = 0
  await pp.runPooledBatchDataLane("batchdata_motivated", wants as any, deps(() => ({ allowed: true })))
  check("POSITIVE CONTROL: all approved → both territories requested (the zero above is real)", calls.some((c) => c.zips.includes("32502")) && calls.some((c) => c.zips.includes("32501")))
  calls.length = 0
  await pp.runPooledBatchDataLane("batchdata_motivated", wants as any, deps((b, lane) => pl.paidPullApproval(null, { brokerageId: b, source: lane }, now)))
  check("an unreadable plan store → ZERO paid requests", calls.length === 0)
  const ppSrc = stripped("lib/lead-pipeline/pooled-pull.ts")
  check("production deps read approved acquisition_plans and fail closed on a refused read", /from\("acquisition_plans"\)/.test(ppSrc) && /planErr \? null :/.test(ppSrc) && /approval: \(brokerageId, lane\) => paidPullApproval\(plans,/.test(ppSrc))
  check("the gate runs BEFORE pooling (no unapproved geography widens a request)", ppSrc.indexOf("deps.approval(") > 0 && ppSrc.indexOf("deps.approval(") < ppSrc.indexOf("planPooledGeography(territories"))

  console.log("\n[D] wiring")
  const act = stripped("app/actions/acquisition-plan.ts")
  check("the doors are a 'use server' file whose every export is async", /^"use server"/.test(read("app/actions/acquisition-plan.ts")) && !/export (const|function [a-zA-Z]+\()/.test(act.replace(/export async function/g, "")))
  check("tenant from the SESSION (requireBrokerageAdmin on auth.getUser), never a body", /supabase\.auth\.getUser\(\)/.test(act) && /requireBrokerageAdmin\(supabase, auth\.user\.id\)/.test(act) && !/input\??\.brokerageId/.test(act))
  check("approval needs a TENANT_COMMERCE_ADMIN seat and is ledgered (FINANCIAL)", /TENANT_COMMERCE_ADMIN_USER_TYPES\.has/.test(act) && /action: "acquisition\.plan\.approve"/.test(act) && /riskClass: "FINANCIAL"/.test(act))
  check("the approval write is tenant-pinned, status-pinned and counted", /\.eq\("id", input\.planId\)\.eq\("brokerage_id", ctx\.brokerageId\)\.eq\("status", "proposed"\)\s*\.select\("id"\)/.test(act))
  check("the plan insert carries brokerage_id at the top level and the creating user", /\.insert\(\{\s*brokerage_id: ctx\.brokerageId,[\s\S]{0,600}created_by_user_id: ctx\.userId/.test(act))
  const page = stripped("app/dashboard/settings/territories/page.tsx")
  check("the Settings → Territories page renders the panel", /<AcquisitionPlanPanel view=\{acquisition\} \/>/.test(page))
  const panel = read("app/dashboard/settings/territories/acquisition-plan-panel.tsx")
  check("the panel says so when empty", /No acquisition plans yet/.test(panel) && /No lead-scraping territories yet/.test(panel))
  const mig = "supabase/migrations/m962-acquisition-plans-source-discovery.sql"
  check("m962 exists with the lane stamp (or APPLIED LIVE) and the approval-shape CHECK", existsSync(join(ROOT, mig)) && (read(mig).split("\n")[0].includes("(wave 150, lane 150EFG)") || read(mig).startsWith("-- ── APPLIED LIVE ")) && /acquisition_plans_approval_shape/.test(read(mig)))
  check("m962's status vocabulary covers what the code writes", ["proposed", "approved"].every((s) => new RegExp(`'${s}'`).test(read(mig))))

  console.log(`\nSOURCE DISCOVERY PLANNER — ${passed} passed, ${failed} failed ${failed === 0 ? "✅ SOURCE_DISCOVERY_PLANNER_PASS" : "❌ SOURCE_DISCOVERY_PLANNER_FAIL"}`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
