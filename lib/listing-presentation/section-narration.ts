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
import { detectFairHousingViolations } from "@/lib/compliance-rules/fair-housing-patterns"
import { MARKETING_SYSTEM_FLOOR } from "@/lib/listing-presentation/marketing-system"
import { compositionSeconds, geometryFor } from "@/lib/remotion/composition-geometry"
import {
  narrationBudget,
  narrationLengthDirective,
  narrationMaxTokens,
  fitNarrationToBudget,
  spokenWords,
  type NarrationBudget,
} from "@/lib/video/script-structure"

/**
 * The composition these scripts are SPOKEN OVER.
 *
 * section-render.ts queues every non-CMA section as a `ListingSectionReel`, and
 * that composition carries the narration as an <Audio> INSIDE the composition
 * (remotion/ListingSectionReel.tsx:63) against a FIXED durationInFrames. Nothing
 * pads it — an overrun is CUT, mid-word, in a video already sent to a seller. So
 * the script has to be sized to the composition before it is written.
 */
export const SECTION_NARRATION_COMPOSITION = "ListingSectionReel"

/**
 * What a section script is allowed to be, DERIVED from the composition's real
 * geometry. Change ListingSectionReel's durationInFrames and this moves with it;
 * there is no 20 written down anywhere.
 */
export function sectionNarrationBudget(
  compositionId: string = SECTION_NARRATION_COMPOSITION,
): NarrationBudget {
  const geo = geometryFor(compositionId)
  return narrationBudget(compositionId, geo ? compositionSeconds(geo) : 0)
}

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

// ── AI narration (the WOW differentiator) ───────────────────────────────────
// Per-section creative brief that steers the AI toward a compelling, specific,
// seller-safe script — not generic filler. The deterministic builder above is
// the fallback when the AI is unavailable.
const SECTION_BRIEF: Record<string, string> = {
  intro:       "Warmly introduce yourself and build anticipation that what follows is a marketing system unlike any other local agent's.",
  credibility: "Establish why this team wins listings — results, the team behind the seller, deep local expertise — so the seller feels they're in the best possible hands.",
  marketing:   "Showcase the marketing machine (cinematic listing video, animated market-data reels, the agent's AI avatar, omnipresent social + portal reach, AI-search-optimized property pages) and contrast it with the tired flyer-and-MLS approach other agents still use.",
  process:     "Reassure the seller the path from listing to closing is clear and stress-free, and that they and the agent stay on the same page the whole way — reduce their anxiety.",
  closing:     "Invite them to the meeting where you'll reveal their home's value and the full strategy; create momentum to choose you.",
  market:      "Walk through the local market with confidence — direction, comparable activity, how fast homes are selling — WITHOUT revealing their home's value.",
  cma:         "Frame the analysis as proof of your data-driven approach and show the market context, while explicitly deferring the home's specific number to the in-person meeting.",
}

// ── TOMBSTONE — `DEFAULT_MARKETING_SYSTEM` (the const that used to be here) ──
//
// SURVIVOR: lib/listing-presentation/marketing-system.ts
//   · MARKETING_SYSTEM_CLAIMS — the six claims, each re-attached to the
//     entitlement that makes it true
//   · composeMarketingSystem() — the pure selector
//   · MARKETING_SYSTEM_FLOOR — the claim-free sentence used when nothing
//     resolves
// The I/O half is lib/listing-presentation/marketing-system-resolver.ts
// resolveMarketingSystem(), called by lib/listing-presentation/section-render.ts.
//
// WHAT IT WAS: one frozen English sentence naming six capabilities, used as the
// fallback for `input.marketingSystem` — which NOTHING in the tree ever set. So
// every seller of every tenant on every plan heard the same six claims, in their
// agent's cloned voice, whether or not that brokerage could deliver them.
//
// WHY IT MOVED (owner ruling, reversing the previous wave's §1 verdict): the
// default marketing system is part of the listing presentation and part of
// ADVERTISEMENT, so it is an active function, not a constant. The previous wave
// un-exported the const because the export had no importers; the export was
// indeed orphaned, but the WRITER was the missing half, and §1.2 says build it.
//
// The measured finding that made this more than tidying: on the live database
// `agent_voice_profiles` and `agent_avatar_assets` both hold ZERO rows, so the
// third claim — a personal AI-avatar video series — was being promised to
// sellers by a platform on which no agent has a voice clone or an avatar, while
// the orchestrator quietly degraded those very sections to on_screen_only. And
// `brokerages.farm_mail_enabled` is false for both live tenants, so the
// direct-mail half of the sixth claim was equally unbacked. The catalogue gates
// both on real facts rather than on the plan alone.
//
// Deliberately NOT re-declared here as a string: a second copy of this prose is
// exactly the §6 defect, and the whole point is that there is no longer a single
// sentence that is true for every tenant.

