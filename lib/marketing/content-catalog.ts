// lib/marketing/content-catalog.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CONTENT AND CHANNEL COMMAND CENTER — ONE READ / INDEX over the canonical content records (wave 154, lane 154G2;
// directive G7, owner ruling R8). It is NOT a storage engine: it never writes, never copies media bytes and never
// mints a parallel record. Every row it returns names the REAL table and id it came from, and every action it offers
// names the EXISTING canonical writer (CATALOG_ACTION_WRITERS) that the session-gated door in
// lib/marketing/campaign-registry.ts (runContentCommandAction) calls. Survivors it reads and does not replace:
//   · lib/marketing/campaign-registry.ts  getCampaignRegistry (7 tables; this index is its superset — the registry's
//     `ContentSourceTable` union stays the set registerCampaignSource can link into marketing_assets)
//   · lib/kernel/egress-scope.ts          resolveEgressScopeForViewer + scopeFilter (who sees what: own / team / office / brokerage)
//   · lib/kernel/video-coordination.ts    the Asset Manager → Campaign Orchestrator hand-off a playable render needs
//   · lib/kernel/media-intelligence.ts    rightsVerdict (the one rights judge for marketing_assets)
//   · lib/auth/deal-work-ownership.ts     loadDealWorkAccess (a secured deal document appears only as a checked LINK)
//   · content_topic_uses / marketing_assets.source_table — the topic → artifact provenance that already exists
// FIELD RULE: a field with no source is null and the UI renders "unknown" — never a default, never 0.
// Pure helpers + DB-injected readers: the caller supplies the client (service client AFTER the session gate).

import type { SupabaseClient } from "@supabase/supabase-js"
import { resolveEgressScopeForViewer, describeScope, type EgressScope } from "@/lib/kernel/egress-scope"
import { BROKERAGE_FINANCE_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"

type Db = SupabaseClient<any, any, any>
type Row = Record<string, any>

// ─── STATUS — honest and distinct; a ready draft is never "sent" ─────────────

export type CatalogStatus =
  | "unconfigured" | "blocked_by_rights" | "draft" | "awaiting_approval" | "ready" | "queued"
  | "accepted" | "delivered" | "posted" | "failed" | "rejected" | "cancelled" | "outcome_unknown"

const STATUS_LABEL: Record<CatalogStatus, string> = {
  unconfigured: "Not set up", blocked_by_rights: "Blocked by rights", draft: "Draft", awaiting_approval: "Awaiting approval",
  ready: "Ready (not sent)", queued: "Queued / in progress", accepted: "Accepted by provider (no delivery receipt)",
  delivered: "Delivered", posted: "Posted", failed: "Failed", rejected: "Rejected", cancelled: "Cancelled / retired",
  outcome_unknown: "Outcome unknown",
}

export type CatalogFamily = "idea" | "text" | "email" | "social" | "web" | "print" | "video" | "audio" | "book" | "report" | "campaign" | "journey" | "qr" | "document"

interface Mapped {
  title: string | null
  artifactType: string
  channels: string[]
  status: CatalogStatus
  rawStatus: string | null
  preview?: string | null
  thumbnailUrl?: string | null
  scheduledAt?: string | null
  campaignId?: string | null
  contactId?: string | null
  listingId?: string | null
  transactionId?: string | null
  creatorUserId?: string | null
  creatorAgentId?: string | null
  teamId?: string | null
  visibility?: string | null
  audience?: string | null
  brandVoice?: string | null
  rights?: unknown
  origin?: { table: string; id: string } | null
  destinationUrls?: string[]
  receipts?: Array<{ kind: string; ref: string | null; at: string | null }>
  engagement?: Record<string, number> | null
  costUsd?: number | null
  qrCodeId?: string | null
  playableUrl?: string | null
  link?: string | null
  secured?: boolean
}

export interface CatalogSource {
  table: string
  family: CatalogFamily
  /** null ⇒ the row carries no owner column; `ownerless` decides who may see it. */
  owner: { column: string; kind: "agent" | "user" } | null
  ownerless?: "tenant_shared" | "admin_only"
  teamColumn?: string
  visibilityColumn?: string
  orderColumn: string
  campaignColumn?: string
  contactColumn?: string
  columns: string[]
  map: (r: Row) => Mapped
}

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null)
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const clip = (v: unknown, max = 220): string | null => { const t = s(v); return t ? (t.length > max ? t.slice(0, max - 1) + "…" : t) : null }
/** Only MEASURED numbers become engagement; an empty object is null (unknown), never zeros. */
function metrics(pairs: Record<string, unknown>): Record<string, number> | null {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(pairs)) { const x = n(v); if (x !== null) out[k] = x }
  return Object.keys(out).length ? out : null
}
function jsonMetrics(v: unknown): Record<string, number> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? metrics(v as Record<string, unknown>) : null
}
const receipt = (kind: string, ref: unknown, at: unknown) => (s(ref) || s(at) ? [{ kind, ref: s(ref), at: s(at) }] : [])
function approval(a: unknown, fallback: CatalogStatus): CatalogStatus {
  if (a === "pending" || a === "pending_review") return "awaiting_approval"
  if (a === "rejected") return "rejected"
  if (a === "approved") return "ready"
  return fallback
}

