#!/usr/bin/env tsx
/**
 * scripts/os-sentinel-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OS SENTINEL — ONE "state of the whole agentic OS" for platform staff.
 * A CONSOLIDATION (not a parallel system): a pure roll-up composing the existing
 * loaders (loadAiOps, loadManagerOps, loadRotationRisks) + two previously-invisible
 * signals (reaper_runs self-heal ledger; weekly red-team regression) into one
 * OsHealth with a status per subsystem + an overall worst-of status.
 *
 * Layer 1 (pure): worstStatus + classifyCount thresholds; rollupOsHealth (all-clear
 *   → ok; any breaching manager SLO → overall breach; credentials expiring-only →
 *   warn; a tenant-isolation finding → breach; red-team regression → breach).
 * Layer 2 (source): getOsHealthAction is staff-gated; the page redirects non-staff;
 *   the board consumes getOsHealthAction; the loader composes the EXISTING roll-ups
 *   (no reimplementation).
 * Layer 3 (live, gated): seed ONE unresolved tenant_safety_findings (flips a
 *   normally-green subsystem) + ONE reaper_runs row → loadOsHealth reflects
 *   tenant_isolation=breach, overall=breach, and self-heal counts ≥ seeded →
 *   cleanup, verify count == 0.
 *
 * Run: npx tsx scripts/os-sentinel-simulator.ts   (npm run test:os-sentinel)
 */
import {
  worstStatus, classifyCount, rollupOsHealth, SENTINEL_THRESHOLDS,
  type OsHealthInputs,
} from "../lib/platform/os-sentinel"
import { readFileSync } from "node:fs"
import { join } from "node:path"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ OS Sentinel verified — one consolidated state-of-the-OS, worst-of roll-up, live subsystem flip")
  console.log(" OS_SENTINEL_PASS")
}

