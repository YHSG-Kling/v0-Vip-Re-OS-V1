/**
 * lib/marketing/guide-booklet-content.ts
 *
 * Chapter content for the buyer/seller guide BOOKLETS — the designed PDF the
 * lead-magnet rail attaches to guide deliveries (before this, "guides"
 * shipped as email copy only; the booklet is what makes the magnet feel like
 * a real deliverable worth trading contact info for).
 *
 * Deterministic, evergreen, Fair-Housing-safe by construction (process and
 * money mechanics only — no demographics, no neighborhood steering). The
 * AI-personalized, demand-topic-grounded deliverable copy rides as the
 * booklet INTRO; these chapters are the durable spine. Keep any edits to the
 * same standard: verifiable process facts, no market predictions, no legal
 * or lending advice.
 */

export interface GuideChapter {
  heading: string
  body: string
}

export const BUYER_GUIDE_CHAPTERS: GuideChapter[] = [
  {
    heading: "Step 1 — Know your number before you shop",
    body:
      "Pre-approval is different from pre-qualification: a lender actually verifies your income, assets, and credit, then puts a number in writing. Sellers take offers with pre-approval letters seriously, and you avoid falling in love with homes outside your range.\n\n" +
      "Budget past the list price: plan for the inspection, the appraisal, homeowner's insurance, and closing costs that typically run two to five percent of the purchase price. Your monthly number should include taxes, insurance, and any HOA dues — not just principal and interest.",
  },
  {
    heading: "Step 2 — Search like an insider",
    body:
      "Make two lists: must-haves and nice-to-haves — and be honest about which is which. Commute, layout, and light are hard to change; paint and fixtures are easy.\n\n" +
      "Move quickly on new listings but never skip the walkthrough questions: how old are the roof, HVAC, and water heater? What do utilities actually run? Why is the seller moving? Your agent can often learn more in one phone call to the listing side than hours of scrolling can tell you.",
  },
  {
    heading: "Step 3 — Make an offer that wins without overpaying",
    body:
      "Price is only one lever. Sellers weigh certainty just as heavily: your financing strength, deposit size, flexibility on the closing date, and how clean your contingencies are.\n\n" +
      "A strong offer is grounded in comparable sales, not the list price. Your agent should show you what similar homes actually closed for in the last 90 days — that's your negotiating floor and ceiling in one picture.",
  },
  {
    heading: "Step 4 — Under contract: inspections, appraisal, and keeping the deal alive",
    body:
      "The inspection tells you what you're really buying. Focus on the expensive systems — roof, foundation, electrical, plumbing, HVAC — and negotiate repairs or credits on those, not on cosmetic items.\n\n" +
      "The appraisal protects your lender (and you) from overpaying. If it comes in low, there are usually three paths: renegotiate the price, bring the difference in cash, or challenge the appraisal with better comparables. Your agent will know which fits.",
  },
  {
    heading: "Step 5 — Closing day and your first year",
    body:
      "Before closing you'll do a final walkthrough to confirm the home's condition and that agreed repairs happened. Bring photo ID and your cashier's check or wire confirmation — and verify wire instructions BY PHONE with the title company using a number you look up yourself. Wire fraud is real and unrecoverable.\n\n" +
      "After closing, keep every settlement document for taxes, set reminders for insurance and warranty renewals, and revisit your home's value yearly — equity is a financial tool you can plan around.",
  },
]

export const SELLER_GUIDE_CHAPTERS: GuideChapter[] = [
  {
    heading: "Step 1 — Price it right the first time",
    body:
      "The market sets the price; the list price sets the strategy. Homes that launch too high sit, and the eventual price cut costs more than starting right would have — buyers read days-on-market as a discount signal.\n\n" +
      "A real comparative market analysis looks at what actually CLOSED near you in the last 90 days, adjusted for size, condition, and timing — not what neighbors are asking. Ask to see the closed comps, not just the recommendation.",
  },
  {
    heading: "Step 2 — Prepare the home buyers will pay more for",
    body:
      "You don't need a renovation; you need the home to photograph well and inspect clean. Declutter hard, brighten every room, fix the small visible defects (dripping taps, scuffed trim, dead bulbs) — these read as 'well cared for' and remove excuses to discount.\n\n" +
      "Photography is the first showing. Most buyers decide whether to tour from the photos alone, so professional images, an accurate floor plan, and an honest, benefit-led description do more than any open house.",
  },
  {
    heading: "Step 3 — Marketing that actually reaches buyers",
    body:
      "Buyers find homes through the MLS and the portals it feeds, through agents working their buyer lists, and increasingly through video and social reach. Your listing should exist in every one of those channels within days of launch — photos, video walkthrough, and targeted promotion, not just a sign in the yard.\n\n" +
      "Ask any agent you interview to show you the actual marketing calendar for your first fourteen days on market. Specifics beat promises.",
  },
  {
    heading: "Step 4 — Offers, negotiation, and picking the RIGHT buyer",
    body:
      "The highest offer isn't always the strongest. Weigh financing type and lender reputation, deposit size, contingencies, and the buyer's flexibility on your timeline. A clean offer fifty basis points lower often nets more than a fragile one that falls apart in week three.\n\n" +
      "Every counter is a chance to trade something cheap to you for something valuable to them — a rent-back, a faster close, an as-is clause on cosmetic items.",
  },
  {
    heading: "Step 5 — From contract to closing without surprises",
    body:
      "Expect the buyer's inspection to produce a request list; decide in advance what you'll repair, credit, or decline. Keep the home insurable and maintained until the day you hand over keys — the final walkthrough checks exactly that.\n\n" +
      "Know your net before you sign anything: sale price minus commission, closing costs, payoff, and any credits. A written net sheet at each price point turns negotiation from stressful guessing into simple arithmetic.",
  },
]

