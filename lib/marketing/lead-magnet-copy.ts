// lib/marketing/lead-magnet-copy.ts
//
// LEAD-MAGNET + LANDING COPY (pure) — the AI writes the marketing surface AND the deliverable. Two
// jobs: (1) landingPageCopy generates the capture page's copy (headline / subhead / CTA / value
// bullets) for a home-value tool or a lead magnet; (2) magnetDeliverableCopy generates the actual
// CONTENT the user receives for filling out the form (the "First-Time Buyer Guide", the equity
// report intro, etc.) — the thing that was missing, so a lead magnet finally DELIVERS something.
//
// This is MARKETING copy, separate from the kernel-owned portal VIEW + education (the kernel decides
// what a contact sees inside the portal; this is the public-facing acquisition copy). Deterministic,
// Fair-Housing-safe fallbacks are REAL content (never a stub); an injectable AI generator personalizes
// to the agent's brand + the persona; every output still clears the compliance gate at the runner.
// Pure (no I/O), unit-tested directly.

export type MagnetType =
  | "home_valuation" | "buyer_guide" | "seller_guide" | "market_report" | "listing_alert" | "open_house" | "generic_form"

export interface LandingCopy {
  headline: string
  subhead: string
  cta: string
  bullets: string[]
}

export interface MagnetDeliverable {
  /** email subject when the deliverable is sent. */
  subject: string
  title: string
  /** the actual guide/report body the user receives. */
  body: string
}

export interface CopyContext {
  /** the agent/brokerage trade name, for branding the copy. */
  brand?: string | null
  /** city/area for localization (never a protected-class signal). */
  area?: string | null
}

// ── Landing-page copy (deterministic, Fair-Housing-safe) ─────────────────────
// No steering language (no "family", "safe", "perfect for", demographics, religion).
const LANDING: Record<MagnetType, LandingCopy> = {
  home_valuation: {
    headline: "What's your home worth today?",
    subhead: "Get an instant estimate, then a precise, agent-prepared value with real local comps — no obligation.",
    cta: "Get my home value",
    bullets: ["Instant estimate in seconds", "A precise CMA from a local expert", "No pressure, no obligation"],
  },
  buyer_guide: {
    headline: "The complete guide to buying a home",
    subhead: "Everything from pre-approval to closing day, in plain language — yours free.",
    cta: "Send me the guide",
    bullets: ["Step-by-step from search to keys", "What to budget beyond the price", "How to write a strong offer"],
  },
  seller_guide: {
    headline: "Sell for more, with less stress",
    subhead: "The pricing, prep, and marketing playbook that gets homes sold — yours free.",
    cta: "Send me the guide",
    bullets: ["How pricing strategy drives the sale", "Prep that pays off (and what to skip)", "What modern marketing looks like"],
  },
  market_report: {
    headline: "Your local market, this month",
    subhead: "Prices, days on market, and what it means for you — delivered to your inbox.",
    cta: "Send me the report",
    bullets: ["Real local price trends", "How fast homes are selling", "What it means for your timing"],
  },
  listing_alert: {
    headline: "Be first to new listings",
    subhead: "Get matched homes the moment they hit the market — before the crowd.",
    cta: "Set up my alerts",
    bullets: ["New listings matched to you", "Price-change alerts", "Be first, not last"],
  },
  open_house: {
    headline: "Join us at the open house",
    subhead: "Get the details, directions, and a private follow-up if you'd like one.",
    cta: "RSVP now",
    bullets: ["Date, time, and address", "What to look for at the showing", "A no-pressure follow-up if you want it"],
  },
  generic_form: {
    headline: "Let's talk about your move",
    subhead: "Tell us a little about what you're looking for and we'll take it from there.",
    cta: "Get started",
    bullets: ["A real local expert", "Answers, not pressure", "Help whenever you're ready"],
  },
}

