#!/usr/bin/env tsx
/**
 * scripts/readiness-gate-simulator.ts   (npm run test:readiness-gate)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the AGENT READINESS HARD GATE — enforcement, not just a warning. A license/CE/ethics-BLOCKED
 * agent is stopped at the license-dependent chokepoints (sendDocumentForSignature + the buyer-offer
 * submitForSignature); a clear agent, a non-agent actor (broker/TC/support), and missing data all pass
 * (no false block). Reuses the canonical evaluator — no drift with the offer-time gate + the sweep.
 *
 * SOURCE: both signature chokepoints call checkAgentTransactable and refuse when not transactable.
 * LIVE (creds-gated): seed a lapsed agent (user+agent) → gate BLOCKS; clear the license → gate PASSES;
 *         a broker-admin user (no agents row) → PASSES; clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function sourceLayer() {
  console.log("\n[wiring — the gate is enforced at BOTH license-dependent signature chokepoints]")
  const gate = src("lib/compliance/agent-readiness-gate.ts")
  check("gate reuses the CANONICAL evaluateLicenseReadiness (no drift)", /evaluateLicenseReadiness\(\{/.test(gate))
  check("a non-agent actor (no agents row) is NOT blocked", /if \(!agent\) return clear/.test(gate))
  check("a data/lookup error never hard-blocks (fails open)", /catch \{\s*\n?\s*return clear/.test(gate))
  const docSig = src("app/actions/transaction-document-signatures.ts")
  check("sendDocumentForSignature calls the gate + refuses when not transactable", /checkAgentTransactable\(supabase, userId\)[\s\S]*?if \(!readiness\.transactable\)[\s\S]*?return \{ success: false/.test(docSig))
  const offerSig = src("app/actions/buyer-offer/submit-for-signature.ts")
  check("buyer-offer submitForSignature calls the gate + refuses when not transactable", /checkAgentTransactable\(supabase, userId\)[\s\S]*?if \(!readiness\.transactable\)[\s\S]*?return \{ success: false/.test(offerSig))
  const reg = src("lib/kernel/manager-registry.ts")
  check("the burn domain documents the hard gate at both chokepoints", /HARD GATE \(checkAgentTransactable\)[\s\S]*?sendDocumentForSignature[\s\S]*?submitForSignature/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — source layer proved the wiring; pure verdict proven by test:license-readiness"); return }
  const svc = createClient(url, key)
  console.log("\n[live] lapsed agent BLOCKS → cleared PASSES → non-agent PASSES → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  const { checkAgentTransactable } = await import("../lib/compliance/agent-readiness-gate")
  try {
    const { data: u } = await svc.from("users").insert({ brokerage_id: brokerageId, email: `gate_${Date.now()}@example.com`, first_name: "Gate", last_name: "Test", user_type: "agent" }).select("id").single()
    cleanup.push({ table: "users", id: (u as any).id })
    const { data: ag } = await svc.from("agents").insert({ brokerage_id: brokerageId, user_id: (u as any).id, license_expiry: "2020-01-01", ce_hours_required: 30, ce_hours_completed: 2, ce_cycle_end_date: "2020-01-01" }).select("id").single()
    cleanup.push({ table: "agents", id: (ag as any).id })

    const blocked = await checkAgentTransactable(svc as any, (u as any).id)
    check("live: lapsed agent is BLOCKED (transactable=false, blockers surfaced)", !blocked.transactable && blocked.blockers.length > 0 && !!blocked.message)

    await svc.from("agents").update({ license_expiry: "2099-01-01", ce_hours_completed: 30 }).eq("id", (ag as any).id)
    const cleared = await checkAgentTransactable(svc as any, (u as any).id)
    check("live: after renewing license + CE, the same agent PASSES", cleared.transactable && cleared.blockers.length === 0)

    const { data: bu } = await svc.from("users").insert({ brokerage_id: brokerageId, email: `broker_${Date.now()}@example.com`, first_name: "Broker", last_name: "Admin", user_type: "broker_admin" }).select("id").single()
    cleanup.push({ table: "users", id: (bu as any).id })
    const nonAgent = await checkAgentTransactable(svc as any, (bu as any).id)
    check("live: a non-agent actor (no agents row) is NOT blocked", nonAgent.transactable)
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ READINESS_GATE_FAIL"); process.exit(1) }
  console.log(" ✅ READINESS_GATE_PASS — a blocked agent can't send documents/offers for signature; clear agents + non-agents pass")
}
main()
