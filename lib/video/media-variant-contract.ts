/**
 * lib/video/media-variant-contract.ts — WHICH PLATFORM MAY CARRY THIS MEDIA, AND HOW (wave 155, lane 155G — owner R6 / R9;
 * directive 155G G1). PURE: no I/O, no server-only, so scripts/artifact-production-guard.ts proves it under plain tsx.
 *
 * MEASURED AT BASE d2d6468c:
 *   · lib/repurpose/distribute.ts drafted a post with `media_urls: [project.video_url]` for EVERY connected platform the
 *     repurpose intent named — a horizontal render went to TikTok, a video went to Instagram (whose publisher in this repo
 *     posts an IMAGE container: publishToInstagram → `image_url`), and a connected account's granted permission was never read.
 *   · the publish cron (app/api/cron/publish-social-posts) handed any media URL to any platform; the publisher's pre-flight
 *     (lib/social/publisher.ts validateContentForPlatform) checks only that SOME media is attached — never its KIND — so an
 *     image on TikTok, or a video on Pinterest, reached the provider and failed there (or worse, posted a still as "the video").
 *
 * THE CONTRACT (every fact below is read from the repo, never invented):
 *   · ROUTE — how a VIDEO artifact reaches each platform HERE: TikTok and YouTube have real video publishers (PULL_FROM_URL /
 *     resumable upload) → `api_publish`; Instagram's and Pinterest's publishers post images only → a video is an APPROVED
 *     EXPORT / HANDOFF (a person posts the approved file), never "published" by API. Text platforms are not video routes —
 *     the approved text master already covers them.
 *   · PERMISSION — the scope each route needs is the scope this repo's own connect flow requests (lib/social/oauth-config.ts
 *     SOCIAL_OAUTH_CONFIGS; the guard proves each named scope is in that list). `social_media_accounts.scope` holding the
 *     scope → `granted`; holding a scope list WITHOUT it → REFUSED; NULL → `unverified` (the tenant connect callback does
 *     not store the granted scope yet — Outside-lane request in the lane notes), drafted for a person's approval and labeled,
 *     and the provider remains the final verifier. Not connected / inactive → REFUSED.
 *   · MEDIA — the variant's aspect is the output format's own aspectRatio (lib/repurpose/types.ts OUTPUT_FORMAT_CONFIG; a
 *     vertical feed also takes the square cut, the Director's own rule); a landscape render on a vertical feed is refused (no
 *     crop is invented); an unknown aspect is refused (missing media metadata);
 *     a duration above the format's maxDuration is refused, an unknown duration is labeled, not guessed.
 *   · A SCRIPT OR A FAILED RENDER IS NOT A VIDEO — `playable: false` refuses every route. No dummy thumbnail is ever produced.
 */
import { OUTPUT_FORMAT_CONFIG, type OutputFormat } from "@/lib/repurpose/types"
import type { SocialOAuthProvider } from "@/lib/social/oauth-config"

export type MediaKind = "video" | "image" | "unknown"

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv)$/i
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|heic)$/i

