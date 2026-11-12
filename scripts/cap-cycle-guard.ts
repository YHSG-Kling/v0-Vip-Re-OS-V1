#!/usr/bin/env tsx
/**
 * scripts/cap-cycle-guard.ts   (npm run test:cap-cycle)
 * ─────────────────────────────────────────────────────────────────────────
 * Wave 144, lane 144D — THE CAP PAID-TO-DATE LEDGER IS THE DEAL'S CYCLE (owner ruling 9, 2026-10-25):
 * "Cap paid to date tallies what the agent/team has paid the brokerage; once it equals the cap in the agent/team agreement,
 * the brokerage stops taking that fee until the agent/team ANNIVERSARY cap date, when the total restarts. Cap-eligible
 * contribution types, cycle/anniversary, exceptions and effective agreement version come from the agreement; never reset on
 * January 1 unless the agreement says so; never apply the cap to unrelated royalties/fees. Test crossing the cap
 * mid-transaction, refunds/corrections, anniversary rollover, agreement changes."
 *
 * Proved as RULES through the REAL engine (lib/commission/engine.ts calculateCommission, all stages) over the in-memory client,
 * and through the REAL correction / void commands (lib/kernel/financial.ts). No migration is pinned by number, every absence
 * claim has a POSITIVE CONTROL, and every source scan reads STRIPPED source (CLAUDE.md §2).
 *
 *   A. the cycle is the DEAL's (its close date), not today's — a deal from last cycle is charged against last cycle
 *   B. crossing the cap MID-TRANSACTION (hit_cap) and a post-cap deal
 *   C. ANNIVERSARY ROLLOVER — no window covers the deal's date: a NEW cycle at $0 is opened (the total restarts)
 *   D. the anniversary comes from the AGREEMENT, else the brokerage basis on the seat's start date — never a Jan-1 reset unless said
 *   E. an AGREEMENT CHANGE mid-cycle — the agreement in force on the deal's date sets the cap
 *   F. cap-ELIGIBLE contributions — a fee the agreement lists stops at the cap; an unlisted fee / the royalty never does
 *   G. REFUNDS / CORRECTIONS — a reversal, an adjustment and a void move the cycle by what the contribution changed
 *   H. FAIL CLOSED — a refused ledger read, overlapping windows, and a counter that moved underneath a calculation
 *   I. the TEAM cap window is the deal's too
 *
 * BLIND SPOTS (published beside the number): the in-memory client models the query grammar and update().select() counts, NOT
 * RLS, triggers, CHECKs or numeric types (cap_paid_to_date is a JS number here, numeric live — the compare-and-swap predicate
 * relies on PostgREST comparing numeric to the value it returned); m850's columns are seeded as if applied (the pre-apply path
 * reads them as absent = the defaults, which section D asserts); a cap-eligible FEE correction is not moved automatically
 * (fee rows do not record their kind — reported as a finding, asserted in G); Stripe / QuickBooks / bank events are not exercised.
 */
import "./canaries/_harness"
import { canaryClient, setSvc, uuid } from "./canaries/_harness"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))
const cents = (n: unknown) => Math.round(Number(n) * 100)
type Rows = Record<string, Array<Record<string, any>>>

