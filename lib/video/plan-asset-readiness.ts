// lib/video/plan-asset-readiness.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLAN-DRIVEN ASSET READINESS (wave 84, lane 84A).
//
// OWNER (2026-09-26, verbatim): "autonomous videos need to read the plan and
// create whatever assets that are needed, first check the buckets to see if
// assets are there."
//
// Before this, an autonomous video planned its screen from whatever the
// PRODUCER happened to stage: the topic runner handed the Director an all-zero
// inventory ("a topic video carries no photos, screens, stat cards"), so the
// purpose's preferred visual was silently replaced by its kinetic-text floor
// and nobody was told; the Director looked for b-roll only on formats flagged
// needsBroll, and under the WRONG identity class (users.id where video_assets
// scopes agents by agents.id — the agent and team tiers of the cascade never
// matched). Nothing ever asked "what does the PLAN want on screen, is it in our
// storage already, and if not can we make it?".
//
// THE RULE, in order, per autonomous commission:
//   1. READ THE PLAN THE PURPOSE WANTS — the body-visual plan is cut with a
//      WISHFUL inventory (every asset class that could be reused or created
//      counts as present), so each segment names the treatment the purpose
//      PREFERS rather than the one the staged props happen to allow
//      (lib/video/body-visual-model.ts stageBodyVisualPlan({ assets })).
//   2. DERIVE THE REQUIREMENTS from that plan — per segment the treatment's
//      asset class (treatmentAssetNeed, the ONE table), plus the finish's own
//      needs (the music bed, the brand logo on the brand cards, the stock
//      bookends) through finish-spec × render-cut (the MLS cut carries no
//      brand, so it requires none).
//   3. CHECK THE BUCKETS FIRST, tenant-scoped, reusing the survivors that
//      already know each bucket:
//        photos       → the staged props → listing_media (the listing-media
//                        bucket's rows; MLS cut: unbranded, mls|both only) →
//                        the tenant's approved marketing_assets image library
//                        (never a screenshot/estimate still)
//        screenshots  → the staged props → (CAMPAIGN VIDEO ONLY) the tenant's
//                        approved Zestimate still, admitted by the ONE use rule
//                        (lib/assets/screenshot-uses.ts screenshotUseAllowed,
//                        re-exported by the seam — lane 84B owns it; consumed
//                        here with the literal "campaign_video", never
//                        restated) through the door approvedTenantStill(…,
//                        "campaign_video") → the platform OS-surface stills
//                        (listScreenshotStillsForUse "product_video")
//        broll        → the staged props → pickBrollClips (video_assets
//                        agent → team → brokerage cascade, agents.id)
//        music / bookend stock → pickStockAsset (the SAME picker the render
//                        coordinator mixes from, so the answer agrees)
//        brand logo   → the brand block the Director resolved through the ONE
//                        brand cascade (resolveReelBrand)
//   4. CREATE ONLY WHAT IS MISSING, and only where creating is honest
//      (ASSET_CREATE_POLICY): a lifestyle/editorial image through the existing
//      image rail (lib/ai/image-generation.ts generateImage — gpt-image-1 via
//      the AI Gateway, DALL-E 3 fallback; lib/providers/dispatch.ts has no image
//      door and a second one would be the §6 defect), its spend BOOKED on the
//      cost ledger (ai_tool_usage, CLAUDE.md §5) and the image CAPTURED into the
//      tenant's marketing_assets library so the next video reuses it; an OS
//      screenshot through the screenshot seam (seedMissingDemoStill — the demo
//      tenant, platform-owned). NEVER created: a photo of a LISTING (an AI house
//      in a listing video misrepresents the property), stat cards / chart data
//      (a number must come from a fact), b-roll (stock footage is licensed, not
//      generated), the client's own footage, a music bed (licensed library), a
//      logo (the tenant's identity).
//   5. RE-STAGE the plan from the real props. A segment whose wanted asset was
//      neither found nor created falls down its own preference chain to a
//      treatment the purpose allows (the planner's universal kinetic-text /
//      brand-card floor) — and every such fall is RECORDED with why
//      (degradations), never rendered silently empty.
//   6. GATE — gateVisualPlanForDispatch on the final plan (fail closed).
//   7. PROVENANCE — every requirement's outcome (reused | created | missing),
//      its source and its cost ride video_metadata.asset_readiness on the row.
//
// Pure planning half at the top (no I/O — the proof runs it); the bucket /
// creation half takes injectable deps so the proof exercises the ladder on
// counting stubs and never touches the network.

import {
  BROLL_PHOTO_SCARCITY, COMPOSITION_TREATMENTS, assetsFromProps, gateVisualPlanForDispatch, segmentUsesBroll,
  stageBodyVisualPlan, treatmentAssetNeed,
  type BodyTreatment, type BodyVisualAssets, type BodyVisualPlan, type BodyVisualRuleOverride, type ScriptSegment,
} from "./body-visual-model"
import { finishForVideo, type VideoFinish } from "./finish-spec"
import { finishForCut, type RenderCut } from "./render-cut"
import { screenshotUseAllowed } from "@/lib/assets/screenshot-capture"
import type { VideoPurpose } from "./duration-model"

// ─────────────────────────────────────────────────────────────────────────────
// § VOCABULARY + POLICY
// ─────────────────────────────────────────────────────────────────────────────

export const READINESS_ASSET_KINDS = [
  "photos", "screenshots", "stat_cards", "chart_data", "broll", "client_footage", "music", "brand_logo", "bookend_stock",
] as const
export type ReadinessAssetKind = (typeof READINESS_ASSET_KINDS)[number]

