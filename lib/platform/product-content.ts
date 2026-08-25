// lib/platform/product-content.ts
// ─────────────────────────────────────────────────────────────────────────────
// PLATFORM SOCIAL SELF-MARKETING — the platform uses its own marketing muscle to
// market VIP AGENTS ITSELF on the company's social channels. Distinct from tenant
// social (a brokerage posting listings via its connected accounts): platform
// channels are company-owned, so content lives as GATED drafts in
// platform_social_drafts (draft → approved → posted), worked by the platform
// MARKETING role. Copy is honest product story — differentiators, no fabricated
// stats or client claims. Publishing records the permalink when the post goes out
// (manual today; the lib/social publisher can be attached when platform accounts
// get their own credential home — tenant social_media_accounts is brokerage-scoped
// by design and is NOT reused here).

import { type ProductBrand, DEFAULT_PRODUCT_BRAND, brandCta, topicToAngle } from "./product-brand"

export const PRODUCT_CHANNELS = ["linkedin", "instagram", "facebook", "x"] as const
export type ProductChannel = (typeof PRODUCT_CHANNELS)[number]

export const X_MAX_CHARS = 280

// The honest differentiator angles — the product story, no invented numbers.
export const PRODUCT_ANGLES: Record<string, { hook: string; proof: string }> = {
  ai_team: {
    hook: "Most real-estate software is another dashboard. {name} is an AI TEAM.",
    proof: "13 accountable AI managers hand real work to each other — lead to deal to lifetime client — and every action is owned, gated, and auditable in one command center.",
  },
  command_center: {
    hook: "One command center. Zero orphaned work.",
    proof: "Every queue, every handoff, every autonomous action has a named AI owner — and the OS watches itself and escalates its own breaches.",
  },
  voice_admin: {
    hook: "Say it. It's done.",
    proof: "The voice admin takes a command — 'follow up with every stale buyer this week' — and the AI team executes it end to end, gated for compliance at the wire.",
  },
  lead_to_lifetime: {
    hook: "From scraped lead to lifetime client — one system runs the whole journey.",
    proof: "Prospecting, qualification, deals, marketing video, closings, anniversaries, referrals: the same AI team carries the relationship for years, not weeks.",
  },
  compliance_wire: {
    hook: "Compliance isn't a checkbox here. It's a gate at the wire.",
    proof: "Fair Housing, consent, and content safety are enforced on the final message before it sends — autonomously blocked, recorded, and auditable.",
  },
  whole_business: {
    hook: "Not just leads. The whole brokerage.",
    proof: "Recruiting and retaining agents, vendor marketplace, commissions, reporting, client education — the AI team runs the business processes, humans make the calls.",
  },
}

// TOMBSTONE (orphan doctrine §1.3) — this name is no longer exported: PRODUCT_HASHTAGS.
// Nothing in the product imported it, and no simulator did either; the
// value is live and unchanged, reached through this module's own exported
// functions, which is where callers already get its effect. Same ruling and same
// reasoning as lib/vendors/appraiser-independence.ts (isAppraiserTrade,
// labelNamesAppraisal): an export with no importer is a public surface nobody
// asked for, and the wire to build is not a second copy of the module's door.
const PRODUCT_HASHTAGS: Record<ProductChannel, string> = {
  linkedin: "#RealEstate #AI #Proptech #BrokerageGrowth",
  instagram: "#realestate #realtor #ai #realestateagent #proptech",
  facebook: "#RealEstate #AI #Realtor",
  x: "#RealEstate #AI #Proptech",
}

export interface ProductPost {
  channel: ProductChannel
  angle: string
  content: string
  hashtags: string
}

/** PURE: compose one channel-shaped product post. BRAND-DRIVEN (the app name is
 *  configurable in platform settings — never hardcoded) and every CTA carries UTMs
 *  so the growth funnel can attribute channel × angle. A watched TOPIC (competitor
 *  buzz / trend) can override the static angle via `custom`. X stays ≤ 280 chars. */
const applyBrand = (text: string, brand: ProductBrand) => text.split("{name}").join(brand.name)

export function composeProductPost(
  channel: ProductChannel, angle: string,
  brand: ProductBrand = DEFAULT_PRODUCT_BRAND,
  custom?: { hook: string; proof: string },
): ProductPost {
  const raw = custom ?? PRODUCT_ANGLES[angle] ?? PRODUCT_ANGLES.ai_team
  const a = { hook: applyBrand(raw.hook, brand), proof: applyBrand(raw.proof, brand) }
  const angleKey = custom ? "topic" : (PRODUCT_ANGLES[angle] ? angle : "ai_team")
  const cta = `See the AI team live → ${brandCta(brand, channel, angleKey === "topic" ? angle : angleKey)}`
  let content: string
  if (channel === "x") {
    content = `${a.hook} ${cta}`
    if (content.length > X_MAX_CHARS) content = content.slice(0, X_MAX_CHARS - 1) + "…"
  } else if (channel === "linkedin") {
    content = `${a.hook}\n\n${a.proof}\n\nWe built ${brand.name} for the teams and brokerages that are done stitching ten tools together. ${cta}`
  } else {
    content = `${a.hook}\n\n${a.proof}\n\n${cta}`
  }
  return { channel, angle: angleKey, content, hashtags: PRODUCT_HASHTAGS[channel] }
}

/** PURE + deterministic: a week of product content rotating angles × channels.
 *  Takes startDateIso explicitly (no Date.now) so a calendar is reproducible. */
