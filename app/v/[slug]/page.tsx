/**
 * app/v/[slug]/page.tsx
 *
 * Wave 39 GEO — the public, AI-search-citable video landing page. SSR so
 * AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended) read the
 * full content + JSON-LD. One page per published render
 * (remotion_composition_renders.is_published).
 *
 * Carries: the video (output_url) + poster (thumbnail_url), title +
 * description from the registry SEO fields, listing/market facts, agent
 * attribution, Fair-Housing / license / EHO disclosures, and schema.org
 * VideoObject + RealEstateListing + BreadcrumbList JSON-LD.
 */
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveUserIdForAgentRecord } from "@/lib/kernel/agent-identity"
import { assembleSocialDisclosures } from "@/lib/social/assemble-disclosures"
import {
  buildVideoObjectJsonLd,
  buildRealEstateListingJsonLd,
  buildBreadcrumbJsonLd,
  serializeJsonLd,
  framesToSeconds,
  seoHintFromRenderProps,
  describeVideoForSearch,
} from "@/lib/geo/video-landing"

export const dynamic = "force-dynamic"
export const revalidate = 300

import { siteUrl } from "@/lib/platform/site-url"
import { loadProductBrand } from "@/lib/platform/product-brand"
import { VideoPlayer } from "./video-player"

interface RenderRow {
  id:             string
  brokerage_id:   string
  composition_id: string
  agent_user_id:  string | null
  entity_type:    string | null
  entity_id:      string | null
  output_url:     string | null
  thumbnail_url:  string | null
  published_at:   string | null
  /** The staged props. Read ONLY for the seoHint the producer cut verbatim from
   *  the compliance-gated narration (thumbnail_props.seoHint, or the top-level
   *  key when the render IS a VideoCoverThumb) — never rendered as page copy.
   *  Null on the ai_video_projects rail, which stages no Remotion props. */
  input_props:    Record<string, unknown> | null
}

interface CompositionRow {
  display_name:    string
  category:        string
  seo_title:       string | null
  seo_description: string | null
  duration_frames: number
  fps:             number
}

interface PageData {
  render:      RenderRow
  composition: CompositionRow
  title:       string
  description: string
  agentName:   string | null
  agentPhoto:  string | null
  brokerageName: string | null
  listing:     {
    address: string | null; city: string | null; state: string | null;
    price: number | null; bedrooms: number | null; bathrooms: number | null; sqft: number | null
  } | null
  disclosures: string
  /**
   * The ai_video_projects id when this page is serving a reel from the canonical
   * project rail (null for a Remotion composition render). trackVideoView keys
   * on that table, so only the project path can record a view — the Remotion
   * rail has no view counter of its own and must not be given a fabricated one.
   */
  projectId: string | null
}

