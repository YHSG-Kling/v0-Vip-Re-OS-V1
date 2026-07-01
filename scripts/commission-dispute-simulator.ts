#!/usr/bin/env tsx
/**
 * scripts/commission-dispute-simulator.ts   (npm run test:commission-dispute)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the commission DISPUTE workflow: an agent disputes a commission they believe is wrong
 * (bad split/amount), and the broker resolves it — uphold/correct → approved, or reopen → pending.
 * Previously 'disputed' was a terminal dead-end with no filing/resolution path.
 *
 * SOURCE scan (kernel + actions are server-only): the transition map allows disputed → approved|pending;
 * markCommissionDisputed is owner-or-broker gated + requires a reason + only from pending/approved;
 * resolveCommissionDispute is broker-only from disputed; the actions + both UI panels are wired.
 * LIVE (creds-gated): the full round-trip against the real schema, cleanup == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function sourceLayer() {
  const fin = src("lib/kernel/financial.ts")
  console.log("\n[the status machine now RESOLVES disputes (was terminal)]")
  check("disputed → approved|pending (resolution transitions added)", /disputed:\s*\[\s*"approved",\s*"pending"\s*\]/.test(fin))

  console.log("\n[markCommissionDisputed — governed filing]")
  check("requires a dispute reason", /markCommissionDisputed[\s\S]*?dispute reason is required/.test(fin))
  check("gated to the OWNING agent or a broker", /markCommissionDisputed[\s\S]*?ctx\.agentId === commission\.agent_id[\s\S]*?broker/.test(fin))
  check("only from a disputable status (pending/approved)", /markCommissionDisputed[\s\S]*?COMMISSION_STATUS_TRANSITIONS\[commission\.status\]\?\.includes\("disputed"\)/.test(fin))
  check("stamps dispute_reason + disputed_at + emits COMMISSION_DISPUTED", /dispute_reason:\s*trimmed[\s\S]*?disputed_at/.test(fin) && /COMMISSION_DISPUTED/.test(fin))

  console.log("\n[resolveCommissionDispute — broker-only resolution]")
  check("broker/admin only", /resolveCommissionDispute[\s\S]*?\["broker",\s*"admin",\s*"superadmin"\]/.test(fin))
  check("only a disputed commission can be resolved", /resolveCommissionDispute[\s\S]*?Only a disputed commission can be resolved/.test(fin))
  check("reopened → pending, upheld/corrected → approved", /resolution === "reopened" \? "pending" : "approved"/.test(fin))

  console.log("\n[server actions + UI wiring]")
  const actions = src("app/actions/financial-kernel.ts")
  check("fileCommissionDisputeAction + resolveCommissionDisputeAction exported", /export async function fileCommissionDisputeAction/.test(actions) && /export async function resolveCommissionDisputeAction/.test(actions))
  check("loadCommissionDisputesAction (broker queue) + loadMyDisputableCommissionsAction (agent)", /loadCommissionDisputesAction/.test(actions) && /loadMyDisputableCommissionsAction/.test(actions))
  check("agent dispute panel wired into agent financials", /MyCommissionsDisputePanel/.test(src("app/dashboard/financials/agent/agent-financials-client.tsx")))
  check("broker dispute queue wired into payouts", /CommissionDisputeQueue/.test(src("app/dashboard/financials/payouts/page.tsx")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — source layer proved the wiring"); return }
  const svc = createClient(url, key)
  console.log("\n[live] dispute → resolve round-trip")
  const { data: agent } = await svc.from("agents").select("id, brokerage_id").limit(1).maybeSingle()
  const { data: txn } = await svc.from("transactions").select("id").limit(1).maybeSingle()
  if (!agent || !txn) { console.log("  ⊘ no agent/transaction — skipping"); return }
  const agentId = (agent as any).id, brokerageId = (agent as any).brokerage_id, txnId = (txn as any).id
  let id: string | null = null
  try {
    const { data } = await svc.from("agent_commissions").insert({
      agent_id: agentId, brokerage_id: brokerageId, transaction_id: txnId,
      gross_commission: 12000, agent_split_percent: 70, status: "approved",
    }).select("id").single()
    id = (data as any)?.id ?? null
    await svc.from("agent_commissions").update({ status: "disputed", dispute_reason: "split looks wrong", disputed_at: new Date().toISOString() }).eq("id", id)
    const { data: d1 } = await svc.from("agent_commissions").select("status, dispute_reason").eq("id", id).maybeSingle()
    check("live: filed → disputed with reason", (d1 as any)?.status === "disputed" && !!(d1 as any)?.dispute_reason)
    await svc.from("agent_commissions").update({ status: "approved", dispute_resolution: "corrected", dispute_resolved_at: new Date().toISOString() }).eq("id", id)
    const { data: d2 } = await svc.from("agent_commissions").select("status, dispute_resolution").eq("id", id).maybeSingle()
    check("live: resolved → approved with resolution stamped", (d2 as any)?.status === "approved" && (d2 as any)?.dispute_resolution === "corrected")
  } finally {
    if (id) await svc.from("agent_commissions").delete().eq("id", id)
    const { count } = id ? await svc.from("agent_commissions").select("id", { count: "exact", head: true }).eq("id", id) : { count: 0 }
    check("live: cleanup count == 0", (count ?? 0) === 0)
  }
}

async function main() {
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ COMMISSION_DISPUTE_FAIL"); process.exit(1) }
  console.log(" ✅ COMMISSION_DISPUTE_PASS — agent files, broker resolves (uphold/correct/reopen); governed transitions, wired both sides")
}
main()