export function guideChaptersFor(kind: "buyer_guide" | "seller_guide"): GuideChapter[] {
  return kind === "buyer_guide" ? BUYER_GUIDE_CHAPTERS : SELLER_GUIDE_CHAPTERS
}

/**
 * AI-FIRST chapters (owner rule: content is never hardcoded in the
 * autonomous OS). The model rewrites the booklet grounded in (a) the real
 * demand topics buyers/sellers are asking right now and (b) the evergreen
 * chapters above as the factual floor it may not contradict — then the
 * whole text clears the compliance gate. Any failure at any step falls
 * back to the deterministic chapters (FH-safe by construction).
 */
export async function generateGuideChapters(
  kind: "buyer_guide" | "seller_guide",
  opts: {
    topics?: string[]
    area?: string | null
    gate?: (text: string) => Promise<{ allowed: boolean }>
    model?: string
  } = {},
): Promise<{ chapters: GuideChapter[]; fromAI: boolean }> {
  const fallback = guideChaptersFor(kind)
  try {
    const { gatewayChatJSON } = await import("@/lib/ai/gateway-chat")
    const res = await gatewayChatJSON<{ chapters: Array<{ heading?: string; body?: string }> }>({
      model: opts.model ?? "openai/gpt-4o-mini",
      maxTokens: 2400,
      temperature: 0.6,
      messages: [
        {
          role: "system",
          content:
            `You write a 5-chapter ${kind === "buyer_guide" ? "home buyer's" : "home seller's"} guide booklet. HARD RULES: ` +
            "FAIR HOUSING — never reference or imply race, religion, national origin, family status, disability, sex; " +
            "no steering language ('safe neighborhood', 'perfect for families', 'great for retirees'). " +
            "No legal, tax, or lending advice — process and money mechanics only. No market predictions, no invented statistics. " +
            "Keep the buyer guide's wire-fraud rule: verify wire instructions BY PHONE with the title company. " +
            'Return STRICT JSON: {"chapters":[{"heading":"Step N — ...","body":"2-3 short paragraphs separated by \\n\\n"}]} with exactly 5 chapters.',
        },
        {
          role: "user",
          content:
            `Rewrite this guide so it answers what people are ACTUALLY asking right now.\n` +
            (opts.area ? `Market area: ${opts.area}\n` : "") +
            (opts.topics?.length ? `Real questions being asked:\n${opts.topics.slice(0, 6).map((t) => `- ${t}`).join("\n")}\n` : "") +
            `Factual floor (do not contradict; you may restructure and sharpen):\n` +
            fallback.map((c) => `## ${c.heading}\n${c.body}`).join("\n\n"),
        },
      ],
    })
    const raw = res.ok ? res.data?.chapters : null
    if (!Array.isArray(raw) || raw.length !== 5) return { chapters: fallback, fromAI: false }
    const chapters: GuideChapter[] = raw.map((c, i) => ({
      heading: String(c.heading ?? fallback[i].heading).slice(0, 90),
      body: String(c.body ?? "").trim(),
    }))
    if (chapters.some((c) => c.body.length < 250)) return { chapters: fallback, fromAI: false }
    if (opts.gate) {
      const g = await opts.gate(chapters.map((c) => `${c.heading}\n${c.body}`).join("\n\n")).catch(() => ({ allowed: false }))
      if (!g.allowed) return { chapters: fallback, fromAI: false }
    }
    return { chapters, fromAI: true }
  } catch {
    return { chapters: fallback, fromAI: false }
  }
}
