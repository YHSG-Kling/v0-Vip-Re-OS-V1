#!/usr/bin/env tsx
/**
 * scripts/seller-team-activity-simulator.ts   (npm run test:seller-team-activity)
 * ─────────────────────────────────────────────────────────────────────────────
 * SELLER "AI TEAM" CARD — the differentiator. Proves the team is built from REAL activity only: Listing
 * Concierge always leads (owns the live listing + coordinates), every other manager appears ONLY when
 * it did real work (no hollow members), counts are accurate, and the seller never sees a fabricated
 * teammate. Pure: no I/O.
 */
import { buildSellerTeamActivity } from "../lib/listings/seller-team-activity"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const has = (team: ReturnType<typeof buildSellerTeamActivity>, mgr: string) => team.some((m) => m.manager === mgr)

function main() {
  console.log("\n[Listing Concierge always leads]")
  const minimal = buildSellerTeamActivity({ listingLive: true, marketingChannelsLive: 0, showingsTotal: 0, videosDelivered: 0, offersCount: 0 })
  check("Listing Concierge present even with no other activity", has(minimal, "Listing Concierge"))
  check("a hollow team is never shown (no member without real work besides the lead)", minimal.length === 1)
  check("live listing → concierge says it's live", /live/i.test(minimal[0].did))

  console.log("\n[Other managers appear ONLY with real work]")
  const noMktg = buildSellerTeamActivity({ listingLive: true, marketingChannelsLive: 0, showingsTotal: 0, videosDelivered: 0, offersCount: 0 })
  check("no marketing channels → no Campaign Orchestrator", !has(noMktg, "Campaign Orchestrator"))
  check("no videos → no Asset Manager", !has(noMktg, "Asset Manager"))
  check("no offers → no Deal Coordinator", !has(noMktg, "Deal Coordinator"))

  const full = buildSellerTeamActivity({ listingLive: true, marketingChannelsLive: 4, showingsTotal: 6, videosDelivered: 2, offersCount: 1 })
  check("marketing channels → Campaign Orchestrator", has(full, "Campaign Orchestrator"))
  check("Campaign Orchestrator cites the real channel count", full.find((m) => m.manager === "Campaign Orchestrator")?.did?.includes("4 channels") === true)
  check("videos → Asset Manager with the real count", full.find((m) => m.manager === "Asset Manager")?.did?.includes("2 personalized videos") === true)
  check("offers → Deal Coordinator with the real count", full.find((m) => m.manager === "Deal Coordinator")?.did?.includes("1 offer") === true)
  check("showings fold into the concierge line (no duplicate member)", full.filter((m) => m.manager === "Listing Concierge").length === 1 && /6 showings/.test(full[0].did))

  console.log("\n[Pre-live listing reads as 'preparing', never claims it's live]")
  const prep = buildSellerTeamActivity({ listingLive: false, marketingChannelsLive: 0, showingsTotal: 0, videosDelivered: 0, offersCount: 0 })
  check("not-live → 'preparing your home to go live'", /preparing/i.test(prep[0].did))
  check("not-live concierge never says it's already live", !/Has your home live/i.test(prep[0].did))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SELLER_TEAM_FAIL"); process.exit(1) }
  console.log(" ✅ SELLER_TEAM_PASS — the seller sees a real, named, accountable AI team — grounded, never hollow")
}
main()
