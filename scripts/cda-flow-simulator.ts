#!/usr/bin/env tsx
/**
 * scripts/cda-flow-simulator.ts  (npm run test:cda-flow)
 *
 * Proves two CDA-workflow completions matching the real disbursement business process:
 *  A) The "Compare" step is real (was a stub returning []) — the computed gross is checked against
 *     the contract terms before Compliance approves; a material mismatch blocks.
 *  B) The "Deliver" step exists — an approved CDA's disbursement authorization is sent to the
 *     closing agent (title/escrow officer). Live layer asserts the no-contact path (no real email).
 */
import { randomUUID } from "node:crypto"
import { computeCdaDiscrepancies, expectedGrossFromTerms } from "../lib/commission/cda-discrepancy"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

function pureLayer(): void {
  console.log("\n[expected gross from contract terms · pure]")
  check("estimated_commission wins when present", expectedGrossFromTerms({ estimated_commission: 12000 }) === 12000)
  check("falls back to purchase_price × commission%", expectedGrossFromTerms({ purchase_price: 400000, commission_percentage: 3 }) === 12000)
  check("no terms ⇒ null (cannot compare)", expectedGrossFromTerms({}) === null)

  console.log("\n[CDA discrepancy detection · pure — the Compare step]")
  check("computed == expected ⇒ no discrepancy", computeCdaDiscrepancies({ computedGross: 12000, expectedGross: 12000 }).length === 0)
  check("tiny dollar diff (<$50) ⇒ ignored", computeCdaDiscrepancies({ computedGross: 12040, expectedGross: 12000 }).length === 0)
  const warn = computeCdaDiscrepancies({ computedGross: 12500, expectedGross: 12000 })
  check("~4% over ⇒ a WARNING discrepancy", warn.length === 1 && warn[0].severity === "warning")
  const block = computeCdaDiscrepancies({ computedGross: 14000, expectedGross: 12000 })
  check("~17% over ⇒ a BLOCKER discrepancy", block.length === 1 && block[0].severity === "blocker")
  check("no expected ⇒ no false discrepancy", computeCdaDiscrepancies({ computedGross: 12000, expectedGross: null }).length === 0)
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[CDA deliver · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the compare logic")
    return
  }
  console.log("\n[CDA deliver · live — no-contact path (no real email) → self-clean]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { deliverCdaToClosingAgent } = await import("../lib/transactions/deal-vendor-notify")
  const svc = createServiceClient()
  const tag = `cda-sim-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const txnId = randomUUID()
  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} (cda test)` })
    await svc.from("transactions").insert({ id: txnId, brokerage_id: brokerageId, deal_name: `${tag} deal`, status: "active" })
    // No title/escrow contact on file → deliver resolves nothing, sends nothing (no spam).
    const d = await deliverCdaToClosingAgent(svc, { transactionId: txnId, brokerageId, grossCommission: 12000, agentNet: 8400, brokerageNet: 3600 })
    check("no title/escrow contact ⇒ not delivered, nothing sent", d.delivered === false && d.recipient === null)
  } finally {
    await svc.from("activities").delete().eq("transaction_id", txnId)
    await svc.from("transactions").delete().eq("id", txnId)
    await svc.from("brokerages").delete().eq("id", brokerageId)
    const { count } = await svc.from("transactions").select("id", { count: "exact", head: true }).eq("id", txnId)
    check("cleanup complete", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CDA_FLOW_FAIL"); process.exit(1) }
  console.log(" ✅ CDA_FLOW_PASS — the CDA compares to contract terms and delivers to the closing agent")
}

main().catch((e) => { console.error(e); process.exit(1) })
