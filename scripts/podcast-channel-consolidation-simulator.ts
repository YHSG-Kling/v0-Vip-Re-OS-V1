#!/usr/bin/env tsx
/**
 * scripts/podcast-channel-consolidation-simulator.ts  (npm run test:podcast-channel-consolidation)
 * ─────────────────────────────────────────────────────────────────────────────
 * CHANNEL SETUP LIVES IN SETTINGS, THE STUDIO SYNDICATES (owner: "podcast is a
 * full ai podcast studio that is syndicated to the channels that are setup on
 * the main settings" + "setup channels … these settings are on the main
 * integration"). The Podcast Studio's Setup → Distribution Channels tab had a
 * FULL editor (toggle/configure/seed) over podcast_distribution_channels — a
 * true duplicate of the /dashboard/settings/podcast-channels editor (same table,
 * same createDistributionChannel/updateDistributionChannel actions, same fields).
 * Resolution: the studio tab is now READ-ONLY syndication status that links to
 * Settings; Settings is the SOLE editor. Also: the Omnipresence repurpose source
 * list now includes PUBLISHED episodes (not just completed), so an episode sent
 * via "Send to Omnipresence" actually shows up.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the Podcast Studio channel tab is READ-ONLY and routes editing to Settings ──")
{
  const tab = src("app/dashboard/marketing/podcast/components/distribution-channels-tab.tsx")
  check("it no longer imports the channel-mutating actions",
    !tab.includes("updateDistributionChannel") && !tab.includes("createDistributionChannel"))
  check("it has no edit dialog / configure / seed affordance",
    !tab.includes("Dialog") && !/Configure<\/Button>/.test(tab) && !tab.includes("handleSeedChannels"))
  check("it links to the Settings channels editor as the single home",
    tab.includes("/dashboard/settings/podcast-channels") && tab.includes("Manage Channels"))
  check("it still shows syndication status (enabled/disabled per channel)",
    tab.includes("Syndicating") && tab.includes("is_enabled"))
}

console.log("\n── the Settings page is the SOLE channel editor (the kept superset) ──")
{
  const client = src("app/dashboard/settings/podcast-channels/podcast-channels-client.tsx")
  check("Settings still imports the channel-mutating actions (it edits)",
    client.includes("updateDistributionChannel") && client.includes("createDistributionChannel"))
  check("Settings keeps the brokerage/personal hierarchy awareness", client.includes("agent_user_id"))
}

console.log("\n── the repurpose source list includes PUBLISHED podcast episodes ──")
{
  const page = src("app/dashboard/campaigns/repurpose/page.tsx")
  check("podcast_episodes are pulled by status IN (completed, published)",
    /podcast_episodes[\s\S]*?\.in\("status",\s*\[\s*"completed",\s*"published"\s*\]\)/.test(page))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ PODCAST_CHANNEL_CONSOLIDATION_FAIL"); process.exit(1) }
console.log(" ✅ PODCAST_CHANNEL_CONSOLIDATION_PASS — one channel editor (Settings); the studio syndicates read-only; published episodes are repurposable")
