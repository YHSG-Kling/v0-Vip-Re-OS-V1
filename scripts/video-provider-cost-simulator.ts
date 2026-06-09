#!/usr/bin/env tsx
/**
 * scripts/video-provider-cost-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 60 — proves the cost-aware avatar-provider choice: D-ID stays the default +
 * differentiator, and HeyGen is a possible path ONLY when a superadmin enables
 * cost-fallback AND HeyGen is cheaper per minute than D-ID. Default behavior unchanged.
 *
 * Pure decision logic — no DB, runs anywhere.
 * Run: npx tsx scripts/video-provider-cost-simulator.ts  (npm run test:video-provider-cost)
 */
import { chooseVideoProvider, estimateVideoCost, DEFAULT_DID_COST_PER_MIN, DEFAULT_HEYGEN_COST_PER_MIN } from "../lib/marketing/video-provider-cost"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const D = DEFAULT_DID_COST_PER_MIN, H = DEFAULT_HEYGEN_COST_PER_MIN

console.log("\n[1 · default behavior is UNCHANGED — D-ID stays the path]")
const off = chooseVideoProvider({ configured: "did", allowCostFallback: false, didCostPerMin: D, heygenCostPerMin: H })
check("fallback OFF → keeps configured D-ID", off.provider === "did" && off.reason === "configured")
const offEvenIfCheaper = chooseVideoProvider({ configured: "did", allowCostFallback: false, didCostPerMin: 0.99, heygenCostPerMin: 0.10 })
check("fallback OFF never switches, even if HeyGen far cheaper", offEvenIfCheaper.provider === "did")

console.log("\n[2 · with default prices, HeyGen is pricier → stays D-ID]")
const defaults = chooseVideoProvider({ configured: "did", allowCostFallback: true, didCostPerMin: D, heygenCostPerMin: H })
check("fallback ON but HeyGen pricier → keeps D-ID", defaults.provider === "did" && defaults.reason === "configured_already_cheapest")

console.log("\n[3 · the user's scenario — D-ID became MORE expensive than HeyGen]")
const flip = chooseVideoProvider({ configured: "did", allowCostFallback: true, didCostPerMin: 0.60, heygenCostPerMin: 0.40 })
check("fallback ON + D-ID pricier than HeyGen → switch to HeyGen", flip.provider === "heygen" && flip.reason === "cost_fallback_cheaper")
const equal = chooseVideoProvider({ configured: "did", allowCostFallback: true, didCostPerMin: 0.40, heygenCostPerMin: 0.40 })
check("equal price → no switch (only switch when STRICTLY cheaper)", equal.provider === "did")

console.log("\n[4 · symmetric + cost math]")
const heygenConfigured = chooseVideoProvider({ configured: "heygen", allowCostFallback: true, didCostPerMin: 0.20, heygenCostPerMin: 0.50 })
check("configured HeyGen + D-ID cheaper + fallback ON → D-ID", heygenConfigured.provider === "did")
check("estimateVideoCost: $0.30/min for 60s = $0.30", Math.abs(estimateVideoCost(0.30, 60) - 0.30) < 1e-9)
check("estimateVideoCost: $0.30/min for 30s = $0.15", Math.abs(estimateVideoCost(0.30, 30) - 0.15) < 1e-9)
check("estimateVideoCost clamps negatives to 0", estimateVideoCost(-1, 60) === 0)

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
console.log(" ✅ D-ID default + differentiator preserved; HeyGen is a governed, cost-gated fallback only")
