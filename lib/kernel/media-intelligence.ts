// lib/kernel/media-intelligence.ts
//
// THE ASSET MANAGER AS A MEDIA INTELLIGENCE SYSTEM — CREATIVE REUSE & LINEAGE (wave 106, lane 106C;
// m719). Owner: "Do not regenerate everything … 'existing media is sufficient' decision; creative
// lineage photos → video → social cut → email thumbnail → seller campaign; Campaign Manager → needs
// creative → Asset Manager produces 4 variants → Ads Manager tests → Outcome Engine measures → Asset
// Manager learns ('seller equity videos outperform static graphics in this market')".
//
// SURVIVORS (nothing here replaces them — this module is the ONE decision layer over them):
//   · the asset record ......... marketing_assets (asset_manager-stewarded; m719 adds the owner's
//                                columns: subject / listing_id / contact_id / purpose / audience / brand /
//                                rights / source_assets / generation_model / cost_usd / variants /
//                                performance / expires_at / approved_at / approved_by)
//   · video generator .......... lib/video/video-director.ts commissionVideo (compliance-first, gated,
//                                reads the buckets through plan-asset-readiness before it creates)
//   · image generator .......... lib/ai/image-generation.ts generateImage (gpt-image-1 via the gateway)
//   · brand ..................... lib/video/reel-brand.ts resolveReelBrand (the ONE brand cascade) +
//                                lib/compliance/client-text-guard.ts hasFairHousingViolation (the phrase gate)
//   · cost ledger ............... ai_tool_usage (CLAUDE.md §5) — the SAME number lands on the asset row
//   · entitlement ............... lib/billing/billing-access.ts mayUseAndAfford("ai.generate")
//   · evidence .................. lib/kernel/action-ledger.ts withActionLedger (media.* actions)
//   · ad performance ............ ad_performance (lib/ads/ad-performance-ingest.ts writes it back here)
//   · experiment gate ........... lib/ads/ad-outcome-loop.ts decideWinningArm (honest floors)
//   · learning .................. lib/kernel/improvement-proposals.ts proposeImprovement (variant kind,
//                                proposer media_intelligence — recommendation mode: a human promotes)
//   · manager hand-off .......... lib/kernel/manager-delegation.ts requestDelegation (a mission in play)
//                                else manager_signals asset_manager:creative_need_handoff (lib/kernel/manager-signals.ts)
// Every read and write is tenant-scoped by the brokerageId the CALLER resolved (session / event /
// cron / the anchored row); a row of another tenant is simply absent. Agents never see cost (§5).
//
// DEPENDS ON m719 (APPLIED LIVE 2026-10-06): where the columns are absent the writer degrades — the owner shape
// rides metadata.media on the legacy columns and the result says `degraded: "m719 not applied"`.

import type { CreativeArmSample } from "@/lib/ads/ad-outcome-loop"
import { decideWinningArm } from "@/lib/ads/ad-outcome-loop"
import { proposeImprovement, type ProposeResult } from "@/lib/kernel/improvement-proposals"

/* eslint-disable @typescript-eslint/no-explicit-any */
type Svc = { from: (t: string) => any }

// ─────────────────────────────────────────────────────────────────────────────
// § VOCABULARY (one spelling; the m719 CHECK mirrors MEDIA_PURPOSES)
// ─────────────────────────────────────────────────────────────────────────────

export const MEDIA_PURPOSES = [
  "listing_promo", "seller_equity", "buyer_education", "market_update", "brand", "social",
  "ad", "email_thumbnail", "campaign", "recruiting", "lead_intro", "anniversary",
] as const
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number]

/** marketing_assets.asset_type (live CHECK, scripts/check-vocabularies.ts) — the subset a generator can make. */
export const GENERATABLE_ASSET_TYPES = ["image", "graphic", "video", "ad_creative", "social_post"] as const
export type MediaAssetType = (typeof GENERATABLE_ASSET_TYPES)[number]

export const MEDIA_AUDIENCES = ["buyer", "seller", "investor", "renter", "relocation", "sphere", "lead", "agent", "public"] as const
export type MediaAudience = (typeof MEDIA_AUDIENCES)[number]

export const RIGHTS_SOURCES = ["generated", "render", "tenant_upload", "stock", "external"] as const
export type RightsSource = (typeof RIGHTS_SOURCES)[number]

/** The owner's cap: "Asset Manager produces 4 variants". */
export const MAX_MEDIA_VARIANTS = 4

/** The variant angles, in order (the Director's own hook angles — one vocabulary). */
export const VARIANT_ANGLES = ["curiosity", "social_proof", "urgency", "value"] as const

/** A "static" kind vs a "video" kind — the learner's two arms ("videos outperform static graphics"). */
export const STATIC_ASSET_TYPES: ReadonlySet<string> = new Set(["image", "graphic", "ad_creative", "social_post"])

/**
 * What a generation would COST if the existing asset were not sufficient (USD, conservative). The image
 * number is gpt-image-1 standard (lib/ai/image-generation.ts: "standard is $0.04"); the video number is
 * the D-ID + render leg the meter books per Director commission. Published beside every reuse decision
 * as `cost_avoided_usd` — an estimate, named as one.
 */
export const GENERATION_COST_ESTIMATE_USD: Readonly<Record<MediaAssetType, number>> = Object.freeze({
  image: 0.04, graphic: 0.04, ad_creative: 0.04, social_post: 0.02, video: 2.5,
})

// ─────────────────────────────────────────────────────────────────────────────
// § SHAPES
// ─────────────────────────────────────────────────────────────────────────────

export interface MediaBrand { brokerage_name?: string | null; primary_color?: string | null; logo_url?: string | null; team_id?: string | null }

export interface MediaRights {
  source: RightsSource
  licence?: string | null
  provenance_url?: string | null
  attribution?: string | null
  verified_at?: string | null
}

export interface MediaPerformance {
  impressions: number
  clicks: number
  leads: number
  spend_usd: number
  samples: number
  /** leads per 100 impressions when leads exist, else CTR — the same score decideWinningArm ranks on. */
  score: number | null
  market: string | null
  last_source: string | null
  updated_at: string | null
}

/** The owner's structured media asset — marketing_assets after m719. */
export interface MediaAssetRecord {
  id: string
  brokerage_id: string
  subject: string | null
  campaign_id: string | null
  listing_id: string | null
  contact_id: string | null
  asset_type: string
  purpose: MediaPurpose | null
  audience: MediaAudience | null
  brand: MediaBrand
  rights: Partial<MediaRights>
  source_assets: string[]
  generation_model: string | null
  cost_usd: number | null
  variants: Record<string, unknown>
  performance: Partial<MediaPerformance>
  expires_at: string | null
  approved_at: string | null
  approved_by: string | null
  approval_status: string | null
  asset_url: string | null
  thumbnail_url: string | null
  asset_name: string | null
  tags: string[] | null
  metadata: Record<string, unknown> | null
  created_at: string | null
}

