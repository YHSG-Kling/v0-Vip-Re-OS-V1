#!/usr/bin/env tsx
/**
 * scripts/vendor-price-simulator.ts   (npm run test:vendor-price)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves VENDOR PRICE INTELLIGENCE — benchmark each vendor's average cost against the category median of
 * peer vendor-averages and flag the overpriced ones. Honest: enough samples + enough peers before a flag.
 *
 * PURE:   flagOverpricedVendors (per-category median of vendor-avgs, %-above threshold, honest gating).
 * SOURCE: the runner benchmarks real bookings + proposes a gated brief; rides the vendor-orchestration cron.
 * LIVE (creds-gated): seed 3 inspectors — 2 fairly priced + 1 overpriced → the overpriced one is flagged
 *         + a gated brief lands → idempotent → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { flagOverpricedVendors, type PricedBooking } from "../lib/kernel/vendor-price-intelligence"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

// helper: n priced bookings for a vendor
const bk = (vendorId: string, category: string, cost: number, n: number): PricedBooking[] => Array.from({ length: n }, () => ({ vendorId, category, cost }))

function pureLayer() {
  console.log("\n[flagOverpricedVendors · pure — peer benchmark, honest gating]")
  // 3 inspectors: A@100, B@110, C@200 (median of avgs = 110; C is 82% above → flagged)
  const bookings = [...bk("A", "inspector", 100, 3), ...bk("B", "inspector", 110, 3), ...bk("C", "inspector", 200, 3)]
  const flags = flagOverpricedVendors(bookings)
  check("the overpriced vendor (C @ $200 vs $110 median) is flagged", flags.length === 1 && flags[0].vendorId === "C")
  check("the flag reports the % above the category median", flags[0].pctAbove >= 20 && flags[0].categoryMedian === 110)
  check("fairly-priced peers are NOT flagged", !flags.some((f) => f.vendorId === "A" || f.vendorId === "B"))

  console.log("\n[honest gating · pure]")
  check("a vendor with too few bookings isn't benchmarked", flagOverpricedVendors([...bk("A", "inspector", 100, 3), ...bk("B", "inspector", 110, 3), ...bk("C", "inspector", 200, 2)]).length === 0)
  check("a category with too few peers has no median → no flag", flagOverpricedVendors([...bk("A", "inspector", 100, 3), ...bk("C", "inspector", 200, 3)]).length === 0)
  check("within-threshold pricing isn't flagged", flagOverpricedVendors([...bk("A", "lender", 100, 3), ...bk("B", "lender", 105, 3), ...bk("C", "lender", 115, 3)]).length === 0)
  check("$0 / null costs are ignored (honest)", flagOverpricedVendors([...bk("A", "inspector", 0, 5), { vendorId: "A", category: "inspector", cost: null }]).length === 0)
}

function sourceLayer() {
  console.log("\n[wiring — gated brief, cron, owned]")
  const lib = src("lib/kernel/vendor-price-intelligence.ts")
  check("benchmarks real vendor_bookings costs by category", /from\("vendor_bookings"\)\.select\("vendor_id, cost"\)/.test(lib) && /flagOverpricedVendors\(priced\)/.test(lib))
  check("proposes ONE gated weekly deal_coordinator brief (deduped)", /VENDOR PRICING — \$\{isoWeekKey\(now\)\}[\s\S]*?agentKind: "deal_coordinator"/.test(lib))
  const cron = src("app/api/cron/vendor-orchestration/route.ts")
  check("the daily vendor-orchestration cron runs the price intelligence", /runVendorPriceIntelligenceAll/.test(cron))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by deal_coordinator with a runnable proof", /vendor_price_intelligence:\s*\{\s*manager:\s*"deal_coordinator",\s*proof:\s*"test:vendor-price"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed 3 inspectors (2 fair + 1 overpriced) → flag the overpriced + gated brief → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const seed = async (name: string, cost: number) => {
      const { data: v } = await svc.from("vendors").insert({ brokerage_id: brokerageId, name, category: "inspector", status: "active" }).select("id").single()
      cleanup.push({ table: "vendors", id: (v as any).id })
      for (let i = 0; i < 3; i++) {
        const { data: b } = await svc.from("vendor_bookings").insert({ brokerage_id: brokerageId, vendor_id: (v as any).id, cost, status: "completed", service_type: "inspection" }).select("id").single()
        cleanup.push({ table: "vendor_bookings", id: (b as any).id })
      }
      return (v as any).id
    }
    const overpricedId = await seed("ZZ Pricey Inspector", 400)
    await seed("ZZ Fair Inspector A", 200)
    await seed("ZZ Fair Inspector B", 210)

    const { runVendorPriceIntelligence } = await import("../lib/kernel/vendor-price-intelligence")
    const r = await runVendorPriceIntelligence(svc as any, { brokerageId })
    check("live: flagged the overpriced inspector", r.overpriced >= 1)
    check("live: proposed a gated pricing brief", r.briefProposed === true)

    const { data: brief } = await svc.from("agent_client_messages").select("id, status, audience")
      .eq("brokerage_id", brokerageId).eq("agent_kind", "deal_coordinator").ilike("rationale", "VENDOR PRICING%").order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (brief) cleanup.push({ table: "agent_client_messages", id: (brief as any).id })
    check("live: the brief is a gated proposal to the broker", !!brief && (brief as any).status === "proposed" && (brief as any).audience === "agent")

    const r2 = await runVendorPriceIntelligence(svc as any, { brokerageId })
    check("live: idempotent — no second brief the same week", r2.briefProposed === false)
    void overpricedId
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ VENDOR_PRICE_FAIL"); process.exit(1) }
  console.log(" ✅ VENDOR_PRICE_PASS — the marketplace benchmarks its own bench and flags overpriced vendors")
}
main()
