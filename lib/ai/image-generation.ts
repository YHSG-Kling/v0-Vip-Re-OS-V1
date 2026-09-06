/**
 * lib/ai/image-generation.ts
 *
 * AI image generation primitive — DALL-E 3 (OpenAI). Used by every content
 * creation surface (social posts, ads, blog, newsletter, postcards, listing
 * imagery). Brand-aware: pulls brokerage primary color + agent's brand voice
 * profile and injects them into the prompt automatically.
 *
 * Output flow:
 *   1. Build the brand-aware prompt
 *   2. Call DALL-E 3 (returns a 1-hour signed URL)
 *   3. Download the image bytes
 *   4. If a logo URL is provided, composite it onto the image using Sharp
 *   5. Re-upload to Vercel Blob (permanent URL)
 *   6. Caller persists to marketing_assets
 *
 * Logo overlay: brokerage/team logo is composited server-side (Sharp) into the
 * bottom-right corner after DALL-E generates the image. This is more reliable
 * than instructing DALL-E to render a logo. Pass noLogo=true to skip compositing
 * and use brokerageName text in the prompt instead.
 */

import "server-only"
// Was `import { put } from "@vercel/blob"`. Survivor:
// lib/remotion/media-host.ts#hostRenderedMedia → Supabase `agent-media`, which
// lib/storage/document-buckets.ts designates for "agent headshots, brand
// imagery and content-studio assets shown on public agent pages" — which is
// what a generated marketing image is.
import { hostRenderedMedia } from "@/lib/remotion/media-host"
import { createServiceClient } from "@/lib/supabase/service"
import sharp from "sharp"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

export type ImageSize = "1024x1024" | "1792x1024" | "1024x1792"
export type ImageQuality = "standard" | "hd"
export type ImageStyle = "vivid" | "natural"

/** Use case shapes the prompt boilerplate */
export type ImagePurpose =
  | "social_post"
  | "ad_creative"
  | "blog_hero"
  | "newsletter_hero"
  | "postcard"
  | "listing_visual"
  | "podcast_cover"
  | "event_banner"
  | "generic"

export interface BrandHints {
  brokerageName?: string | null
  /** Doing-business-as name, when the legal name differs from the trade name */
  brokerageDba?: string | null
  /** Brokerage license # — required on advertising in most US states */
  brokerageLicense?: string | null
  /** State the brokerage license is issued in (e.g. CA, TX, FL) */
  brokerageLicenseState?: string | null
  /** Team trade name — used in attribution when the agent is team-branded */
  teamName?: string | null
  primaryColor?: string | null
  agentName?: string | null
  /** Agent's individual license # — required in CA / FL / TX / NY etc. */
  agentLicense?: string | null
  brandVoiceTone?: string | null
  /** Brokerage or team logo URL — composited onto the finished image via Sharp */
  logoUrl?: string | null
  /** When true, skip logo overlay and use brokerageName text in the prompt instead */
  noLogo?: boolean
  /**
   * Render MLS-clean — when true, BOTH the logo composite AND the attribution
   * band are skipped. MLS rules forbid agent/brokerage branding on listing
   * media submitted to the MLS feed.
   */
  mlsClean?: boolean
}

export interface GenerateImageInput {
  /** What the image should show — agent-provided or AI-suggested */
  prompt: string
  /** Use case — drives prompt boilerplate (e.g. "modern, real-estate, Instagram square") */
  purpose: ImagePurpose
  /** Square / landscape / portrait */
  size?: ImageSize
  /** 'standard' is $0.04, 'hd' is $0.08 — default standard */
  quality?: ImageQuality
  /** 'vivid' = punchy/dramatic, 'natural' = realistic — default natural */
  style?: ImageStyle
  /** Brokerage + agent brand info for prompt injection */
  brand?: BrandHints
  /** Optional listing data to incorporate (price, beds, address) */
  listingContext?: {
    address?: string
    city?: string
    state?: string
    listPrice?: number
    bedrooms?: number
    bathrooms?: number
  }
  /**
   * Optional override for the OpenAI base URL (Azure OpenAI etc.).
   * Defaults to the public OpenAI endpoint.
   */
  endpointBase?: string
}