export interface MediaNeed {
  /** VERIFIED tenant (session / event / cron / the anchored row) — never a request body. */
  brokerageId: string
  subject: string
  purpose: MediaPurpose
  assetType: MediaAssetType
  audience?: MediaAudience | null
  campaignId?: string | null
  listingId?: string | null
  contactId?: string | null
  /** users.id of the agent the creative fronts (the brand cascade's team tier; the ledger's user). */
  agentUserId?: string | null
  brand?: MediaBrand | null
  /** The market the creative serves (city / ZIP) — the learner groups by it. */
  market?: string | null
  /** Performance floor an existing asset must clear to count as sufficient (score, same scale as learn). */
  minScore?: number | null
  /** The assets a derived creative should cite (a listing's captured photos, the primary video). */
  sourceAssetIds?: string[]
  now?: Date
}

// ─────────────────────────────────────────────────────────────────────────────
// § PURE — rights, brand policy, sufficiency, performance, redaction
// ─────────────────────────────────────────────────────────────────────────────

/** Rights / provenance REQUIRED for anything externally sourced; stock names its licence; generated names its model. PURE. */
export function rightsVerdict(rights: Partial<MediaRights> | null | undefined, generationModel?: string | null): { ok: boolean; reason: string | null } {
  const source = rights?.source
  if (!source || !(RIGHTS_SOURCES as readonly string[]).includes(source)) return { ok: false, reason: `rights.source must be one of ${RIGHTS_SOURCES.join("|")}` }
  if (source === "external" && (!rights?.licence || !rights?.provenance_url)) return { ok: false, reason: "an externally sourced asset needs rights.licence and rights.provenance_url" }
  if (source === "stock" && !rights?.licence) return { ok: false, reason: "a stock asset needs rights.licence" }
  if (source === "generated" && !generationModel) return { ok: false, reason: "a generated asset names its generation_model" }
  return { ok: true, reason: null }
}

/**
 * Brand policy, enforced BEFORE any generator runs (owner: "brand policy enforced at produce time").
 * The brand block must name the brokerage (attribution rides every external creative); the subject
 * passes the ONE fair-housing phrase gate (compliance-first, CLAUDE.md §5); a tenant's prohibited
 * phrases (global_settings.additional_settings.prohibited_language — lib/kernel/brand-compliance.ts's
 * rule) are refused. PURE.
 */
export function brandPolicyVerdict(
  need: Pick<MediaNeed, "subject" | "purpose">,
  brand: MediaBrand | null | undefined,
  rules: { prohibited?: readonly string[]; fairHousing?: (text: string) => boolean } = {},
): { ok: boolean; violations: string[] } {
  const violations: string[] = []
  if (!brand?.brokerage_name) violations.push("no brokerage name on the brand block — every external creative carries the brokerage attribution")
  const subject = need.subject ?? ""
  if (!subject.trim()) violations.push("an empty subject produces nothing")
  if (rules.fairHousing && rules.fairHousing(subject)) violations.push("fair-housing phrase in the subject — refused before the writing prompt (hard flag)")
  for (const p of rules.prohibited ?? []) {
    if (p && subject.toLowerCase().includes(String(p).toLowerCase())) violations.push(`prohibited brand phrase "${p}" in the subject`)
  }
  return { ok: violations.length === 0, violations }
}

function tokens(s: string | null | undefined): Set<string> {
  return new Set((s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t.length > 2))
}

/** Jaccard overlap of the subjects' word sets. PURE. */
export function subjectSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = tokens(a), tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return inter / (ta.size + tb.size - inter)
}

/** An asset's score as the learner reads it (leads per 100 impressions when leads exist, else CTR). PURE. */
export function performanceScore(p: Partial<MediaPerformance> | null | undefined): number | null {
  if (!p) return null
  const imp = Number(p.impressions ?? 0), clicks = Number(p.clicks ?? 0), leads = Number(p.leads ?? 0)
  if (imp <= 0) return null
  return leads > 0 ? (leads / imp) * 100 : clicks / imp
}

export const SUFFICIENCY_SUBJECT_FLOOR = 0.5

export interface SufficiencyVerdict { sufficient: boolean; score: number; reasons: string[] }

/**
 * "Existing media is sufficient" — matched on subject / purpose / audience / brand / rights / expiry /
 * performance, in that order, before any generation spend. Every refusal says why. PURE.
 */
export function sufficiencyVerdict(asset: MediaAssetRecord, need: MediaNeed, now: Date = need.now ?? new Date()): SufficiencyVerdict {
  const reasons: string[] = []
  if (asset.brokerage_id !== need.brokerageId) return { sufficient: false, score: 0, reasons: ["another tenant's asset"] }
  if (asset.approval_status !== "approved") reasons.push(`not approved (${asset.approval_status ?? "null"})`)
  if (asset.asset_type !== need.assetType) reasons.push(`asset_type ${asset.asset_type} ≠ ${need.assetType}`)
  if (asset.purpose !== need.purpose) reasons.push(`purpose ${asset.purpose ?? "null"} ≠ ${need.purpose}`)
  if (need.audience && asset.audience && asset.audience !== need.audience) reasons.push(`audience ${asset.audience} ≠ ${need.audience}`)
  const sim = subjectSimilarity(asset.subject, need.subject)
  if (sim < SUFFICIENCY_SUBJECT_FLOOR) reasons.push(`subject overlap ${sim.toFixed(2)} < ${SUFFICIENCY_SUBJECT_FLOOR}`)
  const b = need.brand
  if (b?.brokerage_name && asset.brand?.brokerage_name && asset.brand.brokerage_name !== b.brokerage_name) reasons.push("produced under another brand")
  if (b?.primary_color && asset.brand?.primary_color && asset.brand.primary_color.toLowerCase() !== b.primary_color.toLowerCase()) reasons.push("brand colour changed since it was produced")
  const rv = rightsVerdict(asset.rights, asset.generation_model)
  if (!rv.ok) reasons.push(`rights: ${rv.reason}`)
  if (asset.expires_at && new Date(asset.expires_at).getTime() <= now.getTime()) reasons.push(`expired ${asset.expires_at}`)
  const perf = performanceScore(asset.performance)
  if (need.minScore != null && perf != null && perf < need.minScore) reasons.push(`performance ${perf.toFixed(3)} below the floor ${need.minScore}`)
  if (!asset.asset_url) reasons.push("no asset_url")
  const score = reasons.length === 0 ? sim + (perf ?? 0) : 0
  return { sufficient: reasons.length === 0, score, reasons }
}

/** Fold one measurement into the asset's performance (a running sum; score re-derived). PURE. */
export function foldPerformance(prev: Partial<MediaPerformance> | null | undefined, sample: { impressions?: number; clicks?: number; leads?: number; spendUsd?: number; market?: string | null; source?: string | null }, now: Date): MediaPerformance {
  const p: MediaPerformance = {
    impressions: Number(prev?.impressions ?? 0) + Math.max(0, Number(sample.impressions ?? 0)),
    clicks: Number(prev?.clicks ?? 0) + Math.max(0, Number(sample.clicks ?? 0)),
    leads: Number(prev?.leads ?? 0) + Math.max(0, Number(sample.leads ?? 0)),
    spend_usd: Math.round((Number(prev?.spend_usd ?? 0) + Math.max(0, Number(sample.spendUsd ?? 0))) * 10000) / 10000,
    samples: Number(prev?.samples ?? 0) + 1,
    score: null,
    market: sample.market ?? prev?.market ?? null,
    last_source: sample.source ?? prev?.last_source ?? null,
    updated_at: now.toISOString(),
  }
  p.score = performanceScore(p)
  return p
}

