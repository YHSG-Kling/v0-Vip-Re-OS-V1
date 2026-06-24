#!/usr/bin/env tsx
/**
 * scripts/scraper-health-simulator.ts   (npm run test:scraper-health)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the scraper-failure → manager → human loop is CLOSED.
 *
 * Before: a scheduled scrape that failed to connect was recorded to
 * scraper_executions then ORPHANED — no manager, no human alert, so a dead source
 * silently dried up the lead funnel. Now the Data Steward owns scraping health: on
 * the Nth CONSECUTIVE failure for a (brokerage, source) the cron escalates via
 * scraper_source_failed (campaign_orchestrator → data_steward), and the steward
 * handler raises a HIGH notification to the brokerage broker/admins.
 *
 * Layer 1 (pure): shouldEscalateScraperFailure fires only on N consecutive failures
 *   (no spam on a transient blip; a recovery in the window cancels it).
 * Layer 2 (live, gated): seed N failed executions → escalate publishes the signal →
 *   the steward handler notifies the broker → re-escalating is idempotent (deduped).
 *   Reverse-delete; cleanup == 0.
 */
import { randomUUID } from "node:crypto"
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* nothing to shim */ }

import { shouldEscalateScraperFailure, SCRAPER_FAILURE_THRESHOLD } from "../lib/lead-pipeline/scraper-health"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function pureLayer(): void {
  console.log(`\n[Layer 1 · shouldEscalateScraperFailure — threshold ${SCRAPER_FAILURE_THRESHOLD}, most-recent-first]`)
  check("3 consecutive failures ⇒ escalate", shouldEscalateScraperFailure(["failed", "failed", "failed"]) === true)
  check("2 failures (below threshold count) ⇒ no escalate", shouldEscalateScraperFailure(["failed", "failed"]) === false)
  check("a recovery (most recent = completed) ⇒ no escalate", shouldEscalateScraperFailure(["completed", "failed", "failed", "failed"]) === false)
  check("a completed inside the window ⇒ no escalate", shouldEscalateScraperFailure(["failed", "completed", "failed"]) === false)
  check("3 failed then an OLD completed ⇒ escalate (window is the recent 3)", shouldEscalateScraperFailure(["failed", "failed", "failed", "completed"]) === true)
  check("empty history ⇒ no escalate", shouldEscalateScraperFailure([]) === false)
  check("custom threshold 2 honored", shouldEscalateScraperFailure(["failed", "failed"], 2) === true)
  check("nulls in history are not 'failed'", shouldEscalateScraperFailure([null, "failed", "failed"]) === false)
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the escalation rule")
    return
  }
  console.log("\n[Layer 2 · live — seed N failures → escalate → steward notifies broker → idempotent]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { escalateScraperFailureIfNeeded } = await import("../lib/lead-pipeline/scraper-health")
  const { SIGNAL_HANDLERS } = await import("../lib/kernel/manager-signals")
  const svc = createServiceClient()
  const tag = `scrh-sim-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const brokerUserId = randomUUID()
  const scraperType = "zillow_behavior"
  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} (scraper health)` })
    await svc.from("users").insert({ id: brokerUserId, brokerage_id: brokerageId, email: `${tag}@example.com`, user_type: "broker" })

    // Seed N consecutive failed executions (staggered started_at, most recent last insert).
    const base = Date.UTC(2026, 0, 1)
    const rows = Array.from({ length: SCRAPER_FAILURE_THRESHOLD }, (_, i) => ({
      id: randomUUID(), brokerage_id: brokerageId, scraper_type: scraperType, status: "failed",
      started_at: new Date(base + i * 3_600_000).toISOString(), error_message: "connection timeout",
    }))
    await svc.from("scraper_executions").insert(rows)

    const r1 = await escalateScraperFailureIfNeeded(svc, { brokerageId, scraperType, errorMessage: "connection timeout" })
    check("escalateScraperFailureIfNeeded escalated on the Nth consecutive failure", r1.escalated === true)

    const { data: sigs } = await svc.from("manager_signals").select("*")
      .eq("brokerage_id", brokerageId).eq("signal_type", "scraper_source_failed").eq("status", "open")
    const sigList = (sigs ?? []) as any[]
    check("one OPEN scraper_source_failed signal to the Data Steward", sigList.length === 1 && sigList[0].to_manager === "data_steward")
    check("signal entity_id is the scraper source", sigList[0]?.entity_id === scraperType)

    // The steward handler escalates to the broker as a HIGH notification.
    const sig = sigList[0]
    const handler = SIGNAL_HANDLERS["data_steward:scraper_source_failed"]
    const action = await handler({
      id: sig.id, fromManager: sig.from_manager, toManager: sig.to_manager, signalType: sig.signal_type,
      message: sig.message, entityType: sig.entity_type, entityId: sig.entity_id, contactId: sig.contact_id,
      payload: sig.payload ?? {}, status: "open", createdAt: sig.created_at,
    }, { brokerageId, supabase: svc })
    check("steward handler returned an action (alerted the broker)", !!action && action.includes("alerted"))

    const { data: notifs } = await svc.from("notifications").select("id, type, priority, user_id")
      .eq("brokerage_id", brokerageId).eq("type", "scraper_source_failed")
    const notifList = (notifs ?? []) as any[]
    check("a HIGH scraper_source_failed notification reached the broker", notifList.length === 1 && notifList[0].priority === "high" && notifList[0].user_id === brokerUserId)

    // Idempotent: re-escalating while the signal is open does NOT create a duplicate.
    await escalateScraperFailureIfNeeded(svc, { brokerageId, scraperType, errorMessage: "connection timeout" })
    const { count: openCount } = await svc.from("manager_signals").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("signal_type", "scraper_source_failed").eq("status", "open")
    check("re-escalating is idempotent (still exactly one open signal)", (openCount ?? 0) === 1)
  } finally {
    await svc.from("notifications").delete().eq("brokerage_id", brokerageId)
    await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId)
    await svc.from("scraper_executions").delete().eq("brokerage_id", brokerageId)
    await svc.from("users").delete().eq("id", brokerUserId)
    await svc.from("brokerages").delete().eq("id", brokerageId)
    const { count } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
    check("cleanup complete (no test rows remain)", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SCRAPER_HEALTH_FAIL"); process.exit(1) }
  console.log(" ✅ SCRAPER_HEALTH_PASS — a sustained scraper outage reaches the broker (loop closed)")
}

main().catch((e) => { console.error(e); process.exit(1) })
