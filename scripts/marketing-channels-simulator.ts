#!/usr/bin/env tsx
/**
 * scripts/marketing-channels-simulator.ts   (npm run test:marketing-channels)
 * ─────────────────────────────────────────────────────────────────────────────
 * MARKETING CHANNEL HONESTY — proves the seller portal's "Marketing Live Now" statuses are grounded in
 * REAL signals, never inferred from listing.status. The old card showed MLS/Zillow/Realtor as "live"
 * whenever status='active' — even with no MLS number on file. This asserts: MLS is live ONLY with a
 * real MLS number; the IDX portals follow the MLS; the listing page/social/campaigns reflect what we
 * can actually verify; and an active listing with no real signals shows nothing as falsely "live".
 */
import { buildListingMarketingChannels } from "../lib/listings/marketing-channels"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const status = (chs: ReturnType<typeof buildListingMarketingChannels>, name: string) => chs.find((c) => c.name === name)?.status

function main() {
  console.log("\n[No MLS number → MLS / Zillow / Realtor are NOT falsely 'live']")
  const noMls = buildListingMarketingChannels({ mlsNumber: null, listingSlug: null, instagramLive: false, facebookLive: false, activeCampaignCount: 0 })
  check("MLS is 'scheduled' without an MLS number", status(noMls, "MLS") === "scheduled")
  check("Zillow is 'scheduled' without an MLS number", status(noMls, "Zillow") === "scheduled")
  check("Realtor.com is 'scheduled' without an MLS number", status(noMls, "Realtor.com") === "scheduled")
  check("NOTHING is falsely 'live' when we have no verifiable signal", noMls.every((c) => c.status !== "live"))

  console.log("\n[Real MLS number → MLS live + IDX portals follow]")
  const onMls = buildListingMarketingChannels({ mlsNumber: "MLS-12345", listingSlug: null, instagramLive: false, facebookLive: false, activeCampaignCount: 0 })
  check("MLS live with a real number", status(onMls, "MLS") === "live")
  check("Zillow live (syndicated from MLS)", status(onMls, "Zillow") === "live")
  check("Realtor.com live (syndicated from MLS)", status(onMls, "Realtor.com") === "live")
  check("IDX portals note they're via the MLS", onMls.find((c) => c.name === "Zillow")?.description?.includes("MLS") === true)
  check("blank MLS number is treated as none", status(buildListingMarketingChannels({ mlsNumber: "   ", listingSlug: null, instagramLive: false, facebookLive: false, activeCampaignCount: 0 }), "MLS") === "scheduled")

  console.log("\n[Verifiable channels — listing page / social / campaigns]")
  const full = buildListingMarketingChannels({ mlsNumber: "MLS-1", listingSlug: "123-main-st", instagramLive: true, facebookLive: true, activeCampaignCount: 2 })
  check("hosted listing page → live (we publish it)", status(full, "Your Listing Page") === "live")
  check("Instagram live only when a real post exists", status(full, "Instagram") === "live")
  check("no slug → no listing-page channel at all", !buildListingMarketingChannels({ mlsNumber: null, listingSlug: null, instagramLive: false, facebookLive: false, activeCampaignCount: 0 }).some((c) => c.name === "Your Listing Page"))
  check("no social posts → no IG/FB channels", !noMls.some((c) => c.name === "Instagram" || c.name === "Facebook"))
  check("active campaigns → live with the real count", full.find((c) => c.name === "Ad Campaigns")?.description?.includes("2 active") === true)
  check("no active campaigns → no Ad Campaigns channel", !noMls.some((c) => c.name === "Ad Campaigns"))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ MARKETING_CHANNELS_FAIL"); process.exit(1) }
  console.log(" ✅ MARKETING_CHANNELS_PASS — seller sees only verifiable channel statuses, no fabricated 'live'")
}

main()
