#!/usr/bin/env tsx
/**
 * scripts/buyer-move-simulator.ts   (npm run test:buyer-move)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the post-contract buyer move-in concierge (Deal Coordinator). The dated move-in checklist,
 * the friction score, and the two-mode decision (guided-DIY vs Utility Connect handoff) are PURE and
 * unit-tested; the ensure/update round-trip is proven live against the single buyer_move_cases table.
 * The handoff EXECUTION stays feature-flagged off — the RECOMMENDATION always computes.
 *
 * PURE:   buildMoveInTasks (offsets off the closing date; honest null dates when unknown) +
 *         computeFriction (open-essentials + time-pressure, 0→1) + decideBuyerMode (next_best_action).
 * SOURCE: auto-created at CLOSING_PREP in stage-progression; owned by deal_coordinator; handoff gated by
 *         the FEATURES flag (no external push while off); the schema snapshot carries the table.
 * LIVE (creds-gated): seed a buyer-side txn → ensure → assert the checklist + recommendation land → mark
 *         a task done and re-assert friction drops → idempotent second ensure → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  buildMoveInTasks,
  computeFriction,
  decideBuyerMode,
  daysToClose,
  essentialTasks,
  type MoveTask,
} from "../lib/transactions/buyer-move"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[buildMoveInTasks · pure — dated checklist off the closing date]")
  const tasks = buildMoveInTasks("2026-03-01")
  check("builds the full 10-task move-in catalog", tasks.length === 10)
  check("has the 5 essential utilities (electric/water/gas/internet/insurance)", essentialTasks(tasks).length === 5)
  const elec = tasks.find((t) => t.type === "electricity")
  check("electricity is essential, due 7 days before closing (2026-02-22)", elec?.group === "essential" && elec?.dueDate === "2026-02-22")
  const addr = tasks.find((t) => t.type === "address_change")
  check("change-of-address is admin, due on closing day (2026-03-01)", addr?.group === "admin" && addr?.dueDate === "2026-03-01")
  const movers = tasks.find((t) => t.type === "movers")
  check("movers is optional, due 21 days before (2026-02-08) — book early", movers?.group === "optional" && movers?.dueDate === "2026-02-08")
  check("all tasks start pending", tasks.every((t) => t.status === "pending"))
  check("no closing date ⇒ tasks still exist but carry no due date (honest)", buildMoveInTasks(null).every((t) => t.dueDate === null))

  console.log("\n[computeFriction · pure — open essentials + time pressure]")
  check("all pending, closing 3 days out ⇒ high friction (≥0.6)", computeFriction(tasks, 3) >= 0.6)
  check("all pending, closing 30 days out ⇒ lower friction (essentials only)", computeFriction(tasks, 30) < 0.6)
  const allDone = tasks.map((t) => ({ ...t, status: "done" as const }))
  check("everything done ⇒ friction 0 regardless of time", computeFriction(allDone, 1) === 0)
  check("friction is clamped to [0,1]", computeFriction(tasks, -5) <= 1 && computeFriction(tasks, -5) >= 0)

  console.log("\n[decideBuyerMode · pure — the two-mode decision + next_best_action]")
  const relaxed = decideBuyerMode({ tasks, daysToClose: 30 })
  check("plenty of runway ⇒ CONTINUE_GUIDED_SUPPORT (guided DIY)", relaxed.next_best_action === "CONTINUE_GUIDED_SUPPORT" && relaxed.recommended_mode === "contact_assisted_guided_diy")
  const crunch = decideBuyerMode({ tasks, daysToClose: 3 })
  check("essentials open + closing ≤5d ⇒ OFFER_HANDOFF (recommend handoff)", crunch.next_best_action === "OFFER_HANDOFF" && crunch.recommended_mode === "handoff")
  const asked = decideBuyerMode({ tasks, daysToClose: 20, buyerRequestedHelp: true })
  check("buyer asked us to handle it ⇒ START_HANDOFF", asked.next_best_action === "START_HANDOFF" && asked.recommended_mode === "handoff")
  const doneCrunch = decideBuyerMode({ tasks: allDone, daysToClose: 2 })
  check("essentials all handled ⇒ stays guided even at closing (no needless handoff)", doneCrunch.next_best_action === "CONTINUE_GUIDED_SUPPORT")
  check("decision always carries a friction score + reasons", crunch.friction_score >= 0 && crunch.reasons.length > 0)

  console.log("\n[daysToClose · pure]")
  check("daysToClose is injectable + correct", daysToClose("2026-03-11", new Date("2026-03-01T00:00:00Z")) === 10)
  check("no date ⇒ null (honest)", daysToClose(null) === null)
}

function sourceLayer() {
  console.log("\n[wiring — auto-created at CLOSING_PREP; owned by deal_coordinator; handoff feature-gated]")
  const stage = src("lib/transactions/stage-progression.ts")
  check("stage-progression stands up the move case at CLOSING_PREP", /CLOSING_PREP[\s\S]*?ensureBuyerMoveCase/.test(stage))
  const mod = src("lib/transactions/buyer-move.ts")
  check("buyer-side only — skips listing deals / deals with no buyer contact", /deal_type[\s\S]*?listing[\s\S]*?buyer_contact_id/.test(mod))
  check("writes to the single buyer_move_cases table (no parallel task system)", /from\("buyer_move_cases"\)/.test(mod))
  const actions = src("app/actions/buyer-move.ts")
  check("handoff EXECUTION is gated behind FEATURES.BUYER_MOVE_UTILITY_CONNECT", /FEATURES\.BUYER_MOVE_UTILITY_CONNECT/.test(actions))
  check("handoff preference is recorded even when the flag is off (no external push)", /handoffPending/.test(actions))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by deal_coordinator with a runnable proof", /buyer_move_services:\s*\{\s*manager:\s*"deal_coordinator",\s*proof:\s*"test:buyer-move"/.test(reg))
  check("buyer_move_cases table is owned by deal_coordinator", /buyer_move_cases:\s*"deal_coordinator"/.test(reg))
  const snap = src("scripts/schema-snapshot.ts")
  check("buyer_move_cases is in the schema snapshot (drift-guarded)", /buyer_move_cases:\s*\[/.test(snap))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed buyer-side txn → ensure → assert → mark a task done → idempotent → clean up")
  const { data: txn } = await svc.from("transactions").select("id, brokerage_id, buyer_contact_id, deal_type, close_date").not("buyer_contact_id", "is", null).neq("deal_type", "listing").limit(1).maybeSingle()
  if (!txn) { console.log("  ⊘ no buyer-side transaction with a buyer contact — skipping"); return }
  const brokerageId = (txn as any).brokerage_id, transactionId = (txn as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  const priorClose = (txn as any).close_date ?? null
  try {
    // Give the deal a near-term close so the recommendation exercises the crunch path deterministically.
    await svc.from("transactions").update({ close_date: "2099-01-05" }).eq("id", transactionId)
    const { ensureBuyerMoveCase, updateMoveTask } = await import("../lib/transactions/buyer-move")

    // Pre-clean any stale case for this txn so the seed is deterministic (unique on transaction_id).
    const { data: stale } = await svc.from("buyer_move_cases").select("id").eq("transaction_id", transactionId).maybeSingle()
    if (stale) await svc.from("buyer_move_cases").delete().eq("id", (stale as any).id)

    const r1 = await ensureBuyerMoveCase(svc as any, { transactionId, brokerageId, now: new Date("2099-01-01T00:00:00Z") })
    check("live: created the move case", r1.created && !!r1.case)
    if (r1.case) cleanup.push({ table: "buyer_move_cases", id: r1.case.id })
    check("live: checklist has the full 10 tasks", (r1.case?.tasks?.length ?? 0) === 10)
    check("live: closing 4 days out with essentials open ⇒ recommends handoff", r1.case?.recommended_mode === "handoff")
    const startFriction = r1.case?.friction_score ?? 0
    check("live: friction is high at the seeded crunch", startFriction >= 0.6)

    // Mark all essentials done → friction must drop.
    let last = r1.case
    for (const t of (r1.case?.tasks ?? []).filter((x: MoveTask) => x.group === "essential")) {
      const u = await updateMoveTask(svc as any, { transactionId, brokerageId, taskType: t.type, status: "done", now: new Date("2099-01-01T00:00:00Z") })
      last = u.case
    }
    check("live: after all essentials done, friction dropped", (last?.friction_score ?? 1) < startFriction)
    check("live: with essentials handled, recommendation returns to guided", last?.recommended_mode === "contact_assisted_guided_diy")

    const r2 = await ensureBuyerMoveCase(svc as any, { transactionId, brokerageId, now: new Date("2099-01-01T00:00:00Z") })
    check("live: idempotent — second ensure does NOT create a new row", !r2.created)
    check("live: idempotent ensure preserves the buyer's task edits", (r2.case?.tasks ?? []).filter((t: MoveTask) => t.group === "essential" && t.status === "done").length === 5)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    await svc.from("transactions").update({ close_date: priorClose }).eq("id", transactionId).eq("close_date", "2099-01-05")
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
  if (fail > 0) { console.log(" ❌ BUYER_MOVE_FAIL"); process.exit(1) }
  console.log(" ✅ BUYER_MOVE_PASS — dated move-in checklist + friction + two-mode decision; guided-DIY in-app, handoff recommendation gated behind the feature flag")
}
main()
