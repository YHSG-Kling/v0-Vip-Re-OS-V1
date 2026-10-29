#!/usr/bin/env tsx
/**
 * scripts/ads-tv-connections-guard.ts — test:ads-tv-connections (wave 146, lane 146E).
 *
 * Owner rulings 8, 9 and 2 (2026-10-29), proven in memory (no network, no database, no keys):
 *   A · DECLARATIONS — GroundTruth and StackAdapt each declare EVERY capability ruling 8 names, from their own docs
 *       (sources cited, read date), with UNKNOWN kept as an answer; a "built" claim names a function that EXISTS in
 *       stripped source; a non-supported capability is never "built"; TV formats are separated from non-TV formats.
 *       POSITIVE CONTROL: a planted declaration whose built path names a missing function is flagged.
 *   B · FABRIC — the two connectors are in the ONE ad-connector registry, the credential loader resolves them through
 *       the Connection OS, the campaign + TV vocabularies name them, readiness rows exist (vendor ownership, posture
 *       shelf, adapter facts, tenant connection slots), m881 admits them and KEEPS every live value (the rule, not the
 *       waypoint: line 1 may be the lane stamp or the APPLIED LIVE stamp).
 *   C · ADAPTERS — a recording transport (no network): the documented call chains in order, geography only (no
 *       genders / ages / incomes / demographic segments ever sent), the TV master (never the social reel), a refusal
 *       BEFORE any call when the staged spot is unfit, activation only after every create succeeded, StackAdapt
 *       userErrors and async Progress honoured, a CRM segment carries hashed e-mails only.
 *   D · C5 APPROVER — approverFor picks owner → team lead → brokerage; the brokerage is REQUIRED only by a recorded
 *       policy / legal requirement (then the owner is NOT permitted — positive control); an unreadable policy fails
 *       closed; every publish door calls requirePublishApprover BEFORE its approval write (stripped-source order); the
 *       social REQUEST door (scheduleSocialPost) asks approverFor before it inserts, and its client flag only tightens.
 *   E · C2 RE-ENGAGEMENT — identity + consent + fair housing + entitlement + credentials + authority gates; a draft
 *       audience + ONE pending request + the approver told; idempotent; the upload door refuses until a PERMITTED
 *       person approved; the new source rule narrows to exactly the named ids and refuses an empty list.
 *   F · LAUNCH ROUTING — the Ads Manager proposes and executes the two TV connections through the ONE TV router,
 *       whose provider confirmation precedes the live flip; the performance ingest records the provider's own status.
 * BLIND SPOTS (published): no live call is made (credentials are WAITING_EXTERNAL); the vendors' error envelopes and
 * response shapes are taken from their published schemas, not observed; StackAdapt's GraphQL reference is gated behind
 * a login, so its schema was read from StackAdapt's own SDK package (0.73.0); the in-memory client models jsonb @> only
 * at the top level; the door census reads stripped source order, not runtime.
 */
import { readFileSync, readdirSync } from "node:fs"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"
import type { GatewayRequest, GatewayResponse } from "../lib/agentic-os/connector-gateway"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const section = (s: string) => console.log(`\n── ${s} ──`)
const raw = (f: string) => readFileSync(f, "utf8")
const code = (f: string) => stripComments(raw(f))
const codeNoStrings = (f: string) => blankStrings(stripComments(raw(f)))

const B1 = "11111111-1111-4111-8111-111111111111"
const B2 = "22222222-2222-4222-8222-222222222222"
const U_OWNER = "33333333-3333-4333-8333-333333333333"
const U_LEAD = "44444444-4444-4444-8444-444444444444"
const U_ADMIN = "55555555-5555-4555-8555-555555555555"
const U_OTHER = "66666666-6666-4666-8666-666666666666"
const A_OWNER = "77777777-7777-4777-8777-777777777777"
const A_OTHER = "88888888-8888-4888-8888-888888888888"
const TEAM = "99999999-9999-4999-8999-999999999999"
const CAMP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1"
const C2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2"
const C3 = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3"
const C4 = "c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4"
const L1 = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1"
const L2 = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2"

/** A recording transport — the gateway seam. Answers by a matcher list; records every request. */
function recorder(answers: Array<{ match: (r: GatewayRequest) => boolean; res: Partial<GatewayResponse> }>) {
  const calls: GatewayRequest[] = []
  const t = async (r: GatewayRequest): Promise<GatewayResponse> => {
    calls.push(r)
    const a = answers.find((x) => x.match(r))
    return { ok: true, status: 200, data: null, headers: {}, drift: null, error: null, ...(a?.res ?? {}) } as GatewayResponse
  }
  return { calls, t }
}
const gqlOp = (r: GatewayRequest) => String(((r.body ?? {}) as { query?: string }).query ?? "").match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? ""

