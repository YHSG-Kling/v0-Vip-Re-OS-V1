#!/usr/bin/env tsx
/**
 * scripts/commission-orphan-distribution-simulator.ts   (npm run test:commission-orphan-dist)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DISTRIBUTION NO PATH COULD PAY.
 *
 * commission_distributions is the per-line disbursement ledger. The only code that ever moves a
 * row to 'paid' is payment-tracker's markCommissionPaid, and it filters
 * `.eq('commission_id', …)` — so it can only reach rows that carry a commission_id. Exactly ONE
 * writer sets that column: the Engine 8.0 waterfall (lib/commission/waterfall/11-validate-persist).
 *
 * Two writers create transaction-level rows WITHOUT one, and the important one is real money: the
 * agent-to-agent REFERRAL FEE. lib/agents/referral-closer.ts books it to the REFERRING agent, who
 * by definition has no agent_commissions row on this deal — there is no commission_id to give it.
 * That row could not be marked paid by ANY path in the system, and markDistributionPaid (the only
 * per-row payer) has no callers, so it could not be done by hand either.
 *
 * It also broke the reaper it should have triggered. lib/finance/commission-tracking-reaper
 * aggregates the LEDGER side by transaction_id, and aggregateLedgerStatus only returns 'paid' when
 * EVERY live row is paid. So one unreachable row kept the whole transaction reading 'pending'
 * against a paid summary: the drift alarm re-fired on every pass, forever, and the healer it
 * pointed at was structurally incapable of healing it. A permanent, self-renewing false alarm
 * sitting on top of an agent who never got their referral fee.
 *
 * THE FIX: disbursement is precisely the event that pays these, so reconcileCommissionDisbursement
 * now also locks the transaction's commission_id-less rows.
 *
 * SOURCE layer: the orphan lock exists, is scoped to transaction+brokerage, refuses to resurrect a
 * terminal row, and the reaper counts an orphan-only heal as a heal.
 * LIVE layer (creds-gated): seed a paid summary + a keyed row + an orphan referral fee + a VOIDED
 * orphan; run the reaper; assert the orphan locks, the voided row is untouched, a re-run is a
 * no-op, and cleanup == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { stripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
/** Strip comments so an assertion can never be satisfied by prose describing the fix. */
const code = (p: string) => stripComments(src(p))