export type CreateScope = "never" | "non_listing_only" | "platform_os_surface"

export interface CreatePolicy { create: CreateScope; how: string | null; why: string }

/** Where creating an asset is honest — and where it never is. The proof holds every kind to a row. */
export const ASSET_CREATE_POLICY: Record<ReadinessAssetKind, CreatePolicy> = {
  photos: { create: "non_listing_only", how: "lib/ai/image-generation.ts generateImage (editorial, no people, no identifiable home), booked on ai_tool_usage, captured into marketing_assets", why: "an editorial image may illustrate a topic; an AI image standing in for a LISTING's photos misrepresents the property (NAR Code Art. 12 true picture; the MLS cut is the listing's own media only)" },
  screenshots: { create: "platform_os_surface", how: "lib/assets/screenshot-capture.ts seedMissingDemoStill (the demo tenant's OS surfaces, platform-owned)", why: "an OS surface is our own product and may be re-captured at will; a public-page (Zestimate) still is only ever captured through the tenant door and approved by a person — never auto-captured into a video" },
  stat_cards: { create: "never", how: null, why: "a stat card is a FACT (price, median, equity) — a number no fact supports would be fabricated" },
  chart_data: { create: "never", how: null, why: "chart data is comps / trend facts — never invented" },
  broll: { create: "never", how: null, why: "b-roll is licensed stock or the tenant's own footage (video_assets); generated footage of a place is not what the verdicts admit" },
  client_footage: { create: "never", how: null, why: "the client's OWN recording — by definition never generated" },
  music: { create: "never", how: null, why: "the bed comes from the licensed stock library (video_assets music) — never generated" },
  brand_logo: { create: "never", how: null, why: "a logo is the tenant's identity — the brand card falls back to the brokerage name" },
  bookend_stock: { create: "never", how: null, why: "stock intro/outro clips are uploaded brand assets; without one the composition's own brand-card bookend renders" },
}

/** Cost-down: at most this many images are generated for one video. */
export const MAX_CREATED_IMAGES_PER_VIDEO = 3

/** The seam use a CAMPAIGN video's still is selected under (lane 84B's vocabulary:
 *  "marketing campaigns including video"). Consumed through the ONE rule
 *  (screenshotUseAllowed), never re-decided here. */
export const CAMPAIGN_VIDEO_STILL_USE = "campaign_video" as const

// ─────────────────────────────────────────────────────────────────────────────
// § PURE — the wished plan, its requirements, the degradations
// ─────────────────────────────────────────────────────────────────────────────

export interface ReadinessContext {
  brokerageId: string
  /** agents.id — the stock / b-roll cascade scopes agents by it (never users.id). */
  agentId: string | null
  /** users.id — the ledger's user and the brand cascade's agent. */
  agentUserId: string | null
  listingId?: string | null
  /** A marketing_campaigns id — verified tenant-owned before a campaign-only still is considered. */
  campaignId?: string | null
  /** The property the video is about ("street, City, ST" — the still door matches it); null = the newest approved still. */
  address?: string | null
  cut: RenderCut
  /** What a generated editorial image should illustrate (the topic / goal / hook). */
  subject?: string | null
  musicMood?: string | null
  /** Whether the finish's own needs (music, bookend stock) are probed — true for a composition render. */
  probeFinish?: boolean
}

/**
 * The inventory a WISHED plan is cut under: every class that could be reused
 * or created counts as present; classes that can only come from facts or the
 * client (stat cards, chart data, client footage) stay as they are — wishing
 * for them would plan a segment nothing can fill. PURE.
 */
export function wishfulInventory(now: BodyVisualAssets, ctx: Pick<ReadinessContext, "listingId" | "cut">): BodyVisualAssets {
  return {
    ...now,
    propertyPhotos: Math.max(now.propertyPhotos, BROLL_PHOTO_SCARCITY),
    screenshots: Math.max(now.screenshots, 1),
    brollClips: ctx.cut === "mls" ? now.brollClips : Math.max(now.brollClips, 1),
    brollSource: now.brollSource ?? (now.brollClips > 0 ? null : "stock"),
  }
}

export interface AssetRequirement {
  kind: ReadinessAssetKind
  /** How many are wanted (photos: at least BROLL_PHOTO_SCARCITY — "enough photos"). */
  count: number
  /** Plan segment indexes that need it (empty for the finish's own needs). */
  segments: number[]
  /** The treatment that wants it, or the finish element. */
  wantedBy: string
}

const NEED_TO_KIND: Record<string, ReadinessAssetKind | null> = {
  photos: "photos", screenshots: "screenshots", stats: "stat_cards", chart: "chart_data", broll: "broll", footage: "client_footage",
  avatar: null, // the presenter is the D-ID pipeline's, decided by the host — not a bucket asset
}