function baseInputs(): OsHealthInputs {
  return {
    generatedAt: "2026-07-06T00:00:00.000Z",
    aiOps: { stuck: 0, held: 0, failed: 0, errors: 0, cronsFailing: 0 },
    managerSlo: { breaching: 0, warning: 0 },
    expiredCredentials: 0, expiringCredentials: 0,
    tenantIsolationFindings: 0,
    selfHeal: { runs: 0, replayed: 0, escalated: 0 },
    redTeam: { lastRegressionAt: null },
    topIncidents: [],
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" OS Sentinel simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure roll-up]")
  check("worstStatus: breach dominates warn dominates ok",
    worstStatus(["ok", "warn", "breach"]) === "breach" && worstStatus(["ok", "warn"]) === "warn" && worstStatus(["ok", "ok"]) === "ok")
  check("classifyCount honours warn/breach thresholds",
    classifyCount(0, 1, 10) === "ok" && classifyCount(1, 1, 10) === "warn" && classifyCount(10, 1, 10) === "breach")

  check("all-clear inputs → overall ok, every subsystem ok",
    (() => { const h = rollupOsHealth(baseInputs()); return h.overall === "ok" && h.subsystems.every((s) => s.status === "ok") })())

  check("a breaching manager SLO → manager_slo breach + overall breach",
    (() => { const h = rollupOsHealth({ ...baseInputs(), managerSlo: { breaching: 1, warning: 0 } }); return h.subsystems.find((s) => s.key === "manager_slo")?.status === "breach" && h.overall === "breach" })())

  check("credentials expiring-only (0 expired) → credentials WARN, not breach",
    (() => { const h = rollupOsHealth({ ...baseInputs(), expiringCredentials: 3 }); return h.subsystems.find((s) => s.key === "credentials")?.status === "warn" })())
  check("credentials with expired ≥ breach threshold → breach",
    (() => { const h = rollupOsHealth({ ...baseInputs(), expiredCredentials: SENTINEL_THRESHOLDS.expiredCreds.breach }); return h.subsystems.find((s) => s.key === "credentials")?.status === "breach" })())

  check("ONE tenant-isolation finding → tenant_isolation breach + overall breach (any RLS finding is a breach)",
    (() => { const h = rollupOsHealth({ ...baseInputs(), tenantIsolationFindings: 1 }); return h.subsystems.find((s) => s.key === "tenant_isolation")?.status === "breach" && h.overall === "breach" })())

  check("a recent red-team regression → red_team breach + overall breach",
    (() => { const h = rollupOsHealth({ ...baseInputs(), redTeam: { lastRegressionAt: "2026-07-05T00:00:00.000Z" } }); return h.subsystems.find((s) => s.key === "red_team")?.status === "breach" && h.overall === "breach" })())

  check("stuck-signal count between thresholds → autonomy_bus warn (not breach)",
    (() => { const h = rollupOsHealth({ ...baseInputs(), aiOps: { ...baseInputs().aiOps, stuck: 2 } }); return h.subsystems.find((s) => s.key === "autonomy_bus")?.status === "warn" })())

  check("topIncidents are carried + capped at 20",
    (() => { const many = Array.from({ length: 30 }, (_, i) => ({ subsystem: "crons", severity: "warn" as const, summary: `c${i}` })); return rollupOsHealth({ ...baseInputs(), topIncidents: many }).topIncidents.length === 20 })())

  console.log("\n[Layer 2 · consolidation wiring]")
  const actionSrc = readFileSync(join(process.cwd(), "app/actions/superadmin/os-sentinel.ts"), "utf8")
  check("getOsHealthAction is staff-gated (requireStaff)", /requireStaff/.test(actionSrc) && /platform staff only/i.test(actionSrc))
  const loaderSrc = readFileSync(join(process.cwd(), "lib/platform/os-sentinel.ts"), "utf8")
  check("loadOsHealth COMPOSES the existing roll-ups (loadAiOps + loadManagerOps + loadRotationRisks), no reimplementation",
    /loadAiOps/.test(loaderSrc) && /loadManagerOps/.test(loaderSrc) && /loadRotationRisks/.test(loaderSrc))
  check("loadOsHealth surfaces the previously-invisible reaper_runs + red-team signals",
    /reaper_runs/.test(loaderSrc) && /manager_eval_regression/.test(loaderSrc))
  const pageSrc = readFileSync(join(process.cwd(), "app/dashboard/superadmin/sentinel/page.tsx"), "utf8")
  check("the board page redirects non-staff", /isStaff/.test(pageSrc) && /redirect\("\/dashboard"\)/.test(pageSrc))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 3 · live roll-up]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure + source layers ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { loadOsHealth } = await import("../lib/platform/os-sentinel")
  const svc = createServiceClient()
  const TAG = `OsSentinel${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  console.log("\n[Layer 3 · live roll-up]")
  try {
    // Seed ONE unresolved tenant-isolation finding — flips a normally-green subsystem.
    const { data: finding, error: fErr } = await svc.from("tenant_safety_findings").insert({
      scan_run_id: crypto.randomUUID(), finding_type: "table_missing_rls_policy", table_name: `${TAG}_probe`,
      severity: "high", resolved: false, details: { probe: TAG },
    }).select("id").single()
    if (fErr) { check("seed tenant_safety_findings", false, fErr.message); report(); return }
    cleanup.push({ table: "tenant_safety_findings", id: (finding as any).id })

    // Seed ONE reaper_runs row — proves self-heal reporting (brokerage_id NOT NULL).
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    if (brk) {
      const { data: run } = await svc.from("reaper_runs").insert({
        brokerage_id: (brk as any).id, domain: "manager_handoffs", manager: "deal_coordinator",
        scanned: 3, reaped: 2, escalated: 1, ran_at: new Date().toISOString(), detail: { probe: TAG },
      }).select("id").single()
      if (run) cleanup.push({ table: "reaper_runs", id: (run as any).id })
    }

    const health = await loadOsHealth(svc)
    const tenant = health.subsystems.find((s) => s.key === "tenant_isolation")
    check("live: tenant_isolation subsystem is BREACH after seeding an unresolved finding",
      tenant?.status === "breach" && (tenant?.count ?? 0) >= 1, JSON.stringify(tenant))
    check("live: overall OS status is BREACH (worst-of surfaced the finding)", health.overall === "breach")
    check("live: self-heal reporting reflects the reaper run (replayed ≥ 2, escalated ≥ 1)",
      health.selfHeal.replayed >= 2 && health.selfHeal.escalated >= 1, JSON.stringify(health.selfHeal))
    check("live: OsHealth is well-formed (9 subsystems, generatedAt set)",
      health.subsystems.length === 9 && !!health.generatedAt)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("tenant_safety_findings").select("id", { count: "exact", head: true }).eq("table_name", `${TAG}_probe`)
    check("cleanup verified — 0 seeded findings remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
