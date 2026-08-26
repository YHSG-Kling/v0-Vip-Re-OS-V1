// lib/behavior-learning/signal-mapping.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE BUYER GRAPH LOOP — map a buyer's PORTAL action (what they actually save/favorite/dismiss)
// to the preference-learning signal that adjusts their criteria. The learning engine already
// existed (updatePreferencesFromSignal) but the buyer's OWN portal saves never fed it — so the
// strongest signal (their real behavior) was ignored. This PURE mapper closes that loop: favoring
// a home teaches the system what they want; dismissing one teaches what they don't.

/** The learning engine's signal vocabulary (SIGNAL_WEIGHTS in preference-updater). */
export type LearningSignal = "saved" | "love_it" | "dismissed" | "viewed" | "like_it" | "maybe" | "not_for_us"

/**
 * interestLevelToLearningSignal — PURE. Map a saved_properties.interest_level (the buyer's portal
 * action) to the learning signal that should adjust their criteria. Returns null for actions that
 * carry no preference meaning (a tour/offer REQUEST is about logistics, not taste — don't skew the
 * profile on it). saved → saved(+5), favorited/love_it → love_it(+10, strongest "want"),
 * dismissed → dismissed(-3), not_interested → not_for_us(-5, strongest "don't want").
 */
export function interestLevelToLearningSignal(interestLevel: string | null | undefined): LearningSignal | null {
  switch (interestLevel) {
    case "saved":          return "saved"
    case "favorited":
    case "love_it":        return "love_it"
    case "like_it":        return "like_it"
    case "maybe":          return "maybe"
    case "dismissed":      return "dismissed"
    case "not_interested":
    case "not_for_us":     return "not_for_us"
    // tour_requested / offer_requested — logistics, not taste; viewed — too weak to act on here.
    default:               return null
  }
}

/**
 * showingInterestToLearningSignal — PURE. After a buyer TOURS a home and rates it, that verdict is
 * the STRONGEST taste signal we ever get (they stood in it). Map the showing-feedback vocabulary
 * (very_interested/interested/neutral/not_interested) to the learning signal that re-tunes their
 * criteria. "neutral" is a weak positive (they didn't reject it) → maybe; a tour they didn't rate
 * carries no taste → null. This closes the post-tour half of the buyer-graph loop.
 */
export function showingInterestToLearningSignal(interestLevel: string | null | undefined): LearningSignal | null {
  switch (interestLevel) {
    case "very_interested": return "love_it"
    case "interested":      return "like_it"
    case "neutral":         return "maybe"
    case "not_interested":  return "not_for_us"
    default:                return null
  }
}

/**
 * portalInterestToShowingLevel — PURE. The portal's tour-feedback UI speaks human
 * (very_interested/interested/neutral/not_interested), but showings.buyer_interest_level has a CHECK
 * that only accepts the canonical love_it/like_it/maybe/no. Map portal → canonical BEFORE writing so
 * the feedback actually persists (it had been silently rejected). Returns null for unknown values.
 */
export function portalInterestToShowingLevel(
  interestLevel: string | null | undefined,
): "love_it" | "like_it" | "maybe" | "no" | null {
  switch (interestLevel) {
    case "very_interested": return "love_it"
    case "interested":      return "like_it"
    case "neutral":         return "maybe"
    case "not_interested":  return "no"
    // already-canonical values pass through (defensive)
    case "love_it": case "like_it": case "maybe": case "no": return interestLevel
    default:                return null
  }
}

/**
 * tourInterestToRating — PURE. The canonical buyer verdict as the 1-5 number the
 * story-draft brief speaks.
 *
 * WHY THIS EXISTS (orphan doctrine §1.1 — a DUPLICATE existed, so merge onto the
 * survivor). tour_stops carries TWO spellings of one idea: `rating` (integer) +
 * `feedback` (text), and `buyer_interest_level` (text) + `buyer_note` (text). Only
 * the SECOND pair has writers — app/actions/tour-planner.ts:896 (rateTourStop) and
 * :966 (completeTour) — verified live: no DB trigger, no routine and no column
 * DEFAULT touches `rating`/`feedback` on that table (pg_trigger and pg_proc both
 * empty for tour_stops, project hrvaqgvukzxfskkcrwbt). So the recap reader at
 * lib/kernel/client-story-drafts.ts:335 was reading the dead half and got NULL for
 * every stop, forever — tourRecapBrief's "never narrate a day the OS didn't see"
 * guard then returned null and NO tour recap has ever been proposed.
 *
 * ONE VOCABULARY (CLAUDE.md §6): the ladder is the LIVE CHECK on
 * tour_stops.buyer_interest_level — love_it / like_it / maybe / no — the same four
 * values portalInterestToShowingLevel above already normalises onto, which is why
 * this mapper belongs in this module rather than as a private map at the read site.
 * 'not_for_us' is accepted as the learning-signal spelling of 'no'
 * (app/actions/tour-planner.ts canonicalises 'no' → 'not_for_us' for
 * buyer_behavior_log), so a caller holding either spelling lands on the same rung.
 *
 * An unrated stop returns null and NOT a number: a stop nobody reacted to is not a
 * 1/5, and scoring it as the bottom rung would launder "we never asked" into "they
 * disliked it" — the same trap lib/lead-governance/seller-signal-strength.ts's
 * rank(-1) exists to avoid.
 */
export function tourInterestToRating(interestLevel: string | null | undefined): number | null {
  switch (interestLevel) {
    case "love_it":     return 5
    case "like_it":     return 4
    case "maybe":       return 3
    case "no":
    case "not_for_us":  return 1
    default:            return null
  }
}
