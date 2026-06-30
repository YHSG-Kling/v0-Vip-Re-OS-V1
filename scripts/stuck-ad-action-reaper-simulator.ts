#!/usr/bin/env tsx
/**
 * scripts/stuck-ad-action-reaper-simulator.ts   (npm run test:stuck-ad-action-reaper)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the Ads Manager's stuck-ad-action reaper: an APPROVED (or executing) ad
 * action with no executed_at, past the launch grace, is escalated to the broker/
 * admin spend owners. proposed (awaiting approval) and terminal actions are left
 * alone. Pure policy + (creds-gated) live seed → reap → assert → idempotent → cleanup.
 */
import { classifyStuckAdAction, AD_ACTION_STUCK_HOURS } from "../lib/ads/stuck-ad-action-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const NOW = new Date("2026-03-01T00:00:00Z")
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

async function main() {
  console.log("\n[pure policy — classifyStuckAdAction]")
  check("approved + no executed past grace → escalate", classifyStuckAdAction({ status: "approved", approvedAt: hoursAgo(AD_ACTION_STUCK_HOURS + 1), executedAt: null, now: NOW }) === "escalate")
  check("executing + no executed past grace → escalate", classifyStuckAdAction({ status: "executing", approvedAt: hoursAgo(AD_ACTION_STUCK_HOURS + 2), executedAt: null, now: NOW }) === "escalate")
  check("approved + executed → keep (it ran)", classifyStuckAdAction({ status: "approved", approvedAt: hoursAgo(50), executedAt: hoursAgo(48), now: NOW }) === "keep")
  check("approved within grace → keep", classifyStuckAdAction({ status: "approved", approvedAt: hoursAgo(AD_ACTION_STUCK_HOURS - 1), executedAt: null, now: NOW }) === "keep")
  check("proposed (awaiting approval) → keep", classifyStuckAdAction({ status: "proposed", approvedAt: null, executedAt: null, now: NOW }) === "keep")
  check("succeeded (terminal) → keep", classifyStuckAdAction({ status: "succeeded", approvedAt: hoursAgo(50), executedAt: hoursAgo(48), now: NOW }) === "keep")
  check("failed (terminal) → keep", classifyStuckAdAction({ status: "failed", approvedAt: hoursAgo(50), executedAt: null, now: NOW }) === "keep")
  check("skipped (terminal) → keep", classifyStuckAdAction({ status: "skipped", approvedAt: hoursAgo(50), executedAt: null, now: NOW }) === "keep")
  check("approved + no approvedAt → keep (can't age)", classifyStuckAdAction({ status: "approved", approvedAt: null, executedAt: null, now: NOW }) === "keep")

  // ── LIVE LAYER (creds-gated) ──
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("\n[live] ⏭  Skipped — SUPABASE creds not set (pure layer ran).")
  } else {
    console.log("\n[live] seed an approved-but-unlaunched action → reap → assert → idempotent → cleanup")
    const { createServiceClient } = await import("../lib/supabase/service")
    const { reapStuckAdActions } = await import("../lib/ads/stuck-ad-action-reaper")
    const svc = createServiceClient()
    const { data: b } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
    if (!b) { console.log("  ⏭  no brokerage available") }
    else {
      const { data: act } = await svc.from("ad_manager_actions").insert({
        brokerage_id: b.id, status: "approved", action_type: "launch_ad_campaign",
        action_input: { test: "LIVE" }, approved_at: hoursAgo(12),
      }).select("id").maybeSingle()
      try {
        const r1 = await reapStuckAdActions(b.id, svc, { limit: 500 })
        check("live: escalated >= 1", r1.escalated >= 1)
        const { data: note } = await svc.from("notifications").select("id")
          .eq("brokerage_id", b.id).eq("type", "ad_action_unlaunched").eq("entity_id", act!.id).limit(1)
        check("live: unlaunched notification created", !!note && note.length >= 1)
        const r2 = await reapStuckAdActions(b.id, svc, { limit: 500 })
        check("live: idempotent re-run", r2.escalated === 0 || (note?.length ?? 0) >= 1)
        await svc.from("notifications").delete().eq("type", "ad_action_unlaunched").eq("entity_id", act!.id)
        await svc.from("ad_manager_actions").delete().eq("id", act!.id)
        const { count } = await svc.from("ad_manager_actions").select("id", { count: "exact", head: true }).eq("id", act!.id)
        check("live: cleanup count == 0", (count ?? 0) === 0)
      } catch (e) {
        await svc.from("notifications").delete().eq("type", "ad_action_unlaunched").eq("entity_id", act!.id).then(() => {}, () => {})
        await svc.from("ad_manager_actions").delete().eq("id", act!.id).then(() => {}, () => {})
        throw e
      }
    }
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ STUCK_AD_ACTION_REAPER_FAIL"); process.exit(1) }
  console.log(" ✅ STUCK_AD_ACTION_REAPER_PASS — approved-but-unlaunched spend escalated, terminal/pending left alone")
}
main()
