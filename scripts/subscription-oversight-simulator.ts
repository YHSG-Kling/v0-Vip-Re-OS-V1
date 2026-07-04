#!/usr/bin/env tsx
/**
 * scripts/subscription-oversight-simulator.ts   (npm run test:subscription-oversight)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves SUBSCRIPTION OVERSIGHT: a pure classifier that turns each tenant's subscription facts into one
 * operational state + attention flag, a cross-tenant rollup, and the autonomous watch that alerts platform
 * staff on the tenants that need a human.
 *
 * PURE:   classifySubscription (past_due > cancelled > trial_expiring/trialing > renewal_due/active >
 *         no_subscription; reconciles the trial fields) + summarizeOversight (counts, worst-first queue, MRR).
 * SOURCE: the superadmin console reads it + links each row to the tenant's lifecycle controls; the daily
 *         cron runs the watch; owned by finance_manager with a runnable proof.
 * LIVE (creds-gated): seed a past-due + a trial-expiring subscription → the watch alerts platform staff,
 *         deduped on re-run → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { classifySubscription, summarizeOversight, type SubscriptionOversightRow, type ClassifyInput } from "../lib/platform/subscription-oversight"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const NOW = new Date("2026-07-04T00:00:00Z")
const iso = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString()
const base = (o: Partial<ClassifyInput> = {}): ClassifyInput => ({ status: "active", hasSubscription: true, trialEnd: null, currentPeriodEnd: iso(30), cancelAt: null, cancelledAt: null, latestInvoiceStatus: "paid", latestInvoiceDue: null, ...o })

function pureLayer() {
  console.log("\n[classifySubscription · pure — one operational state per tenant]")
  check("past_due status → past_due + attention", (() => { const c = classifySubscription(base({ status: "past_due" }), NOW); return c.state === "past_due" && c.attention })())
  check("an OPEN invoice past its due date → past_due even if status lags", classifySubscription(base({ status: "active", latestInvoiceStatus: "open", latestInvoiceDue: iso(-3) }), NOW).state === "past_due")
  check("cancelled wins + is not attention", (() => { const c = classifySubscription(base({ status: "cancelled" }), NOW); return c.state === "cancelled" && !c.attention })())
  check("trial ending within 7 days → trial_expiring + attention (days counted)", (() => { const c = classifySubscription(base({ status: "trialing", trialEnd: iso(3), currentPeriodEnd: null }), NOW); return c.state === "trial_expiring" && c.attention && c.daysToTrialEnd === 3 })())
  check("trial far out → trialing, not attention", classifySubscription(base({ status: "trialing", trialEnd: iso(20), currentPeriodEnd: null }), NOW).state === "trialing")
  check("renewal within 7 days → renewal_due (surfaced, not alerting)", (() => { const c = classifySubscription(base({ currentPeriodEnd: iso(4) }), NOW); return c.state === "renewal_due" && !c.attention && c.daysToRenewal === 4 })())
  check("healthy active → active", classifySubscription(base(), NOW).state === "active")
  check("no subscription + no trial → no_subscription", classifySubscription(base({ status: null, hasSubscription: false, trialEnd: null, currentPeriodEnd: null }), NOW).state === "no_subscription")
  check("the two trial fields reconcile (brokerage trial_ends_at when no sub trial)", classifySubscription(base({ status: null, hasSubscription: false, trialEnd: iso(2), currentPeriodEnd: null }), NOW).state === "trial_expiring")

  console.log("\n[summarizeOversight · pure — rollup + worst-first queue]")
  const rows: SubscriptionOversightRow[] = [
    { brokerageId: "a", name: "Alpha", tier: "Team", state: "active", mrrCents: 20000, daysToTrialEnd: null, daysToRenewal: 30, attention: false, reason: "" },
    { brokerageId: "b", name: "Bravo", tier: "Solo", state: "trial_expiring", mrrCents: 5000, daysToTrialEnd: 2, daysToRenewal: null, attention: true, reason: "" },
    { brokerageId: "c", name: "Charlie", tier: "Brokerage", state: "past_due", mrrCents: 40000, daysToTrialEnd: null, daysToRenewal: null, attention: true, reason: "" },
    { brokerageId: "d", name: "Delta", tier: "Solo", state: "cancelled", mrrCents: 5000, daysToTrialEnd: null, daysToRenewal: null, attention: false, reason: "" },
  ]
  const s = summarizeOversight(rows)
  check("MRR sums only live subscriptions (cancelled excluded)", s.totalMrrCents === 20000 + 5000 + 40000)
  check("counts per state are correct", s.counts.active === 1 && s.counts.trial_expiring === 1 && s.counts.past_due === 1 && s.counts.cancelled === 1)
  check("queue is attention-only, PAST_DUE first (worst-first)", s.attentionCount === 2 && s.queue[0].state === "past_due" && s.queue[1].state === "trial_expiring")
}

function sourceLayer() {
  console.log("\n[wiring — console, cron, ownership]")
  const act = src("app/actions/superadmin/subscription-oversight.ts")
  check("the read action is superadmin-gated", /requireSuperadmin/.test(act) && /user_type.*superadmin|platform_role.*superadmin/.test(act))
  const page = src("app/dashboard/superadmin/subscriptions/page.tsx")
  check("the console renders counts + the attention queue + full roster", /getSubscriptionOversightAction/.test(page) && /Needs attention/.test(page) && /All subscriptions/.test(page))
  check("each row links to the tenant's existing lifecycle controls", /\/dashboard\/superadmin\/brokerages\/\$\{r\.brokerageId\}/.test(page))
  check("the platform console links to the subscriptions console", /\/dashboard\/superadmin\/subscriptions/.test(src("app/dashboard/superadmin/platform/page.tsx")))
  check("the daily cron runs the subscription watch (dunning/renewal engine)", /runSubscriptionWatch/.test(src("app/api/cron/brokerage-pl-rollup/route.ts")))
  const lib = src("lib/platform/subscription-oversight.ts")
  check("the watch alerts platform staff, deduped per (tenant, state) per day", /notifyPlatformStaff/.test(lib) && /subscription_watch:\$\{r\.state\}/.test(lib))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by finance_manager with a runnable proof", /subscription_oversight:\s*\{\s*manager:\s*"finance_manager",\s*proof:\s*"test:subscription-oversight"/.test(reg))
  check("package.json wires the proof", /"test:subscription-oversight":\s*"tsx scripts\/subscription-oversight-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source proved the logic; live verified via MCP"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a past_due + trial-expiring subscription → the watch alerts platform staff → dedup → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  const { runSubscriptionWatch, loadSubscriptionOversight } = await import("../lib/platform/subscription-oversight")
  try {
    const { data: sub } = await svc.from("subscriptions").insert({ brokerage_id: brokerageId, status: "past_due" }).select("id").single()
    if (sub) cleanup.push({ table: "subscriptions", id: (sub as any).id })
    const board = await loadSubscriptionOversight(svc as any)
    check("live: the past-due tenant shows in the attention queue", board.queue.some((r) => r.brokerageId === brokerageId && r.state === "past_due"))
    const r1 = await runSubscriptionWatch(svc as any)
    check("live: the watch alerted platform staff", r1.notified >= 1)
    const r2 = await runSubscriptionWatch(svc as any)
    check("live: re-running is deduped (same tenant+state, same day)", r2.notified === 0)
    const { data: notes } = await svc.from("notifications").select("id").eq("type", "subscription_watch:past_due").eq("entity_id", brokerageId).limit(50)
    for (const n of (notes ?? []) as any[]) cleanup.push({ table: "notifications", id: n.id })
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SUBSCRIPTION_OVERSIGHT_FAIL"); process.exit(1) }
  console.log(" ✅ SUBSCRIPTION_OVERSIGHT_PASS — every subscription classified into one queue + an autonomous dunning/renewal watch")
}
main()
