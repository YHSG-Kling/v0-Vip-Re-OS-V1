#!/usr/bin/env tsx
/**
 * scripts/entitlements-resolver-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE UNIFIED ENTITLEMENT RESOLUTION ORDER as ONE provable function. Consolidates
 * the previously-implicit gate logic in lib/kernel/0.1-feature-access.ts into a pure
 * resolveEntitlement (lib/entitlements/resolve.ts) that walks the canonical order —
 * platform hard rule → feature enabled → superadmin gate → tenant override →
 * plan/tier → runtime usage cap — and adds the missing STEP 1 (the god-switch).
 * canAccessFeature now loads the inputs and DELEGATES, so the decision is provable
 * by this single matrix.
 *
 * Layer 1 (pure): the full precedence matrix.
 * Layer 2 (source): canAccessFeature imports resolveEntitlement + wires the platform
 *   god-switch (loadPlatformHalt) as the highest-precedence gate (superadmin-exempt,
 *   fail-open).
 *
 * Run: npx tsx scripts/entitlements-resolver-simulator.ts   (npm run test:entitlements)
 */
import { resolveEntitlement, type EntitlementInputs } from "../lib/entitlements/resolve"
import { readFileSync } from "node:fs"
import { join } from "node:path"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Entitlement engine verified — one provable resolution order, god-switch first")
  console.log(" ENTITLEMENTS_PASS")
}

const now = new Date("2026-07-06T00:00:00Z")
const okFlag = { enabled: true, deprecated: false, sunsetDate: null, superadminOnly: false, tierHasAccess: true, tierLimit: null }
function base(over: Partial<EntitlementInputs> = {}): EntitlementInputs {
  return { flag: { ...okFlag }, tier: "brokerage", now, ...over }
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Entitlement resolution simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · resolution-order matrix]")
  check("all gates pass, no limit → allowed", resolveEntitlement(base()).allowed === true)

  // 1. platform hard rule beats EVERYTHING (even a perfectly-valid flag).
  check("platform halt (god-switch) → denied, highest precedence",
    (() => { const r = resolveEntitlement(base({ platformHalt: { blocked: true, reason: "maintenance" } })); return !r.allowed && r.reason === "maintenance" })())

  // 2. feature existence / enablement
  check("no flag → does not exist", resolveEntitlement(base({ flag: null })).reason === "Feature does not exist")
  check("disabled flag → denied", !resolveEntitlement(base({ flag: { ...okFlag, enabled: false } })).allowed)
  check("deprecated → denied", !resolveEntitlement(base({ flag: { ...okFlag, deprecated: true } })).allowed)
  check("sunset in the past → denied", !resolveEntitlement(base({ flag: { ...okFlag, sunsetDate: "2020-01-01" } })).allowed)

  // 3. superadmin_only gate
  check("superadmin_only + non-superadmin → denied", !resolveEntitlement(base({ flag: { ...okFlag, superadminOnly: true } })).allowed)
  check("superadmin_only + superadmin → allowed", resolveEntitlement(base({ flag: { ...okFlag, superadminOnly: true }, isSuperadmin: true })).allowed)

  // 4. overrides
  check("grant_trial (not expired) → allowed + trial flag",
    (() => { const r = resolveEntitlement(base({ override: { type: "grant_trial", trialEndsAt: "2026-08-01", disabledReason: null } })); return r.allowed && r.trial === true })())
  check("disable override → denied even when the plan includes it",
    (() => { const r = resolveEntitlement(base({ override: { type: "disable", trialEndsAt: null, disabledReason: "abuse" } })); return !r.allowed && r.disabled === true })())
  check("trial override OUTRANKS a plan that lacks the feature",
    resolveEntitlement(base({ flag: { ...okFlag, tierHasAccess: false }, override: { type: "grant_trial", trialEndsAt: "2026-08-01", disabledReason: null } })).allowed === true)
  check("EXPIRED trial → falls through to the plan check (denied when plan lacks it)",
    !resolveEntitlement(base({ flag: { ...okFlag, tierHasAccess: false }, override: { type: "grant_trial", trialEndsAt: "2026-01-01", disabledReason: null } })).allowed)

  // 5. plan / tier access
  check("plan lacks the feature → denied", !resolveEntitlement(base({ flag: { ...okFlag, tierHasAccess: false } })).allowed)

  // 6. runtime usage cap
  check("under the limit → allowed with remaining",
    (() => { const r = resolveEntitlement(base({ flag: { ...okFlag, tierLimit: 10 }, usageCurrent: 3 })); return r.allowed && r.usage?.remaining === 7 })())
  check("at/over the limit → denied",
    (() => { const r = resolveEntitlement(base({ flag: { ...okFlag, tierLimit: 10 }, usageCurrent: 10 })); return !r.allowed && r.usage?.remaining === 0 })())

  console.log("\n[Layer 2 · canAccessFeature delegates + god-switch wired]")
  const src = readFileSync(join(process.cwd(), "lib/kernel/0.1-feature-access.ts"), "utf8")
  check("canAccessFeature imports + returns resolveEntitlement (one order)",
    /from ['"]@\/lib\/entitlements\/resolve['"]/.test(src) && /return resolveEntitlement\(/.test(src))
  check("the platform god-switch (loadPlatformHalt) is wired as the hard rule, superadmin-exempt, fail-open",
    /loadPlatformHalt/.test(src) && /isSuperadmin/.test(src) && /fail-open/.test(src))

  report()
}
main()