/**
 * The learner's arms: every asset of one purpose (and market) folded into "video" vs "static"
 * CreativeArmSamples, judged by the ads lane's own experiment gate (decideWinningArm — read floors,
 * >25 % lift). Returns the statement the owner asked for, or null when the evidence is thin. PURE.
 */
export function mediaKindVerdict(assets: ReadonlyArray<Pick<MediaAssetRecord, "asset_type" | "performance" | "purpose">>, purpose: MediaPurpose, market: string | null): { winner: "video" | "static"; basis: "cpl" | "ctr"; arms: CreativeArmSample[]; statement: string } | null {
  const arms: Record<"video" | "static", CreativeArmSample> = {
    video: { arm: "video", spend: 0, impressions: 0, clicks: 0, leads: 0 },
    static: { arm: "static", spend: 0, impressions: 0, clicks: 0, leads: 0 },
  }
  for (const a of assets) {
    if (a.purpose !== purpose) continue
    const kind: "video" | "static" | null = a.asset_type === "video" ? "video" : STATIC_ASSET_TYPES.has(a.asset_type) ? "static" : null
    if (!kind) continue
    const p = a.performance ?? {}
    arms[kind].spend += Number(p.spend_usd ?? 0)
    arms[kind].impressions += Number(p.impressions ?? 0)
    arms[kind].clicks += Number(p.clicks ?? 0)
    arms[kind].leads += Number(p.leads ?? 0)
  }
  const list = [arms.video, arms.static]
  const d = decideWinningArm(list)
  if (!d) return null
  const winner = d.arm as "video" | "static"
  const loser = winner === "video" ? "static graphics" : "videos"
  const where = market ? ` in ${market}` : ""
  const label = purpose.replace(/_/g, " ")
  return { winner, basis: d.basis, arms: list, statement: `${label} ${winner === "video" ? "videos" : "static graphics"} outperform ${loser}${where} (${d.basis})` }
}

/** The cost columns never reach an agent-facing surface (CLAUDE.md §5). PURE. */
export function redactForAudience<T extends Partial<MediaAssetRecord>>(row: T, viewer: "agent" | "admin" | "platform"): T {
  if (viewer !== "agent") return row
  const out: Record<string, unknown> = { ...row }
  delete out.cost_usd
  delete out.generation_model
  if (out.performance && typeof out.performance === "object") {
    const p = { ...(out.performance as Record<string, unknown>) }
    delete p.spend_usd
    out.performance = p
  }
  return out as T
}

