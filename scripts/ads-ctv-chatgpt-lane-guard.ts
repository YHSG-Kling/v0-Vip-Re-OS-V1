#!/usr/bin/env tsx
/**
 * scripts/ads-ctv-chatgpt-lane-guard.ts   (npm run test:ads-ctv-chatgpt-lane) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * STREAMING TV AND CHATGPT ADS ARE CAPABILITIES THE ADS MANAGER RUNS, NOT PAGES.
 *
 * Owner, 2026-09-06/07: "ads for chatgpt and tv capability needs built out fully.
 * this agentic saas os runs autonomous loops … each capability should be used
 * autonomously as much as you can."
 *
 * Proved:
 *  TV  (1) vibe_ctv is a connector in THE ad-connector registry, spelling no Vibe
 *          HTTP of its own — publish and reporting delegate to lib/providers/vibe.ts;
 *      (2) Vibe reporting is the documented async pair (POST /reports → GET
 *          /reports/{id} → download_url), carried across ingest passes as
 *          provider_state, never blocking a cron tick; (3) the flip-to-live lives
 *          ONCE (launchCtvCampaignOnVibe) and both the server action and the Ads
 *          Manager executor call it; (4) a video_ready proposal, which carried no
 *          campaign and always failed, now stages a TV draft; (5) the sweep proposes
 *          launches for approved/staged campaigns whose account is connected;
 *      (6) the vocabulary puts vibe_ctv in exactly one class (provider-connected).
 *  GPT (7) the lane is honest about the missing API — no HTTP, never dispatched,
 *          getConnector('chatgpt') null, the executor skips with the reason;
 *      (8) copy is composed from the ONE Fair-Housing-clean builder, clipped to the
 *          Ads Manager's limits, and SCANNED BEFORE ANY ROW IS WRITTEN — a hard
 *          flag or a restricted-category (financial) hint refuses;
 *      (9) destination = the listing's own landing page through the one resolver,
 *          stamped utm_source=chatgpt so the landing-page lead attribution counts it;
 *     (10) the human half exists end-to-end: stage → approve creative → mark
 *          launched (row counted) → import the report CSV into ad_performance +
 *          history so proposeAdOptimizations judges it on real cost-per-lead.
 *
 * BLIND SPOTS (§2): static. Vibe report field names follow the published OpenAPI
 * (revision 2026-06-01) and await a live 2xx; the ChatGPT bulk-upload column
 * names follow the documented campaign schema as reported by third parties, not
 * an OpenAI-published header row. Neither vendor can be exercised in-sandbox.
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"

let pass = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => stripComments(readFileSync(p, "utf8"))
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length

const VIBE      = src("lib/providers/vibe.ts")
const CONNECTOR = src("lib/ads/connectors/vibe-ctv.ts")
const REGISTRY  = src("lib/ads/connectors/registry.ts")
const TYPES     = src("lib/ads/connectors/types.ts")
const INGEST    = src("lib/ads/ad-performance-ingest.ts")
const CTV       = src("lib/ads/ctv-campaign.ts")
const CTV_ACT   = src("app/actions/ctv-ads.ts")
const MANAGER   = src("lib/ads/ad-manager.ts")
const SWEEP     = src("app/api/cron/ads-manager-sweep/route.ts")
const CONN      = src("lib/ads/connection-status.ts")
const VOCAB     = src("lib/integrations/ad-campaign-vocabulary.ts")
const GPT       = src("lib/ads/chatgpt-campaign.ts")
const GPT_ACT   = src("app/actions/chatgpt-ads.ts")
const GPT_UI    = src("app/dashboard/campaigns/ads/chatgpt-lane.tsx")
const ADS_PAGE  = src("app/dashboard/campaigns/ads/ads-dashboard-client.tsx")
const SIGNALS   = src("lib/kernel/manager-signals.ts")

console.log("══════════════════════════════════════════════════")
console.log(" Streaming TV + ChatGPT Ads — two capabilities inside the one Ads Manager loop")
console.log("══════════════════════════════════════════════════")

console.log("\n── TV 1 · one connector, no second Vibe client (§6) ──")
check("registry maps vibe_ctv → vibeCtvConnector", /vibe_ctv:\s*vibeCtvConnector/.test(REGISTRY))
check("the connector spells no Vibe HTTP of its own", !/api\.vibe\.co|fetch\(|X-Vibe-Revision/.test(CONNECTOR))
check("…publish delegates to dispatchCtvCampaign", /dispatchCtvCampaign\(campaignId\)/.test(CONNECTOR))
check("…reporting delegates to the provider's request/read pair",
  /requestVibeCampaignReport\(/.test(CONNECTOR) && /readVibeCampaignReport\(/.test(CONNECTOR))
check("…audiences answer honestly (ok:false), not a fabricated ok", count(CONNECTOR, /ok: false, recordsSynced: 0/g) === 2)
check("the credential is loaded through the ONE resolver, not platform_credentials",
  /platform === "vibe_ctv"[\s\S]{0,200}resolveVibeCredential\(brokerageId\)/.test(REGISTRY))
check("…and that resolver is the single resolveConnectionResult call in the provider",
  count(VIBE, /resolveConnectionResult\(\{ brokerageId, provider: VIBE_PROVIDER \}\)/g) === 1 && /export async function resolveVibeCredential/.test(VIBE))
check("the revision header is a full ISO date (the contract's YYYY-MM-DD, not year-month)",
  /const VIBE_REVISION = "\d{4}-\d{2}-\d{2}"/.test(VIBE))

console.log("\n── TV 2 · async reporting carried across passes ──")
check("POST /reports filtered to the one campaign, ≤45-day window",
  /"POST", "\/reports"/.test(VIBE) && /filters: \[\{ dimension: "campaign_id", values: \[req\.vibeCampaignId\] \}\]/.test(VIBE) && /VIBE_REPORT_MAX_DAYS = 45/.test(VIBE))
check("GET /reports/{id} and the signed download_url", /`\/reports\/\$\{encodeURIComponent\(reportId\)\}`/.test(VIBE) && /report\.download_url/.test(VIBE))
check("a row naming another campaign is skipped, not summed", /rowCampaign !== vibeCampaignId\) continue/.test(VIBE))
check("the contract has a pending shape", /export interface PerformancePending \{ pending: true; providerState/.test(TYPES) && /providerState\?:/.test(TYPES))
check("the connector returns pending with the report id on pass N", /return \{ pending: true, providerState: \{ vibe_report_id: reportId/.test(CONNECTOR))
check("the ingest persists provider_state and READS the write's error (§3)",
  /isPerformancePending\(perf\)[\s\S]{0,400}provider_state: perf\.providerState[\s\S]{0,300}if \(stateError\) console\.error/.test(INGEST))
check("…and a throwing fetch is logged and skipped, not fatal to the pass", /catch \(e\) \{\s*console\.error\("\[ad-performance-ingest\] fetch failed/.test(INGEST))

console.log("\n── TV 3 · one flip-to-live, two callers ──")
check("launchCtvCampaignOnVibe writes the generic external id AND the provider ids",
  /external_campaign_id: result\.vibeCampaignId/.test(CTV) && /vibe_campaign_id: result\.vibeCampaignId/.test(CTV))
check("…counts the UPDATE (a no-match update also resolves, §3)", /\.select\("id"\)\s*if \(flipError \|\| !flipped\?\.length\)/.test(CTV))
check("the server action delegates and no longer spells the flip", /launchCtvCampaignOnVibe\(\{/.test(CTV_ACT) && !/status: "live"[\s\S]{0,200}vibe_campaign_id/.test(CTV_ACT))
check("the Ads Manager executor delegates for vibe_ctv BEFORE the Meta/Google assembler",
  (() => { const a = MANAGER.indexOf('campaign.platform === "vibe_ctv"'); const b = MANAGER.indexOf("assembleAdFromCampaign"); return a > 0 && b > a && /launchCtvCampaignOnVibe\(\{ campaignId, brokerageId, actorUserId: null, launchedVia: "ads_manager"/.test(MANAGER) })())
check("…and a refused dispatch is an honest skip carrying the reason", /if \(!r\.dispatched\)[\s\S]{0,200}status: "skipped", result: \{ campaign_id: campaignId, reason: r\.reason \}/.test(MANAGER))

console.log("\n── TV 4 · the video_ready handoff has a reader now ──")
check("manager-signals still raises launch_ad_campaign with a video_project_id and no campaign", /source: "video_ready", video_project_id: signal\.entityId/.test(SIGNALS))
check("the executor stages a TV draft from that video instead of failing", /input\.video_project_id\)[\s\S]{0,300}stageCtvCampaignForVideo\(\{ brokerageId, videoProjectId/.test(MANAGER))
check("staging is idempotent per video", /\.contains\("targeting_config", \{ video_project_id: input\.videoProjectId \}\)/.test(CTV))
check("geography only: ZIP + city, then the brokerage city — no age/gender", /targeting\.zips = \[listing\.zip\]/.test(CTV) && !/\b(age|ages|gender|genders|ethnicit\w*|religio\w*)\b/i.test(CTV.slice(CTV.indexOf("stageCtvCampaignForVideo"))))
check("agents.id crosses to users.id through the resolver (§3)", /stageCtvCampaignForVideo[\s\S]*resolveAgentRecordToUserId\(agentRecordId\)/.test(CTV))

console.log("\n── TV 5 · the sweep proposes launches ──")
check("proposeAdLaunches exists and the sweep calls it", /export async function proposeAdLaunches/.test(MANAGER) && /proposeAdLaunches\(bid, svc\)/.test(SWEEP))
check("candidates: approved campaigns + staged vibe_ctv drafts (a draft is a candidate only on TV)",
  /c\.status === "approved" \|\| \(c\.platform === "vibe_ctv" && c\.status === "draft"\)/.test(MANAGER) && /r\.status === "approved" \|\| \(r\.platform === "vibe_ctv" && r\.status === "draft"\)/.test(SWEEP))
check("…gated on a connected account and idempotent per campaign",
  /isAdPlatformConnected\(brokerageId, c\.platform, supabase\)/.test(MANAGER) && /isVibeConfigured\(brokerageId\)/.test(MANAGER) && /\.in\("status", \["proposed", "approved", "executing"\]\)/.test(MANAGER.slice(MANAGER.indexOf("proposeAdLaunches"))))
check("…never for chatgpt (no API to launch on)", /if \(c\.platform === "chatgpt"\) continue/.test(MANAGER))
check("the read refusal is logged, not reported as zero candidates", /launch-candidate read refused/.test(MANAGER))

console.log("\n── TV 6 · one vocabulary class per platform ──")
check("vibe_ctv is provider-connected (vibe) …", /PROVIDER_CONNECTED_AD_PLATFORMS = \{ vibe_ctv: "vibe" \}/.test(VOCAB))
check("…and in neither of the other two lists", !/CONNECTABLE_AD_PLATFORMS = \[[^\]]*vibe_ctv/.test(VOCAB) && !/AD_PLATFORMS_WITHOUT_CONNECTIONS = \[[^\]]*vibe_ctv/.test(VOCAB))
check("chatgpt is in the no-connection class", /AD_PLATFORMS_WITHOUT_CONNECTIONS = \[[^\]]*"chatgpt"/.test(VOCAB))
check("the launch precheck reads that class and asks the Vibe resolver", /PROVIDER_CONNECTED_AD_PLATFORMS as Record[\s\S]{0,300}resolveVibeCredential\(brokerageId\)/.test(CONN))

console.log("\n── GPT 7 · honest about the missing API ──")
check("the lane makes no HTTP call", !/fetch\(/.test(GPT))
check("no chatgpt connector is registered", !/^\s*chatgpt\s*:/m.test(REGISTRY))
check("the executor skips chatgpt with the reason, never a fake live", /campaign\.platform === "chatgpt"[\s\S]{0,200}status: "skipped"/.test(MANAGER))
check("the precheck says so too", /campaignPlatform === "chatgpt"\) return \{ connected: false/.test(CONN))

console.log("\n── GPT 8 · compliance-first copy, the Ads Manager's own limits ──")
check("copy comes from the one Fair-Housing-clean builder", /buildListingCreative\(facts, kind\)/.test(GPT))
check("limits: headline 50, description 100, $25/day minimum", /CHATGPT_HEADLINE_MAX = 50/.test(GPT) && /CHATGPT_DESCRIPTION_MAX = 100/.test(GPT) && /CHATGPT_MIN_DAILY_BUDGET_USD = 25/.test(VOCAB))
check("the client lane imports values only from the client-safe vocabulary (never the server composer)",
  /from "@\/lib\/integrations\/ad-campaign-vocabulary"/.test(GPT_UI) && !/^import \{[^}]*\} from "@\/lib\/ads\/chatgpt-campaign"/m.test(GPT_UI))
check("the scan runs BEFORE the campaign row is inserted",
  (() => { const scan = GPT.indexOf("severity === \"high\""); const ins = GPT.indexOf('.from("ad_campaigns").insert'); return scan > 0 && ins > scan })())
check("a restricted-category (financial) hint is refused, not warned", /RESTRICTED_FINANCIAL\.test\(h\)/.test(GPT) && /if \(restricted\) return \{ success: false/.test(GPT))
check("context hints are intent + geography, never a protected class", !/\b(age|ages|gender|genders|famil\w*|religio\w*|ethnic\w*|disab\w*)\b/i.test(GPT.slice(GPT.indexOf("const contextHints"), GPT.indexOf("const contextHints") + 600)))

console.log("\n── GPT 9 · destination + attribution ──")
check("destination through the one resolver, fail-closed", /resolveAdDestination\(svc, \{ brokerageId: input\.brokerageId, listingId: input\.listingId, teamId \}\)/.test(GPT) && /if \(!destination\) return \{ success: false/.test(GPT))
check("utm_source=chatgpt on the click", /utm_source", "chatgpt"/.test(GPT))
check("the landing page records utm_source on the visit/lead", /utm_source/.test(src("app/actions/listing-landing.ts")))

console.log("\n── GPT 10 · the human half end-to-end ──")
check("the creative rides the one approval queue as a draft", /ad_creative_variations"\)\.insert\([\s\S]{0,400}generated_from: "chatgpt_lane", approval_status: "draft"/.test(GPT))
check("mark-launched counts the UPDATE and records external_campaign_id", /external_campaign_id: input\.externalCampaignId/.test(GPT) && /if \(!flipped\?\.length\) return \{ success: false/.test(GPT))
check("the CSV import lands in ad_performance via the one mapper + the history series",
  /toAdPerformanceRow\(input\.brokerageId, input\.campaignId, row\)/.test(GPT) && /recordAdPerformanceSnapshot\(\{ brokerageId: input\.brokerageId, adCampaignId: input\.campaignId/.test(GPT))
check("…skipping an export's Total row and refusing an unrecognisable file", /\^total\/i/.test(GPT) && /if \(iImp < 0 && iClk < 0 && iSpend < 0\) return null/.test(GPT))
check("three session-gated actions", /export async function stageChatgptCampaignAction/.test(GPT_ACT) && /export async function markChatgptCampaignLaunchedAction/.test(GPT_ACT) && /export async function importChatgptPerformanceAction/.test(GPT_ACT) && /supabase\.auth\.getUser\(\)/.test(GPT_ACT))
check("…each with a UI caller in the lane, rendered in the ads workspace",
  /stageChatgptCampaignAction\(/.test(GPT_UI) && /markChatgptCampaignLaunchedAction\(/.test(GPT_UI) && /importChatgptPerformanceAction\(/.test(GPT_UI) && /<ChatgptLane/.test(ADS_PAGE))

console.log("\n── CONTROLS ──")
check("POSITIVE CONTROL: the order finder fails when the insert precedes the scan",
  (() => { const s = 'x.from("ad_campaigns").insert(…) … severity === "high"'; const scan = s.indexOf('severity === "high"'); const ins = s.indexOf('.from("ad_campaigns").insert'); return !(scan > 0 && ins > scan) })())
check("POSITIVE CONTROL: the HTTP finder would catch a copied client", /fetch\(/.test('const r = await fetch("https://ads.openai.com/api")'))
check("POSITIVE CONTROL: the protected-class finder catches a real word, not a substring",
  /\b(age|ages|gender|genders)\b/i.test("ages: [25, 54]") && !/\b(age|ages|gender|genders)\b/i.test("manager stage message"))
check("BLINDNESS CONTROL: scans read comment-STRIPPED source", !stripComments("// vibe_ctv: vibeCtvConnector\n").includes("vibeCtvConnector"))

console.log("\n──────────────────────────────────────────────────")
console.log(" BLIND SPOTS (§2): static; Vibe report fields per OpenAPI 2026-06-01 await a live 2xx;")
console.log(" ChatGPT bulk-upload columns follow the documented schema as reported, not a published header row.")
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(`\n RESULT: ${pass} passed, ${fails.length} failed`)
if (fails.length > 0) { console.log(" ❌ ADS_CTV_CHATGPT_LANE_FAIL"); process.exit(1) }
console.log(" ✅ ADS_CTV_CHATGPT_LANE_PASS — TV launches, reports and re-judges itself; ChatGPT stages, uploads by hand, imports and re-judges")
