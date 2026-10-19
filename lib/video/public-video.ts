/**
 * lib/video/public-video.ts — WHICH VIDEOS ARE PUBLIC, NON-PERSONAL MARKETING (wave 142, lane 142F).
 *
 * OWNER (2026-10-18): "all videos that are not personal should also be added to youtube";
 * "a landing page should include some type of video".
 *
 * THE ONE CLASSIFICATION. Three lists already describe a video's audience and none of
 * them answers "may this be broadcast publicly?":
 *   · lib/orchestrator/internal.ts handleVideoGenerated `personalVideoTypes` — the
 *     per-contact DRAFT rail (thank_you / personal / buyer_guide / memory_video);
 *   · lib/video/client-video-delivery.ts CLIENT_FACING_VIDEO_TYPES — kinds delivered to
 *     the ONE contact they were made for (market_update is on it when addressed);
 *   · lib/geo/video-landing.ts isAutoPublishEligible — finished + compliance passed +
 *     broker approved + has a file (the /v/[slug] public page gate).
 * This module composes them into the public verdict instead of restating any: a video
 * is PUBLIC MARKETING only when its KIND is a broadcast class (PUBLIC_MARKETING_VIDEO_TYPES,
 * a subset of the live ai_video_projects.video_type CHECK), it is addressed to NOBODY
 * (contact_id null — a client's CMA / equity / welcome / memory film is never public, and
 * `market_update` for a named contact is that contact's), its audience is not in_house,
 * its usage is not MLS-only (the unbranded MLS cut is not marketing), and it passed the
 * same finished + compliance + approval gate the public page uses. The proof
 * (scripts/video-pipeline-truth-guard.ts) holds this set disjoint from the orchestrator's
 * personal list and inside the CHECK vocabulary, so the three cannot drift apart.
 *
 * READERS: lib/video/youtube-publish.ts (auto-publish after approval), app/site/[slug]
 * (the storefront's video slot via pickSiteHeroVideo). The tenant switch is the policy key
 * `video_auto_publish` (TENANT_POLICY_SETTINGS_KEYS — default ON for these classes; an
 * UNREADABLE policy refuses, because an autonomous public broadcast fails closed).
 *
 * Not server-only on purpose: the public site page and the proof import it. No DB
 * client of its own — every reader takes the caller's client (tenant-pinned reads).
 */
import { VIDEO_FINISHED_STATUSES } from "@/lib/video/video-status"

/**
 * The broadcast classes — brokerage / listing marketing that is never about one
 * person. Every value is in ai_video_projects_video_type_check (proof-held).
 * @proofSeam scripts/video-pipeline-truth-guard.ts holds the set inside the CHECK vocabulary and disjoint from the orchestrator's personal list.
 */
export const PUBLIC_MARKETING_VIDEO_TYPES = [
  "agent_intro",
  "coming_soon",
  "just_listed",
  "just_sold",
  "listing_promo",
  "market_update",
  "open_house_promo",
  "social_reel",
  "testimonial",
] as const

const PUBLIC_TYPES = new Set<string>(PUBLIC_MARKETING_VIDEO_TYPES)

interface PublicVideoRow {
  video_type?: string | null
  audience_type?: string | null
  usage_intent?: string | null
  contact_id?: string | null
  approval_status?: string | null
  status?: string | null
  compliance_status?: string | null
  video_url?: string | null
}

type PublicVideoRefusal =
  | "personal_or_client_kind"
  | "addressed_to_a_contact"
  | "in_house_audience"
  | "mls_only_cut"
  | "not_approved"
  | "not_finished"
  | "compliance_not_passed"
  | "not_rendered"

type PublicVideoVerdict =
  | { public: true; privacy: "public" }
  | { public: false; reason: PublicVideoRefusal }

/** PURE. The verdict, and the ONE reason it was refused. */
export function classifyPublicVideo(row: PublicVideoRow): PublicVideoVerdict {
  if (!PUBLIC_TYPES.has(String(row.video_type ?? ""))) return { public: false, reason: "personal_or_client_kind" }
  if (row.contact_id) return { public: false, reason: "addressed_to_a_contact" }
  if (row.audience_type === "in_house") return { public: false, reason: "in_house_audience" }
  if (row.usage_intent === "mls") return { public: false, reason: "mls_only_cut" }
  if (row.approval_status !== "approved" && row.approval_status !== "published") return { public: false, reason: "not_approved" }
  if (!(VIDEO_FINISHED_STATUSES as readonly string[]).includes(String(row.status ?? ""))) return { public: false, reason: "not_finished" }
  if (row.compliance_status !== "passed") return { public: false, reason: "compliance_not_passed" }
  if (!row.video_url || !String(row.video_url).trim()) return { public: false, reason: "not_rendered" }
  return { public: true, privacy: "public" }
}