async function loadPage(slug: string): Promise<PageData | null> {
  const svc = createServiceClient()
  const { data: r } = await svc.from("remotion_composition_renders")
    .select("id, brokerage_id, composition_id, agent_user_id, entity_type, entity_id, output_url, thumbnail_url, published_at, input_props")
    .eq("public_slug", slug)
    .eq("is_published", true)
    .maybeSingle()
  const render = r as RenderRow | null
  // No matching Remotion render → try the canonical ai_video_projects reel
  // (the D-ID / listing-promo rail that carries its own compliance + approval).
  if (!render || !render.output_url) return loadProjectPage(svc, slug)

  const { data: c } = await svc.from("remotion_compositions")
    .select("display_name, category, seo_title, seo_description, duration_frames, fps")
    .eq("composition_id", render.composition_id)
    .maybeSingle()
  const composition = c as CompositionRow | null
  if (!composition) return null

  // Agent attribution.
  let agentName: string | null = null
  let agentPhoto: string | null = null
  if (render.agent_user_id) {
    const [{ data: u }, { data: a }] = await Promise.all([
      svc.from("users").select("first_name, last_name").eq("id", render.agent_user_id).maybeSingle(),
      svc.from("agents").select("photo_url").eq("user_id", render.agent_user_id).eq("brokerage_id", render.brokerage_id).maybeSingle(),
    ])
    const ur = u as { first_name: string | null; last_name: string | null } | null
    agentName = ur ? [ur.first_name, ur.last_name].filter(Boolean).join(" ") || null : null
    agentPhoto = (a as { photo_url: string | null } | null)?.photo_url ?? null
  }

  const { data: b } = await svc.from("brokerages").select("name").eq("id", render.brokerage_id).maybeSingle()
  const brokerageName = (b as { name: string | null } | null)?.name ?? null

  // Listing facts (when the render is for a listing entity).
  let listing: PageData["listing"] = null
  if (render.entity_type === "listing" && render.entity_id) {
    const { data: l } = await svc.from("listings")
      .select("address, city, state, list_price, bedrooms, bathrooms, sqft")
      .eq("id", render.entity_id)
      .eq("brokerage_id", render.brokerage_id)
      .maybeSingle()
    const lr = l as { address: string | null; city: string | null; state: string | null; list_price: number | null; bedrooms: number | null; bathrooms: number | null; sqft: number | null } | null
    if (lr) listing = { address: lr.address, city: lr.city, state: lr.state, price: lr.list_price, bedrooms: lr.bedrooms, bathrooms: lr.bathrooms, sqft: lr.sqft }
  }

  const title = composition.seo_title || composition.display_name
  // THE SEO HINT, READ BACK (2026-09-03). The producer
  // (app/api/internal/remotion/render-just-listed/route.ts) cuts `seoHint`
  // VERBATIM from the narration that already cleared the compliance gate and
  // files it under input_props.thumbnail_props — the text an AI search engine
  // reads to describe a video it cannot watch. Until now this page built its
  // description from the REGISTRY's seo_description alone, which is per
  // COMPOSITION, not per render: every just-listed reel in the library
  // published the same generic sentence to the exact surface the GEO work is
  // trying to win, and the per-render hint had a writer and no reader.
  // The preference order lives in ONE place (lib/geo/video-landing.ts
  // describeVideoForSearch), so the page and the guard cannot disagree.
  const seoHint = seoHintFromRenderProps(render.input_props)
  const hasRegistryCopy = !!(composition.seo_description && composition.seo_description.trim())
  const description = describeVideoForSearch({
    seoHint,
    seoDescription: composition.seo_description,
    displayName:    composition.display_name,
    // Only the GENERIC arm needs the platform name, so the platform_settings
    // singleton read stays behind the same short-circuit the inline `||` chain
    // gave it — a hint or registry copy means it is never queried.
    producerName:   brokerageName ?? (seoHint || hasRegistryCopy ? "" : (await loadProductBrand(svc)).name),
    agentName,
  })

  const disclosures = await assembleSocialDisclosures(svc as never, {
    brokerageId: render.brokerage_id,
    userId:      render.agent_user_id,
  })

  return { render, composition, title, description, agentName, agentPhoto, brokerageName, listing, disclosures, projectId: null }
}

/** Load a published reel from the canonical ai_video_projects rail and shape it
 *  into the SAME PageData the render path produces, so the page body + JSON-LD
 *  builders are identical regardless of which rail the reel came from. The
 *  synthesized composition uses fps=30 + duration_frames=duration_seconds*30 so
 *  framesToSeconds() recovers the true duration for VideoObject.duration. */