// ─── THE SOURCES — every column is checked against scripts/schema-snapshot.ts by the guard ────────────────────
export const CONTENT_CATALOG_SOURCES: readonly CatalogSource[] = [
  { table: "content_topic_bank", family: "idea", owner: null, ownerless: "tenant_shared", orderColumn: "scraped_at",
    columns: ["id", "topic_title", "value_angle", "status", "categories", "source_url", "scraped_at", "expires_at", "engagement_score", "performance_score", "raw_data"],
    map: (r) => ({ title: s(r.topic_title), artifactType: "topic", channels: ["idea"], rawStatus: s(r.status),
      status: r.status === "fresh" || r.status === "used" ? "ready" : r.status === "rejected" ? "rejected" : r.status === "stale" ? "cancelled" : "outcome_unknown",
      preview: clip(r.value_angle), destinationUrls: s(r.source_url) ? [r.source_url] : [], engagement: metrics({ engagement_score: r.engagement_score, performance_score: r.performance_score }),
      rights: r.raw_data && typeof r.raw_data === "object" ? (r.raw_data as Row).rights ?? null : null, link: "/dashboard/marketing/content-intel" }) },
  { table: "competitor_content", family: "idea", owner: null, ownerless: "tenant_shared", orderColumn: "observed_at",
    columns: ["id", "platform", "content_type", "caption", "content_url", "observed_at", "is_high_performing", "engagement_rate", "detected_topics"],
    // IDEAS ONLY (R3/R4): the competitor's own wording is never the catalog title — the platform + type is.
    map: (r) => ({ title: `Competitor idea · ${s(r.platform) ?? "unknown platform"} ${s(r.content_type) ?? ""}`.trim(), artifactType: "refurbish_origin", channels: ["idea"],
      rawStatus: null, status: "ready", destinationUrls: s(r.content_url) ? [r.content_url] : [], engagement: metrics({ engagement_rate: r.engagement_rate }),
      rights: { basis: "idea_only_reworded" }, link: "/dashboard/marketing/competitors" }) },
  { table: "ai_video_projects", family: "video", owner: { column: "agent_id", kind: "agent" }, orderColumn: "created_at", campaignColumn: "marketing_campaign_id", contactColumn: "contact_id",
    columns: ["id", "agent_id", "title", "status", "approval_status", "video_type", "video_url", "thumbnail_url", "script_content", "contact_id", "listing_id", "marketing_campaign_id", "error_message", "is_published", "published_at", "audience_type", "brand_voice_context", "view_count", "provider_job_id", "created_at"],
    map: (r) => {
      const playable = r.status === "completed" || r.status === "published" ? s(r.video_url) : null
      let status: CatalogStatus
      if (r.status === "failed") status = "failed"
      else if (r.status === "awaiting_presenter_setup") status = "unconfigured"
      else if (r.status === "queued" || r.status === "generating") status = "queued"
      else if (r.status === "draft" || r.status === "scripting" || r.status === "script_ready") status = "draft"
      else if (r.status === "published" || r.is_published === true || r.approval_status === "published") status = playable ? "posted" : "outcome_unknown"
      else if (r.status === "completed") status = !playable ? "outcome_unknown" : approval(r.approval_status, "ready")
      else status = "outcome_unknown"
      return { title: s(r.title), artifactType: r.video_type === "avatar_explainer" ? "avatar_video" : `video${s(r.video_type) ? `:${r.video_type}` : ""}`, channels: r.contact_id ? ["email_1to1"] : ["social", "email", "web"],
        status, rawStatus: [s(r.status), s(r.approval_status)].filter(Boolean).join(" / ") || null, preview: clip(r.script_content ?? r.error_message), thumbnailUrl: s(r.thumbnail_url),
        campaignId: s(r.marketing_campaign_id), contactId: s(r.contact_id), listingId: s(r.listing_id), creatorAgentId: s(r.agent_id), audience: s(r.audience_type),
        brandVoice: r.brand_voice_context ? (typeof r.brand_voice_context === "string" ? r.brand_voice_context : "recorded") : null,
        receipts: [...receipt("provider_job", r.provider_job_id, null), ...receipt("published", null, r.published_at)], engagement: metrics({ views: r.view_count }),
        playableUrl: playable, link: "/dashboard/marketing/video-staging" }
    } },
  { table: "remotion_composition_renders", family: "video", owner: { column: "agent_user_id", kind: "user" }, orderColumn: "created_at",
    columns: ["id", "agent_user_id", "composition_id", "render_status", "output_url", "thumbnail_url", "error_message", "is_published", "published_at", "entity_type", "entity_id", "created_at"],
    map: (r) => ({ title: `${s(r.composition_id) ?? "Remotion"} render`, artifactType: "remotion_render", channels: ["social", "web"], rawStatus: s(r.render_status),
      status: r.render_status === "failed" ? "failed" : r.render_status === "cancelled" ? "cancelled" : r.render_status === "succeeded" ? (s(r.output_url) ? (r.is_published ? "posted" : "ready") : "outcome_unknown") : r.render_status === "queued" || r.render_status === "rendering" ? "queued" : "outcome_unknown",
      thumbnailUrl: s(r.thumbnail_url), preview: clip(r.error_message), creatorUserId: s(r.agent_user_id), origin: s(r.entity_type) && s(r.entity_id) ? { table: r.entity_type, id: r.entity_id } : null,
      playableUrl: r.render_status === "succeeded" ? s(r.output_url) : null, receipts: receipt("published", null, r.published_at) }) },
  { table: "video_snippets", family: "video", owner: { column: "created_by", kind: "user" }, orderColumn: "created_at",
    columns: ["id", "created_by", "snippet_title", "approval_status", "platform_target", "thumbnail_url", "video_url", "caption_text", "video_project_id", "created_at"],
    map: (r) => ({ title: s(r.snippet_title), artifactType: "clip", channels: s(r.platform_target) ? [r.platform_target] : ["social"], rawStatus: s(r.approval_status),
      status: approval(r.approval_status, "draft"), thumbnailUrl: s(r.thumbnail_url), preview: clip(r.caption_text), creatorUserId: s(r.created_by),
      origin: s(r.video_project_id) ? { table: "ai_video_projects", id: r.video_project_id } : null, playableUrl: s(r.video_url) }) },
  { table: "video_scripts_library", family: "text", owner: { column: "agent_id", kind: "agent" }, orderColumn: "created_at", contactColumn: "contact_id",
    columns: ["id", "agent_id", "title", "approval_status", "script_type", "script_content", "brand_voice_tone", "contact_id", "listing_id", "created_at"],
    map: (r) => ({ title: s(r.title), artifactType: `script${s(r.script_type) ? `:${r.script_type}` : ""}`, channels: ["video", "voice"], rawStatus: s(r.approval_status),
      status: approval(r.approval_status, "draft"), preview: clip(r.script_content), creatorAgentId: s(r.agent_id), brandVoice: s(r.brand_voice_tone), contactId: s(r.contact_id), listingId: s(r.listing_id) }) },
  { table: "social_posts", family: "social", owner: { column: "agent_id", kind: "agent" }, orderColumn: "created_at", campaignColumn: "marketing_campaign_id",
    columns: ["id", "agent_id", "user_id", "content", "platform", "post_type", "status", "approval_status", "scheduled_for", "published_at", "external_post_id", "engagement_data", "media_urls", "marketing_campaign_id", "listing_id", "error_message", "social_account_id", "created_at"],
    map: (r) => {
      let status: CatalogStatus
      if (r.status === "failed") status = "failed"
      else if (r.status === "cancelled") status = "cancelled"
      // POSTED needs the platform's receipt; a row marked published with no external id is an unproven claim.
      else if (r.status === "published") status = s(r.external_post_id) ? "posted" : "outcome_unknown"
      else if (r.status === "publishing") status = "queued"
      else if (r.status === "scheduled") status = r.approval_status === "approved" ? (s(r.social_account_id) ? "queued" : "unconfigured") : approval(r.approval_status, "awaiting_approval")
      else if (r.status === "draft") status = approval(r.approval_status, "draft")
      else status = "outcome_unknown"
      const media = Array.isArray(r.media_urls) ? (r.media_urls as unknown[]).filter((u): u is string => typeof u === "string") : []
      return { title: clip(r.content, 90), artifactType: `social_post${s(r.post_type) ? `:${r.post_type}` : ""}`, channels: s(r.platform) ? [r.platform] : [], status,
        rawStatus: [s(r.status), s(r.approval_status)].filter(Boolean).join(" / ") || null, preview: clip(r.content), thumbnailUrl: media[0] ?? null, scheduledAt: s(r.scheduled_for),
        campaignId: s(r.marketing_campaign_id), listingId: s(r.listing_id), creatorAgentId: s(r.agent_id), creatorUserId: s(r.user_id),
        receipts: receipt("platform_post", r.external_post_id, r.published_at), engagement: jsonMetrics(r.engagement_data), link: "/dashboard/social" }
    } },
  { table: "email_campaigns", family: "email", owner: { column: "created_by", kind: "user" }, orderColumn: "created_at", campaignColumn: "marketing_campaign_id",
    columns: ["id", "created_by", "campaign_name", "subject_line", "status", "approval_status", "send_date", "sent_at", "delivered_count", "recipient_count", "open_rate", "click_rate", "marketing_campaign_id", "created_at"],
    map: (r) => ({ title: s(r.campaign_name) ?? s(r.subject_line), artifactType: "email_campaign", channels: ["email"], rawStatus: [s(r.status), s(r.approval_status)].filter(Boolean).join(" / ") || null,
      status: r.status === "failed" ? "failed" : r.status === "cancelled" ? "cancelled" : r.status === "scheduled" || r.status === "sending" ? "queued" : r.status === "paused" ? "ready"
        : r.status === "sent" ? ((n(r.delivered_count) ?? 0) > 0 ? "delivered" : "accepted") : r.status === "draft" ? approval(r.approval_status, "draft") : "outcome_unknown",
      preview: clip(r.subject_line), scheduledAt: s(r.send_date), campaignId: s(r.marketing_campaign_id), creatorUserId: s(r.created_by),
      receipts: receipt("sent", null, r.sent_at), engagement: metrics({ delivered: r.delivered_count, recipients: r.recipient_count, open_rate: r.open_rate, click_rate: r.click_rate }) }) },
  { table: "newsletter_campaigns", family: "email", owner: { column: "created_by", kind: "user" }, orderColumn: "created_at", campaignColumn: "marketing_campaign_id",
    columns: ["id", "created_by", "campaign_name", "subject_line", "status", "approval_status", "send_date", "open_rate", "click_rate", "marketing_campaign_id", "created_at"],
    map: (r) => ({ title: s(r.campaign_name) ?? s(r.subject_line), artifactType: "newsletter", channels: ["email"], rawStatus: [s(r.status), s(r.approval_status)].filter(Boolean).join(" / ") || null,
      status: r.status === "scheduled" || r.status === "sending" ? "queued" : r.status === "sent" ? "accepted" : r.status === "draft" || r.status === "deferred" ? approval(r.approval_status, "draft") : "outcome_unknown",
      preview: clip(r.subject_line), scheduledAt: s(r.send_date), campaignId: s(r.marketing_campaign_id), creatorUserId: s(r.created_by),
      engagement: metrics({ open_rate: r.open_rate, click_rate: r.click_rate }), link: "/dashboard/marketing/studio?tab=newsletters" }) },
  { table: "direct_mail_campaigns", family: "print", owner: { column: "created_by", kind: "user" }, orderColumn: "created_at", campaignColumn: "marketing_campaign_id", contactColumn: "contact_id",
    columns: ["id", "created_by", "agent_id", "campaign_name", "status", "approval_status", "mail_format", "piece_type", "design_url", "proof_url", "proof_status", "copy_text", "qr_code_id", "lob_order_id", "mailing_date", "pieces_mailed", "per_piece_cost", "quantity", "contact_id", "marketing_campaign_id", "bundle_dispatch_id", "created_at"],
    map: (r) => ({ title: s(r.campaign_name), artifactType: `mail:${s(r.mail_format) ?? s(r.piece_type) ?? "piece"}`, channels: ["direct_mail"], rawStatus: [s(r.status), s(r.proof_status)].filter(Boolean).join(" / ") || null,
      // "mailed" is handed to the carrier — not a delivery receipt.
      status: r.status === "failed" ? "failed" : r.status === "cancelled" ? "cancelled" : r.status === "mailed" ? "accepted" : r.status === "printed" ? "queued" : r.status === "approved" ? "ready" : r.status === "planning" ? approval(r.approval_status, "draft") : "outcome_unknown",
      preview: clip(r.copy_text), thumbnailUrl: s(r.proof_url) ?? s(r.design_url), scheduledAt: s(r.mailing_date), campaignId: s(r.marketing_campaign_id), contactId: s(r.contact_id),
      creatorUserId: s(r.created_by), creatorAgentId: s(r.agent_id), qrCodeId: s(r.qr_code_id),
      costUsd: n(r.per_piece_cost) !== null && n(r.pieces_mailed) !== null ? Math.round(r.per_piece_cost * r.pieces_mailed * 100) / 100 : null,
      receipts: receipt("print_order", r.lob_order_id, null), engagement: metrics({ pieces_mailed: r.pieces_mailed }), link: "/dashboard/marketing/studio?tab=mail" }) },
  { table: "blog_posts", family: "web", owner: { column: "agent_user_id", kind: "user" }, teamColumn: "team_id", visibilityColumn: "visibility_scope", orderColumn: "created_at", campaignColumn: "marketing_campaign_id",
    columns: ["id", "agent_user_id", "team_id", "visibility_scope", "title", "excerpt", "publish_status", "approval_status", "published_at", "slug", "featured_image_url", "wordpress_post_id", "view_count_total", "share_count_total", "seo_score", "marketing_campaign_id", "created_at"],
    map: (r) => ({ title: s(r.title), artifactType: "blog_post", channels: ["web", "seo"], rawStatus: s(r.publish_status),
      status: r.publish_status === "published" ? "posted" : r.publish_status === "scheduled" ? "queued" : r.publish_status === "approved" ? "ready" : r.publish_status === "pending_review" ? "awaiting_approval" : r.publish_status === "rejected" ? "rejected" : r.publish_status === "archived" ? "cancelled" : r.publish_status === "draft" ? "draft" : "outcome_unknown",
      preview: clip(r.excerpt), thumbnailUrl: s(r.featured_image_url), campaignId: s(r.marketing_campaign_id), creatorUserId: s(r.agent_user_id), teamId: s(r.team_id), visibility: s(r.visibility_scope),
      destinationUrls: s(r.slug) ? [`/blog/${r.slug}`] : [], receipts: [...receipt("wordpress", r.wordpress_post_id, null), ...receipt("published", null, r.published_at)],
      engagement: metrics({ views: r.view_count_total, shares: r.share_count_total, seo_score: r.seo_score }), link: "/dashboard/marketing/blog" }) },
  { table: "podcast_episodes", family: "audio", owner: { column: "agent_id", kind: "agent" }, orderColumn: "created_at", campaignColumn: "marketing_campaign_id",
    columns: ["id", "agent_id", "title", "description", "status", "approval_status", "audio_url", "scheduled_at", "published_at", "publish_channels", "source_video_project_id", "error_message", "marketing_campaign_id", "created_at"],
    map: (r) => ({ title: s(r.title), artifactType: "podcast_episode", channels: Array.isArray(r.publish_channels) && r.publish_channels.length ? r.publish_channels : ["podcast"], rawStatus: [s(r.status), s(r.approval_status)].filter(Boolean).join(" / ") || null,
      status: r.status === "failed" ? "failed" : r.status === "published" ? "posted" : r.status === "scheduled" || r.status === "generating" || r.status === "processing" ? "queued" : r.status === "completed" ? (s(r.audio_url) ? approval(r.approval_status, "ready") : "outcome_unknown") : r.status === "draft" ? "draft" : "outcome_unknown",
      preview: clip(r.description ?? r.error_message), scheduledAt: s(r.scheduled_at), campaignId: s(r.marketing_campaign_id), creatorAgentId: s(r.agent_id),
      origin: s(r.source_video_project_id) ? { table: "ai_video_projects", id: r.source_video_project_id } : null, receipts: receipt("published", null, r.published_at), playableUrl: s(r.audio_url), link: "/dashboard/marketing/podcast" }) },
  { table: "marketing_assets", family: "print", owner: { column: "agent_user_id", kind: "user" }, teamColumn: "team_id", visibilityColumn: "visibility_scope", orderColumn: "created_at", campaignColumn: "campaign_id", contactColumn: "contact_id",
    columns: ["id", "agent_user_id", "team_id", "visibility_scope", "asset_type", "asset_name", "approval_status", "asset_url", "thumbnail_url", "preview_text", "campaign_id", "contact_id", "listing_id", "source_table", "source_id", "rights", "audience", "brand", "purpose", "regen_status", "cost_usd", "generation_model", "performance", "variants", "created_at"],
    map: (r) => ({ title: s(r.asset_name), artifactType: `asset:${s(r.asset_type) ?? "unknown"}`, channels: s(r.purpose) ? [r.purpose] : [], rawStatus: [s(r.approval_status), s(r.regen_status)].filter(Boolean).join(" / ") || null,
      status: r.regen_status === "failed" ? "failed" : r.regen_status === "processing" || r.regen_status === "requested" ? "queued" : approval(r.approval_status, "draft"),
      preview: clip(r.preview_text), thumbnailUrl: s(r.thumbnail_url) ?? (s(r.asset_type) === "image" || s(r.asset_type) === "graphic" ? s(r.asset_url) : null),
      campaignId: s(r.campaign_id), contactId: s(r.contact_id), listingId: s(r.listing_id), creatorUserId: s(r.agent_user_id), teamId: s(r.team_id), visibility: s(r.visibility_scope),
      audience: typeof r.audience === "string" ? r.audience : r.audience ? JSON.stringify(r.audience) : null, brandVoice: r.brand ? (typeof r.brand === "string" ? r.brand : "recorded") : null, rights: r.rights ?? null,
      origin: s(r.source_table) && s(r.source_id) ? { table: r.source_table, id: r.source_id } : null, costUsd: n(r.cost_usd), engagement: jsonMetrics(r.performance), link: "/dashboard/marketing/studio?tab=assets" }) },
  { table: "repurposed_content_log", family: "social", owner: { column: "created_by", kind: "user" }, orderColumn: "created_at",
    columns: ["id", "created_by", "output_type", "platform_target", "status", "approval_status", "source_type", "source_id", "output_ref_table", "output_ref_id", "notes", "created_at"],
    map: (r) => ({ title: `${s(r.output_type) ?? "Variant"}${s(r.platform_target) ? ` · ${r.platform_target}` : ""}`, artifactType: "refurbish_variant", channels: s(r.platform_target) ? [r.platform_target] : [],
      rawStatus: [s(r.status), s(r.approval_status)].filter(Boolean).join(" / ") || null,
      status: r.status === "failed" ? "failed" : r.status === "published" ? "posted" : r.status === "scheduled" ? "queued" : r.status === "generated" ? approval(r.approval_status, "draft") : "outcome_unknown",
      preview: clip(r.notes), creatorUserId: s(r.created_by), origin: s(r.source_id) ? { table: s(r.source_type) ?? "unknown", id: r.source_id } : null, link: "/dashboard/marketing/studio?tab=lab" }) },
  { table: "campaign_bundles", family: "campaign", owner: { column: "created_by", kind: "user" }, orderColumn: "created_at",
    columns: ["id", "created_by", "name", "description", "is_active", "scope_type", "scope_id", "created_at"],
    map: (r) => ({ title: s(r.name), artifactType: "campaign_bundle", channels: ["multi_channel"], rawStatus: r.is_active === true ? "active" : r.is_active === false ? "inactive" : null,
      status: r.is_active === true ? "ready" : r.is_active === false ? "cancelled" : "outcome_unknown", preview: clip(r.description), creatorUserId: s(r.created_by), link: "/dashboard/marketing/studio?tab=omnichannel" }) },
  { table: "lifetime_customer_touchpoints", family: "journey", owner: { column: "agent_id", kind: "agent" }, orderColumn: "created_at", contactColumn: "contact_id",
    columns: ["id", "agent_id", "contact_id", "touchpoint_type", "channel", "status", "scheduled_date", "sent_date", "engagement_data", "created_at"],
    map: (r) => ({ title: `${s(r.touchpoint_type) ?? "Touchpoint"}`.replace(/_/g, " "), artifactType: `lifetime:${s(r.touchpoint_type) ?? "touchpoint"}`, channels: s(r.channel) ? [r.channel] : [], rawStatus: s(r.status),
      status: r.status === "delivered" ? "delivered" : r.status === "sent" ? "accepted" : r.status === "scheduled" ? "queued" : r.status === "pending_review" ? "awaiting_approval" : r.status === "failed" ? "failed" : r.status === "cancelled" || r.status === "skipped" ? "cancelled" : "outcome_unknown",
      scheduledAt: s(r.scheduled_date), contactId: s(r.contact_id), creatorAgentId: s(r.agent_id), receipts: receipt("sent", null, r.sent_date), engagement: jsonMetrics(r.engagement_data) }) },
  { table: "lead_magnet_deliverables", family: "document", owner: null, ownerless: "admin_only", orderColumn: "created_at",
    columns: ["id", "kind", "title", "status", "asset_url", "version", "produced_at", "created_at"],
    map: (r) => ({ title: s(r.title), artifactType: `lead_magnet:${s(r.kind) ?? "deliverable"}`, channels: ["web", "email"], rawStatus: s(r.status),
      status: r.status === "ready" ? "ready" : r.status === "staged" ? "awaiting_approval" : r.status === "producing" ? "queued" : r.status === "failed" ? "failed" : r.status === "superseded" ? "cancelled" : "outcome_unknown",
      receipts: receipt("produced", null, r.produced_at), link: "/dashboard/marketing/lead-magnets" }) },
  { table: "book_projects", family: "book", owner: { column: "agent_id", kind: "agent" }, teamColumn: "team_id", orderColumn: "created_at",
    columns: ["id", "agent_id", "team_id", "title", "stage", "audience", "publication_context", "created_at"],
    map: (r) => ({ title: s(r.title), artifactType: `book${s(r.publication_context) ? `:${r.publication_context}` : ""}`, channels: ["print", "web"], rawStatus: s(r.stage),
      status: r.stage === "ready_for_review" ? "awaiting_approval" : s(r.stage) ? "draft" : "outcome_unknown", creatorAgentId: s(r.agent_id), teamId: s(r.team_id), audience: s(r.audience) }) },
  { table: "listing_landing_pages", family: "web", owner: null, ownerless: "tenant_shared", orderColumn: "created_at",
    columns: ["id", "listing_id", "slug", "status", "view_count", "lead_count", "created_at"],
    map: (r) => ({ title: s(r.slug) ? `Landing page /${r.slug}` : "Listing landing page", artifactType: "landing_page", channels: ["web", "seo"], rawStatus: s(r.status),
      status: r.status === "published" ? "posted" : r.status === "pending" ? "awaiting_approval" : r.status === "archived" ? "cancelled" : r.status === "draft" ? "draft" : "outcome_unknown",
      listingId: s(r.listing_id), destinationUrls: s(r.slug) ? [`/l/${r.slug}`] : [], engagement: metrics({ views: r.view_count, leads: r.lead_count }) }) },
  { table: "neighborhood_reports", family: "report", owner: null, ownerless: "tenant_shared", orderColumn: "generated_at",
    columns: ["id", "neighborhood_name", "city", "state", "zip_code", "data_source", "generated_at", "expires_at", "ai_summary"],
    map: (r) => ({ title: `Market report · ${[s(r.neighborhood_name), s(r.city), s(r.state)].filter(Boolean).join(", ") || "area"}`, artifactType: "market_report", channels: ["email", "web", "print"],
      rawStatus: null, status: "ready", preview: clip(r.ai_summary), rights: s(r.data_source) ? { source: r.data_source } : null }) },
  { table: "qr_codes", family: "qr", owner: { column: "created_by_user_id", kind: "user" }, orderColumn: "created_at", campaignColumn: "marketing_campaign_id",
    columns: ["id", "created_by_user_id", "agent_id", "slug", "label", "purpose", "target_url", "destination_type", "is_active", "retired_at", "expires_at", "scan_count", "lead_count", "destination_history", "marketing_campaign_id", "created_at"],
    map: (r) => ({ title: s(r.label) ?? `QR /${s(r.slug) ?? "?"}`, artifactType: `qr:${s(r.purpose) ?? "general"}`, channels: ["print", "qr"], rawStatus: r.retired_at ? "retired" : r.is_active === false ? "paused" : "active",
      status: r.retired_at ? "cancelled" : r.is_active === false ? "draft" : s(r.target_url) ? "ready" : "unconfigured",
      campaignId: s(r.marketing_campaign_id), creatorUserId: s(r.created_by_user_id), creatorAgentId: s(r.agent_id), destinationUrls: s(r.target_url) ? [r.target_url] : [],
      engagement: metrics({ scans: r.scan_count, leads: r.lead_count }), qrCodeId: s(r.id), link: "/dashboard/marketing/studio?tab=qr" }) },
  { table: "agent_client_messages", family: "email", owner: null, ownerless: "admin_only", orderColumn: "created_at", contactColumn: "recipient_contact_id",
    columns: ["id", "channel", "subject", "status", "audience", "recipient_contact_id", "entity_type", "entity_id", "rationale", "provider_message_id", "sent_at", "sent_confirmed_at", "send_error", "created_at"],
    map: (r) => ({ title: s(r.subject) ?? "Personal message", artifactType: `personal_${s(r.channel) ?? "message"}`, channels: s(r.channel) ? [r.channel] : [], rawStatus: s(r.status),
      status: r.status === "proposed" ? "awaiting_approval" : r.status === "approved" ? "queued" : r.status === "sent" ? (s(r.sent_confirmed_at) ? "delivered" : "accepted") : r.status === "failed" ? "failed" : r.status === "rejected" ? "rejected" : "outcome_unknown",
      preview: clip(r.rationale ?? r.send_error), contactId: s(r.recipient_contact_id), audience: s(r.audience),
      origin: s(r.entity_type) && s(r.entity_id) ? { table: r.entity_type === "video_project" ? "ai_video_projects" : r.entity_type, id: r.entity_id } : null,
      receipts: receipt("provider_message", r.provider_message_id, r.sent_confirmed_at ?? r.sent_at), link: "/dashboard/admin/command-center" }) },
  { table: "ai_message_drafts", family: "text", owner: { column: "agent_user_id", kind: "user" }, orderColumn: "created_at", contactColumn: "contact_id",
    columns: ["id", "agent_user_id", "channel", "draft_subject", "status", "contact_id", "conversation_id", "trigger_event", "sent_message_id", "created_at"],
    map: (r) => ({ title: s(r.draft_subject) ?? `Reply draft${s(r.trigger_event) ? ` · ${r.trigger_event}` : ""}`, artifactType: `draft:${s(r.channel) ?? "message"}`, channels: s(r.channel) ? [r.channel] : [], rawStatus: s(r.status),
      status: r.status === "pending" ? "awaiting_approval" : r.status === "accepted" || r.status === "edited" ? "ready" : r.status === "sent" ? "accepted" : r.status === "dismissed" ? "rejected" : "outcome_unknown",
      contactId: s(r.contact_id), creatorUserId: s(r.agent_user_id), receipts: receipt("message", r.sent_message_id, null), origin: s(r.conversation_id) ? { table: "conversations", id: r.conversation_id } : null }) },
  // SECURED DOCUMENTS (G7.1 last paragraph): a deal document keeps its own storage, signing, retention and visibility. The
  // catalog selects NO blob column — it can only ever show a permission-checked LINK to the deal page (loadDealWorkAccess).
  { table: "generated_documents", family: "document", owner: { column: "agent_id", kind: "agent" }, orderColumn: "created_at",
    columns: ["id", "agent_id", "document_type", "transaction_id", "listing_id", "created_at"],
    map: (r) => ({ title: `${s(r.document_type) ?? "Document"}`.replace(/_/g, " "), artifactType: `secured_document:${s(r.document_type) ?? "document"}`, channels: [], rawStatus: null, status: "ready",
      creatorAgentId: s(r.agent_id), transactionId: s(r.transaction_id), listingId: s(r.listing_id), secured: true,
      link: s(r.transaction_id) ? `/dashboard/transactions/${r.transaction_id}` : s(r.listing_id) ? `/dashboard/listings/${r.listing_id}` : null }) },
]

