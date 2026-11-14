#!/usr/bin/env tsx
/**
 * scripts/quarterly-tax-concierge-simulator.ts   (npm run test:quarterly-tax-concierge)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the AUTONOMOUS quarterly-tax concierge — the Finance Manager acting.
 *
 * WAVE 153 (lane 153A): the concierge now drives THE ONE estimator (lib/finance/tax-planning.ts buildTaxPlan) and no
 * longer invents a rate. This proof runs the REAL runQuarterlyTaxConcierge end-to-end on the in-memory supabase client
 * (profile read → the agent's own commissions + own-book expenses → plan → dedupe → notification) for these shapes:
 *   solo agent with entered rates · seat with NO rates (coaching reminder, no amount) · team lead whose team revenue is
 *   large (never counted as personal) · agent with no income · fiscal-year filer · a person who entered their own Q3
 *   date · a quarter already recorded in full · a refused profile read · a refused dedupe read · a second run.
 * PURE: upcomingQuarterlyDue with the rolled IRS dates and the person's own schedule. SOURCE: cron + registry wiring.
 * LIVE layer is credentials-gated (read only).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { memSupabase, type MemClient, type Row } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"
import { upcomingQuarterlyDue, runQuarterlyTaxConcierge } from "../lib/finance/quarterly-tax-concierge"
import { applyAssumptionChange, buildTaxPlan, parseTaxAssumptions, recognizeCommissionIncome, sumDeductibleExpenses } from "../lib/finance/tax-planning"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: unknown) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[upcomingQuarterlyDue · pure — fires only inside the window, on the person's real date]")
  const q3 = upcomingQuarterlyDue("2026-09-05", 12)
  check("10 days before Sep 15 ⇒ Q3 due detected", q3?.quarter === 3 && q3?.dueDate === "2026-09-15" && q3?.daysUntil === 10)
  check("far from any due date ⇒ null (no-op)", upcomingQuarterlyDue("2026-07-20", 12) === null)
  const q4 = upcomingQuarterlyDue("2027-01-10", 12)
  check("early Jan ⇒ prior-year Q4 due Jan 15 detected", q4?.quarter === 4 && q4?.taxYear === 2026 && q4?.dueDate === "2027-01-15")
  check("the DUE DATE itself is still in-window (0 days)", upcomingQuarterlyDue("2026-06-15", 12)?.quarter === 2)
  check("just past a due date ⇒ null (not overdue-spamming)", upcomingQuarterlyDue("2026-06-16", 12) === null)
  const rolled = upcomingQuarterlyDue("2024-09-10", 12)
  check("the ROLLED date is used: Q3 2024 falls on Sunday Sep 15 → due Mon Sep 16 (6 days out)", rolled?.dueDate === "2024-09-16" && rolled?.daysUntil === 6, rolled)
  const own = parseTaxAssumptions(applyAssumptionChange({}, { key: "dueDateOverride", quarter: 3, value: "2026-10-15" }, { source: "accountant_supplied", taxYear: 2026, userId: "u", now: "2026-01-01T00:00:00Z" }).ok ? (applyAssumptionChange({}, { key: "dueDateOverride", quarter: 3, value: "2026-10-15" }, { source: "accountant_supplied", taxYear: 2026, userId: "u", now: "2026-01-01T00:00:00Z" }) as any).next : {})
  check("a person's own Q3 date (Oct 15) replaces the rule: nothing due on Sep 5, due on Oct 10", upcomingQuarterlyDue("2026-09-05", 12, own) === null && upcomingQuarterlyDue("2026-10-10", 12, own)?.dueDate === "2026-10-15")
}

// ─── the in-memory world ──────────────────────────────────────────────────────
const T = "tenant-1"
const ID = (n: number) => `ag-${n}`
function stored(changes: Array<[any, "self_entered" | "accountant_supplied"]>) {
  let s: Record<string, unknown> = {}
  for (const [c, source] of changes) { const r = applyAssumptionChange(s, c, { source, taxYear: 2026, userId: "u", now: "2026-02-01T00:00:00Z" }); if (!r.ok) throw new Error(r.error); s = r.next }
  return s
}
const RATES = stored([[{ key: "federalRate", value: 0.22 }, "self_entered"], [{ key: "stateRate", value: 0.05 }, "self_entered"]])
const comm = (agentId: string, amount: number, paid: string) => ({ agent_id: agentId, agent_commission: amount, close_date: paid, paid_at: `${paid}T12:00:00Z`, status: "paid" })

function world(opts: { refuse?: Record<string, string>; extra?: Record<string, Row[]> } = {}): MemClient {
  return memSupabase({
    agents: [
      { id: ID(1), user_id: "u-solo", brokerage_id: T },        // solo agent, rates entered
      { id: ID(2), user_id: "u-seat", brokerage_id: T },        // team seat, NO rates
      { id: ID(3), user_id: "u-lead", brokerage_id: T },        // team lead, rates entered
      { id: ID(4), user_id: "u-noincome", brokerage_id: T },    // no income
      { id: ID(5), user_id: "u-fiscal", brokerage_id: T },      // fiscal year starting July
      { id: ID(6), user_id: "u-owndate", brokerage_id: T },     // entered their own Q3 date
      { id: ID(7), user_id: "u-recorded", brokerage_id: T },    // Q3 already recorded in full (accountant target)
    ],
    agent_tax_profile: [
      { agent_id: ID(1), tax_year: 2026, quarterly_payments: [{ quarter: 1, amount: 1500, kind: "payment" }, { quarter: 2, amount: 1500, kind: "payment" }], assumptions: RATES },
      { agent_id: ID(3), tax_year: 2026, quarterly_payments: [], assumptions: RATES },
      { agent_id: ID(5), tax_year: 2026, quarterly_payments: [], assumptions: stored([[{ key: "federalRate", value: 0.22 }, "self_entered"], [{ key: "stateRate", value: 0.05 }, "self_entered"], [{ key: "fiscalYearStartMonth", value: 7 }, "accountant_supplied"]]) },
      { agent_id: ID(6), tax_year: 2026, quarterly_payments: [], assumptions: stored([[{ key: "federalRate", value: 0.22 }, "self_entered"], [{ key: "stateRate", value: 0.05 }, "self_entered"], [{ key: "dueDateOverride", quarter: 3, value: "2026-10-15" }, "accountant_supplied"]]) },
      { agent_id: ID(7), tax_year: 2026, quarterly_payments: [{ quarter: 3, amount: 4000, kind: "payment" }], assumptions: stored([[{ key: "accountantTarget", quarter: 3, value: 4000 }, "accountant_supplied"], [{ key: "accountantTarget", quarter: 4, value: 4000 }, "accountant_supplied"]]) },
    ],
    agent_commissions: [
      comm(ID(1), 40000, "2026-04-10"), comm(ID(1), 20000, "2026-07-22"),
      comm(ID(2), 30000, "2026-05-05"),
      comm(ID(3), 25000, "2026-06-01"),
      comm(ID(5), 30000, "2026-08-01"), comm(ID(6), 30000, "2026-08-01"), comm(ID(7), 30000, "2026-08-01"),
    ],
    business_expenses: [
      { agent_id: ID(1), amount: 3000, category: "marketing", expense_date: "2026-03-01" },
      { agent_id: null, team_id: "team-1", amount: 50000, category: "office", expense_date: "2026-03-01" }, // a team's books: never personal
    ],
    // A team's consolidated revenue — present, large, and NEVER counted as the lead's personal income.
    team_earnings: [{ team_id: "team-1", gross_commission: 900000, team_net: 400000 }],
    notifications: [],
    ...(opts.extra ?? {}),
  }, { uuidIds: true, stampCreatedAt: true, refuse: opts.refuse })
}
const notesFor = (w: MemClient, userId: string) => w.tables.notifications.filter((n) => n.user_id === userId && n.type === "quarterly_tax_reminder")

async function runLayer() {
  console.log("\n[the concierge end-to-end — real loader, real plan, real dedupe (in-memory, SIMULATED)]")
  const w = world()
  const r = await runQuarterlyTaxConcierge(T, w, { today: "2026-09-05", windowDays: 12 })
  check("ran for the tenant's agents, no errors, Q3 2026 is the quarter", r.agentsConsidered === 7 && r.errors.length === 0 && r.dueQuarter === "2026-Q3", r)
  const solo = notesFor(w, "u-solo")
  // Recompute the solo agent's Q3 suggestion with THE SAME exported functions — the reminder must quote exactly it.
  const a1 = parseTaxAssumptions(RATES)
  const plan1 = buildTaxPlan({ taxYear: 2026, today: "2026-09-05", assumptions: a1, income: recognizeCommissionIncome([comm(ID(1), 40000, "2026-04-10"), comm(ID(1), 20000, "2026-07-22")], "cash", { from: "2026-01-01", to: "2026-09-05" }), expenses: sumDeductibleExpenses([{ amount: 3000, category: "marketing" }], null), recorded: [{ quarter: 1, amount: 1500 }, { quarter: 2, amount: 1500 }] })
  const q3amount = plan1.quarterly[2].suggested!
  const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
  check("solo agent with rates: ONE reminder quoting exactly the plan's Q3 suggestion, labelled a planning reserve, nothing auto-paid",
    solo.length === 1 && solo[0].title.includes(usd(q3amount)) && /suggested tax reserve/.test(solo[0].title) && /not the amount legally due/.test(solo[0].body) && /Nothing is paid automatically/.test(solo[0].body), { title: solo[0]?.title, q3amount })
  check("deductibility is never assumed: the solo agent's unconfirmed 3,000 marketing does not reduce the estimate", plan1.periodToDate.net === 60000)
  const seat = notesFor(w, "u-seat")
  check("seat with NO rates: a coaching reminder (enter your rates / accountant's amount) with NO dollar amount", seat.length === 1 && /add your rates/.test(seat[0].title) && !/\$\d/.test(seat[0].title + seat[0].body) && /don't guess personal tax rates/.test(seat[0].body), seat[0])
  check("the counts separate amount reminders from input reminders", r.remindersSent >= 2 && r.inputRemindersSent === 1, r)
  const leadNote = notesFor(w, "u-lead")
  const planLead = buildTaxPlan({ taxYear: 2026, today: "2026-09-05", assumptions: a1, income: recognizeCommissionIncome([comm(ID(3), 25000, "2026-06-01")], "cash", { from: "2026-01-01", to: "2026-09-05" }), expenses: sumDeductibleExpenses([], null), recorded: [] })
  check("team lead: the amount comes from THEIR OWN 25,000 commission — not the team's 900,000 revenue or the team's books", leadNote.length === 1 && leadNote[0].title.includes(usd(planLead.quarterly[2].suggested!)), { title: leadNote[0]?.title, expected: planLead.quarterly[2].suggested })
  check("no income recorded → no reminder", notesFor(w, "u-noincome").length === 0)
  check("fiscal-year filer (July start): their dates are Oct/Dec/Mar/Jul, so nothing on Sep 5", notesFor(w, "u-fiscal").length === 0)
  check("a person who entered Oct 15 for Q3 gets nothing on Sep 5 (never the calendar date over theirs)", notesFor(w, "u-owndate").length === 0)
  check("a quarter already recorded in full (accountant's 4,000 paid) → no reminder", notesFor(w, "u-recorded").length === 0)
  const again = await runQuarterlyTaxConcierge(T, w, { today: "2026-09-05", windowDays: 12 })
  check("idempotent: a second run the same window sends 0 new reminders of either kind", again.remindersSent === 0 && again.inputRemindersSent === 0 && w.tables.notifications.length === solo.length + seat.length + leadNote.length)
  const later = await runQuarterlyTaxConcierge(T, w, { today: "2026-10-10", windowDays: 12 })
  check("the own-date person is reminded inside THEIR window (Oct 10 for Oct 15)", notesFor(w, "u-owndate").length === 1 && later.remindersSent >= 1)

  const refusedProfile = world({ refuse: { agent_tax_profile: "permission denied" } })
  const rp = await runQuarterlyTaxConcierge(T, refusedProfile, { today: "2026-09-05", windowDays: 12 })
  check("ADVERSE: profile reads refused → every agent skipped with an error, NO reminder sent on guessed numbers", rp.remindersSent === 0 && rp.inputRemindersSent === 0 && rp.errors.length > 0 && refusedProfile.tables.notifications.length === 0, rp)
  const refusedDedupe = world()
  const proxied = new Proxy(refusedDedupe, { get(t, prop, rcv) {
    if (prop !== "from") return Reflect.get(t, prop, rcv)
    return (table: string) => { const b = t.from(table) as any; if (table !== "notifications") return b; return new Proxy(b, { get(bt, p2, r2) { if (p2 === "select") return () => ({ eq: () => ({ eq: () => ({ gte: () => ({ limit: async () => ({ data: null, error: { message: "permission denied" } }) }) }) }) }); return Reflect.get(bt, p2, r2) } }) }
  } }) as MemClient
  const rd = await runQuarterlyTaxConcierge(T, proxied, { today: "2026-09-05", windowDays: 12 })
  check("ADVERSE: the dedupe read refused → no reminder (never risk a duplicate), reported", rd.remindersSent === 0 && rd.inputRemindersSent === 0 && refusedDedupe.tables.notifications.length === 0 && rd.errors.some((e) => /dedupe/.test(e)), rd)
  const other = world()
  const ro = await runQuarterlyTaxConcierge("tenant-unrelated", other, { today: "2026-09-05", windowDays: 12 })
  check("ADVERSE: another tenant's run reads none of this tenant's agents", ro.agentsConsidered === 0 && other.tables.notifications.length === 0)
}

function sourceLayer() {
  console.log("\n[wiring — autonomous, finance-owned, tenant option, honest]")
  const runner = stripComments(src("lib/finance/quarterly-tax-concierge.ts"))
  check("the runner builds each plan with THE ONE estimator from the agent's own commissions and own-book expenses", /from\("agent_commissions"\)[\s\S]*?\.eq\("agent_id", a\.id\)/.test(runner) && /from\("business_expenses"\)[\s\S]*?\.eq\("agent_id", a\.id\)/.test(runner) && /buildTaxPlan\(/.test(runner))
  check("no second rate engine and no fallback rate in the runner", !/set_aside_percent|estimated_effective_rate|\?\?\s*0\.12|\?\?\s*25\b/.test(runner))
  check("PC: the fallback scan catches the old shape", /\?\?\s*25\b/.test("Number((profile as any)?.set_aside_percent ?? 25)"))
  const cron = src("lib/kernel/cron-dispatch.ts")
  check("the daily cron is registered", /quarterly-tax-concierge/.test(cron))
  const route = src("app/api/cron/quarterly-tax-concierge/route.ts")
  check("the cron route verifies cron auth + records the run (incl. input reminders)", /verifyCronAuth/.test(route) && /inputReminders/.test(route))
  check("TENANT OPTION — the cron selects ONLY brokerages with tax assistance enabled (fail-closed opt-in)",
    /from\("brokerages"\)[\s\S]*?\.eq\("tax_assistance_enabled", true\)/.test(route))
  const reg = src("lib/kernel/manager-registry.ts")
  check("the burn domain is owned by the Finance Manager with a runnable proof", /quarterly_tax_concierge:\s*\{\s*manager:\s*"finance_manager",\s*proof:\s*"test:quarterly-tax-concierge"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — the run layer drove the real runner on the in-memory client"); return }
  const svc = createClient(url, key)
  console.log("\n[live] read only — the columns the runner reads exist")
  const { error } = await svc.from("agent_tax_profile").select("tax_year, quarterly_payments, assumptions").limit(1)
  check("live: agent_tax_profile.assumptions is readable (m901 applied)", !error, error?.message)
}

async function main() {
  pureLayer()
  await runLayer()
  sourceLayer()
  await liveLayer()
  console.log("\nBLIND SPOTS: SIMULATED — the in-memory client stands in for the database; the cron route itself (auth + run record) is checked on source; reminders are in-app notifications (no email/SMS is sent by this runner).")
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ QUARTERLY_TAX_CONCIERGE_FAIL"); process.exit(1) }
  console.log(" ✅ QUARTERLY_TAX_CONCIERGE_PASS — each person is reminded on their real date with the one plan's suggestion, or asked for their rates; never an invented amount")
}
main()
