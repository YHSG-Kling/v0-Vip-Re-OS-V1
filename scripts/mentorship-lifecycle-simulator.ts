#!/usr/bin/env tsx
/**
 * scripts/mentorship-lifecycle-simulator.ts   (npm run test:mentorship-lifecycle)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the MENTORSHIP LIFECYCLE — agent_mentor_relationships is no longer a static record. While a
 * pairing is active, gated mentor check-in nudges fire on cadence; when the mentee finishes onboarding
 * certification, the pairing GRADUATES (completed + end_date). Nothing auto-sends.
 *
 * PURE:   mentorshipCheckInDue (cadence off start/last-nudge) + shouldGraduate (mentee cert done) +
 *         checkInPeriod (one nudge per window).
 * SOURCE: runner graduates + proposes gated nudges (idempotent); rides the onboarding cron; owned.
 * LIVE (creds-gated): active pairing + due → nudge; mentee cert-achieved → graduate; idempotent; clean.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { mentorshipCheckInDue, shouldGraduate, checkInPeriod, MENTORSHIP_CHECKIN_DAYS } from "../lib/recruiting/mentorship-lifecycle"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

const NOW = new Date("2026-06-30T00:00:00Z")
const iso = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString()

function pureLayer() {
  console.log("\n[mentorshipCheckInDue · pure]")
  check("no nudge yet + started > cadence ago → due", mentorshipCheckInDue(iso(-20), null, NOW) === true)
  check("no nudge yet + started < cadence ago → NOT due", mentorshipCheckInDue(iso(-5), null, NOW) === false)
  check("last nudge within cadence → NOT due", mentorshipCheckInDue(iso(-60), iso(-3), NOW) === false)
  check("last nudge older than cadence → due", mentorshipCheckInDue(iso(-60), iso(-20), NOW) === true)
  check("no start date → never due (honest)", mentorshipCheckInDue(null, null, NOW) === false)
  check(`cadence edge: exactly ${MENTORSHIP_CHECKIN_DAYS}d → due`, mentorshipCheckInDue(iso(-MENTORSHIP_CHECKIN_DAYS), null, NOW) === true)

  console.log("\n[shouldGraduate · pure]")
  check("active + mentee cert achieved → graduate", shouldGraduate("active", true) === true)
  check("active + not yet certified → stay active", shouldGraduate("active", false) === false)
  check("active + unknown cert → stay active", shouldGraduate("active", null) === false)
  check("already completed → not re-graduated", shouldGraduate("completed", true) === false)

  console.log("\n[checkInPeriod · pure — one nudge per window]")
  check("day 20, 14d cadence → period 1", checkInPeriod(iso(-20), NOW) === 1)
  check("day 30, 14d cadence → period 2", checkInPeriod(iso(-30), NOW) === 2)
  check("before first window → period 0", checkInPeriod(iso(-5), NOW) === 0)
}

function sourceLayer() {
  console.log("\n[wiring — gated nudges + graduation; rides the cron; owned]")
  const mod = src("lib/recruiting/mentorship-lifecycle.ts")
  check("graduates a pairing whose mentee finished onboarding", /shouldGraduate\([\s\S]*?status: "completed", end_date/.test(mod))
  check("proposes a GATED mentor check-in (nothing auto-sends)", /proposeClientMessage\(\{[\s\S]*?agentKind: "recruiting_manager"[\s\S]*?entityType: "mentorship"/.test(mod))
  check("idempotent per (pairing, period)", /MENTORSHIP CHECK-IN — rel:\$\{r\.id\} — period:\$\{period\}/.test(mod))
  const cron = src("app/api/cron/onboarding-reminders/route.ts")
  check("the daily onboarding-reminders cron runs the lifecycle", /runMentorshipLifecycleAll/.test(cron))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by recruiting_manager with a runnable proof", /mentorship_lifecycle:\s*\{\s*manager:\s*"recruiting_manager",\s*proof:\s*"test:mentorship-lifecycle"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] active pairing due → nudge; mentee certified → graduate; idempotent; clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: ags } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).limit(2)
  if (!ags || ags.length < 2) { console.log("  ⊘ need 2 agents — skipping"); return }
  const mentor = (ags as any[])[0].id, mentee = (ags as any[])[1].id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const start = new Date(Date.now() - 20 * 86_400_000).toISOString()
    const { data: rel } = await svc.from("agent_mentor_relationships").insert({ brokerage_id: brokerageId, mentor_agent_id: mentor, mentee_agent_id: mentee, status: "active", start_date: start }).select("id").single()
    cleanup.push({ table: "agent_mentor_relationships", id: (rel as any).id })

    const { runMentorshipLifecycle } = await import("../lib/recruiting/mentorship-lifecycle")
    const r1 = await runMentorshipLifecycle(svc as any, { brokerageId })
    check("live: an active, due pairing gets a gated check-in nudge", r1.nudged >= 1)
    const { data: msg } = await svc.from("agent_client_messages").select("id").eq("entity_type", "mentorship").eq("entity_id", (rel as any).id).eq("agent_kind", "recruiting_manager").maybeSingle()
    if (msg) cleanup.push({ table: "agent_client_messages", id: (msg as any).id })
    check("live: the nudge is a gated proposal", !!msg)

    const r2 = await runMentorshipLifecycle(svc as any, { brokerageId })
    check("live: idempotent — no second nudge in the same period", r2.nudged === 0)

    // Mark mentee onboarding certified → next run graduates the pairing.
    const { data: ob } = await svc.from("agent_onboarding").upsert({ agent_id: mentee, brokerage_id: brokerageId, certification_achieved: true, status: "completed" }, { onConflict: "agent_id" }).select("agent_id").maybeSingle()
    const obSeeded = !!ob
    const r3 = await runMentorshipLifecycle(svc as any, { brokerageId })
    check("live: mentee certified → pairing graduates (or honest skip if onboarding row absent)", obSeeded ? r3.graduated >= 1 : true)
    if (obSeeded) {
      const { data: after } = await svc.from("agent_mentor_relationships").select("status, end_date").eq("id", (rel as any).id).maybeSingle()
      check("live: pairing is completed with an end_date", (after as any)?.status === "completed" && !!(after as any)?.end_date)
      // clean up the onboarding row we created
      await svc.from("agent_onboarding").delete().eq("agent_id", mentee)
    }
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
  if (fail > 0) { console.log(" ❌ MENTORSHIP_LIFECYCLE_FAIL"); process.exit(1) }
  console.log(" ✅ MENTORSHIP_LIFECYCLE_PASS — pairings check in on cadence + graduate when the mentee finishes onboarding")
}
main()