/** READ THE PLAN: what each segment and the finish need. PURE. */
export function requirementsFromPlan(plan: BodyVisualPlan, finish: VideoFinish): AssetRequirement[] {
  const byKind = new Map<ReadinessAssetKind, AssetRequirement>()
  const add = (kind: ReadinessAssetKind, seg: number | null, wantedBy: string) => {
    const r = byKind.get(kind) ?? { kind, count: 0, segments: [], wantedBy }
    if (seg !== null) { r.segments.push(seg); r.count += 1 } else r.count = Math.max(r.count, 1)
    byKind.set(kind, r)
  }
  for (const s of plan.segments) {
    const need = treatmentAssetNeed(s.treatment)
    const kind = need ? NEED_TO_KIND[need] : null
    if (kind) add(kind, s.index, s.treatment)
    // The talking-head reel's floating card is over FOOTAGE — the ONE predicate says so.
    if (s.treatment !== "broll" && segmentUsesBroll(s, plan.compositionId)) add("broll", s.index, `${s.treatment} over footage`)
  }
  const photos = byKind.get("photos")
  if (photos) photos.count = Math.max(photos.count, BROLL_PHOTO_SCARCITY)
  const brandOnScreen = finish.bookends || plan.segments.some((s) => s.treatment === "brand_card")
  if (brandOnScreen) add("brand_logo", null, finish.bookends ? "brand bookends" : "brand_card")
  if (finish.music) add("music", null, "music bed")
  if (finish.bookends) add("bookend_stock", null, "stock intro/outro")
  return Array.from(byKind.values())
}

export type ProvenanceStatus = "reused" | "created" | "missing"

export interface ProvenanceEntry {
  kind: ReadinessAssetKind
  status: ProvenanceStatus
  /** Where it came from: staged_props | listing_media | marketing_assets | zestimate_campaign_still |
   *  os_surface_still | video_assets | brand_cascade | generated:image | captured:os_surface | none */
  source: string
  count: number
  urls: string[]
  assetIds: string[]
  costCents?: number
  reason?: string
}

export interface Degradation {
  segment: number
  kind: string
  wanted: BodyTreatment
  got: BodyTreatment
  why: string
}

/** Every segment whose final treatment is not the one the purpose wanted — with the ledger's reason. PURE. */
export function degradationsBetween(wanted: BodyVisualPlan, final: BodyVisualPlan, ledger: readonly ProvenanceEntry[]): Degradation[] {
  const out: Degradation[] = []
  const n = Math.min(wanted.segments.length, final.segments.length)
  for (let i = 0; i < n; i++) {
    const w = wanted.segments[i], f = final.segments[i]
    if (w.treatment === f.treatment) continue
    const need = treatmentAssetNeed(w.treatment)
    const kind = need ? NEED_TO_KIND[need] : null
    const entry = kind ? ledger.find((e) => e.kind === kind) : null
    const why = entry && entry.status === "missing"
      ? `${kind} missing — ${entry.reason ?? "not in the buckets and not creatable"}`
      : entry ? `${kind} ${entry.status} (${entry.count}) but the plan still fell to ${f.treatment} — ${final.notes.find((x) => x.includes(`#${i}`)) ?? "the purpose's bounds moved it"}`
      : `the plan moved it (${final.notes.find((x) => x.includes(`#${i}`)) ?? "presenter bounds or the b-roll verdict"})`
    out.push({ segment: i, kind: w.kind, wanted: w.treatment, got: f.treatment, why })
  }
  return out
}

export interface AssetReadinessStamp {
  wanted: BodyTreatment[]
  final: BodyTreatment[]
  reused: number
  created: number
  missing: number
  cost_cents: number
  ledger: ProvenanceEntry[]
  degradations: Degradation[]
}

/** The audit stamp written beside the row (video_metadata.asset_readiness). PURE. */
export function readinessStamp(wanted: BodyVisualPlan | null, final: BodyVisualPlan | null, ledger: ProvenanceEntry[], degradations: Degradation[]): AssetReadinessStamp {
  return {
    wanted: wanted?.segments.map((s) => s.treatment) ?? [],
    final: final?.segments.map((s) => s.treatment) ?? [],
    reused: ledger.filter((e) => e.status === "reused").length,
    created: ledger.filter((e) => e.status === "created").length,
    missing: ledger.filter((e) => e.status === "missing").length,
    cost_cents: ledger.reduce((a, e) => a + (e.costCents ?? 0), 0),
    ledger, degradations,
  }
}

/**
 * The CAMPAIGN video's still, as provenance (the creative-playbook install path
 * — app/actions/creative-playbooks.ts — already checks the tenant's bucket
 * first and captures into the PENDING queue when nothing is there; this is the
 * row's record of which it was). A pending / refused still is `missing` for
 * THIS video: it is never staged until a person approves it. PURE.
 */
export function campaignStillProvenance(
  outcome: { state: string; url: string | null; assetId: string | null; reason?: string | null; source?: string | null },
  opts: { forCampaignVideo?: boolean } = {},
): ProvenanceEntry {
  if (outcome.state === "approved" && outcome.url && opts.forCampaignVideo === false) {
    return { kind: "screenshots", status: "missing", source: "none", count: 0, urls: [], assetIds: outcome.assetId ? [outcome.assetId] : [], reason: `the approved still is not admitted for ${CAMPAIGN_VIDEO_STILL_USE} (the screenshot use rule / the row's uses) — the postcard uses it, the video does not` }
  }
  if (outcome.state === "approved" && outcome.url) {
    return { kind: "screenshots", status: "reused", source: "zestimate_campaign_still", count: 1, urls: [outcome.url], assetIds: outcome.assetId ? [outcome.assetId] : [] }
  }
  const why = outcome.state === "captured" ? "captured into the pending approval queue — staged once a person approves it"
    : outcome.state === "pending" ? "a still awaits approval — never staged before a person approves it"
    : outcome.state === "no_address" ? "no listing address to capture an estimate still for"
    : `capture refused: ${outcome.reason ?? "unknown"}`
  return { kind: "screenshots", status: "missing", source: outcome.state === "captured" ? "captured:public_page_pending" : "none", count: 0, urls: [], assetIds: outcome.assetId ? [outcome.assetId] : [], reason: why }
}

