#!/usr/bin/env tsx
/**
 * scripts/license-readiness-simulator.ts   (npm run test:license-readiness)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the AGENT LICENSE / CE / ETHICS READINESS gate — the "tracked but not enforced" fix. License
 * currency + CE hours + ethics are now a single canonical verdict that BLOCKS a transaction and warns
 * BEFORE a lapse; the offer-time gate consolidated onto it; and an autonomous sweep reminds agents +
 * escalates blockers to the broker.
 *
 * PURE:   evaluateLicenseReadiness (expired/CE-past-cycle/ethics-overdue = blocker; ≤45d = warning;
 *         missing → no issue) + readinessIssueKey + buildReadinessReminder (real issues only).
 * SOURCE: proactive-checks consolidated onto the evaluator (CE + ethics now enforced); the sweep is
 *         idempotent + rides the compliance-monitoring cron; owned by recruiting_manager.
 * LIVE (creds-gated): seed a lapsed agent → sweep proposes ONE gated reminder + a broker blocker notice
 *         → idempotent second run adds nothing → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { evaluateLicenseReadiness, readinessIssueKey, READINESS_WARN_DAYS, type LicenseStatus } from "../lib/compliance/license-readiness"
import { buildReadinessReminder } from "../lib/recruiting/license-readiness-sweep"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const NOW = new Date("2026-06-01T00:00:00Z")
const iso = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString().slice(0, 10)
const base = (over: Partial<LicenseStatus> = {}): LicenseStatus => ({ licenseExpiry: null, ceHoursRequired: null, ceHoursCompleted: null, ceCycleEndDate: null, ethicsDueDate: null, ...over })

function pureLayer() {
  console.log("\n[evaluateLicenseReadiness · pure — blockers vs warnings, honest on missing]")
  check("all fields null → ready, no issues (missing never fabricated)", (() => { const r = evaluateLicenseReadiness(base(), NOW); return r.ready && r.blockers.length === 0 && r.warnings.length === 0 })())
  check("expired license → BLOCKER (not ready)", (() => { const r = evaluateLicenseReadiness(base({ licenseExpiry: iso(-10) }), NOW); return !r.ready && r.blockers.some((b) => b.code === "license_expired") })())
  check("license expiring in 30d → WARNING (still ready)", (() => { const r = evaluateLicenseReadiness(base({ licenseExpiry: iso(30) }), NOW); return r.ready && r.warnings.some((w) => w.code === "license_expiring") })())
  check("license 90d out → no issue", evaluateLicenseReadiness(base({ licenseExpiry: iso(90) }), NOW).warnings.length === 0)
  check("CE short + cycle ENDED → BLOCKER", (() => { const r = evaluateLicenseReadiness(base({ ceHoursRequired: 30, ceHoursCompleted: 12, ceCycleEndDate: iso(-5) }), NOW); return !r.ready && r.blockers.some((b) => b.code === "ce_incomplete_cycle_ended") })())
  check("CE short + cycle ending soon → WARNING", (() => { const r = evaluateLicenseReadiness(base({ ceHoursRequired: 30, ceHoursCompleted: 20, ceCycleEndDate: iso(20) }), NOW); return r.ready && r.warnings.some((w) => w.code === "ce_incomplete_cycle_ending") })())
  check("CE short + NO cycle date → WARNING (can't block without a deadline — honest)", (() => { const r = evaluateLicenseReadiness(base({ ceHoursRequired: 30, ceHoursCompleted: 10 }), NOW); return r.ready && r.warnings.some((w) => w.code === "ce_incomplete") })())
  check("CE fully met → no CE issue", evaluateLicenseReadiness(base({ ceHoursRequired: 30, ceHoursCompleted: 30, ceCycleEndDate: iso(-1) }), NOW).warnings.length === 0)
  check("ethics overdue → BLOCKER", (() => { const r = evaluateLicenseReadiness(base({ ethicsDueDate: iso(-3) }), NOW); return !r.ready && r.blockers.some((b) => b.code === "ethics_overdue") })())
  check("ethics due soon → WARNING", (() => { const r = evaluateLicenseReadiness(base({ ethicsDueDate: iso(10) }), NOW); return r.ready && r.warnings.some((w) => w.code === "ethics_due_soon") })())
  check(`WARN window is ${READINESS_WARN_DAYS}d (edge inside warns, +1 clean)`, evaluateLicenseReadiness(base({ licenseExpiry: iso(READINESS_WARN_DAYS) }), NOW).warnings.length === 1 && evaluateLicenseReadiness(base({ licenseExpiry: iso(READINESS_WARN_DAYS + 1) }), NOW).warnings.length === 0)
  const multi = evaluateLicenseReadiness(base({ licenseExpiry: iso(-1), ethicsDueDate: iso(5) }), NOW)
  check("blockers + warnings coexist; issue key is stable/sorted", !multi.ready && readinessIssueKey(multi) === "ethics_due_soon,license_expired")

  console.log("\n[buildReadinessReminder · pure — real issues only, blockers first]")
  const rem = buildReadinessReminder(evaluateLicenseReadiness(base({ licenseExpiry: iso(-2), ceHoursRequired: 30, ceHoursCompleted: 5, ceCycleEndDate: iso(-1) }), NOW), "Dana Agent")
  check("reminder names the agent + lists the real issues", rem.body.includes("Dana Agent") && /license expired/i.test(rem.body) && /continuing-education|CE/i.test(rem.body))
  check("blocker reminder uses the action-needed subject", /Action needed/i.test(rem.subject))
  check("warning-only reminder uses the heads-up subject", /Heads-up/i.test(buildReadinessReminder(evaluateLicenseReadiness(base({ licenseExpiry: iso(20) }), NOW), "X").subject))
}

function sourceLayer() {
  console.log("\n[wiring — offer-time gate consolidated; autonomous sweep; owned]")
  const pc = src("lib/workflow/intelligence/proactive-checks.ts")
  check("offer-time proactive-check now uses the CANONICAL evaluator (CE + ethics enforced, not just license)", /evaluateLicenseReadiness\(\{[\s\S]*?ceHoursRequired[\s\S]*?ethicsDueDate/.test(pc))
  check("its readiness blockers become offer blockers", /readiness\.blockers[\s\S]*?blockers\.push/.test(pc))
  const sweep = src("lib/recruiting/license-readiness-sweep.ts")
  check("sweep is idempotent per (agent, standing issue set)", /LICENSE READINESS — agent:\$\{a\.id\} — \$\{issueKey\}/.test(sweep))
  check("sweep proposes a GATED agent reminder (nothing auto-sends)", /proposeClientMessage\(\{[\s\S]*?agentKind: "recruiting_manager"[\s\S]*?audience: "agent"/.test(sweep))
  check("a BLOCKER escalates to broker/admins (deduped)", /readiness\.blockers\.length > 0[\s\S]*?license_readiness_blocker/.test(sweep))
  const cron = src("app/api/cron/compliance-monitoring/route.ts")
  check("the daily compliance-monitoring cron runs the sweep (autonomous)", /sweepAllLicenseReadiness/.test(cron))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by recruiting_manager with a runnable proof", /license_readiness:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:license-readiness"/.test(reg))
  // MULTI-MANAGER HANDOFF — recruiting_manager → compliance_officer on a blocker.
  check("sweep publishes the recruiting_manager → compliance_officer license_lapsing signal on a blocker", /fromManager: "recruiting_manager", toManager: "compliance_officer",\s*\n?\s*signalType: "license_lapsing"/.test(sweep))
  check("license_lapsing is catalogued in SIGNAL_REGISTRY (consumer compliance_officer)", /license_lapsing:\s*\{ consumers: \["compliance_officer"\]/.test(src("lib/kernel/signal-registry.ts")))
  check("the compliance_officer:license_lapsing handler records a compliance_flag", /"compliance_officer:license_lapsing":[\s\S]*?from\("compliance_flags"\)[\s\S]*?violation_type: "license_readiness_blocker"/.test(src("lib/kernel/manager-signals.ts")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a lapsed agent → sweep proposes ONE reminder + broker blocker → idempotent → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    // Seed a throwaway user + agent with an expired license + CE short past cycle.
    const { data: u } = await svc.from("users").insert({ brokerage_id: brokerageId, email: `lictest_${Date.now()}@example.com`, first_name: "Lic", last_name: "Test", user_type: "agent" }).select("id").single()
    cleanup.push({ table: "users", id: (u as any).id })
    const { data: ag } = await svc.from("agents").insert({ brokerage_id: brokerageId, user_id: (u as any).id, license_expiry: "2020-01-01", ce_hours_required: 30, ce_hours_completed: 4, ce_cycle_end_date: "2020-01-01" }).select("id").single()
    cleanup.push({ table: "agents", id: (ag as any).id })

    const { sweepLicenseReadiness } = await import("../lib/recruiting/license-readiness-sweep")
    const r1 = await sweepLicenseReadiness(svc as any, { brokerageId })
    check("live: sweep reminded + flagged the lapsed agent as blocked", r1.reminded >= 1 && r1.blocked >= 1)
    const { data: msg } = await svc.from("agent_client_messages").select("id").eq("brokerage_id", brokerageId).eq("entity_type", "agent").eq("entity_id", (ag as any).id).eq("agent_kind", "recruiting_manager").maybeSingle()
    if (msg) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })
    check("live: a gated reminder was proposed (not sent)", !!msg)
    const { data: notes } = await svc.from("notifications").select("id").eq("entity_type", "agent").eq("entity_id", (ag as any).id).eq("type", "license_readiness_blocker")
    for (const n of notes ?? []) cleanup.push({ table: "notifications", id: (n as any).id })
    check("live: the broker got a blocker escalation", (notes ?? []).length >= 1)

    const r2 = await sweepLicenseReadiness(svc as any, { brokerageId })
    const { count } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true }).eq("entity_type", "agent").eq("entity_id", (ag as any).id).eq("agent_kind", "recruiting_manager")
    check("live: idempotent — still ONE reminder for the same standing issue set", count === 1 && r2.reminded === 0)
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
  if (fail > 0) { console.log(" ❌ LICENSE_READINESS_FAIL"); process.exit(1) }
  console.log(" ✅ LICENSE_READINESS_PASS — license + CE + ethics now ENFORCED as one verdict, warned before lapse, escalated on block")
}
main()
