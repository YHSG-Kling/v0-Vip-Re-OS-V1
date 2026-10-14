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
 *  GPT (7) chatgpt is a connector on the OpenAI Advertiser API (one provider
 *          module runs the documented chain; approved copy only; region/DMA
 *          targeting; paused-then-activate; three-state credential; the flip
 *          lives once; the sweep proposes launches) and honest when no key;
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
 * an OpenAI-published header row; the Advertiser API request shapes follow
 * developers.openai.com/ads (quickstart, campaigns, ad-groups, campaign-targeting,
 * insights, authentication) and await a live 2xx. Neither vendor can be
 * exercised in-sandbox.
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
const GPT_CONNECTOR = src("lib/ads/connectors/chatgpt.ts")
const OPENAI    = src("lib/providers/openai-ads.ts")
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
check("…and the dispatcher asks that resolver, not the Connection OS directly (isVibeConfigured keeps its pinned direct read — test:credential-cascade-refusal C9)",
  /export async function resolveVibeCredential/.test(VIBE)
  && count(VIBE, /resolveConnectionResult\(\{ brokerageId, provider: VIBE_PROVIDER \}\)/g) === 2
  && !/resolveConnectionResult\(/.test(VIBE.slice(VIBE.indexOf("export async function dispatchCtvCampaign"), VIBE.indexOf("export interface VibeReportRequest")))
  && /resolveVibeCredential\(campaign\.brokerage_id as string\)/.test(VIBE))
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
check("candidates: approved campaigns + staged vibe_ctv/chatgpt drafts (a draft is a candidate only on the provider-connected lanes)",
  /c\.status === "approved" \|\| \(\(c\.platform === "vibe_ctv" \|\| c\.platform === "chatgpt"\) && c\.status === "draft"\)/.test(MANAGER) && /r\.status === "approved" \|\| \(\(r\.platform === "vibe_ctv" \|\| r\.platform === "chatgpt"\) && r\.status === "draft"\)/.test(SWEEP))
check("…gated on a connected account and idempotent per campaign",
  /isAdPlatformConnected\(brokerageId, c\.platform, supabase\)/.test(MANAGER) && /isVibeConfigured\(brokerageId\)/.test(MANAGER) && /\.in\("status", \["proposed", "approved", "executing"\]\)/.test(MANAGER.slice(MANAGER.indexOf("proposeAdLaunches"))))
check("…and for chatgpt only with approved copy (the one queue) — never a draft creative", /c\.platform === "chatgpt"[\s\S]{0,400}\.eq\("approval_status", "approved"\)/.test(MANAGER))
check("the read refusal is logged, not reported as zero candidates", /launch-candidate read refused/.test(MANAGER))

console.log("\n── TV 6 · one vocabulary class per platform ──")
check("vibe_ctv and chatgpt are provider-connected (vibe / openai_ads) …", /PROVIDER_CONNECTED_AD_PLATFORMS = \{ vibe_ctv: "vibe", chatgpt: "openai_ads" \}/.test(VOCAB))
check("…and in neither of the other two lists", !/CONNECTABLE_AD_PLATFORMS = \[[^\]]*vibe_ctv/.test(VOCAB) && !/AD_PLATFORMS_WITHOUT_CONNECTIONS = \[[^\]]*vibe_ctv/.test(VOCAB))
check("…and chatgpt is in neither of the other two lists", !/CONNECTABLE_AD_PLATFORMS = \[[^\]]*chatgpt/.test(VOCAB) && !/AD_PLATFORMS_WITHOUT_CONNECTIONS = \[[^\]]*chatgpt/.test(VOCAB))
check("the launch precheck reads that class and asks the Vibe resolver", /PROVIDER_CONNECTED_AD_PLATFORMS as Record[\s\S]{0,300}resolveVibeCredential\(brokerageId\)/.test(CONN))

console.log("\n── GPT 7 · one connector on the OpenAI Advertiser API, honest when no key ──")
check("registry maps chatgpt → chatgptConnector", /chatgpt:\s*chatgptConnector/.test(REGISTRY))
check("the connector spells no OpenAI Ads HTTP of its own", !/api\.ads\.openai\.com|fetch\(/.test(GPT_CONNECTOR))
check("…publish delegates to dispatchChatgptCampaign, insights to fetchOpenaiCampaignInsights",
  /dispatchChatgptCampaign\(campaignId\)/.test(GPT_CONNECTOR) && /fetchOpenaiCampaignInsights\(/.test(GPT_CONNECTOR))
check("the provider runs the documented chain: account → geo lookup → upload → campaign → ad group → ad → activate",
  /"GET", "\/ad_account"/.test(OPENAI) && /\/geo_lookup\/search\?q=/.test(OPENAI) && /"POST", "\/upload"/.test(OPENAI)
  && /"POST", "\/campaigns"/.test(OPENAI) && /"POST", "\/ad_groups"/.test(OPENAI) && /"POST", "\/ads"/.test(OPENAI)
  && /\{ status: "active" \}/.test(OPENAI) && /https:\/\/api\.ads\.openai\.com\/v1/.test(OPENAI))
check("…the campaign is created PAUSED and activated last (the contract's validate-then-serve order)",
  (() => { const a = OPENAI.indexOf('status: "paused"'); const b = OPENAI.indexOf('{ status: "active" }'); return a > 0 && b > a })())
check("…the copy is the APPROVED creative from the one queue (approval_status approved), never the draft",
  /\.eq\("approval_status", "approved"\)/.test(OPENAI) && /no APPROVED creative/.test(OPENAI))
check("…the chat card obeys the limits (title ≤50, body ≤100) and carries the UTM destination",
  /title: creative\.headline\.slice\(0, 50\)/.test(OPENAI) && /body: creative\.primary_text\.slice\(0, 100\)/.test(OPENAI) && /target_url: destination/.test(OPENAI))
check("…targeting is region/DMA ids only; no resolvable location REFUSES rather than running nationwide",
  /targeting: \{ locations: \{ include:/.test(OPENAI) && /if \(locations\.length === 0\)/.test(OPENAI) && !/custom_audiences/.test(OPENAI))
check("…the daily budget maps to the API's lifetime cap over a stated flight", /OPENAI_ADS_FLIGHT_DAYS = 30/.test(OPENAI) && /lifetime_spend_limit_micros: Math\.max\(MICROS/.test(OPENAI) && /end_time: now \+ OPENAI_ADS_FLIGHT_DAYS \* 86_400/.test(OPENAI))
check("the credential is resolved ONCE (provider openai_ads) with three states, and the dispatcher tells them apart",
  /export async function resolveOpenaiAdsCredential/.test(OPENAI) && /OPENAI_ADS_PROVIDER = "openai_ads"/.test(OPENAI)
  && /openai_ads_connection_unreadable/.test(OPENAI) && /openai_ads_not_connected — campaign staged as launch package/.test(OPENAI)
  && !/\.catch\s*\(\s*\(\s*\)\s*=>\s*null\s*\)/.test(OPENAI))
check("the registry loads the chatgpt credential through that resolver, not platform_credentials",
  /platform === "chatgpt"[\s\S]{0,200}resolveOpenaiAdsCredential\(brokerageId\)/.test(REGISTRY))
check("the precheck resolves openai_ads through PROVIDER_CONNECTED_AD_PLATFORMS", /provider === "openai_ads"[\s\S]{0,200}resolveOpenaiAdsCredential/.test(CONN) && /chatgpt: "openai_ads"/.test(VOCAB) && !/"chatgpt"\]/.test(VOCAB.slice(VOCAB.indexOf("AD_PLATFORMS_WITHOUT_CONNECTIONS ="))))
check("one flip-to-live for chatgpt (launchChatgptCampaignOnOpenai), UPDATE counted, external_campaign_id + openai ids",
  /export async function launchChatgptCampaignOnOpenai/.test(GPT) && /external_campaign_id: result\.openaiCampaignId/.test(GPT) && /\.select\("id"\)\s*if \(flipError \|\| !flipped\?\.length\)/.test(GPT.slice(GPT.indexOf("launchChatgptCampaignOnOpenai"))))
check("the Ads Manager executor delegates for chatgpt and skips honestly when not dispatched",
  /campaign\.platform === "chatgpt"[\s\S]{0,900}launchChatgptCampaignOnOpenai\(\{ campaignId, brokerageId, actorUserId: null, launchedVia: "ads_manager"/.test(MANAGER)
  && /if \(!r\.dispatched\) return \{ status: "skipped", result: \{ campaign_id: campaignId, reason: r\.reason \} \}/.test(MANAGER))
check("the sweep proposes chatgpt launches (approved copy + key connected)",
  /c\.platform === "chatgpt"[\s\S]{0,600}isAdPlatformConnected\(brokerageId, "chatgpt", supabase\)/.test(MANAGER) && /\(r\.platform === "vibe_ctv" \|\| r\.platform === "chatgpt"\) && r\.status === "draft"/.test(SWEEP))
check("the ingest can read chatgpt performance (connector present, external id key shared)", /fetchPerformance\(args: PerformanceQuery\)/.test(GPT_CONNECTOR) && /external_campaign_id/.test(INGEST))

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
// 2026-09-09: the session gate MOVED out of the action file — the SAME-BODY census merged the
// local requireActor onto lib/auth/require-caller.ts::requireAdsActor (§1/§6), so pinning
// `supabase.auth.getUser()` INSIDE chatgpt-ads.ts was a waypoint (§2). The rule: each of the
// three actions calls the gate, and the gate they import is the one that reads the session.
const GATE_IMPORT = GPT_ACT.match(/import \{ requireAdsActor as (\w+) \} from "@\/lib\/auth\/require-caller"/)?.[1] ?? "requireAdsActor"
const REQUIRE_CALLER = src("lib/auth/require-caller.ts")
check("three session-gated actions", /export async function stageChatgptCampaignAction/.test(GPT_ACT) && /export async function markChatgptCampaignLaunchedAction/.test(GPT_ACT) && /export async function importChatgptPerformanceAction/.test(GPT_ACT)
  && (GPT_ACT.match(new RegExp(`await ${GATE_IMPORT}\\(\\)`, "g")) ?? []).length >= 3
  && /export async function requireAdsActor[\s\S]{0,400}supabase\.auth\.getUser\(\)/.test(REQUIRE_CALLER))
check("…each with a UI caller in the lane, rendered in the ads workspace",
  /stageChatgptCampaignAction\(/.test(GPT_UI) && /markChatgptCampaignLaunchedAction\(/.test(GPT_UI) && /importChatgptPerformanceAction\(/.test(GPT_UI) && /<ChatgptLane/.test(ADS_PAGE))

console.log("\n── DOOR · the credential the two providers READ can be WRITTEN ──")
{
  const SLOTS = src("lib/settings/tenant-connection-slots.ts")
  const SAVE  = src("app/actions/tenant-connections.ts")
  const M609  = readFileSync("supabase/migrations/m609-ad-providers-have-a-credential-door.sql", "utf8")
  const CACHE = readFileSync("scripts/check-vocabularies.ts", "utf8")
  check("m609 admits 'vibe' and 'openai_ads' in platform_credentials.platform", /'vibe','openai_ads'\]\)\);/.test(M609) && /APPLIED 2026-09-07/.test(M609))
  check("…and the generated vocabulary cache agrees (regenerated from the live database, never hand-edited)",
    /platform_credentials: \{[\s\S]{0,1200}"openai_ads"[\s\S]{0,800}"vibe"/.test(CACHE))
  check("the one tenant-connection writer offers both slots", /key: "openai_ads"[\s\S]{0,120}fields: \["api_key"\]/.test(SLOTS) && /key: "vibe"[\s\S]{0,160}fields: \["api_key", "api_secret", "account_id"\]/.test(SLOTS))
  check("…stores the secret half under the key the resolver reads first (§6 — one secret vocabulary)",
    /config: \{ \[CONFIG_SECRET_KEYS\[0\]\]: apiSecret \}/.test(SAVE) && /needs the secret half of the pair too/.test(SAVE))
  check("…and the providers ask the Connection OS by exactly those names", /OPENAI_ADS_PROVIDER = "openai_ads"/.test(OPENAI) && /VIBE_PROVIDER = "vibe"/.test(VIBE))
}

console.log("\n── CONTROLS ──")
check("POSITIVE CONTROL: the order finder fails when the insert precedes the scan",
  (() => { const s = 'x.from("ad_campaigns").insert(…) … severity === "high"'; const scan = s.indexOf('severity === "high"'); const ins = s.indexOf('.from("ad_campaigns").insert'); return !(scan > 0 && ins > scan) })())
check("POSITIVE CONTROL: the HTTP finder would catch a copied client in a connector", /api\.ads\.openai\.com|fetch\(/.test('const r = await fetch("https://api.ads.openai.com/v1/ads")'))
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
