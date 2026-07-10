/**
 * lib/marketing/social-media-pairing.ts
 *
 * MEDIA ↔ COPY PAIRING for autonomous social (owner rule: nothing ships
 * bare — a caption needs fitting media, media needs a fitting caption).
 * The cadence stager wrote text-only drafts for months; every brand post
 * now carries an image:
 *
 *   1. LIBRARY-FIRST — the newest approved marketing_assets image for the
 *      tenant (carousel hooks, twilight/staged photos, quote graphics are
 *      all prime feed art). Reuse beats regeneration: one render → many
 *      marketing uses is the library's whole thesis.
 *   2. GENERATE as the fallback — a brand-aware gpt-image-1 social image
 *      from the post's topic (the image-gen rail already composites the
 *      logo + the legal attribution band and bakes in the Fair-Housing
 *      constraints), CAPTURED back into the library so tomorrow's post
 *      reuses it instead of paying again.
 *
 * Never throws — a bare-text post is still better than no post, so the
 * caller treats null as "stage without media" (and the approval UI shows
 * the gap to the human).
 */

export type MediaType = "image" | "video"

/**
 * CHANNEL NORMS — the competitor-validated floor (owner rule: every delivery
 * decision is proven — learned from OUR outcomes when we have them, industry-
 * validated defaults when we don't). Video and image are MEDIA TYPES, not
 * channels; each channel prefers one:
 *   instagram — native video (Reels) carries the most organic reach in the
 *     current algorithm; carousels/images win saves. Video-first.
 *   facebook — native video outperforms links/images on reach; video-first.
 *   tiktok / youtube — video-only surfaces.
 *   linkedin — document/image posts outperform video for B2B reach; image-first.
 *   twitter/x — images lift engagement; short video comparable. Image-first.
 *   google_business — photo posts; GBP video support is inconsistent. Image-first.
 *   pinterest — static pins dominate; image-first.
 */
export const CHANNEL_MEDIA_NORMS: Record<string, { prefer: MediaType; videoAllowed: boolean }> = {
  instagram: { prefer: "video", videoAllowed: true },
  facebook: { prefer: "video", videoAllowed: true },
  tiktok: { prefer: "video", videoAllowed: true },
  youtube: { prefer: "video", videoAllowed: true },
  linkedin: { prefer: "image", videoAllowed: true },
  twitter: { prefer: "image", videoAllowed: true },
  x: { prefer: "image", videoAllowed: true },
  google_business: { prefer: "image", videoAllowed: false },
  pinterest: { prefer: "image", videoAllowed: false },
}

/** PURE: tolerant engagement extractor over whatever shape the platform sync
 *  wrote (likes/comments/shares/saves/views/clicks — sum what exists). */
export function engagementScore(data: unknown): number {
  if (!data || typeof data !== "object") return 0
  const d = data as Record<string, unknown>
  const keys = ["likes", "comments", "shares", "saves", "clicks", "reactions", "engagement", "engagement_count", "impressions_engaged"]
  let score = 0
  for (const k of keys) {
    const v = Number(d[k])
    if (Number.isFinite(v) && v > 0) score += v
  }
  // views count at 1% — a view is far cheaper than an interaction
  const views = Number(d.views ?? d.impressions)
  if (Number.isFinite(views) && views > 0) score += views * 0.01
  return score
}

export interface MediaArmSample { mediaType: MediaType; score: number }

/** PURE: the learned-preference decision. Requires a real experiment — at
 *  least 5 published samples per arm — and a >25% mean lift to override the
 *  channel norm; anything weaker returns null (the norm stands). */
export function decideMediaType(samples: MediaArmSample[]): MediaType | null {
  const arm = (t: MediaType) => samples.filter((s) => s.mediaType === t)
  const img = arm("image"), vid = arm("video")
  if (img.length < 5 || vid.length < 5) return null
  const mean = (a: MediaArmSample[]) => a.reduce((s, x) => s + x.score, 0) / a.length
  const mi = mean(img), mv = mean(vid)
  if (mi <= 0 && mv <= 0) return null
  if (mv > mi * 1.25) return "video"
  if (mi > mv * 1.25) return "image"
  return null
}

const VIDEO_EXT = /\.(mp4|mov|webm|m4v)(\?|$)/i

/** Learned preference from the tenant's OWN last-90-day published posts on
 *  this platform. Null = not enough evidence → the channel norm stands. */
export async function learnedMediaPreference(
  svc: any,
  brokerageId: string,
  platform: string,
): Promise<MediaType | null> {
  try {
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString()
    const { data: posts } = await svc.from("social_posts")
      .select("media_urls, engagement_data")
      .eq("brokerage_id", brokerageId).eq("platform", platform)
      .eq("status", "published").gte("published_at", since)
      .not("media_urls", "eq", "{}")
      .limit(300)
    const samples: MediaArmSample[] = []
    for (const p of ((posts ?? []) as Array<{ media_urls: string[] | null; engagement_data: unknown }>)) {
      const first = p.media_urls?.[0]
      if (!first) continue
      samples.push({ mediaType: VIDEO_EXT.test(first) ? "video" : "image", score: engagementScore(p.engagement_data) })
    }
    return decideMediaType(samples)
  } catch {
    return null
  }
}