// ── The tenant switch ─────────────────────────────────────────────────────────

/** brokerage_settings.settings key (registered in lib/kernel/tenant-policy.ts TENANT_POLICY_SETTINGS_KEYS). */
export const VIDEO_AUTO_PUBLISH_POLICY_KEY = "video_auto_publish"

interface VideoAutoPublishPolicy {
  /** Auto-publish approved public marketing classes to the connected YouTube channel. DEFAULT ON. */
  youtube: boolean
  /** False when the settings read was REFUSED — the caller must not publish on a guess. */
  readable: boolean
  reason: string | null
}

/** @proofSeam scripts/video-pipeline-truth-guard.ts asserts the default is ON (owner: default on for non-personal marketing classes). */
export const DEFAULT_VIDEO_AUTO_PUBLISH_POLICY: Readonly<Pick<VideoAutoPublishPolicy, "youtube">> = { youtube: true }

/**
 * Read the tenant's switch. Absent = the default (ON). Unreadable = OFF, with the reason —
 * an autonomous PUBLIC broadcast never runs on a settings read nobody could complete (§4).
 */
export async function readVideoAutoPublishPolicy(svc: any, brokerageId: string): Promise<VideoAutoPublishPolicy> {
  const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { youtube: false, readable: false, reason: `brokerage_settings read refused: ${error.message}` }
  const settings = ((data as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>
  const v = (settings as Record<string, unknown>)[VIDEO_AUTO_PUBLISH_POLICY_KEY]
  if (!v || typeof v !== "object") return { youtube: DEFAULT_VIDEO_AUTO_PUBLISH_POLICY.youtube, readable: true, reason: null }
  const yt = (v as Record<string, unknown>).youtube
  return { youtube: typeof yt === "boolean" ? yt : DEFAULT_VIDEO_AUTO_PUBLISH_POLICY.youtube, readable: true, reason: null }
}

// ── The storefront's video ────────────────────────────────────────────────────

interface SiteHeroVideo {
  projectId: string
  videoUrl: string
  thumbnailUrl: string | null
  title: string
  /** The reel's own public page (/v/<slug>) — the player's fallback link. */
  slug: string
  /**
   * THE READER of the YouTube write-back (lib/video/youtube-publish.ts recordYouTubePublishOnAsset →
   * ai_video_projects.video_metadata.youtube.url): when the reel is on the channel, the storefront's
   * player falls back to a WORKING external player and links "Watch on YouTube". Null until published.
   */
  youtubeUrl: string | null
}

/** video_metadata.youtube.url when it is an https URL (the write-back's own shape), else null. */
function youtubeUrlOf(videoMetadata: unknown): string | null {
  const yt = (videoMetadata as { youtube?: { url?: unknown } } | null | undefined)?.youtube
  const url = yt && typeof yt === "object" ? yt.url : null
  return typeof url === "string" && /^https:\/\/\S+$/.test(url) ? url : null
}

/**
 * The newest PUBLISHED public-marketing reel for a brokerage's website: a row the auto-publish
 * sweep already made public (is_published + public_slug — the /v/[slug] rail) that ALSO passes
 * classifyPublicVideo (a published client video, should one ever exist, never reaches the
 * storefront). Null when the tenant has none — the page then renders NO player (a silent
 * absence, never an empty box or a dead source). Refused reads are null too; the page is a
 * public surface and a storage hiccup must not 500 it.
 */
export async function pickSiteHeroVideo(svc: any, brokerageId: string): Promise<SiteHeroVideo | null> {
  const { data, error } = await svc.from("ai_video_projects")
    .select("id, title, video_type, audience_type, usage_intent, contact_id, approval_status, status, compliance_status, video_url, thumbnail_url, public_slug, published_at, video_metadata")
    .eq("brokerage_id", brokerageId)
    .eq("is_published", true)
    .not("public_slug", "is", null)
    .not("video_url", "is", null)
    .order("published_at", { ascending: false })
    .limit(10)
  if (error || !data) return null
  for (const r of data as Array<PublicVideoRow & { id: string; title: string | null; thumbnail_url: string | null; public_slug: string | null; video_metadata?: unknown }>) {
    if (!classifyPublicVideo(r).public || !r.public_slug || !r.video_url) continue
    return {
      projectId: r.id,
      videoUrl: r.video_url,
      thumbnailUrl: r.thumbnail_url ?? null,
      title: r.title || `${String(r.video_type ?? "video").replace(/_/g, " ")} reel`,
      slug: r.public_slug,
      youtubeUrl: youtubeUrlOf(r.video_metadata),
    }
  }
  return null
}