// ── Deliverable content (deterministic, Fair-Housing-safe, REAL copy) ─────────
const DELIVERABLE: Record<MagnetType, MagnetDeliverable> = {
  home_valuation: {
    subject: "Your home value — and the precise number",
    title: "Your Home Value",
    body: "Thanks for checking your home's value! The instant estimate is a great starting point, but an automated number can't see recent upgrades, your exact block, or how your home shows. When you're ready, I'll prepare a precise comparative market analysis (CMA) with real local comps so you have an accurate number — whether you're just curious or starting to plan a move. Just reply and I'll get it started.",
  },
  buyer_guide: {
    subject: "Your home-buying guide is here",
    title: "The Complete Home-Buying Guide",
    body: "Here's your guide. The short version: (1) Get pre-approved so you know your budget and can move fast. (2) Define must-haves vs. nice-to-haves. (3) Tour with a plan and take notes. (4) Budget for closing costs and inspections, not just the price. (5) Write a strong, clean offer with the right contingencies. (6) Use your inspection period wisely. (7) Stay responsive through closing. I'm here for every step — reply any time with a question.",
  },
  seller_guide: {
    subject: "Your home-selling guide is here",
    title: "Sell for More, With Less Stress",
    body: "Here's your guide. The essentials: (1) Pricing strategy matters more than any single feature — price to the market, not to a wish. (2) Prep that pays: declutter, deep-clean, small repairs, great photos. (3) Modern marketing means video, social, and reaching real buyers where they look. (4) Review every offer on its full terms, not just price. (5) Stay ahead of inspection and appraisal. When you'd like a tailored plan for your home, just reply.",
  },
  market_report: {
    subject: "Your local market report",
    title: "Your Local Market, This Month",
    body: "Here's the snapshot. We track real local price trends, how many days homes are taking to sell, and the balance of buyers vs. listings — then translate it into what it means for YOUR timing, whether you're buying or selling. Want this each month, tailored to your neighborhood? Reply and I'll set it up.",
  },
  listing_alert: {
    subject: "Your listing alerts are set",
    title: "New Listings, First",
    body: "You're all set to get new and price-improved listings matched to what you described, the moment they hit the market. Want to fine-tune your criteria (price, area, beds/baths, must-haves)? Just reply and we'll dial it in.",
  },
  open_house: {
    subject: "Open house details",
    title: "See You at the Open House",
    body: "Thanks for your interest! You'll find the date, time, and address attached. A quick tip: take a few notes on what you love (and don't), and feel free to ask me anything during or after. No pressure — I'm happy to follow up only if you'd like.",
  },
  generic_form: {
    subject: "Thanks for reaching out",
    title: "Let's Talk About Your Move",
    body: "Thanks for getting in touch! Tell me a little about what you're looking for and your timeline, and I'll take it from there with real, local help — answers first, never pressure. Reply whenever you're ready.",
  },
}

function brandLine(ctx?: CopyContext): string {
  return ctx?.brand ? ` — ${ctx.brand}` : ""
}

/** Landing-page copy for a magnet/home-value page. Pure, Fair-Housing-safe. */
export function landingPageCopy(magnetType: MagnetType, ctx?: CopyContext): LandingCopy {
  const base = LANDING[magnetType] ?? LANDING.generic_form
  const area = ctx?.area?.trim()
  return {
    headline: base.headline,
    subhead: area ? `${base.subhead} Serving ${area}${brandLine(ctx)}.` : `${base.subhead}${brandLine(ctx)}`,
    cta: base.cta,
    bullets: base.bullets,
  }
}

/** The deliverable content the user receives for filling out the form. Pure, Fair-Housing-safe. */
export function magnetDeliverableCopy(magnetType: MagnetType, ctx?: CopyContext): MagnetDeliverable {
  const base = DELIVERABLE[magnetType] ?? DELIVERABLE.generic_form
  return { subject: base.subject, title: base.title, body: ctx?.brand ? `${base.body}\n\n— ${ctx.brand}` : base.body }
}

/** Whether a magnet type ships a downloadable deliverable on submit (open_house is event info, not a guide). */
export function magnetHasDeliverable(magnetType: MagnetType): boolean {
  return magnetType !== "generic_form"
}

export interface PrepareMagnetOpts {
  /** injectable persona-copy generator seam (tests pass () => null for the deterministic copy). */
  copyGenerator?: import("@/lib/kernel/ai-copy").CopyGenerator
  /** the gate seam (tests pass a pass-through; production routes evaluateOutbound). */
  gate?: (text: string) => Promise<{ allowed: boolean; violations: string[] }>
}

/**
 * Prepare the deliverable copy a contact gets for filling out the form — gated. Returns null when the
 * magnet ships no deliverable (e.g. generic_form) or the copy can't clear the gate. The AI generator +
 * gate are injectable seams; with the defaults it's deterministic + self-allowed (the copy is FH-safe).
 * Not server-only (the simulator drives it) — no DB I/O here; the runner records the delivery.
 */
export async function prepareMagnetDeliverable(
  magnetType: MagnetType, ctx: CopyContext | undefined, opts: PrepareMagnetOpts = {},
): Promise<MagnetDeliverable | null> {
  if (!magnetHasDeliverable(magnetType)) return null
  const fallback = magnetDeliverableCopy(magnetType, ctx)

  let body = fallback.body
  if (opts.copyGenerator) {
    try {
      const { generatePersonaCopy } = await import("@/lib/kernel/ai-copy")
      const draft = await generatePersonaCopy(
        { goal: `the deliverable content for a ${magnetType.replace(/_/g, " ")} lead magnet`, facts: [fallback.body], channel: "email", persona: { audience: "audience" }, words: 160 },
        { body: fallback.body }, { generator: opts.copyGenerator },
      )
      body = (draft.body || fallback.body).trim()
    } catch { /* keep the safe deterministic copy */ }
  }

  if (opts.gate) {
    const res = await opts.gate(`${fallback.subject}\n${body}`).catch(() => ({ allowed: false, violations: ["gate error"] }))
    if (!res.allowed) return null
  }

  return { subject: fallback.subject, title: fallback.title, body }
}