export interface PairedMedia {
  mediaUrls: string[]
  mediaType: MediaType
  source: "library" | "generated"
  /** How the media-type decision was made — recorded so the flywheel is auditable. */
  decidedBy: "learned" | "channel_norm" | "availability"
  assetId: string | null
}

export async function resolveSocialMedia(
  svc: any,
  params: {
    brokerageId: string
    agentUserId?: string | null
    /** Topic the caption is about — steers both library match and generation. */
    topicTitle?: string | null
    postType?: string | null
    /** Channel the post ships to — drives the image-vs-video decision. */
    platform?: string | null
  },
): Promise<PairedMedia | null> {
  try {
    // 0. THE MEDIA-TYPE DECISION LADDER (proven, never arbitrary):
    //    learned (the tenant's own 90-day engagement, ≥5 samples/arm, >25% lift)
    //    → channel norm (competitor-validated defaults)
    //    → availability (whatever the library actually has).
    const platform = (params.platform ?? "").toLowerCase()
    const norm = CHANNEL_MEDIA_NORMS[platform] ?? { prefer: "image" as MediaType, videoAllowed: true }
    const learned = platform ? await learnedMediaPreference(svc, params.brokerageId, platform) : null
    const preferred: MediaType = learned ?? norm.prefer
    const decidedBy: PairedMedia["decidedBy"] = learned ? "learned" : "channel_norm"

    // 1. LIBRARY-FIRST — try the preferred media type, then the other (when
    //    the channel allows it); prefer the agent's own art, then the brokerage's.
    const typeOrder: MediaType[] = preferred === "video"
      ? ["video", "image"]
      : norm.videoAllowed ? ["image", "video"] : ["image"]
    for (const assetType of typeOrder) {
      const { data: assets } = await svc.from("marketing_assets")
        .select("id, asset_url, agent_user_id, tags, asset_name")
        .eq("brokerage_id", params.brokerageId)
        .eq("asset_type", assetType)
        .eq("approval_status", "approved")
        .not("asset_url", "is", null)
        .order("created_at", { ascending: false })
        .limit(30)
      const rows = (assets ?? []) as Array<{ id: string; asset_url: string; agent_user_id: string | null; tags: string[] | null; asset_name: string | null }>
      if (rows.length === 0) continue
      const topicWords = (params.topicTitle ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 4)
      const matchesTopic = (r: { tags: string[] | null; asset_name: string | null }) => {
        const hay = `${(r.tags ?? []).join(" ")} ${r.asset_name ?? ""}`.toLowerCase()
        return topicWords.some((w) => hay.includes(w))
      }
      const pick =
        rows.find((r) => r.agent_user_id === params.agentUserId && matchesTopic(r)) ??
        rows.find((r) => matchesTopic(r)) ??
        rows.find((r) => r.agent_user_id === params.agentUserId) ??
        rows[0]
      return {
        mediaUrls: [pick.asset_url],
        mediaType: assetType,
        source: "library",
        decidedBy: assetType === preferred ? decidedBy : "availability",
        assetId: pick.id,
      }
    }

    // 2. GENERATE — brand-aware, FH-constrained, attribution-banded by the rail.
    const { data: b } = await svc.from("brokerages")
      .select("name, dba, primary_color, logo_url, license_number, license_state")
      .eq("id", params.brokerageId).maybeSingle()
    const { generateImage } = await import("@/lib/ai/image-generation")
    const prompt = params.topicTitle
      ? `An editorial real-estate social image illustrating: ${params.topicTitle}. Architectural or lifestyle photography mood, no people.`
      : "A premium residential architecture photograph — warm light, inviting, editorial quality, no people."
    const result = await generateImage({
      prompt,
      purpose: "social_post",
      brand: {
        brokerageName: (b as any)?.name ?? null,
        brokerageDba: (b as any)?.dba ?? null,
        brokerageLicense: (b as any)?.license_number ?? null,
        brokerageLicenseState: (b as any)?.license_state ?? null,
        primaryColor: (b as any)?.primary_color ?? null,
        logoUrl: (b as any)?.logo_url ?? null,
      },
    })
    if (!result.success || !result.imageUrl) return null

    // Capture into the library so the NEXT post reuses it (one asset → many uses).
    const { data: captured } = await svc.from("marketing_assets").insert({
      brokerage_id: params.brokerageId,
      agent_user_id: params.agentUserId ?? null,
      visibility_scope: "brokerage",
      asset_type: "image",
      asset_name: params.topicTitle ? `Social — ${params.topicTitle.slice(0, 60)}` : "Social brand image",
      asset_url: result.imageUrl,
      thumbnail_url: result.imageUrl,
      source_table: "social_posts",
      source_id: null,
      tags: ["reusable", "social", ...(params.postType ? [params.postType] : [])],
      approval_status: "approved",
      metadata: { captured_from: "social_cadence_pairing", topic: params.topicTitle ?? null },
    }).select("id").maybeSingle()

    return {
      mediaUrls: [result.imageUrl],
      mediaType: "image",
      source: "generated",
      decidedBy: "availability", // generation only makes images — honest label
      assetId: (captured as { id: string } | null)?.id ?? null,
    }
  } catch {
    return null
  }
}