/** content_topic_uses.asset_type (its live CHECK) → the table that asset id lives in; null = no catalog table (stated, not guessed). */
export const TOPIC_USE_ASSET_TABLE: Record<string, string | null> = {
  blog_post: "blog_posts", direct_mail_postcard: "direct_mail_campaigns", newsletter_campaign: "newsletter_campaigns", podcast_episode: "podcast_episodes",
  situational_reel: "ai_video_projects", social_post: "social_posts", newsletter_video: null, ctv_ad: null, marketing_plan_item: null,
}

// ─── THE VIEWER — the session decides; scope from the ONE egress resolver ─────

export interface CatalogViewer {
  userId: string
  brokerageId: string
  userType: string
  scope: EgressScope
  scopeLabel: string
  /** null ⇒ every seat in the tenant (brokerage scope). */
  memberUserIds: string[] | null
  memberAgentIds: string[] | null
  teamIds: string[]
  seesProviderCost: boolean
  refusal: string | null
}

export async function resolveCatalogViewer(db: Db, who: { userId: string; brokerageId: string; userType: string }): Promise<CatalogViewer> {
  const { data: me, error: meErr } = await db.from("users").select("id, team_id, location_id").eq("id", who.userId).eq("brokerage_id", who.brokerageId).maybeSingle()
  const meRow = (me ?? null) as { team_id: string | null; location_id: string | null } | null
  const { scope, refusal: scopeRefusal } = await resolveEgressScopeForViewer(db as any, {
    userType: who.userType, userId: who.userId, brokerageId: who.brokerageId, teamId: meRow?.team_id ?? null, locationId: meRow?.location_id ?? null,
  })
  const base = { ...who, scope, scopeLabel: describeScope(scope), seesProviderCost: false, teamIds: [] as string[] }
  const own = async (refusal: string | null): Promise<CatalogViewer> => {
    const { data: ag } = await db.from("agents").select("id").eq("user_id", who.userId).eq("brokerage_id", who.brokerageId)
    return { ...base, memberUserIds: [who.userId], memberAgentIds: ((ag ?? []) as Array<{ id: string }>).map((a) => a.id), refusal }
  }
  // FAIL CLOSED (§4): an unreadable identity row narrows to the viewer's own work and says so.
  if (meErr || !meRow) return own(`showing your own work only — your seat could not be read (${meErr?.message ?? "no seat row in this workspace"})`)
  if (scope.kind === "brokerage") {
    return { ...base, memberUserIds: null, memberAgentIds: null, seesProviderCost: BROKERAGE_FINANCE_ADMIN_USER_TYPES.has(who.userType), refusal: scopeRefusal }
  }
  if (scope.kind === "agent") return own(scopeRefusal)
  const teamIds = scope.kind === "team" ? (scope.teamIds?.length ? scope.teamIds : scope.teamId ? [scope.teamId] : []) : (scope.teamIds ?? [])
  const locationIds = scope.kind === "location" ? (scope.locationIds?.length ? scope.locationIds : scope.locationId ? [scope.locationId] : []) : []
  const userIds = new Set<string>([who.userId])
  const agentIds = new Set<string>()
  const reads: Array<PromiseLike<{ data: unknown; error: { message: string } | null }>> = []
  if (teamIds.length) {
    reads.push(db.from("users").select("id").eq("brokerage_id", who.brokerageId).in("team_id", teamIds))
    reads.push(db.from("agents").select("id, user_id").eq("brokerage_id", who.brokerageId).in("team_id", teamIds))
  }
  if (locationIds.length) {
    reads.push(db.from("users").select("id").eq("brokerage_id", who.brokerageId).in("location_id", locationIds))
    reads.push(db.from("agents").select("id, user_id").eq("brokerage_id", who.brokerageId).in("location_id", locationIds))
  }
  for (const r of await Promise.all(reads)) {
    if (r.error) return own(`showing your own work only — your ${scope.kind === "team" ? "team" : "offices"} could not be read (${r.error.message})`)
    for (const x of (r.data ?? []) as Array<{ id: string; user_id?: string | null }>) {
      if ("user_id" in x) { agentIds.add(x.id); if (x.user_id) userIds.add(x.user_id) } else userIds.add(x.id)
    }
  }
  const { data: ag2, error: agErr } = await db.from("agents").select("id").eq("brokerage_id", who.brokerageId).in("user_id", [...userIds])
  if (agErr) return own(`showing your own work only — the seats in your scope could not be read (${agErr.message})`)
  for (const a of (ag2 ?? []) as Array<{ id: string }>) agentIds.add(a.id)
  return { ...base, teamIds, memberUserIds: [...userIds], memberAgentIds: [...agentIds], refusal: scopeRefusal }
}

