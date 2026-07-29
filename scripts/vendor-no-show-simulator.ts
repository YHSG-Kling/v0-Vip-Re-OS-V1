#!/usr/bin/env tsx
/**
 * scripts/vendor-no-show-simulator.ts   (npm run test:vendor-no-show)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the VENDOR NO-SHOW AUTOPILOT — the self-healing bench. A ghosted booking (past its scheduled
 * date, never completed) is detected, MARKED no_show (the missing autonomous writer, which dents SLA),
 * and a GATED backup vendor (same category, preference-first) is proposed so the agent re-books in one
 * tap. The shared computeVendorSla is the single SLA source of truth (panel + autopilot).
 *
 * PURE:   isNoShow (booked/confirmed + past scheduled+grace + not completed; no false positives) +
 *         pickBackupVendor (different same-category vendor, preference-first) + computeVendorSla/slaTier.
 * SOURCE: the SLA panel consumes the shared lib (no inline drift); the runner marks no_show + proposes a
 *         gated backup; rides the vendor-orchestration cron; owned by deal_coordinator.
 * LIVE (creds-gated): seed a ghosted booking + a same-category backup vendor → run → assert marked
 *         no_show + a gated backup proposal → idempotent → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { isNoShow, pickBackupVendor, NO_SHOW_GRACE_HOURS, type NoShowBooking } from "../lib/kernel/vendor-no-show-autopilot"
import { computeVendorSla, slaTier, SLA_BREACH_PCT } from "../lib/kernel/vendor-sla"
import { rankVendors, type BenchVendor } from "../lib/kernel/vendor-orchestration"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const NOW = new Date("2026-06-10T12:00:00Z")
const iso = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString().slice(0, 10)
const bk = (over: Partial<NoShowBooking>): NoShowBooking => ({ id: "b", status: "confirmed", scheduled_date: iso(-3), completed_at: null, vendor_id: "v1", service_type: "home inspection", contact_id: null, transaction_id: null, ...over })

function pureLayer() {
  console.log("\n[isNoShow · pure — no false positives]")
  check("confirmed + 3 days past + not completed → no-show", isNoShow(bk({}), NOW) === true)
  check("booked + past + not completed → no-show", isNoShow(bk({ status: "booked" }), NOW) === true)
  check("within the grace window → NOT yet a no-show", isNoShow(bk({ scheduled_date: iso(0) }), NOW, NO_SHOW_GRACE_HOURS) === false)
  check("completed → never a no-show", isNoShow(bk({ completed_at: iso(-2) }), NOW) === false)
  check("cancelled → never a no-show", isNoShow(bk({ status: "cancelled" }), NOW) === false)
  check("already no_show → not re-flagged (terminal)", isNoShow(bk({ status: "no_show" }), NOW) === false)
  check("no scheduled_date → never a no-show (honest)", isNoShow(bk({ scheduled_date: null }), NOW) === false)
  check("future appointment → not a no-show", isNoShow(bk({ scheduled_date: iso(5) }), NOW) === false)

  console.log("\n[pickBackupVendor · pure — different same-category vendor, preference-first]")
  const bench: BenchVendor[] = [
    { id: "v1", name: "Ghost Inspect", category: "inspector", email: null, rating: 5 },   // the failed vendor
    { id: "v2", name: "Reliable Inspect", category: "inspector", email: null, rating: 3 },
    { id: "v3", name: "Preferred Inspect", category: "inspector", email: null, rating: 2 },
    { id: "v4", name: "Some Title", category: "title", email: null, rating: 5 },
  ]
  check("excludes the failed vendor + picks same category", pickBackupVendor(bench, "v1", "inspector", new Set())?.id === "v2")
  check("preference-first: a preferred lower-rated backup beats a higher-rated one", pickBackupVendor(bench, "v1", "inspector", new Set(["v3"]))?.id === "v3")
  check("no other same-category vendor → null (honest)", pickBackupVendor([bench[0], bench[3]], "v1", "inspector", new Set()) === null)
  check("wrong category is never offered as a backup", pickBackupVendor(bench, "v1", "inspector", new Set())?.category === "inspector")

  console.log("\n[computeVendorSla · pure — the shared SLA source of truth]")
  const sla = computeVendorSla([
    { vendor_id: "v1", scheduled_date: "2026-01-01", completed_at: "2026-01-01" }, // on time
    { vendor_id: "v1", scheduled_date: "2026-02-01", completed_at: "2026-02-10" }, // late (turnaround 1)
    { vendor_id: "v2", scheduled_date: "2026-01-01", completed_at: null },          // no completion → ignored
  ], { v1: 1 })
  check("on-time math: v1 is 1/2 = 50%", sla.v1.slaPct === 50 && sla.v1.total === 2 && sla.v1.onTime === 1)
  check("unproven vendor (no completed history) → 100% (not 'bad')", (sla.v2?.slaPct ?? 100) === 100)
  check(`slaTier: 50% is a breach (< ${SLA_BREACH_PCT})`, slaTier(50) === "breach" && slaTier(95) === "compliant" && slaTier(80) === "warning")
  // A NO_SHOW counts as a reliability failure (the autopilot marks these → the score drops).
  const slaWithNoShow = computeVendorSla([
    { vendor_id: "v9", scheduled_date: "2026-01-01", completed_at: "2026-01-01" }, // on time
    { vendor_id: "v9", scheduled_date: "2026-02-01", completed_at: null, status: "no_show" }, // ghosted
  ], { v9: 1 })
  check("a no_show dents SLA: v9 is 1/2 = 50% (ghosting costs the vendor)", slaWithNoShow.v9.slaPct === 50 && slaWithNoShow.v9.total === 2)

  console.log("\n[rankVendors · pure — a PROVEN breacher is auto-demoted, unproven is not]")
  const rankBench: BenchVendor[] = [
    { id: "good", name: "Reliable", category: "inspector", email: null, rating: 4 },
    { id: "bad", name: "Flaky", category: "inspector", email: null, rating: 5 },   // higher rating but breaching
    { id: "new", name: "Unproven", category: "inspector", email: null, rating: 3 },
  ]
  const slaMap = { bad: { slaPct: 40, total: 6 }, good: { slaPct: 95, total: 5 }, new: { slaPct: 50, total: 1 } }
  const ranked2 = rankVendors(rankBench, { slaByVendor: slaMap })
  check("a proven breacher (40% over 6) is demoted BELOW a reliable vendor despite higher rating", ranked2[ranked2.length - 1].id === "bad")
  check("a thin-sample low score (50% over 1) is NOT demoted (unproven ≠ bad)", ranked2.findIndex((v) => v.id === "new") < ranked2.findIndex((v) => v.id === "bad"))
  check("preferred still wins among non-breachers", rankVendors(rankBench, { preferredVendorIds: new Set(["good"]), slaByVendor: slaMap })[0].id === "good")
}

function sourceLayer() {
  console.log("\n[wiring — shared SLA lib (no panel drift); autopilot marks + proposes; owned; on cron]")
  const panel = src("app/dashboard/partners/components/os/vendor-sla-panel.tsx")
  check("the SLA panel consumes the SHARED computeVendorSla (inline math removed — no drift)", /computeVendorSla\(\(bookings/.test(panel) && !/byVendor\[vid\]\.onTime\+\+/.test(panel))
  const auto = src("lib/kernel/vendor-no-show-autopilot.ts")
  check("autopilot marks the ghosted booking no_show (the missing writer)", /updateVendorBookingStatus\(\{[\s\S]*?toStatus: "no_show"/.test(auto))
  check("autopilot proposes a GATED backup (agent-audience, nothing auto-books)", /proposeClientMessage\(\{[\s\S]*?agentKind: "deal_coordinator"[\s\S]*?audience: "agent"/.test(auto))
  // Was: /resolvePreferredVendorIds\(bench/ — the vendor_directory bridge, deleted
  // as dead after the round-4 repoint moved preference onto the `vendors` bench
  // itself (broker approval, status='active'). The promise is unchanged — the
  // backup is ranked preference-first — only its source moved.
  check("backup ranking is preference-first from the vendors bench (broker-approved)",
    /from\("vendors"\)[\s\S]*?\.eq\("status", "active"\)[\s\S]*?preferredVendorIds/.test(auto)
    && /rankVendors\(pool, \{ preferredVendorIds \}\)/.test(auto))
  const cron = src("app/api/cron/vendor-orchestration/route.ts")
  check("the daily vendor-orchestration cron runs the autopilot", /runVendorNoShowAutopilotAll/.test(cron))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by deal_coordinator with a runnable proof", /vendor_no_show_autopilot:\s*\{\s*manager:\s*"deal_coordinator",\s*proof:\s*"test:vendor-no-show"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed ghosted booking + same-category backup → autopilot → idempotent → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: v1 } = await svc.from("vendors").insert({ brokerage_id: brokerageId, name: "Ghost Inspect (test)", category: "inspector", rating: 5, status: "active" }).select("id").single()
    cleanup.push({ table: "vendors", id: (v1 as any).id })
    const { data: v2 } = await svc.from("vendors").insert({ brokerage_id: brokerageId, name: "Backup Inspect (test)", category: "inspector", rating: 4, status: "active" }).select("id").single()
    cleanup.push({ table: "vendors", id: (v2 as any).id })
    const pastDate = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
    const { data: bkg } = await svc.from("vendor_bookings").insert({ brokerage_id: brokerageId, vendor_id: (v1 as any).id, service_type: "home inspection", scheduled_date: pastDate, status: "confirmed" }).select("id").single()
    cleanup.push({ table: "vendor_bookings", id: (bkg as any).id })

    const { runVendorNoShowAutopilot } = await import("../lib/kernel/vendor-no-show-autopilot")
    const r1 = await runVendorNoShowAutopilot(svc as any, { brokerageId })
    check("live: marked the ghosted booking no_show + proposed a backup", r1.markedNoShow >= 1 && r1.backupsProposed >= 1)
    const { data: after } = await svc.from("vendor_bookings").select("status").eq("id", (bkg as any).id).maybeSingle()
    check("live: the booking is now no_show", (after as any)?.status === "no_show")
    const { data: msg } = await svc.from("agent_client_messages").select("id, body").eq("entity_type", "vendor_booking").eq("entity_id", (bkg as any).id).eq("agent_kind", "deal_coordinator").maybeSingle()
    if (msg) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })
    check("live: a gated backup proposal names the backup vendor", /Backup Inspect \(test\)/.test((msg as any)?.body ?? ""))

    const r2 = await runVendorNoShowAutopilot(svc as any, { brokerageId })
    check("live: idempotent — no_show is terminal, nothing re-marked/re-proposed", r2.markedNoShow === 0 && r2.backupsProposed === 0)
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
  if (fail > 0) { console.log(" ❌ VENDOR_NO_SHOW_FAIL"); process.exit(1) }
  console.log(" ✅ VENDOR_NO_SHOW_PASS — a ghosted booking self-heals: marked no_show + a gated same-category backup proposed")
}
main()
