#!/usr/bin/env tsx
/**
 * scripts/marketing-package-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the pure core extracted from app/actions/marketing-package-automation.ts:
 * the marketing-package catalog (lib/marketing/package-catalog.ts). The catalog
 * resolves which services a listing-marketing package includes and its flat
 * estimated cost — the figures the UI shows BEFORE activation (display-and-confirm)
 * and the action persists into listing_marketing_packages.
 *
 * Pure + shell-runnable. No DB, no mocks.
 *
 * Run: npx tsx scripts/marketing-package-simulator.ts
 */
import {
  MARKETING_PACKAGE_TYPES,
  getPackageServices,
  calculatePackageCost,
  getPackageDisplayName,
  isMarketingPackageType,
  buildPackagePreview,
  type MarketingPackageType,
} from "../lib/marketing/package-catalog"

let passed = 0,
  failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ""))
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ Marketing package catalog verified — services + cost are deterministic.")
  console.log(" MARKETING_PACKAGE_PASS")
  process.exit(0)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Marketing package catalog simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[type guard]")
  check("basic is a valid type", isMarketingPackageType("basic"))
  check("luxury is a valid type", isMarketingPackageType("luxury"))
  check("garbage is not a valid type", !isMarketingPackageType("platinum"))
  check("empty string is not a valid type", !isMarketingPackageType(""))

  console.log("\n[cost — flat tier pricing]")
  check("basic cost = $0", calculatePackageCost("basic") === 0)
  check("standard cost = $500", calculatePackageCost("standard") === 500)
  check("premium cost = $1500", calculatePackageCost("premium") === 1500)
  check("luxury cost = $3500", calculatePackageCost("luxury") === 3500)
  check("unknown type falls back to $0", calculatePackageCost("platinum") === 0)
  check("cost is monotonic non-decreasing up the tiers", (() => {
    const ordered: MarketingPackageType[] = ["basic", "standard", "premium", "luxury"]
    for (let i = 1; i < ordered.length; i++) {
      if (calculatePackageCost(ordered[i]) <= calculatePackageCost(ordered[i - 1])) return false
    }
    return true
  })())

  console.log("\n[services — base + tier additions]")
  const base = ["mls_syndication", "listing_description", "social_media_posts"]
  for (const t of MARKETING_PACKAGE_TYPES) {
    const svc = getPackageServices(t)
    check(`${t} includes all 3 base services`, base.every((b) => svc.includes(b)))
  }
  check("basic = exactly the 3 base services", getPackageServices("basic").length === 3)
  check("standard adds photos + virtual_tour + email", (() => {
    const s = getPackageServices("standard")
    return s.includes("professional_photos") && s.includes("virtual_tour") && s.includes("email_campaign")
  })())
  check("premium includes paid social (facebook + instagram ads)", (() => {
    const s = getPackageServices("premium")
    return s.includes("facebook_ads") && s.includes("instagram_ads")
  })())
  check("luxury includes 3d_matterport + google_ads + print_materials", (() => {
    const s = getPackageServices("luxury")
    return s.includes("3d_matterport") && s.includes("google_ads") && s.includes("print_materials")
  })())
  check("service count grows up the tiers (basic<standard<premium<luxury)", (() => {
    const counts = MARKETING_PACKAGE_TYPES.map((t) => getPackageServices(t).length)
    for (let i = 1; i < counts.length; i++) if (counts[i] <= counts[i - 1]) return false
    return true
  })())
  check("unknown type falls back to basic service list", (() => {
    return JSON.stringify(getPackageServices("platinum")) === JSON.stringify(getPackageServices("basic"))
  })())
  check("returned list is a copy (mutation does not leak into catalog)", (() => {
    const a = getPackageServices("premium")
    a.push("__mutated__")
    return !getPackageServices("premium").includes("__mutated__")
  })())
  check("no duplicate services within a tier", (() => {
    for (const t of MARKETING_PACKAGE_TYPES) {
      const s = getPackageServices(t)
      if (new Set(s).size !== s.length) return false
    }
    return true
  })())

  console.log("\n[display name]")
  check('basic → "Basic Package"', getPackageDisplayName("basic") === "Basic Package")
  check('luxury → "Luxury Package"', getPackageDisplayName("luxury") === "Luxury Package")
  check('unknown → "Basic Package" (fallback)', getPackageDisplayName("platinum") === "Basic Package")

  console.log("\n[preview bundle — what the UI renders pre-activation]")
  const preview = buildPackagePreview("premium")
  check("preview carries the requested type", preview.packageType === "premium")
  check("preview name matches display name", preview.packageName === "Premium Package")
  check("preview cost matches catalog cost", preview.estimatedCost === calculatePackageCost("premium"))
  check("preview services match catalog services", JSON.stringify(preview.services) === JSON.stringify(getPackageServices("premium")))

  report()
}

main()