// ─── THE CATALOG ROW ──────────────────────────────────────────────────────────

export type CatalogActionKind =
  | "approve" | "reject" | "publish" | "create_variant" | "route_omnipresence" | "route_refurbish" | "send_personal_email"
  | "assign_task" | "render_avatar_clip" | "prepare_direct_mail" | "release_direct_mail" | "hold_research"
  | "accept_proposal" | "decline_proposal" | "change_qr_destination"

/** The EXISTING canonical writers — the guard proves campaign-registry's door imports exactly these. */
export const CATALOG_ACTION_WRITERS = {
  approve_asset: { module: "app/actions/marketing-studio.ts", exportName: "approveAsset" },
  reject_asset: { module: "app/actions/marketing-studio.ts", exportName: "rejectAsset" },
  create_topic_asset: { module: "app/actions/marketing-studio.ts", exportName: "createAsset" },
  approve_social: { module: "app/actions/social-media-automation.ts", exportName: "approveSocialPost" },
  reject_social: { module: "app/actions/social-media-automation.ts", exportName: "rejectSocialPost" },
  approve_video: { module: "app/dashboard/marketing/video-staging/actions.ts", exportName: "approveStagedVideoAction" },
  approve_queue: { module: "app/actions/command-center.ts", exportName: "approveAgentAction" },
  reject_queue: { module: "app/actions/command-center.ts", exportName: "rejectAgentAction" },
  publish_blog: { module: "app/actions/blog.ts", exportName: "publishBlogPost" },
  publish_podcast: { module: "app/actions/podcast-generation.ts", exportName: "publishPodcastEpisode" },
  release_direct_mail: { module: "app/actions/direct-mail.ts", exportName: "sendCampaign" },
  prepare_direct_mail: { module: "app/actions/direct-mail.ts", exportName: "createMailCampaign" },
  render_avatar_clip: { module: "app/actions/custom-video.ts", exportName: "createDescribedVideoAction" },
  route_refurbish: { module: "lib/repurpose/actions.ts", exportName: "refurbishCompetitorIdea" },
  route_omnipresence: { module: "lib/repurpose/actions.ts", exportName: "createRepurposePipeline" },
  route_omnipresence_run: { module: "lib/repurpose/actions.ts", exportName: "executePipeline" },
  assign_task: { module: "app/actions/tasks.ts", exportName: "createTask" },
  change_qr_destination: { module: "lib/marketing/qr-governance.ts", exportName: "editQrDestination" },
} as const
export type CatalogWriterId = keyof typeof CATALOG_ACTION_WRITERS

