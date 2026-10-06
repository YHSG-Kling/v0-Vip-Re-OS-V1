#!/usr/bin/env tsx
/**
 * scripts/media-intelligence-guard.ts  (npm run test:media-intelligence) — wave 106, lane 106C.
 *
 * Proves THE ASSET MANAGER AS A MEDIA INTELLIGENCE SYSTEM (lib/kernel/media-intelligence.ts over the
 * survivors — marketing_assets + m719, the Director, the image rail, ai_tool_usage, the action ledger,
 * improvement_proposals, the ads experiment gate):
 *   S   "existing media is sufficient" avoids spend WITH EVIDENCE (no generator call, a ledger row carrying
 *       the cost avoided); the insufficient control produces;
 *   L   a lineage chain of 5 (photo → video → social cut → email thumbnail → seller campaign) walks to its
 *       root; self-lineage and a foreign source are refused;
 *   V   variants ≤ 4 through the EXISTING generators (n = 9 → 4), each recorded with lineage + rights +
 *       cost booked on ai_tool_usage; one ledgered production, replayed on a second ask;
 *   P   performance learning → the media-kind improvement proposal with the owner's statement; thin data
 *       proposes nothing;
 *   R   rights required — an external asset without licence + provenance is refused, with them recorded;
 *   T   tenant isolation — foreign reads absent, foreign sources refused, foreign learning not found;
 *   A   agents see no cost;
 *   B   brand policy at produce time — a fair-housing subject / no brokerage attribution refuse;
 *   D   honest degrade until m719 is applied (owner shape on metadata.media, result says so);
 *   W   wiring + registration, read from STRIPPED source, each with a positive control; vocabularies derived.
 * In-memory client only, no DB, no model calls, no network.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import {
  MAX_MEDIA_VARIANTS, MEDIA_PURPOSES, GENERATABLE_ASSET_TYPES, GENERATION_COST_ESTIMATE_USD,
  rightsVerdict, brandPolicyVerdict, sufficiencyVerdict, foldPerformance, mediaKindVerdict, redactForAudience, needKey,
  readMediaAssets, recordMediaAsset, recordAssetLineage, lineageChain, findSufficientAsset, produceVariants, learnFromPerformance,
  fulfilCreativeNeed, requestCreative, type MediaNeed, type MediaDeps, type MediaAssetRecord,
} from "../lib/kernel/media-intelligence"
import { PROPOSERS } from "../lib/kernel/improvement-proposals"
import { hasFairHousingViolation } from "../lib/compliance/client-text-guard"
import { MAINTENANCE_DOMAINS, MANAGERS } from "../lib/kernel/manager-registry"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = process.cwd()
const src = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))

const B = "11111111-1111-4111-8111-111111111111"
const OTHER = "99999999-9999-4999-8999-999999999999"
const AGENT_USER = "aaaaaaaa-0000-4000-8000-000000000001"
const NOW = new Date("2026-10-06T12:00:00.000Z")
const BRAND = { brokerage_name: "Kling Group Realty", primary_color: "#1a3c6e", logo_url: "https://cdn.example/logo.png" }

function seed(extra: Record<string, any[]> = {}) {
  return memSupabase({ marketing_assets: [], ai_tool_usage: [], agent_action_ledger: [], tenant_policy_versions: [], improvement_proposals: [], lifecycle_events: [], users: [], agents: [], ...extra }, { stampCreatedAt: true })
}

/** Counting generator stubs — THE seams production never passes. */
function stubs(counter: { image: number; video: number; afford: number }): MediaDeps {
  return {
    now: () => NOW,
    afford: async () => { counter.afford++; return { allowed: true, reason: "ok" } },
    brand: async () => ({ brand: BRAND, prohibited: ["guaranteed sale"] }),
    fairHousing: hasFairHousingViolation,
    generateImage: async ({ angle }) => { counter.image++; return { ok: true, assetUrl: `https://cdn.example/${angle}-${counter.image}.png`, costUsd: 0.04, generationModel: "gpt-image-1" } },
    commissionVideo: async (_svc, { angle }) => { counter.video++; return { ok: true, staged: true, sourceTable: "ai_video_projects", sourceId: `vp-${angle}-${counter.video}`, generationModel: "video_director:AgentExplainerReel" } },
  }
}

const need = (over: Partial<MediaNeed> = {}): MediaNeed => ({
  brokerageId: B, subject: "123 Main St Austin seller equity update", purpose: "seller_equity", assetType: "image", audience: "seller",
  agentUserId: AGENT_USER, brand: BRAND, market: "Austin", now: NOW, ...over,
})