/** The prop key a composition reads its photos from — the one already staged, else imageUrls. PURE. */
export function photoPropKey(compositionId: string, props: Record<string, unknown>): string {
  if (compositionId === "ProductPromoReel") return "imageUrls" // its imageUrls ARE screenshot stills (assetsFromProps)
  return ["imageUrls", "images", "photos", "photoUrls"].find((k) => Array.isArray(props[k])) ?? "imageUrls"
}

/** The prop key a composition reads its screenshots from (ProductPromoReel: imageUrls). PURE. */
export function screenshotPropKey(compositionId: string): string {
  return compositionId === "ProductPromoReel" ? "imageUrls" : "screenshotUrls"
}

function urlsAt(props: Record<string, unknown>, key: string): string[] {
  const v = props[key]
  return Array.isArray(v) ? (v as unknown[]).map((x) => (typeof x === "string" ? x : (x as { url?: unknown } | null)?.url)).filter((u): u is string => typeof u === "string" && u.length > 0) : []
}

/** Is this marketing_assets row a screenshot / estimate still? Such a row is NEVER a photo. PURE. */
export function isStillRow(row: { tags?: readonly string[] | null; metadata?: Record<string, unknown> | null }): boolean {
  const tags = row.tags ?? []
  return row.metadata?.asset_kind === "screenshot" || tags.includes("screenshot") || tags.includes("estimate_still") || tags.includes("third_party_page")
}

// ─────────────────────────────────────────────────────────────────────────────
// § THE BUCKETS + CREATION — injectable deps (defaults are the survivors)
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
type Svc = any

export interface GeneratedImage { success: boolean; imageUrl?: string; cost?: number; error?: string }
export interface ReadinessDeps {
  readListingPhotos?: (svc: Svc, a: { brokerageId: string; listingId: string; cut: RenderCut }) => Promise<{ urls: string[]; error: string | null }>
  readLibraryImages?: (svc: Svc, a: { brokerageId: string }) => Promise<{ rows: Array<{ id: string; url: string; tags: string[] | null; metadata: Record<string, unknown> | null }>; error: string | null }>
  generateImage?: (a: { prompt: string; brand: Record<string, unknown> }) => Promise<GeneratedImage>
  bookImageSpend?: (svc: Svc, a: { ctx: ReadinessContext; costCents: number; imageUrl: string }) => Promise<{ ok: boolean; reason: string | null }>
  captureLibraryImage?: (svc: Svc, a: { ctx: ReadinessContext; imageUrl: string; subject: string }) => Promise<{ id: string | null; reason: string | null }>
  verifyCampaign?: (svc: Svc, a: { brokerageId: string; campaignId: string }) => Promise<{ ok: boolean; reason: string | null }>
  campaignStill?: (svc: Svc, a: { brokerageId: string; address: string | null }) => Promise<{ id: string; url: string } | null>
  stillUseAllowed?: (kind: "zillow_zestimate", use: string) => boolean
  osStills?: (svc: Svc) => Promise<Array<{ id: string; url: string }>>
  seedOsStill?: (svc: Svc) => Promise<{ id: string | null; url: string | null; reason: string | null }>
  pickBroll?: (svc: Svc, a: { brokerageId: string; agentId: string }) => Promise<Array<{ url: string; durationSeconds?: number; caption?: string }>>
  pickStock?: (svc: Svc, a: { brokerageId: string; agentId: string; category: string; mood?: string | null }) => Promise<{ id: string; url: string } | null>
  stockCategories?: (compositionId: string) => Promise<{ intro: string | null; outro: string | null }>
}

type DefaultDeps = Required<ReadinessDeps>