/** The Command Center decision door admits exactly these seats (app/actions/command-center.ts requireApprover — the guard
 *  holds this list equal to that literal, so an offered button is never one the writer always refuses). */
const COMMAND_CENTER_APPROVER_TYPES: ReadonlySet<string> = new Set(["admin", "broker", "broker_owner"])

export interface CatalogDecision { source: string; what: string; at: string | null; by: string | null; outcome: string | null; reason: string | null }
export interface CatalogNextAction {
  manager: string | null; action: string; why: string | null; trigger: string | null; audience: string | null
  dueAt: string | null; status: string; ref: { table: string; id: string }
  /** a proposal the Command Center door can accept or decline */
  door: { queue: "marketing" | "asset" | "client_message"; actionId: string } | null
}
export interface CatalogQrLink { qrCodeId: string; slug: string | null; targetUrl: string | null; active: boolean; version: number | null; scans: number | null }
export interface CatalogDependency { kind: string; ref: string | null; satisfied: boolean; note: string }
export interface OfferedAction { kind: CatalogActionKind; label: string; writer: CatalogWriterId }

export interface CatalogRow {
  key: string
  sourceType: string
  sourceId: string
  family: CatalogFamily
  tenantId: string
  creatorUserId: string | null
  creatorAgentId: string | null
  teamId: string | null
  visibility: string | null
  brandVoice: string | null
  audience: string | null
  title: string
  artifactType: string
  channels: string[]
  status: CatalogStatus
  statusLabel: string
  rawStatus: string | null
  preview: string | null
  thumbnailUrl: string | null
  scheduledAt: string | null
  createdAt: string | null
  campaign: { id: string; name: string | null } | null
  recipientContactId: string | null
  listingId: string | null
  topics: Array<{ id: string; title: string | null }>
  origin: { table: string; id: string } | null
  rights: unknown
  rightsVerdict: string | null
  dependencies: CatalogDependency[]
  destinationUrls: string[]
  qrLinks: CatalogQrLink[]
  receipts: Array<{ kind: string; ref: string | null; at: string | null }>
  providerCostUsd: number | null
  providerCostVisibility: "shown" | "restricted" | "unknown"
  engagement: Record<string, number> | null
  attributedResults: Record<string, number> | null
  /** a playable render handed from the Asset Manager to the Campaign Orchestrator (video only; null = not a video) */
  sendable: boolean | null
  lastDecision: CatalogDecision | null
  nextAction: CatalogNextAction | null
  link: string | null
  secured: boolean
  actions: OfferedAction[]
  blocked: Array<{ kind: CatalogActionKind; reason: string }>
}

export interface CatalogFilters {
  sourceType?: string | null
  sourceId?: string | null
  search?: string | null
  status?: CatalogStatus | null
  channel?: string | null
  family?: CatalogFamily | null
  campaignId?: string | null
  contactId?: string | null
  topicId?: string | null
  creatorUserId?: string | null
  hasResult?: boolean | null
  perSourceLimit?: number
}

export interface CatalogRead { ok: boolean; rows: CatalogRow[]; scopeLabel: string; refusal: string | null; unreadable: Array<{ table: string; error: string }>; perSourceLimit: number }

const chunk = <T,>(xs: T[], size = 100): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size)); return out }
const uniq = (xs: Array<string | null | undefined>): string[] => [...new Set(xs.filter((x): x is string => !!x))]

async function readIn(db: Db, table: string, cols: string, brokerageId: string, col: string, ids: string[], extra?: (q: any) => any): Promise<{ rows: Row[]; error: string | null }> {
  const rows: Row[] = []
  for (const part of chunk(ids)) {
    let q: any = db.from(table).select(cols).eq("brokerage_id", brokerageId).in(col, part)
    if (extra) q = extra(q)
    const { data, error } = await q
    if (error) return { rows, error: error.message }
    rows.push(...((data ?? []) as Row[]))
  }
  return { rows, error: null }
}

