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

export const PRODUCT_CHANNELS = ["linkedin", "instagram", "facebook", "x"] as const
export type ProductChannel = (typeof PRODUCT_CHANNELS)[number]

export const X_MAX_CHARS = 280

// The honest differentiator angles — the product story, no invented numbers.
export const PRODUCT_ANGLES: Record<string, { hook: string; proof: string }> = {
  ai_team: {
    hook: "Most real-estate software is another dashboard. VIP Agents is an AI TEAM.",
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

export const PRODUCT_HASHTAGS: Record<ProductChannel, string> = {
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

/** PURE: compose one channel-shaped product post for an angle. X stays ≤ 280 chars. */
export function composeProductPost(channel: ProductChannel, angle: string): ProductPost {
  const a = PRODUCT_ANGLES[angle] ?? PRODUCT_ANGLES.ai_team
  const cta = "See the AI team live → /get-started"
  let content: string
  if (channel === "x") {
    content = `${a.hook} ${cta}`
    if (content.length > X_MAX_CHARS) content = content.slice(0, X_MAX_CHARS - 1) + "…"
  } else if (channel === "linkedin") {
    content = `${a.hook}\n\n${a.proof}\n\nWe built VIP Agents for the teams and brokerages that are done stitching ten tools together. ${cta}`
  } else {
    content = `${a.hook}\n\n${a.proof}\n\n${cta}`
  }
  return { channel, angle: PRODUCT_ANGLES[angle] ? angle : "ai_team", content, hashtags: PRODUCT_HASHTAGS[channel] }
}

/** PURE + deterministic: a week of product content rotating angles × channels.
 *  Takes startDateIso explicitly (no Date.now) so a calendar is reproducible. */
export function buildWeeklyProductCalendar(startDateIso: string): Array<ProductPost & { scheduledFor: string }> {
  const start = new Date(startDateIso + "T00:00:00Z")
  if (Number.isNaN(start.getTime())) throw new Error("startDateIso must be YYYY-MM-DD")
  const angles = Object.keys(PRODUCT_ANGLES)
  const out: Array<ProductPost & { scheduledFor: string }> = []
  for (let day = 0; day < 7; day++) {
    const channel = PRODUCT_CHANNELS[day % PRODUCT_CHANNELS.length]
    const angle = angles[day % angles.length]
    const d = new Date(start.getTime() + day * 86_400_000)
    out.push({ ...composeProductPost(channel, angle), scheduledFor: d.toISOString().slice(0, 10) })
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
