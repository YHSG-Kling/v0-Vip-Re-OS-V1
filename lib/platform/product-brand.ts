// lib/platform/product-brand.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PLATFORM'S OWN BRAND KIT — the app's NAME is still being decided, so it must
// never be hardcoded (just like tenants get their brand cascade, the platform gets
// its own). Stored on the platform_settings singleton (product_brand jsonb), edited
// by platform marketing staff; every self-marketing surface (posts, reels, pitch,
// /get-started) resolves through resolveProductBrand. CTA links carry UTM params so
// the growth funnel can attribute which channel/angle produced each signup.

export interface ProductBrand {
  name: string
  tagline: string
  primaryColor: string
  accentColor: string
  /** Marketing site origin for CTAs (no trailing slash). */
  ctaUrl: string
}

export const DEFAULT_PRODUCT_BRAND: ProductBrand = {
  name: "VIP Agents",
  tagline: "The AI team that runs the whole business",
  primaryColor: "#0F172A",
  accentColor: "#F59E0B",
  ctaUrl: "https://vipagents.ai",
}

const HEX = /^#[0-9a-fA-F]{6}$/

/** PURE: merge a stored product_brand jsonb over the defaults; bad values fall back. */
export function resolveProductBrand(raw: any): ProductBrand {
  const r = raw ?? {}
  return {
    name: (typeof r.name === "string" && r.name.trim()) ? r.name.trim().slice(0, 60) : DEFAULT_PRODUCT_BRAND.name,
    tagline: (typeof r.tagline === "string" && r.tagline.trim()) ? r.tagline.trim().slice(0, 140) : DEFAULT_PRODUCT_BRAND.tagline,
    primaryColor: HEX.test(r.primaryColor ?? "") ? r.primaryColor : DEFAULT_PRODUCT_BRAND.primaryColor,
    accentColor: HEX.test(r.accentColor ?? "") ? r.accentColor : DEFAULT_PRODUCT_BRAND.accentColor,
    ctaUrl: (typeof r.ctaUrl === "string" && /^https?:\/\//.test(r.ctaUrl)) ? r.ctaUrl.replace(/\/$/, "") : DEFAULT_PRODUCT_BRAND.ctaUrl,
  }
}

/** PURE: the attributed get-started CTA — UTMs let the funnel see which channel/angle converts. */
export function brandCta(brand: ProductBrand, utmSource: string, utmCampaign: string): string {
  return `${brand.ctaUrl}/get-started?utm_source=${encodeURIComponent(utmSource)}&utm_campaign=${encodeURIComponent(utmCampaign)}`
}

/** Load the platform brand (singleton row; defaults when unset). */
export async function loadProductBrand(svc: any): Promise<ProductBrand> {
  try {
    const { data } = await svc.from("platform_settings").select("product_brand").limit(1).maybeSingle()
    return resolveProductBrand((data as any)?.product_brand)
  } catch {
    return DEFAULT_PRODUCT_BRAND
  }
}

// ── TOPIC POOL — reels/posts pull topics from competitor watching + trends ─────

export const TOPIC_SOURCES = ["manual", "competitor", "trend"] as const

export interface ContentTopic {
  id?: string
  source: string
  topic: string
  competitor?: string | null
  url?: string | null
}

export type TopicValidation = { ok: true; value: { source: string; topic: string; competitor: string | null; url: string | null } } | { ok: false; error: string }

export function validateTopic(input: ContentTopic): TopicValidation {
  const topic = (input.topic ?? "").trim()
  if (topic.length < 8) return { ok: false, error: "Topic must be at least 8 characters" }
  const source = (TOPIC_SOURCES as readonly string[]).includes(input.source) ? input.source : "manual"
  return { ok: true, value: { source, topic: topic.slice(0, 240), competitor: (input.competitor ?? "").trim() || null, url: (input.url ?? "").trim() || null } }
}

/**
 * PURE: turn a watched topic into an HONEST angle — we speak to the conversation
 * without disparaging a competitor or inventing claims. The proof line is always
 * about OUR architecture, never about their product.
 */
export function topicToAngle(topic: string, brand: ProductBrand): { hook: string; proof: string } {
  const t = topic.trim().replace(/\s+/g, " ").slice(0, 140)
  return {
    hook: `Everyone's talking about ${t}. Here's the part that matters.`,
    proof: `Features come and go — what compounds is an accountable AI TEAM: every handoff owned, every send compliance-gated at the wire, one command center from lead to lifetime client. That's what ${brand.name} is.`,
  }
}