/** THE ONE READER. Tenant from the viewer (resolved from the session by the caller); scope from the egress resolver. */
export async function readContentCatalog(db: Db, viewer: CatalogViewer, filters: CatalogFilters = {}): Promise<CatalogRead> {
  const B = viewer.brokerageId
  const perSourceLimit = Math.min(Math.max(filters.perSourceLimit ?? 60, 1), 200)
  const unreadable: Array<{ table: string; error: string }> = []
  const tenantWide = viewer.memberUserIds === null
  const base: Array<{ src: CatalogSource; r: Row; m: Mapped }> = []

  for (const src of CONTENT_CATALOG_SOURCES) {
    if (filters.sourceType && filters.sourceType !== src.table) continue
    if (filters.family && filters.family !== src.family) continue
    let q: any = db.from(src.table).select(src.columns.join(", ")).eq("brokerage_id", B)
    if (!tenantWide) {
      if (!src.owner) {
        if (src.ownerless !== "tenant_shared") continue
      } else {
        const ids = src.owner.kind === "agent" ? viewer.memberAgentIds ?? [] : viewer.memberUserIds ?? []
        const terms: string[] = []
        if (ids.length) terms.push(`${src.owner.column}.in.(${ids.join(",")})`)
        if (src.visibilityColumn) terms.push(`${src.visibilityColumn}.eq.brokerage`)
        if (src.teamColumn && viewer.teamIds.length) terms.push(`${src.teamColumn}.in.(${viewer.teamIds.join(",")})`)
        if (!terms.length) continue
        q = q.or(terms.join(","))
      }
    }
    if (filters.sourceId) q = q.eq("id", filters.sourceId)
    if (filters.campaignId) { if (!src.campaignColumn) continue; q = q.eq(src.campaignColumn, filters.campaignId) }
    if (filters.contactId) { if (!src.contactColumn) continue; q = q.eq(src.contactColumn, filters.contactId) }
    const { data, error } = await q.order(src.orderColumn, { ascending: false }).limit(perSourceLimit)
    if (error) { unreadable.push({ table: src.table, error: error.message }); continue }
    for (const r of (data ?? []) as Row[]) base.push({ src, r, m: src.map(r) })
  }

  const idsOf = (table: string) => base.filter((b) => b.src.table === table).map((b) => String(b.r.id))
  const allIds = uniq(base.map((b) => String(b.r.id)))

  // ── topics: content_topic_uses + marketing_assets.source_table — the provenance that already exists ──
  const topicByAsset = new Map<string, Set<string>>()
  const linkTopic = (table: string, id: string, topicId: string) => { const k = `${table}:${id}`; if (!topicByAsset.has(k)) topicByAsset.set(k, new Set()); topicByAsset.get(k)!.add(topicId) }
  if (allIds.length) {
    const uses = await readIn(db, "content_topic_uses", "topic_id, asset_id, asset_type", B, "asset_id", allIds)
    if (uses.error) unreadable.push({ table: "content_topic_uses", error: uses.error })
    for (const u of uses.rows) { const t = TOPIC_USE_ASSET_TABLE[String(u.asset_type)]; if (t && u.topic_id && u.asset_id) linkTopic(t, String(u.asset_id), String(u.topic_id)) }
  }
  for (const b of base) if (b.src.table === "marketing_assets" && b.r.source_table === "content_topic_bank" && s(b.r.source_id)) linkTopic("marketing_assets", String(b.r.id), b.r.source_id)
  for (const b of base) if (b.src.table === "content_topic_bank") linkTopic("content_topic_bank", String(b.r.id), String(b.r.id))
  const topicIds = uniq([...topicByAsset.values()].flatMap((x) => [...x]))
  const topicTitle = new Map<string, string | null>(base.filter((b) => b.src.table === "content_topic_bank").map((b) => [String(b.r.id), s(b.r.topic_title)]))
  const missingTopics = topicIds.filter((t) => !topicTitle.has(t))
  if (missingTopics.length) {
    const t = await readIn(db, "content_topic_bank", "id, topic_title", B, "id", missingTopics)
    if (t.error) unreadable.push({ table: "content_topic_bank", error: t.error })
    for (const x of t.rows) topicTitle.set(String(x.id), s(x.topic_title))
  }

  // ── campaigns, attributed results ──
  const campaignIds = uniq(base.map((b) => b.m.campaignId))
  const campaignName = new Map<string, string | null>()
  const roiByCampaign = new Map<string, Record<string, number> | null>()
  if (campaignIds.length) {
    const c = await readIn(db, "marketing_campaigns", "id, campaign_name", B, "id", campaignIds)
    if (c.error) unreadable.push({ table: "marketing_campaigns", error: c.error })
    for (const x of c.rows) campaignName.set(String(x.id), s(x.campaign_name))
    const roi = await readIn(db, "campaign_roi", "marketing_campaign_id, total_leads, qualified_leads, total_conversions, total_revenue, roi_percentage", B, "marketing_campaign_id", campaignIds)
    if (roi.error) unreadable.push({ table: "campaign_roi", error: roi.error })
    for (const x of roi.rows) roiByCampaign.set(String(x.marketing_campaign_id), metrics({ leads: x.total_leads, qualified_leads: x.qualified_leads, conversions: x.total_conversions, revenue: x.total_revenue, roi_percentage: x.roi_percentage }))
  }

  // ── QR links: marketing_asset_qr_links + direct_mail_campaigns.qr_code_id + the qr row itself ──
  const qrByAsset = new Map<string, string[]>()
  const assetIds = idsOf("marketing_assets")
  if (assetIds.length) {
    const l = await readIn(db, "marketing_asset_qr_links", "marketing_asset_id, qr_code_id", B, "marketing_asset_id", assetIds)
    if (l.error) unreadable.push({ table: "marketing_asset_qr_links", error: l.error })
    for (const x of l.rows) qrByAsset.set(`marketing_assets:${x.marketing_asset_id}`, [...(qrByAsset.get(`marketing_assets:${x.marketing_asset_id}`) ?? []), String(x.qr_code_id)])
  }
  for (const b of base) if (b.m.qrCodeId) qrByAsset.set(`${b.src.table}:${b.r.id}`, uniq([...(qrByAsset.get(`${b.src.table}:${b.r.id}`) ?? []), b.m.qrCodeId]))
  const qrIds = uniq([...qrByAsset.values()].flat())
  const qrRow = new Map<string, Row>()
  if (qrIds.length) {
    const q = await readIn(db, "qr_codes", "id, slug, target_url, is_active, retired_at, expires_at, destination_history, scan_count", B, "id", qrIds)
    if (q.error) unreadable.push({ table: "qr_codes", error: q.error })
    for (const x of q.rows) qrRow.set(String(x.id), x)
  }

  // ── decisions + proposals: manager_signals, the action ledger, client-message proposals, manager action queues ──
  const signals = allIds.length ? await readIn(db, "manager_signals", "id, from_manager, to_manager, signal_type, message, entity_id, status, consumed_action, consumed_at, created_at, payload", B, "entity_id", allIds) : { rows: [], error: null }
  if (signals.error) unreadable.push({ table: "manager_signals", error: signals.error })
  const ledger = allIds.length ? await readIn(db, "agent_action_ledger", "subject_id, action, status, outcome, reason_code, actor_manager_key, actor_user_id, provider, cost_usd, created_at, detail", B, "subject_id", allIds) : { rows: [], error: null }
  if (ledger.error) unreadable.push({ table: "agent_action_ledger", error: ledger.error })
  const messages = allIds.length ? await readIn(db, "agent_client_messages", "id, entity_id, status, channel, audience, rationale, proposed_at, recipient_contact_id", B, "entity_id", allIds) : { rows: [], error: null }
  if (messages.error) unreadable.push({ table: "agent_client_messages", error: messages.error })
  const proposals: Array<{ table: "marketing_agent_actions" | "asset_manager_actions"; queue: "marketing" | "asset"; manager: string; row: Row }> = []
  for (const [table, queue, manager] of [["marketing_agent_actions", "marketing", "marketing_agent"], ["asset_manager_actions", "asset", "asset_manager"]] as const) {
    const { data, error } = await db.from(table).select("id, action_type, action_input, rationale, status, proposed_at").eq("brokerage_id", B).eq("status", "proposed").order("proposed_at", { ascending: false }).limit(200)
    if (error) { unreadable.push({ table, error: error.message }); continue }
    for (const row of (data ?? []) as Row[]) proposals.push({ table, queue, manager, row })
  }
  const proposalFor = (id: string) => proposals.find((p) => p.row.action_input && typeof p.row.action_input === "object" && Object.values(p.row.action_input as Row).some((v) => v === id))
  const publishLog = idsOf("social_posts").length ? await readIn(db, "social_publish_log", "social_post_id, publish_status, external_post_id, published_at, error_message", B, "social_post_id", idsOf("social_posts")) : { rows: [], error: null }
  if (publishLog.error) unreadable.push({ table: "social_publish_log", error: publishLog.error })

  // ── secured documents: the existing deal-access predicate decides; a refusal or an unreadable check hides the row ──
  const dealRead = new Map<string, boolean>()
  const txIds = uniq(base.filter((b) => b.m.secured && b.m.transactionId).map((b) => b.m.transactionId)).slice(0, 25)
  if (txIds.length) {
    const { loadDealWorkAccess } = await import("@/lib/auth/deal-work-ownership")
    for (const tx of txIds) {
      const a = await loadDealWorkAccess(db as any, { userId: viewer.userId, brokerageId: B, userType: viewer.userType, transactionId: tx })
      dealRead.set(tx, a.ok && a.access.capabilities.read)
    }
  }
  const needsRights = base.some((b) => b.src.table === "marketing_assets")
  const rightsVerdict = needsRights ? (await import("@/lib/kernel/media-intelligence")).rightsVerdict : null

  const rows: CatalogRow[] = []
  for (const { src, r, m } of base) {
    const id = String(r.id)
    const key = `${src.table}:${id}`
    if (m.secured && (!m.transactionId || !dealRead.get(m.transactionId))) {
      // a non-deal document stays visible only to its own agent's scope (already applied); a deal document needs read access
      if (m.transactionId) continue
    }
    const topics = [...(topicByAsset.get(key) ?? [])].map((t) => ({ id: t, title: topicTitle.get(t) ?? null }))
    const qrLinks: CatalogQrLink[] = (qrByAsset.get(key) ?? []).map((qid) => {
      const q = qrRow.get(qid)
      return { qrCodeId: qid, slug: s(q?.slug), targetUrl: s(q?.target_url), active: !!q && q.is_active !== false && !q.retired_at && !(s(q.expires_at) && q.expires_at < new Date().toISOString()),
        version: Array.isArray(q?.destination_history) ? q!.destination_history.length || 1 : q ? 1 : null, scans: n(q?.scan_count) }
    })
    const mySignals = signals.rows.filter((x) => String(x.entity_id) === id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    const myLedger = ledger.rows.filter((x) => String(x.subject_id) === id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    const myMessages = messages.rows.filter((x) => String(x.entity_id) === id)
    const myLog = src.table === "social_posts" ? publishLog.rows.filter((x) => String(x.social_post_id) === id) : []

    // RIGHTS — the one judge; an asset that fails it is BLOCKED, whatever its approval says.
    let status = m.status
    let verdict: string | null = null
    if (src.table === "marketing_assets" && rightsVerdict && r.rights) {
      const v = rightsVerdict(r.rights, r.generation_model)
      verdict = v.ok ? "ok" : v.reason
      if (!v.ok && status !== "failed") status = "blocked_by_rights"
    }
    // a social post's publish log is its receipt; a failed log entry is a real failure
    if (myLog.some((x) => x.publish_status === "published" && s(x.external_post_id))) status = "posted"
    else if (myLog.length && myLog.every((x) => x.publish_status === "failed") && status === "queued") status = "failed"

    const dependencies: CatalogDependency[] = []
    for (const ql of qrLinks) dependencies.push({ kind: "qr_destination", ref: ql.qrCodeId, satisfied: ql.active && !!ql.targetUrl, note: ql.active && ql.targetUrl ? `prints /qr/${ql.slug ?? "?"} → ${ql.targetUrl}` : "the QR code this piece prints is missing, paused, retired or has no destination" })
    let sendable: boolean | null = null
    if (src.family === "video" && src.table === "ai_video_projects") {
      const handoff = mySignals.find((x) => x.from_manager === "asset_manager" && x.to_manager === "campaign_orchestrator" && ["video_ready", "contact_outreach_ready", "lead_outreach_ready"].includes(String(x.signal_type)))
      sendable = !!m.playableUrl && !!handoff
      dependencies.push({ kind: "playable_render", ref: id, satisfied: !!m.playableUrl, note: m.playableUrl ? "the render finished and has a playable file" : status === "failed" ? "the render FAILED — nothing to send" : "the render has not produced a playable file" })
      dependencies.push({ kind: "asset_to_campaign_handoff", ref: handoff ? String(handoff.id) : null, satisfied: !!handoff, note: handoff ? `Asset Manager → Campaign Orchestrator: ${handoff.signal_type}` : "the Asset Manager has not handed this render to the Campaign Orchestrator" })
    }

    const led = myLedger[0]
    const sig = mySignals[0]
    const lastDecision: CatalogDecision | null = led
      ? { source: "agent_action_ledger", what: String(led.action), at: s(led.created_at), by: s(led.actor_manager_key) ?? s(led.actor_user_id), outcome: s(led.outcome) ?? s(led.status), reason: s(led.reason_code) }
      : sig ? { source: "manager_signals", what: String(sig.signal_type), at: s(sig.consumed_at) ?? s(sig.created_at), by: s(sig.from_manager), outcome: sig.status === "consumed" ? s(sig.consumed_action) ?? "consumed" : s(sig.status), reason: clip(sig.message, 160) }
      : null
    const openMsg = myMessages.find((x) => x.status === "proposed")
    const prop = proposalFor(id)
    const openSig = mySignals.find((x) => x.status === "open")
    const nextAction: CatalogNextAction | null = openMsg
      ? { manager: "campaign_orchestrator", action: `propose personal ${s(openMsg.channel) ?? "message"}`, why: clip(openMsg.rationale, 200), trigger: sig ? String(sig.signal_type) : null, audience: s(openMsg.audience), dueAt: null, status: "proposed", ref: { table: "agent_client_messages", id: String(openMsg.id) }, door: { queue: "client_message", actionId: String(openMsg.id) } }
      : prop ? { manager: prop.manager, action: String(prop.row.action_type), why: clip(prop.row.rationale, 200), trigger: String(prop.row.action_type), audience: null, dueAt: null, status: "proposed", ref: { table: prop.table, id: String(prop.row.id) }, door: { queue: prop.queue, actionId: String(prop.row.id) } }
      : openSig ? { manager: s(openSig.to_manager), action: String(openSig.signal_type), why: clip(openSig.message, 200), trigger: String(openSig.signal_type), audience: null, dueAt: null, status: "open", ref: { table: "manager_signals", id: String(openSig.id) }, door: null }
      : m.scheduledAt && (status === "queued" || status === "ready") ? { manager: null, action: "scheduled delivery", why: null, trigger: "schedule", audience: null, dueAt: m.scheduledAt, status: "scheduled", ref: { table: src.table, id }, door: null }
      : null

    const cost = m.costUsd ?? (led ? n(led.cost_usd) : null)
    const row: CatalogRow = {
      key, sourceType: src.table, sourceId: id, family: src.family, tenantId: B,
      creatorUserId: m.creatorUserId ?? null, creatorAgentId: m.creatorAgentId ?? null, teamId: m.teamId ?? null, visibility: m.visibility ?? (src.owner ? "owner" : src.ownerless ?? null),
      brandVoice: m.brandVoice ?? null, audience: m.audience ?? null, title: m.title ?? "(untitled)", artifactType: m.artifactType, channels: m.channels,
      status, statusLabel: STATUS_LABEL[status], rawStatus: m.rawStatus, preview: m.preview ?? null, thumbnailUrl: m.thumbnailUrl ?? null, scheduledAt: m.scheduledAt ?? null,
      createdAt: s(r.created_at) ?? s(r[src.orderColumn]),
      campaign: m.campaignId ? { id: m.campaignId, name: campaignName.get(m.campaignId) ?? null } : null,
      recipientContactId: m.contactId ?? null, listingId: m.listingId ?? null, topics, origin: m.origin ?? null, rights: m.rights ?? null, rightsVerdict: verdict, dependencies,
      destinationUrls: m.destinationUrls ?? [], qrLinks,
      receipts: [...(m.receipts ?? []), ...myLog.filter((x) => s(x.external_post_id) || x.publish_status === "failed").map((x) => ({ kind: `publish_log:${x.publish_status}`, ref: s(x.external_post_id), at: s(x.published_at) }))],
      providerCostUsd: viewer.seesProviderCost ? cost : null, providerCostVisibility: !viewer.seesProviderCost ? "restricted" : cost === null ? "unknown" : "shown",
      engagement: m.engagement ?? null, attributedResults: m.campaignId ? roiByCampaign.get(m.campaignId) ?? null : null,
      sendable, lastDecision, nextAction, link: m.link ?? null, secured: !!m.secured, actions: [], blocked: [],
    }
    const offer = offerActions(row, viewer, r)
    row.actions = offer.actions
    row.blocked = offer.blocked
    rows.push(row)
  }

  // ── search + view filters (after the topic join, so a topic's title finds every artifact made from it) ──
  const needle = (filters.search ?? "").trim().toLowerCase()
  const out = rows.filter((x) =>
    (!needle || [x.title, x.preview, x.artifactType, ...x.topics.map((t) => t.title ?? "")].some((f) => (f ?? "").toLowerCase().includes(needle)))
    && (!filters.status || x.status === filters.status)
    && (!filters.channel || x.channels.includes(filters.channel))
    && (!filters.topicId || x.topics.some((t) => t.id === filters.topicId))
    && (!filters.creatorUserId || x.creatorUserId === filters.creatorUserId)
    && (filters.hasResult == null || (filters.hasResult ? !!(x.engagement || x.attributedResults) : !(x.engagement || x.attributedResults))))
  out.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))
  return { ok: unreadable.length === 0, rows: out, scopeLabel: viewer.scopeLabel, refusal: viewer.refusal, unreadable, perSourceLimit }
}

