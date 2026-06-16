// lib/intelligence/showing-feedback-routing.ts
//
// SHOWING-FEEDBACK ROUTING (pure) — turns the weekly buyer-showing sentiment on an IN-HOUSE listing
// from a passive seller summary into a MANAGER-ORCHESTRATED play. A human team doesn't just file
// showing feedback — the listing lead reads "three buyers said price, two said dated kitchen" and
// DOES something: opens a price conversation, invites offers while interest is hot, or coaches
// presentation. This decides which play the Listing Concierge should run from the aggregated
// feedback, so the loop is driven by a manager (gated proposal), not a task that rots in a list.
// Only OUR listings are orchestrated. Honest on thin data. Pure (no I/O), unit-tested directly.

export type ShowingPlay = "price_pressure" | "strong_interest" | "presentation_coaching" | null

export interface ShowingFeedbackInput {
  /** the seller-sentiment summary's pricing read. */
  pricingPressure: "raise" | "hold" | "reduce" | "insufficient_data"
  objections: string[]
  positiveThemes: string[]
  feedbackCount: number
  highInterestCount: number
  lowInterestCount: number
}

export interface ShowingFeedbackRouting {
  play: ShowingPlay
  /** the manager who should run the play (null when nothing to do). */
  toManager: "listing_concierge" | null
  reason: string
  /** the seller-facing coaching points (the objections to address). */
  coachingPoints: string[]
  urgency: "now" | "soon" | "routine"
}

/** Objection themes that are about PRESENTATION/staging (fixable) rather than price or location. */
const PRESENTATION_OBJECTION = /(dated|updates?|clean|clutter|stage|paint|smell|paint|carpet|light)/i

const MIN_FEEDBACK = 3 // honest: don't route a manager play off one or two opinions.

/** Decide the Listing Concierge play from aggregated showing feedback. Pure. */
export function routeShowingFeedback(input: ShowingFeedbackInput, opts: { isInHouse: boolean }): ShowingFeedbackRouting {
  const none = (reason: string): ShowingFeedbackRouting => ({ play: null, toManager: null, reason, coachingPoints: [], urgency: "routine" })

  // We only orchestrate OUR OWN listings — an external/MLS showing isn't ours to act on.
  if (!opts.isInHouse) return none("external listing — not ours to orchestrate")
  if ((input.feedbackCount ?? 0) < MIN_FEEDBACK) return none(`thin feedback (${input.feedbackCount}) — hold for more before routing a play`)

  const objections = input.objections ?? []
  const hasPriceObjection = objections.some((o) => /price|over\s*priced|expensive/i.test(o))

  // 1. Price pressure — repeated price objections / low sentiment → open the price conversation.
  if (input.pricingPressure === "reduce" || hasPriceObjection) {
    const urgency: ShowingFeedbackRouting["urgency"] = input.lowInterestCount >= input.highInterestCount ? "now" : "soon"
    return {
      play: "price_pressure", toManager: "listing_concierge",
      reason: "buyer feedback is pointing at price — open a strategic price conversation with the seller",
      coachingPoints: objections, urgency,
    }
  }

  // 2. Strong interest — high interest + good sentiment → invite offers / hold firm while hot.
  if (input.pricingPressure === "raise" || (input.highInterestCount >= 3 && input.highInterestCount > input.lowInterestCount)) {
    return {
      play: "strong_interest", toManager: "listing_concierge",
      reason: "interest is strong this week — talk to the seller about inviting offers or holding firm",
      coachingPoints: input.positiveThemes ?? [], urgency: "soon",
    }
  }

  // 3. Presentation — fixable staging objections (not price/location) → coach a quick refresh.
  const presentationObjections = objections.filter((o) => PRESENTATION_OBJECTION.test(o))
  if (presentationObjections.length > 0) {
    return {
      play: "presentation_coaching", toManager: "listing_concierge",
      reason: "recurring presentation objections — a few quick staging fixes could lift the next showings",
      coachingPoints: presentationObjections, urgency: "routine",
    }
  }

  return none("feedback is steady — keep the current strategy")
}