/** Stable key for a need (idempotency: one production per need per cycle). PURE. */
export function needKey(need: MediaNeed): string {
  const s = [need.purpose, need.assetType, need.audience ?? "", need.campaignId ?? "", need.listingId ?? "", need.contactId ?? "", [...tokens(need.subject)].sort().join("+")].join("|")
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return `${need.purpose}:${need.assetType}:${(h >>> 0).toString(16)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// § READS — tenant-scoped, m719-aware
// ─────────────────────────────────────────────────────────────────────────────

const MISSING_COLUMN = new Set(["42703", "PGRST204", "PGRST200"])
// (literal column lists so the readerless-writes / writerless-reads censuses see every column)
const MEDIA_COLS = "id, brokerage_id, subject, campaign_id, listing_id, contact_id, asset_type, purpose, audience, brand, rights, source_assets, generation_model, cost_usd, variants, performance, expires_at, approved_at, approved_by, approval_status, asset_url, thumbnail_url, asset_name, tags, metadata, created_at"
const LEGACY_COLS = "id, brokerage_id, campaign_id, asset_type, approval_status, asset_url, thumbnail_url, asset_name, tags, metadata, created_at"

/** A legacy row (m719 not applied) carries the owner shape under metadata.media. */
function fromLegacyRow(r: Record<string, any>): MediaAssetRecord {
  const m = ((r.metadata ?? {}) as Record<string, any>).media ?? {}
  return {
    id: r.id, brokerage_id: r.brokerage_id, subject: m.subject ?? null, campaign_id: r.campaign_id ?? null,
    listing_id: m.listing_id ?? null, contact_id: m.contact_id ?? null, asset_type: r.asset_type, purpose: m.purpose ?? null,
    audience: m.audience ?? null, brand: m.brand ?? {}, rights: m.rights ?? {}, source_assets: Array.isArray(m.source_assets) ? m.source_assets : [],
    generation_model: m.generation_model ?? null, cost_usd: m.cost_usd ?? null, variants: m.variants ?? {}, performance: m.performance ?? {},
    expires_at: m.expires_at ?? null, approved_at: m.approved_at ?? null, approved_by: m.approved_by ?? null,
    approval_status: r.approval_status ?? null, asset_url: r.asset_url ?? null, thumbnail_url: r.thumbnail_url ?? null,
    asset_name: r.asset_name ?? null, tags: r.tags ?? null, metadata: r.metadata ?? null, created_at: r.created_at ?? null,
  }
}

/** A post-m719 row: the owner's columns win; a column the writer degraded into metadata.media still reads. */
function normalize(r: Record<string, any>): MediaAssetRecord {
  const legacy = fromLegacyRow(r)
  return {
    ...legacy,
    subject: r.subject ?? legacy.subject, listing_id: r.listing_id ?? legacy.listing_id, contact_id: r.contact_id ?? legacy.contact_id,
    purpose: r.purpose ?? legacy.purpose, audience: r.audience ?? legacy.audience,
    brand: r.brand && Object.keys(r.brand).length ? r.brand : legacy.brand, rights: r.rights && Object.keys(r.rights).length ? r.rights : legacy.rights,
    source_assets: Array.isArray(r.source_assets) && r.source_assets.length ? r.source_assets : legacy.source_assets,
    generation_model: r.generation_model ?? legacy.generation_model, cost_usd: r.cost_usd ?? legacy.cost_usd,
    variants: r.variants && Object.keys(r.variants).length ? r.variants : legacy.variants,
    performance: r.performance && Object.keys(r.performance).length ? r.performance : legacy.performance,
    expires_at: r.expires_at ?? legacy.expires_at, approved_at: r.approved_at ?? legacy.approved_at, approved_by: r.approved_by ?? legacy.approved_by,
  }
}

export type ReadResult = { ok: true; rows: MediaAssetRecord[]; degraded: string | null } | { ok: false; error: string }

/** Tenant-scoped read of asset rows (by ids, or the approved library), m719-aware. */
export async function readMediaAssets(svc: Svc, brokerageId: string, opts: { ids?: string[]; approvedOnly?: boolean; limit?: number } = {}): Promise<ReadResult> {
  if (!brokerageId) return { ok: false, error: "No brokerage — nothing read." }
  const build = (cols: string) => {
    let q = svc.from("marketing_assets").select(cols).eq("brokerage_id", brokerageId)
    if (opts.ids) q = q.in("id", opts.ids)
    if (opts.approvedOnly) q = q.eq("approval_status", "approved")
    return q.order("created_at", { ascending: false }).limit(opts.limit ?? 200)
  }
  const { data, error } = await build(MEDIA_COLS)
  if (!error) return { ok: true, rows: ((data ?? []) as Record<string, any>[]).map(normalize), degraded: null }
  if (!MISSING_COLUMN.has(String(error.code ?? ""))) return { ok: false, error: `marketing_assets read refused: ${error.message}` }
  const legacy = await build(LEGACY_COLS)
  if (legacy.error) return { ok: false, error: `marketing_assets read refused: ${legacy.error.message}` }
  return { ok: true, rows: ((legacy.data ?? []) as Record<string, any>[]).map(fromLegacyRow), degraded: "m719 not applied — owner shape read from metadata.media" }
}

// ─────────────────────────────────────────────────────────────────────────────
// § THE WRITER every generator uses — record + rights + lineage + cost
// ─────────────────────────────────────────────────────────────────────────────

export interface RecordMediaAssetInput {
  brokerageId: string
  agentUserId?: string | null
  assetType: string
  assetUrl: string
  thumbnailUrl?: string | null
  assetName: string
  subject: string | null
  purpose: MediaPurpose | null
  audience?: MediaAudience | null
  campaignId?: string | null
  listingId?: string | null
  contactId?: string | null
  brand?: MediaBrand | null
  rights: Partial<MediaRights>
  sourceAssetIds?: string[]
  generationModel?: string | null
  costUsd?: number | null
  variants?: Record<string, unknown>
  expiresAt?: string | null
  /** The producer's own source row (ai_video_projects / remotion_composition_renders / …) for idempotency. */
  sourceTable?: string | null
  sourceId?: string | null
  tags?: string[]
  metadata?: Record<string, unknown>
  approvalStatus?: "approved" | "pending" | "rejected"
  /** false when the caller already booked the spend on ai_tool_usage (plan-asset-readiness books its own). */
  bookCost?: boolean
  feature?: string
  visibilityScope?: string
}

export type RecordMediaAssetResult =
  | { ok: true; id: string; degraded: string | null; costBooked: boolean }
  | { ok: false; error: string }

/**
 * THE ONE asset writer: rights verified (external needs licence + provenance), lineage pinned to the
 * tenant (a source of another tenant is refused), the cost booked on ai_tool_usage (the §5 ledger —
 * the same number as cost_usd), the owner shape on the row (metadata.media until m719 is applied).
 */
export async function recordMediaAsset(svc: Svc, input: RecordMediaAssetInput, opts: { now?: Date } = {}): Promise<RecordMediaAssetResult> {
  if (!input.brokerageId) return { ok: false, error: "No brokerage — asset not recorded." }
  if (!input.assetUrl) return { ok: false, error: "No asset_url — asset not recorded." }
  if (input.purpose && !(MEDIA_PURPOSES as readonly string[]).includes(input.purpose)) return { ok: false, error: `unknown purpose ${input.purpose}` }
  const rv = rightsVerdict(input.rights, input.generationModel)
  if (!rv.ok) return { ok: false, error: `rights required: ${rv.reason}` }
  const now = opts.now ?? new Date()
  const sources = [...new Set((input.sourceAssetIds ?? []).filter(Boolean))]
  if (sources.length > 0) {
    const owned = await readMediaAssets(svc, input.brokerageId, { ids: sources, limit: sources.length })
    if (!owned.ok) return { ok: false, error: `lineage sources could not be verified: ${owned.error}` }
    const seen = new Set(owned.rows.map((r) => r.id))
    const foreign = sources.filter((s) => !seen.has(s))
    if (foreign.length > 0) return { ok: false, error: `lineage refused: ${foreign.length} source asset(s) are not this brokerage's (${foreign.join(", ")})` }
  }
  const shape = {
    subject: input.subject, listing_id: input.listingId ?? null, contact_id: input.contactId ?? null, purpose: input.purpose,
    audience: input.audience ?? null, brand: input.brand ?? {}, rights: input.rights, source_assets: sources,
    generation_model: input.generationModel ?? null, cost_usd: input.costUsd ?? null, variants: input.variants ?? {}, performance: {},
    expires_at: input.expiresAt ?? null,
    approved_at: input.approvalStatus === "approved" || !input.approvalStatus ? now.toISOString() : null, approved_by: null,
  }
  const legacy = {
    brokerage_id: input.brokerageId, agent_user_id: input.agentUserId ?? null, visibility_scope: input.visibilityScope ?? "brokerage",
    asset_type: input.assetType, asset_name: input.assetName.slice(0, 120), asset_url: input.assetUrl, thumbnail_url: input.thumbnailUrl ?? input.assetUrl,
    campaign_id: input.campaignId ?? null, source_table: input.sourceTable ?? null, source_id: input.sourceId ?? null,
    tags: [...new Set(["reusable", "media_intelligence", ...(input.tags ?? [])])], approval_status: input.approvalStatus ?? "approved",
    metadata: { ...(input.metadata ?? {}), captured_from: "media_intelligence" },
  }
  let degraded: string | null = null
  let { data, error } = await svc.from("marketing_assets").insert({ ...legacy, ...shape }).select("id")
  if (error && MISSING_COLUMN.has(String(error.code ?? ""))) {
    degraded = "m719 not applied — owner shape written to metadata.media"
    ;({ data, error } = await svc.from("marketing_assets").insert({ ...legacy, metadata: { ...legacy.metadata, media: shape } }).select("id"))
  }
  if (error) return { ok: false, error: `marketing_assets insert refused: ${error.message}` }
  const id = ((data ?? []) as Array<{ id: string }>)[0]?.id
  if (!id) return { ok: false, error: "marketing_assets insert returned no row" }
  let costBooked = false
  if (input.bookCost !== false && (input.costUsd ?? 0) > 0) {
    // THE COST LEDGER (CLAUDE.md §5). model_used is CHECK-constrained to text models — the media model rides context_json.
    const { data: u, error: uErr } = await svc.from("ai_tool_usage").insert({
      user_id: input.agentUserId ?? null, brokerage_id: input.brokerageId, tool_name: "media_generation", tokens_used: 0, model_used: null,
      cost_cents: Math.round((input.costUsd ?? 0) * 100), feature: input.feature ?? "media_intelligence", manager: "asset_manager", success: true,
      context_json: { model: input.generationModel ?? null, asset_id: id, purpose: input.purpose, asset_type: input.assetType },
    }).select("id")
    costBooked = !uErr && ((u ?? []) as unknown[]).length === 1
    if (!costBooked) console.error("[media-intelligence] cost NOT booked on ai_tool_usage:", uErr?.message ?? "no row")
  }
  return { ok: true, id, degraded, costBooked }
}

// ─────────────────────────────────────────────────────────────────────────────
// § LINEAGE
// ─────────────────────────────────────────────────────────────────────────────

export type LineageResult = { ok: true; sourceAssets: string[]; degraded: string | null } | { ok: false; error: string }

