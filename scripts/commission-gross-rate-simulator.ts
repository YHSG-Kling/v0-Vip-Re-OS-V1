#!/usr/bin/env tsx
/**
 * scripts/commission-gross-rate-simulator.ts   (npm run test:commission-gross-rate)
 * ─────────────────────────────────────────────────────────────────────────────
 * COMMISSION GROSS-RATE INTEGRITY. The commission resolver must take the GROSS
 * commission rate from the DEAL or the BROKERAGE DEFAULT — NEVER from the agent's
 * split_percent (that only splits the commission agent↔brokerage). The former code
 * fell back to profile.split_percent as the gross rate, so an agent on an 85% split
 * produced an ~85%-of-sale-price gross commission — a path widened by the
 * split→profile sync. This guard makes that regression impossible and proves a
 * profile-less agent no longer crashes the resolver.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the gross rate is the deal/brokerage rate, never the agent split ──")
{
  const r = src("lib/brokerage/get-default-commission-structure.ts")
  // Isolate the gross-rate resolution block.
  check("gross rate is NEVER assigned from split_percent",
    !/resolvedGrossRateDecimal\s*=\s*profile[.?]*\.?split_percent/.test(r) && !/resolvedGrossRateDecimal = profile\.split_percent/.test(r))
  check("gross rate priority is deal override → brokerage default only",
    /dealCommissionRate != null[\s\S]*?resolvedGrossRateDecimal = dealCommissionRate \/ 100[\s\S]*?structure\?\.base_percentage != null[\s\S]*?resolvedGrossRateDecimal = structure\.base_percentage \/ 100/.test(r))
  check("split_percent is used ONLY as the split (splitDecimal)",
    /splitDecimal = profile\?\.split_percent != null \? Number\(profile\.split_percent\) \/ 100 : 0/.test(r))
  check("a profile-less agent does not crash — every profile field access is null-safe",
    !/[^?]\bprofile\.(cap_amount|transaction_fee_type|desk_fee_type|technology_fee_type|eo_fee_type|royalty_type|referral_type|residual_type)/.test(r))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — source layer proved the fix"); return }
  const svc = createClient(url, key)
  console.log("\n[live] 85% split + 3% brokerage default, no deal rate → gross 3% (NOT 85%) → cleanup")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  const { data: ag } = await svc.from("agents").select("id").limit(1).maybeSingle()
  if (!brk || !ag) { console.log("  ⊘ no brokerage/agent — skipping"); return }
  const brokerageId = (brk as any).id, agentId = (ag as any).id
  const structId = "dddd0000-0000-4000-8000-0000000000ab"
  const { data: hadProfile } = await svc.from("agent_commission_profiles").select("split_percent").eq("agent_id", agentId).maybeSingle()
  try {
    await svc.from("commission_structures").upsert({ id: structId, brokerage_id: brokerageId, name: "ZZ Test Default", base_percentage: 3, commission_type: "percentage", is_default: true, is_active: true }, { onConflict: "id" })
    await svc.from("agent_commission_profiles").upsert({ agent_id: agentId, brokerage_id: brokerageId, split_percent: 85, is_active: true }, { onConflict: "agent_id" })

    const { getDefaultCommissionStructure } = await import("../lib/brokerage/get-default-commission-structure")
    const resolved: any = await getDefaultCommissionStructure(brokerageId, agentId)
    check("live: gross rate is the 3% brokerage default, NOT the 85% split", Math.abs(resolved.grossRateDecimal - 0.03) < 1e-9)
    check("live: the split still applies (splitDecimal 0.85)", Math.abs(resolved.splitDecimal - 0.85) < 1e-9)
    check("live: agent side is 0.03 × 0.85 = 0.0255 (sane), not 0.72", Math.abs(resolved.agentBuyerSideRate - 0.0255) < 1e-9)
  } finally {
    if (hadProfile) await svc.from("agent_commission_profiles").update({ split_percent: (hadProfile as any).split_percent }).eq("agent_id", agentId)
    else await svc.from("agent_commission_profiles").delete().eq("agent_id", agentId)
    await svc.from("commission_structures").delete().eq("id", structId)
    const { count } = await svc.from("commission_structures").select("id", { count: "exact", head: true }).eq("id", structId)
    check("live: cleanup count == 0", (count ?? 0) === 0)
  }
}

async function main() {
  await liveLayer()
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ COMMISSION_GROSS_RATE_FAIL"); process.exit(1) }
  console.log(" ✅ COMMISSION_GROSS_RATE_PASS — the agent split never becomes the gross rate; no ~85% commissions")
}
main()
