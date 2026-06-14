#!/usr/bin/env tsx
/**
 * scripts/nothing-dropped-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE NOTHING-DROPPED SWEEP — the live-data proof of "nothing falls through the cracks."
 * One unified, ranked, cross-entity card: everything past its SLA with no next action, worst-first.
 *
 * Layer 1 (pure, always runs): detection (past-SLA + no-next-action) + severity ranking.
 * Layer 2 (live, SUPABASE_SERVICE_ROLE_KEY-gated, READ-ONLY): seeds a pending showing past its SLA
 *   and asserts the sweep surfaces it. Seed reverse-deleted. No mocks, no writes by the sweep.
 *
 * Run: npx tsx scripts/nothing-dropped-simulator.ts   (npm run test:nothing-dropped)
 */
import { findDroppingBalls, summarizeSweep, type DropCandidate } from "../lib/kernel/nothing-dropped"

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
  console.log(" ✅ Nothing-dropped sweep verified — every lane unified, worst-first, nothing slips.")
  console.log(" NOTHING_DROPPED_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Nothing-dropped sweep simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · detection + severity ranking]")
  const candidates: DropCandidate[] = [
    { entityType: "showing_request", entityId: "s1", ageHours: 10, hasNextAction: false },  // past 4h SLA → drop
    { entityType: "showing_request", entityId: "s2", ageHours: 2,  hasNextAction: false },  // within 4h → ok
    { entityType: "approval",        entityId: "a1", ageHours: 9,  hasNextAction: false },  // past 4h → drop
    { entityType: "offer",           entityId: "o1", ageHours: 8,  hasNextAction: false },  // 6h overdue × 3 crit = worst
    { entityType: "lead",            entityId: "l1", ageHours: 3,  hasNextAction: false },  // past 1h → drop
    { entityType: "lead_followup",   entityId: "lf1", ageHours: 80,  hasNextAction: false }, // first-touched, 80h since last push (>72) → drop
    { entityType: "lead_followup",   entityId: "lf2", ageHours: 40,  hasNextAction: false }, // 40h since last push (<72) → ok
    { entityType: "showing_request", entityId: "s3", ageHours: 99, hasNextAction: true },   // owned → never drops
    { entityType: "contact",         entityId: "c1", ageHours: 200, hasNextAction: false }, // within 14d(336h) → ok
  ]
  const dropping = findDroppingBalls(candidates)
  const ids = dropping.map(d => d.entityId)
  check("within-SLA item is NOT dropping (s2)", !ids.includes("s2"))
  check("owned item (hasNextAction) is NOT dropping (s3)", !ids.includes("s3"))
  check("within-window contact is NOT dropping (c1)", !ids.includes("c1"))
  check("past-SLA items ARE dropping (s1, a1, o1, l1)", ["s1", "a1", "o1", "l1"].every(i => ids.includes(i)))
  check("a first-touched lead overdue for its next email/mail push IS dropping (lf1)", ids.includes("lf1"))
  check("a lead within the follow-up window is NOT dropping (lf2)", !ids.includes("lf2"))
  check("an untouched OFFER ranks worst (highest criticality × overdue)", dropping[0].entityId === "o1", dropping[0]?.entityId)
  check("ranking is worst-first (severity descending)", dropping.every((d, i) => i === 0 || dropping[i - 1].severity >= d.severity))
  const sum = summarizeSweep(dropping, 3)
  check("summary counts + caps the top card", sum.total === 5 && sum.top.length === 3 && (sum.byEntity.lead_followup ?? 0) === 1)

  console.log("\n[Layer 2 · live (read-only): a past-SLA pending showing surfaces]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { runNothingDroppedSweep } = await import("../lib/kernel/nothing-dropped-runner")
  const supabase = createServiceClient()

  const { data: brokerage } = await supabase.from("brokerages").select("id").limit(1).maybeSingle()
  const { data: contact } = brokerage
    ? await supabase.from("contacts").select("id").eq("brokerage_id", (brokerage as any).id).limit(1).maybeSingle()
    : { data: null }
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const stamp = Date.now()

  // Seed a pending showing created 10h ago (past the 4h SLA).
  const tenHoursAgo = new Date(Date.now() - 10 * 3_600_000).toISOString()
  const { data: showing, error } = await supabase.from("showing_requests").insert({
    brokerage_id: brokerageId, contact_id: (contact as any)?.id ?? null,
    property_address: `ZZ Drop ${stamp} Test St`, status: "pending",
    requested_date: new Date().toISOString().split("T")[0], message: "sweep test", created_at: tenHoursAgo,
  }).select("id").single()
  if (error || !showing) { check("seed pending showing", false, error?.message); return report() }
  const showingId = (showing as any).id

  try {
    const sum = await runNothingDroppedSweep(brokerageId, { topN: 200 }, supabase)
    check("the past-SLA pending showing is in the sweep", sum.top.some(d => d.entityId === showingId), `total=${sum.total}`)
    const mine = sum.top.find(d => d.entityId === showingId)
    check("it's flagged overdue with a positive severity", !!mine && mine.overdueHours > 0 && mine.severity > 0, JSON.stringify(mine).slice(0, 120))
  } finally {
    await supabase.from("showing_requests").delete().eq("id", showingId)
    const { count } = await supabase.from("showing_requests").select("id", { count: "exact", head: true }).eq("id", showingId)
    check("cleanup: seed removed (count == 0)", (count ?? 0) === 0)
  }

  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