async function main() {
  console.log("\nmedia-intelligence-guard — wave 106C\n")

  // ── S: sufficiency avoids spend, with evidence ─────────────────────────────────────────
  console.log("S — existing media is sufficient")
  {
    const mem = seed()
    const c = { image: 0, video: 0, afford: 0 }
    const rec = await recordMediaAsset(mem, { brokerageId: B, assetType: "image", assetUrl: "https://cdn.example/equity.png", assetName: "equity", subject: "123 Main St Austin seller equity update", purpose: "seller_equity", audience: "seller", brand: BRAND, rights: { source: "generated" }, generationModel: "gpt-image-1", costUsd: 0.04 }, { now: NOW })
    check("S0 fixture asset recorded (generated, approved, cost booked)", rec.ok && rec.costBooked && mem.tables.ai_tool_usage.length === 1 && mem.tables.ai_tool_usage[0].cost_cents === 4 && mem.tables.ai_tool_usage[0].manager === "asset_manager", JSON.stringify(rec))
    const r = await fulfilCreativeNeed(mem, need(), stubs(c))
    check("S1 reused — no generator ran, cost avoided published", r.reused && c.image === 0 && c.video === 0 && r.costAvoidedUsd === GENERATION_COST_ESTIMATE_USD.image, JSON.stringify(r))
    const led = mem.tables.agent_action_ledger.filter((x) => x.action === "media.decision.reuse")
    check("S2 the decision is EVIDENCE: ledger media.decision.reuse, NO_ACTION_NEEDED, skipped, detail.cost_avoided_usd", led.length === 1 && led[0].reason_code === "NO_ACTION_NEEDED" && led[0].status === "skipped" && led[0].detail?.cost_avoided_usd === 0.04 && led[0].actor_manager_key === "asset_manager", JSON.stringify(led))
    const d = await findSufficientAsset(mem, need({ purpose: "market_update" }), stubs(c))
    check("S3 CONTROL: a different purpose is NOT sufficient and says why", !d.sufficient && d.considered[0]?.reasons.some((x) => /purpose/.test(x)), JSON.stringify(d.considered))
    const r2 = await fulfilCreativeNeed(mem, need({ purpose: "market_update", subject: "Austin October market update" }), stubs(c))
    check("S4 CONTROL: the insufficient need PRODUCES (generator ran ≤ 4 times) and nothing was reused", !r2.reused && c.image === MAX_MEDIA_VARIANTS && r2.assetIds.length === MAX_MEDIA_VARIANTS, JSON.stringify(r2))
    const expired = sufficiencyVerdict({ ...(await readMediaAssets(mem, B, { ids: [rec.ok ? rec.id : ""] }) as any).rows[0], expires_at: "2026-10-01T00:00:00.000Z" } as MediaAssetRecord, need(), NOW)
    check("S5 an expired asset is not sufficient (expiry checked)", !expired.sufficient && expired.reasons.some((x) => /expired/.test(x)))
    const perf = sufficiencyVerdict({ ...(await readMediaAssets(mem, B, { ids: [rec.ok ? rec.id : ""] }) as any).rows[0], performance: { impressions: 1000, clicks: 1, leads: 0 } } as MediaAssetRecord, need({ minScore: 0.01 }), NOW)
    check("S6 an under-performing asset is not sufficient (performance floor checked)", !perf.sufficient && perf.reasons.some((x) => /performance/.test(x)))
  }

  // ── L: lineage chain of 5 ──────────────────────────────────────────────────────────────
  console.log("L — creative lineage")
  {
    const mem = seed()
    const mk = async (assetType: string, name: string, purpose: any, sources: string[], rights: any = { source: "render" }, model: string | null = "remotion:ListingReel") => {
      const r = await recordMediaAsset(mem, { brokerageId: B, assetType, assetUrl: `https://cdn.example/${name}`, assetName: name, subject: "123 Main St", purpose, rights, generationModel: model, sourceAssetIds: sources, bookCost: false }, { now: NOW })
      if (!r.ok) throw new Error(r.error)
      return r.id
    }
    const photo = await mk("image", "photo.jpg", "listing_promo", [], { source: "tenant_upload" }, null)
    const video = await mk("video", "video.mp4", "listing_promo", [photo])
    const cut = await mk("video", "cut.mp4", "social", [video])
    const thumb = await mk("image", "thumb.png", "email_thumbnail", [cut], { source: "generated" }, "gpt-image-1")
    const campaign = await mk("graphic", "seller-campaign.png", "seller_equity", [thumb], { source: "generated" }, "gpt-image-1")
    const chain = await lineageChain(mem, B, campaign)
    check("L1 chain of 5 walks seller campaign → thumbnail → social cut → video → photo (root)", chain.ok && chain.chain.length === 5 && chain.chain.map((l) => l.depth).join(",") === "0,1,2,3,4" && chain.roots.length === 1 && chain.roots[0] === photo, JSON.stringify(chain))
    const row = (await readMediaAssets(mem, B, { ids: [campaign] }) as any).rows[0] as MediaAssetRecord
    check("L2 every derived asset names its sources on the row (source_assets)", row.source_assets.length === 1 && row.source_assets[0] === thumb)
    const extra = await recordAssetLineage(mem, { brokerageId: B, assetId: campaign, sourceAssetIds: [video] })
    check("L3 recordAssetLineage unions a new source, counted", extra.ok && extra.sourceAssets.length === 2 && extra.sourceAssets.includes(video))
    const self = await recordAssetLineage(mem, { brokerageId: B, assetId: campaign, sourceAssetIds: [campaign] })
    check("L4 an asset never names itself", !self.ok && /never names itself/.test(self.error))
    const memO = seed({ marketing_assets: [{ id: "f0000000-0000-4000-8000-000000000001", brokerage_id: OTHER, asset_type: "image", asset_url: "x", approval_status: "approved", metadata: {} }] })
    const ownB = await recordMediaAsset(memO, { brokerageId: B, assetType: "image", assetUrl: "https://cdn.example/b.png", assetName: "b", subject: "s", purpose: "brand", rights: { source: "generated" }, generationModel: "m", bookCost: false })
    const foreign = ownB.ok ? await recordAssetLineage(memO, { brokerageId: B, assetId: ownB.id, sourceAssetIds: ["f0000000-0000-4000-8000-000000000001"] }) : { ok: false, error: "fixture" }
    check("L5 a source of another tenant is REFUSED (lineage never crosses tenants)", !foreign.ok && /not this brokerage/.test((foreign as any).error), JSON.stringify(foreign))
  }

  // ── V: variants ≤ 4 through the existing generators ───────────────────────────────────
  console.log("V — produce variants")
  {
    const mem = seed()
    const c = { image: 0, video: 0, afford: 0 }
    const photo = await recordMediaAsset(mem, { brokerageId: B, assetType: "image", assetUrl: "https://cdn.example/p.jpg", assetName: "p", subject: "123 Main St", purpose: "listing_promo", rights: { source: "tenant_upload" }, bookCost: false })
    const n = need({ subject: "123 Main St just listed", purpose: "listing_promo", sourceAssetIds: photo.ok ? [photo.id] : [] })
    const p = await produceVariants(mem, n, 9, stubs(c))
    check("V1 n=9 is clamped to MAX_MEDIA_VARIANTS=4; the image rail ran exactly 4 times; entitlement asked once", p.ok && p.requested === 4 && p.produced === 4 && c.image === 4 && c.afford === 1, JSON.stringify(p))
    const rows = (await readMediaAssets(mem, B, { ids: p.assetIds }) as any).rows as MediaAssetRecord[]
    check("V2 every variant carries lineage (the need's sources), rights generated, the model, the cost and its set/angle", rows.length === 4 && rows.every((r) => r.source_assets[0] === (photo.ok ? photo.id : "") && r.rights.source === "generated" && r.generation_model === "gpt-image-1" && r.cost_usd === 0.04 && typeof r.variants.set_id === "string" && typeof r.variants.angle === "string"), JSON.stringify(rows.map((r) => r.variants)))
    const usage = mem.tables.ai_tool_usage.filter((u) => u.feature === "media_intelligence")
    check("V3 the cost is BOOKED on ai_tool_usage per variant — the SAME number as cost_usd (§5)", usage.length === 4 && usage.every((u) => u.cost_cents === 4 && u.manager === "asset_manager" && u.context_json?.model === "gpt-image-1"), JSON.stringify(usage.map((u) => u.cost_cents)))
    const led = mem.tables.agent_action_ledger.filter((x) => x.action === "media.variants.produce")
    check("V4 ONE ledgered production: executed, provider image_generation, cost_usd 0.16, CAMPAIGN_STEP/SCHEDULED reason", led.length === 1 && led[0].status === "executed" && led[0].provider === "image_generation" && Math.abs(Number(led[0].cost_usd) - 0.16) < 1e-9, JSON.stringify(led))
    // The ledger's at-most-once is the DB's unique index (23505 → rereadWinner — test:action-ledger owns it);
    // the in-memory client has no index, so the replay path is driven through the ledger SEAM with the
    // key the first production wrote: the hooks must refuse to produce again and say why.
    const firstKey = led[0]?.idempotency_key as string
    const seam: MediaDeps["ledger"] = async (ctx, _run, hooks) => (ctx.idempotencyKey === firstKey ? hooks.replay({ kind: "replay" }) : _run())
    const again = await produceVariants(mem, n, 4, { ...stubs(c), ledger: seam })
    check("V5 the same need the same day REPLAYS on its deterministic key (no second production, generator count unchanged)", firstKey === `media.variants.produce:${B}:${needKey(n)}:2026-10-06` && !again.ok && /already produced/.test(again.reason ?? "") && c.image === 4, JSON.stringify({ firstKey, again }))
    const v = await produceVariants(mem, need({ assetType: "video", subject: "Austin equity explainer", purpose: "seller_equity" }), 2, stubs(c))
    check("V6 a video need goes through the Director (staged, gated — no asset row until the render is captured)", v.ok && c.video === 2 && v.staged.length === 2 && v.assetIds.length === 0 && v.staged[0].sourceTable === "ai_video_projects", JSON.stringify(v))
    const refused = await produceVariants(mem, need({ subject: "Austin open house" , purpose: "social"}), 2, { ...stubs(c), afford: async () => ({ allowed: false, reason: "ai_budget_exhausted" }) })
    check("V7 entitlement refused → nothing produced, reason carried", !refused.ok && /entitlement refused: ai_budget_exhausted/.test(refused.reason ?? "") && c.image === 4)
  }

  // ── P: performance learning → proposal ───────────────────────────────────────────────
  console.log("P — performance learning")
  {
    const mem = seed()
    const mk = async (assetType: string, name: string) => {
      const r = await recordMediaAsset(mem, { brokerageId: B, assetType, assetUrl: `https://cdn.example/${name}`, assetName: name, subject: "seller equity", purpose: "seller_equity", rights: { source: "generated" }, generationModel: "m", bookCost: false }, { now: NOW })
      return r.ok ? r.id : ""
    }
    const v1 = await mk("video", "v1.mp4"), v2 = await mk("video", "v2.mp4"), g1 = await mk("graphic", "g1.png"), g2 = await mk("image", "g2.png")
    const thin = await learnFromPerformance(mem, { brokerageId: B, assetId: v1, sample: { impressions: 100, clicks: 9, leads: 0, spendUsd: 3, market: "Austin", source: "ad_performance:facebook" } }, { now: NOW })
    check("P1 a reading folds into performance jsonb (counted) — thin evidence proposes NOTHING", thin.ok && thin.performance?.impressions === 100 && thin.performance?.market === "Austin" && thin.proposal === null && mem.tables.improvement_proposals.length === 0, JSON.stringify(thin))
    await learnFromPerformance(mem, { brokerageId: B, assetId: v1, sample: { impressions: 1900, clicks: 171, leads: 0, spendUsd: 60, market: "Austin", source: "ad_performance:facebook" } }, { now: NOW })
    await learnFromPerformance(mem, { brokerageId: B, assetId: v2, sample: { impressions: 2000, clicks: 160, leads: 0, spendUsd: 60, market: "Austin", source: "ad_performance:facebook" } }, { now: NOW })
    await learnFromPerformance(mem, { brokerageId: B, assetId: g1, sample: { impressions: 2000, clicks: 40, leads: 0, spendUsd: 60, market: "Austin", source: "ad_performance:facebook" } }, { now: NOW })
    const last = await learnFromPerformance(mem, { brokerageId: B, assetId: g2, sample: { impressions: 2000, clicks: 50, leads: 0, spendUsd: 60, market: "Austin", source: "ad_performance:facebook" } }, { now: NOW })
    const prop = mem.tables.improvement_proposals[0]
    check("P2 the experiment gate clears → ONE improvement proposal (variant kind, proposer media_intelligence, media_kind:seller_equity:Austin)", !!last.proposal?.ok && mem.tables.improvement_proposals.length === 1 && prop?.subject_kind === "variant" && prop?.proposer === "media_intelligence" && prop?.subject_key === "media_kind:seller_equity:Austin" && prop?.status === "PROPOSED", JSON.stringify(prop))
    check("P3 the owner's statement: 'seller equity videos outperform static graphics in Austin'", last.statement === "seller equity videos outperform static graphics in Austin (ctr)" && prop?.proposed_change?.winner === "video", String(last.statement))
    check("P4 RECOMMENDATION MODE: nothing promoted — the proposal waits for a human (status PROPOSED, no policy version written)", prop?.promoted_at == null && mem.tables.tenant_policy_versions.length === 0)
    const again = await learnFromPerformance(mem, { brokerageId: B, assetId: g2, sample: { impressions: 10, clicks: 0 }, market: "Austin" } as any, { now: NOW })
    check("P5 re-learning finds the OPEN proposal (no duplicate)", again.ok && again.proposal?.ok === true && (again.proposal as any).existing === true && mem.tables.improvement_proposals.length === 1)
    const folded = foldPerformance({ impressions: 10, clicks: 1, leads: 0, spend_usd: 1, samples: 1 }, { impressions: 90, clicks: 9, leads: 2, spendUsd: 9 }, NOW)
    check("P6 PURE fold: sums, samples+1, score = leads per 100 impressions when leads exist", folded.impressions === 100 && folded.clicks === 10 && folded.leads === 2 && folded.spend_usd === 10 && folded.samples === 2 && folded.score === 2)
    check("P7 PURE verdict: thin arms → null (honest floors)", mediaKindVerdict([{ asset_type: "video", purpose: "seller_equity", performance: { impressions: 100, clicks: 50 } }, { asset_type: "image", purpose: "seller_equity", performance: { impressions: 100, clicks: 1 } }], "seller_equity", null) === null)
  }

  // ── R: rights required ───────────────────────────────────────────────────────────────
  console.log("R — rights / provenance")
  {
    const mem = seed()
    const ext = await recordMediaAsset(mem, { brokerageId: B, assetType: "image", assetUrl: "https://ext.example/x.jpg", assetName: "ext", subject: "s", purpose: "social", rights: { source: "external" }, bookCost: false })
    check("R1 an externally sourced asset WITHOUT licence + provenance is refused, no row", !ext.ok && /rights required/.test(ext.error) && mem.tables.marketing_assets.length === 0, JSON.stringify(ext))
    const ok = await recordMediaAsset(mem, { brokerageId: B, assetType: "image", assetUrl: "https://ext.example/x.jpg", assetName: "ext", subject: "s", purpose: "social", rights: { source: "external", licence: "CC BY 4.0", provenance_url: "https://ext.example/x", attribution: "Jane Photographer" }, bookCost: false })
    check("R2 with licence + provenance it is recorded, rights on the row", ok.ok && mem.tables.marketing_assets[0]?.rights?.licence === "CC BY 4.0")
    check("R3 PURE: stock needs a licence; generated needs its model; unknown source refused", !rightsVerdict({ source: "stock" }).ok && rightsVerdict({ source: "stock", licence: "Pexels" }).ok && !rightsVerdict({ source: "generated" }, null).ok && rightsVerdict({ source: "generated" }, "gpt-image-1").ok && !rightsVerdict({ source: "somewhere" as any }).ok)
    check("R4 CONTROL: m719 enforces the same rule as a CHECK (external ⇒ licence + provenance_url)", /marketing_assets_external_rights_check[\s\S]*'external'[\s\S]*'licence'[\s\S]*'provenance_url'/.test(readFileSync(join(ROOT, "supabase/migrations/m719-media-asset-record-extends-marketing-assets.sql"), "utf8")))
  }

  // ── T: tenant isolation ──────────────────────────────────────────────────────────────
  console.log("T — tenant isolation")
  {
    const mem = seed()
    const a = await recordMediaAsset(mem, { brokerageId: B, assetType: "image", assetUrl: "https://cdn.example/a.png", assetName: "a", subject: "123 Main St Austin seller equity update", purpose: "seller_equity", audience: "seller", brand: BRAND, rights: { source: "generated" }, generationModel: "m", bookCost: false })
    const foreignRead = await readMediaAssets(mem, OTHER, { ids: [a.ok ? a.id : ""] })
    check("T1 another tenant reads NOTHING (the row is simply absent)", foreignRead.ok && foreignRead.rows.length === 0)
    const c = { image: 0, video: 0, afford: 0 }
    const s = await findSufficientAsset(mem, need({ brokerageId: OTHER }), stubs(c))
    check("T2 another tenant's sufficiency never sees this tenant's asset", !s.sufficient && s.considered.length === 0)
    const l = await learnFromPerformance(mem, { brokerageId: OTHER, assetId: a.ok ? a.id : "", sample: { impressions: 1 } })
    check("T3 learning on a foreign asset is not found — nothing written", !l.ok && /not found/.test(l.error ?? "") && mem.writes.filter((w) => w.op === "update").length === 0)
    check("T4 PURE: the verdict refuses a foreign row outright", !sufficiencyVerdict({ ...(mem.tables.marketing_assets[0] as any), brokerage_id: OTHER, source_assets: [], brand: BRAND, rights: { source: "generated" }, performance: {} }, need(), NOW).sufficient)
  }

  // ── A: agents see no cost ────────────────────────────────────────────────────────────
  console.log("A — agents see no cost")
  {
    const row = { id: "x", cost_usd: 0.04, generation_model: "gpt-image-1", performance: { impressions: 10, spend_usd: 5, clicks: 1 }, subject: "s" } as Partial<MediaAssetRecord>
    const agent = redactForAudience(row, "agent") as any
    const admin = redactForAudience(row, "admin") as any
    check("A1 an agent viewer gets no cost_usd / generation_model / performance.spend_usd; subject and counts stay", agent.cost_usd === undefined && agent.generation_model === undefined && agent.performance.spend_usd === undefined && agent.performance.impressions === 10 && agent.subject === "s")
    check("A2 CONTROL: an admin viewer sees the cost", admin.cost_usd === 0.04 && admin.performance.spend_usd === 5)
  }

  // ── B: brand policy at produce time ──────────────────────────────────────────────────
  console.log("B — brand policy enforced at produce time")
  {
    const mem = seed()
    const c = { image: 0, video: 0, afford: 0 }
    const fh = await produceVariants(mem, need({ subject: "family-friendly home at 123 Main St", purpose: "social" }), 2, stubs(c))
    check("B1 a fair-housing subject is refused BEFORE any generator or entitlement call (hard flag)", !fh.ok && fh.violations.some((v) => /fair-housing/.test(v)) && c.image === 0 && c.afford === 0, JSON.stringify(fh))
    const pr = await produceVariants(mem, need({ subject: "guaranteed sale in 30 days", purpose: "social", brand: null }), 2, stubs(c))
    check("B2 the tenant's prohibited phrase is refused", !pr.ok && pr.violations.some((v) => /prohibited brand phrase/.test(v)) && c.image === 0)
    const nb = brandPolicyVerdict({ subject: "Austin market update", purpose: "market_update" }, { primary_color: "#000" })
    check("B3 PURE: no brokerage attribution on the brand block refuses; a clean subject under a named brand passes", !nb.ok && brandPolicyVerdict({ subject: "Austin market update", purpose: "market_update" }, BRAND, { fairHousing: hasFairHousingViolation }).ok)
  }

  // ── D: honest degrade until m719 is applied ──────────────────────────────────────────
  console.log("D — degrade without m719")
  {
    const NEW_COLS = ["subject", "listing_id", "contact_id", "purpose", "audience", "brand", "rights", "source_assets", "generation_model", "cost_usd", "variants", "performance", "expires_at", "approved_at", "approved_by"]
    const mem = memSupabase({ marketing_assets: [], ai_tool_usage: [], agent_action_ledger: [], tenant_policy_versions: [] }, { stampCreatedAt: true, missingColumns: { marketing_assets: NEW_COLS } })
    const r = await recordMediaAsset(mem, { brokerageId: B, assetType: "image", assetUrl: "https://cdn.example/d.png", assetName: "d", subject: "123 Main St Austin seller equity update", purpose: "seller_equity", audience: "seller", brand: BRAND, rights: { source: "generated" }, generationModel: "gpt-image-1", costUsd: 0.04 })
    check("D1 the writer degrades: row written on the legacy columns, owner shape on metadata.media, result SAYS so", r.ok && r.degraded === "m719 not applied — owner shape written to metadata.media" && mem.tables.marketing_assets[0]?.metadata?.media?.purpose === "seller_equity" && mem.tables.marketing_assets[0]?.purpose === undefined, JSON.stringify(r))
    const read = await readMediaAssets(mem, B, { approvedOnly: true })
    check("D2 the reader degrades the same way and still yields the owner shape", read.ok && read.degraded !== null && read.rows[0]?.purpose === "seller_equity" && read.rows[0]?.rights?.source === "generated")
    const c = { image: 0, video: 0, afford: 0 }
    const s = await fulfilCreativeNeed(mem, need(), stubs(c))
    check("D3 sufficiency still decides from the degraded shape (reused, no generator)", s.reused && c.image === 0)
    const r2 = await recordMediaAsset(mem, { brokerageId: B, assetType: "image", assetUrl: "https://cdn.example/d2.png", assetName: "d2", subject: "s", purpose: "social", rights: { source: "generated" }, generationModel: "m", bookCost: false })
    const lin = r2.ok ? await recordAssetLineage(mem, { brokerageId: B, assetId: r2.id, sourceAssetIds: [r.ok ? r.id : ""] }) : { ok: false, error: "fixture" }
    check("D4 lineage degrades onto metadata.media.source_assets and says so", lin.ok && (lin as any).degraded !== null && mem.tables.marketing_assets[1]?.metadata?.media?.source_assets?.length === 1, JSON.stringify(lin))
    const memOk = seed()
    const r3 = await recordMediaAsset(memOk, { brokerageId: B, assetType: "image", assetUrl: "https://cdn.example/ok.png", assetName: "ok", subject: "s", purpose: "social", rights: { source: "generated" }, generationModel: "m", bookCost: false })
    check("D5 CONTROL: with the columns present nothing degrades (degraded null, purpose on the column)", r3.ok && r3.degraded === null && memOk.tables.marketing_assets[0]?.purpose === "social")
  }

  // ── W: wiring + registration, stripped source, controls; vocabularies derived ─────────
  console.log("W — wiring")
  {
    const signals = src("lib/kernel/manager-signals.ts")
    check("W1 campaign_orchestrator:creative_fatigue HANDLED → requestCreative (the Campaign Manager's creative need reaches the Asset Manager)", /"campaign_orchestrator:creative_fatigue":\s*async/.test(signals) && /requestCreative\(/.test(signals))
    check("W2 asset_manager:creative_need_handoff HANDLED → fulfilCreativeNeed (sufficiency first), tenant from the signal row, foreign payload refused", /"asset_manager:creative_need_handoff":\s*async/.test(signals) && /fulfilCreativeNeed\(/.test(signals) && /need\.brokerageId !== ctx\.brokerageId/.test(signals))
    check("W3 the signals are catalogued: creative_need_handoff → asset_manager, creative_fatigue → campaign_orchestrator (handled)", SIGNAL_REGISTRY.creative_need_handoff?.consumers.includes("asset_manager") && SIGNAL_REGISTRY.creative_need_handoff?.disposition === "handled" && SIGNAL_REGISTRY.creative_fatigue?.consumers.includes("campaign_orchestrator") && SIGNAL_REGISTRY.creative_fatigue?.disposition === "handled")
    const ingest = src("lib/ads/ad-performance-ingest.ts")
    check("W4 the Ads Manager writes performance BACK per source_marketing_asset_id (learnFromPerformance after the ad_performance insert)", /learnFromPerformance\(/.test(ingest) && /source_marketing_asset_id/.test(ingest) && ingest.indexOf('from("ad_performance").insert') < ingest.indexOf("learnFromPerformance("))
    const capture = src("lib/marketing/capture-render-asset.ts")
    check("W5 a captured render records its lineage through recordAssetLineage (readiness ledger reused marketing_assets + props.media_source_assets)", /recordAssetLineage\(/.test(capture) && /asset_readiness/.test(capture) && /media_source_assets/.test(capture))
    const readiness = src("lib/video/plan-asset-readiness.ts")
    check("W6 the readiness image capture goes through recordMediaAsset with bookCost:false (the spend is booked once)", /recordMediaAsset\(/.test(readiness) && /bookCost:\s*false/.test(readiness) && !/from\("marketing_assets"\)\.insert/.test(readiness))
    const mi = src("lib/kernel/media-intelligence.ts")
    check("W7 the service itself: every generator default is the survivor (generateImage, commissionVideo, resolveReelBrand, mayUseAndAfford, withActionLedger, proposeImprovement, decideWinningArm)", ["@/lib/ai/image-generation", "@/lib/video/video-director", "@/lib/video/reel-brand", "@/lib/billing/billing-access", "@/lib/kernel/action-ledger", "@/lib/kernel/improvement-proposals", "@/lib/ads/ad-outcome-loop", "@/lib/kernel/manager-delegation", "@/lib/compliance/client-text-guard"].every((m) => mi.includes(m)))
    check("W8 the delegation route exists for a mission in play (requestDelegation, capability content_repurpose, assigned asset_manager)", /requestDelegation\(\{/.test(mi) && /capability:\s*"content_repurpose"/.test(mi) && /assignedManager:\s*"asset_manager"/.test(mi))
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }
    check("W9 package.json registers test:media-intelligence and the guard chain runs it (position is not pinned — CLAUDE.md §2)", !!pkg.scripts["test:media-intelligence"] && new RegExp("npm run test:media-intelligence(\\s|&|$)").test(pkg.scripts.guard))
    const dom = MAINTENANCE_DOMAINS.media_intelligence
    check("W10 MAINTENANCE_DOMAINS.media_intelligence: asset_manager accountable, co-owners named in the prose and real managers", !!dom && dom.manager === "asset_manager" && dom.proof === "test:media-intelligence" && (dom.coOwners ?? []).every((m) => m in MANAGERS && dom.what.includes(m)) && (dom.coOwners ?? []).includes("ads_manager"))
    check("W11 PROPOSERS carries media_intelligence and m719 widens the m709 CHECK with it (the rule, not a waypoint)", (PROPOSERS as readonly string[]).includes("media_intelligence") && /improvement_proposals_proposer_check[\s\S]*'media_intelligence'/.test(readFileSync(join(ROOT, "supabase/migrations/m719-media-asset-record-extends-marketing-assets.sql"), "utf8")))
    const mig = readFileSync(join(ROOT, "supabase/migrations/m719-media-asset-record-extends-marketing-assets.sql"), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    const migPurposes = [...(/marketing_assets_purpose_check[\s\S]*?IN \(([^)]*)\)/.exec(mig)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
    check("W12 VOCABULARY DERIVED: MEDIA_PURPOSES == the m719 purpose CHECK (one spelling)", migPurposes.length > 0 && migPurposes.join(",") === [...MEDIA_PURPOSES].sort().join(","), `${migPurposes.join(",")} vs ${[...MEDIA_PURPOSES].sort().join(",")}`)
    const liveTypes = CHECK_VOCABULARIES.marketing_assets?.asset_type ?? []
    check("W13 VOCABULARY DERIVED: every generatable asset_type is in the LIVE marketing_assets.asset_type CHECK", liveTypes.length > 0 && GENERATABLE_ASSET_TYPES.every((t) => liveTypes.includes(t)))
    check("W14 the m719 columns every new reader/writer names exist in the migration (the opposite-missing pair is in this lane)", ["subject", "listing_id", "contact_id", "purpose", "audience", "brand", "rights", "source_assets", "generation_model", "cost_usd", "variants", "performance", "expires_at", "approved_at", "approved_by"].every((c) => new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${c}\\s`).test(mig)))
    // POSITIVE CONTROLS — the stripped-source finder ignores a tombstone and sees a live token.
    const specimen = stripComments(`// "asset_manager:creative_need_handoff": async — tombstone\n/* fulfilCreativeNeed( */\nconst live = 1`)
    check("W15 CONTROL: a tombstoned handler is NOT a handler to the stripped scan; a live token is", !/"asset_manager:creative_need_handoff":\s*async/.test(specimen) && !/fulfilCreativeNeed\(/.test(specimen) && /const live/.test(specimen))
    const c = { image: 0, video: 0, afford: 0 }
    const sig: any[] = []
    const rq = await requestCreative(seed(), { need: need(), entityType: "ad_campaign", entityId: "c1" }, { publish: async (i: any) => { sig.push(i); return { ok: true, signalId: "s1" } } })
    check("W16 without a mission the request rides the bus to asset_manager as creative_need_handoff carrying the need", rq.ok && rq.route === "signal" && sig[0]?.toManager === "asset_manager" && sig[0]?.signalType === "creative_need_handoff" && sig[0]?.payload?.media_need?.purpose === "seller_equity")
    const del: any[] = []
    const rd = await requestCreative(seed(), { need: need(), missionId: "m1" }, { delegate: async (i: any) => { del.push(i); return { ok: true, delegation: { id: "d1" } as any } } })
    check("W17 with a mission in play the request is a structured delegation (105A) on content_repurpose with a USD budget", rd.ok && rd.route === "delegation" && del[0]?.assignedManager === "asset_manager" && del[0]?.capability === "content_repurpose" && del[0]?.missionId === "m1" && del[0]?.budget?.usd === 0.16, JSON.stringify(del[0]))
    check("W18 needKey is stable per need and differs across needs", needKey(need()) === needKey(need()) && needKey(need()) !== needKey(need({ purpose: "social" })) && c.image === 0)
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1) }
}

main().catch((e) => { console.error(e); process.exit(1) })
