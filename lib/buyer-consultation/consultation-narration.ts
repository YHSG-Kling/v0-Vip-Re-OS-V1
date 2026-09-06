/**
 * lib/buyer-consultation/consultation-narration.ts
 *
 * The per-slide narration the agent's avatar speaks over each BUYER
 * CONSULTATION slide — the buyer-side mirror of
 * lib/listing-presentation/section-narration.ts, sized to the composition that
 * actually plays it.
 *
 * ── THE BUDGET IS SIX SECONDS, NOT THIRTY ──────────────────────────────────
 * BuyerConsultationSlide runs 180 frames at 30fps (remotion/Root.tsx). The
 * listing lane's ListingSectionReel runs 900. Copying the listing budget here
 * would ship a ~60-word script over a 6-second slide, and the narration rides
 * INSIDE the composition against a fixed durationInFrames — nothing pads it, so
 * the overrun is CUT MID-WORD in a video already sent to a buyer (the defect
 * section-narration.ts:27-35 records). So the budget is DERIVED from
 * BuyerConsultationSlide's own geometry via the same sectionNarrationBudget
 * (§6 — one derivation, not a second copy), and every script — AI or
 * deterministic — is measured and trimmed against it.
 *
 * ── COMPLIANCE (§5, compliance-first) ──────────────────────────────────────
 * The fair-housing belt is COPIED from the listing lane: buyer narration talks
 * about neighborhoods and searches, which is exactly the fair-housing surface —
 * the length limit is in the writing prompt, the fair-housing bound is in the
 * writing prompt, and the deterministic detector runs over the output. A HARD
 * (high-severity) hit falls back to the authored deterministic copy; advisory
 * findings pass through as warnings per §5.
 *
 * What is deliberately NOT copied: findSuggestedPriceLeaks. That guard exists
 * to keep the SELLER'S OWN valuation out of pre-appointment material (the
 * number is the agent's to give at the meeting). A buyer deck has no subject
 * property and no valuation to withhold — the prices it shows
 * (searchExamples[].price) are PUBLIC LIST PRICES of active listings,
 * legitimately shown to the buyer they were saved for. Scrubbing them would
 * blank the one slide the deck exists for.
 */
import { detectFairHousingViolations } from "@/lib/compliance-rules/fair-housing-patterns"
import { sectionNarrationBudget } from "@/lib/listing-presentation/section-narration"
import {
  narrationLengthDirective,
  narrationMaxTokens,
  fitNarrationToBudget,
  spokenWords,
  type NarrationBudget,
} from "@/lib/video/script-structure"
import type { BuyerSlideKind } from "@/remotion/BuyerConsultationSlide"

/** The composition every buyer-consultation slide renders on. */
export const BUYER_SLIDE_COMPOSITION = "BuyerConsultationSlide"

/** What one slide's script is allowed to be — derived from the composition's
 *  real geometry (180f / 30fps ⇒ ~12 words), never a literal. */
export function buyerSlideNarrationBudget(): NarrationBudget {
  return sectionNarrationBudget(BUYER_SLIDE_COMPOSITION)
}

export interface BuyerNarrationInput {
  kind:          BuyerSlideKind
  agentName:     string
  brokerageName: string
  /** Buyer's first name — personalizes the title/closing scripts. */
  buyerFirstName?: string | null
  /** "City, ST" the buyer is searching in. Free text — goes through the belt. */
  areaName?:     string | null
  /** The agent's own angle (users.presentation_take) — AI prompt only. */
  agentTake?:    string | null
  /** loan slide nuance: is a pre-approval on file? */
  preApproved?:  boolean | null
}

export interface BuyerSlideNarration {
  kind:   BuyerSlideKind
  /** Spoken narration (avatar/voice). Sized to the 6-second slide. */
  script: string
  /** On-screen body paragraphs (read, not spoken — the composition's `body`). */
  body:   string[]
}

/**
 * Deterministic, authored copy — the fallback when the AI is unavailable and
 * the safe harbor when a generated script trips the fair-housing belt. Every
 * script below is written UNDER the 6-second budget on purpose; the trim in
 * generateBuyerSlideNarration is a belt, not the sizing.
 */
export function buildBuyerSlideNarration(input: BuyerNarrationInput): BuyerSlideNarration {
  const agent = (input.agentName || "your agent").trim()
  const brokerage = (input.brokerageName || "our brokerage").trim()
  const name = input.buyerFirstName?.trim()
  const hi = name ? `Hi ${name}` : "Hi"

  const S: Record<BuyerSlideKind, BuyerSlideNarration> = {
    title: {
      kind: "title",
      script: `${hi}, I'm ${agent} — here's your personal home-buying plan.`,
      body: [
        "A personalized walkthrough of your search, your financing, your offer, and your closing.",
        `Prepared by ${agent} at ${brokerage} ahead of your consultation.`,
      ],
    },
    loan: {
      kind: "loan",
      script: input.preApproved
        ? `Your pre-approval tells sellers you're ready — let's put it to work.`
        : `Pre-approval tells sellers you're serious. Let's get yours in place.`,
      body: input.preApproved
        ? ["A pre-approval is on file for you.", "We'll walk through exactly what it unlocks for your offers when we meet."]
        : ["Pre-approval is the first move — it defines your search and strengthens every offer.", "We'll map your options together at the consultation."],
    },
    search: {
      kind: "search",
      script: `Here's what your search actually looks like right now.`,
      body: ["Pulled from the homes you've saved — list prices as published."],
    },
    offer_strategy: {
      kind: "offer_strategy",
      script: `When you find the one, here's how we win it.`,
      body: [
        "Competitive terms, clean contingencies, and fast responses — planned before you need them.",
        "We prepare the strategy in advance, so your offer moves first.",
      ],
    },
    timeline: {
      kind: "timeline",
      script: `From accepted offer to keys in hand — here's the path.`,
      body: ["Every step has an owner and a date. You'll always know what's next."],
    },
    closing: {
      kind: "closing",
      script: `Bring your questions — we'll map your whole search together.`,
      body: [
        "We'll cover your financing, your target homes, and your offer plan at the consultation.",
        `— ${agent}, ${brokerage}`,
      ],
    },
  }
  return S[input.kind]
}

