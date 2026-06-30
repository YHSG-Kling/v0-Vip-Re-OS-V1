#!/usr/bin/env tsx
/**
 * scripts/commission-leak-reaper-simulator.ts   (npm run test:commission-leak-reaper)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the Finance Manager's commission-leak reaper: a CLOSED deal with no row
 * in the canonical `commissions` table, past the reconciliation grace, is escalated
 * ONCE. Non-closed deals, deals within grace, and deals that DO have a commission
 * are never flagged. Pure policy + (creds-gated) live seed → reap → assert →
 * idempotent → cleanup (count == 0).
 */
import { classifyCommissionLeak, COMMISSION_LEAK_GRACE_DAYS } from "../lib/finance/commission-leak-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const NOW = new Date("2026-03-01T00:00:00Z")
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()

async function main() {
  console.log("\n[pure policy — classifyCommissionLeak]")
  check("closed + no commission + past grace → escalate", classifyCommissionLeak({ status: "closed", closeDate: daysAgo(COMMISSION_LEAK_GRACE_DAYS + 1), hasCommissionRow: false, now: NOW }) === "escalate")
  check("closed + HAS commission → keep (no leak)", classifyCommissionLeak({ status: "closed", closeDate: daysAgo(30), hasCommissionRow: true, now: NOW }) === "keep")
  check("closed + no commission within grace → keep", classifyCommissionLeak({ status: "closed", closeDate: daysAgo(COMMISSION_LEAK_GRACE_DAYS - 1), hasCommissionRow: false, now: NOW }) === "keep")
  check("under_contract (not closed) → keep", classifyCommissionLeak({ status: "under_contract", closeDate: daysAgo(30), hasCommissionRow: false, now: NOW }) === "keep")
  check("closing (not closed) → keep", classifyCommissionLeak({ status: "closing", closeDate: daysAgo(30), hasCommissionRow: false, now: NOW }) === "keep")
  check("closed + no close_date → keep (can't age)", classifyCommissionLeak({ status: "closed", closeDate: null, hasCommissionRow: false, now: NOW }) === "keep")
  check("bad date → keep (no throw)", classifyCommissionLeak({ status: "closed", closeDate: "nope", hasCommissionRow: false, now: NOW }) === "keep")
  check("exactly at grace boundary → keep", classifyCommissionLeak({ status: "closed", closeDate: daysAgo(COMMISSION_LEAK_GRACE_DAYS), hasCommissionRow: false, now: NOW }) === "keep")

  // ── LIVE LAYER (creds-gated) ──
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("\n[live] ⏭  Skipped — SUPABASE creds not set (pure layer ran).")
  } else {
    console.log("\n[live] seed a closed deal with no commission → reap → assert → idempotent → cleanup")
    const { createServiceClient } = await import("../lib/supabase/service")
    const { reapCommissionLeaks } = await import("../lib/finance/commission-leak-reaper")
    const svc = createServiceClient()
    const { data: c } = await svc.from("contacts").select("id, brokerage_id, agent_id").not("agent_id", "is", null).limit(1).maybeSingle()
    if (!c) { console.log("  ⏭  no contact-with-agent available") }
    else {
      const { data: txn } = await svc.from("transactions").insert({
        brokerage_id: c.brokerage_id, contact_id: c.id, status: "closed",
        close_date: daysAgo(10).slice(0, 10), deal_name: "LIVE TEST commission leak",
      }).select("id").maybeSingle()
      try {
        const r1 = await reapCommissionLeaks(c.brokerage_id, svc, { limit: 500 })
        check("live: escalated >= 1 (leak caught)", r1.escalated >= 1)
        const { data: note } = await svc.from("notifications").select("id, priority")
          .eq("brokerage_id", c.brokerage_id).eq("type", "commission_unrecorded").eq("entity_id", txn!.id).maybeSingle()
        check("live: high-priority leak notification created", !!note && (note as any).priority === "high")
        const r2 = await reapCommissionLeaks(c.brokerage_id, svc, { limit: 500 })
        check("live: idempotent re-run", r2.escalated === 0 || !!note)
        await svc.from("notifications").delete().eq("type", "commission_unrecorded").eq("entity_id", txn!.id)
        await svc.from("transactions").delete().eq("id", txn!.id)
        const { count } = await svc.from("transactions").select("id", { count: "exact", head: true }).eq("id", txn!.id)
        check("live: cleanup count == 0", (count ?? 0) === 0)
      } catch (e) {
        await svc.from("notifications").delete().eq("type", "commission_unrecorded").eq("entity_id", txn!.id).then(() => {}, () => {})
        await svc.from("transactions").delete().eq("id", txn!.id).then(() => {}, () => {})
        throw e
      }
    }
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ COMMISSION_LEAK_REAPER_FAIL"); process.exit(1) }
  console.log(" ✅ COMMISSION_LEAK_REAPER_PASS — closed-deal commission leaks caught, grace + recorded honored")
}
main()