const DEFAULT_DEPS: DefaultDeps = {
  async readListingPhotos(svc, a) {
    // listing_media is the listing-media bucket's row per object. MLS cut: only
    // media meant for the MLS and never a branded (logo / attribution) photo.
    const { data, error } = await svc.from("listing_media")
      .select("file_url, usage_intent, has_logo_overlay, has_brokerage_attribution")
      .eq("brokerage_id", a.brokerageId).eq("listing_id", a.listingId)
      .eq("media_type", "photo").eq("is_approved", true)
      .order("sort_order", { ascending: true }).limit(24)
    if (error) return { urls: [], error: `listing_media read refused: ${error.message}` }
    const ok = (r: { usage_intent: string | null; has_logo_overlay: boolean | null; has_brokerage_attribution: boolean | null }) => a.cut === "mls"
      ? (r.usage_intent === "mls" || r.usage_intent === "both") && !r.has_logo_overlay && !r.has_brokerage_attribution
      : r.usage_intent !== "mls"
    return { urls: ((data ?? []) as Array<{ file_url: string | null; usage_intent: string | null; has_logo_overlay: boolean | null; has_brokerage_attribution: boolean | null }>).filter((r) => !!r.file_url && ok(r)).map((r) => r.file_url as string), error: null }
  },
  async readLibraryImages(svc, a) {
    const { data, error } = await svc.from("marketing_assets")
      .select("id, asset_url, tags, metadata")
      .eq("brokerage_id", a.brokerageId).eq("asset_type", "image").eq("approval_status", "approved")
      .not("asset_url", "is", null).order("created_at", { ascending: false }).limit(40)
    if (error) return { rows: [], error: `marketing_assets read refused: ${error.message}` }
    return { rows: ((data ?? []) as Array<{ id: string; asset_url: string; tags: string[] | null; metadata: Record<string, unknown> | null }>).map((r) => ({ id: r.id, url: r.asset_url, tags: r.tags, metadata: r.metadata })), error: null }
  },
  async generateImage(a) {
    const { generateImage } = await import("@/lib/ai/image-generation")
    return generateImage({ prompt: a.prompt, purpose: "social_post", style: "natural", quality: "standard", brand: a.brand as never })
  },
  async bookImageSpend(svc, a) {
    // THE COST LEDGER (CLAUDE.md §5: ai_tool_usage feeds meter_readings.ai_tokens
    // and the overage projection). model_used is CHECK-constrained to text
    // models (scripts/check-vocabularies.ts) — the image model rides context_json.
    const { data, error } = await svc.from("ai_tool_usage").insert({
      user_id: a.ctx.agentUserId, brokerage_id: a.ctx.brokerageId, tool_name: "image_generation", tokens_used: 0,
      model_used: null, cost_cents: a.costCents, feature: "video_asset_readiness", manager: "asset_manager", success: true,
      context_json: { model: "openai/gpt-image-1 (dall-e-3 fallback) — lib/ai/image-generation.ts", image_url: a.imageUrl, listing_id: a.ctx.listingId ?? null },
    }).select("id")
    if (error) return { ok: false, reason: `ai_tool_usage insert refused: ${error.message}` }
    return ((data ?? []) as unknown[]).length === 1 ? { ok: true, reason: null } : { ok: false, reason: `ai_tool_usage insert returned ${((data ?? []) as unknown[]).length} rows` }
  },
  async captureLibraryImage(svc, a) {
    const { data, error } = await svc.from("marketing_assets").insert({
      brokerage_id: a.ctx.brokerageId, agent_user_id: a.ctx.agentUserId, visibility_scope: "brokerage",
      asset_type: "image", asset_name: `Video visual — ${a.subject.slice(0, 60)}`, asset_url: a.imageUrl, thumbnail_url: a.imageUrl,
      source_table: "ai_video_projects", tags: ["reusable", "video_asset", "generated"], approval_status: "approved",
      metadata: { captured_from: "video_asset_readiness", subject: a.subject, customer_facing_value: false },
    }).select("id")
    if (error) return { id: null, reason: `marketing_assets capture refused: ${error.message}` }
    const id = ((data ?? []) as Array<{ id: string }>)[0]?.id ?? null
    return { id, reason: id ? null : "marketing_assets capture returned no row" }
  },
  async verifyCampaign(svc, a) {
    // An FK proves a campaign exists, never that it is OURS — the tenant predicate does.
    const { data, error } = await svc.from("marketing_campaigns").select("id").eq("id", a.campaignId).eq("brokerage_id", a.brokerageId).maybeSingle()
    if (error) return { ok: false, reason: `marketing_campaigns read refused: ${error.message}` }
    return data ? { ok: true, reason: null } : { ok: false, reason: `campaign ${a.campaignId} is not a marketing campaign of this brokerage` }
  },
  async campaignStill(svc, a) {
    // THE DOOR (lane 84B): APPROVED only, the rule checked inside, the address
    // matched when the video is about a property.
    const { approvedTenantStill } = await import("@/lib/marketing/tenant-screenshot-door")
    const pick = await approvedTenantStill(svc, a.brokerageId, { address: a.address }, "campaign_video")
    return pick ? { id: pick.id, url: pick.url } : null
  },
  stillUseAllowed: (kind, use) => screenshotUseAllowed(kind, use),
  async osStills(svc) {
    const { listScreenshotStillsForUse } = await import("@/lib/assets/screenshot-capture")
    const picks = await listScreenshotStillsForUse(svc, "product_video", { kind: "os_surface", limit: 12 })
    return picks.filter((p) => p.approvalStatus === "approved").map((p) => ({ id: p.id, url: p.url }))
  },
  async seedOsStill(svc) {
    const { seedMissingDemoStill } = await import("@/lib/assets/screenshot-capture")
    const r = await seedMissingDemoStill(svc)
    if (!r.surfaceId) return { id: null, url: null, reason: "every registered OS surface already has a still" }
    if (!r.result || !r.result.ok) return { id: null, url: null, reason: r.result && !r.result.ok ? r.result.reason : "capture returned nothing" }
    return { id: r.result.assetId, url: r.result.url, reason: null }
  },
  async pickBroll(svc, a) {
    const { pickBrollClips } = await import("@/lib/video/broll-picker")
    return (await pickBrollClips({ brokerageId: a.brokerageId, scopeType: "agent", scopeId: a.agentId }, svc)).clips
  },
  async pickStock(svc, a) {
    const { pickStockAsset } = await import("@/lib/remotion/stock-pick")
    const row = await pickStockAsset(svc, { brokerageId: a.brokerageId, scopeType: "agent", scopeId: a.agentId }, a.category, a.mood ?? null)
    return row ? { id: row.id, url: row.video_url } : null
  },
  async stockCategories(compositionId) {
    const { getComposition } = await import("@/lib/remotion/registry")
    const c = await getComposition(compositionId)
    return { intro: c?.stock_intro_category ?? null, outro: c?.stock_outro_category ?? null }
  },
}



