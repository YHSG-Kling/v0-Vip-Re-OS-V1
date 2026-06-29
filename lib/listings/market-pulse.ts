// lib/listings/market-pulse.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE shaping for the MARKET PULSE — "what buyers are prioritizing right now," distilled from
// real-estate forum chatter into a SELLER-SAFE, actionable card on the seller portal. No competitor
// surfaces buyer sentiment to sellers. The AI distillation happens in the runner (gateway); this holds
// the deterministic FALLBACK floor, the seller-safe sanitizer (never raw forum quotes, never scary or
// off-message text), and the week key. No I/O — unit-testable.

export interface MarketPulseInsight {
  /** Short buyer-priority label, e.g. "Move-in ready". */
  priority: string
  /** One-line plain-language detail (seller-safe — no raw quotes). */
  detail: string
  /** What it means for the seller — actionable, positive. */
  sellerAngle: string
}

export interface MarketPulse {
  week: string
  headline: string
  insights: MarketPulseInsight[]
  generated: boolean
}

/** Evergreen, honest, seller-safe floor used when the gateway/scrape is unavailable. */
export const FALLBACK_MARKET_PULSE: Omit<MarketPulse, "week"> = {
  headline: "What buyers are focused on right now",
  generated: false,
  insights: [
    { priority: "Move-in ready", detail: "Buyers are gravitating to homes that need little work before they can settle in.", sellerAngle: "Small touch-ups and a clean, finished presentation make your home stand out." },
    { priority: "Monthly affordability", detail: "With rates top of mind, buyers weigh the monthly payment as much as the price.", sellerAngle: "Sharp pricing — and offering a rate-buydown — can widen the pool of buyers who can act." },
    { priority: "Energy efficiency", detail: "Lower utility bills and efficient systems are a real draw.", sellerAngle: "Highlight efficient windows, HVAC, or solar — buyers notice." },
  ],
}

// Anything that reads as raw forum venting / off-message / unsafe never reaches the seller.
const UNSAFE = /\b(scam|hate|stupid|idiot|crash|screwed|f\*+|sh\*+|lawsuit|fraud|racist|ghetto)\b/i

/** PURE. Validate + clamp an AI-distilled pulse to a seller-safe shape; drop unsafe insights; if nothing
 *  usable survives, return null so the caller uses the fallback. */
export function sanitizeMarketPulse(raw: unknown, week: string): MarketPulse | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as { headline?: unknown; insights?: unknown }
  const headline = typeof r.headline === "string" && r.headline.trim() && !UNSAFE.test(r.headline)
    ? r.headline.trim().slice(0, 80)
    : FALLBACK_MARKET_PULSE.headline
  const rawInsights = Array.isArray(r.insights) ? r.insights : []
  const insights: MarketPulseInsight[] = []
  for (const it of rawInsights) {
    if (!it || typeof it !== "object") continue
    const i = it as { priority?: unknown; detail?: unknown; sellerAngle?: unknown }
    const priority = typeof i.priority === "string" ? i.priority.trim().slice(0, 40) : ""
    const detail = typeof i.detail === "string" ? i.detail.trim().slice(0, 160) : ""
    const sellerAngle = typeof i.sellerAngle === "string" ? i.sellerAngle.trim().slice(0, 160) : ""
    if (!priority || !detail) continue
    if (UNSAFE.test(priority) || UNSAFE.test(detail) || UNSAFE.test(sellerAngle)) continue
    insights.push({ priority, detail, sellerAngle: sellerAngle || "A point worth keeping in mind as you prepare your home." })
    if (insights.length >= 4) break
  }
  if (insights.length === 0) return null
  return { week, headline, insights, generated: true }
}

/** PURE. Monday (UTC) of the week containing `now`, YYYY-MM-DD — the pulse's stable week key. */
export function marketPulseWeek(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const dow = d.getUTCDay()
  d.setUTCDate(d.getUTCDate() + ((dow === 0 ? -6 : 1) - dow))
  return d.toISOString().slice(0, 10)
}

/** PURE. Build the gateway prompt that distills forum thread titles into seller-safe buyer priorities. */
export function buildMarketPulsePrompt(threadTitles: string[]): string {
  const titles = threadTitles.slice(0, 40).map((t) => `- ${t.replace(/\s+/g, " ").slice(0, 160)}`).join("\n")
  return `You are a real-estate market analyst. Below are recent thread titles from home-BUYER forums.
Distill them into the top 3-4 things BUYERS are prioritizing or worried about RIGHT NOW, written for a home SELLER to read on their portal.

Return ONLY valid JSON: {"headline":"...","insights":[{"priority":"...","detail":"...","sellerAngle":"..."}]}

Rules:
- SELLER-SAFE + positive + actionable. NEVER quote raw forum text, profanity, doom, or anything that would worry or offend a seller.
- ZERO Fair Housing references (no race, religion, family, age, "good schools", "safe neighborhood", "perfect for").
- priority: 2-5 words. detail: one plain sentence (<160 chars). sellerAngle: what the seller can do about it (<160 chars), encouraging.
- headline: 4-8 words.

Forum titles:
${titles}

Return the JSON now.`
}
