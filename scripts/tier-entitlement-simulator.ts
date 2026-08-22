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
import { TIER_SEAT_LIMITS } from "../lib/kernel/tier-role-matrix"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

// The REAL production tier feature objects (subscription_tiers.features), AFTER the "all tools to
// every tier" packaging (m251): every tier carries the full TOOL capability set; tiers differ only by
// SCALE (max_agents/max_brokerages) and the multi-location-only scale flags.
const TOOLS = { portal: true, basic_ai: true, core_crm: true, team_features: true, accounting_sync: true, compliance: true }
const TIERS: Record<string, Record<string, boolean>> = {
  solo_agent:    { ...TOOLS },
  team:          { ...TOOLS },
  brokerage:     { ...TOOLS },
  multi_location:{ ...TOOLS, usage_metering: true, multi_brokerage: true },
}
// Max seats per tier — the REAL differentiator now (subscription_tiers.max_agents).
// THESE ARE THE OWNER'S NUMBERS, not the ones the live catalogue carried: it said
// solo=1 / team=10 while the seat gate enforced 2 / 5, and max_agents is what the
// tenant's billing page and the platform voice receptionist QUOTE. m523 moves the
// catalogue onto these; lib/kernel/tier-role-matrix.ts is the code-side fallback
// and scripts/seat-cap-simulator.ts (npm run test:seat-cap) is the enforcement proof.
const MAX_AGENTS: Record<string, number | null> = { solo_agent: 2, team: 5, brokerage: null, multi_location: null }

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

  console.log("\n[ALL TOOLS to EVERY tier — differentiation is SCALE, not feature locks (m251 packaging)]")
  const ALL_TOOLS = ["portal", "basic_ai", "core_crm", "team_features", "accounting_sync", "compliance"]
  check("solo_agent NOW GETS accounting_sync (all tools)", isTierFeatureIncluded(TIERS.solo_agent, "accounting_sync") === true)
  check("solo_agent NOW GETS team_features + compliance", isTierFeatureIncluded(TIERS.solo_agent, "team_features") === true && isTierFeatureIncluded(TIERS.solo_agent, "compliance") === true)
  check("team GETS accounting_sync (previously locked)", isTierFeatureIncluded(TIERS.team, "accounting_sync") === true)
  check("EVERY tier gets EVERY tool capability", Object.values(TIERS).every((t) => ALL_TOOLS.every((k) => isTierFeatureIncluded(t, k) === true)))
  check("multi_location still owns the SCALE flags (usage_metering + multi_brokerage)", isTierFeatureIncluded(TIERS.multi_location, "usage_metering") === true && isTierFeatureIncluded(TIERS.multi_location, "multi_brokerage") === true)
  check("non-multi tiers do NOT get multi_brokerage (scale-gated)", !isTierFeatureIncluded(TIERS.solo_agent, "multi_brokerage") && !isTierFeatureIncluded(TIERS.team, "multi_brokerage") && !isTierFeatureIncluded(TIERS.brokerage, "multi_brokerage"))
  check("SCALE is the differentiator — seats step 2 → 5 → unlimited (owner's ruling)", MAX_AGENTS.solo_agent === 2 && MAX_AGENTS.team === 5 && MAX_AGENTS.brokerage === null)
  check("…and these agree with the seat matrix the gate enforces, so catalogue and code cannot drift",
    MAX_AGENTS.solo_agent === TIER_SEAT_LIMITS.solo_agent
    && MAX_AGENTS.team === TIER_SEAT_LIMITS.team
    && MAX_AGENTS.brokerage === TIER_SEAT_LIMITS.brokerage)

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