/** Every derived asset names its sources — a COUNTED, tenant-pinned union onto source_assets (sources of another tenant refused). */
export async function recordAssetLineage(svc: Svc, input: { brokerageId: string; assetId: string; sourceAssetIds: string[] }): Promise<LineageResult> {
  if (!input.brokerageId || !input.assetId) return { ok: false, error: "No brokerage / asset id." }
  const want = [...new Set(input.sourceAssetIds.filter((s) => s && s !== input.assetId))]
  if (want.length === 0) return { ok: false, error: "no source assets named (an asset never names itself)" }
  const rows = await readMediaAssets(svc, input.brokerageId, { ids: [input.assetId, ...want], limit: want.length + 1 })
  if (!rows.ok) return rows
  const self = rows.rows.find((r) => r.id === input.assetId)
  if (!self) return { ok: false, error: "asset not found for this brokerage" }
  const seen = new Set(rows.rows.map((r) => r.id))
  const foreign = want.filter((s) => !seen.has(s))
  if (foreign.length > 0) return { ok: false, error: `lineage refused: ${foreign.length} source asset(s) are not this brokerage's` }
  const merged = [...new Set([...(self.source_assets ?? []), ...want])]
  let { data, error } = await svc.from("marketing_assets").update({ source_assets: merged }).eq("brokerage_id", input.brokerageId).eq("id", input.assetId).select("id")
  let degraded: string | null = null
  if (error && MISSING_COLUMN.has(String(error.code ?? ""))) {
    degraded = "m719 not applied — lineage written to metadata.media.source_assets"
    const meta = { ...(self.metadata ?? {}), media: { ...(((self.metadata ?? {}) as any).media ?? {}), source_assets: merged } }
    ;({ data, error } = await svc.from("marketing_assets").update({ metadata: meta }).eq("brokerage_id", input.brokerageId).eq("id", input.assetId).select("id"))
  }
  if (error) return { ok: false, error: `lineage not recorded: ${error.message}` }
  if (((data ?? []) as unknown[]).length !== 1) return { ok: false, error: "lineage not recorded: no row matched this brokerage + id" }
  return { ok: true, sourceAssets: merged, degraded }
}

export interface LineageLink { id: string; depth: number; asset_type: string; subject: string | null; purpose: MediaPurpose | null; sources: string[] }

/** Walk an asset's ancestry (sources, their sources, …) breadth-first, tenant-scoped, depth-capped. */
export async function lineageChain(svc: Svc, brokerageId: string, assetId: string, opts: { maxDepth?: number } = {}): Promise<{ ok: true; chain: LineageLink[]; roots: string[] } | { ok: false; error: string }> {
  const maxDepth = opts.maxDepth ?? 8
  const chain: LineageLink[] = []
  const seen = new Set<string>()
  let frontier = [assetId]
  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
    const rows = await readMediaAssets(svc, brokerageId, { ids: frontier, limit: frontier.length })
    if (!rows.ok) return rows
    const next: string[] = []
    for (const r of rows.rows) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      chain.push({ id: r.id, depth, asset_type: r.asset_type, subject: r.subject, purpose: r.purpose, sources: r.source_assets })
      for (const s of r.source_assets) if (!seen.has(s)) next.push(s)
    }
    frontier = [...new Set(next)]
  }
  if (chain.length === 0) return { ok: false, error: "asset not found for this brokerage" }
  return { ok: true, chain, roots: chain.filter((l) => l.sources.length === 0).map((l) => l.id) }
}

// ─────────────────────────────────────────────────────────────────────────────
// § SEAMS — every default is THE survivor (lazy, keeps this module off the proxy graph)
// ─────────────────────────────────────────────────────────────────────────────

export interface GeneratedVariant { ok: boolean; assetUrl?: string; thumbnailUrl?: string; costUsd?: number; generationModel?: string; sourceTable?: string; sourceId?: string; reason?: string; /** the generator staged a gated row (video) — nothing to capture yet */ staged?: boolean }

export interface MediaDeps {
  now?: () => Date
  /** lib/billing/billing-access.ts mayUseAndAfford("ai.generate") */
  afford?: (svc: Svc, a: { brokerageId: string; estTokens: number }) => Promise<{ allowed: boolean; reason: string }>
  /** lib/video/reel-brand.ts resolveReelBrand through the ONE brand cascade + the tenant's prohibited phrases */
  brand?: (svc: Svc, a: { brokerageId: string; agentUserId: string | null }) => Promise<{ brand: MediaBrand; prohibited: string[] }>
  fairHousing?: (text: string) => boolean
  /** lib/ai/image-generation.ts generateImage */
  generateImage?: (a: { need: MediaNeed; angle: string; brand: MediaBrand }) => Promise<GeneratedVariant>
  /** lib/video/video-director.ts commissionVideo (stages a gated ai_video_projects row; the capture on completion cites the lineage) */
  commissionVideo?: (svc: Svc, a: { need: MediaNeed; angle: string; brand: MediaBrand }) => Promise<GeneratedVariant>
  /** Wave 108F — lib/kernel/autonomy-budgets.ts consumeAutonomyEnvelope("asset_renders"): the per-campaign render
   *  envelope every autonomous production consumes first (default all zero = recommendation only). */
  envelope?: (svc: Svc, a: { brokerageId: string; scopeKey: string; renders: number; need: MediaNeed; idempotencyKey: string; now: Date }) => Promise<{ allowed: boolean; reason: string }>
  /** lib/kernel/action-ledger.ts withActionLedger */
  ledger?: <T>(ctx: Record<string, unknown>, run: () => Promise<T>, hooks: { settle: (r: T) => Record<string, unknown>; replay: (claim: { kind: string }) => T }, svc: Svc) => Promise<T>
}

async function defaultLedger<T>(ctx: Record<string, unknown>, run: () => Promise<T>, hooks: { settle: (r: T) => Record<string, unknown>; replay: (claim: { kind: string }) => T }, svc: Svc): Promise<T> {
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  return withActionLedger<T>(ctx as any, run, hooks as any, { client: svc as any })
}

