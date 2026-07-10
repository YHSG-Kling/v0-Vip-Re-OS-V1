/**
 * lib/geo/video-landing.ts
 *
 * Wave 39 GEO — pure builders for the per-render public video landing page.
 * The differentiator: every Remotion render the agentic OS produces gets a
 * crawlable, schema-rich public page so AI search engines (ChatGPT browse,
 * Perplexity, Google AI Overviews, Claude) can READ and CITE the agent's
 * listings + market videos. Incumbents bury video inside a CRM; we make it
 * AI-search real estate.
 *
 * Kept free of DB + server-only so the whole schema/slug/llms.txt layer is
 * unit-testable in the simulator without egress. The SSR page
 * (app/v/[slug]) + llms.txt / robots / sitemap routes consume these.
 */

/** AI + search crawler user-agents we explicitly welcome in robots. The
 *  whole point of GEO is to be readable by these — the opposite of the
 *  default "block the bots" posture. */
export const AI_CRAWLER_BOTS = [
  "GPTBot",            // OpenAI training + ChatGPT browse
  "OAI-SearchBot",     // OpenAI SearchGPT
  "ChatGPT-User",      // ChatGPT on-demand fetch
  "ClaudeBot",         // Anthropic
  "anthropic-ai",      // Anthropic (legacy ua)
  "Claude-User",       // Claude on-demand fetch
  "PerplexityBot",     // Perplexity index
  "Perplexity-User",   // Perplexity on-demand fetch
  "Google-Extended",   // Gemini / AI Overviews opt-in
  "Applebot-Extended", // Apple Intelligence
  "Amazonbot",
  "Bingbot",
  "CCBot",             // Common Crawl (feeds many models)
  "meta-externalagent",// Meta AI
] as const

const SLUG_MAX = 60

/** SEO slug for a render: kebab(seo_title || display_name) + short id so
 *  it is human/AI-readable AND globally unique. Deterministic for a given
 *  (title, renderId). */
export function slugifyTitle(
  title:    string | null | undefined,
  fallback: string,
  renderId: string,
): string {
  const base = (title && title.trim()) || (fallback && fallback.trim()) || "video"
  const kebab = base
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "")
  const suffix = renderId.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase()
  return `${kebab || "video"}-${suffix}`
}

/** A render is publishable as a public page only when it actually produced
 *  a hosted artifact and is not a print-only format (postcards never go on
 *  the public web). */
export function isPublishableRender(args: {
  renderStatus: string
  outputUrl:    string | null
  category:     string
}): boolean {
  if (args.renderStatus !== "succeeded") return false
  if (!args.outputUrl) return false
  if (args.category === "postcard") return false
  return true
}

/** The reel's lifecycle facts the auto-publish gate inspects. Mirrors the
 *  CHECK-constrained ai_video_projects vocabulary verbatim:
 *    status:            'planning'|'generating'|'completed'|'failed'|…
 *    compliance_status: 'not_evaluated'|'passed'|'failed'|'needs_review'
 *    approval_status:   'draft'|'pending_review'|'approved'|'rejected'|'published'
 */
export interface AutoPublishReel {
  status:            string
  complianceStatus:  string
  approvalStatus:    string
  videoUrl:          string | null
  isPublished:       boolean
}

/**
 * THE AUTO-PUBLISH GATE — a reel becomes a public, broadcast-advertising
 * /v/[slug] page ONLY when it is finished, compliance-passed, AND
 * broker-approved, and is not already public. A public page carries
 * Fair-Housing / EHO / license disclosures, so an un-approved or
 * non-compliant reel must NEVER auto-publish.
 *
 * Pure + total — the sweep cron and the simulator both call it.
 */
export function isAutoPublishEligible(reel: AutoPublishReel): boolean {
  if (reel.isPublished) return false                  // already public — idempotent
  if (reel.status !== "completed") return false       // render must have finished
  if (reel.complianceStatus !== "passed") return false// Fair-Housing / disclosures gate
  if (reel.approvalStatus !== "approved") return false// broker sign-off gate
  if (!reel.videoUrl) return false                    // nothing to host
  return true
}

export interface VideoObjectInput {
  name:           string
  description:    string
  thumbnailUrl:   string | null
  contentUrl:     string
  uploadDate:     string        // ISO
  durationSec?:   number | null
  embedUrl?:      string | null
  publisherName?: string | null
  pageUrl:        string
}

/** schema.org VideoObject — the JSON-LD that makes the video itself a
 *  first-class entity AI search engines can quote. */
