#!/usr/bin/env tsx
/**
 * scripts/expense-office-rollup-guard.ts (npm run test:expense-office-rollup) — wave 153, lane 153A.
 * ─────────────────────────────────────────────────────────────────────────────
 * MULTI-LOCATION EXPENSES. Owner (2026-11-14, verbatim): "expesnses for multiple location brokerage tenants. each
 * location takes care of expenses but all can roll up to the main tenant."
 *
 * Drives the REAL survivors on the in-memory supabase client (scripts/in-memory-supabase.ts):
 *   lib/finance/expense-rollup.ts   resolveBooksAuthority · authorizeBooksWrite · loadExpenseRollup ·
 *                                   allocateSharedExpenseCore · officeChoicesFor · expenseDeleteVerdict
 *   lib/kernel/resolve-user-office.ts resolveViewerHierarchy (the C34 hierarchy, reached through the survivor above)
 * plus stripped-source checks of the wiring that needs a Next session (logScopedExpense, deleteExpense,
 * allocateSharedExpense, the accounting egress business unit, the page) and of migration m900.
 *
 * Tenant shapes: multi-location owner (tenant leadership grant) · office admin A · office admin B · managing broker of A
 * (not on a books roster) · compliance officer with tenant leadership (reads, never keeps) · broker WITHOUT a grant on a
 * multi-location tenant (C34: user_type never widens) · team lead · plain agent · single-office broker · single-office
 * agent · unrelated tenant. SIMULATED — no live database; the DB-side 100% rule (m900's deferred constraint trigger) is
 * asserted on the migration text, not executed.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"
import { stripComments, blankStrings } from "./strip-comments"
import {
  resolveBooksAuthority, authorizeBooksWrite, loadExpenseRollup, allocateSharedExpenseCore, officeChoicesFor,
  expenseDeleteVerdict, reversalSearchPattern, BOOKS_WRITE_COPY, ALLOCATION_COPY,
} from "../lib/finance/expense-rollup"
import { reversalMarker } from "../lib/documents/receipt-rules"

const ROOT = process.cwd()
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")
let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`) }
}

// ─── fixtures ─────────────────────────────────────────────────────────────────
const M = "11111111-1111-4111-8111-111111111111" // multi-location tenant
const S = "22222222-2222-4222-8222-222222222222" // single-office tenant
const U = "33333333-3333-4333-8333-333333333333" // unrelated tenant
const OA = "aaaaaaaa-0000-4000-8000-00000000000a", OB = "bbbbbbbb-0000-4000-8000-00000000000b", OX = "cccccccc-0000-4000-8000-00000000000c", OS = "dddddddd-0000-4000-8000-00000000000d"
const E = (n: number) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, "0")}`
const V = (id: string, brokerageId: string, userType: string) => ({ userId: id, brokerageId, userType })
const owner = V("u-owner", M, "broker_owner"), adminA = V("u-admin-a", M, "admin"), adminB = V("u-admin-b", M, "admin")
const mgrA = V("u-mgr-a", M, "agent"), compliance = V("u-compliance", M, "compliance_officer"), brokerNoGrant = V("u-broker-nogrant", M, "broker")
const lead = V("u-lead", M, "team_lead"), agentM = V("u-agent-m", M, "agent")
const brokerS = V("u-broker-s", S, "broker"), agentS = V("u-agent-s", S, "agent"), otherU = V("u-other", U, "broker")

function world(extra: { refuse?: Record<string, string>; expenses?: Row[]; allocations?: Row[] } = {}): MemClient {
  const users = [owner, adminA, adminB, mgrA, compliance, brokerNoGrant, lead, agentM, brokerS, agentS, otherU].map((v) => ({
    id: v.userId, brokerage_id: v.brokerageId, user_type: v.userType,
    location_id: v === adminA ? OA : v === adminB ? OB : null,
  }))
  const leadership = (u: string) => ({ id: `om-${u}`, brokerage_id: M, user_id: u, scope_kind: "tenant", location_id: null, team_id: null, access_level: "leadership", revoked_at: null })
  return memSupabase({
    brokerages: [{ id: M, plan_tier: "multi_location" }, { id: S, plan_tier: "brokerage" }, { id: U, plan_tier: "brokerage" }],
    users,
    locations: [
      { id: OA, brokerage_id: M, name: "North office", status: "active", managing_broker_user_id: mgrA.userId, settings: {} },
      { id: OB, brokerage_id: M, name: "South office", status: "active", managing_broker_user_id: null, settings: {} },
      { id: OS, brokerage_id: S, name: "Only office", status: "active", managing_broker_user_id: null, settings: {} },
      { id: OX, brokerage_id: U, name: "Other tenant office", status: "active", managing_broker_user_id: null, settings: {} },
    ],
    teams: [{ id: "team-a", brokerage_id: M, location_id: OA, team_lead_id: lead.userId, deleted_at: null }],
    organization_members: [leadership(owner.userId), leadership(compliance.userId)],
    business_expenses: extra.expenses ?? [],
    business_expense_allocations: extra.allocations ?? [],
  }, { uuidIds: true, refuse: extra.refuse })
}

// The books of tenant M for the rollup (every figure below is checked to the cent).
const EXPENSES: Row[] = [
  { id: E(1), brokerage_id: M, agent_id: null, team_id: null, location_id: OA, amount: 1000, expense_date: "2026-03-02", category: "office", description: "North office rent" },
  { id: E(2), brokerage_id: M, agent_id: null, team_id: null, location_id: OB, amount: 500, expense_date: "2026-03-03", category: "office", description: "South office rent" },
  { id: E(3), brokerage_id: M, agent_id: null, team_id: null, location_id: null, amount: 1000.01, expense_date: "2026-03-04", category: "technology", description: "Company CRM (shared)" },
  { id: E(4), brokerage_id: M, agent_id: null, team_id: null, location_id: null, amount: 300, expense_date: "2026-03-05", category: "marketing", description: "Brand campaign (not split)" },
  { id: E(5), brokerage_id: M, agent_id: null, team_id: "team-a", location_id: OA, amount: 50, expense_date: "2026-03-06", category: "education", description: "Team A training" },
  { id: E(6), brokerage_id: M, agent_id: null, team_id: null, location_id: null, amount: -100, expense_date: "2026-04-01", category: "technology", description: `Refund — CRM ${reversalMarker(E(3))}` },
  { id: E(7), brokerage_id: M, agent_id: "agent-row", team_id: null, location_id: null, amount: 999, expense_date: "2026-03-07", category: "marketing", description: "An agent's own book (never tenant books)" },
  { id: E(8), brokerage_id: M, agent_id: null, team_id: null, location_id: OA, amount: -100, expense_date: "2026-04-02", category: "office", description: `Credit — rent ${reversalMarker(E(1))}` },
  { id: E(9), brokerage_id: M, agent_id: null, team_id: null, location_id: OB, amount: 77, expense_date: "2025-12-31", category: "office", description: "Last year (outside the window)" },
  { id: E(10), brokerage_id: U, agent_id: null, team_id: null, location_id: OX, amount: 5000, expense_date: "2026-03-02", category: "office", description: "Another tenant's rent" },
]
const ALLOC_E3: Row[] = [
  { id: "al-1", brokerage_id: M, expense_id: E(3), allocation_set_id: "set-1", location_id: OA, share_bps: 4000, allocated_amount: 400.01, rule_label: "headcount", superseded_at: null },
  { id: "al-2", brokerage_id: M, expense_id: E(3), allocation_set_id: "set-1", location_id: OB, share_bps: 4000, allocated_amount: 400, rule_label: "headcount", superseded_at: null },
  { id: "al-3", brokerage_id: M, expense_id: E(3), allocation_set_id: "set-1", location_id: null, share_bps: 2000, allocated_amount: 200, rule_label: "headcount", superseded_at: null },
  { id: "al-0", brokerage_id: M, expense_id: E(3), allocation_set_id: "set-0", location_id: OA, share_bps: 10000, allocated_amount: 1000.01, rule_label: "old rule", superseded_at: "2026-03-10T00:00:00Z" },
]
const YEAR = { from: "2026-01-01", to: "2026-12-31" }

async function main() {
  console.log("\n[1 · who keeps / reads which books — the C34 hierarchy × the books roster]")
  {
    const w = world()
    const a = async (v: typeof owner) => { const r = await resolveBooksAuthority(w, v); return r }
    const o = await a(owner), aa = await a(adminA), mg = await a(mgrA), co = await a(compliance), bn = await a(brokerNoGrant), ld = await a(lead), ag = await a(agentM), bs = await a(brokerS), as_ = await a(agentS)
    check("multi-location owner (tenant leadership): consolidated, keeps every office + the main office", o.ok && o.multiLocation && o.consolidated && o.writeCentral && o.writeOffices.length === 2, o)
    check("office admin pinned to North: reads/writes North only, no consolidated view, no main office", aa.ok && !aa.consolidated && !aa.writeCentral && JSON.stringify(aa.writeOffices) === JSON.stringify([OA]) && JSON.stringify(aa.readOffices) === JSON.stringify([OA]), aa)
    check("managing broker of North who is NOT on a books roster: reads North, writes nothing", mg.ok && JSON.stringify(mg.readOffices) === JSON.stringify([OA]) && mg.writeOffices.length === 0 && !mg.writeCentral, mg)
    check("compliance officer with tenant leadership: reads the consolidated books, keeps none (m467)", co.ok && co.consolidated && !co.writeCentral && co.writeOffices.length === 0, co)
    check("ADVERSE: a broker on a multi-location tenant with NO grant and NO office — nothing (user_type never widens, C34)", bn.ok && !bn.consolidated && bn.readOffices.length === 0 && !bn.writeCentral, bn)
    check("ADVERSE: team lead — no company books (m472), plain agent — none", ld.ok && !ld.consolidated && ld.writeOffices.length === 0 && ag.ok && !ag.consolidated && ag.readOffices.length === 0)
    check("single-office tenant: the broker keeps the books exactly as before (roster), the agent does not", bs.ok && !bs.multiLocation && bs.consolidated && bs.writeCentral && as_.ok && !as_.consolidated && !as_.writeCentral)
    const x = await resolveBooksAuthority(w, { ...otherU, brokerageId: M })
    check("ADVERSE: a user of another tenant asking about this tenant → refused (not a member)", !x.ok, x)
    const refused = await resolveBooksAuthority(world({ refuse: { organization_members: "permission denied" } }), owner)
    check("ADVERSE: a refused hierarchy read → refused (fail closed), never 'may write'", !refused.ok, refused)
  }

  console.log("\n[2 · the writer's office gate (authorizeBooksWrite — logScopedExpense calls it before the insert)]")
  {
    const w = world()
    const g = (v: typeof owner, scope: "agent" | "team" | "brokerage", locationId: string | null, teamId?: string) => authorizeBooksWrite(w, v, { scope, locationId, teamId })
    const r1 = await g(adminA, "brokerage", OA)
    check("office admin → their own office: allowed, stamped North", r1.ok && r1.locationId === OA, r1)
    const r2 = await g(adminA, "brokerage", OB)
    check("ADVERSE: office admin → ANOTHER office: refused cross_location_write", !r2.ok && r2.code === "cross_location_write", r2)
    const r3 = await g(adminA, "brokerage", null)
    check("ADVERSE: office admin → the main office's books: refused forbidden_central_books", !r3.ok && r3.code === "forbidden_central_books", r3)
    const r4 = await g(owner, "brokerage", null), r5 = await g(owner, "brokerage", OB)
    check("owner → main office (no office) and → South office: both allowed", r4.ok && r4.locationId === null && r5.ok && r5.locationId === OB)
    const r6 = await g(brokerNoGrant, "brokerage", null)
    check("ADVERSE: broker without a grant on a multi-location tenant → main office refused", !r6.ok && r6.code === "forbidden_central_books", r6)
    const r7 = await g(owner, "brokerage", OX)
    check("ADVERSE: an office of ANOTHER tenant → refused location_not_in_tenant", !r7.ok && r7.code === "location_not_in_tenant", r7)
    const r8 = await g(agentM, "agent", OA)
    check("ADVERSE: an agent's own book with an office → refused (agent books never roll up)", !r8.ok && r8.code === "agent_books_have_no_office", r8)
    const r9 = await g(lead, "team", null, "team-a"), r10 = await g(lead, "team", OB, "team-a")
    check("team row → stamped with the team's office; naming a different office → refused team_office_mismatch", r9.ok && r9.locationId === OA && !r10.ok && r10.code === "team_office_mismatch", { r9, r10 })
    const r11 = await authorizeBooksWrite(world({ refuse: { locations: "permission denied" } }), owner, { scope: "brokerage", locationId: OA })
    check("ADVERSE: offices unreadable → refused books_authority_unavailable (fail closed)", !r11.ok && r11.code === "books_authority_unavailable", r11)
    const r12 = await g(brokerS, "brokerage", null), r13 = await g(agentS, "brokerage", null)
    check("single-office: broker → company books allowed; agent → refused forbidden_brokerage_scope (the old code, unchanged)", r12.ok && !r13.ok && r13.code === "forbidden_brokerage_scope", { r12, r13 })
    const r14 = await authorizeBooksWrite(w, { ...otherU, brokerageId: M }, { scope: "brokerage", locationId: OA })
    check("ADVERSE: unrelated tenant user writing this tenant's office → refused", !r14.ok, r14)
    check("every refusal code has plain tenant copy (no internals)", Object.values(BOOKS_WRITE_COPY).every((c) => c.length > 20 && !/(pgrst|sql|rls|supabase|error:)/i.test(c)))
  }

  console.log("\n[3 · the rollup — office totals + main office + company total, every source row counted ONCE]")
  {
    const w = world({ expenses: EXPENSES, allocations: ALLOC_E3 })
    const res = await loadExpenseRollup(w, owner, YEAR)
    const r = res.ok ? res.rollup : null
    const north = r?.offices.find((o) => o.locationId === OA), south = r?.offices.find((o) => o.locationId === OB)
    // North: own 1000 − credit 100 = 900 (its team's 50 stays on the TEAM's book); shares 400.01 − 40 (CRM refund split by the same shares) = 360.01.
    check("North office: own 900.00 (rent − the rent credit), share 360.01, total 1,260.01", !!north && north.owned === 900 && north.allocatedIn === 360.01 && north.total === 1260.01, north)
    check("South office: own 500.00, share 360.00, total 860.00", !!south && south.owned === 500 && south.allocatedIn === 360 && south.total === 860, south)
    check("main office: 300.00 not split, 180.00 its own retained share (200 − 20 of the refund)", r?.centralUnallocated === 300 && r?.centralRetained === 180, r)
    check("company total 2,600.01 = offices + main office, to the cent (A + B + central = consolidated)", r?.tenantTotal === 2600.01 && r?.balanced === true && Math.round(((north?.total ?? 0) + (south?.total ?? 0) + (r?.centralUnallocated ?? 0) + (r?.centralRetained ?? 0)) * 100) === 260001, r)
    check("the shared cost is ONE row (no copied rows), the superseded split is ignored; the agent's own book, the TEAM's book (owner: team financials do not roll up), last year and the other tenant's row are all excluded", r?.rowsCounted === 6, r?.rowsCounted)
    check("refunds / credits are netted and counted (2 reversals, −200.00)", r?.reversals.count === 2 && r?.reversals.amount === -200, r?.reversals)
    const adminView = await loadExpenseRollup(w, adminA, YEAR)
    check("office admin sees ONLY North (own + its share), no South line, no company or main-office totals", adminView.ok && adminView.rollup.offices.length === 1 && adminView.rollup.offices[0].locationId === OA && adminView.rollup.offices[0].total === 1260.01 && adminView.rollup.tenantTotal === null && adminView.rollup.centralUnallocated === null, adminView.ok ? adminView.rollup : adminView)
    const mgrView = await loadExpenseRollup(w, mgrA, YEAR)
    check("managing broker (not on a roster) reads North only", mgrView.ok && mgrView.rollup.offices.length === 1 && mgrView.rollup.offices[0].locationId === OA)
    const compView = await loadExpenseRollup(w, compliance, YEAR)
    check("compliance officer reads the consolidated rollup", compView.ok && compView.rollup.consolidated && compView.rollup.tenantTotal === 2600.01)
    const agentView = await loadExpenseRollup(w, agentM, YEAR), leadView = await loadExpenseRollup(w, lead, YEAR), noGrant = await loadExpenseRollup(w, brokerNoGrant, YEAR)
    check("ADVERSE: plain agent, team lead and an ungranted broker on a multi-location tenant → no company books", !agentView.ok && !leadView.ok && !noGrant.ok && !agentView.ok && agentView.error === "no_books_in_scope")
    const other = await loadExpenseRollup(w, { ...otherU, brokerageId: M }, YEAR)
    check("ADVERSE: unrelated tenant → refused", !other.ok)
    const blind = await loadExpenseRollup(world({ expenses: EXPENSES, allocations: ALLOC_E3, refuse: { business_expenses: "permission denied" } }), owner, YEAR)
    check("ADVERSE: a refused expense read → an error, never a confident $0", !blind.ok && /expenses read refused/.test(blind.ok ? "" : blind.error), blind)
    const noAlloc = await loadExpenseRollup(world({ expenses: EXPENSES, allocations: ALLOC_E3, refuse: { business_expense_allocations: "permission denied" } }), owner, YEAR)
    check("ADVERSE: a refused allocation read → an error (never silently 'nothing split')", !noAlloc.ok)
    const q1 = await loadExpenseRollup(w, owner, { from: "2026-01-01", to: "2026-03-31" })
    check("recognition date: a Q1 window counts the March rows only (refunds dated April fall in Q2)", q1.ok && q1.rollup.tenantTotal === 2800.01 && q1.rollup.reversals.count === 0, q1.ok ? q1.rollup.tenantTotal : q1)
    const single = await loadExpenseRollup(world({ expenses: [{ id: E(20), brokerage_id: S, agent_id: null, team_id: null, location_id: null, amount: 42, expense_date: "2026-05-01", category: "office", description: "Single-office cost" }] }), brokerS, YEAR)
    check("single-office tenant: consolidated, the whole cost on the company (main) books", single.ok && single.rollup.tenantTotal === 42 && single.rollup.centralUnallocated === 42 && !single.authority.multiLocation)
  }

  console.log("\n[4 · splitting a shared cost — explicit allocation facts totaling 100%, the source never copied]")
  {
    const w = world({ expenses: EXPENSES.map((e) => ({ ...e })), allocations: ALLOC_E3.map((a) => ({ ...a })) })
    const ok = await allocateSharedExpenseCore(w, owner, { expenseId: E(4), shares: [{ locationId: OA, shareBps: 3333 }, { locationId: OB, shareBps: 3333 }, { locationId: null, shareBps: 3334 }], ruleLabel: "brand campaign by office count" })
    const rows = w.tables.business_expense_allocations.filter((a) => a.expense_id === E(4) && !a.superseded_at)
    check("owner splits the 300.00 campaign 33.33 / 33.33 / 33.34% → three facts that total 300.00 exactly", ok.ok && rows.length === 3 && Math.round(rows.reduce((s, a) => s + a.allocated_amount, 0) * 100) === 30000 && rows.reduce((s, a) => s + a.share_bps, 0) === 10000, { ok, rows })
    check("the source expense row is untouched and still ONE row", w.tables.business_expenses.filter((e) => e.id === E(4)).length === 1 && w.tables.business_expenses.find((e) => e.id === E(4))!.amount === 300)
    const after = await loadExpenseRollup(w, owner, YEAR)
    check("after the split the company total is unchanged (2,600.01) and still balanced — moved between lines, never doubled", after.ok && after.rollup.tenantTotal === 2600.01 && after.rollup.balanced && after.rollup.centralUnallocated === 0, after.ok ? after.rollup : after)
    const re = await allocateSharedExpenseCore(w, owner, { expenseId: E(4), shares: [{ locationId: OB, shareBps: 10000 }], ruleLabel: "moved to South" })
    const hist = w.tables.business_expense_allocations.filter((a) => a.expense_id === E(4))
    check("re-splitting supersedes the old set (kept as history, superseded_by recorded) and writes the new one", re.ok && re.superseded === 3 && hist.filter((a) => a.superseded_at).length === 3 && hist.filter((a) => a.superseded_at).every((a) => a.superseded_by_user_id === owner.userId) && hist.filter((a) => !a.superseded_at).length === 1)
    const bad = async (shares: Array<{ locationId: string | null; shareBps: number }>, expenseId = E(4), v = owner, rule = "r") => allocateSharedExpenseCore(w, v, { expenseId, shares, ruleLabel: rule })
    const notHundred = await bad([{ locationId: OA, shareBps: 6000 }, { locationId: OB, shareBps: 3000 }])
    check("ADVERSE: shares totaling 90% → refused shares_not_100_percent, nothing written", !notHundred.ok && notHundred.code === "shares_not_100_percent")
    const dup = await bad([{ locationId: OA, shareBps: 5000 }, { locationId: OA, shareBps: 5000 }])
    check("ADVERSE: the same office twice → refused duplicate_target", !dup.ok && dup.code === "duplicate_target")
    const foreign = await bad([{ locationId: OX, shareBps: 10000 }])
    check("ADVERSE: an office of another tenant → refused location_not_in_tenant", !foreign.ok && foreign.code === "location_not_in_tenant")
    const officeRow = await bad([{ locationId: OB, shareBps: 10000 }], E(1))
    check("ADVERSE: an office's own expense cannot be split (only main-office costs) → not_a_central_expense", !officeRow.ok && officeRow.code === "not_a_central_expense")
    const refund = await bad([{ locationId: OA, shareBps: 10000 }], E(6))
    check("ADVERSE: a refund is not split on its own (it follows its original) → reversal_not_allocatable", !refund.ok && refund.code === "reversal_not_allocatable")
    const noRule = await bad([{ locationId: OA, shareBps: 10000 }], E(4), owner, "  ")
    check("ADVERSE: no documented rule → refused rule_required", !noRule.ok && noRule.code === "rule_required")
    const asAdmin = await bad([{ locationId: OA, shareBps: 10000 }], E(4), adminA)
    check("ADVERSE: an office admin cannot split a main-office cost → forbidden_central_books", !asAdmin.ok && asAdmin.code === "forbidden_central_books")
    const asCompliance = await bad([{ locationId: OA, shareBps: 10000 }], E(4), compliance)
    check("ADVERSE: the compliance officer reads but cannot split → forbidden_central_books", !asCompliance.ok && asCompliance.code === "forbidden_central_books")
    const otherTenant = await bad([{ locationId: OA, shareBps: 10000 }], E(10))
    check("ADVERSE: another tenant's expense reads as absent → expense_not_found", !otherTenant.ok && otherTenant.code === "expense_not_found")
    // A refused INSERT after the old set was retired leaves the cost UNALLOCATED on the main office — never doubled.
    const base = world({ expenses: EXPENSES.map((e) => ({ ...e })), allocations: ALLOC_E3.map((a) => ({ ...a })) })
    const flaky = new Proxy(base, { get(t, prop, r) {
      if (prop !== "from") return Reflect.get(t, prop, r)
      return (table: string) => { const b = t.from(table) as any; if (table !== "business_expense_allocations") return b; return new Proxy(b, { get(bt, p2, r2) { if (p2 === "insert") return () => ({ select: async () => ({ data: null, error: { message: "insert refused" } }) }); return Reflect.get(bt, p2, r2) } }) }
    } }) as MemClient
    const broken = await allocateSharedExpenseCore(flaky, owner, { expenseId: E(3), shares: [{ locationId: OB, shareBps: 10000 }], ruleLabel: "move" })
    const afterBroken = await loadExpenseRollup(base, owner, YEAR)
    check("ADVERSE: the new split refused after the old was retired → reported insert_refused; the CRM cost is wholly back on the main office and the company total is unchanged (never doubled)",
      !broken.ok && broken.code === "insert_refused" && afterBroken.ok && afterBroken.rollup.tenantTotal === 2600.01 && afterBroken.rollup.balanced && afterBroken.rollup.centralUnallocated === 300 + 1000.01 - 100, afterBroken.ok ? afterBroken.rollup : afterBroken)
    check("every allocation refusal has plain tenant copy", Object.values(ALLOCATION_COPY).every((c) => c.length > 20 && !/(pgrst|sql|rls|supabase|error:)/i.test(c)))
  }

  console.log("\n[5 · the office picker every entry surface shows (officeChoicesFor)]")
  {
    const w = world()
    const a = await officeChoicesFor(w, adminA), o = await officeChoicesFor(w, owner), s = await officeChoicesFor(w, brokerS)
    check("office admin: only North, a choice is required, no main-office option", a.required && !a.mainOfficeAllowed && JSON.stringify(a.choices) === JSON.stringify([{ id: OA, name: "North office" }]), a)
    check("owner: both offices + the main-office option", o.required && o.mainOfficeAllowed && o.choices.length === 2, o)
    check("single-office tenant: no office question", !s.required, s)
    const r = await officeChoicesFor(world({ refuse: { locations: "permission denied" } }), owner)
    check("ADVERSE: refused read → 'required, no choices' (the surface asks instead of posting office-less)", r.required && r.choices.length === 0 && !r.mainOfficeAllowed)
  }

  console.log("\n[6 · paid / closed rows are immutable — a correction is a reversal, never a delete]")
  {
    check("a refund / credit row cannot be deleted", !expenseDeleteVerdict({ description: `Refund ${reversalMarker(E(3))}`, receiptUrl: null, reversalCount: 0, activeAllocationCount: 0 }).ok)
    check("an expense with a refund against it cannot be deleted", !expenseDeleteVerdict({ description: "Rent", receiptUrl: null, reversalCount: 1, activeAllocationCount: 0 }).ok)
    check("an expense posted from an approved receipt (paid) cannot be deleted", !expenseDeleteVerdict({ description: "Office Depot", receiptUrl: "/dashboard/financials/expenses/receipts/doc-1", reversalCount: 0, activeAllocationCount: 0 }).ok)
    check("an expense offices carry a share of cannot be deleted", !expenseDeleteVerdict({ description: "CRM", receiptUrl: null, reversalCount: 0, activeAllocationCount: 3 }).ok)
    check("PC: a plain typed expense with no trail can still be deleted by its owner", expenseDeleteVerdict({ description: "Parking", receiptUrl: null, reversalCount: 0, activeAllocationCount: 0 }).ok)
    check("the reversal finder pattern is the writer's own marker", reversalSearchPattern(E(3)) === `%${reversalMarker(E(3))}%`)
  }

  console.log("\n[7 · the wiring that needs a Next session — stripped source, every absence with a positive control]")
  {
    const fin = stripComments(src("app/actions/financials.ts"))
    const finCode = blankStrings(fin)
    const body = (code: string, name: string) => { const i = code.indexOf(`export async function ${name}(`); if (i < 0) return ""; const j = code.indexOf("\nexport ", i + 10); return code.slice(i, j < 0 ? undefined : j) }
    const writer = body(fin, "logScopedExpense")
    const gateAt = writer.indexOf("authorizeBooksWrite("), insertAt = writer.indexOf('.from("business_expenses").insert(row)')
    check("logScopedExpense asks authorizeBooksWrite BEFORE its insert and refuses with its code", gateAt > 0 && insertAt > gateAt && /if \(!officeGate\.ok\)[\s\S]{0,300}return \{ success: false, error: officeGate\.code\b/.test(writer))
    check("the refusal carries the plain sentence a person sees (BOOKS_WRITE_COPY), and the entry form shows it", /message: BOOKS_WRITE_COPY\[officeGate\.code\]/.test(writer) && /result\.message \?\? result\.error/.test(stripComments(src("app/dashboard/financials/brokerage/scoped-expense-entry.tsx"))))
    check("PC: a writer that inserts before the gate is caught", (() => { const w = 'x.from("business_expenses").insert(row); authorizeBooksWrite('; return !(w.indexOf("authorizeBooksWrite(") < w.indexOf('.insert(row)')) })())
    check("the office it returns is the office stamped (never a body value)", /if \(officeGate\.locationId\) row\.location_id = officeGate\.locationId/.test(writer) && !/row\.location_id\s*=\s*input\.locationId/.test(writer))
    check("a reversal inherits its original's office and a different office is refused", /select\("location_id"\)[\s\S]{0,200}eq\("brokerage_id", ctx\.brokerageId\)[\s\S]{0,400}reversal_scope_mismatch/.test(writer))
    check("the egress push carries the office (business unit)", /pushExpenseToAccounting\(svc, \{[\s\S]{0,700}locationId: \(row\.location_id/.test(writer))
    check("the viewer handed to the gate is the SESSION (ctx), never input", /authorizeBooksWrite\(\s*svc,\s*\{ userId: ctx\.userId, brokerageId: ctx\.brokerageId, userType: ctx\.userType/.test(writer))
    const del = body(fin, "deleteExpense")
    const refuseAt = del.search(/if \(!closed\.ok\) return \{ success: false, error: closed\.message \}/)
    check("deleteExpense checks the closed-row verdict and RETURNS its refusal BEFORE it deletes", del.indexOf("expenseDeleteVerdict(") > 0 && refuseAt > del.indexOf("expenseDeleteVerdict(") && refuseAt < del.indexOf(".delete()"))
    check("deleteExpense's reads fail closed (a refused read refuses the delete)", /if \(targetErr\) return \{ success: false/.test(del) && /if \(revErr\) return \{ success: false/.test(del))
    const alloc = body(fin, "allocateSharedExpense")
    check("allocateSharedExpense: session actor, FINANCIAL ledger evidence, the core writer inside it", /getAgentContext\(\)/.test(alloc) && /withActionLedger\(/.test(alloc) && /riskClass: "FINANCIAL"/.test(alloc) && /allocateSharedExpenseCore\(svc, \{ userId: ctx\.userId, brokerageId/.test(alloc) && !/input\.brokerageId/.test(alloc))
    check("the idempotency key includes the prior split, so re-applying an earlier split after a change still writes", /idempotencyKey: `expense_allocation:\$\{input\.expenseId\}:\$\{priorSet\}:\$\{shareKey\}`/.test(alloc))
    void finCode
    const egress = stripComments(src("lib/finance/accounting-egress.ts"))
    check("egress: office expense with books that track offices but no mapping → BUSINESS_UNIT_NOT_MAPPED sync error (not filed under the company)", /expense\.locationId && unit\.tracked && !unit\.departmentRef/.test(egress) && /errorCode: "BUSINESS_UNIT_NOT_MAPPED"/.test(egress))
    check("egress: the mapping is read from the office's own settings, tenant-pinned, and a refused read refuses the push", /from\("locations"\)\.select\("id, settings"\)\.eq\("brokerage_id", brokerageId\)/.test(egress) && /if \(!unit\.ok\)/.test(egress))
    check("egress: the snapshot a retry reads records the office and the unit", /location_id: expense\.locationId \?\? null/.test(egress) && /failed\.payload\.business_unit =/.test(egress))
    // Wave 153, lane 153G (carried 153A Outside-lane 2): the QuickBooks Purchase builder SENDS the office's location. The provider
    // module imports "server-only" (plain tsx cannot load it), so the emission is proved on its stripped source: createPurchase
    // takes departmentRef and puts it on the payload as QuickBooks' DepartmentRef ONLY when one is mapped (company level otherwise).
    const qboSrc = stripComments(src("lib/providers/accounting/quickbooks.ts"))
    const purchaseBody = (s: string) => { const i = s.indexOf("async createPurchase("); if (i < 0) return ""; const j = s.indexOf("async createJournalEntry(", i); return s.slice(i, j < 0 ? undefined : j) }
    const DEPT_EMIT = /departmentRef\?: string[\s\S]{0,400}\.\.\.\(params\.departmentRef \? \{ DepartmentRef: \{ value: params\.departmentRef \} \} : \{\}\)/
    check("QuickBooks Purchase: createPurchase takes the office's departmentRef and emits DepartmentRef only when mapped (lane 153G)", DEPT_EMIT.test(purchaseBody(qboSrc)))
    check("PC: a Purchase builder that drops the department is caught", !DEPT_EMIT.test(`async createPurchase(params: { amount: number }) { const payload = { PaymentType: "Cash" } } async createJournalEntry(`))
    const intake = stripComments(src("lib/documents/receipt-intake.ts"))
    check("receipt approval HOLDS a multi-location company-books receipt until an office is named (driven in test:receipt-intelligence §17)", /receiptOfficeDecision\(svc, actor/.test(intake) && /Which office is this expense for\?/.test(intake))
    const page = stripComments(src("app/dashboard/financials/brokerage/page.tsx"))
    check("the brokerage page mounts the office rollup and scopes its recent company expenses by the books authority", /<OfficeExpenseRollupSection/.test(page) && /booksAuth\.consolidated/.test(page) && /booksAuth\.readOffices\.includes\(office\)/.test(page))
    const section = stripComments(src("app/dashboard/financials/brokerage/office-expense-rollup.tsx"))
    check("the office section reads THE ONE reader and renders a refusal as 'could not be loaded', never $0", /loadExpenseRollup\(svc, \{ userId, brokerageId, userType \}/.test(section) && /could not be loaded/.test(section))
    const m900 = src("supabase/migrations/m900-expense-office-attribution-and-shared-allocations.sql")
    // The RULE, not the waypoint (CLAUDE.md §2): line 1 is a STATUS line — the lane's WRITTEN-NOT-APPLIED line until the integrator
    // applies it, then the integrator's APPLIED LIVE stamp naming this lane. Either is true at its moment; nothing else is.
    check("m900 line 1 is a status line — the charter's WRITTEN-NOT-APPLIED line (no mNNN token) or the integrator's APPLIED LIVE stamp for lane 153A", m900.split("\n")[0] === "-- WRITTEN, NOT APPLIED (wave 153, lane 153A) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL" || /^-- ── APPLIED LIVE \d{4}-\d{2}-\d{2} via Supabase MCP \(project hrvaqgvukzxfskkcrwbt\) — wave 153, lane 153A ── read back: \S/.test(m900.split("\n")[0]))
    check("m900 enforces the 100% rule at commit (deferred constraint trigger: 10000 bps AND the source amount)", /CREATE CONSTRAINT TRIGGER business_expense_allocations_balance_trg[\s\S]*DEFERRABLE INITIALLY DEFERRED/.test(m900) && /v_bps <> 10000/.test(m900) && /round\(v_sum, 2\) <> round\(v_exp\.amount, 2\)/.test(m900))
    check("m900 refuses an office on an agent's own book and an office of another tenant (trigger)", /agent's own book carries no office|agent''s own book carries no office/.test(m900) && /l\.brokerage_id = NEW\.brokerage_id/.test(m900))
    check("m900 carries a ROLLBACK note and writes no DROP COLUMN / DROP INDEX itself (those are owner SQL)", /-- ROLLBACK:/.test(m900) && !/^\s*(ALTER TABLE[^;]*DROP COLUMN|DROP INDEX)/m.test(m900.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")))
    const pkg = JSON.parse(src("package.json")) as { scripts: Record<string, string> }
    check("package.json registers this proof and the guard chain runs it", /expense-office-rollup-guard\.ts/.test(pkg.scripts["test:expense-office-rollup"] ?? "") && /npm run test:expense-office-rollup\b/.test(pkg.scripts.guard ?? ""))
  }

  console.log("\nBLIND SPOTS: SIMULATED on the in-memory client — m900's deferred 100% trigger and RLS policy are asserted on the migration text, not executed (the integrator applies m900); logScopedExpense / deleteExpense / allocateSharedExpense need a Next session, so their wiring is proved on stripped source and their gates by driving the real survivors they call; the QuickBooks Purchase builder sends DepartmentRef (lane 153G — proved on stripped source, the provider is server-only; no live QuickBooks call) and retrySyncError does not yet re-read location_id (Outside-lane request); the brokerage P&L page's OTHER sections (commissions, production) still show the whole company to any finance-roster user on a multi-location tenant — out of this lane's ownership, reported.")
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); console.log(`\nRESULT: ${passed} passed, ${failed + 1} failed`); process.exit(1) })
