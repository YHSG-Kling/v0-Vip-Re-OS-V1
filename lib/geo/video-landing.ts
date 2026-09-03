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

// video-status.ts is pure constants (no DB, no server-only), so importing it
// here keeps this module unit-testable in the simulator without egress.
import { VIDEO_FINISHED_STATUSES } from "@/lib/video/video-status"

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
 *    status:            CANONICAL_VIDEO_STATUSES (lib/video/video-status.ts) —
 *                       'draft'|'scripting'|'script_ready'|'queued'|'generating'|
 *                       'awaiting_presenter_setup'|'completed'|'published'|'failed'.
 *                       'planning' used to be listed here and no longer exists
 *                       (m374 folded it into 'draft').
 *    compliance_status: 'not_evaluated'|'passed'|'failed'|'needs_review'
 *    approval_status:   'draft'|'pending_review'|'approved'|'rejected'|'published'
 *
 *  NOTE the collision: approval_status ALSO has a 'published' and a 'draft'.
 *  They are different columns with different meanings — status:'published'
 *  means the asset went out, approval_status:'published' is a sign-off state.
 *  The gate below reads both, so do not merge them.
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
  // "Finished" is a SET, not one token (m374). This read used to be
  // `status !== "completed"`, which silently re-narrowed the caller's widened
  // SQL filter: geo-reel-autopublish selects .in("status", VIDEO_FINISHED_STATUSES)
  // and then this gate rejected every `published` row with "reel not
  // auto-publishable". The two halves of one decision disagreed, and the SQL
  // half was the one that looked correct.
  if (!(VIDEO_FINISHED_STATUSES as readonly string[]).includes(reel.status)) return false
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

// ─────────────────────────────────────────────────────────────────────────────
// seoHint — THE TEXT AN AI SEARCH ENGINE READS TO DESCRIBE A VIDEO IT CANNOT
// WATCH. Three sides of one contract, and this file holds the two pure ones:
//
//   · lib/remotion/content-contract.ts requires `seoHint` on VideoCoverThumb
//     (a defaulted hint feeds a fabricated summary to exactly the surface the
//     GEO work is trying to win);
//   · the PRODUCER — app/api/internal/remotion/render-just-listed/route.ts —
//     supplies it with `seoHintFromNarration` below and stages the whole card
//     as `input_props.thumbnail_props` (the one key render-decision.ts
//     resolveThumbnailProps already reads);
//   · the READER — `seoHintFromRenderProps` / `describeVideoForSearch` below,
//     for the /v/[slug] page's <meta description> / og:description.
//
// Until 2026-09-03 only the first side existed: the producer omitted the prop
// (and rendered the still directly, so the backstop could not refuse), and
// nothing read it back — a required prop with neither writer nor reader.
// ─────────────────────────────────────────────────────────────────────────────

/** og:description / VideoObject.description ceiling — the length search
 *  snippets actually show; longer hints are cut mid-sentence by the engine. */
export const SEO_HINT_MAX_CHARS = 160

/**
 * The seoHint, cut VERBATIM from copy that already passed the compliance gate.
 *
 * NOT A SECOND DRAFT. The promo narration has been through evaluateOutbound
 * (fair housing, the one redraft) before it is spoken, so the hint is whole
 * sentences of that script — never a paraphrase, never a new claim, never a
 * protected-class word the gate did not see. Whole sentences while they fit
 * SEO_HINT_MAX_CHARS; a first sentence longer than that is cut on a word
 * boundary with an ellipsis rather than mid-word. Blank in ⇒ null out, so the
 * content contract refuses the card instead of a producer inventing one.
 *
 * PURE.
 */
export function seoHintFromNarration(script: string | null | undefined, maxChars = SEO_HINT_MAX_CHARS): string | null {
  const flat = (script ?? "").replace(/\s+/g, " ").trim()
  if (!flat) return null
  const sentences = flat.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [flat]
  let out = ""
  for (const s of sentences) {
    const next = out ? `${out} ${s}` : s
    if (next.length > maxChars) break
    out = next
  }
  if (out) return out
  // The first sentence alone is over the ceiling: cut on a word boundary.
  const head = sentences[0] ?? flat
  const cut = head.slice(0, maxChars - 1)
  const atWord = cut.lastIndexOf(" ") > maxChars / 2 ? cut.slice(0, cut.lastIndexOf(" ")) : cut
  return `${atWord.replace(/[\s.,;:—-]+$/, "")}…`
}

/**
 * Read the seoHint back off a render row's input_props: the companion card's
 * `thumbnail_props.seoHint` for a moving render, or the top-level `seoHint`
 * when the render IS a VideoCoverThumb still. Null when neither is a
 * non-blank string — a reader must then fall back to registry copy, never to
 * the composition's sample hint. PURE.
 */
export function seoHintFromRenderProps(inputProps: Record<string, unknown> | null | undefined): string | null {
  const tp = inputProps?.thumbnail_props
  const nested = tp && typeof tp === "object" ? (tp as Record<string, unknown>).seoHint : undefined
  const candidate = typeof nested === "string" && nested.trim() ? nested : inputProps?.seoHint
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null
}

/**
 * The description the landing page publishes for a Remotion render — one rule,
 * in preference order: the render's own seoHint (staged from gated copy), the
 * registry's seo_description, then the honest generic line. The agent
 * attribution suffix is appended in every case, as the page always has.
 * PURE — mirrors app/v/[slug]/page.tsx loadPage's inline rule with the seoHint
 * arm in front of it.
 */
export function describeVideoForSearch(args: {
  seoHint:        string | null
  seoDescription: string | null
  displayName:    string
  producerName:   string
  agentName:      string | null
}): string {
  const base = args.seoHint
    || (args.seoDescription && args.seoDescription.trim())
    || `${args.displayName} produced by ${args.producerName}.`
  return args.agentName ? `${base} Presented by ${args.agentName}.` : base
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