export function buildVideoObjectJsonLd(v: VideoObjectInput): Record<string, unknown> {
  const out: Record<string, unknown> = {
    "@context":    "https://schema.org",
    "@type":       "VideoObject",
    name:          v.name,
    description:   v.description,
    contentUrl:    v.contentUrl,
    uploadDate:    v.uploadDate,
    url:           v.pageUrl,
  }
  if (v.thumbnailUrl) out.thumbnailUrl = [v.thumbnailUrl]
  if (v.embedUrl) out.embedUrl = v.embedUrl
  if (v.durationSec && v.durationSec > 0) out.duration = secondsToIso8601(v.durationSec)
  if (v.publisherName) {
    out.publisher = { "@type": "Organization", name: v.publisherName }
  }
  return out
}

export interface ListingJsonLdInput {
  name:        string
  description: string
  url:         string
  imageUrl:    string | null
  streetAddress: string | null
  city:        string | null
  state:       string | null
  price:       number | null
  bedrooms:    number | null
  bathrooms:   number | null
}

/** schema.org for a listing video — RealEstateListing wrapping a Residence
 *  with PostalAddress + offer price. Returns null when there are no real
 *  property facts to assert (don't emit empty/misleading structured data). */
export function buildRealEstateListingJsonLd(l: ListingJsonLdInput): Record<string, unknown> | null {
  if (!l.streetAddress && !l.city && l.price == null) return null
  const residence: Record<string, unknown> = { "@type": "SingleFamilyResidence" }
  if (l.streetAddress || l.city || l.state) {
    residence.address = {
      "@type":          "PostalAddress",
      ...(l.streetAddress ? { streetAddress: l.streetAddress } : {}),
      ...(l.city ? { addressLocality: l.city } : {}),
      ...(l.state ? { addressRegion: l.state } : {}),
      addressCountry: "US",
    }
  }
  if (l.bedrooms != null) residence.numberOfBedrooms = l.bedrooms
  if (l.bathrooms != null) residence.numberOfBathroomsTotal = l.bathrooms

  const out: Record<string, unknown> = {
    "@context":   "https://schema.org",
    "@type":      "RealEstateListing",
    name:         l.name,
    description:  l.description,
    url:          l.url,
    ...(l.imageUrl ? { image: [l.imageUrl] } : {}),
    about:        residence,
  }
  if (l.price != null && l.price > 0) {
    out.offers = {
      "@type":         "Offer",
      price:           l.price,
      priceCurrency:   "USD",
      availability:    "https://schema.org/InStock",
    }
  }
  return out
}

export interface BreadcrumbInput {
  siteName: string
  siteUrl:  string
  agentName: string | null
  pageUrl:  string
  pageName: string
}

export function buildBreadcrumbJsonLd(b: BreadcrumbInput): Record<string, unknown> {
  const items: Array<Record<string, unknown>> = [
    { "@type": "ListItem", position: 1, name: b.siteName, item: b.siteUrl },
  ]
  if (b.agentName) items.push({ "@type": "ListItem", position: items.length + 1, name: b.agentName })
  items.push({ "@type": "ListItem", position: items.length + 1, name: b.pageName, item: b.pageUrl })
  return { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items }
}

/** XSS-safe JSON-LD serialization for a <script type="application/ld+json">
 *  tag — escapes the `</` sequence so a string value can't close the tag. */
export function serializeJsonLd(obj: Record<string, unknown>): string {
  return JSON.stringify(obj).replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--")
}

export interface LlmsTxtPage {
  title:   string
  url:     string
  summary: string
}

/** Build an llms.txt body (the emerging standard that tells AI systems what
 *  a site is + where the citable content lives). Beyond the video pages,
 *  optional extra SECTIONS carry the rest of the public marketing surface
 *  (listings, agent profiles, guides) so AI search reads the whole estate. */
export function buildLlmsTxt(args: {
  siteName:    string
  siteSummary: string
  pages:       LlmsTxtPage[]
  sections?:   Array<{ heading: string; pages: LlmsTxtPage[] }>
}): string {
  const lines: string[] = []
  lines.push(`# ${args.siteName}`)
  lines.push("")
  lines.push(`> ${args.siteSummary}`)
  lines.push("")
  lines.push("## Video content")
  if (args.pages.length === 0) {
    lines.push("- (no published videos yet)")
  } else {
    for (const p of args.pages) {
      lines.push(`- [${p.title}](${p.url}): ${p.summary}`)
    }
  }
  for (const section of args.sections ?? []) {
    if (section.pages.length === 0) continue
    lines.push("")
    lines.push(`## ${section.heading}`)
    for (const p of section.pages) {
      lines.push(`- [${p.title}](${p.url}): ${p.summary}`)
    }
  }
  lines.push("")
  return lines.join("\n")
}

/** ISO-8601 duration (PT#M#S) from seconds, for VideoObject.duration. */
export function secondsToIso8601(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec))
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `PT${m > 0 ? `${m}M` : ""}${rem}S`
}

/** Convert a composition's frame count + fps to seconds for the
 *  VideoObject duration. */
export function framesToSeconds(durationFrames: number, fps: number): number {
  if (!fps || fps <= 0) return 0
  return durationFrames / fps
}
