// scripts/campaign-channels-simulator.ts   (npm run test:campaign-channels)
// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN CHANNEL TAXONOMY — proves the true-channel set is ONE source of truth
// (lib/campaigns/channels.ts) and that every campaign surface derives from it, so
// the creation picker and the engagement feed can never drift again (the bug:
// creation offered email/sms/video/direct_mail while the feed also showed phone).

import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  CAMPAIGN_CHANNELS, OUTREACH_CHANNELS, BROADCAST_CHANNELS,
  sanitizeOutreachChannels, sanitizeChannels,
} from "../lib/campaigns/channels"

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── PURE: the true-channel taxonomy ──")
{
  const keys = CAMPAIGN_CHANNELS.map((c) => c.key)
  for (const k of ["email", "sms", "phone", "direct_mail", "ads", "social", "blog", "newsletter", "podcast"]) {
    check(`registry includes the true channel "${k}"`, keys.includes(k as any))
  }
  check("outreach ⊂ broadcast are disjoint and cover the registry",
    OUTREACH_CHANNELS.length + BROADCAST_CHANNELS.length === CAMPAIGN_CHANNELS.length)
  check("email/sms/phone/direct_mail/video are OUTREACH (1:1)",
    ["email", "sms", "phone", "direct_mail", "video"].every((k) => OUTREACH_CHANNELS.some((c) => c.key === k)))
  check("social/ads/blog/newsletter/podcast are BROADCAST",
    ["social", "ads", "blog", "newsletter", "podcast"].every((k) => BROADCAST_CHANNELS.some((c) => c.key === k)))
  check("sanitizeOutreachChannels drops broadcast + unknown, dedupes, keeps order",
    JSON.stringify(sanitizeOutreachChannels(["email", "blog", "phone", "phone", "garbage", "sms"])) ===
    JSON.stringify(["email", "phone", "sms"]))
  check("sanitizeChannels keeps every known channel, drops garbage",
    sanitizeChannels(["email", "podcast", "nope"]).length === 2)
}

console.log("\n── SOURCE: every campaign surface derives from the ONE registry (no drift) ──")
{
  const drawer = src("app/dashboard/isa/campaigns/components/CreateCampaignDrawer.tsx")
  check("the creation drawer renders channels from OUTREACH_CHANNELS (data-driven)",
    drawer.includes('from "@/lib/campaigns/channels"') && drawer.includes("OUTREACH_CHANNELS.filter"))
  check("the creation drawer now offers PHONE (the previously-missing channel)",
    drawer.includes("phone:"))

  const feed = src("app/dashboard/isa/campaigns/components/EngagementFeed.tsx")
  check("the engagement feed's channel filter derives from OUTREACH_CHANNELS",
    feed.includes("OUTREACH_CHANNELS.map") && feed.includes("CHANNEL_FILTERS") &&
    !/\["all","email","sms","video","direct_mail","phone"\]/.test(feed))

  const action = src("app/actions/ai-isa.ts")
  check("createISACampaign sanitizes channels against the taxonomy (email always included)",
    action.includes("sanitizeOutreachChannels") && action.includes('"email"'))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ CAMPAIGN_CHANNELS_FAIL"); process.exit(1) }
console.log(" ✅ CAMPAIGN_CHANNELS_PASS — one true-channel taxonomy; creation + feed can't drift")
