// lib/platform/product-brand.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PLATFORM'S OWN BRAND KIT — the app's NAME is still being decided, so it must
// never be hardcoded (just like tenants get their brand cascade, the platform gets
// its own). Stored on the platform_settings singleton (product_brand jsonb), edited
// by platform marketing staff; every self-marketing surface (posts, reels, pitch,
// /get-started) resolves through resolveProductBrand. CTA links carry UTM params so
// the growth funnel can attribute which channel/angle produced each signup.

/**
 * THE PLATFORM'S OWN LIVE AGENT (lane 77B, owner verbatim: "the platform should
 * also offer the same ai agents like the live agent using d-id because the
 * platform can use those ai agents as a demo'd product"). The platform's
 * D-ID presenter is part of its brand kit — its face and voice — and lives
 * HERE, on the platform_settings singleton, NEVER on a tenant's twin row
 * (agent_avatar_assets / agent_voice_profiles belong to a real agent, whose
 * likeness is not the platform's to borrow). The presenter is a D-ID stock
 * Expressive (V4) avatar id (`name@avt_…` from D-ID's public gallery — no
 * likeness of a real person, so the consent gate in app/api/did/create-avatar
 * is never involved) or an `avt_…` id the platform trained under its own
 * account. `didAgentId` is the cached D-ID Agent record lib/did/platform-live-
 * agent.ts creates once and the did-agent-sync cron keeps patched.
 */
export interface ProductLiveAgent {
  /** D-ID presenter id (Expressive: `public_x@avt_…` or `avt_…`). null = not configured → the surface falls back to text chat. */
  presenterId: string | null
  /** ElevenLabs voice id for the platform agent; null = D-ID's default voice. */
  voiceId: string | null
  /** The agent's display name (what D-ID shows and what it calls itself). */
  name: string
  /** Opening line the live widget shows before the first turn. */
  greeting: string
  /** Free-text personality folded into the D-ID Agent's baseline instructions. */
  personality: string | null
  /** A pre-rendered public sample clip (mp4) the agent may play on "show me" — rendered ONCE, never per conversation. */
  demoClipUrl: string | null
  /** Cached D-ID Agent id (server-written by lib/did/platform-live-agent.ts; never edited by hand). */
  didAgentId: string | null
}

export interface ProductBrand {
  name: string
  tagline: string
  primaryColor: string
  accentColor: string
  /** Marketing site origin for CTAs (no trailing slash). */
  ctaUrl: string
  /** What the AI receptionist SAYS the product is (owner rule: no hardcoded
   *  prompts — the platform line's pitch is a setting like everything else). */
  voicePitch: string
  /** The platform line's opening question (the legal preamble is composed
   *  around it automatically — never part of the setting). */
  receptionGreeting: string
  /** The platform's own D-ID live agent (lane 77B). */
  liveAgent: ProductLiveAgent
}

export const DEFAULT_PRODUCT_LIVE_AGENT: ProductLiveAgent = {
  presenterId: null,
  voiceId: null,
  name: "Guide",
  greeting: "Hi — I'm the live AI guide. I'm the same live agent every subscriber's website gets. Ask me anything about the platform, or tell me what you run and I'll show you what it would do for you.",
  personality: null,
  demoClipUrl: null,
  didAgentId: null,
}

export const DEFAULT_PRODUCT_BRAND: ProductBrand = {
  name: "VIP Agents",
  tagline: "The AI team that runs the whole business",
  primaryColor: "#0F172A",
  accentColor: "#F59E0B",
  ctaUrl: "https://vipagents.ai",
  voicePitch: "an AI-powered operating system for real-estate brokerages, teams, and agents — an accountable AI team that handles reception, follow-up, marketing, and operations in one command center",
  receptionGreeting: "Are you calling to learn about the platform, or are you already a customer who needs support?",
  liveAgent: DEFAULT_PRODUCT_LIVE_AGENT,
}

const HEX = /^#[0-9a-fA-F]{6}$/
/** A D-ID presenter id: the Expressive family (`avt_…`, optionally `name@avt_…`) or a gallery presenter slug. */
const PRESENTER_ID = /^[A-Za-z0-9_@.-]{3,120}$/

/** PURE: the live-agent block — bad values fall back field by field, never the whole block. */
export function resolveProductLiveAgent(raw: any): ProductLiveAgent {
  const r = raw ?? {}
  const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null)
  const presenterId = str(r.presenterId, 120)
  const demoClipUrl = str(r.demoClipUrl, 500)
  return {
    presenterId: presenterId && PRESENTER_ID.test(presenterId) ? presenterId : null,
    voiceId: str(r.voiceId, 80),
    name: str(r.name, 40) ?? DEFAULT_PRODUCT_LIVE_AGENT.name,
    greeting: str(r.greeting, 300) ?? DEFAULT_PRODUCT_LIVE_AGENT.greeting,
    personality: str(r.personality, 600),
    demoClipUrl: demoClipUrl && /^https:\/\//.test(demoClipUrl) ? demoClipUrl : null,
    didAgentId: str(r.didAgentId, 120),
  }
}

/** PURE: merge a stored product_brand jsonb over the defaults; bad values fall back. */
export function resolveProductBrand(raw: any): ProductBrand {
  const r = raw ?? {}
  return {
    name: (typeof r.name === "string" && r.name.trim()) ? r.name.trim().slice(0, 60) : DEFAULT_PRODUCT_BRAND.name,
    tagline: (typeof r.tagline === "string" && r.tagline.trim()) ? r.tagline.trim().slice(0, 140) : DEFAULT_PRODUCT_BRAND.tagline,
    primaryColor: HEX.test(r.primaryColor ?? "") ? r.primaryColor : DEFAULT_PRODUCT_BRAND.primaryColor,
    accentColor: HEX.test(r.accentColor ?? "") ? r.accentColor : DEFAULT_PRODUCT_BRAND.accentColor,
    ctaUrl: (typeof r.ctaUrl === "string" && /^https?:\/\//.test(r.ctaUrl)) ? r.ctaUrl.replace(/\/$/, "") : DEFAULT_PRODUCT_BRAND.ctaUrl,
    voicePitch: (typeof r.voicePitch === "string" && r.voicePitch.trim()) ? r.voicePitch.trim().slice(0, 600) : DEFAULT_PRODUCT_BRAND.voicePitch,
    receptionGreeting: (typeof r.receptionGreeting === "string" && r.receptionGreeting.trim()) ? r.receptionGreeting.trim().slice(0, 300) : DEFAULT_PRODUCT_BRAND.receptionGreeting,
    liveAgent: resolveProductLiveAgent(r.liveAgent),
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
