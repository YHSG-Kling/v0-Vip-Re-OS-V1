#!/usr/bin/env tsx
/**
 * scripts/deadline-watcher-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * CALENDAR DEADLINE WATCHER harness — the deal-critical watcher the domain audit
 * found fully built but NEVER SCHEDULED (and running on the cookie-bound client,
 * which sees nothing in a cron). Inspections / appraisals / financing deadlines /
 * walkthroughs / closings within 24h now actually notify.
 *
 * Layer (live, gated): seed three calendar events — one inspection due in 2h
 * (must notify + be marked), one already-passed (must NOT notify — the time floor),
 * one 3 days out (must NOT notify yet) — run the REAL checkUpcomingDeadlines, assert,
 * clean up.
 *
 * Run: npx tsx scripts/deadline-watcher-simulator.ts  (npm run test:deadline-watcher)
 */
// calendar-deadline-watcher is `server-only` since it fires through the kernel
// spine (lib/kernel/emit.ts, wave 26). Neutralize the marker in the require
// cache BEFORE importing anything that transitively pulls it — the
// accounting-scopes / buyer-intent-conversion simulators' established idiom.
import { createRequire } from "node:module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* server-only not resolvable — nothing to shim */ }
// Dynamic import: a static ESM import would hoist above the shim.
const { checkUpcomingDeadlines } = await import("../lib/kernel/calendar-deadline-watcher")

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
  console.log(" ✅ Deadline watcher verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Calendar deadline watcher simulator")
  console.log("══════════════════════════════════════════════════")

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (DB-driven watcher; no pure layer).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const cleanup: string[] = []

  try {
    const { data: txn } = await svc.from("transactions").select("id, brokerage_id").not("brokerage_id", "is", null).limit(1).single()
    if (!txn) { console.log("  ⏭  Skipped — need a transaction."); report(); return }
    const brokerageId = (txn as any).brokerage_id
    const entityId = (txn as any).id

    const seed = async (offsetH: number) => {
      const { data } = await svc.from("calendar_events").insert({
        brokerage_id: brokerageId, entity_type: "transaction", entity_id: entityId,
        event_type: "inspection", start_at: new Date(Date.now() + offsetH * 3_600_000).toISOString(),
        end_at: new Date(Date.now() + (offsetH + 1) * 3_600_000).toISOString(),
        deadline_notified: false, title: "__dwsim__ inspection",
      }).select("id").single()
      cleanup.push((data as any).id)
      return (data as any).id as string
    }
    const dueSoon = await seed(2)    // due in 2h → must notify + mark
    const past    = await seed(-6)   // already passed → time floor skips it
    const farOut  = await seed(72)   // 3 days out → not yet

    await checkUpcomingDeadlines(svc)

    const flag = async (id: string) => {
      const { data } = await svc.from("calendar_events").select("deadline_notified").eq("id", id).single()
      return (data as any).deadline_notified as boolean
    }
    check("due-in-2h inspection was notified + marked", (await flag(dueSoon)) === true)
    check("already-passed event NOT notified (time floor)", (await flag(past)) === false)
    check("3-days-out event NOT notified yet", (await flag(farOut)) === false)

    // Idempotency: a second run does not re-process the marked event (stays true, no error).
    await checkUpcomingDeadlines(svc)
    check("idempotent: second run leaves the marked event marked", (await flag(dueSoon)) === true)
  } finally {
    for (const id of cleanup) {
      try { await svc.from("calendar_events").delete().eq("id", id) } catch { /* noop */ }
    }
    const { count } = await svc.from("calendar_events").select("id", { count: "exact", head: true }).eq("title", "__dwsim__ inspection")
    check("cleanup verified — 0 seeded events remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
