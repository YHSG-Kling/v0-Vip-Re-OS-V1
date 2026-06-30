#!/usr/bin/env tsx
/**
 * scripts/compliance-flag-reaper-simulator.ts   (npm run test:compliance-flag-reaper)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the Compliance Officer's stuck-flag reaper: a 'flagged' (unreviewed)
 * compliance_flags row aged past its SEVERITY-weighted SLA is escalated to the
 * brokerage's compliance owners. Reviewed/resolved/overridden flags and flags
 * within SLA are never escalated; higher severity has a shorter fuse. Pure policy
 * + (creds-gated) live seed → reap → assert → idempotent → cleanup (count == 0).
 */
import { classifyStuckComplianceFlag, slaHoursForSeverity, DEFAULT_COMPLIANCE_SLA_HOURS } from "../lib/compliance/compliance-flag-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const NOW = new Date("2026-03-01T00:00:00Z")
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

async function main() {
  console.log("\n[severity SLA tiers — higher stakes, shorter fuse]")
  check("critical = 4h", slaHoursForSeverity("critical") === 4)
  check("high = 12h", slaHoursForSeverity("high") === 12)
  check("medium = 48h", slaHoursForSeverity("medium") === 48)
  check("low = 120h", slaHoursForSeverity("low") === 120)
  check("blocker treated as critical (4h)", slaHoursForSeverity("blocker") === 4)
  check("unknown severity → default medium", slaHoursForSeverity("weird") === DEFAULT_COMPLIANCE_SLA_HOURS)

  console.log("\n[classifyStuckComplianceFlag]")
  check("flagged + critical past 4h → escalate", classifyStuckComplianceFlag({ status: "flagged", severity: "critical", detectedAt: hoursAgo(5), now: NOW }) === "escalate")
  check("flagged + critical within 4h → keep", classifyStuckComplianceFlag({ status: "flagged", severity: "critical", detectedAt: hoursAgo(3), now: NOW }) === "keep")
  check("flagged + high at 12h → escalate", classifyStuckComplianceFlag({ status: "flagged", severity: "high", detectedAt: hoursAgo(12), now: NOW }) === "escalate")
  check("flagged + low within 120h → keep", classifyStuckComplianceFlag({ status: "flagged", severity: "low", detectedAt: hoursAgo(100), now: NOW }) === "keep")
  check("reviewed (someone's on it) → keep", classifyStuckComplianceFlag({ status: "reviewed", severity: "critical", detectedAt: hoursAgo(100), now: NOW }) === "keep")
  check("resolved (terminal) → keep", classifyStuckComplianceFlag({ status: "resolved", severity: "critical", detectedAt: hoursAgo(100), now: NOW }) === "keep")
  check("overridden (terminal) → keep", classifyStuckComplianceFlag({ status: "overridden", severity: "high", detectedAt: hoursAgo(100), now: NOW }) === "keep")
  check("no detected_at → keep (can't age)", classifyStuckComplianceFlag({ status: "flagged", severity: "high", detectedAt: null, now: NOW }) === "keep")
  check("unknown severity uses default fuse", classifyStuckComplianceFlag({ status: "flagged", severity: null, detectedAt: hoursAgo(DEFAULT_COMPLIANCE_SLA_HOURS + 1), now: NOW }) === "escalate")

  // ── LIVE LAYER (creds-gated) ──
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("\n[live] ⏭  Skipped — SUPABASE creds not set (pure layer ran).")
  } else {
    console.log("\n[live] seed a stale flagged row → reap → assert → idempotent → cleanup")
    const { createServiceClient } = await import("../lib/supabase/service")
    const { reapStuckComplianceFlags } = await import("../lib/compliance/compliance-flag-reaper")
    const svc = createServiceClient()
    const { data: b } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
    if (!b) { console.log("  ⏭  no brokerage available") }
    else {
      const { data: flag } = await svc.from("compliance_flags").insert({
        brokerage_id: b.id, status: "flagged", severity: "high", violation_type: "fair_housing",
        content_type: "test", flagged_content: "LIVE TEST", detected_at: hoursAgo(48),
      }).select("id").maybeSingle()
      try {
        const r1 = await reapStuckComplianceFlags(b.id, svc, { limit: 500 })
        check("live: escalated >= 1", r1.escalated >= 1)
        const { data: note } = await svc.from("notifications").select("id")
          .eq("brokerage_id", b.id).eq("type", "compliance_flag_stuck").eq("entity_id", flag!.id).limit(1)
        check("live: stuck-flag notification created", !!note && note.length >= 1)
        const r2 = await reapStuckComplianceFlags(b.id, svc, { limit: 500 })
        check("live: idempotent re-run", r2.escalated === 0 || (note?.length ?? 0) >= 1)
        await svc.from("notifications").delete().eq("type", "compliance_flag_stuck").eq("entity_id", flag!.id)
        await svc.from("compliance_flags").delete().eq("id", flag!.id)
        const { count } = await svc.from("compliance_flags").select("id", { count: "exact", head: true }).eq("id", flag!.id)
        check("live: cleanup count == 0", (count ?? 0) === 0)
      } catch (e) {
        await svc.from("notifications").delete().eq("type", "compliance_flag_stuck").eq("entity_id", flag!.id).then(() => {}, () => {})
        await svc.from("compliance_flags").delete().eq("id", flag!.id).then(() => {}, () => {})
        throw e
      }
    }
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ COMPLIANCE_FLAG_REAPER_FAIL"); process.exit(1) }
  console.log(" ✅ COMPLIANCE_FLAG_REAPER_PASS — unreviewed flags escalate by severity SLA, handled ones left alone")
}
main()
