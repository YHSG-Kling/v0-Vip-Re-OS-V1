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