async function loadProjectPage(
  svc: ReturnType<typeof createServiceClient>,
  slug: string,
): Promise<PageData | null> {
  const { data: pr } = await svc.from("ai_video_projects")
    .select("id, brokerage_id, agent_id, listing_id, title, video_type, script_content, video_url, thumbnail_url, duration_seconds, published_at, video_metadata")
    .eq("public_slug", slug)
    .eq("is_published", true)
    .maybeSingle()
  const proj = pr as {
    id: string; brokerage_id: string; agent_id: string | null; listing_id: string | null;
    title: string | null; video_type: string | null; script_content: string | null;
    video_url: string | null; thumbnail_url: string | null; duration_seconds: number | null;
    published_at: string | null; video_metadata: Record<string, unknown> | null
  } | null
  if (!proj || !proj.video_url) return null

  // Agent attribution. ai_video_projects.agent_id is agents-class since m366, so
  // the photo comes off that agents row directly and the NAME (which lives on
  // users) needs the resolve across. Client-agnostic resolver — this is a page,
  // and the server-only one cannot be reachable from a page bundle.
  let agentName: string | null = null
  let agentPhoto: string | null = null
  let projAgentUserId: string | null = null
  if (proj.agent_id) {
    projAgentUserId = await resolveUserIdForAgentRecord(svc, proj.agent_id)
    const { data: a } = await svc.from("agents").select("photo_url").eq("id", proj.agent_id).maybeSingle()
    agentPhoto = (a as { photo_url: string | null } | null)?.photo_url ?? null
    if (projAgentUserId) {
      const { data: u } = await svc.from("users").select("first_name, last_name").eq("id", projAgentUserId).maybeSingle()
      const ur = u as { first_name: string | null; last_name: string | null } | null
      agentName = ur ? [ur.first_name, ur.last_name].filter(Boolean).join(" ") || null : null
    }
  }

  const { data: b } = await svc.from("brokerages").select("name").eq("id", proj.brokerage_id).maybeSingle()
  const brokerageName = (b as { name: string | null } | null)?.name ?? null

  // Listing facts (every promo / listing-tour reel is listing-tied).
  let listing: PageData["listing"] = null
  if (proj.listing_id) {
    const { data: l } = await svc.from("listings")
      .select("address, city, state, list_price, bedrooms, bathrooms, sqft")
      .eq("id", proj.listing_id)
      .eq("brokerage_id", proj.brokerage_id)
      .maybeSingle()
    const lr = l as { address: string | null; city: string | null; state: string | null; list_price: number | null; bedrooms: number | null; bathrooms: number | null; sqft: number | null } | null
    if (lr) listing = { address: lr.address, city: lr.city, state: lr.state, price: lr.list_price, bedrooms: lr.bedrooms, bathrooms: lr.bathrooms, sqft: lr.sqft }
  }

  const title = proj.title || `${(proj.video_type ?? "video").replace(/_/g, " ")} reel`
  // Same ONE rule as the render rail above (§6). This rail stages no Remotion
  // input_props, so it has no per-render seoHint — its own gated script IS the
  // description, and it takes the seoDescription slot.
  const hasScript = !!(proj.script_content && proj.script_content.trim())
  const description = describeVideoForSearch({
    seoHint:        null,
    seoDescription: proj.script_content,
    displayName:    title,
    producerName:   brokerageName ?? (hasScript ? "" : (await loadProductBrand(svc)).name),
    agentName,
  })

  const disclosures = await assembleSocialDisclosures(svc as never, {
    brokerageId: proj.brokerage_id,
    userId:      projAgentUserId,
  })

  // Shape a synthetic composition so the shared body + JSON-LD builders work.
  const durFrames = proj.duration_seconds && proj.duration_seconds > 0 ? Math.round(proj.duration_seconds * 30) : 0
  const composition: CompositionRow = {
    display_name: title, category: proj.video_type ?? "video",
    seo_title: title, seo_description: description, duration_frames: durFrames, fps: 30,
  }
  const render: RenderRow = {
    id: proj.id, brokerage_id: proj.brokerage_id, composition_id: proj.video_type ?? "video",
    // RenderRow.agent_user_id mirrors remotion_composition_renders.agent_user_id,
    // which is users-class — the resolved id, not the project's agents id.
    agent_user_id: projAgentUserId, entity_type: proj.listing_id ? "listing" : null,
    entity_id: proj.listing_id, output_url: proj.video_url, thumbnail_url: proj.thumbnail_url,
    published_at: proj.published_at,
    // No Remotion props on this rail — seoHintFromRenderProps(null) is null, so
    // the description above already took the script arm.
    input_props: null,
  }

  return { render, composition, title, description, agentName, agentPhoto, brokerageName, listing, disclosures, projectId: proj.id }
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const data = await loadPage(slug)
  if (!data) return { title: "Video not found", robots: { index: false } }
  const url = `${siteUrl()}/v/${slug}`
  const images = data.render.thumbnail_url ? [{ url: data.render.thumbnail_url }] : []
  return {
    title:       data.title,
    description: data.description,
    alternates:  { canonical: url },
    openGraph: {
      title: data.title, description: data.description, url, type: "video.other",
      images, videos: data.render.output_url ? [{ url: data.render.output_url }] : [],
    },
    twitter: { card: "player", title: data.title, description: data.description, images },
    robots: { index: true, follow: true },
  }
}