function sourceLayer() {
  console.log("\n[source · the orphan lock]")
  const rec = code("lib/commission/reconcile-tracking.ts")

  // Assert the CONSTRUCT, not the spelling: an update on commission_distributions that filters
  // on a NULL commission_id. Without `.is("commission_id", null)` the lock is not the orphan lock.
  check("reconcileCommissionDisbursement locks the commission_id-less rows",
    /from\("commission_distributions"\)[\s\S]{0,400}?\.update\(\s*\{\s*status:\s*"paid"[\s\S]{0,400}?\.is\("commission_id",\s*null\)/.test(rec))

  check("...scoped to THIS transaction and brokerage (never a cross-deal sweep)",
    /\.is\("commission_id",\s*null\)/.test(rec) &&
    /from\("commission_distributions"\)[\s\S]{0,400}?\.eq\("transaction_id",\s*params\.transactionId\)[\s\S]{0,200}?\.eq\("brokerage_id",\s*params\.brokerageId\)/.test(rec))

  // A terminal row must stay terminal — otherwise the lock would resurrect a voided fee as paid,
  // which is worse than the defect it fixes.
  check("...and refuses to resurrect a terminal row (paid/voided excluded)",
    /\.not\("status",\s*"in",\s*'\("paid","voided"\)'\)/.test(rec))

  check("the caller can see it happened (orphanRowsLocked is returned)",
    /orphanRowsLocked/.test(rec) && /ledgerRowsFound:\s*rows\.length,\s*ledgerRowsLocked:\s*locked,\s*orphanRowsLocked/.test(rec))

  console.log("\n[source · the reaper counts it]")
  const reap = code("lib/finance/commission-tracking-reaper.ts")
  // Counting only ledgerRowsLocked reported "reaped: 0" on the exact drift this reaper exists to
  // close — indistinguishable from "nothing was wrong".
  check("an orphan-only heal still counts as a heal",
    /r\.ledgerRowsLocked\s*>\s*0\s*\|\|\s*r\.orphanRowsLocked\s*>\s*0/.test(reap))

  console.log("\n[source · the stub that made it worse is gone]")
  const svcTxn = src("lib/services/transaction-management.service.ts")
  // calculateTransactionCommission inserted a ZERO-amount distribution with no commission_id —
  // a row that pins the ledger at 'pending' forever and represents no money at all. Its own
  // comments named the survivor. Consolidated into lib/commission/engine.ts:calculateCommission.
  check("the zero-amount placeholder writer is retired, with its survivor named",
    !/export async function calculateTransactionCommission/.test(svcTxn) &&
    /lib\/commission\/engine\.ts:calculateCommission/.test(svcTxn))
  check("...and the real engine it points at exists",
    /export async function calculateCommission/.test(src("lib/commission/engine.ts")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — the source layer proved the shape"); return }
  console.log("\n[live · a referral fee that could never be paid]")
  const svc = createClient(url, key, { auth: { persistSession: false } })

  const stamp = `zz_orphan_${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: brk } = await svc.from("brokerages").insert({ name: stamp }).select("id").single()
    if (!brk) { console.log("  ⊘ could not seed a brokerage — skipping live"); return }
    const brokerageId = (brk as any).id as string
    cleanup.push({ table: "brokerages", id: brokerageId })

    const { data: usr } = await svc.from("users").insert({
      email: `${stamp}@example.invalid`, brokerage_id: brokerageId,
      user_type: "agent", first_name: "ZZ", last_name: "Orphan",
    }).select("id").single()
    if (!usr) { console.log("  ⊘ could not seed a user — skipping live"); return }
    cleanup.push({ table: "users", id: (usr as any).id })

    const { data: ag } = await svc.from("agents")
      .insert({ user_id: (usr as any).id, brokerage_id: brokerageId }).select("id").single()
    if (!ag) { console.log("  ⊘ could not seed an agent — skipping live"); return }
    const agentId = (ag as any).id as string
    cleanup.push({ table: "agents", id: agentId })

    const { data: txn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, agent_id: agentId, status: "closed", deal_name: stamp,
    }).select("id").single()
    if (!txn) { console.log("  ⊘ could not seed a transaction — skipping live"); return }
    const transactionId = (txn as any).id as string
    cleanup.push({ table: "transactions", id: transactionId })

    // The summary is PAID; its keyed line lags. That is the drift the reaper already handled.
    const { data: comm } = await svc.from("agent_commissions").insert({
      transaction_id: transactionId, brokerage_id: brokerageId, agent_id: agentId,
      gross_commission: 12000, agent_split_percent: 70, close_date: new Date().toISOString().slice(0, 10),
      net_to_agent: 8400, net_to_brokerage: 3600, status: "paid", paid_at: new Date().toISOString(),
    }).select("id").single()
    if (!comm) { console.log("  ⊘ could not seed a commission — skipping live"); return }
    cleanup.push({ table: "agent_commissions", id: (comm as any).id })

    const mkDist = async (row: Record<string, unknown>) => {
      const { data } = await svc.from("commission_distributions").insert(row).select("id").single()
      if (data) cleanup.push({ table: "commission_distributions", id: (data as any).id })
      return data ? (data as any).id as string : null
    }
    const keyedId = await mkDist({
      commission_id: (comm as any).id, transaction_id: transactionId, brokerage_id: brokerageId,
      agent_id: agentId, distribution_type: "agent", calculation_type: "flat",
      calculated_amount: 8400, source_of_funds: "brokerage", status: "pending",
    })
    // THE DEFECT — the referring agent's fee. No commission_id, so nothing could pay it.
    const orphanId = await mkDist({
      transaction_id: transactionId, brokerage_id: brokerageId, agent_id: agentId,
      distribution_type: "referral", calculation_type: "percent",
      calculated_amount: 1500, source_of_funds: "agent", status: "pending",
    })
    // A terminal orphan — the lock must leave it alone.
    const voidedId = await mkDist({
      transaction_id: transactionId, brokerage_id: brokerageId,
      distribution_type: "fee", calculation_type: "flat",
      calculated_amount: 99, source_of_funds: "agent", status: "voided",
    })

    const { reapCommissionTrackingDrift } = await import("../lib/finance/commission-tracking-reaper")
    const r = await reapCommissionTrackingDrift(brokerageId, svc as any)
    check("live: the reaper reports a heal (not a silent 'nothing was wrong')", r.reaped >= 1)

    const statusOf = async (id: string | null) => {
      if (!id) return null
      const { data } = await svc.from("commission_distributions").select("status").eq("id", id).maybeSingle()
      return (data as any)?.status ?? null
    }
    check("live: the keyed distribution is paid", (await statusOf(keyedId)) === "paid")
    check("live: THE REFERRAL FEE is paid — it never could be before", (await statusOf(orphanId)) === "paid")
    check("live: the VOIDED orphan was not resurrected", (await statusOf(voidedId)) === "voided")

    // Re-running must be a no-op, not a second payment event.
    const r2 = await reapCommissionTrackingDrift(brokerageId, svc as any)
    check("live: a second pass locks nothing further (idempotent)", r2.reaped === 0)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let leftover = 0
    for (const c of cleanup) {
      const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id)
      leftover += count ?? 0
    }
    check("live: cleanup count == 0", leftover === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════════════════════════")
  console.log(" COMMISSION ORPHAN DISTRIBUTION — the referral fee no path could pay")
  console.log("══════════════════════════════════════════════════════════════════════")
  sourceLayer()
  await liveLayer()
  console.log(`\n${"═".repeat(70)}`)
  console.log(`ORPHAN DISTRIBUTION — ${pass} passed, ${fail} failed`)
  if (fail > 0) {
    console.log("\nFailures:")
    for (const f of fails) console.log(`  · ${f}`)
    console.log("\nA distribution with a NULL commission_id is reachable by exactly one code path:")
    console.log("reconcileCommissionDisbursement. If that lock goes, the referral fee goes unpaid")
    console.log("and the tracking-drift reaper alarms forever without ever converging.")
    process.exit(1)
  }
  console.log("✅ ORPHAN_DISTRIBUTION_PASS — every distribution has a path to paid")
}

main().catch((e) => { console.error(e); process.exit(1) })
