#!/usr/bin/env tsx
/**
 * scripts/ad-payload-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 43 — proves we assemble the EXACT parameters each provider needs to create
 * an ad, validate readiness BEFORE calling the provider, and enforce the Fair
 * Housing rules. The same assembleAd() serves both the Ads Manager (auto) and a
 * user creating an ad in the dashboard. Fully pure → runs in CI.
 *
 * Run: npx tsx scripts/ad-payload-simulator.ts  (npm run test:ad-payload)
 */
import { validateAdReadiness, buildMetaAdStructure, buildGoogleAdStructure, assembleAd, type AdBuildInput } from "../lib/ads/connectors/ad-payload"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// A complete, compliant Meta lead ad (what the manager OR user would assemble).
const metaLead = (over: Partial<AdBuildInput> = {}): AdBuildInput => ({
  platform: "facebook", objective: "leads", campaignName: "Just Listed — Maple Grove", dailyBudgetUsd: 50,
  pageId: "PAGE_123", leadFormId: "FORM_456",
  creative: { headline: "See Your Home's Value", primaryText: "Thinking of selling? Get a free market analysis.", description: "Local experts", callToAction: "LEARN_MORE", mediaAssetUrl: "https://blob/reel.mp4", destinationUrl: null },
  targeting: { locations: [{ city: "Maple Grove", state: "MN" }], audienceExternalId: "AUD_789" },
  specialAdCategory: "HOUSING", ...over,
})

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Ad payload simulator (provider parameters + Fair Housing)")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[readiness — missing required provider params]")
  check("complete Meta lead ad → ready", validateAdReadiness(metaLead()).ready)
  check("missing headline + media flagged", (() => { const v = validateAdReadiness(metaLead({ creative: { ...metaLead().creative, headline: null, mediaAssetUrl: null } })); return v.missing.includes("creative.headline") && v.missing.includes("creative.mediaAssetUrl") && !v.ready })())
  check("leads objective requires pageId + leadFormId", (() => { const v = validateAdReadiness(metaLead({ pageId: null, leadFormId: null })); return v.missing.includes("pageId") && v.missing.includes("leadFormId") })())
  check("traffic objective requires a destination url", (() => { const v = validateAdReadiness(metaLead({ objective: "traffic", creative: { ...metaLead().creative, destinationUrl: null } })); return v.missing.includes("creative.destinationUrl") })())
  check("zero budget flagged", validateAdReadiness(metaLead({ dailyBudgetUsd: 0 })).missing.includes("dailyBudgetUsd"))
  check("no locations flagged", validateAdReadiness(metaLead({ targeting: { locations: [] } })).missing.includes("targeting.locations"))

  console.log("\n[Fair Housing enforcement (release-blocker)]")
  check("non-HOUSING category → violation", validateAdReadiness(metaLead({ specialAdCategory: "NONE" })).violations.length > 0)
  check("age narrowing under HOUSING → violation", validateAdReadiness(metaLead({ targeting: { ...metaLead().targeting, ageMin: 25, ageMax: 45 } })).violations.some((v) => /age/i.test(v)))
  check("gender targeting under HOUSING → violation", validateAdReadiness(metaLead({ targeting: { ...metaLead().targeting, genders: ["female"] } })).violations.some((v) => /gender/i.test(v)))
  check("tight radius under HOUSING → violation", validateAdReadiness(metaLead({ targeting: { locations: [{ city: "X", radiusMiles: 5 }] } })).violations.some((v) => /radius/i.test(v)))
  check("compliant broad targeting → no violations", validateAdReadiness(metaLead()).violations.length === 0)

  console.log("\n[Meta ad structure]")
  const meta = buildMetaAdStructure(metaLead())
  check("campaign forces special_ad_categories=['HOUSING']", JSON.stringify((meta.campaign as any).special_ad_categories) === JSON.stringify(["HOUSING"]))
  check("objective mapped to OUTCOME_LEADS", (meta.campaign as any).objective === "OUTCOME_LEADS")
  check("ad set daily_budget in cents", (meta.adSet as any).daily_budget === 5000)
  check("ad set targets age 18-65 (Housing-safe)", (meta.adSet as any).targeting.age_min === 18 && (meta.adSet as any).targeting.age_max === 65)
  check("lead ad set carries promoted_object.page_id", (meta.adSet as any).promoted_object?.page_id === "PAGE_123")
  check("custom audience wired into targeting", (meta.adSet as any).targeting.custom_audiences?.[0]?.id === "AUD_789")
  check("creative carries the lead_gen_form_id", (meta.adCreative as any).object_story_spec.link_data.call_to_action.value.lead_gen_form_id === "FORM_456")
  check("everything starts PAUSED (human launches via the gate)", (meta.campaign as any).status === "PAUSED" && (meta.ad as any).status === "PAUSED")

  console.log("\n[Google ad structure]")
  const g = buildGoogleAdStructure(metaLead({ platform: "google", creative: { ...metaLead().creative, destinationUrl: "https://agent.com/lp" } }))
  check("budget in micros", (g.budget as any).amount_micros === 50_000_000)
  check("responsive search ad has headlines + descriptions", (g.ad as any).responsive_search_ad.headlines.length >= 1 && (g.ad as any).responsive_search_ad.descriptions.length >= 1)
  check("final_urls set", JSON.stringify((g.ad as any).final_urls) === JSON.stringify(["https://agent.com/lp"]))

  console.log("\n[assembleAd routes by platform — same path for auto + user-created]")
  check("facebook → meta structure", !!assembleAd(metaLead()).meta && !assembleAd(metaLead()).google)
  check("google → google structure", !!assembleAd(metaLead({ platform: "google", creative: { ...metaLead().creative, destinationUrl: "https://x" } })).google)
  check("assembleAd surfaces readiness", assembleAd(metaLead()).validation.ready === true)

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Provider ad payloads assembled + validated; Fair Housing enforced before any spend")
}
main()
