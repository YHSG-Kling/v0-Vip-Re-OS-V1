/**
 * lib/listing-presentation/section-narration.ts
 *
 * Wave 39 — the per-section narration the agent's avatar/voice clone speaks over
 * each pre-listing presentation section. This is the CONTENT that sells the
 * seller on the brokerage + agent + marketing system over any other local
 * agent — deterministic + seller-safe (NEVER states the home's value; that is
 * deferred to the in-person meeting), so it is fully testable and never leaks a
 * suggested price.
 *
 * Flow: buildSectionNarrationScript() → ElevenLabs TTS in the agent's cloned
 * voice → D-ID talking-head → the avatar PIP narrates the section. The script
 * also drives the on-screen bullets so copy + voiceover stay in sync.
 */
import { findSuggestedPriceLeaks } from "@/lib/cma/customer-facing-guard"

export interface NarrationInput {
  sectionKey:    string
  brokerageName: string
  agentName:     string
  areaName?:     string | null
  teamName?:     string | null
}

export interface SectionNarration {
  sectionKey: string
  /** Full narration for ElevenLabs TTS. */
  script:     string
  /** Short on-screen lines (kept in sync with the script). */
  bullets:    string[]
}

export function buildSectionNarrationScript(input: NarrationInput): SectionNarration {
  const agent = (input.agentName || "your agent").trim()
  const brokerage = (input.brokerageName || "our brokerage").trim()
  const team = input.teamName?.trim()
  const where = input.areaName?.trim() || "your neighborhood"
  const us = team ? `${team} at ${brokerage}` : brokerage

  const S: Record<string, SectionNarration> = {
    intro: {
      sectionKey: "intro",
      script: `Hi, I'm ${agent} with ${us}. Before we even meet, I want to show you exactly how we'll sell your home — with a marketing system no other agent in ${where} runs. Let's walk through it together.`,
      bullets: ["A marketing system no other local agent runs.", `Here's how ${us} will sell your home — before we meet.`],
    },
    credibility: {
      sectionKey: "credibility",
      script: `${us} doesn't just list homes — we market them. You get a full team behind you, not a single busy agent, and a proven track record right here in ${where}. When you hire us, you hire the whole system.`,
      bullets: ["A team behind you, not one busy agent.", `Proven results right here in ${where}.`],
    },
    marketing: {
      sectionKey: "marketing",
      script: `Here's how we sell: cinematic video, animated market data, and omnipresent digital reach across every channel where today's buyers are actually looking. Your home won't be a flyer — it'll be marketed like a brand.`,
      bullets: ["Cinematic video + animated market data.", "Omnipresent reach where buyers actually look.", "Your home, marketed like a brand."],
    },
    process: {
      sectionKey: "process",
      script: `From listing to closing, you'll always know what's next. You and I stay on the same page every step of the way — no surprises, no chasing, no guesswork. We make selling feel effortless.`,
      bullets: ["A clear path from listing to closing.", "You and your agent on the same page, every step."],
    },
    closing: {
      sectionKey: "closing",
      script: `When we meet, I'll walk you through your home's value and our complete strategy in person. Bring your questions — I'll bring the plan. Let's get your home sold for everything it's worth.`,
      bullets: ["Bring your questions — we'll bring the plan.", "Your home's value, covered in person."],
    },
    market: {
      sectionKey: "market",
      script: `Let's look at your market. These are recent comparable sales and where prices are heading in ${where}. Your home's specific value is the very first thing we'll cover when we sit down together.`,
      bullets: [`Recent comparable sales + where ${where} is heading.`, "Your home's value — discussed in person."],
    },
    cma: {
      sectionKey: "cma",
      script: `Here's the market analysis for ${where} — the comparable sales, how long homes are taking to sell, and what buyers are paying. Your home's specific number? We'll go through that together at our meeting, where I can factor in everything that makes your home unique.`,
      bullets: ["The comparable sales + market velocity.", "Your home's number — covered at our meeting."],
    },
  }

  const out = S[input.sectionKey] ?? {
    sectionKey: input.sectionKey,
    script: `${us} is ready to sell your home with a marketing system built for today's market. Let's talk strategy when we meet.`,
    bullets: [`${us} — a marketing system built for today's market.`],
  }

  // Compliance belt: the narration must never carry a suggested price.
  if (findSuggestedPriceLeaks({ script: out.script, bullets: out.bullets }).length > 0) {
    return { sectionKey: out.sectionKey, script: out.script.replace(/\$[\d,]+/g, "the right price"), bullets: out.bullets }
  }
  return out
}

export const NARRATABLE_SECTION_KEYS = ["intro", "credibility", "marketing", "process", "closing", "market", "cma"] as const
