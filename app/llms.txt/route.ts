/**
 * app/llms.txt/route.ts — Wave 39 GEO.
 *
 * Serves /llms.txt — the emerging standard that tells AI systems what this
 * site is and where the citable content lives. Points them at the public
 * video landing pages so models index the agent's listing + market videos
 * as real-estate knowledge.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { buildLlmsTxt, type LlmsTxtPage } from "@/lib/geo/video-landing"

export const dynamic = "force-dynamic"
export const revalidate = 3600

function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "https://app.viprealestateos.com").replace(/\/$/, "")
}

export async function GET() {
  const base = siteUrl()
  let pages: LlmsTxtPage[] = []
  try {
    const svc = createServiceClient()
    // Published reels live on BOTH rails — the Asset Manager render rail
    // (remotion_composition_renders + registry SEO fields) and the canonical
    // D-ID / listing-promo reel rail (ai_video_projects, self-describing).
    const [renders, projects] = await Promise.all([
      svc.from("remotion_composition_renders")
        .select("public_slug, composition_id, published_at, remotion_compositions(seo_title, seo_description, display_name)")
        .eq("is_published", true).not("public_slug", "is", null)
        .order("published_at", { ascending: false }).limit(500),
      svc.from("ai_video_projects")
        .select("public_slug, title, video_type, script_content, published_at")
        .eq("is_published", true).not("public_slug", "is", null)
        .order("published_at", { ascending: false }).limit(500),
    ])
    // The embedded join comes back as an array (Supabase types to-one
    // relationships as arrays); take the first row.
    type CompMeta = { seo_title: string | null; seo_description: string | null; display_name: string | null }
    const renderRows = (renders.data ?? []) as unknown as Array<{
      public_slug: string
      remotion_compositions: CompMeta | CompMeta[] | null
    }>
    const projectRows = (projects.data ?? []) as Array<{
      public_slug: string; title: string | null; video_type: string | null; script_content: string | null
    }>
    const seen = new Set<string>()
    const add = (page: LlmsTxtPage) => { if (!seen.has(page.url)) { seen.add(page.url); pages.push(page) } }
    for (const r of renderRows) {
      const c = Array.isArray(r.remotion_compositions) ? r.remotion_compositions[0] : r.remotion_compositions
      add({
        title:   c?.seo_title || c?.display_name || "Video",
        url:     `${base}/v/${r.public_slug}`,
        summary: c?.seo_description || "Real-estate video.",
      })
    }
    for (const p of projectRows) {
      add({
        title:   p.title || `${(p.video_type ?? "video").replace(/_/g, " ")} reel`,
        url:     `${base}/v/${p.public_slug}`,
        summary: (p.script_content && p.script_content.trim().slice(0, 200)) || "Real-estate video.",
      })
    }
  } catch {
    pages = []
  }

  const body = buildLlmsTxt({
    siteName:    "VIP Real Estate OS",
    siteSummary: "AI-powered real-estate marketing: listing, market-update, neighborhood, and explainer videos produced for licensed agents. Every video below is a public, citable page with the property/market facts it covers.",
    pages,
  })

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  })
}