function missing(kind: ReadinessAssetKind, reason: string): ProvenanceEntry {
  return { kind, status: "missing", source: "none", count: 0, urls: [], assetIds: [], reason: `${reason}; not created — ${ASSET_CREATE_POLICY[kind].why}` }
}

export interface ResolveResult { ledger: ProvenanceEntry[]; propsPatch: Record<string, unknown> }

/**
 * CHECK THE BUCKETS FIRST, CREATE ONLY WHAT IS MISSING. Never throws: a refused
 * read is a `missing` entry carrying the refusal (fail closed — the segment then
 * degrades and the reason is recorded), never an assumed asset.
 */
export async function resolvePlanAssets(
  svc: Svc, compositionId: string, props: Record<string, unknown>, requirements: readonly AssetRequirement[], ctx: ReadinessContext, deps: ReadinessDeps = {},
): Promise<ResolveResult> {
  const d: DefaultDeps = { ...DEFAULT_DEPS, ...(Object.fromEntries(Object.entries(deps).filter(([, v]) => v !== undefined)) as Partial<DefaultDeps>) }
  const ledger: ProvenanceEntry[] = []
  const patch: Record<string, unknown> = {}
  const safe = async <T>(f: () => Promise<T>, fallback: T, note: (e: Error) => void): Promise<T> => {
    try { return await f() } catch (e) { note(e as Error); return fallback }
  }
  for (const req of requirements) {
    switch (req.kind) {
      case "photos": {
        const key = photoPropKey(compositionId, props)
        const have = urlsAt(props, key)
        if (have.length >= req.count) { ledger.push({ kind: "photos", status: "reused", source: "staged_props", count: have.length, urls: have, assetIds: [] }); break }
        const found = [...have]
        const reasons: string[] = []
        if (ctx.listingId) {
          const r = await safe(() => d.readListingPhotos(svc, { brokerageId: ctx.brokerageId, listingId: ctx.listingId as string, cut: ctx.cut }), { urls: [], error: "listing_media read threw" }, (e) => reasons.push(e.message))
          if (r.error) reasons.push(r.error)
          for (const u of r.urls) if (!found.includes(u)) found.push(u)
          if (found.length > have.length) { patch[key] = found; ledger.push({ kind: "photos", status: "reused", source: have.length ? "staged_props+listing_media" : "listing_media", count: found.length, urls: found, assetIds: [] }); break }
          ledger.push(missing("photos", `the listing has ${found.length} photo(s) in its media bucket (want ${req.count})${reasons.length ? ` — ${reasons.join("; ")}` : ""}`))
          if (found.length > 0) ledger[ledger.length - 1].count = found.length
          break
        }
        const lib = await safe(() => d.readLibraryImages(svc, { brokerageId: ctx.brokerageId }), { rows: [], error: "marketing_assets read threw" }, (e) => reasons.push(e.message))
        if (lib.error) reasons.push(lib.error)
        const reusable = lib.rows.filter((r) => !isStillRow(r))
        const libIds: string[] = []
        for (const r of reusable) { if (found.length >= req.count) break; if (!found.includes(r.url)) { found.push(r.url); libIds.push(r.id) } }
        if (found.length >= req.count || lib.error) {
          if (found.length > have.length) { patch[key] = found; ledger.push({ kind: "photos", status: "reused", source: "marketing_assets", count: found.length, urls: found, assetIds: libIds }) }
          if (lib.error) { ledger.push(missing("photos", `library unreadable (${lib.error}) — nothing generated against a library we could not see`)); }
          break
        }
        if (ctx.cut === "mls") { ledger.push(missing("photos", "the MLS cut uses the listing's own media only")); break }
        // CREATE the shortfall — cost-down cap, booked, captured for reuse.
        const created: string[] = [], createdIds: string[] = []
        let cost = 0
        const brand = (props.brand ?? {}) as Record<string, unknown>
        const subject = (ctx.subject ?? "").trim() || "a welcoming home and neighbourhood"
        const shortfall = Math.min(MAX_CREATED_IMAGES_PER_VIDEO, req.count - found.length)
        for (let i = 0; i < shortfall; i++) {
          const img = await safe(() => d.generateImage({
            prompt: `An editorial real-estate lifestyle photograph illustrating: ${subject}. Natural light, no people, no text, no identifiable real property or address.${i ? ` Variation ${i + 1}: a different angle and room/scene.` : ""}`,
            brand: { brokerageName: brand.brokerageName ?? null, primaryColor: brand.primaryColor ?? null, logoUrl: brand.logoUrl ?? null },
          }), { success: false, error: "image generation threw" }, (e) => reasons.push(e.message))
          if (!img.success || !img.imageUrl) { reasons.push(img.error ?? "image generation failed"); break }
          const cents = Math.max(0, Math.round((img.cost ?? 0) * 100))
          const booked = await safe(() => d.bookImageSpend(svc, { ctx, costCents: cents, imageUrl: img.imageUrl as string }), { ok: false, reason: "ledger write threw" }, (e) => reasons.push(e.message))
          if (!booked.ok) reasons.push(`spend NOT booked: ${booked.reason}`)
          const cap = await safe(() => d.captureLibraryImage(svc, { ctx, imageUrl: img.imageUrl as string, subject }), { id: null, reason: "library capture threw" }, (e) => reasons.push(e.message))
          if (cap.reason) reasons.push(cap.reason)
          created.push(img.imageUrl); if (cap.id) createdIds.push(cap.id)
          cost += cents
        }
        if (found.length > have.length) ledger.push({ kind: "photos", status: "reused", source: "marketing_assets", count: found.length - have.length, urls: found.slice(have.length), assetIds: libIds })
        if (created.length > 0) ledger.push({ kind: "photos", status: "created", source: "generated:image", count: created.length, urls: created, assetIds: createdIds, costCents: cost, ...(reasons.length ? { reason: reasons.join("; ") } : {}) })
        const all = [...found, ...created]
        if (all.length > have.length) patch[key] = all
        if (all.length === 0) ledger.push(missing("photos", `no library image and generation failed${reasons.length ? ` — ${reasons.join("; ")}` : ""}`))
        break
      }
      case "screenshots": {
        const key = screenshotPropKey(compositionId)
        const have = urlsAt(props, key)
        if (have.length >= req.count) { ledger.push({ kind: "screenshots", status: "reused", source: "staged_props", count: have.length, urls: have, assetIds: [] }); break }
        const reasons: string[] = []
        // 1. CAMPAIGN VIDEO ONLY — the tenant's approved Zestimate still, through the ONE use rule.
        if (ctx.campaignId) {
          const v = await safe(() => d.verifyCampaign(svc, { brokerageId: ctx.brokerageId, campaignId: ctx.campaignId as string }), { ok: false, reason: "campaign check threw" }, (e) => reasons.push(e.message))
          if (!v.ok) reasons.push(v.reason ?? "not a campaign video")
          else {
            // THE ONE screenshot use rule (lane 84B owns it) — consumed, never restated.
            if (!d.stillUseAllowed("zillow_zestimate", CAMPAIGN_VIDEO_STILL_USE)) {
              reasons.push(`the screenshot use rule refuses the Zestimate still for ${CAMPAIGN_VIDEO_STILL_USE}`)
            } else {
              const still = await safe(() => d.campaignStill(svc, { brokerageId: ctx.brokerageId, address: ctx.address ?? null }), null, (e) => reasons.push(e.message))
              if (still) {
                patch[key] = [...have, still.url]
                ledger.push({ kind: "screenshots", status: "reused", source: "zestimate_campaign_still", count: 1, urls: [still.url], assetIds: [still.id] })
                break
              }
              reasons.push(`no approved ${CAMPAIGN_VIDEO_STILL_USE} Zestimate still${ctx.address ? ` for ${ctx.address}` : ""}`)
            }
          }
        }
        // 2. The platform OS-surface stills (approved renders of the demo tenant).
        const os = await safe(() => d.osStills(svc), [], (e) => reasons.push(e.message))
        if (os.length > 0) {
          patch[key] = [...have, ...os.map((s) => s.url)]
          ledger.push({ kind: "screenshots", status: "reused", source: "os_surface_still", count: os.length, urls: os.map((s) => s.url), assetIds: os.map((s) => s.id) })
          break
        }
        // 3. CREATE — capture the next missing OS surface through the seam.
        const seeded = await safe(() => d.seedOsStill(svc), { id: null, url: null, reason: "capture threw" }, (e) => reasons.push(e.message))
        if (seeded.url) {
          patch[key] = [...have, seeded.url]
          ledger.push({ kind: "screenshots", status: "created", source: "captured:os_surface", count: 1, urls: [seeded.url], assetIds: seeded.id ? [seeded.id] : [] })
          break
        }
        ledger.push(missing("screenshots", `no campaign still, no OS still${seeded.reason ? `, capture refused: ${seeded.reason}` : ""}${reasons.length ? ` — ${reasons.join("; ")}` : ""}`))
        break
      }
      case "broll": {
        const have = Array.isArray(props.brollClips) ? (props.brollClips as unknown[]) : []
        if (have.length > 0) { ledger.push({ kind: "broll", status: "reused", source: "staged_props", count: have.length, urls: urlsAt(props, "brollClips"), assetIds: [] }); break }
        if (!ctx.agentId) { ledger.push(missing("broll", "no agents.id to walk the stock cascade with")); break }
        const reasons: string[] = []
        const clips = await safe(() => d.pickBroll(svc, { brokerageId: ctx.brokerageId, agentId: ctx.agentId as string }), [], (e) => reasons.push(e.message))
        if (clips.length > 0) {
          patch.brollClips = clips
          if (!props.brollSource) patch.brollSource = "stock"
          ledger.push({ kind: "broll", status: "reused", source: "video_assets", count: clips.length, urls: clips.map((c) => c.url), assetIds: [] })
        } else ledger.push(missing("broll", `no b_roll / neighborhood clip in the agent → team → brokerage library${reasons.length ? ` — ${reasons.join("; ")}` : ""}`))
        break
      }
      case "stat_cards": case "chart_data": case "client_footage": {
        const a = assetsFromProps(props, { compositionId })
        const n = req.kind === "stat_cards" ? (a.statCards ?? 0) : req.kind === "client_footage" ? (a.clientFootage ?? 0) : (a.chartData ? 1 : 0)
        ledger.push(n > 0 ? { kind: req.kind, status: "reused", source: "staged_props", count: n, urls: [], assetIds: [] } : missing(req.kind, "no fact / recording staged for it"))
        break
      }
      case "brand_logo": {
        const brand = (props.brand ?? {}) as Record<string, unknown>
        const logo = typeof brand.logoUrl === "string" && brand.logoUrl ? brand.logoUrl : typeof props.logoUrl === "string" && props.logoUrl ? props.logoUrl : null
        ledger.push(logo ? { kind: "brand_logo", status: "reused", source: "brand_cascade", count: 1, urls: [logo], assetIds: [] } : missing("brand_logo", "the brand cascade has no logo — the brand card shows the brokerage name"))
        break
      }
      case "music": case "bookend_stock": {
        if (ctx.probeFinish === false) break
        if (!ctx.agentId) { ledger.push(missing(req.kind, "no agents.id to walk the stock cascade with")); break }
        const reasons: string[] = []
        const cats = req.kind === "music" ? ["music"] : await (async () => {
          const c = await safe(() => d.stockCategories(compositionId), { intro: null, outro: null }, (e) => reasons.push(e.message))
          return [c.intro, c.outro].filter((x): x is string => !!x)
        })()
        if (cats.length === 0) { ledger.push(missing(req.kind, `the registry names no stock category for ${compositionId}${reasons.length ? ` — ${reasons.join("; ")}` : ""}`)); break }
        const hits: Array<{ id: string; url: string }> = []
        for (const category of cats) {
          const hit = await safe(() => d.pickStock(svc, { brokerageId: ctx.brokerageId, agentId: ctx.agentId as string, category, mood: req.kind === "music" ? ctx.musicMood ?? null : null }), null, (e) => reasons.push(e.message))
          if (hit) hits.push(hit)
        }
        ledger.push(hits.length > 0
          ? { kind: req.kind, status: "reused", source: "video_assets", count: hits.length, urls: hits.map((h) => h.url), assetIds: hits.map((h) => h.id) }
          : missing(req.kind, `no ${cats.join("/")} track in the agent → team → brokerage stock library${reasons.length ? ` — ${reasons.join("; ")}` : ""}`))
        break
      }
    }
  }
  return { ledger, propsPatch: patch }
}

