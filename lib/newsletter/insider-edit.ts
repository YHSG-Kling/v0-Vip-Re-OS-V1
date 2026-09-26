/**
 * lib/newsletter/insider-edit.ts
 *
 * "The Insider Edit" — the curated deal-of-the-week newsletter format.
 *
 * MERGED HERE (§1.1, lane N3a 2026-09-01) from the deleted route trio
 * app/api/ai/insider-edit-generate/route.ts +
 * app/api/ai/insider-edit-rewrite-section/route.ts +
 * app/api/ai/insider-edit-save/route.ts.
 * The trio had NO UI anywhere in the tree and its save half
 * duplicated the newsletter lane's own campaign writer
 * (app/actions/ai-newsletter.ts:createNewsletterCampaign, which now also
 * carries the trio's upsert-by-id edit semantics). The two things the trio held
 * that existed NOWHERE else — this curator system prompt with its forbidden-word
 * list, and the tone-validation rewrite pass — live here, wired into
 * aiWriteNewsletterContent as the selectable "insider" template
 * (app/actions/ai-newsletter.ts NEWSLETTER_TEMPLATES).
 */

import { generateAIResponse } from "@/lib/ai"

/**
 * The Insider curator voice. Verbatim from the deleted
 * insider-edit-generate/route.ts:7-20 — quiet confidence, micro-editorial,
 * hard forbidden-word list.
 */
export const INSIDER_CURATOR_SYSTEM_PROMPT = `You are "The Insider," a curated real estate newsletter curator with quiet confidence and specific editorial taste. Your tone is low-stress, high-quality, and micro-editorial.

FORBIDDEN WORDS/PHRASES: "Hurry," "Act fast," "Don't miss out," generic "Luxury," "Amazing," "Spectacular," "Must see"

REQUIRED TONE:
- Quiet confidence over hype
- Specific details over generic praise
- Curiosity-driven language
- Micro-editorial (like a fine magazine)
- Personal POV mixed with market insight

You are generating curated weekly opportunity newsletters that feature ONE listing but frame it through lifestyle, community, and opportunity lenses. The newsletter is NOT a property blast—it's a "deal of the week" that tells a story.

Each section should be 150-200 words, specific, and avoid all hard-sell language.`

/**
 * Per-section writing direction for the five insider sections. Verbatim from
 * the deleted generate route (SECTION_PROMPTS), keyed by the section ids the
 * insider template declares.
 */
export const INSIDER_SECTION_PROMPTS: Record<string, string> = {
  hook: `"The Hook" — a personal point of view about the market THIS WEEK. A single paragraph with quiet confidence about market dynamics (e.g., "The market isn't crashing, it's calibrating" or "Inventory isn't tight, it's curated"). An insider sharing a genuine perspective, not a sales pitch; the opening line of a thoughtful blog post.`,
  events: `"Curated Events" — 2-3 LOCAL events happening this week in the neighborhood. For each: Event Name, Date/Time, Vibe (1-2 words describing the feeling). Events should feel authentic to the neighborhood's character, not generic. End with a casual connector to why these events matter for understanding the lifestyle.`,
  civic: `"Development Watch" — civic/infrastructure news in the neighborhood: new schools opening, zoning changes, hospital expansions, transit improvements, or neighborhood development. Written in the tone of "here's what's actually happening that matters." 2-3 items, 1-2 sentences each.`,
  deal: `"The Opportunity" — present the listing. START with: "For the buyer who wants [specific lifestyle/outcome]:" then describe the property focusing on: 1) The lifestyle fit, 2) One unique/hidden value point, 3) Market positioning. Avoid MLS-speak. A discovery, not a listing.`,
  eats: `"Community & Eats" — a single paragraph recommending ONE restaurant/cafe in the neighborhood, like a personal recommendation from someone who knows the area. Focus on the experience/vibe, not just food. End with why locals love it.`,
}

/** Display titles for the five insider sections (deleted generate route :59-65). */
export const INSIDER_SECTION_TITLES: Record<string, string> = {
  hook: "This Week's Market POV",
  events: "Curated Events",
  civic: "Development Watch",
  deal: "The Opportunity",
  eats: "Community & Eats",
}

/**
 * The tone-validation rewrite pass, from the deleted
 * insider-edit-rewrite-section/route.ts:24-37: check a section for forbidden
 * hype words / generic language / sales-y tone, rewrite ONLY if needed while
 * keeping the core message, return the text either way.
 *
 * On any AI failure this returns the ORIGINAL content unchanged and says so —
 * the pass is a polish, and losing the section over it would be worse than
 * shipping the un-validated copy (the fair-housing compliance gate still runs
 * separately in aiWriteNewsletterContent; this pass is tone, not compliance).
 */
export async function enforceInsiderTone(
  content: string,
  actor: { userId: string; brokerageId: string; agentId?: string | null },
): Promise<{ content: string; rewritten: boolean }> {
  const validationPrompt = `Review this real estate newsletter section for tone compliance:

"${content}"

Check for: forbidden hype words, generic language, or sales-y tone. If issues found, rewrite maintaining the user's core message but fixing tone. If clean, return as-is. Reply with ONLY the section text, no explanation.`

  try {
    const response = await generateAIResponse({
      prompt: `${INSIDER_CURATOR_SYSTEM_PROMPT}\n\n${validationPrompt}`,
      metadata: {
        userId: actor.userId,
        brokerageId: actor.brokerageId,
        agentId: actor.agentId ?? undefined,
        feature: "newsletter_generation",
      },
    })
    const text = response.text?.trim()
    if (!text) return { content, rewritten: false }
    return { content: text, rewritten: text !== content.trim() }
  } catch (error) {
    console.error("[insider-edit] tone pass failed; keeping original section:", (error as Error).message)
    return { content, rewritten: false }
  }
}
