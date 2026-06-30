#!/usr/bin/env tsx
/**
 * scripts/cda-delivery-reaper-simulator.ts   (npm run test:cda-delivery-reaper)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the Deal Coordinator's CDA-delivery reaper: a CDA that is 'approved' but
 * never delivered to title (sent_to_title_at null), past the grace, on the CDA-to-
 * title model (uses_cda !== false), is escalated. Non-approved, already-delivered,
 * brokerage-payout (uses_cda false), and within-grace CDAs are left alone. Pure
 * policy + (creds-gated) live seed → reap → assert → idempotent → cleanup.
 */
import { classifyUndeliveredCda, CDA_DELIVERY_GRACE_HOURS } from "../lib/transactions/cda-delivery-policy"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const NOW = new Date("2026-03-01T00:00:00Z")
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

async function main() {
  console.log("\n[pure policy — classifyUndeliveredCda]")
  check("approved + unsent + past grace + uses_cda → escalate", classifyUndeliveredCda({ status: "approved", sentToTitleAt: null, usesCda: true, updatedAt: hoursAgo(CDA_DELIVERY_GRACE_HOURS + 1), now: NOW }) === "escalate")
  check("approved + unsent + uses_cda null (default to-title) → escalate", classifyUndeliveredCda({ status: "approved", sentToTitleAt: null, usesCda: null, updatedAt: hoursAgo(CDA_DELIVERY_GRACE_HOURS + 1), now: NOW }) === "escalate")
  check("approved + within grace → keep", classifyUndeliveredCda({ status: "approved", sentToTitleAt: null, usesCda: true, updatedAt: hoursAgo(CDA_DELIVERY_GRACE_HOURS - 1), now: NOW }) === "keep")
  check("approved + already sent → keep", classifyUndeliveredCda({ status: "approved", sentToTitleAt: hoursAgo(20), usesCda: true, updatedAt: hoursAgo(40), now: NOW }) === "keep")
  check("uses_cda FALSE (brokerage payout) → keep", classifyUndeliveredCda({ status: "approved", sentToTitleAt: null, usesCda: false, updatedAt: hoursAgo(40), now: NOW }) === "keep")
  check("submitted (not yet approved) → keep", classifyUndeliveredCda({ status: "submitted", sentToTitleAt: null, usesCda: true, updatedAt: hoursAgo(40), now: NOW }) === "keep")
  check("pending → keep", classifyUndeliveredCda({ status: "pending", sentToTitleAt: null, usesCda: true, updatedAt: hoursAgo(40), now: NOW }) === "keep")
  check("rejected/cancelled → keep", classifyUndeliveredCda({ status: "cancelled", sentToTitleAt: null, usesCda: true, updatedAt: hoursAgo(40), now: NOW }) === "keep")
  check("no updated_at → keep (can't age)", classifyUndeliveredCda({ status: "approved", sentToTitleAt: null, usesCda: true, updatedAt: null, now: NOW }) === "keep")

  // ── LIVE LAYER (creds-gated) ──
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("\n[live] ⏭  Skipped — SUPABASE creds not set (pure layer ran).")
  } else {
    console.log("\n[live] seed an approved-but-unsent CDA → reap → assert → idempotent → cleanup")
    const { createServiceClient } = await import("../lib/supabase/service")
    const { reapUndeliveredCdas } = await import("../lib/transactions/cda-delivery-reaper")
    const svc = createServiceClient()
    const { data: c } = await svc.from("contacts").select("id, brokerage_id, agent_id").not("agent_id", "is", null).limit(1).maybeSingle()
    if (!c) { console.log("  ⏭  no contact-with-agent available") }
    else {
      // closing_disclosure_agreement.agent_id references users(id) (not agents) — resolve it.
      const { data: ag } = await svc.from("agents").select("user_id").eq("id", c.agent_id).maybeSingle()
      const cdaUserId = (ag as { user_id?: string | null } | null)?.user_id ?? null
      const { data: txn } = await svc.from("transactions").insert({
        brokerage_id: c.brokerage_id, contact_id: c.id, status: "closing", deal_name: "LIVE cda delivery",
      }).select("id").maybeSingle()
      const { data: cda } = await svc.from("closing_disclosure_agreement").insert({
        brokerage_id: c.brokerage_id, transaction_id: txn!.id, agent_id: cdaUserId,
        status: "approved", uses_cda: true, sent_to_title_at: null, updated_at: hoursAgo(24),
      }).select("id").maybeSingle()
      try {
        const r1 = await reapUndeliveredCdas(c.brokerage_id, svc, { limit: 500 })
        check("live: escalated >= 1", r1.escalated >= 1)
        const { data: note } = await svc.from("notifications").select("id, priority")
          .eq("brokerage_id", c.brokerage_id).eq("type", "cda_undelivered").eq("entity_id", cda!.id).maybeSingle()
        check("live: high-priority CDA-undelivered notification", !!note && (note as any).priority === "high")
        const r2 = await reapUndeliveredCdas(c.brokerage_id, svc, { limit: 500 })
        check("live: idempotent re-run", r2.escalated === 0 || !!note)
        await svc.from("notifications").delete().eq("type", "cda_undelivered").eq("entity_id", cda!.id)
        await svc.from("closing_disclosure_agreement").delete().eq("id", cda!.id)
        await svc.from("transactions").delete().eq("id", txn!.id)
        const { count } = await svc.from("closing_disclosure_agreement").select("id", { count: "exact", head: true }).eq("id", cda!.id)
        check("live: cleanup count == 0", (count ?? 0) === 0)
      } catch (e) {
        await svc.from("notifications").delete().eq("type", "cda_undelivered").eq("entity_id", cda?.id ?? "").then(() => {}, () => {})
        await svc.from("closing_disclosure_agreement").delete().eq("id", cda?.id ?? "").then(() => {}, () => {})
        await svc.from("transactions").delete().eq("id", txn?.id ?? "").then(() => {}, () => {})
        throw e
      }
    }
  }

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CDA_DELIVERY_REAPER_FAIL"); process.exit(1) }
  console.log(" ✅ CDA_DELIVERY_REAPER_PASS — undelivered approved CDAs escalated, payout-model/sent/pending left alone")
}
main()
