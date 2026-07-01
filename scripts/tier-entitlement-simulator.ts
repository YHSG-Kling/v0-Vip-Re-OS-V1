#!/usr/bin/env tsx
/**
 * scripts/tier-entitlement-simulator.ts   (npm run test:tier-entitlement)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves tier feature-gating works. subscription_tiers.features is a JSONB OBJECT
 * ({ accounting_sync: true, team_features: false, ... }); resolveFeatureEntitlement used to call
 * .includes() on it, which threw / returned undefined so EVERY tier feature resolved to DISABLED —
 * a paying brokerage was denied accounting_sync/compliance it paid for. isTierFeatureIncluded now
 * reads the key's boolean (and still honors a legacy array shape). Pure; the real per-tier matrix is
 * asserted from the actual production feature objects.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isTierFeatureIncluded } from "../lib/kernel/billing"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

// The REAL production tier feature objects (subscription_tiers.features).
const TIERS: Record<string, Record<string, boolean>> = {
  solo_agent:    { portal: true, basic_ai: true, core_crm: true, team_features: false, accounting_sync: false },
  team:          { portal: true, basic_ai: true, core_crm: true, team_features: true, accounting_sync: false },
  brokerage:     { portal: true, basic_ai: true, core_crm: true, compliance: true, team_features: true, accounting_sync: true },
  multi_location:{ portal: true, basic_ai: true, core_crm: true, compliance: true, team_features: true, usage_metering: true, accounting_sync: true, multi_brokerage: true },
}

function main() {
  console.log("\n[isTierFeatureIncluded · pure — object shape]")
  check("true-valued key ⇒ included", isTierFeatureIncluded({ accounting_sync: true }, "accounting_sync") === true)
  check("false-valued key ⇒ NOT included", isTierFeatureIncluded({ accounting_sync: false }, "accounting_sync") === false)
  check("absent key ⇒ NOT included", isTierFeatureIncluded({ portal: true }, "accounting_sync") === false)
  check("non-boolean truthy value ⇒ NOT included (must be strictly true)", isTierFeatureIncluded({ x: 1 }, "x") === false)

  console.log("\n[legacy array shape still honored]")
  check("array containing the key ⇒ included", isTierFeatureIncluded(["accounting_sync", "portal"], "accounting_sync") === true)
  check("array without the key ⇒ NOT included", isTierFeatureIncluded(["portal"], "accounting_sync") === false)

  console.log("\n[garbage ⇒ safe deny]")
  check("null ⇒ not included", isTierFeatureIncluded(null, "x") === false)
  check("string ⇒ not included", isTierFeatureIncluded("accounting_sync", "accounting_sync") === false)

  console.log("\n[the REAL per-tier entitlement matrix resolves correctly]")
  check("solo_agent is DENIED accounting_sync (base plan)", isTierFeatureIncluded(TIERS.solo_agent, "accounting_sync") === false)
  check("solo_agent is DENIED team_features", isTierFeatureIncluded(TIERS.solo_agent, "team_features") === false)
  check("team GETS team_features", isTierFeatureIncluded(TIERS.team, "team_features") === true)
  check("team is DENIED accounting_sync", isTierFeatureIncluded(TIERS.team, "accounting_sync") === false)
  check("brokerage GETS accounting_sync + compliance", isTierFeatureIncluded(TIERS.brokerage, "accounting_sync") === true && isTierFeatureIncluded(TIERS.brokerage, "compliance") === true)
  check("multi_location GETS usage_metering + multi_brokerage", isTierFeatureIncluded(TIERS.multi_location, "usage_metering") === true && isTierFeatureIncluded(TIERS.multi_location, "multi_brokerage") === true)
  check("EVERY tier gets core_crm (universal)", Object.values(TIERS).every((t) => isTierFeatureIncluded(t, "core_crm") === true))

  console.log("\n[the resolver no longer calls .includes() on the object (the bug)]")
  const billing = src("lib/kernel/billing.ts")
  check("resolveFeatureEntitlement uses isTierFeatureIncluded", /resolveFeatureEntitlement[\s\S]*?isTierFeatureIncluded/.test(billing))
  check("no `tier.features?.includes(` remains", !/tier\.features\?\.includes\(/.test(billing))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ TIER_ENTITLEMENT_FAIL"); process.exit(1) }
  console.log(" ✅ TIER_ENTITLEMENT_PASS — tier feature-gating reads the JSONB object correctly; paying tiers get what they pay for")
}
main()