// ─────────────────────────────────────────────────────────────────────────────
// § THE ONE CALL every autonomous producer makes before dispatch
// ─────────────────────────────────────────────────────────────────────────────

export interface ReadyPlanArgs {
  svc: Svc
  compositionId: string
  props: Record<string, unknown>
  avatarClip: boolean
  script?: string | null
  segments?: ScriptSegment[] | null
  purpose?: VideoPurpose | null
  overrides?: readonly BodyVisualRuleOverride[] | null
  ctx: ReadinessContext
  deps?: ReadinessDeps
}

export type ReadyPlanResult =
  | { ok: true; plan: BodyVisualPlan; props: Record<string, unknown>; propsPatch: Record<string, unknown>; stamp: AssetReadinessStamp }
  | { ok: false; reason: string; violations: string[]; stamp: AssetReadinessStamp }

/**
 * READ THE PLAN → CHECK THE BUCKETS → CREATE WHAT IS MISSING → RE-STAGE →
 * RECORD THE DEGRADATIONS → GATE. The returned props carry every reused or
 * created asset under the key the composition reads.
 */
export async function readyVisualPlanForDispatch(args: ReadyPlanArgs): Promise<ReadyPlanResult> {
  const { compositionId, ctx } = args
  const emptyStamp = readinessStamp(null, null, [], [])
  if (!COMPOSITION_TREATMENTS[compositionId]) {
    return { ok: false, reason: `body visual could not be planned for ${compositionId}: no COMPOSITION_TREATMENTS row`, violations: ["body_visual_unplanned"], stamp: emptyStamp }
  }
  const stageArgs = { compositionId, avatarClip: args.avatarClip, script: args.script ?? null, segments: args.segments ?? null, purpose: args.purpose ?? null, overrides: args.overrides ?? null }
  const now = assetsFromProps(args.props, { avatarClip: args.avatarClip, compositionId })
  const wanted = stageBodyVisualPlan({ ...stageArgs, props: args.props, assets: wishfulInventory(now, ctx) })
  if (!wanted.ok) return { ok: false, reason: `body visual could not be planned for ${compositionId}: ${wanted.reason}`, violations: ["body_visual_unplanned"], stamp: emptyStamp }
  const finish = finishForCut(finishForVideo(compositionId), ctx.cut)
  const requirements = requirementsFromPlan(wanted.plan, finish)
  let resolved: ResolveResult
  try {
    resolved = await resolvePlanAssets(args.svc, compositionId, args.props, requirements, ctx, args.deps)
  } catch (e) {
    // FAIL CLOSED: an unrunnable resolver reuses nothing and creates nothing; the
    // plan degrades on the staged props and the reason is recorded.
    resolved = { ledger: requirements.map((r) => missing(r.kind, `asset resolution failed: ${(e as Error).message}`)), propsPatch: {} }
  }
  const props = { ...args.props, ...resolved.propsPatch }
  const final = stageBodyVisualPlan({ ...stageArgs, props })
  if (!final.ok) return { ok: false, reason: `body visual could not be planned for ${compositionId}: ${final.reason}`, violations: ["body_visual_unplanned"], stamp: readinessStamp(wanted.plan, null, resolved.ledger, []) }
  const degradations = degradationsBetween(wanted.plan, final.plan, resolved.ledger)
  const stamp = readinessStamp(wanted.plan, final.plan, resolved.ledger, degradations)
  const gate = gateVisualPlanForDispatch(final.plan, assetsFromProps(props, { avatarClip: args.avatarClip, compositionId }), { overrides: args.overrides ?? null })
  if (!gate.ok) return { ok: false, reason: gate.reason, violations: ["body_visual_unplanned", ...gate.missing], stamp }
  return { ok: true, plan: final.plan, props, propsPatch: resolved.propsPatch, stamp }
}