// ─── THE ACTION SURFACE — every offer names its existing writer; a blocked one says why ──────────────────────

function offerActions(row: CatalogRow, viewer: CatalogViewer, r: Row): { actions: OfferedAction[]; blocked: Array<{ kind: CatalogActionKind; reason: string }> } {
  const actions: OfferedAction[] = []
  const blocked: Array<{ kind: CatalogActionKind; reason: string }> = []
  const add = (kind: CatalogActionKind, label: string, writer: CatalogWriterId) => actions.push({ kind, label, writer })
  const approver = COMMAND_CENTER_APPROVER_TYPES.has(viewer.userType)
  if (row.secured) return { actions, blocked }
  if (row.status === "blocked_by_rights") blocked.push({ kind: "approve", reason: `rights: ${row.rightsVerdict ?? "not established"}` })

  switch (row.sourceType) {
    case "content_topic_bank":
      if (row.status === "ready") {
        add("create_variant", "Draft an image from this topic", "create_topic_asset")
        add("render_avatar_clip", "Render an avatar clip", "render_avatar_clip")
        add("prepare_direct_mail", "Prepare a postcard", "prepare_direct_mail")
        add("hold_research", "Hold — research first", "assign_task")
      }
      break
    case "competitor_content":
      add("route_refurbish", "Refurbish into an original piece", "route_refurbish")
      break
    case "marketing_assets":
      if (row.status === "awaiting_approval") { add("approve", "Approve", "approve_asset"); add("reject", "Reject", "reject_asset") }
      break
    case "social_posts":
      if (row.status === "awaiting_approval") { add("approve", "Approve (publishes on schedule)", "approve_social"); add("reject", "Reject", "reject_social") }
      if (row.status === "posted") add("route_omnipresence", "Repurpose across channels", "route_omnipresence")
      break
    case "ai_video_projects":
      if (row.status === "failed") blocked.push({ kind: "send_personal_email", reason: "the render failed — a failed video is never offered as sendable" })
      else if (row.status === "awaiting_approval") add("approve", "Approve render", "approve_video")
      if (row.sendable && row.nextAction?.door?.queue === "client_message" && approver) add("send_personal_email", "Approve & send the personal email", "approve_queue")
      else if (row.status !== "failed" && row.recipientContactId) blocked.push({ kind: "send_personal_email", reason: row.sendable ? "the Campaign Orchestrator has not drafted the personal email yet" : !row.dependencies.find((d) => d.kind === "playable_render")?.satisfied ? "no playable render yet" : "waiting for the Asset Manager → Campaign Orchestrator hand-off" })
      if (row.dependencies.find((d) => d.kind === "playable_render")?.satisfied && (row.status === "ready" || row.status === "posted")) add("route_omnipresence", "Repurpose across channels", "route_omnipresence")
      break
    case "newsletter_campaigns": case "direct_mail_campaigns": case "blog_posts": case "podcast_episodes":
      if (row.status === "awaiting_approval" || (row.sourceType === "direct_mail_campaigns" && row.status === "draft")) {
        if (approver) { add("approve", "Approve", "approve_queue"); add("reject", "Reject", "reject_queue") }
        else blocked.push({ kind: "approve", reason: "approval sits with a broker or admin (the Command Center door)" })
      }
      if (row.sourceType === "blog_posts" && row.status === "ready") add("publish", "Publish", "publish_blog")
      if (row.sourceType === "podcast_episodes" && row.status === "ready") add("publish", "Publish", "publish_podcast")
      if (row.sourceType === "direct_mail_campaigns" && row.status === "ready") {
        const qr = row.dependencies.filter((d) => d.kind === "qr_destination")
        if (r.qr_code_id && (qr.length === 0 || qr.some((d) => !d.satisfied))) blocked.push({ kind: "release_direct_mail", reason: "the QR code this piece prints has no live destination — fix the QR first" })
        else add("release_direct_mail", "Release to print", "release_direct_mail")
      }
      if ((row.sourceType === "blog_posts" || row.sourceType === "podcast_episodes") && row.status === "posted") add("route_omnipresence", "Repurpose across channels", "route_omnipresence")
      break
    case "qr_codes":
      if (row.status !== "cancelled") add("change_qr_destination", "Change where it lands (same printed code)", "change_qr_destination")
      break
  }
  if (row.nextAction?.door && row.nextAction.door.queue !== "client_message") {
    if (approver) { add("accept_proposal", `Accept: ${row.nextAction.action}`, "approve_queue"); add("decline_proposal", "Decide to do nothing", "reject_queue") }
    else blocked.push({ kind: "accept_proposal", reason: "a broker or admin decides manager proposals" })
  }
  if (row.recipientContactId && row.status !== "failed") add("assign_task", "Assign an agent task", "assign_task")
  return { actions, blocked }
}

