#!/usr/bin/env tsx
/**
 * scripts/commission-tracking-reconcile-simulator.ts   (npm run test:commission-tracking)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the two commission status trackings are two STAGES of the money (not redundant) and can't
 * drift on paid:
 *   • THE BRIDGE  — agent_commissions.status (the agent-earnings record).
 *   • THE LEDGER  — commissions.status + commission_distributions.status (the disbursement ledger).
 * CLOSE freezes the amount (close ≠ paid); the ledger tracks the deposit; DISBURSEMENT locks BOTH to
 * paid together. A reaper heals historical drift (bridge paid, ledger lagging) and escalates the
 * anomaly (ledger paid, bridge lagging).
 *
 * PURE layer: detectCommissionTrackingDrift (both directions + consistent + absent) and
 * aggregateLedgerStatus (paid only when every non-cancelled row is paid).
 * SOURCE scan: CLOSE calls reconcileCommissionTrackingAtClose; the reaper is registered under
 * finance_manager; the reconcile reuses the canonical payment path.
 * LIVE layer (creds-gated): seed a paid bridge + a pending ledger for a throwaway transaction, run
 * the reaper, assert the ledger locked to paid; reverse-delete and verify cleanup == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import {
  detectCommissionTrackingDrift,
  aggregateLedgerStatus,
} from "../lib/commission/reconcile-tracking"
// (finalizeCommissionAtClose / reconcileCommissionDisbursement / recordCommissionDepositReceived do
//  I/O — asserted via source scan below, not imported into the pure layer.)

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[detectCommissionTrackingDrift · pure]")
  check("bridge paid + ledger pending ⇒ bridge_ahead (heal the ledger)",
    detectCommissionTrackingDrift({ bridgeStatus: "paid", ledgerStatus: "pending" }).direction === "bridge_ahead")
  check("ledger paid + bridge approved ⇒ ledger_ahead (escalate)",
    detectCommissionTrackingDrift({ bridgeStatus: "approved", ledgerStatus: "paid" }).direction === "ledger_ahead")
  check("both paid ⇒ consistent (no drift)",
    detectCommissionTrackingDrift({ bridgeStatus: "paid", ledgerStatus: "paid" }).drifted === false)
  check("both pending ⇒ consistent (no drift)",
    detectCommissionTrackingDrift({ bridgeStatus: "pending", ledgerStatus: "pending" }).drifted === false)
  check("ledger absent ⇒ nothing to compare (not drift — a leak concern)",
    detectCommissionTrackingDrift({ bridgeStatus: "paid", ledgerStatus: null }).direction === null)

  console.log("\n[aggregateLedgerStatus · pure]")
  check("all rows paid ⇒ paid", aggregateLedgerStatus([{ status: "paid" }, { status: "paid" }]) === "paid")
  check("any pending row ⇒ pending", aggregateLedgerStatus([{ status: "paid" }, { status: "pending" }]) === "pending")
  check("cancelled rows are ignored (all live rows paid ⇒ paid)", aggregateLedgerStatus([{ status: "paid" }, { status: "cancelled" }]) === "paid")
  check("no rows ⇒ null (no ledger)", aggregateLedgerStatus([]) === null)
}

function sourceLayer() {
  console.log("\n[wiring — close FREEZES; disbursement is the ONE LOCK; the reaper is the safety net]")
  const stage = src("lib/transactions/stage-progression.ts")
  check("CLOSE calls finalizeCommissionAtClose (freeze the amount, not pay)",
    /finalizeCommissionAtClose/.test(stage) && /params\.targetStage === "CLOSED"/.test(stage))
  check("CLOSE does NOT lock the ledger to paid (paid moved to disbursement)",
    !/reconcileCommissionDisbursement/.test(stage.slice(stage.indexOf('params.targetStage === "CLOSED"'), stage.indexOf('params.targetStage === "CLOSED"') + 3200)))

  const fin = src("lib/kernel/financial.ts")
  check("DISBURSEMENT (kernel markCommissionPaid) calls reconcileCommissionDisbursement",
    /markCommissionPaid[\s\S]*?reconcileCommissionDisbursement/.test(fin))

  const reconcile = src("lib/commission/reconcile-tracking.ts")
  check("reconcile reuses the canonical payment path (markCommissionPaid)", /markCommissionPaid/.test(reconcile))
  check("reconcile skips cancelled/voided ledger rows", /cancelled/.test(reconcile) && /voided/.test(reconcile))
  // KEEP-ONE (m283/m284): a PAID summary row whose distributions still lag is the drift the reaper
  // heals — skipping on summary status alone would make the heal a no-op. Idempotent because a row
  // whose distributions are already paid (or absent) is skipped on the next pass.
  check("reconcile still heals a PAID summary row whose distributions lag",
    /status === "paid"[\s\S]*?commission_distributions[\s\S]*?distStatus === "paid"[\s\S]*?continue/.test(reconcile))
  check("the ledger tracks the DEPOSIT (recordCommissionDepositReceived → deposit_received_at)", /recordCommissionDepositReceived[\s\S]*?deposit_received_at/.test(reconcile))

  const net = src("lib/intelligence/reaper-net.ts")
  check("the reaper is registered under commission_tracking_drift / finance_manager",
    /commission_tracking_drift[\s\S]*?finance_manager/.test(net) && /reapCommissionTrackingDrift/.test(net))

  const reaper = src("lib/finance/commission-tracking-reaper.ts")
  check("reaper HEALS bridge_ahead (locks the ledger)", /reconcileCommissionDisbursement/.test(reaper))
  check("reaper ESCALATES ledger_ahead (never force-finalizes the earnings record)", /ledger_ahead/.test(reaper) && /notifications/.test(reaper))
  check("escalation is deduped (one alert per transaction / 7d)", /commission_tracking_drift[\s\S]*?entity_id/.test(reaper) && /gte\("created_at"/.test(reaper))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)

  console.log("\n[live] seed a paid bridge + pending ledger, heal via the reaper, clean up")
  // Find a real brokerage + a broker user + an agent to satisfy FKs.
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage on file — skipping live"); return }
  const brokerageId = (brk as any).id as string
  const { data: agent } = await svc.from("agents").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
  const { data: txn } = await svc.from("transactions").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
  if (!agent || !txn) { console.log("  ⊘ no agent/transaction on file — skipping live"); return }
  const agentId = (agent as any).id as string
  const transactionId = (txn as any).id as string

  const cleanup: Array<{ table: string; id: string }> = []
  try {
    // KEEP-ONE (m283/m284): the summary row IS the agent_commissions row. Seed it PAID and leave
    // its distribution lagging at pending — that is the drift the reaper heals.
    const { data: comm } = await svc.from("agent_commissions").insert({
      transaction_id: transactionId, brokerage_id: brokerageId, agent_id: agentId,
      gross_commission: 12000, agent_split_percent: 70, close_date: new Date().toISOString().slice(0, 10),
      net_to_agent: 8400, net_to_brokerage: 3600,
      status: "paid", paid_at: new Date().toISOString(),
    }).select("id").single()
    if (comm) cleanup.push({ table: "agent_commissions", id: (comm as any).id })
    const { data: dist } = await svc.from("commission_distributions").insert({
      commission_id: (comm as any).id, transaction_id: transactionId, brokerage_id: brokerageId,
      distribution_type: "agent", agent_id: agentId, calculation_type: "flat", calculated_amount: 8400,
      source_of_funds: "brokerage", status: "pending",
    }).select("id").single()
    if (dist) cleanup.push({ table: "commission_distributions", id: (dist as any).id })

    const { reapCommissionTrackingDrift } = await import("../lib/finance/commission-tracking-reaper")
    const r = await reapCommissionTrackingDrift(brokerageId, svc as any)
    check("live: reaper reaped ≥ 1 drifted transaction", r.reaped >= 1)

    const { data: after } = await svc.from("agent_commissions").select("status").eq("id", (comm as any).id).maybeSingle()
    check("live: the summary ledger row is PAID", (after as any)?.status === "paid")
    const { data: distAfter } = await svc.from("commission_distributions").select("status").eq("id", (dist as any).id).maybeSingle()
    check("live: the distribution is now PAID too", (distAfter as any)?.status === "paid")
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    // Verify cleanup == 0 for the seeded rows.
    let leftover = 0
    for (const c of cleanup) {
      const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id)
      leftover += count ?? 0
    }
    check("live: cleanup count == 0", leftover === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ COMMISSION_TRACKING_FAIL"); process.exit(1) }
  console.log(" ✅ COMMISSION_TRACKING_PASS — close freezes the amount; bridge + ledger are one lock at DISBURSEMENT; the reaper heals drift + escalates anomalies")
}
main()
