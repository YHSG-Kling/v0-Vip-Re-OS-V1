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
    const { data } = await svc.from("remotion_composition_renders")
      .select("public_slug, published_at")
      .eq("is_published", true)
      .not("public_slug", "is", null)
      .order("published_at", { ascending: false })
      .limit(5000)
    const rows = (data ?? []) as Array<{ public_slug: string; published_at: string | null }>
    const videoEntries: MetadataRoute.Sitemap = rows.map((r) => ({
      url: `${base}/v/${r.public_slug}`,
      lastModified: r.published_at ?? undefined,
      changeFrequency: "monthly",
      priority: 0.6,
    }))
    return [...staticEntries, ...videoEntries]
  } catch {
    return staticEntries
  }
}
