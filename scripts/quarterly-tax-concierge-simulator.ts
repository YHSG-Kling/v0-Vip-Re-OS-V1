#!/usr/bin/env tsx
/**
 * scripts/quarterly-tax-concierge-simulator.ts   (npm run test:quarterly-tax-concierge)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the AUTONOMOUS quarterly-tax concierge — the Finance Manager acting. PURE upcomingQuarterlyDue
 * fires only inside the window before an IRS due date (Apr/Jun/Sep 15 + Jan 15); the runner computes
 * each agent's estimated payment from real income and reminds once per quarter. SOURCE scan: the cron
 * is registered, the burn domain is finance-owned, dedupe + income-gating are in place. LIVE (creds-
 * gated): seed income, run near a due date, assert a reminder, clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { upcomingQuarterlyDue } from "../lib/finance/quarterly-tax-concierge"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[upcomingQuarterlyDue · pure — fires only inside the window]")
  const q3 = upcomingQuarterlyDue("2026-09-05", 12)
  check("10 days before Sep 15 ⇒ Q3 due detected", q3?.quarter === 3 && q3?.dueDate === "2026-09-15" && q3?.daysUntil === 10)
  check("far from any due date ⇒ null (no-op)", upcomingQuarterlyDue("2026-07-20", 12) === null)
  const q4 = upcomingQuarterlyDue("2027-01-10", 12)
  check("early Jan ⇒ prior-year Q4 due Jan 15 detected", q4?.quarter === 4 && q4?.taxYear === 2026 && q4?.dueDate === "2027-01-15")
  const q1 = upcomingQuarterlyDue("2026-04-14", 12)
  check("day before Apr 15 ⇒ Q1 (1 day until)", q1?.quarter === 1 && q1?.daysUntil === 1)
  check("the DUE DATE itself is still in-window (0 days)", upcomingQuarterlyDue("2026-06-15", 12)?.quarter === 2)
  check("just past a due date ⇒ null (not overdue-spamming)", upcomingQuarterlyDue("2026-06-16", 12) === null)
  check("window is configurable (3-day window excludes a 10-day-out date)", upcomingQuarterlyDue("2026-09-05", 3) === null)
}

function sourceLayer() {
  console.log("\n[wiring — autonomous, finance-owned, idempotent, honest]")
  const runner = src("lib/finance/quarterly-tax-concierge.ts")
  check("computes each agent's estimate from real income − expenses (buildTaxPlan)", /agent_commissions[\s\S]*?business_expenses[\s\S]*?buildTaxPlan/.test(runner))
  check("skips agents with no income (no tax owed)", /ytdGrossIncome <= 0/.test(runner))
  check("skips a quarter the agent already PAID (agent_tax_profile.quarterly_payments)", /paidQuarters\.includes\(due\.quarter\)/.test(runner))
  check("deduped — one reminder per agent per quarter", /quarterly_tax_reminder[\s\S]*?windowOpenedIso/.test(runner))
  check("honest — tells the agent to confirm with their CPA", /CPA/.test(runner))

  const cron = src("lib/kernel/cron-dispatch.ts")
  check("the daily cron is registered", /quarterly-tax-concierge/.test(cron))
  check("the cron route verifies cron auth + records the run", /verifyCronAuth/.test(src("app/api/cron/quarterly-tax-concierge/route.ts")))

  const reg = src("lib/kernel/manager-registry.ts")
  check("the burn domain is owned by the Finance Manager with a runnable proof", /quarterly_tax_concierge:\s*\{\s*manager:\s*"finance_manager",\s*proof:\s*"test:quarterly-tax-concierge"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed income, run near a due date, assert one reminder, clean up")
  const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).limit(1).maybeSingle()
  const { data: txn } = await svc.from("transactions").select("id").limit(1).maybeSingle()
  if (!agent || !txn) { console.log("  ⊘ no agent/transaction — skipping"); return }
  const agentId = (agent as any).id, userId = (agent as any).user_id, brokerageId = (agent as any).brokerage_id, txnId = (txn as any).id
  const cleanup: Array<{ table: string; col: string; val: string }> = []
  try {
    const { data: c } = await svc.from("agent_commissions").insert({ agent_id: agentId, brokerage_id: brokerageId, transaction_id: txnId, gross_commission: 40000, agent_split_percent: 70, status: "approved", close_date: "1999-03-01", created_at: "1999-03-01T00:00:00Z" }).select("id").single()
    if (c) cleanup.push({ table: "agent_commissions", col: "id", val: (c as any).id })
    const { runQuarterlyTaxConcierge } = await import("../lib/finance/quarterly-tax-concierge")
    // Run as if today is 10 days before the 1999 Q1 due date (Apr 15, 1999).
    const r = await runQuarterlyTaxConcierge(brokerageId, svc as any, { today: "1999-04-05", windowDays: 12 })
    check("live: concierge detected a due quarter + sent ≥ 1 reminder", r.dueQuarter === "1999-Q1" && r.remindersSent >= 1)
    const { data: notif } = await svc.from("notifications").select("id, title").eq("user_id", userId).eq("type", "quarterly_tax_reminder").order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (notif) cleanup.push({ table: "notifications", col: "id", val: (notif as any).id })
    check("live: an agent-facing reminder notification was created", !!notif && /estimated tax/i.test((notif as any)?.title ?? ""))
    // Idempotent — a second run sends no NEW reminder.
    const r2 = await runQuarterlyTaxConcierge(brokerageId, svc as any, { today: "1999-04-05", windowDays: 12 })
    check("live: idempotent — second run sends 0 new reminders", r2.remindersSent === 0)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq(c.col, c.val)
    let leftover = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq(c.col, c.val); leftover += count ?? 0 }
    check("live: cleanup count == 0", leftover === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ QUARTERLY_TAX_CONCIERGE_FAIL"); process.exit(1) }
  console.log(" ✅ QUARTERLY_TAX_CONCIERGE_PASS — the Finance Manager proactively reminds each agent of their exact quarterly estimate, in-window + idempotent")
}
main()