interface Deal { B: string; A: string; U: string; T: string; C: string; close: string; terms?: Record<string, unknown>; versions?: Array<{ effective_from: string; terms: Record<string, unknown> }>; caps?: Array<Record<string, unknown>>; brokerage?: Record<string, unknown>; agent?: Record<string, unknown>; extra?: Rows }
const newDeal = (o: Partial<Deal> = {}): Deal => ({ B: uuid(), A: uuid(), U: uuid(), T: uuid(), C: uuid(), close: "2026-08-15", ...o })
function seed(d: Deal): Rows {
  const terms = { split_percent: 70, is_active: true, ...(d.terms ?? {}) }
  return {
    brokerages: [{ id: d.B, revenue_share_enabled: false, created_at: "2018-01-01T00:00:00Z", ...(d.brokerage ?? {}) }],
    agents: [{ id: d.A, brokerage_id: d.B, user_id: d.U, team_id: null, created_at: "2019-09-01T12:00:00Z", anniversary_date: "2019-09-01", ...(d.agent ?? {}) }],
    transactions: [{ id: d.T, brokerage_id: d.B, agent_id: d.A, purchase_price: 400_000, commission_percentage: 3, close_date: d.close, status: "closed", contact_id: d.C }],
    commission_structures: [{ id: uuid(), brokerage_id: d.B, is_default: true, is_active: true, base_percentage: 3 }],
    agent_commission_profiles: [{ id: uuid(), agent_id: d.A, brokerage_id: d.B, effective_date: "2026-01-01", ...terms }],
    agent_commission_profile_versions: (d.versions ?? [{ effective_from: "2025-01-01", terms }]).map((v) => ({ id: uuid(), agent_id: d.A, brokerage_id: d.B, effective_from: v.effective_from, terms: { ...terms, ...v.terms }, recorded_at: `${v.effective_from}T00:00:00Z` })),
    agent_cap_tracking: (d.caps ?? []).map((c) => ({ id: uuid(), agent_id: d.A, brokerage_id: d.B, is_capped: false, ...c })),
    commission_adjustments: [], referrals: [], contract_signatures: [],
    ...(d.extra ?? {}),
  }
}
async function run(d: Deal, s: Rows = seed(d), opts: Parameters<typeof canaryClient>[1] = {}, mode: "final" | "preview" = "final", patch?: (svc: ReturnType<typeof canaryClient>) => void) {
  const svc = canaryClient(s as never, opts)
  if (patch) patch(svc)
  setSvc(svc)
  const { calculateCommission } = await import("../lib/commission/engine")
  const w = console.warn; console.warn = () => {}
  const e = console.error; console.error = () => {}
  try { return { r: await calculateCommission({ transactionId: d.T, brokerageId: d.B, calculationMode: mode, triggeredBy: null }), svc } }
  finally { console.warn = w; console.error = e }
}
const rows = (svc: ReturnType<typeof canaryClient>, t: string) => ((svc.tables as Rows)[t] ?? [])
const W_OLD = { anniversary_start: "2025-09-01", anniversary_end: "2026-08-31" }
const W_NEW = { anniversary_start: "2026-09-01", anniversary_end: "2027-08-31" }