const DEFAULT_DEPS: Required<MediaDeps> = {
  now: () => new Date(),
  async envelope(svc, a) {
    const { consumeAutonomyEnvelope } = await import("@/lib/kernel/autonomy-budgets")
    const v = await consumeAutonomyEnvelope(svc, {
      brokerageId: a.brokerageId, envelope: "asset_renders", amount: a.renders, scopeKey: a.scopeKey,
      reasonCode: a.need.campaignId ? "CAMPAIGN_STEP" : "SCHEDULED_CONTENT_PUBLISH",
      reasonDetail: `${a.renders} ${a.need.assetType} variant render(s) for "${a.need.subject.slice(0, 80)}" (${a.need.purpose})`,
      subject: { type: a.need.campaignId ? "marketing_campaign" : a.need.listingId ? "listing" : "media_need", id: a.need.campaignId ?? a.need.listingId ?? null, ref: a.scopeKey },
      idempotencyKey: a.idempotencyKey, now: a.now,
    })
    return { allowed: v.allowed, reason: v.reason }
  },
  async afford(svc, a) {
    const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
    const d = await mayUseAndAfford({ brokerageId: a.brokerageId, capability: "ai.generate", estTokens: a.estTokens, client: svc })
    return { allowed: d.allowed, reason: d.reason }
  },
  async brand(svc, a) {
    const { resolveReelBrand } = await import("@/lib/video/reel-brand")
    const b = await resolveReelBrand(svc, a.brokerageId, { agentUserId: a.agentUserId })
    const { data } = await svc.from("global_settings").select("additional_settings").eq("brokerage_id", a.brokerageId).maybeSingle()
    const prohibited = (((data as any)?.additional_settings ?? {}).prohibited_language ?? []) as string[]
    return { brand: { brokerage_name: b.brokerageName, primary_color: b.primaryColor, logo_url: b.logoUrl }, prohibited: Array.isArray(prohibited) ? prohibited : [] }
  },
  // replaced per call by the lazy import below (the survivor regex lives in lib/compliance/client-text-guard.ts)
  fairHousing: () => false,
  async generateImage(a) {
    const { generateImage } = await import("@/lib/ai/image-generation")
    const purpose = a.need.purpose === "ad" ? "ad_creative" : a.need.purpose === "email_thumbnail" ? "newsletter_hero" : a.need.purpose === "listing_promo" ? "listing_visual" : "social_post"
    const r = await generateImage({ prompt: `${a.need.subject} — ${a.angle} angle`, purpose, style: "natural", quality: "standard", brand: { brokerageName: a.brand.brokerage_name ?? null, primaryColor: a.brand.primary_color ?? null, logoUrl: a.brand.logo_url ?? null } })
    return r.success && r.imageUrl ? { ok: true, assetUrl: r.imageUrl, thumbnailUrl: r.thumbnailUrl ?? r.imageUrl, costUsd: r.cost ?? GENERATION_COST_ESTIMATE_USD.image, generationModel: "gpt-image-1" } : { ok: false, reason: r.error ?? "image generation failed" }
  },
  async commissionVideo(svc, a) {
    const { commissionVideo } = await import("@/lib/video/video-director")
    if (!a.need.agentUserId) return { ok: false, reason: "a video needs an agentUserId (the presenter)" }
    const kind = a.need.purpose === "listing_promo" ? "new_listing" : a.need.purpose === "market_update" ? "market_update" : a.need.purpose === "anniversary" ? "anniversary" : a.need.purpose === "lead_intro" ? "lead_intro" : "explainer"
    const r = await commissionVideo(
      { kind: kind as any, tier: "brokerage", targetChannel: a.need.purpose === "email_thumbnail" ? "email" : "instagram", facts: { subject: a.need.subject, market: a.need.market ?? null, angle: a.angle } },
      { brokerageId: a.need.brokerageId, agentUserId: a.need.agentUserId, listingId: a.need.listingId ?? null, contactId: a.need.contactId ?? null, campaignId: a.need.campaignId ?? null, idempotencyDiscriminator: `media:${a.angle}`, autonomous: true, meterFeature: "media_intelligence", extraMetadata: { media_need: { purpose: a.need.purpose, audience: a.need.audience ?? null, source_assets: a.need.sourceAssetIds ?? [] } } },
      svc as any,
    )
    return r.ok ? { ok: true, staged: true, sourceTable: "ai_video_projects", sourceId: r.videoProjectId, generationModel: `video_director:${r.compositionId ?? "?"}`, reason: r.status } : { ok: false, reason: r.reason ?? r.status }
  },
  ledger: defaultLedger,
}

// ─────────────────────────────────────────────────────────────────────────────
// § THE DECISIONS — sufficiency (ledgered with the cost avoided), production, learning
// ─────────────────────────────────────────────────────────────────────────────

export interface SufficiencyDecision {
  sufficient: boolean
  asset: MediaAssetRecord | null
  costAvoidedUsd: number
  /** every candidate's verdict — the evidence */
  considered: Array<{ id: string; score: number; reasons: string[] }>
  degraded: string | null
  ledgered: boolean
  error?: string
}

/**
 * "Existing media is sufficient" — the decision BEFORE any generation spend. Reads the tenant's approved
 * library, ranks by sufficiencyVerdict, and records the decision on the action ledger with the cost it
 * avoided (media.decision.reuse, NO_ACTION_NEEDED, status skipped — nothing was produced).
 */
export async function findSufficientAsset(svc: Svc, need: MediaNeed, deps: MediaDeps = {}): Promise<SufficiencyDecision> {
  const d = { ...DEFAULT_DEPS, ...deps }
  const now = need.now ?? d.now()
  const read = await readMediaAssets(svc, need.brokerageId, { approvedOnly: true, limit: 300 })
  if (!read.ok) return { sufficient: false, asset: null, costAvoidedUsd: 0, considered: [], degraded: null, ledgered: false, error: read.error }
  const considered = read.rows.map((r) => ({ row: r, v: sufficiencyVerdict(r, need, now) })).sort((a, b) => b.v.score - a.v.score)
  const best = considered.find((c) => c.v.sufficient) ?? null
  const costAvoidedUsd = best ? GENERATION_COST_ESTIMATE_USD[need.assetType] ?? 0 : 0
  let ledgered = false
  if (best) {
    try {
      await d.ledger(
        {
          brokerageId: need.brokerageId, action: "media.decision.reuse",
          actor: { type: "manager", managerKey: "asset_manager", userId: need.agentUserId ?? null },
          subject: { type: "marketing_asset", id: best.row.id }, reasonCode: "NO_ACTION_NEEDED",
          reasonDetail: `existing media is sufficient for "${need.subject.slice(0, 80)}" (${need.purpose}/${need.assetType}) — generation avoided`,
          idempotencyKey: `media.decision.reuse:${need.brokerageId}:${needKey(need)}:${now.toISOString().slice(0, 10)}`,
          riskClass: "READ", systemSource: "media_intelligence",
          detail: { need_key: needKey(need), asset_id: best.row.id, cost_avoided_usd: costAvoidedUsd, cost_basis: "GENERATION_COST_ESTIMATE_USD (estimate)", considered: considered.length, campaign_id: need.campaignId ?? null },
        },
        async () => ({ ok: true as const }),
        { settle: () => ({ status: "skipped", outcome: "existing_media_sufficient", costUsd: 0 }), replay: () => ({ ok: true as const }) },
        svc,
      )
      ledgered = true
    } catch (e) { console.error("[media-intelligence] reuse decision not ledgered:", (e as Error).message) }
  }
  return { sufficient: !!best, asset: best?.row ?? null, costAvoidedUsd, considered: considered.slice(0, 10).map((c) => ({ id: c.row.id, score: c.v.score, reasons: c.v.reasons })), degraded: read.degraded, ledgered }
}

export interface ProduceVariantsResult {
  ok: boolean
  reason: string | null
  /** recorded asset ids (images) — a staged video has no asset row until its render is captured */
  assetIds: string[]
  staged: Array<{ sourceTable: string; sourceId: string }>
  requested: number
  produced: number
  costUsd: number
  violations: string[]
  degraded: string | null
}

/**
 * Produce ≤ MAX_MEDIA_VARIANTS variants of one need through the EXISTING generators — after the brand
 * policy (produce time) and the entitlement gate — each recorded with lineage (the need's sources),
 * rights {source: generated}, the model and the cost (booked on ai_tool_usage); the production is
 * ONE ledgered action (media.variants.produce, idempotent per need).
 */