export function buildWeeklyProductCalendar(
  startDateIso: string,
  brand: ProductBrand = DEFAULT_PRODUCT_BRAND,
  topics: string[] = [],
): Array<ProductPost & { scheduledFor: string }> {
  const start = new Date(startDateIso + "T00:00:00Z")
  if (Number.isNaN(start.getTime())) throw new Error("startDateIso must be YYYY-MM-DD")
  const angles = Object.keys(PRODUCT_ANGLES)
  const out: Array<ProductPost & { scheduledFor: string }> = []
  for (let day = 0; day < 7; day++) {
    const channel = PRODUCT_CHANNELS[day % PRODUCT_CHANNELS.length]
    const angle = angles[day % angles.length]
    const d = new Date(start.getTime() + day * 86_400_000)
    // Watched topics (competitor buzz / trends) take the odd days so the week mixes
    // evergreen differentiators with what the market is talking about RIGHT NOW.
    const topic = day % 2 === 1 ? topics[(day - 1) / 2] : undefined
    const custom = topic ? topicToAngle(topic, brand) : undefined
    out.push({ ...composeProductPost(channel, angle, brand, custom), scheduledFor: d.toISOString().slice(0, 10) })
  }
  return out
}

export const DRAFT_STATUSES = ["draft", "approved", "posted", "discarded"] as const
export type DraftStatus = (typeof DRAFT_STATUSES)[number]

/** PURE: legal status transitions — posted requires a permalink; posted/discarded are terminal. */
export function canTransitionDraft(from: string, to: string, permalink?: string | null): { ok: boolean; reason?: string } {
  if (!(DRAFT_STATUSES as readonly string[]).includes(to)) return { ok: false, reason: "unknown status" }
  if (from === "posted" || from === "discarded") return { ok: false, reason: `${from} is terminal` }
  if (to === "posted" && from !== "approved") return { ok: false, reason: "approve before posting" }
  if (to === "posted" && !(permalink ?? "").trim()) return { ok: false, reason: "permalink required to mark posted" }
  return { ok: true }
}

// ── PRODUCT VIDEO (the same story, video-shaped) ──────────────────────────────
// The platform's promo videos reuse PRODUCT_ANGLES so text posts and reels tell
// ONE honest story. The spec targets the real ProductPromoReel Remotion
// composition (registered in remotion/Root.tsx): hook → three proof beats → CTA,
// 15s @30fps. Render via the existing Remotion tooling
// (`npx remotion render ProductPromoReel out.mp4 --props=...`), then attach the
// file URL to the draft; the gated lifecycle (approve → posted w/ permalink) is
// unchanged — a video draft additionally requires video_url before posting.

export const VIDEO_FORMATS = {
  vertical: { width: 1080, height: 1920, channel: "instagram" as ProductChannel },
  square:   { width: 1080, height: 1080, channel: "linkedin" as ProductChannel },
} as const
export type ProductVideoFormat = keyof typeof VIDEO_FORMATS

export interface ProductVideoSpec {
  compositionId: "ProductPromoReel"
  format: ProductVideoFormat
  width: number
  height: number
  fps: 30
  durationInFrames: 450
  inputProps: { hook: string; proofs: string[]; cta: string; brand: { primaryColor: string; accentColor: string; name?: string; tagline?: string }; ctaDomain?: string; imageUrls?: string[] }
  /** The voiceover/caption script — hook + beats + CTA, honest, no invented stats. */
  script: string
  /** The social caption that ships WITH the video (same composer as text posts). */
  caption: string
  channel: ProductChannel
  angle: string
}

/** PURE + deterministic: three proof beats = the chosen angle's proof + the next
 *  two angles' proofs in catalog order (wrapping) — variety without randomness. */
export function videoProofBeats(angle: string): string[] {
  const keys = Object.keys(PRODUCT_ANGLES)
  const start = Math.max(0, keys.indexOf(angle))
  return [0, 1, 2].map((i) => PRODUCT_ANGLES[keys[(start + i) % keys.length]].proof)
}

export function composeProductVideoSpec(
  angle: string, format: ProductVideoFormat = "vertical",
  brand: ProductBrand = DEFAULT_PRODUCT_BRAND,
  topic?: string | null,
  imageUrls: string[] = [],
): ProductVideoSpec {
  const custom = topic ? topicToAngle(topic, brand) : undefined
  const rawA = custom ?? PRODUCT_ANGLES[angle] ?? PRODUCT_ANGLES.ai_team
  const a = { hook: applyBrand(rawA.hook, brand), proof: applyBrand(rawA.proof, brand) }
  const resolvedAngle = custom ? "topic" : (PRODUCT_ANGLES[angle] ? angle : "ai_team")
  const f = VIDEO_FORMATS[format] ?? VIDEO_FORMATS.vertical
  const beats = custom
    ? [custom.proof, ...videoProofBeats("ai_team").slice(0, 2)]
    : videoProofBeats(resolvedAngle)
  const cta = "See the AI team hand a real deal between managers — live."
  const post = composeProductPost(f.channel, custom ? angle : resolvedAngle, brand, custom)
  return {
    compositionId: "ProductPromoReel",
    format: VIDEO_FORMATS[format] ? format : "vertical",
    width: f.width,
    height: f.height,
    fps: 30,
    durationInFrames: 450,
    inputProps: {
      hook: a.hook, proofs: beats, cta,
      brand: { primaryColor: brand.primaryColor, accentColor: brand.accentColor, name: brand.name, tagline: brand.tagline },
      ctaDomain: brand.ctaUrl.replace(/^https?:\/\//, "") + "/get-started",
      imageUrls,
    },
    script: [a.hook, ...beats, cta].join("\n"),
    caption: post.content,
    channel: f.channel,
    angle: resolvedAngle,
  }
}