export interface AINarrationInput extends NarrationInput {
  /** The composition this narration will be spoken over. Defaults to
   *  SECTION_NARRATION_COMPOSITION; pass another id and the word budget
   *  re-derives from THAT composition's geometry. */
  compositionId?:   string
  /** The agent's own angle / proof points (users.presentation_take). */
  agentTake?:       string | null
  /**
   * What THIS brokerage can actually claim to deliver, composed by
   * lib/listing-presentation/marketing-system-resolver.ts resolveMarketingSystem()
   * from the tenant's real entitlements and account state.
   *
   * NO LONGER OPTIONAL IN PRACTICE — section-render.ts sets it on every call.
   * It stays optional in the TYPE because the deterministic path and the
   * simulators construct inputs without a database, and because the fallback
   * below is the safe one: an absent value composes the CLAIM-FREE floor
   * sentence, never the six-capability boast the retired constant made. See the
   * tombstone above.
   */
  marketingSystem?: string | null
  /** Background market context (never a price): e.g. "rising", "balanced". */
  marketTrend?:     string | null
  avgDaysOnMarket?: number | null
}

/**
 * Generate a compelling, personalized, SELLER-SAFE narration script for one
 * section using the platform's metered AI gateway. Weaves the brokerage
 * marketing system, the agent's own take, and market context into as much
 * spoken text as the composition can actually play. Falls back to the
 * deterministic builder on any AI failure, and scrubs any dollar figure the
 * model emits (the no-price rule is absolute).
 *
 * ── LENGTH IS NOW A CONSTRAINT, NOT A HOPE ──────────────────────────────────
 * The prompt asked for "3 to 5 sentences" and the gateway was given 320 tokens,
 * so a typical draft ran 60–80 words ≈ 24–32 spoken seconds against a
 * composition that then ran TEN SECONDS. Two thirds of every section narration
 * was cut off mid-word and nothing anywhere noticed. Both halves are fixed here:
 * the prompt now carries the budget DERIVED from the composition's geometry, and
 * the returned text is measured and trimmed at a sentence boundary if the model
 * ignored it. The deterministic fallback goes through the same trim — it was
 * ~45 words, and it ships exactly when the AI is unavailable.
 *
 * AND THEN THE OTHER HALF: capping a 60–80 word script to 20 words left these
 * sections saying one sentence. m566 widened ListingSectionReel from 300 to 900
 * frames (10s → 30s), which is why the budget now reads 60 words — enough for
 * the 4–5 sentence paragraph the brief below actually asks for, and comfortably
 * over the 33–46 words the deterministic fallbacks run. NOTHING here was
 * retyped to make that happen: the number below is still geometryFor() ×
 * compositionSeconds() and it moved on its own.
 *
 * BOTH the AI path and the fallback can come back flagged `stillOverBudget`
 * when even one sentence does not fit; that is logged loudly rather than
 * swallowed, because it means the COMPOSITION is too short for what this
 * section has to say and only a geometry change can fix it.
 */