export interface GenerateImageResult {
  success: boolean
  imageUrl?: string         // permanent blob URL
  thumbnailUrl?: string     // same as imageUrl for now (future: separate)
  revisedPrompt?: string    // what DALL-E actually used
  size?: ImageSize
  cost?: number             // estimated USD
  error?: string
  errorCode?: "no_api_key" | "rate_limit" | "content_policy" | "auth" | "blob_failed" | "unknown"
}

const DEFAULT_SIZES: Record<ImagePurpose, ImageSize> = {
  social_post: "1024x1024",
  ad_creative: "1024x1024",
  blog_hero: "1792x1024",
  newsletter_hero: "1792x1024",
  postcard: "1792x1024",
  listing_visual: "1792x1024",
  podcast_cover: "1024x1024",
  event_banner: "1792x1024",
  generic: "1024x1024",
}

const COST_PER_IMAGE: Record<string, number> = {
  "standard:1024x1024": 0.04,
  "standard:1792x1024": 0.08,
  "standard:1024x1792": 0.08,
  "hd:1024x1024": 0.08,
  "hd:1792x1024": 0.12,
  "hd:1024x1792": 0.12,
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// gpt-image-1 via Vercel AI Gateway (Flex mode)
// ---------------------------------------------------------------------------

/**
 * Maps image quality to gpt-image-1 quality levels.
 * gpt-image-1 uses "low" | "medium" | "high" | "auto".
 */
function toGptImage1Quality(q: ImageQuality): string {
  return q === "hd" ? "high" : "medium"
}

async function callGptImage1Gateway(
  prompt: string,
  size: ImageSize,
  quality: ImageQuality
): Promise<{ imageBytes: Buffer; revisedPrompt: string } | null> {
  const gatewayKey = process.env.AI_GATEWAY_API_KEY
  if (!gatewayKey) return null

  // Vercel AI Gateway endpoint (OpenAI-compatible image generation API)
  const res = await callConnector<any>({
    connector: "vercel-ai-gateway",
    baseUrl: "https://ai-gateway.vercel.sh",
    path: "/v1/images/generations",
    method: "POST",
    auth: { style: "bearer", token: gatewayKey },
    body: {
      model: "openai/gpt-image-1",
      prompt,
      size,
      quality: toGptImage1Quality(quality),
      n: 1,
      // gpt-image-1 returns base64 by default; request b64_json explicitly
      response_format: "b64_json",
      // Flex routing lets the gateway pick the fastest available capacity
      routing: "flex",
    },
  })

  if (!res.ok) return null // let caller fall back to DALL-E 3

  const data = res.data ?? {}
  const b64 = data?.data?.[0]?.b64_json as string | undefined
  if (!b64) return null

  return {
    imageBytes: Buffer.from(b64, "base64"),
    revisedPrompt: data?.data?.[0]?.revised_prompt ?? prompt,
  }
}

export async function generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
  const size = input.size ?? DEFAULT_SIZES[input.purpose]
  const quality = input.quality ?? "standard"
  const style = input.style ?? "natural"

  const fullPrompt = buildBrandAwarePrompt(input)

  // 1. Try gpt-image-1 via Vercel AI Gateway (Flex mode) when key is available
  let imageBytes: Buffer | null = null
  let revisedPrompt = fullPrompt

  try {
    const gatewayResult = await callGptImage1Gateway(fullPrompt, size, quality)
    if (gatewayResult) {
      imageBytes = gatewayResult.imageBytes
      revisedPrompt = gatewayResult.revisedPrompt
    }
  } catch { /* gateway unavailable — fall through to DALL-E 3 */ }

  // 2. Fall back to DALL-E 3 via direct OpenAI if gateway path didn't produce bytes
  if (!imageBytes) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      return { success: false, errorCode: "no_api_key", error: "Neither AI_GATEWAY_API_KEY nor OPENAI_API_KEY is configured" }
    }

    let dalleResp: { url: string; revisedPrompt: string } | null = null
    try {
      const base = new URL(input.endpointBase ?? "https://api.openai.com/v1")
      const res = await callConnector<any>({
        connector: "openai",
        baseUrl: base.origin,
        path: `${base.pathname.replace(/\/$/, "")}/images/generations`,
        method: "POST",
        auth: { style: "bearer", token: apiKey },
        body: {
          model: "dall-e-3",
          prompt: fullPrompt,
          size,
          quality,
          style,
          n: 1,
        },
      })

      if (!res.ok) {
        const body = res.error ?? ""
        const code: GenerateImageResult["errorCode"] =
          res.status === 401 || res.status === 403
            ? "auth"
            : res.status === 429
            ? "rate_limit"
            : /content_policy|safety/i.test(body)
            ? "content_policy"
            : "unknown"
        return {
          success: false,
          errorCode: code,
          error: `DALL-E (${res.status}): ${body}`,
        }
      }

      const data = res.data ?? {}
      const item = data?.data?.[0]
      if (!item?.url) {
        return { success: false, errorCode: "unknown", error: "DALL-E returned no image" }
      }
      dalleResp = { url: item.url, revisedPrompt: item.revised_prompt ?? fullPrompt }
    } catch (err: any) {
      return { success: false, errorCode: "unknown", error: err?.message ?? "Network error" }
    }

    // Download DALL-E image bytes (signed 1-hour URL) through the gateway (absolute-url override).
    const dl = await callConnector<Buffer>({
      connector: "asset-download", baseUrl: "", path: "", url: dalleResp.url,
      method: "GET", auth: { style: "none" }, responseType: "arraybuffer", timeoutMs: 30_000,
    })
    if (!dl.ok || !dl.data) {
      return { success: false, errorCode: "unknown", error: `Image download failed: ${dl.status}` }
    }
    imageBytes = dl.data
    revisedPrompt = dalleResp.revisedPrompt
  }

  // imageBytes is now populated (either from gateway or DALL-E fallback)
  // The null check is enforced by early returns in both paths above.
  let finalImageBytes: Buffer = imageBytes as Buffer

  // 3. Composite brokerage/team logo if provided (and not opted out).
  //    SKIPPED entirely when mlsClean=true — MLS rules forbid agent/brokerage
  //    branding on photos and videos in the MLS feed.
  const logoUrl = input.brand?.logoUrl
  const skipLogo = input.brand?.noLogo === true || input.brand?.mlsClean === true
  if (logoUrl && !skipLogo) {
    try {
      finalImageBytes = await compositeLogoOntoImage(finalImageBytes, logoUrl)
    } catch {
      // Logo compositing is best-effort — don't fail the whole generation
    }
  }

  // 3a. Composite the legal attribution band along the bottom edge — brokerage
  //     name, license #, "Equal Housing Opportunity". This is what makes the
  //     image compliant with state real-estate advertising law + the federal
  //     Fair Housing Act for housing-related marketing.
  //     SKIPPED entirely when mlsClean=true (MLS rules forbid this).
  if (input.brand?.mlsClean !== true) {
    try {
      finalImageBytes = await compositeAttributionBand(finalImageBytes, input.brand ?? {})
    } catch {
      // Attribution band is best-effort — never fail the whole generation
    }
  }

  // 4. Store in Supabase `agent-media` — a public bucket, so the URL won't expire.
  let permanentUrl: string
  try {
    permanentUrl = await hostRenderedMedia(
      createServiceClient(),
      `ai-images/${input.purpose}/${Date.now()}-${randomSlug()}.png`,
      Buffer.from(finalImageBytes),
      "image/png",
      "agent-media",
    )
  } catch (err: any) {
    // errorCode kept as `blob_failed`: it is a stored CONTRACT with this
    // function's callers (they branch on it) and renaming it here would be a
    // silent behaviour change in code this lane does not own. The message now
    // names the real store.
    return { success: false, errorCode: "blob_failed", error: err?.message ?? "Supabase storage upload failed" }
  }

  return {
    success: true,
    imageUrl: permanentUrl,
    thumbnailUrl: permanentUrl,
    revisedPrompt,
    size,
    cost: COST_PER_IMAGE[`${quality}:${size}`] ?? 0.04,
  }
}

