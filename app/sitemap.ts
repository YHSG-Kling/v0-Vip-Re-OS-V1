/**
 * app/sitemap.ts — Wave 39 GEO.
 *
 * Lists every published public video landing page (/v/[slug]) so search +
 * AI crawlers discover them. Capped to the most recent 5,000 (sitemap
 * protocol limit is 50k; we stay well under and can shard later).
 */
import type { MetadataRoute } from "next"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"
export const revalidate = 3600

function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "https://app.viprealestateos.com").replace(/\/$/, "")
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl()
  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${base}/`, changeFrequency: "weekly", priority: 0.8 },
  ]

  try {
    const svc = createServiceClient()
    // Published reels live on BOTH rails: remotion_composition_renders (the
    // Asset Manager render rail) and ai_video_projects (the canonical D-ID /
    // listing-promo reel rail). Union both, dedupe by slug.
    const [renders, projects] = await Promise.all([
      svc.from("remotion_composition_renders")
        .select("public_slug, published_at")
        .eq("is_published", true).not("public_slug", "is", null)
        .order("published_at", { ascending: false }).limit(5000),
      svc.from("ai_video_projects")
        .select("public_slug, published_at")
        .eq("is_published", true).not("public_slug", "is", null)
        .order("published_at", { ascending: false }).limit(5000),
    ])
    const rows = [
      ...((renders.data ?? []) as Array<{ public_slug: string; published_at: string | null }>),
      ...((projects.data ?? []) as Array<{ public_slug: string; published_at: string | null }>),
    ]
    const seen = new Set<string>()
    const videoEntries: MetadataRoute.Sitemap = []
    for (const r of rows) {
      if (seen.has(r.public_slug)) continue
      seen.add(r.public_slug)
      videoEntries.push({
        url: `${base}/v/${r.public_slug}`,
        lastModified: r.published_at ?? undefined,
        changeFrequency: "monthly",
        priority: 0.6,
      })
    }
    return [...staticEntries, ...videoEntries]
  } catch {
    return staticEntries
  }
}