export async function generateSectionNarration(input: AINarrationInput): Promise<SectionNarration> {
  const budget = sectionNarrationBudget(input.compositionId ?? SECTION_NARRATION_COMPOSITION)
  const rawFallback = buildSectionNarrationScript(input)
  /** The deterministic script, held to the same budget as the AI's. */
  const fallback = ((): SectionNarration => {
    const fit = fitNarrationToBudget(rawFallback.script, budget)
    if (fit.note) console.warn(`[section-narration] deterministic fallback — ${fit.note}`)
    return { ...rawFallback, script: fit.script }
  })()
  const brief = SECTION_BRIEF[input.sectionKey]
  if (!brief) return fallback

  const agent = (input.agentName || "your agent").trim()
  const brokerage = (input.brokerageName || "our brokerage").trim()
  const us = input.teamName?.trim() ? `${input.teamName.trim()} at ${brokerage}` : brokerage
  const where = input.areaName?.trim() || "your neighborhood"

  const prompt = [
    `You are writing the spoken narration for ${agent}, a real estate agent at ${us}, that their AI avatar will speak in ${agent}'s own cloned voice over ONE section of a pre-listing presentation video sent to a home seller in ${where} BEFORE the listing appointment.`,
    ``,
    `SECTION GOAL: ${brief}`,
    `OVERALL GOAL: Wow the seller and prove why they should list with ${us} over any other local agent — sell the marketing system and the relationship.`,
    input.agentTake?.trim() ? `\nTHE AGENT'S OWN ANGLE (weave in naturally, first person):\n${input.agentTake.trim()}` : ``,
    // ADVERTISING, SPOKEN TO A CONSUMER. Every capability named here is one the
    // resolver proved this tenant is entitled to and has the account state for;
    // an absent value falls to the CLAIM-FREE floor rather than to a boast.
    // The model is told it may not add to the list — the catalogue is authored
    // and reviewed prose, and a model-invented seventh capability would be an
    // unbacked claim in the agent's own cloned voice.
    `\nTHE MARKETING SYSTEM TO SELL — these are the ONLY capabilities you may claim, and you may claim ALL of them:\n${(input.marketingSystem?.trim() || MARKETING_SYSTEM_FLOOR)}`,
    input.marketTrend?.trim() ? `\nMARKET BACKGROUND (context only — never quote a price): the market is ${input.marketTrend.trim()}${input.avgDaysOnMarket ? `, homes averaging about ${input.avgDaysOnMarket} days on market` : ``}.` : ``,
    ``,
    `HARD RULES:`,
    `- NEVER state the seller's home value, a suggested list price, or ANY dollar figure. Defer all pricing to the in-person meeting.`,
    // COMPLIANCE-FIRST (§5): the advertising bound is an INPUT to the writing
    // prompt, not a grade applied afterwards. The claim list was already
    // capability-gated and fair-housing screened before it got here.
    `- NEVER invent a marketing capability. Claim ONLY what THE MARKETING SYSTEM TO SELL lists above — no extra channels, no guarantees, no results promises, no timelines, and no claim about what other agents do or do not do.`,
    `- Fair housing is absolute: describe the HOME and the MARKETING, never the people who live in the area. No reference to who a neighborhood is for, no schools, no "safe", no "family" framing.`,
    `- First person ("I", "my team", "we"), warm, confident, specific to ${where} — not generic.`,
    // WAS "3 to 5 sentences" — a fixed count that no composition duration ever
    // agreed with. The ceiling now comes from ListingSectionReel's own geometry.
    `- ${narrationLengthDirective(budget)} Conversational, meant to be spoken aloud. No bullet points, no markdown, no stage directions, no salutations.`,
    `- This is ${agent} speaking directly to the homeowner.`,
    ``,
    `Write only the narration text.`,
  ].filter(Boolean).join("\n")

  try {
    const { generateAIText } = await import("@/lib/ai/generate")
    const { text } = await generateAIText(prompt, {
      maxTokens: narrationMaxTokens(budget), temperature: 0.8, feature: "listing_presentation_narration",
    })
    let script = (text ?? "").trim().replace(/^["“]|["”]$/g, "")
    // "The model returned junk" floor. WAS `script.length < 40` — a character
    // literal that would start rejecting VALID output the moment the derived
    // budget dropped below ~7 words, i.e. it fought the cap. Counted in words
    // instead, well under any real budget.
    if (spokenWords(script).length < 3) return fallback
    // Absolute no-price rule — scrub any dollar figure or leaked valuation.
    if (/\$\s?\d/.test(script) || findSuggestedPriceLeaks({ script }).length > 0) {
      script = script.replace(/\$\s?[\d,]+(?:\.\d+)?/g, "the right price")
    }
    // ── FAIR-HOUSING BELT, AND THIS PATH HAD NONE ──────────────────────────
    // Measured while wiring the marketing-system function: the price scrub above
    // was the ONLY compliance check on this producer. Every other AI video-script
    // path in the repo goes through runWithComplianceRedraft (listing-promo,
    // intro-video, avatar-explainer, podcast, direct-mail, generate-client-message)
    // — this one goes through neither that nor buildComplianceSystemBlocks, while
    // producing a script SPOKEN IN THE AGENT'S CLONED VOICE to a home seller.
    // The frozen marketing string satisfied nothing by being static; it simply
    // was not model-authored. Now that the prompt composes per-tenant claims, the
    // model's output needs the belt the prompt's braces already assume.
    //
    // §5's disposition exactly: a HARD (high-severity) fair-housing hit does not
    // ship — it falls back to the deterministic script, which is authored copy
    // that cannot carry a protected-class reference — and medium/low ride through
    // as warnings, because escalating those would hold up every presentation.
    // Deliberately the DETERMINISTIC detector rather than a second model call:
    // it is pure, it cannot itself fail open, and a fallback is always available
    // here, so refusing costs the seller nothing.
    const fhHits = detectFairHousingViolations(script)
    if (fhHits.some((v) => v.severity === "high")) {
      console.warn(
        `[section-narration] ${input.sectionKey} — HARD fair-housing flag in the generated script `
        + `(${fhHits.filter((v) => v.severity === "high").map((v) => v.phrase).join(", ")}); `
        + `falling back to the deterministic script rather than speaking it to a seller.`,
      )
      return fallback
    }
    if (fhHits.length > 0) {
      console.warn(`[section-narration] ${input.sectionKey} — advisory fair-housing finding(s), passing through per §5: ${fhHits.map((v) => v.severity).join(", ")}`)
    }
    // VERIFY, don't trust. "At most N words" in a prompt is a request; this is
    // the enforcement. An overrun is trimmed at a sentence boundary and SAID SO
    // — it must never pass silently, which is the whole defect.
    const fit = fitNarrationToBudget(script, budget)
    if (fit.note) console.warn(`[section-narration] ${input.sectionKey} — ${fit.note}`)
    if (!fit.script) return fallback
    // Bullets stay deterministic (concise, seller-safe on-screen text).
    return { sectionKey: input.sectionKey, script: fit.script, bullets: fallback.bullets }
  } catch {
    return fallback
  }
}