async function main() {
  const { planSplitAgainstCap, chargeAgainstCap, planCapContributionCorrection, resolveCapCycleForDeal } = await import("../lib/commission/cap-resolver")
  const { memSupabase } = await import("./in-memory-supabase")

  // ══ A · the deal's cycle ══════════════════════════════════════════════════════════════════════════
  console.log("[A · the cycle is the DEAL's (close 2026-08-15), calculated after the 2026-09-01 anniversary]")
  const a = newDeal({ close: "2026-08-15", caps: [{ ...W_OLD, cap_amount: 20_000, cap_paid_to_date: 19_000 }, { ...W_NEW, cap_amount: 20_000, cap_paid_to_date: 0 }] })
  const ra = await run(a)
  const capRows = rows(ra.svc, "agent_cap_tracking")
  const oldRow = capRows.find((r) => r.anniversary_start === "2025-09-01")!, newRow = capRows.find((r) => r.anniversary_start === "2026-09-01")!
  check("the August deal is priced in LAST cycle (paid $19,000 of $20,000): it CROSSES the cap mid-transaction — brokerage $1,000, agent $8,400 + $2,600 = $11,000, status hit_cap",
    ra.r.success && cents(ra.r.net_to_brokerage) === 100_000 && cents(ra.r.net_to_agent) === 1_100_000 && ra.r.cap_status === "hit_cap", JSON.stringify(ra.r).slice(0, 220))
  check("last cycle's ledger advanced to the cap ($20,000, is_capped) and THIS cycle's row is untouched ($0)", Number(oldRow.cap_paid_to_date) === 20_000 && oldRow.is_capped === true && Number(newRow.cap_paid_to_date) === 0)
  const todayPlan = planSplitAgainstCap({ brokeragePortionCents: 360_000, cycle: { capAmountCents: 2_000_000, paidToDateCents: 0, eligible: ["brokerage_split"] } })
  check("POSITIVE CONTROL: priced against TODAY's window (what stage 07 did at HEAD) the same deal pays the brokerage the full $3,600 (pre_cap) — $2,600 the agent was owed", todayPlan.capStatus === "pre_cap" && todayPlan.brokerageFinalCents === 360_000)
  const ei = rows(ra.svc, "commission_calculations")[0]?.engine_inputs as Record<string, any> | undefined
  check("the calculation FREEZES its cycle: tracking id, the cycle bounds, the as-of date, $1,000 contributed (by type), paid before/after", !!ei?.cap && ei.cap.tracking_id === oldRow.id && ei.cap.cycle_start === "2025-09-01" && ei.cap.as_of === "2026-08-15" && ei.cap.contributed_cents === 100_000 && ei.cap.contributed_by_type_cents?.brokerage_split === 100_000 && ei.cap.paid_before === 19_000 && ei.cap.paid_after === 20_000, JSON.stringify(ei?.cap).slice(0, 300))
  const s07 = code("lib/commission/waterfall/07-apply-cap.ts"), s11 = code("lib/commission/waterfall/11-validate-persist.ts")
  const TODAY_WINDOW = /\.lte\(\s*['"]anniversary_start['"]\s*,\s*nowDate\s*\)/
  check("source: neither stage 07 nor stage 11 filters agent_cap_tracking on a wall-clock `nowDate` window any more (POSITIVE CONTROL: the finder sees the retired shape in a specimen)",
    !TODAY_WINDOW.test(s07) && !TODAY_WINDOW.test(s11) && TODAY_WINDOW.test(`.lte('anniversary_start', nowDate)`))

  // ══ B · post-cap ══════════════════════════════════════════════════════════════════════════════════
  console.log("\n[B · a post-cap deal]")
  const b = newDeal({ close: "2026-05-10", caps: [{ ...W_OLD, cap_amount: 20_000, cap_paid_to_date: 20_000, is_capped: true }] })
  const rb = await run(b)
  check("already capped: the brokerage takes $0 of the split, the agent keeps $12,000, nothing is added to the ledger", rb.r.success && cents(rb.r.net_to_brokerage) === 0 && cents(rb.r.net_to_agent) === 1_200_000 && rb.r.cap_status === "post_cap" && Number(rows(rb.svc, "agent_cap_tracking")[0].cap_paid_to_date) === 20_000)

  // ══ C · anniversary rollover ═════════════════════════════════════════════════════════════════════
  console.log("\n[C · anniversary rollover — no window covers the deal; the total restarts]")
  const c = newDeal({ close: "2026-08-15", brokerage: { default_cap_amount: 20_000, default_cap_anniversary_basis: "agent_start_date" }, caps: [{ anniversary_start: "2024-09-01", anniversary_end: "2025-08-31", cap_amount: 20_000, cap_paid_to_date: 20_000, is_capped: true }] })
  const rc = await run(c)
  const opened = rows(rc.svc, "agent_cap_tracking").find((r) => r.anniversary_start === "2025-09-01")
  check("a NEW cycle 2025-09-01 → 2026-08-31 (the seat's anniversary, rolled forward) is opened at $0 and charged this deal's $3,600 — the brokerage takes its split again (pre_cap)",
    rc.r.success && cents(rc.r.net_to_brokerage) === 360_000 && rc.r.cap_status === "pre_cap" && !!opened && opened.anniversary_end === "2026-08-31" && Number(opened.cap_paid_to_date) === 3_600 && Number(opened.cap_amount) === 20_000, JSON.stringify(rc.r).slice(0, 200))
  check("the expired, capped cycle is left as history (still $20,000, still capped)", Number(rows(rc.svc, "agent_cap_tracking").find((r) => r.anniversary_start === "2024-09-01")!.cap_paid_to_date) === 20_000)
  const T2 = uuid()
  rc.svc.tables.transactions.push({ id: T2, brokerage_id: c.B, agent_id: c.A, purchase_price: 400_000, commission_percentage: 3, close_date: "2026-08-20", status: "closed", contact_id: c.C })
  setSvc(rc.svc)
  const { calculateCommission } = await import("../lib/commission/engine")
  const w0 = console.warn; console.warn = () => {}
  const second = await calculateCommission({ transactionId: T2, brokerageId: c.B, calculationMode: "final", triggeredBy: null })
  console.warn = w0
  check("the NEXT deal in the restarted cycle uses the window just opened ($3,600 → $7,200) — one window, never a second", second.success && Number(opened!.cap_paid_to_date) === 7_200 && rows(rc.svc, "agent_cap_tracking").filter((r) => r.anniversary_start === "2025-09-01").length === 1)
  check("POSITIVE CONTROL: with no cap configured anywhere (no window, no agreement cap, no brokerage default) the deal is honestly uncapped ('n/a')",
    (await run(newDeal({ close: "2026-08-15" }))).r.cap_status === "n/a")

  // ══ D · the anniversary ═════════════════════════════════════════════════════════════════════════
  console.log("\n[D · the anniversary comes from the agreement, else the brokerage basis — never a silent Jan-1 reset]")
  const cycleFor = async (o: { basis?: string; agreementDate?: string | null; anniversary?: string | null; created?: string }, asOf: string) => {
    const BX = "brk-d", AX = "agent-d"
    const mem = memSupabase({
      agent_cap_tracking: [],
      brokerages: [{ id: BX, created_at: "2018-04-01T00:00:00Z", default_cap_amount: 18_000, default_cap_anniversary_basis: o.basis ?? "agent_start_date" }],
      agents: [{ id: AX, brokerage_id: BX, created_at: o.created ?? "2019-09-01T12:00:00Z", anniversary_date: o.anniversary === undefined ? "2019-09-01" : o.anniversary }],
    })
    return resolveCapCycleForDeal(mem as never, { agentId: AX, brokerageId: BX, asOf, terms: o.agreementDate ? { cap_anniversary_date: o.agreementDate } : {} })
  }
  const d1 = await cycleFor({}, "2026-01-15")
  check("the agent's own anniversary (agents.anniversary_date 2019-09-01): a January deal is in 2025-09-01 → 2026-08-31 — NOT reset on January 1", d1.ok && d1.cycle?.start === "2025-09-01" && d1.cycle.end === "2026-08-31")
  const d2 = await cycleFor({ basis: "calendar_year" }, "2026-01-15")
  check("a January 1 cycle only when the brokerage basis SAYS calendar_year (2026-01-01 → 2026-12-31)", d2.ok && d2.cycle?.start === "2026-01-01" && d2.cycle.end === "2026-12-31")
  const d3 = await cycleFor({ basis: "calendar_year", agreementDate: "2020-03-15" }, "2026-01-15")
  check("the AGREEMENT's cap anniversary (2020-03-15) outranks the brokerage's calendar-year basis: 2025-03-15 → 2026-03-14", d3.ok && d3.cycle?.start === "2025-03-15" && d3.cycle.end === "2026-03-14")
  const d4 = await cycleFor({ anniversary: null, created: "2021-06-10T09:00:00Z" }, "2026-01-15")
  check("no anniversary_date stamped (pre-m850 / legacy seat) → the seat's created_at anchors it (2025-06-10 → 2026-06-09)", d4.ok && d4.cycle?.start === "2025-06-10" && d4.cycle.end === "2026-06-09")
  const d5 = await cycleFor({ agreementDate: "2020-02-29" }, "2026-03-01")
  check("a 29 February agreement anniversary clamps to 28 February in a common year (2026-02-28 → 2027-02-27)", d5.ok && d5.cycle?.start === "2026-02-28", JSON.stringify(d5))

  // ══ E · agreement change ════════════════════════════════════════════════════════════════════════
  console.log("\n[E · an agreement change mid-cycle — the agreement in force on the deal's date sets the cap]")
  const versions = [{ effective_from: "2025-01-01", terms: { cap_amount: 20_000 } }, { effective_from: "2026-06-01", terms: { cap_amount: 25_000 } }]
  const e1 = newDeal({ close: "2026-05-15", versions, caps: [{ ...W_OLD, cap_amount: 20_000, cap_paid_to_date: 20_000, is_capped: true }] })
  const re1 = await run(e1)
  check("a MAY deal (the $20,000 agreement in force) is post-cap: brokerage $0", re1.r.success && re1.r.cap_status === "post_cap" && cents(re1.r.net_to_brokerage) === 0)
  const e2 = newDeal({ close: "2026-07-15", versions, caps: [{ ...W_OLD, cap_amount: 20_000, cap_paid_to_date: 20_000, is_capped: true }] })
  const re2 = await run(e2)
  const e2cap = (rows(re2.svc, "commission_calculations")[0]?.engine_inputs as any)?.cap
  check("a JULY deal (the $25,000 agreement in force from 2026-06-01) has $5,000 of room: the brokerage takes its $3,600 again (pre_cap) and the finding says the agreement applied over the ledger's $20,000",
    re2.r.success && re2.r.cap_status === "pre_cap" && cents(re2.r.net_to_brokerage) === 360_000 && e2cap?.cap_source === "agreement" && (e2cap?.findings ?? []).some((f: string) => /agreement applies/.test(f)), JSON.stringify(e2cap).slice(0, 300))

  // ══ F · eligible contributions ══════════════════════════════════════════════════════════════════
  console.log("\n[F · cap-eligible contributions come from the agreement; the royalty and unlisted fees never stop at the cap]")
  const f1 = newDeal({ close: "2026-08-15", terms: { transaction_fee_type: "flat", transaction_fee_value: 500, cap_eligible_contributions: ["brokerage_split", "transaction_fee"] }, caps: [{ ...W_OLD, cap_amount: 20_000, cap_paid_to_date: 16_000 }] })
  const rf1 = await run(f1)
  const feeRows = rows(rf1.svc, "commission_distributions").filter((r) => r.distribution_type === "fee")
  check("a LISTED transaction fee stops at the cap: split $3,600 leaves $400 of room, the $500 fee is charged $400 ($100 waived), the ledger reaches $20,000, status hit_cap",
    rf1.r.success && feeRows.length === 1 && cents(feeRows[0].calculated_amount) === 40_000 && Number(rows(rf1.svc, "agent_cap_tracking")[0].cap_paid_to_date) === 20_000 && rf1.r.cap_status === "hit_cap" && cents(rf1.r.net_to_agent) === 800_000, JSON.stringify(rf1.r).slice(0, 240))
  const f2 = newDeal({ close: "2026-08-15", terms: { transaction_fee_type: "flat", transaction_fee_value: 500 }, caps: [{ ...W_OLD, cap_amount: 20_000, cap_paid_to_date: 16_000 }] })
  const rf2 = await run(f2)
  check("POSITIVE CONTROL: an agreement that is SILENT counts the split alone — the $500 fee is charged in full and counts for nothing (ledger $19,600)",
    rf2.r.success && cents(rows(rf2.svc, "commission_distributions").find((r) => r.distribution_type === "fee")!.calculated_amount) === 50_000 && Number(rows(rf2.svc, "agent_cap_tracking")[0].cap_paid_to_date) === 19_600)
  const f3 = newDeal({ close: "2026-08-15", terms: { royalty_type: "percent", royalty_value: 5 }, caps: [{ ...W_OLD, cap_amount: 20_000, cap_paid_to_date: 20_000, is_capped: true }] })
  const rf3 = await run(f3)
  const roy = rows(rf3.svc, "commission_distributions").filter((r) => r.distribution_type === "royalty")
  check("the ROYALTY is its own row (5 % of the $12,000 gross = $600, funded by the agent, to the brokerage) and a POST-CAP agent still pays it — the cap never applies to an unrelated royalty",
    rf3.r.success && roy.length === 1 && cents(roy[0].calculated_amount) === 60_000 && roy[0].source_of_funds === "agent" && rf3.r.cap_status === "post_cap" && cents(rf3.r.net_to_agent) === 1_140_000, JSON.stringify(rf3.r).slice(0, 220))
  check("…and the distributions still FOOT to the gross of record with the royalty in them ($12,000.00)", rows(rf3.svc, "commission_distributions").reduce((s, r) => s + cents(r.calculated_amount), 0) === 1_200_000)
  const f4 = newDeal({ close: "2026-08-15", terms: { royalty_type: "percent", royalty_value: 5, cap_eligible_contributions: ["brokerage_split", "royalty"] }, caps: [{ ...W_OLD, cap_amount: 20_000, cap_paid_to_date: 19_000 }] })
  const rf4 = await run(f4)
  check("a royalty counts toward the cap ONLY when the agreement lists it: split takes the last $1,000 of room, the $600 royalty is then waived in full", rf4.r.success && rows(rf4.svc, "commission_distributions").filter((r) => r.distribution_type === "royalty").length === 0 && Number(rows(rf4.svc, "agent_cap_tracking")[0].cap_paid_to_date) === 20_000)
  check("pure rule chargeAgainstCap: not eligible → full charge, nothing counted; eligible → charged up to the room, the rest waived",
    JSON.stringify(chargeAgainstCap(500, 400, false)) === JSON.stringify({ chargedCents: 500, waivedCents: 0, countedCents: 0, remainingCents: 400 }) && JSON.stringify(chargeAgainstCap(500, 400, true)) === JSON.stringify({ chargedCents: 400, waivedCents: 100, countedCents: 400, remainingCents: 0 }))

  // ══ G · refunds / corrections ═══════════════════════════════════════════════════════════════════
  console.log("\n[G · refunds and corrections move the cycle by what the contribution changed]")
  const fin = await import("../lib/kernel/financial")
  const ADMIN = uuid()
  const g = newDeal({ close: "2026-08-15", caps: [{ ...W_OLD, cap_amount: 20_000, cap_paid_to_date: 10_000 }] })
  const gs = seed(g); gs.users = [{ id: ADMIN, brokerage_id: g.B, user_type: "broker_owner", email: "b@g.test" }]
  const rg = await run(g, gs)
  const cap = () => Number(rows(rg.svc, "agent_cap_tracking")[0].cap_paid_to_date)
  check("the deal posted pre-cap: the cycle went $10,000 → $13,600", rg.r.success && cap() === 13_600)
  const brokerageRow = rows(rg.svc, "commission_distributions").find((r) => r.distribution_type === "brokerage")!
  brokerageRow.status = "paid"; brokerageRow.paid_at = "2026-08-20T00:00:00Z"
  setSvc(rg.svc)
  const ctx = { userId: ADMIN, agentId: null, brokerageId: g.B, userType: "broker", platformRole: null, isTenantPrincipal: true } as never
  const errLog = console.error; console.error = () => {}
  const adj = await fin.correctCommissionDistribution({ ctx, distributionId: brokerageRow.id, kind: "adjustment", correctedAmount: 3_000, reason: "refund of $600 overcharged split" } as never)
  check("an ADJUSTMENT of the brokerage's entry $3,600 → $3,000 (a $600 refund) takes $600 off the cycle ($13,600 → $13,000), ledgered", adj.success && cap() === 13_000 && (adj as any).data?.capLedger?.capDeltaCents === -60_000 && rows(rg.svc, "agent_action_ledger").some((l) => l.action === "finance.cap_ledger.corrected"), JSON.stringify(adj).slice(0, 300))
  const rev = await fin.correctCommissionDistribution({ ctx, distributionId: brokerageRow.id, kind: "reversal", reason: "deal unwound after closing" } as never)
  check("a REVERSAL of what is left ($3,000) takes the rest of the deal's contribution off ($13,000 → $10,000 — back where the cycle stood before the deal)", rev.success && cap() === 10_000, JSON.stringify(rev).slice(0, 300))
  const agentRow = rows(rg.svc, "commission_distributions").find((r) => r.distribution_type === "agent")!
  agentRow.status = "paid"
  const agentAdj = await fin.correctCommissionDistribution({ ctx, distributionId: agentRow.id, kind: "adjustment", correctedAmount: 8_000, reason: "agent entry correction" } as never)
  check("POSITIVE CONTROL: a correction of the AGENT's entry (not a cap contribution) leaves the cycle alone", agentAdj.success && cap() === 10_000 && ((agentAdj as any).data?.capLedger?.capDeltaCents ?? 0) === 0)
  const gv = newDeal({ close: "2026-08-15", caps: [{ ...W_OLD, cap_amount: 20_000, cap_paid_to_date: 0 }] })
  const gvs = seed(gv); gvs.users = [{ id: ADMIN, brokerage_id: gv.B, user_type: "broker_owner", email: "b@g.test" }]
  const rgv = await run(gv, gvs)
  setSvc(rgv.svc)
  const unpaidBrokerage = rows(rgv.svc, "commission_distributions").find((r) => r.distribution_type === "brokerage")!
  const voided = await fin.voidCommissionDistribution({ ctx: { ...(ctx as object), brokerageId: gv.B } as never, distributionId: unpaidBrokerage.id, reason: "posted in error" })
  check("a VOID of the unpaid brokerage entry takes its $3,600 back off the cycle ($3,600 → $0)", voided.success && Number(rows(rgv.svc, "agent_cap_tracking")[0].cap_paid_to_date) === 0, JSON.stringify(voided).slice(0, 300))
  console.error = errLog
  check("pure rule planCapContributionCorrection: a raise never passes the cap (the excess is REPORTED — the agent is owed it); a refund never takes paid-to-date below 0",
    JSON.stringify(planCapContributionCorrection({ contributedCents: 100, originalEntryCents: 100, netBeforeCents: 100, netAfterCents: 500, capAmountCents: 1_000, paidToDateCents: 800 })) === JSON.stringify({ capDeltaCents: 200, excessCents: 200 })
    && planCapContributionCorrection({ contributedCents: 500, originalEntryCents: 500, netBeforeCents: 500, netAfterCents: 0, capAmountCents: 1_000, paidToDateCents: 300 }).capDeltaCents === -300)

  // ══ H · fail closed ═════════════════════════════════════════════════════════════════════════════
  console.log("\n[H · fail closed]")
  const h1 = newDeal({ close: "2026-08-15", caps: [{ ...W_OLD, cap_amount: 20_000, cap_paid_to_date: 20_000 }] })
  const rh1 = await run(h1, seed(h1), { refuse: { agent_cap_tracking: "permission denied for table agent_cap_tracking" } })
  check("a REFUSED cap-ledger read fails the calculation by name and posts nothing (it used to price a capped agent as uncapped — the brokerage collecting a split it had stopped taking)",
    rh1.r.success === false && /cap ledger could not be read/.test(rh1.r.error ?? "") && rows(rh1.svc, "commission_distributions").length === 0 && rows(rh1.svc, "agent_commissions").length === 0, rh1.r.error)
  const h2 = newDeal({ close: "2026-08-15", caps: [{ ...W_OLD, cap_amount: 20_000, cap_paid_to_date: 0 }, { anniversary_start: "2026-01-01", anniversary_end: "2026-12-31", cap_amount: 20_000, cap_paid_to_date: 0 }] })
  const rh2 = await run(h2)
  check("OVERLAPPING windows covering the deal's date are refused by name (never one picked at random)", rh2.r.success === false && /cap ledger windows cover/.test(rh2.r.error ?? ""), rh2.r.error)
  const h3 = newDeal({ close: "2026-08-15", caps: [{ ...W_OLD, cap_amount: 20_000, cap_paid_to_date: 18_000 }] })
  let bumped = false
  const rh3 = await run(h3, seed(h3), {}, "final", (svc) => {
    const orig = svc.from.bind(svc)
    ;(svc as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const b = orig(t) as unknown as { update: (p: Record<string, unknown>) => unknown }
      if (t !== "agent_cap_tracking" || bumped) return b
      const u = b.update.bind(b)
      b.update = (p: Record<string, unknown>) => { bumped = true; ((svc.tables as Rows).agent_cap_tracking[0]).cap_paid_to_date = 19_500; return u(p) }
      return b
    }
  })
  check("a COUNTER THAT MOVED underneath the calculation (another deal posted against the same cycle) refuses the compare-and-swap: nothing posted, the other deal's figure kept — a cap is never crossed twice",
    rh3.r.success === false && /moved while this deal was calculated/.test(rh3.r.error ?? "") && rows(rh3.svc, "commission_distributions").length === 0 && Number(rows(rh3.svc, "agent_cap_tracking")[0].cap_paid_to_date) === 19_500, rh3.r.error)
  const pre = await run(newDeal({ close: "2026-08-15", caps: [{ ...W_OLD, cap_amount: 20_000, cap_paid_to_date: 1_000 }] }), undefined, {}, "preview")
  check("a PREVIEW prices the cycle and moves NOTHING", pre.r.success && pre.r.preview === true && Number(rows(pre.svc, "agent_cap_tracking")[0].cap_paid_to_date) === 1_000)

  // ══ I · team cap window ═════════════════════════════════════════════════════════════════════════
  console.log("\n[I · the TEAM cap window is the deal's too]")
  const s08 = code("lib/commission/waterfall/08-team-split.ts")
  const TEAM_TODAY = /const today = new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\s*\n\s*const \{ data, error \} = await supabase\s*\n\s*\.from\('team_cap_tracking'\)/
  check("stage 08's team-cap read and stage 11's team-cap write judge the window on the deal's as-of date (POSITIVE CONTROL: the retired wall-clock shape is recognised in a specimen)",
    !TEAM_TODAY.test(s08) && /context\.agreement\?\.asOf/.test(s08) && /teamNowDate = context\.agreement\?\.asOf/.test(s11)
    && TEAM_TODAY.test(`const today = new Date().toISOString().slice(0, 10)\n  const { data, error } = await supabase\n    .from('team_cap_tracking')`))

  console.log("\nBLIND SPOTS: in-memory client (no RLS / triggers / CHECKs / numeric types); m850 columns seeded as applied; a cap-eligible FEE")
  console.log("  correction is reported, not moved (fee rows carry no kind); the team cap is proved on source for the window date, behaviourally by test:team-cap.")
  console.log(`\nRESULT: ${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`)
  if (failures.length) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)) }
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