export async function produceVariants(svc: Svc, need: MediaNeed, n: number = MAX_MEDIA_VARIANTS, deps: MediaDeps = {}): Promise<ProduceVariantsResult> {
  const d = { ...DEFAULT_DEPS, ...deps }
  const count = Math.max(1, Math.min(MAX_MEDIA_VARIANTS, Math.floor(n)))
  const empty = (reason: string, violations: string[] = []): ProduceVariantsResult => ({ ok: false, reason, assetIds: [], staged: [], requested: count, produced: 0, costUsd: 0, violations, degraded: null })
  if (!need.brokerageId) return empty("no brokerage")
  if (!(GENERATABLE_ASSET_TYPES as readonly string[]).includes(need.assetType)) return empty(`no generator for asset_type ${need.assetType}`)
  const brandRes = need.brand ? { brand: need.brand, prohibited: [] as string[] } : await d.brand(svc, { brokerageId: need.brokerageId, agentUserId: need.agentUserId ?? null })
  const fairHousing = deps.fairHousing ?? (await import("@/lib/compliance/client-text-guard")).hasFairHousingViolation
  const policy = brandPolicyVerdict(need, brandRes.brand, { prohibited: brandRes.prohibited, fairHousing })
  if (!policy.ok) return empty("brand policy refused at produce time", policy.violations)
  const afford = await d.afford(svc, { brokerageId: need.brokerageId, estTokens: 1500 * count })
  if (!afford.allowed) return empty(`entitlement refused: ${afford.reason}`)
  const now = need.now ?? d.now()
  const setId = `${needKey(need)}:${now.toISOString().slice(0, 10)}`
  // Wave 108F — CONTROLLED AUTONOMOUS BUDGETING: the Asset Manager's render envelope (per campaign) is consumed
  // atomically BEFORE any generator runs; a zero / exhausted envelope produces nothing (recommendation only).
  const env = await d.envelope(svc, { brokerageId: need.brokerageId, scopeKey: need.campaignId ?? need.listingId ?? `need:${needKey(need)}`, renders: count, need, idempotencyKey: `media.variants.envelope:${need.brokerageId}:${setId}`, now })
  if (!env.allowed) return empty(`render envelope refused — recommendation only: ${env.reason}`)
  const run = async (): Promise<ProduceVariantsResult> => {
    const out: ProduceVariantsResult = { ok: true, reason: null, assetIds: [], staged: [], requested: count, produced: 0, costUsd: 0, violations: [], degraded: null }
    for (let i = 0; i < count; i++) {
      const angle = VARIANT_ANGLES[i % VARIANT_ANGLES.length]
      const g = need.assetType === "video"
        ? await d.commissionVideo(svc, { need, angle, brand: brandRes.brand })
        : await d.generateImage({ need, angle, brand: brandRes.brand })
      if (!g.ok) { out.violations.push(`variant ${i + 1} (${angle}): ${g.reason ?? "generator refused"}`); continue }
      if (g.staged && g.sourceTable && g.sourceId) { out.staged.push({ sourceTable: g.sourceTable, sourceId: g.sourceId }); out.produced++; continue }
      const rec = await recordMediaAsset(svc, {
        brokerageId: need.brokerageId, agentUserId: need.agentUserId ?? null, assetType: need.assetType, assetUrl: g.assetUrl!, thumbnailUrl: g.thumbnailUrl ?? null,
        assetName: `${need.subject.slice(0, 60)} — ${angle}`, subject: need.subject, purpose: need.purpose, audience: need.audience ?? null,
        campaignId: need.campaignId ?? null, listingId: need.listingId ?? null, contactId: need.contactId ?? null, brand: brandRes.brand,
        rights: { source: "generated", attribution: brandRes.brand.brokerage_name ?? null }, sourceAssetIds: need.sourceAssetIds ?? [],
        generationModel: g.generationModel ?? "unknown", costUsd: g.costUsd ?? GENERATION_COST_ESTIMATE_USD[need.assetType],
        variants: { set_id: setId, index: i, angle, requested: count }, sourceTable: g.sourceTable ?? null, sourceId: g.sourceId ?? null,
        metadata: { market: need.market ?? null }, feature: "media_intelligence",
      }, { now })
      if (!rec.ok) { out.violations.push(`variant ${i + 1} (${angle}) not recorded: ${rec.error}`); continue }
      out.assetIds.push(rec.id); out.produced++; out.costUsd += g.costUsd ?? GENERATION_COST_ESTIMATE_USD[need.assetType]
      if (rec.degraded) out.degraded = rec.degraded
    }
    out.ok = out.produced > 0
    out.reason = out.ok ? null : "no variant was produced"
    return out
  }
  try {
    return await d.ledger<ProduceVariantsResult>(
      {
        brokerageId: need.brokerageId, action: "media.variants.produce",
        actor: { type: "manager", managerKey: "asset_manager", userId: need.agentUserId ?? null },
        subject: { type: need.campaignId ? "marketing_campaign" : need.listingId ? "listing" : "media_need", id: need.campaignId ?? need.listingId ?? null, ref: needKey(need) },
        reasonCode: need.campaignId ? "CAMPAIGN_STEP" : "SCHEDULED_CONTENT_PUBLISH",
        reasonDetail: `produce ${count} ${need.assetType} variant(s) for "${need.subject.slice(0, 80)}" (${need.purpose})`,
        idempotencyKey: `media.variants.produce:${need.brokerageId}:${setId}`, riskClass: "LOW_RISK_WRITE", systemSource: "media_intelligence",
        policyKey: "autonomy_tier:asset_manager",
        detail: { need_key: needKey(need), requested: count, purpose: need.purpose, asset_type: need.assetType, audience: need.audience ?? null, campaign_id: need.campaignId ?? null, source_assets: need.sourceAssetIds ?? [], brand: brandRes.brand.brokerage_name ?? null },
      },
      run,
      {
        settle: (r) => r.ok ? { status: "executed", outcome: `produced_${r.produced}`, provider: need.assetType === "video" ? "video_director" : "image_generation", costUsd: r.costUsd } : { status: "failed", outcome: "nothing_produced", error: r.violations.join("; ").slice(0, 500) },
        replay: (claim) => ({ ...empty(claim.kind === "replay" ? "already produced for this need today (ledger replay)" : `ledger refused: ${claim.kind}`) }),
      },
      svc,
    )
  } catch (e) { return empty(`production threw: ${(e as Error).message}`) }
}

export interface LearnResult {
  ok: boolean
  error?: string
  performance: MediaPerformance | null
  proposal: ProposeResult | null
  statement: string | null
  degraded: string | null
}

/**
 * Ads / outcome results per asset → performance jsonb (counted, tenant-pinned), then the learner judges
 * "video vs static" for the asset's purpose (and market) through the ads lane's experiment gate and
 * writes ONE improvement proposal (variant kind, proposer media_intelligence) — recommendation mode:
 * it waits for a human on the Manager Trust page; nothing is promoted here.
 */
