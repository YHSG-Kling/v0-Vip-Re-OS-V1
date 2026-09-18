#!/usr/bin/env tsx
/**
 * scripts/content-winner-loop-guard.ts   (npm run test:content-winner-loop) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * A WINNING ORGANIC POST BECOMES A PAID PROPOSAL, END TO END.
 *
 * The `content_winner` signal was declared (lib/kernel/signal-registry.ts) and
 * handled (lib/kernel/manager-signals.ts ads_manager:content_winner) since wave
 * 41 and EMITTED by nothing; and the proposal the handler wrote carried no
 * campaign, so the executor failed it with "campaign_id required". Two halves of
 * one loop, both absent. Owner: "any orphaned wire/absent that needs a wire
 * and/or build needs to get it done … each capability should be used
 * autonomously as much as you can."
 *
 * Proved: (1) the emitter judges a post against the brokerage's OWN 28-day
 * baseline through the one baseline reader, with an impressions floor and a
 * baseline-size floor, and publishes campaign_orchestrator → ads_manager
 * idempotently per post (m618: survivor of the retired marketing_agent seat);
 * (2) it rides the daily analytics sync AFTER fresh numbers land;
 * (3) the executor stages a paid campaign from the post on approval, compliance
 * first (a hard flag refuses before any row), creative in the one approval queue
 * as a DRAFT, destination through the one resolver, idempotent per post, and
 * spends nothing itself; (4) pure verdict logic with positive + negative controls.
 *
 * BLIND SPOTS (§2): static + pure. The thresholds (200 impressions, 2× lift,
 * 3-post baseline, 14-day window) are the lane's defaults, not a measured
 * optimum; social_post_baselines_28d is a live view this proof does not query.
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"
import { judgeContentWinner, WINNER_LIFT, WINNER_MIN_IMPRESSIONS, WINNER_MIN_BASELINE_POSTS } from "../lib/marketing/content-winner-verdict"
import { creativeFromPost } from "../lib/ads/promote-post"

let pass = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => stripComments(readFileSync(p, "utf8"))

const EMIT    = src("lib/marketing/content-winner.ts")
const VERDICT = src("lib/marketing/content-winner-verdict.ts")
const PROMOTE = src("lib/ads/promote-post.ts")
const MANAGER = src("lib/ads/ad-manager.ts")
const SYNC    = src("app/api/cron/social-analytics-sync/route.ts")
const SIGNALS = src("lib/kernel/manager-signals.ts")
const REG     = src("lib/kernel/signal-registry.ts")

console.log("══════════════════════════════════════════════════")
console.log(" content_winner — an organic winner becomes a gated paid proposal")
console.log("══════════════════════════════════════════════════")

console.log("\n── 1 · the emitter exists and judges on the brokerage's own floor ──")
check("the registry declares the signal for ads_manager", /content_winner:\s*\{ consumers: \["ads_manager"\]/.test(REG))
check("the handler consumes it into a launch proposal", /"ads_manager:content_winner"[\s\S]{0,400}action_type: "launch_ad_campaign"/.test(SIGNALS))
check("the emitter publishes campaign_orchestrator → ads_manager with the post as the entity (m618: survivor of the retired marketing_agent seat)",
  /fromManager: "campaign_orchestrator"[\s\S]{0,60}toManager: "ads_manager"[\s\S]{0,60}signalType: "content_winner"/.test(EMIT) && /entityType: "social_post",\s*entityId: p\.id/.test(EMIT))
check("…through the ONE baseline reader (no second baseline query)", /listSocialBaselines\(brokerageId\)/.test(EMIT) && !/social_post_baselines_28d/.test(EMIT))
check("…with an impressions floor and a baseline-size floor", /WINNER_MIN_IMPRESSIONS = 200/.test(VERDICT) && /WINNER_MIN_BASELINE_POSTS = 3/.test(VERDICT) && /WINNER_LIFT = 2\b/.test(VERDICT) && /judgeContentWinner\(/.test(EMIT))
check("…and every read's error is READ (§3), never reported as 'no posts'", /social_posts read refused/.test(EMIT) && /social_media_analytics read refused/.test(EMIT) && /brokerage sweep read refused/.test(EMIT))

console.log("\n── 2 · it rides the daily analytics sync, after fresh numbers ──")
const syncAt = SYNC.indexOf("syncSocialAnalytics(svc")
const winAt = SYNC.indexOf("detectContentWinnersAll(svc)")
check("the sync cron calls the winner pass", winAt > 0)
check("…AFTER the metrics sync", syncAt > 0 && winAt > syncAt)
check("…and a failing pass is logged, not fatal to the sync", /winner pass failed/.test(SYNC))

console.log("\n── 3 · the reader: an approved proposal stages the paid campaign ──")
check("the executor stages from input.post_id when no campaign is named", /!campaignId && action === "launch_ad_campaign" && input\.post_id/.test(MANAGER) && /stageCampaignFromSocialPost\(\{ brokerageId, postId: String\(input\.post_id\)/.test(MANAGER))
check("…and says the creative awaits approval instead of falling through", /approve the creative in the ad approval queue, then approve the campaign to launch/.test(MANAGER))
const scanAt = PROMOTE.indexOf("evaluateContentSafety(post.content)")
const insertAt = PROMOTE.indexOf('from("ad_campaigns").insert(')
check("compliance-first: the scan runs BEFORE the campaign row is inserted", scanAt > 0 && insertAt > scanAt)
check("…a hard flag refuses", /filter\(\(v\) => v\.severity === "high"\)/.test(PROMOTE) && /post copy refused for paid promotion/.test(PROMOTE))
check("the creative lands in the one approval queue as a DRAFT", /ad_creative_variations"\)\.insert\([\s\S]{0,400}approval_status: "draft"/.test(PROMOTE))
check("destination through the one resolver", /resolveAdDestination\(svc, \{ brokerageId: input\.brokerageId, listingId: post\.listing_id, teamId \}\)/.test(PROMOTE))
check("idempotent per post (source_social_post_id)", /contains\("targeting_config", \{ source_social_post_id: input\.postId \}\)/.test(PROMOTE))
check("the platform is a connectable one (post's own, else facebook)", /CONNECTABLE_AD_PLATFORMS as readonly string\[\]\)\.includes\(post\.platform\) \? post\.platform : "facebook"/.test(PROMOTE))
check("nothing here spends: status draft, no external call", /status: "draft"/.test(PROMOTE) && !/fetch\(/.test(PROMOTE))
check("agents.id ⊥ users.id — the post's agent is resolved through the one resolver", /resolveAgentRecordToUserId\(post\.agent_id\)/.test(PROMOTE))

console.log("\n── 4 · pure verdict logic ──")
const baselines = [{ brokerageId: "b", platform: "facebook", postType: "new_listing", postsMeasured: 5, totalImpressions: 5000, totalEngagements: 100, totalClicks: 10, engagementRate: 0.02, clickThroughRate: 0.002, lastMeasuredAt: null, windowStart: null }] as any
const win = judgeContentWinner({ postId: "p", platform: "facebook", postType: "new_listing", impressions: 1000, engagements: 50 }, baselines)
check("POSITIVE: 5% vs a 2% floor on 1000 impressions is a winner at 2.5×", !!win && Math.abs(win.lift - 2.5) < 1e-9)
check("NEGATIVE: 3% (1.5×) is not a winner", judgeContentWinner({ postId: "p", platform: "facebook", postType: "new_listing", impressions: 1000, engagements: 30 }, baselines) === null)
check("NEGATIVE: too few impressions is not judged", judgeContentWinner({ postId: "p", platform: "facebook", postType: "new_listing", impressions: WINNER_MIN_IMPRESSIONS - 1, engagements: 100 }, baselines) === null)
check("NEGATIVE: a thin baseline is not a floor", judgeContentWinner({ postId: "p", platform: "facebook", postType: "new_listing", impressions: 1000, engagements: 500 }, [{ ...baselines[0], postsMeasured: WINNER_MIN_BASELINE_POSTS - 1 }]) === null)
check("NEGATIVE: a different (platform, post_type) baseline does not apply", judgeContentWinner({ postId: "p", platform: "instagram", postType: "new_listing", impressions: 1000, engagements: 500 }, baselines) === null)
check("the lift threshold is the exported constant", WINNER_LIFT === 2)
const cr = creativeFromPost("Just listed in Folsom! Three beds, two baths, a backyard made for summer. Tour this weekend.")
check("creativeFromPost: headline is the first sentence within 40 chars, primary text ≤ 300", cr.headline.length <= 40 && cr.primaryText.length <= 300 && cr.headline.startsWith("Just listed"))

console.log("\n── CONTROLS ──")
check("POSITIVE CONTROL: the order finder fails when the insert precedes the scan",
  (() => { const s = 'x.from("ad_campaigns").insert( … evaluateContentSafety(post.content)'; return !(s.indexOf("evaluateContentSafety(post.content)") > 0 && s.indexOf('from("ad_campaigns").insert(') > s.indexOf("evaluateContentSafety(post.content)")) })())
check("BLINDNESS CONTROL: scans read comment-STRIPPED source", !stripComments("// detectContentWinnersAll(svc)\n").includes("detectContentWinnersAll"))

console.log("\n──────────────────────────────────────────────────")
console.log(" BLIND SPOTS (§2): static + pure; thresholds are defaults, not measured optima; the 28d view is not queried here.")
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(`\n RESULT: ${pass} passed, ${fails.length} failed`)
if (fails.length > 0) { console.log(" ❌ CONTENT_WINNER_LOOP_FAIL"); process.exit(1) }
console.log(" ✅ CONTENT_WINNER_LOOP_PASS — a winning organic post reaches the Ads Manager and becomes a gated paid draft")
