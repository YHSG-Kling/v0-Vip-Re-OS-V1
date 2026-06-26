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
