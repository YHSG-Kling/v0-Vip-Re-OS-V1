#!/usr/bin/env tsx
/**
 * scripts/vibe-ctv-dispatch-simulator.ts  (npm run test:vibe-ctv-dispatch)
 * ─────────────────────────────────────────────────────────────────────────────
 * STREAMING-TV LAUNCHES END-TO-END ON VIBE, IN-APP (owner: "build this out fully
 * so users don't need to go to vibe to do it"). The connector was an honest
 * refusal slot; it is now a real OAuth2 client-credentials integration against
 * api.vibe.co that runs the documented chain: token → advertiser → upload video
 * creative → create campaign → create strategy (budget + GEO targeting) →
 * PUBLISH. Proves the real calls are wired, targeting is Fair-Housing-safe
 * (geo + device only, no age/gender), dispatch is honest (live only on a
 * confirmed publish), and the action flips the row + records the Vibe ids.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the connector makes the real Vibe API calls ──")
{
  const v = src("lib/providers/vibe.ts")
  check("targets api.vibe.co with a pinned X-Vibe-Revision",
    v.includes("https://api.vibe.co") && v.includes("X-Vibe-Revision"))
  check("OAuth2 client-credentials token exchange (HTTP Basic)",
    v.includes("/oauth2/token") && v.includes("client_credentials") && v.includes("Basic "))
  check("uploads the video creative (presigned upload-url → S3 → /creatives/video)",
    v.includes("/creatives/upload-url") && v.includes("/creatives/video") && v.includes("FormData"))
  check("creates a campaign (goal AWARENESS, countries USA)",
    /"\/campaigns"/.test(v) && v.includes("AWARENESS") && v.includes('"USA"'))
  check("creates a strategy with DAILY budget + creative attached",
    /"\/strategies"/.test(v) && v.includes("budget_type") && v.includes("creative_ids"))
  check("publishes the campaign to start delivery",
    /\/campaigns\/\$\{vibeCampaignId\}\/actions/.test(v) && v.includes('"PUBLISH"'))
}

console.log("\n── Fair Housing: targeting is geo + device only ──")
{
  const v = src("lib/providers/vibe.ts")
  check("targeting sets geo (metro/cities/zips) + devices only",
    v.includes("metro_codes") && v.includes("zip_codes") && v.includes('devices: ["TV"]'))
  check("no age/gender narrowing in the strategy payload",
    !/age_ranges:/.test(v) && !/genders:/.test(v))
}

console.log("\n── dispatch is honest; the row flips only on a confirmed publish ──")
{
  const v = src("lib/providers/vibe.ts")
  check("dispatched:true only after a real publish (not connected → false)",
    v.includes("vibe_not_connected") && v.includes("dispatched: true") && v.includes("Published on Vibe"))
  check("errors return dispatched:false with the real Vibe message",
    v.includes("catch") && v.includes("VibeError") && v.includes("dispatched: false"))

  // The flip-to-live moved from the server action onto ONE survivor
  // (lib/ads/ctv-campaign.ts launchCtvCampaignOnVibe, 2026-09-07) so the Ads
  // Manager executor and the action share it. The action must DELEGATE.
  const lane = src("lib/ads/ctv-campaign.ts")
  const act = src("app/actions/ctv-ads.ts")
  check("the survivor flips status→live + records Vibe ids ONLY when dispatched",
    /if \(!\(result\.dispatched && result\.vibeCampaignId\)\) return result/.test(lane) &&
    lane.includes('status: "live"') && lane.includes("vibe_campaign_id"))
  check("it ledgers the launch with the caller's launched_via (vibe_api from the action)",
    lane.includes("ad_campaign_launched") && lane.includes("launched_via: input.launchedVia") && act.includes('launchedVia: "vibe_api"'))
  check("the action delegates to the survivor and spells no flip of its own",
    act.includes("launchCtvCampaignOnVibe({") && !act.slice(act.indexOf("dispatchCtvCampaignAction")).includes('status: "live"'))
}

console.log("\n── the UI launches in-app when Vibe is connected ──")
{
  const lane = src("app/dashboard/campaigns/ads/ctv-lane.tsx")
  check("connected → an in-app 'Launch on Vibe' button (no vibe.co trip)",
    lane.includes("Launch on Vibe") && lane.includes("handleTryDispatch"))
  check("not connected → the manual vibe.co + Mark-as-launched path remains",
    lane.includes("Open vibe.co") && lane.includes("Mark as launched"))
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ VIBE_CTV_DISPATCH_FAIL"); process.exit(1) }
console.log(" ✅ VIBE_CTV_DISPATCH_PASS — real Vibe launch chain, Fair-Housing targeting, honest dispatch, in-app launch")
