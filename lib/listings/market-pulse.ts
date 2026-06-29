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
  /** One-line plain-language detail (audience-safe — no raw quotes). */
  detail: string
  /** What it means for the SELLER — actionable, positive. */
  sellerAngle: string
  /** What it means for the BUYER — how to use it to compete / act with confidence. One scrape, both
   *  lenses: the seller portal reads sellerAngle, the buyer portal reads buyerAngle. */
  buyerAngle: string
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
    { priority: "Move-in ready", detail: "Buyers are gravitating to homes that need little work before they can settle in.", sellerAngle: "Small touch-ups and a clean, finished presentation make your home stand out.", buyerAngle: "Move-in-ready homes draw the most interest — when you find one you love, tour it quickly and be ready to act." },
    { priority: "Monthly affordability", detail: "With rates top of mind, buyers weigh the monthly payment as much as the price.", sellerAngle: "Sharp pricing — and offering a rate-buydown — can widen the pool of buyers who can act.", buyerAngle: "Know your monthly comfort range before you shop — a fresh pre-approval lets you move the moment the right home appears." },
    { priority: "Energy efficiency", detail: "Lower utility bills and efficient systems are a real draw.", sellerAngle: "Highlight efficient windows, HVAC, or solar — buyers notice.", buyerAngle: "Ask your agent about utility costs and efficient systems — they affect what you'll really pay each month." },
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
    const i = it as { priority?: unknown; detail?: unknown; sellerAngle?: unknown; buyerAngle?: unknown }
    const priority = typeof i.priority === "string" ? i.priority.trim().slice(0, 40) : ""
    const detail = typeof i.detail === "string" ? i.detail.trim().slice(0, 160) : ""
    const sellerAngle = typeof i.sellerAngle === "string" ? i.sellerAngle.trim().slice(0, 160) : ""
    const buyerAngle = typeof i.buyerAngle === "string" ? i.buyerAngle.trim().slice(0, 160) : ""
    if (!priority || !detail) continue
    if (UNSAFE.test(priority) || UNSAFE.test(detail) || UNSAFE.test(sellerAngle) || UNSAFE.test(buyerAngle)) continue
    insights.push({
      priority,
      detail,
      sellerAngle: sellerAngle || "A point worth keeping in mind as you prepare your home.",
      buyerAngle: buyerAngle || "A point worth keeping in mind as you plan your search with your agent.",
    })
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
Distill them into the top 3-4 things BUYERS are prioritizing or worried about RIGHT NOW. For EACH point,
write BOTH a seller angle (for a home seller's portal) AND a buyer angle (for a home buyer's portal).

Return ONLY valid JSON: {"headline":"...","insights":[{"priority":"...","detail":"...","sellerAngle":"...","buyerAngle":"..."}]}

Rules:
- SAFE + positive + actionable for BOTH audiences. NEVER quote raw forum text, profanity, doom, or anything that would worry or offend a reader.
- ZERO Fair Housing references (no race, religion, family, age, "good schools", "safe neighborhood", "perfect for").
- Make NO guarantees, NO predictions of price/rate movement, and NO pressure tactics — inform and empower, don't push.
- priority: 2-5 words. detail: one plain sentence (<160 chars).
- sellerAngle: what the SELLER can do about it (<160 chars), encouraging.
- buyerAngle: how the BUYER can use it to search and compete with confidence (<160 chars), encouraging — often "talk to your agent / lender".
- headline: 4-8 words.

Forum titles:
${titles}

Return the JSON now.`
}
