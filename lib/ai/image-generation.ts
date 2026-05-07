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
 *   4. Re-upload to Vercel Blob (permanent URL)
 *   5. Caller persists to marketing_assets
 *
 * Why re-upload: DALL-E URLs expire in 1 hour. The platform needs the image
 * to live in our blob storage so we control retention + can attach to any
 * surface long-term.
 */

import "server-only"
import { put } from "@vercel/blob"

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
  primaryColor?: string | null
  agentName?: string | null
  brandVoiceTone?: string | null
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

export async function generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return { success: false, errorCode: "no_api_key", error: "OPENAI_API_KEY not configured" }
  }

  const size = input.size ?? DEFAULT_SIZES[input.purpose]
  const quality = input.quality ?? "standard"
  const style = input.style ?? "natural"

  const fullPrompt = buildBrandAwarePrompt(input)

  // 1. Call DALL-E 3
  let dalleResp: { url: string; revisedPrompt: string } | null = null
  try {
    const base = input.endpointBase ?? "https://api.openai.com/v1"
    const res = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "dall-e-3",
        prompt: fullPrompt,
        size,
        quality,
        style,
        n: 1,
      }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => "")
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
        error: `DALL-E (${res.status}): ${body || res.statusText}`,
      }
    }

    const data = await res.json()
    const item = data?.data?.[0]
    if (!item?.url) {
      return { success: false, errorCode: "unknown", error: "DALL-E returned no image" }
    }
    dalleResp = { url: item.url, revisedPrompt: item.revised_prompt ?? fullPrompt }
  } catch (err: any) {
    return { success: false, errorCode: "unknown", error: err?.message ?? "Network error" }
  }

  // 2. Download the image bytes
  let imageBytes: ArrayBuffer
  try {
    const dl = await fetch(dalleResp.url)
    if (!dl.ok) {
      return { success: false, errorCode: "unknown", error: `Image download failed: ${dl.status}` }
    }
    imageBytes = await dl.arrayBuffer()
  } catch (err: any) {
    return { success: false, errorCode: "unknown", error: err?.message ?? "Download failed" }
  }

  // 3. Upload to Vercel Blob — public URL won't expire
  let permanentUrl: string
  try {
    const filename = `ai-images/${input.purpose}/${Date.now()}-${randomSlug()}.png`
    const blob = await put(filename, imageBytes, {
      access: "public",
      contentType: "image/png",
    })
    permanentUrl = blob.url
  } catch (err: any) {
    return { success: false, errorCode: "blob_failed", error: err?.message ?? "Blob upload failed" }
  }

  return {
    success: true,
    imageUrl: permanentUrl,
    thumbnailUrl: permanentUrl,
    revisedPrompt: dalleResp.revisedPrompt,
    size,
    cost: COST_PER_IMAGE[`${quality}:${size}`] ?? 0.04,
  }
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
  lines.push("") // blank line
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

  if (input.brand?.brokerageName) {
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