/** PURE. What a hosted media URL IS, from its path (query / fragment ignored). Unknown is never upgraded to a guess. */
export function classifyMediaUrl(url: string | null | undefined): MediaKind {
  const raw = String(url ?? "").trim()
  if (!raw) return "unknown"
  let path = raw
  try { path = new URL(raw).pathname } catch { path = raw.split(/[?#]/)[0] }
  if (VIDEO_EXT.test(path)) return "video"
  if (IMAGE_EXT.test(path)) return "image"
  return "unknown"
}

export type VideoVariantRoute = "api_publish" | "export_handoff"

interface VideoRouteSpec {
  route: VideoVariantRoute
  /** The repurpose output format the variant is cut to (its aspectRatio / maxDuration are the variant's spec). */
  format: OutputFormat
  /** The connect flow that grants the permission (lib/social/oauth-config.ts key). */
  oauthProvider: SocialOAuthProvider
  /** The scope an API publish needs — one of SOCIAL_OAUTH_CONFIGS[oauthProvider].scopes (proven by the guard). */
  requiredScope: string
  why: string
}

/** HOW A VIDEO ARTIFACT REACHES EACH PLATFORM in this repo. A platform absent here has no video route (text or image-only). */
export const VIDEO_VARIANT_ROUTES: Readonly<Record<string, VideoRouteSpec>> = Object.freeze({
  tiktok: { route: "api_publish", format: "tiktok", oauthProvider: "tiktok", requiredScope: "video.publish", why: "publishToTikTok pulls the approved video from its hosted URL (PULL_FROM_URL)" },
  youtube: { route: "api_publish", format: "youtube_shorts", oauthProvider: "youtube", requiredScope: "https://www.googleapis.com/auth/youtube.upload", why: "publishToYouTube uploads the approved file (resumable upload) with an explicit privacy" },
  instagram: { route: "export_handoff", format: "instagram_reels", oauthProvider: "meta", requiredScope: "instagram_content_publish", why: "publishToInstagram posts an IMAGE container (image_url) — there is no Reels upload in this repo, so the approved video is handed off for a person to post" },
})

/** Platforms whose publisher here takes ONLY one media kind (lib/social/publisher.ts: TikTok / YouTube pull a video; Instagram /
 *  Pinterest post an image URL). A post of the wrong kind — or of no media at all — is refused before any provider call. */
const API_MEDIA_KIND: Readonly<Record<string, Exclude<MediaKind, "unknown">>> = Object.freeze({ tiktok: "video", youtube: "video", instagram: "image", pinterest: "image" })

export interface ConnectedAccountFacts {
  isActive: boolean
  /** social_media_accounts.scope — the granted scope list as stored (space- or comma-separated); null = not recorded. */
  scope: string | null
}

export interface RenderedMediaFacts {
  kind: MediaKind
  /** The canonical resolver said READY (lib/video/playable-video.ts resolvePlayableVideo) — a script / failed render is false. */
  playable: boolean
  /** "9:16" / "1:1" / "16:9" (ai_video_projects.format), null = unknown. */
  aspect: string | null
  durationSeconds: number | null
}

export type PlatformVariantVerdict =
  | { ok: true; platform: string; route: VideoVariantRoute; format: OutputFormat; permission: "granted" | "unverified" | "not_needed"; notes: string[]; why: string }
  | { ok: false; platform: string; reason: string }

/** The aspects a format accepts. A vertical-feed format (9:16) also takes the square cut — the Director's own rule
 *  (lib/video/video-director.ts aspectForChannel: "Vertical feeds (TikTok/IG/Shorts) want 9:16 or 1:1"); a landscape cut is not
 *  platform-appropriate there. Any other format takes exactly its own aspect. */
function acceptedAspects(spec: string): string[] {
  return spec === "9:16" ? ["9:16", "1:1"] : [spec]
}

function scopeList(scope: string | null): string[] | null {
  if (scope == null || !String(scope).trim()) return null
  return String(scope).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
}

/** PURE. May THIS rendered video be carried on THIS platform for THIS tenant's connected account — and by which route? */
export function decidePlatformVariant(i: { platform: string; account: ConnectedAccountFacts | null; media: RenderedMediaFacts }): PlatformVariantVerdict {
  const platform = String(i.platform ?? "").toLowerCase()
  const spec = VIDEO_VARIANT_ROUTES[platform]
  if (!spec) return { ok: false, platform, reason: API_MEDIA_KIND[platform] === "image" ? `${platform}'s publisher here posts images only — a still is not the video, and no thumbnail is passed off as one` : `${platform} has no video route here — the approved text master covers it` }
  if (!i.account) return { ok: false, platform, reason: `no ${platform} account is connected for this sender` }
  if (!i.account.isActive) return { ok: false, platform, reason: `the ${platform} connection is inactive` }
  if (!i.media.playable) return { ok: false, platform, reason: "no playable render — a script or a failed render is not a video" }
  if (i.media.kind !== "video") return { ok: false, platform, reason: `the media is ${i.media.kind === "image" ? "an image" : "of unknown kind"}, not a video` }
  const cfg = OUTPUT_FORMAT_CONFIG[spec.format]
  const notes: string[] = []
  if (cfg.aspectRatio && /^\d+:\d+$/.test(cfg.aspectRatio)) {
    const accepts = acceptedAspects(cfg.aspectRatio)
    if (!i.media.aspect) return { ok: false, platform, reason: `the render's aspect is not recorded — ${cfg.displayName} takes ${accepts.join(" or ")} (missing media metadata)` }
    if (!accepts.includes(i.media.aspect)) return { ok: false, platform, reason: `${cfg.displayName} takes ${accepts.join(" or ")}; this render is ${i.media.aspect} — no crop is invented` }
    if (i.media.aspect !== cfg.aspectRatio) notes.push(`a ${i.media.aspect} cut on ${cfg.displayName} (prefers ${cfg.aspectRatio}) — posted as rendered`)
  }
  if (cfg.maxDuration != null) {
    if (i.media.durationSeconds == null) notes.push(`duration not recorded — ${cfg.displayName}'s ${cfg.maxDuration}s limit is checked by the provider`)
    else if (i.media.durationSeconds > cfg.maxDuration) return { ok: false, platform, reason: `${Math.round(i.media.durationSeconds)}s is over ${cfg.displayName}'s ${cfg.maxDuration}s limit` }
  }
  if (spec.route === "export_handoff") return { ok: true, platform, route: spec.route, format: spec.format, permission: "not_needed", notes, why: spec.why }
  const scopes = scopeList(i.account.scope)
  if (scopes == null) return { ok: true, platform, route: spec.route, format: spec.format, permission: "unverified", notes: [...notes, `the granted ${platform} permission is not recorded — drafted for approval; the provider is the final check`], why: spec.why }
  if (!scopes.includes(spec.requiredScope)) return { ok: false, platform, reason: `the ${platform} connection was granted without ${spec.requiredScope} — reconnect to publish video` }
  return { ok: true, platform, route: spec.route, format: spec.format, permission: "granted", notes, why: spec.why }
}

/**
 * PURE. THE EGRESS CHECK the publish cron runs before any provider call: a media platform never receives a text-only post
 * (a text post is never presented as a video or a pin), nor media of the kind its publisher here cannot carry. A URL of
 * unknown kind passes to the provider (it is the final verifier); a URL that is KNOWN to be the wrong kind does not.
 */
export function mediaEgressVerdict(platform: string, mediaUrls: readonly string[] | null | undefined): { ok: true } | { ok: false; reason: string } {
  const p = String(platform ?? "").toLowerCase()
  const want = API_MEDIA_KIND[p]
  if (!want) return { ok: true }
  const urls = (mediaUrls ?? []).filter((u) => String(u ?? "").trim())
  if (!urls.length) return { ok: false, reason: `${p} needs ${want === "video" ? "a rendered video" : "an image"} — a text post is never presented as ${want === "video" ? "a video" : "a pin / photo post"}` }
  const wrong = urls.find((u) => { const k = classifyMediaUrl(u); return k !== "unknown" && k !== want })
  if (wrong) return { ok: false, reason: want === "image" && VIDEO_VARIANT_ROUTES[p]?.route === "export_handoff" ? `${p}'s publisher here posts images only — the approved video is an export / handoff, never published by API` : `${p}'s publisher here carries ${want === "video" ? "video" : "images"}, and this post carries ${want === "video" ? "an image" : "a video"}` }
  return { ok: true }
}