async function main() {
  const gt = await import("../lib/providers/groundtruth-ads")
  const sa = await import("../lib/providers/stackadapt-ads")
  const KEYS = ["account_access", "campaign_creation", "creative_association", "budget", "provider_review", "status_readback", "performance_readback", "conversion_readback", "attribution", "ctv_inventory", "lead_readback", "response_readback", "audience_sync", "webhooks"] as const

  // ════════════════════════════════════════════════════════════════════════════════════════════
  section("A · capability declarations — documented truth, UNKNOWN kept, built claims real")
  type Decl = typeof gt.GROUNDTRUTH_DECLARATION
  const validate = (d: Decl, providerFile: string): string[] => {
    const src = code(providerFile)
    const bad: string[] = []
    for (const k of KEYS) {
      const c = (d.capabilities as Record<string, { documented: string; via: string; built: string | null; evidence: string }>)[k]
      if (!c) { bad.push(`${k}: undeclared`); continue }
      if (!["supported", "unsupported", "unknown"].includes(c.documented)) bad.push(`${k}: documented '${c.documented}'`)
      if (!c.evidence || c.evidence.length < 12) bad.push(`${k}: no evidence`)
      if (c.documented !== "supported" && c.built) bad.push(`${k}: '${c.documented}' yet claims built`)
      if (c.built) {
        const fn = c.built.match(/\.ts\s+(\w+)/)?.[1]
        if (!fn || !new RegExp(`function\\s+${fn}\\s*\\(`).test(src)) bad.push(`${k}: built names '${fn}', not a function in ${providerFile}`)
      }
    }
    return bad
  }
  for (const [d, file, host] of [[gt.GROUNDTRUTH_DECLARATION, "lib/providers/groundtruth-ads.ts", "api-docs.groundtruth.com"], [sa.STACKADAPT_DECLARATION, "lib/providers/stackadapt-ads.ts", "docs.stackadapt.com"]] as const) {
    const bad = validate(d as Decl, file)
    check(`${d.provider}: all ${KEYS.length} ruling-8 capabilities declared, each with evidence; no unsupported/unknown claims built; every built path is a real function`, bad.length === 0, bad.join("; "))
    check(`${d.provider}: the primary source is cited (${host}) with the read date`, d.sources.some((s) => s.includes(host)) && /^\d{4}-\d{2}-\d{2}$/.test(d.readOn))
    check(`${d.provider}: TV formats and non-TV formats are disjoint and both stated (not every format is TV)`, d.tvFormats.length > 0 && d.nonTvFormats.length > 0 && d.tvFormats.every((f) => !d.nonTvFormats.includes(f)))
    check(`${d.provider}: the credential is named, never a value`, d.credentialFields.length > 0 && !JSON.stringify(d).match(/sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9]{12,}/))
  }
  check("GroundTruth: CTV is a TV format; app / web / audio / DOOH are not", gt.GROUNDTRUTH_DECLARATION.tvFormats.includes("ctv") && ["app", "web", "audio-podcast", "dooh"].every((f) => gt.GROUNDTRUTH_DECLARATION.nonTvFormats.includes(f)))
  check("GroundTruth: audience upload is UNKNOWN (no endpoint published) and webhooks unsupported — never upgraded by a guess", gt.GROUNDTRUTH_DECLARATION.capabilities.audience_sync.documented === "unknown" && gt.GROUNDTRUTH_DECLARATION.capabilities.webhooks.documented === "unsupported")
  check("StackAdapt: CTV + PROGRAMMATIC_LINEAR_TV are TV; webhooks documented but NOT built (payload/signature unpublished)", sa.STACKADAPT_DECLARATION.tvFormats.includes("CTV") && sa.STACKADAPT_DECLARATION.capabilities.webhooks.documented === "supported" && sa.STACKADAPT_DECLARATION.capabilities.webhooks.built === null)
  check("neither provider claims lead or response readback (nothing fake reaches the C1 inbound record)", [gt.GROUNDTRUTH_DECLARATION, sa.STACKADAPT_DECLARATION].every((d) => d.capabilities.lead_readback.documented === "unsupported" && d.capabilities.response_readback.documented === "unsupported"))
  {
    const planted = JSON.parse(JSON.stringify(gt.GROUNDTRUTH_DECLARATION)) as Decl
    ;(planted.capabilities as any).attribution = { documented: "supported", via: "poll", built: "lib/providers/groundtruth-ads.ts fetchGroundtruthFootTraffic", evidence: "planted for the positive control" }
    ;(planted.capabilities as any).webhooks = { documented: "unknown", via: "none", built: "lib/providers/groundtruth-ads.ts launchGroundtruthCampaign", evidence: "planted for the positive control" }
    const bad = validate(planted, "lib/providers/groundtruth-ads.ts")
    check("POSITIVE CONTROL: a planted built-claim naming a missing function AND an 'unknown' claimed as built are both flagged", bad.some((b) => b.startsWith("attribution")) && bad.some((b) => b.startsWith("webhooks")), bad.join("; "))
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  section("B · fabric — registry, credentials, vocabularies, readiness rows, m881")
  const { getConnector } = await import("../lib/ads/connectors/registry")
  check("the ONE ad-connector registry maps groundtruth and stackadapt", getConnector("groundtruth")?.platform === "groundtruth" && getConnector("stackadapt")?.platform === "stackadapt")
  check("…and keeps Meta / Google / Vibe / ChatGPT", ["facebook", "instagram", "google", "vibe_ctv", "chatgpt"].every((p) => !!getConnector(p)))
  const reg = code("lib/ads/connectors/registry.ts")
  check("loadConnectorCredential resolves both through the Connection OS resolvers and stamps the tenant", /resolveGroundtruthCredential\(brokerageId\)/.test(reg) && /resolveStackadaptCredential\(brokerageId\)/.test(reg) && (reg.match(/brokerageId \}/g) ?? []).length >= 5)
  const vocab = await import("../lib/integrations/ad-campaign-vocabulary")
  check("campaign vocabulary names both; the TV list is vibe_ctv + groundtruth + stackadapt", (["groundtruth", "stackadapt"] as const).every((p) => (vocab.AD_CAMPAIGN_PLATFORMS as readonly string[]).includes(p)) && JSON.stringify(vocab.TV_AD_CAMPAIGN_PLATFORMS) === JSON.stringify(["vibe_ctv", "groundtruth", "stackadapt"]))
  check("both are provider-connected (one class per platform, §6)", vocab.PROVIDER_CONNECTED_AD_PLATFORMS.groundtruth === "groundtruth" && vocab.PROVIDER_CONNECTED_AD_PLATFORMS.stackadapt === "stackadapt" && !(vocab.CONNECTABLE_AD_PLATFORMS as readonly string[]).includes("groundtruth"))
  const { USER_CONNECTED_VENDORS } = await import("../lib/agentic-os/vendor-ownership")
  check("readiness: both are USER-CONNECTED vendors (tenant account, tenant spend)", USER_CONNECTED_VENDORS.has("groundtruth") && USER_CONNECTED_VENDORS.has("stackadapt"))
  check("readiness: both sit on the paid-acquisition shelf beside Vibe", /groundtruth:\s*"leadgen",\s*stackadapt:\s*"leadgen"/.test(code("lib/platform/provider-posture.ts")))
  const pa = await import("../lib/kernel/provider-adapters")
  check("adapter facts: both declared, tenant-account ledger, gateway egress", ["groundtruth", "stackadapt"].every((p) => pa.adapterFor(p)?.cost.ledger === "tenant_account"))
  const slots = (await import("../lib/settings/tenant-connection-slots")).TENANT_CONNECTION_SLOTS as readonly { key: string; fields: readonly string[] }[]
  check("the tenant can enter both credentials (Settings → Connections slots: GroundTruth needs the key + user-id pair)", slots.some((s) => s.key === "groundtruth" && s.fields.includes("api_secret")) && slots.some((s) => s.key === "stackadapt" && s.fields.includes("api_key")))
  {
    const f = readdirSync("supabase/migrations").find((n) => /^m881-/.test(n))
    const m = f ? raw(`supabase/migrations/${f}`) : ""
    const { CHECK_VOCABULARIES } = await import("./check-vocabularies")
    const liveCred = (CHECK_VOCABULARIES as any).platform_credentials?.platform as string[] ?? []
    const liveCamp = (CHECK_VOCABULARIES as any).ad_campaigns?.platform as string[] ?? []
    const liveAud = (CHECK_VOCABULARIES as any).facebook_custom_audiences?.target_platform as string[] ?? []
    check("m881 exists, line 1 is the lane stamp OR the APPLIED LIVE stamp (the rule, not the waypoint)", !!f && /^-- (WRITTEN, NOT APPLIED \(wave 146, lane 146E\)|── APPLIED LIVE )/.test(m))
    check("m881 admits groundtruth + stackadapt on campaigns and credentials, stackadapt on audiences", /ad_campaigns_platform_check[\s\S]*'groundtruth','stackadapt'/.test(m) && /platform_credentials_platform_check[\s\S]*'groundtruth','stackadapt'/.test(m) && /target_platform_check[\s\S]*'stackadapt'/.test(m))
    check("m881 KEEPS every live value of all three CHECKs (no value dropped)", [...liveCred, ...liveCamp, ...liveAud].every((v) => m.includes(`'${v}'`)), [...liveCred, ...liveCamp, ...liveAud].filter((v) => !m.includes(`'${v}'`)).join(","))
    check("POSITIVE CONTROL: the keep-check sees a value m881 does not carry", !m.includes("'not_a_live_platform'"))
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  section("C · adapters — documented chains, geography only, TV master only, honest refusals")
  const MASTER = "https://cdn.example/tv-master.mp4"
  const stagedRow = (platform: string, over: Record<string, unknown> = {}) => ({
    id: CAMP, brokerage_id: B1, platform, status: "draft", campaign_name: "Spring market — TV", daily_budget: 40,
    targeting_config: { play: "ctv", zips: ["33602"], dmas: ["Tampa-St. Petersburg (Sarasota)"], cities: [], creative_video_url: MASTER, creative_source: "tv_master", bid_cpm_usd: 32, ...over },
  })
  async function gtConn() {
    const conn = { apiKey: "gt-key-xxxxxx", apiSecret: "gt-user-1", accountId: "4242", config: {}, brokerageId: B1 }
    return { status: "connected" as const, conn }
  }
  {
    const rec = recorder([
      { match: (r) => r.path === "/users/current", res: { data: { user_id: 1, tenant_id: 77 } } },
      { match: (r) => r.path === "/accounts/4242", res: { data: { id: 4242, name: "Acme Realty", currency: "USD" } } },
      { match: (r) => r.path === "/campaigns" && r.method === "POST", res: { data: { id: 9001 } } },
      { match: (r) => r.path === "/adgroups", res: { data: { id: 9101 } } },
      { match: (r) => r.path === "/creatives", res: { data: { id: 9201 } } },
      { match: (r) => r.path === "/campaigns/9001", res: { data: { id: 9001, status: 1 } } },
    ])
    const db = memSupabase({ ad_campaigns: [stagedRow("groundtruth")] })
    const r = await gt.launchGroundtruthCampaign(CAMP, { transport: rec.t, client: db as never, resolve: gtConn, now: new Date("2026-11-01T00:00:00Z") })
    const order = rec.calls.map((c) => `${c.method} ${c.path}`)
    check("GroundTruth: dispatched only after the activation answered, with every provider id", r.dispatched && r.groundtruthCampaignId === "9001" && r.groundtruthAdgroupId === "9101" && r.groundtruthCreativeId === "9201", JSON.stringify(r))
    check("GroundTruth: the documented chain in order — users/current → account → campaign (PAUSED) → CTV ad group → VIDEO creative → activate", JSON.stringify(order) === JSON.stringify(["GET /users/current", "GET /accounts/4242", "POST /campaigns", "POST /adgroups", "POST /creatives", "PATCH /campaigns/9001"]), order.join(" | "))
    const camp = rec.calls[2].body as Record<string, unknown>, group = rec.calls[3].body as Record<string, unknown>, cre = rec.calls[4].body as Record<string, unknown>
    check("GroundTruth: the campaign is created PAUSED (status 2), DAILY budget at campaign level; activation sends status 1", camp.status === 2 && camp.budget_type === 3 && camp.budget_level === "campaign" && (rec.calls[5].body as Record<string, unknown>).status === 1)
    check("GroundTruth: the ad group is CTV only, geography only — no genders / age_ranges / income_ranges / audiences", JSON.stringify(group.media_types) === JSON.stringify(["ctv"]) && !["genders", "age_ranges", "income_ranges", "audiences", "communities"].some((k) => k in group) && Array.isArray(group.location_filters) && (group.location_filters as Array<{ type: string }>).every((f) => ["DMA", "City", "Zip"].includes(f.type)))
    check("GroundTruth: the creative is the TV MASTER as a VIDEO", cre.type === "VIDEO" && cre.video_url === MASTER)
    check("GroundTruth: every call carries X-GT-USER-ID + the X-GT-API-KEY auth header, the tenant, and GroundTruth's tenant_id where documented", rec.calls.every((c) => c.headers?.["X-GT-USER-ID"] === "gt-user-1" && (c.auth as { name?: string }).name === "X-GT-API-KEY" && c.brokerageId === B1) && rec.calls.slice(1).every((c) => c.query?.tenant_id === "77"))
  }
  for (const [label, over, expect] of [
    ["the social reel (not the TV master)", { creative_source: "video_url" }, /TV master/],
    ["no geography", { zips: [], dmas: [], cities: [] }, /nationwide/],
    ["no CPM bid", { bid_cpm_usd: null }, /CPM bid/],
  ] as const) {
    const rec = recorder([])
    const r = await gt.launchGroundtruthCampaign(CAMP, { transport: rec.t, client: memSupabase({ ad_campaigns: [stagedRow("groundtruth", over as Record<string, unknown>)] }) as never, resolve: gtConn })
    check(`GroundTruth refuses ${label} BEFORE any provider call`, !r.dispatched && (expect as RegExp).test(r.reason) && rec.calls.length === 0, r.reason)
  }
  {
    const rec = recorder([{ match: (r) => r.path === "/users/current", res: { data: { tenant_id: 77 } } }, { match: (r) => r.path === "/accounts/4242", res: { data: { id: 4242, currency: "CAD" } } }])
    const r = await gt.launchGroundtruthCampaign(CAMP, { transport: rec.t, client: memSupabase({ ad_campaigns: [stagedRow("groundtruth")] }) as never, resolve: gtConn })
    check("GroundTruth refuses a non-USD account (budget unit UNKNOWN beyond `number`) — no POST", !r.dispatched && /currency/.test(r.reason) && !rec.calls.some((c) => c.method === "POST"))
  }
  {
    const rec = recorder([
      { match: (r) => r.path === "/users/current", res: { data: { tenant_id: 77 } } },
      { match: (r) => r.path === "/accounts/4242", res: { data: { id: 4242, currency: "USD" } } },
      { match: (r) => r.path === "/campaigns" && r.method === "POST", res: { data: { id: 9001 } } },
      { match: (r) => r.path === "/adgroups", res: { ok: false, status: 422, errorBody: { errors: [{ code: "invalid", message: "bid_price below minimum", fields: ["bid_price"] }] } } },
    ])
    const r = await gt.launchGroundtruthCampaign(CAMP, { transport: rec.t, client: memSupabase({ ad_campaigns: [stagedRow("groundtruth")] }) as never, resolve: gtConn })
    check("GroundTruth: a refused ad group returns GroundTruth's own message and NEVER activates", !r.dispatched && /bid_price below minimum/.test(r.reason) && !rec.calls.some((c) => c.method === "PATCH"), r.reason)
  }
  {
    const r = await gt.launchGroundtruthCampaign(CAMP, { client: memSupabase({ ad_campaigns: [stagedRow("groundtruth")] }) as never, resolve: async () => ({ status: "not_connected", reason: "groundtruth_not_connected" }) })
    check("GroundTruth not connected → the spot stays staged (WAITING_EXTERNAL credentials named)", !r.dispatched && /not_connected/.test(r.reason))
    const w = await gt.launchGroundtruthCampaign(CAMP, { client: memSupabase({ ad_campaigns: [stagedRow("vibe_ctv")] }) as never, resolve: gtConn })
    check("GroundTruth refuses a row staged for another provider", !w.dispatched && /not 'groundtruth'/.test(w.reason))
  }
  {
    const rec = recorder([{ match: (r) => r.path === "/users/current", res: { data: { tenant_id: 77 } } }, { match: (r) => /\/reporting\/totals\/campaign\/9001/.test(r.path ?? ""), res: { data: [{ impressions: 1000, clicks: 3, spend: 21.5, total_conversions: 2, video_end: 700, tv_imps: 900 }, { impressions: 500, clicks: 1, spend: 10.25, total_conversions: 0, video_end: 300, tv_imps: 400 }] } }])
    const t = await gt.fetchGroundtruthCampaignTotals((await gtConn()).conn, "9001", "2026-10-01T00:00:00Z", { transport: rec.t, now: new Date("2026-11-01T00:00:00Z") })
    check("GroundTruth totals: rows summed (impressions, clicks, spend, conversions, completions, TV impressions)", t.impressions === 1500 && t.clicks === 4 && t.spend === 31.75 && t.conversions === 2 && t.videoCompletions === 1000 && t.tvImpressions === 1300, JSON.stringify(t))
    const s = await gt.readGroundtruthCampaignStatus((await gtConn()).conn, "9001", { transport: recorder([{ match: (r) => r.path === "/users/current", res: { data: { tenant_id: 77 } } }, { match: (r) => r.path === "/campaigns/9001", res: { data: { status: 2 } } }]).t })
    check("GroundTruth status readback maps the documented enum (2 = paused)", s.ok && s.status === "paused")
  }

  // StackAdapt
  const saConn = async () => ({ status: "connected" as const, conn: { apiKey: "sa-token-xxxxxx", accountId: "adv-1", config: {}, brokerageId: B1 } })
  const saAnswers = (over: Partial<Record<string, Partial<GatewayResponse>>> = {}) => recorder([
    { match: (r) => gqlOp(r) === "VipAccount", res: over.VipAccount ?? { data: { data: { tokenInfo: { name: "t" }, advertiser: { id: "adv-1", isArchived: false } } } } },
    { match: (r) => gqlOp(r) === "VipGeo", res: over.VipGeo ?? { data: { data: { geos: { nodes: [{ id: "geo-dma-539", administrativeLevel: "DMA_REGION" }] } } } } },
    { match: (r) => gqlOp(r) === "VipGroup", res: over.VipGroup ?? { data: { data: { createCampaignGroup: { campaignGroup: { id: "grp-1" }, userErrors: [] } } } } },
    { match: (r) => gqlOp(r) === "VipUpload", res: over.VipUpload ?? { data: { data: { createUploadTargets: { targets: [{ url: "https://upload.example/s3", resourceUrl: "s3://bucket/tv-master.mp4", parameters: [{ name: "key", value: "k" }] }], userErrors: [] } } } } },
    { match: (r) => r.url === MASTER, res: { data: Buffer.from([1, 2, 3]) } },
    { match: (r) => r.url === "https://upload.example/s3", res: { data: "" } },
    { match: (r) => gqlOp(r) === "VipCreative", res: over.VipCreative ?? { data: { data: { createCreatives: { creatives: [{ id: "cr-1" }], userErrors: [] } } } } },
    { match: (r) => gqlOp(r) === "VipCtv", res: over.VipCtv ?? { data: { data: { upsertCampaign: { campaign: { id: "sa-c-1", isDraft: false, campaignStatus: { state: "PENDING", status: "CREATIVES_PENDING" } }, userErrors: [] } } } } },
  ])
  {
    const rec = saAnswers()
    const r = await sa.launchStackadaptCampaign(CAMP, { transport: rec.t, client: memSupabase({ ad_campaigns: [stagedRow("stackadapt")] }) as never, resolve: saConn, now: new Date("2026-11-01T00:00:00Z") })
    const seq = rec.calls.map((c) => gqlOp(c) || (c.url === MASTER ? "GET master" : c.url ? "POST upload" : "?"))
    check("StackAdapt: submitted, reported in StackAdapt's own state (PENDING review), never as 'live'", r.dispatched && r.stackadaptCampaignId === "sa-c-1" && r.providerState === "PENDING" && /reviewing/.test(r.reason), JSON.stringify(r))
    check("StackAdapt: the documented chain in order — account → geo → campaign group → upload target → master bytes → presigned upload → creative → CTV campaign", JSON.stringify(seq) === JSON.stringify(["VipAccount", "VipGeo", "VipGroup", "VipUpload", "GET master", "POST upload", "VipCreative", "VipCtv"]), seq.join(" | "))
    const ctv = ((rec.calls.find((c) => gqlOp(c) === "VipCtv")!.body as { variables: { input: Record<string, any> } }).variables.input)
    check("StackAdapt: the CTV campaign is NOT a draft, carries the uploaded creative, a CPM flight and a documented subtype", ctv.isDraft === false && ctv.ads?.[0]?.creative?.creativeId === "cr-1" && ctv.flights?.[0]?.bidType === "CPM" && ctv.flights?.[0]?.bidAmount === 32 && ctv.subtype === "DEFAULT")
    check("StackAdapt: geography only — location ids + global ZIPs; no audience / demographic / interest segments", Array.isArray(ctv.geo?.locationIds) && ctv.geo?.globalZipTargeting?.[0]?.zipCodes?.[0] === "33602" && !("audience" in ctv) && !JSON.stringify(ctv).includes("demographicSegmentIds"))
    check("StackAdapt: every GraphQL call is a Bearer POST to /graphql through the gateway with the tenant", rec.calls.filter((c) => !c.url).every((c) => c.path === "/graphql" && c.method === "POST" && (c.auth as { style?: string }).style === "bearer" && c.brokerageId === B1))
  }
  {
    const rec = saAnswers({ VipCtv: { data: { data: { upsertCampaign: { campaign: null, userErrors: [{ message: "Flight budget below minimum", path: ["input", "flights", "0"] }] } } } } })
    const r = await sa.launchStackadaptCampaign(CAMP, { transport: rec.t, client: memSupabase({ ad_campaigns: [stagedRow("stackadapt")] }) as never, resolve: saConn })
    check("StackAdapt: a mutation's userErrors are READ and returned (never a fabricated ok)", !r.dispatched && /Flight budget below minimum/.test(r.reason), r.reason)
    const rec2 = saAnswers({ VipAccount: { ok: false, status: 401, errorBody: { errors: [{ message: "Unauthorized" }] } } })
    const r2 = await sa.launchStackadaptCampaign(CAMP, { transport: rec2.t, client: memSupabase({ ad_campaigns: [stagedRow("stackadapt")] }) as never, resolve: saConn })
    check("StackAdapt: a transport-level GraphQL error is read; nothing after the account check runs", !r2.dispatched && /Unauthorized/.test(r2.reason) && rec2.calls.length === 1)
    const rec3 = saAnswers({ VipCtv: { data: { data: { upsertCampaign: { campaign: { id: "sa-c-2", isDraft: true, campaignStatus: { state: "DRAFT" } }, userErrors: [] } } } } })
    const r3 = await sa.launchStackadaptCampaign(CAMP, { transport: rec3.t, client: memSupabase({ ad_campaigns: [stagedRow("stackadapt")] }) as never, resolve: saConn })
    check("StackAdapt: a campaign StackAdapt kept as a DRAFT is not 'dispatched'", !r3.dispatched && /DRAFT/.test(r3.reason))
    const rec4 = recorder([])
    const r4 = await sa.launchStackadaptCampaign(CAMP, { transport: rec4.t, client: memSupabase({ ad_campaigns: [stagedRow("stackadapt", { creative_source: "video_url" })] }) as never, resolve: saConn })
    check("StackAdapt refuses the social reel BEFORE any call", !r4.dispatched && rec4.calls.length === 0)
  }
  {
    const prog = await sa.fetchStackadaptCampaignDelivery((await saConn()).conn, "sa-c-1", "2026-10-01T00:00:00Z", { transport: recorder([{ match: () => true, res: { data: { data: { campaignDelivery: { __typename: "Progress" } } } } }]).t })
    check("StackAdapt delivery: an async Progress answer is PENDING (asked again next pass), never zeros", prog.pending === true)
    const done = await sa.fetchStackadaptCampaignDelivery((await saConn()).conn, "sa-c-1", "2026-10-01T00:00:00Z", { transport: recorder([{ match: () => true, res: { data: { data: { campaignDelivery: { __typename: "CampaignDeliveryOutcome", totalStats: { impressionsBigint: "1200", clicksBigint: "4", cost: 18.4, conversionsBigint: "1", conversionRevenue: 0, videoCompletionsBigint: "900" } } } } } }]).t })
    check("StackAdapt delivery: totals mapped from the documented BigInt metrics", !done.pending && done.totals.impressions === 1200 && done.totals.clicks === 4 && done.totals.spend === 18.4 && done.totals.videoCompletions === 900)
    const crmRec = recorder([{ match: () => true, res: { data: { data: { createCrmSegmentWithPii: { customSegment: { id: "seg-1" }, userErrors: [] } } } } }])
    const crm = await sa.pushStackadaptCrmSegment((await saConn()).conn, { name: "Re-engage", externalSegmentId: null, members: [{ email_sha256: "a".repeat(64), phone_sha256: "b".repeat(64) }, { phone_sha256: "c".repeat(64) }] }, { transport: crmRec.t })
    const vars = (crmRec.calls[0].body as { variables: { input: Record<string, unknown> } }).variables.input
    check("StackAdapt CRM segment: SHA_256 hashed e-mails ONLY (no phone hash, never raw PII); a phone-only member is rejected, counted", crm.ok && crm.externalAudienceId === "seg-1" && crm.recordsSynced === 1 && crm.recordsRejected === 1 && vars.hashAlgo === "SHA_256" && JSON.stringify(vars.hashedCrmData) === JSON.stringify(["a".repeat(64)]) && !("rawCrmData" in vars))
  }
  {
    const gtc = getConnector("groundtruth")!, sac = getConnector("stackadapt")!
    const nt = await gtc.publishCampaign({ structure: { campaign_id: CAMP }, cred: { accessToken: "x", accountId: null, config: {}, brokerageId: null } })
    const nt2 = await sac.publishCampaign({ structure: { campaign_id: CAMP }, cred: { accessToken: "x", accountId: null, config: {}, brokerageId: null } })
    check("both connectors refuse to publish when the credential names no tenant (the TV gate cannot run)", !nt.ok && /names no tenant/.test(nt.error ?? "") && !nt2.ok && /names no tenant/.test(nt2.error ?? ""))
    const aud = await gtc.pushCustomAudience({ audienceName: "x", externalAudienceId: null, members: [], cred: { accessToken: "x", accountId: null, config: {}, brokerageId: B1 } })
    check("GroundTruth's connector REFUSES an audience upload (none published) rather than fake ok", !aud.ok && /no first-party audience upload/.test(aud.error ?? ""))
    for (const f of ["lib/ads/connectors/groundtruth.ts", "lib/ads/connectors/stackadapt.ts"]) {
      const src = code(f)
      check(`${f}: publish runs the ONE TV gate (ensureCtvBroadcastReady) BEFORE the provider launch; spells no vendor HTTP`, src.indexOf("ensureCtvBroadcastReady(") > 0 && src.indexOf("ensureCtvBroadcastReady(") < src.search(/launch(Groundtruth|Stackadapt)Campaign\(/) && !/https?:\/\/|fetch\(/.test(src))
    }
  }
  {
    // Fair housing census over the two provider files: no protected-class targeting KEY is ever written (stripped, strings blanked).
    const banned = /\b(genders|age_ranges|income_ranges|demographicSegmentIds|interestSegmentIds|customSegmentIds)\s*:/
    for (const f of ["lib/providers/groundtruth-ads.ts", "lib/providers/stackadapt-ads.ts"]) check(`${f}: no demographic / audience targeting key is sent (fair housing)`, !banned.test(codeNoStrings(f)))
    check("POSITIVE CONTROL: the census sees a planted `genders: [\"M\"]`", banned.test(blankStrings(`const g = { genders: ["M"] }`)))
    check("ONE TV subsystem holds: neither adapter defines a dispatch…Ctv / …Tv function, nor names the Vibe dispatch or host", ["lib/providers/groundtruth-ads.ts", "lib/providers/stackadapt-ads.ts", "lib/ads/connectors/groundtruth.ts", "lib/ads/connectors/stackadapt.ts"].every((f) => !/export\s+async\s+function\s+dispatch\w*(Ctv|CTV|StreamingTv|Tv)\w*\s*\(/.test(code(f)) && !/dispatchCtvCampaign|api\.vibe\.co/.test(raw(f))))
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  section("D · contract C5 — approverFor: the tenant approves its own; the brokerage only when required")
  const aa = await import("../lib/kernel/approval-authority")
  const seed = (over: Record<string, any[]> = {}) => memSupabase({
    agents: [{ id: A_OWNER, user_id: U_OWNER, brokerage_id: B1, is_active: true }, { id: A_OTHER, user_id: U_OTHER, brokerage_id: B1, is_active: true }],
    users: [{ id: U_OWNER, brokerage_id: B1, user_type: "agent" }, { id: U_OTHER, brokerage_id: B1, user_type: "agent" }, { id: U_LEAD, brokerage_id: B1, user_type: "agent" }, { id: U_ADMIN, brokerage_id: B1, user_type: "broker" }],
    user_role_assignments: [],
    team_members: [{ id: "tm1", agent_id: A_OWNER, team_id: TEAM, brokerage_id: B1, is_active: true }],
    teams: [{ id: TEAM, brokerage_id: B1, team_lead_id: U_LEAD, deleted_at: null }],
    brokerage_settings: [{ brokerage_id: B1, settings: {} }],
    ...over,
  })
  {
    const d = await aa.approverFor({ brokerageId: B1, assetKind: "social_post", scope: { agentId: A_OWNER }, client: seed() as never })
    check("an agent's own asset: the AGENT approves (primary); team lead + brokerage may approve as oversight; brokerage not required", d.ok && d.tier === "owner_agent" && JSON.stringify(d.primaryUserIds) === JSON.stringify([U_OWNER]) && [U_OWNER, U_LEAD, U_ADMIN].every((u) => d.permittedUserIds.includes(u)) && !d.permittedUserIds.includes(U_OTHER) && !d.brokerageApprovalRequired, JSON.stringify(d))
    const t = await aa.approverFor({ brokerageId: B1, assetKind: "ad_creative", scope: { teamId: TEAM }, client: seed() as never })
    check("a team's asset: the TEAM LEAD approves; the brokerage may as oversight; another agent may not", t.ok && t.tier === "team_lead" && t.primaryUserIds[0] === U_LEAD && t.permittedUserIds.includes(U_ADMIN) && !t.permittedUserIds.includes(U_OWNER))
    const b = await aa.approverFor({ brokerageId: B1, assetKind: "ad_campaign", scope: {}, client: seed() as never })
    check("a brokerage asset: the broker / admin roster approves", b.ok && b.tier === "tenant_admin" && JSON.stringify(b.permittedUserIds) === JSON.stringify([U_ADMIN]))
    const pol = await aa.approverFor({ brokerageId: B1, assetKind: "social_post", scope: { agentId: A_OWNER }, client: seed({ brokerage_settings: [{ brokerage_id: B1, settings: { publication_approval: { require_brokerage_approval: { social_post: { basis: "legal_requirement", source: "state advertising rule (attested)" } } } } }] }) as never })
    check("a RECORDED legal requirement makes the brokerage the required approver — and the owner is then NOT permitted (positive control)", pol.ok && pol.brokerageApprovalRequired && pol.basis === "legal_requirement" && pol.policyRef === "publication_approval.social_post" && !pol.permittedUserIds.includes(U_OWNER) && pol.permittedUserIds.includes(U_ADMIN))
    const other = await aa.approverFor({ brokerageId: B1, assetKind: "video", scope: { agentId: A_OWNER }, client: seed({ brokerage_settings: [{ brokerage_id: B1, settings: { publication_approval: { require_brokerage_approval: { social_post: { basis: "brokerage_policy" } } } } }] }) as never })
    check("…the requirement is per asset kind: a policy for social posts does not take an agent's video away from them", other.ok && !other.brokerageApprovalRequired && other.tier === "owner_agent")
    const unread = await aa.approverFor({ brokerageId: B1, assetKind: "social_post", scope: { agentId: A_OWNER }, client: memSupabase({ ...Object.fromEntries(Object.entries((seed() as MemClient).tables)) }, { refuse: { brokerage_settings: "permission denied" } }) as never })
    check("an UNREADABLE policy fails closed — the brokerage approves until it can be read (stricter, said)", unread.ok && unread.brokerageApprovalRequired && unread.basis === "policy_unreadable")
    const refused = await aa.approverFor({ brokerageId: B1, assetKind: "social_post", scope: { agentId: A_OWNER }, client: memSupabase((seed() as MemClient).tables, { refuse: { agents: "permission denied" } }) as never })
    check("a refused read of the owner refuses the decision (never 'nobody needs to approve')", !refused.ok && /could not be read/.test(refused.reason))
    const foreign = await aa.approverFor({ brokerageId: B2, assetKind: "social_post", scope: { agentId: A_OWNER }, client: seed() as never })
    check("an owner from another tenant is refused (tenant-pinned reads)", !foreign.ok && /not in this brokerage/.test(foreign.reason))
    const solo = await aa.approverFor({ brokerageId: B2, assetKind: "ad_campaign", scope: {}, client: memSupabase({ users: [], user_role_assignments: [], brokerage_settings: [], agents: [{ id: "a-solo", user_id: "u-solo", brokerage_id: B2, is_active: true }], team_members: [], teams: [] }) as never })
    check("a SOLO tenant with no roster: its one agent is the principal who approves", solo.ok && solo.tier === "tenant_principal" && solo.primaryUserIds[0] === "u-solo")
    const unknownKind = await aa.approverFor({ brokerageId: B1, assetKind: "billboard" as never, scope: {}, client: seed() as never })
    check("an unknown asset kind is refused (one vocabulary)", !unknownKind.ok)
  }
  {
    const db = seed({ social_posts: [{ id: "post-1", brokerage_id: B1, agent_id: A_OWNER, user_id: U_OWNER }], ad_campaigns: [{ id: CAMP, brokerage_id: B1, agent_user_id: U_OWNER, team_id: null, visibility_scope: "agent" }], ad_creative_variations: [{ id: "cr-1", brokerage_id: B1, ad_campaign_id: CAMP }] })
    const ok = await aa.requirePublishApprover({ brokerageId: B1, assetKind: "social_post", assetTable: "social_posts", assetId: "post-1", approverUserId: U_OWNER, client: db as never })
    const no = await aa.requirePublishApprover({ brokerageId: B1, assetKind: "social_post", assetTable: "social_posts", assetId: "post-1", approverUserId: U_OTHER, client: db as never })
    const cre = await aa.requirePublishApprover({ brokerageId: B1, assetKind: "ad_creative", assetTable: "ad_creative_variations", assetId: "cr-1", approverUserId: U_LEAD, client: db as never })
    const creNo = await aa.requirePublishApprover({ brokerageId: B1, assetKind: "ad_creative", assetTable: "ad_creative_variations", assetId: "cr-1", approverUserId: U_OTHER, client: db as never })
    check("the door check: the post's owner may approve; ANOTHER agent of the same brokerage may not", ok.ok && !no.ok && /not an approver/.test((no as { reason: string }).reason))
    check("an ad creative inherits its campaign's scope: the owner's team lead may approve, another agent may not", cre.ok && !creNo.ok)
    const unknownTable = await aa.requirePublishApprover({ brokerageId: B1, assetKind: "asset", assetTable: "mystery_table", assetId: "x", approverUserId: U_ADMIN, client: db as never })
    check("an asset table with no declared scope is refused, never guessed", !unknownTable.ok && /no approval scope/.test(unknownTable.reason))
  }
  {
    const doors: Array<[string, string, RegExp]> = [
      ["app/actions/social-media-automation.ts", "export async function approveSocialPost", /approval_status:\s*"approved"/],
      ["lib/ads/ad-creator.ts", "export async function approveCreativeVariation", /\.update\(\{\s*approval_status:\s*"approved"\s*\}\)/],
      ["lib/kernel/approval-queue-aggregator.ts", "case \"acv\"", /\.from\("ad_creative_variations"\)\s*\.update/],
      ["lib/kernel/approval-sources.ts", "export async function approveContentSource", /src\.approve\(ctx\.userId\)/],
      ["lib/ads/facebook-audience-sync.ts", "export async function approveAudience", /status:\s*"approved",\s*updated_at/],
    ]
    for (const [f, start, write] of doors) {
      const src = code(f)
      const body = src.slice(src.indexOf(start))
      const gate = body.indexOf("requirePublishApprover(")
      const w = body.search(write)
      check(`C5 door ${f} (${start.replace(/export async function |case /, "")}): requirePublishApprover runs BEFORE the approval write`, gate > 0 && w > gate, `gate@${gate} write@${w}`)
    }
    check("POSITIVE CONTROL: the order finder flags a door whose write precedes the gate", (() => { const s = `approval_status: "approved" … requirePublishApprover(`; return !(s.indexOf("requirePublishApprover(") < s.search(/approval_status:\s*"approved"/)) })())
  }
  {
    // The REQUEST side of the social door (lane 146H Outside-lane 3): whether a new post needs someone else's approval is
    // the authority answer's, never a client flag's.
    const src = code("app/actions/social-media-automation.ts")
    const at = src.indexOf("export async function scheduleSocialPost")
    const body = src.slice(at, src.indexOf("export async function", at + 10))
    const decide = body.indexOf("approverFor(")
    const insert = body.search(/\.from\("social_posts"\)\s*\.insert/)
    check("C5 request side: scheduleSocialPost asks approverFor BEFORE it inserts the post", at >= 0 && decide > 0 && insert > decide, `approverFor@${decide} insert@${insert}`)
    check("…and the client flag can only TIGHTEN: self-approval needs the scheduler in permittedUserIds AND no review asked", /permittedUserIds\.includes\(userId\)\s*&&\s*params\.requiresBrokerApproval\s*!==\s*true/.test(body))
    check("…and no status / approval_status write reads the client flag directly", !/(?:approval_status|initialStatus)\s*[:=]\s*params\.requiresBrokerApproval/.test(body))
    check("…and a self-approval is RECORDED (approved_by / approved_at)", /approved_by:\s*userId,\s*approved_at/.test(body))
    check("…and the ask goes to the people approverFor names, not a hard-coded broker/admin list", /approver\.primaryUserIds/.test(body) && !/\.in\("user_type",\s*\["broker",\s*"admin"\]\)/.test(body))
    check("POSITIVE CONTROL: the loosen-finder sees the old shape", /(?:approval_status|initialStatus)\s*[:=]\s*params\.requiresBrokerApproval/.test(`const initialStatus = params.requiresBrokerApproval ? "draft" : "scheduled"`))
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  section("E · contract C2 — requestAudienceReengagement (recommend, never upload; approve, then sync)")
  const re = await import("../lib/ads/audience-reengagement")
  const rules = await import("../lib/ads/audience-source-rules")
  const contact = (id: string, over: Record<string, unknown> = {}) => ({ id, brokerage_id: B1, agent_id: A_OWNER, email: `${id.slice(0, 4)}@ex.com`, phone: null, tcpa_consent: true, nurture_status: "active", dnc_status: null, email_opt_out: false, email_unsubscribed: false, sms_opt_out: false, sms_unsubscribed: false, phone_opt_out: false, opt_out_channels: [], ...over })
  const reDb = () => seed({
    contacts: [contact(C1), contact(C2), contact(C3, { tcpa_consent: false }), contact(C4, { nurture_status: "withdrawn" })],
    leads: [{ id: L1, brokerage_id: B1, contact_id: C2 }, { id: L2, brokerage_id: B1, contact_id: null }],
    facebook_custom_audiences: [], approval_items: [], notifications: [],
  })
  const deps = { entitled: async () => ({ allowed: true }), connected: async () => true, ledger: false as const }
  {
    const db = reDb()
    const r = await re.requestAudienceReengagement({ brokerageId: B1, partyIds: [C1, { kind: "lead", id: L1 }, C3, C4, { kind: "lead", id: L2 }, { kind: "platform_prospect", id: "pp-1" }, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"], basis: "inbound_ad_response", creativeHint: "open-house invite", client: db as never, deps })
    check("C2: admits only identity-matched, consented contacts (a converted lead resolves to its contact); every other party is refused WITH its reason", r.ok && r.admitted === 2 && r.refused.length === 5, JSON.stringify(r))
    const reasons = r.ok ? r.refused.map((x) => x.reason).join(" | ") : ""
    check("C2: the refusals name no-consent, withdrawn, lead-without-contact, platform prospect and foreign contact", /consent floor/.test(reasons) && /withdrawn/.test(reasons) && /contact-only rule/.test(reasons) && /platform prospect/.test(reasons) && /not a contact of this brokerage/.test(reasons))
    const aud = (db as MemClient).tables.facebook_custom_audiences ?? []
    const item = (db as MemClient).tables.approval_items ?? []
    const bell = (db as MemClient).tables.notifications ?? []
    check("C2: ONE draft audience (pending_review, reengagement_parties rule naming exactly the admitted ids) — nothing uploaded", aud.length === 1 && aud[0].status === "pending_review" && aud[0].source_rule.type === "reengagement_parties" && JSON.stringify(aud[0].source_rule.filters.contact_ids) === JSON.stringify([C1, C2].sort()) && !(db as MemClient).writes.some((w) => w.table === "audience_sync_runs"))
    check("C2: ONE pending approval request + the approver (the contacts' agent, C5) is told", item.length === 1 && item[0].status === "pending" && item[0].item_type === re.AUDIENCE_REENGAGEMENT_ITEM_TYPE && bell.length === 1 && bell[0].user_id === U_OWNER && r.ok && r.approverUserIds[0] === U_OWNER)
    const again = await re.requestAudienceReengagement({ brokerageId: B1, partyIds: [C2, C1], basis: "inbound_ad_response", client: db as never, deps })
    check("C2: idempotent — the same basis + party set returns the OPEN request, never a second audience", again.ok && again.reused && ((db as MemClient).tables.facebook_custom_audiences ?? []).length === 1)

    const audienceId = aud[0].id as string
    const pend = await re.reengagementApprovalGate(db as never, { brokerageId: B1, audienceId })
    check("upload door: PENDING request → refused", !pend.ok && /awaiting a person's approval/.test(pend.reason))
    item[0].status = "approved"; item[0].reviewed_by = U_OTHER; item[0].reviewed_at = "2026-11-01T00:00:00Z"
    const wrong = await re.reengagementApprovalGate(db as never, { brokerageId: B1, audienceId })
    check("upload door: approved by someone who may NOT approve this audience → refused (C5)", !wrong.ok && /may not approve/.test(wrong.reason))
    item[0].reviewed_by = U_OWNER
    const right = await re.reengagementApprovalGate(db as never, { brokerageId: B1, audienceId })
    check("upload door: approved by the owner → passes", right.ok && right.approvedBy === U_OWNER)
    item[0].status = "rejected"
    const rej = await re.reengagementApprovalGate(db as never, { brokerageId: B1, audienceId })
    check("upload door: a later rejection revokes it", !rej.ok && /rejected/.test(rej.reason))
  }
  {
    const bad = await re.requestAudienceReengagement({ brokerageId: B1, partyIds: [C1], basis: "seniors_55_plus" as never, client: reDb() as never, deps })
    check("C2: a basis outside the WHY vocabulary is refused (an audience is never chosen by a characteristic)", !bad.ok && /not a re-engagement WHY/.test(bad.reason))
    const none = await re.requestAudienceReengagement({ brokerageId: B1, partyIds: [], basis: "portal_activity", client: reDb() as never, deps })
    check("C2: no parties → refused ('never everyone')", !none.ok && /never 'everyone'/.test(none.reason))
    const nc = await re.requestAudienceReengagement({ brokerageId: B1, partyIds: [C1], basis: "portal_activity", client: reDb() as never, deps: { ...deps, connected: async () => false } })
    check("C2: no permitted ad account → refused before anything is written", !nc.ok && /not connected/.test(nc.reason))
    const ne = await re.requestAudienceReengagement({ brokerageId: B1, partyIds: [C1], basis: "portal_activity", client: reDb() as never, deps: { ...deps, entitled: async () => ({ allowed: false, reason: "past_due_not_served" }) } })
    check("C2: not entitled → refused (fail closed)", !ne.ok && /may not use ads/.test(ne.reason))
    const gtPlat = await re.requestAudienceReengagement({ brokerageId: B1, partyIds: [C1], basis: "portal_activity", platform: "groundtruth" as never, client: reDb() as never, deps })
    check("C2: a platform with no audience upload (GroundTruth) is refused", !gtPlat.ok && /does not upload a hashed CRM audience/.test(gtPlat.reason))
    const { assertAudienceSegmentationAllowed } = await import("../lib/lead-governance/protected-class-signals")
    let threw = false
    try { assertAudienceSegmentationAllowed({ type: "reengagement_parties", filters: { contact_ids: [C1], age_min: 55 } }, "control") } catch { threw = true }
    check("POSITIVE CONTROL: the ONE fair-housing refusal the request runs still refuses a rule carrying a protected-class key", threw)
  }
  {
    const n = rules.resolveSourceRuleNarrowing({ type: "reengagement_parties", filters: { contact_ids: [C1, C2] } })
    const empty = rules.resolveSourceRuleNarrowing({ type: "reengagement_parties", filters: { contact_ids: [] } })
    const junk = rules.resolveSourceRuleNarrowing({ type: "reengagement_parties", filters: { contact_ids: ["not-a-uuid"] } })
    check("source rule reengagement_parties narrows to EXACTLY the named ids (id IN …)", n.ok && n.predicates.length === 1 && n.predicates[0].column === "id" && n.predicates[0].op === "in" && JSON.stringify(n.predicates[0].value) === JSON.stringify([C1, C2]) && n.uploadsContacts)
    check("…and REFUSES an empty or malformed list (positive control: 'no ids' is never 'everyone')", !empty.ok && !junk.ok)
    const ads = code("lib/kernel/ads.ts")
    const sync = ads.slice(ads.indexOf("export async function syncAudience"))
    check("syncAudience runs the re-engagement approval gate BEFORE it resolves (reads) a single contact", sync.indexOf("reengagementApprovalGate(") > 0 && sync.indexOf("reengagementApprovalGate(") < sync.indexOf("resolveAudiencePopulation({"))
    const src = code("lib/ads/audience-reengagement.ts")
    check("the production path is LEDGERED (withActionLedger) and never calls an upload / launch itself", /withActionLedger</.test(src) && !/syncAudience\(|pushCustomAudience\(|publishCampaign\(/.test(src))
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  section("F · launch routing + two-way status — the ONE TV router, provider word before the flip")
  {
    const ctv = code("lib/ads/ctv-campaign.ts")
    const router = ctv.slice(ctv.indexOf("export async function launchTvCampaign"), ctv.indexOf("export const CTV_AUTO_DAILY_BUDGET_USD"))
    check("launchTvCampaign: Vibe keeps its own path; the other two publish through the registry BEFORE the row flips live (counted)", /launchCtvCampaignOnVibe\(/.test(router) && router.indexOf("publishCampaign(") > 0 && router.indexOf("publishCampaign(") < router.indexOf('status: "live"') && /\.select\("id"\)/.test(router))
    const gate = ctv.slice(ctv.indexOf("export async function ensureCtvBroadcastReady"), ctv.indexOf("export async function launchTvCampaign"))
    check("the ONE broadcast gate admits exactly the TV connections (not any platform)", /isCtvTvPlatform\(campaign\.platform\)/.test(gate))
    const mgr = code("lib/ads/ad-manager.ts")
    check("Ads Manager: proposes staged GroundTruth / StackAdapt drafts (connected, TV master present) and executes them through launchTvCampaign under the spend cap", /TV_CONNECTION_PLATFORMS\.has\(c\.platform\)/.test(mgr) && /launchTvCampaign\(\{ campaignId, brokerageId, actorUserId: null, launchedVia: "ads_manager"/.test(mgr) && /TV_CONNECTION_PLATFORMS[\s\S]{0,400}MAX_AD_DAILY_BUDGET_USD/.test(mgr.slice(mgr.indexOf("case \"launch_ad_campaign\""))))
    const ing = code("lib/ads/ad-performance-ingest.ts")
    check("performance ingest asks a connector's own status (fetchStatus) and RECORDS it (provider_status), never maps it silently", /connector\.fetchStatus\(/.test(ing) && /provider_status/.test(ing) && !/status:\s*st\.state/.test(ing))
    const launchCase = mgr.slice(mgr.indexOf("case \"launch_ad_campaign\""), mgr.indexOf("case \"pause_ad_campaign\""))
    check("the APPROVED VERSION publishes (Meta / Google): every approved creative passes checkDistributionPublication BEFORE the 'launching' flip", launchCase.indexOf("checkDistributionPublication(") > 0 && launchCase.indexOf("checkDistributionPublication(") < launchCase.indexOf('status: "launching"'))
    const asm = code("lib/ads/launch-assembler.ts")
    const pub = asm.slice(asm.indexOf("export async function publishLaunchingCampaigns"))
    check("…and the version that went out is RECORDED after the provider accepted (recordDoorPublication after the live stamp)", pub.indexOf('status: "live"') > 0 && pub.indexOf("recordDoorPublication(") > pub.indexOf('status: "live"'))
    const act = code("app/actions/ctv-ads.ts")
    check("the action door takes the TV connection + bid from its input and the tenant from the session only", /tvPlatform: input\.tvPlatform/.test(act) && /bidCpmUsd: input\.bidCpmUsd/.test(act) && /brokerageId:\s*actor\.brokerageId/.test(act))
  }

  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log("FAILURES:"); for (const f of failures) console.log("  - " + f); console.log(" ❌ ADS_TV_CONNECTIONS_FAIL"); process.exit(1) }
  console.log(" ✅ ADS_TV_CONNECTIONS_PASS — GroundTruth + StackAdapt are TV connections on the one ad fabric (declared from their docs, gated by the one TV gate, credentials WAITING_EXTERNAL); every publish door asks the C5 approver; 1:1 re-engagement (C2) recommends, a permitted person approves, the upload door re-checks")
}

main().catch((e) => { console.error(e); process.exit(1) })