export async function learnFromPerformance(
  svc: Svc,
  input: { brokerageId: string; assetId: string; sample: { impressions?: number; clicks?: number; leads?: number; spendUsd?: number; market?: string | null; source?: string | null } },
  opts: { now?: Date; propose?: boolean } = {},
): Promise<LearnResult> {
  const now = opts.now ?? new Date()
  const got = await readMediaAssets(svc, input.brokerageId, { ids: [input.assetId], limit: 1 })
  if (!got.ok) return { ok: false, error: got.error, performance: null, proposal: null, statement: null, degraded: null }
  const row = got.rows[0]
  if (!row) return { ok: false, error: "asset not found for this brokerage", performance: null, proposal: null, statement: null, degraded: null }
  const perf = foldPerformance(row.performance, input.sample, now)
  let { data, error } = await svc.from("marketing_assets").update({ performance: perf }).eq("brokerage_id", input.brokerageId).eq("id", input.assetId).select("id")
  let degraded: string | null = got.degraded
  if (error && MISSING_COLUMN.has(String(error.code ?? ""))) {
    degraded = "m719 not applied — performance written to metadata.media.performance"
    const meta = { ...(row.metadata ?? {}), media: { ...(((row.metadata ?? {}) as any).media ?? {}), performance: perf } }
    ;({ data, error } = await svc.from("marketing_assets").update({ metadata: meta }).eq("brokerage_id", input.brokerageId).eq("id", input.assetId).select("id"))
  }
  if (error) return { ok: false, error: `performance not recorded: ${error.message}`, performance: null, proposal: null, statement: null, degraded }
  if (((data ?? []) as unknown[]).length !== 1) return { ok: false, error: "performance not recorded: no row matched this brokerage + id", performance: null, proposal: null, statement: null, degraded }
  if (opts.propose === false || !row.purpose) return { ok: true, performance: perf, proposal: null, statement: null, degraded }
  const all = await readMediaAssets(svc, input.brokerageId, { approvedOnly: true, limit: 500 })
  if (!all.ok) return { ok: true, performance: perf, proposal: null, statement: null, degraded, error: all.error }
  const market = perf.market ?? null
  const pool = all.rows.map((r) => (r.id === input.assetId ? { ...r, performance: perf } : r)).filter((r) => !market || (r.performance?.market ?? null) === market)
  const verdict = mediaKindVerdict(pool, row.purpose, market)
  if (!verdict) return { ok: true, performance: perf, proposal: null, statement: null, degraded }
  const stats = verdict.arms.map((a) => ({ variant: a.arm, sent: a.impressions, replies: a.leads > 0 ? a.leads : a.clicks }))
  // The winner is attributed to its ROOTS too (photos → video → cut): the lineage rides the evidence.
  const lineage = await lineageChain(svc, input.brokerageId, input.assetId)
  const proposal = await proposeImprovement(svc, {
    brokerageId: input.brokerageId, subjectKind: "variant", subjectKey: `media_kind:${row.purpose}:${market ?? "all"}`, proposer: "media_intelligence",
    proposedChange: { winner: verdict.winner, stats, loserIds: [], statement: verdict.statement, basis: verdict.basis, purpose: row.purpose, market, recommendation: `prefer ${verdict.winner} creative for ${row.purpose}${market ? ` in ${market}` : ""} — recommendation mode: a human decides` },
    evidenceRefs: [{ kind: "marketing_assets.performance", asset_id: input.assetId, source: input.sample.source ?? null }, { kind: "marketing_assets.lineage", roots: lineage.ok ? lineage.roots : [], depth: lineage.ok ? lineage.chain.length : null, error: lineage.ok ? null : lineage.error }, ...verdict.arms.map((a) => ({ kind: "media_kind_arm", ...a }))],
  })
  return { ok: true, performance: perf, proposal, statement: verdict.statement, degraded }
}

// ─────────────────────────────────────────────────────────────────────────────
// § THE HAND-OFF — Campaign Manager's creative need → Asset Manager
// ─────────────────────────────────────────────────────────────────────────────

export const CREATIVE_NEED_SIGNAL = "creative_need_handoff"

export interface CreativeRequestResult { route: "delegation" | "signal"; ok: boolean; id: string | null; reason: string | null }

/**
 * The Campaign Manager asks the Asset Manager for creative: a mission in play → a structured delegation
 * (lib/kernel/manager-delegation.ts, capability content_repurpose — the asset manager's catalogue key;
 * budget = the variants' estimated cost); otherwise the bus (asset_manager:creative_need_handoff), whose handler
 * runs findSufficientAsset → produceVariants. Nothing is generated here.
 */
export async function requestCreative(
  svc: Svc,
  input: { need: MediaNeed; missionId?: string | null; requestingManager?: "campaign_orchestrator" | "ads_manager"; entityType?: string | null; entityId?: string | null },
  deps: { delegate?: typeof import("@/lib/kernel/manager-delegation").requestDelegation; publish?: typeof import("@/lib/kernel/manager-signals").publishManagerSignal } = {},
): Promise<CreativeRequestResult> {
  const need = input.need
  const from = input.requestingManager ?? "campaign_orchestrator"
  const estUsd = Math.round(GENERATION_COST_ESTIMATE_USD[need.assetType] * MAX_MEDIA_VARIANTS * 100) / 100
  if (input.missionId) {
    const requestDelegation = deps.delegate ?? (await import("@/lib/kernel/manager-delegation")).requestDelegation
    const r = await requestDelegation({
      brokerageId: need.brokerageId, missionId: input.missionId, requestingManager: from, assignedManager: "asset_manager", capability: "content_repurpose",
      objective: `creative for "${need.subject.slice(0, 100)}" (${need.purpose}/${need.assetType}): reuse existing media if sufficient, else ≤ ${MAX_MEDIA_VARIANTS} variants`,
      inputEntities: { media_need: need, campaign_id: need.campaignId ?? null, listing_id: need.listingId ?? null }, requiredOutput: { asset_ids: "uuid[]", reused: "boolean", cost_usd: "number" },
      budget: { usd: estUsd }, actor: { type: "manager", id: from },
    }, svc as any)
    return r.ok ? { route: "delegation", ok: true, id: r.delegation.id, reason: r.duplicate ? "duplicate (open delegation found)" : null } : { route: "delegation", ok: false, id: null, reason: r.reason }
  }
  const publish = deps.publish ?? (await import("@/lib/kernel/manager-signals")).publishManagerSignal
  const r = await publish({
    brokerageId: need.brokerageId, fromManager: from, toManager: "asset_manager", signalType: CREATIVE_NEED_SIGNAL,
    message: `Creative needed: "${need.subject.slice(0, 100)}" (${need.purpose}/${need.assetType}${need.audience ? `, ${need.audience}` : ""}) — reuse if sufficient, else ≤ ${MAX_MEDIA_VARIANTS} variants (est. $${estUsd})`,
    entityType: input.entityType ?? (need.campaignId ? "marketing_campaign" : need.listingId ? "listing" : null), entityId: input.entityId ?? need.campaignId ?? need.listingId ?? null,
    payload: { media_need: need },
  }, svc as any)
  return { route: "signal", ok: r.ok, id: r.signalId ?? null, reason: r.reason ?? null }
}

/** The Asset Manager's answer to a creative need: sufficiency first, production only when nothing suffices. */
export async function fulfilCreativeNeed(svc: Svc, need: MediaNeed, deps: MediaDeps = {}): Promise<{ reused: boolean; assetIds: string[]; staged: number; costUsd: number; costAvoidedUsd: number; reason: string | null }> {
  const s = await findSufficientAsset(svc, need, deps)
  if (s.sufficient && s.asset) return { reused: true, assetIds: [s.asset.id], staged: 0, costUsd: 0, costAvoidedUsd: s.costAvoidedUsd, reason: `existing media is sufficient (${s.asset.id}) — $${s.costAvoidedUsd} avoided` }
  const p = await produceVariants(svc, need, MAX_MEDIA_VARIANTS, deps)
  return { reused: false, assetIds: p.assetIds, staged: p.staged.length, costUsd: p.costUsd, costAvoidedUsd: 0, reason: p.ok ? `produced ${p.produced} of ${p.requested} variant(s)` : p.reason }
}