// Per-slide creative brief for the AI path. Fair housing is an explicit bound
// IN THE WRITING PROMPT (§5 compliance-first), not only in the post-hoc scan.
const SLIDE_BRIEF: Record<BuyerSlideKind, string> = {
  title:          "Warmly welcome the buyer to their personalized home-buying plan and set up what the next slides cover.",
  loan:           "Explain in one breath why pre-approval matters to sellers, without quoting any amount, rate, or lender terms.",
  search:         "Introduce the example homes on screen as what their search looks like right now — the homes speak for themselves.",
  offer_strategy: "Give the buyer confidence that the offer strategy is prepared before they need it.",
  timeline:       "Reassure the buyer the path from accepted offer to closing is clear and managed.",
  closing:        "Invite them to bring questions to the consultation; create momentum to meet.",
}

/**
 * Generate ONE slide's spoken narration through the metered AI gateway, held to
 * the composition's derived budget, with the fair-housing belt over the output.
 * Falls back to the authored deterministic copy on any failure or hard flag.
 * The on-screen `body` stays deterministic either way (concise, authored copy).
 */
export async function generateBuyerSlideNarration(input: BuyerNarrationInput): Promise<BuyerSlideNarration> {
  const budget = buyerSlideNarrationBudget()
  const rawFallback = buildBuyerSlideNarration(input)
  const fallback = ((): BuyerSlideNarration => {
    const fit = fitNarrationToBudget(rawFallback.script, budget)
    if (fit.note) console.warn(`[consultation-narration] deterministic fallback — ${fit.note}`)
    return { ...rawFallback, script: fit.script }
  })()
  const brief = SLIDE_BRIEF[input.kind]
  if (!brief) return fallback

  const agent = (input.agentName || "your agent").trim()
  const brokerage = (input.brokerageName || "our brokerage").trim()
  const where = input.areaName?.trim() || null

  const prompt = [
    `You are writing the spoken narration for ${agent}, a real estate agent at ${brokerage}, that their AI avatar will speak over ONE slide of a personalized buyer-consultation video sent to a home buyer${where ? ` searching in ${where}` : ""} BEFORE their consultation.`,
    ``,
    `SLIDE GOAL: ${brief}`,
    input.agentTake?.trim() ? `\nTHE AGENT'S OWN ANGLE (weave in naturally, first person):\n${input.agentTake.trim()}` : ``,
    ``,
    `HARD RULES:`,
    // §5 — the fair-housing bound is an INPUT to the writing prompt. Buyer
    // narration about areas and searches is exactly the fair-housing surface.
    `- Fair housing is absolute: describe HOMES and the PROCESS, never the people of an area. No reference to who a neighborhood is for, no schools, no "safe", no "family" framing, no demographic language of any kind.`,
    `- Do not quote any rate, payment, approval amount, or lender terms, and never promise a result or a timeline.`,
    `- First person ("I", "we"), warm, confident. This is ${agent} speaking directly to the buyer.`,
    `- ${narrationLengthDirective(budget)} Conversational, meant to be spoken aloud. No bullet points, no markdown, no stage directions.`,
    ``,
    `Write only the narration text.`,
  ].filter(Boolean).join("\n")

  try {
    const { generateAIText } = await import("@/lib/ai/generate")
    const { text } = await generateAIText(prompt, {
      maxTokens: narrationMaxTokens(budget), temperature: 0.8, feature: "buyer_consultation_narration",
    })
    const script = (text ?? "").trim().replace(/^["“]|["”]$/g, "")
    if (spokenWords(script).length < 3) return fallback
    // ── FAIR-HOUSING BELT (copied from section-narration.ts:295-324, §5) ────
    // Deterministic detector on purpose: it is pure, cannot fail open, and the
    // authored fallback is always available, so refusing costs the buyer
    // nothing. HARD hit ⇒ the deterministic script; advisories pass as warnings.
    const fhHits = detectFairHousingViolations(script)
    if (fhHits.some((v) => v.severity === "high")) {
      console.warn(
        `[consultation-narration] ${input.kind} — HARD fair-housing flag in the generated script `
        + `(${fhHits.filter((v) => v.severity === "high").map((v) => v.phrase).join(", ")}); `
        + `falling back to the deterministic script rather than speaking it to a buyer.`,
      )
      return fallback
    }
    if (fhHits.length > 0) {
      console.warn(`[consultation-narration] ${input.kind} — advisory fair-housing finding(s), passing through per §5: ${fhHits.map((v) => v.severity).join(", ")}`)
    }
    // NO findSuggestedPriceLeaks here — see the module header: that guard hides
    // the SELLER'S subject-home valuation; a buyer deck's prices are public
    // list prices of the homes on the search slide, legitimately shown.
    const fit = fitNarrationToBudget(script, budget)
    if (fit.note) console.warn(`[consultation-narration] ${input.kind} — ${fit.note}`)
    if (!fit.script) return fallback
    return { kind: input.kind, script: fit.script, body: fallback.body }
  } catch {
    return fallback
  }
}