function usd(n: number | null): string | null {
  return n != null ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n) : null
}

export default async function VideoLandingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const data = await loadPage(slug)
  if (!data) notFound()

  const url = `${siteUrl()}/v/${slug}`
  const priceStr = data.listing ? usd(data.listing.price) : null

  const videoLd = buildVideoObjectJsonLd({
    name:          data.title,
    description:   data.description,
    thumbnailUrl:  data.render.thumbnail_url,
    contentUrl:    data.render.output_url!,
    uploadDate:    data.render.published_at ?? new Date().toISOString(),
    durationSec:   framesToSeconds(data.composition.duration_frames, data.composition.fps),
    publisherName: data.brokerageName,
    pageUrl:       url,
  })
  const listingLd = data.listing
    ? buildRealEstateListingJsonLd({
        name: data.title, description: data.description, url,
        imageUrl: data.render.thumbnail_url,
        streetAddress: data.listing.address, city: data.listing.city, state: data.listing.state,
        price: data.listing.price, bedrooms: data.listing.bedrooms, bathrooms: data.listing.bathrooms,
      })
    : null
  const breadcrumbLd = buildBreadcrumbJsonLd({
    siteName: (await loadProductBrand(createServiceClient())).name, siteUrl: siteUrl(), agentName: data.agentName, pageUrl: url, pageName: data.title,
  })

  const facts: string[] = []
  if (data.listing?.address) facts.push([data.listing.address, data.listing.city, data.listing.state].filter(Boolean).join(", "))
  if (priceStr) facts.push(priceStr)
  if (data.listing?.bedrooms != null) facts.push(`${data.listing.bedrooms} bd`)
  if (data.listing?.bathrooms != null) facts.push(`${data.listing.bathrooms} ba`)
  if (data.listing?.sqft != null) facts.push(`${data.listing.sqft.toLocaleString("en-US")} sqft`)

  return (
    <main style={{ maxWidth: 880, margin: "0 auto", padding: "24px 16px", fontFamily: "system-ui, sans-serif" }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(videoLd) }} />
      {listingLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(listingLd) }} />}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(breadcrumbLd) }} />

      <article>
        <h1 style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.2, margin: "0 0 12px" }}>{data.title}</h1>
        <div style={{ borderRadius: 12, overflow: "hidden", background: "#000", aspectRatio: "16 / 9" }}>
          <VideoPlayer
            src={data.render.output_url!}
            poster={data.render.thumbnail_url}
            projectId={data.projectId}
          />
        </div>

        <p style={{ fontSize: 17, color: "#1f2937", margin: "16px 0" }}>{data.description}</p>

        {facts.length > 0 && (
          <ul style={{ display: "flex", flexWrap: "wrap", gap: 8, listStyle: "none", padding: 0, margin: "0 0 16px" }}>
            {facts.map((f) => (
              <li key={f} style={{ background: "#f1f5f9", borderRadius: 999, padding: "4px 12px", fontSize: 14, color: "#0f172a" }}>{f}</li>
            ))}
          </ul>
        )}

        {(data.agentName || data.brokerageName) && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderTop: "1px solid #e5e7eb" }}>
            {data.agentPhoto && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={data.agentPhoto} alt={data.agentName ?? "Agent"} width={48} height={48} style={{ borderRadius: 999, objectFit: "cover" }} />
            )}
            <div>
              {data.agentName && <div style={{ fontWeight: 600 }}>{data.agentName}</div>}
              {data.brokerageName && <div style={{ color: "#6b7280", fontSize: 14 }}>{data.brokerageName}</div>}
            </div>
          </div>
        )}

        {data.disclosures && (
          <footer style={{ marginTop: 20, paddingTop: 12, borderTop: "1px solid #e5e7eb", color: "#6b7280", fontSize: 12 }}>
            {data.disclosures}
          </footer>
        )}
      </article>
    </main>
  )
}