// ---------------------------------------------------------------------------
// Logo compositing via Sharp
// ---------------------------------------------------------------------------

async function compositeLogoOntoImage(imageBytes: Buffer, logoUrl: string): Promise<Buffer> {
  // Fetch the logo through the gateway (absolute-url download)
  const logoRes = await callConnector<Buffer>({
    connector: "asset-download", baseUrl: "", path: "", url: logoUrl,
    method: "GET", auth: { style: "none" }, responseType: "arraybuffer", timeoutMs: 20_000,
  })
  if (!logoRes.ok || !logoRes.data) return imageBytes
  const logoBytes = logoRes.data

  // Get the base image metadata to know its dimensions
  const baseMeta = await sharp(imageBytes).metadata()
  const baseWidth = baseMeta.width ?? 1024
  const baseHeight = baseMeta.height ?? 1024

  // Target logo size: at most 15% of image width, max 180px, min 60px
  const targetLogoWidth = Math.max(60, Math.min(180, Math.round(baseWidth * 0.15)))

  // Resize logo, preserving aspect ratio — convert to PNG for compositing
  const resizedLogo = await sharp(logoBytes)
    .resize({ width: targetLogoWidth, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer()

  // Get resized logo dimensions
  const logoMeta = await sharp(resizedLogo).metadata()
  const logoW = logoMeta.width ?? targetLogoWidth
  const logoH = logoMeta.height ?? 40

  // Padding from the corner
  const padding = Math.round(baseWidth * 0.025)

  // Add a semi-transparent white pill background behind the logo for readability
  const pillW = logoW + padding
  const pillH = logoH + Math.round(padding * 0.6)
  const pillSvg = Buffer.from(
    `<svg width="${pillW}" height="${pillH}">
      <rect x="0" y="0" width="${pillW}" height="${pillH}" rx="${Math.round(pillH / 2)}"
            fill="white" fill-opacity="0.85"/>
    </svg>`
  )

  const logoPill = await sharp(pillSvg)
    .composite([{
      input: resizedLogo,
      top: Math.round((pillH - logoH) / 2),
      left: Math.round((pillW - logoW) / 2),
    }])
    .png()
    .toBuffer()

  // Position: bottom-right corner
  const left = baseWidth - pillW - padding
  const top = baseHeight - pillH - padding

  return sharp(imageBytes)
    .composite([{ input: logoPill, left, top }])
    .png()
    .toBuffer()
}

// ---------------------------------------------------------------------------
// Attribution band — brokerage name + license # + EHO mark
// ---------------------------------------------------------------------------
// Composites a 56px-tall semi-transparent band along the bottom edge of the
// image carrying the legal attribution every public real-estate ad needs:
//
//   "[Brokerage Name] · License #[Number] ([State])    [⌂ Equal Housing Opportunity]"
//
// Skipped silently when no brokerage name is provided (private/draft images
// can still render). The Equal Housing Opportunity mark uses the standard
// house+equals glyph + text — no external image fetch needed.
async function compositeAttributionBand(
  imageBytes: Buffer,
  brand: BrandHints
): Promise<Buffer> {
  // Real-estate ad law requires SOME identifiable brokerage / team
  // attribution on every public-facing piece. Try brokerage DBA → brokerage
  // name → team name in that order. If none are available the band is
  // skipped (private/draft images).
  const tradeName = brand.brokerageDba ?? brand.brokerageName ?? brand.teamName
  if (!tradeName) return imageBytes

  const baseMeta = await sharp(imageBytes).metadata()
  const baseWidth  = baseMeta.width  ?? 1024
  const baseHeight = baseMeta.height ?? 1024

  // Build the attribution line. License # and state are appended when present.
  const licenseParts: string[] = []
  if (brand.brokerageLicense) {
    const state = brand.brokerageLicenseState ? ` (${brand.brokerageLicenseState})` : ""
    licenseParts.push(`Lic #${brand.brokerageLicense}${state}`)
  }
  if (brand.agentLicense && brand.agentLicense !== brand.brokerageLicense) {
    licenseParts.push(`Agent #${brand.agentLicense}`)
  }
  // Append the team name as a secondary line item when both a brokerage and
  // a team are present (e.g. "Sotheby's · The Smith Group · Lic #12345").
  const attributionTextParts: string[] = [tradeName]
  if (brand.teamName && brand.teamName !== tradeName) {
    attributionTextParts.push(brand.teamName)
  }
  attributionTextParts.push(...licenseParts)
  const attributionText = attributionTextParts.join(" · ")

  // SVG-text escape — these strings end up inside an SVG element so any
  // angle brackets, ampersands, or quotes in a brokerage name would break
  // the layout.
  const xmlEscape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

  const bandHeight = Math.max(48, Math.round(baseHeight * 0.06))
  const fontSize   = Math.max(14, Math.round(bandHeight * 0.4))
  const pad        = Math.round(bandHeight * 0.4)

  const svg = Buffer.from(`
    <svg width="${baseWidth}" height="${bandHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${baseWidth}" height="${bandHeight}"
            fill="black" fill-opacity="0.55"/>
      <text x="${pad}" y="${bandHeight / 2}"
            font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}"
            fill="white" dominant-baseline="middle">
        ${xmlEscape(attributionText)}
      </text>
      <!-- Equal Housing Opportunity mark on the right side. Glyph is the
           standard house outline + '=' rendered with SVG primitives. -->
      <g transform="translate(${baseWidth - pad - 200}, ${bandHeight / 2})">
        <text x="0" y="0"
              font-family="Arial, Helvetica, sans-serif" font-size="${Math.round(fontSize * 0.85)}"
              fill="white" dominant-baseline="middle">
          ⌂ Equal Housing Opportunity
        </text>
      </g>
    </svg>
  `)

  return sharp(imageBytes)
    .composite([{ input: svg, left: 0, top: baseHeight - bandHeight }])
    .png()
    .toBuffer()
}

// ---------------------------------------------------------------------------
// Brand-aware prompt builder
// ---------------------------------------------------------------------------

function buildBrandAwarePrompt(input: GenerateImageInput): string {
  const purposeBoilerplate: Record<ImagePurpose, string> = {
    social_post:
      "Modern, eye-catching social media image suitable for Instagram or Facebook. Square composition. Clean, scroll-stopping visual.",
    ad_creative:
      "Professional digital advertising creative. High contrast, clear focal point, suitable for display ads. Avoid text overlays.",
    blog_hero:
      "Editorial blog post hero image. Wide landscape composition. Photographic, magazine-quality. Avoid text.",
    newsletter_hero:
      "Newsletter header image. Wide landscape. Warm and welcoming, professional newsletter aesthetic.",
    postcard:
      "Direct mail postcard front image. High-quality, printable photography. Wide landscape composition. No text.",
    listing_visual:
      "Real estate listing photography style. Architectural / lifestyle composition. Wide landscape. Premium aesthetic.",
    podcast_cover:
      "Podcast cover art. Square composition. Bold, on-brand, distinctive at small thumbnail sizes.",
    event_banner:
      "Event banner image. Wide landscape. Inviting and clear, suitable for email + social promotion.",
    generic:
      "High-quality, on-brand visual.",
  }

  const lines: string[] = []
  lines.push(input.prompt)
  lines.push("")
  lines.push(purposeBoilerplate[input.purpose])

  if (input.listingContext) {
    const lc = input.listingContext
    const parts: string[] = []
    if (lc.bedrooms) parts.push(`${lc.bedrooms}-bedroom`)
    if (lc.bathrooms) parts.push(`${lc.bathrooms}-bathroom`)
    if (lc.address) parts.push(`at ${lc.address}`)
    if (lc.city) parts.push(`in ${lc.city}${lc.state ? `, ${lc.state}` : ""}`)
    if (parts.length > 0) {
      lines.push(`Property context: ${parts.join(" ")}.`)
    }
  }

  // Brand name only used in prompt when logo overlay is opted out or no logo is available
  const hasLogo = !!(input.brand?.logoUrl && !input.brand?.noLogo)
  if (!hasLogo && input.brand?.brokerageName) {
    lines.push(`Brand: ${input.brand.brokerageName}.`)
  }
  if (input.brand?.primaryColor) {
    lines.push(`Subtly incorporate the brand color ${input.brand.primaryColor}.`)
  }
  if (input.brand?.brandVoiceTone) {
    lines.push(`Brand tone: ${input.brand.brandVoiceTone}.`)
  }

  // Universal real-estate constraints — Fair Housing + no text overlays
  lines.push(
    "Constraints: Fair Housing compliant — depict no specific demographic or family composition. " +
      "No text or watermarks in the image. No real-estate logos. No fake people. " +
      "Photorealistic unless the brand tone explicitly calls for illustration."
  )

  return lines.join("\n")
}

function randomSlug(): string {
  return Math.random().toString(36).slice(2, 8)
}
