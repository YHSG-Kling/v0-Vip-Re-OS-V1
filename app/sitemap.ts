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

    // The REST of the public marketing surface — every page campaigns/QRs
    // point at must be discoverable, not just the videos:
    //   /listing/[slug]  — active listing pages (slug = mls_number or id)
    //   /p/[agentSlug]   — agent profiles
    //   /lm/[slug]       — lead-magnet landing pages
    const [listings, agents, magnets, blogs] = await Promise.all([
      svc.from("listings").select("id, mls_number, updated_at")
        .eq("status", "active").is("deleted_at", null)
        .order("updated_at", { ascending: false }).limit(5000),
      // Cross-tenant by design (one public sitemap) — rows carry brokerage_id
      svc.from("agents").select("public_slug, brokerage_id, updated_at")
        .not("public_slug", "is", null).limit(2000),
      svc.from("lead_capture_forms").select("slug, updated_at")
        .eq("is_active", true).not("slug", "is", null).limit(1000),
      svc.from("blog_posts").select("slug, published_at")
        .eq("publish_status", "published").not("slug", "is", null)
        .order("published_at", { ascending: false }).limit(2000),
    ])
    const listingEntries: MetadataRoute.Sitemap = ((listings.data ?? []) as Array<{ id: string; mls_number: string | null; updated_at: string | null }>)
      .map((l) => ({
        url: `${base}/listing/${l.mls_number ?? l.id}`,
        lastModified: l.updated_at ?? undefined,
        changeFrequency: "daily" as const,
        priority: 0.7,
      }))
    const agentEntries: MetadataRoute.Sitemap = ((agents.data ?? []) as Array<{ public_slug: string; updated_at: string | null }>)
      .map((a) => ({
        url: `${base}/p/${a.public_slug}`,
        lastModified: a.updated_at ?? undefined,
        changeFrequency: "weekly" as const,
        priority: 0.5,
      }))
    const magnetEntries: MetadataRoute.Sitemap = ((magnets.data ?? []) as Array<{ slug: string; updated_at: string | null }>)
      .map((m) => ({
        url: `${base}/lm/${m.slug}`,
        lastModified: m.updated_at ?? undefined,
        changeFrequency: "monthly" as const,
        priority: 0.4,
      }))
    const blogEntries: MetadataRoute.Sitemap = ((blogs.data ?? []) as Array<{ slug: string; published_at: string | null }>)
      .map((bp) => ({
        url: `${base}/blog/${bp.slug}`,
        lastModified: bp.published_at ?? undefined,
        changeFrequency: "monthly" as const,
        priority: 0.5,
      }))

    return [...staticEntries, ...listingEntries, ...videoEntries, ...blogEntries, ...agentEntries, ...magnetEntries]
  } catch {
    return staticEntries
  }
}