export type ContentActionInput = { sourceType: string; sourceId: string; action: CatalogActionKind; targetUrl?: string | null; reason?: string | null }
export type ContentActionPlan =
  | { ok: true; writer: CatalogWriterId; args: Record<string, unknown> }
  | { ok: false; error: string }

/** Pure: given a row the VIEWER may see (re-read under the session) and the requested action, the exact writer + its args.
 *  Anything not offered is refused here — the door never trusts the button. */
export function planContentAction(row: CatalogRow | null, input: ContentActionInput): ContentActionPlan {
  if (!row) return { ok: false, error: "That item is not in your workspace (or you can't see it)." }
  const blockedHit = row.blocked.find((b) => b.kind === input.action)
  const offer = row.actions.find((a) => a.kind === input.action)
  if (!offer) return { ok: false, error: blockedHit ? blockedHit.reason : "That action isn't available for this item right now." }
  const id = row.sourceId
  const title = row.title.slice(0, 120)
  switch (offer.writer) {
    case "approve_asset": case "approve_social": case "approve_video": return { ok: true, writer: offer.writer, args: { id } }
    case "reject_asset": case "reject_social": return { ok: true, writer: offer.writer, args: { id, reason: input.reason ?? null } }
    case "approve_queue": case "reject_queue": {
      const door = input.action === "send_personal_email" || input.action === "accept_proposal" || input.action === "decline_proposal" ? row.nextAction?.door : null
      if (door) return { ok: true, writer: offer.writer, args: { queue: door.queue, actionId: door.actionId } }
      const queue = row.sourceType === "newsletter_campaigns" ? "newsletter" : row.sourceType === "direct_mail_campaigns" ? "direct_mail" : row.sourceType === "blog_posts" ? "blog" : row.sourceType === "podcast_episodes" ? "podcast" : null
      return queue ? { ok: true, writer: offer.writer, args: { queue, actionId: id } } : { ok: false, error: "No decision door for this item." }
    }
    case "publish_blog": return { ok: true, writer: offer.writer, args: { postId: id } }
    case "publish_podcast": return { ok: true, writer: offer.writer, args: { episodeId: id, channels: row.channels } }
    case "release_direct_mail": return { ok: true, writer: offer.writer, args: { campaignId: id } }
    case "prepare_direct_mail": return { ok: true, writer: offer.writer, args: { campaignName: `Postcard · ${title}`.slice(0, 120), targetAudience: row.audience ?? "sphere", quantity: 1, copyText: row.preview ?? title } }
    case "render_avatar_clip": return { ok: true, writer: offer.writer, args: { topicId: id, title, audience: row.audience ?? "homeowners and buyers in my market", goal: row.preview ?? title, host: "avatar" } }
    case "create_topic_asset": return { ok: true, writer: offer.writer, args: { assetType: "graphic", assetName: `Image · ${title}`.slice(0, 120), sourceTable: "content_topic_bank", sourceId: id, previewText: row.preview ?? undefined } }
    case "route_refurbish": return { ok: true, writer: offer.writer, args: { competitorContentId: id, outputFormats: ["instagram_carousel", "linkedin_post", "email_snippet"] } }
    case "route_omnipresence": {
      const sourceType = row.sourceType === "ai_video_projects" ? "video_project" : row.sourceType === "blog_posts" ? "blog_post" : row.sourceType === "podcast_episodes" ? "podcast_episode" : row.sourceType === "social_posts" ? "social_post" : null
      return sourceType ? { ok: true, writer: offer.writer, args: { sourceType, sourceId: id, pipelineName: `Omnipresence · ${title}`.slice(0, 120), outputFormats: ["instagram_reels", "linkedin_post", "email_snippet", "google_business_post"] } } : { ok: false, error: "This item can't be repurposed." }
    }
    case "assign_task": return { ok: true, writer: offer.writer, args: { title: (input.action === "hold_research" ? `Research before using: ${title}` : `Follow up: ${title}`).slice(0, 160), contactId: row.recipientContactId ?? undefined, priority: input.action === "hold_research" ? "low" : "medium" } }
    case "change_qr_destination": {
      const target = (input.targetUrl ?? "").trim()
      return target ? { ok: true, writer: offer.writer, args: { qrCodeId: id, targetUrl: target, reason: input.reason ?? null } } : { ok: false, error: "Enter where scanners should land." }
    }
    default: return { ok: false, error: "That action isn't available for this item right now." }
  }
}
